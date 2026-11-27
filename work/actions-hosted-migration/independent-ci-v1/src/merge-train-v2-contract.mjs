import { digest } from './proof.mjs';

export const TRAIN_PROTOCOL_VERSION = 2;
export const TRAIN_CONTROL_TIMING = Object.freeze({ leaseMs: 90_000, progressIntervalMs: 30_000, recheckMs: 15_000 });
export const TRAIN_PROBE_FIELDS = Object.freeze([
  'protocol_version', 'on_duty', 'node_id', 'binding_generation', 'source_manifest_sha256', 'stop_scope',
]);
export const TRAIN_BATCH_MEMBER_FIELDS = Object.freeze(['pr', 'headSha', 'claimId', 'fence', 'epoch']);
export const TRAIN_LANDING_INTENT_FIELDS = Object.freeze([
  'batchId', 'generation', 'baseSha', 'testSha', 'generationRefOid', 'members', 'expiresAt',
]);
export const TRAIN_REQUIRED_RUN_FIELDS = Object.freeze(['testSha', 'checkName', 'platform', 'policyVersion']);
export const TRAIN_CHECK_EFFECT_FIELDS = Object.freeze(['appId', 'headSha', 'externalId', 'checkRunId']);

// 值为动作必须核验的对象。节点资格是所有工作写入的共同前提。
export const TRAIN_ACTION_AUTHORITY = Object.freeze({
  role_probe: 'node_read',
  merge_slot_holders: 'legacy_read',
  ci_nodes_status: 'legacy_read',
  ci_queue_report: 'legacy_report',
  ci_node_heartbeat: 'heartbeat',
  hosted_legacy: 'legacy_hosted',
  verify_head: 'head',
  owner_grant_admission: 'head',
  resolve_pr_claim: 'head',
  mechanical_proof: 'head',
  publisher_current: 'node_qualification',
  historical_admission_valid: 'historical_admission',
  admission_issue_fact: 'head',
  publication_begin: 'ticket',
  publication_begin_independent: 'ticket',
  publication_finish: 'ticket',
  publication_abort: 'ticket',
  publication_reconcile: 'effect',
  scan_start_verify: 'job_head',
  scan_start_begin: 'job_head',
  carry_main_merge: 'pr_claim',
  merge_queue_join: 'pr_claim',
  claim_lease_extend: 'pr_claim',
  merge_slot_touch: 'pr_claim',
  merge_slot_return: 'pr_claim',
  merge_queue_yield: 'pr_claim',
  pr_lifecycle_report: 'pr_claim',
  claim_adopt: 'landed_batch_member',
  merge_queue_keepalive: 'pr_claim',
  batch_reserve: 'target_branch',
  batch_seal: 'batch',
  batch_bisect: 'batch',
  staging_publish: 'batch_generation',
  landing_prepare: 'batch_generation',
  landing_send: 'landing_intent',
  landing_reconcile: 'landing_intent',
  landing_invalidate: 'landing_intent',
  batch_cleanup: 'batch',
  ci_sweep_watermark: 'legacy_maintenance',
  independent_revocation_heads: 'effect_inventory',
  independent_legacy_drain_finish: 'effect',
  revoke_check: 'effect',
});

// 旧合入位、命令总闸、独立发布与扫描的判定逐处迁移。重复的函数名以检查位置区分。
export const TRAIN_LEGACY_DUTY_SITES = Object.freeze([
  ['merge_slot_admits_v1', 'duty_merge_slot', '按各合入位动作的对象'],
  ['work_claim_ci_command_v1', 'duty_role', '按命令动作和票据角色'],
  ['ci_sweep_watermark_v1', 'duty_merge_slot_sweep', 'ci_sweep_watermark'],
  ['work_claim_merge_queue_keepalive_v1', 'duty_merge_slot_sweep', 'merge_queue_keepalive'],
  ['work_claim_independent_begin_v1', 'duty_role', 'publication_begin_independent'],
  ['work_claim_independent_abort_v1', 'duty_role', 'publication_abort'],
  ['work_claim_independent_drain_command_v1', 'duty_role', '按命令效果对象'],
  ['clued_work_verify_v1:1', 'issuer_role', 'verify_head'],
  ['clued_work_verify_v1:2', 'issuer_role', 'verify_head'],
  ['work_claim_verify_before_execution_v1', 'issuer_admits', 'verify_head'],
  ['clued_owner_grant_admission_door_v1', 'issuer_role', 'owner_grant_admission'],
  ['clued_work_merge_slot_holders_v1', 'duty_admits', 'merge_slot_holders'],
  ['ci_publisher_current_v1', 'duty_publisher', 'publisher_current'],
  // 旧扫描核验副本已收敛到实时 verify。保留盘点位置，供迁移覆盖比对。
  ['ci_scan_start_verify_principal_v1:1', 'issuer_role', 'scan_start_verify'],
  ['ci_scan_start_verify_principal_v1:2', 'issuer_role', 'scan_start_verify'],
  ['ci_scan_start_verify_core_principal_v1', 'issuer_admits', 'scan_start_verify'],
  ['ci_scan_start_begin_v1', 'duty_role', 'scan_start_begin'],
  ['ci_admission_issue_fact_v1', 'issuer_role', 'admission_issue_fact'],
  ['ci_admission_issue_valid_v1', 'admission_role', 'historical_admission_valid'],
  ['work_claim_resolve_pr_v1', 'issuer_role', 'resolve_pr_claim'],
  ['work_claim_mechanical_proof_error_v1', 'issuer_role', 'mechanical_proof'],
  ['work_claim_carry_main_merge_v1', 'issuer_role', 'carry_main_merge'],
].map(Object.freeze));

export const TRAIN_LEGACY_EXTRA_GATES = Object.freeze({
  publication_begin_independent: Object.freeze(['singleton_binding_source', 'phase_requires_reservation']),
  scan_start_begin: Object.freeze(['singleton_binding_source']),
  publication_finish: Object.freeze(['work_claim_ci_command_v1', 'ticket_role_and_generation']),
});

export const TRAIN_TICKET_AUTHORITY = Object.freeze({
  'work-admission': 'head_or_front_job',
  'control-admission': 'batch_member',
  'control-merge-slot': 'batch_member',
});

export const TRAIN_FAILURE = Object.freeze({
  HEAD_LEASE_HELD: Object.freeze({ native: 'ci_head_lease_held', resident: 'CI_HEAD_LEASE_HELD', handling: 'retry_at_expiry' }),
  HEAD_LEASE_COMPLETED: Object.freeze({ native: 'ci_head_lease_completed', resident: 'CI_HEAD_LEASE_COMPLETED', handling: 'settle_local' }),
  LEASE_STALE: Object.freeze({ native: 'ci_work_lease_stale', resident: 'CI_WORK_LEASE_STALE', handling: 'discard_authority' }),
  EFFECT_UNKNOWN: Object.freeze({ native: 'ci_effect_unknown', resident: 'CI_EFFECT_UNKNOWN', handling: 'reconcile_effect' }),
  LANDING_REF_MISMATCH: Object.freeze({ native: 'ci_landing_ref_mismatch', resident: 'CI_LANDING_REF_MISMATCH', handling: 'reconcile_refs' }),
  SOURCE_MISMATCH: Object.freeze({ native: 'ci_source_mismatch', resident: 'CI_SOURCE_MISMATCH', handling: 'deny_write' }),
});
export const TRAIN_HEAD_RETRY_FIELDS = Object.freeze({ native: 'ci_retry_after', source: 'scheduling.ciRetryAfter' });
export const TRAIN_EFFECT_STATES = Object.freeze(['reserved', 'sent', 'unknown', 'settled', 'revoked']);

// 统计实际生效的外部写，尝试次数单独统计。丢回复仍计一次已生效写。
export const TRAIN_EFFECTS = Object.freeze([
  'headCharges', 'checkCreates', 'checkRevocations', 'queueJoins', 'stagingUpdates', 'requiredRuns',
  'duplicateRequiredRuns', 'mainUpdates', 'adoptions', 'manualActions',
]);

function key(kind, fields) {
  if (!fields.flat(Infinity).every(value => (typeof value === 'string' && value.length > 0)
    || (Number.isSafeInteger(value) && value >= 0))) throw new TypeError('列车工作键缺少稳定标识');
  return digest(['clued.merge-train/2', kind, ...fields]);
}

export function trainHeadWorkKey({ tenantId, projectId, repositoryId, targetBranch, pr, headSha, action }) {
  if (!Number.isSafeInteger(pr) || pr < 1 || typeof headSha !== 'string' || !/^[a-f0-9]{40}$/.test(headSha))
    throw new TypeError('列车 head 工作键需要确切 PR 和 SHA');
  return key('head', [tenantId, projectId, repositoryId, targetBranch, pr, headSha, action]);
}

export function trainBatchKey({ tenantId, projectId, repositoryId, targetBranch, baseSha, members, sourceSha256, policyVersion }) {
  if (!Array.isArray(members) || members.length < 1 || members.length > 4 || new Set(members.map(member => member.pr)).size !== members.length)
    throw new TypeError('列车批成员必须为 1–4 个不同 PR');
  return key('batch', [tenantId, projectId, repositoryId, targetBranch, baseSha,
    members.map(({ pr, headSha, claimId, fence, epoch }) => [pr, headSha, claimId, fence, epoch]), sourceSha256, policyVersion]);
}

export function trainEffectKey({ tenantId, projectId, repositoryId, targetBranch, action, subject }) {
  if (!Array.isArray(subject) || subject.length === 0 || subject.some(Array.isArray)) throw new TypeError('列车效果键缺少精确对象');
  return key('effect', [tenantId, projectId, repositoryId, targetBranch, action, subject]);
}

// 同一目标分支只有一个未裁决的落地意图。意图记录内另存批和持有代次。
export function trainLandingSlotKey({ tenantId, projectId, repositoryId, targetBranch }) {
  return key('landing-slot', [tenantId, projectId, repositoryId, targetBranch]);
}
