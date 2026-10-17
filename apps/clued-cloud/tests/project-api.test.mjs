import assert from "node:assert/strict";
import test from "node:test";
import { loadContinuityWorker as loadWorker } from "./worker-continuity-loader.mjs";

const env = { CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway", ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
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

test("exposes the Project Lifecycle v2 mutation tool and hashes binding credentials", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    assert.match(String(input), /\/rest\/v1\/rpc\/clued_project_mutate_v2$/);
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
        arguments: { operation: "create", project_schema_version: 2, base_version: null, idempotency_key: "project-0001", mutation: { name: "Clued", progress_status: "not_started", aliases: [] } },
      } }),
    }), env, ctx);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.structuredContent.supplemental.project.id, projectId);
  } finally { globalThis.fetch = originalFetch; }
});

test("GET /v1/projects forwards account filters to the list RPC", async () => {
  const worker = await loadWorker();
  const mock = mockAccountRpc("clued_user_project_list_v2", {
    progress_status: "active", limit: 25, include_dismissed: true,
  });
  try {
    const response = await worker.fetch(new Request(
      "https://clued.test/v1/projects?progress_status=active&limit=25&include_dismissed=true",
      { headers: { authorization: "Bearer account-jwt" } },
    ), env, ctx);
    assert.equal(response.status, 200);
    assert.equal(mock.calls.length, 2);
  } finally { mock.restore(); }
});

test("GET /v1/projects rejects the retired certainty filter without widening the result", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("unexpected network call"); };
  try {
    const response = await worker.fetch(new Request(
      "https://clued.test/v1/projects?certainty_status=confirmed",
      { headers: { authorization: "Bearer account-jwt" } },
    ), env, ctx);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "legacy_project_certainty_forbidden");
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("POST /v1/projects creates through the authenticated v2 atomic RPC", async () => {
  const worker = await loadWorker();
  const input = { operation: "create", canonical_project_id: projectId, project_schema_version: 2, base_version: null, idempotency_key: "project-0002", mutation: { name: "Clued", progress_status: "active", aliases: [] } };
  const mock = mockAccountRpc("clued_user_project_mutate_v2", input, { status: "committed", supplemental: { project: { id: projectId } } });
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
  const expected = { operation: "update", project_schema_version: 2, base_version: 3, idempotency_key: "update-0001", mutation: { progress_status: "paused" }, canonical_project_id: projectId };
  const mock = mockAccountRpc("clued_user_project_mutate_v2", expected, { status: "committed", supplemental: { project: { id: projectId, version: 4 } } });
  try {
    const response = await worker.fetch(new Request(`https://clued.test/v1/projects/${projectId}`, {
      method: "PATCH", headers: { authorization: "Bearer account-jwt", "content-type": "application/json" },
      body: JSON.stringify({ operation: "update", project_schema_version: 2, base_version: 3, idempotency_key: "update-0001", mutation: { progress_status: "paused" } }),
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

const readTraceHeader = "x-kooyumi-read-trace";
const readTraceId = "33333333-3333-4333-8333-333333333333";

async function captureReadTrace(action) {
  const original = console.info;
  const logs = [];
  console.info = value => { logs.push(JSON.parse(value)); };
  try { await action(logs); }
  finally { console.info = original; }
}

test("traced project read preserves payload, filters, auth and CORS without forwarding diagnostics", async () => {
  const worker = await loadWorker();
  const mock = mockAccountRpc("clued_user_project_list_v2", { query: "private-query", limit: 25 }, {
    status: "ok", projects: [{ id: projectId, name: "private-project" }],
  });
  try {
    await captureReadTrace(async logs => {
      const headers = { authorization: "Bearer account-jwt", origin: "https://clued.test" };
      const url = "https://clued.test/v1/projects?query=private-query&limit=25";
      const baseline = await worker.fetch(new Request(url, { headers }), env, ctx);
      const response = await worker.fetch(new Request(url, { headers: { ...headers, [readTraceHeader]: readTraceId } }), env, ctx);
      assert.equal(response.status, baseline.status);
      assert.equal(response.statusText, baseline.statusText);
      assert.deepEqual(await response.json(), await baseline.json());
      const tracedHeaders = new Headers(response.headers);
      assert.equal(tracedHeaders.get(readTraceHeader), readTraceId);
      tracedHeaders.delete(readTraceHeader);
      assert.deepEqual([...tracedHeaders], [...baseline.headers]);
      assert.deepEqual(logs.map(log => log.stage), ["entry", "auth_started", "auth_completed", "rpc_started", "rpc_completed", "response_built"]);
      assert.equal(logs.at(-1).status, 200);
      assert.ok(logs.every(log => log.traceId === readTraceId));
      assert.equal(JSON.stringify(logs).includes("private-"), false);
      assert.equal(JSON.stringify(logs).includes("account-jwt"), false);
      assert.ok(mock.calls.every(call => call.init.headers.get(readTraceHeader) === null));
      assert.equal(mock.calls.length, 4);
    });
  } finally { mock.restore(); }
});

test("trace identifies auth and RPC failures without leaking error details or changing status", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  const cases = [
    { name: "missing auth", token: null, mode: "missing", status: 401, stages: ["entry", "auth_started", "auth_failed", "response_built"] },
    { name: "auth denial", token: "account-jwt", mode: "auth_denied", status: 401, stages: ["entry", "auth_started", "auth_failed", "response_built"] },
    { name: "auth transport", token: "account-jwt", mode: "auth_throws", status: 500, stages: ["entry", "auth_started", "auth_failed", "response_built"] },
    { name: "RPC denial", token: "account-jwt", mode: "rpc_denied", status: 403, stages: ["entry", "auth_started", "auth_completed", "rpc_started", "rpc_failed", "response_built"] },
    { name: "RPC transport", token: "account-jwt", mode: "rpc_throws", status: 500, stages: ["entry", "auth_started", "auth_completed", "rpc_started", "rpc_failed", "response_built"] },
    { name: "RPC application rejection", token: "account-jwt", mode: "rpc_rejected", status: 200, stages: ["entry", "auth_started", "auth_completed", "rpc_started", "rpc_completed", "response_built"] },
  ];
  try {
    for (const scenario of cases) {
      let calls = 0;
      globalThis.fetch = async (input, init) => {
        calls += 1;
        assert.equal(init.headers.get(readTraceHeader), null);
        if (String(input).endsWith("/auth/v1/user")) {
          if (scenario.mode === "auth_throws") throw new TypeError("private-auth-exception");
          return scenario.mode === "auth_denied"
            ? Response.json({ message: "private-auth-reason" }, { status: 401 })
            : Response.json({ id: projectId });
        }
        if (scenario.mode === "rpc_throws") throw new TypeError("private-rpc-exception");
        if (scenario.mode === "rpc_denied") return Response.json({ message: "private-rpc-reason" }, { status: 403 });
        return Response.json({ status: "rejected", reason: "private-semantic-reason" });
      };
      await captureReadTrace(async logs => {
        const headers = { [readTraceHeader]: readTraceId, ...(scenario.token ? { authorization: `Bearer ${scenario.token}` } : {}) };
        const response = await worker.fetch(new Request("https://clued.test/v1/projects", { headers }), env, ctx);
        assert.equal(response.status, scenario.status, scenario.name);
        assert.equal(response.headers.get(readTraceHeader), readTraceId, scenario.name);
        assert.deepEqual(logs.map(log => log.stage), scenario.stages, scenario.name);
        assert.equal(logs.at(-1).status, scenario.status, scenario.name);
        assert.equal(JSON.stringify(logs).includes("private-"), false, scenario.name);
        assert.equal(JSON.stringify(logs).includes("account-jwt"), false, scenario.name);
        assert.equal(calls, scenario.mode === "missing" ? 0 : scenario.mode.startsWith("auth_") ? 1 : 2);
        // HTTP-200 business rejection remains HTTP-200, not a transport failure.
        if (scenario.mode === "rpc_rejected") assert.equal((await response.json()).status, "rejected");
      });
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("invalid project trace headers do not echo or log, and writes stay untraced", async () => {
  const worker = await loadWorker();
  await captureReadTrace(async logs => {
    for (const id of ["private-invalid-header", `${readTraceId}, ${readTraceId}`, "x".repeat(1000)]) {
      const response = await worker.fetch(new Request("https://clued.test/v1/projects", { headers: { [readTraceHeader]: id } }), env, ctx);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get(readTraceHeader), null);
    }
    for (const [method, url, body, status] of [
      ["POST", "/v1/projects", {}, 401],
      ["PATCH", `/v1/projects/${projectId}`, {}, 401],
      ["OPTIONS", "/v1/projects", null, 204],
      ["GET", `/v1/projects/${projectId}`, null, 405],
    ]) {
      const response = await worker.fetch(new Request(`https://clued.test${url}`, {
        method, headers: { [readTraceHeader]: readTraceId, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }), env, ctx);
      assert.equal(response.status, status);
      assert.equal(response.headers.get(readTraceHeader), null);
    }
    assert.deepEqual(logs, []);
  });
});

test("trace captures pre-auth input rejection while preserving original validation", async () => {
  const worker = await loadWorker();
  await captureReadTrace(async logs => {
    const response = await worker.fetch(new Request("https://clued.test/v1/projects?certainty_status=confirmed", {
      headers: { [readTraceHeader]: readTraceId },
    }), env, ctx);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "legacy_project_certainty_forbidden");
    assert.equal(response.headers.get(readTraceHeader), readTraceId);
    assert.deepEqual(logs.map(log => log.stage), ["entry", "response_built"]);
    assert.equal(logs.at(-1).status, 400);
  });
});

test("project reads and denials retain their original result if trace logging fails", async () => {
  const worker = await loadWorker();
  const mock = mockAccountRpc("clued_user_project_list_v2", {});
  const originalInfo = console.info;
  console.info = () => { throw new Error("private-logger-failure"); };
  try {
    const ok = await worker.fetch(new Request("https://clued.test/v1/projects", {
      headers: { authorization: "Bearer account-jwt", [readTraceHeader]: readTraceId },
    }), env, ctx);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { status: "ok", projects: [] });
    const denied = await worker.fetch(new Request("https://clued.test/v1/projects", { headers: { [readTraceHeader]: readTraceId } }), env, ctx);
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get(readTraceHeader), readTraceId);
    assert.equal(mock.calls.length, 2);
  } finally { console.info = originalInfo; mock.restore(); }
});
