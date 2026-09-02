import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryOperationCommitStore } from "../../kernel/domain/operation-commit.mjs";
import { CheckpointPointerStore, negotiateProtocol } from "../../kernel/runtime/continuity-runtime.mjs";
import { InMemoryDurableOutbox, scrubEvidence } from "../../kernel/runtime/durable-outbox-evidence.mjs";
import { validateArchiveEntries } from "../../kernel/policy/archive-import-applicability.mjs";
import { validateFuzzManifest } from "../../kernel/policy/observation-manifest.mjs";
import {
  PERF_TEST_IDS,
  V15_CI_IDS,
  V15_EAT_IDS,
  V15_EIA_IDS,
  V15_LOCAL_AGGREGATE_RECEIPT_DRAFT_SCHEMA,
  V15_MODEL_RULE_IDS,
  V15_NA_STAGE_IDS,
  V15_STAGE_IDS,
  buildA30AssuranceManifest,
  contentDigest,
  measurePerformanceScenario,
  productionOnlyBoundary,
  qualifyPerformance,
  validateLocalQualificationProfile,
  validateProductionOnlyBoundary,
  validateV15AggregateInput,
} from "../../kernel/qualification/local-assurance.mjs";
const D = (character) => "sha256:" + character.repeat(64);
const REQUIRED_PERF = new Set(["PERF-01", "PERF-02", "PERF-03", "PERF-04", "PERF-05.a", "PERF-07", "PERF-08", "PERF-11"]);
const CASES = Object.freeze({
  "protocol-parser": [
    ["exact", "NEGOTIATED"], ["major", "PROTOCOL_MAJOR_UNSUPPORTED"],
    ["downgrade", "PROTOCOL_DOWNGRADE_NOT_AUTHORIZED"], ["profile", "PROFILE_NO_COMMON_VERSION"],
    ["schema", "SCHEMA_NO_COMMON_VERSION"], ["invalid", "NEGOTIATION_INPUT_INVALID"],
  ],
  "runner-ipc": [
    ["accepted", "ACCEPTED"], ["replay", "REPLAY"], ["drift", "OUTBOX_ID_HASH_CONFLICT"],
    ["incomplete", "ACTION_INTENT_INCOMPLETE"], ["not-durable", "ACTION_INTENT_NOT_DURABLE"],
    ["secret", "JOURNAL_SECRET_FORBIDDEN"], ["backpressure", "OUTBOX_BACKPRESSURE"],
  ],
  "archive-file-boundary": [
    ["accepted", "ACCEPTED"], ["absolute", "ARCHIVE_ABSOLUTE_PATH"],
    ["ambiguous", "ARCHIVE_PATH_AMBIGUOUS"], ["collision", "ARCHIVE_NORMALIZATION_COLLISION"],
    ["special", "ARCHIVE_SPECIAL_OBJECT_REJECTED"], ["expansion", "ARCHIVE_EXPANSION_BUDGET_EXCEEDED"],
    ["entry-budget", "ARCHIVE_ENTRY_BUDGET_EXCEEDED"],
  ],
});

function v14Profile() {
  const reasons = {
    "PERF-05.b": "SCREENSHOT_OCR_CAPABILITY_OMITTED_FROM_LOCAL_RC_PROFILE",
    "PERF-06": "ENTERPRISE_PROFILE_OMITTED_FROM_LOCAL_RC_PROFILE",
    "PERF-09": "PUBLIC_CLOUD_PROFILE_OMITTED_FROM_LOCAL_RC_PROFILE",
    "PERF-10": "PUBLIC_OAUTH_DCR_PROFILE_OMITTED_FROM_LOCAL_RC_PROFILE",
  };
  return {
    schema_version: "clued.local-v14-qualification-profile/1",
    frozen: true,
    release_scope: "V15_LOCAL_RC_ONLY",
    environment: "isolated_local",
    network_access: false,
    production_access: false,
    incremental_cost_minor_units: 0,
    deadline_seconds: 1800,
    candidate_digest: D("1"), release_bom_digest: D("2"), tool_digest: D("3"),
    corpus_digest: D("4"), dictionary_digest: D("5"), seed_partition_digest: D("6"),
    security_profile_digest: D("7"), convergence_delta_max: 0,
    performance: PERF_TEST_IDS.map((testId) => REQUIRED_PERF.has(testId) ? {
      test_id: testId, disposition: "REQUIRED", iterations: 30,
      max_elapsed_ms: 10000, min_operations_per_second: 1, max_unexpected_failures: 0,
    } : {
      test_id: testId, disposition: "N/A_WITH_PROOF", reason_code: reasons[testId],
      proof_digest: contentDigest({ test_id: testId, reason: reasons[testId], candidate: D("1"), bom: D("2") }),
    }),
    target_families: Object.entries(CASES).map(([id, cases]) => ({
      id,
      minimum_executions: cases.length * 3,
      expected_branches: cases.map((item) => item[1]),
      expected_edges: cases.map((item) => item[0] + "->" + item[1]),
    })),
  };
}

const INTENT = Object.freeze({
  outbox_event_id: "outbox-1", tenant_id: "tenant-1", attempt_id: "attempt-1",
  action_id: "action-1", plan_hash: D("1"), segment_hash: D("2"), lease_id: "lease-1",
  lease_version: 1, fencing_stream_id: "stream-1", fencing_token: 1, ownership_epoch: 1,
  target_idempotency_key: "idem-1", expected_commit_boundary: "accepted", durable_barrier_passed: true,
});
const ARCHIVE_BUDGET = Object.freeze({
  max_entries: 4, max_entry_bytes: 1024, max_compressed_bytes: 2048,
  max_expanded_bytes: 4096, max_compression_ratio: 10, max_depth: 4,
  sandbox_profile: "isolated-local-v14",
});
const ENTRY = Object.freeze({
  path: "safe/item.txt", type: "regular", compressed_size: 10,
  expanded_size: 20, content_digest: D("8"),
});

function performanceExecutors() {
  const plans = new InMemoryOperationCommitStore();
  const ledger = new InMemoryOperationCommitStore();
  const pointer = new CheckpointPointerStore();
  const outbox = new InMemoryDurableOutbox({ max_outbox_bytes: 1000000, reserved_bytes: 1024 });
  return {
    "PERF-01": (index) => {
      plans.commit({
        operation_id: "plan-op-" + index, aggregate_id: "plan-" + index, expected_version: 0,
        next_state: { compiled: true }, event: { type: "PLAN_COMPILED" },
        receipt_stub: { receipt_id: "plan-receipt-" + index },
        outbox: [{ message_id: "plan-message-" + index, topic: "plan" }],
      });
      return "COMPILE_COMMIT_REPORT";
    },
    "PERF-02": (index) => {
      const value = { ...INTENT, outbox_event_id: "outbox-" + index, action_id: "action-" + index, target_idempotency_key: "idem-" + index };
      if (outbox.beginAction(value).replay || !outbox.beginAction(value).replay) throw new Error("OUTBOX_REPLAY_INVARIANT");
      return "HEARTBEAT_LEASE_OUTBOX_DEDUP";
    },
    "PERF-03": (index) => {
      ledger.commit({
        operation_id: "ledger-op-" + index, aggregate_id: "ledger", expected_version: index,
        next_state: { progress: index + 1 }, event: { type: "PROGRESS" },
        receipt_stub: { receipt_id: "ledger-receipt-" + index }, outbox: [],
      });
      return "LEDGER_APPEND";
    },
    "PERF-04": (index) => {
      const value = D((index % 10).toString());
      pointer.casPointer({ expected_version: index, next_version: index + 1, digest: value, readback_digest: value });
      return "SNAPSHOT_POINTER_CAS";
    },
    "PERF-05.a": (index) => {
      const secret = "secret-" + index;
      const result = scrubEvidence({ access_token: secret, message: "value=" + secret }, { max_input_bytes: 4096, max_secret_patterns: 4, secret_patterns: [secret] });
      if (result.evidence_status !== "complete" || JSON.stringify(result).includes(secret)) throw new Error("SCRUB_INVARIANT");
      return "SCRUBBED";
    },
    "PERF-07": (index) => {
      const journal = new InMemoryDurableOutbox({ max_outbox_bytes: 10000, reserved_bytes: 100 });
      journal.beginAction({ ...INTENT, outbox_event_id: "queue-" + index, action_id: "queue-action-" + index, target_idempotency_key: "queue-idem-" + index });
      return "QUEUE_RETRY_BOUNDED";
    },
    "PERF-08": (index) => {
      validateArchiveEntries([{ ...ENTRY, path: "safe/item-" + index + ".txt" }], ARCHIVE_BUDGET);
      return "IMPORT_UNIT_VALIDATED";
    },
    "PERF-11": (index) => {
      try {
        if (index % 3 === 0) new CheckpointPointerStore().casPointer({ expected_version: 0, next_version: 1, digest: D("1"), readback_digest: D("2") });
        else if (index % 3 === 1) validateArchiveEntries([{ ...ENTRY, symlink: true }], ARCHIVE_BUDGET);
        else new InMemoryDurableOutbox({ max_outbox_bytes: 64, reserved_bytes: 63 }).beginAction(INTENT);
      } catch (error) {
        if (["POINTER_READBACK_MISMATCH", "ARCHIVE_SPECIAL_OBJECT_REJECTED", "OUTBOX_BACKPRESSURE"].includes(error.code)) return "FAULT_REJECTED_" + error.code;
        throw error;
      }
      throw new Error("FAULT_NOT_REJECTED");
    },
  };
}

function protocolOutcome(id) {
  const inputs = {
    exact: { client: { majors: [1], profiles: ["1"], schemas: ["1"] }, server: { majors: [1], profiles: ["1"], schemas: ["1"] } },
    major: { client: { majors: [1], profiles: ["1"], schemas: ["1"] }, server: { majors: [2], profiles: ["1"], schemas: ["1"] } },
    downgrade: { client: { majors: [1, 2], preferred_major: 2, allow_downgrade: false, profiles: ["1"], schemas: ["1"] }, server: { majors: [1], profiles: ["1"], schemas: ["1"] } },
    profile: { client: { majors: [1], profiles: ["1"], schemas: ["1"] }, server: { majors: [1], profiles: ["2"], schemas: ["1"] } },
    schema: { client: { majors: [1], profiles: ["1"], schemas: ["1"] }, server: { majors: [1], profiles: ["1"], schemas: ["2"] } },
    invalid: { client: null, server: { majors: [1], profiles: ["1"], schemas: ["1"] } },
  };
  try { negotiateProtocol(inputs[id]); return "NEGOTIATED"; }
  catch (error) { return error.code || error.message; }
}

function outboxOutcome(id) {
  const journal = new InMemoryDurableOutbox(id === "backpressure" ? { max_outbox_bytes: 64, reserved_bytes: 63 } : { max_outbox_bytes: 10000, reserved_bytes: 100 });
  try {
    if (id === "accepted") journal.beginAction(INTENT);
    else if (id === "replay") { journal.beginAction(INTENT); if (!journal.beginAction(INTENT).replay) throw new Error("REPLAY_NOT_DETECTED"); }
    else if (id === "drift") { journal.beginAction(INTENT); journal.beginAction({ ...INTENT, action_id: "changed" }); }
    else if (id === "incomplete") { const value = { ...INTENT }; delete value.plan_hash; journal.beginAction(value); }
    else if (id === "not-durable") journal.beginAction({ ...INTENT, durable_barrier_passed: false });
    else if (id === "secret") journal.beginAction({ ...INTENT, access_token: "forbidden" });
    else journal.beginAction(INTENT);
    return id === "replay" ? "REPLAY" : "ACCEPTED";
  } catch (error) { return error.code || error.message; }
}

function archiveOutcome(id) {
  let entries;
  if (id === "accepted") entries = [ENTRY];
  else if (id === "absolute") entries = [{ ...ENTRY, path: "C:/escape.txt" }];
  else if (id === "ambiguous") entries = [{ ...ENTRY, path: "safe/../escape.txt" }];
  else if (id === "collision") entries = [ENTRY, { ...ENTRY, path: "SAFE/ITEM.TXT" }];
  else if (id === "special") entries = [{ ...ENTRY, symlink: true }];
  else if (id === "expansion") entries = [{ ...ENTRY, compressed_size: 1, expanded_size: 100 }];
  else entries = Array.from({ length: 5 }, (_, index) => ({ ...ENTRY, path: "safe/" + index + ".txt" }));
  try { validateArchiveEntries(entries, ARCHIVE_BUDGET); return "ACCEPTED"; }
  catch (error) { return error.code || error.message; }
}

function fuzzRun(id, executor) {
  const cases = CASES[id];
  const makeWindow = () => {
    const branches = new Set(), edges = new Set();
    let crashes = 0;
    for (const [caseId, expected] of cases) {
      const actual = executor(caseId);
      branches.add(actual); edges.add(caseId + "->" + actual);
      if (actual !== expected) crashes += 1;
    }
    return { executions: cases.length, observed_branches: [...branches], observed_edges: [...edges], unexpected_unique_crashes: crashes };
  };
  return { id, windows: [makeWindow(), makeWindow(), makeWindow()], last_twenty_percent_new_unresolved_crashes: 0 };
}

function resultRows(ids, na = new Set()) {
  return ids.map((testId) => na.has(testId) ? {
    test_id: testId, status: "N/A_WITH_PROOF", evidence_sha256: D("a"), na_proof_sha256: D("b"),
  } : { test_id: testId, status: "PASS", evidence_sha256: D("a") });
}

function v15Input() {
  const candidate = D("1");
  return {
    schema_version: "clued.v15.aggregate-input/1",
    claim: "LOCAL_RC_ONLY",
    production_authorized: false,
    authoritative_gate_result: false,
    candidate_digest: candidate,
    common_bindings: {
      artifact_digest: candidate, release_bom_digest: D("2"), requirement_trace_digest: D("3"),
      policy_digest: D("4"), fixture_digest: D("5"), observability_profile_digest: D("6"),
      release_risk_manifest_digest: D("7"), v01a_core_digest: D("8"),
      v01a_experience_policy_digest: D("9"), v01a_capability_model_digest: D("a"),
      v01a_adapter_index_digest: D("b"),
    },
    stage_receipts: V15_STAGE_IDS.map((stageId) => {
      const notApplicable = V15_NA_STAGE_IDS.includes(stageId);
      return {
        stage_id: stageId,
        disposition: notApplicable ? "N/A_WITH_PROOF" : "PASS",
        wpr_sha256: D("c"), final_rebind_sha256: D("d"), candidate_digest: candidate,
        authority_effect: "NONE",
        ...(notApplicable ? {
          na_proof_sha256: D("e"),
          applicability_proof: {
            minimum_profile_digest: D("f"), final_release_bom_digest: D("2"),
            runtime_path_scan_sha256: D("0"), runtime_entrypoints_found: 0,
          },
        } : {}),
      };
    }),
    prerequisites: {
      v12_real_supply_chain_evidence: {
        status: "PASS", syft_sbom_sha256: D("1"),
        cosign_verification_sha256: D("2"), oras_descriptor_sha256: D("3"),
      },
    },
    coverage: {
      ci: resultRows(V15_CI_IDS), eia: resultRows(V15_EIA_IDS), model: resultRows(V15_MODEL_RULE_IDS),
      primary_duplicates: 0, primary_gaps: 0,
    },
    specialized: {
      performance: resultRows(PERF_TEST_IDS, new Set(["PERF-05.b", "PERF-06", "PERF-09", "PERF-10"])),
      eat: resultRows(V15_EAT_IDS),
    },
    failed_blocked_stale_count: 0,
    retracted_claims: { active_reference_count: 0, scan_sha256: D("4") },
    production_only_suites: productionOnlyBoundary(),
    g7a: {
      gate_id: "G7A", result: "PASS", aggregate_instance_count: 1,
      authorization_sha256: D("5"), result_sha256: D("6"), authorization_result_distinct: true,
      perf_s_result: "PASS", perf_q_result: "PASS", mig_q_result: "N/A_WITH_PROOF",
      mig_q_proof_sha256: D("7"), rc_candidate_digest: candidate,
      rc_manifest_sha256: D("8"), rc_byte_identity: true, candidate_sealed_before_aggregate: true,
    },
  };
}

test("V14 exact PERF instances execute locally with machine N/A proofs and zero effect", () => {
  const profile = validateLocalQualificationProfile(v14Profile());
  const executors = performanceExecutors();
  const observations = profile.performance.filter((entry) => entry.disposition === "REQUIRED")
    .map((entry) => measurePerformanceScenario(entry, executors[entry.test_id]));
  const result = qualifyPerformance(profile, observations);
  assert.equal(result.status, "PASS");
  assert.equal(result.pass_count, 8);
  assert.equal(result.not_applicable_count, 4);
});

test("CI-70 A30 exercises parser IPC and file boundaries in three equal converged windows", () => {
  const manifest = buildA30AssuranceManifest(v14Profile(), [
    fuzzRun("protocol-parser", protocolOutcome),
    fuzzRun("runner-ipc", outboxOutcome),
    fuzzRun("archive-file-boundary", archiveOutcome),
  ], 1);
  assert.equal(validateFuzzManifest(manifest).valid, true);
  assert.equal(manifest.target_families.every((item) => item.actual_branch_coverage === 100 && item.actual_edge_coverage === 100), true);
  assert.equal(manifest.unresolved_unique_crashes, 0);
});

test("A30 unexpected crash and production-suite false credit fail closed", () => {
  const bad = fuzzRun("protocol-parser", protocolOutcome);
  bad.windows[2].unexpected_unique_crashes = 1;
  const manifest = buildA30AssuranceManifest(v14Profile(), [bad, fuzzRun("runner-ipc", outboxOutcome), fuzzRun("archive-file-boundary", archiveOutcome)], 1);
  assert.throws(() => validateFuzzManifest(manifest), /FUZZ_UNRESOLVED_CRASHES_NONZERO/);
  const boundary = productionOnlyBoundary();
  assert.equal(validateProductionOnlyBoundary(boundary).tests, 14);
  assert.throws(() => validateProductionOnlyBoundary(boundary.map((item, index) => index === 0 ? { ...item, status: "PASS" } : item)), /PRODUCTION_SUITE_FALSE_EXECUTION_CLAIM/);
});

test("V15 aggregate closes exact predecessors and coverage only on one final candidate", () => {
  const receipt = validateV15AggregateInput(v15Input());
  assert.equal(receipt.status, "PASS");
  assert.equal(receipt.stage_receipt_count, 20);
  assert.deepEqual(receipt.coverage.ci, { total: 102, pass: 102, not_applicable: 0 });
  assert.equal(receipt.production_only_suite_status, "NOT_EXECUTED_PRODUCTION_ONLY");
  assert.equal(V15_LOCAL_AGGREGATE_RECEIPT_DRAFT_SCHEMA.properties.stage_receipt_count.const, 20);
});

test("V15 blocks while real Syft Cosign ORAS evidence remains pending", () => {
  const input = v15Input();
  input.prerequisites.v12_real_supply_chain_evidence.status = "PENDING";
  assert.throws(() => validateV15AggregateInput(input), /V15_V12_REAL_SUPPLY_CHAIN_EVIDENCE_PENDING/);
});

test("V06-W V09 and V13 N/A require minimum profile final BOM and zero-entrypoint path scan", () => {
  const input = v15Input();
  const receipt = input.stage_receipts.find((entry) => entry.stage_id === "V09");
  receipt.applicability_proof.runtime_entrypoints_found = 1;
  assert.throws(() => validateV15AggregateInput(input), /V15_STAGE_NA_RUNTIME_ENTRYPOINT_PRESENT_V09/);
});

test("V15 rejects candidate drift missing coverage and retracted active claims", () => {
  const drift = v15Input();
  drift.stage_receipts[0].candidate_digest = D("9");
  assert.throws(() => validateV15AggregateInput(drift), /V15_STAGE_CANDIDATE_DRIFT_G0b/);
  const gap = v15Input();
  gap.coverage.ci.pop();
  assert.throws(() => validateV15AggregateInput(gap), /V15_CI_IDS_SET_MISMATCH/);
  const retracted = v15Input();
  retracted.retracted_claims.active_reference_count = 1;
  assert.throws(() => validateV15AggregateInput(retracted), /V15_RETRACTED_CLAIM_STILL_ACTIVE/);
});
