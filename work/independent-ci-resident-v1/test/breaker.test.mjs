// The circuit breaker (resident quota redesign phase 2, step 1: design v0.5 §4.6; v0.6 §4, §9 phase 2 items 6 and 7).
import test from 'node:test';
import assert from 'node:assert/strict';
import { POSITIONS, breakerGate, breakerOf, breakerRecord, closedBreaker, positionOf } from '../src/breaker.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { rawPolicy } from './helpers.mjs';

const MIN = 60_000;
const policy = validatePolicy(rawPolicy());
const fail = (pos, pr, code = 'BROKER_REQUEST_EXPIRED') => ({ pos, counts: true, neutral: false, completed: false, windowsOnly: false, pr, code });
const neutral = (pos, pr) => ({ pos, counts: false, neutral: true, completed: false, windowsOnly: false, pr, code: 'CLAIM_NOT_CURRENT' });
const done = pr => ({ pos: POSITIONS.END, counts: false, neutral: true, completed: true, windowsOnly: false, pr, code: null });

test('positions follow the order a batch runs; the bundle and the workspace are stage 0 by phase', () => {
  assert.deepEqual([positionOf(0, 'bundle'), positionOf(1), positionOf(9), positionOf(0, 'workspace'), positionOf(2), positionOf(8)], [1, 2, 3, 4, 5, 11]);
  assert.throws(() => positionOf(12), { code: 'BREAKER_STAGE_INVALID' });
});

test('opens on 3 counted failures in a row; neutral endings never count; getting past the failing place breaks the row', () => {
  let now = 0;
  const b = closedBreaker();
  assert.equal(breakerRecord(b, fail(positionOf(2), 1), policy, now += MIN), null);
  assert.equal(breakerRecord(b, neutral(positionOf(1), 2), policy, now += MIN), null, 'a stage-1 refusal says nothing about stage 2');
  assert.equal(breakerRecord(b, fail(positionOf(2), 3), policy, now += 61 * MIN), null);
  assert.equal(b.streak, 2);
  assert.equal(breakerRecord(b, neutral(positionOf(4), 4), policy, now += 61 * MIN), null);
  assert.equal(b.streak, 0, 'a batch that got past stage 2 ends the row');
  for (const pr of [5, 6]) breakerRecord(b, fail(positionOf(2), pr), policy, now += 61 * MIN);
  assert.equal(breakerRecord(b, fail(positionOf(2), 7), policy, now += 61 * MIN), 'opened');
  assert.deepEqual([b.state, b.failingPos, b.nextTrialAt - now, b.exclude], ['open', positionOf(2), 30 * MIN, [5, 6, 7]]);
});

test('opens on 4 counted failures within an hour even when they are not in a row', () => {
  let now = 0;
  const b = closedBreaker();
  breakerRecord(b, fail(positionOf(1), 1), policy, now += MIN);
  breakerRecord(b, fail(positionOf(1), 2), policy, now += MIN);
  breakerRecord(b, done(3), policy, now += MIN);
  breakerRecord(b, fail(positionOf(1), 4), policy, now += MIN);
  assert.equal(b.state, 'closed');
  assert.equal(breakerRecord(b, fail(positionOf(1), 5), policy, now += MIN), 'opened', 'the fourth in the hour');
});

test('open: nothing starts until the trial; trials back off 30, 60, 120, then every 120 minutes and never lock', () => {
  let now = 0;
  const b = closedBreaker();
  for (const pr of [1, 2, 3]) breakerRecord(b, fail(positionOf(2), pr), policy, now += MIN);
  assert.deepEqual(breakerGate(b, now + 29 * MIN), { allow: false, trial: false, exclude: [1, 2, 3], until: now + 30 * MIN });
  const delays = [];
  for (let i = 0; i < 5; i++) {
    now = b.nextTrialAt;
    const g = breakerGate(b, now);
    assert.deepEqual([g.allow, g.trial, b.state], [true, true, 'half-open']);
    assert.equal(breakerRecord(b, fail(positionOf(2), 10 + i), policy, now), 'reopened');
    delays.push((b.nextTrialAt - now) / MIN);
  }
  assert.deepEqual(delays, [60, 120, 120, 120, 120]);
  assert.ok(b.exclude.includes(14), 'a failed trial row is not picked by the next trial');
});

test('closes when a trial completes, gets past the failing place, or ends there neutrally; anything earlier is inconclusive', () => {
  const openAt = (pos, windowsOnly = false) => {
    const b = closedBreaker();
    for (const pr of [1, 2, 3]) breakerRecord(b, { ...fail(pos, pr), windowsOnly }, policy, pr * MIN);
    breakerGate(b, b.nextTrialAt);
    return b;
  };
  const b1 = openAt(positionOf(2));
  assert.equal(breakerRecord(b1, done(9), policy, 1e9), 'closed');
  assert.equal(b1.state, 'closed');
  const b2 = openAt(positionOf(2));
  assert.equal(breakerRecord(b2, neutral(positionOf(1), 9), policy, 1e9), null, 'a refusal at stage 1 says nothing about stage 2');
  assert.equal(b2.state, 'half-open');
  assert.equal(breakerRecord(b2, fail(positionOf(4), 9), policy, 1e9), 'closed', 'got past stage 2, then a new counted failure later');
  assert.deepEqual([b2.state, b2.streak], ['closed', 1]);
  // a stage-1 fault: KooYomi's explicit answer (a neutral refusal at stage 1) is recovery
  const b3 = openAt(positionOf(1));
  assert.equal(breakerRecord(b3, neutral(positionOf(1), 9), policy, 1e9), 'closed');
  // a Windows-only ending never closes a breaker a Linux stage opened (design v0.5 §4.6, m3)
  const b4 = openAt(positionOf(2));
  assert.equal(breakerRecord(b4, { ...neutral(positionOf(8), 9), windowsOnly: true }, policy, 1e9), null);
  const b5 = openAt(positionOf(8), true);
  assert.equal(breakerRecord(b5, { ...neutral(positionOf(8), 9), windowsOnly: true }, policy, 1e9), 'closed');
});

test('a stored breaker that does not validate starts closed', () => {
  assert.equal(breakerOf(null).state, 'closed');
  assert.equal(breakerOf({ state: 'weird' }).state, 'closed');
  assert.throws(() => breakerRecord(closedBreaker(), { pos: 99 }, policy, 0), { code: 'BREAKER_EVENT_INVALID' });
});

test('policy /6: the queue, breaker, parking and train settings are bounded; the phase-1 daily cap per key is gone', () => {
  const p = rawPolicy();
  assert.equal(validatePolicy(p).contract, 'clued.independent-ci.resident-policy/6');
  assert.equal(validatePolicy({ ...p, limits: { ...p.limits, maxBatchesPer24h: 72 } }).limits.maxBatchesPer24h, 72);
  for (const [k, v, code] of [['maxBatchesPer24h', 73, 'POLICY_RATE_INVALID'], ['maxEvaluationsPer24h', 97, 'POLICY_EVALUATION_RATE_INVALID'], ['queueDepth', 101, 'POLICY_QUEUE_DEPTH_INVALID'],
    ['releasesPerHeadPer24h', 7, 'POLICY_RELEASE_CAP_INVALID'], ['waitingRetriesPer24h', 97, 'POLICY_WAITING_BUDGET_INVALID'], ['reevaluationsPerPrHeadPer24h', 13, 'POLICY_REEVALUATION_CAP_INVALID']]) {
    assert.throws(() => validatePolicy({ ...p, limits: { ...p.limits, [k]: v } }), { code }, k);
  }
  assert.throws(() => validatePolicy({ ...p, limits: { ...p.limits, unexecutedMaxPer24h: 3 } }), { code: 'POLICY_LIMIT_KEYS_INVALID' });
  assert.throws(() => validatePolicy({ ...p, breaker: { ...p.breaker, backoffMs: [3_600_000, 1_800_000] } }), { code: 'POLICY_BREAKER_INVALID' });
  assert.throws(() => validatePolicy({ ...p, contract: 'clued.independent-ci.resident-policy/5' }), { code: 'POLICY_CONTRACT_INVALID' });
  // phase 2, step 3c-1: the train runs in shadow at most; 'on' needs step 3c-2
  assert.equal(validatePolicy({ ...p, train: { ...p.train, enabled: 'shadow' } }).train.enabled, 'shadow');
  assert.throws(() => validatePolicy({ ...p, train: { ...p.train, enabled: 'on' } }), { code: 'POLICY_TRAIN_ON_NOT_SUPPORTED' });
  for (const train of [{ ...p.train, enabled: 'maybe' }, { ...p.train, nonFrontRuns: 'preview' }, { ...p.train, maintenanceEveryMs: 1000 }, { ...p.train, maintenanceMaxPerDay: 201 }])
    assert.throws(() => validatePolicy({ ...p, train }), { code: 'POLICY_TRAIN_INVALID' });
  assert.throws(() => validatePolicy({ ...p, train: { ...p.train, depth: 2 } }), { code: 'POLICY_TRAIN_KEYS_INVALID' });
  const { train, ...noTrain } = p;
  assert.throws(() => validatePolicy(noTrain), { code: 'POLICY_KEYS_INVALID' });
  assert.throws(() => validatePolicy({ ...p, stage8: { mode: 'grace15' } }), { code: 'POLICY_STAGE8_MODE_INVALID' });
  assert.throws(() => validatePolicy({ ...p, park: { ...p.park, stage8MaxTries: 0 } }), { code: 'POLICY_PARK_INVALID' });
});

test('review m2/m3: the failing place is the furthest one that opened it; a Windows-only ending never closes a Linux one', () => {
  let now = 0;
  const b = closedBreaker();
  breakerRecord(b, { ...fail(positionOf(2), 1), windowsOnly: false }, policy, now += MIN);
  breakerRecord(b, { ...fail(positionOf(0, 'bundle'), 2), windowsOnly: true }, policy, now += MIN);
  breakerRecord(b, { ...fail(positionOf(0, 'bundle'), 3), windowsOnly: true }, policy, now += MIN);
  assert.deepEqual([b.state, b.failingPos, b.failingWindowsOnly], ['open', positionOf(2), false]);
  breakerGate(b, b.nextTrialAt);
  // a trial that gets past the bundle but fails at stage 2 again does not close it
  assert.equal(breakerRecord(b, { ...fail(positionOf(2), 4), windowsOnly: false }, policy, now += 31 * MIN), 'reopened');
  breakerGate(b, b.nextTrialAt);
  // a fully relayed batch (no Linux) completes: Windows-only, no proof for stage 2
  assert.equal(breakerRecord(b, { ...done(5), windowsOnly: true }, policy, now += 61 * MIN), null);
  assert.equal(b.state, 'half-open');
  assert.equal(breakerRecord(b, { ...done(6), windowsOnly: false }, policy, now += MIN), 'closed');
});
