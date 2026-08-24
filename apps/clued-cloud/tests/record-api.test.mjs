import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  return (await import(workerUrl.href)).default;
}

const baseEnv = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const projectId = "11111111-1111-4111-8111-111111111111";
const recordId = "22222222-2222-4222-8222-222222222222";

test("keeps project views v2 off by default in API and MCP discovery", async () => {
  const worker = await loadWorker();
  const config = await worker.fetch(new Request("https://clued.test/v1/records/config"), baseEnv, ctx);
  assert.equal(config.status, 200);
  assert.deepEqual(await config.json(), { enabled: false });

  const records = await worker.fetch(new Request("https://clued.test/v1/records"), baseEnv, ctx);
  assert.equal(records.status, 404);

  const tools = await worker.fetch(new Request("https://clued.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }), baseEnv, ctx);
  const names = (await tools.json()).result.tools.map((tool) => tool.name);
  assert.equal(names.includes("clued_record_list"), false);
  assert.equal(names.includes("clued_record_write"), false);
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
    if (rpc === "clued_record_write") assert.match(body.p_token_hash, /^[0-9a-f]{64}$/);
    return Response.json({ status: "written", record: { id: recordId, record_type: "task", version: 1 } });
  };
  const input = {
    action: "create",
    idempotency_key: "record-create-0001",
    scope: "global",
    record_type: "task",
    title: "Ship G4",
    content: "Turn the accepted contracts green.",
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
        name: "clued_record_write", arguments: input,
      } }),
    }), { ...baseEnv, PROJECT_VIEWS_V2: "true" }, ctx);
    assert.equal(mcp.status, 200);
    assert.deepEqual(rpcNames, ["clued_user_record_write", "clued_record_write"]);
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
});
