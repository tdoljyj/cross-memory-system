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
const readOutput=path.join(dir,'read-agent.mjs');
await build({entryPoints:[fileURLToPath(new URL('../worker/storage-owner-lifecycle.ts',import.meta.url))],outfile:output,bundle:true,platform:'node',format:'esm'});
await build({entryPoints:[fileURLToPath(new URL('../worker/storage-credential-vault.ts',import.meta.url))],outfile:vaultOutput,bundle:true,platform:'node',format:'esm'});
await build({entryPoints:[fileURLToPath(new URL('../worker/storage-read-agent.ts',import.meta.url))],outfile:readOutput,bundle:true,platform:'node',format:'esm'});
const {createStorageOwnerLifecycle,STORAGE_OWNER_CONFIRMATION,STORAGE_OWNER_WHOLE_ROOT_CONFIRMATION,STORAGE_OWNER_WHOLE_ROOT_MODE}=await import(pathToFileURL(output));
const {createStorageCredentialVault}=await import(pathToFileURL(vaultOutput));
const {createStorageReadAgent,StorageReadError}=await import(pathToFileURL(readOutput));
test.after(()=>rm(dir,{recursive:true,force:true}));
async function fixture(options={}){
  const owner=randomUUID(),connection=randomUUID(),profile=randomUUID(),project=randomUUID(),attempt=randomUUID();
  const vault={current_key_id:'test',keys:{test:randomBytes(32).toString('base64url')}},storage=await createStorageCredentialVault(vault);
  const ctx={owner_id:owner,connection_id:connection,provider:'google-drive',provider_subject:'synthetic-provider-owner',oauth_client_id:'synthetic.apps.googleusercontent.com',credential_version:1};
  const envelope=await storage.seal(JSON.stringify({access_token:'synthetic-access-token',refresh_token:'synthetic-refresh-token',token_type:'Bearer',scope:'synthetic',expires_at_ms:Date.now()+(options.expired?-1:3600000)}),ctx);
  const descriptor={...ctx,connection_version:2,profile_id:profile,profile_version:1,credential_envelope:envelope,root_folder_id:'synthetic-root',root_parent_id:'my-drive',created_by_clued:options.created!==false,
    ...(options.whole?{root_trash_confirmation_mode:STORAGE_OWNER_WHOLE_ROOT_MODE}:{})};
  const row={id:connection,version:2,provider:'google-drive',state:'active',auth_mode:'account_policy',profile_id:profile,profile_version:1,project_id:project,
    policy_active:true,actions:['inspect','create_file','create_topic'],database_execution_enabled:true,profile_current:true,access_digest_missing:{count:0,directories:[]},
    managed_root:'/clued-cloud/google-drive/synthetic-root',root_folder_id:'synthetic-root',root_parent_id:'my-drive',root_name:'Stale registered label',tracks:['资料'],
    created_by_clued:descriptor.created_by_clued,root_stop_generation:1,root_stopped:false,normal_use_enabled:false,refresh_enabled:false};
  const calls=[],provider=[],oauthCalls=[];let state,rootVersion='3',trashed=false,patches=0,prepared=false,savedConfirmation;
  const metadata=()=>({id:'synthetic-root',name:'Actual Drive folder',mimeType:'application/vnd.google-apps.folder',parents:['my-drive'],version:rootVersion,
    trashed,ownedByMe:true,isAppAuthorized:true,capabilities:{canTrash:true}});
  const lifecycle=await createStorageOwnerLifecycle({vault,oauth:{async start(...args){oauthCalls.push(args);return {authorization_url:'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic'};}},
    ...(options.clock?{clock:options.clock}:{}),
    ...(options.preflight?{credential_preflight:async(...args)=>options.preflight(...args,{descriptor,row})}:{}),
    rpc:async input=>{
      calls.push(input);
      if(options.rpc) {const answer=await options.rpc(input,{descriptor,row});if(answer!==undefined)return answer;}
      if(input.action==='list')return {contract:'clued.storage-owner-lifecycle/1',complete:true,connections:[row]};
      if(input.action==='describe')return {...descriptor,...options.descriptor};
      if(input.action==='reconnect_begin')return {status:'prepared',connection_id:randomUUID(),attempt_id:randomUUID(),normal_use:input.confirmation.normal_use,refresh_enabled:false};
      if(input.action==='delete_prepare'){
        if(prepared)return {status:state,attempt_id:attempt,execution_permitted:false};prepared=true;state='prepared';savedConfirmation=structuredClone(input.confirmation);
        return {status:'prepared',attempt_id:attempt,admission:attempt,expires_at:new Date(Date.now()+60000).toISOString()};
      }
      if(input.action==='delete_start'){if(state!=='prepared')throw new Error('storage_owner_lifecycle_replayed');state='started';return {status:'admitted',attempt_id:attempt};}
      if(input.action==='delete_revalidate'){if(state!=='started')throw new Error('storage_owner_lifecycle_replayed');return {status:'admitted',attempt_id:attempt};}
      if(input.action==='delete_observe'){
        if(input.outcome==='uncertain'){state='uncertain';return {status:'uncertain',attempt_id:attempt,execution_permitted:false};}
        state='completed';return {status:'completed',receipt_id:attempt,attempt_id:attempt,connection_id:connection,root_trashed:input.outcome==='trashed'};
      }
      if(input.action==='recover')return {status:state,attempt_id:attempt,execution_permitted:false,descriptor,snapshot:{root_version:'3'},
        ...(savedConfirmation?.contract===STORAGE_OWNER_WHOLE_ROOT_CONFIRMATION?{confirmation_contract:savedConfirmation.contract,confirmation_mode:savedConfirmation.confirmation_mode}:{})};
      throw new Error('unknown fixture action');
    },fetch:async(url,init)=>{
      const u=new URL(url);provider.push({url:u,method:init.method??'GET'});
      assert.equal(init.redirect,'manual');assert.equal(init.headers.authorization,'Bearer synthetic-access-token');
      if(init.method==='PATCH'){
        patches++;assert.equal(init.headers['if-match'],savedConfirmation?.contract===STORAGE_OWNER_WHOLE_ROOT_CONFIRMATION?undefined:'"synthetic-etag"');assert.deepEqual(JSON.parse(init.body),{trashed:true});
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

test('list reloads safe current state after renewal; the returned CAS is usable by the next Owner action',async()=>{
  const f=await fixture({preflight:async(owner,connection,operation,{descriptor,row})=>{
    assert.equal(operation,'owner_metadata');descriptor.connection_version=3;row.version=3;
    row.refresh_enabled=true;return {status:'ready',credential_version:1};
  }});
  const entry=(await f.lifecycle.list(f.owner)).connections[0];
  assert.equal(entry.version,3);assert.equal(entry.refresh_enabled,true);
  assert.equal(entry.physical_location.status,'verified');
  assert.equal(f.calls.filter(x=>x.action==='list').length,2);
  assert.doesNotMatch(JSON.stringify(entry),/credential_envelope|provider_subject|synthetic-access-token/);
});

test('list discards provider observations when current Native state changes after preflight',async()=>{
  let lists=0;
  const f=await fixture({preflight:async()=>({status:'ready',credential_version:1}),rpc:(input,{row})=>{
    if(input.action==='list'&&++lists===2)return {contract:'clued.storage-owner-lifecycle/1',complete:true,
      connections:[{...row,version:4,state:'revoked',auth_mode:'revoked',root_stopped:true,refresh_enabled:false}]};
  }});
  const entry=(await f.lifecycle.list(f.owner)).connections[0];
  assert.equal(entry.version,4);assert.equal(entry.state,'revoked');assert.equal(entry.refresh_enabled,false);
  assert.equal(entry.physical_location.status,'unavailable');
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
test('legacy reconnect creates new CID via Native RPC with refresh OFF; browser owner/admission keys rejected before RPC',async()=>{
  const f=await fixture(),value={...f.base,root_stop_generation:1,confirmation:{contract:STORAGE_OWNER_CONFIRMATION,root_folder_id:'synthetic-root',confirmed:true,normal_use:false}};
  const r=await f.lifecycle.reconnect(f.owner,value);assert.notEqual(r.connection_id,f.connection);assert.deepEqual(f.oauthCalls[0],[r.connection_id,false,'keep']);
  const count=f.calls.length;await assert.rejects(f.lifecycle.reconnect(f.owner,{...value,owner_id:randomUUID()}));assert.equal(f.calls.length,count);assert.equal(f.patches(),0);
});

test('fresh reconnect binds the default renewal choice to Native consent; invalid or omitted choices never start OAuth',async()=>{
  for(const default_refresh of [true,false]){
    const f=await fixture(),value={...f.base,root_stop_generation:1,confirmation:{
      contract:'clued.storage-owner-confirmation/4',root_folder_id:'synthetic-root',confirmed:true,
      master_enabled:true,disclosure_version:'clued.storage-master-disclosure/1',default_refresh,
      refresh_disclosure_version:'clued.storage-reconnect-refresh-disclosure/1'}};
    const r=await f.lifecycle.reconnect(f.owner,value);
    assert.equal(r.refresh_requested,default_refresh);assert.equal(r.refresh_enabled,false,'renewal requires successful Google callback');
    assert.deepEqual(f.calls.find(x=>x.action==='reconnect_begin').confirmation,value.confirmation);
    assert.deepEqual(f.oauthCalls[0],[r.connection_id,false,'full',{disclosure_version:'clued.storage-master-disclosure/1'}]);
    const count=f.calls.length;
    for(const confirmation of [
      {...value.confirmation,default_refresh:'true'},
      {...value.confirmation,default_refresh:undefined},
      {...value.confirmation,refresh_disclosure_version:'clued.storage-master-disclosure/1'},
      {...value.confirmation,until_revoked:true},
    ])await assert.rejects(f.lifecycle.reconnect(f.owner,{...value,confirmation}));
    assert.equal(f.calls.length,count);
  }
});

test('reconnect callback projects actual renewal truth without another OAuth exchange',async()=>{
  for(const refresh_enabled of [true,false]){
    const f=await fixture({rpc:input=>input.action==='reconnect_activate'?{
      status:'completed',receipt_id:randomUUID(),connection_id:randomUUID(),refresh_enabled}:undefined});
    assert.equal((await f.lifecycle.completeReconnect(f.owner,'a'.repeat(43))).refresh_enabled,refresh_enabled);
    assert.equal(f.oauthCalls.length,0);
  }
});

test('master reconnect has its own confirmation and requests full Google scope, without carrying stopped legacy permissions',async()=>{
  const f=await fixture(),value={...f.base,root_stop_generation:1,confirmation:{
    contract:'clued.storage-owner-confirmation/3',root_folder_id:'synthetic-root',confirmed:true,
    master_enabled:true,disclosure_version:'clued.storage-master-disclosure/1'}};
  const r=await f.lifecycle.reconnect(f.owner,value);
  assert.notEqual(r.connection_id,f.connection);
  assert.deepEqual(f.oauthCalls[0],[r.connection_id,false,'full',{disclosure_version:'clued.storage-master-disclosure/1'}]);
  assert.deepEqual(f.calls.find(x=>x.action==='reconnect_begin').confirmation,value.confirmation);
  assert.equal('normal_use' in value.confirmation,false);
  assert.equal(f.patches(),0);
  const count=f.calls.length;
  for(const confirmation of [
    {...value.confirmation,disclosure_version:'clued.storage-full-scope-disclosure/1'},
    {...value.confirmation,normal_use:true},
    {...value.confirmation,confirmed:false},
    {...value.confirmation,master_enabled:'true'},
  ]) await assert.rejects(f.lifecycle.reconnect(f.owner,{...value,confirmation}));
  assert.equal(f.calls.length,count,'invalid consent is refused before RPC or another OAuth attempt');
  const g=await fixture();
  const off=await g.lifecycle.reconnect(g.owner,{...g.base,root_stop_generation:1,confirmation:{...value.confirmation,master_enabled:false}});
  assert.deepEqual(g.oauthCalls[0],[off.connection_id,false,'keep']);
});

test('reconnect completion projects master truth only with an actual matching full scope',async()=>{
  for(const provider_scope_profile of ['normal','full']){
    const f=await fixture({rpc:input=>input.action==='reconnect_activate'?{
      status:'completed',receipt_id:randomUUID(),connection_id:input.connection_id??'10000000-0000-4000-8000-000000000001',
      master_state:'on',provider_scope_profile}:undefined});
    const state='a'.repeat(43);
    if(provider_scope_profile==='normal') await assert.rejects(f.lifecycle.completeReconnect(f.owner,state));
    else assert.equal((await f.lifecycle.completeReconnect(f.owner,state)).master_state,'on');
    assert.equal(f.oauthCalls.length,0,'projection never starts authorization or replays token exchange');
  }
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
test('expired credential during an unknown Root trash recovery never replays PATCH or uses ordinary quiet-root preflight',async()=>{
  let now=Date.now(),preflights=0;
  const f=await fixture({lost:true,clock:()=>now,preflight:async()=>{preflights++;return {status:'ready',credential_version:1};}});
  const uncertain=await f.lifecycle.delete(f.owner,await f.deletion());assert.equal(uncertain.status,'uncertain');assert.equal(f.patches(),1);
  const calls=preflights,provider=f.provider.length;now+=3600001;
  await assert.rejects(f.lifecycle.recover(f.owner,uncertain.attempt_id),error=>error.reason==='fresh_authorization_required');
  assert.equal(preflights,calls);assert.equal(f.provider.length,provider);assert.equal(f.patches(),1);
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

const wholeValue=f=>({...f.base,confirmation:{contract:STORAGE_OWNER_WHOLE_ROOT_CONFIRMATION,
  root_folder_id:'synthetic-root',confirmed:true,trash_created_root:true,confirmation_mode:STORAGE_OWNER_WHOLE_ROOT_MODE}});
const noEtag=(u,init,{metadata})=>u.pathname.endsWith('/synthetic-root')?Response.json(metadata()):undefined;

test('V2 explicitly advertised whole Root supports no ETag, one Root PATCH and no shortcut target effects',async()=>{
  const f=await fixture({whole:true,fetch:(u,init,ctx)=>u.pathname.endsWith('/files')
    ?Response.json({files:[{id:'shortcut',name:'External shortcut',mimeType:'application/vnd.google-apps.shortcut',parents:['synthetic-root'],version:'2',trashed:false}],incompleteSearch:false})
    :noEtag(u,init,ctx)});
  const preview=await f.lifecycle.previewDelete(f.owner,f.connection);
  assert.equal(preview.trash_available,true);assert.equal(preview.confirmation_contract,STORAGE_OWNER_WHOLE_ROOT_CONFIRMATION);
  assert.equal(preview.confirmation_mode,STORAGE_OWNER_WHOLE_ROOT_MODE);assert.equal(preview.item_count,1);
  const result=await f.lifecycle.delete(f.owner,wholeValue(f));assert.equal(result.root_trashed,true);assert.equal(f.patches(),1);
  const writes=f.provider.filter(r=>r.method!=='GET');assert.equal(writes.length,1);assert.equal(writes[0].method,'PATCH');
  assert.equal(writes[0].url.pathname,'/drive/v3/files/synthetic-root');assert.equal(f.provider.some(r=>r.url.pathname.endsWith('/shortcut')),false);
  assert.equal(f.calls.filter(c=>c.action==='delete_revalidate').length,1);
  assert.deepEqual(f.calls.find(c=>c.action==='delete_prepare').confirmation,wholeValue(f).confirmation);
  assert.doesNotMatch(JSON.stringify([preview,result]),/credential|admission|synthetic-access-token|synthetic-refresh-token/);
});

test('V2 missing or unknown backend capability cannot use a caller-selected mode, and V1 still requires strong ETag',async()=>{
  for(const capability of [undefined,'whole_created_root_v3']){
    const f=await fixture({descriptor:{root_trash_confirmation_mode:capability},fetch:noEtag});
    const preview=await f.lifecycle.previewDelete(f.owner,f.connection);assert.equal(preview.trash_available,false);
    assert.equal(preview.confirmation_mode,undefined);assert.equal(preview.reason,'conditional_capability_unavailable');
    const before=f.provider.length;
    await assert.rejects(f.lifecycle.delete(f.owner,wholeValue(f)),e=>e.reason==='whole_root_trash_unavailable');
    assert.equal(f.provider.length,before);assert.equal(f.patches(),0);assert.ok(f.calls.every(c=>c.action==='describe'));
  }
  const f=await fixture({whole:true,fetch:noEtag});
  await assert.rejects(f.lifecycle.delete(f.owner,await f.deletion()),e=>e.reason==='root_drift');
  assert.equal(f.calls.some(c=>c.action==='delete_prepare'),false);assert.equal(f.patches(),0);
  const oversized=await fixture({whole:true,fetch:(u,init,{metadata})=>u.pathname.endsWith('/synthetic-root')
    ?Response.json(metadata(),{headers:{etag:'a'.repeat(205)}}):undefined});
  await assert.rejects(oversized.lifecycle.previewDelete(oversized.owner,oversized.connection),e=>e.reason==='metadata_unavailable');
  await assert.rejects(oversized.lifecycle.delete(oversized.owner,wholeValue(oversized)),e=>e.reason==='metadata_unavailable');
  assert.equal(oversized.calls.some(c=>c.action==='delete_prepare'),false);assert.equal(oversized.patches(),0);
});

test('V2 confirmation cannot mix V1 snapshot fields, change mode, spoof Owner or request connection-only V2',async()=>{
  const f=await fixture({whole:true});
  for(const confirmation of [{...wholeValue(f).confirmation,metadata_digest:'a'.repeat(64),root_version:'3'},
    {...wholeValue(f).confirmation,confirmation_mode:'exact_snapshot_v1'},
    {...wholeValue(f).confirmation,confirmed:false},{...wholeValue(f).confirmation,trash_created_root:false}]){
    await assert.rejects(f.lifecycle.delete(f.owner,{...f.base,confirmation}),e=>e.reason==='confirmation_required');
  }
  await assert.rejects(f.lifecycle.delete(f.owner,{...wholeValue(f),owner_id:randomUUID()}),e=>e.reason==='input_invalid');
  assert.equal(f.calls.length,0);assert.equal(f.provider.length,0);
});

test('V2 preserves created provenance, connection/profile CAS and real canTrash checks before admission',async()=>{
  for(const options of [{created:false},{descriptor:{connection_version:9}},{descriptor:{profile_version:9}},
    {fetch:(u,init,{metadata})=>u.pathname.endsWith('/synthetic-root')?Response.json({...metadata(),capabilities:{canTrash:false}}):undefined}]){
    const f=await fixture({whole:true,...options});await assert.rejects(f.lifecycle.delete(f.owner,wholeValue(f)));
    assert.equal(f.patches(),0);assert.equal(f.calls.some(c=>c.action==='delete_prepare'),false);
  }
});

test('V2 accepts content observed at execution after preview, but rejects drift between both pre-effect inventories',async()=>{
  const f=await fixture({whole:true,fetch:noEtag});await f.lifecycle.previewDelete(f.owner,f.connection);f.drift();
  assert.equal((await f.lifecycle.delete(f.owner,wholeValue(f))).root_trashed,true);assert.equal(f.patches(),1);
  const g=await fixture({whole:true,fetch:(u,init,{calls,metadata})=>u.pathname.endsWith('/files')&&calls.some(c=>c.action==='delete_start')
    ?Response.json({files:[{id:'new-item',name:'Concurrent item',mimeType:'text/plain',parents:['synthetic-root'],version:'1',trashed:false}],incompleteSearch:false})
    :u.pathname.endsWith('/synthetic-root')?Response.json(metadata()):undefined});
  assert.equal((await g.lifecycle.delete(g.owner,wholeValue(g))).status,'uncertain');assert.equal(g.patches(),0);
  assert.equal(g.calls.some(c=>c.action==='delete_revalidate'),false);
});

test('V2 post-effect fixed Root observation tolerates later parent/name/version drift, while V1 keeps its guard',async()=>{
  for(const whole of [true,false]){
    const f=await fixture({whole,fetch:(u,init,{metadata})=>u.pathname.endsWith('/synthetic-root')&&metadata().trashed
      ?Response.json({...metadata(),name:'Externally renamed',parents:['external-parent'],version:'99'}):undefined});
    const result=await f.lifecycle.delete(f.owner,whole?wholeValue(f):await f.deletion());
    assert.equal(result.status,whole?'completed':'uncertain');assert.equal(f.patches(),1);
  }
});

test('V2 lost PATCH reply recovers by GET only with durable mode; repeating delete cannot PATCH again',async()=>{
  const f=await fixture({whole:true,lost:true,fetch:(u,init,{metadata})=>u.pathname.endsWith('/synthetic-root')&&metadata().trashed
    ?Response.json({...metadata(),name:'Changed after effect',parents:['external-parent'],version:'100'}):noEtag(u,init,{metadata})});
  const result=await f.lifecycle.delete(f.owner,wholeValue(f));assert.equal(result.status,'uncertain');assert.equal(f.patches(),1);
  const recovered=await f.lifecycle.recover(f.owner,result.attempt_id);assert.equal(recovered.root_trashed,true);assert.equal(f.patches(),1);
  await assert.rejects(f.lifecycle.delete(f.owner,wholeValue(f)),e=>e.reason==='root_drift');assert.equal(f.patches(),1);
});

test('V2 fixed Root identity and incomplete durable mode refuse recovery without an effect',async()=>{
  for(const mode of [{confirmation_contract:STORAGE_OWNER_WHOLE_ROOT_CONFIRMATION},
    {confirmation_contract:STORAGE_OWNER_WHOLE_ROOT_CONFIRMATION,confirmation_mode:'unknown'}]){
    const f=await fixture({whole:true,rpc:(input,{descriptor})=>input.action==='recover'
      ?{status:'uncertain',descriptor,snapshot:{root_version:'3'},...mode}:undefined});
    await assert.rejects(f.lifecycle.recover(f.owner,randomUUID()),e=>e.reason==='root_drift');assert.equal(f.patches(),0);
  }
  const f=await fixture({whole:true,fetch:(u,init,{metadata})=>u.pathname.endsWith('/synthetic-root')&&metadata().trashed
    ?Response.json({...metadata(),id:'foreign-root'}):undefined});
  const result=await f.lifecycle.delete(f.owner,wholeValue(f));assert.equal(result.status,'uncertain');assert.equal(f.patches(),1);
  await assert.rejects(f.lifecycle.recover(f.owner,result.attempt_id),e=>e.reason==='root_drift');assert.equal(f.patches(),1);
});

// Read preparation shares the same demand renewal contract as Owner metadata,
// but must never replay an admitted operation or send a denied read to Drive.
async function readFixture(options={}){
  let now=1_700_000_000_000;
  const context={owner_id:randomUUID(),connection_id:randomUUID(),provider:'google-drive',provider_subject:'synthetic-read-owner',
    oauth_client_id:'synthetic-read-client',credential_version:3};
  const keys={current_key_id:'test',keys:{test:randomBytes(32).toString('base64url')}},vault=await createStorageCredentialVault(keys);
  const envelope=await vault.seal(JSON.stringify({token_type:'Bearer',access_token:'synthetic-private-read-access-token',
    scope:'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/drive.readonly',
    expires_at_ms:now+(options.expired?1000:3600000)}),context);
  const calls=[],preflights=[],pauses=[],provider=[],receipt=randomUUID();
  const advance=ms=>{now+=ms;};
  const agent=await createStorageReadAgent({client_id:context.oauth_client_id,vault:keys,
    receipt_keys:{current:'k1',keys:{k1:randomBytes(32).toString('base64')}},cursor_key:randomBytes(32).toString('base64'),
    clock:()=>now,pause:async ms=>{pauses.push(ms);if(options.pause)return options.pause(ms,{advance});advance(ms);},
    credential_preflight:async request=>{preflights.push(structuredClone(request));
      assert.equal(calls.length,0,'all preparation remains before admission');
      assert.equal(provider.length,0,'all preparation remains before Drive');
      return options.preflight?options.preflight(preflights.length,{advance,request}):{status:'ready',credential_version:3};},
    rpc:async value=>{calls.push(value);const input=value.input;
      if(input.action==='finalize')return {status:'completed'};
      assert.equal(input.action,'admit');
      if(options.deny)throw new Error('storage_read_denied synthetic-private-proof');
      return {contract:'clued.storage-read-admission/1',receipt_id:receipt,class:'read',...context,
        binding_id:randomUUID(),read_generation:2,root_folder_id:'synthetic-read-root',provider_scope_profile:'normal',
        content_profile:'normal/1',credential_envelope:envelope,...options.admission};},
    fetch:async(url,init)=>{provider.push({url:String(url),method:init.method});
      assert.equal(calls.filter(c=>c.input.action==='admit').length,1);
      assert.equal(calls.some(c=>c.input.action==='finalize'),false);
      if(options.providerFailure)throw new Error('synthetic-private-provider-error');
      const ids=[...String(init.body).matchAll(/Content-ID: <([^>]+)>/g)].map(match=>match[1]);
      assert.ok(ids.length>0);const boundary='synthetic-read-boundary';
      const body=ids.map(id=>`--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <response-${id}>\r\n\r\n`+
        `HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({files:[],incompleteSearch:false})}\r\n`).join('')+`--${boundary}--\r\n`;
      return new Response(body,{headers:{'content-type':`multipart/mixed; boundary=${boundary}`}});
    }});
  return {run:()=>agent.run('c'.repeat(64),{connection_id:context.connection_id,operation:'list'}),calls,preflights,pauses,provider,advance,receipt};
}
const preflightError=pattern=>error=>error.code==='storage_read_unavailable'&&pattern.test(error.detail?.hint??'')&&
  !/synthetic-private|unfinished|same root|has expired/.test(JSON.stringify(error.detail));
const noAdmittedRead=f=>{assert.equal(f.calls.length,0);assert.equal(f.provider.length,0);};
const finalizedRead=(f,complete)=>{
  assert.deepEqual(f.calls.map(c=>c.input.action),['admit','finalize']);
  assert.equal(f.calls[1].input.receipt_id,f.receipt);assert.equal(f.calls[1].input.complete,complete);
  assert.equal(f.calls[1].input.byte_count,0);
};

test('read pending preparation rechecks the same authorized request and automatically completes once ready',async()=>{
  const f=await readFixture({preflight:n=>({status:n===1?'pending':'ready',credential_version:3})});
  const result=await f.run();assert.deepEqual(result.items,[]);assert.equal(result.complete,true);
  assert.equal(f.preflights.length,2);assert.deepEqual(f.preflights[0],f.preflights[1]);
  assert.deepEqual(f.pauses,[200]);assert.equal(f.provider.length,1);finalizedRead(f,true);
});

test('read pending preparation has a fixed check limit and never admits or contacts Drive at that limit',async()=>{
  const f=await readFixture({preflight:()=>({status:'pending'})});
  await assert.rejects(f.run(),preflightError(/could not confirm.*bounded wait/));
  assert.equal(f.preflights.length,3);assert.deepEqual(f.pauses,[200,400]);noAdmittedRead(f);
});

test('read preflight uses one 30 second deadline including its first ensure call and pauses',async()=>{
  for(const elapsed of [29900,30000,30001]){
    const f=await readFixture({preflight:(_n,{advance})=>{advance(elapsed);return {status:elapsed===30001?'ready':'pending'};}});
    await assert.rejects(f.run(),preflightError(/bounded wait/));
    assert.equal(f.preflights.length,1);assert.deepEqual(f.pauses,elapsed===29900?[100]:[]);noAdmittedRead(f);
  }
});

test('a hung read preflight times out once and a late ready cannot admit the expired read',async t=>{
  let finish;const f=await readFixture({preflight:()=>new Promise(resolve=>{finish=resolve;})});
  t.mock.timers.enable({apis:['setTimeout']});
  const result=f.run();t.mock.timers.tick(30000);
  await assert.rejects(result,preflightError(/bounded wait/));
  finish({status:'ready',credential_version:3});await Promise.resolve();await Promise.resolve();
  assert.equal(f.preflights.length,1);assert.deepEqual(f.pauses,[]);noAdmittedRead(f);
});

test('the same total deadline bounds a hung preparation pause and prevents a subsequent check',async t=>{
  let enteredPause,finishPause;
  const paused=new Promise(resolve=>{enteredPause=resolve;});
  const f=await readFixture({preflight:()=>({status:'pending'}),pause:()=>{enteredPause();return new Promise(resolve=>{finishPause=resolve;});}});
  t.mock.timers.enable({apis:['setTimeout']});
  const result=f.run();await paused;t.mock.timers.tick(30000);
  await assert.rejects(result,preflightError(/bounded wait/));
  finishPause();await Promise.resolve();await Promise.resolve();
  assert.equal(f.preflights.length,1);assert.deepEqual(f.pauses,[200]);noAdmittedRead(f);
});

test('disabled, unavailable, unknown, malformed and thrown read preflight results stop without retry or provider access',async()=>{
  const cases=[[{status:'renewal_disabled'},/renewal was disabled or its authorization settings changed/],[{status:'unavailable'},/could not confirm/],
    [{status:'unexpected',proof:'synthetic-private-proof'},/unrecognized/],[null,/unrecognized/],
    [new Error('synthetic-private-provider-error'),/could not confirm/],
    [new StorageReadError('storage_read_unavailable',{hint:'synthetic-private-forged-hint'}),/could not confirm/]];
  for(const [result,hint] of cases){
    const f=await readFixture({preflight:()=>{if(result instanceof Error)throw result;return result;}});
    await assert.rejects(f.run(),preflightError(hint));assert.equal(f.preflights.length,1);assert.deepEqual(f.pauses,[]);noAdmittedRead(f);
  }
});

test('a pending read stops immediately on later disable, denial or malformed state without another retry',async()=>{
  for(const result of [{status:'renewal_disabled'},new Error('synthetic-private-denial'),{status:'unknown'},null]){
    const f=await readFixture({preflight:n=>{if(n===1)return {status:'pending'};if(result instanceof Error)throw result;return result;}});
    await assert.rejects(f.run(),preflightError(/disabled|could not confirm|unrecognized/));
    assert.equal(f.preflights.length,2);assert.deepEqual(f.pauses,[200]);noAdmittedRead(f);
  }
});

test('nonfinite or backwards preparation clocks fail closed without an operation admission',async()=>{
  for(const drift of [-1,NaN,Infinity]){
    const f=await readFixture({preflight:(_n,{advance})=>{advance(drift);return {status:'ready'};}});
    await assert.rejects(f.run(),preflightError(/could not confirm/));
    assert.equal(f.preflights.length,1);noAdmittedRead(f);
  }
});

test('a sealed credential with insufficient validity finalizes once and is not blamed on an old job',async()=>{
  const f=await readFixture({expired:true});
  await assert.rejects(f.run(),preflightError(/does not have enough remaining validity/));
  assert.equal(f.preflights.length,1);assert.equal(f.provider.length,0);finalizedRead(f,false);
});

test('fresh admission denial and failures after admission never reenter credential preparation',async()=>{
  const denied=await readFixture({deny:true});await assert.rejects(denied.run(),e=>e.code==='storage_read_unavailable'&&e.detail===undefined);
  assert.equal(denied.preflights.length,1);assert.equal(denied.calls.length,1);assert.equal(denied.provider.length,0);
  for(const options of [{providerFailure:true},{admission:{read_generation:undefined}}]){
    const f=await readFixture(options);await assert.rejects(f.run(),e=>e.code==='storage_read_unavailable'&&e.detail===undefined);
    assert.equal(f.preflights.length,1);assert.deepEqual(f.pauses,[]);finalizedRead(f,false);
    assert.equal(f.provider.length,options.providerFailure?1:0);
  }
});
