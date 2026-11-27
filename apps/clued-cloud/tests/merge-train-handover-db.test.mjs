import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanionHeartbeat, parseHeartbeatReply } from '../../../work/independent-ci-resident-v1/src/companion-heartbeat.mjs';
import { TRAIN_CONTROL_TIMING, TRAIN_FAILURE } from '../../../work/actions-hosted-migration/independent-ci-v1/src/merge-train-v2-contract.mjs';
import { batchOf, drill, landReadyBatch, probe } from './merge-train-rollout-db.test.mjs';

test('片 7：心跳持续而执行器冻结，分别记录换代获权及同一 S 落地时间', async t => {
  const d = await drill(t);
  const a = await d.addNode('frozen-a');
  const b = await d.addNode('ready-b');
  const subject = d.head();
  await d.authorize(subject);
  await d.enableV2();
  for (const node of [a, b]) assert.equal((await probe(d, node)).on_duty, true);
  const staged = await d.joinAndStage(a, subject);
  const original = await d.command(a, 'batch_acquire', { batchId: staged.batchId });
  assert.equal(original.state, 'waiting_checks');
  assert.equal(original.generation, staged.generation + 1);
  const companion = new CompanionHeartbeat({ nodeName: 'frozen-a', scope: d.scope, clock: d.clock.now,
    readToken: async () => a.token, serviceRunning: async () => true,
    readStatus: async () => ({ writtenAt: d.clock.now(), versions: { windows: { ciSourceManifestSha256: d.source } } }),
    transport: async ({ payload }) => parseHeartbeatReply(await d.legacy(a, payload)) });
  const liveness = () => d.one(d.db.admin, `select heartbeat_sequence,reported_state,reported_service_running
    from clued_private.ci_node_liveness_v1 where node_id=$1`, [a.id]);
  assert.equal((await companion.step()).sent, true);
  const before = await liveness();
  const faultAt = d.clock.now();
  let acquiredAt, acquired;
  // S 已绿、B 有空位、无 CI 剩余时间或限流。按 15 秒复查，相位接近最坏点。
  // 隔离库时钟保持真实，只把原代次的截止向前移同量，保留数据库发出的租约长度和续期判定。
  for (let delta = 12_000; d.clock.now() - faultAt + delta <= 105_000; delta = TRAIN_CONTROL_TIMING.recheckMs) {
    d.clock.advance(delta);
    await d.db.admin.query(`update clued_private.ci_train_batches_v2
      set expires_at=expires_at-$2*interval '1 millisecond' where batch_id=$1 and generation=$3`,
    [staged.batchId, delta, original.generation]);
    await companion.step();
    const pending = await d.command(b, 'work_pending');
    assert.equal(pending.status, 'ok', JSON.stringify(pending));
    if (!pending.work.some(item => item.batchId === staged.batchId && item.action === 'batch_acquire')) continue;
    acquired = await d.command(b, 'batch_acquire', { batchId: staged.batchId });
    assert.equal(acquired.generation, original.generation + 1);
    assert.equal(acquired.testSha, staged.testSha);
    acquiredAt = d.clock.now();
    break;
  }
  const after = await liveness();
  assert.ok(Number(after.heartbeat_sequence) > Number(before.heartbeat_sequence));
  assert.deepEqual([after.reported_state, after.reported_service_running], ['NORMAL', true]);
  assert.ok(acquiredAt !== undefined, '心跳不得续工作租约，故障至新节点获权最多 105 秒');
  assert.equal((await d.command(a, 'batch_release', batchOf(original))).error_code, TRAIN_FAILURE.LEASE_STALE.native);
  const apiMs = 15_000;
  await landReadyBatch(d, b, acquired, staged, { apiMs, loseReply: true });
  const [landed] = d.github.effects().filter(effect => effect.kind === 'mainUpdates');
  const ownMs = acquiredAt - faultAt;
  const mainMs = landed.at - faultAt;
  t.diagnostic(JSON.stringify({ 故障至新节点获权毫秒: ownMs, 故障至主分支前进毫秒: mainMs,
    CI剩余毫秒: 0, API耗时毫秒: apiMs, 限流等待毫秒: 0, 容量等待毫秒: 0 }));
  assert.ok(ownMs > 0 && ownMs <= 105_000);
  assert.ok(mainMs >= ownMs && mainMs <= 120_000);
  assert.equal(d.github.totals().stagingUpdates, 1);
  assert.equal(d.github.totals().requiredRuns, staged.runs.length);
  assert.equal(d.github.totals().manualActions, 0);
});
