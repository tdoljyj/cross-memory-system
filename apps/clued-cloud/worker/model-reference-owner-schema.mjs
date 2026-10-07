import { ALLOWED, PROHIBITED, SCOPE, TASK } from './model-reference-owner-contract.mjs';
const text = { type: 'string', minLength: 1, maxLength: 512 };
const uuid = { type: 'string', format: 'uuid', pattern: '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' };
const digest = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const integer = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const utc = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,6})?Z$' };
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const ref = object({ id: uuid, version: integer, content_hash: digest });
const budget = object({
  currency: { type: 'string', const: 'USD' }, currency_exponent: { type: 'integer', minimum: 0, maximum: 6 }, currency_profile_digest: digest,
  max_attempts: { type: 'integer', const: 1 }, max_compute: object({ device_class: { type: 'string', const: 'PC' }, max_compute_bytes: integer }),
  max_concurrency: { type: 'integer', const: 1 }, max_cost_minor_units: { type: 'integer', const: 0 }, max_input_bytes: integer,
  max_input_tokens: integer, max_output_bytes: integer, max_output_tokens: integer, max_parallel_experiments: { type: 'integer', const: 1 },
  max_requests: integer, max_response_bytes: integer, max_storage_bytes: integer, max_total_tokens: integer, max_wall_time: integer, provider_deadline_at: utc,
});
export const ownerApprovalInputSchema = object({
  approval_binding: object({
    allowed_operations: { type: 'array', const: ALLOWED }, budget, candidate_role: { type: 'string', const: 'M2_REFERENCE_BASELINE' },
    canonical_scope: { type: 'string', const: SCOPE }, confirmation_origin: { type: 'string', const: 'OWNER_CURRENT_CONVERSATION_EXACT_REQUEST' },
    host_ref: text, kind: { type: 'string', const: 'M2_REFERENCE_QUALIFICATION_PROFILE_EXACT_APPROVAL' }, materializer_code_sha256: digest,
    output_target_ref: text, parent_boundary: { type: 'string', const: 'QUALIFICATION' },
    profile_id: { type: 'string', pattern: '^M2-REFERENCE-QUALIFICATION-PC-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' },
    prohibited_operations: { type: 'array', const: PROHIBITED }, purpose_id: { type: 'string', const: 'qualification' }, request_sha256: digest,
    source_stage: { type: 'string', const: 'M1_FIXED_REFERENCE' }, task_id: { type: 'string', const: TASK }, template_sha256: digest,
    window: object({ not_before: utc, stop_at: utc }),
  }),
  receipt_id: uuid, record_ref: ref, request_sha256: digest,
});
export const ownerApprovalOutputSchema = object({
  status: { type: 'string', const: 'CURRENT_EXACT_OWNER_APPROVAL_REFS_ONLY' }, approval_record_ref: ref, receipt_id: uuid,
  event_id: { type: 'string', pattern: '^[1-9][0-9]*$' }, canonical_version: integer, request_sha256: digest, template_sha256: digest,
  profile_id: { type: 'string', pattern: '^M2-REFERENCE-QUALIFICATION-PC-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' },
  source_scope: { type: 'string', const: SCOPE }, task_id: { type: 'string', const: TASK }, evaluated_at: utc,
  authority_effect: { type: 'string', const: 'NONE' }, actual_execution: { type: 'string', const: 'NONE' },
  profile_issued: { type: 'boolean', const: false }, private_actor_fields_exposed: { type: 'boolean', const: false },
  record_body_exposed: { type: 'boolean', const: false },
});
