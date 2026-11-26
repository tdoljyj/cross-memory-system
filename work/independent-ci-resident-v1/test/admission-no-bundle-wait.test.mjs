// Task f79929d9 (PLAN-native-admission-latency-20261124 §1.2 and §8, PR A): the admission does not wait for a bundle nobody reads.
// Stage 1 never reads the bundle (it is the all-refs package of the Linux scans and their workspaces), yet every batch built one before
// stage 1: 2-14 minutes in the field, also for the batches that run no scan at all (R3 lean: every batch since 2026-11-23 17:40).
// A batch that tests its own head (no S) and is born on a reading "no scan from this App" builds none; 10-started records it (lean) and
// the plan follows that record alone. Every other batch is untouched: the bundle stays before stage 1, where its refusals release the
// reservation (RESIDENT_BASE_MOVED and the restamp, TRAIN_BATCH_MEMBER_MOVED and the dropped S).
// A lean batch that rests at B while main moves ends at stage 8 as every batch resting there does (RESIDENT_BASE_MOVED, FAILED_CLEAN,
// no HALT): park.test.mjs, "main moving ends the batch at once".
// End to end on the executor's own run queue: the real ledger, receipts and queue, a fake companion and a fake engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICY_CONTRACT_V8, TRAIN_DEFAULTS } from '../src/policy.mjs';
import { batchKey } from '../src/ledger.mjs';
import { BASE, HEAD, executorFixture, fakeCompanion, fakeEngine, holdAtA, rawPolicy, triggerBytes } from './helpers.mjs';
import { until } from '../../../scripts/ci/test-clock-guard.mjs';
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
// A bundle port that never answers, and how often it was asked.
function neverBundle(companion) {
  const seen = { n: 0 };
  companion.buildBundle = () => { seen.n += 1; return new Promise(() => {}); };
  return seen;
}
// What the newest stage 10 read on the github-merge route: main's rules require no scan from this App (R3 lean). No push stamp.
const LEAN_READ = Object.freeze({ landing: { route: 'github-merge' }, appScans: [] });

test('github-merge route, no scan from this App, no S: no bundle is asked for; stage 1 runs, 10-started says lean and the batch reaches B while the bundle port never answers', async t => {
  const engine = fakeEngine(), companion = fakeCompanion();
  const bundles = neverBundle(companion);
  const f = await executorFixture(t, { engine, companion });
  f.exec.trainLast = LEAN_READ;
  assert.equal(f.exec.batchRoute(), null, 'not the push route');
  await f.drop(triggerBytes());
  const r = await until(f.exec.tick(), 'the tick of a batch that needs no bundle');
  assert.deepEqual(engine.calls.filter(c => c[0] === 'stage').map(c => c[1]), [1, 8], 'stage 1, then straight to stage 8');
  assert.equal(Object.hasOwn((await ofType(f.receipts, 'batch-reserved'))[0].subject, 'batchRoute'), false, 'no push stamp');
  assert.ok((await ofType(f.receipts, 'batch-started'))[0], 'batch-started was written');
  assert.equal((await f.ledger.state(r.key)).started?.facts?.lean, true, '10-started carries lean');
  const [parked] = await ofType(f.receipts, 'batch-parked');
  assert.deepEqual(parked?.local, [], 'the batch rested at B with no local role');
  assert.equal(r.state, 'COMPLETED', JSON.stringify(r));
  assert.equal(bundles.n, 0, 'no bundle was asked for');
  assert.ok(!companion.calls.some(c => c[0] === 'wsprep'), 'no workspace either');
  assert.deepEqual((await ofType(f.receipts, 'bundle-skipped')).map(x => [x.key, x.pr, x.headSha]), [[r.key, 884, HEAD]], 'one bundle-skipped receipt');
});

test('the lean decision is on disk: the reading is gone after 10-started (a restart) and the batch still plans no local role and enters no workspace', async t => {
  const engine = fakeEngine(), companion = fakeCompanion();
  const bundles = neverBundle(companion);
  const f = await executorFixture(t, { engine, companion });
  f.exec.trainLast = LEAN_READ;
  const atA = holdAtA(f.exec);
  await f.drop(triggerBytes());
  const first = await until(f.exec.tick(), 'the tick up to parking point A');
  assert.equal(first.state, 'WAITING', JSON.stringify(first));
  assert.equal((await f.ledger.state(first.key)).started?.facts?.lean, true);
  f.exec.trainLast = null; // a restart: the reading lives in memory only; unread means "every scan runs" for a batch born now
  atA.release();
  f.advance(MIN);
  const r = await until(f.exec.tick(), 'the tick that goes on from A');
  assert.equal(r.state, 'COMPLETED', JSON.stringify(r));
  assert.deepEqual(engine.calls.filter(c => c[0] === 'stage').map(c => c[1]), [1, 8], 'no Linux stage');
  assert.deepEqual((await f.ledger.state(r.key)).plan?.local, [], 'the plan has no local role');
  assert.equal(bundles.n, 0);
  assert.ok(!companion.calls.some(c => ['wsprep', 'rebundle'].includes(c[0])), 'no workspace, no second bundle');
  assert.equal(await f.ledger.halted(), null);
});

test('the rules were not read (a restart): the bundle still comes before stage 1; RESIDENT_BASE_MOVED releases the head, the restamp queues it again and it runs', async t => {
  const engine = fakeEngine(), companion = fakeCompanion({ bundle: { ok: false, code: 'RESIDENT_BASE_MOVED' } });
  const order = ordered(engine, companion);
  const f = await executorFixture(t, { engine, companion });
  assert.equal(f.exec.trainLast ?? null, null, 'no stage 10 summary: every scan would run');
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode, r.release], ['NOT_EXECUTED', 'RESIDENT_BASE_MOVED', 'SUPERSEDED'], JSON.stringify(r));
  assert.deepEqual(order, ['bundle'], 'the bundle first; stage 1 never ran');
  assert.deepEqual(await ofType(f.receipts, 'bundle-skipped'), []);
  const row = () => f.queue.row(884);
  assert.deepEqual([row().state, row().reason, row().stopKind, row().stopClass], ['STOPPED', 'RESIDENT_BASE_MOVED', 'burned', 'superseded']);
  assert.equal(Object.hasOwn(row().current, 'batchRoute'), false);
  // the route is read as push: the stopped head gets the stamp and is queued again, by the system alone
  const installed = f.exec.policy;
  f.exec.policy = { ...installed, train: { ...installed.train, enabled: 'on', landing: 'push' } };
  f.exec.trainLast = Object.freeze({ landing: { route: 'push' }, appScans: [] });
  const back = await f.exec.restampStopped();
  f.exec.policy = installed; // the run itself: the train's maintenance is not this test's
  assert.deepEqual(back.map(x => x.headSha), [HEAD]);
  assert.deepEqual([row().state, row().current.batchRoute], ['QUEUED', 'push']);
  const bundles = neverBundle(companion);
  order.length = 0;
  f.advance(MIN);
  const r2 = await until(f.exec.tick(), 'the tick of the restamped head');
  assert.equal(r2.state, 'COMPLETED', JSON.stringify(r2));
  assert.deepEqual(order.filter(x => x.startsWith('stage-')), ['stage-1', 'stage-8'], order.join(' '));
  assert.equal(bundles.n, 0, 'the restamped batch (stamped push) builds no bundle');
  assert.equal(await f.ledger.halted(), null);
});

test('a front batch (H, S) still builds its bundle before stage 1, whatever the reading; a member that moved on is released and its S dropped', async t => {
  const S = '5'.repeat(40), TREE = '6'.repeat(40), CLAIM = '0a1b2c3d-0000-4000-8000-0000000000aa';
  const front = { pr: 884, headSha: HEAD, baseSha: BASE, testSha: S, testTree: TREE, claimId: CLAIM, since: new Date(T0 - MIN).toISOString(), attempt: 1,
    members: [{ pr: 884, headSha: HEAD }, { pr: 885, headSha: '3'.repeat(40) }] };
  const done = { sweep: { ...NO_SWEEP, kind: 'full-segment', complete: true, fullSweep: { state: 'complete', startedAt: new Date(T0).toISOString(), completedAt: new Date(T0).toISOString(), sinceOn: true, reason: null } } };
  const answer = (mode, o, sideEffects) => ({ ok: true, runId: `${'7'.repeat(16)}-${'0'.repeat(12)}`, proof: { windowsTreeZero: true, serviceOriginalStopped: true },
    outcome: { status: 'TRAIN_FACTS', reason: null, sideEffects, mayHavePublished: sideEffects > 0, diagnostic: null, scheduling: null, safeToRerun: false },
    train: trainFacts({ mode, at: new Date(T0).toISOString(), onDuty: true, holders: [], mainSha: BASE, rules: null, front: null, revoke: [], ledger: null, ...o }) });
  let i = 0;
  const list = [m => answer(m, { ...done, decision: 'OPEN_FRONT_BATCH', openFrontBatch: front }, 1), m => answer(m, done, 0)];
  const engine = fakeEngine({ train: m => list[Math.min(i++, list.length - 1)](m) });
  const companion = fakeCompanion({ bundle: { ok: false, code: 'TRAIN_BATCH_MEMBER_MOVED' } });
  const order = ordered(engine, companion);
  const policy = rawPolicy({ contract: POLICY_CONTRACT_V8, train: { enabled: 'on', nonFrontRuns: true, maintenanceEveryMs: 10 * MIN, maintenanceMaxPerDay: 200, ...TRAIN_DEFAULTS, sweep: 'gate' } });
  const f = await executorFixture(t, { policy, engine, companion });
  await f.exec.tick(); // the take-over run opens the front batch (H, S)
  const row = f.queue.row(884);
  assert.equal(row?.current?.testSha, S, 'the front batch is queued');
  row.current = { ...row.current, batchRoute: 'push' }; // also with the push stamp
  f.exec.trainLast = Object.freeze({ ...f.exec.trainLast, appScans: [] }); // and with a reading "no scan from this App"
  order.length = 0;
  f.advance(MIN);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode, r.release], ['NOT_EXECUTED', 'TRAIN_BATCH_MEMBER_MOVED', 'SUPERSEDED'], JSON.stringify(r));
  assert.deepEqual(order.filter(x => x !== 'stage-10'), ['bundle'], 'the bundle first; stage 1 never ran');
  assert.deepEqual(await ofType(f.receipts, 'bundle-skipped'), []);
  const after = f.queue.row(884);
  assert.deepEqual([after.state, after.reason, after.current], ['DONE', 'TRAIN_BATCH_MEMBER_MOVED', null], 'the S is dropped: it can never pass again');
  assert.equal(batchKey((await ofType(f.receipts, 'batch-reserved')).at(-1).subject), r.key);
});
