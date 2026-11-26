import assert from "node:assert/strict";
import test from "node:test";
import { loadContinuityWorker } from "./worker-continuity-loader.mjs";

const env = { CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway",
  SUPABASE_URL: "https://clued.test",
  SUPABASE_PUBLISHABLE_KEY: "anon-test",
  CLUED_PROJECTION_BUILDER_TOKEN: `clued_bnd_${"p".repeat(43)}`,
};

test("Projection Builder drains CAS conflicts without exposing or inheriting its credential", async () => {
  const worker = await loadContinuityWorker();
  const previousFetch = globalThis.fetch;
  const calls = [];
  const responses = [
    { status: "claimed", projection_key: "global.priority_frontier", lease_id: "11111111-1111-4111-8111-111111111111", expected_invalidation_revision: 7, expected_source_vector_digest: "a".repeat(64) },
    { status: "cas_conflict" },
    { status: "claimed", projection_key: "global.priority_frontier", lease_id: "22222222-2222-4222-8222-222222222222", expected_invalidation_revision: 9, expected_source_vector_digest: "b".repeat(64) },
    { status: "rebuilt" },
    { status: "claimed", projection_key: "global.__aggregate__", lease_id: "33333333-3333-4333-8333-333333333333", expected_invalidation_revision: 9, expected_source_vector_digest: "c".repeat(64) },
    { status: "reconciled" },
    { status: "idle" },
  ];
  globalThis.fetch = async (input, init = {}) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(input), body });
    return Response.json(responses.shift());
  };
  try {
    const result = await worker.runProjectionRefreshPipeline(env);
    assert.deepEqual(result, { status: "idle", processed: 2, cas_conflicts: 1 });
    assert.equal(calls.length, 7);
    assert.ok(calls.every(({ body }) => /^[0-9a-f]{64}$/.test(body.p_token_hash)));
    assert.ok(calls.every(({ body }) => !JSON.stringify(body).includes(env.CLUED_PROJECTION_BUILDER_TOKEN)));
    assert.match(calls[0].url, /clued_mcp_projection_refresh_claim$/);
    assert.match(calls[1].url, /clued_mcp_projection_refresh_apply$/);
    assert.equal(calls[3].body.p_input.expected_invalidation_revision, 9);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Projection refresh remains inert without the independent Builder binding", async () => {
  const worker = await loadContinuityWorker();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("must not call storage"); };
  try {
    assert.deepEqual(await worker.runProjectionRefreshPipeline({}), {
      status: "not_configured",
      processed: 0,
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("scheduled projection refresh claims without writing a heartbeat", async t => {
  const worker = await loadContinuityWorker();
  const calls = [];
  t.mock.method(globalThis, "fetch", async url => {
    calls.push(String(url).split("/").at(-1));
    return Response.json({ status: "idle" });
  });
  await worker.wakeProjectionRefresh(env);
  assert.deepEqual(calls, ["clued_mcp_projection_refresh_claim"]);
});

test("terminal projection failure stops after applying the claim", async t => {
  const worker = await loadContinuityWorker();
  const responses = [
    { status: "claimed", projection_key: "global.priority_frontier", lease_id: "11111111-1111-4111-8111-111111111111", expected_invalidation_revision: 94, expected_source_vector_digest: "a".repeat(64) },
    { status: "failed", projection_key: "global.priority_frontier", error_code: "frontier_candidate_not_unique" },
  ];
  t.mock.method(globalThis, "fetch", async () => Response.json(responses.shift()));
  const result = await worker.runProjectionRefreshPipeline(env);
  assert.equal(result.status, "failed");
  assert.equal(result.error_code, "frontier_candidate_not_unique");
  assert.equal(responses.length, 0);
});

test("dependency-blocked aggregate does not consume the full refresh cycle limit", async () => {
  const worker = await loadContinuityWorker();
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ status: "waiting", retry_after_ms: 0,
      next_attempt_at: "2026-09-23T04:18:00Z" });
  };
  try {
    const result = await worker.runProjectionRefreshPipeline(env);
    assert.equal(result.status, "waiting");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

const mcp = (method, name) => ({ jsonrpc: "2.0", id: 1, method, params: { name, arguments: {} } });
const write = mcp("tools/call", "clued_append_event");

async function wakeFixture(t, { outcome = { status: "committed" }, onClaim } = {}) {
  const worker = await loadContinuityWorker();
  const pending = [];
  const claims = [];
  t.mock.method(globalThis, "fetch", async url => {
    const rpc = String(url).split("/").at(-1);
    if (rpc === "clued_mcp_projection_refresh_claim") {
      claims.push(rpc);
      await onClaim?.();
      return Response.json({ status: "idle" });
    }
    assert.ok(["clued_mcp_append_event", "clued_mcp_read_log"].includes(rpc), rpc);
    return Response.json(outcome);
  });
  async function post(body, pathname = "/mcp") {
    const response = await worker.fetch(new Request(`https://clued.test${pathname}`, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer clued_bnd_${"a".repeat(43)}` },
      body: JSON.stringify(body) }), env, { waitUntil: p => pending.push(p) });
    assert.equal(response.status, 200);
    return response.json();
  }
  return { post, claims, drain: () => Promise.all(pending) };
}

for (const [label, body] of [["read tool", mcp("tools/call", "clued_read_log")],
  ["tools/list", mcp("tools/list")], ["initialize", mcp("initialize")]]) {
  test(`successful MCP ${label} starts zero projection claims`, async t => {
    const fixture = await wakeFixture(t);
    assert.ok((await fixture.post(body)).result);
    await fixture.drain();
    assert.equal(fixture.claims.length, 0);
  });
}

test("a rejected MCP write with HTTP 200 starts zero projection claims", async t => {
  const fixture = await wakeFixture(t, { outcome: { status: "rejected", error_code: "refused" } });
  assert.equal((await fixture.post(write)).result.isError, true);
  await fixture.drain();
  assert.equal(fixture.claims.length, 0);
});

test("MCP and REST writes each wake an idle projection builder once", async t => {
  const fixture = await wakeFixture(t);
  assert.equal((await fixture.post(write)).result.isError, false);
  await fixture.drain();
  assert.equal(fixture.claims.length, 1);
  await fixture.post({}, "/v1/continuity/events");
  await fixture.drain();
  assert.equal(fixture.claims.length, 2);
});

test("three overlapping writes share one builder and retain one trailing refresh", async t => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let active = 0, peak = 0;
  const fixture = await wakeFixture(t, { onClaim: async () => {
    peak = Math.max(peak, ++active);
    started.resolve();
    await release.promise;
    active--;
  } });
  try {
    await fixture.post(write);
    // Fail immediately if the initial write did not schedule a builder.
    await Promise.race([started.promise, fixture.drain().then(() => assert.fail("missing first claim"))]);
    await Promise.all([fixture.post(write), fixture.post({}, "/v1/continuity/events")]);
  } finally {
    release.resolve();
    await fixture.drain();
  }
  assert.equal(fixture.claims.length, 2);
  assert.equal(peak, 1);
  await fixture.post(write);
  await fixture.drain();
  assert.equal(fixture.claims.length, 3, "a later write starts a new flight");
});
