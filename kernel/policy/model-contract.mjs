export const LOCAL_PROVIDER_NONE_PROFILE = Object.freeze({
  schema_version: "clued.v15.model-provider-none-profile/1",
  provider_kind: "none",
  network_access: false,
  provider_sdk_access: false,
  secret_access: false,
  paid_calls: 0,
  external_calls: 0,
  external_writes: 0,
  canonical_writes: 0,
  production: false,
});

export class ModelContractError extends Error {
  constructor(code, details = []) {
    super(code);
    this.name = "ModelContractError";
    this.code = code;
    this.details = [...details];
  }
}

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const clone = (value) => structuredClone(value);

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function equal(left, right) {
  return canonical(left) === canonical(right);
}

function reject(code, details = []) {
  throw new ModelContractError(code, details);
}

function requireCondition(condition, code, details = []) {
  if (!condition) reject(code, details);
}

function typeMatches(type, value) {
  const accepted = Array.isArray(type) ? type : [type];
  const actual = value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : Number.isInteger(value)
        ? "integer"
        : typeof value;
  return accepted.includes(actual) || (actual === "integer" && accepted.includes("number"));
}

function resolveLocalRef(root, reference) {
  const prefix = "#/$defs/";
  if (typeof reference !== "string" || !reference.startsWith(prefix)) return null;
  return root.$defs?.[reference.slice(prefix.length)] ?? null;
}

export function validateModelSchema(schema, value) {
  const failures = [];

  function walk(node, current, root, location) {
    if (node === true) return;
    if (node === false || !node || typeof node !== "object") {
      failures.push(location + " false_schema");
      return;
    }

    if (node.$ref) {
      const referenced = resolveLocalRef(root, node.$ref);
      if (!referenced) {
        failures.push(location + " unresolved_ref");
        return;
      }
      walk(referenced, current, root, location);
      return;
    }

    if (Array.isArray(node.allOf)) {
      for (const child of node.allOf) walk(child, current, root, location);
    }

    if (Array.isArray(node.oneOf)) {
      let matches = 0;
      for (const child of node.oneOf) {
        const before = failures.length;
        walk(child, current, root, location);
        if (failures.length === before) {
          matches += 1;
        } else {
          failures.splice(before);
        }
      }
      if (matches !== 1) failures.push(location + " oneOf");
    }

    if (node.not) {
      const before = failures.length;
      walk(node.not, current, root, location);
      const matched = failures.length === before;
      failures.splice(before);
      if (matched) failures.push(location + " not");
    }

    if (node.if) {
      const before = failures.length;
      walk(node.if, current, root, location);
      const matched = failures.length === before;
      failures.splice(before);
      if (matched && node.then) walk(node.then, current, root, location);
      if (!matched && node.else) walk(node.else, current, root, location);
    }

    if (own(node, "const") && !equal(current, node.const)) failures.push(location + " const");
    if (Array.isArray(node.enum) && !node.enum.some((item) => equal(item, current))) failures.push(location + " enum");

    if (node.type && !typeMatches(node.type, current)) {
      failures.push(location + " type");
      return;
    }

    if (typeof current === "string") {
      if (node.minLength !== undefined && current.length < node.minLength) failures.push(location + " minLength");
      if (node.maxLength !== undefined && current.length > node.maxLength) failures.push(location + " maxLength");
      if (node.pattern && !new RegExp(node.pattern, "u").test(current)) failures.push(location + " pattern");
      if (node.format === "date-time" && (!current.includes("T") || Number.isNaN(Date.parse(current)))) {
        failures.push(location + " date-time");
      }
    }

    if (typeof current === "number") {
      if (node.minimum !== undefined && current < node.minimum) failures.push(location + " minimum");
      if (node.maximum !== undefined && current > node.maximum) failures.push(location + " maximum");
    }

    if (Array.isArray(current)) {
      if (node.minItems !== undefined && current.length < node.minItems) failures.push(location + " minItems");
      if (node.maxItems !== undefined && current.length > node.maxItems) failures.push(location + " maxItems");
      if (node.uniqueItems && new Set(current.map(canonical)).size !== current.length) failures.push(location + " uniqueItems");
      if (node.items) current.forEach((item, index) => walk(node.items, item, root, location + "/" + index));
    }

    if (current && typeof current === "object" && !Array.isArray(current)) {
      if (Array.isArray(node.required)) {
        for (const key of node.required) {
          if (!own(current, key)) failures.push(location + " missing " + key);
        }
      }
      if (node.additionalProperties === false && node.properties) {
        for (const key of Object.keys(current)) {
          if (!own(node.properties, key)) failures.push(location + " extra " + key);
        }
      }
      if (node.properties) {
        for (const [key, child] of Object.entries(node.properties)) {
          if (own(current, key)) walk(child, current[key], root, location + "/" + key);
        }
      }
    }
  }

  walk(schema, value, schema, "$");
  return Object.freeze({ valid: failures.length === 0, failures: Object.freeze([...failures]) });
}

export function assertModelSchema(schema, value, objectName = "model-object") {
  const result = validateModelSchema(schema, value);
  if (!result.valid) reject("MODEL_SCHEMA_INVALID", [objectName, ...result.failures]);
  return clone(value);
}

export function assertProviderNoneProfile(profile) {
  requireCondition(profile && typeof profile === "object" && !Array.isArray(profile), "MODEL_PROVIDER_NONE_PROFILE_INVALID");
  const required = LOCAL_PROVIDER_NONE_PROFILE;
  for (const [key, expected] of Object.entries(required)) {
    requireCondition(own(profile, key) && equal(profile[key], expected), "MODEL_PROVIDER_NONE_EFFECT_SURFACE_OPEN", [key]);
  }
  const allowed = new Set(Object.keys(required));
  for (const key of Object.keys(profile)) {
    requireCondition(allowed.has(key), "MODEL_PROVIDER_NONE_PROFILE_EXTRA_FIELD", [key]);
  }
  return clone(profile);
}

function requireSame(code, field, ...values) {
  const [first, ...rest] = values;
  requireCondition(rest.every((value) => equal(first, value)), code, [field]);
}

function dateValue(value, field) {
  const parsed = Date.parse(value);
  requireCondition(Number.isFinite(parsed), "MODEL_TIME_INVALID", [field]);
  return parsed;
}

const ROUTE_FIELDS = Object.freeze(["provider_id", "adapter_version", "model_revision"]);
const REQUEST_BINDING_FIELDS = Object.freeze([
  "template_hash",
  "output_schema_digest",
  "policy_snapshot_digest",
  "scope_digest",
  "purpose",
  "input_digest",
  "data_classification",
  "region",
  "retention_mode",
  "training_mode",
]);
const CURRENCY_FIELDS = Object.freeze(["currency", "currency_exponent", "currency_profile_digest"]);

export function validateProviderNoneModelContract(bundle) {
  requireCondition(bundle && typeof bundle === "object" && !Array.isArray(bundle), "MODEL_BUNDLE_INVALID");
  const { profile, schemas, provider, request, attempt, result, candidate } = bundle;
  assertProviderNoneProfile(profile);

  requireCondition(schemas && typeof schemas === "object", "MODEL_SCHEMA_SET_MISSING");
  for (const [name, value] of Object.entries({ provider, request, attempt, result, candidate })) {
    requireCondition(schemas[name], "MODEL_SCHEMA_SET_INCOMPLETE", [name]);
    assertModelSchema(schemas[name], value, name);
  }

  requireCondition(provider.provider_type === "Test", "MODEL_PROVIDER_NONE_DESCRIPTOR_MUST_BE_TEST_ONLY");
  requireCondition(provider.regions.includes("offline"), "MODEL_PROVIDER_NONE_OFFLINE_REGION_REQUIRED");
  requireCondition(provider.retention_modes.includes("fixture_only"), "MODEL_PROVIDER_NONE_FIXTURE_RETENTION_REQUIRED");
  requireCondition(provider.training_modes.includes("none"), "MODEL_PROVIDER_NONE_TRAINING_FORBIDDEN");

  requireCondition(provider.capabilities.includes(request.capability), "MODEL_PROVIDER_CAPABILITY_UNSUPPORTED");
  requireCondition(provider.model_revisions.includes(request.model_revision), "MODEL_PROVIDER_REVISION_UNSUPPORTED");
  requireCondition(provider.regions.includes(request.region), "MODEL_PROVIDER_REGION_UNSUPPORTED");
  requireCondition(provider.retention_modes.includes(request.retention_mode), "MODEL_PROVIDER_RETENTION_UNSUPPORTED");
  requireCondition(provider.training_modes.includes(request.training_mode), "MODEL_PROVIDER_TRAINING_MODE_UNSUPPORTED");
  requireCondition(provider.data_classes.includes(request.data_classification), "MODEL_PROVIDER_DATA_CLASS_UNSUPPORTED");
  requireCondition(request.budgets.max_input_bytes <= provider.max_input_bytes, "MODEL_PROVIDER_INPUT_CAP_EXCEEDED");
  requireCondition(request.budgets.max_response_bytes <= provider.max_output_bytes, "MODEL_PROVIDER_OUTPUT_CAP_EXCEEDED");

  for (const object of [attempt, result, candidate]) {
    requireSame("MODEL_IDENTITY_BINDING_MISMATCH", "invocation_id", request.invocation_id, object.invocation_id);
    requireSame("MODEL_IDENTITY_BINDING_MISMATCH", "attempt_id", request.attempt_id, object.attempt_id);
  }

  for (const field of ROUTE_FIELDS) {
    requireSame("MODEL_ROUTE_BINDING_MISMATCH", field, request[field], attempt[field], result[field], candidate[field]);
  }
  requireSame("MODEL_ROUTE_BINDING_MISMATCH", "provider_type", provider.provider_type, request.provider_type, result.provider_type, candidate.provider_type);
  requireSame("MODEL_ROUTE_BINDING_MISMATCH", "provider_id", provider.provider_id, request.provider_id);
  requireSame("MODEL_ROUTE_BINDING_MISMATCH", "adapter_version", provider.adapter_version, request.adapter_version);
  requireSame("MODEL_ROUTE_BINDING_MISMATCH", "adapter_artifact_digest", provider.artifact_digest, result.adapter_artifact_digest, candidate.adapter_artifact_digest);
  requireSame("MODEL_ROUTE_BINDING_MISMATCH", "model_id", attempt.model_id, result.model_id, candidate.model_id);
  requireSame("MODEL_ROUTE_BINDING_MISMATCH", "capability", request.capability, result.capability, candidate.capability);

  for (const field of REQUEST_BINDING_FIELDS) {
    requireSame("MODEL_REQUEST_BINDING_MISMATCH", field, request[field], result[field], candidate[field]);
  }
  requireSame("MODEL_REQUEST_BINDING_MISMATCH", "subject", request.subject_ref, result.subject_projection, candidate.subject_ref);
  requireSame("MODEL_REQUEST_BINDING_MISMATCH", "binding", request.binding_ref, result.binding_projection, candidate.binding_ref);
  requireSame("MODEL_REQUEST_BINDING_MISMATCH", "project", request.project_ref, result.project_projection, candidate.project_ref);
  requireSame("MODEL_REQUEST_BINDING_MISMATCH", "correlation_id", request.correlation_id, result.correlation_id, candidate.correlation_id);
  requireSame("MODEL_REQUEST_BINDING_MISMATCH", "provider_qualification_ref", request.provider_qualification_ref, candidate.provider_qualification_ref);
  requireSame("MODEL_REQUEST_BINDING_MISMATCH", "request_digest", attempt.request_digest, result.request_digest);
  requireSame("MODEL_REQUEST_BINDING_MISMATCH", "idempotency_key", request.idempotency_key, attempt.idempotency_key);
  requireSame("MODEL_REQUEST_BINDING_MISMATCH", "budget_reservation_ref", attempt.budget_reservation_ref, result.budget_reservation_ref);

  requireCondition(equal(request.budgets, result.request_budget_snapshot), "MODEL_BUDGET_SNAPSHOT_MISMATCH");
  for (const field of CURRENCY_FIELDS) {
    requireSame("MODEL_CURRENCY_BINDING_MISMATCH", field, request.budgets[field], result.usage[field]);
  }
  requireCondition(result.usage.cost_minor_units <= request.budgets.max_cost_minor_units, "MODEL_COST_BUDGET_EXCEEDED");
  requireCondition(result.usage.input_tokens <= request.budgets.max_input_tokens, "MODEL_INPUT_TOKEN_BUDGET_EXCEEDED");
  requireCondition(result.usage.output_tokens <= request.budgets.max_output_tokens, "MODEL_OUTPUT_TOKEN_BUDGET_EXCEEDED");
  requireCondition(result.usage.input_bytes <= request.budgets.max_input_bytes, "MODEL_INPUT_BYTE_BUDGET_EXCEEDED");
  requireCondition(result.usage.output_bytes <= request.budgets.max_response_bytes, "MODEL_OUTPUT_BYTE_BUDGET_EXCEEDED");
  requireCondition(attempt.attempt_ordinal <= request.budgets.max_attempts, "MODEL_ATTEMPT_BUDGET_EXCEEDED");
  requireCondition(attempt.attempt_ordinal <= request.budgets.max_request_count, "MODEL_REQUEST_COUNT_BUDGET_EXCEEDED");
  requireCondition(request.budgets.max_concurrent_requests === 1, "MODEL_PROVIDER_NONE_CONCURRENCY_MUST_BE_ONE");

  if (attempt.attempt_ordinal === 1) {
    requireCondition(
      attempt.predecessor_attempt_id === null &&
      attempt.retry_trigger === "initial" &&
      attempt.retry_not_before === null &&
      attempt.backoff_ms === 0 &&
      attempt.jitter_ms === 0,
      "MODEL_INITIAL_ATTEMPT_BINDING_INVALID",
    );
  } else {
    requireCondition(
      attempt.predecessor_attempt_id !== null &&
      attempt.retry_trigger !== "initial" &&
      attempt.retry_not_before !== null,
      "MODEL_RETRY_ATTEMPT_BINDING_INVALID",
    );
  }

  requireCondition(
    attempt.cancel_requested_at === null &&
    attempt.late_result === false &&
    attempt.candidate_acceptance_eligible === true,
    "MODEL_CANDIDATE_INELIGIBLE",
  );
  requireCondition(attempt.output_merge_policy === "FORBID_CROSS_ATTEMPT_MERGE", "MODEL_CROSS_ATTEMPT_MERGE_FORBIDDEN");
  requireCondition(result.outcome === "succeeded" && result.error === null, "MODEL_PROVIDER_CALL_NOT_SUCCESSFUL");
  requireCondition(result.invocation_result_authority === "PROVIDER_CALL_OUTCOME_ONLY", "MODEL_RESULT_AUTHORITY_BOUNDARY_INVALID");
  requireCondition(result.business_receipt_boundary === "SEPARATE_ID_SCHEMA_OUTCOME_AND_STORAGE", "MODEL_BUSINESS_RECEIPT_BOUNDARY_INVALID");
  requireCondition(candidate.authority === "NON_AUTHORITATIVE_CANDIDATE", "MODEL_CANDIDATE_AUTHORITY_INVALID");
  requireCondition(candidate.canonical_status === "NOT_CANONICAL", "MODEL_CANDIDATE_CANONICAL_STATUS_INVALID");
  requireCondition(candidate.immutability === "IMMUTABLE_APPEND_ONLY", "MODEL_CANDIDATE_IMMUTABILITY_INVALID");
  requireCondition(candidate.lifecycle_projection_authority === "EVENT_DECISION_RECEIPT_ONLY", "MODEL_CANDIDATE_LIFECYCLE_AUTHORITY_INVALID");

  requireSame("MODEL_CANDIDATE_PROVENANCE_MISMATCH", "input_digest", request.input_digest, candidate.input_digest);
  requireSame("MODEL_CANDIDATE_PROVENANCE_MISMATCH", "output_digest", result.output_digest, candidate.output_digest);
  requireSame("MODEL_CANDIDATE_PROVENANCE_MISMATCH", "payload_ref", result.payload_ref, candidate.payload_ref);
  requireSame("MODEL_CANDIDATE_PROVENANCE_MISMATCH", "invocation_result_id", result.result_id, candidate.invocation_result_id);

  const started = dateValue(result.started_at, "result.started_at");
  const completed = dateValue(result.completed_at, "result.completed_at");
  const deadline = dateValue(request.deadline, "request.deadline");
  const stepDeadline = dateValue(request.step_deadline, "request.step_deadline");
  const leaseHardStop = dateValue(request.lease_hard_stop, "request.lease_hard_stop");
  const providerDeadline = dateValue(attempt.provider_deadline, "attempt.provider_deadline");
  const generated = dateValue(candidate.generated_at, "candidate.generated_at");
  const expires = dateValue(candidate.expires_at, "candidate.expires_at");

  requireSame("MODEL_TIMING_BINDING_MISMATCH", "started_at", attempt.started_at, result.started_at);
  requireSame("MODEL_TIMING_BINDING_MISMATCH", "completed_at", attempt.result_received_at, result.completed_at, candidate.generated_at);
  requireSame("MODEL_TIMING_BINDING_MISMATCH", "step_deadline", request.step_deadline, attempt.step_deadline);
  requireSame("MODEL_TIMING_BINDING_MISMATCH", "lease_hard_stop", request.lease_hard_stop, attempt.lease_hard_stop);
  requireCondition(started <= completed, "MODEL_TIME_ORDER_INVALID");
  requireCondition(completed <= deadline && completed <= providerDeadline && completed <= stepDeadline && completed <= leaseHardStop, "MODEL_DEADLINE_EXCEEDED");
  requireCondition(completed - started <= request.budgets.max_elapsed_ms, "MODEL_ELAPSED_BUDGET_EXCEEDED");
  requireCondition(generated === completed && expires > generated, "MODEL_CANDIDATE_LIFETIME_INVALID");

  return Object.freeze({
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
}
