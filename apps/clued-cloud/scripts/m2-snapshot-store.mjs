#!/usr/bin/env node

import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  publishSnapshot,
  rollbackSnapshot,
  sha256,
  validateSnapshot,
  withSnapshotPublicationLock,
} from "./two-level-snapshot.mjs";

export const M2_STORE_SCHEMA_VERSION = 1;
export const M2_STORE_CONTRACT = "clued.m2.persistent-snapshot-store";
export const DEFAULT_M2_POLICY = Object.freeze({
  min_versions: 2,
  max_versions: 12,
  failure_alert_threshold: 3,
  stale_lock_seconds: 900,
  retry_schedule_ms: [100, 500, 2_000],
});

function normalize(value) {
  if (typeof value === "string") return value.normalize("NFC").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  }
  return value;
}

function prettyJson(value) {
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

function assertIso(value, field) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${field} must be an ISO timestamp.`);
}

function assertPolicy(policy) {
  if (!Number.isInteger(policy.min_versions) || policy.min_versions < 2) throw new Error("min_versions must be at least 2.");
  if (!Number.isInteger(policy.max_versions) || policy.max_versions < policy.min_versions) throw new Error("max_versions must be >= min_versions.");
  if (!Number.isInteger(policy.failure_alert_threshold) || policy.failure_alert_threshold < 1) throw new Error("failure_alert_threshold must be positive.");
  if (!Number.isInteger(policy.stale_lock_seconds) || policy.stale_lock_seconds < 1) throw new Error("stale_lock_seconds must be positive.");
  if (!Array.isArray(policy.retry_schedule_ms) || policy.retry_schedule_ms.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error("retry_schedule_ms must contain non-negative integers.");
  }
}

function storePaths(exportRoot) {
  const root = path.resolve(exportRoot);
  const m2 = path.resolve(root, "m2");
  return {
    root,
    m2,
    store: path.resolve(m2, "store.json"),
    reports: path.resolve(m2, "reports"),
    runtime: path.resolve(m2, "runtime"),
    lock: path.resolve(m2, "runtime", "publish.lock"),
    current: path.resolve(root, "current.json"),
    published: path.resolve(root, "published"),
  };
}

async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.resolve(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${sha256(canonicalJson(value)).slice(0, 12)}.tmp`);
  await writeFile(temporary, prettyJson(value), "utf8");
  const handle = await open(temporary, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, filePath);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function withPublicationLock(paths, options, callback) {
  return withSnapshotPublicationLock({
    exportRoot: paths.root,
    occurredAt: options.now,
    operation: options.operation,
    policy: options.policy,
  }, callback);
}

async function inspectPointer(paths) {
  const pointer = await readJson(paths.current);
  if (pointer.pointer_schema_version !== 1 || typeof pointer.snapshot_version !== "string") throw new Error("invalid_current_pointer");
  const expectedBundle = `published/${pointer.snapshot_version}/memory`;
  if (pointer.bundle_path !== expectedBundle) throw new Error("current_pointer_bundle_path_mismatch");
  const snapshotRoot = path.resolve(paths.published, pointer.snapshot_version);
  const { manifest } = await validateSnapshot(snapshotRoot);
  const manifestHash = sha256(await readFile(path.resolve(snapshotRoot, "memory", "manifest.json")));
  if (manifestHash !== pointer.manifest_sha256) throw new Error("current_pointer_manifest_hash_mismatch");
  if (manifest.status !== "ready") throw new Error("current_pointer_not_ready");
  return { pointer, manifest, manifestHash };
}

async function inspectVersions(paths) {
  const entries = await readdir(paths.published, { withFileTypes: true });
  const versions = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    const snapshotRoot = path.resolve(paths.published, entry.name);
    try {
      const { manifest } = await validateSnapshot(snapshotRoot);
      const manifestHash = sha256(await readFile(path.resolve(snapshotRoot, "memory", "manifest.json")));
      versions.push({
        snapshot_version: manifest.snapshot_version,
        status: "ready",
        baseline_claim: manifest.baseline_claim,
        canonical_version: manifest.canonical_version,
        build_epoch: manifest.build_epoch,
        bundle_path: `published/${manifest.snapshot_version}/memory`,
        manifest_sha256: manifestHash,
      });
    } catch (error) {
      versions.push({ snapshot_version: entry.name, status: "invalid", error_code: error.message });
    }
  }
  return versions;
}

function assertStore(store) {
  if (store.schema_version !== M2_STORE_SCHEMA_VERSION || store.contract !== M2_STORE_CONTRACT || store.enabled !== true) {
    throw new Error("M2 persistent snapshot store is not enabled.");
  }
  assertPolicy(store.policy);
}

async function writeReport(paths, name, report) {
  await atomicWriteJson(path.resolve(paths.reports, name), report);
}

export async function enablePersistentSnapshotStore({ exportRoot, enabledAt, policy = DEFAULT_M2_POLICY }) {
  assertIso(enabledAt, "enabledAt");
  assertPolicy(policy);
  const paths = storePaths(exportRoot);
  const current = await inspectPointer(paths);
  const versions = await inspectVersions(paths);
  const invalid = versions.filter((item) => item.status !== "ready");
  if (invalid.length > 0) throw new Error("Cannot enable M2 with invalid published snapshots.");
  if (versions.length < policy.min_versions) throw new Error("Persistent store requires at least min_versions ready snapshots.");
  const store = {
    schema_version: M2_STORE_SCHEMA_VERSION,
    contract: M2_STORE_CONTRACT,
    enabled: true,
    enabled_at: enabledAt,
    status: "healthy",
    current_snapshot_version: current.pointer.snapshot_version,
    previous_snapshot_version: current.pointer.previous_snapshot_version ?? null,
    policy: structuredClone(policy),
    capabilities: {
      persistent_versions: true,
      coordinated_publish: true,
      bounded_retry: true,
      reconciler: true,
      sweeper_gc: true,
      file_alerts: true,
      event_rollup: false,
      index_sharding: false,
      semantic_assist: false,
      workspace_team: false,
    },
    consecutive_failures: 0,
    active_alert: null,
    versions,
    last_reconcile: null,
    last_sweep: null,
  };
  await atomicWriteJson(paths.store, store);
  await writeReport(paths, "enable.json", {
    report_schema_version: 1,
    operation: "enable_persistent_snapshot_store",
    status: "success",
    occurred_at: enabledAt,
    current_snapshot_version: store.current_snapshot_version,
    ready_version_count: versions.length,
    policy: store.policy,
  });
  return store;
}

async function reconcileUnlocked(paths, store, reconciledAt) {
  const issues = [];
  let current = null;
  try {
    current = await inspectPointer(paths);
  } catch (error) {
    issues.push(error.message);
  }
  const versions = await inspectVersions(paths);
  for (const invalid of versions.filter((item) => item.status !== "ready")) issues.push(`invalid_snapshot:${invalid.snapshot_version}:${invalid.error_code}`);
  if (current && !versions.some((item) => item.status === "ready" && item.snapshot_version === current.pointer.snapshot_version)) {
    issues.push("current_snapshot_missing_from_registry");
  }
  const failures = issues.length === 0 ? 0 : store.consecutive_failures + 1;
  const alertActive = failures >= store.policy.failure_alert_threshold;
  const next = {
    ...store,
    status: issues.length === 0 ? "healthy" : "degraded",
    current_snapshot_version: current?.pointer.snapshot_version ?? store.current_snapshot_version,
    previous_snapshot_version: current?.pointer.previous_snapshot_version ?? store.previous_snapshot_version,
    consecutive_failures: failures,
    active_alert: alertActive ? {
      code: "snapshot_store_reconcile_failed",
      first_observed_at: store.active_alert?.first_observed_at ?? reconciledAt,
      last_observed_at: reconciledAt,
      consecutive_failures: failures,
      issues,
    } : null,
    versions,
    last_reconcile: {
      status: issues.length === 0 ? "success" : "failed",
      occurred_at: reconciledAt,
      repaired_registry: canonicalJson(store.versions) !== canonicalJson(versions),
      issues,
    },
  };
  await atomicWriteJson(paths.store, next);
  await writeReport(paths, "latest-reconcile.json", next.last_reconcile);
  return next;
}

export async function reconcilePersistentSnapshotStore({ exportRoot, reconciledAt }) {
  assertIso(reconciledAt, "reconciledAt");
  const paths = storePaths(exportRoot);
  const store = await readJson(paths.store);
  assertStore(store);
  return withPublicationLock(paths, { now: reconciledAt, policy: store.policy, operation: "reconcile" }, () => reconcileUnlocked(paths, store, reconciledAt));
}

export async function coordinatedPublishSnapshot({ snapshotDirectory, exportRoot, expectedCurrentSnapshotVersion, publishedAt, failAt = null }) {
  assertIso(publishedAt, "publishedAt");
  if (typeof expectedCurrentSnapshotVersion !== "string" || expectedCurrentSnapshotVersion.length === 0) throw new Error("expectedCurrentSnapshotVersion is required.");
  const paths = storePaths(exportRoot);
  const store = await readJson(paths.store);
  assertStore(store);
  let storeStatus = store.status;
  const published = await publishSnapshot({
    snapshotDirectory,
    exportRoot,
    activate: true,
    expectedCurrentSnapshotVersion,
    publishedAt,
    failAt,
    lockPolicy: store.policy,
    afterSwitch: async () => {
      const next = await reconcileUnlocked(paths, store, publishedAt);
      storeStatus = next.status;
      if (next.status !== "healthy") throw new Error("post_publish_reconcile_failed");
    },
    afterRecovery: async () => {
      await reconcileUnlocked(paths, store, publishedAt);
    },
  });
  return { ...published, store_status: storeStatus };
}

export async function coordinatedRollbackSnapshot({ exportRoot, expectedCurrentSnapshotVersion, rolledBackAt, failAt = null }) {
  assertIso(rolledBackAt, "rolledBackAt");
  if (typeof expectedCurrentSnapshotVersion !== "string" || expectedCurrentSnapshotVersion.length === 0) throw new Error("expectedCurrentSnapshotVersion is required.");
  const paths = storePaths(exportRoot);
  const store = await readJson(paths.store);
  assertStore(store);
  let storeStatus = store.status;
  const rolledBack = await rollbackSnapshot({
    exportRoot,
    expectedCurrentSnapshotVersion,
    rolledBackAt,
    failAt,
    lockPolicy: store.policy,
    afterSwitch: async () => {
      const next = await reconcileUnlocked(paths, store, rolledBackAt);
      storeStatus = next.status;
      if (next.status !== "healthy") throw new Error("post_rollback_reconcile_failed");
    },
    afterRecovery: async () => {
      await reconcileUnlocked(paths, store, rolledBackAt);
    },
  });
  return { ...rolledBack, store_status: storeStatus };
}

function protectedVersions(store) {
  const protectedSet = new Set([store.current_snapshot_version, store.previous_snapshot_version].filter(Boolean));
  const ready = store.versions
    .filter((item) => item.status === "ready")
    .sort((left, right) => Date.parse(right.build_epoch) - Date.parse(left.build_epoch));
  for (const version of ready.slice(0, store.policy.min_versions)) protectedSet.add(version.snapshot_version);
  return protectedSet;
}

export async function sweepPersistentSnapshotStore({ exportRoot, sweptAt, apply = false }) {
  assertIso(sweptAt, "sweptAt");
  const paths = storePaths(exportRoot);
  const store = await readJson(paths.store);
  assertStore(store);
  return withPublicationLock(paths, { now: sweptAt, policy: store.policy, operation: apply ? "sweep_apply" : "sweep_dry_run" }, async () => {
    const current = await inspectPointer(paths);
    if (current.pointer.snapshot_version !== store.current_snapshot_version) throw new Error("store_pointer_drift_requires_reconcile");
    const ready = store.versions
      .filter((item) => item.status === "ready")
      .sort((left, right) => Date.parse(right.build_epoch) - Date.parse(left.build_epoch));
    const keep = protectedVersions(store);
    for (const version of ready.slice(0, store.policy.max_versions)) keep.add(version.snapshot_version);
    const candidates = ready.filter((item) => !keep.has(item.snapshot_version));
    if (apply) {
      for (const candidate of candidates) await rm(path.resolve(paths.published, candidate.snapshot_version), { recursive: true, force: false });
    }
    const versions = apply ? await inspectVersions(paths) : store.versions;
    const result = {
      status: "success",
      occurred_at: sweptAt,
      mode: apply ? "apply" : "dry_run",
      protected_versions: [...keep].sort(),
      candidate_versions: candidates.map((item) => item.snapshot_version).sort(),
      deleted_versions: apply ? candidates.map((item) => item.snapshot_version).sort() : [],
    };
    const next = { ...store, versions, last_sweep: result };
    await atomicWriteJson(paths.store, next);
    await writeReport(paths, "latest-sweep.json", result);
    return result;
  });
}

export async function readPersistentSnapshotStoreStatus({ exportRoot }) {
  const paths = storePaths(exportRoot);
  const store = await readJson(paths.store);
  assertStore(store);
  return store;
}

function parseArgs(argv) {
  const command = argv[0];
  const options = {};
  const flags = new Set(["--apply"]);
  for (let index = 1; index < argv.length; index += 1) {
    const name = argv[index];
    if (flags.has(name)) { options[name.slice(2)] = true; continue; }
    if (!["--export-root", "--snapshot", "--expected-current", "--at"].includes(name)) throw new Error(`Unknown argument: ${name}`);
    const value = argv[++index];
    if (!value) throw new Error(`${name} requires a value.`);
    options[name.slice(2).replaceAll("-", "_")] = value;
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const exportRoot = path.resolve(options.export_root);
  const at = options.at ?? new Date().toISOString();
  if (command === "enable") {
    const result = await enablePersistentSnapshotStore({ exportRoot, enabledAt: at });
    process.stdout.write(`${JSON.stringify({ status: result.status, capability: "persistent_snapshot_store", versions: result.versions.length })}\n`);
    return;
  }
  if (command === "status") {
    const result = await readPersistentSnapshotStoreStatus({ exportRoot });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "reconcile") {
    const result = await reconcilePersistentSnapshotStore({ exportRoot, reconciledAt: at });
    process.stdout.write(`${JSON.stringify({ status: result.status, consecutive_failures: result.consecutive_failures, alert: result.active_alert })}\n`);
    return;
  }
  if (command === "sweep") {
    const result = await sweepPersistentSnapshotStore({ exportRoot, sweptAt: at, apply: options.apply ?? false });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "publish") {
    const result = await coordinatedPublishSnapshot({
      snapshotDirectory: path.resolve(options.snapshot),
      exportRoot,
      expectedCurrentSnapshotVersion: options.expected_current,
      publishedAt: at,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "rollback") {
    const result = await coordinatedRollbackSnapshot({
      exportRoot,
      expectedCurrentSnapshotVersion: options.expected_current,
      rolledBackAt: at,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error("Usage: m2-snapshot-store.mjs <enable|status|reconcile|sweep|publish|rollback> --export-root <path> [options]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
