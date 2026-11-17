import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, batchKey } from '../src/ledger.mjs';
import { POLICY_CONTRACT_V8, TRAIN_DEFAULTS } from '../src/policy.mjs';
import { StatusBoard, parseStatus } from '../src/status.mjs';
import { describe } from '../src/pr-status.mjs';
import { executorFixture, fakeEngine, rawPolicy, HEAD, BASE, SOURCE, WINDOWS_CLEAN } from './helpers.mjs';
import { trainFacts, NO_SWEEP } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-facts.mjs';

const MIN = 60_000, DAY = 24 * 60 * MIN;
const policy = enabled => rawPolicy({ contract: POLICY_CONTRACT_V8, train: { enabled, nonFrontRuns: true,
  maintenanceEveryMs: 10 * MIN, maintenanceMaxPerDay: 200, ...TRAIN_DEFAULTS, sweep: 'gate' } });
const facts = (mode, now) => ({ ok: true, proof: WINDOWS_CLEAN, runId: `${'7'.repeat(16)}-${'0'.repeat(12)}`,
  train: trainFacts({ mode, at: new Date(now).toISOString(), onDuty: true, holders: [], mainSha: BASE, rules: null,
    front: null, revoke: [], ledger: null, sweep: NO_SWEEP, decision: 'TRAIN_FRONT_NOT_PROVEN', wouldDo: 'NO_FRONT' }) });

async function parked(t, { enabled = 'on', position = 1, testSha, code = 'TRAIN_SINGLE_GREEN_NOT_PROVEN' } = {}) {
  const engine = fakeEngine({ stages: { 8: { ok: false, code, proof: WINDOWS_CLEAN,
    outcome: { status: 'BLOCKED', sideEffects: 0, mayHavePublished: false,
      scheduling: { mergeQueue: { entered: true, position } } } } } });
  const f = await executorFixture(t, { policy: policy(enabled), engine });
  engine.runTrainStage = async mode => { engine.calls.push(['train', mode]); return facts(mode, f.clock()); };
  await f.exec.trainRecover();
  f.exec.trainTakeoverDone = true;
  f.exec.trainUrgent = false;
  const subject = { repo: f.exec.policy.repo, pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1,
    ...(testSha ? { testSha } : {}) }, key = batchKey(subject), batch = { key, batchId: 'fixture-batch' };
  await f.ledger.reserve(key, subject);
  await f.ledger.markStarted(key, {});
  await f.ledger.beginWait(key, { t0: f.clock(), batch });
  await f.ledger.writePlanIntent(key, {});
  await f.ledger.writePlan(key, { relayed: [], local: [] });
  await f.ledger.park(key, { batch, closed: {}, local: [] });
  await f.exec.stage8Try(key, subject, batch);
  return { ...f, subject, key };
}

for (const [options, owes] of [[{}, true], [{ enabled: 'shadow' }, false], [{ enabled: 'off' }, false],
  [{ testSha: '5'.repeat(40) }, false], [{ position: 2 }, false], [{ position: null }, false],
  [{ code: 'REQUIRED_CHECKS_UNREADABLE' }, false]]) {
  test(`stage 8 records front-open debt only for an ordinary on-mode queue head: ${JSON.stringify(options)}`, async t => {
    const f = await parked(t, options), s = await f.ledger.state(f.key);
    assert.equal(Ledger.frontOpenOwed(s), owes);
    assert.equal(s.tries[0].ended.frontOpenOwed === true, owes);
    assert.equal(f.exec.trainFrontOwed.has(f.key), owes);
    assert.equal(f.exec.trainUrgent, owes);
  });
}

test('front-open debt pays the same daily cap and survives a cap refusal until a real decision', async t => {
  const f = await parked(t);
  f.exec.trainRuns = Array(200).fill(f.clock() - DAY + 1000);
  await f.exec.trainMaintenance();
  assert.equal(f.engine.calls.filter(c => c[0] === 'train').length, 0);
  assert.equal(Ledger.frontOpenOwed(await f.ledger.state(f.key)), true);
  f.advance(1001);
  await f.exec.trainMaintenance();
  assert.equal(f.engine.calls.filter(c => c[0] === 'train').length, 1);
  assert.equal(Ledger.frontOpenOwed(await f.ledger.state(f.key)), false);
  assert.equal((await f.ledger.state(f.key)).frontOpenChecked.decision, 'TRAIN_FRONT_NOT_PROVEN');
  // The ordinary retry can still park, but cannot mint another priority request for this batch.
  await f.exec.stage8Try(f.key, f.subject, { key: f.key, batchId: 'fixture-batch' });
  assert.equal(Ledger.frontOpenOwed(await f.ledger.state(f.key)), false);
  assert.equal(f.exec.trainUrgent, false);
});

test('revoke-only and unconfirmed on-mode facts do not settle a front-open debt', async t => {
  const f = await parked(t);
  await f.exec.trainMaintenance({ paused: true });
  assert.deepEqual(f.engine.calls.filter(c => c[0] === 'train'), [['train', 'revoke-only']]);
  assert.equal(Ledger.frontOpenOwed(await f.ledger.state(f.key)), true);
  f.exec.trainUrgent = true;
  f.engine.runTrainStage = async () => ({ ok: true, proof: WINDOWS_CLEAN, train: {} });
  await f.exec.trainMaintenance();
  assert.equal(Ledger.frontOpenOwed(await f.ledger.state(f.key)), true);
});

test('PR status round-trips front-open debt and says next tick priority only while owed', () => {
  const now = Date.parse('2026-11-17T06:08:00Z'), board = new StatusBoard({ clock: () => now });
  board.update({ backfill: { complete: true, published: 0, unreadable: 0 } });
  const row = { pr: 884, headSha: HEAD, baseSha: BASE, state: 'PARKED', deferred: 'TRAIN_SINGLE_GREEN_NOT_PROVEN', queuePosition: 1,
    nextAt: new Date(now + MIN).toISOString() };
  for (const owed of [true, false]) {
    board.setPending([{ ...row, frontOpenOwed: owed }]);
    const status = parseStatus(Buffer.from(JSON.stringify(board.snapshot())));
    assert.equal(status.pending[0].frontOpenOwed, owed);
    const description = describe({ pull: { pr: 884, headSha: HEAD, eligible: true }, status, now }).description;
    assert.match(description, /等开车头批次（第 10 段）/);
    assert.equal(description.includes('下一拍优先'), owed);
    assert.equal(description.includes('证明只有车头一个绿'), false);
  }
});
