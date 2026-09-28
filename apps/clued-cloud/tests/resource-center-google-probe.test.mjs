import assert from "node:assert/strict";
import {randomUUID,randomBytes} from "node:crypto";
import {mkdtemp} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import test from "node:test";
import {build} from "esbuild";
const dir=await mkdtemp(path.join(os.tmpdir(),"clued-directory-probe-"));
async function load(name) {
  const outfile=path.join(dir,name+".mjs");
  await build({entryPoints:[fileURLToPath(new URL("../worker/"+name+".ts",import.meta.url))],outfile,bundle:true,platform:"node",format:"esm"});
  return import(pathToFileURL(outfile));
}
const {createStorageGoogleProbe,storageProbeDiagnostic}=await load("storage-google-probe");
const {createStorageCredentialVault}=await load("storage-credential-vault");
const scope="https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
async function fixture(options={}) {
  const root="/drive/Clued_资料中心", connection=randomUUID(), attempt=randomUUID(), receipt=randomUUID();
  const vaultConfig={current_key_id:"k1",keys:{k1:randomBytes(32).toString("base64url")}};
  const vault=await createStorageCredentialVault(vaultConfig);
  const context={owner_id:randomUUID(),connection_id:connection,provider:"google-drive",provider_subject:"probe-user",oauth_client_id:"probe.apps.googleusercontent.com",credential_version:1};
  const descriptor={...context,connection_version:1,layout:{contract:"clued.storage-directory-layout/1",managed_root:root,root_folder_id:"root",root_parent_id:"parent",allowed_root_children:["10_E"],
    directories:[{path:root,provider_file_id:"root"},{path:root+"/10_E",provider_file_id:"track"},{path:root+"/10_E/topic",provider_file_id:"topic"}]},...options.descriptor};
  const envelope=await vault.seal(JSON.stringify({access_token:"synthetic-private-access",refresh_token:"synthetic-private-refresh",token_type:"Bearer",scope,expires_at_ms:Date.now()+3600000,...options.secret}),context);
  const item=(id,name,parent)=>({id,name,parents:parent?[parent]:[],mimeType:"application/vnd.google-apps.folder",version:"1",trashed:false,isAppAuthorized:true,capabilities:{canAddChildren:true}});
  const files=[item("parent","drive"),item("root","Clued_资料中心","parent"),item("track","10_E","root"),item("topic","topic","track")];
  if(options.fullSize) {
    descriptor.layout.allowed_root_children=Array.from({length:5},(_,i)=>`track${i}`);
    descriptor.layout.directories=[{path:root,provider_file_id:"root"}];
    files.splice(2);
    for(let i=0;i<5;i++) {
      files.push(item(`track${i}`,`track${i}`,"root"));
      descriptor.layout.directories.push({path:root+`/track${i}`,provider_file_id:`track${i}`});
      for(let j=0;j<5;j++) {
        files.push(item(`topic${i}_${j}`,`topic${j}`,`track${i}`));
        descriptor.layout.directories.push({path:root+`/track${i}/topic${j}`,provider_file_id:`topic${i}_${j}`});
      }
    }
  }
  if(options.parentlessBoundary)delete files[0].parents;
  const calls=[], rpcs=[];
  const fetcher=async(url,init)=>{
    calls.push({url:String(url),method:init.method});
    if(options.fetchLimit && calls.length>options.fetchLimit)throw Error("Too many subrequests.");
    assert.equal(init.method,"GET"); assert.equal(init.redirect,"manual"); assert.ok(init.signal);
    assert.equal(new Headers(init.headers).get("authorization"),"Bearer synthetic-private-access");
    const u=new URL(url); assert.equal(u.origin,"https://www.googleapis.com"); assert.equal(u.searchParams.has("alt"),false);
    if(options.networkError)throw Error("synthetic-private-upstream");
    if(options.redirect)return new Response(null,{status:302,headers:{location:"https://unexpected.invalid"}});
    if(options.delay)options.delay();
    if(u.pathname.endsWith("/about"))return Response.json({user:{me:true,permissionId:options.subject??"probe-user"}});
    if(options.metadataStatus)return new Response("synthetic-private-provider-body",{status:options.metadataStatus,headers:{"x-private":"synthetic-private-header"}});
    if(options.metadataNetworkError)throw new Error("synthetic-private-network-failure");
    if(options.metadataError)throw options.metadataError;
    if(options.invalidJson)return new Response("synthetic-private-invalid-json");
    if(options.metadataTimeout) await new Promise((_,reject)=>{
      if(init.signal.aborted)reject(init.signal.reason);
      else init.signal.addEventListener("abort",()=>reject(init.signal.reason),{once:true});
    });
    if(u.pathname.endsWith("/files")) {
      assert.match(u.searchParams.get("fields"),/isAppAuthorized/);
      const parent=u.searchParams.get("q").split("'")[1];
      return Response.json({files:files.filter(f=>f.parents?.includes(parent)),incompleteSearch:options.incomplete??false});
    }
    const result=structuredClone(files.find(f=>f.id===u.pathname.split("/").at(-1)));
    if(result.id===options.unauthorized)result.isAppAuthorized=false;
    return Response.json(result);
  };
  const rpc=async input=>{
    rpcs.push(input);
    if(input.action==="prepare") {
      assert.deepEqual(input,{action:"prepare",connection_id:connection});
      if(options.prepareError)throw Error("synthetic-private-db");
      return {status:"prepared",attempt_id:attempt,descriptor,credential_envelope:envelope,expires_at:new Date(Date.now()+90000).toISOString()};
    }
    assert.deepEqual(Object.keys(input).sort(),["action","attempt_id","observation"]);
    assert.equal(input.attempt_id,attempt); assert.equal(input.observation.directories.length,options.fullSize?31:3);
    if(options.commitError)throw Error("synthetic-private-stale");
    return {status:"metadata_observed",attempt_id:attempt,receipt_id:receipt,execution_permitted:false,credential_envelope:envelope};
  };
  const probe=await createStorageGoogleProbe({client_id:context.oauth_client_id,vault:vaultConfig,rpc,fetch:fetcher,clock:options.clock});
  return {probe,connection,attempt,receipt,calls,rpcs,rpc,fetcher,vaultConfig,client:context.oauth_client_id};
}
test("server directory observation uses pinned secret, fixed GETs and whitelisted receipt only",async()=>{
  const f=await fixture(), result=await f.probe.run({connection_id:f.connection});
  assert.deepEqual(result,{status:"metadata_observed",attempt_id:f.attempt,receipt_id:f.receipt,execution_permitted:false});
  assert.equal(f.rpcs.length,2); assert.ok(f.calls.length>8);
  assert.equal(JSON.stringify(f.rpcs[1]).includes("synthetic-private"),false);
  assert.equal(JSON.stringify(result).includes("credential"),false);
});

test("server observes a parentless outer boundary without adding a writable root or relaxing topic grants",async()=>{
  const f=await fixture({parentlessBoundary:true});const result=await f.probe.run({connection_id:f.connection});
  assert.equal(result.status,"metadata_observed");assert.equal(result.execution_permitted,false);
  assert.deepEqual(f.rpcs[1].observation.directories.map(x=>x.provider_file_id),["root","track","topic"]);
  const denied=await fixture({parentlessBoundary:true,unauthorized:"topic"});let error;
  try {await denied.probe.run({connection_id:denied.connection});}catch(e){error=e;}
  assert.deepEqual(storageProbeDiagnostic(error),{stage:"directories",reason:"DIRECTORY_NOT_APP_AUTHORIZED"});
  assert.equal(denied.rpcs.length,1);
});
test("no caller profile, root, credential, owner, report or issuer reaches private RPC",async()=>{
  const f=await fixture();
  for(const extra of [{profile_id:randomUUID()},{managed_root:"/caller"},{owner_id:randomUUID()},{observation:{}},{credential:{}},{issuer:"caller"}])
    await assert.rejects(f.probe.run({connection_id:f.connection,...extra}),/^Error: storage_directory_probe_unavailable$/);
  assert.equal(f.rpcs.length,0); assert.equal(f.calls.length,0);
});
test("profile/AAD/client/scope/expiry mismatch cannot read Google or refresh tokens",async()=>{
  for(const options of [{descriptor:{owner_id:randomUUID()}},{descriptor:{oauth_client_id:"other-client"}},
    {descriptor:{credential_version:2}},{secret:{scope:scope+" https://www.googleapis.com/auth/drive"}},
    {secret:{expires_at_ms:Date.now()+10000}},{prepareError:true}]) {
    const f=await fixture(options); await assert.rejects(f.probe.run({connection_id:f.connection}),/storage_directory_probe_unavailable/);
    assert.equal(f.calls.length,0);assert.equal(f.rpcs.length,1);
  }
});
test("subject, topic application grant, incomplete namespace and redirect failures cannot commit",async()=>{
  for(const options of [{subject:"someone-else"},{unauthorized:"topic"},{incomplete:true},{redirect:true},{networkError:true}]) {
    const f=await fixture(options);await assert.rejects(f.probe.run({connection_id:f.connection}),/^Error: storage_directory_probe_unavailable$/);
    assert.equal(f.rpcs.length,1);assert.ok(f.calls.length>0);
  }
});
test("post-read CAS rejection has no refresh, activation, retry or success response",async()=>{
  const f=await fixture({commitError:true});await assert.rejects(f.probe.run({connection_id:f.connection}),/^Error: storage_directory_probe_unavailable$/);
  assert.deepEqual(f.rpcs.map(r=>r.action),["prepare","complete"]);
  assert.ok(f.calls.every(c=>c.method==="GET"));
});
test("time spent checking identity is part of the shared observation deadline",async()=>{
  let now=Date.now(); const f=await fixture({clock:()=>now,delay:()=>{now+=60001;}});
  await assert.rejects(f.probe.run({connection_id:f.connection}),/storage_directory_probe_unavailable/);
  assert.equal(f.calls.length,1); assert.equal(f.rpcs.length,1);
});

test("native HTTP probe route preserves JWT plus fixed issuer and never accepts a report",async()=>{
  const {loadContinuityWorker}=await import("./worker-continuity-loader.mjs"), worker=await loadContinuityWorker();
  const f=await fixture(), origin="https://clued.example.invalid", issuer=randomBytes(32).toString("base64url");
  const env={CLUED_STORAGE_ACCOUNT_V1:"true",CLUED_STORAGE_GOOGLE_V1:"true",SUPABASE_URL:"https://db.example.invalid",SUPABASE_PUBLISHABLE_KEY:"fixture-key",
    CLUED_STORAGE_GOOGLE_CLIENT_ID:f.client,CLUED_STORAGE_CONNECTOR_ISSUER:issuer,CLUED_STORAGE_VAULT_KEYS:JSON.stringify(f.vaultConfig)};
  const request=(body,token="native-fixture")=>new Request(origin+"/v1/storage/google/probe",{method:"POST",headers:{origin,"content-type":"application/json",authorization:"Bearer "+token},body:JSON.stringify(body)});
  const original=globalThis.fetch; let redirect=false;
  globalThis.fetch=async(url,init)=>{
    if(String(url).endsWith("/auth/v1/user"))return Response.json({id:randomUUID()});
    if(String(url).includes("db.example.invalid")) {
      assert.equal(String(url),env.SUPABASE_URL+"/rest/v1/rpc/clued_storage_directory_probe_v1");
      assert.equal(new Headers(init.headers).get("authorization"),"Bearer native-fixture");
      const body=JSON.parse(init.body);assert.match(body.p_issuer_hash,/^[a-f0-9]{64}$/);assert.notEqual(body.p_issuer_hash,issuer);
      assert.equal(init.redirect,"manual"); assert.ok(init.signal);
      if(redirect)return new Response(null,{status:307,headers:{location:"https://untrusted.invalid"}});
      return Response.json(await f.rpc(body.p_input));
    }
    return f.fetcher(url,init);
  };
  try {
    assert.equal((await worker.fetch(request({connection_id:f.connection}),{})).status,404);
    assert.equal((await worker.fetch(request({connection_id:f.connection},"clued_bnd_"+"a".repeat(64)),env)).status,401);
    assert.equal((await worker.fetch(request({connection_id:f.connection,observation:{}}),env)).status,403);
    assert.equal(f.rpcs.length,0);
    const response=await worker.fetch(request({connection_id:f.connection}),env);
    assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");
    assert.deepEqual(await response.json(),{status:"metadata_observed",attempt_id:f.attempt,receipt_id:f.receipt,execution_permitted:false});
    redirect=true;const before=f.calls.length;
    const denied=await worker.fetch(request({connection_id:f.connection}),env);
    assert.equal(denied.status,403);assert.equal(f.calls.length,before);
    assert.deepEqual(await denied.json(),{error:"Storage directory observation unavailable.",execution_permitted:false,diagnostic:{stage:"prepare",reason:"UNCONFIRMED"}});
  } finally {globalThis.fetch=original;}
});

test("diagnostics reveal only fixed stage/reason, never upstream secrets or caller error fields",async()=>{
  assert.deepEqual(storageProbeDiagnostic({stage:"credential",reason:"synthetic-private-token"}),{stage:"request",reason:"UNCONFIRMED"});
  for(const [options,stage,reason] of [[{prepareError:true},"prepare","UNCONFIRMED"],
    [{secret:{expires_at_ms:0}},"credential","UNCONFIRMED"],[{networkError:true},"identity","UNCONFIRMED"],
    [{unauthorized:"topic"},"directories","DIRECTORY_NOT_APP_AUTHORIZED"],[{metadataNetworkError:true},"directories","UNCONFIRMED"],
    [{commitError:true},"receipt","UNCONFIRMED"]]) {
    const f=await fixture(options);let caught;
    try {await f.probe.run({connection_id:f.connection});}catch(error){caught=error;}
    assert.ok(caught);assert.deepEqual(storageProbeDiagnostic(caught),{stage,reason});
    assert.equal(JSON.stringify(storageProbeDiagnostic(caught)).includes("synthetic-private"),false);
    assert.ok(f.calls.every(c=>c.method==="GET"));
  }
});

test("provider HTTP diagnostics expose only a closed numeric-status classification without retry",async()=>{
  for(const [status,reason] of [[401,"PROVIDER_AUTHENTICATION_REJECTED"],[403,"PROVIDER_ACCESS_REJECTED"],
    [404,"PROVIDER_OBJECT_UNAVAILABLE"],[429,"PROVIDER_RATE_LIMITED"],[500,"PROVIDER_SERVER_UNAVAILABLE"],
    [400,"PROVIDER_RESPONSE_REJECTED"]]) {
    const f=await fixture({metadataStatus:status});let caught;
    try {await f.probe.run({connection_id:f.connection});}catch(error){caught=error;}
    assert.deepEqual(storageProbeDiagnostic(caught),{stage:"directories",reason});
    assert.equal(f.calls.length,2);assert.equal(f.rpcs.length,1);
    assert.equal(JSON.stringify(storageProbeDiagnostic(caught)).includes("synthetic-private"),false);
  }
});

test("actual per-request timeout is classified using the private abort signal and never retried",async()=>{
  const f=await fixture({metadataTimeout:true});let caught;
  try {await f.probe.run({connection_id:f.connection});}catch(error){caught=error;}
  assert.deepEqual(storageProbeDiagnostic(caught),{stage:"directories",reason:"PROVIDER_TIMEOUT"});
  assert.equal(f.calls.length,2);assert.equal(f.rpcs.length,1);
});

test("31 registered directories require 97 GETs; a runtime request limit denies without skipping checks or retry",async()=>{
  const complete=await fixture({fullSize:true});
  assert.equal((await complete.probe.run({connection_id:complete.connection})).status,"metadata_observed");
  assert.equal(complete.calls.length,97);assert.equal(complete.rpcs.length,2);
  const limited=await fixture({fullSize:true,fetchLimit:50});let error;
  try{await limited.probe.run({connection_id:limited.connection});}catch(e){error=e;}
  assert.deepEqual(storageProbeDiagnostic(error),{stage:"directories",reason:"RUNTIME_SUBREQUEST_LIMIT"});
  assert.equal(limited.calls.length,51);assert.equal(limited.rpcs.length,1);
  assert.ok(limited.calls.every(c=>c.method==="GET"));
});

test("runtime and metadata failure diagnostics are exact closed codes, never arbitrary exception text",async()=>{
  for(const [message,reason] of [["Too many subrequests.","RUNTIME_SUBREQUEST_LIMIT"],
    ["Too many subrequests by single Worker invocation.","RUNTIME_SUBREQUEST_LIMIT"],
    ["Too many subrequests. synthetic-private-token","UNCONFIRMED"],
    ["storage_redirect_rejected","PROVIDER_REDIRECT_REJECTED"],
    ["DRIVE_METADATA_MISMATCH","METADATA_ID_MISMATCH"],["DRIVE_LIST_INVALID","ENUMERATION_INVALID"],
    ["DRIVE_PAGINATION_INVALID","PAGINATION_INVALID"],["DRIVE_PAGINATION_LIMIT","PAGINATION_LIMIT"],
    ["DRIVE_ENUMERATION_LIMIT","ENTRY_LIMIT"],["DRIVE_NAMESPACE_VISIBILITY_UNPROVEN","NAMESPACE_VISIBILITY_UNPROVEN"]]) {
    const f=await fixture({metadataError:new Error(message)});let error;
    try{await f.probe.run({connection_id:f.connection});}catch(e){error=e;}
    assert.deepEqual(storageProbeDiagnostic(error),{stage:"directories",reason});
    assert.equal(f.calls.length,2);assert.equal(f.rpcs.length,1);
    assert.equal(JSON.stringify(storageProbeDiagnostic(error)).includes("synthetic-private"),false);
  }
  const invalid=await fixture({invalidJson:true});let error;
  try{await invalid.probe.run({connection_id:invalid.connection});}catch(e){error=e;}
  assert.deepEqual(storageProbeDiagnostic(error),{stage:"directories",reason:"PROVIDER_RESPONSE_INVALID"});
  assert.equal(invalid.calls.length,2);assert.equal(invalid.rpcs.length,1);
});
