import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import {build,stop} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {createStorageCredentialVault} from '../worker/storage-credential-vault.ts';
import {scopeString} from '../worker/storage-google-scopes.ts';
import {createGoogleDriveMetadataApi} from '../../../kernel/host/resource-center-google-drive-metadata.mjs';
import {createGoogleDriveLocationRecovery} from '../../../kernel/host/resource-center-google-drive-location-recovery.mjs';
const bundle=await build({entryPoints:[fileURLToPath(new URL('../worker/storage-cloud-recovery.ts',import.meta.url))],bundle:true,
 platform:'node',format:'esm',write:false});
const cloud=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const locationBundle=await build({entryPoints:[fileURLToPath(new URL('../worker/storage-location-recovery.ts',import.meta.url))],bundle:true,
 platform:'node',format:'esm',write:false});
const {createStorageCurrentLocationRecovery}=await import('data:text/javascript;base64,'+Buffer.from(locationBundle.outputFiles[0].text).toString('base64'));stop();
const uuid=()=>crypto.randomUUID(),folder='application/vnd.google-apps.folder',hash='a'.repeat(64);

async function fixture({scope=scopeString('full'),moved=false}={}){
 const reference={connection_id:uuid(),job_id:uuid()},intent=uuid(),owner=uuid(),client='location-client',files=new Map(),calls=[],rpcCalls=[];
 const add=(id,name,parent)=>{const file={id,name,parents:[parent],mimeType:folder,version:'1',trashed:false,explicitlyTrashed:false,
  ownedByMe:true,shared:false,permissionIds:['owner-permission'],permissions:[{id:'owner-permission',type:'user',role:'owner'}],
  capabilities:{canShare:true,canListChildren:true}};files.set(id,file);return file;};
 const root=add('root','Root','outside'),track=add('track','assets','root'),parent=moved?add('new-parent','Current','track'):track;
 const target=add('target','NowTopic',parent.id);target.version='30';
 const node=(file,path)=>({artifact_id:uuid(),artifact_version:1,path,provider_file_id:file.id,parent_id:file.parents[0],access_digest:null,sharing_digest:null});
 const seed={contract:'clued.storage-directory-location-seed/1',managed_root:'G:/Root',root_folder_id:'root',root_parent_id:'outside',intent_id:intent,
  request_sha256:hash,target:{...node(target,'G:/Root/assets/OldTopic'),parent_id:'track',registered_state:'trashed'}};
 const parents=[node(root,'G:/Root'),node(track,'G:/Root/assets')];if(moved)parents.push(node(parent,'G:/Root/assets/Current'));
 const plan={...seed,contract:'clued.storage-directory-location-plan/1',mode:'refresh_directory_location',parents,
  target:{...seed.target,path:parents.at(-1).path+'/NowTopic',parent_id:parent.id,registered_path:seed.target.path,registered_parent_id:'track'}};
 const fetch=async(input,init)=>{
  const url=new URL(input);calls.push({url,init});assert.equal(init.method,'GET');assert.equal(init.body,undefined);
  assert.equal(url.origin,'https://www.googleapis.com');
  if(url.pathname.endsWith('/permissions'))return Response.json({permissions:files.get(url.pathname.split('/').at(-2)).permissions});
  if(url.pathname!=='/drive/v3/files')return Response.json(structuredClone(files.get(url.pathname.split('/').at(-1))));
  const q=url.searchParams.get('q'),parentId=q.match(/^'([^']+)' in parents/)?.[1],name=q.match(/ and name = '([^']+)'/)?.[1];assert.ok(parentId);
  return Response.json({files:[...files.values()].filter(f=>f.parents.includes(parentId)&&(!q.includes('trashed = false')||!f.trashed)&&(!name||f.name===name)),incompleteSearch:false});
 };
 const keys={current_key_id:'synthetic',keys:{synthetic:crypto.randomBytes(32).toString('base64url')}},vault=await createStorageCredentialVault(keys);
 const context={owner_id:owner,connection_id:uuid(),provider:'google-drive',provider_subject:'synthetic-subject',oauth_client_id:client,credential_version:3};
 const actor={contract:'clued.storage-registration-program-authority/1',actor_kind:'storage_program',issuer_id:uuid(),issuer_credential_generation:1,...context,
  original_connection_id:reference.connection_id,job_id:reference.job_id,intent_id:intent,registration_action:'modify',provider_scope_profile:'full',actions:['modify'],
  root_folder_id:'root',root_parent_id:'outside',managed_root:'G:/Root',runtime:{allowed_root_children:['assets']}};
 const source=uuid(),loaded={status:'registration_location_required',...reference,owner_id:owner,intent_id:intent,base_version:4,source_receipt_id:source,
  registration_authority:actor,recovery_reader:{contract:'clued.storage-recovery-reader/1',connection_id:context.connection_id,credential_version:3},
  registration_seed:seed,credential_version:3,execution_permitted:false,
  credential_envelope:await vault.seal(JSON.stringify({token_type:'Bearer',access_token:'synthetic-location-token',scope,expires_at_ms:Date.now()+3600000}),context)};
 const planned={...loaded,status:'registration_required',registration_plan:plan};delete planned.registration_seed;
 const result={status:'resolved',resolution:'automatically_registered_current_state',automatic_recovery:'resolved',...reference,intent_id:intent,
  base_version:4,receipt_id:uuid(),source_receipt_id:source,current_artifact_state:'active',current_path:plan.target.path,execution_permitted:false};
 const rpc=async input=>{rpcCalls.push(input);return input.action==='registration_location_load'?loaded:input.action==='registration_location_plan'?planned:result;};
 const metadata=createGoogleDriveMetadataApi({registration_details:true,get_credential:async()=>({access_token:'synthetic-location-token',scope:scopeString('full')}),fetch});
 return {reference,intent,keys,client,seed,plan,files,calls,rpcCalls,target,parent,loaded,planned,result,rpc,observer:createGoogleDriveLocationRecovery({metadata}),
  adapter:options=>createStorageCurrentLocationRecovery({client_id:client,vault:keys,rpc,fetch,...options}),fetch};
}

for(const moved of [false,true])test('same original ID at current '+(moved?'parent':'name')+' uses a fresh Native plan and GET-only full observations',async()=>{
 const f=await fixture({moved}),before=structuredClone([...f.files]),r=await(await f.adapter()).run(f.reference,f.intent);
 assert.deepEqual(r,f.result);assert.deepEqual([...f.files],before);
 assert.deepEqual(f.rpcCalls.map(x=>x.action),['registration_location_load','registration_location_plan','registration_location_commit']);
 assert.equal(f.rpcCalls[0].job_id,f.reference.job_id);assert.equal(f.rpcCalls[1].location_hint.provider_file_id,'target');
 assert.equal(f.rpcCalls[2].registration_plan.target.registered_path,'G:/Root/assets/OldTopic');
 assert.equal(f.rpcCalls[2].second_observation.target.path,f.plan.target.path);
 assert.ok(f.calls.every(x=>x.init.method==='GET'));assert.equal(f.calls[0].url.pathname,'/drive/v3/files/target');
});
for(const [label,change] of [
 ['trashed',f=>f.target.trashed=true],['inherited trash',f=>f.target.explicitlyTrashed=true],
 ['unknown ownership',f=>delete f.target.ownedByMe],['multiple parents',f=>f.target.parents.push('other')],
 ['unsafe name',f=>f.target.name='../escape'],['shortcut',f=>f.target.mimeType='application/vnd.google-apps.shortcut'],
])test('discovery refuses '+label+' before planning',async()=>{
 const f=await fixture();change(f);await assert.rejects((await f.adapter()).run(f.reference,f.intent));assert.equal(f.rpcCalls.length,1);
});
test('the real sealed scope and exact credential context are checked before discovery',async()=>{
 const f=await fixture({scope:scopeString('normal')});await assert.rejects((await f.adapter()).run(f.reference,f.intent));assert.equal(f.calls.length,0);
 const g=await fixture();g.loaded.registration_authority.provider_subject='different-subject';await assert.rejects((await g.adapter()).run(g.reference,g.intent));assert.equal(g.calls.length,0);
});
for(const phase of ['load','plan','commit'])test('strict same-reference busy at '+phase+' maps to durable pending without a new effect',async()=>{
 const f=await fixture(),busy={contract:'clued.storage-current-location-busy/1',...f.reference,status:'pending',automatic_recovery:'pending',
  reason_code:'REGISTRATION_LOCATION_BUSY',execution_permitted:false};
 const adapter=await f.adapter({rpc:input=>input.action==='registration_location_'+phase?Promise.resolve(busy):f.rpc(input)});
 const r=await adapter.run(f.reference,f.intent);assert.equal(r.status,'inspection_required');assert.equal(r.automatic_recovery,'pending');
 assert.equal(r.job_id,f.reference.job_id);assert.equal(r.execution_permitted,false);
});
test('an unrelated or malformed busy reply never becomes a valid pending projection',async()=>{
 const f=await fixture();await assert.rejects((await f.adapter({rpc:async()=>({contract:'clued.storage-current-location-busy/1',...f.reference,
  job_id:uuid(),status:'pending',automatic_recovery:'pending',reason_code:'REGISTRATION_LOCATION_BUSY',execution_permitted:false})})).run(f.reference,f.intent));
});
for(const [name,change] of [
 ['result path',f=>f.result.current_path+='-other'],['result source',f=>f.result.source_receipt_id=uuid()],
 ['result identity',f=>f.result.intent_id=uuid()],['result state',f=>f.result.current_artifact_state='trashed'],
 ['authority track',f=>f.loaded.registration_authority.runtime.allowed_root_children=['other']],
 ['plan target ID',f=>f.plan.target.provider_file_id='other'],['plan original path',f=>f.plan.target.registered_path+='-other'],
])test(name+' cannot substitute for the exact independently committed result',async()=>{
 const f=await fixture();change(f);await assert.rejects((await f.adapter()).run(f.reference,f.intent));
});
test('a lost commit response is not replayed in the same run; a later exact load can read the committed result without GETs',async()=>{
 const f=await fixture();let commits=0;
 await assert.rejects((await f.adapter({rpc:input=>{if(input.action==='registration_location_commit'){commits++;throw Error('synthetic lost reply');}return f.rpc(input);}})).run(f.reference,f.intent),/synthetic lost reply/);
 assert.equal(commits,1);const gets=f.calls.length;
 assert.deepEqual(await(await f.adapter({rpc:async()=>f.result})).run(f.reference,f.intent),f.result);assert.equal(f.calls.length,gets);
});
test('an uncooperative late load cannot start discovery or commit after the local deadline',async()=>{
 const f=await fixture();await assert.rejects((await f.adapter({timeout_ms:5,rpc:async()=>{await new Promise(r=>setTimeout(r,25));return f.loaded;}})).run(f.reference,f.intent));
 await new Promise(r=>setTimeout(r,30));assert.equal(f.calls.length,0);
});
test('the actual scheduled recovery composition falls through old-path refusal to separately authenticated location recovery',async()=>{
 const f=await fixture(),calls=[],descriptor={...f.reference,intent_id:f.intent,mutation:{target_kind:'directory',operation:'delete'},attempt:{contract:'clued.storage-destructive-attempt/1'}};
 const recovery=await cloud.createStorageCloudRecovery({client_id:f.client,vault:f.keys,rpc:async()=>{throw Error('original not yet settled');},
  verified:{descriptor,rpc:async()=>{throw Error('no typed proof');}},current_registration:{rpc:async input=>{
   calls.push(input.action);if(input.action==='registration_current_load')throw Error('old path no longer current');
   assert.equal(input.action,'registration_location_load');return f.result;}}});
 assert.deepEqual(await recovery.run(f.reference),f.result);assert.deepEqual(calls,['registration_current_load','registration_location_load']);
});
