import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rename, symlink, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BUNDLE_CONTRACT,
  exportUserMemoryBundle,
  mapMemoryObject,
  validateUserMemoryBundle,
} from "../scripts/user-memory-bundle.mjs";
import {
  buildImportPlan,
  importUserMemoryBundle,
} from "../scripts/user-memory-bundle-import.mjs";

const SOURCE_COMMIT = "a".repeat(40);
const CREATED_AT = "2026-08-25T00:00:00.000Z";

function memoryObject({ id, category, scope = "global", projectId = null, status = "active", content }) {
  return {
    schema_version: 1,
    id,
    type: category === "history" ? "episodic" : category === "state" ? "state" : "semantic",
    scope,
    content,
    status,
    source: {
      kind: "user_explicit",
      adapter: "test",
      session_id: null,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    },
    temporal: { valid_from: null, valid_until: null },
    relations: { supersedes: [], superseded_by: [], contradicts: [], related: [] },
    classification: {
      memory_layer: category,
      category,
      recall_layer: category === "history" ? "L4" : "L3",
      priority: category === "state" ? "high" : "medium",
    },
    provenance: { evidence: "explicit", source_ref: null },
    tags: [],
    entities: [],
    ...(projectId ? { project_id: projectId } : {}),
  };
}

async function fixtureMemory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "clued-umb-memory-"));
  await mkdir(path.join(root, "objects"), { recursive: true });
  await mkdir(path.join(root, "contexts", "projects", "clued"), { recursive: true });
  await mkdir(path.join(root, "audit"), { recursive: true });
  const objects = [
    memoryObject({ id: "mem_a1", category: "state", content: "Current global state body." }),
    memoryObject({ id: "mem_b2", category: "todo", content: "Complete the portable bundle." }),
    memoryObject({ id: "mem_c3", category: "decision", content: "Supabase remains canonical." }),
    memoryObject({ id: "mem_d4", category: "history", status: "superseded", content: "Old historical evidence." }),
    memoryObject({
      id: "mem_e5",
      category: "state",
      scope: "project",
      projectId: "clued",
      content: "Clued project is active.",
    }),
  ];
  for (const object of objects) {
    await writeFile(path.join(root, "objects", `${object.id}.json`), `${JSON.stringify(object, null, 2)}\n`);
  }
  for (const name of ["画像.md", "状态.md", "决策.md", "待办.md", "归档.md"]) {
    await writeFile(path.join(root, name), `# ${name}\nprivate legacy evidence\n`);
  }
  await writeFile(path.join(root, "contexts", "projects", "clued", "日志.md"), "# log\nlegacy evidence\n");
  await writeFile(path.join(root, "contexts", "routes.json"), "{\"system\":true}\n");
  await writeFile(path.join(root, "object-index.json"), "{\"derived\":true}\n");
  await writeFile(path.join(root, "index.json"), "{\"system\":true}\n");
  await writeFile(path.join(root, "audit", "audit.log"), "audit evidence\n");
  return root;
}

async function exportedFixture() {
  const memoryDirectory = await fixtureMemory();
  const parent = await mkdtemp(path.join(os.tmpdir(), "clued-umb-output-"));
  const outputDirectory = path.join(parent, "bundle");
  const result = await exportUserMemoryBundle({
    memoryDirectory,
    outputDirectory,
    sourceGitCommit: SOURCE_COMMIT,
    createdAt: CREATED_AT,
  });
  return { memoryDirectory, outputDirectory, result };
}

test("User Memory Bundle v2 exports one canonical record payload plus read-only evidence", async () => {
  const { outputDirectory, result } = await exportedFixture();
  assert.equal(result.manifest.contract, BUNDLE_CONTRACT);
  assert.equal(result.manifest.schema_version, 2);
  assert.equal(result.manifest.contract_version, "2.0.0");
  assert.equal(result.manifest.counts.records, 5);
  assert.equal(result.manifest.counts.projects, 1);
  assert.equal(result.manifest.boundaries.production_canonical_store, "supabase");
  assert.equal(result.manifest.boundaries.direct_git_runtime_writes, false);
  assert.equal(result.manifest.boundaries.bundle_role, "portable_single_user_historical_export");
  assert.equal(result.manifest.boundaries.fixture_authority, false);
  assert.equal(result.manifest.boundaries.current_truth_authority, false);
  assert.ok(result.manifest.evidence_files.includes("evidence/状态.md"));
  assert.ok(result.manifest.evidence_files.includes("evidence/contexts/projects/clued/日志.md"));
  assert.ok(result.manifest.excluded_system_paths.includes("object-index.json"));
  assert.ok(!result.manifest.files.some((file) => file.path.endsWith("object-index.json")));
  assert.ok(!result.manifest.files.some((file) => file.path.endsWith("routes.json")));
  assert.equal("certainty_status" in result.projects[0], false);
  assert.match(result.projects[0].recognition_evidence, /material-work evidence/);

  const mirror = await readFile(path.join(outputDirectory, "Global", "State.md"), "utf8");
  assert.match(mirror, /`mem_a1`/);
  assert.doesNotMatch(mirror, /Current global state body/);
  await validateUserMemoryBundle(outputDirectory);
});

test("mapping is conservative, deterministic, and preserves source IDs for idempotency", async () => {
  const { outputDirectory, result } = await exportedFixture();
  const byId = new Map(result.records.map((record) => [record.source_id, record]));
  assert.equal(byId.get("mem_a1").record_type, "state");
  assert.equal(byId.get("mem_b2").record_type, "task");
  assert.equal(byId.get("mem_c3").record_type, "decision");
  assert.equal(byId.get("mem_d4").record_type, "archive_snapshot");
  assert.equal(byId.get("mem_e5").source_project_id, "clued");
  assert.equal(byId.get("mem_a1").status, "current");
  assert.equal(byId.get("mem_b2").status, "in_progress");
  assert.equal(byId.get("mem_c3").status, "active");
  assert.equal(byId.get("mem_d4").status, "archived");

  assert.equal(mapMemoryObject(memoryObject({
    id: "mem_f6",
    category: "preference",
    status: "candidate",
    content: "Candidate preferences must not become current truth.",
  })).status, "archived");
  assert.equal(mapMemoryObject(memoryObject({
    id: "mem_f7",
    category: "todo",
    status: "candidate",
    content: "Candidate tasks remain in backlog.",
  })).status, "backlog");

  const first = buildImportPlan(await validateUserMemoryBundle(outputDirectory));
  const second = buildImportPlan(await validateUserMemoryBundle(outputDirectory));
  assert.deepEqual(first, second);
  assert.equal(new Set(first.record_actions.map((action) => action.request.idempotency_key)).size, 5);
  assert.ok(first.record_actions.every((action) => !Object.hasOwn(action.request, "user_id")));
});

test("validation fails closed when a payload checksum changes", async () => {
  const { outputDirectory } = await exportedFixture();
  await writeFile(path.join(outputDirectory, "records.jsonl"), "{}\n", "utf8");
  await assert.rejects(
    validateUserMemoryBundle(outputDirectory),
    /checksum mismatch/,
  );
});

async function redirectOutside(root, relative, type = "junction") {
  // Deliberately share the root's string prefix to defeat startsWith-only guards.
  const outside = `${root}-outside`;
  await mkdir(outside, { recursive: true });
  const target = path.join(outside, path.basename(relative));
  await rename(path.join(root, relative), target);
  await symlink(target, path.join(root, relative), type);
}

for (const relative of ["objects", "contexts", "audit"]) {
  test(`export refuses an outside ${relative} junction, including prefix-sharing siblings`, async () => {
    const memoryDirectory = await fixtureMemory();
    await redirectOutside(memoryDirectory, relative);
    const parent = await mkdtemp(path.join(os.tmpdir(), "clued-umb-denied-"));
    await assert.rejects(exportUserMemoryBundle({ memoryDirectory, outputDirectory: path.join(parent, "bundle"),
      sourceGitCommit: SOURCE_COMMIT, createdAt: CREATED_AT }), /Path escapes authorized root/);
  });
}

for (const relative of ["objects/mem_a1.json", "状态.md"]) {
  test(`export refuses an outside file link at ${relative}`, async t => {
    const memoryDirectory = await fixtureMemory();
    try { await redirectOutside(memoryDirectory, relative, "file"); }
    catch (error) { if (error.code === "EPERM") { t.skip("OS does not grant file symlink creation; directory junction cases still run"); return; } throw error; }
    const parent = await mkdtemp(path.join(os.tmpdir(), "clued-umb-denied-"));
    await assert.rejects(exportUserMemoryBundle({ memoryDirectory, outputDirectory: path.join(parent, "bundle"),
      sourceGitCommit: SOURCE_COMMIT, createdAt: CREATED_AT }), /Path escapes authorized root/);
  });
}

test("validator refuses a manifest descriptor whose ancestor is an outside junction despite matching hashes", async () => {
  const { outputDirectory } = await exportedFixture();
  await redirectOutside(outputDirectory, "evidence");
  await assert.rejects(validateUserMemoryBundle(outputDirectory), /Path escapes authorized root/);
});

for (const relative of ["manifest.json", "records.jsonl", "projects.jsonl"]) {
  test(`validator refuses outside ${relative} symlink with unchanged content`, async t => {
    const { outputDirectory } = await exportedFixture();
    try { await redirectOutside(outputDirectory, relative, "file"); }
    catch (error) { if (error.code === "EPERM") { t.skip("OS does not grant file symlink creation; ancestor junction case still runs"); return; } throw error; }
    await assert.rejects(validateUserMemoryBundle(outputDirectory), /Path escapes authorized root/);
  });
}

test("an explicitly selected root reached through a junction remains a valid authorized root", async () => {
  const memoryDirectory = await fixtureMemory();
  const parent = await mkdtemp(path.join(os.tmpdir(), "clued-umb-root-link-"));
  const selectedRoot = path.join(parent, "selected-memory");
  await symlink(memoryDirectory, selectedRoot, "junction");
  const result = await exportUserMemoryBundle({ memoryDirectory: selectedRoot, outputDirectory: path.join(parent, "bundle"),
    sourceGitCommit: SOURCE_COMMIT, createdAt: CREATED_AT });
  assert.equal(result.records.length, 5);
});

test("dry-run is explicitly historical mapping with zero network and filesystem writes", async () => {
  const { outputDirectory } = await exportedFixture();
  const targets = await mkdtemp(path.join(os.tmpdir(), "clued-umb-no-writes-"));
  let networkCalls = 0;
  const result = await importUserMemoryBundle({ bundleDirectory: outputDirectory, execute: false,
    receiptPath: path.join(targets, "receipt.json"), targetMirrorDirectory: path.join(targets, "mirrors"),
    fetchImpl: async () => { networkCalls += 1; throw new Error("unexpected network"); } });
  assert.equal(result.status, "dry_run"); assert.equal(result.projects, 1); assert.equal(result.records, 5);
  assert.equal(result.mapping_status, "historical_contract_only"); assert.equal(result.executable, false);
  assert.equal(result.fixture_authority, false); assert.equal(result.current_truth_authority, false);
  assert.equal(result.network_writes, 0); assert.equal(result.filesystem_writes, 0); assert.equal(networkCalls, 0);
  assert.deepEqual(await readdir(targets), []);
});

test("retired execute rejects before validation, project resolution, network or output writes", async () => {
  const targets = await mkdtemp(path.join(os.tmpdir(), "clued-umb-execute-retired-"));
  let networkCalls = 0;
  await assert.rejects(importUserMemoryBundle({ bundleDirectory: path.join(targets, "does-not-exist"), execute: true,
    accessToken: "synthetic-test-token", verify: false,
    receiptPath: path.join(targets, "receipt.json"), targetMirrorDirectory: path.join(targets, "mirrors"),
    fetchImpl: async () => { networkCalls += 1; throw new Error("unexpected network"); },
  }), /USER_MEMORY_BUNDLE_EXECUTE_RETIRED/);
  assert.equal(networkCalls, 0); assert.deepEqual(await readdir(targets), []);
});

test("CLI --execute is retired even with --no-verify and never creates output files", async () => {
  const targets = await mkdtemp(path.join(os.tmpdir(), "clued-umb-cli-retired-"));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/user-memory-bundle-import.mjs', import.meta.url)),
    '--execute', '--no-verify', '--bundle', path.join(targets, 'missing'),
    '--receipt', path.join(targets, 'receipt.json'), '--target-mirror', path.join(targets, 'mirrors')], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /USER_MEMORY_BUNDLE_EXECUTE_RETIRED/);
  assert.deepEqual(await readdir(targets), []);
});

test("historical fixture wording remains readable but grants neither fixture nor current authority", async () => {
  const { outputDirectory } = await exportedFixture();
  const manifestPath = path.join(outputDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.boundaries.bundle_role = "portable_single_user_export_and_import_fixture";
  delete manifest.boundaries.fixture_authority; delete manifest.boundaries.current_truth_authority;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const plan = buildImportPlan(await validateUserMemoryBundle(outputDirectory));
  assert.equal(plan.executable, false); assert.equal(plan.fixture_authority, false); assert.equal(plan.current_truth_authority, false);
  assert.equal(plan.mapping_status, "historical_contract_only");
  assert.doesNotMatch(plan.project_actions[0].request.summary, /fixture/);
  const preview = await importUserMemoryBundle({ bundleDirectory: outputDirectory });
  assert.equal(preview.fixture_authority, false); assert.equal(preview.executable, false);
});
