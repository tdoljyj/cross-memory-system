import assert from "node:assert/strict";
import test from "node:test";
import { loadContinuityWorker as loadWorker } from "./worker-continuity-loader.mjs";

const env = {
  PROJECT_VIEWS_V2: "true",
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };
const bindingToken = `clued_bnd_${"x".repeat(43)}`;

function mcpRequest(token, input, name = "clued_record_list") {
  return new Request("https://clued.test/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name, arguments: input },
    }),
  });
}

test("MCP advertises an explicit boolean history switch and keeps default current", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(new Request("https://clued.test/mcp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }), env, ctx);
  const tools = (await response.json()).result.tools;
  const recordList = tools.find((tool) => tool.name === "clued_record_list");
  assert.deepEqual(recordList.inputSchema.properties.include_history, {
    type: "boolean", default: false,
    description: "Explicit history/diagnostic view; shadowed records are non-authoritative.",
  });
  assert.equal(recordList.inputSchema.additionalProperties, false);
});

test("account HTTP, Binding MCP, and OAuth MCP forward the same history flag to protected record-list routes", async () => {
  const worker = await loadWorker();
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return Response.json({ id: "11111111-1111-4111-8111-111111111111" });
    const rpc = /\/rpc\/([^/?]+)$/.exec(url)?.[1];
    calls.push({ rpc, body: JSON.parse(init.body) });
    return Response.json({ status: "ok", records: [] });
  };
  try {
    const currentHttp = await worker.fetch(new Request("https://clued.test/v1/records?record_type=state", {
      headers: { authorization: "Bearer account-jwt" },
    }), env, ctx);
    const historyHttp = await worker.fetch(new Request("https://clued.test/v1/records?record_type=state&include_history=true", {
      headers: { authorization: "Bearer account-jwt" },
    }), env, ctx);
    const currentBinding = await worker.fetch(mcpRequest(bindingToken, { record_type: "state" }), env, ctx);
    const historyBinding = await worker.fetch(mcpRequest(bindingToken, { record_type: "state", include_history: true }), env, ctx);
    const historyOauth = await worker.fetch(mcpRequest("oauth-access-token", { record_type: "state", include_history: true }), env, ctx);
    for (const response of [currentHttp, historyHttp, currentBinding, historyBinding, historyOauth]) {
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.deepEqual(calls, [
      { rpc: "clued_user_record_list", body: { p_input: { record_type: "state" } } },
      { rpc: "clued_user_record_list", body: { p_input: { record_type: "state", include_history: true } } },
      { rpc: "clued_record_list", body: { p_token_hash: calls[2].body.p_token_hash, p_input: { record_type: "state" } } },
      { rpc: "clued_record_list", body: { p_token_hash: calls[3].body.p_token_hash, p_input: { record_type: "state", include_history: true } } },
      { rpc: "clued_oauth_call", body: { p_tool: "clued_record_list", p_input: { record_type: "state", include_history: true } } },
    ]);
    assert.match(calls[2].body.p_token_hash, /^[0-9a-f]{64}$/);
    assert.equal(calls[2].body.p_token_hash, calls[3].body.p_token_hash);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("history cannot be activated through ambiguous HTTP or MCP aliases", async () => {
  const worker = await loadWorker();
  const previousFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => { upstreamCalls++; return Response.json({ status: "ok", records: [] }); };
  try {
    for (const query of ["include_history=1", "include_history=True", "include_history=true&include_history=false", "mode=history", "history=true"]) {
      const response = await worker.fetch(new Request(`https://clued.test/v1/records?record_type=state&${query}`, {
        headers: { authorization: "Bearer account-jwt" },
      }), env, ctx);
      assert.equal(response.status, 422, query);
    }
    for (const input of [{ record_type: "state", include_history: "true" }, { record_type: "state", mode: "history" }]) {
      const response = await worker.fetch(mcpRequest(bindingToken, input), env, ctx);
      assert.equal(response.status, 422);
    }
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("the retired Memory API rejects nested legacy aliases without a storage read", async () => {
  const worker = await loadWorker();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Legacy route reached storage"); };
  try {
    for (const path of ["/api/memories", "/api/memories/audit", "/api/memories/legacy-records"]) {
      const response = await worker.fetch(new Request(`https://clued.test${path}`), env, ctx);
      assert.equal(response.status, 410);
      assert.equal((await response.json()).replacement, "/v1/records");
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("MCP transition tool requires CAS and successor evidence, with write authorization", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(new Request("https://clued.test/mcp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }), env, ctx);
  const transition = (await response.json()).result.tools.find((tool) => tool.name === "clued_event_carrier_transition");
  assert.ok(transition);
  assert.deepEqual(transition._meta["clued/requiredScopes"], ["context:write"]);
  assert.deepEqual(transition.inputSchema.required, [
    "context_key", "source_event_id", "expected_transition_version", "transition", "idempotency_key",
  ]);
  assert.equal(transition.inputSchema.oneOf.length, 3);
  assert.equal(transition.inputSchema.properties.source_event_id.minimum, 1);
  assert.equal(transition.inputSchema.properties.expected_transition_version.minimum, 1);
});

test("Binding and OAuth transition calls select only the protected transition dispatcher", async () => {
  const worker = await loadWorker();
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ rpc: /\/rpc\/([^/?]+)$/.exec(String(input))?.[1], body: JSON.parse(init.body) });
    return Response.json({ status: "transitioned", source_event_id: 101, successor_event_id: 102, transition_version: 2 });
  };
  const payload = {
    context_key: "global", source_event_id: 101, expected_transition_version: 1,
    transition: "supersede", idempotency_key: "transition-101-1", session_token: "session-test",
    base_version: 7, event_type: "decision", payload: { text: "new decision" },
  };
  try {
    const binding = await worker.fetch(mcpRequest(bindingToken, payload, "clued_event_carrier_transition"), env, ctx);
    const oauth = await worker.fetch(mcpRequest("oauth-access-token", payload, "clued_event_carrier_transition"), env, ctx);
    assert.equal(binding.status, 200);
    assert.equal(oauth.status, 200);
    assert.equal((await binding.json()).result.structuredContent.transition_version, 2);
    assert.deepEqual(calls, [
      { rpc: "clued_mcp_event_carrier_transition", body: { p_token_hash: calls[0].body.p_token_hash, p_input: payload } },
      { rpc: "clued_oauth_call", body: { p_tool: "clued_event_carrier_transition", p_input: payload } },
    ]);
    assert.match(calls[0].body.p_token_hash, /^[0-9a-f]{64}$/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("transition aliases and incomplete CAS inputs fail before storage", async () => {
  const worker = await loadWorker();
  const previousFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => { upstreamCalls++; return Response.json({ status: "unexpected" }); };
  const base = {
    context_key: "global", source_event_id: 101, expected_transition_version: 1,
    transition: "supersede", idempotency_key: "transition-101-1", session_token: "session-test",
    base_version: 7, event_type: "decision", payload: { text: "new decision" },
  };
  try {
    const invalid = [
      { ...base, expected_transition_version: undefined },
      { ...base, source_event_id: "101" },
      { ...base, successor_event_id: 102 },
      { ...base, transition: "retract", event_type: "retraction" },
      { ...base, transition: "resolve", proof_receipt_id: "11111111-1111-4111-8111-111111111111" },
    ];
    for (const input of invalid) {
      const response = await worker.fetch(mcpRequest(bindingToken, input, "clued_event_carrier_transition"), env, ctx);
      assert.equal(response.status, 422, JSON.stringify(input));
    }
    const alias = await worker.fetch(mcpRequest(bindingToken, base, "clued_mcp_event_carrier_transition"), env, ctx);
    assert.equal(alias.status, 404);
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("reconcile, projection rebuild, aggregate reconcile, and G6 tools publish exact authorization schemas", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(new Request("https://clued.test/mcp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }), env, ctx);
  const tools = new Map((await response.json()).result.tools.map((tool) => [tool.name, tool]));
  const cases = [
    ["clued_session_reconcile", ["session_token"], ["context:read"]],
    ["clued_projection_rebuild", ["projection_key", "record_id", "expected_invalidation_revision", "expected_source_vector_digest"], ["context:write"]],
    ["clued_full_global_reconcile", ["expected_invalidation_revision", "expected_source_vector_digest"], ["context:write"]],
    ["clued_currentness_g6_gate", ["project_id"], ["context:read"]],
  ];
  for (const [name, required, scopes] of cases) {
    const tool = tools.get(name);
    assert.ok(tool, name);
    assert.deepEqual(tool.inputSchema.required, required);
    assert.deepEqual(tool._meta["clued/requiredScopes"], scopes);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.match(tools.get("clued_projection_rebuild").description, /separate projection builder grant/);
  assert.match(tools.get("clued_currentness_g6_gate").description, /Global and Project reads/);
});

test("all currentness MCP tools forward through the exact Binding or OAuth RPC path", async () => {
  const worker = await loadWorker();
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ rpc: /\/rpc\/([^/?]+)$/.exec(String(input))?.[1], body: JSON.parse(init.body) });
    return Response.json({ status: "ok" });
  };
  const digest = "a".repeat(64);
  const projectId = "11111111-1111-4111-8111-111111111111";
  const cases = [
    ["clued_session_reconcile", "clued_mcp_session_reconcile", { session_token: "session-test", context_key: "global" }],
    ["clued_projection_rebuild", "clued_mcp_projection_rebuild", { projection_key: "global.priority", record_id: projectId, expected_invalidation_revision: 3, expected_source_vector_digest: digest }],
    ["clued_full_global_reconcile", "clued_mcp_full_global_reconcile", { expected_invalidation_revision: 3, expected_source_vector_digest: digest }],
    ["clued_currentness_g6_gate", "clued_mcp_currentness_g6_gate", { project_id: projectId }],
  ];
  try {
    for (const [name, rpc, input] of cases) {
      const binding = await worker.fetch(mcpRequest(bindingToken, input, name), env, ctx);
      const oauth = await worker.fetch(mcpRequest("oauth-access-token", input, name), env, ctx);
      assert.equal(binding.status, 200, name);
      assert.equal(oauth.status, 200, name);
      const fromBinding = calls.at(-2);
      const fromOauth = calls.at(-1);
      assert.equal(fromBinding.rpc, rpc);
      assert.deepEqual(fromBinding.body.p_input, input);
      assert.match(fromBinding.body.p_token_hash, /^[0-9a-f]{64}$/);
      assert.deepEqual(fromOauth, { rpc: "clued_oauth_call", body: { p_tool: name, p_input: input } });
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});
