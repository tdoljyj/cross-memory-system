import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  LOCAL_PROVIDER_NONE_PROFILE,
  ModelContractError,
  assertProviderNoneProfile,
  validateModelSchema,
  validateProviderNoneModelContract,
} from "../../kernel/policy/model-contract.mjs";

const testRoot = dirname(fileURLToPath(import.meta.url));
const schemaRoot = resolve(testRoot, "../../protocol/continuity/v1/schemas/model");
const schemaPaths = Object.freeze({
  provider: "provider-descriptor.schema.json",
  request: "model-invocation-request.schema.json",
  attempt: "model-invocation-attempt.schema.json",
  result: "model-invocation-result.schema.json",
  candidate: "model-output-candidate.schema.json",
});
const schemas = Object.freeze(Object.fromEntries(
  Object.entries(schemaPaths).map(([name, relative]) => [
    name,
    JSON.parse(readFileSync(join(schemaRoot, relative), "utf8")),
  ]),
));

const clone = (value) => structuredClone(value);
const D = "sha256:" + "a".repeat(64);
const D2 = "sha256:" + "b".repeat(64);
const T0 = "2026-09-02T00:00:00Z";
const T1 = "2026-09-02T00:00:05Z";
const T2 = "2026-09-02T00:00:10Z";
const budgets = Object.freeze({
  currency: "USD",
  currency_exponent: 2,
  currency_profile_digest: D,
  max_attempts: 2,
  max_concurrent_requests: 1,
  max_cost_minor_units: 100,
  max_elapsed_ms: 5000,
  max_input_bytes: 1048576,
  max_input_tokens: 4096,
  max_output_tokens: 1024,
  max_request_count: 2,
  max_response_bytes: 262144,
  parse_budget_ms: 100,
  persistence_budget_ms: 100,
  scrub_wall_clock_budget_ms: 100,
  validation_budget_ms: 100,
});

const fixtures = Object.freeze({
  provider: Object.freeze({
    schema_version: "2.0",
    object_type: "ModelProviderDescriptor",
    provider_id: "provider.none.fixture",
    adapter_version: "adapter.none.1",
    provider_type: "Test",
    capabilities: ["structured_generate"],
    model_revisions: ["model.fixed.1"],
    regions: ["offline"],
    retention_modes: ["fixture_only"],
    training_modes: ["none"],
    max_input_bytes: 1048576,
    max_output_bytes: 262144,
    streaming: false,
    cancellation: true,
    idempotency: true,
    data_classes: ["internal"],
    health_ttl: 60,
    artifact_digest: D,
    signature_ref: "sig://local/provider-none/1",
  }),
  request: Object.freeze({
    schema_version: "2.0",
    object_type: "ModelInvocationRequest",
    invocation_id: "mi_01",
    attempt_id: "att_01",
    capability: "structured_generate",
    subject_ref: D,
    binding_ref: D,
    project_ref: D,
    scope_digest: D,
    purpose: "document_summary",
    provider_qualification_ref: D,
    model_revision: "model.fixed.1",
    template_hash: D,
    output_schema_digest: D,
    context_slice_ref: "payload://context/1",
    input_digest: D,
    policy_snapshot_digest: D,
    idempotency_key: D,
    deadline: T1,
    budgets: clone(budgets),
    correlation_id: "corr_01",
    provider_id: "provider.none.fixture",
    adapter_version: "adapter.none.1",
    provider_type: "Test",
    region: "offline",
    retention_mode: "fixture_only",
    training_mode: "none",
    training_opt_in_receipt_ref: null,
    data_classification: "internal",
    security_profile_id: "security.local.provider-none",
    eval_set_digest: D,
    step_deadline: T2,
    lease_hard_stop: T2,
  }),
  attempt: Object.freeze({
    schema_version: "2.0",
    object_type: "ModelInvocationAttempt",
    invocation_id: "mi_01",
    attempt_id: "att_01",
    provider_id: "provider.none.fixture",
    started_at: T0,
    provider_deadline: T1,
    step_attempt_ref: "step-attempt://local/1",
    request_digest: D2,
    attempt_ordinal: 1,
    predecessor_attempt_id: null,
    adapter_version: "adapter.none.1",
    model_id: "model.fixture",
    model_revision: "model.fixed.1",
    idempotency_key: D,
    budget_reservation_ref: "budget://local/reserve/1",
    retry_trigger: "initial",
    retry_not_before: null,
    backoff_ms: 0,
    jitter_ms: 0,
    step_deadline: T2,
    lease_hard_stop: T2,
    cancel_requested_at: null,
    result_received_at: T1,
    late_result: false,
    late_result_evidence_ref: null,
    candidate_acceptance_eligible: true,
    output_merge_policy: "FORBID_CROSS_ATTEMPT_MERGE",
  }),
  result: Object.freeze({
    schema_version: "2.0",
    object_type: "ModelInvocationResult",
    result_id: "mr_01",
    invocation_id: "mi_01",
    attempt_id: "att_01",
    correlation_id: "corr_01",
    provider_id: "provider.none.fixture",
    provider_type: "Test",
    adapter_version: "adapter.none.1",
    adapter_artifact_digest: D,
    model_id: "model.fixture",
    model_revision: "model.fixed.1",
    capability: "structured_generate",
    template_hash: D,
    output_schema_digest: D,
    policy_snapshot_digest: D,
    subject_projection: D,
    binding_projection: D,
    project_projection: D,
    scope_digest: D,
    purpose: "document_summary",
    started_at: T0,
    completed_at: T1,
    outcome: "succeeded",
    request_budget_snapshot: clone(budgets),
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      input_bytes: 1000,
      output_bytes: 500,
      cost_minor_units: 10,
      currency: "USD",
      currency_exponent: 2,
      currency_profile_digest: D,
    },
    response_summary: "deterministic local fixture",
    payload_ref: "payload://local/response/1",
    stop_reason: "stop",
    pre_output_schema_validation_status: "PARSEABLE_UNVALIDATED",
    error: null,
    input_digest: D,
    output_digest: D,
    routing_reason: "provider-none deterministic fixture",
    data_classification: "internal",
    retention_policy: "fixture_only",
    region: "offline",
    retention_mode: "fixture_only",
    training_mode: "none",
    request_digest: D2,
    provider_response_id: "provider-none-response-1",
    budget_reservation_ref: "budget://local/reserve/1",
    settlement_ref: "budget://local/settle/1",
    invocation_result_authority: "PROVIDER_CALL_OUTCOME_ONLY",
    business_receipt_boundary: "SEPARATE_ID_SCHEMA_OUTCOME_AND_STORAGE",
  }),
  candidate: Object.freeze({
    schema_version: "2.0",
    object_type: "ModelOutputCandidate",
    candidate_id: "cand_01",
    invocation_id: "mi_01",
    attempt_id: "att_01",
    subject_ref: D,
    binding_ref: D,
    project_ref: D,
    scope_digest: D,
    purpose: "document_summary",
    provider_id: "provider.none.fixture",
    adapter_version: "adapter.none.1",
    adapter_artifact_digest: D,
    model_id: "model.fixture",
    model_revision: "model.fixed.1",
    template_hash: D,
    output_schema_digest: D,
    policy_snapshot_digest: D,
    input_digest: D,
    output_digest: D,
    payload_ref: "payload://local/response/1",
    generated_at: T1,
    expires_at: T2,
    data_classification: "internal",
    retention_policy: "fixture_only",
    correlation_id: "corr_01",
    invocation_result_id: "mr_01",
    invocation_result_digest: D,
    provider_qualification_ref: D,
    provider_type: "Test",
    capability: "structured_generate",
    region: "offline",
    retention_mode: "fixture_only",
    training_mode: "none",
    authority: "NON_AUTHORITATIVE_CANDIDATE",
    canonical_status: "NOT_CANONICAL",
    immutability: "IMMUTABLE_APPEND_ONLY",
    lifecycle_projection_authority: "EVENT_DECISION_RECEIPT_ONLY",
  }),
});

function objects() {
  return clone(fixtures);
}

function bundle(value = objects(), profile = clone(LOCAL_PROVIDER_NONE_PROFILE)) {
  return { profile, schemas, ...value };
}

function schemaAccepted(name, value) {
  const result = validateModelSchema(schemas[name], value);
  assert.equal(result.valid, true, result.failures.join(", "));
}

function schemaRejected(name, value) {
  const result = validateModelSchema(schemas[name], value);
  assert.equal(result.valid, false, "schema negative was accepted");
  assert.ok(result.failures.length > 0);
}

test("V11-POS-01 provider descriptor schema and provider-none effect surface", () => {
  schemaAccepted("provider", fixtures.provider);
  assert.deepEqual(assertProviderNoneProfile(LOCAL_PROVIDER_NONE_PROFILE), LOCAL_PROVIDER_NONE_PROFILE);
  assert.throws(
    () => assertProviderNoneProfile({ ...LOCAL_PROVIDER_NONE_PROFILE, network_access: true }),
    (error) => error instanceof ModelContractError && error.code === "MODEL_PROVIDER_NONE_EFFECT_SURFACE_OPEN",
  );
});

test("V11-POS-02 request schema binds three-part currency and bounded invocation budgets", () => {
  schemaAccepted("request", fixtures.request);
});

test("V11-POS-03 attempt schema binds retry deadline cancellation and late-result controls", () => {
  schemaAccepted("attempt", fixtures.attempt);
});

test("V11-POS-04 result schema binds usage actual route timing outcome and sanitized error union", () => {
  schemaAccepted("result", fixtures.result);
});

test("V11-POS-05 candidate schema plus provider-none cross-object semantic contract", () => {
  schemaAccepted("candidate", fixtures.candidate);
  assert.deepEqual(validateProviderNoneModelContract(bundle()), {
    status: "LOCAL_PROVIDER_NONE_MODEL_CONTRACT_VALID",
    authority_effect: "NONE",
    provider_execution: "NOT_RUN_PROVIDER_NONE",
    network_access: false,
    external_calls: 0,
    paid_calls: 0,
    external_writes: 0,
    canonical_writes: 0,
    business_receipt_issued: false,
    candidate_authority: "NON_AUTHORITATIVE_CANDIDATE",
  });
});

const schemaNegatives = [
  ["V11-SNEG-01 descriptor missing regions", "provider", (value) => { delete value.regions; }],
  ["V11-SNEG-02 descriptor rejects canonical-write credential field", "provider", (value) => { value.canonical_write_credentials = true; }],
  ["V11-SNEG-03 request missing currency", "request", (value) => { delete value.budgets.currency; }],
  ["V11-SNEG-04 request rejects lowercase currency", "request", (value) => { value.budgets.currency = "usd"; }],
  ["V11-SNEG-05 request rejects fractional cost minor units", "request", (value) => { value.budgets.max_cost_minor_units = 1.5; }],
  ["V11-SNEG-06 request missing concurrency bound", "request", (value) => { delete value.budgets.max_concurrent_requests; }],
  ["V11-SNEG-07 request rejects authority grant scope", "request", (value) => { value.grant_scope = true; }],
  ["V11-SNEG-08 request rejects provider training without opt-in receipt", "request", (value) => { value.training_mode = "provider_training"; value.training_opt_in_receipt_ref = null; }],
  ["V11-SNEG-09 attempt rejects unregistered retry trigger", "attempt", (value) => { value.retry_trigger = "format_error"; }],
  ["V11-SNEG-10 retry attempt requires predecessor", "attempt", (value) => { value.attempt_ordinal = 2; value.predecessor_attempt_id = null; value.retry_trigger = "transport_error"; value.retry_not_before = T1; }],
  ["V11-SNEG-11 late result cannot remain candidate eligible", "attempt", (value) => { value.late_result = true; value.late_result_evidence_ref = null; value.candidate_acceptance_eligible = true; }],
  ["V11-SNEG-12 cancelled attempt cannot remain candidate eligible", "attempt", (value) => { value.cancel_requested_at = T1; value.candidate_acceptance_eligible = true; }],
  ["V11-SNEG-13 result missing adapter artifact digest", "result", (value) => { delete value.adapter_artifact_digest; }],
  ["V11-SNEG-14 result missing actual model id", "result", (value) => { delete value.model_id; }],
  ["V11-SNEG-15 result rejects fractional cost minor units", "result", (value) => { value.usage.cost_minor_units = 1.5; }],
  ["V11-SNEG-16 successful result cannot carry error", "result", (value) => { value.error = { code: "MODEL_TIMEOUT", details_digest: null, provider_status: 504, retryable: true, sanitized_message: "timeout" }; }],
  ["V11-SNEG-17 failed result rejects unknown error taxonomy", "result", (value) => { value.outcome = "failed"; value.error = { code: "UNKNOWN", details_digest: null, provider_status: 500, retryable: false, sanitized_message: "bad" }; }],
  ["V11-SNEG-18 candidate missing subject binding", "candidate", (value) => { delete value.subject_ref; }],
  ["V11-SNEG-19 candidate rejects second mutable status axis", "candidate", (value) => { value.status = "committed"; }],
  ["V11-SNEG-20 candidate cannot become authoritative", "candidate", (value) => { value.authority = "CANONICAL"; }],
  ["V11-SNEG-21 candidate requires bounded expiry", "candidate", (value) => { delete value.expires_at; }],
];

for (const [name, objectName, mutate] of schemaNegatives) {
  test(name, () => {
    const value = clone(fixtures[objectName]);
    mutate(value);
    schemaRejected(objectName, value);
  });
}

const crossNegatives = [
  ["V11-XNEG-01 result currency must equal request currency", "MODEL_CURRENCY_BINDING_MISMATCH", (value) => { value.result.usage.currency = "EUR"; }],
  ["V11-XNEG-02 result currency profile must equal request profile", "MODEL_CURRENCY_BINDING_MISMATCH", (value) => { value.result.usage.currency_profile_digest = "sha256:" + "c".repeat(64); }],
  ["V11-XNEG-03 result cost cannot exceed request budget", "MODEL_COST_BUDGET_EXCEEDED", (value) => { value.result.usage.cost_minor_units = 101; }],
  ["V11-XNEG-04 result attempt identity must equal request", "MODEL_IDENTITY_BINDING_MISMATCH", (value) => { value.result.attempt_id = "att_02"; }],
  ["V11-XNEG-05 late result cannot yield accepted candidate", "MODEL_CANDIDATE_INELIGIBLE", (value) => { value.attempt.late_result = true; value.attempt.candidate_acceptance_eligible = false; value.attempt.late_result_evidence_ref = "evidence://late/1"; }],
];

for (const [name, expectedCode, mutate] of crossNegatives) {
  test(name, () => {
    const value = objects();
    mutate(value);
    assert.throws(
      () => validateProviderNoneModelContract(bundle(value)),
      (error) => error instanceof ModelContractError && error.code === expectedCode,
    );
  });
}
