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
    intent_id:ids.intent,version:2,request_sha256:current.request_sha256,
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
      if(options.hangFinalize)return new Promise(()=>{});
      if(options.lateFinalize)await new Promise(resolve=>setTimeout(resolve,80));
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
    {credential_version:2},{version:0},{request_sha256:'bad'},{attempt:{provider_file_id:'other'}},{root_folder_id:'../root'}]) {
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
    const f=await setup({...options,timeout:50});assert.deepEqual(await f.run.run(f.base.reference),inspect);
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.deepEqual(f.calls.map(x=>x.action),['recovery_load','recovery_finalize']);
    assert.equal(f.base.info().posts,1);
  }
});
