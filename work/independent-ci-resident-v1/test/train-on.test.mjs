// The merge train on, the resident side (step 3c-2b, DESIGN §41.3-41.8; INTERFACES §2, §3): policy /8, the train-run job /2,
// facts /2 with side effects, revoke-only under PAUSE, the take-over gate, the front batch with S, the two request files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { POLICY_CONTRACT_V8, TRAIN_DEFAULTS, trainSettings, validatePolicy } from '../src/policy.mjs';
import { DECISIONS, TRAIN_RUN_INPUT_FIELDS, openFrontBatchOf, trainRunInput, trainRunMode, trainSummary, trainSweepView, parseTrainSweep, validateTrainRunInput } from '../src/train.mjs';
import { RELAY_TRAIN_FRONT_LOCAL, TRAIN_CLEAN_CODES, failureRow } from '../src/classify.mjs';
import { PROBE_REQUEST_CONTRACT, REVOKE_HEAD_REQUEST_CONTRACT, probeRequest, revokeHeadRequest, validateResidentRequest } from '../src/resident-requests.mjs';
import { installedTrainMode } from '../src/engine-windows.mjs';
import { StatusBoard, parseStatus } from '../src/status.mjs';
import { executorFixture, fakeEngine, rawPolicy, triggerBytes, HEAD, BASE } from './helpers.mjs';
import { makeTrainRun, TRAIN_RUN_PARAMS } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/train-run.mjs';
import { DECISIONS as SOURCE_DECISIONS, NO_ACTIONS, NO_SWEEP, trainFacts } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-facts.mjs';
import { TRAIN_CODES as SOURCE_TRAIN_CODES } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-10-20T12:00:00Z');
const S = '5'.repeat(40), TREE = '6'.repeat(40), CLAIM = '0a1b2c3d-0000-4000-8000-0000000000aa';
const onTrain = (o = {}) => ({ enabled: 'on', nonFrontRuns: true, maintenanceEveryMs: 10 * MIN, maintenanceMaxPerDay: 200, ...TRAIN_DEFAULTS, ...o });
const policyV8 = (train = {}, top = {}) => rawPolicy({ contract: POLICY_CONTRACT_V8, train: onTrain(train), ...top });
const ofType = async (receipts, type) => (await receipts.latest([type], 1000)).map(e => e.value.body);
const trainCalls = engine => engine.calls.filter(c => c[0] === 'stage' && c[1] === 10);
const proof = { windowsTreeZero: true, serviceOriginalStopped: true };
// Facts /2 as Source v2 writes them (train-facts.mjs#trainFacts), wrapped as the engine's stage-10 answer with side effects.
const answer = (mode, o = {}, sideEffects = 0) => ({ ok: true, runId: `${'7'.repeat(16)}-${'0'.repeat(12)}`, proof,
  outcome: { status: 'TRAIN_FACTS', reason: null, sideEffects, mayHavePublished: sideEffects > 0, diagnostic: null, scheduling: null, safeToRerun: false },
  train: trainFacts({ mode, at: new Date(T0).toISOString(), onDuty: true, holders: [], mainSha: BASE, rules: null, front: null, revoke: [], ledger: null, ...o }) });
// The take-over is done only on this positive signal (review R3 M3): this node's full sweep in on mode is complete since onSince.
const DONE = { sweep: { ...NO_SWEEP, kind: 'full-segment', complete: true, fullSweep: { state: 'complete', startedAt: new Date(T0).toISOString(), completedAt: new Date(T0).toISOString(), sinceOn: true, reason: null } } };
const scripted = list => { let i = 0; return { inputs: [], engine: fakeEngine({ train: mode => list[Math.min(i++, list.length - 1)](mode) }) }; };
// fakeEngine's runTrainStage passes only the mode on: wrap it to keep each run's input.
const withInput = e => { const run = e.engine.runTrainStage.bind(e.engine); e.engine.runTrainStage = async (mode, input) => { e.inputs.push({ mode, input }); return run(mode); }; return e; };

test('policy /8: on, the four train settings and their bounds; /7 refuses on exactly as before', () => {
  const p = validatePolicy(policyV8());
  assert.deepEqual([p.contract, p.train.enabled], [POLICY_CONTRACT_V8, 'on']);
  assert.equal(validatePolicy(policyV8({ nonFrontRuns: false })).train.nonFrontRuns, false, '/8 accepts nonFrontRuns false');
  for (const [k, v] of [['slotHardCapMinutes', 59], ['slotHardCapMinutes', 181], ['frontBatchBudgetMs', 59_999], ['sweepFreshMs', 3_600_001], ['fullSweepMaxMs', 599_999],
    ['frontBatchBudgetMs', 120 * MIN]]) assert.throws(() => validatePolicy(policyV8({ [k]: v })), { code: 'POLICY_TRAIN_INVALID' }, `${k}=${v}`);
  const { sweepFreshMs, ...missing } = onTrain(); void sweepFreshMs;
  assert.throws(() => validatePolicy(rawPolicy({ contract: POLICY_CONTRACT_V8, train: missing })), { code: 'POLICY_TRAIN_KEYS_INVALID' });
  assert.throws(() => validatePolicy(rawPolicy({ train: { ...rawPolicy().train, enabled: 'on' } })), { code: 'POLICY_TRAIN_ON_NOT_SUPPORTED' });
  assert.throws(() => validatePolicy(rawPolicy({ train: onTrain({ enabled: 'shadow' }) })), { code: 'POLICY_TRAIN_KEYS_INVALID' }, '/7 never takes the /8 keys');
  assert.deepEqual({ ...trainSettings(rawPolicy().train) }, { ...TRAIN_DEFAULTS });
  assert.equal(trainSettings(onTrain({ sweepFreshMs: 600_000 })).sweepFreshMs, 600_000);
  for (const [train, mode] of [[rawPolicy().train, 'off'], [onTrain({ enabled: 'shadow' }), 'shadow'], [onTrain(), 'on']]) assert.equal(installedTrainMode({ train }), mode);
  assert.equal(installedTrainMode(null), 'off');
});

test('config: the /8 shadow example is the /7 example with the /8 contract and train settings; the installed /7 example is unchanged', async () => {
  const read = async n => JSON.parse(await fs.readFile(new URL(`../config/${n}`, import.meta.url), 'utf8'));
  const v7 = await read('policy.example.json'), v8 = await read('policy.v8-shadow.example.json');
  assert.equal(v7.contract, 'clued.independent-ci.resident-policy/7', 'what the current install uses stays /7');
  const p = validatePolicy(v8);
  assert.deepEqual([p.contract, p.train.enabled, p.train.nonFrontRuns], [POLICY_CONTRACT_V8, 'shadow', true]);
  assert.deepEqual({ ...trainSettings(p.train) }, { ...TRAIN_DEFAULTS });
  const { contract: c7, train: t7, ...rest7 } = v7, { contract: c8, train: t8, ...rest8 } = v8;
  assert.deepEqual(rest8, rest7);
  assert.deepEqual(t8, { ...t7, ...TRAIN_DEFAULTS });
  assert.equal(installedTrainMode(p), 'shadow');
  void c7; void c8;
});

test('train-run /2: the resident part is exactly the job\'s params plus the mode, and Source v2 builds a valid job from it', () => {
  assert.deepEqual(TRAIN_RUN_INPUT_FIELDS.filter(k => k !== 'mode'), [...TRAIN_RUN_PARAMS]);
  const settings = trainSettings(onTrain());
  const runId = `${'1'.repeat(16)}-${'2'.repeat(12)}`;
  const job = input => { const { mode, ...params } = input; return makeTrainRun({ repo: 'tdoljyj/cross-memory-system', runId, mode, sourceManifestSha256: 'e'.repeat(64), createdAt: new Date(T0).toISOString(), ...params }); };
  const shadow = trainRunInput({ mode: 'shadow', settings, onSince: T0 });
  assert.equal(shadow.onSince, null, 'never an onSince in shadow');
  assert.equal(job(shadow).mode, 'shadow');
  const front = { pr: 910, headSha: HEAD, testSha: S, attempt: 1, code: 'STAGE_CHILD_REFUSED' };
  const on = trainRunInput({ mode: 'on', settings, onSince: T0, frontOutcome: front, revokeHeadRequestId: CLAIM });
  assert.deepEqual([on.onSince, on.frontPr, on.frontAttempt, on.revokeHeadRequestId], [new Date(T0).toISOString(), 910, 1, CLAIM]);
  assert.equal(job(on).frontCode, 'STAGE_CHILD_REFUSED');
  const revokeOnly = trainRunInput({ mode: 'revoke-only', settings, onSince: T0, frontOutcome: front, revokeHeadRequestId: CLAIM });
  assert.deepEqual([revokeOnly.frontPr, revokeOnly.revokeHeadRequestId], [null, CLAIM], 'no failed report under PAUSE');
  assert.equal(job(revokeOnly).mode, 'revoke-only');
  for (const bad of [{ ...on, onSince: null }, { ...shadow, revokeHeadRequestId: CLAIM }, { ...on, frontTestSha: HEAD }, { ...on, frontCode: null }, { ...on, extra: 1 }])
    assert.throws(() => validateTrainRunInput(bad), { code: 'TRAIN_RUN_INPUT_INVALID' });
});

test('the code tables: the train codes as Source v2 lists them; the decisions as train facts /2 name them', () => {
  assert.deepEqual([...TRAIN_CLEAN_CODES], [...SOURCE_TRAIN_CODES]);
  assert.deepEqual([...DECISIONS].sort(), [...SOURCE_DECISIONS].sort());
  for (const code of TRAIN_CLEAN_CODES) assert.ok(failureRow({ code, stage: 8 }) && failureRow({ code, stage: 1 }), code);
  assert.equal(failureRow({ code: 'TRAIN_SINGLE_GREEN_NOT_PROVEN', stage: 8 }).class, 'queue', 'parked at B until the next stage 10');
  assert.ok(TRAIN_CLEAN_CODES.includes(RELAY_TRAIN_FRONT_LOCAL));
});

test('the run mode: shadow on every node (held by PAUSE and an intake pause), on only ACTIVE, revoke-only under PAUSE', () => {
  assert.deepEqual(trainRunMode({ enabled: 'shadow', active: false }), { mode: 'shadow', notOnDuty: false });
  assert.deepEqual(trainRunMode({ enabled: 'shadow', active: true, paused: true }).mode, null);
  assert.deepEqual(trainRunMode({ enabled: 'on', active: false }), { mode: null, notOnDuty: true });
  assert.deepEqual(trainRunMode({ enabled: 'on', active: true }).mode, 'on');
  assert.deepEqual(trainRunMode({ enabled: 'on', active: true, paused: true }).mode, 'revoke-only');
  assert.deepEqual(trainRunMode({ enabled: 'on', active: true, intakeHeld: true }).mode, 'revoke-only');
  assert.deepEqual(trainRunMode({ enabled: 'off', active: true }).mode, null);
});

test('facts /2: a summary only with a decision in on; OPEN_FRONT_BATCH only with a front that fits; an unknown PAUSE request is no summary', () => {
  const front = { pr: 910, headSha: HEAD, baseSha: BASE, testSha: S, testTree: TREE, claimId: CLAIM, since: new Date(T0 - MIN).toISOString(), attempt: 1 };
  const open = answer('on', { decision: 'OPEN_FRONT_BATCH', openFrontBatch: front }).train;
  assert.deepEqual({ ...trainSummary(open).openFrontBatch }, front);
  assert.equal(trainSummary({ ...open, openFrontBatch: { ...front, testSha: HEAD } }), null, 'S = H is no front batch');
  assert.equal(trainSummary({ ...open, decision: undefined }), null);
  assert.equal(trainSummary({ ...open, requestPause: 'SOMETHING' }), null);
  assert.equal(openFrontBatchOf({ ...front, attempt: 3 }), null);
  const shadow = trainSummary(answer('shadow').train);
  assert.deepEqual([shadow.mode, shadow.decision, shadow.openFrontBatch, shadow.requestPause], ['shadow', 'NO_FRONT', null, null]);
  // the status copy of the sweep (DESIGN §41.7): the newest full sweep since this node became eligible
  const done = trainSummary(answer('on', { sweep: { ...NO_SWEEP, kind: 'full-segment', complete: true, fullSweep: { state: 'complete', startedAt: new Date(T0 - 60 * MIN).toISOString(),
    completedAt: new Date(T0).toISOString(), sinceOn: true, reason: null } } }).train);
  const view = trainSweepView({ summary: done, onSince: new Date(T0 - 2 * 60 * MIN).toISOString() });
  assert.deepEqual([view.fullState, view.fullSinceOn, view.fullCompletedAt], ['complete', true, new Date(T0).toISOString()]);
  const later = trainSweepView({ summary: trainSummary(answer('on').train), previous: view, onSince: view.onSince });
  assert.deepEqual([later.fullSinceOn, later.fullCompletedAt], [true, view.fullCompletedAt], 'kept until the next eligibility');
  assert.equal(trainSweepView({ summary: trainSummary(answer('on').train), previous: view, onSince: new Date(T0).toISOString() }).fullSinceOn, false, 'a new take-over starts over');
  const read = parseTrainSweep(JSON.parse(JSON.stringify(view)));
  assert.deepEqual([read.fullSinceOn, read.fullCompletedAt], [true, T0]);
  // generation 15 (DESIGN 60): what the round enumerates and why, and a rewrite of main still pending, reach the status
  assert.deepEqual([view.fullScope, view.fullScopeReason, view.fullAllPending, read.fullScope, read.fullAllPending], [null, null, null, null, null], 'a Source before generation 15');
  const all = trainSummary(answer('on', { sweep: { ...NO_SWEEP, kind: 'full-segment', complete: true, fullSweep: { state: 'running', startedAt: new Date(T0 - MIN).toISOString(),
    completedAt: null, sinceOn: false, reason: null, scope: 'all', scopeReason: 'TRAIN_MAIN_REWRITTEN', allPending: 'TRAIN_MAIN_REWRITTEN' } } }).train);
  const v15 = parseTrainSweep(JSON.parse(JSON.stringify(trainSweepView({ summary: all, onSince: view.onSince }))));
  assert.deepEqual([v15.fullState, v15.fullScope, v15.fullScopeReason, v15.fullAllPending], ['running', 'all', 'TRAIN_MAIN_REWRITTEN', 'TRAIN_MAIN_REWRITTEN']);
  // main rewritten voids the full sweep since on that the view kept (the companion's backstop and the duty read fullSinceOn)
  assert.equal(trainSweepView({ summary: all, previous: view, onSince: view.onSince }).fullSinceOn, false);
  assert.equal(trainSweepView({ summary: trainSummary(answer('on').train), previous: view, onSince: view.onSince }).fullSinceOn, true, 'without a rewrite it is kept, as before');
  // the Source refuses facts with other values; a summary built past it still shows none of them
  const base = answer('on').train;
  const odd = trainSummary({ ...base, sweep: { ...base.sweep, fullSweep: { ...base.sweep.fullSweep, scope: 'some', scopeReason: 'lower case', allPending: 'yes' } } });
  assert.deepEqual([odd.sweep.fullSweep.scope, odd.sweep.fullSweep.scopeReason, odd.sweep.fullSweep.allPending], [null, null, null], 'anything else is not shown');
  assert.throws(() => answer('on', { sweep: { ...NO_SWEEP, fullSweep: { ...NO_SWEEP.fullSweep, scope: 'some' } } }), /invalid_train_facts/);
});

test('executor, on: the take-over sweep holds new batches; an on-mode run with side effects is a normal ending and lets them go', async t => {
  const e = scripted([mode => answer(mode, { decision: 'TRAIN_TAKEOVER_SWEEP_PENDING' }, 3), mode => answer(mode, DONE, 2)]);
  const f = await executorFixture(t, { policy: policyV8(), engine: e.engine });
  withInput(e);
  await f.drop(triggerBytes());
  const first = await f.exec.tick();
  assert.deepEqual([first.state, first.reason], ['DEFERRED', 'TRAIN_TAKEOVER_SWEEP_PENDING']);
  assert.deepEqual(trainCalls(f.engine).map(c => c[2]), ['on'], 'due at once: the node became eligible at its start');
  assert.equal(e.inputs[0].input.onSince, new Date(T0).toISOString());
  assert.equal(await f.ledger.halted(), null, 'side effects in on: no HALT');
  assert.deepEqual(f.engine.calls.filter(c => c[0] === 'derive'), [], 'no batch before the take-over sweep');
  const [intent] = await ofType(f.receipts, 'train-run-intent');
  assert.deepEqual([intent.mode, intent.runMode, intent.input.mode], ['on', 'on', 'on']);
  const [run] = await ofType(f.receipts, 'train-run');
  assert.deepEqual([run.ok, run.runMode, run.decision, run.sideEffects], [true, 'on', 'TRAIN_TAKEOVER_SWEEP_PENDING', 3]);
  // the next run (its own cadence) ends the take-over: the trigger runs
  f.advance(10 * MIN);
  await f.exec.tick();
  assert.equal(trainCalls(f.engine).length, 2);
  f.advance(MIN);
  await f.exec.tick();
  assert.ok(f.engine.calls.some(c => c[0] === 'derive'), 'the batch starts after the take-over');
});

test('executor, on: facts with side effects that do not validate HALT; a failure with a side effect HALTs as before', async t => {
  const odd = await executorFixture(t, { policy: policyV8(), engine: fakeEngine({ train: () => ({ ...answer('on', {}, 2), train: { contract: 'clued.independent-ci.train-facts/2', mode: 'on' } }) }) });
  assert.deepEqual(await odd.exec.tick(), { state: 'HALTED', failureCode: 'TRAIN_STAGE_OUTCOME_UNCONFIRMED' });
  const shadowFacts = await executorFixture(t, { policy: policyV8(), engine: fakeEngine({ train: () => answer('shadow', {}, 0) }) });
  await shadowFacts.exec.tick();
  assert.deepEqual((await ofType(shadowFacts.receipts, 'train-run')).map(b => [b.ok, b.failureCode]), [[false, 'TRAIN_FACTS_UNCONFIRMED']], 'facts of another mode are no facts');
  const failed = await executorFixture(t, { policy: policyV8(), engine: fakeEngine({ train: () => ({ ok: false, code: 'PUBLICATION_UNCERTAIN', proof,
    outcome: { status: 'UNCERTAIN', reason: null, sideEffects: 1, mayHavePublished: true } }) }) });
  assert.deepEqual(await failed.exec.tick(), { state: 'HALTED', failureCode: 'TRAIN_STAGE_OUTCOME_UNCONFIRMED' });
});

test('executor, shadow under /8 and /7: the run carries the /2 settings, never onSince, and its receipts are what they were', async t => {
  for (const policy of [rawPolicy({ train: { ...rawPolicy().train, enabled: 'shadow' } }), policyV8({ enabled: 'shadow' })]) {
    const e = withInput({ inputs: [], engine: fakeEngine() });
    const f = await executorFixture(t, { policy, engine: e.engine });
    await f.exec.tick();
    assert.deepEqual(e.inputs.map(x => [x.mode, x.input.onSince, x.input.slotHardCapMinutes]), [['shadow', null, 120]]);
    assert.deepEqual(await ofType(f.receipts, 'train-run-intent'), [{ mode: 'shadow' }]);
    assert.equal(f.exec.trainGate(), null, 'shadow never holds a batch');
  }
});

test('executor, on: PAUSE runs revoke-only before PAUSED (shadow does not); HALT runs nothing', async t => {
  const e = withInput({ inputs: [], engine: fakeEngine({ train: mode => answer(mode, { decision: 'REVOKE_ONLY_DONE' }, 1) }) });
  const f = await executorFixture(t, { policy: policyV8(), engine: e.engine });
  await f.ledger.pause({ reason: 'owner', requestSha256: 'a'.repeat(64) });
  assert.equal((await f.exec.tick()).state, 'PAUSED');
  assert.deepEqual(e.inputs.map(x => x.mode), ['revoke-only']);
  assert.equal(await f.ledger.halted(), null);
  const h = await executorFixture(t, { policy: policyV8() });
  await h.ledger.halt('TEST_HALT', {});
  assert.equal((await h.exec.tick()).state, 'HALTED');
  assert.deepEqual(trainCalls(h.engine), []);
});

test('executor, on: a requestPause latches PAUSE (in the status at once) and tells the Owner', async t => {
  const status = new StatusBoard({ clock: () => T0, pid: 1 });
  const f = await executorFixture(t, { policy: policyV8(), status, engine: fakeEngine({ train: mode => answer(mode, { decision: 'TRAIN_LANDED_TREE_MISMATCH', requestPause: 'TRAIN_LANDED_TREE_MISMATCH' }, 0) }) });
  await f.exec.tick();
  assert.match((await f.ledger.paused()).value.source.reason, /TRAIN_LANDED_TREE_MISMATCH/);
  assert.equal(status.snapshot().paused, true);
  assert.ok(f.queue.notices.some(n => n.kind === 'train-owner' && n.code === 'TRAIN_LANDED_TREE_MISMATCH'));
  assert.ok((await ofType(f.receipts, 'paused')).length === 1);
});

test('executor, on: OPEN_FRONT_BATCH queues the front with S first; the batch keeps every role local before 20-plan-intent; at most two per head', async t => {
  const front = attempt => ({ pr: 884, headSha: HEAD, baseSha: BASE, testSha: attempt === 1 ? S : '8'.repeat(40), testTree: TREE, claimId: CLAIM, since: new Date(T0 - MIN).toISOString(), attempt });
  let next = 1;
  const f = await executorFixture(t, { policy: policyV8(), engine: fakeEngine({ train: mode => answer(mode, { ...DONE, decision: 'OPEN_FRONT_BATCH', openFrontBatch: front(Math.min(next++, 2)) }, 1) }) });
  await f.exec.tick(); // take-over sweep run: it opens the front batch
  const row = f.queue.row(884);
  assert.deepEqual([row.state, row.current.testSha, row.current.frontAttempt], ['QUEUED', S, 1]);
  assert.equal(f.queue.candidates(f.clock())[0].testSha, S);
  const [enq] = await ofType(f.receipts, 'train-front-enqueued');
  assert.deepEqual([enq.pr, enq.testSha, enq.attempt], [884, S, 1]);
  f.advance(MIN);
  await f.exec.tick();
  const reserved = (await ofType(f.receipts, 'batch-reserved')).at(-1);
  assert.equal(reserved.subject.testSha, S, 'the subject names S');
  const intent = JSON.parse(await fs.readFile(path.join(f.root, 'state', 'ledger', reserved.key, '20-plan-intent.json'), 'utf8'));
  assert.deepEqual([intent.candidates, intent.reason, intent.reasons.gitleaks, intent.reasons.trivy], [[], RELAY_TRAIN_FRONT_LOCAL, RELAY_TRAIN_FRONT_LOCAL, RELAY_TRAIN_FRONT_LOCAL]);
  // a third front batch of the same head is refused by the executor itself
  f.exec.frontBatches.set(`884:${HEAD}`, [{ testSha: S, attempt: 1 }, { testSha: '8'.repeat(40), attempt: 2 }]);
  assert.equal(await f.exec.enqueueFront({ ...front(2), testSha: '9'.repeat(40) }), null);
  assert.equal((await ofType(f.receipts, 'train-front-refused')).at(-1).failureCode, 'TRAIN_FRONT_ATTEMPTS_USED');
});

test('executor, on: the front batch (H, S) runs after the non-front run of H published; the head stays burned for every other run', async t => {
  const f = await executorFixture(t);
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED', 'the non-front run of H (nonFrontRuns) published its checks');
  const front = { pr: 884, headSha: HEAD, baseSha: BASE, testSha: S, testTree: TREE, claimId: CLAIM, since: new Date(T0 - MIN).toISOString(), attempt: 1 };
  const g = await executorFixture(t, { root: f.root, policy: policyV8(), engine: fakeEngine({ train: mode => answer(mode, { ...DONE, decision: 'OPEN_FRONT_BATCH', openFrontBatch: front }, 1) }) });
  await g.exec.tick(); // the take-over run opens the front batch
  g.advance(MIN);
  const r = await g.exec.tick();
  const reserved = (await ofType(g.receipts, 'batch-reserved')).at(-1);
  assert.equal(reserved.subject.testSha, S);
  assert.deepEqual([r.state, r.reason ?? null], ['COMPLETED', null], 'neither HEAD_ALREADY_EXECUTED_NO_RETRY nor HEAD_ALREADY_PUBLISHED_NO_RETRY');
  assert.equal((await ofType(g.receipts, 'trigger-ignored')).length, 0);
  // H itself (S = H) is still burned and published: a new trigger of it is ignored, as before
  g.advance(MIN);
  await g.drop(triggerBytes({ pr: 990 }));
  await g.exec.tick();
  assert.ok(['HEAD_ALREADY_EXECUTED_NO_RETRY', 'HEAD_ALREADY_PUBLISHED_NO_RETRY'].includes((await ofType(g.receipts, 'trigger-ignored')).at(-1)?.failureCode));
});

test('executor, on: a front batch that finally failed for the PR itself is the next on-mode run\'s frontOutcome, once', async t => {
  const e = withInput({ inputs: [], engine: fakeEngine({ train: mode => answer(mode, {}, 0) }) });
  const f = await executorFixture(t, { policy: policyV8(), engine: e.engine });
  await f.exec.tick();
  const subject = { repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: f.ports.policy.sourceManifestSha256, attempt: 1, testSha: S };
  f.exec.frontKeys.set('k'.repeat(64), 2);
  await f.exec.noteFrontOutcome(subject, 'k'.repeat(64), 'STAGE_CHILD_REFUSED');
  await f.exec.noteFrontOutcome({ ...subject, testSha: undefined }, 'x'.repeat(64), 'STAGE_CHILD_REFUSED'); // not a front batch: nothing
  f.advance(MIN);
  await f.exec.tick();
  const carried = e.inputs.at(-1).input;
  assert.deepEqual([carried.frontPr, carried.frontHeadSha, carried.frontTestSha, carried.frontAttempt, carried.frontCode], [884, HEAD, S, 2, 'STAGE_CHILD_REFUSED']);
  assert.equal((await ofType(f.receipts, 'train-run')).at(-1).frontOutcomeSeq, (await f.receipts.latest(['train-front-outcome'], 1))[0].seq);
  f.advance(10 * MIN);
  await f.exec.tick();
  assert.equal(e.inputs.at(-1).input.frontPr, null, 'reported once');
  // a restart before it was carried finds it again
  const g = await executorFixture(t, { policy: policyV8(), root: f.root, engine: fakeEngine({ train: mode => answer(mode, {}, 0) }) });
  await g.receipts.append('train-front-outcome', { key: 'k'.repeat(64), frontOutcome: { pr: 884, headSha: HEAD, testSha: S, attempt: 1, code: 'STAGE_CHILD_REFUSED' } });
  assert.equal(await g.exec.trainRecover(), null);
  assert.equal(g.exec.trainFrontOutcome.pr, 884);
});

test('requests\\: the probe request only marks the probe urgent; the revoke-head request goes to stage 10 and its result to the status', async t => {
  assert.throws(() => validateResidentRequest({ ...probeRequest({ reason: 'x' }, () => T0) }, T0 + 61 * MIN), { code: 'RESIDENT_REQUEST_EXPIRED' });
  assert.throws(() => validateResidentRequest({ ...probeRequest({ reason: 'x' }, () => T0), extra: 1 }, T0), { code: 'RESIDENT_REQUEST_REFUSED' });
  assert.equal(validateResidentRequest(revokeHeadRequest({ reason: 'x' }, () => T0), T0 + 59 * MIN).contract, REVOKE_HEAD_REQUEST_CONTRACT);
  const status = new StatusBoard({ clock: () => T0, pid: 1 });
  const e = withInput({ inputs: [], engine: fakeEngine({ train: mode => answer(mode, { actions: { ...NO_ACTIONS, revokeHead: { requestId: CLAIM, done: true } } }, 1) }) });
  const f = await executorFixture(t, { policy: policyV8(), status, engine: e.engine });
  f.exec.roleProbe.urgent = false;
  await f.drop(JSON.stringify(probeRequest({ reason: 'now please' }, f.clock)), 'requests');
  await f.drop(JSON.stringify({ ...revokeHeadRequest({ reason: 'revoke the front' }, f.clock), requestId: CLAIM }), 'requests');
  await f.drop(JSON.stringify({ ...probeRequest({ reason: 'old' }, () => T0 - 2 * 60 * MIN) }), 'requests');
  await f.exec.tick();
  assert.equal(f.exec.roleProbe.urgent, true, 'only marked urgent');
  assert.equal(f.exec.nodeMode(), 'UNCERTAIN', 'never a mode change');
  assert.equal(e.inputs[0].input.revokeHeadRequestId, CLAIM);
  assert.deepEqual([status.snapshot().train.revokeHead.state, status.snapshot().train.revokeHead.requestId], ['done', CLAIM]);
  assert.deepEqual(parseStatus(Buffer.from(JSON.stringify(status.snapshot()))).train.revokeHead.state, 'done');
  assert.equal((await ofType(f.receipts, 'resident-request-refused')).at(-1).failureCode, 'RESIDENT_REQUEST_EXPIRED');
  const archived = await fs.readdir(path.join(f.root, 'state', 'requests-archive'), { recursive: true });
  assert.ok(archived.filter(n => n.endsWith('.json')).length >= 3, 'every request is archived by rename');
  assert.deepEqual(await fs.readdir(path.join(f.root, 'requests')), []);
  // with the train not on a revoke-head request is refused
  const s = await executorFixture(t, { policy: rawPolicy({ train: { ...rawPolicy().train, enabled: 'shadow' } }) });
  await s.drop(JSON.stringify(revokeHeadRequest({ reason: 'x' }, s.clock)), 'requests');
  await s.exec.tick();
  assert.equal((await ofType(s.receipts, 'resident-request-refused')).at(-1).failureCode, 'REVOKE_HEAD_TRAIN_NOT_ON');
  assert.equal(PROBE_REQUEST_CONTRACT, 'clued.independent-ci.resident-probe-request/1');
});

test('requests\\: an accepted revoke-head request is durable until stage 10 reports it done (a restart picks it up) or it is an hour old', async t => {
  const rh = done => ({ actions: { ...NO_ACTIONS, revokeHead: { requestId: CLAIM, done } } });
  const pending = async f => (await fs.readdir(path.join(f.root, 'requests'))).length;
  // the first run could not do it: the request stays in requests\, in force
  const e = withInput({ inputs: [], engine: fakeEngine({ train: mode => answer(mode, rh(false), 0) }) });
  const status = new StatusBoard({ clock: () => T0, pid: 1 });
  const f = await executorFixture(t, { policy: policyV8(), status, engine: e.engine });
  await f.drop(JSON.stringify({ ...revokeHeadRequest({ reason: 'revoke the front' }, f.clock), requestId: CLAIM }), 'requests');
  await f.exec.tick();
  assert.deepEqual([e.inputs[0].input.revokeHeadRequestId, status.snapshot().train.revokeHead.state, await pending(f)], [CLAIM, 'not-done', 1]);
  f.advance(MIN);
  await f.exec.tick();
  assert.equal((await ofType(f.receipts, 'revoke-head-requested')).length, 1, 'read again every tick, accepted once');
  // the service restarts: the file is read again, the request is in force again, and the next run does it
  const g2 = withInput({ inputs: [], engine: fakeEngine({ train: mode => answer(mode, rh(true), 1) }) });
  const g = await executorFixture(t, { policy: policyV8(), root: f.root, engine: g2.engine });
  g.advance(2 * MIN);
  await g.exec.tick();
  assert.equal(g2.inputs[0].input.revokeHeadRequestId, CLAIM, 'picked up after the restart');
  assert.deepEqual((await ofType(g.receipts, 'revoke-head-done')).map(b => b.requestId), [CLAIM]);
  assert.equal(await pending(g), 0, 'archived once done');
  g.advance(11 * MIN);
  await g.exec.tick();
  assert.equal(g2.inputs.at(-1).input.revokeHeadRequestId, null, 'never again');
  // a request whose done receipt exists (a restart between the receipt and the archive) is archived, not run again
  await g.drop(JSON.stringify({ ...revokeHeadRequest({ reason: 'again' }, g.clock), requestId: CLAIM }), 'requests');
  await g.exec.takePauseRequests();
  assert.deepEqual([await pending(g), g.exec.revokeHead], [0, null]);
  // never done: archived (refused as expired) once it is an hour old, and no run carries it any more
  const x = withInput({ inputs: [], engine: fakeEngine({ train: mode => answer(mode, rh(false), 0) }) });
  const h = await executorFixture(t, { policy: policyV8(), engine: x.engine });
  await h.drop(JSON.stringify({ ...revokeHeadRequest({ reason: 'x' }, h.clock), requestId: CLAIM }), 'requests');
  await h.exec.tick();
  assert.equal(await pending(h), 1);
  h.advance(61 * MIN);
  await h.exec.tick();
  assert.equal(await pending(h), 0);
  assert.equal((await ofType(h.receipts, 'resident-request-refused')).at(-1).failureCode, 'RESIDENT_REQUEST_EXPIRED');
  assert.equal(x.inputs.at(-1).input.revokeHeadRequestId, null);
  assert.equal(h.exec.revokeHead, null);
});

test('executor, on: STANDBY and UNCERTAIN run nothing and say NOT_ON_DUTY; ACTIVE starts onSince and the take-over at once', async t => {
  const engine = fakeEngine({ train: mode => answer(mode, DONE, 0) });
  engine.runRoleProbe = async () => ({ ok: false, code: 'ROLE_PROBE_BUSY', deferred: true, proof: null, roleProbe: null });
  const status = new StatusBoard({ clock: () => T0, pid: 1 });
  const f = await executorFixture(t, { policy: policyV8(), engine, status });
  await f.exec.tick();
  assert.deepEqual(trainCalls(engine), []);
  assert.equal(status.snapshot().train.notOnDuty, true);
  f.advance(MIN);
  await f.exec.setNodeMode('ACTIVE', 'test');
  assert.equal(f.exec.trainOnSince, f.clock());
  assert.deepEqual(f.exec.trainGate(), { state: 'DEFERRED', reason: 'TRAIN_TAKEOVER_SWEEP_PENDING' });
  await f.exec.tick();
  assert.deepEqual(trainCalls(engine).map(c => c[2]), ['on']);
  assert.equal(f.exec.trainGate(), null);
  await f.exec.setNodeMode('STANDBY', 'test');
  assert.equal(f.exec.trainOnSince, null);
});

test('HALT, PAUSE and the intake pause reach the status board in the tick they are latched', async t => {
  const status = new StatusBoard({ clock: () => T0, pid: 1 });
  const f = await executorFixture(t, { status });
  await f.exec.haltWith('TEST_HALT', {});
  assert.equal(status.snapshot().halt.code, 'TEST_HALT');
  const g = await executorFixture(t, { status: new StatusBoard({ clock: () => T0, pid: 1 }) });
  await g.drop(JSON.stringify({ contract: 'clued.independent-ci.resident-pause/1', reason: 'owner' }), 'requests');
  await g.exec.takePauseRequests();
  assert.equal(g.ports.status.snapshot().paused, true);
  const { intakePauseRequest } = await import('../src/intake-pause.mjs');
  await g.drop(JSON.stringify(intakePauseRequest({ minutes: 30, reason: 'switch' }, g.clock)), 'requests');
  await g.exec.takePauseRequests();
  assert.ok(g.ports.status.snapshot().intakePause?.holders?.length >= 1);
});

test('rearm-tool: request-probe and request-revoke-head write the requests\\ requests the service takes; mark-train-shadow-reviewed the mark stage 10 reads', async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const { TRAIN_REVIEW_CONTRACT, TRAIN_REVIEW_PATH, residentRequest } = await import('../tools/rearm-tool.mjs');
  const retention = await import('../../actions-hosted-migration/independent-ci-v1/src/resident-v2/state-retention.mjs');
  assert.equal(TRAIN_REVIEW_CONTRACT, retention.TRAIN_REVIEW_CONTRACT);
  assert.deepEqual(TRAIN_REVIEW_PATH, ['owner', retention.TRAIN_REVIEW_DIRECTORY, retention.TRAIN_REVIEW_NAME], 'the folder clued-control may read (install-resident.ps1 owner\\train-review)');
  assert.ok(retention.TRAIN_REVIEW_FILE.endsWith(`\\${TRAIN_REVIEW_PATH.join('\\')}`));
  const tool = fileURLToPath(new URL('../tools/rearm-tool.mjs', import.meta.url));
  const run = async (...args) => { try { const r = await promisify(execFile)(process.execPath, [tool, ...args]); return { code: 0, out: JSON.parse(r.stdout) }; } catch (e) { return { code: e.code, out: JSON.parse(e.stdout) }; } };
  const f = await executorFixture(t, { policy: policyV8() });
  f.exec.roleProbe.urgent = false;
  assert.equal((await run('request-probe', '--root', f.root, '--reason', 'now')).out.status, 'PROBE_REQUESTED');
  assert.equal((await run('request-revoke-head', '--root', f.root, '--reason', 'revoke the front')).out.status, 'REVOKE_HEAD_REQUESTED_NEXT_STAGE_10_WILL_REVOKE');
  assert.deepEqual(await run('request-probe', '--root', f.root), { code: 1, out: { status: 'REFUSED', code: 'RESIDENT_REQUEST_REASON_REQUIRED' } });
  f.advance(Date.now() - f.clock()); // the tool writes with the real clock
  await f.exec.takePauseRequests();
  assert.equal(f.exec.roleProbe.urgent, true);
  assert.equal(f.exec.revokeHead?.requestId.length, 36, 'the revoke-head request is in force');
  assert.equal(residentRequest('probe', { reason: 'x' }).contract, PROBE_REQUEST_CONTRACT);
  // the review mark: create-only in owner\train-review\, exactly what Source v2 reads
  await fs.mkdir(path.join(f.root, 'owner', 'train-review'), { recursive: true });
  const marked = await run('mark-train-shadow-reviewed', '--root', f.root, '--ref', 'Owner review of the shadow data, Note x');
  assert.equal(marked.out.status, 'TRAIN_SHADOW_REVIEW_MARKED');
  const read = await retention.readTrainReview(marked.out.file);
  assert.equal(read.code, null);
  assert.ok(Math.abs(read.reviewedAt - Date.now()) < 60_000);
  assert.deepEqual(await run('mark-train-shadow-reviewed', '--root', f.root, '--ref', 'again'), { code: 1, out: { status: 'REFUSED', code: 'CREATE_ONLY_TARGET_EXISTS' } }, 'once');
  assert.equal((await run('mark-train-shadow-reviewed', '--root', f.root)).out.code, 'TRAIN_REVIEW_REF_REQUIRED');
});

const FRONT1 = { pr: 884, headSha: HEAD, baseSha: BASE, testSha: S, testTree: TREE, claimId: CLAIM, since: new Date(T0 - MIN).toISOString(), attempt: 1 };
const busyProbe = engine => { engine.runRoleProbe = async () => ({ ok: false, code: 'ROLE_PROBE_BUSY', deferred: true, proof: null, roleProbe: null }); return engine; };

test('review R3 M3: the take-over is done only on a positive signal (full sweep complete since this onSince), never from a decision that is no deferral', async t => {
  const notSince = { sweep: { ...DONE.sweep, fullSweep: { ...DONE.sweep.fullSweep, sinceOn: false } } };
  const e = scripted([m => answer(m, { decision: 'TRAIN_SWEEP_INCOMPLETE' }, 1), m => answer(m, { decision: 'TRAIN_REVOKE_UNCONFIRMED' }, 1), m => answer(m, notSince, 0), m => answer(m, DONE, 0)]);
  const f = await executorFixture(t, { policy: policyV8(), engine: e.engine });
  await f.drop(triggerBytes());
  for (const decision of ['TRAIN_SWEEP_INCOMPLETE', 'TRAIN_REVOKE_UNCONFIRMED', null]) {
    const r = await f.exec.tick();
    assert.deepEqual([r.state, r.reason], ['DEFERRED', 'TRAIN_TAKEOVER_SWEEP_PENDING'], String(decision));
    if (decision) assert.equal(f.exec.trainLast.decision, decision);
    assert.equal(f.exec.trainTakeoverDone, false);
    assert.deepEqual(f.engine.calls.filter(c => c[0] === 'derive'), [], 'no batch, no publication');
    f.advance(10 * MIN);
  }
  await f.exec.tick();
  assert.equal(f.exec.trainTakeoverDone, true, 'complete since this onSince');
  f.advance(MIN);
  await f.exec.tick();
  assert.ok(f.engine.calls.some(c => c[0] === 'derive'), 'then the batch starts');
});

test('review R3 M2 (R2 M2): onSince and a finished take-over survive a restart with the same policy; STANDBY or another policy start over', async t => {
  const f = await executorFixture(t, { policy: policyV8(), engine: fakeEngine({ train: m => answer(m, DONE, 0) }) });
  await f.exec.tick();
  const onSince = f.exec.trainOnSince, iso = new Date(onSince).toISOString();
  assert.equal(f.exec.trainTakeoverDone, true);
  const duty = (await ofType(f.receipts, 'train-duty')).at(-1);
  assert.deepEqual([duty.onSince, duty.takeoverDone, duty.sweep.fullSinceOn], [iso, true, true]);
  // a restart an hour later, same policy: no new take-over; the next run carries the old onSince; the status keeps the sweep
  const e = withInput({ inputs: [], engine: fakeEngine({ train: m => answer(m, {}, 0) }) });
  const g = await executorFixture(t, { root: f.root, policy: policyV8(), engine: e.engine, now: T0 + 60 * MIN });
  await g.drop(triggerBytes({ pr: 990, headSha: '3'.repeat(40) }));
  await g.exec.tick();
  assert.deepEqual([g.exec.trainOnSince, g.exec.trainTakeoverDone, g.exec.trainSweep?.fullSinceOn], [onSince, true, true]);
  assert.ok(g.engine.calls.some(c => c[0] === 'derive'), 'the batch runs without a new take-over sweep');
  g.advance(MIN);
  await g.exec.tick();
  assert.equal(e.inputs[0].input.onSince, iso);
  // a node that probes: UNCERTAIN at the start holds the duty; ACTIVE again restores it; STANDBY ends it for good
  const p = await executorFixture(t, { root: f.root, policy: policyV8(), engine: busyProbe(fakeEngine({ train: m => answer(m, {}, 0) })), now: T0 + 120 * MIN });
  await p.exec.tick();
  assert.equal(p.exec.trainOnSince, null, 'UNCERTAIN: not eligible yet');
  await p.exec.setNodeMode('ACTIVE', 'test');
  assert.deepEqual([p.exec.trainOnSince, p.exec.trainTakeoverDone, p.exec.trainGate()], [onSince, true, null]);
  await p.exec.setNodeMode('UNCERTAIN', 'test');
  await p.exec.setNodeMode('ACTIVE', 'test');
  assert.equal(p.exec.trainOnSince, onSince, 'UNCERTAIN in between keeps it');
  await p.exec.setNodeMode('STANDBY', 'test');
  assert.equal(p.exec.trainOnSince, null);
  const q = await executorFixture(t, { root: f.root, policy: policyV8(), now: T0 + 180 * MIN });
  await q.exec.tick();
  assert.deepEqual([q.exec.trainOnSince, q.exec.trainTakeoverDone], [T0 + 180 * MIN, false], 'after STANDBY: a new eligibility');
  // another policy: a new eligibility too
  const h = await executorFixture(t, { policy: policyV8(), engine: fakeEngine({ train: m => answer(m, DONE, 0) }) });
  await h.exec.tick();
  const k = await executorFixture(t, { root: h.root, policy: policyV8({ maintenanceEveryMs: 11 * MIN }), now: T0 + 60 * MIN });
  await k.exec.tick();
  assert.deepEqual([k.exec.trainOnSince, k.exec.trainTakeoverDone], [T0 + 60 * MIN, false]);
  // shadow writes no duty
  const s = await executorFixture(t, { policy: policyV8({ enabled: 'shadow' }) });
  await s.exec.tick();
  assert.deepEqual(await ofType(s.receipts, 'train-duty'), []);
});

test('review R3 M5: attempt 2 of a front batch is the head\'s second front batch; its final deterministic-pr failure reports touch failed', async t => {
  const stages = { 2: { ok: false, code: 'BRIDGE_TRANSPORT_TIMEOUT', proof } };
  let i = 0;
  const list = [m => answer(m, { ...DONE, decision: 'OPEN_FRONT_BATCH', openFrontBatch: FRONT1 }, 1), m => answer(m, DONE, 0)];
  const e = withInput({ inputs: [], engine: fakeEngine({ stages, train: m => list[Math.min(i++, list.length - 1)](m) }) });
  const f = await executorFixture(t, { policy: policyV8(), engine: e.engine });
  await f.exec.tick(); // opens the front batch
  f.advance(MIN);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, typeof r.attempt2], ['FAILED_CLEAN', 'string'], 'a transient stage-2 failure: attempt 2');
  assert.deepEqual(f.exec.frontBatches.get(`884:${HEAD}`).map(x => x.attempt), [1, 2]);
  assert.equal(f.exec.frontKeys.get(r.attempt2), 2);
  assert.deepEqual((await ofType(f.receipts, 'train-front-enqueued')).map(b => [b.attempt, b.auto === true]), [[1, false], [2, true]]);
  // stage 10 cannot open a third front batch of this head
  assert.equal(await f.exec.enqueueFront({ ...FRONT1, testSha: '9'.repeat(40), attempt: 2 }), null);
  assert.equal((await ofType(f.receipts, 'train-front-refused')).at(-1).failureCode, 'TRAIN_FRONT_ATTEMPTS_USED');
  // attempt 2 fails for the PR itself: touch failed is owed, with attempt 2, and the next on-mode run carries it
  stages[2] = { ok: false, code: 'PR_NOT_OPEN_OR_CHANGED', proof, outcome: { status: 'BLOCKED', reason: 'full_admission_subject_changed', sideEffects: 0, mayHavePublished: false } };
  f.advance(10 * MIN);
  const r2 = await f.exec.tick();
  assert.deepEqual([r2.state, r2.failureCode], ['FAILED_CLEAN', 'PR_NOT_OPEN_OR_CHANGED']);
  const fo = (await ofType(f.receipts, 'train-front-outcome')).at(-1);
  assert.deepEqual([fo.frontOutcome.attempt, fo.frontOutcome.testSha, fo.frontOutcome.code], [2, S, 'PR_NOT_OPEN_OR_CHANGED']);
  f.advance(10 * MIN);
  await f.exec.tick();
  assert.deepEqual([e.inputs.at(-1).input.frontPr, e.inputs.at(-1).input.frontAttempt], [884, 2]);
  // a restart counts both front batches of the head
  const g = await executorFixture(t, { root: f.root, policy: policyV8() });
  await g.exec.trainRecover();
  assert.equal(g.exec.frontBatches.get(`884:${HEAD}`).length, 2);
  // no attempt 2 when the head's two front batches are used up (the second one failing transiently)
  const h = await executorFixture(t, { policy: policyV8() });
  h.exec.frontBatches.set(`884:${HEAD}`, [{ testSha: S, attempt: 1 }, { testSha: '8'.repeat(40), attempt: 2 }]);
  h.exec.frontKeys.set('b'.repeat(64), 2);
  const subject = { repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: h.ports.policy.sourceManifestSha256, attempt: 1, testSha: '8'.repeat(40) };
  assert.equal(await h.exec.attempt2IfEligible('b'.repeat(64), subject, { code: 'BRIDGE_TRANSPORT_TIMEOUT', stageNumber: 2 }), null);
});

test('review R3 M6: nonFrontRuns false schedules only the front subject; true runs every row as today', async t => {
  const f = await executorFixture(t, { policy: policyV8({ nonFrontRuns: false }), engine: fakeEngine({ train: m => answer(m, DONE, 0) }) });
  await f.exec.tick(); // the take-over
  await f.drop(triggerBytes({ pr: 990, headSha: '3'.repeat(40) }));
  f.advance(MIN);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.reason], ['DEFERRED', 'TRAIN_NON_FRONT_RUNS_OFF']);
  assert.equal(f.queue.row(990).reason, 'TRAIN_NON_FRONT_RUNS_OFF');
  assert.deepEqual(f.engine.calls.filter(c => c[0] === 'derive'), []);
  assert.ok(await f.exec.enqueueFront(FRONT1));
  f.advance(MIN);
  await f.exec.tick();
  const reserved = await ofType(f.receipts, 'batch-reserved');
  assert.deepEqual(reserved.map(b => [b.subject.pr, b.subject.testSha]), [[884, S]], 'only the front subject ran');
  const g = await executorFixture(t, { policy: policyV8(), engine: fakeEngine({ train: m => answer(m, DONE, 0) }) });
  await g.exec.tick();
  await g.drop(triggerBytes({ pr: 990, headSha: '3'.repeat(40) }));
  g.advance(MIN);
  assert.equal((await g.exec.tick()).state, 'COMPLETED', 'nonFrontRuns true: as today');
});

test('review R3 MINOR 3: the front outcome is carried again until stage 10 reports failed, or reporting it became moot', async t => {
  let failed = false, front = { pr: 884, headSha: HEAD };
  const at = m => { const a = answer(m, { ...DONE, actions: { ...NO_ACTIONS, failedReported: failed } }); a.train = { ...a.train, front }; return a; };
  const e = withInput({ inputs: [], engine: fakeEngine({ train: at }) });
  const f = await executorFixture(t, { policy: policyV8(), engine: e.engine });
  await f.exec.tick();
  const subject = { repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: f.ports.policy.sourceManifestSha256, attempt: 1, testSha: S };
  f.exec.frontKeys.set('k'.repeat(64), 1);
  await f.exec.noteFrontOutcome(subject, 'k'.repeat(64), 'PR_NOT_OPEN_OR_CHANGED');
  f.advance(MIN);
  await f.exec.tick();
  assert.deepEqual([e.inputs.at(-1).input.frontPr, (await ofType(f.receipts, 'train-run')).at(-1).frontOutcomeCleared], [884, false]);
  f.advance(10 * MIN);
  await f.exec.tick();
  assert.equal(e.inputs.at(-1).input.frontPr, 884, 'not reported: carried again');
  const g = await executorFixture(t, { policy: policyV8(), root: f.root });
  await g.exec.trainRecover();
  assert.equal(g.exec.trainFrontOutcome?.pr, 884, 'a restart before it was reported finds it again');
  failed = true;
  f.advance(10 * MIN);
  await f.exec.tick();
  assert.equal((await ofType(f.receipts, 'train-run')).at(-1).frontOutcomeCleared, true);
  f.advance(10 * MIN);
  await f.exec.tick();
  assert.equal(e.inputs.at(-1).input.frontPr, null, 'reported: cleared');
  // moot: the front is another head now
  failed = false;
  await f.exec.noteFrontOutcome(subject, 'k'.repeat(64), 'PR_NOT_OPEN_OR_CHANGED');
  front = { pr: 884, headSha: '9'.repeat(40) };
  f.advance(MIN);
  await f.exec.tick();
  assert.equal((await ofType(f.receipts, 'train-run')).at(-1).frontOutcomeCleared, true);
  assert.equal(f.exec.trainFrontOutcome, null);
});

test('review R3 MINOR 4: under an intake pause stage 10 runs revoke-only whatever the queue holds (on); shadow stays held', async t => {
  const { intakePauseRequest } = await import('../src/intake-pause.mjs');
  for (const [policy, want] of [[policyV8(), ['on', 'revoke-only']], [policyV8({ enabled: 'shadow' }), ['shadow']]]) {
    const e = withInput({ inputs: [], engine: fakeEngine({ train: m => answer(m, DONE, 0) }) });
    const f = await executorFixture(t, { policy, engine: e.engine });
    await f.exec.tick();
    await f.drop(JSON.stringify(intakePauseRequest({ minutes: 30, reason: 'switch' }, f.clock)), 'requests');
    await f.drop(triggerBytes({ pr: 990, headSha: '3'.repeat(40) }));
    f.advance(10 * MIN);
    const r = await f.exec.tick();
    assert.equal(r.reason, 'INTAKE_PAUSED');
    assert.deepEqual(e.inputs.map(x => x.mode), want, policy.train.enabled);
  }
});

test('review R3 MINOR 5: front rows (S) are dropped when the node turns STANDBY, and at a start whose train is not on', async t => {
  const engine = busyProbe(fakeEngine({ train: m => answer(m, { ...DONE, decision: 'OPEN_FRONT_BATCH', openFrontBatch: FRONT1 }, 1) }));
  const f = await executorFixture(t, { policy: policyV8(), engine });
  await f.exec.tick();
  await f.exec.setNodeMode('ACTIVE', 'test');
  await f.exec.tick();
  assert.equal(f.queue.row(884).current.testSha, S);
  await f.exec.setNodeMode('STANDBY', 'test');
  assert.deepEqual([f.queue.row(884).state, f.queue.row(884).reason, f.queue.row(884).current], ['DONE', 'TRAIN_NOT_ON_DUTY', null]);
  const g = await executorFixture(t, { policy: policyV8(), engine: fakeEngine({ train: m => answer(m, { ...DONE, decision: 'OPEN_FRONT_BATCH', openFrontBatch: FRONT1 }, 1) }) });
  await g.exec.tick();
  assert.equal(g.queue.row(884).current.testSha, S);
  const h = await executorFixture(t, { root: g.root, policy: policyV8({ enabled: 'shadow' }) });
  assert.deepEqual([h.queue.row(884).state, h.queue.row(884).reason], ['DONE', 'TRAIN_NOT_ON']);
  await h.exec.tick();
  assert.equal((await ofType(h.receipts, 'batch-reserved')).length, 0, 'the old front row never runs');
});

test('Source A/B round: TRAIN_SOURCE_UNREADABLE defers like a Source mismatch (no notice); TRAIN_MODE_UNREADABLE at stage 1 releases the front head', async t => {
  const e = scripted([m => answer(m, DONE, 0), m => answer(m, { ...DONE, decision: 'TRAIN_SOURCE_UNREADABLE' }, 0), m => answer(m, DONE, 0)]);
  const f = await executorFixture(t, { policy: policyV8(), engine: e.engine });
  await f.exec.tick();
  f.advance(10 * MIN);
  await f.exec.tick();
  assert.equal(f.exec.trainLast.decision, 'TRAIN_SOURCE_UNREADABLE', 'a decision the summary keeps');
  assert.deepEqual(f.exec.trainGate(), { state: 'DEFERRED', reason: 'TRAIN_SOURCE_UNREADABLE' });
  assert.equal(f.queue.notices.filter(n => n.kind === 'train-owner').length, 0, 'no Owner notice');
  f.advance(10 * MIN);
  await f.exec.tick();
  assert.equal(f.exec.trainGate(), null);
  const refused = { ok: false, code: 'TRAIN_MODE_UNREADABLE', proof, outcome: { status: 'BLOCKED', reason: 'TRAIN_MODE_UNREADABLE', sideEffects: 0, mayHavePublished: false } };
  const g = await executorFixture(t, { policy: policyV8(), engine: fakeEngine({ stages: { 1: refused }, train: m => answer(m, { ...DONE, decision: 'OPEN_FRONT_BATCH', openFrontBatch: FRONT1 }, 1) }) });
  await g.exec.tick();
  g.advance(MIN);
  const r = await g.exec.tick();
  assert.deepEqual([r.state, r.failureCode, r.release], ['NOT_ADMITTED', 'TRAIN_MODE_UNREADABLE', 'NOT_ADMITTED'], 'released whatever safeToRerun says');
  const reserved = (await ofType(g.receipts, 'batch-reserved')).at(-1);
  assert.equal(await g.ledger.headBurned(reserved.headKey), false, 'never burned');
  // a side effect, or no bound outcome, is no release
  const { decideFailure } = await import('../src/classify.mjs');
  assert.equal(decideFailure({ code: 'TRAIN_MODE_UNREADABLE', stage: 1, outcome: { ...refused.outcome, sideEffects: 1 }, proof, started: false }).release, null);
  assert.equal(decideFailure({ code: 'TRAIN_MODE_UNREADABLE', stage: 1, outcome: null, proof, started: false }).release, null);
});

test('Source A/B round: TRAIN_FRONT_BATCH_RUNNING enqueues nothing and makes the parked front batch\'s next stage-8 try due now', async t => {
  const f = await executorFixture(t, { policy: policyV8(), engine: fakeEngine({ train: m => answer(m, { ...DONE, decision: 'TRAIN_FRONT_BATCH_RUNNING' }, 0) }) });
  const parked = { key: 'p'.repeat(64), state: 'STARTED', plan: {}, reserved: { subject: { pr: 884, headSha: HEAD, testSha: S } }, parked: { at: new Date(T0).toISOString() }, tries: [{ ended: { nextAt: new Date(T0 + 60 * MIN).toISOString() } }] };
  const other = { key: 'q'.repeat(64), state: 'STARTED', plan: {}, reserved: { subject: { pr: 884, headSha: HEAD } }, parked: { at: new Date(T0).toISOString() }, tries: [] };
  f.exec.ledger = Object.create(f.ledger, { parkedEntries: { value: async () => [parked, other] } });
  await f.exec.trainActed({ ...trainSummary(answer('on', { ...DONE, decision: 'TRAIN_FRONT_BATCH_RUNNING' }).train), front: { pr: 884, headSha: HEAD } }, { mode: 'on', input: { onSince: null }, frontOutcome: null, frontCleared: false, revokeHead: null });
  f.exec.ledger = f.ledger;
  assert.equal(f.exec.parkedDueAt(parked), f.clock(), 'due now');
  assert.equal(f.exec.parkNudges.has(other.key), false, 'only a front batch (S)');
  assert.equal(f.queue.row(884), null, 'nothing enqueued');
});

test('review R3 MINOR 6: parked batches wait for the take-over sweep; MINOR 11: a head\'s front batches count whatever their age', async t => {
  const f = await executorFixture(t, { policy: policyV8(), engine: fakeEngine({ train: m => answer(m, { decision: 'TRAIN_TAKEOVER_SWEEP_PENDING' }, 0) }) });
  const holds = [];
  const resume = f.exec.resumeParked.bind(f.exec);
  f.exec.resumeParked = async o => { holds.push(o?.hold === true); return resume(o); };
  await f.exec.tick();
  f.advance(10 * MIN);
  await f.exec.tick();
  assert.deepEqual(holds, [true, true]);
  assert.deepEqual(await resume({ hold: true }), { acted: null, waiting: null });
  const s = await executorFixture(t, { policy: policyV8({ enabled: 'shadow' }) });
  const shadowHolds = [];
  const sr = s.exec.resumeParked.bind(s.exec);
  s.exec.resumeParked = async o => { shadowHolds.push(o?.hold === true); return sr(o); };
  await s.exec.tick();
  assert.deepEqual(shadowHolds, [false], 'shadow: as before');
  // MINOR 11
  await f.receipts.append('train-front-enqueued', { key: 'a'.repeat(64), pr: 884, headSha: HEAD, baseSha: BASE, testSha: S, testTree: TREE, attempt: 1, claimId: CLAIM, since: FRONT1.since });
  const g = await executorFixture(t, { root: f.root, policy: policyV8(), now: T0 + 3 * 24 * 60 * MIN });
  await g.exec.trainRecover();
  assert.deepEqual(g.exec.frontBatches.get(`884:${HEAD}`), [{ testSha: S, attempt: 1 }]);
});

test('round-2 review MINOR 1: a node that ran no stage 10 for longer than fullSweepMaxMs restores no duty (a new take-over sweep)', async t => {
  const f = await executorFixture(t, { policy: policyV8(), engine: fakeEngine({ train: m => answer(m, DONE, 0) }) });
  await f.exec.tick();
  assert.equal(f.exec.trainTakeoverDone, true);
  const late = T0 + policyV8().train.fullSweepMaxMs + 60 * MIN;
  const g = await executorFixture(t, { root: f.root, policy: policyV8(), now: late });
  await g.exec.tick();
  assert.deepEqual([g.exec.trainOnSince, g.exec.trainTakeoverDone], [late, false]);
});
