import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import {build,stop} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {createStorageCredentialVault} from '../worker/storage-credential-vault.ts';
import {scopeString} from '../worker/storage-google-scopes.ts';
import {createGoogleDriveMetadataApi} from '../../../kernel/host/resource-center-google-drive-metadata.mjs';
import {createGoogleDriveRegistrationRecovery} from '../../../kernel/host/resource-center-google-drive-registration-recovery.mjs';
import {googleDriveAccessDigest,googleDriveSharingDigest} from '../../../kernel/host/resource-center-google-drive-sharing.mjs';
const folder='application/vnd.google-apps.folder',hash='a'.repeat(64),intent=crypto.randomUUID();
function fixture(mode='refresh_directory'){
 const files=new Map(),calls=[],versions=new Map();
 const add=(id,name,parent,kind=folder)=>{
  const file={id,name,parents:[parent],mimeType:kind,version:'1',trashed:false,explicitlyTrashed:false,
   ownedByMe:true,shared:false,permissionIds:['drive-permission-owner'],
   permissions:[{id:'drive-permission-owner',type:'user',role:'owner'}],capabilities:{canShare:true,canListChildren:true}};
  files.set(id,file);return file;
 };
 const root=add('root','Root','outside'),track=add('track','assets','root'),target=add('target','Topic','track');
 const node=(file,path)=>({artifact_id:crypto.randomUUID(),artifact_version:1,path,provider_file_id:file.id,parent_id:file.parents[0],
  access_digest:null,sharing_digest:null});
 const targetNode=['refresh_directory','refresh_directory_state'].includes(mode)?node(target,'G:/Root/assets/Topic'):
  {path:'G:/Root/assets/Topic',provider_file_id:'target',parent_id:'track',target_kind:'directory',mime_type:folder,size:null,sha256:null};
 if(mode==='refresh_directory_state')targetNode.registered_state='active';
 target.appProperties={clued_intent_id:intent,clued_request_sha256:hash};
 const plan={contract:'clued.storage-registration-plan/1',mode,managed_root:'G:/Root',root_folder_id:'root',root_parent_id:'outside',
  intent_id:intent,request_sha256:hash,parents:[node(root,'G:/Root'),node(track,'G:/Root/assets')],target:targetNode};
 const fetch=async(input,init)=>{
  const url=new URL(input);calls.push({url,init});
  assert.equal(url.origin,'https://www.googleapis.com');assert.equal(init.method,'GET');assert.equal(init.body,undefined);
  if(url.pathname.endsWith('/permissions')){
   const id=url.pathname.split('/').at(-2),file=files.get(id);
   return file?Response.json({permissions:file.permissions}):Response.json({error:{code:404}},{status:404});
  }
  if(url.pathname!=='/drive/v3/files'){
   if(url.searchParams.get('fields').includes('canListChildren'))assert.equal(url.searchParams.get('includePermissionsForView'),'published');
   const id=url.pathname.split('/').at(-1),file=files.get(id);
   if(!file)return Response.json({error:{code:404}},{status:404});
   const value=structuredClone(file);
   if(versions.has(id))value.version=String(versions.get(id)());
   return Response.json(value);
  }
  const q=url.searchParams.get('q'),parent=q.match(/^'([^']+)' in parents/)?.[1],name=q.match(/ and name = '([^']+)'/)?.[1];
  assert.ok(parent,q);
  const found=[...files.values()].filter(f=>f.parents.includes(parent)&&(!q.includes('trashed = false')||!f.trashed)&&(!name||f.name===name));
  return Response.json({files:found,incompleteSearch:false});
 };
 const metadata=createGoogleDriveMetadataApi({registration_details:true,get_credential:async()=>({access_token:'synthetic-current-full-token',
  scope:'https://www.googleapis.com/auth/drive'}),fetch});
 return {files,calls,versions,root,track,target,plan,fetch,
  observe:()=>createGoogleDriveRegistrationRecovery({metadata}).observe(plan)};
}

for(const registered of ['active','trashed'])for(const current of ['active','trashed'])
 test('directory state '+registered+' -> '+current+' observes the target without changing Drive',async()=>{
  const f=fixture('refresh_directory_state');f.plan.target.registered_state=registered;
  f.target.trashed=current==='trashed';f.target.explicitlyTrashed=f.target.trashed;
  if(f.target.trashed)f.target.capabilities.canListChildren=false;
  const before=structuredClone([...f.files]),result=await f.observe();
  assert.equal(result.second_observation.target.current_state,current);
  assert.equal(result.second_observation.target.registered_state,registered);
  assert.equal(result.second_observation.target.empty,current==='trashed'?null:true);
  assert.deepEqual([...f.files],before);
  assert.ok(f.calls.every(c=>c.init.method==='GET'));
  if(current==='trashed')assert.equal(f.calls.some(c=>c.url.searchParams.get('q')?.startsWith("'target' in parents")),false);
 });

test('a trashed target does not claim or adopt the active same-name slot',async()=>{
 const f=fixture('refresh_directory_state');f.target.trashed=true;f.target.explicitlyTrashed=true;
 f.files.set('foreign',{id:'foreign',name:'Topic',parents:['track'],trashed:false});
 const before=structuredClone([...f.files]);
 assert.equal((await f.observe()).second_observation.target.current_state,'trashed');
 assert.deepEqual([...f.files],before);assert.equal(f.calls.some(c=>c.url.pathname.endsWith('/foreign')),false);
});

test('a non-shareable trashed owner directory obtains a real complete permission list without changing canShare',async()=>{
 const f=fixture('refresh_directory_state');f.target.trashed=true;f.target.explicitlyTrashed=true;f.target.capabilities.canShare=false;
 f.target.capabilities.canListChildren=false;const before=structuredClone([...f.files]);
 assert.equal((await f.observe()).second_observation.target.current_state,'trashed');
 assert.deepEqual([...f.files],before);
 assert.equal(f.calls.filter(c=>c.url.pathname==='/drive/v3/files/target/permissions').length,2);
 assert.equal(f.target.capabilities.canShare,false);
});

for(const [name,change,reason] of [
 ['inherited trash',f=>{f.target.trashed=true;f.target.explicitlyTrashed=false;},'IDENTITY_CHANGED'],
 ['contradictory explicit trash',f=>{f.target.trashed=false;f.target.explicitlyTrashed=true;},'IDENTITY_CHANGED'],
 ['missing trash flag',f=>delete f.target.trashed,'IDENTITY_CHANGED'],
 ['missing explicit flag',f=>delete f.target.explicitlyTrashed,'IDENTITY_CHANGED'],
 ['string trash flag',f=>{f.target.trashed='true';f.target.explicitlyTrashed='true';},'IDENTITY_CHANGED'],
 ['trashed parent',f=>{f.track.trashed=true;f.track.explicitlyTrashed=true;},'IDENTITY_CHANGED'],
 ['unknown registered state',f=>f.plan.target.registered_state='removed','PLAN_INVALID'],
 ['missing registered state',f=>delete f.plan.target.registered_state,'PLAN_INVALID'],
 ['invented parent state',f=>f.plan.parents[0].registered_state='active','PLAN_INVALID'],
 ['trash incomplete ACL',f=>{f.target.trashed=true;f.target.explicitlyTrashed=true;f.target.capabilities.canShare=false;delete f.target.permissions;},'PERMISSIONS_INVALID'],
])test('current state rejects '+name,async()=>{
 const f=fixture('refresh_directory_state');change(f);await assert.rejects(f.observe(),new RegExp(reason));
});

test('trash state changing between two reads cannot be registered',async()=>{
 const f=fixture('refresh_directory_state');let reads=0;
 f.versions.set('target',()=>{if(++reads===2){f.target.trashed=true;f.target.explicitlyTrashed=true;}return 1;});
 // The returned file is cloned before the synthetic mutation; force it on
 // the second actual GET, rather than substituting a proposed state.
 const metadata=createGoogleDriveMetadataApi({registration_details:true,
  get_credential:async()=>({access_token:'synthetic-current-token',scope:'https://www.googleapis.com/auth/drive'}),
  fetch:async(input,init)=>{if(new URL(input).pathname.endsWith('/target')&&reads===1){f.target.trashed=true;f.target.explicitlyTrashed=true;}return f.fetch(input,init);}});
 await assert.rejects(createGoogleDriveRegistrationRecovery({metadata}).observe(f.plan),/OBSERVATION_CHANGED/);
});

test('current qualification reads complete owner ACL; parents may contain unrelated children',async()=>{
 const f=fixture();f.files.set('unrelated',{id:'unrelated',name:'Other',parents:['track'],trashed:false});
 const result=await f.observe();assert.equal(result.second_observation.target.empty,true);
 assert.equal(result.second_observation.parents.length,2);assert.ok(f.calls.length>5);
 assert.equal(result.second_observation.target.access_digest,googleDriveAccessDigest(f.target));
 // The synthetic OAuth subject does not equal this Drive permission ID;
 // the sealed-credential adapter owns that binding, not a string heuristic.
 assert.equal(result.second_observation.parents[0].sharing_digest,googleDriveSharingDigest(f.root));
 assert.ok(f.calls.every(c=>c.init.method==='GET'));
});

test('ancestor version can advance; exact identity and ACL are compared across observations',async()=>{
 const f=fixture();let counter=0;f.versions.set('root',()=>++counter);
 const result=await f.observe();assert.notEqual(result.first_observation.parents[0].provider_file_version,result.second_observation.parents[0].provider_file_version);
 assert.equal(result.second_observation.target.provider_file_version,'1');
});

for(const mode of ['refresh_directory','adopt_create'])for(const trashed of [false,true])
 test(mode+' observes a nonempty directory without adopting or changing its '+(trashed?'trashed':'active')+' child',async()=>{
  const f=fixture(mode);
  f.files.set('unmanaged-child',{id:'unmanaged-child',parents:['target'],name:'owner-file',trashed});
  const before=structuredClone([...f.files]),plan=structuredClone(f.plan);
  const result=await f.observe();
  assert.equal(result.first_observation.target.empty,false);assert.equal(result.second_observation.target.empty,false);
  assert.deepEqual([...f.files],before);assert.deepEqual(f.plan,plan);
  assert.ok(f.calls.every(c=>c.init.method==='GET'&&c.url.pathname!=='/drive/v3/files/unmanaged-child'));
 });

test('changing child presence between the two reads is not a stable current qualification',async()=>{
 const f=fixture();let reads=0;
 f.versions.set('target',()=>{if(++reads===2)f.files.set('new-child',{id:'new-child',parents:['target'],name:'new',trashed:false});return 1;});
 await assert.rejects(f.observe(),/OBSERVATION_CHANGED/);
});

for(const [name,change,reason] of [
 ['metadata-only list visibility',f=>f.track.capabilities.canListChildren=false,'NAMESPACE_UNPROVEN'],
 ['missing canShare/full ACL visibility',f=>delete f.track.capabilities.canShare,'OWNERSHIP_UNPROVEN'],
 ['absent permissions',f=>delete f.target.permissions,'OWNERSHIP_UNPROVEN'],
 ['a second grantee',f=>f.target.permissions.push({id:'other',type:'user',role:'reader'}),'OWNERSHIP_UNPROVEN'],
 ['shared Drive item',f=>f.target.driveId='shared-drive','OWNERSHIP_UNPROVEN'],
 ['ownership missing',f=>delete f.target.ownedByMe,'OWNERSHIP_UNPROVEN'],
 ['shared item',f=>f.target.shared=true,'OWNERSHIP_UNPROVEN'],
 ['pending owner transfer',f=>f.target.permissions[0].pendingOwner=true,'OWNERSHIP_UNPROVEN'],
 ['published/metadata view permission',f=>f.target.permissions[0].view='published','OWNERSHIP_UNPROVEN'],
 ['deleted permission',f=>f.target.permissions[0].deleted=true,'OWNERSHIP_UNPROVEN'],
 ['unrequested permission field',f=>f.target.permissions[0].unrecognized=true,'OWNERSHIP_UNPROVEN'],
 ['permission IDs disagree',f=>f.target.permissionIds=['other-owner'],'OWNERSHIP_UNPROVEN'],
 ['known access baseline mismatch',f=>f.plan.parents[0].access_digest='b'.repeat(64),'ACL_CHANGED'],
 ['known sharing baseline mismatch',f=>f.plan.target.sharing_digest='b'.repeat(64),'ACL_CHANGED'],
 ['duplicate target name',f=>f.files.set('duplicate',{id:'duplicate',parents:['track'],name:'Topic',trashed:false}),'NAMESPACE_CONFLICT'],
 ['moved target',f=>f.target.parents=['elsewhere'],'IDENTITY_CHANGED'],
 ['multiple parents',f=>f.target.parents.push('elsewhere'),'IDENTITY_CHANGED'],
 ['shortcut target',f=>f.target.mimeType='application/vnd.google-apps.shortcut','IDENTITY_CHANGED'],
 ['trashed target',f=>f.target.trashed=true,'IDENTITY_CHANGED'],
 ['missing explicit trash fact',f=>delete f.target.explicitlyTrashed,'IDENTITY_CHANGED'],
])test('current registration rejects '+name,async()=>{
 const f=fixture();change(f);await assert.rejects(f.observe(),new RegExp('DRIVE_REGISTRATION_'+reason));
});

test('create recovery requires both private tags and exact pinned bytes identity',async()=>{
 const f=fixture('adopt_create');f.target.mimeType='application/zip';f.target.size='2048';f.target.sha256Checksum=hash;
 Object.assign(f.plan.target,{target_kind:'file',mime_type:'application/zip',size:'2048',sha256:hash});
 assert.equal((await f.observe()).second_observation.target.request_tag,hash);
 delete f.target.appProperties.clued_request_sha256;
 await assert.rejects(f.observe(),/CREATE_IDENTITY_UNPROVEN/);
 f.target.appProperties.clued_request_sha256=hash;f.target.size='2049';
 await assert.rejects(f.observe(),/CREATE_IDENTITY_UNPROVEN/);
 f.target.size='2048';f.target.sha256Checksum='b'.repeat(64);
 await assert.rejects(f.observe(),/CREATE_IDENTITY_UNPROVEN/);
});

test('a changed target version or changed ancestor facts invalidate two reads',async()=>{
 const f=fixture();let counter=0;f.versions.set('target',()=>++counter);
 await assert.rejects(f.observe(),/OBSERVATION_CHANGED/);
 const g=fixture();let reads=0;
 const api=createGoogleDriveMetadataApi({registration_details:true,get_credential:async()=>({access_token:'synthetic-full-token',scope:'https://www.googleapis.com/auth/drive'}),
  fetch:async(input,init)=>{if(new URL(input).pathname==='/drive/v3/files/root'&&++reads===2)g.root.permissions[0].id='changed-owner';return g.fetch(input,init);}});
 await assert.rejects(createGoogleDriveRegistrationRecovery({metadata:api}).observe(g.plan),/OWNERSHIP_UNPROVEN|OBSERVATION_CHANGED/);
});

test('incomplete namespace results and drive.file are not absence or uniqueness proof',async()=>{
 for(const profile of ['incomplete','drive.file']){
  const f=fixture(),api=createGoogleDriveMetadataApi({registration_details:true,
   get_credential:async()=>({access_token:'synthetic-current-token',scope:'https://www.googleapis.com/auth/'+(profile==='drive.file'?'drive.file':'drive')}),
   fetch:async(input,init)=>new URL(input).pathname==='/drive/v3/files'&&profile==='incomplete'?
    Response.json({files:[],incompleteSearch:true}):f.fetch(input,init)});
  await assert.rejects(createGoogleDriveRegistrationRecovery({metadata:api}).observe(f.plan),/DRIVE_LIST_INVALID|DRIVE_NAMESPACE_VISIBILITY_UNPROVEN/);
 }
});

test('invalid plan, timeout and abort never produce a qualification',async()=>{
 const f=fixture();f.plan.parents[0].parent_id=undefined;await assert.rejects(f.observe(),/PLAN_INVALID/);assert.equal(f.calls.length,0);
 const g=fixture(),controller=new AbortController();controller.abort();
 const api=createGoogleDriveMetadataApi({registration_details:true,get_credential:async()=>({access_token:'synthetic-full-token',scope:'https://www.googleapis.com/auth/drive'}),fetch:g.fetch});
 await assert.rejects(createGoogleDriveRegistrationRecovery({metadata:api}).observe(g.plan,{signal:controller.signal}),/abort/i);
 let tick=0;await assert.rejects(createGoogleDriveRegistrationRecovery({metadata:api,clock:()=>tick++*31000}).observe(g.plan),/OBSERVATION_EXPIRED/);
});

test('a slow first scan cannot timestamp old ACL facts as fresh',async()=>{
 const f=fixture();let now=100000;
 const metadata=createGoogleDriveMetadataApi({registration_details:true,
  get_credential:async()=>({access_token:'synthetic-full-token',scope:'https://www.googleapis.com/auth/drive'}),
  fetch:async(input,init)=>{if(new URL(input).pathname==='/drive/v3/files/root')now+=31000;return f.fetch(input,init);}});
 await assert.rejects(createGoogleDriveRegistrationRecovery({metadata,clock:()=>now}).observe(f.plan),/OBSERVATION_EXPIRED/);
});

test('malformed incompleteSearch and pagination flags never prove a complete scan',async()=>{
 for(const bad of [{incompleteSearch:'false'},{incompleteSearch:0},{nextPageToken:0},{nextPageToken:''},{nextPageToken:null}]){
  const f=fixture();
  const metadata=createGoogleDriveMetadataApi({registration_details:true,
   get_credential:async()=>({access_token:'synthetic-full-token',scope:'https://www.googleapis.com/auth/drive'}),
   fetch:async(input,init)=>new URL(input).pathname==='/drive/v3/files'?Response.json({files:[],...bad}):f.fetch(input,init)});
  await assert.rejects(createGoogleDriveRegistrationRecovery({metadata}).observe(f.plan),/DRIVE_LIST_INVALID/);
  await assert.rejects(metadata.hasChildren('target'),/DRIVE_LIST_INVALID/);
 }
});

const bundled=await build({entryPoints:[fileURLToPath(new URL('../worker/storage-registration-recovery.ts',import.meta.url))],
 bundle:true,platform:'node',format:'esm',write:false});
const {createStorageCurrentRegistrationRecovery}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
stop();
async function programFixture(scope=scopeString('full'),mode='refresh_directory'){
 const f=fixture(mode),reference={connection_id:crypto.randomUUID(),job_id:crypto.randomUUID()},owner=crypto.randomUUID(),readerId=crypto.randomUUID();
 const source=crypto.randomUUID(),receipt=crypto.randomUUID(),keys={current_key_id:'synthetic',keys:{synthetic:crypto.randomBytes(32).toString('base64url')}};
 const vault=await createStorageCredentialVault(keys),client='registration-client';
 const context={owner_id:owner,connection_id:readerId,provider:'google-drive',provider_subject:'oauth-subject-separate-from-permission-id',
  oauth_client_id:client,credential_version:3};
 const reader={contract:'clued.storage-recovery-reader/1',connection_id:readerId,credential_version:3,connection_version:2,
  auth_generation:4,policy_id:crypto.randomUUID(),policy_generation:2,scope_digest:hash,profile_version:1};
 const actor={contract:'clued.storage-registration-program-authority/1',actor_kind:'storage_program',issuer_id:crypto.randomUUID(),issuer_credential_generation:1,
  ...context,original_connection_id:reference.connection_id,job_id:reference.job_id,intent_id:intent,registration_action:'modify',
  provider_scope_profile:'full',actions:['modify'],root_folder_id:'root',root_parent_id:'outside',managed_root:'G:/Root'};
 const descriptor={status:'registration_required',...reference,owner_id:owner,intent_id:intent,base_version:4,source_receipt_id:source,
  registration_authority:actor,recovery_reader:reader,registration_plan:f.plan,credential_version:3,execution_permitted:false,
  credential_envelope:await vault.seal(JSON.stringify({token_type:'Bearer',access_token:'synthetic-current-full-token',scope,expires_at_ms:Date.now()+3600000}),context)};
 const result={status:'resolved',resolution:'automatically_registered_current_state',automatic_recovery:'resolved',...reference,
  intent_id:intent,base_version:4,receipt_id:receipt,source_receipt_id:source,execution_permitted:false};
 const rpcCalls=[];
 const rpc=async input=>{rpcCalls.push(input);return input.action==='registration_current_load'?descriptor:result;};
 return {...f,reference,source,receipt,keys,client,descriptor,result,rpcCalls,rpc,
  adapter:options=>createStorageCurrentRegistrationRecovery({client_id:client,vault:keys,rpc,fetch:f.fetch,...options})};
}

test('Worker uses a current program actor, real sealed full scope, GET-only reads and a separately bound receipt',async()=>{
 const f=await programFixture(),adapter=await f.adapter();
 assert.deepEqual(await adapter.run(f.reference,intent),f.result);
 assert.deepEqual(f.rpcCalls.map(c=>c.action),['registration_current_load','registration_current_commit']);
 const commit=f.rpcCalls[1];assert.deepEqual(commit.registration_authority,f.descriptor.registration_authority);
 assert.equal(commit.first_observation.target.provider_file_id,'target');
 assert.equal(commit.second_observation.target.owner_permission_id,'drive-permission-owner');
 assert.equal(Object.hasOwn(commit,'confirmed'),false);assert.ok(f.calls.every(c=>c.init.method==='GET'));
});

test('Worker carries a trashed state only with its exact observed independent settlement',async()=>{
 const f=await programFixture(scopeString('full'),'refresh_directory_state');
 f.target.trashed=true;f.target.explicitlyTrashed=true;f.target.capabilities.canListChildren=false;f.target.capabilities.canShare=false;
 f.result.current_artifact_state='trashed';
 assert.deepEqual(await (await f.adapter()).run(f.reference,intent),f.result);
 assert.equal(f.rpcCalls[1].second_observation.target.empty,null);
 for(const returned of ['active','deleted',undefined]){
  const g=await programFixture(scopeString('full'),'refresh_directory_state');g.target.trashed=true;g.target.explicitlyTrashed=true;
  if(returned!==undefined)g.result.current_artifact_state=returned;
  await assert.rejects((await g.adapter()).run(g.reference,intent),/storage_current_registration_unavailable/);
 }
});

test('DB full label cannot substitute for a lower sealed scope or wrong credential identity',async()=>{
 const f=await programFixture(scopeString('normal'));
 await assert.rejects((await f.adapter()).run(f.reference,intent),/storage_current_registration_unavailable/);
 assert.equal(f.calls.length,0);assert.equal(f.rpcCalls.length,1);
 const g=await programFixture();g.descriptor.registration_authority.provider_subject='different-subject';
 await assert.rejects((await g.adapter()).run(g.reference,intent));assert.equal(g.calls.length,0);assert.equal(g.rpcCalls.length,1);
});

test('late or unrelated settlement responses never become a current registration success',async()=>{
 for(const change of [result=>result.job_id=crypto.randomUUID(),result=>result.intent_id=crypto.randomUUID(),
  result=>result.base_version++,result=>result.source_receipt_id=crypto.randomUUID(),result=>result.receipt_id=result.source_receipt_id,
  result=>result.automatic_recovery='pending',result=>result.execution_permitted=true,result=>result.resolution='accepted_current_state']){
  const f=await programFixture();change(f.result);
  await assert.rejects((await f.adapter()).run(f.reference,intent),/storage_current_registration_unavailable/);
  assert.equal(f.rpcCalls.filter(c=>c.action==='registration_current_commit').length,1);
 }
});

test('lost commit reply does not retry provider work or submit another settlement',async()=>{
 const f=await programFixture();let commits=0;
 const adapter=await f.adapter({rpc:async input=>{
  if(input.action==='registration_current_load')return f.descriptor;
  commits++;throw Error('synthetic lost commit response');}});
 await assert.rejects(adapter.run(f.reference,intent),/synthetic lost commit response/);assert.equal(commits,1);
 assert.ok(f.calls.every(c=>c.init.method==='GET'));
});

test('a timed-out uncooperative descriptor cannot perform later GET or settlement',async()=>{
 const f=await programFixture();let commits=0;
 const adapter=await f.adapter({timeout_ms:5,rpc:async input=>{
  if(input.action==='registration_current_load'){await new Promise(resolve=>setTimeout(resolve,30));return f.descriptor;}
  commits++;return f.result;}});
 await assert.rejects(adapter.run(f.reference,intent),/DRIVE_METADATA_TIMEOUT/);
 await new Promise(resolve=>setTimeout(resolve,40));assert.equal(f.calls.length,0);assert.equal(commits,0);
});
