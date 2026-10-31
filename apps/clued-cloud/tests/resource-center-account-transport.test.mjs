import assert from "node:assert/strict";
import test from "node:test";
import { loadContinuityWorker } from "./worker-continuity-loader.mjs";
const worker = await loadContinuityWorker();
const origin = "https://clued.example.invalid";
const env = { CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway", CLUED_STORAGE_ACCOUNT_V1: "true", SUPABASE_URL: "https://db.example.invalid", SUPABASE_PUBLISHABLE_KEY: "fixture-public-key" };
const request = (body, token = "fixture-native-jwt") => new Request(origin + "/v1/storage/account", {
  method: "POST", headers: { "content-type": "application/json", origin, authorization: "Bearer " + token }, body: JSON.stringify(body),
});
test("storage account endpoint is disabled by default and rejects Binding tokens", async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
  try {
    assert.equal((await worker.fetch(request({ action: "list" }), {})).status, 404);
    assert.equal((await worker.fetch(request({ action: "list" }, "clued_bnd_" + "a".repeat(64)), env)).status, 401);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});
test("native account token reaches exact RPC; no service-role or owner substitution", async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), body: init.body });
    if (String(url).endsWith("/auth/v1/user")) return Response.json({ id: "fixture-owner" });
    return Response.json({ connections: [] });
  };
  try {
    const result = await worker.fetch(request({ action: "list" }), env);
    assert.equal(result.status, 200); assert.equal(result.headers.get("cache-control"), "no-store");
    assert.deepEqual(await result.json(), { connections: [] });
    assert.equal(calls[1].url, env.SUPABASE_URL + "/rest/v1/rpc/clued_storage_account_v1");
    assert.equal(calls[1].headers.get("authorization"), "Bearer fixture-native-jwt");
    assert.deepEqual(JSON.parse(calls[1].body), { p_input: { action: "list" } });
  } finally { globalThis.fetch = original; }
});
test("database rejection is closed and never returns sensitive upstream errors", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async url => String(url).endsWith("/auth/v1/user") ? Response.json({ id: "fixture-owner" }) :
    Response.json({ message: "private upstream diagnostic", code: "42501" }, { status: 403 });
  try {
    const response = await worker.fetch(request({ action: "list" }), env);
    assert.equal(response.status, 403); assert.equal((await response.text()).includes("private"), false);
  } finally { globalThis.fetch = original; }
});

const ownerRequest = (body, token = "fixture-native-jwt") => new Request(origin + "/v1/storage/owner", {
  method: "POST", headers: { "content-type": "application/json", origin, authorization: "Bearer " + token },
  body: JSON.stringify(body),
});
test("owner storage management is native-only and routes to its exact RPC",async()=>{
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init)=>{
    calls.push({url:String(url),headers:new Headers(init.headers),body:init.body});
    if(String(url).endsWith("/auth/v1/user"))return Response.json({id:"fixture-owner"});
    return Response.json({connections:[]});
  };
  try {
    assert.equal((await worker.fetch(ownerRequest({action:"connections"}),{})).status,404);
    assert.equal((await worker.fetch(ownerRequest({action:"connections"},"clued_bnd_"+"a".repeat(64)),env)).status,401);
    assert.equal(calls.length,0);
    const result=await worker.fetch(ownerRequest({action:"connections"}),{ CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway",...env,CLUED_STORAGE_EXECUTOR_V1:"false"});
    assert.equal(result.status,200);assert.deepEqual(await result.json(),{connections:[],worker_execution_enabled:false});
    assert.equal(calls[1].url,env.SUPABASE_URL+"/rest/v1/rpc/clued_storage_owner_manage_v2");
    assert.equal(calls[1].headers.get("authorization"),"Bearer fixture-native-jwt");
    assert.deepEqual(JSON.parse(calls[1].body),{p_input:{action:"connections"}});
  } finally {globalThis.fetch=original;}
});
// Bug 38bb5ddf: the directories that need the Owner are a separate fixed read.
test("owner digest attention routes to its own RPC with a fixed input",async()=>{
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init)=>{
    calls.push({url:String(url),headers:new Headers(init.headers),body:init.body});
    if(String(url).endsWith("/auth/v1/user"))return Response.json({id:"fixture-owner"});
    return Response.json({contract:"clued.storage-access-digest-attention/1",connections:[]});
  };
  try {
    const result=await worker.fetch(ownerRequest({action:"digest_attention",connection_id:"ignored"}),env);
    assert.equal(result.status,200);assert.deepEqual(await result.json(),{contract:"clued.storage-access-digest-attention/1",connections:[]});
    assert.equal(calls[1].url,env.SUPABASE_URL+"/rest/v1/rpc/clued_storage_access_digest_attention_v1");
    assert.equal(calls[1].headers.get("authorization"),"Bearer fixture-native-jwt");
    assert.deepEqual(JSON.parse(calls[1].body),{p_input:{action:"list"}});
  } finally {globalThis.fetch=original;}
});
test("owner storage management fails closed on database rejection",async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async url=>String(url).endsWith("/auth/v1/user")?Response.json({id:"fixture-owner"}):
    Response.json({message:"private credential",code:"42501"},{status:403});
  try {
    const response=await worker.fetch(ownerRequest({action:"disconnect",connection_id:"fixture",base_version:1,idempotency_key:"fixture-id"}),env);
    assert.equal(response.status,403);assert.equal((await response.text()).includes("private"),false);
  } finally {globalThis.fetch=original;}
});
test("Agent read-level control is native-only and routes to its exact RPC",async()=>{
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init)=>{
    calls.push({url:String(url),headers:new Headers(init.headers),body:init.body});
    if(String(url).endsWith("/auth/v1/user"))return Response.json({id:"fixture-owner"});
    if(calls.length>2)return Response.json({message:"private",code:"42501"},{status:403});
    return Response.json({active:false,read_generation:0,disclosure_version:"clued.storage-read-disclosure/1"});
  };
  const readRequest=(body,token="fixture-native-jwt")=>new Request(origin+"/v1/storage/read-access",{
    method:"POST",headers:{"content-type":"application/json",origin,authorization:"Bearer "+token},body:JSON.stringify(body)});
  try {
    assert.equal((await worker.fetch(readRequest({action:"status"}),{})).status,404);
    assert.equal((await worker.fetch(readRequest({action:"status"},"clued_bnd_"+"a".repeat(64)),env)).status,401);
    assert.equal(calls.length,0);
    const input={action:"status",connection_id:"20000000-0000-4000-8000-000000000001"};
    const ok=await worker.fetch(readRequest(input),env);
    assert.equal(ok.status,200);assert.equal(ok.headers.get("cache-control"),"no-store");
    assert.equal(calls[1].url,env.SUPABASE_URL+"/rest/v1/rpc/clued_storage_read_access_v1");
    assert.equal(calls[1].headers.get("authorization"),"Bearer fixture-native-jwt");
    assert.deepEqual(JSON.parse(calls[1].body),{p_input:input});
    const denied=await worker.fetch(readRequest(input),env);
    assert.equal(denied.status,403);assert.equal((await denied.text()).includes("private"),false);
  } finally {globalThis.fetch=original;}
});
test("Agent write-level control is native-only and routes to its exact RPC",async()=>{
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init)=>{
    calls.push({url:String(url),headers:new Headers(init.headers),body:init.body});
    if(String(url).endsWith("/auth/v1/user"))return Response.json({id:"fixture-owner"});
    if(calls.length>2)return Response.json({message:"private",code:"42501"},{status:403});
    return Response.json({active:true,policy_generation:1,classes:[],disclosure_version:"clued.storage-modify-disclosure/1"});
  };
  const writeRequest=(body,token="fixture-native-jwt")=>new Request(origin+"/v1/storage/write-access",{
    method:"POST",headers:{"content-type":"application/json",origin,authorization:"Bearer "+token},body:JSON.stringify(body)});
  try {
    assert.equal((await worker.fetch(writeRequest({action:"status"}),{})).status,404);
    assert.equal((await worker.fetch(writeRequest({action:"status"},"clued_bnd_"+"a".repeat(64)),env)).status,401);
    assert.equal(calls.length,0);
    const input={action:"status",connection_id:"20000000-0000-4000-8000-000000000001"};
    const ok=await worker.fetch(writeRequest(input),env);
    assert.equal(ok.status,200);assert.equal(ok.headers.get("cache-control"),"no-store");
    assert.equal(calls[1].url,env.SUPABASE_URL+"/rest/v1/rpc/clued_storage_write_access_v1");
    assert.equal(calls[1].headers.get("authorization"),"Bearer fixture-native-jwt");
    assert.deepEqual(JSON.parse(calls[1].body),{p_input:input});
    const denied=await worker.fetch(writeRequest(input),env);
    assert.equal(denied.status,403);assert.equal((await denied.text()).includes("private"),false);
  } finally {globalThis.fetch=original;}
});
test("trash batch confirmation (StorageFullCapability P5) is native-only and routes to its exact RPC",async()=>{
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init)=>{
    calls.push({url:String(url),headers:new Headers(init.headers),body:init.body});
    if(String(url).endsWith("/auth/v1/user"))return Response.json({id:"fixture-owner"});
    if(calls.length>2)return Response.json({message:"private",code:"42501"},{status:403});
    return Response.json({destructive:true,policy_generation:2,limit:5,window_hours:24,files:[],open_items:[]});
  };
  const trashRequest=(body,token="fixture-native-jwt")=>new Request(origin+"/v1/storage/trash-confirmation",{
    method:"POST",headers:{"content-type":"application/json",origin,authorization:"Bearer "+token},body:JSON.stringify(body)});
  try {
    assert.equal((await worker.fetch(trashRequest({action:"status"}),{})).status,404);
    assert.equal((await worker.fetch(trashRequest({action:"status"},"clued_bnd_"+"a".repeat(64)),env)).status,401);
    assert.equal(calls.length,0);
    const input={action:"status",connection_id:"20000000-0000-4000-8000-000000000001"};
    const ok=await worker.fetch(trashRequest(input),env);
    assert.equal(ok.status,200);assert.equal(ok.headers.get("cache-control"),"no-store");
    assert.equal(calls[1].url,env.SUPABASE_URL+"/rest/v1/rpc/clued_storage_trash_confirmation_v1");
    assert.equal(calls[1].headers.get("authorization"),"Bearer fixture-native-jwt");
    assert.deepEqual(JSON.parse(calls[1].body),{p_input:input});
    const denied=await worker.fetch(trashRequest(input),env);
    assert.equal(denied.status,403);assert.equal((await denied.text()).includes("private"),false);
  } finally {globalThis.fetch=original;}
});
test("normal-use control (StorageNormalUse §8.2) is native-only and routes to its exact RPC",async()=>{
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init)=>{
    calls.push({url:String(url),headers:new Headers(init.headers),body:init.body});
    if(String(url).endsWith("/auth/v1/user"))return Response.json({id:"fixture-owner"});
    if(calls.length>2)return Response.json({message:"private",code:"42501"},{status:403});
    return Response.json({normal_use:false,read_generation:1,disclosure_version:"clued.storage-normal-use-disclosure/1"});
  };
  const normalRequest=(body,token="fixture-native-jwt")=>new Request(origin+"/v1/storage/normal-use",{
    method:"POST",headers:{"content-type":"application/json",origin,authorization:"Bearer "+token},body:JSON.stringify(body)});
  try {
    assert.equal((await worker.fetch(normalRequest({action:"status"}),{})).status,404);
    assert.equal((await worker.fetch(normalRequest({action:"status"},"clued_bnd_"+"a".repeat(64)),env)).status,401);
    assert.equal(calls.length,0);
    const input={action:"status",connection_id:"20000000-0000-4000-8000-000000000001"};
    const ok=await worker.fetch(normalRequest(input),env);
    assert.equal(ok.status,200);assert.equal(ok.headers.get("cache-control"),"no-store");
    assert.equal(calls[1].url,env.SUPABASE_URL+"/rest/v1/rpc/clued_storage_normal_use_v1");
    assert.equal(calls[1].headers.get("authorization"),"Bearer fixture-native-jwt");
    assert.deepEqual(JSON.parse(calls[1].body),{p_input:input});
    const denied=await worker.fetch(normalRequest(input),env);
    assert.equal(denied.status,403);assert.equal((await denied.text()).includes("private"),false);
  } finally {globalThis.fetch=original;}
});
test("budget control (StorageNormalUse §7.3, N4) is native-only and routes to its exact RPC",async()=>{
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init)=>{
    calls.push({url:String(url),headers:new Headers(init.headers),body:init.body});
    if(String(url).endsWith("/auth/v1/user"))return Response.json({id:"fixture-owner"});
    if(refusal)return Response.json({message:refusal,code:refusal==="storage_owner_version_conflict"?"40001":"22023"},{status:400});
    if(calls.length>2)return Response.json({message:"private",code:"42501"},{status:403});
    return Response.json({contract:"clued.storage-budget/1"});
  };
  let refusal=null;
  const budgetRequest=(body,token="fixture-native-jwt")=>new Request(origin+"/v1/storage/budget",{
    method:"POST",headers:{"content-type":"application/json",origin,authorization:"Bearer "+token},body:JSON.stringify(body)});
  try {
    assert.equal((await worker.fetch(budgetRequest({action:"status"}),{})).status,404);
    assert.equal((await worker.fetch(budgetRequest({action:"status"},"clued_bnd_"+"a".repeat(64)),env)).status,401);
    assert.equal(calls.length,0);
    const input={action:"set",scope:"connection",connection_id:"20000000-0000-4000-8000-000000000001",base_generation:0,
      read_bytes_per_hour:67108864,upload_bytes_per_hour:67108864,idempotency_key:"fixture-budget-key"};
    const ok=await worker.fetch(budgetRequest(input),env);
    assert.equal(ok.status,200);assert.equal(ok.headers.get("cache-control"),"no-store");
    assert.equal(calls[1].url,env.SUPABASE_URL+"/rest/v1/rpc/clued_storage_budget_v1");
    assert.equal(calls[1].headers.get("authorization"),"Bearer fixture-native-jwt");
    assert.deepEqual(JSON.parse(calls[1].body),{p_input:input});
    const denied=await worker.fetch(budgetRequest(input),env);
    assert.equal(denied.status,403);assert.equal((await denied.text()).includes("private"),false);
    // A stale CAS base or out-of-bounds value (refused before any receipt) is a fixed reason, not "unconfirmed".
    for(const code of ["storage_owner_version_conflict","storage_budget_out_of_bounds"]){
      refusal=code;
      const refused=await worker.fetch(budgetRequest(input),env);
      assert.equal(refused.status,409);assert.equal((await refused.json()).reason,code);
    }
    refusal=null;
  } finally {globalThis.fetch=original;}
});
test("a level switch refused for an unresolved job returns the fixed busy reason (fix d9d6db4c)",async()=>{
  const original=globalThis.fetch;let refusal="storage_root_has_unresolved_mutation";
  globalThis.fetch=async(url)=>{
    if(String(url).endsWith("/auth/v1/user"))return Response.json({id:"fixture-owner"});
    return Response.json({message:refusal,code:"42501"},{status:403});
  };
  const writeRequest=body=>new Request(origin+"/v1/storage/write-access",{
    method:"POST",headers:{"content-type":"application/json",origin,authorization:"Bearer fixture-native-jwt"},body:JSON.stringify(body)});
  try {
    const input={action:"set_classes",connection_id:"20000000-0000-4000-8000-000000000001",classes:[],base_generation:1,
      disclosure_version:"clued.storage-modify-disclosure/1",idempotency_key:"fixture-key"};
    const busy=await worker.fetch(writeRequest(input),env);
    assert.equal(busy.status,409);assert.deepEqual(await busy.json(),{error:"Storage access operation unavailable.",reason:"storage_root_busy"});
    // Any other refusal stays an unconfirmed result without detail.
    refusal="storage_owner_version_conflict";
    const other=await worker.fetch(writeRequest(input),env);
    assert.equal(other.status,403);assert.equal("reason" in await other.json(),false);
  } finally {globalThis.fetch=original;}
});
