import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { loadContinuityWorker } from "./worker-continuity-loader.mjs";
const worker = await loadContinuityWorker();
const origin = "https://clued.example.invalid", connection = randomUUID(), issuer = randomBytes(32).toString("base64url");
const env = { CLUED_STORAGE_ACCOUNT_V1: "true", CLUED_STORAGE_GOOGLE_V1: "true", CLUED_STORAGE_REFRESH_V1: "true",
  SUPABASE_URL: "https://db.example.invalid", SUPABASE_PUBLISHABLE_KEY: "fixture-public-key", CLUED_STORAGE_CONNECTOR_ISSUER: issuer,
  CLUED_STORAGE_GOOGLE_CLIENT_ID: "fixture.apps.googleusercontent.com", CLUED_STORAGE_GOOGLE_CLIENT_SECRET: "fixture-private-client-secret",
  CLUED_STORAGE_VAULT_KEYS: JSON.stringify({ current_key_id: "fixture", keys: { fixture: randomBytes(32).toString("base64url") } }) };
const request = (body, token = "fixture-native-jwt") => new Request(origin+"/v1/storage/refresh", {
  method: "POST", headers: { origin, "content-type": "application/json", authorization: "Bearer "+token }, body: JSON.stringify(body) });
test("refresh management defaults off, rejects Bindings and forwards only native owner RPC", async () => {
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/auth/v1/user")) return Response.json({ id: "fixture-owner" });
    assert.equal(String(url), env.SUPABASE_URL+"/rest/v1/rpc/clued_storage_refresh_manage_v1");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-native-jwt");
    assert.deepEqual(JSON.parse(init.body), { p_input: { action: "status", connection_id: connection } });
    return Response.json({ enabled: false, version: 0 });
  };
  try {
    assert.equal((await worker.fetch(request({}), {})).status, 404);
    assert.equal((await worker.fetch(request({}), { ...env, CLUED_STORAGE_REFRESH_V1: "false" })).status, 404);
    assert.equal((await worker.fetch(request({}, "clued_bnd_"+"a".repeat(64)), env)).status, 401); assert.equal(calls.length, 0);
    const response = await worker.fetch(request({ action: "status", connection_id: connection }), env);
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(calls.length, 2);
    assert.equal(JSON.stringify(await response.json()).includes(issuer), false);
  } finally { globalThis.fetch = previous; }
});
test("scheduled refresh disabled flags cause zero IO and missing secret fails closed", async () => {
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error("forbidden"); };
  try {
    for (const flag of ["CLUED_STORAGE_ACCOUNT_V1", "CLUED_STORAGE_GOOGLE_V1", "CLUED_STORAGE_REFRESH_V1"])
      assert.deepEqual(await worker.runStorageRefreshScheduled({ ...env, [flag]: "false" }), { status: "disabled" });
    assert.deepEqual(await worker.runStorageRefreshScheduled({ ...env, CLUED_STORAGE_CONNECTOR_ISSUER: undefined }), { status: "unavailable" });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = previous; }
});
test("scheduler uses only fixed private issuer RPC, bounded batch and non-sensitive status", async () => {
  const previous = globalThis.fetch, calls = []; let connections = [connection], pending = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), env.SUPABASE_URL+"/rest/v1/rpc/clued_storage_refresh_worker_v1");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-public-key"); assert.equal(init.redirect, "manual");
    const input = JSON.parse(init.body); calls.push(input);
    assert.equal(input.p_issuer_hash, createHash("sha256").update(issuer).digest("hex"));
    if (input.p_input.action === "due") return Response.json({ connections, pending_expired: pending });
    assert.equal(input.p_input.action, "claim"); return Response.json({ status: "claimed" });
  };
  try {
    assert.deepEqual(await worker.runStorageRefreshScheduled(env), { status: "attention_required", committed: 0, unavailable: 1 });
    assert.equal(calls.length, 2); assert.equal(calls[1].p_input.connection_id, connection);
    connections = Array.from({ length: 11 }, () => randomUUID());
    assert.deepEqual(await worker.runStorageRefreshScheduled(env), { status: "unavailable" }); assert.equal(calls.length, 3);
    connections = []; pending = 2;
    assert.deepEqual(await worker.runStorageRefreshScheduled(env), { status: "attention_required", committed: 0, unavailable: 2 });
    pending = 0;
    assert.deepEqual(await worker.runStorageRefreshScheduled(env), { status: "ok", committed: 0, unavailable: 0 });
  } finally { globalThis.fetch = previous; }
});
