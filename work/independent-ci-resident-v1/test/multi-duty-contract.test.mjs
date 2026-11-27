import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TRAIN_ACTION_AUTHORITY, TRAIN_CONTROL_TIMING, TRAIN_FAILURE, TRAIN_HEAD_RETRY_FIELDS, TRAIN_LEGACY_DUTY_SITES,
  TRAIN_LEGACY_EXTRA_GATES, TRAIN_PROBE_FIELDS, TRAIN_PROTOCOL_VERSION, trainBatchKey, trainEffectKey, trainHeadWorkKey,
  trainLandingSlotKey,
} from '../../actions-hosted-migration/independent-ci-v1/src/merge-train-v2-contract.mjs';
import { multiDutyClock, multiDutyGitHub } from './multi-duty-fixture.mjs';

test('列车 v2 合同：22 处旧判定、独立硬闸、只读权限与中性原因码', () => {
  assert.equal(TRAIN_PROTOCOL_VERSION, 2);
  assert.deepEqual(TRAIN_PROBE_FIELDS, ['protocol_version', 'on_duty', 'node_id', 'binding_generation', 'source_manifest_sha256', 'stop_scope']);
  assert.equal(new Set(TRAIN_LEGACY_DUTY_SITES.map(([site]) => site)).size, 22);
  assert.equal(TRAIN_LEGACY_DUTY_SITES.length, 22);
  assert.deepEqual(TRAIN_LEGACY_EXTRA_GATES.publication_finish, ['work_claim_ci_command_v1', 'ticket_role_and_generation']);
  assert.deepEqual(['role_probe', 'ci_node_heartbeat', 'merge_slot_holders', 'hosted_legacy'].map(action => TRAIN_ACTION_AUTHORITY[action]),
    ['node_read', 'heartbeat', 'legacy_read', 'legacy_hosted']);
  assert.deepEqual(['publication_finish', 'merge_queue_join', 'landing_send', 'claim_adopt', 'revoke_check'].map(action => TRAIN_ACTION_AUTHORITY[action]),
    ['ticket', 'pr_claim', 'landing_intent', 'landed_batch_member', 'effect']);
  assert.equal(TRAIN_FAILURE.HEAD_LEASE_HELD.native, 'ci_head_lease_held');
  assert.equal(TRAIN_FAILURE.HEAD_LEASE_HELD.resident, 'CI_HEAD_LEASE_HELD');
  assert.equal(TRAIN_FAILURE.HEAD_LEASE_COMPLETED.native, 'ci_head_lease_completed');
  assert.equal(TRAIN_FAILURE.HEAD_LEASE_COMPLETED.resident, 'CI_HEAD_LEASE_COMPLETED');
  assert.deepEqual(TRAIN_HEAD_RETRY_FIELDS, { native: 'ci_retry_after', source: 'scheduling.ciRetryAfter' });
  assert.deepEqual(TRAIN_CONTROL_TIMING, { leaseMs: 90_000, progressIntervalMs: 30_000, recheckMs: 15_000 });
});

test('列车 v2 合同：跨节点工作与效果键稳定，批键绑定有序成员及代次', () => {
  const scope = { tenantId: 'tenant', projectId: 'project', repositoryId: 99, targetBranch: 'main' };
  const a = { pr: 1, headSha: 'a'.repeat(40), claimId: 'claim-a', fence: 1, epoch: 2 };
  const b = { ...a, pr: 2, headSha: 'b'.repeat(40), claimId: 'claim-b' };
  const head = { ...scope, ...a, action: 'verify_head' };
  const batch = { ...scope, baseSha: 'c'.repeat(40), members: [a, b], sourceSha256: 'd'.repeat(64), policyVersion: 1 };
  const effect = { ...scope, action: 'revoke_check', subject: [5368905, a.headSha, 'external-id', 101] };
  assert.equal(trainHeadWorkKey(head), trainHeadWorkKey({ ...head, nodeId: 'b', retry: 2, fence: 3 }));
  assert.notEqual(trainHeadWorkKey(head), trainHeadWorkKey({ ...head, tenantId: 'other' }));
  assert.notEqual(trainHeadWorkKey(head), trainHeadWorkKey({ ...head, action: 'scan_start_begin' }));
  assert.notEqual(trainBatchKey(batch), trainBatchKey({ ...batch, members: [b, a] }));
  assert.notEqual(trainBatchKey(batch), trainBatchKey({ ...batch, members: [{ ...a, epoch: 3 }, b] }));
  assert.notEqual(trainBatchKey(batch), trainBatchKey({ ...batch, policyVersion: 2 }));
  assert.equal(trainEffectKey(effect), trainEffectKey({ ...effect, nodeId: 'b', leaseGeneration: 3 }));
  assert.notEqual(trainEffectKey(effect), trainEffectKey({ ...effect, subject: [...effect.subject.slice(0, -1), 102] }));
  assert.equal(trainLandingSlotKey(scope), trainLandingSlotKey({ ...scope, batchId: trainBatchKey(batch), generation: 2 }));
  assert.notEqual(trainLandingSlotKey(scope), trainLandingSlotKey({ ...scope, targetBranch: 'release' }));
  assert.throws(() => trainBatchKey({ ...batch, members: [a, a] }), /不同 PR/);
  assert.throws(() => trainHeadWorkKey({ ...head, tenantId: undefined }), TypeError);
});

test('列车 v2 夹具：写入暂停、写成丢回复、事件逆序、请求与生效分别计数', async () => {
  const clock = multiDutyClock(1_000), gh = multiDutyGitHub(clock);
  const events = [];
  let main = 'T';
  gh.arm('push', { delay: true, loseReply: true });
  const sent = gh.write('push', () => { main = 'S'; return main; }, sha => ['mainUpdates', sha, 'a']);
  const rejection = assert.rejects(sent, /远端写入后丢弃回复/);
  assert.ok(gh.waiting('push'));
  assert.equal(main, 'T');
  assert.equal(gh.totals().mainUpdates, 0);
  clock.advance(90_000);
  gh.emit(1, { oid: 'T' });
  gh.emit(2, { oid: 'S' });
  gh.release('push');
  await rejection;
  assert.equal(main, 'S');
  assert.deepEqual(gh.effects(), [{ kind: 'mainUpdates', subject: 'S', node: 'a', at: 91_000 }]);
  await gh.deliver(2, event => events.push(event.oid));
  await gh.deliver(1, event => events.push(event.oid));
  assert.deepEqual(events, ['S', 'T']);
  assert.equal(gh.requests().length, 1);
});
