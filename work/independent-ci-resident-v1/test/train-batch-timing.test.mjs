// Task bc982192 (FABLE-keep-train-replan-20261122 §3.4): stage 10 comes when the event comes, the cadence is unchanged.
// Moment (a), a batch landed or failed: already asks today (push landing: stage8Try's trainUrgent; touch failed: noteFrontOutcome), and
// the front it named keeps that ask ahead of the batch work (trainFrontWaits). Moment (b), the train idle and a PR just got its admission
// (its ordinary batch passed stage 1): trainAskAfterBind asked, but with no bound front nothing put stage 10 ahead of the batch work, so a
// second PR's ordinary batch in the next tick ran first and the grouping waited for it (in the field 13-15 minutes, more than the cadence).
// The daily cap holds as before, and a batch that is running is never cut into.
import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICY_CONTRACT_V8, TRAIN_DEFAULTS } from '../src/policy.mjs';
import { executorFixture, fakeEngine, rawPolicy, triggerBytes, BASE } from './helpers.mjs';
import { NO_SWEEP, trainFacts } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-facts.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-11-22T02:00:00.000Z');
const A = { pr: 1230, headSha: 'a'.repeat(40) }, B = { pr: 1231, headSha: 'c'.repeat(40) };
const STAGE_MS = 2 * MIN; // every formal stage of an ordinary batch takes this long here (the field: 13-15 minutes a batch)
const policy = (train = {}) => rawPolicy({ contract: POLICY_CONTRACT_V8, train: { enabled: 'on', nonFrontRuns: true, maintenanceEveryMs: 10 * MIN,
  maintenanceMaxPerDay: 200, ...TRAIN_DEFAULTS, sweep: 'audit', landing: 'push', ...train } });
const proof = { windowsTreeZero: true, serviceOriginalStopped: true };
// Stage 10 on an empty queue: the train is idle (NO_FRONT), strict on.
const idle = (mode, at) => ({ ok: true, runId: `${'7'.repeat(16)}-${'0'.repeat(12)}`, proof,
  outcome: { status: 'TRAIN_FACTS', reason: null, sideEffects: 0, mayHavePublished: false, diagnostic: null, scheduling: null, safeToRerun: false },
  train: trainFacts({ mode, at: new Date(at).toISOString(), onDuty: true, holders: [], mainSha: BASE, rules: { strict: true, mergeOnly: true },
    front: null, revoke: [], ledger: null, sweep: NO_SWEEP }) });
// Stage 1 of a head whose claim Native found first in the merge queue (its ordinary batch gives way, DESIGN §62.6).
const firstInQueue = { ok: true, factsSha256: 'd'.repeat(64), proof,
  outcome: { status: 'SETTLED', reason: null, sideEffects: 1, mayHavePublished: true, diagnostic: null,
    scheduling: { ciRetryAfter: null, mergeQueue: { entered: true, state: 'head', position: 1 }, claimExpiresAt: null }, safeToRerun: false } };

// yields: whether A's stage 1 finds A's claim first in the merge queue. Stage 10 is recorded at the time it starts.
async function scene(t, { yields = true, train = {} } = {}) {
  let f;
  const runs = [], stage1 = new Map(), prOf = new Map(), ends = new Map();
  const engine = fakeEngine({ train: mode => { runs.push(f.clock()); return idle(mode, f.clock()); } });
  const derive = engine.derive, runStage = engine.runStage;
  engine.derive = async (subject, key, chain) => { const b = await derive(subject, key, chain); prOf.set(b.batchId, subject.pr); return b; };
  engine.runStage = async (batch, stage, o) => {
    const pr = prOf.get(batch?.batchId);
    f.advance(STAGE_MS);
    ends.set(pr, f.clock());
    if (stage.number === 1) {
      if (!stage1.has(pr)) stage1.set(pr, f.clock());
      if (pr === A.pr && yields) return firstInQueue;
    }
    return runStage(batch, stage, o);
  };
  f = await executorFixture(t, { policy: policy(train), engine, now: T0 });
  await f.exec.tick(); // the duty's first stage 10: NO_FRONT, the cadence starts here
  assert.equal(runs.length, 1);
  assert.equal(f.exec.trainLast.wouldDo, 'NO_FRONT');
  assert.equal(f.exec.trainFrontWaits(), false, 'the train is idle: no bound front');
  f.advance(3 * MIN);
  return { ...f, runs, stage1, ends };
}
const count = async (f, type) => (await f.receipts.latest([type], 1000)).length;

test('§3.4 (b) must-red: the train idle, A gets its admission, B triggers next: stage 10 comes at once, not after B\'s batch', async t => {
  const f = await scene(t);
  await f.drop(triggerBytes(A));
  await f.exec.tick(); // A's ordinary batch: stage 1 admits it (claim first in the queue), then it gives way
  assert.ok(f.stage1.has(A.pr), 'A ran stage 1');
  const admitted = f.stage1.get(A.pr), before = f.runs.length;
  assert.ok(admitted - f.runs[0] < 10 * MIN, 'well inside the cadence: a routine run is not due');
  f.advance(15_000);
  await f.drop(triggerBytes(B));
  for (let i = 0; i < 120 && f.runs.length === before; i++) { await f.exec.tick(); if (f.runs.length === before) f.advance(15_000); }
  assert.ok(f.runs.length > before, 'stage 10 ran');
  const waited = f.runs[before] - admitted;
  assert.ok(waited < MIN, `stage 10 came ${Math.round(waited / 1000)} s after A's admission (before the fix: after B's whole batch)`);
  assert.ok(f.stage1.has(B.pr), 'B\'s ordinary batch still ran in that tick');
  assert.ok(f.runs[before] < f.stage1.get(B.pr), 'stage 10 went before B\'s batch');
});

test('§3.4 (b) regression: with the daily cap used up the admission never runs stage 10; B\'s batch runs', async t => {
  const f = await scene(t);
  f.exec.trainRuns = Array(200).fill(f.clock() - MIN);
  await f.drop(triggerBytes(A));
  await f.exec.tick();
  assert.ok(f.stage1.has(A.pr));
  const before = f.runs.length, intents = await count(f, 'train-run-intent');
  f.advance(15_000);
  await f.drop(triggerBytes(B));
  await f.exec.tick();
  assert.equal(f.runs.length, before, 'no stage 10 over the cap');
  assert.equal(await count(f, 'train-run-intent'), intents);
  assert.ok(f.stage1.has(B.pr), 'B\'s batch ran');
  // Once the window frees up, the ask is honoured: the next tick runs stage 10 at once.
  f.exec.trainRuns = [];
  f.advance(15_000);
  await f.exec.tick();
  assert.equal(f.runs.length, before + 1, 'stage 10 once the cap allows it');
  assert.ok(f.clock() - f.stage1.get(A.pr) < 10 * MIN + 30 * MIN);
});

test('§3.4 (b) regression: a running batch is never cut into: no stage 10 inside A\'s batch, nor beside the between-batches step', async t => {
  // A not first in the queue: its ordinary batch runs on past stage 1 (the admission asked stage 10); stage 10 starts only after its end.
  const f = await scene(t, { yields: false });
  await f.drop(triggerBytes(A));
  const before = f.runs.length;
  for (let i = 0; i < 120 && f.runs.length === before; i++) { await f.exec.tick(); if (f.runs.length === before) f.advance(15_000); }
  assert.ok(f.stage1.has(A.pr) && f.runs.length > before);
  assert.ok(f.runs[before] >= f.ends.get(A.pr), `stage 10 at ${f.runs[before]}, A's batch ended at ${f.ends.get(A.pr)}`);
  // A yields; the between-batches step then runs beside the loop: that tick runs no stage 10, the next ordinary tick does.
  const g = await scene(t);
  await g.drop(triggerBytes(A));
  await g.exec.tick();
  const n = g.runs.length;
  g.advance(15_000);
  await g.exec.tick({ betweenBatchesRunning: true });
  assert.equal(g.runs.length, n, 'nothing beside the between-batches step');
  g.advance(15_000);
  await g.exec.tick();
  assert.equal(g.runs.length, n + 1, 'the next tick runs it');
});

