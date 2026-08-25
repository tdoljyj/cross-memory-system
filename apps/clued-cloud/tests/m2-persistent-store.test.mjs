import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { readPersistentSnapshotStoreStatus } from "../scripts/m2-snapshot-store.mjs";
import { sha256, validateSnapshot } from "../scripts/two-level-snapshot.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const exportRoot = path.resolve(repoRoot, "artifacts", "clued-two-level-snapshots");

test("installed M2 capability set is threshold-scoped and preserves disabled gates", async () => {
  const evaluation = JSON.parse(await readFile(path.resolve(exportRoot, "m2", "threshold-evaluation.json"), "utf8"));
  assert.equal(evaluation.contract, "clued.m2.threshold-evaluation");
  assert.equal(evaluation.capabilities.persistent_snapshot_store.enabled, true);
  assert.equal(evaluation.capabilities.event_rollup_and_cold_storage.enabled, false);
  assert.equal(evaluation.capabilities.event_rollup_and_cold_storage.observed.sequenced_events, 0);
  assert.equal(evaluation.capabilities.index_sharding.enabled, false);
  assert.ok(evaluation.capabilities.index_sharding.observed.index_bytes < evaluation.capabilities.index_sharding.thresholds.index_bytes);
  assert.ok(evaluation.capabilities.index_sharding.observed.parse_p95_ms < evaluation.capabilities.index_sharding.thresholds.parse_p95_ms);
  assert.equal(evaluation.capabilities.semantic_assist.enabled, false);
  assert.equal(evaluation.capabilities.workspace_team.enabled, false);
});

test("installed M2 store points to one ready immutable current version", async () => {
  const store = await readPersistentSnapshotStoreStatus({ exportRoot });
  const pointer = JSON.parse(await readFile(path.resolve(exportRoot, "current.json"), "utf8"));
  assert.equal(store.status, "healthy");
  assert.equal(store.active_alert, null);
  assert.equal(store.current_snapshot_version, pointer.snapshot_version);
  assert.ok(store.versions.length >= store.policy.min_versions);
  assert.ok(store.versions.every((version) => version.status === "ready"));
  const snapshotRoot = path.resolve(exportRoot, "published", pointer.snapshot_version);
  const { manifest } = await validateSnapshot(snapshotRoot);
  assert.equal(manifest.status, "ready");
  assert.equal(manifest.views_complete, true);
  assert.equal(sha256(await readFile(path.resolve(snapshotRoot, "memory", "manifest.json"))), pointer.manifest_sha256);
});
