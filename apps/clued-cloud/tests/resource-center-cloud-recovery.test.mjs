import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import test from 'node:test';
import {build,stop} from 'esbuild';
import {fixture,ids} from './resource-center-cloud-executor.fixture.mjs';

const dir=await mkdtemp(path.join(os.tmpdir(),'clued-cloud-recovery-'));
async function load(name) {
  const outfile=path.join(dir,name+'.mjs');
  await build({entryPoints:[fileURLToPath(new URL('../worker/'+name+'.ts',import.meta.url))],outfile,bundle:true,platform:'node',format:'esm'});
  return import(pathToFileURL(outfile));
}
const {createStorageCloudRecovery}=await load('storage-cloud-recovery');
const {createStorageCredentialVault}=await load('storage-credential-vault');
stop();
async function setup(options={}) {
  // A synthetic prior provider effect, not a new effect by the recovery path.
  const fixtureOptions={lostFinalize:true};
  const base=fixture(fixtureOptions);
  await base.run().run(base.reference);
  fixtureOptions.redirect='manual';
  const current=base.info().currentRequest;
  const d={...await base.config.load_job(base.reference),status:'recovery_only',oauth_client_id:'test-client',
    intent_id:ids.intent,version:2,request_sha256:current.request_sha256,recovery_binding:'e'.repeat(64),
    provider_before:current.authority_request.provider_identity,
    attempt:{provider_file_id:'new-id',parent_id:'track',destination_path:current.exact_request.mutation.destination_path}};
  const vaultConfig={current_key_id:'test',keys:{test:randomBytes(32).toString('base64url')}};
  const vault=await createStorageCredentialVault(vaultConfig);
  d.credential_envelope=await vault.seal(JSON.stringify({...await base.config.get_credential(),token_type:'Bearer',...options.token}),{
    owner_id:d.owner_id,connection_id:d.connection_id,provider:'google-drive',provider_subject:d.provider_subject,
    oauth_client_id:d.oauth_client_id,credential_version:d.credential_version});
  Object.assign(d,options.descriptor);
  const calls=[],gets=[];
  const config={client_id:'test-client',vault:vaultConfig,clock:base.config.clock,timeout_ms:options.timeout??10000,
    rpc:async input=>{
      calls.push(structuredClone(input));
      assert.ok(['recovery_load','recovery_finalize'].includes(input.action),'no writer/authority/normal load RPC');
      if(input.action==='recovery_load') {
        if(options.loadError)throw Error('private-db-error');
        if(options.lateLoad)await new Promise(resolve=>setTimeout(resolve,40));
        return d;
      }
      assert.equal(input.finish.intent_id,ids.intent);assert.equal(input.finish.base_version,2);
      assert.equal(input.finish.request_sha256,current.request_sha256);assert.equal(input.credential_version,1);
      assert.equal(input.finish.postcondition.provider_file_id,'new-id');
      assert.equal(input.recovery_binding,'e'.repeat(64));
      if(options.hangFinalize)return new Promise(()=>{});
      if(options.lateFinalize)await new Promise(resolve=>setTimeout(resolve,800));
      if(options.finalizeError)throw Error('private-finalize-error');
      return {status:'committed',state:'committed',intent_id:ids.intent,receipt_id:ids.receipt,execution_permitted:false,
        private_secret:'must-not-escape',...options.result};
    },fetch:async(url,init)=>{
      gets.push(String(url));assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');
      if(options.fetchError)throw Error('private-provider-error');
      if(options.hang)return new Promise(()=>{});
      if(options.hangBody)return {status:200,ok:true,redirected:false,json:()=>new Promise(()=>{})};
      if(options.redirect)return new Response(null,{status:307,headers:{location:'https://other.invalid'}});
      if(options.onFetch)options.onFetch(d,base);
      return base.config.drive_fetch(url,init);
    }};
  return {run:await createStorageCloudRecovery(config),config,base,d,calls,gets};
}
const inspect={status:'inspection_required',execution_permitted:false};
test('dedicated recovery settles only the original metadata-verified effect, with whitelisted receipt',async()=>{
  const f=await setup(), result=await f.run.run(f.base.reference);
  assert.deepEqual(result,{status:'committed',job_id:ids.job,receipt_id:ids.receipt,execution_permitted:false});
  assert.deepEqual(f.calls.map(x=>x.action),['recovery_load','recovery_finalize']);
  assert.equal(f.base.info().posts,1);assert.equal(f.base.info().starts,1);assert.ok(f.gets.length>0);
  assert.equal(JSON.stringify(result).includes('private'),false);
});
test('missing/denied recovery never falls through to normal execution',async()=>{
  for(const options of [{loadError:true},{descriptor:{status:'queued'}},{descriptor:{status:'committed'}}]) {
    const f=await setup(options);assert.deepEqual(await f.run.run(f.base.reference),inspect);
    assert.equal(f.calls.length,1);assert.equal(f.gets.length,0);assert.equal(f.base.info().posts,1);
  }
});
test('caller cannot add credentials, roots, authority or a mutation',async()=>{
  const f=await setup();
  for(const key of ['profile','owner_id','mutation','credential','issuer','recovery_refresh']) {
    assert.deepEqual(await f.run.run({...f.base.reference,[key]:'caller'}),inspect);
  }
  assert.equal(f.calls.length,0);assert.equal(f.gets.length,0);
});
test('malformed references and synchronous adapter failures clean up without unhandled rejection',async()=>{
  const f=await setup();
  for(const reference of [null,{},[],{...f.base.reference,job_id:7},
    {get connection_id(){throw Error('invalid getter');},job_id:ids.job}]) {
    assert.deepEqual(await f.run.run(reference),inspect);
  }
  assert.equal(f.calls.length,0);
  const run=await createStorageCloudRecovery({...f.config,rpc:()=>{throw Error('synchronous private failure');}});
  assert.deepEqual(await run.run(f.base.reference),inspect);
  await new Promise(resolve=>setImmediate(resolve));
});
test('wrong owner/AAD, client, job, connection, version, attempt or digest cannot settle',async()=>{
  for(const descriptor of [{owner_id:ids.profile},{oauth_client_id:'other'}, {job_id:ids.profile},{connection_id:ids.profile},
    {credential_version:2},{version:0},{request_sha256:'bad'},{recovery_binding:null},{attempt:{provider_file_id:'other'}},{root_folder_id:'../root'}]) {
    const f=await setup({descriptor});assert.deepEqual(await f.run.run(f.base.reference),inspect);
    assert.equal(f.calls.length,1);assert.equal(f.base.info().posts,1);
  }
});
test('expired/wrong-scope/corrupt credentials require human recovery, never token POST',async()=>{
  for(const token of [{expires_at_ms:100000},{scope:'https://www.googleapis.com/auth/drive'}, {token_type:'other'}]) {
    const f=await setup({token});assert.deepEqual(await f.run.run(f.base.reference),inspect);
    assert.equal(f.calls.length,1);assert.equal(f.gets.length,0);
  }
});
test('metadata mismatch, ambiguity, redirects and upstream failures preserve inspection state',async()=>{
  for(const options of [{fetchError:true},{redirect:true},{onFetch:(_,b)=>{b.files.get('new-id').sha256Checksum='b'.repeat(64);}},
    {onFetch:(_,b)=>{b.files.set('duplicate',{...b.files.get('new-id'),id:'duplicate'});}}]) {
    const f=await setup(options);assert.deepEqual(await f.run.run(f.base.reference),inspect);assert.equal(f.calls.length,1);
    assert.equal(f.base.info().posts,1);assert.equal(f.base.info().starts,1);
  }
});
test('descriptor mutation during provider IO cannot replace the pinned finalization',async()=>{
  const f=await setup({onFetch:d=>{d.intent_id=ids.profile;d.version=99;d.credential_version=8;}});
  assert.equal((await f.run.run(f.base.reference)).status,'committed');
  assert.equal(f.calls[1].finish.intent_id,ids.intent);assert.equal(f.calls[1].credential_version,1);
});
test('lost or invalid finalization replies never retry, expose details or claim success',async()=>{
  for(const options of [{finalizeError:true},{result:{intent_id:ids.profile}},{result:{receipt_id:'bad'}},{result:{execution_permitted:true}}]) {
    const f=await setup(options);assert.deepEqual(await f.run.run(f.base.reference),inspect);
    assert.equal(f.calls.length,2);assert.equal(f.base.info().posts,1);
  }
});
test('shared deadline bounds stalled load/provider and prevents late finalization',async()=>{
  for(const options of [{lateLoad:true},{hang:true},{hangBody:true}]) {
    const f=await setup({...options,timeout:10});assert.deepEqual(await f.run.run(f.base.reference),inspect);
    await new Promise(resolve=>setTimeout(resolve,60));
    assert.equal(f.calls.length,1);assert.equal(f.base.info().posts,1);
  }
});
test('lost or late settlement remains unknown and never resends the finalization',async()=>{
  for(const options of [{hangFinalize:true},{lateFinalize:true}]) {
    const f=await setup({...options,timeout:500});assert.deepEqual(await f.run.run(f.base.reference),inspect);
    await new Promise(resolve=>setTimeout(resolve,1000));
    assert.deepEqual(f.calls.map(x=>x.action),['recovery_load','recovery_finalize']);
    assert.equal(f.base.info().posts,1);
  }
});

test('native recovery HTTP accepts only original IDs, preserves native JWT plus fixed issuer, and never dispatches',async()=>{
  const {loadContinuityWorker}=await import('./worker-continuity-loader.mjs'),worker=await loadContinuityWorker();
  const f=await setup({token:{expires_at_ms:Date.now()+3600000}}),issuer='synthetic-recovery-issuer-'.repeat(3);
  const origin='https://clued.example.invalid';
  const env={CLUED_STORAGE_ACCOUNT_V1:'true',CLUED_STORAGE_GOOGLE_V1:'true',CLUED_STORAGE_JOBS_V1:'false',CLUED_STORAGE_EXECUTOR_V1:'false',
    CLUED_STORAGE_CONNECTOR_ISSUER:issuer,CLUED_STORAGE_GOOGLE_CLIENT_ID:f.config.client_id,CLUED_STORAGE_VAULT_KEYS:JSON.stringify(f.config.vault),
    SUPABASE_URL:'https://db.example.invalid',SUPABASE_PUBLISHABLE_KEY:'fixture-public'};
  const request=(body,token='native-fixture',method='POST',site=origin)=>new Request(origin+'/v1/storage/recovery',{
    method,headers:{origin:site,'content-type':'application/json',authorization:'Bearer '+token},...(method==='POST'?{body:JSON.stringify(body)}:{})});
  const ref=f.base.reference,before=globalThis.fetch,rpcs=[];let redirect=false,inspectResult={
    ...ref,status:'started',request_digest:'a'.repeat(64),intent_id:ids.intent,receipt_id:ids.receipt,execution_permitted:false,private_secret:'must-not-escape'};
  globalThis.fetch=async(url,init)=>{
    if(String(url).endsWith('/auth/v1/user'))return Response.json({id:f.d.owner_id});
    if(String(url).startsWith(env.SUPABASE_URL)) {
      assert.equal(String(url),env.SUPABASE_URL+'/rest/v1/rpc/clued_storage_native_recovery_v1');
      assert.equal(new Headers(init.headers).get('authorization'),'Bearer native-fixture');
      assert.equal(init.redirect,'manual');assert.ok(init.signal);
      const body=JSON.parse(init.body);assert.match(body.p_issuer_hash,/^[a-f0-9]{64}$/);assert.notEqual(body.p_issuer_hash,issuer);
      rpcs.push(body.p_input);
      if(redirect)return new Response(null,{status:307,headers:{location:'https://untrusted.invalid'}});
      return Response.json(body.p_input.action==='recovery_inspect'?inspectResult:await f.config.rpc(body.p_input));
    }
    return f.config.fetch(url,init);
  };
  try {
    const input={...ref,action:'settle'};
    assert.equal((await worker.fetch(request(input),{})).status,404);
    assert.equal((await worker.fetch(request(input,'clued_bnd_'+'a'.repeat(40)),env)).status,401);
    assert.equal((await worker.fetch(request(input,'native-fixture','GET'),env)).status,405);
    assert.equal((await worker.fetch(request(input,'native-fixture','POST','https://untrusted.invalid'),env)).status,403);
    for(const extra of [{action:'submit'},{action:'recovery_load'},{action:['inspect']},{action:['settle']},{action:{}},{action:null},
      {profile:{}},{finish:{}},{credential_version:1},{owner_id:f.d.owner_id},{issuer:'caller'}])
      assert.equal((await worker.fetch(request({...input,...extra}),env)).status,403);
    assert.equal(rpcs.length,0);assert.equal(f.gets.length,0);
    const inspected=await worker.fetch(request({...ref,action:'inspect'}),{...env,CLUED_STORAGE_VAULT_KEYS:undefined});
    assert.equal(inspected.status,200);assert.equal(inspected.headers.get('cache-control'),'no-store');
    const data=await inspected.json();assert.equal(Object.keys(data).length,7);assert.equal(data.private_secret,undefined);
    assert.deepEqual(rpcs,[{...ref,action:'recovery_inspect'}]);assert.equal(f.gets.length,0);
    const settled=await worker.fetch(request(input),env);
    assert.equal(settled.status,200);assert.equal(settled.headers.get('cache-control'),'no-store');
    assert.deepEqual(await settled.json(),{status:'committed',job_id:ids.job,receipt_id:ids.receipt,execution_permitted:false});
    assert.deepEqual(rpcs.map(x=>x.action),['recovery_inspect','recovery_inspect','recovery_load','recovery_finalize']);
    assert.equal(f.base.info().posts,1);assert.equal(f.base.info().starts,1);
    inspectResult={...inspectResult,job_id:ids.profile};
    const wrong=await worker.fetch(request({...ref,action:'inspect'}),env);
    assert.equal(wrong.status,403);assert.deepEqual(await wrong.json(),inspect);
    redirect=true;const reads=f.gets.length;
    const denied=await worker.fetch(request(input),env);assert.deepEqual(await denied.json(),inspect);assert.equal(f.gets.length,reads);
  } finally {globalThis.fetch=before;}
});

test('account-policy recovery uses native Owner preflight, read-only descriptor and durable v2 settlement',async()=>{
  const {loadContinuityWorker}=await import('./worker-continuity-loader.mjs'),worker=await loadContinuityWorker();
  const f=await setup({token:{expires_at_ms:Date.now()+3600000}}),issuer='synthetic-account-recovery-issuer-'.repeat(3);
  const origin='https://clued.example.invalid',ref=f.base.reference,before=globalThis.fetch,calls=[];
  const env={CLUED_STORAGE_ACCOUNT_V1:'true',CLUED_STORAGE_GOOGLE_V1:'true',CLUED_STORAGE_JOBS_V2:'true',
    CLUED_STORAGE_EXECUTOR_V1:'false',CLUED_STORAGE_CONNECTOR_ISSUER:issuer,
    CLUED_STORAGE_GOOGLE_CLIENT_ID:f.config.client_id,CLUED_STORAGE_VAULT_KEYS:JSON.stringify(f.config.vault),
    SUPABASE_URL:'https://db.example.invalid',SUPABASE_PUBLISHABLE_KEY:'fixture-public'};
  globalThis.fetch=async(url,init)=>{
    if(String(url).endsWith('/auth/v1/user'))return Response.json({id:f.d.owner_id});
    if(String(url).startsWith(env.SUPABASE_URL)){
      assert.equal(new Headers(init.headers).get('authorization'),'Bearer native-fixture');
      assert.equal(init.redirect,'manual');assert.ok(init.signal);
      const body=JSON.parse(init.body),rpc=String(url).split('/').pop();calls.push({rpc,action:body.p_input.action});
      if(rpc==='clued_storage_native_recovery_v1'){
        assert.equal(body.p_input.action,'recovery_inspect');
        return Response.json({...ref,status:'started',request_digest:'a'.repeat(64),intent_id:ids.intent,
          receipt_id:ids.receipt,execution_permitted:false});
      }
      if(rpc==='clued_storage_native_recovery_load_v2'){
        assert.equal(body.p_issuer_secret,issuer);assert.deepEqual(body.p_input,{...ref,action:'recovery_load'});
        return Response.json(f.d);
      }
      assert.equal(rpc,'clued_storage_cloud_worker_router_v2');
      assert.match(body.p_issuer_hash,/^[a-f0-9]{64}$/);
      if(body.p_input.action==='verified_inspect')return Response.json({...ref,status:'inspection_required',execution_permitted:false});
      if(body.p_input.action==='verified_record'){
        assert.equal(body.p_input.finish.intent_id,ids.intent);
        assert.equal(body.p_input.proof.contract,'clued.storage-create-verified/2');
        return Response.json({status:'verified',intent_id:ids.intent,version:2,verified_receipt_id:ids.receipt,
          verified_digest:'f'.repeat(64),execution_permitted:false});
      }
      assert.equal(body.p_input.action,'settle_verified');
      return Response.json({status:'committed',state:'committed',intent_id:ids.intent,receipt_id:ids.receipt,
        execution_permitted:false,final_result:{status:'committed'}});
    }
    assert.equal(init.method,'GET');return f.config.fetch(url,init);
  };
  try {
    const response=await worker.fetch(new Request(origin+'/v1/storage/recovery',{method:'POST',
      headers:{origin,'content-type':'application/json',authorization:'Bearer native-fixture'},
      body:JSON.stringify({...ref,action:'settle'})}),env);
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{status:'committed',job_id:ids.job,receipt_id:ids.receipt,execution_permitted:false});
    assert.deepEqual(calls.map(x=>x.action),['recovery_inspect','verified_inspect','recovery_load','verified_record','settle_verified']);
    assert.equal(f.base.info().posts,1);assert.equal(f.base.info().starts,1);
  } finally {globalThis.fetch=before;}
});
