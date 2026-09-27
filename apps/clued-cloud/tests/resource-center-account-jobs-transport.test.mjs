import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadContinuityWorker } from "./worker-continuity-loader.mjs";
const worker = await loadContinuityWorker();
const origin = "https://clued.example.invalid";
const token = "clued_bnd_" + "a".repeat(40);
const env = { CLUED_STORAGE_ACCOUNT_V1: "true", CLUED_STORAGE_JOBS_V1: "true", SUPABASE_URL: "https://db.example.invalid", SUPABASE_PUBLISHABLE_KEY: "fixture-public-key" };
const request = (body, bearer = token) => new Request(origin + "/v1/storage/jobs", {
  method: "POST", headers: { "content-type": "application/json", origin, authorization: "Bearer " + bearer }, body: JSON.stringify(body),
});
test("account job transport is off by default and requires a Binding, not a native JWT", async () => {
  const before = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("not expected"); };
  try {
    assert.equal((await worker.fetch(request({}), {})).status, 404);
    assert.equal((await worker.fetch(request({}, "native-jwt"), env)).status, 403);
    assert.equal((await worker.fetch(request({}, "clued_bnd_short"), env)).status, 403);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = before; }
});
test("submit/status route hashes Binding and never supplies an owner or service role", async () => {
  const before = globalThis.fetch; const calls = [];
  const input = { action: "inspect", connection_id: "fixture-connection", job_id: "fixture-job" };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: new Headers(init.headers) });
    return Response.json({ status: "queued", execution_permitted: false });
  };
  try {
    const result = await worker.fetch(request(input), env);
    assert.equal(result.status, 200); assert.equal(result.headers.get("cache-control"), "no-store");
    assert.equal((await result.json()).execution_permitted, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, env.SUPABASE_URL + "/rest/v1/rpc/clued_storage_jobs_v1");
    assert.deepEqual(calls[0].body, { p_token_hash: createHash("sha256").update(token).digest("hex"), p_input: input });
    assert.equal(calls[0].headers.get("authorization"), "Bearer fixture-public-key");
  } finally { globalThis.fetch = before; }
});
test("database rejection does not expose payload or internal diagnostics", async () => {
  const before = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ message: "private-content", code: "42501" }, { status: 403 });
  try {
    const result = await worker.fetch(request({ action: "begin" }), env);
    assert.equal(result.status, 403); assert.equal((await result.text()).includes("private-content"), false);
  } finally { globalThis.fetch = before; }
});
