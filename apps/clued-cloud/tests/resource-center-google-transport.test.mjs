import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { loadContinuityWorker } from "./worker-continuity-loader.mjs";
const worker = await loadContinuityWorker();
const origin = "https://clued.example.invalid", connection = randomUUID();
const issuer = randomBytes(32).toString("base64url");
const env = { CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway", CLUED_STORAGE_ACCOUNT_V1: "true", CLUED_STORAGE_GOOGLE_V1: "true", SUPABASE_URL: "https://db.example.invalid", SUPABASE_PUBLISHABLE_KEY: "fixture-public-key",
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
    assert.equal(init.redirect, "manual"); assert.ok(init.signal);
    const body = JSON.parse(init.body); calls.push(body);
    assert.equal(body.p_issuer_hash, createHash("sha256").update(issuer).digest("hex"));
    if (body.p_input.action === "describe") return Response.json({ owner_id: randomUUID(), connection_id: connection, connection_version: 1, credential_version: 1,
      provider_subject: null, oauth_client_id: env.CLUED_STORAGE_GOOGLE_CLIENT_ID, redirect_uri: env.CLUED_STORAGE_GOOGLE_REDIRECT_URI, root_folder_id: "root", root_parent_id: "parent",
      provider_scope_profile: "legacy" });
    assert.equal(body.p_input.action, "prepare");
    // A plain reconnect keeps the recorded profile and binds it to the attempt (StorageNormalUse §2.3).
    assert.equal(body.p_input.requested_scope_profile, "legacy"); assert.equal("normal_use" in body.p_input, false);
    return Response.json({ status: "prepared" });
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

test("existing OAuth issuer RPC refuses 307 and 308 without forwarding secrets or calling Google",async()=>{
  const original=globalThis.fetch;let calls=0;
  try {
    for(const status of [307,308]) {
      globalThis.fetch=async(url,init)=>{
        if(String(url).endsWith('/auth/v1/user'))return Response.json({id:'fixture-owner'});
        calls++;assert.ok([env.SUPABASE_URL+'/rest/v1/rpc/clued_storage_oauth_v1',env.SUPABASE_URL+'/rest/v1/rpc/clued_storage_oauth_callback_v2'].includes(String(url)));
        assert.equal(init.redirect,'manual');assert.ok(init.signal);
        return new Response(null,{status,headers:{location:'https://untrusted.invalid'}});
      };
      for(const path of ['start','complete']) {
        const response=await worker.fetch(request(path,path==='start'?{connection_id:connection}:{state:'a'.repeat(43),code:'synthetic-code'}),env);
        assert.equal(response.status,403);assert.deepEqual(await response.json(),{error:'Storage Google connection unavailable.',...(path==='complete'?{reason:'attempt_unavailable'}:{})});
      }
    }
    assert.equal(calls,4);
  } finally {globalThis.fetch=original;}
});
test("default refresh requires the refresh feature and a strict boolean before any private RPC",async()=>{
  const original=globalThis.fetch; let rpcCalls=0;
  globalThis.fetch=async url=>{if(String(url).endsWith('/auth/v1/user'))return Response.json({id:'fixture-owner'});rpcCalls++;throw Error('unexpected private RPC');};
  try {
    for(const value of ['true',1,null,{}]) assert.equal((await worker.fetch(request('start',{connection_id:connection,default_refresh:value}),{ CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway",...env,CLUED_STORAGE_REFRESH_V1:'true'})).status,403);
    assert.equal((await worker.fetch(request('start',{connection_id:connection,default_refresh:true}),env)).status,403);
    assert.equal(rpcCalls,0);
  } finally {globalThis.fetch=original;}
});

test('recovery start pins one job and describe fingerprint, without new execution flags or default refresh',async()=>{
  const original=globalThis.fetch,job=randomUUID(),calls=[];
  globalThis.fetch=async(url,init)=>{
    if(String(url).endsWith('/auth/v1/user'))return Response.json({id:'fixture-owner'});
    assert.equal(String(url),env.SUPABASE_URL+'/rest/v1/rpc/clued_storage_recovery_oauth_start_v2');
    assert.equal(init.redirect,'manual');assert.ok(init.signal);
    assert.equal(new Headers(init.headers).get('authorization'),'Bearer fixture-native');
    const body=JSON.parse(init.body);calls.push(body);
    assert.equal(body.p_issuer_secret,issuer);assert.equal(body.p_issuer_hash,undefined);
    assert.equal(body.p_input.job_id,job);assert.equal(body.p_input.connection_id,connection);
    if(body.p_input.action==='describe')return Response.json({owner_id:randomUUID(),connection_id:connection,connection_version:9,credential_version:4,
      provider_subject:'fixture-subject',oauth_client_id:env.CLUED_STORAGE_GOOGLE_CLIENT_ID,redirect_uri:env.CLUED_STORAGE_GOOGLE_REDIRECT_URI,
      root_folder_id:'root',root_parent_id:'parent',recovery_binding:'e'.repeat(64),provider_scope_profile:'legacy',default_refresh_eligible:true});
    assert.equal(body.p_input.recovery_binding,'e'.repeat(64));assert.equal(body.p_input.connection_version,9);
    assert.equal(Object.hasOwn(body.p_input,'default_refresh_consent'),false);
    return Response.json({status:'prepared'});
  };
  try{
    const response=await worker.fetch(request('recovery/start',{connection_id:connection,job_id:job}),env);
    assert.equal(response.status,200);assert.equal(calls.length,2);assert.equal(response.headers.get('cache-control'),'no-store');
    const result=await response.json();assert.equal(new URL(result.authorization_url).searchParams.get('include_granted_scopes'),'false');
    assert.deepEqual(Object.keys(result),['authorization_url']);
    for(const bad of [{default_refresh:true},{purpose:'connection'},{recovery_binding:'f'.repeat(64)},{managed_root:'/caller'},{job_id:['x']},{connection_id:{}}]){
      assert.equal((await worker.fetch(request('recovery/start',{connection_id:connection,job_id:job,...bad}),env)).status,403);
    }
    assert.equal(calls.length,2);
    assert.equal((await worker.fetch(request('recovery/start',{connection_id:connection,job_id:job},'clued_bnd_'+'a'.repeat(64)),env)).status,401);
  }finally{globalThis.fetch=original;}
});
test('automatic recovery is explicitly marked for one original job before returning Google consent URL',async()=>{
  const original=globalThis.fetch,job=randomUUID(),calls=[];
  globalThis.fetch=async(url,init)=>{
    if(String(url).endsWith('/auth/v1/user'))return Response.json({id:'fixture-owner'});
    const body=JSON.parse(init.body);calls.push({url:String(url),body});
    if(body.p_input.action==='describe')return Response.json({owner_id:randomUUID(),connection_id:connection,connection_version:9,credential_version:4,
      provider_subject:'fixture-subject',oauth_client_id:env.CLUED_STORAGE_GOOGLE_CLIENT_ID,redirect_uri:env.CLUED_STORAGE_GOOGLE_REDIRECT_URI,
      root_folder_id:'root',root_parent_id:'parent',recovery_binding:'e'.repeat(64),provider_scope_profile:'legacy'});
    if(body.p_input.action==='prepare')return Response.json({status:'prepared'});
    assert.equal(String(url),env.SUPABASE_URL+'/rest/v1/rpc/clued_storage_recovery_auto_target_v1');
    if(body.p_input.action==='target')return Response.json({status:'ready',connection_id:connection,job_id:job,execution_permitted:false});
    assert.equal(body.p_input.action,'mark');assert.equal(body.p_input.connection_id,connection);assert.equal(body.p_input.job_id,job);
    assert.match(body.p_input.state_hash,/^[0-9a-f]{64}$/);return Response.json({status:'marked'});
  };
  try{
    const result=await worker.fetch(request('recovery/auto-start',{connection_id:connection,job_id:job}),env);
    assert.equal(result.status,200, result.status===200?'':await result.text());assert.equal(calls.length,3);
    const state=new URL((await result.json()).authorization_url).searchParams.get('state');
    assert.equal(calls[2].body.p_input.state_hash,createHash('sha256').update(state).digest('hex'));
    const target=await worker.fetch(request('recovery/auto-target',{state}),env);
    assert.equal(target.status,200);assert.equal(calls[3].body.p_input.action,'target');
    assert.equal(calls[3].body.p_input.state_hash,calls[2].body.p_input.state_hash);
  }finally{globalThis.fetch=original;}
});

test("normal-use start (StorageNormalUse §2.4) requests the normal set and binds the confirmed disclosure; bad shapes never reach the RPC", async () => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/auth/v1/user")) return Response.json({ id: "fixture-owner" });
    const body = JSON.parse(init.body); calls.push(body);
    if (body.p_input.action === "describe") return Response.json({ owner_id: randomUUID(), connection_id: connection, connection_version: 1, credential_version: 2,
      provider_subject: "subject", oauth_client_id: env.CLUED_STORAGE_GOOGLE_CLIENT_ID, redirect_uri: env.CLUED_STORAGE_GOOGLE_REDIRECT_URI, root_folder_id: "root", root_parent_id: "parent",
      provider_scope_profile: "legacy" });
    if (body.p_input.normal_use?.disclosure_version === "busy/1") return Response.json({ message: "storage_root_has_unresolved_mutation" }, { status: 403 });
    return Response.json({ status: "prepared" });
  };
  try {
    const disclosure = "clued.storage-normal-use-disclosure/1";
    const response = await worker.fetch(request("start", { connection_id: connection, normal_use: { disclosure_version: disclosure } }), env);
    assert.equal(response.status, 200);
    const url = new URL((await response.json()).authorization_url);
    assert.equal(url.searchParams.get("scope").split(" ").length, 3);
    assert.ok(url.searchParams.get("scope").includes("auth/drive.readonly"));
    assert.equal(calls[1].p_input.requested_scope_profile, "normal");
    assert.deepEqual(calls[1].p_input.normal_use, { disclosure_version: disclosure });
    const before = calls.length;
    for (const normal_use of [true, "x", null, [], {}, { disclosure_version: disclosure, extra: 1 }, { disclosure_version: 1 }]) {
      const refused = await worker.fetch(request("start", { connection_id: connection, normal_use }), env);
      assert.equal(refused.status, 403, JSON.stringify(normal_use));
    }
    assert.equal(calls.length, before, "no RPC for an invalid shape");
    const busy = await worker.fetch(request("start", { connection_id: connection, normal_use: { disclosure_version: "busy/1" } }), env);
    assert.equal(busy.status, 403);
    assert.deepEqual(await busy.json(), { error: "Storage Google connection unavailable.", reason: "storage_root_busy" });
  } finally { globalThis.fetch = original; }
});
