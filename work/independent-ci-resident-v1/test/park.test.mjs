// Parking lifecycle and safe points. Owner actions, retry budgets and ruleset wake-up are in the other park test files.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ResidentExecutor, PARK_HEAD_RETRY_MS } from '../src/executor.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { POSITIONS, closedBreaker } from '../src/breaker.mjs';
import { describe as prPage, events as notificationEvents } from '../src/pr-status.mjs';
import { StatusBoard, parseStatus } from '../src/status.mjs';
import { Ledger, batchKey } from '../src/ledger.mjs';
import { Poller } from '../src/poller.mjs';
import { drainRequest, writeOwnerRequest } from '../tools/rearm-tool.mjs';
import { restAnswer } from './gh-rest-stub.mjs';
import { BASE, HEAD, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, holdAtA, rawPolicy, triggerBytes } from './helpers.mjs';
import { MIN, OWNER, H, subject, KEY, stagesRun, receiptTypes, notReady, stage8Engine, bodies, unreadable } from './park-fixtures.mjs';

describe('parking: lifecycle and safe points', () => {
  test('stage 8 not ready parks the batch at B after the close archive; tries back off 10, 20 minutes, then it completes', async t => {
    const engine = stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_QUEUE_HEAD_NOT_REACHED', { entered: true, state: 'waiting', position: 3 })], KEY);
    const f = await executorFixture(t, { engine });
    await f.drop(triggerBytes());
    const first = await f.exec.tick();
    assert.deepEqual([first.state, first.reason, first.tries], ['PARKED', 'RESIDENT_MERGE_QUEUE_NOT_JOINED', 1]);
    assert.deepEqual(stagesRun(engine), [1, 2, 3, 4, 5, 6, 7, 8]);
    const closeAt = engine.calls.findIndex(c => c[0] === 'close'), stage8At = engine.calls.findIndex(c => c[0] === 'stage' && c[1] === 8);
    assert.ok(closeAt >= 0 && closeAt < stage8At, 'the close archive on both hosts comes before stage 8 (the Linux zone ended)');
    const s = await f.ledger.state(KEY);
    assert.ok(Ledger.parkedAt(s));
    assert.deepEqual(s.tries.map(x => [x.n, x.ended.code]), [[1, 'RESIDENT_MERGE_QUEUE_NOT_JOINED']]);
    assert.equal(await f.executedHeads.published(subject()), true, 'recorded before stage 8 (stages 3, 5, 7 published)');
    assert.deepEqual([f.queue.row(884).state, f.queue.row(884).reason], ['PARKED', 'RESIDENT_MERGE_QUEUE_NOT_JOINED']);
    // the executor is not held: another PR runs meanwhile
    await f.drop(triggerBytes({ pr: 900, headSha: H(4) }));
    assert.equal((await f.exec.tick()).state, 'COMPLETED');
    f.advance(10 * MIN);
    const second = await f.exec.tick();
    assert.deepEqual([second.state, second.reason, second.position], ['PARKED', 'RESIDENT_QUEUE_HEAD_NOT_REACHED', 3]);
    f.advance(19 * MIN);
    assert.equal((await f.exec.tick()).state, 'IDLE', 'its 20-minute back-off');
    f.advance(MIN);
    const third = await f.exec.tick();
    assert.deepEqual([third.state, third.tries], ['COMPLETED', 3]);
    assert.equal((await f.ledger.state(KEY)).outcome, 'COMPLETED');
    assert.equal(f.queue.row(884).state, 'DONE');
    assert.equal((await receiptTypes(f)).filter(x => x === 'stage8-not-ready').length, 2);
  });

  test('a claim first in the merge queue is tried again in a minute; main moving ends the batch at once, never an attempt 2', async t => {
    const engine = stage8Engine([notReady('RESIDENT_QUEUE_HEAD_NOT_REACHED', { entered: true, state: 'waiting', position: 1 }), notReady('RESIDENT_BASE_MOVED')]);
    const f = await executorFixture(t, { engine });
    await f.drop(triggerBytes());
    const r = await f.exec.tick();
    assert.equal(r.until - f.clock(), PARK_HEAD_RETRY_MS);
    f.advance(PARK_HEAD_RETRY_MS);
    const moved = await f.exec.tick();
    assert.deepEqual([moved.state, moved.failureCode], ['FAILED_CLEAN', 'RESIDENT_BASE_MOVED']);
    assert.deepEqual(await f.ledger.pendingAttempts2(), []);
    assert.equal(f.queue.row(884).state, 'STOPPED');
  });

  test('the tries are bounded: the last not-ready answer leaves the batch asleep and neutral', async t => {
    const engine = stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]);
    const f = await executorFixture(t, { engine, policy: rawPolicy({ park: { ...rawPolicy().park, stage8MaxTries: 2 } }) });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'PARKED');
    f.advance(10 * MIN);
    const end = await f.exec.tick();
    assert.deepEqual([end.state, end.reason, end.until], ['PARKED', 'RESIDENT_MERGE_QUEUE_NOT_JOINED', null]);
    assert.equal(f.queue.breaker?.state ?? 'closed', 'closed', 'neutral');
    const notice = f.queue.notices.find(n => n.code === 'STAGE8_TRY_LIMIT');
    const board = new StatusBoard({ clock: f.clock });
    board.update({ notices: [notice], backfill: { complete: true } });
    const parked = { pr: 884, headSha: HEAD, state: 'PARKED', deferred: end.reason };
    board.setPending([{ ...parked, nextAt: null }]);
    const status = () => parseStatus(Buffer.from(JSON.stringify(board.snapshot())));
    const pull = { pr: 884, headSha: HEAD, eligible: true };
    const description = () => prPage({ pull, status: status(), now: f.clock() }).description;
    assert.match(description(), /相关变化后再查第 8 段/);
    assert.match(notificationEvents({ status: status(), now: f.clock() })[0].body, /相关变化后再查第 8 段/);
    board.setPending([{ ...parked, nextAt: f.clock() + MIN }]);
    assert.match(description(), /已测通/);
  });

  test('failed required checks sleep after the retry budget and a check change resumes the same batch', async t => {
    const engine = stage8Engine(Array.from({ length: 13 }, () => notReady('REQUIRED_CHECK_FAILED')), KEY);
    const f = await executorFixture(t, { engine, policy: rawPolicy({ park: { ...rawPolicy().park, stage8MaxTries: 13 } }) });
    await f.drop(triggerBytes());
    for (let i = 0; i < 13; i++) {
      const result = await f.exec.tick();
      assert.equal(result.state, 'PARKED');
      if (i < 12) f.advance(result.until - f.clock());
    }
    assert.ok(Ledger.parkedAt(await f.ledger.state(KEY)));
    assert.equal((await f.exec.parkedCounts()).outside, 0);
    let conclusion = 'failure', events = 0;
    const poller = new Poller({ repo: subject().repo, ghExe: 'gh', clock: f.clock,
      run: async argv => restAnswer(argv, { total_count: 1, check_runs: [{ id: 1, name: 'migration-verify', status: 'completed', conclusion }] }),
      writeTrigger: async trigger => { events++; await f.drop(Buffer.from(JSON.stringify(trigger))); } });
    poller.lastPass = { mainSha: BASE, pulls: [{ pr: 884, headSha: HEAD }] };
    const pending = f.queue.view(f.clock(), { etaBatchMs: 20 * MIN });
    await poller.parkedPass(pending);
    assert.equal(events, 0, 'the unchanged failed check is a baseline, not a wake');
    f.advance(180 * MIN);
    await f.exec.tick();
    assert.equal(stagesRun(engine).filter(stage => stage === 8).length, 13);
    conclusion = 'success';
    await poller.parkedPass(pending);
    await poller.parkedPass(pending);
    assert.equal(events, 1);
    assert.equal((await f.exec.tick()).state, 'COMPLETED');
    assert.deepEqual(stagesRun(engine), [1, 2, 3, 4, 5, 6, 7, ...Array(14).fill(8)]);
  });

  test('a stage-8 ending that may have written anything is no try: it is classified as before (UNKNOWN halts)', async t => {
    const engine = stage8Engine([{ ok: false, code: 'PUBLICATION_UNCERTAIN', proof: WINDOWS_CLEAN, outcome: { status: 'UNCERTAIN', reason: 'x', sideEffects: 1, mayHavePublished: true, diagnostic: null, scheduling: null, safeToRerun: false } }]);
    const f = await executorFixture(t, { engine });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'HALTED');
    assert.equal((await f.ledger.state(KEY)).outcome, 'FAILED_UNKNOWN');
  });

  test('a crash inside a stage-8 try is a crash scene; a crash at rest is not', async t => {
    const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]) });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'PARKED');
    // a restart at rest: the parked batch is resumed, nothing halts
    const fresh = new ResidentExecutor(f.ports);
    assert.equal((await fresh.tick()).state, 'IDLE');
    assert.equal(await f.ledger.halted(), null);
    // a try that began and never ended (the process died in stage 8)
    await f.ledger.beginTry(KEY, { batchId: 'x' });
    const again = new ResidentExecutor(f.ports);
    assert.equal((await again.tick()).state, 'HALTED');
    assert.equal((await f.ledger.state(KEY)).outcome, 'FAILED_UNKNOWN');
  });

  test('the parking slots: at most maxParked batches rest in the first places; outside them the bound ends a batch', async t => {
    const second = notReady('RESIDENT_QUEUE_HEAD_NOT_REACHED', { entered: true, state: 'waiting', position: 2 });
    const f = await executorFixture(t, { engine: stage8Engine([second]), policy: rawPolicy({ park: { ...rawPolicy().park, maxParked: 1 } }) });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'PARKED');
    await f.drop(triggerBytes({ pr: 900, headSha: H(4) }));
    assert.deepEqual(await f.exec.tick(), { state: 'DEFERRED', reason: 'PARKING_FULL' });
    const overEngine = stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]);
    const derive = overEngine.derive;
    overEngine.derive = async (...args) => ({ ...await derive(...args), ciSourceManifestSha256: policy.ciSourceManifestSha256 });
    const policy = rawPolicy({ park: { ...rawPolicy().park, maxParkedOutsideTop2: 0 } });
    const g = await executorFixture(t, { engine: overEngine,
      companion: fakeCompanion({ pull: pr => ({ number: pr, state: 'open', headSha: HEAD }) }),
      policy });
    await g.drop(triggerBytes());
    const over = await g.exec.tick();
    assert.deepEqual([over.state, over.failureCode], ['FAILED_CLEAN', 'PARKED_OVER_CAPACITY']);
    await g.exec.tick();
    assert.equal(stagesRun(g.engine).length, 8, 'the same head observes its release back-off');
    g.advance(10 * MIN);
    assert.equal((await g.exec.tick()).state, 'COMPLETED');
    assert.deepEqual(stagesRun(g.engine), [1, 2, 3, 4, 5, 6, 7, 8, 8]);
  });

  test('a nudge (main moved, or the parked PR changed) brings the next try forward; the stage-8 budget bounds the tries', async t => {
    const engine = stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_BASE_MOVED')]);
    const f = await executorFixture(t, { engine });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'PARKED');
    await f.drop(triggerBytes({ pr: 900, headSha: H(4), baseSha: H(9) })); // the poller saw another main tip
    f.advance(MIN);
    const r = await f.exec.tick();
    assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', 'RESIDENT_BASE_MOVED'], 'tried at once, not after 10 minutes');
    const g = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]),
      policy: rawPolicy({ park: { ...rawPolicy().park, stage8RetriesPer24h: 0 } }) });
    await g.drop(triggerBytes());
    assert.equal((await g.exec.tick()).state, 'PARKED', 'the first try is no retry');
    g.advance(10 * MIN);
    assert.equal((await g.exec.tick()).state, 'IDLE');
    assert.ok(g.queue.notices.some(n => n.kind === 'stage8-budget'));
  });

  test('an install authority ending soon closes a parked batch neutrally instead of a HALT', async t => {
    const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]), policy: rawPolicy({ validUntil: '2026-10-21T02:00:00Z' }) });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'PARKED');
    // 11.5 hours later (inside park.maxMs) the install authority ends within one batch budget
    f.advance(Date.parse('2026-10-20T23:30:00Z') - f.clock());
    const r = await f.exec.tick();
    assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', 'PARKED_AUTHORITY_EXPIRING']);
    assert.equal(await f.ledger.halted(), null);
  });

  test('the breaker: parking after stage 7 is a pass of every stage before it; a stage-8 try is Windows-only', async t => {
    const burn = { ok: false, code: 'STAGE_PACKAGE_REFUSED', proof: WINDOWS_CLEAN };
    const engine = fakeEngine();
    const base = engine.runStage;
    let failStage2 = 3, stage8 = [notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')];
    engine.runStage = async (batch, stage, o) => {
      if (stage.number === 2 && failStage2 > 0) { failStage2 -= 1; engine.calls.push(['stage', 2]); return burn; }
      if (stage.number === 8 && stage8.length) { engine.calls.push(['stage', 8]); return stage8.shift(); }
      return base(batch, stage, o);
    };
    const f = await executorFixture(t, { engine });
    for (const n of [1, 2, 3, 4]) await f.drop(triggerBytes({ pr: n, headSha: H(n) }));
    for (let i = 0; i < 3; i++) await f.exec.tick();
    assert.equal(f.queue.breaker.state, 'open');
    f.advance(30 * MIN);
    const trial = await f.exec.tick();
    assert.equal(trial.state, 'PARKED', 'the trial got past stage 2 and parked');
    assert.equal(f.queue.breaker.state, 'closed', 'getting past stage 7 closes a stage-2 breaker');
  });

  test('parking point A: a batch resumed with a bundle older than 100 minutes ends before the workspace, nothing on Linux', async t => {
    const f = await executorFixture(t);
    const atA = holdAtA(f.exec);
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'WAITING');
    f.advance(101 * MIN);
    atA.release();
    const r = await f.exec.tick();
    assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', 'PARKED_BUNDLE_TOO_OLD']);
    assert.deepEqual(stagesRun(f.engine), [1], 'no workspace preparation or local Linux scan');
    assert.ok(!f.companion.calls.some(c => c[0] === 'wsprep'));
    assert.deepEqual(await f.ledger.pendingAttempts2(), []);
    assert.equal(f.queue.row(884).state, 'STOPPED');
  });

  test('a newer commit of a parked PR ends the parked batch once a live read confirms it; the newer commit runs next', async t => {
    // a live read that still sees the parked head: the batch stays parked (the trigger only brought its next try forward)
    const g = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY),
      companion: fakeCompanion({ pull: pr => ({ number: pr, state: 'open', headSha: HEAD }) }) });
    await g.drop(triggerBytes());
    assert.equal((await g.exec.tick()).state, 'PARKED');
    await g.drop(triggerBytes({ headSha: H(7) }));
    assert.deepEqual([(await g.exec.tick()).state, g.queue.row(884).state, (await g.ledger.state(KEY)).state], ['PARKED', 'PARKED', 'STARTED']);
    // a live read that confirms the push: ended at its safe point at once, published, then the newer commit runs
    const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY),
      companion: fakeCompanion({ pull: pr => ({ number: pr, state: 'open', headSha: H(7) }) }) });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'PARKED');
    await f.drop(triggerBytes({ headSha: H(7) }));
    const ended = await f.exec.tick();
    assert.deepEqual([ended.state, ended.failureCode, ended.safePoint], ['FAILED_CLEAN', 'SUPERSEDED_AT_SAFE_POINT', 'parked']);
    assert.equal((await f.ledger.state(KEY)).terminal.facts.stage, 8, 'stages 3, 5 and 7 published');
    assert.equal(await f.executedHeads.published(subject()), true);
    assert.equal((await f.exec.tick()).state, 'COMPLETED');
    assert.equal(f.queue.row(884).current.headSha, H(7));
    assert.equal(f.queue.row(884).state, 'DONE');
  });

  // ---- the independent review of step 2 ----

  test('review M2: a supersession at parking point B never closes a breaker a Linux place opened', async t => {
    const engine = stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY);
    const at8 = engine.runStage;
    const failing = new Set([batchKey(subject({ pr: 901, headSha: H(3) })), batchKey(subject({ pr: 902, headSha: H(6) })), batchKey(subject({ pr: 903, headSha: H(8) }))]);
    engine.runStage = async (batch, stage, o) => (failing.has(batch.key) && stage.number === 2 ? (engine.calls.push(['stage', 2]), { ok: false, code: 'STAGE_PACKAGE_REFUSED', proof: WINDOWS_CLEAN }) : at8(batch, stage, o));
    const f = await executorFixture(t, { engine, companion: fakeCompanion({
      pull: pr => ({ number: pr, state: 'open', headSha: pr === 884 ? H(7) : f.queue.row(pr).current.headSha }),
    }) });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'PARKED');
    for (const [n, h] of [[1, 3], [2, 6], [3, 8]]) { await f.drop(triggerBytes({ pr: 900 + n, headSha: H(h) })); assert.equal((await f.exec.tick()).state, 'FAILED_CLEAN'); }
    assert.equal(f.queue.breaker.state, 'open');
    await f.drop(triggerBytes({ headSha: H(7) }));
    const r = await f.exec.tick();
    assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', 'SUPERSEDED_AT_SAFE_POINT']);
    assert.equal(f.queue.breaker.state, 'open', 'the stage-8 place is Windows-only');
  });

  test('review m3, m13, m8: the PR page never calls an untested commit tested, nor claims a queue place it does not know', async t => {
    // a newer commit of a parked PR, the live read unanswered: the batch stays at B, the newer commit is not shown parked
    const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY) });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'PARKED');
    await f.drop(triggerBytes({ headSha: H(7) }));
    await f.exec.tick();
    assert.ok(Ledger.parkedAt(await f.ledger.state(KEY)));
    const row = f.queue.view(f.clock(), { etaBatchMs: 20 * MIN }).find(r => r.pr === 884);
    assert.deepEqual([row.headSha, row.state, row.queuePosition], [H(7), 'RUNNING', null]);
    const now = Date.parse('2026-10-22T09:00:00Z');
    const board = fn => { const b = new StatusBoard({ clock: () => now }); b.update({ backfill: { complete: true, published: 0, unreadable: 0 } }); fn(b); return parseStatus(Buffer.from(JSON.stringify(b.snapshot()))); };
    const pull = { pr: 7, headSha: H(7), eligible: true, hint: null, behindBy: 0 };
    const newer = prPage({ pull, status: board(b => b.setPending([{ pr: 7, headSha: H(7), baseSha: BASE, state: 'RUNNING' }])), now });
    assert.ok(newer === null || (newer.weak === true && !/已测通/.test(newer.description)), JSON.stringify(newer));
    // a parked row without a place: waiting for the merge queue, no claim that it is in it
    const parked = prPage({ pull, status: board(b => b.setPending([{ pr: 7, headSha: H(7), baseSha: BASE, state: 'PARKED', deferred: 'RESIDENT_QUEUE_HEAD_NOT_REACHED', nextAt: now + 10 * MIN }])), now });
    assert.match(parked.description, /^已测通：等合并队列/);
    const placed = prPage({ pull, status: board(b => b.setPending([{ pr: 7, headSha: H(7), baseSha: BASE, state: 'PARKED', deferred: 'RESIDENT_QUEUE_HEAD_NOT_REACHED', queuePosition: 2, nextAt: now + 10 * MIN }])), now });
    assert.match(placed.description, /在合并队列第 2 位/);
    // the parking places full: no estimate that assumes a free executor
    const full = prPage({ pull, status: board(b => { b.update({ queue: { generation: 'abcdefabcdef', live: 2, depth: 100, parkingFull: true } }); b.setPending([{ pr: 6, headSha: H(6), baseSha: BASE }, { pr: 7, headSha: H(7), baseSha: BASE, eta: now + 20 * MIN }]); }), now });
    assert.equal(full.description, '排队第 2 位：停靠的批次已满，等它们结束');
  });

  test('park.maxMs puts a zero-effect parked batch to sleep even when no try is allowed', async t => {
    const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY), policy: rawPolicy({ park: { ...rawPolicy().park, stage8RetriesPer24h: 0 } }) });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'PARKED');
    f.advance(23 * 60 * MIN);
    assert.ok(Ledger.parkedAt(await f.ledger.state(KEY)), 'no retry budget: it only rests');
    await f.exec.tick();
    assert.ok(Ledger.parkedAt(await f.ledger.state(KEY)));
    f.advance(60 * MIN);
    await f.exec.tick();
    assert.ok(Ledger.parkedAt(await f.ledger.state(KEY)));
    assert.equal(f.exec.parkedDueAt(await f.ledger.state(KEY)), Infinity);
    assert.equal(stagesRun(f.engine).filter(n => n === 8).length, 1, 'no stage ran to go to sleep');
    assert.equal(await f.ledger.halted(), null);
  });

  test('review m9, m11, m12: no new batch while the outside bound is full or a trial rests at A; a breaker feed never ends a parked batch', async t => {
    const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY), policy: rawPolicy({ park: { ...rawPolicy().park, maxParkedOutsideTop2: 1 } }) });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'PARKED');
    await f.drop(triggerBytes({ pr: 900, headSha: H(4) }));
    assert.deepEqual([(await f.exec.tick()).reason, f.engine.calls.filter(c => c[0] === 'derive').length], ['PARKING_FULL', 1]);
    // a half-open breaker starts no trial while a batch rests at parking point A
    const g = await executorFixture(t);
    holdAtA(g.exec);
    await g.drop(triggerBytes());
    assert.equal((await g.exec.tick()).state, 'WAITING');
    g.queue.breaker = { ...closedBreaker(), state: 'open', level: 0, openedAt: g.clock(), nextTrialAt: g.clock() - 1, failingPos: POSITIONS[2], failingWindowsOnly: false, exclude: [] };
    await g.drop(triggerBytes({ pr: 900, headSha: H(4) }));
    assert.equal((await g.exec.tick()).reason, 'BREAKER_TRIAL_PENDING');
    // a breaker feed that throws when the batch parks never turns the batch at rest into a crash
    const h = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY) });
    h.exec.feedBreaker = async () => { throw new Error('receipt store full'); };
    await h.drop(triggerBytes());
    assert.equal((await h.exec.tick()).state, 'PARKED');
    assert.equal(await h.ledger.halted(), null);
  });

  test('re-review m16: drifted bytes end a parked batch UNKNOWN with a HALT, never through the archive tools', async t => {
    for (const ending of ['supersede', 'authority']) {
      const engine = stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY);
      const f = await executorFixture(t, { engine, policy: rawPolicy(ending === 'authority' ? { validUntil: '2026-10-21T02:00:00Z' } : {}),
        companion: fakeCompanion({ pull: pr => ({ number: pr, state: 'open', headSha: H(7) }) }) });
      await f.drop(triggerBytes());
      assert.equal((await f.exec.tick()).state, 'PARKED');
      const drifted = new ResidentExecutor({ ...f.ports, sourceIntegrity: async () => ({ ok: false }) });
      if (ending === 'supersede') await f.drop(triggerBytes({ headSha: H(7) }));
      if (ending === 'authority') f.advance(Date.parse('2026-10-20T23:30:00Z') - f.clock());
      const r = await drifted.tick();
      assert.equal(r.state, 'HALTED', ending);
      assert.equal((await f.ledger.halted()).value.code, 'RESIDENT_SOURCE_DRIFT', ending);
      assert.equal(engine.calls.filter(c => c[0] === 'archive-windows').length, 0, ending);
    }
  });

  test('re-review m8, N6, N9: parking full is on every status; the back-off after a head run; a drain stopped part-way says so', async t => {
    // parking full stays visible on a tick that ran a parked try (the executor state is PARKED then)
    const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY),
      policy: rawPolicy({ park: { ...rawPolicy().park, maxParkedOutsideTop2: 1 } }), status: new StatusBoard({ clock: () => Date.parse('2026-10-20T12:00:00Z') }) });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'PARKED');
    f.advance(10 * MIN);
    assert.equal((await f.exec.tick()).state, 'PARKED');
    assert.equal(parseStatus(Buffer.from(JSON.stringify(f.ports.status.snapshot()))).queue.parkingFull, true);
    // N6: after 15 minutes at the queue's first place the next try follows the counted tries (10 minutes), not 2 hours
    const head = notReady('RESIDENT_QUEUE_HEAD_NOT_REACHED', { entered: true, state: 'waiting', position: 1 });
    const g = await executorFixture(t, { engine: stage8Engine(Array.from({ length: 30 }, () => head), KEY) });
    await g.drop(triggerBytes());
    let r = await g.exec.tick();
    while (r.until - g.clock() === PARK_HEAD_RETRY_MS) { g.advance(PARK_HEAD_RETRY_MS); r = await g.exec.tick(); }
    assert.equal(r.until - g.clock(), 10 * MIN);
    // N9: the second entry's acceptance fails before anything was written: the first one stays ended and reported
    const h = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]) });
    await h.drop(triggerBytes());
    assert.equal((await h.exec.tick()).state, 'PARKED');
    await h.drop(triggerBytes({ pr: 900, headSha: H(4) }));
    assert.equal((await h.exec.tick()).state, 'PARKED');
    const begin = h.ledger.beginOwnerAbort.bind(h.ledger);
    let calls = 0;
    h.ledger.beginOwnerAbort = async (...a) => { if (++calls === 2) throw Object.assign(new Error('disk'), { code: 'LEDGER_WRITE_FAILED' }); return begin(...a); };
    h.advance(1);
    await writeOwnerRequest(path.join(h.root, 'owner'), drainRequest({ reason: 'reinstall', by: OWNER }, h.clock), h.clock);
    await h.exec.tick();
    const done = (await bodies(h, 'owner-request')).find(b => b.kind === 'drain');
    assert.deepEqual([done.ended.length, done.remaining, typeof done.stoppedBy], [1, 1, 'string']);
    assert.equal((await bodies(h, 'owner-request-refused')).length, 0);
  });

  // ---- the final check of step 2 (test gaps n1, n2) ----
  test('final check n1: drifted bytes at an expiring authority end a batch waiting at A with a HALT, no archive', async t => {
    const f = await executorFixture(t);
    holdAtA(f.exec);
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'WAITING');
    const later = new ResidentExecutor({ ...f.ports, policy: validatePolicy(rawPolicy({ validUntil: new Date(f.clock() + 60_000).toISOString() })),
      sourceIntegrity: async () => ({ ok: false }) });
    const r = await later.tick();
    assert.equal(r.state, 'HALTED');
    assert.equal((await f.ledger.halted()).value.code, 'RESIDENT_SOURCE_DRIFT');
    assert.equal(f.engine.calls.filter(c => c[0] === 'archive-windows').length, 0);
  });
});
