export class FileIntentError extends Error {
  constructor(code) {
    super(code);
    this.name = "FileIntentError";
    this.code = code;
  }
}
const clone = (value) => structuredClone(value);
const TERMINAL = new Set(["completed","failed_terminal","cancelled"]);
const MODE_STATES = Object.freeze({
  index_only: new Set(["planned","blocked","location_committed","completed","failed_terminal","cancelled","reconciling"]),
  copy: new Set(["planned","reserved","staging","target_committed","location_committed","blocked","reconciling","completed","failed_terminal","cancelled"]),
  move: new Set(["planned","reserved","staging","target_committed","location_committed","source_delete_pending","blocked","reconciling","completed","failed_terminal","cancelled"]),
});
const DURABLE_STAGES = [
  "staged",
  "content_synced",
  "metadata_synced",
  "target_committed",
  "target_dir_synced",
  "source_revalidated",
  "source_deleted",
  "source_dir_synced",
];
function reject(code) { throw new FileIntentError(code); }
function sameIdentity(left, right) {
  return Boolean(left && right) &&
    left.volume_id === right.volume_id &&
    left.file_id === right.file_id &&
    left.parent_file_id === right.parent_file_id &&
    left.size === right.size &&
    left.content_version === right.content_version &&
    left.sha256 === right.sha256;
}

export class InMemoryFileIntent {
  #intent;
  #events = [];

  constructor(input) {
    if (!MODE_STATES[input.operation_mode] || !["fail","version","rename","replace"].includes(input.conflict_policy) ||
        typeof input.effective_profile_hash !== "string" || typeof input.idempotency_key !== "string") {
      reject("FILE_INTENT_INPUT_INVALID");
    }
    this.#intent = {
      file_intent_id: input.file_intent_id,
      operation_mode: input.operation_mode,
      intent_state: "planned",
      intent_version: 0,
      idempotency_key: input.idempotency_key,
      effective_profile_hash: input.effective_profile_hash,
      preview_digest: input.preview_digest,
      source_identity: clone(input.source_identity),
      target_parent_identity: clone(input.target_parent_identity),
      expected_target_hash: input.expected_target_hash,
      conflict_policy: input.conflict_policy,
      erasure_generation: input.erasure_generation,
      side_effect_status: "none",
      execution_outcome: null,
      reason_code: null,
      resume_from_state: null,
      last_durable_stage: null,
      durable_stages: [],
      target_identity: null,
      target_verified: false,
      canonical_location_committed: false,
      source_deleted: false,
      source_delete_receipt_id: null,
      repair_round: 0,
      max_repair_rounds: input.max_repair_rounds ?? 2,
      pending_deadline: input.pending_deadline ?? 1000,
      resolution_status: null,
      residual_copy_accepted: false,
    };
  }

  snapshot() {
    return Object.freeze({ intent: clone(this.#intent), events: clone(this.#events) });
  }

  #cas(expectedVersion) {
    if (expectedVersion !== this.#intent.intent_version) reject("FILE_INTENT_CAS_CONFLICT");
    if (TERMINAL.has(this.#intent.intent_state)) reject("FILE_INTENT_TERMINAL");
  }

  #commit(next, kind, detail) {
    const version = this.#intent.intent_version + 1;
    this.#intent = { ...next, intent_version: version };
    this.#events = [...this.#events, Object.freeze({
      event_id: "file-intent-event-" + version,
      file_intent_id: this.#intent.file_intent_id,
      intent_version: version,
      kind,
      detail: clone(detail),
    })];
    return this.snapshot();
  }

  recordDurableStage(stage, command) {
    this.#cas(command.expectedVersion);
    const index = DURABLE_STAGES.indexOf(stage);
    if (index < 0 || index !== this.#intent.durable_stages.length ||
        command.barrier_passed !== true) reject("FILESYSTEM_DURABILITY_STAGE_INVALID");
    if (stage.startsWith("source_") && !this.#intent.target_verified) reject("SOURCE_DELETE_BEFORE_TARGET_VERIFIED");
    const next = clone(this.#intent);
    next.durable_stages.push(stage);
    next.last_durable_stage = stage;
    if (stage === "target_committed") next.side_effect_status = "partially_completed";
    if (stage === "source_deleted") next.source_deleted = true;
    return this.#commit(next, "durable_stage", { stage });
  }

  transition(to, command) {
    this.#cas(command.expectedVersion);
    const from = this.#intent.intent_state;
    if (!MODE_STATES[this.#intent.operation_mode].has(to)) reject("FILE_INTENT_MODE_STATE_INVALID");
    let next = clone(this.#intent);

    if (to === "blocked" && ["planned","reserved"].includes(from)) {
      if (next.side_effect_status !== "none" || command.reason_code !== "runner_unavailable_before_dispatch") {
        reject("FILE_INTENT_BLOCK_INVALID");
      }
      next.intent_state = to;
      next.reason_code = command.reason_code;
      next.resume_from_state = from;
    } else if (from === "blocked") {
      if (to !== next.resume_from_state || command.guards_revalidated !== true ||
          command.idempotency_key !== next.idempotency_key ||
          command.preview_digest !== next.preview_digest ||
          command.erasure_generation !== next.erasure_generation) {
        reject("FILE_INTENT_RESUME_INVALID");
      }
      next.intent_state = to;
      next.reason_code = null;
      next.resume_from_state = null;
    } else if (to === "reconciling" && !TERMINAL.has(from)) {
      if (next.side_effect_status === "none" && command.effect_may_have_started !== true) {
        reject("RECONCILIATION_NOT_REQUIRED");
      }
      next.intent_state = to;
      next.execution_outcome = "unknown";
      next.side_effect_status = "unknown";
      next.reason_code = "result_unknown";
      next.resolution_status = "reconciling";
    } else if (from === "reconciling") {
      if (!command.observation?.identity_verified || !command.observation?.hash_verified ||
          command.observation.duplicate_targets > 1 || command.observation.source_deleted_without_verified_target) {
        reject("FILE_RECONCILIATION_EVIDENCE_INVALID");
      }
      if (!["target_committed","location_committed","completed","failed_terminal"].includes(to)) {
        reject("FILE_RECONCILIATION_TARGET_INVALID");
      }
      next.intent_state = to;
      next.execution_outcome = to === "completed" ? "succeeded" : "confirmed_failed";
      next.side_effect_status = command.observation.side_effect_status;
      next.resolution_status = to === "completed" ? "resolved" : "manual_review_required";
      next.reason_code = command.observation.reason_code ?? null;
      next.target_verified = command.observation.target_verified === true;
      next.canonical_location_committed = command.observation.location_committed === true;
      next.source_deleted = command.observation.source_deleted === true;
    } else if (from === "planned" && to === "reserved") {
      if (this.#intent.operation_mode === "index_only" || command.unique_reservation !== true ||
          command.target_exists && this.#intent.conflict_policy === "fail" ||
          command.preview_digest !== next.preview_digest ||
          command.effective_profile_hash !== next.effective_profile_hash) reject("TARGET_RESERVATION_INVALID");
      next.intent_state = to;
    } else if (from === "planned" && to === "location_committed" &&
               this.#intent.operation_mode === "index_only") {
      if (!command.location_cas || !sameIdentity(command.source_identity, next.source_identity)) {
        reject("LOCATION_COMMIT_INVALID");
      }
      next.intent_state = to;
      next.canonical_location_committed = true;
    } else if (from === "reserved" && to === "staging") {
      if (command.create_new !== true || command.private_acl !== true ||
          command.target_exists && next.conflict_policy === "fail" ||
          !sameIdentity(command.source_identity, next.source_identity)) reject("STAGING_PRECONDITION_FAILED");
      next.intent_state = to;
    } else if (from === "staging" && to === "target_committed") {
      const required = ["staged","content_synced","metadata_synced","target_committed","target_dir_synced"];
      if (!required.every((stage, index) => next.durable_stages[index] === stage) ||
          command.durability_status !== "confirmed" ||
          command.target_hash !== next.expected_target_hash ||
          command.target_exists_before_commit && next.conflict_policy === "fail" ||
          !sameIdentity(command.source_identity, next.source_identity) ||
          !command.target_identity) reject("TARGET_COMMIT_NOT_VERIFIED");
      next.intent_state = to;
      next.target_identity = clone(command.target_identity);
      next.target_verified = true;
      next.side_effect_status = "completed";
      next.execution_outcome = "succeeded";
    } else if (from === "target_committed" && to === "location_committed") {
      if (!command.location_cas || !next.target_verified ||
          !sameIdentity(command.target_identity, next.target_identity)) reject("LOCATION_COMMIT_INVALID");
      next.intent_state = to;
      next.canonical_location_committed = true;
    } else if (from === "location_committed" && to === "completed" &&
               this.#intent.operation_mode !== "move") {
      if (!next.canonical_location_committed) reject("FILE_COMPLETION_INVALID");
      next.intent_state = to;
      next.execution_outcome = "succeeded";
      next.side_effect_status = "completed";
    } else if (from === "location_committed" && to === "source_delete_pending" &&
               this.#intent.operation_mode === "move") {
      if (!next.target_verified || !next.canonical_location_committed ||
          !sameIdentity(command.source_identity, next.source_identity) ||
          command.erasure_generation !== next.erasure_generation ||
          typeof command.file_deletion_receipt_id !== "string" ||
          command.provisional_receipt_persisted !== true ||
          command.conditional_delete_supported !== true) reject("SOURCE_DELETE_PRECONDITION_FAILED");
      next.intent_state = to;
      next.source_delete_receipt_id = command.file_deletion_receipt_id;
    } else if (from === "source_delete_pending" && to === "completed") {
      if (!next.target_verified || !next.source_delete_receipt_id ||
          command.source_identity_match !== true ||
          command.conditional_delete_committed !== true ||
          command.source_dir_synced !== true ||
          !next.durable_stages.includes("source_deleted") ||
          !next.durable_stages.includes("source_dir_synced")) reject("SOURCE_DELETE_NOT_VERIFIED");
      next.intent_state = to;
      next.source_deleted = true;
      next.execution_outcome = "succeeded";
      next.side_effect_status = "completed";
    } else {
      reject("FILE_INTENT_EDGE_INVALID");
    }
    return this.#commit(next, "state_transition", { from, to });
  }

  recordSourceDeleteFailure(command) {
    this.#cas(command.expectedVersion);
    if (this.#intent.intent_state !== "source_delete_pending") reject("SOURCE_DELETE_NOT_PENDING");
    const next = clone(this.#intent);
    next.repair_round += 1;
    next.intent_state = "reconciling";
    next.execution_outcome = "confirmed_failed";
    next.side_effect_status = "partially_completed";
    next.reason_code = "source_delete_failed";
    next.resolution_status =
      next.repair_round >= next.max_repair_rounds || command.now >= next.pending_deadline
        ? "manual_review_required"
        : "reconciling";
    return this.#commit(next, "source_delete_failure", { repair_round: next.repair_round });
  }
}

export function compileRestrictedStorageInvocation(profile, request) {
  if (profile.adapter_id !== "adapters/storage/rclone" ||
      !["stat","copy"].includes(request.operation) ||
      request.delete || request.purge || request.overwrite || request.sync ||
      request.mount || request.serve || request.arbitrary_config_path ||
      request.backend !== profile.fixed_backend ||
      !request.source_ref.startsWith(profile.allowed_source_prefix) ||
      !request.target_ref.startsWith(profile.allowed_target_prefix)) {
    reject("STORAGE_ADAPTER_CAPABILITY_REJECTED");
  }
  return Object.freeze({
    adapter_id: profile.adapter_id,
    operation: request.operation,
    source_ref: request.source_ref,
    target_ref: request.target_ref,
    overwrite: false,
    delete: false,
    intent_required: true,
    receipt_required: true,
  });
}
