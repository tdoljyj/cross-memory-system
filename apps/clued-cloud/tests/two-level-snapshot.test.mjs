import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSnapshot,
  canonicalJson,
  publishSnapshot,
  rollbackSnapshot,
  sha256,
  validateSnapshot,
} from "../scripts/two-level-snapshot.mjs";

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
  await assert.rejects(publishSnapshot({ snapshotDirectory: clean.snapshot, exportRoot, activate: true }), /live-rechecked/);
});

test("failure injection preserves the formal pointer and rollback restores the previous immutable version", async () => {
  const source = canonicalSource({ verification: "live_rechecked", viewsComplete: true });
  const first = await buildFixture(source, BUILD_EPOCH, "run_current_a");
  const exportRoot = path.join(first.parent, "export");
  await publishSnapshot({ snapshotDirectory: first.snapshot, exportRoot, activate: true });
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
  await publishSnapshot({ snapshotDirectory: second.snapshot, exportRoot, activate: true });
  const secondPointer = JSON.parse(await readFile(path.join(exportRoot, "current.json"), "utf8"));
  assert.equal(secondPointer.previous_snapshot_version, firstPointer.snapshot_version);
  const rolledBack = await rollbackSnapshot({ exportRoot });
  assert.equal(rolledBack.pointer.snapshot_version, firstPointer.snapshot_version);
  assert.equal(rolledBack.pointer.previous_snapshot_version, secondPointer.snapshot_version);
});

test("canonical JSON normalizes object key order and Unicode", () => {
  assert.equal(canonicalJson({ b: "e\u0301", a: 1 }), canonicalJson({ a: 1, b: "é" }));
  assert.equal(sha256(canonicalJson({ b: 2, a: 1 })), sha256('{"a":1,"b":2}'));
});
