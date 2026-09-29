import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadContinuityWorker } from "./worker-continuity-loader.mjs";

const worker = await loadContinuityWorker();
const origin = "https://clued.example.invalid";
const issuer = "fixture-policy-transition-issuer-" + "x".repeat(32);
const env = {
  CLUED_STORAGE_ACCOUNT_V1: "true", CLUED_STORAGE_POLICY_TRANSITION_V2: "true",
  CLUED_STORAGE_CONNECTOR_ISSUER: issuer,
  SUPABASE_URL: "https://db.example.invalid", SUPABASE_PUBLISHABLE_KEY: "fixture-public-key",
};
const manifestId = "10000000-0000-4000-8000-000000000071";
const request = (body, token = "fixture-native-jwt") => new Request(origin + "/v1/storage/policy-transition", {
  method: "POST", headers: { "content-type": "application/json", origin, authorization: "Bearer " + token },
  body: JSON.stringify(body),
});

test("policy transition transport is disabled until released and rejects Binding tokens", async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
  try {
    assert.equal((await worker.fetch(request({ action: "describe", manifest_id: manifestId }), {
      ...env, CLUED_STORAGE_POLICY_TRANSITION_V2: "false",
    })).status, 404);
    assert.equal((await worker.fetch(request({ action: "describe", manifest_id: manifestId }, "clued_bnd_" + "a".repeat(64)), env)).status, 401);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test("signed-in Owner reaches exact transition RPC with fixed server issuer", async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), body: init.body });
    if (String(url).endsWith("/auth/v1/user")) return Response.json({ id: "fixture-owner" });
    return Response.json({ contract: "clued.storage-policy-transition-status/2", status: "reviewed", execution_permitted: false });
  };
  try {
    const input = { action: "describe", manifest_id: manifestId };
    const response = await worker.fetch(request(input), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(calls[1].url, env.SUPABASE_URL + "/rest/v1/rpc/clued_storage_policy_transition_v2");
    assert.equal(calls[1].headers.get("authorization"), "Bearer fixture-native-jwt");
    assert.deepEqual(JSON.parse(calls[1].body), {
      p_issuer_hash: createHash("sha256").update(issuer).digest("hex"), p_input: input,
    });
  } finally { globalThis.fetch = original; }
});

test("transition transport rejects caller authority fields and hides database errors", async () => {
  const original = globalThis.fetch; let rpcCalls = 0;
  globalThis.fetch = async url => {
    if (String(url).endsWith("/auth/v1/user")) return Response.json({ id: "fixture-owner" });
    rpcCalls++;
    return Response.json({ message: "private upstream diagnostic", code: "42501" }, { status: 403 });
  };
  try {
    const bad = await worker.fetch(request({ action: "describe", manifest_id: manifestId, owner_id: manifestId }), env);
    assert.equal(bad.status, 403);
    assert.equal(rpcCalls, 0);
    const denied = await worker.fetch(request({ action: "inspect", manifest_id: manifestId }), env);
    assert.equal(denied.status, 403);
    assert.equal((await denied.text()).includes("private"), false);
    assert.equal(rpcCalls, 1);
  } finally { globalThis.fetch = original; }
});
