import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { loadContinuityWorker } from "./worker-continuity-loader.mjs";
const worker = await loadContinuityWorker();
const origin = "https://clued.example.invalid", connection = randomUUID();
const issuer = randomBytes(32).toString("base64url");
const env = { CLUED_STORAGE_ACCOUNT_V1: "true", CLUED_STORAGE_GOOGLE_V1: "true", SUPABASE_URL: "https://db.example.invalid", SUPABASE_PUBLISHABLE_KEY: "fixture-public-key",
  CLUED_STORAGE_GOOGLE_CLIENT_ID: "fixture.apps.googleusercontent.com", CLUED_STORAGE_GOOGLE_CLIENT_SECRET: "fixture-client-secret",
  CLUED_STORAGE_GOOGLE_REDIRECT_URI: origin + "/storage/google/callback", CLUED_STORAGE_CONNECTOR_ISSUER: issuer,
  CLUED_STORAGE_VAULT_KEYS: JSON.stringify({ current_key_id: "fixture", keys: { fixture: randomBytes(32).toString("base64url") } }) };
const request = (path, input, token = "fixture-native") => new Request(origin + "/v1/storage/google/" + path, { method: "POST",
  headers: { origin, "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify(input) });

test("OAuth routes default disabled and cannot accept Binding or browser-selected app configuration", async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async url => { calls++; assert.equal(String(url), env.SUPABASE_URL + "/auth/v1/user"); return Response.json({ id: "fixture-owner" }); };
  try {
    assert.equal((await worker.fetch(request("start", { connection_id: connection }), {})).status, 404);
    assert.equal((await worker.fetch(request("start", { connection_id: connection }, "clued_bnd_" + "a".repeat(64)), env)).status, 401);
    assert.equal(calls, 0);
    for (const key of ["managed_root", "profile", "client_id", "issuer", "vault"]) {
      assert.equal((await worker.fetch(request("start", { connection_id: connection, [key]: "caller-selected" }), env)).status, 403);
    }
    assert.equal(calls, 5); // Authentication only; neither private RPC nor Google.
  } finally { globalThis.fetch = original; }
});

test("native OAuth route adds only server issuer and returns no native/provider secrets", async () => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/auth/v1/user")) return Response.json({ id: "fixture-owner" });
    assert.equal(String(url), env.SUPABASE_URL + "/rest/v1/rpc/clued_storage_oauth_v1");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-native");
    const body = JSON.parse(init.body); calls.push(body);
    assert.equal(body.p_issuer_hash, createHash("sha256").update(issuer).digest("hex"));
    if (body.p_input.action === "describe") return Response.json({ owner_id: randomUUID(), connection_id: connection, connection_version: 1, credential_version: 1,
      provider_subject: null, oauth_client_id: env.CLUED_STORAGE_GOOGLE_CLIENT_ID, redirect_uri: env.CLUED_STORAGE_GOOGLE_REDIRECT_URI, root_folder_id: "root", root_parent_id: "parent" });
    assert.equal(body.p_input.action, "prepare"); return Response.json({ status: "prepared" });
  };
  try {
    const response = await worker.fetch(request("start", { connection_id: connection }), env);
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const result = await response.json(); assert.equal(new URL(result.authorization_url).origin, "https://accounts.google.com");
    for (const secret of [issuer, "fixture-native", "fixture-client-secret", env.CLUED_STORAGE_VAULT_KEYS]) assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(calls.length, 2); assert.ok(calls[1].p_input.verifier_envelope.ciphertext);
  } finally { globalThis.fetch = original; }
});

test("callback transport exposes only a fixed reason, never upstream exception details", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async url => String(url).endsWith("/auth/v1/user") ? Response.json({id:"fixture-owner"}) :
    Response.json({message:"private-provider-secret",reason:"attacker-controlled-text"},{status:403});
  try {
    const response = await worker.fetch(request("complete",{state:"a".repeat(43),code:"fixture-auth-code"}),env);
    assert.equal(response.status,403);
    assert.equal(response.headers.get("cache-control"),"no-store");
    assert.deepEqual(await response.json(),{error:"Storage Google connection unavailable.",reason:"attempt_unavailable"});
  } finally {globalThis.fetch=original;}
});
test("default refresh requires the refresh feature and a strict boolean before any private RPC",async()=>{
  const original=globalThis.fetch; let rpcCalls=0;
  globalThis.fetch=async url=>{if(String(url).endsWith('/auth/v1/user'))return Response.json({id:'fixture-owner'});rpcCalls++;throw Error('unexpected private RPC');};
  try {
    for(const value of ['true',1,null,{}]) assert.equal((await worker.fetch(request('start',{connection_id:connection,default_refresh:value}),{...env,CLUED_STORAGE_REFRESH_V1:'true'})).status,403);
    assert.equal((await worker.fetch(request('start',{connection_id:connection,default_refresh:true}),env)).status,403);
    assert.equal(rpcCalls,0);
  } finally {globalThis.fetch=original;}
});
