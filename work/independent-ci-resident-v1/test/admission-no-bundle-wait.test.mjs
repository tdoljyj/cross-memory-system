// Task f79929d9 (PLAN-native-admission-latency-20261124 §1.2, PR A): the admission does not wait for the bundle. Stage 1 never reads the
// bundle (it is the all-refs package of the Linux scans and their workspaces), yet every batch built its bundle before stage 1: 2-14
// minutes in the field, also for the batches that run no scan at all (R3 lean: every batch since 2026-11-23 17:40). The bundle is now
// built after stage 1, right before the workspaces, and only by a batch that has a local role.
// End to end on the executor's own run queue: the real ledger, receipts and queue, a fake companion and a fake engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICY_CONTRACT_V8, TRAIN_DEFAULTS } from '../src/policy.mjs';
import { batchKey } from '../src/ledger.mjs';
import { BASE, HEAD, executorFixture, fakeCompanion, fakeEngine, rawPolicy, triggerBytes, withTimeout } from './helpers.mjs';
import { NO_SWEEP, trainFacts } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-facts.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-10-20T12:00:00Z');
const ofType = async (receipts, type) => (await receipts.latest([type], 1000)).map(e => e.value.body);
// One list of what ran, in order, across both fakes: 'stage-N', 'bundle', 'rebundle', 'wsprep'.
function ordered(engine, companion) {
  const order = [];
  const runStage = engine.runStage.bind(engine);
  engine.runStage = async (batch, stage, o) => { order.push(`stage-${stage.number}`); return runStage(batch, stage, o); };
  for (const [port, name] of [['buildBundle', 'bundle'], ['rebuildBundle', 'rebundle'], ['prepareWorkspaces', 'wsprep']]) {
    const own = companion[port]?.bind(companion);
    if (own) companion[port] = async (...a) => { order.push(name); return own(...a); };
  }
  return order;
}

test('no scan is required from this App: stage 1 runs, the head is started and the batch reaches B while the bundle port never answers; no bundle is asked for', async t => {
  const engine = fakeEngine(), companion = fakeCompanion();
  let bundles = 0;
  companion.buildBundle = () => { bundles += 1; return new Promise(() => {}); }; // a bundle that never returns
  const f = await executorFixture(t, { engine, companion });
  f.exec.trainLast = Object.freeze({ appScans: [] }); // the newest stage 10 read main's rules: no scan from this App (R3 lean)
  await f.drop(triggerBytes());
  const r = await withTimeout(f.exec.tick(), 'the tick of a batch that needs no bundle', 5_000);
  assert.deepEqual(engine.calls.filter(c => c[0] === 'stage').map(c => c[1]), [1, 8], 'stage 1, then straight to stage 8');
  const [started] = await ofType(f.receipts, 'batch-started');
  assert.ok(started, '10-started was written');
  const [parked] = await ofType(f.receipts, 'batch-parked');
  assert.deepEqual(parked?.local, [], 'the batch rested at B with no local role');
  assert.equal(r.state, 'COMPLETED');
  assert.equal(bundles, 0, 'no bundle was asked for');
  assert.ok(!companion.calls.some(c => c[0] === 'wsprep'), 'no workspace either');
});

test('the rules were not read yet (the first batch after a restart): stage 1, then the bundle, the workspaces and stage 2', async t => {
  const engine = fakeEngine(), companion = fakeCompanion();
  const order = ordered(engine, companion);
  const f = await executorFixture(t, { engine, companion });
  assert.equal(f.exec.trainLast ?? null, null, 'no stage 10 summary: every scan runs');
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.deepEqual(order.slice(0, 4), ['stage-1', 'bundle', 'wsprep', 'stage-2'], order.join(' '));
  assert.equal(order.filter(x => x === 'bundle').length, 1, 'one bundle, the first generation');
});

test('the bundle after stage 1 is unavailable: the batch ends as a workspace preparation failure, no HALT, one attempt 2', async t => {
  const engine = fakeEngine(), companion = fakeCompanion({ bundle: { ok: false, code: 'BUNDLE_UNAVAILABLE' } });
  const order = ordered(engine, companion);
  const f = await executorFixture(t, { engine, companion });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', 'BUNDLE_UNAVAILABLE'], JSON.stringify(r));
  assert.deepEqual(order, ['stage-1', 'bundle'], 'stage 1 ran first; nothing after the bundle (no workspace, no Linux stage)');
  assert.equal(await f.ledger.halted(), null, 'no HALT');
  const [terminal] = await ofType(f.receipts, 'batch-terminal');
  assert.deepEqual([terminal?.outcome, terminal?.failureCode], ['FAILED_CLEAN', 'BUNDLE_UNAVAILABLE']);
  const pending = await f.ledger.pendingAttempts2();
  assert.equal(pending.length, 1, 'one attempt 2 is scheduled');
  assert.equal((await ofType(f.receipts, 'attempt2-scheduled')).length, 1);
  // attempt 2 is a batch of its own (its own key and bundle directory) and runs once it is due
  companion.buildBundle = async () => { order.push('bundle'); return { ok: true }; };
  f.advance(f.ports.policy.automaticAttempt2.delayMs + MIN);
  const r2 = await f.exec.tick();
  assert.equal(r2.state, 'COMPLETED', JSON.stringify(r2));
  assert.equal(await f.ledger.halted(), null);
  assert.deepEqual(await f.ledger.pendingAttempts2(), [], 'never an attempt 3');
});

test('a front batch (H, S) with no local role: no bundle, stage 1 and then stage 8', async t => {
  const S = '5'.repeat(40), TREE = '6'.repeat(40), CLAIM = '0a1b2c3d-0000-4000-8000-0000000000aa';
  const front = { pr: 884, headSha: HEAD, baseSha: BASE, testSha: S, testTree: TREE, claimId: CLAIM, since: new Date(T0 - MIN).toISOString(), attempt: 1 };
  const done = { sweep: { ...NO_SWEEP, kind: 'full-segment', complete: true, fullSweep: { state: 'complete', startedAt: new Date(T0).toISOString(), completedAt: new Date(T0).toISOString(), sinceOn: true, reason: null } } };
  const answer = (mode, o, sideEffects) => ({ ok: true, runId: `${'7'.repeat(16)}-${'0'.repeat(12)}`, proof: { windowsTreeZero: true, serviceOriginalStopped: true },
    outcome: { status: 'TRAIN_FACTS', reason: null, sideEffects, mayHavePublished: sideEffects > 0, diagnostic: null, scheduling: null, safeToRerun: false },
    train: trainFacts({ mode, at: new Date(T0).toISOString(), onDuty: true, holders: [], mainSha: BASE, rules: null, front: null, revoke: [], ledger: null, ...o }) });
  const engine = fakeEngine({ train: mode => answer(mode, { ...done, decision: 'OPEN_FRONT_BATCH', openFrontBatch: front }, 1) });
  const companion = fakeCompanion();
  let bundles = 0;
  companion.buildBundle = () => { bundles += 1; return new Promise(() => {}); };
  const policy = rawPolicy({ contract: POLICY_CONTRACT_V8, train: { enabled: 'on', nonFrontRuns: true, maintenanceEveryMs: 10 * MIN, maintenanceMaxPerDay: 200, ...TRAIN_DEFAULTS, sweep: 'gate' } });
  const f = await executorFixture(t, { policy, engine, companion });
  await f.exec.tick(); // the take-over run opens the front batch (H, S)
  assert.equal(f.queue.row(884)?.current?.testSha, S, 'the front batch is queued');
  f.exec.trainLast = Object.freeze({ ...f.exec.trainLast, appScans: [] }); // main's rules require no scan from this App
  f.advance(MIN);
  const r = await withTimeout(f.exec.tick(), 'the tick of a front batch that needs no bundle', 5_000);
  const reserved = (await ofType(f.receipts, 'batch-reserved')).at(-1);
  assert.equal(reserved.subject.testSha, S, 'the batch that ran is the front batch');
  assert.equal(reserved.key, batchKey(reserved.subject));
  assert.deepEqual(engine.calls.filter(c => c[0] === 'stage' && c[1] !== 10).map(c => c[1]), [1, 8], 'stage 1, then straight to stage 8');
  assert.equal(r.state, 'COMPLETED', JSON.stringify(r));
  assert.equal(bundles, 0, 'no bundle was asked for');
});
