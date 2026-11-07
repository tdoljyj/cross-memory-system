import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../src/canonical.mjs';
import { POLICY_CONTRACT_V8, TRAIN_DEFAULTS, trainSettings } from '../src/policy.mjs';
import { TRAIN_STRICT_READINESS_CONTRACT, TRAIN_STRICT_FRONT_READINESS_CONTRACT, strictCoverageOf, strictCoverageMatches, strictFrontReadinessOf,
  strictFrontReadinessMatches, sweepOf, trainIdleExtraDue } from '../src/train.mjs';
import { executorFixture, fakeEngine, rawPolicy, HEAD, BASE, SOURCE, CI_SOURCE } from './helpers.mjs';

const MIN = 60_000, DAY = 24 * 60 * MIN, NOW = Date.parse('2026-10-20T12:00:00Z');
const iso = n => new Date(n).toISOString();
const train = { enabled: 'on', nonFrontRuns: true, maintenanceEveryMs: 10 * MIN, maintenanceMaxPerDay: 200, ...TRAIN_DEFAULTS };
const policy = () => rawPolicy({ contract: POLICY_CONTRACT_V8, train });
const front = { pr: 910, headSha: HEAD, baseSha: BASE, testSha: '5'.repeat(40), testTree: '6'.repeat(40),
  claimId: '0a1b2c3d-0000-4000-8000-0000000000aa', since: iso(NOW), attempt: 1 };
const coverage = () => ({ contract: TRAIN_STRICT_READINESS_CONTRACT, state: 'ready', repo: policy().repo, mainSha: BASE,
  sourceManifestSha256: CI_SOURCE, settingsDigest: digest(trainSettings(train)), onSince: iso(NOW), front: { pr: front.pr, headSha: HEAD, claimId: front.claimId, since: front.since },
  proofRef: `strict-proof-${NOW}-0123456789abcdef-0123456789ab-01234567.json`, writtenAt: iso(NOW), expiresAt: iso(NOW + 15 * MIN),
  backgroundAllPending: 'TRAIN_ALL_REQUIRED', reason: null });
const context = () => ({ now: NOW, repo: policy().repo, sourceManifestSha256: CI_SOURCE, settingsDigest: digest(trainSettings(train)), onSince: iso(NOW), front, sweepFreshMs: 15 * MIN });
const frontReadiness = () => ({ ...coverage(), contract: TRAIN_STRICT_FRONT_READINESS_CONTRACT, historyCoverage: false,
  proofRef: `strict-front-proof-${NOW}-0123456789abcdef-0123456789ab-01234567.json` });
const progress = () => ({ contract: 'clued.independent-ci.train-sweep-progress/1', roundId: 'a'.repeat(64), token: 'b'.repeat(64), scope: 'all', required: true, advanced: true, at: iso(NOW) });
const budget = () => ({ contract: 'clued.independent-ci.train-provider-budget/1', state: 'ok', requests: 3, restRequests: 2, graphqlRequests: 1,
  rest: { limit: 5000, remaining: 4000, resetAt: iso(NOW + 60 * MIN) }, graphql: { limit: 5000, remaining: 4000, resetAt: iso(NOW + 60 * MIN) },
  observedAt: iso(NOW), retryAt: null, extraSlicesAllowed: true });

test('strict readiness checks its exact front tenure, Source, settings and bounded fresh clock window', () => {
  assert.ok(strictCoverageMatches(coverage(), context()));
  for (const patch of [{ now: NOW - 1 }, { now: NOW + 15 * MIN }, { repo: 'other/repo' }, { sourceManifestSha256: SOURCE }, { sourceManifestSha256: 'f'.repeat(64) },
    { settingsDigest: 'e'.repeat(64) }, { onSince: iso(NOW - 1) }, { front: { ...front, baseSha: HEAD } }, { front: { ...front, claimId: 'new-claim' } },
    { front: { ...front, since: iso(NOW + 1) } }, { front: { ...front, headSha: BASE } }]) assert.equal(strictCoverageMatches(coverage(), { ...context(), ...patch }), false, JSON.stringify(patch));
  assert.equal(strictCoverageMatches({ ...coverage(), expiresAt: iso(NOW + 16 * MIN) }, context()), false);
  assert.equal(strictCoverageMatches({ ...coverage(), writtenAt: iso(NOW - MIN), expiresAt: iso(NOW + MIN) }, context()), false, 'a proof cannot predate this duty');
  for (const patch of [{ proofRef: '../proof.json' }, { writtenAt: 'yesterday' }, { front: null }, { settingsDigest: 'x' }, { reason: 'bad reason' }])
    assert.equal(strictCoverageOf({ ...coverage(), ...patch }), null);
  const sweep = { kind: 'full-segment', complete: true, revoked: 0, unconfirmed: 0, proofWritten: true,
    fullSweep: { state: 'running', sinceOn: false }, strictCoverage: coverage() };
  assert.equal(sweepOf(sweep).fullSweep.sinceOn, false, 'a limited proof never supplies a full sweep');
  for (const patch of [{ unconfirmed: null }, { unconfirmed: 1 }, { proofWritten: false }, { complete: false }]) assert.equal(sweepOf({ ...sweep, ...patch }), null);
});

test('front-only readiness cannot claim coverage and still binds the exact Source, tenure and fresh clock', () => {
  assert.ok(strictFrontReadinessMatches(frontReadiness(), context()));
  assert.equal(strictCoverageOf(frontReadiness()), null);
  assert.equal(strictFrontReadinessOf(coverage()), null);
  for (const patch of [{ historyCoverage: true }, { proofRef: coverage().proofRef }, { unknown: true }])
    assert.equal(strictFrontReadinessOf({ ...frontReadiness(), ...patch }), null);
  for (const patch of [{ now: NOW - 1 }, { now: NOW + 15 * MIN }, { sourceManifestSha256: SOURCE }, { sourceManifestSha256: 'f'.repeat(64) },
    { settingsDigest: 'e'.repeat(64) }, { onSince: iso(NOW - 1) }, { front: { ...front, claimId: 'new-claim' } },
    { front: { ...front, since: iso(NOW - 1) } }, { front: { ...front, baseSha: HEAD } }])
    assert.equal(strictFrontReadinessMatches(frontReadiness(), { ...context(), ...patch }), false);
  const s = { kind: 'full-segment', complete: false, revoked: 0, unconfirmed: 0, proofWritten: false,
    fullSweep: { state: 'running', sinceOn: false }, strictFrontReadiness: frontReadiness() };
  assert.equal(sweepOf(s).fullSweep.sinceOn, false);
  assert.equal(sweepOf(s).complete, false, 'front-only readiness must not turn incomplete history into complete');
  assert.equal(sweepOf(s).proofWritten, false, 'durable front readiness does not invent a legacy coverage proof');
  for (const patch of [{ unconfirmed: 1 }, { fullSweep: { state: 'running', allPending: 'TRAIN_MAIN_REWRITTEN' } }])
    assert.equal(sweepOf({ ...s, ...patch }), null);
});

test('resident admits only an enqueued S with the same claim; full takeover and other guards stay intact', async t => {
  const f = await executorFixture(t, { policy: policy() });
  f.exec.trainStrictReadiness = coverage();
  f.exec.trainLast = { mode: 'on', decision: 'TRAIN_TAKEOVER_SWEEP_PENDING' };
  assert.equal(f.exec.trainGate(front).reason, 'TRAIN_TAKEOVER_SWEEP_PENDING', 'no guessed binding');
  await f.exec.enqueueFront(front);
  assert.equal(f.exec.trainGate(front), null);
  assert.equal(f.exec.trainTakeoverDone, false);
  // Stage 10 binds its observation to the CI Source (policy ciSourceManifestSha256); the resident's own installed-files manifest
  // (policy sourceManifestSha256) is another Source and admits nothing (generation 21: the executor compared against it).
  f.exec.trainStrictReadiness = { ...coverage(), sourceManifestSha256: SOURCE };
  assert.equal(f.exec.trainGate(front).reason, 'TRAIN_TAKEOVER_SWEEP_PENDING');
  f.exec.trainStrictReadiness = coverage();
  assert.equal(f.exec.trainGate(front), null);
  assert.equal(f.exec.trainGate({ ...front, testSha: '7'.repeat(40) }).reason, 'TRAIN_TAKEOVER_SWEEP_PENDING');
  assert.equal(f.exec.trainGate({ pr: front.pr, headSha: HEAD, baseSha: BASE }).reason, 'TRAIN_TAKEOVER_SWEEP_PENDING');
  f.exec.trainLast.decision = 'TRAIN_SOURCE_UNREADABLE';
  assert.equal(f.exec.trainGate(front).reason, 'TRAIN_SOURCE_UNREADABLE');
  f.exec.trainLast.decision = 'TRAIN_TAKEOVER_SWEEP_PENDING';
  f.exec.trainSweep = { fullAllPending: 'TRAIN_MAIN_REWRITTEN' };
  assert.equal(f.exec.trainGate(front).reason, 'TRAIN_TAKEOVER_SWEEP_PENDING');
  f.exec.trainSweep = null;
  f.exec.trainUrgent = false;
  f.advance(15 * MIN);
  assert.equal(f.exec.trainGate(front).reason, 'TRAIN_TAKEOVER_SWEEP_PENDING');
  assert.equal(f.exec.trainUrgent, true);
  f.exec.trainUrgent = false;
  f.exec.trainGate(front);
  assert.equal(f.exec.trainUrgent, false, 'expired certificate asks for one refresh, never a spin');
});

test('restart recovers exact S bindings and extra charges but does not trust persisted light readiness', async t => {
  const f = await executorFixture(t, { policy: policy() });
  await f.exec.enqueueFront(front);
  f.exec.trainStrictReadiness = coverage();
  await f.exec.trainDutySave();
  const key = `${progress().roundId}:${progress().token}`;
  const intent = await f.exec.receipt('train-run-intent', { mode: 'on', idleProgressExtra: true, progressKey: key });
  await f.exec.receipt('train-run', { intentSeq: intent.seq, ok: false, failureCode: 'TRAIN_STAGE_REFUSED' });
  const next = await executorFixture(t, { policy: policy(), root: f.root });
  await next.exec.trainRecover();
  assert.equal(next.exec.trainRuns.length, 1);
  assert.equal(next.exec.trainExtraRuns.length, 1, 'failed extra still pays');
  assert.equal(next.exec.trainProgressConsumed, key);
  assert.equal(next.exec.frontBindings.get(`${front.pr}:${front.testSha}`).claimId, front.claimId);
  assert.equal(next.exec.trainStrictReadiness, null);
  assert.ok(next.exec.trainGate(front));
  assert.equal(next.exec.trainUrgent, true);
});

test('idle progress extras preserve cap, normal cadence, quota uncertainty and the finite default 56 allowance', () => {
  const args = { train, now: NOW + MIN, runs: [NOW], extraRuns: [], progress: progress(), providerBudget: budget() };
  assert.equal(trainIdleExtraDue(args), true);
  for (const patch of [{ urgent: true }, { frontWork: true }, { busy: true }, { providerBudget: { state: 'unknown', retryAt: null } },
    { providerBudget: { state: 'low', retryAt: null } }, { providerBudget: { state: 'ok', retryAt: iso(NOW - 1) } }, { progress: { ...progress(), advanced: false } },
    { progress: { ...progress(), required: false } }, { consumed: `${progress().roundId}:${progress().token}` }, { now: NOW - 1 },
    { now: NOW + 10 * MIN }, { runs: Array(200).fill(NOW) }, { extraRuns: Array(56).fill(NOW) }, { runs: [NOW + 2 * MIN] }])
    assert.equal(trainIdleExtraDue({ ...args, ...patch }), false, JSON.stringify(patch));
  assert.equal(trainIdleExtraDue({ ...args, extraRuns: Array(55).fill(NOW) }), true);
  assert.equal(trainIdleExtraDue({ ...args, extraRuns: Array(56).fill(NOW - DAY) }), true, 'rolling boundary expires charges');
  assert.equal(trainIdleExtraDue({ ...args, train: { ...train, maintenanceMaxPerDay: 144 } }), false);
  for (const patch of [{ observedAt: iso(NOW - 1) }, { observedAt: iso(NOW + 2 * MIN) }, { extraSlicesAllowed: false }, { requests: 4 },
    { rest: null }, { graphql: { ...budget().graphql, remaining: 2500 } }, { rest: { ...budget().rest, resetAt: iso(NOW + MIN) } }])
    assert.equal(trainIdleExtraDue({ ...args, providerBudget: { ...budget(), ...patch } }), false, JSON.stringify(patch));
});

test('required current coverage can continue within the same finite budget; routine current work cannot', () => {
  const current = { ...progress(), scope: 'current' };
  const args = { train, now: NOW + MIN, runs: [NOW], extraRuns: [], progress: current, providerBudget: budget() };
  assert.equal(trainIdleExtraDue(args), true, 'a takeover with trusted history need not wait another ten minutes');
  for (const patch of [{ required: false }, { advanced: false }, { scope: 'open-only' }])
    assert.equal(trainIdleExtraDue({ ...args, progress: { ...current, ...patch } }), false);
  assert.equal(trainIdleExtraDue({ ...args, extraRuns: Array(56).fill(NOW) }), false);
  assert.equal(trainIdleExtraDue({ ...args, frontWork: true }), false);
  assert.equal(trainIdleExtraDue({ ...args, consumed: `${current.roundId}:${current.token}` }), false);
  const sweep = sweepOf({ kind: 'full-segment', complete: false, fullSweep: { state: 'running', sinceOn: false, scope: 'current' }, progress: current });
  assert.equal(sweep.progress.scope, 'current', 'persisted summaries retain the actual required scope');
  assert.equal(sweepOf({ kind: 'full-segment', complete: false, fullSweep: { state: 'running' }, progress: { ...current, required: false } }).progress, null);
});

test('extra intent is charged before a clean failed invocation and cannot repeat the same progress', async t => {
  const engine = fakeEngine();
  engine.runTrainStage = async () => ({ ok: false, code: 'TRAIN_STAGE_REFUSED', proof: { windowsTreeZero: true, serviceOriginalStopped: true } });
  const f = await executorFixture(t, { policy: policy(), engine });
  f.exec.trainRuns = [NOW];
  f.exec.trainUrgent = false;
  f.exec.trainProgressReady = true;
  f.exec.trainLast = { sweep: { progress: progress(), providerBudget: budget() } };
  f.advance(MIN);
  await f.exec.trainMaintenance();
  const intents = await f.receipts.latest(['train-run-intent'], 10);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].value.body.idleProgressExtra, true);
  assert.equal(f.exec.trainRuns.length, 2);
  assert.equal(f.exec.trainExtraRuns.length, 1);
  await f.exec.trainMaintenance();
  assert.equal((await f.receipts.latest(['train-run-intent'], 10)).length, 1);
});

test('limited coverage filters both first scheduling and parked retries to the bound front S', async t => {
  const f = await executorFixture(t, { policy: policy() });
  await f.exec.enqueueFront(front);
  f.exec.trainStrictReadiness = coverage();
  f.exec.trainLast = { mode: 'on', decision: 'TRAIN_TAKEOVER_SWEEP_PENDING' };
  const foreign = { ...front, pr: 911 };
  f.exec.queue.candidates = () => [foreign, front];
  const ran = [];
  f.exec.runRow = async row => { ran.push(row.pr); return { state: 'TEST_FRONT' }; };
  assert.equal((await f.exec.schedule()).state, 'TEST_FRONT');
  assert.deepEqual(ran, [front.pr]);
  const entry = subject => ({ key: `${subject.pr}`, state: 'STARTED', plan: {}, parked: { at: iso(NOW) }, tries: [], reserved: { subject } });
  f.ledger.parkedEntries = async () => [entry(foreign), entry(front)];
  f.exec.parkedCounts = async () => ({ inside: 0, outside: 0 });
  f.exec.supersededParked = async () => null;
  f.exec.parkedDueAt = () => NOW;
  f.exec.resumeParkedB = async e => ({ state: 'TEST_PARKED_FRONT', pr: e.reserved.subject.pr });
  assert.deepEqual((await f.exec.resumeParked({ hold: true })).acted, { state: 'TEST_PARKED_FRONT', pr: front.pr });
});

test('a real stage-10 readiness answer opens only its front without marking full takeover complete', async t => {
  let ready = coverage();
  const engine = fakeEngine();
  engine.runTrainStage = async () => ({ ok: true, proof: { windowsTreeZero: true, serviceOriginalStopped: true },
    train: { contract: 'clued.independent-ci.train-facts/2', mode: 'on', at: iso(NOW), wouldDo: 'OPEN_FRONT_BATCH', decision: 'OPEN_FRONT_BATCH',
      onDuty: true, front: { pr: front.pr, headSha: HEAD }, mainSha: BASE, rules: { strict: true }, openFrontBatch: front,
      sweep: { kind: 'full-segment', complete: true, revoked: 0, unconfirmed: 0, proofWritten: true,
        fullSweep: { state: 'running', startedAt: iso(NOW), completedAt: null, sinceOn: false, scope: 'all', allPending: 'TRAIN_ALL_REQUIRED' },
        strictCoverage: ready, progress: progress(), providerBudget: budget() } } });
  const f = await executorFixture(t, { policy: policy(), engine });
  await f.exec.trainRecover();
  await f.exec.trainMaintenance();
  assert.equal(f.exec.trainTakeoverDone, false);
  assert.equal(f.exec.trainSweep.fullSinceOn, false);
  assert.equal(f.exec.trainGate(front), null);
  assert.deepEqual([f.exec.trainStatus().frontReadyMode, f.exec.trainStatus().fullPending, f.exec.trainStatus().backgroundAllPending], ['strict-coverage', true, true]);
  ready = { ...coverage(), front: { ...coverage().front, since: iso(NOW - 1) } };
  f.exec.trainUrgent = true;
  await f.exec.trainMaintenance();
  assert.ok(f.exec.trainGate(front), 'a fresh observation for another tenure invalidates the previous one');
});

test('a durable front-only observation schedules only its bound S while history stays incomplete, and is refreshed after restart', async t => {
  let ready = frontReadiness();
  const engine = fakeEngine();
  engine.runTrainStage = async () => ({ ok: true, proof: { windowsTreeZero: true, serviceOriginalStopped: true },
    train: { contract: 'clued.independent-ci.train-facts/2', mode: 'on', at: iso(NOW), wouldDo: 'OPEN_FRONT_BATCH', decision: 'OPEN_FRONT_BATCH',
      onDuty: true, front: { pr: front.pr, headSha: HEAD }, mainSha: BASE, rules: { strict: true }, openFrontBatch: front,
      sweep: { kind: 'full-segment', complete: false, revoked: 0, unconfirmed: 0, proofWritten: false,
        fullSweep: { state: 'running', startedAt: iso(NOW), completedAt: null, sinceOn: false, scope: 'all', allPending: 'TRAIN_NO_MAIN_RECORD' },
        strictFrontReadiness: ready } } });
  const f = await executorFixture(t, { policy: policy(), engine });
  await f.exec.trainRecover();
  await f.exec.trainMaintenance();
  assert.equal(f.exec.trainGate(front), null);
  assert.ok(f.exec.trainGate({ ...front, testSha: '7'.repeat(40) }));
  assert.ok(f.exec.trainGate({ pr: front.pr, headSha: HEAD, baseSha: BASE }));
  assert.equal(f.exec.trainTakeoverDone, false);
  assert.equal(f.exec.trainSweep.fullSinceOn, false);
  assert.equal(f.exec.trainLast.sweep.complete, false);
  assert.equal(f.exec.trainLast.sweep.proofWritten, false);
  assert.equal(f.exec.trainStatus().frontReadyMode, 'strict-current-front');
  const next = await executorFixture(t, { policy: policy(), root: f.root });
  await next.exec.trainRecover();
  assert.equal(next.exec.frontBindings.get(`${front.pr}:${front.testSha}`).claimId, front.claimId);
  assert.equal(next.exec.trainStrictFrontReadiness, null);
  assert.ok(next.exec.trainGate(front), 'restart cannot inherit front authority from a saved hint');
  ready = { ...frontReadiness(), settingsDigest: 'e'.repeat(64) };
  f.exec.trainUrgent = true;
  await f.exec.trainMaintenance();
  assert.ok(f.exec.trainGate(front), 'Source and settings are rechecked even on the same front');
});
