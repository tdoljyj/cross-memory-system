import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryDeletionSession } from "../../kernel/runtime/deletion-session.mjs";

const digest = (char) => "sha256:" + char.repeat(64);
const ref = (id, char) => ({ scope_id: id, scope_digest: digest(char) });
const vector = (accountEpoch = 1) => ({
  vector_schema_version: "1",
  account_scope_ref: ref("acct:test", "a"),
  account_epoch: accountEpoch,
  integration_installation_scope_ref: ref("install:test", "b"),
  integration_installation_epoch: 1,
  context_scope_ref: ref("ctx:test", "c"),
  context_epoch: 1,
  binding_scope_ref: ref("bind:test", "d"),
  binding_epoch: 1,
});
const makeSession = (suffix = "a", maxRepairRounds = 1) => new InMemoryDeletionSession({
  deletion_session_id: "delete-" + suffix,
  tenant_id: "tenant-a",
  subject_ref: "subject-a",
  context_key: "alpha",
  revocation_epoch_vector: vector(),
  erasure_generation: 1,
  max_repair_rounds: maxRepairRounds,
  verifying_deadline: 500,
});
const makeTask = (suffix, managedScope = "clued") => ({
  store_task_id: "task-" + suffix,
  target_ref: "store-" + suffix,
  operation: managedScope === "clued" ? "erase" : "external_delete_request",
  erasure_generation: 2,
  revocation_epoch_vector: vector(2),
  input_digest: digest("e"),
  idempotency_key: "idem-" + suffix,
  executor_identity: "executor-test",
  security_profile_id: "test_generation",
  deadline: 400,
  attempt_budget: 3,
  managed_scope: managedScope,
});
const quiesce = (session) => session.transition("quiescing", {
  expectedVersion: 0,
  next_revocation_epoch_vector: vector(2),
  next_erasure_generation: 2,
  reauthenticated: true,
  deletion_gate_passed: true,
  target_manifest_digest: digest("f"),
  idempotency_key: "delete-command",
});
const keyFor = (snapshot, suffix) =>
  snapshot.tasks.find((item) => item.store_task_id === "task-" + suffix).unique_key;

function runTask(session, key) {
  let version = session.snapshot().session.deletion_session_version;
  session.transitionStoreTask(key, "leased", {
    expectedVersion: version,
    revocation_epoch_vector: vector(2),
    erasure_generation: 2,
  });
  version += 1;
  session.transitionStoreTask(key, "running", {
    expectedVersion: version,
    revocation_epoch_vector: vector(2),
    erasure_generation: 2,
  });
  version += 1;
  session.transitionStoreTask(key, "succeeded", {
    expectedVersion: version,
    revocation_epoch_vector: vector(2),
    erasure_generation: 2,
    evidence_ref: "evidence:" + key,
  });
}

test("V03-DEL-01 managed deletion completes while external timeout remains separately truthful", () => {
  const session = makeSession("complete");
  quiesce(session);
  session.registerStoreTask(makeTask("managed"), { expectedVersion: 1 });
  session.registerStoreTask(makeTask("third-party", "external"), { expectedVersion: 2 });
  session.transition("erasing", {
    expectedVersion: 3,
    writes_blocked: true,
    inflight_isolated: true,
    store_tasks_persisted: true,
  });
  const snapshot = session.snapshot();
  const managedKey = keyFor(snapshot, "managed");
  const externalKey = keyFor(snapshot, "third-party");
  runTask(session, managedKey);
  let version = session.snapshot().session.deletion_session_version;
  session.transitionStoreTask(externalKey, "failed_retryable", {
    expectedVersion: version,
    revocation_epoch_vector: vector(2),
    erasure_generation: 2,
    evidence_ref: "external-timeout",
  });
  version += 1;
  session.transition("verifying", { expectedVersion: version });
  version += 1;
  const final = session.transition("completed", {
    expectedVersion: version,
    residuals: [],
    minimum_retention: [],
  });
  assert.equal(final.session.state, "completed");
  assert.equal(final.tasks.find((item) => item.unique_key === externalKey).state, "failed_retryable");
  assert.equal(final.events.length, final.deletion_control_outbox.length);
  assert.equal(final.events.length, final.session.deletion_session_version);
});

test("V03-DEL-02 illegal edges, stale CAS, post-fencing cancel, and terminal exits reject atomically", () => {
  const session = makeSession("illegal");
  const initial = session.snapshot();
  assert.throws(() => session.transition("completed", {
    expectedVersion: 0,
    residuals: [],
    minimum_retention: [],
  }), { code: "DELETION_SESSION_EDGE_INVALID" });
  assert.deepEqual(session.snapshot(), initial);
  quiesce(session);
  assert.throws(() => session.transition("cancelled", { expectedVersion: 1 }), {
    code: "DELETION_SESSION_EDGE_INVALID",
  });
  assert.throws(() => session.transition("erasing", {
    expectedVersion: 0,
    writes_blocked: true,
    inflight_isolated: true,
    store_tasks_persisted: true,
  }), { code: "DELETION_SESSION_CAS_CONFLICT" });
  const cancellable = makeSession("cancel");
  cancellable.transition("cancelled", { expectedVersion: 0 });
  assert.throws(() => cancellable.transition("quiescing", { expectedVersion: 1 }), {
    code: "DELETION_SESSION_TERMINAL",
  });
});

test("V03-DEL-03 repair budget exhausts into manual intervention; extension never resets history", () => {
  const session = makeSession("repair", 1);
  quiesce(session);
  session.registerStoreTask(makeTask("repair"), { expectedVersion: 1 });
  session.transition("erasing", {
    expectedVersion: 2,
    writes_blocked: true,
    inflight_isolated: true,
    store_tasks_persisted: true,
  });
  const key = keyFor(session.snapshot(), "repair");
  runTask(session, key);
  let version = session.snapshot().session.deletion_session_version;
  session.transition("verifying", { expectedVersion: version });
  version += 1;
  session.transition("erasing", {
    expectedVersion: version,
    residuals: ["residual:one"],
    repair_task_keys: [key],
    now: 100,
  });
  assert.equal(session.snapshot().session.repair_round, 1);
  runTask(session, key);
  version = session.snapshot().session.deletion_session_version;
  session.transition("verifying", { expectedVersion: version });
  version += 1;
  session.transition("manual_intervention_required", {
    expectedVersion: version,
    residuals: ["residual:regenerated"],
    last_evidence_ref: "evidence:residual",
    blocked_sources: ["cache:test"],
    now: 200,
  });
  version += 1;
  const resumed = session.transition("erasing", {
    expectedVersion: version,
    now: 201,
    repair_task_keys: [key],
    repair_budget_extension_receipt: {
      authorized: true,
      prior_generation: 1,
      new_generation: 2,
      additional_rounds: 2,
      verifying_deadline: 800,
    },
  });
  assert.equal(resumed.session.repair_round, 1);
  assert.equal(resumed.session.max_repair_rounds, 3);
  assert.equal(resumed.session.repair_budget_generation, 2);
  assert.equal(resumed.session.fencing_active, true);
});

test("V03-DEL-04 verified Legal Hold resumes only to persisted state and preserves fencing", () => {
  const session = makeSession("hold");
  quiesce(session);
  session.transition("blocked_legal_hold", {
    expectedVersion: 1,
    legal_hold: {
      verified: true,
      hold_id: "hold-1",
      scope: "context:alpha",
      reason: "litigation",
      expires_at: 900,
    },
  });
  assert.throws(() => session.transition("erasing", {
    expectedVersion: 2,
    hold_release: { authorized: true, hold_id: "hold-1" },
  }), { code: "LEGAL_HOLD_RESUME_INVALID" });
  const resumed = session.transition("quiescing", {
    expectedVersion: 2,
    hold_release: { authorized: true, hold_id: "hold-1" },
  });
  assert.equal(resumed.session.state, "quiescing");
  assert.equal(resumed.session.fencing_active, true);
});
