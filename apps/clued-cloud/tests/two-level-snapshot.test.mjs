import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSnapshot,
  canonicalJson,
  publishSnapshot,
  readFormalSnapshot,
  rollbackSnapshot,
  sha256,
  validateSnapshot,
} from "../scripts/two-level-snapshot.mjs";
import {
  coordinatedPublishSnapshot,
  coordinatedRollbackSnapshot,
  DEFAULT_M2_POLICY,
  enablePersistentSnapshotStore,
  readPersistentSnapshotStoreStatus,
  reconcilePersistentSnapshotStore,
  sweepPersistentSnapshotStore,
} from "../scripts/m2-snapshot-store.mjs";

const BUILD_EPOCH = "2026-08-26T00:00:00.000Z";
const HASH = "a".repeat(64);

function record(overrides) {
  return {
    id: overrides.id,
    record_schema_version: 1,
    record_type: overrides.record_type,
    lifecycle_status: overrides.lifecycle_status ?? "active",
    scope: overrides.scope,
    title: overrides.title ?? overrides.id,
    content: overrides.content ?? `${overrides.id} body`,
    type_fields: overrides.type_fields ?? {},
    relations: { depends_on: [], supersedes: [], related_records: [] },
    source_refs: overrides.source_refs ?? [],
    source_unavailable_reason: overrides.source_unavailable_reason ?? "fixture",
    closure_summary: overrides.closure_summary ?? null,
    closed_reason: overrides.closed_reason ?? null,
    closed_at: overrides.closed_at ?? null,
    authority: "user_explicit",
    observed_at: null,
    recorded_at: BUILD_EPOCH,
    updated_at: BUILD_EPOCH,
    confidence: 1,
    confidence_reason: "fixture",
    version: overrides.version ?? 1,
    receipt_id: `receipt_${overrides.id}`,
    content_hash: HASH,
  };
}

function event(overrides) {
  return {
    event_id: overrides.event_id,
    event_schema_version: 1,
    event_stream_id: null,
    stream_generation: null,
    event_sequence: null,
    committed_canonical_version: "cv_1",
    event_type: "record_created",
    target_refs: [{ role: "primary", kind: "record", id: overrides.target_id }],
    event_scope: overrides.event_scope,
    origin_scope: null,
    change_summary: [],
    idempotency_key: `idem_${overrides.event_id}`,
    request_hash: HASH,
    actor_binding_id: overrides.actor_binding_id ?? null,
    actor_user_id: "private-user-id",
    occurred_at: BUILD_EPOCH,
    result: "success",
    receipt_id: `receipt_${overrides.event_id}`,
    audit_visibility: overrides.audit_visibility,
    evidence_refs: [],
    artifact_refs: [],
    error_code: null,
    content_hash: HASH,
  };
}

function canonicalSource({ verification = "bundle_only", viewsComplete = true } = {}) {
  const projectId = "00000000-0000-4000-8000-000000000001";
  return {
    schema_version: 1,
    canonical_version: "cv_1",
    source_verification: verification,
    views_complete: viewsComplete,
    owner_ref: "owner_fixture",
    projects: [{
      canonical_project_id: projectId,
      project_schema_version: 1,
      name: "Clued",
      certainty_status: "confirmed",
      progress_status: "active",
      lifecycle_status: "active",
      merged_into_project_id: null,
      aliases: [],
      version: 2,
      receipt_id: "receipt_project",
    }],
    records: [
      record({ id: "rec_profile", record_type: "profile_fact", scope: "profile", title: "Profile" }),
      record({ id: "rec_global", record_type: "state", scope: "global", title: "Global state" }),
      record({ id: "rec_task", record_type: "task", scope: `project:${projectId}`, title: "Next task", type_fields: { execution_bucket: "now" } }),
      record({ id: "rec_old", record_type: "decision", scope: `project:${projectId}`, title: "Old decision", lifecycle_status: "superseded", closure_summary: "Superseded", closed_at: BUILD_EPOCH }),
    ],
    events: [
      event({ event_id: "evt_work", target_id: "rec_global", event_scope: "global", audit_visibility: "work_log", actor_binding_id: "private-binding-id" }),
      event({ event_id: "evt_profile", target_id: "rec_profile", event_scope: "profile", audit_visibility: "audit_only" }),
    ],
    evidence: [{
      evidence_id: "evidence_1",
      evidence_schema_version: 1,
      evidence_type: "user_quote",
      storage_ref: "protected://fixture",
      content_hash: HASH,
      mime_type: "text/plain",
      size_bytes: 7,
      captured_at: BUILD_EPOCH,
      recorded_at: BUILD_EPOCH,
      referenced_by: ["rec_profile"],
      derived_scopes: ["profile"],
      export_disposition: "omitted",
      omitted_reason: "sensitive",
      receipt_id: "receipt_evidence",
    }],
    referenced_receipts: ["receipt_project"],
    legacy_projects: [], legacy_records: [], legacy_events: [], legacy_evidence: [],
    excluded_evidence_counts: { unlinked: 2 },
  };
}

async function buildFixture(source = canonicalSource(), epoch = BUILD_EPOCH, run = "run_fixture") {
  const parent = await mkdtemp(path.join(os.tmpdir(), "clued-v16-"));
  const snapshot = path.join(parent, "snapshot");
  const result = await buildSnapshot({ source, outputDirectory: snapshot, buildEpoch: epoch, migrationRunId: run });
  return { parent, snapshot, result };
}

async function activateFixture(fixture, exportRoot, expectedCurrentSnapshotVersion, publishedAt) {
  return await publishSnapshot({
    snapshotDirectory: fixture.snapshot,
    exportRoot,
    activate: true,
    expectedCurrentSnapshotVersion,
    publishedAt,
  });
}

test("M0 emits profile/global/projects, canonical objects, raw Events, evidence, one index and Manifest v5", async () => {
  const { snapshot, result } = await buildFixture();
  const root = path.join(snapshot, "memory");
  assert.equal(result.manifest.schema_version, 5);
  assert.equal(result.manifest.baseline_claim, "historical_offline");
  assert.equal(result.manifest.source_verification, "bundle_only");
  assert.equal(result.manifest.event_rollups_enabled, false);
  assert.equal(result.manifest.snapshot_counts.pending_review, 0);
  assert.ok(result.manifest.files.some((file) => file.path === "profile.md"));
  assert.ok(result.manifest.files.some((file) => file.path === "global/state.md"));
  assert.ok(result.manifest.files.some((file) => file.path.endsWith("/task.md")));
  assert.ok(result.manifest.files.some((file) => file.path === "index.json"));
  assert.ok(!result.manifest.files.some((file) => file.path === "object-index.json"));

  const archive = await readFile(path.join(root, "projects", "00000000-0000-4000-8000-000000000001", "archive.md"), "utf8");
  assert.match(archive, /`rec_old`/);
  const oldObject = JSON.parse(await readFile(path.join(root, "objects", "records", "rec_old.json"), "utf8"));
  assert.equal(oldObject.data.record_type, "decision");
  assert.equal(oldObject.data.lifecycle_status, "superseded");

  const fullEvent = JSON.parse(await readFile(path.join(root, "events", "raw", "evt_work.json"), "utf8"));
  assert.equal(fullEvent.kind, "event");
  assert.equal(fullEvent.data.actor_kind, "agent_binding");
  assert.ok(!Object.hasOwn(fullEvent.data, "actor_user_id"));
  assert.ok(!Object.hasOwn(fullEvent.data, "actor_binding_id"));
  const privateEvent = JSON.parse(await readFile(path.join(root, "events", "raw", "evt_profile.json"), "utf8"));
  assert.equal(privateEvent.kind, "event_stub");
  assert.ok(!Object.hasOwn(privateEvent.data, "target_refs"));
  await validateSnapshot(snapshot);
});

test("Project schema v2 snapshot omits legacy certainty and preserves recognition metadata", async () => {
  const source = canonicalSource({ verification: "live_rechecked", viewsComplete: true });
  source.schema_version = 2;
  source.projects = source.projects.map((project) => {
    const { certainty_status: _certainty, ...rest } = project;
    return {
      ...rest,
      project_schema_version: 2,
      recognition_metadata: {
        confidence: 0.92,
        reason: "fixture-recognized-project",
        source_ref: "fixture",
      },
    };
  });
  const { snapshot, result } = await buildFixture(source, BUILD_EPOCH, "run_project_v2");
  assert.equal(result.manifest.status, "ready");
  await validateSnapshot(snapshot);
  const projectObject = JSON.parse(await readFile(
    path.join(snapshot, "memory", "objects", "projects", "00000000-0000-4000-8000-000000000001.json"),
    "utf8",
  ));
  assert.equal(projectObject.data.project_schema_version, 2);
  assert.equal(projectObject.data.recognition_metadata.confidence, 0.92);
  assert.equal(Object.hasOwn(projectObject.data, "certainty_status"), false);
});

test("source schema v2 rejects a legacy Project in the active projects array", async () => {
  const source = canonicalSource({ verification: "live_rechecked", viewsComplete: true });
  source.schema_version = 2;
  await assert.rejects(
    buildFixture(source, BUILD_EPOCH, "run_project_v2_legacy_reject"),
    /Source schema v2 requires Project schema v2/,
  );
});

test("fixed source, build epoch and migration run are byte deterministic", async () => {
  const first = await buildFixture();
  const second = await buildFixture();
  const one = await readFile(path.join(first.snapshot, "memory", "manifest.json"));
  const two = await readFile(path.join(second.snapshot, "memory", "manifest.json"));
  assert.deepEqual(one, two);
  assert.equal(first.result.manifest.snapshot_version, second.result.manifest.snapshot_version);
});

test("validation fails closed on checksum drift and offline publish cannot activate", async () => {
  const { parent, snapshot } = await buildFixture();
  await writeFile(path.join(snapshot, "memory", "global", "state.md"), "tampered\n", "utf8");
  await assert.rejects(validateSnapshot(snapshot), /checksum mismatch/);

  const clean = await buildFixture();
  const exportRoot = path.join(parent, "export");
  const published = await publishSnapshot({ snapshotDirectory: clean.snapshot, exportRoot, activate: false });
  assert.equal(published.status, "published_offline");
  await assert.rejects(publishSnapshot({
    snapshotDirectory: clean.snapshot,
    exportRoot,
    activate: true,
    expectedCurrentSnapshotVersion: null,
    publishedAt: "2026-08-26T00:00:01.000Z",
  }), /live-rechecked/);
});

test("failure injection preserves the formal pointer and rollback restores the previous immutable version", async () => {
  const source = canonicalSource({ verification: "live_rechecked", viewsComplete: true });
  const first = await buildFixture(source, BUILD_EPOCH, "run_current_a");
  const exportRoot = path.join(first.parent, "export");
  await activateFixture(first, exportRoot, null, "2026-08-26T00:00:10.000Z");
  const firstPointer = JSON.parse(await readFile(path.join(exportRoot, "current.json"), "utf8"));

  const failedRoot = path.join(first.parent, "failed-candidate");
  await assert.rejects(buildSnapshot({
    source,
    outputDirectory: failedRoot,
    buildEpoch: "2026-08-26T00:01:00.000Z",
    migrationRunId: "run_failed",
    failAfter: "objects",
  }), /INJECTED_FAILURE/);
  const afterFailure = JSON.parse(await readFile(path.join(exportRoot, "current.json"), "utf8"));
  assert.equal(afterFailure.snapshot_version, firstPointer.snapshot_version);

  const second = await buildFixture(source, "2026-08-26T00:02:00.000Z", "run_current_b");
  await activateFixture(second, exportRoot, firstPointer.snapshot_version, "2026-08-26T00:02:10.000Z");
  const secondPointer = JSON.parse(await readFile(path.join(exportRoot, "current.json"), "utf8"));
  assert.equal(secondPointer.previous_snapshot_version, firstPointer.snapshot_version);
  const rolledBack = await rollbackSnapshot({
    exportRoot,
    expectedCurrentSnapshotVersion: secondPointer.snapshot_version,
    rolledBackAt: "2026-08-26T00:02:20.000Z",
  });
  assert.equal(rolledBack.pointer.snapshot_version, firstPointer.snapshot_version);
  assert.equal(rolledBack.pointer.previous_snapshot_version, secondPointer.snapshot_version);
});

test("P6 closes base activation and rollback CAS bypasses", async () => {
  const source = canonicalSource({ verification: "live_rechecked", viewsComplete: true });
  const first = await buildFixture(source, BUILD_EPOCH, "run_p6_cas_a");
  const exportRoot = path.join(first.parent, "export");
  await assert.rejects(publishSnapshot({
    snapshotDirectory: first.snapshot,
    exportRoot,
    activate: true,
    publishedAt: "2026-08-26T00:00:10.000Z",
  }), /expected_current_required/);
  await activateFixture(first, exportRoot, null, "2026-08-26T00:00:20.000Z");
  await assert.rejects(rollbackSnapshot({ exportRoot }), /expected_current_required/);
  const second = await buildFixture(source, "2026-08-26T00:01:00.000Z", "run_p6_cas_b");
  await assert.rejects(activateFixture(
    second,
    exportRoot,
    "snap_stale",
    "2026-08-26T00:01:10.000Z",
  ), /stale_current_pointer/);
  assert.equal((await readFormalSnapshot({ exportRoot })).pointer.snapshot_version, first.result.manifest.snapshot_version);
});

test("F19 every staging and pointer failure window preserves the old formal snapshot", async () => {
  const source = canonicalSource({ verification: "live_rechecked", viewsComplete: true });
  const first = await buildFixture(source, BUILD_EPOCH, "run_f19_a");
  const exportRoot = path.join(first.parent, "export");
  await activateFixture(first, exportRoot, null, "2026-08-26T00:00:10.000Z");
  const second = await buildFixture(source, "2026-08-26T00:01:00.000Z", "run_f19_b");
  const pointerBefore = await readFile(path.join(exportRoot, "current.json"), "utf8");
  for (const [index, failAt] of [
    "staging_copy",
    "staging_hash",
    "immutable_promote",
    "pointer_temp_write",
    "pointer_fsync",
    "pointer_rename",
    "pointer_directory_sync",
    "formal_readback",
    "post_switch_audit",
  ].entries()) {
    let recoveryCalls = 0;
    await assert.rejects(publishSnapshot({
      snapshotDirectory: second.snapshot,
      exportRoot,
      activate: true,
      expectedCurrentSnapshotVersion: first.result.manifest.snapshot_version,
      publishedAt: `2026-08-26T00:${String(2 + index).padStart(2, "0")}:00.000Z`,
      failAt,
      afterRecovery: async () => { recoveryCalls += 1; },
    }), /INJECTED_FAILURE|checksum mismatch/);
    assert.equal(await readFile(path.join(exportRoot, "current.json"), "utf8"), pointerBefore, failAt);
    assert.equal((await readFormalSnapshot({ exportRoot })).pointer.snapshot_version, first.result.manifest.snapshot_version, failAt);
    if (["pointer_directory_sync", "formal_readback", "post_switch_audit"].includes(failAt)) {
      assert.equal(recoveryCalls, 1, failAt);
    }
  }
  const staging = path.join(exportRoot, "staging");
  assert.deepEqual(await readdir(staging), []);
});

test("F19 rollback readback failure automatically restores the pre-rollback pointer", async () => {
  const source = canonicalSource({ verification: "live_rechecked", viewsComplete: true });
  const first = await buildFixture(source, BUILD_EPOCH, "run_f19_rb_a");
  const exportRoot = path.join(first.parent, "export");
  await activateFixture(first, exportRoot, null, "2026-08-26T00:00:10.000Z");
  const second = await buildFixture(source, "2026-08-26T00:01:00.000Z", "run_f19_rb_b");
  await activateFixture(second, exportRoot, first.result.manifest.snapshot_version, "2026-08-26T00:01:10.000Z");
  const pointerBefore = await readFile(path.join(exportRoot, "current.json"), "utf8");
  await assert.rejects(rollbackSnapshot({
    exportRoot,
    expectedCurrentSnapshotVersion: second.result.manifest.snapshot_version,
    rolledBackAt: "2026-08-26T00:02:00.000Z",
    failAt: "formal_readback",
  }), /INJECTED_FAILURE:formal_readback/);
  assert.equal(await readFile(path.join(exportRoot, "current.json"), "utf8"), pointerBefore);
  assert.equal((await readFormalSnapshot({ exportRoot })).pointer.snapshot_version, second.result.manifest.snapshot_version);
});

test("canonical JSON normalizes object key order and Unicode", () => {
  assert.equal(canonicalJson({ b: "e\u0301", a: 1 }), canonicalJson({ a: 1, b: "é" }));
  assert.equal(sha256(canonicalJson({ b: 2, a: 1 })), sha256('{"a":1,"b":2}'));
});

test("M2 persistent store coordinates CAS publication and sweeps only unprotected versions", async () => {
  const source = canonicalSource({ verification: "live_rechecked", viewsComplete: true });
  const first = await buildFixture(source, BUILD_EPOCH, "run_m2_a");
  const exportRoot = path.join(first.parent, "export");
  await activateFixture(first, exportRoot, null, "2026-08-26T00:00:10.000Z");
  const second = await buildFixture(source, "2026-08-26T00:01:00.000Z", "run_m2_b");
  await activateFixture(second, exportRoot, first.result.manifest.snapshot_version, "2026-08-26T00:01:10.000Z");
  const policy = { ...DEFAULT_M2_POLICY, max_versions: 2, retry_schedule_ms: [] };
  const enabled = await enablePersistentSnapshotStore({ exportRoot, enabledAt: "2026-08-26T00:02:00.000Z", policy });
  assert.equal(enabled.status, "healthy");
  assert.equal(enabled.versions.length, 2);

  const third = await buildFixture(source, "2026-08-26T00:03:00.000Z", "run_m2_c");
  const published = await coordinatedPublishSnapshot({
    snapshotDirectory: third.snapshot,
    exportRoot,
    expectedCurrentSnapshotVersion: second.result.manifest.snapshot_version,
    publishedAt: "2026-08-26T00:04:00.000Z",
  });
  assert.equal(published.pointer.snapshot_version, third.result.manifest.snapshot_version);
  assert.equal(published.pointer.previous_snapshot_version, second.result.manifest.snapshot_version);
  await assert.rejects(coordinatedPublishSnapshot({
    snapshotDirectory: first.snapshot,
    exportRoot,
    expectedCurrentSnapshotVersion: first.result.manifest.snapshot_version,
    publishedAt: "2026-08-26T00:05:00.000Z",
  }), /stale_current_pointer/);

  const sweep = await sweepPersistentSnapshotStore({ exportRoot, sweptAt: "2026-08-26T00:06:00.000Z", apply: true });
  assert.deepEqual(sweep.deleted_versions, [first.result.manifest.snapshot_version]);
  await assert.rejects(access(path.join(exportRoot, "published", first.result.manifest.snapshot_version)));
  await access(path.join(exportRoot, "published", second.result.manifest.snapshot_version));
  await access(path.join(exportRoot, "published", third.result.manifest.snapshot_version));
});

test("M2 publication lock fails closed without moving current", async () => {
  const source = canonicalSource({ verification: "live_rechecked", viewsComplete: true });
  const first = await buildFixture(source, BUILD_EPOCH, "run_lock_a");
  const exportRoot = path.join(first.parent, "export");
  await activateFixture(first, exportRoot, null, "2026-08-26T00:00:10.000Z");
  const second = await buildFixture(source, "2026-08-26T00:01:00.000Z", "run_lock_b");
  await activateFixture(second, exportRoot, first.result.manifest.snapshot_version, "2026-08-26T00:01:10.000Z");
  await enablePersistentSnapshotStore({
    exportRoot,
    enabledAt: "2026-08-26T00:02:00.000Z",
    policy: { ...DEFAULT_M2_POLICY, retry_schedule_ms: [] },
  });
  const pointerBefore = await readFile(path.join(exportRoot, "current.json"), "utf8");
  const lock = path.join(exportRoot, "m2", "runtime", "publish.lock");
  await mkdir(path.dirname(lock), { recursive: true });
  await writeFile(lock, "occupied\n", "utf8");
  const third = await buildFixture(source, "2026-08-26T00:03:00.000Z", "run_lock_c");
  await assert.rejects(coordinatedPublishSnapshot({
    snapshotDirectory: third.snapshot,
    exportRoot,
    expectedCurrentSnapshotVersion: second.result.manifest.snapshot_version,
    publishedAt: "2026-08-26T00:04:00.000Z",
  }), /publication_lock_busy/);
  assert.equal(await readFile(path.join(exportRoot, "current.json"), "utf8"), pointerBefore);
  await rm(lock, { force: true });
});

test("M2 post-switch audit failure restores both pointer and persistent store", async () => {
  const source = canonicalSource({ verification: "live_rechecked", viewsComplete: true });
  const first = await buildFixture(source, BUILD_EPOCH, "run_m2_recovery_a");
  const exportRoot = path.join(first.parent, "export");
  await activateFixture(first, exportRoot, null, "2026-08-26T00:00:10.000Z");
  const second = await buildFixture(source, "2026-08-26T00:01:00.000Z", "run_m2_recovery_b");
  await activateFixture(second, exportRoot, first.result.manifest.snapshot_version, "2026-08-26T00:01:10.000Z");
  await enablePersistentSnapshotStore({ exportRoot, enabledAt: "2026-08-26T00:02:00.000Z" });
  const third = await buildFixture(source, "2026-08-26T00:03:00.000Z", "run_m2_recovery_c");

  await assert.rejects(coordinatedPublishSnapshot({
    snapshotDirectory: third.snapshot,
    exportRoot,
    expectedCurrentSnapshotVersion: second.result.manifest.snapshot_version,
    publishedAt: "2026-08-26T00:04:00.000Z",
    failAt: "post_switch_audit",
  }), /INJECTED_FAILURE:post_switch_audit/);

  const formal = await readFormalSnapshot({ exportRoot });
  const store = await readPersistentSnapshotStoreStatus({ exportRoot });
  assert.equal(formal.pointer.snapshot_version, second.result.manifest.snapshot_version);
  assert.equal(store.current_snapshot_version, second.result.manifest.snapshot_version);
  assert.equal(store.status, "healthy");
});

test("M2 rollback uses the shared lock, Expected-Current CAS, readback and reconciliation", async () => {
  const source = canonicalSource({ verification: "live_rechecked", viewsComplete: true });
  const first = await buildFixture(source, BUILD_EPOCH, "run_m2_rb_a");
  const exportRoot = path.join(first.parent, "export");
  await activateFixture(first, exportRoot, null, "2026-08-26T00:00:10.000Z");
  const second = await buildFixture(source, "2026-08-26T00:01:00.000Z", "run_m2_rb_b");
  await activateFixture(second, exportRoot, first.result.manifest.snapshot_version, "2026-08-26T00:01:10.000Z");
  await enablePersistentSnapshotStore({ exportRoot, enabledAt: "2026-08-26T00:02:00.000Z" });
  await assert.rejects(coordinatedRollbackSnapshot({
    exportRoot,
    expectedCurrentSnapshotVersion: first.result.manifest.snapshot_version,
    rolledBackAt: "2026-08-26T00:03:00.000Z",
  }), /stale_current_pointer/);
  const result = await coordinatedRollbackSnapshot({
    exportRoot,
    expectedCurrentSnapshotVersion: second.result.manifest.snapshot_version,
    rolledBackAt: "2026-08-26T00:04:00.000Z",
  });
  assert.equal(result.pointer.snapshot_version, first.result.manifest.snapshot_version);
  assert.equal(result.store_status, "healthy");
  assert.equal((await readFormalSnapshot({ exportRoot })).pointer.snapshot_version, first.result.manifest.snapshot_version);
});

test("M2 reconciler repairs registry drift and raises a bounded failure alert", async () => {
  const source = canonicalSource({ verification: "live_rechecked", viewsComplete: true });
  const first = await buildFixture(source, BUILD_EPOCH, "run_reconcile_a");
  const exportRoot = path.join(first.parent, "export");
  await activateFixture(first, exportRoot, null, "2026-08-26T00:00:10.000Z");
  const second = await buildFixture(source, "2026-08-26T00:01:00.000Z", "run_reconcile_b");
  await activateFixture(second, exportRoot, first.result.manifest.snapshot_version, "2026-08-26T00:01:10.000Z");
  await enablePersistentSnapshotStore({ exportRoot, enabledAt: "2026-08-26T00:02:00.000Z" });

  const pointerPath = path.join(exportRoot, "current.json");
  const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  await writeFile(pointerPath, `${JSON.stringify({ ...pointer, manifest_sha256: "0".repeat(64) }, null, 2)}\n`, "utf8");
  let result;
  for (let index = 0; index < 3; index += 1) {
    result = await reconcilePersistentSnapshotStore({ exportRoot, reconciledAt: `2026-08-26T00:0${3 + index}:00.000Z` });
  }
  assert.equal(result.status, "degraded");
  assert.equal(result.active_alert.code, "snapshot_store_reconcile_failed");
  assert.equal(result.active_alert.consecutive_failures, 3);
  await writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`, "utf8");
  result = await reconcilePersistentSnapshotStore({ exportRoot, reconciledAt: "2026-08-26T00:06:00.000Z" });
  assert.equal(result.status, "healthy");
  assert.equal(result.consecutive_failures, 0);
  assert.equal(result.active_alert, null);
});
