// The merge train on, the resident side (step 3c-2b, DESIGN §41.3-41.8; INTERFACES §2, §3): policy /8, the train-run job /2,
// facts /2 with side effects, revoke-only under PAUSE, the take-over gate, the front batch with S, the two request files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { POLICY_CONTRACT_V8, TRAIN_DEFAULTS, TRAIN_SWEEP_DEFAULT, trainSettings, trainSweepMode, trainLandingMode, trainBatchMax, installedTrainLanding, validatePolicy } from '../src/policy.mjs';
import { DECISIONS, trainDue, TRAIN_RUN_INPUT_FIELDS, chainOfFront, openFrontBatchOf, trainRunInput, trainRunMode, trainSummary, trainSweepView, parseTrainSweep, validateTrainRunInput,
  trainNodesView, parseTrainNodes } from '../src/train.mjs';
import { fleetSourceCheck } from '../rollout/precheck.mjs';
import { RELAY_TRAIN_FRONT_LOCAL, TRAIN_CLEAN_CODES, failureRow } from '../src/classify.mjs';
import { PROBE_REQUEST_CONTRACT, REVOKE_HEAD_REQUEST_CONTRACT, probeRequest, revokeHeadRequest, validateResidentRequest } from '../src/resident-requests.mjs';
import { installedTrainMode } from '../src/engine-windows.mjs';
import { StatusBoard, parseStatus } from '../src/status.mjs';
import { executorFixture, fakeCompanion, fakeEngine, notAdmitted, rawPolicy, triggerBytes, HEAD, BASE, SAFE_REFUSAL } from './helpers.mjs';
import { breakerOf } from '../src/breaker.mjs';
import { ResidentExecutor } from '../src/executor.mjs';
import { makeTrainRun, TRAIN_RUN_PARAMS } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/train-run.mjs';
import { DECISIONS as SOURCE_DECISIONS, NO_ACTIONS, NO_SWEEP, trainFacts } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-facts.mjs';
import { TRAIN_CODES as SOURCE_TRAIN_CODES } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-10-20T12:00:00Z');
const S = '5'.repeat(40), TREE = '6'.repeat(40), CLAIM = '0a1b2c3d-0000-4000-8000-0000000000aa';
// Gate mode (DESIGN §41, §60-§62): the take-over full sweep these tests exercise; strict-permanent mode (§65) has its own tests.
const onTrain = (o = {}) => ({ enabled: 'on', nonFrontRuns: true, maintenanceEveryMs: 10 * MIN, maintenanceMaxPerDay: 200, ...TRAIN_DEFAULTS, sweep: 'gate', ...o });
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

// DESIGN §65 (strict-permanent mode, Owner decision 9e2511fe): train.sweep is optional in /8 and later; without it the Owner's default
// 'audit'; the policy digest of an installed policy without it is unchanged; the train-run input carries it next to the clocks.
test('policy train.sweep: optional gate | audit | off, default audit; carried by the train-run input and the job /4', () => {
  assert.equal(TRAIN_SWEEP_DEFAULT, 'audit');
  const { sweep, ...without } = onTrain(); void sweep;
  const p = validatePolicy(rawPolicy({ contract: POLICY_CONTRACT_V8, train: without }));
  assert.equal(Object.hasOwn(p.train, 'sweep'), false, 'nothing is added to the installed policy');
  assert.equal(trainSweepMode(p.train), 'audit');
  assert.equal(trainSweepMode(rawPolicy().train), 'audit', '/7 carries the default');
  for (const v of ['gate', 'audit', 'off']) assert.equal(trainSweepMode(validatePolicy(policyV8({ sweep: v })).train), v);
  for (const v of ['full', null, true, 'GATE']) assert.throws(() => validatePolicy(policyV8({ sweep: v })), { code: 'POLICY_TRAIN_INVALID' }, String(v));
  assert.throws(() => validatePolicy(rawPolicy({ train: { ...rawPolicy().train, sweep: 'audit' } })), { code: 'POLICY_TRAIN_KEYS_INVALID' }, '/7 never takes it');
  assert.equal(Object.hasOwn(trainSettings(onTrain()), 'sweep'), false, 'the clocks (strictSettingsDigest) stay the four of /8');
  for (const v of ['gate', 'audit', 'off']) {
    const input = trainRunInput({ mode: 'on', settings: trainSettings(onTrain()), sweep: v, onSince: T0 });
    assert.equal(input.sweep, v);
    const job = makeTrainRun({ repo: 'tdoljyj/cross-memory-system', runId: `${'1'.repeat(16)}-${'2'.repeat(12)}`, sourceManifestSha256: 'e'.repeat(64), createdAt: new Date(T0).toISOString(), ...input });
    assert.equal(job.sweep, v);
  }
  assert.throws(() => trainRunInput({ mode: 'on', settings: trainSettings(onTrain()), sweep: 'full', onSince: T0 }), { code: 'TRAIN_RUN_INPUT_INVALID' });
  assert.deepEqual(TRAIN_RUN_INPUT_FIELDS, ['mode', ...TRAIN_RUN_PARAMS]);
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
  const front = { pr: 910, headSha: HEAD, testSha: S, attempt: 1, code: 'STAGE_CHILD_REFUSED', failed: true };
  const on = trainRunInput({ mode: 'on', settings, onSince: T0, frontOutcome: front, revokeHeadRequestId: CLAIM });
  assert.deepEqual([on.onSince, on.frontPr, on.frontAttempt, on.revokeHeadRequestId], [new Date(T0).toISOString(), 910, 1, CLAIM]);
  assert.deepEqual([job(on).frontCode, job(on).frontFailed], ['STAGE_CHILD_REFUSED', true]);
  const ended = trainRunInput({ mode: 'on', settings, onSince: T0, frontOutcome: { ...front, code: 'TRAIN_BATCH_CHANGED', failed: false }, revokeHeadRequestId: null });
  assert.deepEqual([job(ended).frontCode, job(ended).frontFailed], ['TRAIN_BATCH_CHANGED', false], 'R3 batch 2: an ended front batch that did not fail for the PR');
  const revokeOnly = trainRunInput({ mode: 'revoke-only', settings, onSince: T0, frontOutcome: front, revokeHeadRequestId: CLAIM });
  assert.deepEqual([revokeOnly.frontPr, revokeOnly.revokeHeadRequestId], [null, CLAIM], 'no failed report under PAUSE');
  assert.equal(job(revokeOnly).mode, 'revoke-only');
  for (const bad of [{ ...on, onSince: null }, { ...shadow, revokeHeadRequestId: CLAIM }, { ...on, frontTestSha: HEAD }, { ...on, frontCode: null }, { ...on, frontFailed: null }, { ...on, frontFailed: 'true' }, { ...shadow, frontFailed: false }, { ...on, extra: 1 }])
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

test('executor, on: main rewritten after the take-over holds new batches again until the round of scope all completes, whatever the run decides', async t => {
  const rewritten = (decision, state = 'running') => ({ decision, sweep: { ...NO_SWEEP, kind: 'full-segment', complete: false, fullSweep: { state, startedAt: new Date(T0).toISOString(),
    completedAt: null, sinceOn: false, reason: null, scope: 'all', scopeReason: 'TRAIN_MAIN_REWRITTEN', allPending: 'TRAIN_MAIN_REWRITTEN' } } });
  const e = scripted([mode => answer(mode, DONE, 0), mode => answer(mode, rewritten('TRAIN_SWEEP_INCOMPLETE'), 0), mode => answer(mode, rewritten('TRAIN_REVOKE_UNCONFIRMED'), 0),
    mode => answer(mode, DONE, 0)]);
  const f = await executorFixture(t, { policy: policyV8(), engine: e.engine });
  withInput(e);
  await f.exec.tick();
  assert.equal(f.exec.trainTakeoverDone, true, 'the take-over sweep completed');
  assert.equal(f.exec.trainGate(), null);
  for (const decision of ['TRAIN_SWEEP_INCOMPLETE', 'TRAIN_REVOKE_UNCONFIRMED']) {
    f.advance(10 * MIN);
    await f.exec.tick();
    assert.deepEqual([f.exec.trainTakeoverDone, f.exec.trainGate()], [false, { state: 'DEFERRED', reason: 'TRAIN_TAKEOVER_SWEEP_PENDING' }], decision);
  }
  f.advance(10 * MIN);
  await f.exec.tick();
  assert.deepEqual([f.exec.trainTakeoverDone, f.exec.trainGate()], [true, null], 'the round of scope all completed since on');
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

test('executor, on (ADR 0019): a front batch of several PRs keeps its members (receipt, restart) and hands them to derive; one PR hands none', async t => {
  const H2 = '3'.repeat(40), H3 = '4'.repeat(40);
  const members = [{ pr: 884, headSha: HEAD }, { pr: 885, headSha: H2 }, { pr: 886, headSha: H3 }];
  const front = { pr: 884, headSha: HEAD, baseSha: BASE, testSha: S, testTree: TREE, claimId: CLAIM, since: new Date(T0 - MIN).toISOString(), attempt: 1, members };
  const f = await executorFixture(t, { policy: policyV8(), engine: fakeEngine({ train: mode => answer(mode, { ...DONE, decision: 'OPEN_FRONT_BATCH', openFrontBatch: front }, 1) }) });
  await f.exec.tick(); // the take-over run opens the batch
  const [enq] = await ofType(f.receipts, 'train-front-enqueued');
  assert.deepEqual(enq.members, members, 'the receipt carries the members (a restart reads them back)');
  // a restart before the batch runs: the binding, members included, comes back from the receipts
  const g = await executorFixture(t, { root: f.root, policy: policyV8(), engine: fakeEngine({ train: mode => answer(mode, { ...DONE }, 0) }) });
  await g.exec.trainFrontRecover([]);
  assert.deepEqual(g.exec.frontBindings.get(`884:${S}`)?.members, members);
  f.advance(MIN);
  await f.exec.tick();
  const derive = f.engine.calls.find(c => c[0] === 'derive');
  assert.ok(derive, JSON.stringify(f.engine.calls));
  assert.deepEqual(JSON.parse(JSON.stringify(derive[2])), { members, testTree: TREE }, 'descriptor /4: the members and S\'s tree');
  // one PR (no members): derive gets no chain, exactly as before
  const one = { ...front, members: undefined };
  delete one.members;
  const h = await executorFixture(t, { policy: policyV8(), engine: fakeEngine({ train: mode => answer(mode, { ...DONE, decision: 'OPEN_FRONT_BATCH', openFrontBatch: one }, 1) }) });
  await h.exec.tick();
  h.advance(MIN);
  await h.exec.tick();
  assert.deepEqual(h.engine.calls.find(c => c[0] === 'derive').length, 2);
  // members that do not describe the front make the whole batch unusable (never a /3 descriptor for a chain S by mistake)
  assert.equal(openFrontBatchOf({ ...front, members: [members[1], members[0]] }), null);
  assert.equal(openFrontBatchOf({ ...front, members: [members[0]] }), null);
  assert.equal(openFrontBatchOf({ ...front, members: [members[0], { ...members[1], headSha: S }] }), null);
  assert.equal(chainOfFront({ repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, testSha: '9'.repeat(40) }, openFrontBatchOf(front)), null, 'another S');
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
  await f.exec.noteFrontOutcome(subject, 'k'.repeat(64), 'STAGE_CHILD_REFUSED', true);
  await f.exec.noteFrontOutcome({ ...subject, testSha: undefined }, 'x'.repeat(64), 'STAGE_CHILD_REFUSED', true); // not a front batch: nothing
  f.advance(MIN);
  await f.exec.tick();
  const carried = e.inputs.at(-1).input;
  assert.deepEqual([carried.frontPr, carried.frontHeadSha, carried.frontTestSha, carried.frontAttempt, carried.frontCode, carried.frontFailed], [884, HEAD, S, 2, 'STAGE_CHILD_REFUSED', true]);
  assert.equal((await ofType(f.receipts, 'train-run')).at(-1).frontOutcomeSeq, (await f.receipts.latest(['train-front-outcome'], 1))[0].seq);
  f.advance(10 * MIN);
  await f.exec.tick();
  assert.equal(e.inputs.at(-1).input.frontPr, null, 'reported once');
  // a restart before it was carried finds it again
  const g = await executorFixture(t, { policy: policyV8(), root: f.root, engine: fakeEngine({ train: mode => answer(mode, {}, 0) }) });
  await g.receipts.append('train-front-outcome', { key: 'k'.repeat(64), frontOutcome: { pr: 884, headSha: HEAD, testSha: S, attempt: 1, code: 'STAGE_CHILD_REFUSED' } });
  assert.equal(await g.exec.trainRecover(), null);
  assert.equal(g.exec.trainFrontOutcome.pr, 884);
  assert.equal(g.exec.trainFrontOutcome.failed, true, 'R3 batch 2: a receipt from before frontFailed was a failed report');
});

// FABLE-r3-batch2-followup §1b (修复前必红): a front batch that only ended (frontFailed false) is receipted as 'train-front-ended', never
// as 'train-front-outcome': a resident of the generation before (an automatic roll-back) reads every 'train-front-outcome' as failed and
// its stage 10 would touch failed on a PR that did not fail. A restart reads the newest of the two types; the next stage 10 is told.
test('R3 batch 2 1b: an ended front batch is a train-front-ended receipt, not a train-front-outcome; a restart carries it with frontFailed false', async t => {
  const e = withInput({ inputs: [], engine: fakeEngine({ train: mode => answer(mode, {}, 0) }) });
  const f = await executorFixture(t, { policy: policyV8(), engine: e.engine });
  await f.exec.tick();
  const subject = { repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: f.ports.policy.sourceManifestSha256, attempt: 1, testSha: S };
  f.exec.frontKeys.set('k'.repeat(64), 1);
  await f.exec.noteFrontOutcome(subject, 'k'.repeat(64), 'TRAIN_BATCH_CHANGED', false);
  assert.deepEqual(await f.receipts.latest(['train-front-outcome'], 1), [], 'what an older resident reads as failed is not written');
  assert.deepEqual((await f.receipts.latest(['train-front-ended'], 1)).map(r => [r.value.body.frontOutcome.code, r.value.body.frontOutcome.failed]), [['TRAIN_BATCH_CHANGED', false]]);
  const ge = withInput({ inputs: [], engine: fakeEngine({ train: mode => answer(mode, {}, 0) }) });
  const g = await executorFixture(t, { policy: policyV8(), root: f.root, engine: ge.engine });
  await g.exec.trainRecover();
  assert.deepEqual([g.exec.trainFrontOutcome?.pr, g.exec.trainFrontOutcome?.failed], [884, false], 'a restart finds it');
  await g.exec.tick();
  assert.deepEqual([ge.inputs.at(-1)?.input.frontPr, ge.inputs.at(-1)?.input.frontCode, ge.inputs.at(-1)?.input.frontFailed], [884, 'TRAIN_BATCH_CHANGED', false]);
  // a failure of the PR itself is a train-front-outcome as before, and the newest of the two is the one a restart carries
  f.exec.frontKeys.set('m'.repeat(64), 2);
  await f.exec.noteFrontOutcome({ ...subject, attempt: 2 }, 'm'.repeat(64), 'PR_NOT_OPEN_OR_CHANGED', true);
  assert.deepEqual((await f.receipts.latest(['train-front-outcome'], 1)).map(r => [r.value.body.frontOutcome.attempt, r.value.body.frontOutcome.failed]), [[2, true]]);
  const h = await executorFixture(t, { policy: policyV8(), root: f.root });
  await h.exec.trainRecover();
  assert.deepEqual([h.exec.trainFrontOutcome?.attempt, h.exec.trainFrontOutcome?.failed], [2, true]);
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
  assert.deepEqual([fo.frontOutcome.attempt, fo.frontOutcome.testSha, fo.frontOutcome.code, fo.frontOutcome.failed], [2, S, 'PR_NOT_OPEN_OR_CHANGED', true]);
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

// FABLE-r3-batch2-gate R5 (防回归): front batch 1 fails transiently, its automatic attempt 2 is scheduled, and stage 10 opens front
// number 2 of the same S as well: both are attempt 2 of the same (H, S), one batch key; enqueueFront takes it only once (S + attempt), so
// attempt 2 runs once.
test('R3 batch 2 R5: an automatic attempt 2 and stage 10\'s front number 2 of the same S are one batch: it runs once', async t => {
  const stages = { 2: { ok: false, code: 'BRIDGE_TRANSPORT_TIMEOUT', proof } };
  let i = 0;
  const list = [m => answer(m, { ...DONE, decision: 'OPEN_FRONT_BATCH', openFrontBatch: FRONT1 }, 1), m => answer(m, DONE, 0)];
  const f = await executorFixture(t, { policy: policyV8(), engine: fakeEngine({ stages, train: m => list[Math.min(i++, list.length - 1)](m) }) });
  await f.exec.tick(); // opens the front batch
  f.advance(MIN);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, typeof r.attempt2], ['FAILED_CLEAN', 'string'], 'a transient stage-2 failure: attempt 2');
  assert.equal(await f.exec.enqueueFront({ ...FRONT1, attempt: 2 }), null, 'front number 2 of the same S is the attempt 2 already scheduled');
  stages[2] = { ok: true, factsSha256: 'd'.repeat(64) };
  for (let n = 0; n < 6; n++) { f.advance(10 * MIN); await f.exec.tick(); }
  const reserved = (await ofType(f.receipts, 'batch-reserved')).filter(b => b.subject?.testSha === S);
  assert.deepEqual(reserved.map(b => [b.subject.attempt, b.origin]), [[1, 'queued'], [2, 'attempt2']], JSON.stringify(reserved));
  assert.equal(reserved[1].key, r.attempt2);
  assert.equal(f.engine.calls.filter(c => c[0] === 'derive').length, 2, JSON.stringify(f.engine.calls));
  assert.deepEqual((await ofType(f.receipts, 'train-front-enqueued')).map(b => [b.attempt, b.auto === true]), [[1, false], [2, true]]);
});

// R6 (防回归): a batch of several PRs that fails transiently still gets its automatic attempt 2, the same members and S, as before.
test('R3 batch 2 R6: a batch of several PRs that fails transiently still gets its automatic attempt 2 (same members, same S)', async t => {
  const members = [{ pr: 884, headSha: HEAD }, { pr: 885, headSha: '3'.repeat(40) }];
  const stages = { 2: { ok: false, code: 'BRIDGE_TRANSPORT_TIMEOUT', proof } };
  let i = 0;
  const list = [m => answer(m, { ...DONE, decision: 'OPEN_FRONT_BATCH', openFrontBatch: { ...FRONT1, members } }, 1), m => answer(m, DONE, 0)];
  const f = await executorFixture(t, { policy: policyV8(), engine: fakeEngine({ stages, train: m => list[Math.min(i++, list.length - 1)](m) }) });
  await f.exec.tick();
  f.advance(MIN);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, typeof r.attempt2], ['FAILED_CLEAN', 'string']);
  stages[2] = { ok: true, factsSha256: 'd'.repeat(64) };
  for (let n = 0; n < 6; n++) { f.advance(10 * MIN); await f.exec.tick(); }
  const reserved = (await ofType(f.receipts, 'batch-reserved')).filter(b => b.subject?.testSha === S);
  assert.deepEqual(reserved.map(b => [b.subject.attempt, b.origin]), [[1, 'queued'], [2, 'attempt2']], JSON.stringify(reserved));
  const derives = f.engine.calls.filter(c => c[0] === 'derive');
  assert.ok(derives.length === 2 && derives.every(c => JSON.stringify(c[2]?.members) === JSON.stringify(members)), JSON.stringify(derives));
});

// FABLE-r3-batch2-gate §3 A1 (修复前必红): a front batch fails transiently, its automatic attempt 2 is scheduled, and stage 1 of attempt 2
// releases it for the node role. The same attempt 2 is given back: an `attempt2-reopened` receipt whose attempt1 is the front batch's key
// (the subject with S), and the intent is pending again. Before the fix reopenAttempt2 built key1 from this.current, which has no S: the
// ledger refused it and attempt 2 stayed spent.
const NO_ROLE_HERE = { ...SAFE_REFUSAL, diagnostic: { ...SAFE_REFUSAL.diagnostic, reasonCodes: ['admission_binding_required'] } };
test('R3 batch 2 A1: a front batch\'s automatic attempt 2 released for the node role at stage 1 is given back (key1 with S)', async t => {
  const stages = { 2: { ok: false, code: 'BRIDGE_TRANSPORT_TIMEOUT', proof } };
  let i = 0;
  const list = [m => answer(m, { ...DONE, decision: 'OPEN_FRONT_BATCH', openFrontBatch: FRONT1 }, 1), m => answer(m, DONE, 0)];
  const e = withInput({ inputs: [], engine: fakeEngine({ stages, train: m => list[Math.min(i++, list.length - 1)](m) }) });
  const f = await executorFixture(t, { policy: policyV8(), engine: e.engine });
  await f.exec.tick(); // opens the front batch
  f.advance(MIN);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, typeof r.attempt2], ['FAILED_CLEAN', 'string'], 'a transient stage-2 failure: attempt 2');
  const key1 = (await ofType(f.receipts, 'batch-reserved')).find(b => b.key === r.key);
  assert.equal(key1.subject.testSha, S, 'attempt 1 is the front batch, its subject names S');
  stages[1] = notAdmitted('NODE_ROLE_NOT_HELD', NO_ROLE_HERE);
  f.advance(11 * MIN);
  const second = await f.exec.tick();
  assert.deepEqual([second.state, second.key, second.failureCode], ['NOT_ADMITTED', r.attempt2, 'NODE_ROLE_NOT_HELD'], JSON.stringify(second));
  assert.deepEqual((await ofType(f.receipts, 'attempt2-reopened')).map(b => [b.key, b.attempt1]), [[r.attempt2, r.key]]);
  assert.deepEqual((await f.ledger.pendingAttempts2()).map(a => a.key2), [r.attempt2], 'the same attempt 2 is pending again');
});

// A2 (防回归): stage 10's front number 2 is a queue row (origin not 'attempt2'), not an attempt-2 intent. Released for the node role at
// stage 1, it gives nothing back (no `attempt2-reopened`); the row stays queued and runs again.
test('R3 batch 2 A2: stage 10\'s front number 2 released for the node role at stage 1 gives back no attempt 2; its row stays and retries', async t => {
  const stages = { 1: notAdmitted('NODE_ROLE_NOT_HELD', NO_ROLE_HERE) };
  let i = 0;
  const list = [m => answer(m, { ...DONE, decision: 'OPEN_FRONT_BATCH', openFrontBatch: { ...FRONT1, attempt: 2 } }, 1), m => answer(m, DONE, 0)];
  const e = withInput({ inputs: [], engine: fakeEngine({ stages, train: m => list[Math.min(i++, list.length - 1)](m) }) });
  const f = await executorFixture(t, { policy: policyV8(), engine: e.engine });
  await f.exec.tick(); // opens front number 2
  assert.deepEqual([f.queue.row(884)?.current?.testSha, f.queue.row(884)?.current?.frontAttempt], [S, 2]);
  f.advance(MIN);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['NOT_ADMITTED', 'NODE_ROLE_NOT_HELD'], JSON.stringify(r));
  const reserved = (await ofType(f.receipts, 'batch-reserved')).find(b => b.key === r.key);
  assert.deepEqual([reserved.subject.attempt, reserved.subject.testSha, reserved.origin === 'attempt2'], [2, S, false]);
  assert.deepEqual(await ofType(f.receipts, 'attempt2-reopened'), []);
  assert.deepEqual(await f.ledger.pendingAttempts2(), []);
  const row = f.queue.row(884);
  assert.deepEqual([row?.current?.testSha, row?.current?.frontAttempt], [S, 2], 'the row is still queued');
  delete stages[1];
  const ranBefore = e.engine.calls.filter(c => c[0] === 'stage' && c[1] === 1).length;
  for (let k = 0; k < 10 && e.engine.calls.filter(c => c[0] === 'stage' && c[1] === 1).length === ranBefore; k++) { f.advance(11 * MIN); await f.exec.tick(); }
  assert.ok(e.engine.calls.filter(c => c[0] === 'stage' && c[1] === 1).length > ranBefore, 'the row runs again');
  assert.equal((await ofType(f.receipts, 'batch-reserved')).at(-1).key, r.key, 'with the same key');
});

test('ADR 0019 review blocker 1: batches of several PRs never use up the front\'s two attempts (bisection reaches the front alone); attempt 2 keeps /4', async t => {
  const members = [{ pr: 884, headSha: HEAD }, { pr: 885, headSha: '3'.repeat(40) }, { pr: 886, headSha: '4'.repeat(40) }];
  const FRONTM = { ...FRONT1, members };
  const stages = { 2: { ok: false, code: 'BRIDGE_TRANSPORT_TIMEOUT', proof } };
  let i = 0;
  const list = [m => answer(m, { ...DONE, decision: 'OPEN_FRONT_BATCH', openFrontBatch: FRONTM }, 1), m => answer(m, DONE, 0)];
  const f = await executorFixture(t, { policy: policyV8(), engine: fakeEngine({ stages, train: m => list[Math.min(i++, list.length - 1)](m) }) });
  await f.exec.tick(); // opens the batch of three
  f.advance(MIN);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, typeof r.attempt2], ['FAILED_CLEAN', 'string'], 'a transient failure of the batch of three: attempt 2');
  assert.deepEqual(f.exec.frontBatches.get(`884:${HEAD}`).map(x => [x.attempt, x.solo]), [[1, false], [2, false]], 'neither is one of the front\'s own attempts');
  const auto = (await ofType(f.receipts, 'train-front-enqueued')).at(-1);
  assert.deepEqual([auto.auto, auto.members], [true, members], 'the attempt-2 receipt names the members (a restart counts it as a batch of several)');
  stages[2] = { ok: true, factsSha256: 'd'.repeat(64) };
  f.advance(10 * MIN);
  await f.exec.tick();
  const derives = f.engine.calls.filter(c => c[0] === 'derive');
  assert.equal(derives.length, 2, JSON.stringify(f.engine.calls));
  assert.ok(derives.every(c => JSON.stringify(c[2]?.members) === JSON.stringify(members)), 'attempt 1 and attempt 2 are both descriptor /4');
  // bisection: the first half, then the front alone twice: every one of them reaches the run queue; only a third front-alone is refused
  const refusedCodes = async () => (await ofType(f.receipts, 'train-front-refused')).map(b => b.failureCode);
  const before = (await refusedCodes()).length;
  f.exec.frontBatches.set(`884:${HEAD}`, [{ testSha: S, attempt: 1, solo: false }, { testSha: '8'.repeat(40), attempt: 1, solo: false }, { testSha: '9'.repeat(40), attempt: 1, solo: false }]);
  await f.exec.enqueueFront({ ...FRONT1, testSha: 'a'.repeat(40), attempt: 1 });
  assert.ok(!(await refusedCodes()).slice(before).includes('TRAIN_FRONT_ATTEMPTS_USED'), 'the front alone after three batches of several');
  f.exec.frontBatches.set(`884:${HEAD}`, [{ testSha: S, attempt: 1, solo: true }, { testSha: '8'.repeat(40), attempt: 2, solo: true }]);
  await f.exec.enqueueFront({ ...FRONTM, testSha: 'b'.repeat(40), attempt: 2, members: [members[0], members[1]] });
  assert.ok(!(await refusedCodes()).slice(before).includes('TRAIN_FRONT_ATTEMPTS_USED'), 'a batch of several after the front\'s two attempts');
  assert.equal(await f.exec.enqueueFront({ ...FRONT1, testSha: 'c'.repeat(40), attempt: 2 }), null);
  assert.equal((await ofType(f.receipts, 'train-front-refused')).at(-1).failureCode, 'TRAIN_FRONT_ATTEMPTS_USED', 'a third front alone is refused, as before');
  // a restart: the batches of several come back as such (members in their receipts)
  const g = await executorFixture(t, { root: f.root, policy: policyV8() });
  await g.exec.trainRecover();
  assert.deepEqual(g.exec.frontBatches.get(`884:${HEAD}`).map(x => x.solo), [false, false, true, false], JSON.stringify(g.exec.frontBatches.get(`884:${HEAD}`)));
  // the front alone whose two attempts are used up gets no attempt 2, as before
  const h = await executorFixture(t, { policy: policyV8() });
  h.exec.frontBatches.set(`884:${HEAD}`, [{ testSha: '6'.repeat(40), attempt: 1, solo: true }, { testSha: '7'.repeat(40), attempt: 2, solo: true }, { testSha: '8'.repeat(40), attempt: 1, solo: false }]);
  const solo = { repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: h.ports.policy.sourceManifestSha256, attempt: 1, testSha: '9'.repeat(40) };
  assert.equal(await h.exec.attempt2IfEligible('b'.repeat(64), solo, { code: 'BRIDGE_TRANSPORT_TIMEOUT', stageNumber: 2 }), null);
});

test('ADR 0019 review 2: a batch whose member moved on (the bundle says so) is released like a supersession: no release cap, no breaker, its S dropped', async t => {
  const members = [{ pr: 884, headSha: HEAD }, { pr: 885, headSha: '3'.repeat(40) }];
  const FRONTM = { ...FRONT1, members };
  let i = 0;
  const list = [m => answer(m, { ...DONE, decision: 'OPEN_FRONT_BATCH', openFrontBatch: FRONTM }, 1), m => answer(m, DONE, 0)];
  const f = await executorFixture(t, { policy: policyV8(), engine: fakeEngine({ train: m => list[Math.min(i++, list.length - 1)](m) }),
    companion: fakeCompanion({ bundle: { ok: false, code: 'TRAIN_BATCH_MEMBER_MOVED' } }) });
  await f.exec.tick(); // opens the batch of two
  f.advance(MIN);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode, r.release], ['NOT_EXECUTED', 'TRAIN_BATCH_MEMBER_MOVED', 'SUPERSEDED'], JSON.stringify(r));
  const row = f.queue.row(884);
  assert.deepEqual([row.state, row.reason, row.current], ['DONE', 'TRAIN_BATCH_MEMBER_MOVED', null], 'the S is dropped: it can never pass again');
  assert.equal((await f.ledger.usage(f.clock() - 24 * 60 * MIN)).releasesByHead.get(HEAD) ?? 0, 0, 'not counted towards the front head\'s release cap');
  assert.equal(breakerOf(f.queue.breaker).state, 'closed');
  const un = (await ofType(f.receipts, 'batch-unexecuted')).at(-1);
  assert.deepEqual([un.failureCode, un.release], ['TRAIN_BATCH_MEMBER_MOVED', 'SUPERSEDED']);
  // a plain bundle refusal of the same batch is the counted environment release, as before
  let j = 0;
  const list2 = [m => answer(m, { ...DONE, decision: 'OPEN_FRONT_BATCH', openFrontBatch: FRONTM }, 1), m => answer(m, DONE, 0)];
  const g = await executorFixture(t, { policy: policyV8(), engine: fakeEngine({ train: m => list2[Math.min(j++, list2.length - 1)](m) }),
    companion: fakeCompanion({ bundle: { ok: false, code: 'BUNDLE_UNAVAILABLE' } }) });
  await g.exec.tick();
  g.advance(MIN);
  const r2 = await g.exec.tick();
  assert.deepEqual([r2.state, r2.failureCode], ['NOT_EXECUTED', 'BUNDLE_UNAVAILABLE']);
  assert.equal(r2.settle.reason, 'BUNDLE_UNAVAILABLE');
  assert.notEqual(g.queue.row(884).current, null, 'kept for a later try, as before');
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
  await f.exec.noteFrontOutcome(subject, 'k'.repeat(64), 'PR_NOT_OPEN_OR_CHANGED', true);
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
  await f.exec.noteFrontOutcome(subject, 'k'.repeat(64), 'PR_NOT_OPEN_OR_CHANGED', true);
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
  assert.deepEqual(g.exec.frontBatches.get(`884:${HEAD}`), [{ testSha: S, attempt: 1, solo: true }]);
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

// Defect b0426896 (field, 08:02:39 -> 08:12:44): after the upgrade's restart the resident starts under the upgrader's PAUSE; the first
// stage 10 runs revoke-only (REVOKE_ONLY_DONE, wouldDo NO_FRONT) and used up the urgency the new eligibility had set, so the first
// on-mode run after the resume waited a whole maintenanceEveryMs while the queue's head PR sat there. Once the pause is lifted
// (upgrade-resumed, or the last intake hold resumed) and no on-mode stage 10 ran yet in this duty (or the last one was revoke-only),
// stage 10 is due at once: the first on run happens within a minute of the resume, and the head PR's front batch goes in.
test('defect b0426896: install -> upgrade PAUSE (revoke-only) -> upgrade-resumed: the first on run within a minute, the head PR goes in', async t => {
  const { upgradeResumeRequest } = await import('../src/upgrade-mailbox.mjs');
  const e = withInput({ inputs: [], engine: fakeEngine({ train: m => m === 'revoke-only' ? answer(m, { decision: 'REVOKE_ONLY_DONE' }, 0)
    : answer(m, { ...DONE, decision: 'OPEN_FRONT_BATCH', openFrontBatch: FRONT1 }, 1) }) });
  const f = await executorFixture(t, { policy: policyV8(), engine: e.engine });
  // the upgrader paused the resident before its restart; the head PR's trigger is waiting
  await f.ledger.pause({ reason: 'upgrade', requestSha256: 'a'.repeat(64) });
  await f.drop(triggerBytes({ pr: 884, headSha: HEAD }));
  assert.equal((await f.exec.tick()).state, 'PAUSED');
  assert.deepEqual(e.inputs.map(x => x.mode), ['revoke-only']);
  assert.equal((await ofType(f.receipts, 'train-run')).at(-1).decision, 'REVOKE_ONLY_DONE');
  // still paused a minute later: nothing more runs (revoke-only keeps its own cadence)
  f.advance(MIN);
  await f.exec.tick();
  assert.deepEqual(e.inputs.map(x => x.mode), ['revoke-only']);
  f.advance(MIN);
  const paused = await f.ledger.paused();
  await f.drop(Buffer.from(JSON.stringify(upgradeResumeRequest({ pausedSha256: paused.sha256, opId: CLAIM, generation: 3 }, f.clock))), 'owner');
  const resumedAt = f.clock();
  for (let i = 0; i < 2 && !e.inputs.some(x => x.mode === 'on'); i += 1) { await f.exec.tick(); if (!e.inputs.some(x => x.mode === 'on')) f.advance(30_000); }
  assert.equal(await f.ledger.paused(), null);
  assert.equal((await f.receipts.latest(['upgrade-resumed'], 5)).length, 1);
  const on = (await f.receipts.latest(['train-run-intent'], 50)).find(r => r.value.body.runMode === 'on');
  assert.ok(on, 'an on-mode stage 10 ran after the resume');
  assert.ok(Date.parse(on.value.at) - resumedAt <= MIN, `the first on run ${(Date.parse(on.value.at) - resumedAt) / 1000}s after the resume`);
  // the head PR's front batch is queued and reserved
  assert.deepEqual((await ofType(f.receipts, 'train-front-enqueued')).map(b => [b.pr, b.testSha]), [[884, S]]);
  f.advance(MIN);
  await f.exec.tick();
  assert.deepEqual((await ofType(f.receipts, 'batch-reserved')).map(b => [b.subject.pr, b.subject.headSha, b.subject.testSha]), [[884, HEAD, S]], 'the front batch (H, S) of the head PR started');
  // no repeat: the urgency was spent by that on run, the next one keeps its cadence
  const runs = e.inputs.length;
  f.advance(MIN);
  await f.exec.tick();
  assert.equal(e.inputs.length, runs);
});

test('defect b0426896: an intake hold left after the upgrade-resume keeps revoke-only; its intake-resumed makes the first on run due at once', async t => {
  const { intakePauseRequest, intakeResumeRequest } = await import('../src/intake-pause.mjs');
  const { upgradeResumeRequest } = await import('../src/upgrade-mailbox.mjs');
  const e = withInput({ inputs: [], engine: fakeEngine({ train: m => m === 'revoke-only' ? answer(m, { decision: 'REVOKE_ONLY_DONE' }, 0) : answer(m, DONE, 0) }) });
  const f = await executorFixture(t, { policy: policyV8(), engine: e.engine });
  await f.ledger.pause({ reason: 'upgrade', requestSha256: 'a'.repeat(64) });
  await f.drop(JSON.stringify(intakePauseRequest({ holder: 'version-skew', minutes: 120, reason: 'UPGRADE_VERSION_SKEW' }, f.clock)), 'requests');
  await f.exec.tick();
  assert.deepEqual(e.inputs.map(x => x.mode), ['revoke-only']);
  f.advance(2 * MIN);
  const paused = await f.ledger.paused();
  await f.drop(Buffer.from(JSON.stringify(upgradeResumeRequest({ pausedSha256: paused.sha256, opId: CLAIM, generation: 3 }, f.clock))), 'owner');
  await f.exec.tick();
  assert.equal(await f.ledger.paused(), null);
  assert.deepEqual(e.inputs.map(x => x.mode), ['revoke-only'], 'the intake hold still holds: no extra revoke-only run, no on run');
  f.advance(2 * MIN);
  await f.drop(JSON.stringify(intakeResumeRequest({ holder: 'version-skew', reason: 'VERSIONS_CONSISTENT' }, f.clock)), 'requests');
  const resumedAt = f.clock();
  await f.exec.tick();
  assert.deepEqual(e.inputs.map(x => x.mode), ['revoke-only', 'on'], 'the first on run in the tick of the intake-resumed');
  const on = (await f.receipts.latest(['train-run-intent'], 50)).find(r => r.value.body.runMode === 'on');
  assert.ok(Date.parse(on.value.at) - resumedAt <= MIN);
});

test('defect b0426896: the resume urgency never passes the daily cap and never runs a second time in the same duty', async t => {
  const { upgradeResumeRequest } = await import('../src/upgrade-mailbox.mjs');
  const e = withInput({ inputs: [], engine: fakeEngine({ train: m => m === 'revoke-only' ? answer(m, { decision: 'REVOKE_ONLY_DONE' }, 0) : answer(m, DONE, 0) }) });
  const f = await executorFixture(t, { policy: policyV8({ maintenanceMaxPerDay: 1 }), engine: e.engine });
  await f.ledger.pause({ reason: 'upgrade', requestSha256: 'a'.repeat(64) });
  await f.exec.tick();
  f.advance(MIN);
  const paused = await f.ledger.paused();
  await f.drop(Buffer.from(JSON.stringify(upgradeResumeRequest({ pausedSha256: paused.sha256, opId: CLAIM, generation: 3 }, f.clock))), 'owner');
  await f.exec.tick();
  f.advance(MIN);
  await f.exec.tick();
  assert.deepEqual(e.inputs.map(x => x.mode), ['revoke-only'], 'the one run of the day was spent; the resume does not add one');
  // an on run already happened in this duty and was not followed by revoke-only: a later PAUSE/resume pair adds nothing
  const g = withInput({ inputs: [], engine: fakeEngine({ train: m => answer(m, DONE, 0) }) });
  const h = await executorFixture(t, { policy: policyV8(), engine: g.engine });
  await h.exec.tick();
  assert.deepEqual(g.inputs.map(x => x.mode), ['on']);
  h.advance(MIN);
  await h.ledger.pause({ reason: 'owner', requestSha256: 'b'.repeat(64) });
  await h.ledger.resume((await h.ledger.paused()).sha256, 'S-1-5-32-544');
  await h.exec.tick();
  assert.deepEqual(g.inputs.map(x => x.mode), ['on'], 'no on run before its cadence');
});

test('defect a8910e41: after the take-over the head bound in this duty runs no ordinary batch; the marker never outlives the duty', async t => {
  const e = withInput({ inputs: [], engine: fakeEngine({ train: m => answer(m, DONE, 0) }) });
  const f = await executorFixture(t, { policy: policyV8(), engine: e.engine });
  await f.exec.tick();
  assert.equal(f.exec.trainTakeoverDone, true);
  f.exec.frontBound.set(`884:${HEAD}`, f.clock());
  await f.drop(triggerBytes({ pr: 884, headSha: HEAD }));
  f.advance(MIN);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.reason], ['DEFERRED', 'TRAIN_FRONT_BOUND_HEAD']);
  assert.deepEqual(f.engine.calls.filter(c => c[0] === 'derive'), [], 'no ordinary batch of the bound head in this duty');
  assert.equal(f.queue.row(884).state, 'QUEUED', 'the row stays');
  // a marker from before this duty's onSince holds nothing
  f.exec.frontBound.set(`884:${HEAD}`, f.exec.trainOnSince - 1);
  f.advance(5 * MIN);
  await f.exec.tick();
  assert.ok(f.engine.calls.some(c => c[0] === 'derive'), 'the head runs like any other');
});

test('service loop: after stage 10 gives OPEN_FRONT_BATCH the next sleep is the short one, not the 15 s resting one', async t => {
  const { serviceLoop } = await import('../src/service-main.mjs');
  const front = { pr: 884, headSha: HEAD, baseSha: BASE, testSha: S, testTree: TREE, claimId: CLAIM, since: new Date(T0 - MIN).toISOString(), attempt: 1 };
  const f = await executorFixture(t, { policy: policyV8(), engine: fakeEngine({ train: mode => answer(mode, { ...DONE, decision: 'OPEN_FRONT_BATCH', openFrontBatch: front }, 1) }) });
  const slept = [];
  let ticks = 0;
  const exec = { tick: async () => { ticks += 1; return f.exec.tick(); } };
  await serviceLoop({ exec, lock: { touch: async () => {} }, sleep: async ms => { slept.push(ms); f.advance(ms); }, stopRequested: async () => ticks >= 1 && slept.length >= 1,
    acknowledgeStop: async () => {}, onLoopException: async () => {}, betweenBatches: async () => {} });
  assert.equal(f.queue.row(884).current.testSha, S, 'the front batch was queued');
  assert.deepEqual(slept, [2_000], 'a batch is to open: the short sleep');
});

test('defect: a TRAIN_SOURCE_MISMATCH or TRAIN_SOURCE_UNREADABLE run is re-checked after 2 minutes, not 10; the daily cap still holds', async t => {
  for (const decision of ['TRAIN_SOURCE_MISMATCH', 'TRAIN_SOURCE_UNREADABLE']) {
    const e = withInput({ inputs: [], engine: fakeEngine({ train: m => answer(m, e.inputs.length === 2 ? { ...DONE, decision } : DONE, 0) }) });
    const f = await executorFixture(t, { policy: policyV8(), engine: e.engine });
    await f.exec.tick();
    f.advance(10 * MIN);
    await f.exec.tick();
    assert.equal(f.exec.trainLast.decision, decision);
    assert.equal(e.inputs.length, 2);
    f.advance(MIN);
    await f.exec.tick();
    assert.equal(e.inputs.length, 2, 'not yet: 1 minute');
    f.advance(MIN);
    await f.exec.tick();
    assert.equal(e.inputs.length, 3, `${decision}: due 2 minutes after`);
    assert.equal(f.exec.trainLast.decision, 'NO_FRONT', 'the peer is ready now; back to the normal cadence');
    f.advance(2 * MIN);
    await f.exec.tick();
    assert.equal(e.inputs.length, 3, 'a normal run keeps the 10 minute cadence');
  }
  // the daily cap is not bypassed
  const g = withInput({ inputs: [], engine: fakeEngine({ train: m => answer(m, { ...DONE, decision: 'TRAIN_SOURCE_MISMATCH' }, 0) }) });
  const h = await executorFixture(t, { policy: policyV8({ maintenanceMaxPerDay: 2 }), engine: g.engine });
  await h.exec.tick();
  h.advance(2 * MIN);
  await h.exec.tick();
  assert.equal(g.inputs.length, 2);
  h.advance(2 * MIN);
  await h.exec.tick();
  assert.equal(g.inputs.length, 2, 'cap of 2 per day holds');
  assert.equal(trainDue({ train: onTrain({ maintenanceMaxPerDay: 2 }), now: T0 + 5 * MIN, runs: [T0, T0 + 2 * MIN], busy: false, recheck: true }), false);
});

// ADR 0018 (bors-style landing): train.landing and train.batchMax are optional in /8 and later; neither written changes nothing.
test('policy train.landing / train.batchMax: optional, defaults github-merge and 1; push only in strict-permanent mode; a batch only with push', () => {
  const p = validatePolicy(policyV8({ sweep: 'audit' }));
  assert.equal(Object.hasOwn(p.train, 'landing'), false, 'nothing is added to the installed policy');
  assert.deepEqual([trainLandingMode(p.train), trainBatchMax(p.train)], ['github-merge', 1]);
  assert.deepEqual(installedTrainLanding(p), { landing: 'github-merge', batchMax: 1 });
  assert.deepEqual(installedTrainLanding(validatePolicy(policyV8({ sweep: 'off', landing: 'push', batchMax: 4 }))), { landing: 'push', batchMax: 4 });
  assert.deepEqual(installedTrainLanding(validatePolicy(policyV8({ sweep: 'audit', landing: 'push' }))), { landing: 'push', batchMax: 1 });
  for (const train of [{ sweep: 'gate', landing: 'push' }, { landing: 'push' } /* sweep gate in this fixture */, { sweep: 'audit', batchMax: 2 }, { sweep: 'audit', landing: 'github-merge', batchMax: 2 },
    { sweep: 'audit', landing: 'push', batchMax: 5 }, { sweep: 'audit', landing: 'push', batchMax: 0 }, { sweep: 'audit', landing: 'merge' }, { sweep: 'audit', landing: null }])
    assert.throws(() => validatePolicy(policyV8(train)), { code: 'POLICY_TRAIN_INVALID' }, JSON.stringify(train));
  assert.throws(() => validatePolicy(rawPolicy({ train: { ...rawPolicy().train, landing: 'push' } })), { code: 'POLICY_TRAIN_KEYS_INVALID' }, '/7 never takes it');
  assert.equal(Object.hasOwn(trainSettings(policyV8({ sweep: 'audit', landing: 'push' }).train), 'landing'), false, 'the clocks stay the four of /8');
});

test('push codes (ADR 0018): every stage-8 landing code is in the resident tables and the Source table; the PR-attributable one feeds frontOutcome', () => {
  const codes = ['TRAIN_LANDING_CHECKS_PENDING', 'TRAIN_LANDING_RULES_MISSING', 'TRAIN_LANDING_REFUSED', 'TRAIN_LANDING_CHECK_FAILED', 'TRAIN_BATCH_CHANGED', 'TRAIN_BATCH_WITHOUT_PUSH'];
  for (const c of codes) {
    assert.ok(TRAIN_CLEAN_CODES.includes(c) && SOURCE_TRAIN_CODES.includes(c), c);
    assert.ok(failureRow({ code: c, stage: 8 }), c);
  }
  assert.equal(failureRow({ code: 'TRAIN_LANDING_CHECK_FAILED', stage: 8 }).class, 'deterministic-pr', 'bisection or touch failed follows');
  for (const c of ['TRAIN_BATCH_CHANGED', 'TRAIN_BATCH_WITHOUT_PUSH']) assert.equal(failureRow({ code: c, stage: 8 }).class, 'clean-final');
});

// Defect 15894c2a (end to end, resident side): the nodes an on-mode stage 10 compared in its §41.6 Source check reach the status snapshot
// (train.nodes) the NON-elevated upgrade precheck reads; there the precheck's comparison against a target refuses while another node heard
// within 24 hours runs another Source, and passes once it runs the target. A run that read no nodes (shadow, not on duty) keeps the list.
test('defect 15894c2a: stage 10\'s nodes list reaches status.json train.nodes; the precheck compares the target against it', async t => {
  const status = new StatusBoard({ clock: () => T0, pid: 1 });
  const target = 'd'.repeat(64), heard = new Date(T0 - 5 * MIN).toISOString();
  let peerSource = null, mode = 'on';
  const nodes = own => [{ node: 'desk', sourceManifestSha256: own, state: 'NORMAL', lastHeartbeatAt: new Date(T0).toISOString() },
    { node: 'node-b', sourceManifestSha256: peerSource, state: 'NORMAL', lastHeartbeatAt: heard }];
  let own = null;
  const f = await executorFixture(t, { policy: policyV8(), status, engine: fakeEngine({ train: m => answer(m, mode === 'on' ? { ...DONE, decision: 'NO_FRONT', nodes: nodes(own), nodesDropped: 0 } : DONE, 0) }) });
  own = f.exec.policy.ciSourceManifestSha256;
  peerSource = own;
  await f.exec.tick();
  const onDisk = () => JSON.parse(JSON.stringify(status.snapshot())).train.nodes; // what precheck.mjs reads from state\status.json
  const read = parseStatus(Buffer.from(JSON.stringify(status.snapshot()))).train.nodes;
  assert.deepEqual([read.at, read.sourceManifestSha256, read.nodes.map(n => [n.node, n.sourceManifestSha256, n.lastHeartbeatAt])],
    [new Date(T0).toISOString(), own, [['desk', own, new Date(T0).toISOString()], ['node-b', own, heard]]]);
  const check = (onDuty = true) => fleetSourceCheck({ view: parseTrainNodes(onDisk()), target, selfNames: ['desk'], now: T0 + MIN, onDuty });
  assert.deepEqual([check().status, check().upgradeFirst], ['MISMATCH', ['node-b']], 'node-b still runs the current Source: it goes first');
  assert.deepEqual([check(false).status, check(false).reason], ['UNVERIFIED', 'NOT_ON_DUTY'], 'review m2: only the node on duty refuses');
  // node-b installs the target; the next on-mode run reads it
  peerSource = target;
  f.advance(10 * MIN);
  await f.exec.tick();
  assert.equal(check().status, 'PASS');
  assert.equal(parseTrainNodes(onDisk()).at, new Date(T0).toISOString(), 'facts carry the run time the fixture gave');
});

test('defect 15894c2a: trainNodesView takes on-mode facts /2 with a nodes list only; a malformed list is none', () => {
  const own = 'e'.repeat(64);
  const facts = o => answer('on', { decision: 'NO_FRONT', nodes: [{ node: 'node-b', sourceManifestSha256: 'c'.repeat(64), state: 'NORMAL', lastHeartbeatAt: new Date(T0).toISOString() }], nodesDropped: 2, ...o }, 0).train;
  const v = trainNodesView(facts(), own);
  assert.deepEqual([v.sourceManifestSha256, v.dropped, v.nodes.length], [own, 2, 1]);
  assert.equal(trainNodesView(facts({ nodes: null }), own), null, 'a run that read no nodes');
  assert.equal(trainNodesView(answer('shadow', {}, 0).train, own), null, 'shadow reads no nodes');
  assert.equal(trainNodesView(facts(), 'not-a-hash'), null);
  assert.equal(parseTrainNodes({ ...v, nodes: [{ node: 'x', sourceManifestSha256: 'zz', state: null, lastHeartbeatAt: null }] }), null);
  assert.deepEqual(parseTrainNodes(JSON.parse(JSON.stringify(v))), v);
});

// D6 §8.4 (b), field 2026-11-19: a landing state stage 10 cannot read while this node has landing batches is its own decision, no longer
// TRAIN_SWEEP_INCOMPLETE; the Owner is told (one notice a day) and the error stays in state\status.json's train.last.
test('executor, on: TRAIN_LANDING_STATE_UNREADABLE tells the Owner and keeps landing.error in the status', async t => {
  const status = new StatusBoard({ clock: () => T0, pid: 1 });
  const landing = { error: 'TRAIN_LANDING_STATE_UNREADABLE' };
  const f = await executorFixture(t, { policy: policyV8(), status,
    engine: fakeEngine({ train: mode => answer(mode, mode === 'on' ? { ...DONE, decision: 'TRAIN_LANDING_STATE_UNREADABLE', landing } : DONE, 1) }) });
  assert.ok(DECISIONS.includes('TRAIN_LANDING_STATE_UNREADABLE') && SOURCE_DECISIONS.includes('TRAIN_LANDING_STATE_UNREADABLE'));
  await f.exec.tick();
  assert.equal(await f.ledger.halted(), null);
  assert.ok(f.queue.notices.some(n => n.kind === 'train-owner' && n.code === 'TRAIN_LANDING_STATE_UNREADABLE'), JSON.stringify(f.queue.notices));
  const last = parseStatus(Buffer.from(JSON.stringify(status.snapshot()))).train.last;
  assert.deepEqual([last.decision, last.landing], ['TRAIN_LANDING_STATE_UNREADABLE', landing]);
  assert.equal(trainSummary({ ...answer('on', { ...DONE, decision: 'NO_FRONT' }).train, landing: { error: 'not a code' } })?.landing, undefined, 'only a code is kept');
});

// Fable 11-21 open points §5: stage 10's landing.bypass (this App's bypass state of the main and the independent ruleset) is kept in the
// summary and state\status.json's train.last, for the landing precheck's P3 (no elevation needed); a bypass of another shape is dropped.
test('open points §5: trainSummary and status.json keep landing.bypass; another shape is dropped, the route stays', async () => {
  const status = new StatusBoard({ clock: () => T0, pid: 1 });
  const on = landing => ({ ...answer('on', { ...DONE, decision: 'NO_FRONT' }).train, landing });
  const kept = { route: 'github-merge', bypass: { main: 'never', independent: 'never' } };
  assert.deepEqual(trainSummary(on(kept))?.landing, kept);
  status.update({ train: { enabled: 'on', last: trainSummary(on(kept)) } });
  assert.deepEqual(parseStatus(Buffer.from(JSON.stringify(status.snapshot()))).train.last.landing, kept, 'status.json keeps it');
  assert.deepEqual(trainSummary(on({ route: 'push', bypass: { main: 'always', independent: 'absent' } }))?.landing, { route: 'push', bypass: { main: 'always', independent: 'absent' } });
  for (const bypass of [{ main: 'never' }, { main: 'never', independent: 'never', more: 'never' }, 'never'])
    assert.deepEqual(trainSummary(on({ route: 'push', bypass }))?.landing, { route: 'push' }, JSON.stringify(bypass));
});

// Task 04f9b91b (Fable s7-landing-gaps 11-22, 改动 3): the landing precheck's P3 --before reads what push still lacks (landing.missing) from
// state\status.json: the resident keeps stage 10's list as written, checking the shape only (at most 16 distinct items, each a lower-case
// word with an optional :suffix, as train-landing.mjs#validLandingMissing); another shape drops the list, the rest stays.
test('task 04f9b91b: trainSummary and status.json keep landing.missing; another shape is dropped, the route and bypass stay', async () => {
  const status = new StatusBoard({ clock: () => T0, pid: 1 });
  const on = landing => ({ ...answer('on', { ...DONE, decision: 'NO_FRONT' }).train, landing });
  const kept = { route: 'github-merge', missing: ['train_landed_check_missing', 'main_app_cannot_bypass'], bypass: { main: 'never', independent: 'never' } };
  assert.deepEqual(trainSummary(on(kept))?.landing, kept);
  status.update({ train: { enabled: 'on', last: trainSummary(on(kept)) } });
  assert.deepEqual(parseStatus(Buffer.from(JSON.stringify(status.snapshot()))).train.last.landing, kept, 'status.json keeps it');
  assert.deepEqual(trainSummary(on({ route: 'park', missing: ['ruleset_app_cannot_bypass:27843120'] }))?.landing, { route: 'park', missing: ['ruleset_app_cannot_bypass:27843120'] });
  assert.deepEqual(trainSummary(on({ route: 'push', missing: [] }))?.landing, { route: 'push', missing: [] });
  const wrong = [['not an array', 'x'], ['a number', [7]], ['upper case', ['Main']], ['a space', ['a b']], ['twice', ['main_x', 'main_x']],
    ['seventeen', Array.from({ length: 17 }, (_, i) => `item_${String.fromCharCode(97 + i)}`)]]
    .filter(([, missing]) => JSON.stringify(trainSummary(on({ route: 'push', missing }))?.landing) !== JSON.stringify({ route: 'push' })).map(([label]) => label);
  assert.deepEqual(wrong, [], 'every other shape dropped, the route stays');
});

// Fable 11-21 open points §10 point 2: the resident only keeps what stage 10 wrote; it knows no list of bypass states (that list is
// Source v2's train-landing.mjs#BYPASS_STATES alone, and the two may be of different generations). It checks the shape only: exactly the
// keys main and independent, each a short string of lower-case letters and underscores. Which values are right is the reader's (P3).
test('open points §10: a bypass state the resident never heard of is kept as written; only the shape drops one', async () => {
  const status = new StatusBoard({ clock: () => T0, pid: 1 });
  const on = landing => ({ ...answer('on', { ...DONE, decision: 'NO_FRONT' }).train, landing });
  const newer = { route: 'push', bypass: { main: 'some_new_state', independent: 'absent' } };
  assert.deepEqual(trainSummary(on(newer))?.landing, newer, 'a value of a newer Source generation is kept');
  status.update({ train: { enabled: 'on', last: trainSummary(on(newer)) } });
  assert.deepEqual(parseStatus(Buffer.from(JSON.stringify(status.snapshot()))).train.last.landing, newer, 'status.json keeps it');
  assert.deepEqual(trainSummary(on({ route: 'push', bypass: { main: 'absent', independent: 'x' } }))?.landing, { route: 'push', bypass: { main: 'absent', independent: 'x' } });
  const bad = [
    ['not a string', { main: 7, independent: 'never' }], ['null', { main: 'never', independent: null }], ['empty', { main: '', independent: 'never' }],
    ['too long', { main: 'a'.repeat(33), independent: 'never' }], ['upper case', { main: 'Never', independent: 'never' }],
    ['a hyphen', { main: 'never', independent: 'not-read' }], ['a space', { main: 'never ', independent: 'never' }], ['a digit', { main: 'never2', independent: 'never' }],
    ['one key more', { main: 'never', independent: 'never', more: 'never' }], ['one key fewer', { main: 'never' }], ['not an object', 'never'], ['an array', ['never', 'never']],
  ];
  const wrong = bad.filter(([, bypass]) => JSON.stringify(trainSummary(on({ route: 'push', bypass }))?.landing) !== JSON.stringify({ route: 'push' })).map(([label]) => label);
  assert.deepEqual(wrong, [], 'every other shape dropped, the route stays');
  assert.deepEqual(trainSummary(on({ route: 'push', bypass: { main: 'a'.repeat(32), independent: 'never' } }))?.landing?.bypass?.main, 'a'.repeat(32), '32 characters is short enough');
});

// ---- bc982192 parked-front, redone on frontFailed: every end of a front batch reaches stage 10 (D:/w/tmp/FABLE-parked-front-vs-frontfailed-20261123.md §1 items 3a-3c) ----
// R1 (3a): a batch of several whose member moved on before stage 1 is released and its S dropped from the run queue (ADR 0019 review 2):
// that is its end. The next on-mode stage 10 carries it (frontFailed false), so it counts the batch ended and composes the next one;
// otherwise train-maintenance.mjs#liveFrontBatch counts it running and the merge slot is renewed up to its hard cap.
test('parked-front R1: a batch of several dropped before stage 1 (TRAIN_BATCH_MEMBER_MOVED) is reported ended to the next stage 10, frontFailed false', async t => {
  const members = [{ pr: 884, headSha: HEAD }, { pr: 885, headSha: '3'.repeat(40) }];
  const FRONTM = { ...FRONT1, members };
  const e = withInput(scripted([m => answer(m, { ...DONE, decision: 'OPEN_FRONT_BATCH', openFrontBatch: FRONTM }, 1), m => answer(m, DONE, 0)]));
  const f = await executorFixture(t, { policy: policyV8(), engine: e.engine, companion: fakeCompanion({ bundle: { ok: false, code: 'TRAIN_BATCH_MEMBER_MOVED' } }) });
  await f.exec.tick(); // opens the batch of two
  f.advance(MIN);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['NOT_EXECUTED', 'TRAIN_BATCH_MEMBER_MOVED'], JSON.stringify(r));
  assert.equal(f.queue.row(884).current, null, 'the S is dropped');
  f.advance(10 * MIN);
  await f.exec.tick();
  const carried = e.inputs.at(-1).input;
  assert.deepEqual([carried.frontPr, carried.frontHeadSha, carried.frontTestSha, carried.frontAttempt, carried.frontCode, carried.frontFailed],
    [884, HEAD, S, 1, 'TRAIN_BATCH_MEMBER_MOVED', false], JSON.stringify(carried));
  assert.equal((await ofType(f.receipts, 'train-front-ended')).length, 1, 'reported once');
});

// R2 (3b): a front batch an earlier boot left open before stage 1 is closed at the restart (DESIGN §71, restartedUnpublished), before
// trainRecover. The front book (frontKeys, frontBatches) is read first, so the batch keeps its front attempt: the head's second front
// batch gets no attempt 2 (never a third), and its end reaches the first on-mode stage 10 of the new process (frontFailed false).
const HANG = () => new Promise(() => {});
test('parked-front R2: the head\'s second front batch interrupted by a reboot closes without attempt 2, its end reported to the new process\'s stage 10', async t => {
  const FRONT2 = { ...FRONT1, attempt: 2 };
  const e = scripted([m => answer(m, { ...DONE, decision: 'OPEN_FRONT_BATCH', openFrontBatch: FRONT2 }, 1), m => answer(m, DONE, 0)]);
  const f = await executorFixture(t, { policy: policyV8(), engine: e.engine });
  await f.exec.tick(); // opens the front batch (attempt 2 of the head)
  f.advance(MIN);
  let died;
  const reached = new Promise(resolve => { died = resolve; });
  f.companion.buildBundle = () => { died(); return HANG(); };
  f.exec.tick(); // dies in the bundle: the entry is left RESERVED
  await reached;
  f.exec.sleep = HANG;
  const g = withInput({ inputs: [], engine: fakeEngine({ train: m => answer(m, DONE, 0) }) });
  const exec = new ResidentExecutor({ ...f.ports, engine: g.engine, companion: fakeCompanion({}, f.clock), lockFromEarlierBoot: true });
  f.advance(10 * MIN);
  const r = await exec.tick();
  assert.notEqual(r.state, 'HALTED', JSON.stringify(r));
  const terminal = (await ofType(f.receipts, 'batch-terminal')).at(-1);
  assert.deepEqual([terminal?.outcome, terminal?.failureCode], ['FAILED_CLEAN', 'EXECUTOR_RESTARTED_UNPUBLISHED'], JSON.stringify(terminal));
  assert.deepEqual(await ofType(f.receipts, 'attempt2-scheduled'), [], 'its front attempt was 2: no third front batch of the head');
  f.advance(10 * MIN);
  await exec.tick();
  const carried = g.inputs.find(x => x.input.frontPr !== null)?.input ?? null;
  assert.ok(carried, `a stage 10 of the new process carries the end: ${JSON.stringify(g.inputs.map(x => x.input.frontPr))}`);
  assert.deepEqual([carried.frontPr, carried.frontHeadSha, carried.frontTestSha, carried.frontAttempt, carried.frontCode, carried.frontFailed],
    [884, HEAD, S, 2, 'EXECUTOR_RESTARTED_UNPUBLISHED', false], JSON.stringify(carried));
});

// 3c: stage 10 counted a front batch and touched running before enqueueFront refused it; the batch never runs, so its end is owed to
// the next stage 10 (frontFailed false) instead of a TRAIN_FRONT_BATCH_RUNNING until the running clock runs out. Not urgent (§1 item 3d):
// the cadence's run carries it. A refusal for a busy row is kept for frontRetry and not reported.
test('parked-front 3c: a front batch refused as TRAIN_FRONT_ATTEMPTS_USED is reported ended to the next stage 10, frontFailed false', async t => {
  const e = withInput({ inputs: [], engine: fakeEngine({ train: mode => answer(mode, DONE, 0) }) });
  const f = await executorFixture(t, { policy: policyV8(), engine: e.engine });
  await f.exec.tick();
  f.exec.frontBatches.set(`884:${HEAD}`, [{ testSha: S, attempt: 1 }, { testSha: '8'.repeat(40), attempt: 2 }]);
  const third = { ...FRONT1, testSha: '9'.repeat(40), attempt: 2 };
  assert.equal(await f.exec.enqueueFront(third), null);
  assert.equal((await ofType(f.receipts, 'train-front-refused')).at(-1).failureCode, 'TRAIN_FRONT_ATTEMPTS_USED');
  assert.equal(f.exec.trainUrgent, false, 'not urgent');
  f.advance(10 * MIN);
  await f.exec.tick();
  const carried = e.inputs.at(-1).input;
  assert.deepEqual([carried.frontPr, carried.frontHeadSha, carried.frontTestSha, carried.frontAttempt, carried.frontCode, carried.frontFailed],
    [884, HEAD, '9'.repeat(40), 2, 'TRAIN_FRONT_ATTEMPTS_USED', false], JSON.stringify(carried));
});

test('parked-front 3c: a front batch refused because the queue is full (QUEUE_DEPTH_EXCEEDED) is reported ended to the next stage 10, frontFailed false', async t => {
  const e = withInput({ inputs: [], engine: fakeEngine({ train: mode => answer(mode, DONE, 0) }) });
  const f = await executorFixture(t, { policy: policyV8(), engine: e.engine });
  await f.exec.tick();
  f.exec.policy.limits.queueDepth = 1;
  assert.equal(f.queue.offer({ pr: 990, headSha: '2'.repeat(40), baseSha: BASE }, f.clock(), { depth: 1, cooldownMs: 0 }).action, 'new', 'the queue is full now');
  assert.equal(await f.exec.enqueueFront(FRONT1), null);
  assert.equal((await ofType(f.receipts, 'train-front-refused')).at(-1).failureCode, 'QUEUE_DEPTH_EXCEEDED');
  // PR 990's batch may take a tick first; the report is held until a stage 10 carries it (and cleared after): the run that carried it
  let carried = null;
  for (let i = 0; i < 4 && !carried; i++) {
    f.advance(10 * MIN);
    await f.exec.tick();
    carried = e.inputs.map(x => x.input).find(x => x.frontPr !== null) ?? null;
  }
  assert.deepEqual([carried?.frontPr, carried?.frontHeadSha, carried?.frontTestSha, carried?.frontAttempt, carried?.frontCode, carried?.frontFailed],
    [884, HEAD, S, 1, 'QUEUE_DEPTH_EXCEEDED', false], JSON.stringify({ carried, runs: e.inputs.map(x => [x.mode, x.input.frontPr]), outcome: f.exec.trainFrontOutcome ?? null }));
});

// ---- bc982192 parked-front v2 rework (D:/w/tmp/FABLE-parked-front-attempt2-number-20261123.md §4) ----
// A front batch whose attempt 1 fails transiently at stage 2 (BRIDGE_TRANSPORT_TIMEOUT) gets its automatic attempt 2; transient: a list
// of stage-10 answers, the first opening `front`. attempt2Front: the fixture after attempt 1 ended (its attempt 2 scheduled).
async function attempt2Front(t, front, { stage2 = { ok: false, code: 'BRIDGE_TRANSPORT_TIMEOUT', proof } } = {}) {
  const stages = { 2: stage2 };
  let i = 0;
  const list = [m => answer(m, { ...DONE, decision: 'OPEN_FRONT_BATCH', openFrontBatch: front }, 1), m => answer(m, DONE, 0)];
  const e = withInput({ inputs: [], engine: fakeEngine({ stages, train: m => list[Math.min(i++, list.length - 1)](m) }) });
  const f = await executorFixture(t, { policy: policyV8(), engine: e.engine });
  await f.exec.tick(); // opens the front batch
  f.advance(MIN);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, typeof r.attempt2], ['FAILED_CLEAN', 'string'], `a transient stage-2 failure: attempt 2 (${JSON.stringify(r)})`);
  assert.deepEqual(await ofType(f.receipts, 'train-front-ended'), [], 'attempt 1 has an attempt 2: not an end');
  return { e, f, r, stages };
}
const endedOf = async f => (await ofType(f.receipts, 'train-front-ended')).map(b => [b.frontOutcome.pr, b.frontOutcome.testSha, b.frontOutcome.attempt, b.frontOutcome.code, b.frontOutcome.failed]);
const carriedOf = e => e.inputs.map(x => x.input).findLast(x => x.frontPr !== null) ?? null;

// N1 (executor side; the stage-10 side is train-landing-e2e N1): push mode, a batch of two; attempt 1 and its automatic attempt 2 both
// fail transiently at stage 2. That end (no attempt 2 of its own) is reported once, naming S (frontFailed false), and carried to stage 10.
test('parked-front N1: a batch of two whose automatic attempt 2 ended (not failed) is reported naming its S to the next stage 10', async t => {
  const members = [{ pr: 884, headSha: HEAD }, { pr: 885, headSha: '3'.repeat(40) }];
  const { e, f } = await attempt2Front(t, { ...FRONT1, members });
  f.advance(10 * MIN);
  const r2 = await f.exec.tick();
  assert.deepEqual([r2.state, r2.failureCode, r2.attempt2 ?? null], ['FAILED_CLEAN', 'BRIDGE_TRANSPORT_TIMEOUT', null], JSON.stringify(r2));
  assert.deepEqual(await endedOf(f), [[884, S, 2, 'BRIDGE_TRANSPORT_TIMEOUT', false]]);
  f.advance(10 * MIN);
  await f.exec.tick();
  const carried = carriedOf(e);
  assert.deepEqual([carried?.frontPr, carried?.frontTestSha, carried?.frontCode, carried?.frontFailed], [884, S, 'BRIDGE_TRANSPORT_TIMEOUT', false], JSON.stringify(carried));
});

// N2 (修复前必红, executor side; FABLE §1.3): the front alone, the same two failures; stage 10 then opens its own number 2 of the same S,
// which is the automatic attempt 2 that already ran. enqueueFront never returns silently: with nothing here left to run (H, S) it reports
// the batch ended (TRAIN_FRONT_ATTEMPTS_USED, frontFailed false, not urgent), so stage 10 counts it ended instead of running.
test('parked-front N2: stage 10\'s number 2 of an S whose automatic attempt 2 already ran is reported ended, not urgent (enqueueFront never returns silently)', async t => {
  const { e, f } = await attempt2Front(t, FRONT1);
  f.advance(10 * MIN);
  const r2 = await f.exec.tick();
  assert.deepEqual([r2.state, r2.failureCode, r2.attempt2 ?? null], ['FAILED_CLEAN', 'BRIDGE_TRANSPORT_TIMEOUT', null], JSON.stringify(r2));
  f.exec.trainUrgent = false;
  assert.equal(await f.exec.enqueueFront({ ...FRONT1, attempt: 2 }), null, 'the same (S, 2) ran already');
  assert.equal(f.exec.trainUrgent, false, 'not urgent');
  assert.deepEqual(await endedOf(f), [[884, S, 2, 'BRIDGE_TRANSPORT_TIMEOUT', false], [884, S, 2, 'TRAIN_FRONT_ATTEMPTS_USED', false]]);
  f.advance(10 * MIN);
  await f.exec.tick();
  const carried = carriedOf(e);
  assert.deepEqual([carried?.frontTestSha, carried?.frontAttempt, carried?.frontCode, carried?.frontFailed], [S, 2, 'TRAIN_FRONT_ATTEMPTS_USED', false], JSON.stringify(carried));
});

// N3 (修复前必红; review must-fix 1, the same chain): attempt 1 carried an attempt 2, so afterBatch did not report it; the attempt 2 is then
// closed unrun for another installed Source (ATTEMPT2_SOURCE_CHANGED). That is the batch's end: reported, and the next stage 10 told.
test('parked-front N3: a front batch whose attempt 2 is closed unrun (ATTEMPT2_SOURCE_CHANGED) is reported ended to the next stage 10', async t => {
  const { f } = await attempt2Front(t, FRONT1);
  const NEW = 'c'.repeat(64);
  const g = withInput({ inputs: [], engine: fakeEngine({ train: m => answer(m, DONE, 0) }) });
  const h = await executorFixture(t, { root: f.root, policy: policyV8({}, { sourceManifestSha256: NEW }), engine: g.engine, now: f.clock() + 10 * MIN,
    integrity: { ok: true, sourceManifestSha256: NEW, residentManifestSha256: 'b'.repeat(64) } });
  let ignored = [];
  for (let n = 0; n < 4 && ignored.length === 0; n++) { await h.exec.tick(); ignored = await ofType(h.receipts, 'attempt2-ignored'); h.advance(MIN); }
  assert.deepEqual(ignored.map(b => b.failureCode), ['ATTEMPT2_SOURCE_CHANGED']);
  assert.deepEqual(await endedOf(h), [[884, S, 2, 'ATTEMPT2_SOURCE_CHANGED', false]]);
  h.advance(10 * MIN);
  await h.exec.tick();
  const carried = carriedOf(g);
  assert.deepEqual([carried?.frontTestSha, carried?.frontCode, carried?.frontFailed], [S, 'ATTEMPT2_SOURCE_CHANGED', false], JSON.stringify(carried));
});

// N4 (修复前必红): as N3, the attempt 2 refused for good by its precheck (pre.ignore).
test('parked-front N4: a front batch whose attempt 2 the precheck ignores is reported ended to the next stage 10', async t => {
  const { e, f } = await attempt2Front(t, FRONT1);
  const precheck = f.exec.precheck.bind(f.exec);
  f.exec.precheck = async (key, hk, subject, o = {}) => (o.origin === 'attempt2' ? { ignore: 'HEAD_ALREADY_EXECUTED_NO_RETRY' } : precheck(key, hk, subject, o));
  f.advance(10 * MIN);
  const r2 = await f.exec.tick();
  assert.deepEqual([r2.state, r2.reason], ['IGNORED', 'HEAD_ALREADY_EXECUTED_NO_RETRY'], JSON.stringify(r2));
  assert.deepEqual(await endedOf(f), [[884, S, 2, 'HEAD_ALREADY_EXECUTED_NO_RETRY', false]]);
  f.advance(10 * MIN);
  await f.exec.tick();
  const carried = carriedOf(e);
  assert.deepEqual([carried?.frontTestSha, carried?.frontCode, carried?.frontFailed], [S, 'HEAD_ALREADY_EXECUTED_NO_RETRY', false], JSON.stringify(carried));
});

// N5 (修复前必红; FABLE §1.5): the automatic attempt 2's 'train-front-enqueued' receipt could not be written, then the service restarts;
// the attempt 2 runs in the new process and ends (transient again). Its end is still reported: its number is its subject's own.
test('parked-front N5: an automatic attempt 2 whose train-front-enqueued receipt was lost, after a restart, still reports its end', async t => {
  const stages = { 2: { ok: false, code: 'BRIDGE_TRANSPORT_TIMEOUT', proof } };
  let i = 0;
  const list = [m => answer(m, { ...DONE, decision: 'OPEN_FRONT_BATCH', openFrontBatch: FRONT1 }, 1), m => answer(m, DONE, 0)];
  const f = await executorFixture(t, { policy: policyV8(), engine: fakeEngine({ stages, train: m => list[Math.min(i++, list.length - 1)](m) }) });
  const receipt = f.exec.receipt.bind(f.exec);
  f.exec.receipt = async (type, body) => { if (type === 'train-front-enqueued' && body?.auto === true) throw new Error('disk full'); return receipt(type, body); };
  await f.exec.tick();
  f.advance(MIN);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, typeof r.attempt2], ['FAILED_CLEAN', 'string'], JSON.stringify(r));
  assert.deepEqual((await ofType(f.receipts, 'train-front-enqueued')).map(b => b.auto === true), [false], 'the automatic one was not receipted');
  const g = withInput({ inputs: [], engine: fakeEngine({ stages, train: m => answer(m, DONE, 0) }) });
  const h = await executorFixture(t, { root: f.root, policy: policyV8(), engine: g.engine, now: f.clock() + 10 * MIN });
  await h.exec.trainRecover();
  let r2 = null;
  for (let n = 0; n < 4 && r2?.state !== 'FAILED_CLEAN'; n++) { r2 = await h.exec.tick(); h.advance(MIN); }
  assert.deepEqual([r2?.state, r2?.failureCode], ['FAILED_CLEAN', 'BRIDGE_TRANSPORT_TIMEOUT'], JSON.stringify(r2));
  assert.deepEqual(await endedOf(h), [[884, S, 2, 'BRIDGE_TRANSPORT_TIMEOUT', false]]);
});

// N7 (防回归, R3 batch 2 R5): the automatic attempt 2 is scheduled and not run yet when stage 10 opens its number 2 of the same S: the
// executor holds a run of (H, S) (the pending intent), so it reports nothing; when that attempt 2 ends it reports once, naming S.
test('parked-front N7: number 2 of an S whose automatic attempt 2 is still pending is not reported; the attempt 2\'s end is, once', async t => {
  const { f } = await attempt2Front(t, FRONT1);
  assert.equal(await f.exec.enqueueFront({ ...FRONT1, attempt: 2 }), null, 'the attempt 2 already scheduled');
  assert.deepEqual(await endedOf(f), [], 'the pending attempt 2 runs (H, S): no end yet');
  f.advance(10 * MIN);
  const r2 = await f.exec.tick();
  assert.deepEqual([r2.state, r2.failureCode], ['FAILED_CLEAN', 'BRIDGE_TRANSPORT_TIMEOUT'], JSON.stringify(r2));
  for (let n = 0; n < 3; n++) { f.advance(10 * MIN); await f.exec.tick(); }
  assert.deepEqual(await endedOf(f), [[884, S, 2, 'BRIDGE_TRANSPORT_TIMEOUT', false]]);
});
