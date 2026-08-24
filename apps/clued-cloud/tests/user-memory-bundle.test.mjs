import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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

test("User Memory Bundle v1 exports one canonical record payload plus read-only evidence", async () => {
  const { outputDirectory, result } = await exportedFixture();
  assert.equal(result.manifest.contract, BUNDLE_CONTRACT);
  assert.equal(result.manifest.counts.records, 5);
  assert.equal(result.manifest.counts.projects, 1);
  assert.equal(result.manifest.boundaries.production_canonical_store, "supabase");
  assert.equal(result.manifest.boundaries.direct_git_runtime_writes, false);
  assert.ok(result.manifest.evidence_files.includes("evidence/状态.md"));
  assert.ok(result.manifest.evidence_files.includes("evidence/contexts/projects/clued/日志.md"));
  assert.ok(result.manifest.excluded_system_paths.includes("object-index.json"));
  assert.ok(!result.manifest.files.some((file) => file.path.endsWith("object-index.json")));
  assert.ok(!result.manifest.files.some((file) => file.path.endsWith("routes.json")));

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

function mockCluedApi() {
  const projects = [];
  const records = [];
  const recordIdByKey = new Map();
  let projectCounter = 1;
  let recordCounter = 1;
  const uuid = (kind, number) => `00000000-0000-4000-8000-${kind}${String(number).padStart(11, "0")}`;

  return {
    projects,
    records,
    async fetch(url, init = {}) {
      const parsed = new URL(url);
      const body = init.body ? JSON.parse(init.body) : null;
      if (parsed.pathname === "/v1/records/config") {
        return Response.json({ enabled: true, semantic_contract: { version: "two-level-five-view-v1" } });
      }
      if (parsed.pathname === "/v1/projects" && (!init.method || init.method === "GET")) {
        return Response.json({ projects });
      }
      if (parsed.pathname === "/v1/projects/observe" && init.method === "POST") {
        let project = projects.find((item) => item.name.toLowerCase() === body.name.toLowerCase());
        if (!project) {
          project = {
            id: uuid("1", projectCounter++),
            name: body.name,
            certainty_status: body.intent === "confirmed" ? "confirmed" : "unconfirmed",
            progress_status: body.progress_status,
          };
          projects.push(project);
        }
        return Response.json({ status: "written", project });
      }
      if (parsed.pathname === "/v1/records" && init.method === "POST") {
        let id = recordIdByKey.get(body.idempotency_key);
        let record = records.find((item) => item.id === id);
        if (!record) {
          id = uuid("2", recordCounter++);
          recordIdByKey.set(body.idempotency_key, id);
          record = {
            id,
            ...body,
            project_id: body.project_id ?? null,
            version: 1,
          };
          records.push(record);
        }
        return Response.json({ status: "written", record });
      }
      if (parsed.pathname === "/v1/records" && (!init.method || init.method === "GET")) {
        const level = parsed.searchParams.get("level");
        const type = parsed.searchParams.get("record_type");
        const projectId = parsed.searchParams.get("project_id");
        const expectedType = type === "archive" ? "archive_snapshot" : type;
        return Response.json({
          records: records.filter((record) =>
            record.record_type === expectedType &&
            (level === "global" ? record.scope === "global" : record.project_id === projectId)),
        });
      }
      return Response.json({ error: "not-found" }, { status: 404 });
    },
  };
}

test("dry-run makes zero network writes and execute uses only authenticated Clued APIs", async () => {
  const { outputDirectory } = await exportedFixture();
  let fetchCalls = 0;
  const dryRun = await importUserMemoryBundle({
    bundleDirectory: outputDirectory,
    execute: false,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("network should not be called");
    },
  });
  assert.equal(dryRun.status, "dry_run");
  assert.equal(dryRun.network_writes, 0);
  assert.equal(fetchCalls, 0);

  const api = mockCluedApi();
  const imported = await importUserMemoryBundle({
    bundleDirectory: outputDirectory,
    execute: true,
    accessToken: "test-user-token",
    fetchImpl: api.fetch,
  });
  assert.equal(imported.receipt.projects.length, 1);
  assert.equal(imported.receipt.records.length, 5);
  assert.equal(imported.receipt.verification.verified, 5);
  assert.equal(api.projects.length, 1);
  assert.equal(api.records.length, 5);
  assert.ok(api.records.every((record) => !Object.hasOwn(record, "user_id")));
});
