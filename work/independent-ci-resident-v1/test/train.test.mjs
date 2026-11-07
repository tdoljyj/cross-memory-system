// The merge train on the resident side, shadow mode (quota redesign phase 2, step 3c-1; DESIGN §22.3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { trainDue, trainPageLine, trainSummary, WOULD_DO } from '../src/train.mjs';
import { executorFixture, fakeEngine, rawPolicy, triggerBytes } from './helpers.mjs';
import { WOULD_DO as SOURCE_WOULD_DO, TRAIN_FACTS_CONTRACT } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-facts.mjs';

const MIN = 60_000, NOW = Date.parse('2026-10-23T12:00:00Z');
const train = { enabled: 'shadow', nonFrontRuns: true, maintenanceEveryMs: 10 * MIN, maintenanceMaxPerDay: 200 };

test('stage 10 is due when the train is not off, nothing runs, and the interval and the daily cap allow it', () => {
  assert.equal(trainDue({ train, now: NOW, runs: [], busy: false }), true);
  assert.equal(trainDue({ train: { ...train, enabled: 'off' }, now: NOW, runs: [], busy: false }), false);
  assert.equal(trainDue({ train, now: NOW, runs: [], busy: true }), false, 'never while a batch runs');
  assert.equal(trainDue({ train, now: NOW, runs: [NOW - 9 * MIN], busy: false }), false);
  assert.equal(trainDue({ train, now: NOW, runs: [NOW - 10 * MIN], busy: false }), true);
  // the daily cap counts the last 24 hours only
  const full = Array.from({ length: 200 }, (_, i) => NOW - 23 * 3600_000 + i * 1000);
  assert.equal(trainDue({ train, now: NOW, runs: full, busy: false }), false);
  assert.equal(trainDue({ train, now: NOW + 3600_000, runs: full, busy: false }), true);
  assert.equal(trainDue({ train: { ...train, maintenanceMaxPerDay: 0 }, now: NOW, runs: [], busy: false }), false);
});

test('the resident and Source v2 name the same train answers and contract', () => {
  assert.deepEqual([...WOULD_DO], [...SOURCE_WOULD_DO]);
  assert.equal(trainSummary({ contract: TRAIN_FACTS_CONTRACT, mode: 'shadow', at: 'x', wouldDo: 'NO_FRONT', front: null })?.wouldDo, 'NO_FRONT');
});

test('the summary keeps only what status and the PR page show; the page line is for the front PR only', () => {
  const facts = { contract: 'clued.independent-ci.train-facts/1', mode: 'shadow', at: '2026-10-23T12:00:00.000Z', onDuty: true, mainSha: '1'.repeat(40), rules: { strict: true, mergeOnly: false },
    front: { claimId: 'c', pr: 910, headSha: '2'.repeat(40) }, wouldDo: 'OPEN_FRONT_BATCH', wouldRevoke: [], wouldRevokeCount: 3 };
  const s = trainSummary(facts);
  assert.deepEqual({ ...s }, { at: facts.at, mode: 'shadow', wouldDo: 'OPEN_FRONT_BATCH', onDuty: true, front: { pr: 910, headSha: '2'.repeat(40) }, mainSha: '1'.repeat(40), strict: true, wouldRevokeCount: 3 });
  assert.match(trainPageLine(s, 910), /^列车影子（只记录，不执行）：你是合并队列车头。开车后会在 GitHub 的试合并提交上跑车头批次。$/);
  assert.equal(trainPageLine(s, 911), null);
  // generation 15 (DESIGN 60.2): the front's page says why nothing goes green while the train re-sweeps after main was rewritten
  const pending = allPending => ({ mode: 'on', decision: 'TRAIN_TAKEOVER_SWEEP_PENDING', front: { pr: 910 }, sweep: { fullSweep: { allPending } } });
  assert.equal(trainPageLine(pending('TRAIN_MAIN_REWRITTEN'), 910), '合并列车：你是车头。main 被改写，合并列车在重扫全部 PR 和提交，扫完前不发绿。');
  assert.equal(trainPageLine(pending(null), 910), '合并列车：你是车头。接班清扫未完成，暂不发绿。');
  assert.equal(trainPageLine(trainSummary({ ...facts, wouldDo: 'NOT_ON_DUTY', front: null }), 910), null);
  for (const bad of [null, { ...facts, contract: 'x' }, { ...facts, mode: 'on' }, { ...facts, wouldDo: 'REVOKE' }]) assert.equal(trainSummary(bad), null);
});

// ---- the executor's stage 10 (DESIGN §22.3) ----
const shadowPolicy = (train = {}, top = {}) => rawPolicy({ train: { enabled: 'shadow', nonFrontRuns: true, maintenanceEveryMs: 10 * MIN, maintenanceMaxPerDay: 200, ...train }, ...top });
const ofType = async (receipts, type) => (await receipts.latest([type], 1000)).map(e => e.value.body);
const trainCalls = engine => engine.calls.filter(c => c[0] === 'stage' && c[1] === 10);

test('executor: an idle tick runs stage 10 when due, records it, and leaves the batch path alone', async t => {
  const f = await executorFixture(t, { policy: shadowPolicy() });
  assert.equal((await f.exec.tick()).state, 'IDLE');
  assert.deepEqual(trainCalls(f.engine), [['stage', 10, 'shadow']]);
  assert.deepEqual(await ofType(f.receipts, 'train-run-intent'), [{ mode: 'shadow' }]);
  const [run] = await ofType(f.receipts, 'train-run');
  assert.deepEqual(run, { intentSeq: (await f.receipts.latest(['train-run-intent'], 1))[0].seq, runId: `${'7'.repeat(16)}-${'0'.repeat(12)}`, mode: 'shadow', ok: true, failureCode: null,
    wouldDo: 'NO_FRONT', frontPr: null, mainSha: null, wouldRevokeCount: 0 });
  assert.equal(f.exec.trainLast.wouldDo, 'NO_FRONT');
  // not due again before maintenanceEveryMs
  f.advance(9 * MIN);
  await f.exec.tick();
  assert.equal(trainCalls(f.engine).length, 1);
  f.advance(MIN);
  await f.exec.tick();
  assert.equal(trainCalls(f.engine).length, 2);
  assert.equal(await f.ledger.halted(), null);
});

test('executor: stage 10 never runs with the train off, while PAUSED, or past the daily cap', async t => {
  const off = await executorFixture(t);
  await off.exec.tick();
  assert.deepEqual(trainCalls(off.engine), []);
  assert.deepEqual(await ofType(off.receipts, 'train-run-intent'), []);

  const paused = await executorFixture(t, { policy: shadowPolicy() });
  await paused.ledger.pause({ reason: 'test', requestSha256: 'a'.repeat(64) });
  assert.equal((await paused.exec.tick()).state, 'PAUSED');
  assert.deepEqual(trainCalls(paused.engine), [], 'step 3c-1: PAUSE holds stage 10 as well');

  const capped = await executorFixture(t, { policy: shadowPolicy({ maintenanceEveryMs: MIN, maintenanceMaxPerDay: 2 }) });
  for (let i = 0; i < 4; i += 1) { await capped.exec.tick(); capped.advance(MIN); }
  assert.equal(trainCalls(capped.engine).length, 2);
  capped.advance(24 * 3600_000);
  await capped.exec.tick();
  assert.equal(trainCalls(capped.engine).length, 3, 'the cap counts the last 24 hours');
});

test('executor: a failed stage 10 is only a receipt; an unproven cleanup or an exception HALTs', async t => {
  const failed = await executorFixture(t, { policy: shadowPolicy(), engine: fakeEngine({ train: () => ({ ok: false, code: 'TRAIN_STAGE_REFUSED', proof: { windowsTreeZero: true, serviceOriginalStopped: true } }) }) });
  // (TRAIN_STAGE_REFUSED is the engine's own refusal before anything was asked of the broker)
  assert.equal((await failed.exec.tick()).state, 'IDLE');
  assert.deepEqual((await ofType(failed.receipts, 'train-run')).map(b => [b.ok, b.failureCode, b.runId]), [[false, 'TRAIN_STAGE_REFUSED', null]]);
  assert.equal(await failed.ledger.halted(), null);
  // facts that are no train facts are not a success
  const odd = await executorFixture(t, { policy: shadowPolicy(), engine: fakeEngine({ train: () => ({ ok: true, runId: 'x', proof: { windowsTreeZero: true, serviceOriginalStopped: true }, train: { wouldDo: 'REVOKE' } }) }) });
  await odd.exec.tick();
  assert.deepEqual((await ofType(odd.receipts, 'train-run')).map(b => [b.ok, b.failureCode]), [[false, 'TRAIN_FACTS_UNCONFIRMED']]);

  const unproven = await executorFixture(t, { policy: shadowPolicy(), engine: fakeEngine({ train: () => ({ ok: false, code: 'BROKER_TIMEOUT', proof: { windowsTreeZero: false, serviceOriginalStopped: true } }) }) });
  assert.deepEqual(await unproven.exec.tick(), { state: 'HALTED', failureCode: 'TRAIN_STAGE_CLEANUP_UNCONFIRMED' });
  assert.equal((await unproven.ledger.halted()).value.code, 'TRAIN_STAGE_CLEANUP_UNCONFIRMED');
  assert.deepEqual((await ofType(unproven.receipts, 'train-run')).map(b => b.failureCode), ['BROKER_TIMEOUT']);

  const thrown = await executorFixture(t, { policy: shadowPolicy(), engine: fakeEngine({ train: () => { throw new Error('boom'); } }) });
  assert.equal((await thrown.exec.tick()).failureCode, 'TRAIN_STAGE_CLEANUP_UNCONFIRMED');
  assert.deepEqual((await ofType(thrown.receipts, 'train-run')).map(b => b.failureCode), ['RESIDENT_EXECUTOR_EXCEPTION']);

  const drifted = await executorFixture(t, { policy: shadowPolicy(), integrity: { ok: true, sourceManifestSha256: 'f'.repeat(64), residentManifestSha256: 'f'.repeat(64) } });
  await drifted.exec.tick();
  assert.equal((await drifted.ledger.halted()).value.code, 'RESIDENT_SOURCE_DRIFT');
  assert.deepEqual(trainCalls(drifted.engine), [], 'never from drifted bytes');
});

test('executor: an intent no train-run receipt closed HALTs once at the next start; the run count survives a restart', async t => {
  const first = await executorFixture(t, { policy: shadowPolicy() });
  await first.exec.tick();
  await first.receipts.append('train-run-intent', { mode: 'shadow' }); // a crash right after the intent
  const second = await executorFixture(t, { policy: shadowPolicy(), root: first.root });
  assert.deepEqual(await second.exec.tick(), { state: 'HALTED', failureCode: 'TRAIN_STAGE_INTERRUPTED' });
  assert.equal((await second.ledger.halted()).value.code, 'TRAIN_STAGE_INTERRUPTED');
  assert.deepEqual((await ofType(second.receipts, 'train-run')).map(b => b.failureCode), [null, 'TRAIN_STAGE_INTERRUPTED']);
  assert.deepEqual(trainCalls(second.engine), []);
  // a third start finds the interruption closed and both runs counted (the cap and the interval read the receipts)
  const third = await executorFixture(t, { policy: shadowPolicy({ maintenanceMaxPerDay: 2 }), root: first.root });
  assert.equal(await third.exec.trainRecover(), null);
  assert.equal(third.exec.trainRuns.length, 2);
});

test('the status copy of a summary and the PR page line: recent, this head at the front, never on a failure', async () => {
  const { parseTrainLast, withTrainLine, TRAIN_PAGE_MAX_AGE_MS } = await import('../src/train.mjs');
  const facts = { contract: 'clued.independent-ci.train-facts/1', mode: 'shadow', at: '2026-10-23T12:00:00.000Z', onDuty: true, mainSha: '1'.repeat(40), rules: { strict: true, mergeOnly: true },
    front: { claimId: 'c', pr: 910, headSha: '2'.repeat(40) }, wouldDo: 'FRONT_GREEN_WAIT_MERGE', wouldRevoke: [], wouldRevokeCount: 0 };
  const last = parseTrainLast(JSON.parse(JSON.stringify(trainSummary(facts))));
  assert.deepEqual({ ...last }, { at: NOW, mode: 'shadow', wouldDo: 'FRONT_GREEN_WAIT_MERGE', onDuty: true, front: { pr: 910, headSha: '2'.repeat(40) }, mainSha: '1'.repeat(40), strict: true, wouldRevokeCount: 0 });
  for (const bad of [null, [], { ...last, at: 'x' }, { ...last, mode: 'on' }, { ...last, wouldDo: 'REVOKE' }]) assert.equal(parseTrainLast(bad), null);
  const pull = { pr: 910, headSha: '2'.repeat(40) };
  const parked = { state: 'pending', description: '已测通，在合并队列第 1 位：等成为队首，约 12:05 再查第 8 段' };
  assert.match(withTrainLine(parked, last, pull, NOW + MIN).description, /^已测通.*；列车影子（只记录，不执行）：你是合并队列车头。车头六项已绿，等合并。$/);
  assert.equal(withTrainLine(parked, last, pull, NOW + TRAIN_PAGE_MAX_AGE_MS + 1), parked, 'too old');
  assert.equal(withTrainLine(parked, last, { ...pull, headSha: '3'.repeat(40) }, NOW), parked, 'another head');
  assert.equal(withTrainLine(parked, last, { ...pull, pr: 911 }, NOW), parked, 'another PR');
  const failed = { state: 'failure', description: 'x' };
  assert.equal(withTrainLine(failed, last, pull, NOW), failed);
  assert.equal(withTrainLine(null, last, pull, NOW), null);
  assert.ok(withTrainLine({ state: 'pending', description: 'y'.repeat(140) }, last, pull, NOW).description.length <= 140);
});

test('the status snapshot carries the train mode and the newest summary; the companion reads them back', async () => {
  const { StatusBoard, parseStatus } = await import('../src/status.mjs');
  const b = new StatusBoard({ clock: () => NOW, pid: 7 });
  assert.deepEqual(parseStatus(Buffer.from(JSON.stringify(b.snapshot()))).train, { enabled: 'off', last: null });
  const facts = { contract: 'clued.independent-ci.train-facts/1', mode: 'shadow', at: '2026-10-23T12:00:00.000Z', onDuty: false, mainSha: null, rules: null, front: null, wouldDo: 'NOT_ON_DUTY', wouldRevoke: [], wouldRevokeCount: 0 };
  b.update({ train: { enabled: 'shadow', last: trainSummary(facts) } });
  const read = parseStatus(Buffer.from(JSON.stringify(b.snapshot()))).train;
  assert.deepEqual([read.enabled, read.last.wouldDo, read.last.at, read.last.onDuty], ['shadow', 'NOT_ON_DUTY', NOW, false]);
  assert.deepEqual(parseStatus(Buffer.from(JSON.stringify({ ...b.snapshot(), train: { enabled: 'sideways', last: { wouldDo: 'x' } } }))).train, { enabled: null, last: null });
});

test('executor (review of 3c-1): an intake pause holds stage 10 also with an empty queue; the install authority keeps its margin', async t => {
  const f = await executorFixture(t, { policy: shadowPolicy() });
  const { intakePauseRequest } = await import('../src/intake-pause.mjs');
  await f.drop(JSON.stringify(intakePauseRequest({ minutes: 30, reason: 'planned switch' }, f.clock)), 'requests');
  assert.equal((await f.exec.tick()).state, 'IDLE');
  assert.deepEqual(trainCalls(f.engine), [], 'held by the intake pause with an empty queue (M1)');
  // the install authority: stage 10's cap plus the helper's margin (stageMarginMs) must fit before validUntil (m2)
  const cap = 300_000, margin = 180_000, at = Date.parse('2026-10-20T12:00:00Z');
  const tight = await executorFixture(t, { policy: shadowPolicy({}, { validUntil: new Date(at + cap + margin - 1).toISOString() }) });
  await tight.exec.tick();
  assert.deepEqual(trainCalls(tight.engine), []);
  const room = await executorFixture(t, { policy: shadowPolicy({}, { validUntil: new Date(at + cap + margin + 60_000).toISOString() }) });
  await room.exec.tick();
  assert.equal(trainCalls(room.engine).length, 1);
});

test('executor (review of 3c-1): a side effect, an unknown failure or a broker conflict HALTs; a clean BLOCKED does not', async t => {
  const proof = { windowsTreeZero: true, serviceOriginalStopped: true };
  const outcome = o => ({ status: 'BLOCKED', reason: 'github_http_502', sideEffects: 0, mayHavePublished: false, diagnostic: null, scheduling: null, safeToRerun: true, ...o });
  const cases = [
    [{ ok: false, code: 'PUBLICATION_BLOCKED', proof, outcome: outcome() }, null],
    [{ ok: false, code: 'PUBLICATION_UNCERTAIN', proof, outcome: outcome({ status: 'UNCERTAIN', sideEffects: 1, mayHavePublished: true }) }, 'TRAIN_STAGE_OUTCOME_UNCONFIRMED'],
    [{ ok: false, code: 'BROKER_BUSY', proof }, 'TRAIN_STAGE_OUTCOME_UNCONFIRMED'],
    [{ ok: false, code: 'STAGE_OUTCOME_MISSING', proof }, 'TRAIN_STAGE_OUTCOME_UNCONFIRMED'],
    [{ ok: true, runId: 'x', proof, outcome: outcome({ status: 'TRAIN_FACTS', sideEffects: 1 }), train: null }, 'TRAIN_STAGE_OUTCOME_UNCONFIRMED'],
  ];
  for (const [answer, halt] of cases) {
    const f = await executorFixture(t, { policy: shadowPolicy(), engine: fakeEngine({ train: () => answer }) });
    const r = await f.exec.tick();
    assert.equal((await f.ledger.halted())?.value?.code ?? null, halt, answer.code ?? 'facts with a side effect');
    if (halt) assert.deepEqual(r, { state: 'HALTED', failureCode: halt });
    assert.equal((await ofType(f.receipts, 'train-run')).length, 1, 'the run is closed in every case');
  }
});

test('executor (review of 3c-1): the HALT comes before the closing receipt; an unreadable chain holds every batch, then HALTs', async t => {
  const f = await executorFixture(t, { policy: shadowPolicy(), engine: fakeEngine({ train: () => ({ ok: false, code: 'X', proof: { windowsTreeZero: false, serviceOriginalStopped: true } }) }) });
  const append = f.receipts.append.bind(f.receipts);
  f.receipts.append = async (type, body) => { if (type === 'train-run') throw new Error('disk full'); return append(type, body); };
  await assert.rejects(f.exec.tick());
  assert.equal((await f.ledger.halted()).value.code, 'TRAIN_STAGE_CLEANUP_UNCONFIRMED', 'latched although the receipt failed');
  // the chain cannot be read: batches wait (DEFERRED), for at most BACKFILL_PENDING_MAX_MS, then HALT
  const { BACKFILL_PENDING_MAX_MS } = await import('../src/executor.mjs');
  const g = await executorFixture(t, { policy: shadowPolicy() });
  g.receipts.latest = async () => { throw new Error('EBUSY'); };
  assert.deepEqual(await g.exec.tick(), { state: 'DEFERRED', reason: 'TRAIN_RECEIPTS_PENDING' });
  await g.drop(triggerBytes());
  assert.equal((await g.exec.tick()).reason, 'TRAIN_RECEIPTS_PENDING', 'no batch either');
  assert.deepEqual(g.engine.calls.filter(c => c[0] === 'derive'), []);
  g.advance(BACKFILL_PENDING_MAX_MS);
  assert.deepEqual(await g.exec.tick(), { state: 'HALTED', failureCode: 'TRAIN_RECEIPTS_UNREADABLE' });
});

test('executor (review of 3c-1): the status says RUNNING TRAIN_MAINTENANCE while stage 10 runs', async t => {
  const { StatusBoard } = await import('../src/status.mjs');
  const status = new StatusBoard({ clock: () => Date.parse('2026-10-20T12:00:00Z'), pid: 1 });
  let during = null;
  const f = await executorFixture(t, { policy: shadowPolicy(), status, engine: fakeEngine({ train: mode => { during = { ...status.snapshot().executor }; return fakeEngine().runTrainStage(mode); } }) });
  await f.exec.tick();
  assert.deepEqual([during.state, during.reason], ['RUNNING', 'TRAIN_MAINTENANCE']);
  assert.equal(status.snapshot().executor.state, 'IDLE');
  // the tick's status carries the mode and the newest run's summary (review of 3c-1, round 3, m1)
  const train = status.snapshot().train;
  assert.deepEqual([train.enabled, train.last.wouldDo, train.last.mode], ['shadow', 'NO_FRONT', 'shadow']);
});

test('the companion reporter puts the shadow line on the front PR only, after the executor\'s own words (review of 3c-1, round 3, m1)', async t => {
  const fsp = (await import('node:fs/promises')).default;
  const os = (await import('node:os')).default;
  const path = (await import('node:path')).default;
  const { StatusBoard, parseStatus } = await import('../src/status.mjs');
  const { LocalStore, PrStatusReporter } = await import('../src/pr-status.mjs');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'clued-train-page-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const H = '2'.repeat(40), other = '4'.repeat(40);
  const REQUIRED = ['kooyumi-work-admission', 'gitleaks', 'trivy', 'contract-placement', 'kooyumi-admission-verified', 'kooyumi-merge-slot'];
  const calls = [];
  const run = async argv => {
    calls.push(argv);
    if (argv.some(x => x.includes('/rules/branches/main'))) return { code: 0, stdout: REQUIRED.join('\n') + '\n' };
    return { code: 0, stdout: '{}' };
  };
  const board = new StatusBoard({ clock: () => NOW, pid: 1 });
  board.update({ backfill: { complete: true, published: 0, unreadable: 0 } });
  board.outcome({ pr: 910, headSha: H, outcome: 'COMPLETED' });
  board.outcome({ pr: 911, headSha: other, outcome: 'COMPLETED' });
  const facts = { contract: 'clued.independent-ci.train-facts/1', mode: 'shadow', at: new Date(NOW).toISOString(), onDuty: true, mainSha: '1'.repeat(40), rules: { strict: true, mergeOnly: true },
    front: { claimId: 'c', pr: 910, headSha: H }, wouldDo: 'FRONT_GREEN_WAIT_MERGE', wouldRevoke: [], wouldRevokeCount: 0 };
  board.update({ train: { enabled: 'shadow', last: trainSummary(facts) } });
  const status = parseStatus(Buffer.from(JSON.stringify(board.snapshot())));
  const reporter = new PrStatusReporter({ node: 'turing', repo: 'tdoljyj/cross-memory-system', ghExe: 'C:\\gh.exe', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', run, clock: () => NOW + MIN,
    store: await LocalStore.open(path.join(root, 'store.json'), () => NOW + MIN) });
  const pulls = [{ pr: 910, headSha: H, eligible: true, hint: null, behindBy: 0 }, { pr: 911, headSha: other, eligible: true, hint: null, behindBy: 0 }];
  await reporter.pass({ pulls, status });
  const description = pr => {
    const post = calls.find(argv => argv.includes('POST') && argv.some(x => x.endsWith(`/statuses/${pr === 910 ? H : other}`)));
    return post?.find(x => x.startsWith('description='))?.slice('description='.length) ?? null;
  };
  assert.match(description(910), /列车影子（只记录，不执行）：你是合并队列车头。车头六项已绿，等合并。$/);
  assert.ok(description(911) && !description(911).includes('列车影子'), 'another PR gets no line');
});

test('executor (review of 3c-1, round 2): the clean endings that are not BLOCKED stay clean; an incomplete proof HALTs', async t => {
  const proof = { windowsTreeZero: true, serviceOriginalStopped: true };
  const facts = { status: 'TRAIN_FACTS', reason: null, sideEffects: 0, mayHavePublished: false, diagnostic: null, scheduling: null, safeToRerun: false };
  const cases = [
    [{ ok: false, code: 'BROKER_REQUEST_EXPIRED', proof, brokerNoLaunch: true }, null],
    [{ ok: false, code: 'BROKER_REQUEST_REFUSED', proof, brokerNoLaunch: true }, null],
    [{ ok: false, code: 'STAGE_HELPER_PREFLIGHT_REFUSED', proof }, null],
    [{ ok: false, code: 'STAGE_CHILD_TIMEOUT', proof }, null],
    // the child wrote its facts, then ran into the cap: the bound outcome is quiet (round 2, NIT 3)
    [{ ok: false, code: 'PUBLICATION_UNCERTAIN', proof, outcome: facts }, null],
    [{ ok: false, code: 'BROKER_REQUEST_EXPIRED', proof: { windowsTreeZero: true, serviceOriginalStopped: false } }, 'TRAIN_STAGE_CLEANUP_UNCONFIRMED'],
  ];
  for (const [answer, halt] of cases) {
    const f = await executorFixture(t, { policy: shadowPolicy(), engine: fakeEngine({ train: () => answer }) });
    await f.exec.tick();
    assert.equal((await f.ledger.halted())?.value?.code ?? null, halt, `${answer.code} ${JSON.stringify(answer.proof)}`);
  }
});

test('executor (review of 3c-1, round 2): a DEFERRED schedule still runs stage 10; a halted start runs nothing', async t => {
  const f = await executorFixture(t, { policy: shadowPolicy(), companion: undefined });
  f.companion.heartbeat = async () => null; // the companion is not ready: the trigger is deferred, nothing else runs
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.reason], ['DEFERRED', 'COMPANION_NOT_READY']);
  assert.equal(trainCalls(f.engine).length, 1);
  const h = await executorFixture(t, { policy: shadowPolicy() });
  await h.ledger.halt('TEST_HALT', {});
  assert.equal((await h.exec.tick()).state, 'HALTED');
  assert.deepEqual(trainCalls(h.engine), []);
});

test('executor (review of 3c-1, round 2): an interruption found while halted is closed at once, so one re-arm is enough', async t => {
  const first = await executorFixture(t, { policy: shadowPolicy() });
  await first.receipts.append('train-run-intent', { mode: 'shadow' }); // a crash right after the intent
  await first.ledger.halt('SOMETHING_ELSE', {}); // and a HALT from elsewhere
  const second = await executorFixture(t, { policy: shadowPolicy(), root: first.root });
  assert.equal((await second.exec.tick()).state, 'HALTED');
  assert.deepEqual((await ofType(second.receipts, 'train-run')).map(b => b.failureCode), ['TRAIN_STAGE_INTERRUPTED'], 'closed although halted');
  const third = await executorFixture(t, { policy: shadowPolicy(), root: first.root });
  assert.equal(await third.exec.trainRecover(), null, 'nothing left for the next start after the re-arm');
});

test('SwapBroker poll constants (M2a): intake 100 ms, stop watch 200 ms, SCM restore pass still 500 ms, stop-retry window still 10 s', async () => {
  const fs = (await import('node:fs')).default;
  const src = fs.readFileSync(new URL('../windows/SwapBroker.cs', import.meta.url), 'utf8');
  const n = re => Number(re.exec(src)?.[1]);
  assert.equal(n(/RequestPollMs\s*=\s*(\d+)/), 100);
  assert.equal(n(/StopPollMs\s*=\s*(\d+)/), 200);
  assert.equal(n(/RestoreIntervalMs\s*=\s*(\d+)/), 500, 'RestoreStoppedHelper opens an SCM session per pass; its rate is unchanged');
  assert.equal(n(/const int StopAttempts\s*=\s*(\d+)/) * 200, 10_000, 'StopAttempts counts polls: the stop-retry window stays 10 s');
  assert.match(src, /Thread\.Sleep\(RequestPollMs\)/);
  assert.match(src, /Thread\.Sleep\(StopPollMs\)/);
  assert.doesNotMatch(src, /Thread\.Sleep\((500|1000)\)/, 'no literal 500/1000 ms poll is left');
});

test('the install authority keeps at least the helper\'s fixed margin; stage 10\'s cap is pinned in the policy and the two C# tables', async t => {
  const at = Date.parse('2026-10-20T12:00:00Z');
  const lowMargin = { ...rawPolicy().limits, stageMarginMs: 60_000 };
  const f = await executorFixture(t, { policy: shadowPolicy({}, { limits: lowMargin, validUntil: new Date(at + 300_000 + 120_000).toISOString() }) });
  await f.exec.tick();
  assert.deepEqual(trainCalls(f.engine), [], 'the helper would refuse: its margin is 180 s whatever the policy says');
  const { validatePolicy } = await import('../src/policy.mjs');
  const caps = [...rawPolicy().stageRunMilliseconds];
  caps[9] = 240_000;
  assert.throws(() => validatePolicy(rawPolicy({ stageRunMilliseconds: caps })), { code: 'POLICY_STAGE_TIMES_INVALID' });
  const fs = (await import('node:fs')).default;
  const table = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8').match(/StageMilliseconds\s*=\s*\{([0-9,\s]+)\}/)[1].split(',').map(n => Number(n.trim()));
  const broker = table('../windows/SwapBroker.cs');
  const boundary = table('../../actions-hosted-migration/independent-ci-v1/src/resident-v2/windows/FormalPublicBoundaryV2.cs');
  assert.deepEqual(broker, boundary);
  // All twelve original caps are unchanged. Stage13 is only a short protected
  // relay observation; it does not make a new scanner or Linux worker route.
  assert.deepEqual(broker.slice(0, 12), [900_000, 2_700_000, 900_000, 1_800_000, 900_000, 600_000, 900_000, 2_700_000, 900_000, 300_000, 60_000, 300_000]);
  assert.deepEqual([broker.length, broker[12]], [13, 300_000]);
  const { stageByNumber } = await import('../../actions-hosted-migration/independent-ci-v1/src/resident-v2/layout.mjs');
  const observer = stageByNumber(13);
  assert.deepEqual([observer.kind, observer.entryRole, observer.jobRoles, observer.runMilliseconds, observer.linuxWorker],
    ['relay-qualification', 'relay-qualification', ['relay-qualification-run'], 300_000, false]);
  assert.equal(stageByNumber(14), null);
});
