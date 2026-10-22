import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadContinuityWorker as loadWorker } from "./worker-continuity-loader.mjs";

const env = { CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway",
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };
const componentManifest = JSON.parse(readFileSync(new URL("../../../config/clued-components.json", import.meta.url), "utf8"));
const mcpComponents = componentManifest.components.filter((component) => component.id === "mcp.server");
assert.equal(mcpComponents.length, 1, "the independent manifest must name one MCP version");
const EXPECTED_MCP_VERSION = mcpComponents[0].version;
assert.equal(typeof EXPECTED_MCP_VERSION, "string");
assert.match(EXPECTED_MCP_VERSION, /^\d+\.\d+\.\d+$/);
const CLUED_COMPONENT_VERSIONS = Object.fromEntries(componentManifest.components.map((c) => [c.id, String(c.version)]));

test("publishes a continuity health contract", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(new Request("https://clued.test/healthz"), env, ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "clued-continuity",
    version: EXPECTED_MCP_VERSION,
    components: CLUED_COMPONENT_VERSIONS,
    canonicalStore: "supabase",
    mcp: "/mcp",
    api: "/v1/continuity",
    workLog: "日志.md",
    mandatoryLifecycle: ["resume", "checkpoint"],
  });
});

test("implements MCP initialization and continuity tool discovery", async () => {
  const worker = await loadWorker();
  const anonymousInitialize = await worker.fetch(
    new Request("https://clued.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
    }),
    env,
    ctx,
  );
  assert.equal(anonymousInitialize.status, 401);
  assert.match(
    anonymousInitialize.headers.get("www-authenticate") ?? "",
    /^Bearer realm="Clued", resource_metadata=/,
  );

  const initialize = await worker.fetch(
    new Request("https://clued.test/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer clued_bnd_${"a".repeat(43)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    }),
    env,
    ctx,
  );
  assert.equal(initialize.status, 200);
  const initialized = await initialize.json();
  assert.equal(initialized.result.serverInfo.name, "BeamingFace Continuity");
  assert.equal(initialized.result.protocolVersion, "2026-07-28");
  assert.equal(initialized.result.serverInfo.version, EXPECTED_MCP_VERSION);
  assert.match(initialized.result.instructions, /https:\/\/clued\.test\/clued-agent\.md/);
  assert.match(initialized.result.instructions, /in the same turn, before reporting it done/);

  const list = await worker.fetch(
    new Request("https://clued.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    }),
    env,
    ctx,
  );
  const listed = await list.json();
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    [
      "clued_agent_bootstrap",
      "clued_session_resume",
      "clued_append_event",
      "clued_event_carrier_transition",
      "clued_session_reconcile",
      "clued_projection_rebuild",
      "clued_full_global_reconcile",
      "clued_currentness_g6_gate",
      "clued_mtpe_snapshot",
      "clued_mtpe_validate",
      "clued_mtpe_owner_pin",
      "clued_session_checkpoint",
      "clued_search_context",
      "clued_read_log",
      "clued_import_log",
      "clued_audit_receipts",
      "clued_project_mutate",
      "clued_project_list",
    ],
  );
});

test("publishes a public bootstrap without user context", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("https://clued.test/v1/continuity/bootstrap"),
    env,
    ctx,
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.kernel_version, EXPECTED_MCP_VERSION);
  assert.equal(result.endpoints.mcp, "https://clued.test/mcp");
  assert.equal(result.lifecycle.required, true);
  assert.equal(result.capabilities.semantic_recall, false);
  assert.doesNotMatch(JSON.stringify(result), /session_token|markdown/i);
});

test("publishes vendor-neutral agent instructions", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(new Request("https://clued.test/clued-agent.md"), env, ctx);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/markdown/);
  const markdown = await response.text();
  assert.match(markdown, /clued_session_resume/);
  assert.match(markdown, /dedicated BeamingFace Binding/);
});

test("serves MCP bootstrap without a binding token", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("https://clued.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: { name: "clued_agent_bootstrap", arguments: {} },
      }),
    }),
    env,
    ctx,
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.result.structuredContent.kernel_version, EXPECTED_MCP_VERSION);
});

test("publishes OAuth protected resource metadata for MCP clients", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("https://clued.test/.well-known/oauth-protected-resource/mcp"),
    env,
    ctx,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    resource: "https://clued.test/mcp",
    bearer_methods_supported: ["header"],
    authorization_servers: ["https://ccxsikzwxlolxqlosril.supabase.co/auth/v1"],
    scopes_supported: ["openid", "email", "profile"],
    clued_binding_scopes: ["context:read", "context:write", "audit:read"],
    clued_binding_portal: "https://clued.test/",
  });
});

test("forwards canonical log imports to the production RPC contract", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    assert.match(String(input), /\/rest\/v1\/rpc\/clued_mcp_import_log$/);
    const body = JSON.parse(init.body);
    assert.match(body.p_token_hash, /^[0-9a-f]{64}$/);
    assert.equal(body.p_input.markdown, "# 日志\n\nImported baseline.");
    return Response.json({ status: "imported", version: 8, content_sha256: "a".repeat(64) });
  };
  try {
    const response = await worker.fetch(
      new Request("https://clued.test/v1/continuity/log/import", {
        method: "POST",
        headers: {
          authorization: `Bearer clued_bnd_${"b".repeat(43)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          context_key: "project:clued",
          session_token: `clued_ses_${"c".repeat(64)}`,
          base_version: 7,
          markdown: "# 日志\n\nImported baseline.",
          idempotency_key: "import-log-001",
        }),
      }),
      env,
      ctx,
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).version, 8);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects cross-origin continuity calls by default", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("https://clued.test/mcp", {
      method: "POST",
      headers: { origin: "https://untrusted.example", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 22, method: "ping" }),
    }),
    env,
    ctx,
  );
  assert.equal(response.status, 403);
});

test("rejects MCP memory access without a scoped binding token", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("https://clued.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "clued_session_resume", arguments: {} },
      }),
    }),
    env,
    ctx,
  );
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", /Clued/);
});

test("the retired binding issuance route issues nothing and points to /oauth/connections", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return Response.json({ message: "unexpected request" }, { status: 500 });
  };

  try {
    const response = await worker.fetch(
      new Request("https://clued.test/api/bindings", {
        method: "POST",
        headers: {
          authorization: "Bearer user-session-jwt",
          "content-type": "application/json",
        },
        body: JSON.stringify({ vendor: "OpenAI", agentName: "Codex" }),
      }),
      env,
      ctx,
    );
    assert.equal(response.status, 410);
    const result = await response.json();
    assert.equal(result.replacement, "/oauth/connections");
    assert.equal(result.token, undefined);
    assert.equal(calls.length, 0, "no database call, no Binding row");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("forwards MCP calls as token-hash RPCs", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    assert.match(String(input), /\/rest\/v1\/rpc\/clued_mcp_restore$/);
    const body = JSON.parse(init.body);
    assert.match(body.p_token_hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(body.p_input, { context_key: "clued" });
    return Response.json({ status: "restored", version: 7, snapshot: { project: "Clued" } });
  };

  try {
    const response = await worker.fetch(
      new Request("https://clued.test/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer clued_bnd_${"a".repeat(43)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "clued_session_resume",
            arguments: { context_key: "clued" },
          },
        }),
      }),
      env,
      ctx,
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.result.structuredContent.version, 7);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports authority capture separately from currentness on resume and reconcile", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  const rpcResults = {
    clued_mcp_restore: { status: "restored", version: 7, session_compliance: { state: "active" } },
    clued_mcp_session_reconcile: { status: "current", currentness_state: "CURRENT", admission_eligible: true },
    clued_mcp_search_context: { status: "ok", results: [] },
  };
  globalThis.fetch = async (input) => {
    const rpc = String(input).match(/\/rest\/v1\/rpc\/([a-z0-9_]+)$/)?.[1];
    assert.ok(rpc in rpcResults, `unexpected RPC ${rpc}`);
    return Response.json(rpcResults[rpc]);
  };
  const call = async (name, args) => {
    const response = await worker.fetch(
      new Request("https://clued.test/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer clued_bnd_${"a".repeat(43)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name, arguments: args } }),
      }),
      env,
      ctx,
    );
    assert.equal(response.status, 200);
    return (await response.json()).result.structuredContent;
  };
  const expected = {
    state: "unknown",
    basis: "server_observes_only_writes_that_reached_clued",
    independent_of: "currentness",
  };

  try {
    const resumed = await call("clued_session_resume", { context_key: "global" });
    assert.deepEqual(resumed.authority_capture_completeness, expected);
    const reconciled = await call("clued_session_reconcile", { session_token: "clued_ses_x", context_key: "global" });
    assert.equal(reconciled.currentness_state, "CURRENT");
    assert.deepEqual(reconciled.authority_capture_completeness, expected);
    const searched = await call("clued_search_context", { query: "x" });
    assert.equal("authority_capture_completeness" in searched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("forwards Supabase OAuth MCP calls through the authenticated dispatcher", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    assert.match(String(input), /\/rest\/v1\/rpc\/clued_oauth_call$/);
    assert.equal(init.headers.get("authorization"), "Bearer oauth-access-jwt");
    assert.deepEqual(JSON.parse(init.body), {
      p_tool: "clued_session_resume",
      p_input: { context_key: "global" },
    });
    return Response.json({ status: "restored", version: 12 });
  };

  try {
    const response = await worker.fetch(
      new Request("https://clued.test/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer oauth-access-jwt",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "clued_session_resume",
            arguments: { context_key: "global" },
          },
        }),
      }),
      env,
      ctx,
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.structuredContent.version, 12);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
