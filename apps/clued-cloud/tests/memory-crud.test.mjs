import assert from "node:assert/strict";
import test from "node:test";
import { loadContinuityWorker as loadWorker } from "./worker-continuity-loader.mjs";

const env = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };
test("retires the legacy Memory API with an explicit V2 replacement", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return Response.json({ message: "unexpected request" }, { status: 500 });
  };

  try {
    for (const pathname of ["/api/memories", "/api/memories/audit"]) {
      for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
        const response = await worker.fetch(
          new Request(`https://clued.test${pathname}`, { method }),
          env,
          ctx,
        );
        assert.equal(response.status, 410);
        assert.deepEqual(await response.json(), {
          error: "Legacy Memory API retired.",
          replacement: "/v1/records",
          semantic_contract: "two-level-five-view-v1",
        });
      }
    }
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps CORS preflight available on retired legacy paths", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("https://clued.test/api/memories", { method: "OPTIONS" }),
    env,
    ctx,
  );
  assert.equal(response.status, 204);
});
