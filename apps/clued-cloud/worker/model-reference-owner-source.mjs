import { ALLOWED, PROHIBITED, exact, same, demand, utc, SCOPE, TASK } from './model-reference-owner-contract.mjs';
export const SOURCE_RPC = 'clued_model_reference_owner_approval_refs_candidate';
const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/, hex = /^[0-9a-f]{64}$/;
const bindingKeys = ['allowed_operations', 'budget', 'candidate_role', 'canonical_scope', 'confirmation_origin', 'host_ref', 'kind',
  'materializer_code_sha256', 'output_target_ref', 'parent_boundary', 'profile_id', 'prohibited_operations', 'purpose_id', 'request_sha256',
  'source_stage', 'task_id', 'template_sha256', 'window'];
const budgetKeys = ['currency', 'currency_exponent', 'currency_profile_digest', 'max_attempts', 'max_compute', 'max_concurrency', 'max_cost_minor_units',
  'max_input_bytes', 'max_input_tokens', 'max_output_bytes', 'max_output_tokens', 'max_parallel_experiments', 'max_requests', 'max_response_bytes',
  'max_storage_bytes', 'max_total_tokens', 'max_wall_time', 'provider_deadline_at'];
export function validateSourceInput(input) {
  demand(exact(input, ['approval_binding', 'receipt_id', 'record_ref', 'request_sha256'])
    && exact(input.record_ref, ['content_hash', 'id', 'version']) && uuid.test(input.record_ref.id)
    && Number.isSafeInteger(input.record_ref.version) && input.record_ref.version > 0 && hex.test(input.record_ref.content_hash)
    && uuid.test(input.receipt_id) && hex.test(input.request_sha256), 'EXACT_OWNER_APPROVAL_SOURCE_INPUT_REQUIRED');
  const a = input.approval_binding;
  demand(exact(a, bindingKeys) && a.kind === 'M2_REFERENCE_QUALIFICATION_PROFILE_EXACT_APPROVAL'
    && a.task_id === TASK && a.canonical_scope === SCOPE && a.purpose_id === 'qualification' && a.parent_boundary === 'QUALIFICATION'
    && a.candidate_role === 'M2_REFERENCE_BASELINE' && a.source_stage === 'M1_FIXED_REFERENCE'
    && a.confirmation_origin === 'OWNER_CURRENT_CONVERSATION_EXACT_REQUEST' && a.request_sha256 === input.request_sha256
    && hex.test(a.template_sha256) && hex.test(a.materializer_code_sha256)
    && /^M2-REFERENCE-QUALIFICATION-PC-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(a.profile_id)
    && typeof a.host_ref === 'string' && a.host_ref.length > 0 && a.host_ref.length <= 512
    && typeof a.output_target_ref === 'string' && a.output_target_ref.length > 0 && a.output_target_ref.length <= 512
    && same(a.allowed_operations, ALLOWED) && same(a.prohibited_operations, PROHIBITED), 'FIXED_M2_OWNER_EXACT_SEMANTICS_REQUIRED');
  const b = a.budget;
  demand(exact(b, budgetKeys) && b.currency === 'USD' && Number.isSafeInteger(b.currency_exponent) && b.currency_exponent >= 0 && b.currency_exponent <= 6
    && hex.test(b.currency_profile_digest) && b.max_attempts === 1 && b.max_concurrency === 1 && b.max_parallel_experiments === 1 && b.max_cost_minor_units === 0
    && exact(b.max_compute, ['device_class', 'max_compute_bytes']) && b.max_compute.device_class === 'PC'
    && Number.isSafeInteger(b.max_compute.max_compute_bytes) && b.max_compute.max_compute_bytes > 0,
  'EXACT_NON_LEARNING_PC_BUDGET_REQUIRED');
  for (const key of ['max_input_bytes', 'max_input_tokens', 'max_output_bytes', 'max_output_tokens', 'max_requests', 'max_response_bytes',
    'max_storage_bytes', 'max_total_tokens', 'max_wall_time']) demand(Number.isSafeInteger(b[key]) && b[key] > 0, 'EXACT_POSITIVE_INTEGER_BUDGET_REQUIRED');
  demand(exact(a.window, ['not_before', 'stop_at']) && b.provider_deadline_at === a.window.stop_at
    && utc(a.window.not_before) < utc(a.window.stop_at) && (utc(a.window.stop_at) - utc(a.window.not_before)) / 1000 >= b.max_wall_time,
  'EXACT_TYPED_UTC_OWNER_WINDOW_REQUIRED');
  return structuredClone(input);
}
const resultKeys = ['status', 'approval_record_ref', 'receipt_id', 'event_id', 'canonical_version', 'request_sha256', 'template_sha256',
  'profile_id', 'source_scope', 'task_id', 'evaluated_at', 'authority_effect', 'actual_execution', 'profile_issued',
  'private_actor_fields_exposed', 'record_body_exposed'];
export function validateSourceOutput(output, input, now) {
  demand(exact(output, resultKeys) && output.status === 'CURRENT_EXACT_OWNER_APPROVAL_REFS_ONLY'
    && same(output.approval_record_ref, input.record_ref) && output.receipt_id === input.receipt_id
    && /^[1-9][0-9]*$/.test(output.event_id) && Number.isSafeInteger(output.canonical_version) && output.canonical_version > 0
    && output.request_sha256 === input.request_sha256 && output.template_sha256 === input.approval_binding.template_sha256
    && output.profile_id === input.approval_binding.profile_id && output.source_scope === SCOPE && output.task_id === TASK
    && output.authority_effect === 'NONE' && output.actual_execution === 'NONE' && output.profile_issued === false
    && output.private_actor_fields_exposed === false && output.record_body_exposed === false,
  'ACTOR_FREE_CURRENT_OWNER_REF_OUTPUT_REQUIRED');
  const readAt = utc(output.evaluated_at);
  demand(Number.isSafeInteger(now) && readAt <= now && now - readAt <= 300000
    && utc(input.approval_binding.window.not_before) <= now && now < utc(input.approval_binding.window.stop_at), 'OWNER_SOURCE_FRESHNESS_OR_WINDOW_EXPIRED');
  return Object.freeze(structuredClone(output));
}
// Bind only in the existing authenticated Request/Binding code branch. No
// Actor, token, caller DTO or proof field is accepted from operation JSON.
export function createActorFreeOwnerApprovalSource(existingBindingRpc, clock = () => Date.now()) {
  const captures = new WeakMap();
  return Object.freeze({
    async readExact(input) {
      try {
        const request = validateSourceInput(input);
        demand(typeof existingBindingRpc === 'function', 'AUTHENTICATED_OWNER_SOURCE_NOT_INSTALLED_OR_UNAVAILABLE');
        const result = validateSourceOutput(await existingBindingRpc(SOURCE_RPC, request), request, clock());
        const localRef = Object.freeze(Object.create(null)); captures.set(localRef, { request, result });
        return { status: 'ACTOR_FREE_SOURCE_REFERENCE_CAPTURED_NOT_PROFILE_ISSUED', source_ref: localRef,
          verified_refs: result, authority_effect: 'NONE', issued: false };
      } catch (e) { return { status: 'NOT_READY', reason: e.code ?? 'AUTHENTICATED_OWNER_SOURCE_DENIED_OR_UNKNOWN', issued: false, authority_effect: 'NONE' }; }
    },
    validateCaptured(localRef, exactInput) {
      const stored = localRef && captures.get(localRef);
      demand(stored && same(stored.request, validateSourceInput(exactInput)), 'SAME_HOST_AUTHENTICATED_ACTOR_FREE_SOURCE_REQUIRED');
      return validateSourceOutput(stored.result, stored.request, clock());
    },
  });
}

// Public MCP receives the closed 16-field DTO only, never an opaque Host seal.
export async function readOwnerApprovalRefsWithExistingBindingRpc(rpc, input, clock = () => Date.now()) {
  const result = await createActorFreeOwnerApprovalSource(rpc, clock).readExact(input);
  demand(result.status === 'ACTOR_FREE_SOURCE_REFERENCE_CAPTURED_NOT_PROFILE_ISSUED', 'EXACT_OWNER_SOURCE_DENIED_OR_UNAVAILABLE');
  return result.verified_refs;
}
