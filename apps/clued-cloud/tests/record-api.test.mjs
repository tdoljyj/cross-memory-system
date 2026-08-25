import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  formatCanonicalRecordReference,
  presentCluedRecord,
} from "../app/record-presentation.ts";

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  return (await import(workerUrl.href)).default;
}

const baseEnv = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const projectId = "11111111-1111-4111-8111-111111111111";
const recordId = "22222222-2222-4222-8222-222222222222";
const recordFixture = {
  id: recordId,
  record_type: "state",
  status: "current",
  title: "Current priority",
  body: "Complete the G6 cross-entry evidence.",
  version: 7,
  updated_at: "2026-08-24T08:00:00.000Z",
};
const semanticContract = {
  version: "clued-v1.6-m1",
  read_order: [
    "global_registry_and_priority",
    "project_state_task_decision",
    "log_and_archive_on_demand",
  ],
  current_truth: ["state", "task", "decision"],
  history_on_demand: ["log", "archive"],
  write_order: [
    "canonical_entity",
    "event_and_receipt_same_transaction",
    "derived_views",
  ],
  canonical_id_field: "id",
  mirror_mode: "query_results_or_stable_id_references",
  mirror_layout: {
    global_directory: "Global",
    project_directory_pattern: "Projects/{canonical_project_id}",
    view_files: ["State.md", "Task.md", "Decision.md", "Archive.md", "Log.md"],
    entry_mode: "query_conclusion_or_stable_id_reference",
    entry_template: "- `{id}` — {title}: {conclusion} [status={status}; version={version}]",
  },
  project_creation: "explicit_confirmation_required",
  idempotency_boundary: "verified_user_and_operation_family",
  event_stream_ordering_enabled: false,
  record_merge_write_enabled: false,
  project_merge_write_enabled: false,
  canonical_export: "authorized_live_recheck",
  double_write: false,
};

test("keeps project views v2 off by default in API and MCP discovery", async () => {
  const worker = await loadWorker();
  const config = await worker.fetch(new Request("https://clued.test/v1/records/config"), baseEnv, ctx);
  assert.equal(config.status, 200);
  assert.deepEqual(await config.json(), { enabled: false, semantic_contract: semanticContract });

  const records = await worker.fetch(new Request("https://clued.test/v1/records"), baseEnv, ctx);
  assert.equal(records.status, 404);

  const tools = await worker.fetch(new Request("https://clued.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }), baseEnv, ctx);
  const names = (await tools.json()).result.tools.map((tool) => tool.name);
  assert.equal(names.includes("clued_record_list"), false);
  assert.equal(names.includes("clued_record_mutate"), false);
});

test("one fixture preserves canonical id and conclusion across REST, MCP, UI and Markdown", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  const rpcNames = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return Response.json({ id: projectId });
    const rpc = /\/rpc\/([^/?]+)$/.exec(url)?.[1];
    rpcNames.push(rpc);
    const body = JSON.parse(init.body);
    if (rpc === "clued_record_list") assert.match(body.p_token_hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(body.p_input, { level: "global", record_type: "state", limit: 10 });
    return Response.json({ status: "ok", records: [recordFixture] });
  };
  try {
    const env = { ...baseEnv, PROJECT_VIEWS_V2: "true" };
    const rest = await worker.fetch(new Request(
      "https://clued.test/v1/records?level=global&record_type=state&limit=10",
      { headers: { authorization: "Bearer account-jwt" } },
    ), env, ctx);
    const restResult = await rest.json();

    const mcp = await worker.fetch(new Request("https://clued.test/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer clued_bnd_${"x".repeat(43)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "clued_record_list",
          arguments: { level: "global", record_type: "state", limit: 10 },
        },
      }),
    }), env, ctx);
    const mcpResult = await mcp.json();

    const restRecord = restResult.records[0];
    const mcpRecord = mcpResult.result.structuredContent.records[0];
    assert.deepEqual(restRecord, recordFixture);
    assert.deepEqual(mcpRecord, recordFixture);
    assert.deepEqual(presentCluedRecord(restRecord, "State"), {
      id: recordId,
      title: "Current priority",
      conclusion: "Complete the G6 cross-entry evidence.",
      status: "current",
      version: 7,
      updatedAt: "2026-08-24T08:00:00.000Z",
    });
    assert.equal(
      formatCanonicalRecordReference(restRecord, "State"),
      "- `22222222-2222-4222-8222-222222222222` — Current priority: Complete the G6 cross-entry evidence. [status=current; version=7]",
    );
    assert.deepEqual(rpcNames, ["clued_user_record_list", "clued_record_list"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Global and Project reads share the authenticated record list RPC", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith("/auth/v1/user")) return Response.json({ id: projectId });
    assert.match(String(input), /\/rest\/v1\/rpc\/clued_user_record_list$/);
    assert.deepEqual(JSON.parse(init.body).p_input, {
      level: "project",
      project_id: projectId,
      record_type: "task",
      limit: 25,
    });
    return Response.json({ status: "ok", records: [{ id: recordId, record_type: "task", version: 1 }] });
  };
  try {
    const response = await worker.fetch(new Request(
      `https://clued.test/v1/records?level=project&project_id=${projectId}&record_type=task&limit=25`,
      { headers: { authorization: "Bearer account-jwt" } },
    ), { ...baseEnv, PROJECT_VIEWS_V2: "true" }, ctx);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).records[0].id, recordId);
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("known database not-found errors remain client-safe 404 responses", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/auth/v1/user")) return Response.json({ id: projectId });
    return Response.json(
      { code: "P0002", details: null, hint: null, message: "project_not_found" },
      { status: 500 },
    );
  };
  try {
    const response = await worker.fetch(new Request(
      `https://clued.test/v1/records?level=project&project_id=${projectId}&record_type=task&limit=25`,
      { headers: { authorization: "Bearer account-jwt" } },
    ), { ...baseEnv, PROJECT_VIEWS_V2: "true" }, ctx);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "project_not_found",
      details: { code: "P0002", details: null, hint: null, message: "project_not_found" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("REST and MCP writes delegate to the same canonical database core wrappers", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  const rpcNames = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return Response.json({ id: projectId });
    const rpc = /\/rpc\/([^/?]+)$/.exec(url)?.[1];
    rpcNames.push(rpc);
    const body = JSON.parse(init.body);
    if (rpc === "clued_record_mutate") assert.match(body.p_token_hash, /^[0-9a-f]{64}$/);
    return Response.json({ status: "committed", supplemental: { record: { id: recordId, record_type: "task", version: 1 } } });
  };
  const input = {
    operation: "create",
    id: recordId,
    idempotency_key: "record-create-0001",
    record_schema_version: 1,
    lifecycle_status: "active",
    scope: "global",
    record_type: "task",
    base_version: null,
    source_refs: [],
    source_unavailable_reason: null,
    mutation: { title: "Ship G4", content: "Turn the accepted contracts green.", type_fields: { execution_bucket: "now" }, relations: {} },
    authority: "user_explicit",
    confidence: 1,
    confidence_reason: "Explicit test input",
  };
  try {
    const rest = await worker.fetch(new Request("https://clued.test/v1/records", {
      method: "POST",
      headers: { authorization: "Bearer account-jwt", "content-type": "application/json" },
      body: JSON.stringify(input),
    }), { ...baseEnv, PROJECT_VIEWS_V2: "true" }, ctx);
    assert.equal(rest.status, 200);

    const mcp = await worker.fetch(new Request("https://clued.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer clued_bnd_${"x".repeat(43)}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "clued_record_mutate", arguments: input,
      } }),
    }), { ...baseEnv, PROJECT_VIEWS_V2: "true" }, ctx);
    assert.equal(mcp.status, 200);
    assert.deepEqual(rpcNames, ["clued_user_record_mutate", "clued_record_mutate"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("account UI exposes two levels and five query tabs only behind the v2 config", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /\/v1\/records\/config/);
  assert.match(source, /PROJECT_VIEWS_V2|recordsEnabled/);
  assert.match(source, /type RecordView = "state" \| "task" \| "decision" \| "archive" \| "log"/);
  assert.match(source, /\["global", "project"\]/);
  assert.match(source, /fetch\("\/v1\/records"/);
  assert.match(source, /presentCluedRecord\(record, recordViewLabels\[recordView\]\)/);
  assert.match(source, /canonicalIdLabel/);
  assert.match(source, /t\.canonicalIdLabel}: \{item\.id\}/);
  assert.match(source, /item\.conclusion/);
  assert.match(source, /item\.version/);
});
