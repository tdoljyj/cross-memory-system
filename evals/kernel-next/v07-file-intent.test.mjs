import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryFileIntent,
  compileRestrictedStorageInvocation,
} from "../../kernel/runtime/file-intent.mjs";

const digest = (char) => "sha256:" + char.repeat(64);
const source = () => ({
  volume_id: "volume-source",
  file_id: "source-1",
  parent_file_id: "source-parent",
  size: 100,
  content_version: 4,
  sha256: digest("a"),
});
const target = () => ({
  volume_id: "volume-target",
  file_id: "target-1",
  parent_file_id: "target-parent",
  size: 100,
  content_version: 1,
  sha256: digest("b"),
});
const makeIntent = (mode = "copy", suffix = "a") => new InMemoryFileIntent({
  file_intent_id: "intent-" + suffix,
  operation_mode: mode,
  idempotency_key: "idem-" + suffix,
  effective_profile_hash: digest("c"),
  preview_digest: digest("d"),
  source_identity: source(),
  target_parent_identity: { volume_id: "volume-target", file_id: "target-parent" },
  expected_target_hash: digest("b"),
  conflict_policy: "fail",
  erasure_generation: 3,
  max_repair_rounds: 2,
  pending_deadline: 1000,
});

function stageAndCommitTarget(intent) {
  intent.transition("reserved", {
    expectedVersion: 0,
    unique_reservation: true,
    target_exists: false,
    preview_digest: digest("d"),
    effective_profile_hash: digest("c"),
  });
  intent.transition("staging", {
    expectedVersion: 1,
    create_new: true,
    private_acl: true,
    target_exists: false,
    source_identity: source(),
  });
  const stages = ["staged","content_synced","metadata_synced","target_committed","target_dir_synced"];
  let version = 2;
  for (const stage of stages) {
    intent.recordDurableStage(stage, { expectedVersion: version, barrier_passed: true });
    version += 1;
  }
  intent.transition("target_committed", {
    expectedVersion: version,
    durability_status: "confirmed",
    target_hash: digest("b"),
    target_exists_before_commit: false,
    source_identity: source(),
    target_identity: target(),
  });
}

test("V07-FILE-01 copy requires create-new, verified target bytes and parent durability before success", () => {
  const intent = makeIntent("copy", "copy");
  stageAndCommitTarget(intent);
  intent.transition("location_committed", {
    expectedVersion: 8,
    location_cas: true,
    target_identity: target(),
  });
  const completed = intent.transition("completed", { expectedVersion: 9 });
  assert.equal(completed.intent.intent_state, "completed");
  assert.equal(completed.intent.target_verified, true);
  assert.equal(completed.intent.source_deleted, false);
  assert.equal(completed.events.length, completed.intent.intent_version);
});

test("V07-FILE-02 default overwrite and source drift fail before target commit", () => {
  const overwrite = makeIntent("copy", "overwrite");
  assert.throws(() => overwrite.transition("reserved", {
    expectedVersion: 0,
    unique_reservation: true,
    target_exists: true,
    preview_digest: digest("d"),
    effective_profile_hash: digest("c"),
  }), { code: "TARGET_RESERVATION_INVALID" });

  const changed = makeIntent("copy", "changed");
  changed.transition("reserved", {
    expectedVersion: 0,
    unique_reservation: true,
    target_exists: false,
    preview_digest: digest("d"),
    effective_profile_hash: digest("c"),
  });
  const changedSource = source();
  changedSource.sha256 = digest("e");
  assert.throws(() => changed.transition("staging", {
    expectedVersion: 1,
    create_new: true,
    private_acl: true,
    target_exists: false,
    source_identity: changedSource,
  }), { code: "STAGING_PRECONDITION_FAILED" });
});

test("V07-FILE-03 move deletes source only after verified destination, Location CAS and provisional receipt", () => {
  const intent = makeIntent("move", "move");
  stageAndCommitTarget(intent);
  intent.transition("location_committed", {
    expectedVersion: 8,
    location_cas: true,
    target_identity: target(),
  });
  intent.recordDurableStage("source_revalidated", { expectedVersion: 9, barrier_passed: true });
  intent.transition("source_delete_pending", {
    expectedVersion: 10,
    source_identity: source(),
    erasure_generation: 3,
    file_deletion_receipt_id: "delete-receipt-1",
    provisional_receipt_persisted: true,
    conditional_delete_supported: true,
  });
  intent.recordDurableStage("source_deleted", { expectedVersion: 11, barrier_passed: true });
  intent.recordDurableStage("source_dir_synced", { expectedVersion: 12, barrier_passed: true });
  const completed = intent.transition("completed", {
    expectedVersion: 13,
    source_identity_match: true,
    conditional_delete_committed: true,
    source_dir_synced: true,
  });
  assert.equal(completed.intent.source_deleted, true);
  assert.equal(completed.intent.target_verified, true);
  assert.equal(completed.intent.canonical_location_committed, true);
});

test("V07-FILE-04 offline-before-effect blocks and resumes same identity; unknown-after-effect reconciles", () => {
  const offline = makeIntent("copy", "offline");
  offline.transition("blocked", {
    expectedVersion: 0,
    reason_code: "runner_unavailable_before_dispatch",
  });
  const resumed = offline.transition("planned", {
    expectedVersion: 1,
    guards_revalidated: true,
    idempotency_key: "idem-offline",
    preview_digest: digest("d"),
    erasure_generation: 3,
  });
  assert.equal(resumed.intent.intent_state, "planned");
  assert.equal(resumed.intent.idempotency_key, "idem-offline");

  const crashed = makeIntent("copy", "crash");
  crashed.transition("reserved", {
    expectedVersion: 0,
    unique_reservation: true,
    target_exists: false,
    preview_digest: digest("d"),
    effective_profile_hash: digest("c"),
  });
  crashed.transition("staging", {
    expectedVersion: 1,
    create_new: true,
    private_acl: true,
    target_exists: false,
    source_identity: source(),
  });
  crashed.recordDurableStage("staged", { expectedVersion: 2, barrier_passed: true });
  crashed.transition("reconciling", { expectedVersion: 3, effect_may_have_started: true });
  assert.throws(() => crashed.transition("blocked", {
    expectedVersion: 4,
    reason_code: "runner_unavailable_before_dispatch",
  }));
  const reconciled = crashed.transition("target_committed", {
    expectedVersion: 4,
    observation: {
      identity_verified: true,
      hash_verified: true,
      duplicate_targets: 1,
      source_deleted_without_verified_target: false,
      side_effect_status: "partially_completed",
      target_verified: true,
      location_committed: false,
      source_deleted: false,
    },
  });
  assert.equal(reconciled.intent.intent_state, "target_committed");
  assert.equal(reconciled.intent.source_deleted, false);
});

test("V07-FILE-05 source-delete retry budget has a bounded manual-review exit", () => {
  const intent = makeIntent("move", "stuck");
  stageAndCommitTarget(intent);
  intent.transition("location_committed", {
    expectedVersion: 8,
    location_cas: true,
    target_identity: target(),
  });
  intent.recordDurableStage("source_revalidated", { expectedVersion: 9, barrier_passed: true });
  intent.transition("source_delete_pending", {
    expectedVersion: 10,
    source_identity: source(),
    erasure_generation: 3,
    file_deletion_receipt_id: "delete-receipt-stuck",
    provisional_receipt_persisted: true,
    conditional_delete_supported: true,
  });
  const failed = intent.recordSourceDeleteFailure({ expectedVersion: 11, now: 1000 });
  assert.equal(failed.intent.intent_state, "reconciling");
  assert.equal(failed.intent.resolution_status, "manual_review_required");
  assert.equal(failed.intent.side_effect_status, "partially_completed");
  assert.equal(failed.intent.target_verified, true);
});

test("V07-STORAGE-01 restricted storage adapter has no arbitrary backend, delete, overwrite, mount or sync", () => {
  const profile = {
    adapter_id: "adapters/storage/rclone",
    fixed_backend: "local-fixture",
    allowed_source_prefix: "source://tenant-a/",
    allowed_target_prefix: "target://tenant-a/",
  };
  const compiled = compileRestrictedStorageInvocation(profile, {
    operation: "copy",
    backend: "local-fixture",
    source_ref: "source://tenant-a/a",
    target_ref: "target://tenant-a/b",
  });
  assert.equal(compiled.overwrite, false);
  assert.equal(compiled.delete, false);
  for (const mutation of [
    { delete: true },
    { overwrite: true },
    { sync: true },
    { mount: true },
    { backend: "attacker" },
  ]) {
    assert.throws(() => compileRestrictedStorageInvocation(profile, {
      operation: "copy",
      backend: "local-fixture",
      source_ref: "source://tenant-a/a",
      target_ref: "target://tenant-a/b",
      ...mutation,
    }), { code: "STORAGE_ADAPTER_CAPABILITY_REJECTED" });
  }
});
