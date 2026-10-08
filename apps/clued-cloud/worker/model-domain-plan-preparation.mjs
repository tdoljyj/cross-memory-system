import { DOMAIN_POLICY as P } from './model-domain-policy.mjs';
import { POLICY } from './model-domain-readonly.mjs';
import { readOwnerAnchorsWithExistingBindingRpc } from './model-domain-owner-anchor-rpc.mjs';

// Preparation only. The dispatcher supplies a closure captured from one actual
// Request/Binding; transport JSON cannot provide refs, identity or a loader.
export async function prepareExactPlanWithExistingBindingRpc(rpc, input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).length !== 0) {
    throw new Error('MODEL_DOMAIN_PLAN_PREPARATION_INPUT_INVALID');
  }
  const anchors = await readOwnerAnchorsWithExistingBindingRpc(rpc, {});
  const roles = [
    { role: 'producer', operation: 'create', record_type: 'state', authority: 'user_explicit', identity_not_persisted: true },
    { role: 'permission', operation: 'create', record_type: 'decision', authority: 'user_explicit', identity_not_persisted: true },
    { role: 'recognition', operation: 'create', record_type: 'state', authority: 'observed', identity_not_persisted: true },
  ];
  const roleInputs = Object.freeze({
    producer_record_id: crypto.randomUUID(), permission_record_id: crypto.randomUUID(), recognition_record_id: crypto.randomUUID(),
    idempotency_key: 'model-bootstrap-' + crypto.randomUUID(),
    owner_adoption_server_ref: Object.freeze({ ...anchors.owner_adoption_server_ref }),
    final_recognizer_server_ref: Object.freeze({ ...anchors.final_recognizer_server_ref }),
  });
  const plan = {
    schema: 'clued.model-dataset-split-bootstrap-exact/1', canonical_scope: POLICY.scope, task_id: POLICY.task,
    contract_sha256: P.contract_sha256, authority_registry_sha256: P.domain.authority_registry_sha256,
    max_uses: 1, max_window_seconds: 3600, subject: P.domain.subject, mutation_roles: roles,
    targets: { producer_record_id: roleInputs.producer_record_id, permission_record_id: roleInputs.permission_record_id,
      recognition_record_id: roleInputs.recognition_record_id },
    owner_anchor_refs: { owner_adoption_server_ref: roleInputs.owner_adoption_server_ref,
      final_recognizer_server_ref: roleInputs.final_recognizer_server_ref }, idempotency_key: roleInputs.idempotency_key,
  };
  const planUtf8 = JSON.stringify(plan, null, 2) + '\n';
  const bytes = new TextEncoder().encode(planUtf8);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const planSha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  return Object.freeze({ status: 'PLAN_ARTIFACT_PROPOSAL_UNCOMMITTED_UNAUTHORIZED', plan_utf8: planUtf8,
    plan_sha256: planSha256, plan_bytes: bytes.length, role_inputs: roleInputs, actual_execution: 'NONE', execution: false,
    mutation_permitted: false, authority_effect: 'NONE', plan_semantics: 'PROPOSAL_ONLY_NEVER_NATIVE_INTENT',
    immutable_resource: null, SQL_emitted: false, domain_permission: 'NOT_GRANTED', m2_verdict: 'NOT_ISSUED' });
}
