import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadContinuityWorker } from "./worker-continuity-loader.mjs";

// Storage connection discovery (Owner Decision 1721045d) over the real
// continuity handler. Synthetic RPC only: no database or Google.
const worker = await loadContinuityWorker();
const origin = "https://clued.example.invalid";
const token = "clued_bnd_" + "s".repeat(40);
const sha = value => createHash("sha256").update(value).digest("hex");
const CONNECTION = "20000000-0000-4000-8000-0000000000c1", PROJECT = "30000000-0000-4000-8000-0000000000c1";
const base = { CLUED_STORAGE_ACCOUNT_V1: "true", SUPABASE_URL: "https://db.example.invalid", SUPABASE_PUBLISHABLE_KEY: "fixture-public-key" };
const reads = { CLUED_STORAGE_GOOGLE_V1: "true", CLUED_STORAGE_READ_V1: "true" }, writes = { CLUED_STORAGE_JOBS_V1: "true" };
const entry = { connection_id: CONNECTION, name: "Clued_资料中心", managed_root: "G:/我的云端硬盘/Clued_资料中心", project_id: PROJECT,
  tracks: ["10_E_工程与平台", "20_P_产品与体验"], inspect: true, write_levels: ["create_file", "create_topic", "modify"], read: ["read", "read_content"], normal_use: true };
const answer = { contract: "clued.storage-connections/1", connections: [entry], complete: true };

async function call(args, { env = { ...base, ...reads, ...writes }, reply = () => Response.json(answer), bearer = token } = {}) {
  const calls = [], before = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    assert.equal(u.origin + u.pathname, base.SUPABASE_URL + "/rest/v1/rpc/clued_storage_connections_v1");
    const body = JSON.parse(init.body);
    calls.push(body);
    return reply(body);
  };
  try {
    const response = await worker.fetch(new Request(origin + "/mcp", { method: "POST",
      headers: { "content-type": "application/json", origin, ...(bearer ? { authorization: "Bearer " + bearer } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "clued_storage_connections", arguments: args } }) }), env);
    if (response.status !== 200) return { status: response.status, calls };
    const result = (await response.json()).result;
    return { calls, isError: result.isError, value: result.structuredContent, cache: response.headers.get("cache-control") };
  } finally { globalThis.fetch = before; }
}

test("offered with storage reads or jobs, never without", async () => {
  const names = async env => (await (await worker.fetch(new Request(origin + "/mcp", { method: "POST",
    headers: { "content-type": "application/json", origin, authorization: "Bearer " + token },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }), env)).json()).result.tools.map(t => t.name);
  for (const env of [{}, base, { ...base, CLUED_STORAGE_ACCOUNT_V1: "false", ...reads, ...writes }]) {
    assert.equal((await names(env)).includes("clued_storage_connections"), false);
    assert.equal((await call({}, { env })).status, 404);
  }
  for (const env of [{ ...base, ...reads }, { ...base, ...writes }, { ...base, ...reads, ...writes }]) {
    assert.equal((await names(env)).includes("clued_storage_connections"), true);
  }
});

test("every storage tool says where its connection_id comes from", async () => {
  const tools = (await (await worker.fetch(new Request(origin + "/mcp", { method: "POST",
    headers: { "content-type": "application/json", origin, authorization: "Bearer " + token },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }),
  { ...base, ...reads, ...writes, CLUED_STORAGE_BINARY_V1: "true" })).json()).result.tools;
  const storage = tools.filter(t => t.name.startsWith("clued_storage_") && t.name !== "clued_storage_connections");
  assert.ok(storage.length >= 5, storage.map(t => t.name).join(","));
  for (const tool of storage) {
    assert.match(tool.inputSchema.properties.connection_id.description, /from clued_storage_connections\. Never ask the user for it\./, tool.name);
  }
  const listing = tools.find(t => t.name === "clued_storage_connections");
  assert.deepEqual(listing.inputSchema, { type: "object", additionalProperties: false, properties: {} });
  assert.equal(listing.annotations.readOnlyHint, true);
  assert.match(listing.description, /never ask the user for one/);
});

test("lists the Binding's connections with the hashed token only, uncached", async () => {
  const { calls, isError, value, cache } = await call({});
  assert.equal(isError, false);
  assert.deepEqual(calls, [{ p_token_hash: sha(token) }]);
  assert.deepEqual(value, answer);
  assert.equal(cache, "no-store");
  assert.equal((await call(undefined)).isError, false, "arguments may be omitted");
});

test("classes whose tools this deployment does not offer are left out", async () => {
  const onlyReads = await call({}, { env: { ...base, ...reads } });
  assert.deepEqual(onlyReads.value.connections, [{ ...entry, inspect: false, write_levels: [] }]);
  const onlyWrites = await call({}, { env: { ...base, ...writes } });
  assert.deepEqual(onlyWrites.value.connections, [{ ...entry, read: [], normal_use: false }]);
  const readOnlyEntry = { ...entry, inspect: false, write_levels: [] };
  const dropped = await call({}, { env: { ...base, ...writes }, reply: () => Response.json({ ...answer, connections: [readOnlyEntry] }) });
  assert.deepEqual(dropped.value.connections, [], "a connection left with no offered class is not listed");
});

test("arguments, a missing Binding and malformed or failed answers give fixed codes", async () => {
  for (const args of [{ connection_id: CONNECTION }, { owner_id: "x" }, []]) {
    const { calls, isError, value } = await call(args);
    assert.equal(isError, true);
    assert.equal(value.error, "storage_connections_input_invalid");
    assert.equal(calls.length, 0);
  }
  const missing = await call({}, { bearer: null });
  assert.ok(missing.status === 401 || (missing.isError && missing.calls.length === 0), JSON.stringify(missing));
  const bad = [
    () => new Response(JSON.stringify({ message: "storage_connections_denied" }), { status: 403 }),
    () => Response.json({ ...answer, contract: "other" }),
    () => Response.json({ ...answer, connections: [{ ...entry, provider_subject: "owner@example.invalid" }] }),
    () => Response.json({ ...answer, connections: [{ ...entry, write_levels: ["delete_forever"] }] }),
    () => Response.json({ ...answer, connections: [{ ...entry, connection_id: "not-a-uuid" }] }),
    () => Response.json({ ...answer, connections: [{ ...entry, read: ["read", "read"] }] }),
  ];
  for (const reply of bad) {
    const { isError, value } = await call({}, { reply });
    assert.equal(isError, true);
    assert.deepEqual(Object.keys(value).sort(), ["error", "message"]);
    assert.equal(value.error, "storage_connections_unavailable");
    assert.doesNotMatch(JSON.stringify(value), /owner@example|storage_connections_denied/);
  }
});
