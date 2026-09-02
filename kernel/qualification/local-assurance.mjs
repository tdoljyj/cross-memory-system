import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

const SHA256 = /^sha256:[0-9a-f]{64}$/;

export const PERF_TEST_IDS = Object.freeze([
  "PERF-01",
  "PERF-02",
  "PERF-03",
  "PERF-04",
  "PERF-05.a",
  "PERF-05.b",
  "PERF-06",
  "PERF-07",
  "PERF-08",
  "PERF-09",
  "PERF-10",
  "PERF-11",
]);

export const PRODUCTION_ONLY_TEST_IDS = Object.freeze([
  "SHD-01", "SHD-02", "SHD-03", "SHD-04",
  "CAN-01", "CAN-02", "CAN-03", "CAN-04", "CAN-05",
  "RBK-01", "RBK-02", "RBK-03",
  "RLT-01", "RLT-02",
]);

function invariant(condition, code) {
  if (!condition) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

export function contentDigest(value) {
  return "sha256:" + createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

function exactIds(actual, expected, code) {
  invariant(Array.isArray(actual), code + "_ARRAY_REQUIRED");
  invariant(new Set(actual).size === actual.length, code + "_DUPLICATE");
  const left = [...actual].sort();
  const right = [...expected].sort();
  invariant(left.length === right.length && left.every((value, index) => value === right[index]), code + "_SET_MISMATCH");
}

function requireDigest(value, code) {
  invariant(SHA256.test(value || ""), code);
}

export function validateLocalQualificationProfile(profile) {
  invariant(profile && profile.schema_version === "clued.local-v14-qualification-profile/1", "V14_PROFILE_SCHEMA");
  invariant(profile.frozen === true, "V14_PROFILE_NOT_FROZEN");
  invariant(profile.release_scope === "V15_LOCAL_RC_ONLY", "V14_SCOPE_NOT_LOCAL_RC");
  invariant(profile.environment === "isolated_local", "V14_ENVIRONMENT_NOT_ISOLATED_LOCAL");
  invariant(profile.network_access === false && profile.production_access === false, "V14_EXTERNAL_EFFECT_BOUNDARY");
  invariant(profile.incremental_cost_minor_units === 0, "V14_NONZERO_INCREMENTAL_COST");
  invariant(Number.isInteger(profile.deadline_seconds) && profile.deadline_seconds > 0 && profile.deadline_seconds <= 1800, "V14_DEADLINE_EXCEEDS_A30");
  for (const field of [
    "candidate_digest", "release_bom_digest", "tool_digest", "corpus_digest",
    "dictionary_digest", "seed_partition_digest", "security_profile_digest",
  ]) requireDigest(profile[field], "V14_" + field.toUpperCase() + "_REQUIRED");

  invariant(Array.isArray(profile.performance), "V14_PERFORMANCE_PROFILE_REQUIRED");
  exactIds(profile.performance.map((entry) => entry.test_id), PERF_TEST_IDS, "V14_PERF_IDS");
  for (const entry of profile.performance) {
    invariant(["REQUIRED", "N/A_WITH_PROOF"].includes(entry.disposition), "V14_PERF_DISPOSITION_INVALID");
    if (entry.disposition === "REQUIRED") {
      invariant(Number.isInteger(entry.iterations) && entry.iterations > 0, "V14_PERF_ITERATIONS_REQUIRED");
      invariant(Number.isFinite(entry.max_elapsed_ms) && entry.max_elapsed_ms > 0, "V14_PERF_MAX_ELAPSED_REQUIRED");
      invariant(Number.isFinite(entry.min_operations_per_second) && entry.min_operations_per_second > 0, "V14_PERF_MIN_RATE_REQUIRED");
      invariant(entry.max_unexpected_failures === 0, "V14_PERF_FAILURE_BUDGET_MUST_BE_ZERO");
    } else {
      requireDigest(entry.proof_digest, "V14_PERF_NA_PROOF_REQUIRED");
      invariant(typeof entry.reason_code === "string" && entry.reason_code.length > 0, "V14_PERF_NA_REASON_REQUIRED");
    }
  }

  invariant(Array.isArray(profile.target_families) && profile.target_families.length > 0, "V14_A30_TARGETS_REQUIRED");
  invariant(new Set(profile.target_families.map((target) => target.id)).size === profile.target_families.length, "V14_A30_TARGET_DUPLICATE");
  for (const target of profile.target_families) {
    invariant(typeof target.id === "string" && target.id.length > 0, "V14_A30_TARGET_ID_REQUIRED");
    invariant(Number.isInteger(target.minimum_executions) && target.minimum_executions > 0, "V14_A30_MIN_EXECUTIONS_REQUIRED");
    invariant(Array.isArray(target.expected_branches) && target.expected_branches.length > 0, "V14_A30_BRANCH_REGISTRY_REQUIRED");
    invariant(Array.isArray(target.expected_edges) && target.expected_edges.length > 0, "V14_A30_EDGE_REGISTRY_REQUIRED");
    invariant(new Set(target.expected_branches).size === target.expected_branches.length, "V14_A30_BRANCH_DUPLICATE");
    invariant(new Set(target.expected_edges).size === target.expected_edges.length, "V14_A30_EDGE_DUPLICATE");
  }
  invariant(Number.isFinite(profile.convergence_delta_max) && profile.convergence_delta_max >= 0, "V14_A30_CONVERGENCE_REQUIRED");
  return Object.freeze(structuredClone(profile));
}

export function measurePerformanceScenario(spec, execute) {
  invariant(spec && spec.disposition === "REQUIRED", "V14_PERF_REQUIRED_SPEC_EXPECTED");
  invariant(typeof execute === "function", "V14_PERF_EXECUTOR_REQUIRED");
  const outcomes = new Map();
  const unexpected = [];
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  for (let index = 0; index < spec.iterations; index += 1) {
    try {
      const outcome = execute(index);
      invariant(typeof outcome === "string" && outcome.length > 0, "V14_PERF_OUTCOME_REQUIRED");
      outcomes.set(outcome, (outcomes.get(outcome) || 0) + 1);
    } catch (error) {
      unexpected.push({ index, code: error?.code || error?.message || "UNCLASSIFIED_ERROR" });
    }
  }
  const elapsedMs = Math.max(performance.now() - started, 0.001);
  const heapAfter = process.memoryUsage().heapUsed;
  return Object.freeze({
    test_id: spec.test_id,
    disposition: "EXECUTED",
    operations: spec.iterations,
    elapsed_ms: Number(elapsedMs.toFixed(3)),
    operations_per_second: Number((spec.iterations / (elapsedMs / 1000)).toFixed(3)),
    heap_delta_bytes: Math.max(0, heapAfter - heapBefore),
    unexpected_failures: unexpected,
    outcomes: Object.fromEntries([...outcomes.entries()].sort(([left], [right]) => left.localeCompare(right))),
    external_effects: 0,
  });
}

export function qualifyPerformance(profileInput, observations) {
  const profile = validateLocalQualificationProfile(profileInput);
  invariant(Array.isArray(observations), "V14_PERF_OBSERVATIONS_REQUIRED");
  invariant(new Set(observations.map((item) => item.test_id)).size === observations.length, "V14_PERF_OBSERVATION_DUPLICATE");
  const byId = new Map(observations.map((item) => [item.test_id, item]));
  const results = [];
  for (const spec of profile.performance) {
    if (spec.disposition === "N/A_WITH_PROOF") {
      results.push({ test_id: spec.test_id, status: "N/A_WITH_PROOF", proof_digest: spec.proof_digest, reason_code: spec.reason_code });
      continue;
    }
    const observed = byId.get(spec.test_id);
    invariant(observed, "V14_PERF_OBSERVATION_MISSING_" + spec.test_id);
    invariant(observed.operations === spec.iterations, "V14_PERF_EXECUTION_COUNT_MISMATCH_" + spec.test_id);
    invariant(observed.external_effects === 0, "V14_PERF_EXTERNAL_EFFECT_" + spec.test_id);
    invariant(observed.unexpected_failures.length <= spec.max_unexpected_failures, "V14_PERF_UNEXPECTED_FAILURE_" + spec.test_id);
    invariant(observed.elapsed_ms <= spec.max_elapsed_ms, "V14_PERF_ELAPSED_THRESHOLD_" + spec.test_id);
    invariant(observed.operations_per_second >= spec.min_operations_per_second, "V14_PERF_RATE_THRESHOLD_" + spec.test_id);
    results.push({ test_id: spec.test_id, status: "PASS", observed });
  }
  return Object.freeze({
    profile_digest: contentDigest(profile),
    candidate_digest: profile.candidate_digest,
    status: "PASS",
    tests: results,
    pass_count: results.filter((item) => item.status === "PASS").length,
    not_applicable_count: results.filter((item) => item.status === "N/A_WITH_PROOF").length,
    authority_effect: "NONE",
  });
}

function percent(numerator, denominator) {
  return denominator === 0 ? 100 : Number(((numerator / denominator) * 100).toFixed(6));
}

export function buildA30AssuranceManifest(profileInput, runs, elapsedSeconds) {
  const profile = validateLocalQualificationProfile(profileInput);
  invariant(Array.isArray(runs), "V14_A30_RUNS_REQUIRED");
  exactIds(runs.map((run) => run.id), profile.target_families.map((target) => target.id), "V14_A30_RUN_IDS");
  invariant(Number.isFinite(elapsedSeconds) && elapsedSeconds >= 0 && elapsedSeconds <= profile.deadline_seconds, "V14_A30_ELAPSED_INVALID");
  const runById = new Map(runs.map((run) => [run.id, run]));
  const targetFamilies = [];
  const aggregateWindows = [0, 1, 2].map(() => ({ executions: 0, coverage_delta: 0 }));
  let unresolved = 0;
  let lastTwenty = 0;

  for (const target of profile.target_families) {
    const run = runById.get(target.id);
    invariant(Array.isArray(run.windows) && run.windows.length === 3, "V14_A30_THREE_WINDOWS_REQUIRED_" + target.id);
    invariant(run.windows.every((window) => Number.isInteger(window.executions) && window.executions === run.windows[0].executions && window.executions > 0), "V14_A30_WINDOWS_NOT_EQUAL_" + target.id);
    const observedBranches = new Set();
    const observedEdges = new Set();
    for (const [windowIndex, window] of run.windows.entries()) {
      invariant(Array.isArray(window.observed_branches) && Array.isArray(window.observed_edges), "V14_A30_WINDOW_COVERAGE_REQUIRED_" + target.id);
      window.observed_branches.forEach((item) => observedBranches.add(item));
      window.observed_edges.forEach((item) => observedEdges.add(item));
      invariant(Number.isInteger(window.unexpected_unique_crashes) && window.unexpected_unique_crashes >= 0, "V14_A30_CRASH_COUNT_INVALID_" + target.id);
      unresolved += window.unexpected_unique_crashes;
      aggregateWindows[windowIndex].executions += window.executions;
      const branchWindow = percent(new Set(window.observed_branches.filter((item) => target.expected_branches.includes(item))).size, target.expected_branches.length);
      const edgeWindow = percent(new Set(window.observed_edges.filter((item) => target.expected_edges.includes(item))).size, target.expected_edges.length);
      aggregateWindows[windowIndex].coverage_delta = Math.max(aggregateWindows[windowIndex].coverage_delta, 100 - Math.min(branchWindow, edgeWindow));
    }
    const actualExecutions = run.windows.reduce((sum, window) => sum + window.executions, 0);
    const branchCount = target.expected_branches.filter((item) => observedBranches.has(item)).length;
    const edgeCount = target.expected_edges.filter((item) => observedEdges.has(item)).length;
    invariant(Number.isInteger(run.last_twenty_percent_new_unresolved_crashes) && run.last_twenty_percent_new_unresolved_crashes >= 0, "V14_A30_LAST_TWENTY_INVALID_" + target.id);
    lastTwenty += run.last_twenty_percent_new_unresolved_crashes;
    targetFamilies.push({
      id: target.id,
      minimum_executions: target.minimum_executions,
      actual_executions: actualExecutions,
      minimum_branch_coverage: 100,
      actual_branch_coverage: percent(branchCount, target.expected_branches.length),
      minimum_edge_coverage: 100,
      actual_edge_coverage: percent(edgeCount, target.expected_edges.length),
      coverage_basis: "explicit_contract_outcome_and_transition_registry",
      branch_registry_digest: contentDigest(target.expected_branches),
      edge_registry_digest: contentDigest(target.expected_edges),
    });
  }

  invariant(aggregateWindows.every((window) => window.executions === aggregateWindows[0].executions), "V14_A30_AGGREGATE_WINDOWS_NOT_EQUAL");
  return Object.freeze({
    schema_version: "clued.fuzz-assurance-manifest/1",
    frozen: true,
    execution_profile: "A30",
    release_scope: "V15_LOCAL_RC_ONLY",
    candidate_digest: profile.candidate_digest,
    tool_digest: profile.tool_digest,
    corpus_digest: profile.corpus_digest,
    security_profile_digest: profile.security_profile_digest,
    dictionary_digest: profile.dictionary_digest,
    seed_partition_digest: profile.seed_partition_digest,
    deadline_seconds: profile.deadline_seconds,
    elapsed_seconds: elapsedSeconds,
    target_families: targetFamilies,
    equal_windows: aggregateWindows,
    convergence_delta_max: profile.convergence_delta_max,
    last_twenty_percent_new_unresolved_crashes: lastTwenty,
    unresolved_unique_crashes: unresolved,
    external_network_requests: 0,
    production_targets: 0,
    incremental_cost_minor_units: 0,
    authority_effect: "NONE",
  });
}

export function productionOnlyBoundary() {
  return PRODUCTION_ONLY_TEST_IDS.map((testId) => Object.freeze({
    test_id: testId,
    status: "NOT_EXECUTED_PRODUCTION_ONLY",
    credited_to_v14_or_v15: false,
    authority_effect: "NONE",
  }));
}

export function validateProductionOnlyBoundary(entries) {
  invariant(Array.isArray(entries), "PRODUCTION_SUITE_BOUNDARY_REQUIRED");
  exactIds(entries.map((entry) => entry.test_id), PRODUCTION_ONLY_TEST_IDS, "PRODUCTION_SUITE_IDS");
  for (const entry of entries) {
    invariant(entry.status === "NOT_EXECUTED_PRODUCTION_ONLY", "PRODUCTION_SUITE_FALSE_EXECUTION_CLAIM");
    invariant(entry.credited_to_v14_or_v15 === false && entry.authority_effect === "NONE", "PRODUCTION_SUITE_FALSE_CREDIT");
  }
  return Object.freeze({ valid: true, tests: entries.length, authority_effect: "NONE" });
}

export const V15_STAGE_IDS = Object.freeze([
  "G0b", "CONTRACT_TOOLCHAIN", "G1", "V00", "V01", "V01A", "V02", "V03", "V04", "V05",
  "V06-L", "V06-W", "V07", "V08", "V09", "V10", "V11", "V12", "V13", "V14",
]);
export const V15_NA_STAGE_IDS = Object.freeze(["V06-W", "V09", "V13"]);
export const V15_MODEL_RULE_IDS = Object.freeze([
  "MODEL-BOUNDARY-01", "MODEL-OPTIONAL-01", "MODEL-CANDIDATE-01", "MODEL-CANONICAL-01",
  "MODEL-GATE-01", "MODEL-PROVENANCE-01", "MODEL-MIN-DISCLOSURE-01", "MODEL-NO-TRAINING-01",
  "MODEL-SECRET-01", "MODEL-BUDGET-01", "MODEL-DEADLINE-01", "MODEL-IDEMPOTENCY-01",
  "MODEL-FAILSAFE-01", "MODEL-DRIFT-01", "MODEL-PROJECTION-01", "MODEL-AUDIT-01",
]);
export const V15_CI_IDS = Object.freeze(Array.from({ length: 102 }, (_, index) => "CI-" + String(index + 1).padStart(2, "0")));
export const V15_EIA_IDS = Object.freeze(Array.from({ length: 50 }, (_, index) => "EIA-" + String(index + 1).padStart(2, "0")));
export const V15_EAT_IDS = Object.freeze(Array.from({ length: 10 }, (_, index) => "EAT-" + String(index + 1).padStart(2, "0")));

function validateAggregateResults(entries, expected, prefix) {
  invariant(Array.isArray(entries), prefix + "_RESULTS_REQUIRED");
  exactIds(entries.map((entry) => entry.test_id), expected, prefix + "_IDS");
  for (const entry of entries) {
    invariant(["PASS", "N/A_WITH_PROOF"].includes(entry.status), prefix + "_STATUS_INVALID");
    requireDigest(entry.evidence_sha256, prefix + "_EVIDENCE_REQUIRED");
    if (entry.status === "N/A_WITH_PROOF") requireDigest(entry.na_proof_sha256, prefix + "_NA_PROOF_REQUIRED");
  }
  return Object.freeze({
    total: entries.length,
    pass: entries.filter((entry) => entry.status === "PASS").length,
    not_applicable: entries.filter((entry) => entry.status === "N/A_WITH_PROOF").length,
  });
}

function validateAggregateStages(input) {
  invariant(Array.isArray(input.stage_receipts), "V15_STAGE_RECEIPTS_REQUIRED");
  exactIds(input.stage_receipts.map((entry) => entry.stage_id), V15_STAGE_IDS, "V15_STAGE_IDS");
  for (const entry of input.stage_receipts) {
    const naAllowed = V15_NA_STAGE_IDS.includes(entry.stage_id);
    invariant(entry.disposition === "PASS" || (naAllowed && entry.disposition === "N/A_WITH_PROOF"), "V15_STAGE_DISPOSITION_INVALID_" + entry.stage_id);
    requireDigest(entry.wpr_sha256, "V15_STAGE_WPR_REQUIRED_" + entry.stage_id);
    requireDigest(entry.final_rebind_sha256, "V15_STAGE_REBIND_REQUIRED_" + entry.stage_id);
    invariant(entry.candidate_digest === input.candidate_digest, "V15_STAGE_CANDIDATE_DRIFT_" + entry.stage_id);
    invariant(entry.authority_effect === "NONE", "V15_STAGE_AUTHORITY_EFFECT_" + entry.stage_id);
    if (entry.disposition === "N/A_WITH_PROOF") {
      requireDigest(entry.na_proof_sha256, "V15_STAGE_NA_PROOF_REQUIRED_" + entry.stage_id);
      requireDigest(entry.applicability_proof?.minimum_profile_digest, "V15_STAGE_NA_MINIMUM_PROFILE_REQUIRED_" + entry.stage_id);
      requireDigest(entry.applicability_proof?.final_release_bom_digest, "V15_STAGE_NA_FINAL_BOM_REQUIRED_" + entry.stage_id);
      requireDigest(entry.applicability_proof?.runtime_path_scan_sha256, "V15_STAGE_NA_PATH_SCAN_REQUIRED_" + entry.stage_id);
      invariant(entry.applicability_proof.runtime_entrypoints_found === 0, "V15_STAGE_NA_RUNTIME_ENTRYPOINT_PRESENT_" + entry.stage_id);
    }
  }
}

function validateAggregateBindings(input) {
  invariant(input.common_bindings && typeof input.common_bindings === "object", "V15_COMMON_BINDINGS_REQUIRED");
  for (const field of [
    "artifact_digest", "release_bom_digest", "requirement_trace_digest", "policy_digest",
    "fixture_digest", "observability_profile_digest", "release_risk_manifest_digest",
    "v01a_core_digest", "v01a_experience_policy_digest", "v01a_capability_model_digest",
    "v01a_adapter_index_digest",
  ]) requireDigest(input.common_bindings[field], "V15_BINDING_" + field.toUpperCase() + "_REQUIRED");
  invariant(input.common_bindings.artifact_digest === input.candidate_digest, "V15_ARTIFACT_CANDIDATE_DRIFT");
}

function validateAggregatePrerequisites(input) {
  const supply = input.prerequisites?.v12_real_supply_chain_evidence;
  invariant(supply?.status === "PASS", "V15_V12_REAL_SUPPLY_CHAIN_EVIDENCE_PENDING");
  requireDigest(supply.syft_sbom_sha256, "V15_V12_SYFT_SBOM_REQUIRED");
  requireDigest(supply.cosign_verification_sha256, "V15_V12_COSIGN_VERIFICATION_REQUIRED");
  requireDigest(supply.oras_descriptor_sha256, "V15_V12_ORAS_DESCRIPTOR_REQUIRED");
}

function validateAggregateG7A(input) {
  const value = input.g7a;
  invariant(value?.gate_id === "G7A", "V15_G7A_REQUIRED");
  invariant(value.result === "PASS" && value.aggregate_instance_count === 1, "V15_G7A_UNIQUE_PASS_REQUIRED");
  requireDigest(value.authorization_sha256, "V15_G7A_AUTHORIZATION_REQUIRED");
  requireDigest(value.result_sha256, "V15_G7A_RESULT_REQUIRED");
  invariant(value.authorization_sha256 !== value.result_sha256 && value.authorization_result_distinct === true, "V15_G7A_AUTH_RESULT_NOT_DISTINCT");
  invariant(value.perf_s_result === "PASS" && value.perf_q_result === "PASS", "V15_PERF_S_Q_PASS_REQUIRED");
  invariant(["PASS", "N/A_WITH_PROOF"].includes(value.mig_q_result), "V15_MIG_Q_DISPOSITION_INVALID");
  if (value.mig_q_result === "N/A_WITH_PROOF") requireDigest(value.mig_q_proof_sha256, "V15_MIG_Q_NA_PROOF_REQUIRED");
  invariant(value.rc_candidate_digest === input.candidate_digest, "V15_RC_CANDIDATE_DRIFT");
  requireDigest(value.rc_manifest_sha256, "V15_RC_MANIFEST_REQUIRED");
  invariant(value.rc_byte_identity === true && value.candidate_sealed_before_aggregate === true, "V15_RC_BYTE_IDENTITY_REQUIRED");
}

export function validateV15AggregateInput(input) {
  invariant(input?.schema_version === "clued.v15.aggregate-input/1", "V15_AGGREGATE_INPUT_SCHEMA");
  invariant(input.claim === "LOCAL_RC_ONLY", "V15_PRODUCTION_CLAIM_FORBIDDEN");
  invariant(input.production_authorized === false && input.authoritative_gate_result === false, "V15_AUTHORITY_CLAIM_FORBIDDEN");
  requireDigest(input.candidate_digest, "V15_CANDIDATE_DIGEST_REQUIRED");
  validateAggregateBindings(input);
  validateAggregateStages(input);
  validateAggregatePrerequisites(input);
  const coverage = Object.freeze({
    ci: validateAggregateResults(input.coverage?.ci, V15_CI_IDS, "V15_CI"),
    eia: validateAggregateResults(input.coverage?.eia, V15_EIA_IDS, "V15_EIA"),
    model: validateAggregateResults(input.coverage?.model, V15_MODEL_RULE_IDS, "V15_MODEL"),
    performance: validateAggregateResults(input.specialized?.performance, PERF_TEST_IDS, "V15_PERF"),
    eat: validateAggregateResults(input.specialized?.eat, V15_EAT_IDS, "V15_EAT"),
  });
  invariant(input.coverage.primary_duplicates === 0 && input.coverage.primary_gaps === 0, "V15_PRIMARY_COVERAGE_NOT_EXACT");
  invariant(input.failed_blocked_stale_count === 0, "V15_FAILED_BLOCKED_STALE_NONZERO");
  invariant(input.retracted_claims?.active_reference_count === 0, "V15_RETRACTED_CLAIM_STILL_ACTIVE");
  requireDigest(input.retracted_claims?.scan_sha256, "V15_RETRACTED_CLAIM_SCAN_REQUIRED");
  validateProductionOnlyBoundary(input.production_only_suites);
  validateAggregateG7A(input);
  return Object.freeze({
    schema_version: "clued.v15.local-aggregate-receipt/1-draft",
    object_type: "V15LocalAggregateReceipt",
    stage: "V15",
    status: "PASS",
    claim: "LOCAL_RC_ONLY",
    candidate_digest: input.candidate_digest,
    common_bindings: structuredClone(input.common_bindings),
    stage_receipt_count: input.stage_receipts.length,
    coverage,
    g7a: Object.freeze({
      gate_id: "G7A",
      result: "PASS",
      authorization_sha256: input.g7a.authorization_sha256,
      result_sha256: input.g7a.result_sha256,
      rc_manifest_sha256: input.g7a.rc_manifest_sha256,
    }),
    production_only_suite_status: "NOT_EXECUTED_PRODUCTION_ONLY",
    production_only_suite_count: input.production_only_suites.length,
    input_digest: contentDigest(input),
    authority_effect: "NONE",
    authoritative_gate_result: false,
    production_authorized: false,
  });
}

export const V15_LOCAL_AGGREGATE_RECEIPT_DRAFT_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:clued:eval-draft:v15-local-aggregate-receipt:1",
  title: "V15 Local Aggregate Receipt Draft",
  description: "Non-authoritative local-RC receipt; not a v3.3 GateResultReceipt and not production authorization.",
  type: "object",
  required: [
    "schema_version", "object_type", "stage", "status", "claim", "candidate_digest",
    "stage_receipt_count", "coverage", "g7a", "input_digest", "authority_effect",
    "authoritative_gate_result", "production_authorized",
  ],
  properties: {
    schema_version: { const: "clued.v15.local-aggregate-receipt/1-draft" },
    object_type: { const: "V15LocalAggregateReceipt" },
    stage: { const: "V15" },
    status: { const: "PASS" },
    claim: { const: "LOCAL_RC_ONLY" },
    candidate_digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    stage_receipt_count: { const: 20 },
    authority_effect: { const: "NONE" },
    authoritative_gate_result: { const: false },
    production_authorized: { const: false },
  },
});
