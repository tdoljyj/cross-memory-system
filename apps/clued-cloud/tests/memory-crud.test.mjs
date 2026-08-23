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
const userId = "ca1aeea5-9a2b-4e91-8a0e-8402c8be6a56";
const memoryId = "b5eb6c34-d18d-4100-9a20-f7a63020b04d";

test("requires a signed-in account for memory CRUD", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("https://clued.test/api/memories"),
    env,
    ctx,
  );
  assert.equal(response.status, 401);
});

test("proxies create, update and delete through the user JWT", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/auth/v1/user")) {
      return Response.json({ id: userId, email: "user@example.com" });
    }
    if (url.endsWith("/rest/v1/clued_memories") && init.method === "POST") {
      const body = JSON.parse(init.body);
      assert.equal(init.headers.get("authorization"), "Bearer user-session-jwt");
      assert.deepEqual(body, {
        user_id: userId,
        title: "Launch decision",
        content: "Ship the smallest verified CRUD loop.",
      });
      return Response.json([
        {
          id: memoryId,
          title: body.title,
          content: body.content,
          created_at: "2026-08-24T00:00:00Z",
          updated_at: "2026-08-24T00:00:00Z",
        },
      ]);
    }
    if (url.includes(`/rest/v1/clued_memories?id=eq.${memoryId}`) && init.method === "PATCH") {
      const body = JSON.parse(init.body);
      assert.equal(body.title, "Updated decision");
      assert.equal(body.content, "CRUD is verified end to end.");
      assert.match(body.updated_at, /^2026-/);
      return Response.json([
        {
          id: memoryId,
          title: body.title,
          content: body.content,
          created_at: "2026-08-24T00:00:00Z",
          updated_at: body.updated_at,
        },
      ]);
    }
    if (url.includes(`/rest/v1/clued_memories?id=eq.${memoryId}`) && init.method === "DELETE") {
      return Response.json([{ id: memoryId }]);
    }
    return Response.json({ message: "unexpected request" }, { status: 500 });
  };

  const authHeaders = {
    authorization: "Bearer user-session-jwt",
    "content-type": "application/json",
  };
  try {
    const created = await worker.fetch(
      new Request("https://clued.test/api/memories", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          title: "  Launch decision  ",
          content: "  Ship the smallest verified CRUD loop.  ",
        }),
      }),
      env,
      ctx,
    );
    assert.equal(created.status, 201);
    assert.equal((await created.json()).memory.id, memoryId);

    const updated = await worker.fetch(
      new Request(`https://clued.test/api/memories?id=${memoryId}`, {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify({
          title: "Updated decision",
          content: "CRUD is verified end to end.",
        }),
      }),
      env,
      ctx,
    );
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).memory.title, "Updated decision");

    const deleted = await worker.fetch(
      new Request(`https://clued.test/api/memories?id=${memoryId}`, {
        method: "DELETE",
        headers: { authorization: "Bearer user-session-jwt" },
      }),
      env,
      ctx,
    );
    assert.equal(deleted.status, 204);
    assert.equal(calls.length, 6);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lists memories and their read-only audit receipts", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return Response.json({ id: userId });
    if (url.includes("/rest/v1/clued_memories?")) {
      return Response.json([{ id: memoryId, title: "A", content: "B" }]);
    }
    if (url.includes("/rest/v1/clued_memory_audit?")) {
      return Response.json([
        {
          id: "a5eb6c34-d18d-4100-9a20-f7a63020b04d",
          memory_id: memoryId,
          action: "create",
          details: { title: "A", content_sha256: "a".repeat(64) },
          occurred_at: "2026-08-24T00:00:00Z",
        },
      ]);
    }
    return Response.json({ message: "unexpected request" }, { status: 500 });
  };

  try {
    const headers = { authorization: "Bearer user-session-jwt" };
    const listed = await worker.fetch(
      new Request("https://clued.test/api/memories", { headers }),
      env,
      ctx,
    );
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).memories[0].id, memoryId);

    const audit = await worker.fetch(
      new Request("https://clued.test/api/memories/audit", { headers }),
      env,
      ctx,
    );
    assert.equal(audit.status, 200);
    const receipt = (await audit.json()).audit[0];
    assert.equal(receipt.action, "create");
    assert.equal("content" in receipt.details, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
