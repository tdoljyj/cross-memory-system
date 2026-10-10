import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const dir=await mkdtemp(path.join(os.tmpdir(),'clued-owner-lifecycle-worker-'));
const output=path.join(dir,'lifecycle.mjs'),vaultOutput=path.join(dir,'vault.mjs');
await build({entryPoints:[fileURLToPath(new URL('../worker/storage-owner-lifecycle.ts',import.meta.url))],outfile:output,bundle:true,platform:'node',format:'esm'});
await build({entryPoints:[fileURLToPath(new URL('../worker/storage-credential-vault.ts',import.meta.url))],outfile:vaultOutput,bundle:true,platform:'node',format:'esm'});
const {createStorageOwnerLifecycle,STORAGE_OWNER_CONFIRMATION}=await import(pathToFileURL(output));
const {createStorageCredentialVault}=await import(pathToFileURL(vaultOutput));
test.after(()=>rm(dir,{recursive:true,force:true}));
async function fixture(options={}){
  const owner=randomUUID(),connection=randomUUID(),profile=randomUUID(),project=randomUUID(),attempt=randomUUID();
  const vault={current_key_id:'test',keys:{test:randomBytes(32).toString('base64url')}},storage=await createStorageCredentialVault(vault);
  const ctx={owner_id:owner,connection_id:connection,provider:'google-drive',provider_subject:'synthetic-provider-owner',oauth_client_id:'synthetic.apps.googleusercontent.com',credential_version:1};
  const envelope=await storage.seal(JSON.stringify({access_token:'synthetic-access-token',refresh_token:'synthetic-refresh-token',token_type:'Bearer',scope:'synthetic',expires_at_ms:Date.now()+(options.expired?-1:3600000)}),ctx);
  const descriptor={...ctx,connection_version:2,profile_id:profile,profile_version:1,credential_envelope:envelope,root_folder_id:'synthetic-root',root_parent_id:'my-drive',created_by_clued:options.created!==false};
  const row={id:connection,version:2,provider:'google-drive',state:'active',auth_mode:'account_policy',profile_id:profile,profile_version:1,project_id:project,
    policy_active:true,actions:['inspect','create_file','create_topic'],database_execution_enabled:true,profile_current:true,access_digest_missing:{count:0,directories:[]},
    managed_root:'/clued-cloud/google-drive/synthetic-root',root_folder_id:'synthetic-root',root_parent_id:'my-drive',root_name:'Stale registered label',tracks:['资料'],
    created_by_clued:descriptor.created_by_clued,root_stop_generation:1,root_stopped:false,normal_use_enabled:false,refresh_enabled:false};
  const calls=[],provider=[],oauthCalls=[];let state,rootVersion='3',trashed=false,patches=0,prepared=false;
  const metadata=()=>({id:'synthetic-root',name:'Actual Drive folder',mimeType:'application/vnd.google-apps.folder',parents:['my-drive'],version:rootVersion,
    trashed,ownedByMe:true,isAppAuthorized:true,capabilities:{canTrash:true}});
  const lifecycle=await createStorageOwnerLifecycle({vault,oauth:{async start(...args){oauthCalls.push(args);return {authorization_url:'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic'};}},
    rpc:async input=>{
      calls.push(input);
      if(options.rpc) {const answer=await options.rpc(input,{descriptor,row});if(answer!==undefined)return answer;}
      if(input.action==='list')return {contract:'clued.storage-owner-lifecycle/1',complete:true,connections:[row]};
      if(input.action==='describe')return {...descriptor,...options.descriptor};
      if(input.action==='reconnect_begin')return {status:'prepared',connection_id:randomUUID(),attempt_id:randomUUID(),normal_use:input.confirmation.normal_use,refresh_enabled:false};
      if(input.action==='delete_prepare'){
        if(prepared)return {status:state,attempt_id:attempt,execution_permitted:false};prepared=true;state='prepared';
        return {status:'prepared',attempt_id:attempt,admission:attempt,expires_at:new Date(Date.now()+60000).toISOString()};
      }
      if(input.action==='delete_start'){if(state!=='prepared')throw new Error('storage_owner_lifecycle_replayed');state='started';return {status:'admitted',attempt_id:attempt};}
      if(input.action==='delete_revalidate'){if(state!=='started')throw new Error('storage_owner_lifecycle_replayed');return {status:'admitted',attempt_id:attempt};}
      if(input.action==='delete_observe'){
        if(input.outcome==='uncertain'){state='uncertain';return {status:'uncertain',attempt_id:attempt,execution_permitted:false};}
        state='completed';return {status:'completed',receipt_id:attempt,attempt_id:attempt,connection_id:connection,root_trashed:input.outcome==='trashed'};
      }
      if(input.action==='recover')return {status:state,attempt_id:attempt,execution_permitted:false,descriptor,snapshot:{root_version:'3'}};
      throw new Error('unknown fixture action');
    },fetch:async(url,init)=>{
      const u=new URL(url);provider.push({url:u,method:init.method??'GET'});
      assert.equal(init.redirect,'manual');assert.equal(init.headers.authorization,'Bearer synthetic-access-token');
      if(init.method==='PATCH'){
        patches++;assert.equal(init.headers['if-match'],'"synthetic-etag"');assert.deepEqual(JSON.parse(init.body),{trashed:true});
        if(options.lost){trashed=true;rootVersion='4';throw new Error('synthetic-access-token MUST NOT LEAK');}
        trashed=true;rootVersion='4';return Response.json(metadata());
      }
      if(options.fetch){const answer=await options.fetch(u,init,{calls,metadata});if(answer!==undefined)return answer;}
      if(u.pathname.endsWith('/files/root'))return Response.json({id:'my-drive',name:'我的云端硬盘',mimeType:'application/vnd.google-apps.folder',trashed:false});
      if(u.pathname.endsWith('/my-drive'))return Response.json({id:'my-drive',name:'我的云端硬盘',mimeType:'application/vnd.google-apps.folder',parents:[],trashed:false});
      if(u.pathname.endsWith('/files'))return Response.json({files:[],incompleteSearch:false});
      return Response.json(metadata(),{headers:{etag:'"synthetic-etag"'}});
    }});
  const base={connection_id:connection,base_version:2,profile_version:1,request_id:randomUUID()};
  const confirmation={contract:STORAGE_OWNER_CONFIRMATION,root_folder_id:'synthetic-root',confirmed:true,trash_created_root:true};
  const deletion=async()=>{const preview=await lifecycle.previewDelete(owner,connection);return {...base,confirmation:{...confirmation,root_version:preview.root_version,metadata_digest:preview.metadata_digest}};};
  return {lifecycle,owner,connection,calls,provider,oauthCalls,base,confirmation,deletion,patches:()=>patches,drift:()=>{rootVersion='9';}};
}
test('real metadata location is separate from virtual registration path; closed DTO has no credential fields',async()=>{
  const f=await fixture(),r=await f.lifecycle.list(f.owner),entry=r.connections[0];
  assert.equal(entry.physical_location.path,'我的云端硬盘 / Actual Drive folder');assert.equal(entry.managed_root,'/clued-cloud/google-drive/synthetic-root');
  assert.equal(entry.root_name,'Stale registered label');assert.doesNotMatch(JSON.stringify(r),/synthetic-access-token|credential_envelope|provider_subject|admission/);
});
test('only authenticated files/root alias permits omitted My Drive parents; ordinary ancestor missing parents denies location',async()=>{
  const f=await fixture({descriptor:{root_parent_id:'ordinary-parent'},fetch:u=>{
    if(u.pathname.endsWith('/synthetic-root'))return Response.json({id:'synthetic-root',name:'Folder',mimeType:'application/vnd.google-apps.folder',parents:['ordinary-parent'],version:'3',trashed:false,ownedByMe:true,isAppAuthorized:true});
    if(u.pathname.endsWith('/ordinary-parent'))return Response.json({id:'ordinary-parent',name:'Not root',mimeType:'application/vnd.google-apps.folder',trashed:false});
  }});
  assert.equal((await f.lifecycle.list(f.owner)).connections[0].physical_location.status,'unavailable');
  const g=await fixture({rpc:(input,{row})=>input.action==='list'?{contract:'clued.storage-owner-lifecycle/1',complete:true,connections:[{...row,access_digest_missing:{count:1,directories:[{path:'资料',since:new Date().toISOString(),secret:'reject'}]}}]}:undefined});
  await assert.rejects(g.lifecycle.list(g.owner));
});
test('reconnect creates new CID via Native RPC, always refresh OFF; browser owner/admission keys rejected before RPC',async()=>{
  const f=await fixture(),value={...f.base,root_stop_generation:1,confirmation:{contract:STORAGE_OWNER_CONFIRMATION,root_folder_id:'synthetic-root',confirmed:true,normal_use:false}};
  const r=await f.lifecycle.reconnect(f.owner,value);assert.notEqual(r.connection_id,f.connection);assert.deepEqual(f.oauthCalls[0],[r.connection_id,false,'keep']);
  const count=f.calls.length;await assert.rejects(f.lifecycle.reconnect(f.owner,{...value,owner_id:randomUUID()}));assert.equal(f.calls.length,count);assert.equal(f.patches(),0);
});
test('picked/legacy root provenance cannot issue a trash request; connection-only hide makes no Drive request',async()=>{
  const f=await fixture({created:false});assert.deepEqual(await f.lifecycle.previewDelete(f.owner,f.connection),{trash_available:false,reason:'picked_or_legacy_root'});
  await assert.rejects(f.lifecycle.delete(f.owner,{...f.base,confirmation:{...f.confirmation,root_version:'3',metadata_digest:'a'.repeat(64)}}));assert.equal(f.patches(),0);
  const before=f.provider.length;const r=await f.lifecycle.delete(f.owner,{...f.base,confirmation:{contract:STORAGE_OWNER_CONFIRMATION,root_folder_id:'synthetic-root',confirmed:true,trash_created_root:false}});
  assert.equal(r.root_trashed,false);assert.equal(f.provider.length,before);assert.ok(!Object.hasOwn(r,'admission'));
});
test('expired credential and foreign descriptor cannot fetch or acquire an admission',async()=>{
  for(const options of [{expired:true},{descriptor:{owner_id:randomUUID()}}]){const f=await fixture(options);await assert.rejects(f.lifecycle.previewDelete(f.owner,f.connection));assert.equal(f.provider.length,0);assert.equal(f.calls.some(c=>c.action==='delete_prepare'),false);}
});
test('hard byte streaming limit cancels upstream before parsing oversized JSON',async()=>{
  let cancelled=false;
  const f=await fixture({fetch:u=>u.pathname.endsWith('/synthetic-root')?new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(270000));},cancel(){cancelled=true;}})):undefined});
  await assert.rejects(f.lifecycle.previewDelete(f.owner,f.connection));assert.equal(cancelled,true);assert.equal(f.patches(),0);
});
test('arbitrary pagination loops and incomplete search fail closed before admission',async()=>{
  let pages=0;const f=await fixture({fetch:u=>u.pathname.endsWith('/files')?Response.json({files:[],nextPageToken:['A','B','A'][pages++]}):undefined});
  await assert.rejects(f.lifecycle.previewDelete(f.owner,f.connection));assert.equal(pages,3);assert.equal(f.patches(),0);
  const g=await fixture({fetch:u=>u.pathname.endsWith('/files')?Response.json({files:[],incompleteSearch:true}):undefined});await assert.rejects(g.lifecycle.previewDelete(g.owner,g.connection));assert.equal(g.patches(),0);
});
test('metadata traversal enforces one overall deadline and rejects incomplete Native list instead of treating absence as deletion',async t=>{
  const before=Date.now();let now=before;
  const f=await fixture({fetch:u=>{now=before+26000;return undefined;}});
  t.mock.method(Date,'now',()=>now);
  await assert.rejects(f.lifecycle.previewDelete(f.owner,f.connection));assert.equal(f.patches(),0);
  t.mock.restoreAll();
  const g=await fixture({rpc:input=>input.action==='list'?{contract:'clued.storage-owner-lifecycle/1',complete:false,connections:[]}:undefined});
  await assert.rejects(g.lifecycle.list(g.owner));
});
test('changed provider metadata after Owner preview refuses before DB prepare or PATCH',async()=>{
  const f=await fixture(),value=await f.deletion();f.drift();await assert.rejects(f.lifecycle.delete(f.owner,value));
  assert.equal(f.calls.some(c=>c.action==='delete_prepare'),false);assert.equal(f.patches(),0);
});
test('metadata drift after durable start remains uncertain and cannot send provider PATCH',async()=>{
  const f=await fixture({fetch:(u,init,{calls,metadata})=>u.pathname.endsWith('/synthetic-root')&&calls.some(c=>c.action==='delete_start')
    ?Response.json({...metadata(),version:'9'},{headers:{etag:'"changed-etag"'}}):undefined});
  const result=await f.lifecycle.delete(f.owner,await f.deletion());assert.equal(result.status,'uncertain');assert.equal(f.patches(),0);
});
test('successful trash uses a single guarded PATCH, preserves recovery semantics and redacts internal fields',async()=>{
  const f=await fixture(),r=await f.lifecycle.delete(f.owner,await f.deletion());assert.equal(r.status,'completed');assert.equal(r.root_trashed,true);assert.equal(f.patches(),1);
  const start=f.calls.findIndex(c=>c.action==='delete_start'),lastCheck=f.calls.findIndex(c=>c.action==='delete_revalidate');assert.ok(start>=0&&lastCheck>start);
  assert.doesNotMatch(JSON.stringify(r),/admission|credential|synthetic-access-token|synthetic-refresh-token/);
});
test('lost PATCH completion is never retried; recovery only GET observes and settles',async()=>{
  const f=await fixture({lost:true}),value=await f.deletion(),result=await f.lifecycle.delete(f.owner,value);assert.equal(result.status,'uncertain');assert.equal(f.patches(),1);
  const done=await f.lifecycle.recover(f.owner,result.attempt_id);assert.equal(done.status,'completed');assert.equal(f.patches(),1);
  await assert.rejects(f.lifecycle.delete(f.owner,value),e=>e.reason==='root_drift');assert.equal(f.patches(),1);
});
test('Native revalidation refusal cannot send PATCH or leak arbitrary database/upstream text',async()=>{
  const f=await fixture({rpc:input=>{if(input.action==='delete_revalidate')throw new Error('synthetic-refresh-token secret in error');}});
  const result=await f.lifecycle.delete(f.owner,await f.deletion());assert.equal(result.status,'uncertain');assert.equal(f.patches(),0);
  assert.doesNotMatch(JSON.stringify(result),/synthetic-refresh-token/);
});
test('unknown prepare completion only looks up the request; never retries a Native write or starts Drive effect',async()=>{
  const recovered=randomUUID();
  const f=await fixture({rpc:input=>{
    if(input.action==='delete_prepare')throw new Error('lost native completion with synthetic-refresh-token');
    if(input.action==='recover_request')return {status:'prepared',attempt_id:recovered,execution_permitted:false};
  }});
  const result=await f.lifecycle.delete(f.owner,{...f.base,confirmation:{contract:STORAGE_OWNER_CONFIRMATION,root_folder_id:'synthetic-root',confirmed:true,trash_created_root:false}});
  assert.deepEqual(result,{status:'recovery_required',attempt_id:recovered,execution_permitted:false});
  assert.equal(f.calls.filter(c=>c.action==='delete_prepare').length,1);assert.equal(f.calls.filter(c=>c.action==='recover_request').length,1);
  assert.equal(f.calls.some(c=>c.action==='delete_start'),false);assert.equal(f.provider.length,0);
});
test('reconnect recovery projects waiting/cancelled read-only state, never starts another OAuth or Drive request',async()=>{
  for(const status of ['waiting','cancelled']){
    const f=await fixture({rpc:input=>input.action==='recover'?{status,operation:'reconnect',expires_at:new Date().toISOString(),execution_permitted:false}:undefined});
    const result=await f.lifecycle.recover(f.owner,randomUUID());assert.equal(result.status,status);assert.equal(result.execution_permitted,false);
    assert.equal(f.oauthCalls.length,0);assert.equal(f.provider.length,0);assert.equal(f.calls.length,1);
  }
});

test('missing or weak provider ETag has a safe explicit reason and never qualifies a trash write',async()=>{
  for(const etag of [undefined,'W/"provider-version"','unquoted']){
    const f=await fixture({fetch:(u,init,{metadata})=>u.pathname.endsWith('/synthetic-root')
      ?Response.json(metadata(),{headers:etag===undefined?{}:{etag}}):undefined});
    const preview=await f.lifecycle.previewDelete(f.owner,f.connection);
    assert.equal(preview.trash_available,false);assert.equal(preview.reason,'conditional_capability_unavailable');
    assert.equal(preview.connection_version,2);assert.equal(preview.profile_version,1);
    await assert.rejects(f.lifecycle.delete(f.owner,{...f.base,confirmation:{...f.confirmation,
      root_version:preview.root_version,metadata_digest:preview.metadata_digest}}),e=>e.reason==='root_drift');
    assert.equal(f.calls.some(c=>c.action==='delete_prepare'),false);assert.equal(f.patches(),0);
    assert.doesNotMatch(JSON.stringify(preview),/provider-version|etag|credential|synthetic-access-token|synthetic-refresh-token/);
  }
});

test('Google canTrash refusal is distinct from missing conditional capability, without admission',async()=>{
  for(const capabilities of [{canTrash:false},{}]){
    const f=await fixture({fetch:(u,init,{metadata})=>u.pathname.endsWith('/synthetic-root')
      ?Response.json({...metadata(),capabilities}):undefined});
    const preview=await f.lifecycle.previewDelete(f.owner,f.connection);
    assert.equal(preview.trash_available,false);assert.equal(preview.reason,'can_trash_unavailable');
    assert.equal(f.patches(),0);assert.ok(f.calls.every(c=>c.action==='describe'));
  }
});

test('root metadata and full inventory failures preserve distinct fixed reasons, never upstream text',async()=>{
  for(const [path,reason] of [['/synthetic-root','metadata_unavailable'],['/files','inventory_unavailable']]){
    const f=await fixture({fetch:u=>u.pathname.endsWith(path)?new Response('synthetic-refresh-token private provider details',{status:503}):undefined});
    await assert.rejects(f.lifecycle.previewDelete(f.owner,f.connection),e=>e.reason===reason
      &&e.message==='storage_owner_lifecycle_unavailable'&&!e.message.includes('private'));
    assert.equal(f.patches(),0);assert.ok(f.calls.every(c=>c.action==='describe'));
  }
});

test('authorization and current connection qualification failures are safe and make no provider request',async()=>{
  const expired=await fixture({expired:true});
  await assert.rejects(expired.lifecycle.previewDelete(expired.owner,expired.connection),e=>e.reason==='fresh_authorization_required');
  const stale=await fixture({rpc:input=>{if(input.action==='describe')throw new Error('storage_connection_unavailable');}});
  await assert.rejects(stale.lifecycle.previewDelete(stale.owner,stale.connection),e=>e.reason==='storage_connection_unavailable');
  for(const f of [expired,stale]){assert.equal(f.provider.length,0);assert.equal(f.patches(),0);assert.ok(f.calls.every(c=>c.action==='describe'));}
});

test('root identity drift and bounded traversal deadline retain their reason without authorizing effects',async t=>{
  const drift=await fixture({fetch:(u,init,{metadata})=>u.pathname.endsWith('/synthetic-root')
    ?Response.json({...metadata(),parents:['moved-parent']}):undefined});
  await assert.rejects(drift.lifecycle.previewDelete(drift.owner,drift.connection),e=>e.reason==='root_drift');
  const before=Date.now();let now=before;
  const timeout=await fixture({fetch:()=>{now=before+26000;return undefined;}});
  t.mock.method(Date,'now',()=>now);
  await assert.rejects(timeout.lifecycle.previewDelete(timeout.owner,timeout.connection),e=>e.reason==='operation_deadline');
  t.mock.restoreAll();
  for(const f of [drift,timeout]){assert.equal(f.patches(),0);assert.ok(f.calls.every(c=>c.action==='describe'));}
});
