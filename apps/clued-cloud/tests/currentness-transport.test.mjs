import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadContinuityWorker as loadWorker } from "./worker-continuity-loader.mjs";

// Task 6dfd7560: every resume reports the component versions the build was made from.
const CLUED_COMPONENTS = {
  schema: "clued.components/1",
  versions: Object.fromEntries(JSON.parse(readFileSync(new URL("../../../config/clued-components.json", import.meta.url), "utf8"))
    .components.map((c) => [c.id, String(c.version)])),
  source_commit: null,
};
const CONTRACT_SOURCE = readFileSync(new URL("../../../skills/clued/references/agent-contract.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const CONTRACT_IDENTITY = { contract_version: Number(/^Contract version: (\d+)$/m.exec(CONTRACT_SOURCE)[1]),
  agent_contract_sha256: createHash("sha256").update(CONTRACT_SOURCE).digest("hex") };

const env = { CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway",
  PROJECT_VIEWS_V2: "true",
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };
const bindingToken = `clued_bnd_${"x".repeat(43)}`;

test("M-LIVE-01: resume and log transport preserve omitted constraints and separate historical log authority", async () => {
  const worker = await loadWorker();
  const previousFetch = globalThis.fetch;
  const calls = [];
  const resume = { status: "restored", session_token: "session-test", active_constraints: [], authority_conflicts: [],
    currentness_evaluation: { overall: "CURRENT", authoritative: true },
    authoritative_current_action: { status: "BLOCKED" }, next_action: "ACTION_RESOLUTION_REQUIRED",
    next_action_authoritative: false, effective_next_action: null,
    work_log: "### Next action\n\nACTION_RESOLUTION_REQUIRED\n\n## Active constraints\n\nNo active constraints in this authorized view." };
  const log = { status: "ok", currentness_evaluation: { overall: "CURRENT", authoritative: true },
    source_semantics: "historical_continuity_log", authoritative_current: false, next_action_authoritative: false,
    markdown: "> Historical continuity log.\n\n### Historical checkpoint action\n\nOLD_CHECKPOINT" };
  globalThis.fetch = async (input, init = {}) => {
    const rpc = /\/rpc\/([^/?]+)$/.exec(String(input))?.[1], body = JSON.parse(init.body);
    calls.push({ rpc, body });
    return Response.json((rpc === "clued_mcp_read_log" || body.p_tool === "clued_read_log") ? log : resume);
  };
  try {
    for (const [tool, pathname, expected] of [
      // BUG-20260924-001 L1: resume reports capture completeness next to currentness.
      ["clued_session_resume", "/v1/continuity/resume", { ...resume, ...CONTRACT_IDENTITY, clued_components: CLUED_COMPONENTS, authority_capture_completeness: {
        state: "unknown", basis: "server_observes_only_writes_that_reached_clued", independent_of: "currentness" } }],
      ["clued_read_log", "/v1/continuity/log", log],
    ]) {
      const args = tool === "clued_session_resume" ? { context_key: "global", response_view: "work_log" }
        : { context_key: "global", session_token: "session-test" };
      for (const token of [bindingToken, "account-or-legacy-oauth-token"]) {
        const mcp = await worker.fetch(mcpRequest(token, args, tool), env, ctx);
        assert.equal(mcp.status, 200); assert.deepEqual((await mcp.json()).result.structuredContent, expected);
        const rest = await worker.fetch(new Request(`https://clued.test${pathname}`, { method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(args) }), env, ctx);
        assert.equal(rest.status, 200); assert.deepEqual(await rest.json(), expected);
        for (const call of calls.slice(-2)) {
          assert.equal(call.rpc, token === bindingToken ? (tool === "clued_read_log" ? "clued_mcp_read_log" : "clued_mcp_restore") : "clued_oauth_call");
          assert.deepEqual(call.body.p_input, args);
        }
      }
    }
  } finally { globalThis.fetch = previousFetch; }
});

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

test("G6 closure binds the serving Worker commit on Binding and OAuth paths", async () => {
  const worker = await loadWorker();
  const previousFetch = globalThis.fetch;
  const previousSha = globalThis.__CLUED_BUILD_SHA__;
  const attestedSha = "a".repeat(40);
  const deployedSha = "b".repeat(40);
  const seen = [];
  globalThis.fetch = async (_input, init = {}) => {
    const body = JSON.parse(init.body);
    seen.push(body.p_input);
    return Response.json({
      gate: "G6_CURRENTNESS",
      status: body.p_input.__transport_source_commit === attestedSha
        ? "transport_precheck_ready" : "not_ready",
      missing_requirements: body.p_input.__transport_source_commit === attestedSha
        ? [] : ["all_path_checkpoint_enforcement"],
    });
  };
  try {
    for (const sourceSha of [attestedSha, deployedSha]) {
      globalThis.__CLUED_BUILD_SHA__ = sourceSha;
      for (const token of [bindingToken, "oauth-access-token"]) {
        const response = await worker.fetch(mcpRequest(token, {
          project_id: "11111111-1111-4111-8111-111111111111",
          __transport_source_commit: attestedSha,
        }, "clued_currentness_g6_gate"), env, ctx);
        assert.equal(response.status, 200);
        const result = (await response.json()).result.structuredContent;
        assert.equal(result.status, sourceSha === attestedSha ? "closed" : "not_ready");
        assert.equal(seen.at(-1).__transport_source_commit, sourceSha);
      }
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSha === undefined) delete globalThis.__CLUED_BUILD_SHA__;
    else globalThis.__CLUED_BUILD_SHA__ = previousSha;
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
      const expectedInput = name === "clued_currentness_g6_gate"
        ? { ...input, __transport_source_commit: null } : input;
      assert.equal(fromBinding.rpc, rpc);
      assert.deepEqual(fromBinding.body.p_input, expectedInput);
      assert.match(fromBinding.body.p_token_hash, /^[0-9a-f]{64}$/);
      assert.deepEqual(fromOauth, { rpc: "clued_oauth_call", body: { p_tool: name, p_input: expectedInput } });
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});
