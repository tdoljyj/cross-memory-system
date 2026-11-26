// Real disposable PostgreSQL. Synthetic identities/time/Drive transport only;
// these tests never query production, change a real grant or mutate Google.
import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {once} from 'node:events';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build,stop} from 'esbuild';
import { newCluster } from './pg-cluster-fixture.mjs';
import {createStorageCredentialVault} from '../worker/storage-credential-vault.ts';
import {scopeString} from '../worker/storage-google-scopes.ts';
import {allowRawTestBindings} from './raw-binding-grants-fixture.mjs';
import {assertGatewayCloseoutBoundary,workerGatewayRpc} from './worker-gateway-caller-fixture.mjs';
import {testStorageDestructive} from './resource-center-storage-destructive-db.fixture.mjs';
import {storageAdminApproval,storageAdminCall} from './resource-center-storage-admin-db.fixture.mjs';
import {createGoogleDriveMetadataApi} from '../../../kernel/host/resource-center-google-drive-metadata.mjs';
import {createGoogleDriveRegistrationRecovery} from '../../../kernel/host/resource-center-google-drive-registration-recovery.mjs';
const cloud=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const uuid=()=>crypto.randomUUID();

test('legacy create: current registration, original unresolved history and no repeated provider effect',{timeout:240000},async t=>{
 const parent=await fs.realpath(os.tmpdir()),directory=await fs.mkdtemp(path.join(parent,'kooyumi-create-registration-db-'));
 const server=newCluster({databaseDir:directory,user:'postgres',password:uuid(),persistent:true,
  initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags:[...EPHEMERAL_POSTGRES_FLAGS, '-c', 'listen_addresses=127.0.0.1'],onLog(){},onError(){}});
 let db,native,started=false;
 try{
  await startCluster(server);started=true;db=server.getPgClient();await db.connect();
  await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
   create role authenticator nologin noinherit;create schema auth;create schema extensions;create extension pgcrypto with schema extensions;
   create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
   create table auth.sessions(id uuid primary key,user_id uuid not null,not_after timestamptz);
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
   grant usage on schema auth,extensions to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;
   create schema cron;create table cron.job(jobid bigserial primary key,jobname text unique,schedule text,command text,active boolean default true,database text default current_database(),username text default current_user);
   create function cron.schedule(text,text,text) returns bigint language sql as $$insert into cron.job(jobname,schedule,command) values($1,$2,$3)
    on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command,active=true returning jobid$$;`);
  for(const name of (await fs.readdir(path.join(cloud,'supabase/migrations'))).filter(n=>n.endsWith('.sql')).sort()){
   try{await db.query(await fs.readFile(path.join(cloud,'supabase/migrations',name),'utf8'));}
   catch(cause){throw Error('Migration '+name+': '+cause.message,{cause});}
  }
  await allowRawTestBindings(db);
  const owner=uuid(),project=uuid(),decision=uuid(),session=uuid();
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'registration-program@synthetic.invalid',now())",[owner]);
  await db.query("insert into auth.sessions(id,user_id) values($1,$2)",[session,owner]);
  await db.query("insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at) values($1,$2,'Registration program','registration program',$3,'confirmed',now())",[project,owner,'project:'+project]);
  await db.query(`insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,record_schema_version,lifecycle_status,
   canonical_scope,type_fields,relations,source_refs,authority,confidence_reason) values($1,$2,'Synthetic approval','Disposable only','project',$3,'decision','active',1,'active',
   $4,'{"rationale":"registration program test"}','{}','{}','user_explicit','Owner confirmed')`,[decision,owner,project,'project:'+project]);
  native=server.getPgClient();await native.connect();await native.query('set role authenticated');
  await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[owner,JSON.stringify({sub:owner,session_id:session})]);
  const scalar=async(sql,args)=>(await db.query(sql,args)).rows[0].v;
  const hashJson=value=>scalar('select clued_private.m1_sha256($1::jsonb) v',[JSON.stringify(value)]);
  const transitionLegacy=async(target,issuer)=>{
   // Real storage-only designation/manifest + Native transition in this
   // disposable database. No direct policy activation or snapshot edit.
   if(!await scalar('select exists(select 1 from clued_private.storage_admin_v2 where singleton) v')){
    const approval=await storageAdminApproval(db,owner,project,'designate');
    assert.equal((await storageAdminCall(db,approval)).status,'committed');
   }
   const designation=await scalar('select to_jsonb(a) v from clued_private.storage_admin_v2 a where singleton');
   const inventory=await scalar('select clued_private.storage_policy_transition_inventory_v2($1,$2,$3::jsonb) v',
    [owner,target.connection,JSON.stringify(target.history)]);
   assert.deepEqual(inventory.unresolved_intents,[]);
   const version=await scalar('select version v from public.clued_memories where id=$1',[decision]);
   const document={contract:'clued.storage-policy-transition/2',owner_id:owner,connection_id:target.connection,
    source_decision_id:decision,decision_version:Number(version),disclosure_version:'clued.storage-account-consent/2',
    expires_at:new Date(Date.now()+3600000).toISOString(),expected_inventory_digest:await hashJson(inventory),history_preimages:target.history};
   const text=JSON.stringify(document,null,2)+'\n',digest=crypto.createHash('sha256').update(text).digest('hex');
   const evidence={idempotency_key:uuid(),evidence_schema_version:1,evidence_type:'test_output',storage_ref:'isolated-legacy-transition:'+uuid(),
    content_hash:digest,size_bytes:Buffer.byteLength(text),mime_type:'application/json'};
   const ingested=await scalar('select clued_private.evidence_ingest_core($1,null,$2::jsonb,clued_private.m1_sha256($2::jsonb)) v',[owner,JSON.stringify(evidence)]);
   assert.equal(ingested.status,'committed');
   const registered=await scalar('select clued_private.storage_policy_transition_admin_v2($1::jsonb) v',[JSON.stringify({action:'register',
    storage_admin_version:Number(designation.version),idempotency_key:uuid(),evidence_id:ingested.evidence_ids[0],evidence_sha256:digest,manifest_json:text})]);
   assert.equal(registered.status,'committed',JSON.stringify(registered));
   const manifest=registered.target_refs.find(x=>x.role==='primary').id;
   const call=async input=>(await native.query('select public.clued_storage_policy_transition_v2($1,$2::jsonb) v',[issuer,JSON.stringify(input)])).rows[0].v;
   const described=await call({action:'describe',manifest_id:manifest});
   // The Native cutover requires the actual issuer execution gate quiet,
   // independently of the original intent already being closed by I9.
   await db.query('update clued_private.storage_oauth_apps_v1 set execution_enabled=false where issuer_hash=$1',[issuer]);
   let result;
   try{result=await call({action:'transition',manifest_id:manifest,manifest_sha256:described.manifest_sha256,
    expected_inventory_digest:described.expected_inventory_digest,idempotency_key:uuid()});}
   finally{await db.query('update clued_private.storage_oauth_apps_v1 set execution_enabled=true where issuer_hash=$1',[issuer]);}
   assert.equal(result.status,'committed',JSON.stringify(result));
   assert.equal(await scalar('select auth_mode v from clued_private.storage_connections_v1 where id=$1',[target.connection]),'account_policy');
   return result;
  };
  await build({entryPoints:[path.join(cloud,'worker/storage-cloud-recovery.ts')],bundle:true,platform:'node',format:'esm',outfile:path.join(directory,'recovery.mjs'),logLevel:'silent'});
  const {createStorageCloudRecovery}=await import(pathToFileURL(path.join(directory,'recovery.mjs')));
  const vaultConfig={current_key_id:'synthetic',keys:{synthetic:crypto.randomBytes(32).toString('base64url')}};
  const vault=await createStorageCredentialVault(vaultConfig);
  await testStorageDestructive(t,db,server,owner,decision,{gateway:true,only_extra:true,extra_cases:async ctx=>{
   const rpc=async(issuer,input,database=db)=>{
    try{return await workerGatewayRpc(database,'clued_storage_scheduled_recovery_v2',issuer,input);}
    finally{await database.query('reset role');await database.query("select set_config('request.jwt.claims','{}',false)");}
   };
   const make=async(kind='file',{legacy=false}={})=>{
    const {target,client,storage}=await (legacy?ctx.setupLegacy():ctx.setup());
    const parentPath=await scalar('select path v from clued_private.resource_center_artifacts_v1 where profile_id=$1 and provider_file_id=$2',[target.profile,target.trackId]);
    const mutation={operation:'create',target_kind:kind,destination_path:parentPath+'/created-'+uuid()+'.md',
     ...(kind==='file'?{content:'original immutable content'}:{directory_semantics:'topic'})};
    const job=await ctx.submitJob(target,client,mutation);
    const snapshot=()=>scalar('select authority_snapshot_v2 v from clued_private.storage_jobs_v1 where owner_id=$1 and job_id=$2',[owner,job.reference.job_id]);
    if(legacy)assert.equal(await snapshot(),null);
    let withheld;
    const engine=ctx.executor(target,storage,async request=>{
     if(request.action==='verified_record'){withheld=structuredClone(request);throw Error('synthetic lost verification request after one POST');}
    });
    assert.equal((await engine.run(job.reference)).status,'unreconciled');assert.ok(withheld);
    const original=await ctx.journal(job),file=storage.files.get(original.provider_attempt.provider_file_id);assert.ok(file);
    assert.equal(original.verified_result_v2,null);
    await db.query("update public.clued_audit_receipts set created_at=clock_timestamp()-interval '3 hours' where id=$1",[original.provider_attempt_receipt_id]);
    await db.query("update clued_private.resource_center_mutations_v1 set expires_at=clock_timestamp()-interval '3 hours' where id=$1",[original.id]);
    assert.equal(await scalar('select clued_private.storage_conflict_close_v1($1) v',[original.id]),'conflict');
    const closed=await ctx.journal(job),issuer=await scalar('select issuer_hash v from clued_private.storage_oauth_apps_v1 where oauth_client_id=$1',[ctx.oauth_client_id]);
    if(legacy){assert.equal(await snapshot(),null);await transitionLegacy(target,issuer);assert.equal(await snapshot(),null);}
    const state=(await native.query('select public.clued_storage_write_access_v1($1::jsonb) v',[JSON.stringify({action:'status',connection_id:target.connection})])).rows[0].v;
    const granted=(await native.query('select public.clued_storage_write_access_v1($1::jsonb) v',[JSON.stringify({action:'set_classes',connection_id:target.connection,
     classes:[...state.classes,'modify'].sort(),base_generation:state.policy_generation,disclosure_version:'clued.storage-modify-disclosure/1',idempotency_key:uuid()})])).rows[0].v;
    assert.equal(granted.status,'committed',JSON.stringify(granted));
    const envelope=await vault.seal(JSON.stringify({token_type:'Bearer',access_token:ctx.access_token,scope:scopeString('full'),expires_at_ms:Date.now()+3600000}),
     {owner_id:owner,connection_id:target.connection,provider:'google-drive',provider_subject:ctx.provider_subject,oauth_client_id:ctx.oauth_client_id,credential_version:1});
    await db.query("update clued_private.storage_connections_v1 set credential_envelope=$2,provider_scope_profile='full' where id=$1",[target.connection,JSON.stringify(envelope)]);
    for(const item of storage.files.values()){
     Object.assign(item,{shared:false,permissionIds:['fixture-owner'],permissions:[{id:'fixture-owner',type:'user',role:'owner'}]});
     item.capabilities={...item.capabilities,canShare:true,canListChildren:true};
     if(item.mimeType==='application/vnd.google-apps.folder'){delete item.size;delete item.sha256Checksum;delete item.headRevisionId;delete item.md5Checksum;}
    }
    const descriptor=await rpc(issuer,{action:'load',...job.reference}),requests=[];
    assert.equal(descriptor.status,'recovery_only');assert.equal(descriptor.verified_result_v2,undefined);
    // The original Agent is now expired. Its stored typed path must not
    // manufacture fresh authority; the independent program actor still can.
    await db.query("update public.clued_agent_bindings set expires_at=clock_timestamp()-interval '1 minute' where id=$1",[client.id]);
    const fetch=async(url,init)=>{requests.push({url:String(url),method:init.method});return storage.fetch(url,init);};
    const oldProofErrors=[];
    const recover=async(allowOriginalProof=legacy)=>{
     const recovery=await createStorageCloudRecovery({client_id:ctx.oauth_client_id,vault:vaultConfig,timeout_ms:10000,fetch,
      // Fault injection is explicit: the old proof-recording route cannot
      // establish historical authority. The new registration still uses the
      // real issuer wrapper/Gateway/PostgreSQL, never a mocked success.
      verified:{descriptor,rpc:async input=>{if(!allowOriginalProof&&input.action==='verified_record')throw Error('synthetic old verification authority unavailable');
       try{return await ctx.cloud(input);}catch(error){if(input.action==='verified_record')oldProofErrors.push(error.message);throw error;}}},
      rpc:async()=>assert.fail('legacy create must use fixed current-registration RPC'),
      current_registration:{rpc:input=>rpc(issuer,input)}});
     return recovery.run(job.reference);
    };
    const load=async()=>{try{return await rpc(issuer,{action:'registration_current_load',...job.reference});}
     catch(cause){const diagnostic=await scalar(`select jsonb_build_object('paths',q.paths,'destination',j.mutation->>'destination_path',
      'candidate',clued_private.storage_legacy_create_absent_candidate_v1(j),'attempt',m.provider_attempt,
      'receipt',jsonb_build_object('status',r.status,'operation',r.operation,'request_sha256',r.request_sha256,'event_ids',r.event_ids),
      'events',(select jsonb_agg(jsonb_build_object('type',e.canonical_event_type,'result',e.result,'summary',e.change_summary))
       from public.clued_context_events e where e.receipt_id=r.id)) v
      from clued_private.storage_jobs_v1 j join clued_private.resource_center_mutations_v1 m on m.id=j.intent_id
      join clued_private.storage_conflict_isolations_v1 q on q.intent_id=m.id join public.clued_audit_receipts r on r.id=m.provider_attempt_receipt_id
      where j.job_id=$1`,[job.reference.job_id]);throw Error('Current create registration load rejected: '+JSON.stringify(diagnostic),{cause});}};
    const commit=(d,observations,database=db)=>rpc(issuer,{action:'registration_current_commit',...job.reference,
     base_version:d.base_version,source_receipt_id:d.source_receipt_id,registration_authority:d.registration_authority,
     registration_plan:d.registration_plan,...observations},database);
    const observe=async d=>createGoogleDriveRegistrationRecovery({metadata:createGoogleDriveMetadataApi({registration_details:true,
     get_credential:async()=>({access_token:ctx.access_token,scope:scopeString('full')}),fetch})}).observe(d.registration_plan);
    return {target,client,storage,job,original,closed,file,issuer,withheld,requests,recover,load,commit,observe,snapshot,oldProofErrors};
   };
   const untouched=async f=>{
    const row=await ctx.journal(f.job);assert.equal(row.state,'conflict');assert.equal(row.version,'3');
    assert.equal(row.receipt_id,f.closed.receipt_id);assert.deepEqual(row.provider_attempt,f.original.provider_attempt);
    assert.equal(row.provider_attempt_receipt_id,f.original.provider_attempt_receipt_id);assert.equal(row.verified_result_v2,null);
    assert.equal(await scalar('select count(*)::int v from clued_private.storage_current_registration_results_v1 where intent_id=$1',[row.id]),0);
    assert.equal(await scalar('select count(*)::int v from clued_private.resource_center_artifacts_v1 where profile_id=$1 and provider_file_id=$2',[f.target.profile,f.file.id]),0);
    assert.equal(await scalar("select state v from clued_private.storage_conflict_isolations_v1 where intent_id=$1",[row.id]),'active');
   };
   const assertRegistrationReceipt=async(f,result)=>{
    const receipt=await scalar('select to_jsonb(r) v from public.clued_audit_receipts r where id=$1',[result.receipt_id]);
    const events=await scalar('select jsonb_agg(to_jsonb(e) order by e.id) v from public.clued_context_events e where e.receipt_id=$1',[result.receipt_id]);
    assert.equal(events.length,1);const event=events[0],{after_rows:after,...request}=event.change_summary;
    assert.equal(event.canonical_event_type,'extension:storage:current_registration_reconciled');assert.equal(event.result,'success');
    assert.equal(receipt.user_id,owner);assert.equal(event.user_id,owner);assert.equal(event.actor_user_id,owner);
    assert.equal(event.receipt_id,receipt.id);assert.equal(event.request_hash,receipt.request_sha256);
    assert.deepEqual(event.target_refs,receipt.target_refs);assert.equal(event.committed_canonical_version,receipt.canonical_version);
    assert.equal(event.idempotency_key,receipt.idempotency_key);assert.deepEqual(receipt.event_ids.map(String),[String(event.id)]);
    assert.equal(receipt.idempotency_key,'storage-current-registration:'+f.original.id+':3');
    assert.equal(receipt.status,'committed');assert.equal(receipt.operation,'storage_current_registration_reconcile');
    const {idempotency_key:unusedKey,request_hash:unusedHash,...payload}=request;void unusedKey;void unusedHash;
    assert.equal(receipt.request_sha256,await hashJson({operation:'storage_current_registration_reconcile',payload}));
    assert.equal(receipt.received_payload_hash,await hashJson(request));
    assert.equal(receipt.response_hash,await hashJson(receipt.canonical_result));
    assert.deepEqual(receipt.canonical_result,await scalar('select clued_private.m1_result_envelope(r) v from public.clued_audit_receipts r where id=$1',[receipt.id]));
    const created=request.created_target_id;
    const saved=await scalar('select result v from clued_private.storage_current_registration_results_v1 where intent_id=$1',[f.original.id]);
    assert.equal(created,saved.artifact_id);assert.equal(saved.receipt_id,result.receipt_id);assert.equal(request.registration_plan.mode,'adopt_create');
    assert.equal(request.original_attempt_receipt_id,f.original.provider_attempt_receipt_id);
    assert.equal(request.original_attempt_digest,await hashJson(f.original.provider_attempt));
    assert.equal(receipt.base_versions[created],0);assert.equal(receipt.committed_versions[created],1);
    assert.equal(receipt.base_versions[f.original.id],3);assert.equal(receipt.committed_versions[f.original.id],4);
    assert.deepEqual(after.map(x=>x.id).sort(),[...request.before_rows.map(x=>x.id),created].sort());
    assert.equal(new Set(after.map(x=>x.id)).size,after.length);
    for(const row of after){
     assert.deepEqual(row,await scalar('select to_jsonb(a) v from clued_private.resource_center_artifacts_v1 a where id=$1',[row.id]));
     const before=request.before_rows.find(x=>x.id===row.id);
     assert.equal(receipt.base_versions[row.id],before?Number(before.version):0);
     assert.equal(receipt.committed_versions[row.id],before?Number(before.version)+1:1);
     assert.ok(receipt.target_refs.some(x=>x.id===row.id&&x.role==='target'));
    }
    assert.equal(await scalar("select count(*)::int v from public.clued_audit_receipts where user_id=$1 and operation='storage_current_registration_reconcile' and idempotency_key=$2 and status='committed'",[owner,receipt.idempotency_key]),1);
   };
   for(const kind of ['file','directory'])await t.test(kind+' existing create is registered once by the real Worker and Gateway, with independent Receipt',async()=>{
    const f=await make(kind),first=await f.recover();assert.equal(first.status,'resolved',JSON.stringify(first));
    assert.equal(first.resolution,'automatically_registered_current_state');assert.notEqual(first.receipt_id,f.closed.receipt_id);
    const row=await ctx.journal(f.job);assert.equal(row.state,'conflict');assert.equal(row.version,'4');
    assert.equal(row.receipt_id,f.closed.receipt_id);assert.equal(row.verified_result_v2,null);
    assert.deepEqual(row.provider_attempt,f.original.provider_attempt);assert.deepEqual(row.authority_request,f.original.authority_request);
    const a=await ctx.artifact(f.target,f.job.mutation.destination_path);assert.equal(a.provider_file_id,f.file.id);
    assert.equal(a.target_kind,kind);assert.equal(a.governance_class,'ordinary');assert.equal(a.delete_authority,false);assert.equal(a.version,'1');
    const receipt=await scalar('select to_jsonb(r) v from public.clued_audit_receipts r where id=$1',[first.receipt_id]);
    assert.equal(receipt.status,'committed');assert.equal(receipt.operation,'storage_current_registration_reconcile');
    assert.equal(receipt.base_versions[a.id],0);assert.equal(receipt.committed_versions[a.id],1);
    assert.ok(receipt.target_refs.some(x=>x.id===a.id&&x.role==='target'));
    await assertRegistrationReceipt(f,first);
    const again=await f.load();assert.equal(again.receipt_id,first.receipt_id);
    assert.equal(await scalar('select count(*)::int v from clued_private.storage_current_registration_results_v1 where intent_id=$1',[row.id]),1);
    assert.ok(f.requests.length>0&&f.requests.every(x=>x.method==='GET'));assert.equal(f.storage.patches,0);assert.equal(f.storage.deletes,0);
   });
   for(const kind of ['file','directory'])await t.test(kind+' genuine legacy NULL snapshot is recovered after the real Native policy transition without injected old-route failure',async()=>{
    const f=await make(kind,{legacy:true});assert.equal(await f.snapshot(),null);
    const beforeReceipt=await scalar('select to_jsonb(r) v from public.clued_audit_receipts r where id=$1',[f.original.provider_attempt_receipt_id]);
    const result=await f.recover();assert.equal(result.status,'resolved',JSON.stringify({result,oldProofErrors:f.oldProofErrors}));
    assert.ok(f.oldProofErrors.length>0,'the real old verified_record RPC must actually be refused: '+JSON.stringify(f.oldProofErrors));
    assert.ok(f.oldProofErrors.every(x=>/^storage_[a-z0-9_]+$/.test(x)),JSON.stringify(f.oldProofErrors));
    assert.equal(result.resolution,'automatically_registered_current_state');assert.equal(await f.snapshot(),null);
    const row=await ctx.journal(f.job);assert.equal(row.state,'conflict');assert.equal(row.verified_result_v2,null);
    assert.deepEqual(row.provider_attempt,f.original.provider_attempt);assert.deepEqual(row.authority_request,f.original.authority_request);
    assert.equal(row.provider_attempt_receipt_id,f.original.provider_attempt_receipt_id);assert.equal(row.receipt_id,f.closed.receipt_id);
    assert.deepEqual(await scalar('select to_jsonb(r) v from public.clued_audit_receipts r where id=$1',[f.original.provider_attempt_receipt_id]),beforeReceipt);
    await assertRegistrationReceipt(f,result);assert.equal((await f.load()).receipt_id,result.receipt_id);
    assert.ok(f.requests.length>0&&f.requests.every(x=>x.method==='GET'));assert.equal(f.storage.patches,0);assert.equal(f.storage.deletes,0);
   });
   await t.test('the existing valid typed-proof route remains preferred over current registration',async()=>{
    const f=await make();assert.equal((await f.recover(true)).status,'committed');
    assert.equal(await scalar('select count(*)::int v from clued_private.storage_current_registration_results_v1 where intent_id=$1',[f.original.id]),0);
   });
   for(const fault of ['missing_intent_tag','wrong_request_tag','wrong_content','wrong_parent','external_name_slot','shared'])await t.test(fault+' never registers or resolves the original isolation',async()=>{
    const f=await make('file');
    if(fault==='missing_intent_tag')delete f.file.appProperties.clued_intent_id;
    if(fault==='wrong_request_tag')f.file.appProperties.clued_request_sha256='f'.repeat(64);
    if(fault==='wrong_content')f.file.sha256Checksum='f'.repeat(64);
    if(fault==='wrong_parent')f.file.parents=[f.target.rootId];
    if(fault==='external_name_slot')f.storage.files.set('external-'+uuid(),{...f.file,id:'external-object',appProperties:{}});
    if(fault==='shared')f.file.shared=true;
    assert.notEqual((await f.recover()).status,'resolved');await untouched(f);
   });
   for(const trashed of [false,true])await t.test('real legacy NULL nonempty directory registers only itself; '+(trashed?'trashed':'active')+' child remains unmanaged',async()=>{
    const f=await make('directory',{legacy:true}),child={id:'unmanaged-'+uuid(),name:'owner-file',parents:[f.file.id],version:'1',trashed,mimeType:'text/plain'};
    f.storage.files.set(child.id,child);const before=structuredClone(child);
    assert.equal(await f.snapshot(),null);
    const result=await f.recover();assert.equal(result.status,'resolved',JSON.stringify(result));
    assert.equal(result.resolution,'automatically_registered_current_state');assert.equal(await f.snapshot(),null);
    const row=await ctx.journal(f.job);assert.equal(row.state,'conflict');assert.equal(row.verified_result_v2,null);
    assert.deepEqual(row.provider_attempt,f.original.provider_attempt);assert.equal(row.receipt_id,f.closed.receipt_id);
    await assertRegistrationReceipt(f,result);
    const saved=await scalar('select observations v from clued_private.storage_current_registration_results_v1 where intent_id=$1',[f.original.id]);
    assert.equal(saved.first_observation.target.empty,false);assert.equal(saved.second_observation.target.empty,false);
    assert.equal(await scalar('select count(*)::int v from clued_private.resource_center_artifacts_v1 where profile_id=$1 and provider_file_id=$2',[f.target.profile,child.id]),0);
    assert.deepEqual(f.storage.files.get(child.id),before);
    assert.ok(f.oldProofErrors.length>0&&f.oldProofErrors.every(x=>/^storage_[a-z0-9_]+$/.test(x)));
    assert.ok(f.requests.every(x=>x.method==='GET'));assert.equal(f.storage.patches,0);assert.equal(f.storage.deletes,0);
   });
   for(const invalid of [null,'false',undefined])await t.test('SQL rejects nonboolean or absent current child-presence fact '+String(invalid),async()=>{
    const f=await make('directory'),d=await f.load(),o=await f.observe(d);
    for(const point of ['first_observation','second_observation']){
     const bad=structuredClone(o);
     if(invalid===undefined)delete bad[point].target.empty;else bad[point].target.empty=invalid;
     await assert.rejects(f.commit(d,bad),/storage_current_registration_proof_invalid/);await untouched(f);
    }
   });
   await t.test('the independent base-create switch denies adoption while modify alone remains enabled',async()=>{
    const f=await make();
    await db.query(`insert into clued_private.storage_master_controls_v1(connection_id,owner_id,enabled,allow_base_create,generation,receipt_id)
     select id,owner_id,true,false,1,receipt_id from clued_private.storage_connections_v1 where id=$1`,[f.target.connection]);
    await assert.rejects(f.load(),e=>e.cause?.message==='storage_current_registration_unavailable');
    await untouched(f);
   });
   await t.test('a corrupted direct-commit private tag is rejected by PostgreSQL independently of Worker',async()=>{
    const f=await make(),d=await f.load(),o=await f.observe(d);o.first_observation.target.intent_tag=uuid();o.second_observation.target.intent_tag=o.first_observation.target.intent_tag;
    await assert.rejects(f.commit(d,o),/storage_current_registration_proof_invalid/);await untouched(f);
   });
   await t.test('a final Receipt failure rolls back the new Artifact, parent qualification and exit permit',async()=>{
    const f=await make(),d=await f.load(),o=await f.observe(d);
    const before=await scalar('select jsonb_agg(to_jsonb(a) order by a.id) v from clued_private.resource_center_artifacts_v1 a where a.profile_id=$1',[f.target.profile]);
    await db.query(`create function public.test_create_registration_receipt_failure() returns trigger language plpgsql as $$begin
     if new.operation='storage_current_registration_reconcile' and new.status='committed' then raise exception 'synthetic_create_registration_receipt_failure';end if;return new;end$$;
     create trigger test_create_registration_receipt_failure before update on public.clued_audit_receipts for each row execute function public.test_create_registration_receipt_failure()`);
    try{await assert.rejects(f.commit(d,o),/synthetic_create_registration_receipt_failure/);}
    finally{await db.query('drop trigger test_create_registration_receipt_failure on public.clued_audit_receipts;drop function public.test_create_registration_receipt_failure()');}
    assert.deepEqual(await scalar('select jsonb_agg(to_jsonb(a) order by a.id) v from clued_private.resource_center_artifacts_v1 a where a.profile_id=$1',[f.target.profile]),before);
    await untouched(f);assert.equal((await f.commit(d,o)).status,'resolved');
   });
   await t.test('two real database sessions commit one new Artifact and one recovery Receipt',async()=>{
    const f=await make(),d=await f.load(),o=await f.observe(d),other=server.getPgClient();await other.connect();
    try{const [a,b]=await Promise.all([f.commit(d,o),f.commit(d,o,other)]);assert.equal(a.receipt_id,b.receipt_id);assert.equal(a.artifact_id,b.artifact_id);}
    finally{await other.end();}
    assert.equal(await scalar('select count(*)::int v from clued_private.resource_center_artifacts_v1 where profile_id=$1 and provider_file_id=$2',[f.target.profile,f.file.id]),1);
   });
   for(const signature of ['storage_legacy_create_registration_authority_v1(text,uuid,uuid)','storage_legacy_create_registration_plan_v1(text,uuid,uuid)',
    'storage_legacy_create_registration_observation_v1(jsonb,jsonb)','storage_legacy_create_registration_v1(text,jsonb)','storage_registration_before_create_v1(text,jsonb)'])
    for(const role of ['anon','authenticated','service_role','clued_worker_gateway'])
     assert.equal(await scalar('select has_function_privilege($1,$2,\'execute\') v',[role,'clued_private.'+signature]),false);
   await assertGatewayCloseoutBoundary(db);
  }});
 }finally{
  stop();if(native)await native.end();if(db)await db.end();
  if(started){
   // embedded-postgres.stop resolves on exit, before its Windows stdio has
   // necessarily closed. Wait for producer close before deleting its scratch.
   const producer=server.process,closed=producer?once(producer,'close'):Promise.resolve();
   await stopCluster(server);
   producer?.stdin?.destroy();producer?.stdout?.destroy();producer?.stderr?.destroy();
   await closed;
  }
  const actual=await fs.realpath(directory);assert.equal(path.dirname(actual).toLowerCase(),parent.toLowerCase());
  assert.ok(path.basename(actual).startsWith('kooyumi-create-registration-db-'));
  await removeTestDirectory(actual);
 }
});
