import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { ResidentExecutor, PARK_HEAD_RETRY_MS, PARK_HEAD_STREAK_MS, STAGE8_NOT_READY_CODES, STAGE8_TRANSIENT_MAX_TRIES, STAGE8_TRANSIENT_PARK_CODES, STAGE8_TRANSIENT_RETRY_MS } from '../src/executor.mjs';
import { STAGE8_NOT_READY_REASONS, STAGE8_FINAL_REASONS } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/publisher.mjs';
import { outcomeFailureCode } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs';
import { describe as prPage, events as notificationEvents } from '../src/pr-status.mjs';
import { StatusBoard, parseStatus } from '../src/status.mjs';
import { Ledger, batchKey } from '../src/ledger.mjs';
import { BASE, HEAD, WINDOWS_CLEAN, executorFixture, fakeEngine, rawPolicy, triggerBytes } from './helpers.mjs';
import { MIN, H, subject, KEY, stagesRun, receiptTypes, notReady, stage8Engine, isoAt, seedStage8History } from './park-fixtures.mjs';

describe('parking: retry budgets, queue hints and transient stage-8 answers', () => {
  test('#1144: 100 historical retries across PRs cannot block the front PR after restart', async t => {
    const f = await executorFixture(t, { now: Date.parse('2026-11-17T01:23:32.000Z'),
      engine: stage8Engine([notReady('TRAIN_SINGLE_GREEN_NOT_PROVEN', { entered: true, state: 'head', position: 1 })]) });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'PARKED');
    // Report: #1142 35, #1143 36, other PRs 24, the current front 5 = 100.
    for (const [pr, retries] of [[1142, 35], [1143, 36], [1130, 24], [884, 5]]) {
      const s = subject({ pr, headSha: pr.toString(16).padStart(40, '0') }), key = batchKey(s);
      await f.ledger.reserve(key, s);
      await f.ledger.markStarted(key, { batchId: 'history' });
      await f.ledger.beginWait(key, { t0: f.clock(), batch: { batchId: 'history' } });
      await f.ledger.writePlanIntent(key, {});
      await f.ledger.writePlan(key, { relayed: [] });
      await f.ledger.park(key, { batch: { batchId: 'history' } });
      await seedStage8History(f, key, 1, retries + 1, 'history',
        { code: 'TRAIN_SINGLE_GREEN_NOT_PROVEN', nextAt: isoAt(f.clock()), position: 1 });
      await f.ledger.terminal(key, 'COMPLETED', {});
    }
    assert.equal((await f.ledger.usage(f.clock() - 86_400_000)).stage8Retries, 100);
    assert.equal((await f.ledger.usage(f.clock() - 86_400_000, { stage8Pr: 884 })).stage8Retries, 5);
    f.advance(MIN);
    const restarted = new ResidentExecutor(f.ports);
    assert.equal((await restarted.tick()).state, 'COMPLETED', 'the front still has 95 of its own retries');
  });

  // scope-isolation: park.stage8RetriesPer24h
  test('#1144: an exhausted PR does not block another due parked PR; its own limit still holds', async t => {
    const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]),
      policy: rawPolicy({ park: { ...rawPolicy().park, stage8RetriesPer24h: 1 } }) });
    await f.drop(triggerBytes()); assert.equal((await f.exec.tick()).state, 'PARKED');
    await f.drop(triggerBytes({ pr: 900, headSha: H(4) })); assert.equal((await f.exec.tick()).state, 'PARKED');
    const n = await f.ledger.beginTry(KEY, { batchId: 'historical-retry' });
    await f.ledger.endTry(KEY, n, { code: 'RESIDENT_MERGE_QUEUE_NOT_JOINED', nextAt: isoAt(f.clock()), position: null });
    f.advance(10 * MIN);
    assert.equal((await f.exec.tick()).state, 'COMPLETED', 'skip the exhausted first PR and try the second');
    assert.ok(Ledger.parkedAt(await f.ledger.state(KEY)), 'the exhausted PR still waits');
    assert.equal((await f.ledger.state(batchKey(subject({ pr: 900, headSha: H(4) })))).outcome, 'COMPLETED');
    const budget = f.queue.notices.find(n => n.code === 'STAGE8_RETRY_BUDGET_EXHAUSTED' && n.pr === 884)?.budget;
    assert.deepEqual(budget, { policyKey: ['park', 'stage8RetriesPer24h'].join('.'), scope: 'pr', used: 1, limit: 1, resetsAt: f.clock() - 10 * MIN + 24 * 60 * MIN });
    const notice = notificationEvents({ status: { pending: [], notices: f.queue.notices }, now: f.clock() }).find(n => /第 8 段重试额度/.test(n.title));
    assert.match(notice.title, /PR #884/);
  });

  test('review m5: tries first in the merge queue come a minute apart for 15 minutes and never use up the try cap', async t => {
    const head = notReady('RESIDENT_QUEUE_HEAD_NOT_REACHED', { entered: true, state: 'waiting', position: 1 });
    const f = await executorFixture(t, { engine: stage8Engine(Array.from({ length: 40 }, () => head), KEY) });
    await f.drop(triggerBytes());
    let r = await f.exec.tick();
    const start = f.clock();
    let tries = 1;
    while (f.clock() - start < PARK_HEAD_STREAK_MS) {
      assert.equal(r.until - f.clock(), PARK_HEAD_RETRY_MS, `try ${tries}`);
      f.advance(PARK_HEAD_RETRY_MS);
      r = await f.exec.tick();
      tries += 1;
      assert.equal(r.state, 'PARKED', `try ${tries}`);
    }
    assert.ok(tries > rawPolicy().park.stage8MaxTries, 'more head tries than the cap, still parked');
    assert.ok(r.until - f.clock() > PARK_HEAD_RETRY_MS, 'after 15 minutes the back-off applies again');
    assert.equal((await f.ledger.usage(f.clock() - 24 * 60 * MIN)).stage8Retries, tries - 1, 'every try after the first is a stage-8 retry');
  });

  test('review m7: a re-read of a seen trigger nudges nothing; a new main tip nudges once', async t => {
    const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY) });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'PARKED');
    const tries = async () => (await f.ledger.state(KEY)).tries.length;
    await f.drop(triggerBytes());   // the same trigger again: seen
    await f.exec.tick();
    assert.equal(await tries(), 1);
    // an Agent's trigger (no prUpdatedAt) names any base: no nudge
    await f.drop(triggerBytes({ pr: 902, headSha: H(8), baseSha: H(9) }));
    await f.exec.tick();
    assert.equal(await tries(), 1);
    // main moved: the poller's trigger of another PR carries the new tip
    await f.drop(triggerBytes({ pr: 900, headSha: H(4), baseSha: H(5), prUpdatedAt: '2026-10-20T11:00:00.000Z', contract: 'clued.independent-ci.resident-trigger/2' }));
    const moved = await f.exec.tick();
    assert.deepEqual([moved.state, await tries()], ['PARKED', 2]);
    // the same tip again later: no second nudge for it
    f.advance(6 * MIN);
    await f.drop(triggerBytes({ pr: 901, headSha: H(6), baseSha: H(5), prUpdatedAt: '2026-10-20T11:00:00.000Z', contract: 'clued.independent-ci.resident-trigger/2' }));
    await f.exec.tick();
    assert.equal(await tries(), 2);
  });

  // ---- the confirmatory re-review of step 2 ----
  test('the 99th stage-8 try ends automatic retries; a later event still runs try 100', async t => {
    const head = notReady('RESIDENT_QUEUE_HEAD_NOT_REACHED', { entered: true, state: 'waiting', position: 1 });
    const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), head], KEY) });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'PARKED');
    // 97 more tries at the queue's first place (they do not count towards the cap), as the ledger records them
    await seedStage8History(f, KEY, 2, 98, 'x',
      { code: 'RESIDENT_QUEUE_HEAD_NOT_REACHED', nextAt: new Date(f.clock()).toISOString(), position: 1, entered: true });
    f.advance(10 * MIN);
    const r = await f.exec.tick();
    assert.deepEqual([r.state, r.reason, r.until], ['PARKED', 'RESIDENT_QUEUE_HEAD_NOT_REACHED', null]);
    assert.equal((await f.ledger.state(KEY)).tries.length, 99);
    await f.exec.nudgeParked([{ t: { ...subject(), prUpdatedAt: null }, seen: false }], f.clock());
    assert.deepEqual([(await f.exec.tick()).state, (await f.ledger.state(KEY)).tries.length], ['COMPLETED', 100]);
    assert.equal(await f.ledger.halted(), null);
  });

  test('final check n2: alternating main tips nudge once each, not every 5 minutes', async t => {
    const answers = Array.from({ length: 6 }, () => notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'));
    const f = await executorFixture(t, { engine: stage8Engine(answers, KEY) });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'PARKED');
    const tries = async () => (await f.ledger.state(KEY)).tries.length;
    const poller = (pr, base) => triggerBytes({ contract: 'clued.independent-ci.resident-trigger/2', pr, headSha: H(pr % 10 === 0 ? 3 : pr % 10), baseSha: base, prUpdatedAt: '2026-10-20T11:00:00.000Z' });
    const seen = [];
    for (const [i, base] of [H(5), H(6), H(5), H(6)].entries()) {
      f.advance(6 * MIN);
      await f.drop(poller(901 + i, base));
      await f.exec.tick();
      seen.push(await tries());
    }
    // X and Y nudge once each (tries 2 and 3); X and Y again nudge nothing (no try is due by its back-off yet)
    assert.deepEqual(seen, [2, 3, 3, 3]);
  });

  // ---- Task 867250db: stage 10 reads the merge queue's head; a batch parked for that PR is tried at once ----

  const shadowPolicy = () => rawPolicy({ train: { enabled: 'shadow', nonFrontRuns: true, maintenanceEveryMs: 10 * MIN, maintenanceMaxPerDay: 200 } });
  // Stage 10 facts whose merge-queue head (holders[0]) is `front`.
  const trainWithFront = front => () => ({ ok: true, runId: `${'7'.repeat(16)}-${'0'.repeat(12)}`, proof: { windowsTreeZero: true, serviceOriginalStopped: true },
    train: { contract: 'clued.independent-ci.train-facts/1', mode: 'shadow', at: '2026-10-23T05:00:00.000Z', onDuty: true, mainSha: null, rules: null,
      front: front ? { claimId: 'c', ...front } : null, wouldDo: front ? 'FRONT_TEST_MERGE_NOT_READY' : 'NO_FRONT', wouldRevoke: [], wouldRevokeCount: 0 } });
  const hintFixture = async (t, front) => {
    const answers = [notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_QUEUE_HEAD_NOT_REACHED', { entered: true, state: 'waiting', position: 1 })];
    const f = await executorFixture(t, { policy: shadowPolicy(), engine: stage8Engine(answers, KEY, { train: trainWithFront(front) }) });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'PARKED');
    return { f, tries: async () => (await f.ledger.state(KEY)).tries.length };
  };

  test('867250db: stage 10 sees the parked PR at the merge queue head: its stage-8 try is due now, not after the 10-minute back-off', async t => {
    const { f, tries } = await hintFixture(t, { pr: 884, headSha: HEAD });
    f.advance(2 * MIN);
    assert.equal((await f.exec.tick()).state, 'IDLE', 'this tick runs stage 10 (the batch itself rests)');
    assert.equal(f.engine.calls.filter(c => c[0] === 'stage' && c[1] === 10).length, 1);
    assert.equal(await tries(), 1);
    const r = await f.exec.tick();
    assert.deepEqual([r.state, r.position, await tries()], ['PARKED', 1, 2], 'tried two minutes after the first try; the claim is first: the one-minute cadence follows');
    assert.equal(r.until - f.clock(), PARK_HEAD_RETRY_MS);
  });

  test('867250db: no hint for another PR, another head or an empty queue: the back-off stands', async t => {
    for (const front of [null, { pr: 900, headSha: HEAD }, { pr: 884, headSha: H(7) }, { pr: 884, headSha: null }]) {
      const { f, tries } = await hintFixture(t, front);
      f.advance(2 * MIN);
      await f.exec.tick();
      await f.exec.tick();
      assert.equal(await tries(), 1, JSON.stringify(front));
      f.advance(8 * MIN);
      await f.exec.tick();
      assert.equal(await tries(), 2, `${JSON.stringify(front)}: its 10-minute back-off`);
    }
  });

  test('867250db: no tight loop: one hint never makes a try less than PARK_HEAD_RETRY_MS after the last try ended', async t => {
    const { f, tries } = await hintFixture(t, { pr: 884, headSha: HEAD });
    f.advance(10_000);
    await f.exec.tick(); // stage 10 hints 10 seconds after the first try
    await f.exec.tick();
    await f.exec.tick();
    assert.equal(await tries(), 1, 'not yet');
    f.advance(PARK_HEAD_RETRY_MS - 10_000 - 1);
    await f.exec.tick();
    assert.equal(await tries(), 1, 'one millisecond short');
    f.advance(1);
    await f.exec.tick();
    assert.equal(await tries(), 2);
    // the hint is spent by the try: another stage 10 run is 10 minutes away, so nothing else is due before the claim's minute cadence
    assert.equal((await f.ledger.state(KEY)).tries[1].ended.position, 1);
  });

  // ---- phase 2, step 3a (design v0.5 §5.3 rules 3, 5, 7): stage 8's live branch rules, test merge and green ledger ----
  test('step 3a: the stage-8 code lists of the publisher, the stage fact and the executor agree (review N1)', () => {
    assert.deepEqual([...STAGE8_NOT_READY_CODES].sort(), [...STAGE8_NOT_READY_REASONS].sort());
    // every not-ready answer and every final answer of stage 8 reaches the resident under its own code
    for (const code of [...STAGE8_NOT_READY_REASONS, ...STAGE8_FINAL_REASONS])
      assert.equal(outcomeFailureCode({ status: 'BLOCKED', reason: code, sideEffects: 0, mayHavePublished: false }, 8), code, code);
    assert.ok(STAGE8_FINAL_REASONS.every(code => !STAGE8_NOT_READY_CODES.includes(code)));
  });

  test('step 3a: the new not-ready answers park the batch and are tried again; the rules ones tell the Owner once a day', async t => {
    // RULESET_UNREADABLE is not tried again by the clock (task bd07449b, its own test below); a failed read of the rules is
    for (const code of ['REQUIRED_CHECK_FAILED', 'REQUIRED_CHECKS_UNREADABLE', 'RULESET_READ_FAILED', 'STRICT_OFF_WITHOUT_TRAIN', 'MERGE_METHODS_NOT_MERGE_ONLY', 'TRAIN_TEST_MERGE_NOT_READY', 'GREEN_LEDGER_UNAVAILABLE', 'TRAIN_MODE_UNREADABLE']) {
      const f = await executorFixture(t, { engine: stage8Engine([notReady(code), notReady(code)], KEY) });
      await f.drop(triggerBytes());
      const first = await f.exec.tick();
      assert.deepEqual([first.state, first.reason, first.tries], ['PARKED', code, 1], code);
      assert.deepEqual([f.queue.row(884).state, f.queue.row(884).reason], ['PARKED', code], code);
      const notices = f.queue.notices.filter(n => n.kind === 'stage8-rules');
      const toldOwner = ['STRICT_OFF_WITHOUT_TRAIN', 'MERGE_METHODS_NOT_MERGE_ONLY'].includes(code);
      assert.equal(notices.length, toldOwner ? 1 : 0, code);
      f.advance(10 * MIN);
      const second = await f.exec.tick();
      assert.deepEqual([second.state, second.tries], ['PARKED', 2], code);
      assert.equal(f.queue.notices.filter(n => n.kind === 'stage8-rules').length, toldOwner ? 1 : 0, `${code}: the same notice key the same day`);
      f.advance(20 * MIN);
      assert.equal((await f.exec.tick()).state, 'COMPLETED', code);
    }
  });

  test('step 3a: a test merge that is not the tested tree ends the parked batch neutrally, never an attempt 2, and tells the Owner', async t => {
    const f = await executorFixture(t, { engine: stage8Engine([notReady('TRAIN_TEST_MERGE_TREE_DIFFERS')], KEY) });
    await f.drop(triggerBytes());
    const r = await f.exec.tick();
    assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', 'TRAIN_TEST_MERGE_TREE_DIFFERS']);
    assert.deepEqual(await f.ledger.pendingAttempts2(), []);
    assert.equal(f.queue.breaker?.state ?? 'closed', 'closed');
    assert.equal(f.queue.row(884).state, 'STOPPED');
    const n = f.queue.notices.filter(x => x.kind === 'stage8-rules');
    assert.deepEqual(n.map(x => [x.code, x.pr, x.headSha]), [['TRAIN_TEST_MERGE_TREE_DIFFERS', 884, HEAD]]);
    // the stage-fact catalogue and the failure table agree it is a clean final code of the head
    assert.equal(await f.executedHeads.published(subject()), true, 'its roles were published before stage 8');
  });

  test('step 3a: the PR page and the notifications say why stage 8 writes no green', async () => {
    const now = Date.parse('2026-10-23T09:00:00Z');
    const board = fn => { const b = new StatusBoard({ clock: () => now }); b.update({ backfill: { complete: true, published: 0, unreadable: 0 } }); fn(b); return parseStatus(Buffer.from(JSON.stringify(b.snapshot()))); };
    const pull = { pr: 7, headSha: H(7), eligible: true, hint: null, behindBy: 0 };
    const parkedAs = code => prPage({ pull, status: board(b => b.setPending([{ pr: 7, headSha: H(7), baseSha: BASE, state: 'PARKED', deferred: code, nextAt: now + 10 * MIN }])), now });
    assert.match(parkedAs('STRICT_OFF_WITHOUT_TRAIN').description, /^已测通：main 的 strict 已关而列车未开.*再查第 8 段$/);
    assert.match(parkedAs('RULESET_UNREADABLE').description, /^已测通：main 的必需检查没有全部钉在本执行器上/);
    assert.match(parkedAs('RULESET_READ_FAILED').description, /^已测通：暂时读不到 main 的规则/);
    assert.match(parkedAs('TRAIN_TEST_MERGE_NOT_READY').description, /^已测通：等 GitHub 算好试合并/);
    assert.match(parkedAs('MERGE_METHODS_NOT_MERGE_ONLY').description, /合并方式不只有 merge/);
    assert.match(parkedAs('GREEN_LEDGER_UNAVAILABLE').description, /绿色台账/);
    assert.match(parkedAs('TRAIN_MODE_UNREADABLE').description, /^已测通：读不到本机的列车模式/);
    const ended = prPage({ pull, status: board(b => b.outcome({ pr: 7, headSha: H(7), outcome: 'FAILED_CLEAN', code: 'TRAIN_TEST_MERGE_TREE_DIFFERS', klass: 'clean-final', retry: 'new-commit' })), now });
    assert.deepEqual([ended.state, /请推新提交/.test(ended.description)], ['failure', true]);
    const told = notificationEvents({ status: board(b => b.update({ notices: [
      { key: 'stage8:STRICT_OFF_WITHOUT_TRAIN:2026-10-23', kind: 'stage8-rules', pr: null, headSha: null, code: 'STRICT_OFF_WITHOUT_TRAIN' },
      { key: `stage8:TRAIN_TEST_MERGE_TREE_DIFFERS:7:${H(7)}`, kind: 'stage8-rules', pr: 7, headSha: H(7), code: 'TRAIN_TEST_MERGE_TREE_DIFFERS' }] })), now });
    assert.deepEqual(told.map(e => e.title), ['main 的 strict 已关，第 8 段停发合并位', 'PR #7 的试合并与测过的树不同']);
    assert.match(told[1].body, new RegExp(H(7).slice(0, 8)));
  });

  // ---- DESIGN §28 (design r3 4a, PR #930): a transient zero-effect stage-8 ending parks again, 3 times at most ----
  // PR #930 (2026-10-28, batch 5bc215cb attempt 2): stages 1-7 passed, the first stage-8 try ended 35 s later BLOCKED
  // full_admission_unavailable with zero side effects and no merge-queue facts; it was burned. Now it parks a minute.
  const unavailable = (code = 'NATIVE_ADMISSION_UNAVAILABLE', o = {}) => ({ ok: false, code, proof: WINDOWS_CLEAN, brokerNoLaunch: false,
    outcome: { status: 'BLOCKED', reason: 'full_admission_unavailable', sideEffects: 0, mayHavePublished: false, diagnostic: null, scheduling: null, safeToRerun: false, ...o } });

  test('4a: zero-effect NATIVE_ADMISSION_UNAVAILABLE parks at B after 1, 3 and 10 minutes; the 4th one burns the head as before', async t => {
    assert.deepEqual([...STAGE8_TRANSIENT_PARK_CODES], ['NATIVE_ADMISSION_UNAVAILABLE', 'GITHUB_TRANSIENT_UNAVAILABLE']);
    assert.deepEqual([STAGE8_TRANSIENT_MAX_TRIES, ...STAGE8_TRANSIENT_RETRY_MS], [3, MIN, 3 * MIN, 10 * MIN]);
    const f = await executorFixture(t, { engine: stage8Engine([unavailable(), unavailable('GITHUB_TRANSIENT_UNAVAILABLE'), unavailable(), unavailable()], KEY) });
    await f.drop(triggerBytes());
    const gaps = [];
    let r = await f.exec.tick();
    for (const gap of STAGE8_TRANSIENT_RETRY_MS) {
      assert.equal(r.state, 'PARKED');
      gaps.push(r.until - f.clock());
      f.advance(gap - 1);
      assert.equal((await f.exec.tick()).state, 'IDLE', 'not before its own back-off');
      f.advance(1);
      r = await f.exec.tick();
    }
    assert.deepEqual(gaps, [MIN, 3 * MIN, 10 * MIN]);
    assert.deepEqual([r.state, r.failureCode, r.attempt2], ['FAILED_CLEAN', 'NATIVE_ADMISSION_UNAVAILABLE', undefined], 'the fourth: fail() as before, the head burned');
    const s = await f.ledger.state(KEY);
    assert.deepEqual(s.tries.map(x => [x.ended?.transient ?? false, x.ended?.position ?? null, x.ended?.assumedPosition ?? null]),
      [[true, null, 1], [true, null, 1], [true, null, 1], [false, null, null]], 'the true place (null) is recorded; the assumed one beside it');
    assert.equal((await receiptTypes(f)).filter(x => x === 'stage8-transient-parked').length, 3);
    assert.equal(f.queue.breaker?.state ?? 'closed', 'closed');
    assert.equal(await f.ledger.halted(), null);
  });

  test('4a: the #930 replay: unavailable once, parked a minute, then COMPLETED on the same batch', async t => {
    const engine = stage8Engine([unavailable()], KEY);
    const f = await executorFixture(t, { engine, status: new StatusBoard({ clock: () => Date.parse('2026-10-20T12:00:00Z') }) });
    await f.drop(triggerBytes());
    const parked = await f.exec.tick();
    assert.deepEqual([parked.state, parked.reason, parked.position, parked.until - f.clock()], ['PARKED', 'NATIVE_ADMISSION_UNAVAILABLE', 1, MIN]);
    assert.deepEqual([f.queue.row(884).state, f.queue.row(884).parked.position], ['PARKED', 1], 'the status shows the assumed place');
    f.advance(MIN);
    const done = await f.exec.tick();
    assert.deepEqual([done.state, done.tries], ['COMPLETED', 2]);
    assert.deepEqual(stagesRun(engine), [1, 2, 3, 4, 5, 6, 7, 8, 8], 'stages 1-7 ran once; no new head');
  });

  test('4a: a null place keeps the last try place (or 1), is never PARKED_OVER_CAPACITY, and counts by its assumed place (review r3 NIT 2)', async t => {
    // its last try was third in the queue: that place is assumed
    const third = notReady('RESIDENT_QUEUE_HEAD_NOT_REACHED', { entered: true, state: 'waiting', position: 3 });
    const f = await executorFixture(t, { engine: stage8Engine([third, unavailable()], KEY) });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).position, 3);
    f.advance(10 * MIN);
    const r = await f.exec.tick();
    assert.deepEqual([r.state, r.position], ['PARKED', 3]);
    const last = ResidentExecutor.lastTry(await f.ledger.state(KEY));
    assert.deepEqual([last.position, last.assumedPosition], [null, 3]);
    // with no room outside the queue's first two places at all, a transient park is exempt: never PARKED_OVER_CAPACITY
    const g = await executorFixture(t, { engine: stage8Engine([unavailable()], KEY), policy: rawPolicy({ park: { ...rawPolicy().park, maxParkedOutsideTop2: 0 } }) });
    await g.drop(triggerBytes());
    assert.deepEqual([(await g.exec.tick()).state], ['PARKED']);
    // and it counts as inside (assumed place 1): another batch not ready outside the first places is not pushed over the bound
    const e = stage8Engine([unavailable()], KEY);
    const base = e.runStage;
    e.runStage = async (b, s, o) => (s.number === 8 && b.key !== KEY ? (e.calls.push(['stage', 8]), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')) : base(b, s, o));
    const h = await executorFixture(t, { engine: e, policy: rawPolicy({ park: { ...rawPolicy().park, maxParkedOutsideTop2: 1 } }) });
    await h.drop(triggerBytes());
    assert.equal((await h.exec.tick()).state, 'PARKED');
    assert.deepEqual(await h.exec.parkedCounts(), { inside: 1, outside: 0 });
    await h.drop(triggerBytes({ pr: 900, headSha: H(4) }));
    const other = await h.exec.tick();
    assert.deepEqual([other.state, other.reason], ['PARKED', 'RESIDENT_MERGE_QUEUE_NOT_JOINED'], 'parked, not PARKED_OVER_CAPACITY');
  });

  test('4a: side effects, a possible publication or UNCERTAIN never park; the try cap and park.maxMs still end it first', async t => {
    for (const o of [{ sideEffects: 1 }, { mayHavePublished: true }]) {
      const f = await executorFixture(t, { engine: stage8Engine([unavailable('NATIVE_ADMISSION_UNAVAILABLE', o)], KEY) });
      await f.drop(triggerBytes());
      const r = await f.exec.tick();
      assert.notEqual(r.state, 'PARKED', JSON.stringify(o));
    }
    const u = await executorFixture(t, { engine: stage8Engine([{ ok: false, code: 'PUBLICATION_UNCERTAIN', proof: WINDOWS_CLEAN, outcome: { status: 'UNCERTAIN', reason: 'full_admission_unavailable', sideEffects: 1, mayHavePublished: true, diagnostic: null, scheduling: null, safeToRerun: false } }], KEY) });
    await u.drop(triggerBytes());
    assert.equal((await u.exec.tick()).state, 'HALTED');
    // the Windows half missing: no park
    const w = await executorFixture(t, { engine: stage8Engine([{ ...unavailable(), proof: { windowsTreeZero: false, serviceOriginalStopped: true } }], KEY) });
    await w.drop(triggerBytes());
    assert.notEqual((await w.exec.tick()).state, 'PARKED');
    // park.stage8MaxTries reached first
    const cap = await executorFixture(t, { engine: stage8Engine([unavailable(), unavailable()], KEY), policy: rawPolicy({ park: { ...rawPolicy().park, stage8MaxTries: 2 } }) });
    await cap.drop(triggerBytes());
    assert.equal((await cap.exec.tick()).state, 'PARKED');
    cap.advance(MIN);
    assert.deepEqual([(await cap.exec.tick()).failureCode], ['NATIVE_ADMISSION_UNAVAILABLE']);
    // park.maxMs reached first: the batch ends without another try
    const old = await executorFixture(t, { engine: stage8Engine([unavailable(), unavailable()], KEY), policy: rawPolicy({ park: { ...rawPolicy().park, maxMs: 60 * MIN } }) });
    await old.drop(triggerBytes());
    assert.equal((await old.exec.tick()).state, 'PARKED');
    old.advance(60 * MIN);
    const end = await old.exec.tick();
    assert.deepEqual([end.state, end.failureCode], ['FAILED_CLEAN', 'NATIVE_ADMISSION_UNAVAILABLE']);
    assert.equal(stagesRun(old.engine).filter(n => n === 8).length, 1);
  });

  test('4a: the next try finds an unsettled journal entry (RECONCILIATION_REQUIRED): HALT; a changed claim: BATCH_CLAIM_CHANGED', async t => {
    const f = await executorFixture(t, { engine: stage8Engine([unavailable(), { ok: false, code: 'RECONCILIATION_REQUIRED', proof: WINDOWS_CLEAN,
      outcome: { status: 'RECONCILIATION_REQUIRED', reason: 'journal_unsettled', sideEffects: 0, mayHavePublished: true, diagnostic: null, scheduling: null, safeToRerun: false } }], KEY) });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'PARKED');
    f.advance(MIN);
    const r = await f.exec.tick();
    assert.deepEqual([r.state, (await f.ledger.halted()).value.code], ['HALTED', 'RECONCILIATION_REQUIRED']);
    const g = await executorFixture(t, { engine: stage8Engine([unavailable(), { ok: false, code: 'BATCH_CLAIM_CHANGED', proof: WINDOWS_CLEAN,
      outcome: { status: 'BLOCKED', reason: 'batch_claim_changed', sideEffects: 0, mayHavePublished: false, diagnostic: null, scheduling: null, safeToRerun: false } }], KEY) });
    await g.drop(triggerBytes());
    assert.equal((await g.exec.tick()).state, 'PARKED');
    g.advance(MIN);
    const c = await g.exec.tick();
    assert.deepEqual([c.state, c.failureCode, c.attempt2], ['FAILED_CLEAN', 'BATCH_CLAIM_CHANGED', undefined]);
  });

  // Generation 12, review round 28: the green ledger's not-ready answer of a queue head keeps the queue place (publisher.mjs), so the
  // head is tried again in 60 s and the try is not counted, as in generation 11.
  test('review round 28: GREEN_LEDGER_UNAVAILABLE at the queue head parks for the 60-second head retry, uncounted', async t => {
    const { PARK_HEAD_RETRY_MS: HEAD_MS } = await import('../src/executor.mjs');
    const helpers = await import('./helpers.mjs');
    const answer = { ok: false, code: 'GREEN_LEDGER_UNAVAILABLE', proof: helpers.WINDOWS_CLEAN, brokerNoLaunch: false,
      outcome: { status: 'BLOCKED', reason: 'GREEN_LEDGER_UNAVAILABLE', sideEffects: 0, mayHavePublished: false, diagnostic: null,
        scheduling: { ciRetryAfter: null, mergeQueue: { entered: true, state: 'head', position: 1 }, claimExpiresAt: null }, safeToRerun: false } };
    const engine = helpers.fakeEngine({});
    const base = engine.runStage;
    let i = 0;
    engine.runStage = async (b, s, o) => (s.number === 8 && i++ === 0 ? answer : base(b, s, o));
    const f = await helpers.executorFixture(t, { engine });
    await f.drop(helpers.triggerBytes());
    const r = await f.exec.tick();
    assert.equal(r.state, 'PARKED');
    assert.equal(r.until - f.clock(), HEAD_MS);
    const [entry] = await f.ledger.parkedEntries();
    assert.equal(ResidentExecutor.lastTry(entry).position, 1);
  });
});
