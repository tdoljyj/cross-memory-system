import assert from "node:assert/strict";
import test from "node:test";
import { loadContinuityWorker } from "./worker-continuity-loader.mjs";

const env = {
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

test("scheduled refresh records a bounded Builder heartbeat around the cycle", async () => {
  const worker = await loadContinuityWorker();
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(input), body });
    return Response.json(calls.length === 2 ? { status: "idle" } : { status: "recorded" });
  };
  try {
    assert.deepEqual(await worker.runProjectionRefreshScheduled(env), {
      status: "idle", processed: 0, cas_conflicts: 0,
    });
    assert.deepEqual(calls.map((call) => new URL(call.url).pathname.split('/').at(-1)),
      ["clued_mcp_projection_refresh_heartbeat", "clued_mcp_projection_refresh_claim",
        "clued_mcp_projection_refresh_heartbeat"]);
    assert.equal(calls[0].body.p_input.phase, "start");
    assert.equal(calls[2].body.p_input.phase, "finish");
    assert.equal(calls[2].body.p_input.result, "idle");
    assert.equal(calls[0].body.p_input.run_id, calls[2].body.p_input.run_id);
    assert.ok(calls.every(({ body }) => !JSON.stringify(body).includes(env.CLUED_PROJECTION_BUILDER_TOKEN)));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("terminal projection failure is reported directly by the Worker heartbeat", async () => {
  const worker = await loadContinuityWorker();
  const previousFetch = globalThis.fetch;
  const responses = [
    { status: "recorded" },
    { status: "claimed", projection_key: "global.priority_frontier", lease_id: "11111111-1111-4111-8111-111111111111", expected_invalidation_revision: 94, expected_source_vector_digest: "a".repeat(64) },
    { status: "failed", projection_key: "global.priority_frontier", error_code: "frontier_candidate_not_unique" },
    { status: "recorded" },
  ];
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ input: String(input), body: JSON.parse(init.body) });
    return Response.json(responses.shift());
  };
  try {
    const result = await worker.runProjectionRefreshScheduled(env);
    assert.equal(result.status, "failed");
    assert.equal(result.error_code, "frontier_candidate_not_unique");
    assert.equal(calls.length, 4);
    assert.equal(calls[3].body.p_input.result, "failed");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("dependency-blocked aggregate does not consume the full heartbeat cycle limit", async () => {
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
