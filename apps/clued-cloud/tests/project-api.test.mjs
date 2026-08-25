import assert from "node:assert/strict";
import test from "node:test";

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  return (await import(workerUrl.href)).default;
}

const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const projectId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";

function mockAccountRpc(expectedRpc, expectedInput, result = { status: "ok", projects: [] }) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith("/auth/v1/user")) return Response.json({ id: projectId });
    assert.match(String(input), new RegExp(`/rest/v1/rpc/${expectedRpc}$`));
    assert.equal(init.headers.get("authorization"), "Bearer account-jwt");
    assert.deepEqual(JSON.parse(init.body).p_input, expectedInput);
    return Response.json(result);
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

test("exposes the M1 Project Mutation tool and hashes binding credentials", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    assert.match(String(input), /\/rest\/v1\/rpc\/clued_project_mutate$/);
    const body = JSON.parse(init.body);
    assert.match(body.p_token_hash, /^[0-9a-f]{64}$/);
    assert.equal(body.p_input.operation, "create");
    return Response.json({ status: "committed", supplemental: { project: { id: projectId } } });
  };
  try {
    const response = await worker.fetch(new Request("https://clued.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer clued_bnd_${"x".repeat(43)}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "clued_project_mutate",
        arguments: { operation: "create", project_schema_version: 1, base_version: null, idempotency_key: "project-0001", mutation: { name: "Clued", certainty_status: "unconfirmed", progress_status: "paused", aliases: [] } },
      } }),
    }), env, ctx);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.structuredContent.supplemental.project.id, projectId);
  } finally { globalThis.fetch = originalFetch; }
});

test("GET /v1/projects forwards account filters to the list RPC", async () => {
  const worker = await loadWorker();
  const mock = mockAccountRpc("clued_user_project_list", {
    certainty_status: "confirmed", limit: 25, include_dismissed: true,
  });
  try {
    const response = await worker.fetch(new Request(
      "https://clued.test/v1/projects?certainty_status=confirmed&limit=25&include_dismissed=true",
      { headers: { authorization: "Bearer account-jwt" } },
    ), env, ctx);
    assert.equal(response.status, 200);
    assert.equal(mock.calls.length, 2);
  } finally { mock.restore(); }
});

test("POST /v1/projects creates through the authenticated M1 atomic RPC", async () => {
  const worker = await loadWorker();
  const input = { operation: "create", canonical_project_id: projectId, project_schema_version: 1, base_version: null, idempotency_key: "project-0002", mutation: { name: "Clued", certainty_status: "confirmed", progress_status: "active", aliases: [] } };
  const mock = mockAccountRpc("clued_user_project_mutate", input, { status: "committed", supplemental: { project: { id: projectId } } });
  try {
    const response = await worker.fetch(new Request("https://clued.test/v1/projects", {
      method: "POST", headers: { authorization: "Bearer account-jwt", "content-type": "application/json" }, body: JSON.stringify(input),
    }), env, ctx);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).supplemental.project.id, projectId);
  } finally { mock.restore(); }
});

test("PATCH /v1/projects/:id preserves path identity and optimistic version", async () => {
  const worker = await loadWorker();
  const expected = { operation: "update", project_schema_version: 1, base_version: 3, idempotency_key: "update-0001", mutation: { certainty_status: "confirmed" }, canonical_project_id: projectId };
  const mock = mockAccountRpc("clued_user_project_mutate", expected, { status: "committed", supplemental: { project: { id: projectId, version: 4 } } });
  try {
    const response = await worker.fetch(new Request(`https://clued.test/v1/projects/${projectId}`, {
      method: "PATCH", headers: { authorization: "Bearer account-jwt", "content-type": "application/json" },
      body: JSON.stringify({ operation: "update", project_schema_version: 1, base_version: 3, idempotency_key: "update-0001", mutation: { certainty_status: "confirmed" } }),
    }), env, ctx);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).supplemental.project.id, projectId);
  } finally { mock.restore(); }
});

test("Project merge writes remain disabled", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(new Request(`https://clued.test/v1/projects/${projectId}/merge`, {
    method: "POST", headers: { authorization: "Bearer account-jwt", "content-type": "application/json" },
    body: JSON.stringify({ target_project_id: targetId, idempotency_key: "merge-00001" }),
  }), env, ctx);
  assert.equal(response.status, 405);
});

test("project APIs reject missing account authentication", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(new Request("https://clued.test/v1/projects"), env, ctx);
  assert.equal(response.status, 401);
});
