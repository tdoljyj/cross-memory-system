import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const dir=await mkdtemp(path.join(os.tmpdir(),'clued-external-registration-runtime-'));
async function load(name){const outfile=path.join(dir,name+'.mjs');
 await build({entryPoints:[fileURLToPath(new URL('../worker/'+name+'.ts',import.meta.url))],outfile,bundle:true,platform:'node',format:'esm'});
 return import(pathToFileURL(outfile));}
const {runStorageExternalRegistrationScheduled:run}=await load('storage-external-registration');
const {createStorageCredentialVault}=await load('storage-credential-vault');
const {scopeString}=await load('storage-google-scopes');
const folder='application/vnd.google-apps.folder';
async function fixture({token={},descriptor={},empty=false,transient=false,shared=false,renewal=false,enabled=true}={}){
 const owner=randomUUID(),connection=randomUUID(),artifact=randomUUID(),attempt=randomUUID(),client='fixture.apps.googleusercontent.com';
 const keys={current_key_id:'k1',keys:{k1:randomBytes(32).toString('base64url')}},vault=await createStorageCredentialVault(keys);
 const context={owner_id:owner,connection_id:connection,provider:'google-drive',provider_subject:'subject',oauth_client_id:client,credential_version:1};
 let version=1;
 let credential_envelope=await vault.seal(JSON.stringify({access_token:'synthetic-access-only',refresh_token:'synthetic-refresh-only',token_type:'Bearer',scope:scopeString('full'),expires_at_ms:Date.now()+3600000,...token}),context);
 const make=(id,name,parent,mimeType=folder)=>({id,name,parents:[parent],mimeType,version:'1',trashed:false,ownedByMe:true,shared:false,
  permissionIds:['owner'],permissions:[{id:'owner',type:'user',role:'owner'}],capabilities:{canListChildren:true}});
 const files=[make('root','资料中心','drive'),make('track','20_产品','root'),make('focus','探索产出','track'),make('new','新增.txt','focus','text/plain')];
 if(shared)files[2].shared=true;
 const root='G:/资料中心',paths={root,track:root+'/20_产品',focus:root+'/20_产品/探索产出'};
 const plan={contract:'clued.storage-external-registration-plan/1',root_folder_id:'root',root_parent_id:'drive',managed_root:root,focus_file_id:'focus',
  registry:files.slice(0,3).map(f=>({provider_file_id:f.id,provider_file_version:'1',path:paths[f.id],target_kind:'directory',state:'active',governance_class:f.id==='root'?'governance':'ordinary'}))};
 const authority={owner_id:owner,connection_id:connection,credential_version:1,root_folder_id:'root',root_parent_id:'drive',managed_root:root};
 const calls=[],reads=[];let temporary=transient;
 const fetch=async(input,init)=>{
  const url=new URL(String(input));
  if(url.origin==='https://oauth2.googleapis.com'){
   assert.equal(init.method,'POST');calls.push({action:'provider_token'});
   return Response.json({access_token:'synthetic-access-only',token_type:'Bearer',expires_in:3600});
  }
  if(url.origin==='https://www.googleapis.com'){
   assert.equal(init.method??'GET','GET');assert.equal(init.body,undefined);assert.equal(url.searchParams.has('alt'),false);
   assert.equal(new Headers(init.headers).get('authorization'),'Bearer synthetic-access-only');reads.push(url);
   if(renewal&&url.pathname==='/drive/v3/about')return Response.json({user:{me:true,permissionId:'subject'}});
   if(renewal&&url.searchParams.get('fields')?.includes('canAddChildren'))return Response.json({...files[0],capabilities:{canAddChildren:true}});
   if(temporary){temporary=false;return new Response('{}',{status:503});}
   if(url.pathname==='/drive/v3/files'){
    const q=url.searchParams.get('q'),parent=/^'([^']+)' in parents/.exec(q)?.[1],name=/ and name = '([^']+)'/.exec(q)?.[1];
    assert.ok(parent,q);return Response.json({files:files.filter(f=>f.parents[0]===parent&&(!name||f.name===name)),incompleteSearch:false});
   }
   assert.match(url.pathname,/^\/drive\/v3\/files\/[A-Za-z0-9_-]+$/);
   const f=files.find(f=>url.pathname.endsWith('/'+f.id));assert.ok(f);return Response.json(f);
  }
  assert.equal(url.origin,'https://db.example.test');assert.ok(['/rest/v1/rpc/clued_storage_access_digest_backfill_v1','/rest/v1/rpc/clued_storage_refresh_worker_v1'].includes(url.pathname));
  assert.equal(new Headers(init.headers).get('authorization'),'Bearer synthetic-gateway');
  const body=JSON.parse(init.body);assert.match(body.p_issuer_hash,/^[0-9a-f]{64}$/);calls.push(body.p_input);
  if(url.pathname.endsWith('/clued_storage_refresh_worker_v1')){
   const input=body.p_input;
   if(input.action==='prepare_credential')return Response.json({contract:'clued.storage-demand-preflight/1',...context,
    credential_version:version,credential_envelope,provider_scope_profile:'full',delegation_version:1,
    renewal_enabled:enabled,refresh_state:'idle',proof:'clued_srp_'+'b'.repeat(64)});
   if(input.action==='observe_credential')return Response.json({status:'current'});
   if(input.action==='claim')return Response.json({...context,credential_version:version,credential_envelope,status:'acquired',
    attempt_id:input.attempt_id,root_folder_id:'root',root_parent_id:'drive',expires_at:new Date(Date.now()+120000).toISOString()});
   if(input.action==='commit'){version++;credential_envelope=input.credential_envelope;return Response.json({status:'committed'});}
   throw Error('unexpected refresh RPC');
  }
  if(body.p_input.action==='external_due')return Response.json({status:'ok',directories:empty?[]:[{connection_id:connection,artifact_id:artifact}]});
  if(body.p_input.action==='external_load')return Response.json({status:'read_only',execution_permitted:false,attempt_id:attempt,authority:{...authority,credential_version:version},plan,
   credential_envelope,oauth_client_id:client,provider_subject:'subject',...descriptor});
  if(body.p_input.action==='external_commit')return Response.json({status:'committed',execution_permitted:false,attempt_id:attempt,changed:1,receipt_id:randomUUID()});
  if(body.p_input.action==='external_failed')return Response.json({status:'recorded',execution_permitted:false,attempt_id:attempt});
  throw Error('unexpected RPC');
 };
 return {fetch,calls,reads,artifact,env:{CLUED_DB_GATEWAY_TOKEN:'synthetic-gateway',CLUED_STORAGE_ACCOUNT_V1:'true',CLUED_STORAGE_GOOGLE_V1:'true',
  CLUED_STORAGE_JOBS_V2:'true',CLUED_STORAGE_EXECUTOR_V1:'true',CLUED_STORAGE_CONNECTOR_ISSUER:'i'.repeat(40),CLUED_STORAGE_GOOGLE_CLIENT_ID:client,
  CLUED_STORAGE_VAULT_KEYS:JSON.stringify(keys),SUPABASE_URL:'https://db.example.test',SUPABASE_PUBLISHABLE_KEY:'publishable',
  ...(renewal?{CLUED_STORAGE_REFRESH_V1:'true',CLUED_STORAGE_GOOGLE_CLIENT_SECRET:'synthetic-client-secret'}:{})}};
}
test('scheduled external create uses the issuer, sealed credential and GET-only metadata transport',async()=>{
 const f=await fixture();assert.deepEqual(await run(f.env,{fetch:f.fetch}),{status:'ok',changed:1,unchanged:0,skipped:0});
 assert.deepEqual(f.calls.map(x=>x.action),['external_due','external_load','external_commit']);
 assert.deepEqual(f.calls.at(-1).observation.first_observation.new_ids,['new']);assert.ok(f.reads.length>0);
});
test('a temporary Drive failure retries within the bounded observation',async()=>{
 const f=await fixture({transient:true});assert.equal((await run(f.env,{fetch:f.fetch})).changed,1);
});
test('expired or narrower credentials perform no Drive read and report a bounded failure',async()=>{
 for(const token of [{expires_at_ms:Date.now()-1},{scope:scopeString('normal')}]){
  const f=await fixture({token});assert.deepEqual(await run(f.env,{fetch:f.fetch}),{status:'ok',changed:0,unchanged:0,skipped:1});
  assert.equal(f.reads.length,0);assert.equal(f.calls.at(-1).action,'external_failed');
 }
});
test('unexpected authority or changed sharing never commits a registration',async()=>{
 for(const options of [{descriptor:{execution_permitted:true}},{descriptor:{oauth_client_id:'foreign-client'}},{shared:true}]){
  const f=await fixture(options);assert.equal((await run(f.env,{fetch:f.fetch})).skipped,1);
  assert.equal(f.calls.some(x=>x.action==='external_commit'),false);
 }
});
test('disabled or empty scheduling performs no content work and needs no decryption',async()=>{
 assert.deepEqual(await run({}),{status:'disabled'});
 const f=await fixture({empty:true});assert.deepEqual(await run({...f.env,CLUED_STORAGE_VAULT_KEYS:'invalid'},{fetch:f.fetch}),{status:'ok',changed:0,unchanged:0,skipped:0});
 assert.equal(f.reads.length,0);assert.deepEqual(f.calls.map(x=>x.action),['external_due']);
});
test('expired eligible registration renews once and reloads its plan with the renewed credential',async()=>{
 const f=await fixture({renewal:true,token:{expires_at_ms:Date.now()-1000}});
 assert.deepEqual(await run(f.env,{fetch:f.fetch}),{status:'ok',changed:1,unchanged:0,skipped:0});
 assert.equal(f.calls.filter(c=>c.action==='provider_token').length,1);
 assert.ok(f.calls.findIndex(c=>c.action==='external_load')>f.calls.findLastIndex(c=>c.action==='prepare_credential'));
 assert.ok(f.calls.filter(c=>c.action==='prepare_credential').every(c=>c.caller_kind==='maintenance'&&
  c.request.operation==='external_registration'&&c.request.artifact_id===f.artifact));
});
test('renewal off preserves valid registration but never exchanges an expired credential',async()=>{
 const valid=await fixture({renewal:true,enabled:false});
 assert.equal((await run(valid.env,{fetch:valid.fetch})).changed,1);
 assert.equal(valid.calls.some(c=>c.action==='claim'||c.action==='provider_token'),false);
 const expired=await fixture({renewal:true,enabled:false,token:{expires_at_ms:Date.now()-1000}});
 assert.deepEqual(await run(expired.env,{fetch:expired.fetch}),{status:'ok',changed:0,unchanged:0,skipped:1});
 assert.equal(expired.reads.length,0);assert.equal(expired.calls.some(c=>c.action==='claim'||c.action==='external_load'),false);
});
