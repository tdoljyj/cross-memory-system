import assert from "node:assert/strict";
import test from "node:test";

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  return (await import(workerUrl.href)).default;
}

const env = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };

test("publishes a continuity health contract", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(new Request("https://clued.test/healthz"), env, ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "clued-continuity",
    version: "0.2.0",
    canonicalStore: "supabase",
    mcp: "/mcp",
  });
});

test("implements MCP initialization and continuity tool discovery", async () => {
  const worker = await loadWorker();
  const initialize = await worker.fetch(
    new Request("https://clued.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    }),
    env,
    ctx,
  );
  assert.equal(initialize.status, 200);
  const initialized = await initialize.json();
  assert.equal(initialized.result.serverInfo.name, "Clued Continuity");
  assert.equal(initialized.result.protocolVersion, "2025-06-18");

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
      "clued_session_resume",
      "clued_append_event",
      "clued_session_checkpoint",
      "clued_search_context",
      "clued_audit_receipts",
    ],
  );
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

test("issues a one-time binding token without storing the raw secret", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith("/auth/v1/user")) {
      return Response.json({ id: "ca1aeea5-9a2b-4e91-8a0e-8402c8be6a56", email: "user@example.com" });
    }
    if (String(input).endsWith("/rest/v1/clued_agent_bindings")) {
      const body = JSON.parse(init.body);
      assert.match(body.token_hash, /^[0-9a-f]{64}$/);
      assert.doesNotMatch(init.body, /clued_bnd_/);
      return Response.json([
        {
          id: "b5eb6c34-d18d-4100-9a20-f7a63020b04d",
          vendor: body.vendor,
          agent_name: body.agent_name,
          scopes: body.scopes,
          created_at: "2026-08-23T00:00:00Z",
          last_used_at: null,
          revoked_at: null,
        },
      ]);
    }
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
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.match(result.token, /^clued_bnd_[A-Za-z0-9_-]{40,}$/);
    assert.equal(result.mcpUrl, "https://clued.test/mcp");
    assert.equal(calls.length, 2);
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
