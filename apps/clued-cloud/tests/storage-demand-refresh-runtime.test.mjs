import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const dir=await mkdtemp(path.join(os.tmpdir(),'clued-demand-runtime-'));
async function load(name){const outfile=path.join(dir,name+'.mjs');await build({entryPoints:[fileURLToPath(new URL('../worker/'+name+'.ts',import.meta.url))],
  outfile,bundle:true,platform:'node',format:'esm'});return import(pathToFileURL(outfile));}
const {createStorageDemandRuntime,runStorageDemandRenewalScheduled}=await load('storage-demand-runtime');
const {createStorageCredentialVault}=await load('storage-credential-vault');
test.after(()=>rm(dir,{recursive:true,force:true}));
const now=1700000000000,scope='https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly';
async function fixture(ttl=3600000){
  const ctx={owner_id:randomUUID(),connection_id:randomUUID(),provider:'google-drive',provider_subject:'subject',oauth_client_id:'runtime-client'};
  const vault={current_key_id:'test',keys:{test:randomBytes(32).toString('base64url')}},sealed=await createStorageCredentialVault(vault);
  let version=1,envelope=await sealed.seal(JSON.stringify({access_token:'synthetic-access-token',refresh_token:'synthetic-refresh-token',token_type:'Bearer',
    scope,expires_at_ms:now+ttl}),{...ctx,credential_version:1});
  const requests=[],native=[],provider=[];
  const config={client_id:ctx.oauth_client_id,client_secret:'synthetic-client-secret',vault,clock:()=>now,
    prepare:async request=>{requests.push(request);return {contract:'clued.storage-demand-preflight/1',...ctx,credential_version:version,
      credential_envelope:envelope,provider_scope_profile:'legacy',delegation_version:1,renewal_enabled:true,refresh_state:'idle',proof:'clued_srp_'+'d'.repeat(64)};},
    refresh_rpc:async input=>{native.push(input);
      if(input.action==='observe_credential')return {status:'current'};
      if(input.action==='claim')return {...ctx,credential_version:version,credential_envelope:envelope,status:'acquired',attempt_id:input.attempt_id,
        root_folder_id:'root',root_parent_id:'parent',expires_at:new Date(now+120000).toISOString()};
      if(input.action==='commit'){version++;envelope=input.credential_envelope;return {status:'committed'};}
      throw Error('unexpected Native action');},
    fetch:async(url,init)=>{provider.push(String(url));
      assert.equal(init.redirect,'manual');
      if(String(url).endsWith('/token'))return Response.json({access_token:'synthetic-access-token',token_type:'Bearer',expires_in:3600});
      if(String(url).includes('/about'))return Response.json({user:{me:true,permissionId:ctx.provider_subject}});
      return Response.json({id:'root',mimeType:'application/vnd.google-apps.folder',trashed:false,isAppAuthorized:true,parents:['parent'],capabilities:{canAddChildren:true}});}};
  return {ctx,config,requests,native,provider,runtime:await createStorageDemandRuntime(config)};
}

test('probe covers its seventy-second provider budget; adequately valid Agent use has no exchange',async()=>{
  const probe=await fixture(65000);
  assert.equal((await probe.runtime.owner(probe.ctx.owner_id,probe.ctx.connection_id,'probe')).status,'ready');
  assert.equal(probe.provider.filter(url=>url.endsWith('/token')).length,1);
  assert.ok(probe.requests.every(request=>request.operation==='probe'&&request.caller_kind==='owner'));
  const read=await fixture();const result=await read.runtime.agent({token_hash:'a'.repeat(64),input:{connection_id:read.ctx.connection_id,operation:'list'}});
  assert.equal(result.status,'ready');assert.equal(read.provider.length,0);
  assert.doesNotMatch(JSON.stringify(result),/clued_srp_|token|credential_envelope/);
});

test('job uses the full five-minute operation margin and mismatched Owner identity cannot renew',async()=>{
  const job=await fixture(120000);
  assert.equal((await job.runtime.job({connection_id:job.ctx.connection_id,job_id:randomUUID()})).status,'ready');
  assert.equal(job.provider.filter(url=>url.endsWith('/token')).length,1);
  const owner=await fixture(-1000);
  assert.equal((await owner.runtime.owner(randomUUID(),owner.ctx.connection_id,'probe')).status,'unavailable');
  assert.equal(owner.provider.length,0);
});

test('empty demand schedule never creates a vault/refresher and still reports unresolved Native attempts',async()=>{
  for(const pending_expired of [0,1]){
    const calls=[];const result=await runStorageDemandRenewalScheduled({client_id:'',client_secret:'',vault:null,
      refresh_rpc:async input=>{calls.push(input);return {status:'ok',connections:[],pending_expired};}});
    assert.equal(result.status,pending_expired?'attention_required':'ok');
    assert.deepEqual(calls,[{action:'due_demand'}]);
  }
});

test('schedule refuses untrusted selectors before credentials are initialized',async()=>{
  const result=await runStorageDemandRenewalScheduled({client_id:'',client_secret:'',vault:null,
    refresh_rpc:async()=>({status:'ok',connections:[{connection_id:randomUUID(),wake:'keepalive',owner_id:randomUUID()}]})});
  assert.equal(result.status,'unavailable');
});
