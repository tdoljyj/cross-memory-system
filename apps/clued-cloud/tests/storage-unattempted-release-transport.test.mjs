import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { loadContinuityWorker } from "./worker-continuity-loader.mjs";

// Storage fix (Owner Decision d9d6db4c): the scheduled release of started jobs
// that never recorded a provider attempt. Database only, never the executor gate.
const worker = await loadContinuityWorker();
const issuer = randomBytes(32).toString("base64url");
const env = {
  CLUED_STORAGE_ACCOUNT_V1: "true", CLUED_STORAGE_GOOGLE_V1: "true", CLUED_STORAGE_JOBS_V2: "true",
  SUPABASE_URL: "https://db.example.invalid", SUPABASE_PUBLISHABLE_KEY: "fixture-public-key",
  CLUED_STORAGE_CONNECTOR_ISSUER: issuer,
};

test("the unattempted release is off with any storage flag off and fails closed without the issuer", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error("unexpected IO"); };
  try {
    for (const flag of ["CLUED_STORAGE_ACCOUNT_V1", "CLUED_STORAGE_GOOGLE_V1", "CLUED_STORAGE_JOBS_V2"])
      assert.deepEqual(await worker.runStorageUnattemptedReleaseScheduled({ ...env, [flag]: "false" }), { status: "disabled" });
    assert.deepEqual(await worker.runStorageUnattemptedReleaseScheduled({ ...env, CLUED_STORAGE_CONNECTOR_ISSUER: undefined }),
      { status: "unavailable" });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = previous; }
});

test("the unattempted release calls only the fixed RPC with the issuer, with or without the executor switch", async () => {
  const previous = globalThis.fetch;
  const calls = [];
  let reply = { status: "ok", released: 1 };
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), env.SUPABASE_URL + "/rest/v1/rpc/clued_storage_release_unattempted_v1");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-public-key");
    assert.equal(init.redirect, "manual");
    const body = JSON.parse(init.body);
    calls.push(body);
    assert.deepEqual(body, { p_issuer_hash: createHash("sha256").update(issuer).digest("hex"), p_input: { action: "release" } });
    return Response.json(reply);
  };
  try {
    for (const executor of [undefined, "false", "true"])
      assert.deepEqual(await worker.runStorageUnattemptedReleaseScheduled({ ...env, CLUED_STORAGE_EXECUTOR_V1: executor }),
        { status: "ok", released: 1 });
    assert.equal(calls.length, 3);
    reply = { status: "ok", released: 0 };
    assert.deepEqual(await worker.runStorageUnattemptedReleaseScheduled(env), { status: "ok", released: 0 });
    for (const bad of [{ status: "ok", released: 4 }, { status: "ok", released: -1 }, { status: "ok", released: "1" },
      { status: "ok" }, { status: "denied", released: 0 }, null]) {
      reply = bad;
      assert.deepEqual(await worker.runStorageUnattemptedReleaseScheduled(env), { status: "unavailable" }, JSON.stringify(bad));
    }
    globalThis.fetch = async () => new Response(JSON.stringify({ message: "storage_release_denied" }), { status: 403 });
    assert.deepEqual(await worker.runStorageUnattemptedReleaseScheduled(env), { status: "unavailable" });
  } finally { globalThis.fetch = previous; }
});
