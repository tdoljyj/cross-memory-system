// FABLE-ci-10min-20261119 §3.2 P1 (T1): the resident schedule does not wait idle.
// P1a: a bound front whose stage-10 run answered TRAIN_SWEEP_INCOMPLETE / FRONT_RETURNED is looked at again TRAIN_RECHECK_MS later,
// at most TRAIN_FRONT_RECHECK_MAX times per head. P1b: a due stage-10 run goes before a new ordinary batch while a front is bound.
import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICY_CONTRACT_V8, TRAIN_DEFAULTS } from '../src/policy.mjs';
import * as train from '../src/train.mjs';
import { executorFixture, fakeEngine, rawPolicy, triggerBytes, BASE } from './helpers.mjs';
import { NO_SWEEP, trainFacts } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-facts.mjs';

const MIN = 60_000;
// The design's bound (FABLE-ci-10min §3.2 P1a): six fast looks per front head. Read through the namespace so a missing export fails an assertion.
const TRAIN_FRONT_RECHECK_MAX = 6;
// The field scene (production receipts 10294-10310, 2026-11-19 09:14-09:35 Beijing): PR #1172 head 3cb1787d bound at the queue's head,
// main 874eb81b, train.sweep audit; stage 10 answered TRAIN_SWEEP_INCOMPLETE with wouldDo OPEN_FRONT_BATCH three times, 10 minutes apart.
const T_FIELD = Date.parse('2026-11-19T01:14:29.780Z');
const H1172 = '3cb1787dea58392508f6939b55b117d443c6338c', CLAIM1172 = '75ab3159-3c10-4081-9059-1dd6403ec3df';
const policy = (train = {}) => rawPolicy({ contract: POLICY_CONTRACT_V8, train: { enabled: 'on', nonFrontRuns: true, maintenanceEveryMs: 10 * MIN,
  maintenanceMaxPerDay: 200, ...TRAIN_DEFAULTS, sweep: 'audit', ...train } });
const proof = { windowsTreeZero: true, serviceOriginalStopped: true };
const holderOf = (pr, at) => ({ claimId: CLAIM1172, pr, mergeSlotUntil: new Date(at + 60 * MIN).toISOString(), takenAt: new Date(at - 8 * MIN).toISOString(), ciState: 'running' });
const frontOf = headSha => ({ headSha, state: 'open', draft: false, baseRef: 'main', mergeable: true, headContainsMain: true, green: false,
  testMerge: { sha: '8'.repeat(40), tree: '9'.repeat(40), parentsOk: true } });
const answer = (mode, at, { decision, pr = 1172, headSha = H1172, sideEffects = 1 } = {}) => ({ ok: true, runId: `${'7'.repeat(16)}-${'0'.repeat(12)}`, proof,
  outcome: { status: 'TRAIN_FACTS', reason: null, sideEffects, mayHavePublished: sideEffects > 0, diagnostic: null, scheduling: null, safeToRerun: false },
  train: trainFacts({ mode, at: new Date(at).toISOString(), onDuty: true, holders: pr ? [holderOf(pr, at)] : [], mainSha: BASE, rules: { strict: true, mergeOnly: true },
    front: pr ? frontOf(headSha) : null, revoke: [], ledger: null, sweep: NO_SWEEP, decision: mode === 'on' ? decision : null }) });

async function scene(t, { decision = 'TRAIN_SWEEP_INCOMPLETE', pr = 1172 } = {}) {
  let f;
  const runs = [];
  const engine = fakeEngine({ train: mode => { runs.push(f.clock()); return answer(mode, f.clock(), { decision: pr ? decision : null, pr }); } });
  f = await executorFixture(t, { policy: policy(), engine, now: T_FIELD });
  return { ...f, runs };
}
// Ticks once a minute until a new stage-10 run starts (or `limit` minutes pass); returns the minutes it took.
async function minutesToNextRun(f, limit = 11) {
  const before = f.runs.length;
  for (let m = 1; m <= limit; m++) {
    f.advance(MIN);
    await f.exec.tick();
    if (f.runs.length > before) return m;
  }
  return null;
}

test('P1a replay of 09:15-09:35: a bound front answered TRAIN_SWEEP_INCOMPLETE is looked at again within 2 minutes; the 7th answer goes back to 10', async t => {
  const f = await scene(t);
  await f.exec.tick();
  assert.equal(f.runs.length, 1, 'the first run of the duty');
  assert.deepEqual([f.exec.trainLast.decision, f.exec.trainLast.wouldDo, f.exec.trainLast.front?.pr, f.exec.trainLast.front?.headSha],
    ['TRAIN_SWEEP_INCOMPLETE', 'OPEN_FRONT_BATCH', 1172, H1172], 'the field answer of receipt 10296');
  const gaps = [];
  for (let i = 0; i < TRAIN_FRONT_RECHECK_MAX; i++) gaps.push(await minutesToNextRun(f));
  assert.deepEqual(gaps, Array(TRAIN_FRONT_RECHECK_MAX).fill(2), 'answers 1-6: the next run 2 minutes later (before the fix: 10)');
  assert.equal(f.runs.length, TRAIN_FRONT_RECHECK_MAX + 1);
  assert.equal(await minutesToNextRun(f), 10, 'after the 7th answer for the same head: the normal 10-minute cadence');
  assert.equal(await minutesToNextRun(f), 10, 'and it stays there for this head');
});

test('P1a: FRONT_RETURNED is looked at again too; a new front head starts its own streak; other decisions keep 10 minutes', async t => {
  const f = await scene(t, { decision: 'FRONT_RETURNED' });
  await f.exec.tick();
  assert.equal(await minutesToNextRun(f), 2);
  const g = await scene(t, { decision: 'TRAIN_FRONT_NOT_PROVEN' });
  await g.exec.tick();
  assert.equal(await minutesToNextRun(g), 10, 'not a fast-look decision');
  // pure: the cap is per head; a run with another decision ends the fast look but never refills the head's count
  assert.equal(train.TRAIN_FRONT_RECHECK_MAX, TRAIN_FRONT_RECHECK_MAX);
  assert.deepEqual(train.TRAIN_FRONT_RECHECK_DECISIONS, ['TRAIN_SWEEP_INCOMPLETE', 'FRONT_RETURNED']);
  const { trainFrontRecheckNext } = train;
  const s = { mode: 'on', decision: 'TRAIN_SWEEP_INCOMPLETE', front: { pr: 1172, headSha: H1172 } };
  let st = null;
  for (let i = 0; i < 3; i++) st = trainFrontRecheckNext(st, s);
  assert.deepEqual({ ...st }, { key: `1172:${H1172}`, count: 3, due: true });
  st = trainFrontRecheckNext(st, { ...s, decision: 'TRAIN_FRONT_NOT_PROVEN' });
  assert.equal(st.due, false);
  st = trainFrontRecheckNext(st, null);
  assert.equal(st.due, false, 'a run without a clean on-mode summary never keeps a fast look');
  for (let i = 0; i < 3; i++) st = trainFrontRecheckNext(st, s);
  assert.deepEqual([st.count, st.due], [6, true]);
  assert.deepEqual([trainFrontRecheckNext(st, s).count, trainFrontRecheckNext(st, s).due], [7, false]);
  assert.deepEqual({ ...trainFrontRecheckNext(st, { ...s, front: { pr: 1172, headSha: 'a'.repeat(40) } }) }, { key: `1172:${'a'.repeat(40)}`, count: 1, due: true });
  for (const unbound of [{ ...s, front: null }, { ...s, front: { pr: null, headSha: null } }, { ...s, mode: 'revoke-only' }])
    assert.equal(trainFrontRecheckNext(null, unbound), null, JSON.stringify(unbound));
});

test('P1a: the fast look pays the unchanged daily cap', async t => {
  let f;
  const runs = [];
  const engine = fakeEngine({ train: mode => { runs.push(f.clock()); return answer(mode, f.clock(), { decision: 'TRAIN_SWEEP_INCOMPLETE' }); } });
  f = await executorFixture(t, { policy: policy({ maintenanceMaxPerDay: 3 }), engine, now: T_FIELD });
  for (let m = 0; m < 30; m++) { await f.exec.tick(); f.advance(MIN); }
  assert.equal(runs.length, 3);
});

test('P1b end to end: stage 10 due, a front bound, another PR\'s trigger in the same tick: train-run-intent comes before batch-reserved', async t => {
  // 06:39 of the field (#1171 bound at the queue's head, TRAIN_SINGLE_GREEN_NOT_PROVEN): a bound front, and a new trigger of another PR
  // (#1169) arrives in the tick stage 10 falls due.
  const f = await scene(t, { decision: 'TRAIN_FRONT_NOT_PROVEN' });
  await f.exec.tick();
  assert.equal(f.runs.length, 1);
  f.advance(10 * MIN);
  await f.drop(triggerBytes({ pr: 1169, headSha: 'c'.repeat(40) }));
  await f.exec.tick();
  const seqOf = async type => (await f.receipts.latest([type], 1000)).map(e => e.value.seq ?? e.seq);
  const intents = await seqOf('train-run-intent'), reserved = await seqOf('batch-reserved');
  assert.equal(intents.length, 2, 'the due stage-10 run ran in this tick');
  assert.equal(reserved.length, 1, 'and the ordinary batch of #1169 still ran in it');
  assert.ok(Math.max(...intents) < reserved[0], `train-run-intent ${Math.max(...intents)} before batch-reserved ${reserved[0]} (before the fix: after)`);
});

test('P1b: with no front bound and nothing parked first, the order is the old one (the batch, stage 10 only when quiet)', async t => {
  const f = await scene(t, { pr: null });
  await f.exec.tick();
  assert.equal(f.exec.trainLast.wouldDo, 'NO_FRONT');
  f.advance(10 * MIN);
  await f.drop(triggerBytes({ pr: 1169, headSha: 'c'.repeat(40) }));
  await f.exec.tick();
  assert.equal((await f.receipts.latest(['batch-reserved'], 1000)).length, 1);
  assert.equal((await f.receipts.latest(['train-run-intent'], 1000)).length, 1, 'no stage-10 run was put ahead of the batch');
});
