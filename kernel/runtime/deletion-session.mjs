import {
  assertExactRevocationVector,
  validateRevocationEpochVector,
  vectorsHaveMonotonicRaise,
} from "../policy/identity-security.mjs";

export class DeletionSessionError extends Error {
  constructor(code) {
    super(code);
    this.name = "DeletionSessionError";
    this.code = code;
  }
}
const TERMINAL = new Set(["completed","completed_with_minimum_retention","cancelled","failed_terminal"]);
const HOLDABLE = new Set(["quiescing","erasing","verifying","manual_intervention_required"]);
const RETRYABLE_FROM = new Set(["quiescing","erasing","verifying"]);
const TASK_EDGES = Object.freeze({
  pending: new Set(["leased","blocked_legal_hold","failed_retryable","failed_terminal"]),
  leased: new Set(["running","failed_retryable","failed_terminal"]),
  running: new Set(["succeeded","not_applicable","blocked_legal_hold","failed_retryable","failed_terminal"]),
  blocked_legal_hold: new Set(["pending","failed_terminal"]),
  failed_retryable: new Set(["pending","failed_terminal"]),
  succeeded: new Set(),
  not_applicable: new Set(),
  failed_terminal: new Set(),
});
const clone = (value) => structuredClone(value);
function reject(code) { throw new DeletionSessionError(code); }
function validRetention(item) {
  return item && typeof item.legal_basis === "string" && item.legal_basis.length > 0 &&
    Number.isFinite(item.retention_until) && typeof item.access_restriction === "string" &&
    item.access_restriction.length > 0 && typeof item.non_inference_proof === "string" &&
    item.non_inference_proof.length > 0;
}

export class InMemoryDeletionSession {
  #session;
  #tasks = new Map();
  #events = [];
  #outbox = [];

  constructor(input) {
    validateRevocationEpochVector(input.revocation_epoch_vector);
    if (!Number.isSafeInteger(input.max_repair_rounds) || input.max_repair_rounds <= 0 ||
        !Number.isFinite(input.verifying_deadline) ||
        !Number.isSafeInteger(input.erasure_generation) || input.erasure_generation < 0) {
      reject("DELETION_SESSION_INPUT_INVALID");
    }
    this.#session = {
      deletion_session_id: input.deletion_session_id,
      tenant_id: input.tenant_id,
      subject_ref: input.subject_ref,
      context_key: input.context_key,
      state: "requested",
      deletion_session_version: 0,
      revocation_epoch_vector: clone(input.revocation_epoch_vector),
      erasure_generation: input.erasure_generation,
      max_repair_rounds: input.max_repair_rounds,
      repair_round: 0,
      repair_budget_generation: 1,
      verifying_deadline: input.verifying_deadline,
      fencing_active: false,
      epochs_raised: false,
      store_tasks_started: false,
      resume_state: null,
      retry_resume_state: null,
      retry_budget_remaining: 0,
      retry_deadline: null,
      residuals: [],
      legal_hold: null,
      minimum_retention: [],
    };
  }
  snapshot() {
    return Object.freeze({
      session: clone(this.#session),
      tasks: [...this.#tasks.values()].map(clone),
      events: clone(this.#events),
      deletion_control_outbox: clone(this.#outbox),
    });
  }
  #assertCas(expectedVersion) {
    if (expectedVersion !== this.#session.deletion_session_version) reject("DELETION_SESSION_CAS_CONFLICT");
    if (TERMINAL.has(this.#session.state)) reject("DELETION_SESSION_TERMINAL");
  }
  #commit(nextSession, kind, detail, nextTasks = this.#tasks) {
    const version = this.#session.deletion_session_version + 1;
    const event = Object.freeze({
      event_id: "deletion-event-" + version,
      deletion_session_id: this.#session.deletion_session_id,
      deletion_session_version: version,
      kind,
      detail: clone(detail),
    });
    const outbox = Object.freeze({
      outbox_id: "deletion-control-" + version,
      deletion_session_id: this.#session.deletion_session_id,
      deletion_session_version: version,
      event_id: event.event_id,
      acknowledged: false,
    });
    this.#session = { ...nextSession, deletion_session_version: version };
    this.#tasks = nextTasks;
    this.#events = [...this.#events, event];
    this.#outbox = [...this.#outbox, outbox];
    return this.snapshot();
  }
  registerStoreTask(task, { expectedVersion }) {
    this.#assertCas(expectedVersion);
    const required = ["store_task_id","target_ref","operation","erasure_generation","input_digest",
      "idempotency_key","executor_identity","security_profile_id","deadline","attempt_budget","managed_scope"];
    if (required.some((field) => task[field] === undefined || task[field] === null)) {
      reject("DELETION_STORE_TASK_INCOMPLETE");
    }
    assertExactRevocationVector(task.revocation_epoch_vector, this.#session.revocation_epoch_vector);
    if (task.erasure_generation !== this.#session.erasure_generation ||
        !["clued","external"].includes(task.managed_scope)) reject("DELETION_STORE_TASK_BINDING_INVALID");
    const uniqueKey = [this.#session.deletion_session_id,task.target_ref,task.operation,task.erasure_generation].join("|");
    if (this.#tasks.has(uniqueKey)) reject("DELETION_STORE_TASK_DUPLICATE");
    const nextTasks = new Map(this.#tasks);
    nextTasks.set(uniqueKey, {
      ...clone(task),
      deletion_session_id: this.#session.deletion_session_id,
      unique_key: uniqueKey,
      state: "pending",
      repair_round: this.#session.repair_round,
    });
    return this.#commit({ ...this.#session, store_tasks_started: true }, "store_task_registered", { unique_key: uniqueKey }, nextTasks);
  }
  transitionStoreTask(uniqueKey, to, command) {
    this.#assertCas(command.expectedVersion);
    const task = this.#tasks.get(uniqueKey);
    if (!task || !TASK_EDGES[task.state]?.has(to)) reject("DELETION_STORE_TASK_EDGE_INVALID");
    assertExactRevocationVector(command.revocation_epoch_vector, this.#session.revocation_epoch_vector);
    if (command.erasure_generation !== this.#session.erasure_generation) reject("ERASURE_GENERATION_STALE");
    const nextTasks = new Map(this.#tasks);
    nextTasks.set(uniqueKey, {
      ...task,
      state: to,
      last_evidence_ref: command.evidence_ref ?? task.last_evidence_ref ?? null,
      attempt_no: (task.attempt_no ?? 0) + (to === "leased" ? 1 : 0),
    });
    return this.#commit(this.#session, "store_task_transition", { unique_key: uniqueKey, from: task.state, to }, nextTasks);
  }
  transition(to, command) {
    this.#assertCas(command.expectedVersion);
    const from = this.#session.state;
    let next = clone(this.#session);
    const nextTasks = new Map(this.#tasks);

    if (to === "blocked_legal_hold" && HOLDABLE.has(from)) {
      const hold = command.legal_hold;
      if (!hold?.verified || typeof hold.hold_id !== "string" || typeof hold.scope !== "string" ||
          typeof hold.reason !== "string" || !Number.isFinite(hold.expires_at)) reject("LEGAL_HOLD_INVALID");
      next.state = to;
      next.resume_state = from;
      next.legal_hold = clone(hold);
      next.fencing_active = true;
    } else if (from === "blocked_legal_hold") {
      if (to !== next.resume_state || !command.hold_release?.authorized ||
          command.hold_release.hold_id !== next.legal_hold?.hold_id) reject("LEGAL_HOLD_RESUME_INVALID");
      next.state = to;
      next.resume_state = null;
      next.legal_hold = null;
      next.fencing_active = true;
    } else if (to === "failed_retryable" && RETRYABLE_FROM.has(from)) {
      if (!Number.isSafeInteger(command.retry_budget) || command.retry_budget <= 0 ||
          !Number.isFinite(command.retry_deadline) || command.retry_deadline <= command.now ||
          typeof command.error_class !== "string") reject("RETRY_BUDGET_INVALID");
      next.state = to;
      next.retry_resume_state = from;
      next.retry_budget_remaining = command.retry_budget;
      next.retry_deadline = command.retry_deadline;
    } else if (from === "failed_retryable") {
      if (to === "failed_terminal") {
        if (!command.adjudication?.authorized) reject("TERMINAL_ADJUDICATION_REQUIRED");
        next.state = to;
      } else {
        if (to !== next.retry_resume_state || next.retry_budget_remaining <= 0 ||
            command.now > next.retry_deadline) reject("RETRY_RESUME_INVALID");
        next.state = to;
        next.retry_budget_remaining -= 1;
        next.retry_resume_state = null;
      }
    } else if (from === "requested" && to === "cancelled") {
      if (next.epochs_raised || next.store_tasks_started || next.fencing_active) reject("DELETION_CANCEL_FORBIDDEN");
      next.state = to;
    } else if (from === "requested" && to === "quiescing") {
      if (!vectorsHaveMonotonicRaise(next.revocation_epoch_vector, command.next_revocation_epoch_vector) ||
          !Number.isSafeInteger(command.next_erasure_generation) ||
          command.next_erasure_generation <= next.erasure_generation ||
          !command.reauthenticated || !command.deletion_gate_passed ||
          !command.target_manifest_digest || !command.idempotency_key) reject("DELETION_QUIESCE_PRECONDITION_FAILED");
      next.state = to;
      next.revocation_epoch_vector = clone(command.next_revocation_epoch_vector);
      next.erasure_generation = command.next_erasure_generation;
      next.fencing_active = true;
      next.epochs_raised = true;
    } else if (from === "quiescing" && to === "erasing") {
      if (!command.writes_blocked || !command.inflight_isolated ||
          !command.store_tasks_persisted || nextTasks.size === 0) reject("DELETION_ERASE_PRECONDITION_FAILED");
      next.state = to;
    } else if (from === "erasing" && to === "verifying") {
      const managed = [...nextTasks.values()].filter((task) => task.managed_scope === "clued");
      if (managed.length === 0 || managed.some((task) => !["succeeded","not_applicable"].includes(task.state))) {
        reject("MANAGED_ERASURE_INCOMPLETE");
      }
      next.state = to;
    } else if (from === "verifying" && to === "erasing") {
      if (!Array.isArray(command.residuals) || command.residuals.length === 0 ||
          next.repair_round >= next.max_repair_rounds || command.now > next.verifying_deadline ||
          command.residual_regenerating || command.unadjudicable) reject("REPAIR_BUDGET_UNAVAILABLE");
      if (!Array.isArray(command.repair_task_keys) || command.repair_task_keys.length === 0) reject("REPAIR_TASKS_REQUIRED");
      for (const key of command.repair_task_keys) {
        const task = nextTasks.get(key);
        if (!task || task.managed_scope !== "clued") reject("REPAIR_TASK_INVALID");
        nextTasks.set(key, { ...task, state: "pending", repair_round: next.repair_round + 1 });
      }
      next.state = to;
      next.repair_round += 1;
      next.residuals = clone(command.residuals);
    } else if (from === "verifying" && to === "manual_intervention_required") {
      const blocked = next.repair_round >= next.max_repair_rounds ||
        command.now > next.verifying_deadline || command.residual_regenerating || command.unadjudicable;
      if (!blocked || !Array.isArray(command.residuals) || command.residuals.length === 0 ||
          !command.last_evidence_ref || !Array.isArray(command.blocked_sources)) {
        reject("MANUAL_INTERVENTION_PRECONDITION_FAILED");
      }
      next.state = to;
      next.residuals = clone(command.residuals);
      next.last_evidence_ref = command.last_evidence_ref;
      next.blocked_sources = clone(command.blocked_sources);
      next.fencing_active = true;
    } else if (from === "manual_intervention_required" && to === "erasing") {
      const receipt = command.repair_budget_extension_receipt;
      if (!receipt?.authorized || receipt.prior_generation !== next.repair_budget_generation ||
          !Number.isSafeInteger(receipt.new_generation) || receipt.new_generation <= next.repair_budget_generation ||
          !Number.isSafeInteger(receipt.additional_rounds) || receipt.additional_rounds <= 0 ||
          !Number.isFinite(receipt.verifying_deadline) || receipt.verifying_deadline <= command.now ||
          receipt.verifying_deadline <= next.verifying_deadline ||
          !Array.isArray(command.repair_task_keys) || command.repair_task_keys.length === 0) {
        reject("REPAIR_BUDGET_EXTENSION_INVALID");
      }
      for (const key of command.repair_task_keys) {
        const task = nextTasks.get(key);
        if (!task || task.managed_scope !== "clued") reject("REPAIR_TASK_INVALID");
        nextTasks.set(key, { ...task, state: "pending", repair_round: next.repair_round + 1 });
      }
      next.state = to;
      next.repair_budget_generation = receipt.new_generation;
      next.max_repair_rounds += receipt.additional_rounds;
      next.verifying_deadline = receipt.verifying_deadline;
      next.fencing_active = true;
    } else if (from === "manual_intervention_required" && to === "failed_terminal") {
      if (!command.adjudication?.authorized || typeof command.adjudication.reason !== "string") {
        reject("TERMINAL_ADJUDICATION_REQUIRED");
      }
      next.state = to;
      next.fencing_active = true;
    } else if (from === "verifying" && to === "completed") {
      if ((command.residuals?.length ?? 0) !== 0 || (command.minimum_retention?.length ?? 0) !== 0) {
        reject("DELETION_COMPLETION_INVALID");
      }
      next.state = to;
    } else if (from === "verifying" && to === "completed_with_minimum_retention") {
      if (!Array.isArray(command.minimum_retention) || command.minimum_retention.length === 0 ||
          !command.minimum_retention.every(validRetention) ||
          (command.residuals?.length ?? 0) !== 0) reject("MINIMUM_RETENTION_INVALID");
      next.state = to;
      next.minimum_retention = clone(command.minimum_retention);
    } else {
      reject("DELETION_SESSION_EDGE_INVALID");
    }
    return this.#commit(next, "session_transition", { from, to }, nextTasks);
  }
}
