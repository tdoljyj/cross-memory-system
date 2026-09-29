import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { loadContinuityWorker } from "./worker-continuity-loader.mjs";

const worker = await loadContinuityWorker();
const issuer = randomBytes(32).toString("base64url");
const reference = { connection_id: randomUUID(), job_id: randomUUID() };
const env = {
  CLUED_STORAGE_ACCOUNT_V1: "true", CLUED_STORAGE_GOOGLE_V1: "true", CLUED_STORAGE_JOBS_V2: "true",
  CLUED_STORAGE_EXECUTOR_V1: "true",
  SUPABASE_URL: "https://db.example.invalid", SUPABASE_PUBLISHABLE_KEY: "fixture-public-key",
  CLUED_STORAGE_CONNECTOR_ISSUER: issuer,
  CLUED_STORAGE_GOOGLE_CLIENT_ID: "fixture.apps.googleusercontent.com",
  CLUED_STORAGE_VAULT_KEYS: JSON.stringify({ current_key_id: "fixture", keys: { fixture: randomBytes(32).toString("base64url") } }),
};

test("scheduled recovery remains read-only when disabled and fails closed on missing issuer", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error("unexpected IO"); };
  try {
    for (const flag of ["CLUED_STORAGE_ACCOUNT_V1", "CLUED_STORAGE_GOOGLE_V1", "CLUED_STORAGE_JOBS_V2", "CLUED_STORAGE_EXECUTOR_V1"])
      assert.deepEqual(await worker.runStorageRecoveryScheduled({ ...env, [flag]: "false" }), { status: "disabled" });
    assert.deepEqual(await worker.runStorageRecoveryScheduled({ ...env, CLUED_STORAGE_CONNECTOR_ISSUER: undefined }),
      { status: "unavailable" });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = previous; }
});

test("scheduled recovery uses the fixed issuer, bounded references and the original-job descriptor only", async () => {
  const previous = globalThis.fetch;
  const calls = [];
  let jobs = [reference];
  let verified = false;
  globalThis.fetch = async (url, init) => {
    assert.ok(["/rest/v1/rpc/clued_storage_scheduled_recovery_v2",
      "/rest/v1/rpc/clued_storage_cloud_worker_router_v2"].some(path => String(url) === env.SUPABASE_URL + path));
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-public-key");
    assert.equal(init.redirect, "manual");
    const input = JSON.parse(init.body);
    calls.push(input.p_input);
    assert.equal(input.p_issuer_hash, createHash("sha256").update(issuer).digest("hex"));
    if (String(url).endsWith("clued_storage_cloud_worker_router_v2")) {
      if (input.p_input.action === "settle_verified") return Response.json({ status: "committed", state: "committed",
        ...reference, final_result: { status: "committed" }, receipt_id: randomUUID(), execution_permitted: false });
      assert.equal(input.p_input.action, "verified_inspect");
      return Response.json(verified ? { status: "verified", ...reference, verified_receipt_id: randomUUID(),
        verified_digest: "a".repeat(64), execution_permitted: false }
        : { status: "inspection_required", ...reference, execution_permitted: false });
    }
    if (input.p_input.action === "due") return Response.json({ status: "ok", jobs });
    assert.deepEqual(input.p_input, { ...reference, action: "load" });
    return Response.json({ status: "inspection_required", execution_permitted: false });
  };
  try {
    assert.deepEqual(await worker.runStorageRecoveryScheduled(env),
      { status: "attention_required", committed: 0, attention: 1 });
    assert.deepEqual(calls.map(call => call.action), ["due", "verified_inspect", "load"]);
    calls.length = 0; verified = true;
    assert.deepEqual(await worker.runStorageRecoveryScheduled(env), { status: "ok", committed: 1, attention: 0 });
    assert.deepEqual(calls.map(call => call.action), ["due", "verified_inspect", "settle_verified"]);
    calls.length = 0; jobs = Array.from({ length: 4 }, () => ({ connection_id: randomUUID(), job_id: randomUUID() }));
    assert.deepEqual(await worker.runStorageRecoveryScheduled(env), { status: "unavailable" });
    assert.deepEqual(calls.map(call => call.action), ["due"]);
    calls.length = 0; jobs = [{ ...reference, mutation: { operation: "create" } }];
    assert.deepEqual(await worker.runStorageRecoveryScheduled(env), { status: "unavailable" });
    assert.deepEqual(calls.map(call => call.action), ["due"]);
  } finally { globalThis.fetch = previous; }
});
