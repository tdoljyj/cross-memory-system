// The merge train on the resident side, shadow mode (quota redesign phase 2, step 3c-1; DESIGN §22.3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { trainDue, trainPageLine, trainSummary, WOULD_DO } from '../src/train.mjs';
import { executorFixture, fakeEngine, rawPolicy } from './helpers.mjs';
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
  assert.equal(trainPageLine(trainSummary({ ...facts, wouldDo: 'NOT_ON_DUTY', front: null }), 910), null);
  for (const bad of [null, { ...facts, contract: 'x' }, { ...facts, mode: 'on' }, { ...facts, wouldDo: 'REVOKE' }]) assert.equal(trainSummary(bad), null);
});

// ---- the executor's stage 10 (DESIGN §22.3) ----
const shadowPolicy = (train = {}) => rawPolicy({ train: { enabled: 'shadow', nonFrontRuns: true, maintenanceEveryMs: 10 * MIN, maintenanceMaxPerDay: 200, ...train } });
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
