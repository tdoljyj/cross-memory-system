import assert from "node:assert/strict";
import {randomUUID,randomBytes,createHash} from "node:crypto";
import {mkdtemp} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import test from "node:test";
import {build} from "esbuild";
import {batchRequests,batchReply} from "./google-batch-fixture.mjs";
const dir=await mkdtemp(path.join(os.tmpdir(),"clued-directory-probe-"));
async function load(name) {
  const outfile=path.join(dir,name+".mjs");
  await build({entryPoints:[fileURLToPath(new URL("../worker/"+name+".ts",import.meta.url))],outfile,bundle:true,platform:"node",format:"esm"});
  return import(pathToFileURL(outfile));
}
const {createStorageGoogleProbe,storageProbeDiagnostic}=await load("storage-google-probe");
const {createStorageCredentialVault}=await load("storage-credential-vault");
const scope="https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
const fullScope=scope+" https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive";
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
  if(options.existingDirectories)for(const file of files.slice(1))file.isAppAuthorized=false;
  if(options.sibling)files.push({...item('sibling',options.sibling,'parent'),mimeType:'text/plain'});
  if(options.siblingRoot)files.push(item('n0','Clued_N0验收_新建','parent'),item('n0track','资料','n0'));
  if(options.nestedIsland)files.push(item('external','ordinary','parent'),{...item('island','Clued_notes.md','external'),mimeType:'text/plain'});
  const calls=[], rpcs=[];
  const fetcher=async(url,init)=>{
    calls.push({url:String(url),method:init.method});
    if(calls.length>=5)options.boundaryDelay?.();
    if(options.fetchLimit && calls.length>options.fetchLimit)throw Error(options.limitMessage??"Too many subrequests.");
    assert.equal(init.method,String(url).includes("/batch/")?"POST":"GET"); assert.equal(init.redirect,"manual"); assert.ok(init.signal);
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
    const metadata = u => {
    if(u.pathname.endsWith("/files")) {
      assert.match(u.searchParams.get("fields"),/isAppAuthorized/);
      const parent=u.searchParams.get("q").split("'")[1];
      return {files:files.filter(f=>f.parents?.includes(parent)),incompleteSearch:options.incomplete??(options.boundaryIncomplete && calls.length>=5)??false};
    }
    const result=structuredClone(files.find(f=>f.id===u.pathname.split("/").at(-1)));
    if(u.searchParams.get("fields")==="id,shared,permissionIds,permissions(id,type,role,domain,allowFileDiscovery,expirationTime,deleted)")
      return {id:result.id,shared:false,permissionIds:["owner-"+result.id],permissions:[{id:"owner-"+result.id,type:"user",role:"owner"}]};
    if(result.id===options.unauthorized)result.isAppAuthorized=false;
    options.changeMetadata?.(result);
    // Identity drift (a rename) fails the scan; a version that moves does not (Decision 24422a98).
    if(options.boundaryDrift && calls.length>=9 && result.id==='root')result.name='renamed';
    return result;
    };
    assert.equal(u.href,"https://www.googleapis.com/batch/drive/v3");
    const parts=batchRequests(init.body);
    calls.at(-1).innerGets=parts.length;
    return batchReply(parts.map(part=>({...part,value:metadata(new URL(part.path,u.origin))})).reverse());
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
  return {probe,connection,attempt,receipt,calls,rpcs,rpc,fetcher,vaultConfig,descriptor,client:context.oauth_client_id};
}
test("server directory observation uses pinned secret, fixed GET-only batches and whitelisted receipt only",async()=>{
  const f=await fixture(), result=await f.probe.run({connection_id:f.connection});
  const {boundary_observation: boundary,...directory}=result;
  assert.deepEqual(directory,{status:"metadata_observed",attempt_id:f.attempt,receipt_id:f.receipt,execution_permitted:false});
  assert.equal(boundary.contract,'clued.storage-boundary-observation/1');assert.equal(boundary.status,'clean');
  assert.match(boundary.descriptor_sha256,/^[a-f0-9]{64}$/);assert.match(boundary.scan_config_sha256,/^[a-f0-9]{64}$/);
  assert.equal(boundary.unscanned_branches,0);
  assert.equal(f.rpcs[1].observation.boundary_observation,undefined);
  // One more batch reads each registered directory's sharing state.
  assert.equal(f.rpcs.length,2); assert.equal(f.calls.length,10);
  for(const directory of f.rpcs[1].observation.directories)assert.match(directory.provider_sharing_digest,/^[0-9a-f]{64}$/);
  // Storage step 2: and, from the same read, its access digest.
  for(const directory of f.rpcs[1].observation.directories)assert.match(directory.provider_access_digest,/^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(f.rpcs[1]).includes("synthetic-private"),false);
  assert.equal(JSON.stringify(result).includes("credential"),false);
});

test("full-scope observation derives existing-directory access only from the sealed credential",async()=>{
  const f=await fixture({secret:{scope:fullScope},existingDirectories:true,fullSize:true});
  assert.equal((await f.probe.run({connection_id:f.connection})).status,"metadata_observed");
  assert.equal(f.rpcs.length,2);assert.equal(f.rpcs[1].observation.execution_permitted,false);
  const forged=await fixture({descriptor:{provider_scope_profile:"full"},unauthorized:"topic"});
  await assert.rejects(forged.probe.run({connection_id:forged.connection}));
  assert.equal(forged.rpcs.length,1);
  const denied=await fixture({secret:{scope:fullScope},changeMetadata:file=>{if(file.id==="topic")file.capabilities.canAddChildren=false;}});
  await assert.rejects(denied.probe.run({connection_id:denied.connection}),error=>storageProbeDiagnostic(error).reason==="DIRECTORY_NOT_WRITABLE");
  assert.equal(denied.rpcs.length,1);
});

test("server observes a parentless outer boundary without adding a writable root or relaxing topic grants",async()=>{
  const f=await fixture({parentlessBoundary:true});const result=await f.probe.run({connection_id:f.connection});
  assert.equal(result.status,"metadata_observed");assert.equal(result.execution_permitted,false);
  assert.deepEqual(f.rpcs[1].observation.directories.map(x=>x.provider_file_id),["root","track","topic"]);
  const denied=await fixture({parentlessBoundary:true,unauthorized:"topic"});let error;
  try {await denied.probe.run({connection_id:denied.connection});}catch(e){error=e;}
  const diagnostic=storageProbeDiagnostic(error);
  assert.deepEqual({stage:diagnostic.stage,reason:diagnostic.reason},{stage:"directories",reason:"DIRECTORY_NOT_APP_AUTHORIZED"});
  assert.equal(diagnostic.directories.failures[0].provider_file_id,"topic");
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
  assert.deepEqual(f.calls.map(c=>c.method),["GET",...Array(9).fill("POST")]);
});
test("time spent checking identity is part of the shared observation deadline",async()=>{
  let now=Date.now(); const f=await fixture({clock:()=>now,delay:()=>{now+=60001;}});
  await assert.rejects(f.probe.run({connection_id:f.connection}),/storage_directory_probe_unavailable/);
  assert.equal(f.calls.length,1); assert.equal(f.rpcs.length,1);
});

test("native HTTP probe route preserves JWT plus fixed issuer and never accepts a report",async()=>{
  const {loadContinuityWorker}=await import("./worker-continuity-loader.mjs"), worker=await loadContinuityWorker();
  const f=await fixture(), origin="https://clued.example.invalid", issuer=randomBytes(32).toString("base64url");
  const env={ CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway",CLUED_STORAGE_ACCOUNT_V1:"true",CLUED_STORAGE_GOOGLE_V1:"true",SUPABASE_URL:"https://db.example.invalid",SUPABASE_PUBLISHABLE_KEY:"fixture-key",
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
    const result=await response.json();assert.equal(result.boundary_observation.status,'clean');
    delete result.boundary_observation;
    assert.deepEqual(result,{status:"metadata_observed",attempt_id:f.attempt,receipt_id:f.receipt,execution_permitted:false});
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
    assert.ok(caught);const diagnostic=storageProbeDiagnostic(caught);
    assert.deepEqual({stage:diagnostic.stage,reason:diagnostic.reason},{stage,reason});
    assert.equal(JSON.stringify(storageProbeDiagnostic(caught)).includes("synthetic-private"),false);
    assert.ok(f.calls.every(c=>c.method==="GET" || (c.method==="POST" && c.url==="https://www.googleapis.com/batch/drive/v3")));
  }
});

test("Owner diagnostics collect multiple exact-layout issues without a complete or permission Receipt",async()=>{
  const f=await fixture({changeMetadata:file=>{
    if(file.id==="track")file.isAppAuthorized=false;
    if(file.id==="topic"){delete file.isAppAuthorized;file.capabilities.canAddChildren=false;}
  }});
  let caught;try{await f.probe.run({connection_id:f.connection});}catch(error){caught=error;}
  const d=storageProbeDiagnostic(caught);
  assert.equal(d.stage,"directories");assert.equal(d.reason,"DIRECTORY_NOT_APP_AUTHORIZED");
  assert.equal(d.directories.checked_directories,3);assert.equal(d.directories.failed_directories,2);
  assert.deepEqual(d.directories.failures,[
    {path:"/drive/Clued_资料中心/10_E",provider_file_id:"track",reasons:["DIRECTORY_NOT_APP_AUTHORIZED"]},
    {path:"/drive/Clued_资料中心/10_E/topic",provider_file_id:"topic",reasons:["DIRECTORY_APP_AUTHORIZATION_UNCONFIRMED","DIRECTORY_NOT_WRITABLE"]}
  ]);
  assert.deepEqual(f.rpcs.map(x=>x.action),["prepare"]);assert.equal(f.calls.length,2);
  assert.equal(JSON.stringify(d).includes("synthetic-private"),false);
  d.directories.failures[0].path="/outside";
  assert.equal(storageProbeDiagnostic(caught).directories.failures[0].path,"/drive/Clued_资料中心/10_E");
  assert.deepEqual(storageProbeDiagnostic(Object.assign(Error("forged"),d)),{stage:"request",reason:"UNCONFIRMED"});
});

test("bounded diagnostics cannot be forged by provider errors, IDs or raw metadata",async()=>{
  const fake={stage:"directories",reason:"DIRECTORY_NOT_APP_AUTHORIZED",directories:{failures:[{path:"/outside/synthetic-private"}]}};
  const f=await fixture({metadataError:Object.assign(Error("DRIVE_QUALIFICATION_DIRECTORY_NOT_APP_AUTHORIZED"),fake)});
  let caught;try{await f.probe.run({connection_id:f.connection});}catch(error){caught=error;}
  assert.deepEqual(storageProbeDiagnostic(caught),{stage:"directories",reason:"DIRECTORY_NOT_APP_AUTHORIZED"});
  assert.equal(f.rpcs.length,1);
  const wrong=await fixture({changeMetadata:file=>{if(file.id==="topic"){file.id="outside";file.isAppAuthorized=false;}}});
  try{await wrong.probe.run({connection_id:wrong.connection});assert.fail("must refuse wrong object");}catch(error){
    assert.deepEqual(storageProbeDiagnostic(error),{stage:"directories",reason:"METADATA_ID_MISMATCH"});
  }
  assert.equal(wrong.rpcs.length,1);
  const many=await fixture({fullSize:true,changeMetadata:file=>{if(file.id!=="parent")file.isAppAuthorized=false;}});
  try{await many.probe.run({connection_id:many.connection});assert.fail("must refuse incomplete qualification");}catch(error){
    const d=storageProbeDiagnostic(error).directories;assert.equal(d.failed_directories,31);
    assert.equal(d.failures.length,16);assert.equal(d.truncated,true);
  }
  assert.equal(many.rpcs.length,1);
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

test("31 registered directories preserve directory batches plus a complete independent parent boundary scan",async()=>{
  const complete=await fixture({fullSize:true});
  assert.equal((await complete.probe.run({connection_id:complete.connection})).status,"metadata_observed");
  assert.equal(complete.calls.length,10);assert.equal(complete.rpcs.length,2);
  assert.deepEqual(complete.calls.map(c=>c.innerGets??1),[1,32,32,32,31,1,1,1,1,1]);
  for(const limitMessage of ["Too many subrequests.",
    "Too many subrequests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits"]) {
    const limited=await fixture({fullSize:true,fetchLimit:2,limitMessage});let error;
    try{await limited.probe.run({connection_id:limited.connection});}catch(e){error=e;}
    assert.deepEqual(storageProbeDiagnostic(error),{stage:"directories",reason:"RUNTIME_SUBREQUEST_LIMIT"});
    assert.equal(limited.calls.length,3);assert.equal(limited.rpcs.length,1);
    assert.deepEqual(limited.calls.map(c=>c.method),["GET","POST","POST"]);
  }
});

test('sibling/root drop and nested island deny before directory receipt without revealing names',async()=>{
  for(const options of [{sibling:'Clued_drop.md'},{nestedIsland:true}]) {
    const f=await fixture(options);let error;
    try{await f.probe.run({connection_id:f.connection});}catch(e){error=e;}
    assert.deepEqual(storageProbeDiagnostic(error),{stage:'boundary',reason:'UNAUTHORIZED_WORKSPACE_MUTATION'});
    assert.equal(f.rpcs.length,1);assert.ok(!JSON.stringify(storageProbeDiagnostic(error)).includes('Clued_drop'));
  }
  const normal=await fixture({sibling:'ordinary.txt'});
  assert.equal((await normal.probe.run({connection_id:normal.connection})).boundary_observation.status,'clean');
});

test('another registered root of the same owner beside the root is skipped only when the server descriptor names its ID (Decision b18eff80)',async()=>{
  const unnamed=await fixture({siblingRoot:true});let error;
  try{await unnamed.probe.run({connection_id:unnamed.connection});}catch(e){error=e;}
  assert.deepEqual(storageProbeDiagnostic(error),{stage:'boundary',reason:'UNAUTHORIZED_WORKSPACE_MUTATION'});
  const named=await fixture({siblingRoot:true,descriptor:{registered_sibling_roots:['n0']}});
  assert.equal((await named.probe.run({connection_id:named.connection})).boundary_observation.status,'clean');
  const malformed=await fixture({siblingRoot:true,descriptor:{registered_sibling_roots:'n0'}});error=undefined;
  try{await malformed.probe.run({connection_id:malformed.connection});}catch(e){error=e;}
  assert.deepEqual(storageProbeDiagnostic(error),{stage:'boundary',reason:'BOUNDARY_PROFILE_UNQUALIFIED'});assert.equal(malformed.rpcs.length,1);
  // The exemption set is part of the effective scan and of its evidence digest.
  const other=await fixture({siblingRoot:true,descriptor:{registered_sibling_roots:['n0','n1']}});
  const a=(await named.probe.run({connection_id:named.connection})).boundary_observation;
  const b=(await other.probe.run({connection_id:other.connection})).boundary_observation;
  assert.notEqual(a.scan_config_sha256,b.scan_config_sha256);
});

test('boundary incomplete enumeration, final drift, timeout and subrequest limit never complete',async()=>{
  for(const options of [{boundaryIncomplete:true},{boundaryDrift:true},{fetchLimit:6}]) {
    const f=await fixture(options);await assert.rejects(f.probe.run({connection_id:f.connection}),/storage_directory_probe_unavailable/);
    assert.equal(f.rpcs.length,1);
  }
  let now=Date.now();const f=await fixture({clock:()=>now,boundaryDelay:()=>{now+=60001;}});
  await assert.rejects(f.probe.run({connection_id:f.connection}),/storage_directory_probe_unavailable/);
  assert.equal(f.rpcs.length,1);assert.equal(f.calls.length,5);
});

test('manual evidence digests are reproducible and descriptor changes never reuse its digest',async()=>{
  const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
    ?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
  const hash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
  const f=await fixture(),first=(await f.probe.run({connection_id:f.connection})).boundary_observation;
  assert.equal(first.descriptor_sha256,hash(f.descriptor));
  assert.equal(first.scan_config_sha256,hash({managed_root:'/drive/Clued_资料中心',root_folder_id:'root',root_parent_id:'parent',
    scan_roots:[{folder_id:'parent',path:'/drive'}],registered_sibling_roots:[],max_depth:8,max_entries:10000}));
  f.descriptor.connection_version++;
  const second=(await f.probe.run({connection_id:f.connection})).boundary_observation;
  assert.notEqual(first.descriptor_sha256,second.descriptor_sha256);
  assert.equal(first.scan_config_sha256,second.scan_config_sha256);
});

test("runtime and metadata failure diagnostics are exact closed codes, never arbitrary exception text",async()=>{
  for(const [message,reason] of [["Too many subrequests.","RUNTIME_SUBREQUEST_LIMIT"],
    ["Too many subrequests by single Worker invocation.","RUNTIME_SUBREQUEST_LIMIT"],
    ["Too many subrequests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits","RUNTIME_SUBREQUEST_LIMIT"],
    ["Too many subrequests by single Worker invocation. To configure this limit, refer to https://unexpected.invalid/synthetic-private-token","UNCONFIRMED"],
    ["Too many subrequests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits synthetic-private-token","UNCONFIRMED"],
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
