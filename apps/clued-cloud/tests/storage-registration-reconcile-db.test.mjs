// Real disposable PostgreSQL. Synthetic identities/time/Drive transport only;
// these tests never query production, change a real grant or mutate Google.
import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import {createStorageCredentialVault} from '../worker/storage-credential-vault.ts';
import {scopeString} from '../worker/storage-google-scopes.ts';
import {allowRawTestBindings} from './raw-binding-grants-fixture.mjs';
import {assertGatewayCloseoutBoundary,setWorkerGatewayCaller} from './worker-gateway-caller-fixture.mjs';
import {testStorageDestructive} from './resource-center-storage-destructive-db.fixture.mjs';
import {createGoogleDriveMetadataApi} from '../../../kernel/host/resource-center-google-drive-metadata.mjs';
import {createGoogleDriveRegistrationRecovery} from '../../../kernel/host/resource-center-google-drive-registration-recovery.mjs';
const cloud=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const uuid=()=>crypto.randomUUID();
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));
 const p=s.address().port;await new Promise(r=>s.close(r));return p;}

test('registration reconciliation: actual program authority, independent of the original Agent',{timeout:240000},async t=>{
 const parent=await fs.realpath(os.tmpdir()),directory=await fs.mkdtemp(path.join(parent,'kooyumi-registration-db-'));
 const server=new EmbeddedPostgres({databaseDir:directory,user:'postgres',password:uuid(),port:await port(),persistent:true,
  initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags:[...EPHEMERAL_POSTGRES_FLAGS, '-c', 'listen_addresses=127.0.0.1'],onLog(){},onError(){}});
 let db,native,started=false;
 try{
  await server.initialise();await server.start();started=true;db=server.getPgClient();await db.connect();
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
  await testStorageDestructive(t,db,server,owner,decision,{gateway:true,only_extra:true,extra_cases:async ctx=>{
   const f=await ctx.setup();let source=await ctx.directoryIn(f.target,f.storage,'registered-'+uuid());
   // A real independent Artifact Decision L sorts below master Decision H.
   // Register it through the actual admin receipt, before any job exists.
   const artifactDecision='00000000-0000-4000-8000-000000000001';
   assert.ok(artifactDecision<decision);
   await db.query(`insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,record_schema_version,lifecycle_status,
    canonical_scope,type_fields,relations,source_refs,authority,confidence_reason) values($1,$2,'Synthetic Artifact approval','Disposable only','project',$3,'decision','active',1,'active',
    $4,'{"rationale":"independent Artifact Decision"}','{}','{}','user_explicit','Owner confirmed')`,[artifactDecision,owner,project,'project:'+project]);
   const qualified=await scalar('select public.clued_resource_center_admin_v1($1,$2::jsonb) v',[owner,JSON.stringify({
    action:'artifact_update',profile_id:f.target.profile,artifact_id:source.id,base_version:source.version,
    path:source.path,provider_file_id:source.provider_file_id,provider_file_version:source.provider_file_version,
    governance_class:source.governance_class,delete_authority:source.delete_authority,
    source_decision_id:artifactDecision,idempotency_key:uuid()})]);
   assert.equal(qualified.status,'committed',JSON.stringify(qualified));source=await ctx.artifactById(source.id);
   const job=await ctx.submitJob(f.target,f.client,ctx.trash(source));
   const engine=ctx.executor(f.target,f.storage,async request=>{
    if(request.action==='provider_attempt'){await ctx.cloud(request);throw Error('synthetic lost original attempt acknowledgement');}
   });
   assert.equal((await engine.run(job.reference)).status,'unreconciled');
   const original=await ctx.journal(job);
   await db.query("update public.clued_audit_receipts set created_at=clock_timestamp()-interval '3 hours' where id=$1",[original.provider_attempt_receipt_id]);
   await db.query("update clued_private.resource_center_mutations_v1 set expires_at=clock_timestamp()-interval '3 hours' where id=$1",[original.id]);
   assert.equal(await scalar('select clued_private.storage_conflict_close_v1($1) v',[original.id]),'conflict');
   const issuer=await scalar('select issuer_hash v from clued_private.storage_oauth_apps_v1 where oauth_client_id=$1',[ctx.oauth_client_id]);
   // A synthetic OAuth completion attestation with a genuinely sealed full
   // token, rather than the original fixture's deliberately empty envelope.
   const vault=await createStorageCredentialVault({current_key_id:'synthetic',keys:{synthetic:crypto.randomBytes(32).toString('base64url')}});
   const envelope=await vault.seal(JSON.stringify({token_type:'Bearer',access_token:ctx.access_token,
    scope:scopeString('full'),expires_at_ms:Date.now()+3600000}),
    {owner_id:owner,connection_id:f.target.connection,provider:'google-drive',provider_subject:ctx.provider_subject,oauth_client_id:ctx.oauth_client_id,credential_version:1});
   await db.query("update clued_private.storage_connections_v1 set credential_envelope=$2,provider_scope_profile='full' where id=$1",[f.target.connection,JSON.stringify(envelope)]);
   // This exact call composition models the existing authenticated wrapper;
   // the helper never treats a caller-supplied stable identity as a proof.
   const program=async(proof=issuer,reference=job.reference)=>scalar(`select clued_private.storage_registration_program_authority_v1(
    clued_private.issuer_resolve_identity_v1($1,'storage'),$2,$3) v`,[proof,reference.connection_id,reference.job_id]);
   await t.test('reader/destructive alone cannot become a registration modifier',async()=>{
    await assert.rejects(program(),/storage_registration_program_denied/);
   });
   const state=(await native.query("select public.clued_storage_write_access_v1($1::jsonb) v",[JSON.stringify({action:'status',connection_id:f.target.connection})])).rows[0].v;
   const granted=(await native.query("select public.clued_storage_write_access_v1($1::jsonb) v",[JSON.stringify({action:'set_classes',connection_id:f.target.connection,
    classes:['modify','destructive'],base_generation:state.policy_generation,disclosure_version:'clued.storage-modify-disclosure/1',idempotency_key:uuid()})])).rows[0].v;
   assert.equal(granted.status,'committed',JSON.stringify(granted));
   await t.test('current modify/full authorizes the program, without reviving the old Agent',async()=>{
    await db.query('begin');try{
     await db.query("update public.clued_agent_bindings set expires_at=clock_timestamp()-interval '1 minute' where id=$1",[f.client.id]);
     const result=await program(),a=result.registration_authority;
     assert.equal(a.actor_kind,'storage_program');assert.equal(a.registration_action,'modify');assert.equal(a.provider_scope_profile,'full');
     assert.equal(a.issuer_credential_generation,1);assert.equal(a.job_id,job.reference.job_id);
     assert.equal(a.original_connection_id,job.reference.connection_id);assert.equal(a.connection_id,f.target.connection);
     assert.ok(a.consent_receipt_id);assert.ok(a.activation_receipt_id);assert.ok(a.runtime.receipt_id);
     assert.equal(result.recovery_reader.connection_id,f.target.connection);
     assert.deepEqual((await ctx.journal(job)).provider_attempt,original.provider_attempt);
    }finally{await db.query('rollback');}
   });
   for(const [name,sql,args] of [
    ['execution off','update clued_private.storage_oauth_apps_v1 set execution_enabled=false where issuer_hash=$1',[issuer]],
    ['DB full missing',"update clued_private.storage_connections_v1 set provider_scope_profile='normal' where id=$1",[f.target.connection]],
    ['master off',`insert into clued_private.storage_master_controls_v1(connection_id,owner_id,enabled,allow_base_create,generation,receipt_id)
      select id,owner_id,false,true,1,receipt_id from clued_private.storage_connections_v1 where id=$1`,[f.target.connection]],
    ['runtime qualification receipt mismatch',`update clued_private.resource_center_profiles_v1 set cloud_runtime=jsonb_set(cloud_runtime,'{receipt_id}',to_jsonb($2::text)) where id=$1`,[f.target.profile,f.target.receipt]],
    ['source Decision no longer current',"update public.clued_memories set lifecycle_status='archived' where id=$1",[decision]],
    ['original client explicitly denied',`insert into clued_private.storage_client_denies_v2(owner_id,lineage_id,denied,receipt_id) values($1,$2,true,$3)`,[owner,f.client.lineage,f.target.receipt]],
    ['root explicitly denied',`insert into clued_private.storage_root_denies_v2(owner_id,provider,provider_subject,root_folder_id,denied,receipt_id)
      values($1,'google-drive',$2,$3,true,$4)`,[owner,ctx.provider_subject,f.target.rootId,f.target.receipt]],
   ])await t.test(name+' denies current program authority and rolls back',async()=>{
    await db.query('begin');try{await db.query(sql,args);await assert.rejects(program(),/storage_registration_program_denied|storage_recovery_denied/);}
    finally{await db.query('rollback');}
   });
   await t.test('wrong issuer proof cannot enter the actor chain',async()=>{await assert.rejects(program('a'.repeat(64)),/issuer_credential_required/);});
   await t.test('the existing create-only master switch does not disable modify',async()=>{
    await db.query('begin');try{
     await db.query(`insert into clued_private.storage_master_controls_v1(connection_id,owner_id,enabled,allow_base_create,generation,receipt_id)
       select id,owner_id,true,false,1,receipt_id from clued_private.storage_connections_v1 where id=$1`,[f.target.connection]);
     assert.equal((await program()).registration_authority.registration_action,'modify');
    }finally{await db.query('rollback');}
   });
   await t.test('each new transaction needs its own authenticated issuer context',async()=>{
    assert.equal((await program()).registration_authority.issuer_credential_generation,1);
    await assert.rejects(scalar('select clued_private.storage_registration_program_authority_v1($1,$2,$3) v',
      [issuer,job.reference.connection_id,job.reference.job_id]),/issuer_authenticated_context_required/);
   });
   await t.test('multiple active generations record the actual matching proof, never MAX',async()=>{
    const nextProof=crypto.createHash('sha256').update(uuid()).digest('hex');
    await db.query('begin');try{
     await db.query(`insert into clued_private.issuer_credentials_v1(issuer_id,generation,verifier,state,activated_at)
      select id,2,'cv1:'||encode(extensions.digest('clued.credential-verifier.v1:'||$2,'sha256'),'hex'),'active',clock_timestamp()
      from clued_private.issuer_identities_v1 where kind='storage' and legacy_key=$1`,[issuer,nextProof]);
     assert.equal((await program(issuer)).registration_authority.issuer_credential_generation,1);
     assert.equal((await program(nextProof)).registration_authority.issuer_credential_generation,2);
    }finally{await db.query('rollback');}
   });
   await t.test('the current registration descriptor traverses the actual original journal and parent registry',async()=>{
    const loaded=await scalar(`select public.clued_storage_scheduled_recovery_v2($1,$2::jsonb) v`,
     [issuer,JSON.stringify({...job.reference,action:'registration_current_load'})]);
    assert.equal(loaded.status,'registration_required');assert.equal(loaded.intent_id,original.id);
    assert.equal(loaded.registration_plan.target.provider_file_id,source.provider_file_id);
   });
   await t.test('independent lower Decision contention aborts registration and releases its higher master lock',async()=>{
    const blocker=server.getPgClient();await blocker.connect();
    const snapshot=async()=>scalar(`select jsonb_build_object(
     'receipts',(select count(*) from public.clued_audit_receipts),
     'permits',(select count(*) from clued_private.storage_registration_artifact_permits_v1),
     'results',(select count(*) from clued_private.storage_current_registration_results_v1),
     'artifacts',(select jsonb_agg(to_jsonb(a) order by a.id) from clued_private.resource_center_artifacts_v1 a where a.user_id=$1)) v`,[owner]);
    const before=await snapshot();
    try{
     await blocker.query('begin');await blocker.query("set local lock_timeout='1000ms'");
     await blocker.query('select id from public.clued_memories where id=$1 for update',[artifactDecision]);
     // The real wrapper first takes H in its master snapshot, then reaches L.
     // A server-side timeout bounds a regression without rescuing the lock.
     await db.query("set statement_timeout='1500ms'");
     try{await assert.rejects(scalar('select public.clued_storage_scheduled_recovery_v2($1,$2::jsonb) v',
      [issuer,JSON.stringify({...job.reference,action:'registration_current_load'})]),error=>error.code==='55P03');}
     finally{await db.query('set statement_timeout=0');}
     // The competing replacement order L -> H can now finish immediately.
     assert.equal((await blocker.query('select id from public.clued_memories where id=$1 for update',[decision])).rowCount,1);
     assert.deepEqual(await snapshot(),before);
    }finally{await blocker.query('rollback');await blocker.end();}
   });
   await t.test('a credential that expires while waiting on the actual root lock cannot authorize the program',async()=>{
    const blocker=server.getPgClient(),inspector=server.getPgClient();await blocker.connect();await inspector.connect();
    let work;const expiringProof=crypto.createHash('sha256').update(uuid()).digest('hex');
    try{
     await blocker.query('begin');await blocker.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[owner+':'+f.target.rootId]);
     await db.query(`insert into clued_private.issuer_credentials_v1(issuer_id,generation,verifier,state,activated_at,valid_until)
      select id,2,'cv1:'||encode(extensions.digest('clued.credential-verifier.v1:'||$2,'sha256'),'hex'),'active',clock_timestamp(),clock_timestamp()+interval '2 seconds'
      from clued_private.issuer_identities_v1 where kind='storage' and legacy_key=$1`,[issuer,expiringProof]);
     work=program(expiringProof);void work.catch(()=>{});
     let blocked=false;
     for(let i=0;i<100;i++){
      const row=(await inspector.query('select wait_event from pg_stat_activity where pid=$1',[db.processID])).rows[0];
      if(row?.wait_event==='advisory'){blocked=true;break;}
      await new Promise(resolve=>setTimeout(resolve,10));
     }
     assert.equal(blocked,true,'the authenticated call really waited on another connection');
     await new Promise(resolve=>setTimeout(resolve,2100));await blocker.query('commit');
     await assert.rejects(work,/storage_registration_program_denied/);
    }finally{
     await blocker.query('rollback');if(work)await work.catch(()=>{});
     await blocker.end();await inspector.end();
    }
   });
   // A second unresolved job protects a different object in the same parent.
   // Its ancestor-only overlap must not become a root-wide recovery fence.
   const sibling=await ctx.directoryIn(f.target,f.storage,'independent-'+uuid());
   const siblingJob=await ctx.submitJob(f.target,f.client,ctx.trash(sibling));
   const siblingEngine=ctx.executor(f.target,f.storage,async request=>{
    if(request.action==='provider_attempt'){await ctx.cloud(request);throw Error('synthetic second lost attempt acknowledgement');}
   });
   assert.equal((await siblingEngine.run(siblingJob.reference)).status,'unreconciled');
   const siblingOriginal=await ctx.journal(siblingJob);
   await db.query("update public.clued_audit_receipts set created_at=clock_timestamp()-interval '3 hours' where id=$1",[siblingOriginal.provider_attempt_receipt_id]);
   await db.query("update clued_private.resource_center_mutations_v1 set expires_at=clock_timestamp()-interval '3 hours' where id=$1",[siblingOriginal.id]);
   assert.equal(await scalar('select clued_private.storage_conflict_close_v1($1) v',[siblingOriginal.id]),'conflict');
   // A genuine previously verified create, whose final receipt temporarily
   // failed, remains settleable after I9. Its old ancestor match mode must
   // not be silently invalidated by a new root/parent qualification.
   const typedJob=await ctx.submitJob(f.target,f.client,{operation:'create',target_kind:'file',
    destination_path:source.path.replace(/\/[^/]+$/,'')+'/typed-'+uuid()+'.txt',content:'actual typed proof fixture'});
   let withheld;
   const typedEngine=ctx.executor(f.target,f.storage,async request=>{
    if(request.action==='verified_record'){withheld=structuredClone(request);throw Error('synthetic lost typed-record delivery');}
   });
   assert.equal((await typedEngine.run(typedJob.reference)).status,'unreconciled');assert.ok(withheld);
   assert.equal((await ctx.cloud(withheld)).status,'verified');
   const typedBefore=await ctx.journal(typedJob);assert.ok(typedBefore.verified_result_v2);
   await db.query(`create sequence public.synthetic_registration_typed_failure_calls;
    create function public.synthetic_registration_typed_failure() returns trigger language plpgsql as $$begin
     if new.operation='storage_verified_settle' and new.status='committed' then
      perform nextval('public.synthetic_registration_typed_failure_calls');raise exception 'synthetic_registration_typed_settle_failure';end if;return new;end$$;
    create trigger synthetic_registration_typed_failure before update on public.clued_audit_receipts
     for each row execute function public.synthetic_registration_typed_failure()`);
   try{
    await db.query("update clued_private.resource_center_mutations_v1 set expires_at=clock_timestamp()-interval '3 hours' where id=$1",[typedBefore.id]);
    assert.equal(await scalar('select clued_private.storage_conflict_close_v1($1) v',[typedBefore.id]),'conflict');
    assert.equal(await scalar('select is_called v from public.synthetic_registration_typed_failure_calls'),true);
   }finally{await db.query('drop trigger synthetic_registration_typed_failure on public.clued_audit_receipts;drop function public.synthetic_registration_typed_failure();drop sequence public.synthetic_registration_typed_failure_calls');}
   assert.equal((await ctx.journal(typedJob)).state,'conflict');
   const currentRpc=async input=>scalar('select public.clued_storage_scheduled_recovery_v2($1,$2::jsonb) v',[issuer,JSON.stringify(input)]);
   for(const file of f.storage.files.values()){
    Object.assign(file,{shared:false,permissionIds:['fixture-owner']});
    file.capabilities={...file.capabilities,canShare:true,canListChildren:true};
   }
   // All three Drive versions have advanced. This is a new current
   // qualification, never a claim that the original before-state survived.
   f.storage.files.get(f.target.rootId).version='10';f.storage.files.get(f.target.trackId).version='20';
   f.storage.files.get(source.provider_file_id).version='30';
   // Physical children stay outside this metadata-only registration. Neither
   // their content nor their separate sharing is adopted or rewritten.
   const unmanagedChild={id:'unmanaged-'+uuid(),name:'owner-child',parents:[source.provider_file_id],version:'1',
    trashed:false,mimeType:'text/plain',shared:true};
   f.storage.files.set(unmanagedChild.id,unmanagedChild);const childBefore=structuredClone(unmanagedChild);
   const load=await currentRpc({...job.reference,action:'registration_current_load'});
   const metadata=createGoogleDriveMetadataApi({registration_details:true,
    get_credential:async()=>({access_token:ctx.access_token,scope:scopeString('full')}),fetch:f.storage.fetch});
   const observations=await createGoogleDriveRegistrationRecovery({metadata}).observe(load.registration_plan);
   assert.equal(observations.first_observation.target.empty,false);assert.equal(observations.second_observation.target.empty,false);
   const commit={...job.reference,action:'registration_current_commit',base_version:load.base_version,
    source_receipt_id:load.source_receipt_id,registration_authority:load.registration_authority,
    registration_plan:load.registration_plan,...observations};
   const baseline=await scalar('select to_jsonb(a) v from clued_private.resource_center_artifacts_v1 a where id=$1',[source.id]);
   let receiptCount=await scalar('select count(*)::integer v from public.clued_audit_receipts');
   await t.test('a genuine settleable typed conflict keeps its old ancestor mode until its own result commits',async()=>{
    await assert.rejects(currentRpc(commit),/storage_current_registration_object_busy/);
    assert.deepEqual((await ctx.journal(typedJob)).verified_result_v2,typedBefore.verified_result_v2);
    assert.equal(await scalar('select count(*)::integer v from public.clued_audit_receipts'),receiptCount);
    assert.deepEqual(await scalar('select to_jsonb(a) v from clued_private.resource_center_artifacts_v1 a where id=$1',[source.id]),baseline);
    assert.equal((await ctx.cloud({action:'settle_verified',...typedJob.reference})).status,'committed');
    assert.equal((await ctx.journal(typedJob)).state,'committed');
    receiptCount=await scalar('select count(*)::integer v from public.clued_audit_receipts');
   });
   for(const [name,mutate,pattern] of [
    ['missing child-presence fact',input=>delete input.second_observation.target.empty,/proof_invalid/],
    ['null child-presence fact',input=>input.second_observation.target.empty=null,/proof_invalid/],
    ['string child-presence fact',input=>input.second_observation.target.empty='false',/proof_invalid/],
    ['missing permission evidence',input=>delete input.second_observation.target.owner_permission_id,/proof_invalid/],
    ['numeric permission identity',input=>input.second_observation.target.owner_permission_id=123,/proof_invalid/],
    ['numeric provider version',input=>input.second_observation.target.provider_file_version=30,/proof_invalid/],
    ['forged digest-shaped ACL',input=>input.second_observation.target.access_digest='c'.repeat(64),/acl_changed/],
    ['expired observation',input=>{input.first_observation.observed_at=new Date(Date.now()-60000).toISOString();},/proof_changed/],
    ['changed target second observation',input=>input.second_observation.target.provider_file_version='31',/proof_changed/],
    ['stale Artifact CAS',input=>input.registration_plan.target.artifact_version++,/registration_conflict/],
    ['different original source receipt',input=>input.source_receipt_id=uuid(),/registration_conflict/],
   ])await t.test(name+' rolls back every qualification, permit and receipt',async()=>{
    const input=structuredClone(commit);mutate(input);await assert.rejects(currentRpc(input),pattern);
    assert.equal(await scalar('select count(*)::integer v from public.clued_audit_receipts'),receiptCount);
    assert.deepEqual(await scalar('select to_jsonb(a) v from clued_private.resource_center_artifacts_v1 a where id=$1',[source.id]),baseline);
    assert.equal(await scalar('select count(*)::integer v from clued_private.storage_registration_artifact_permits_v1'),0);
    assert.equal(await scalar('select state v from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[original.id]),'active');
   });
   await t.test('revocation after observation is rechecked before any registry commit',async()=>{
    await db.query('begin');try{
     await db.query("update clued_private.storage_oauth_apps_v1 set execution_enabled=false where issuer_hash=$1",[issuer]);
     await assert.rejects(currentRpc(commit),/program_denied/);
    }finally{await db.query('rollback');}
    assert.deepEqual(await scalar('select to_jsonb(a) v from clued_private.resource_center_artifacts_v1 a where id=$1',[source.id]),baseline);
   });
   await t.test('a final Receipt failure rolls back Artifact updates, isolation exit and all transaction permits',async()=>{
    await db.query(`create function public.synthetic_registration_receipt_failure() returns trigger language plpgsql as $$begin
     if new.operation='storage_current_registration_reconcile' and new.status='committed' then raise exception 'synthetic_registration_commit_failure';end if;return new;end$$;
     create trigger synthetic_registration_receipt_failure before update on public.clued_audit_receipts
      for each row execute function public.synthetic_registration_receipt_failure()`);
    try{
     await assert.rejects(currentRpc(commit),/synthetic_registration_commit_failure/);
     assert.equal(await scalar('select count(*)::integer v from public.clued_audit_receipts'),receiptCount);
     assert.deepEqual(await scalar('select to_jsonb(a) v from clued_private.resource_center_artifacts_v1 a where id=$1',[source.id]),baseline);
     assert.equal(await scalar('select count(*)::integer v from clued_private.storage_registration_artifact_permits_v1'),0);
     assert.equal(await scalar('select count(*)::integer v from clued_private.storage_current_registration_results_v1'),0);
     assert.equal(await scalar('select state v from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[original.id]),'active');
    }finally{await db.query('drop trigger synthetic_registration_receipt_failure on public.clued_audit_receipts;drop function public.synthetic_registration_receipt_failure()');}
   });
   for(const mode of ['path','governance','another_artifact'])await t.test('an exact private metadata permit cannot change '+mode,async()=>{
    await db.query('begin');try{
     const request={idempotency_key:'synthetic-permit-negative:'+uuid()},pending=await scalar(`select to_jsonb(clued_private.m1_begin_receipt(
      $1,null,'storage_current_registration_reconcile',$2::jsonb,clued_private.m1_sha256($2::jsonb))) v`,[owner,JSON.stringify(request)]);
     const changed={...baseline,receipt_id:pending.id,version:baseline.version+1,provider_file_version:'30',
      provider_access_digest:observations.second_observation.target.access_digest,provider_sharing_digest:observations.second_observation.target.sharing_digest};
     if(mode==='path')changed.path+='_forged';if(mode==='governance')changed.governance_class='governance';
     const after=await scalar('select to_jsonb(jsonb_populate_record(null::clued_private.resource_center_artifacts_v1,$1::jsonb)) v',[JSON.stringify(changed)]);
     await db.query(`insert into clued_private.storage_registration_artifact_permits_v1
      values(txid_current(),$1,$2,$3,$4,$5,clued_private.m1_sha256($6::jsonb),clued_private.m1_sha256($7::jsonb))`,
      [source.id,pending.id,original.id,owner,source.profile_id,JSON.stringify(baseline),JSON.stringify(after)]);
     const target=mode==='another_artifact'?sibling.id:source.id;
     await assert.rejects(db.query(`update clued_private.resource_center_artifacts_v1 set path=$2,governance_class=$3,
      provider_file_version=$4,provider_access_digest=$5,provider_sharing_digest=$6,receipt_id=$7,version=version+1 where id=$1`,
      [target,mode==='another_artifact'?sibling.path:after.path,after.governance_class,after.provider_file_version,
       after.provider_access_digest,after.provider_sharing_digest,after.receipt_id]),/storage_current_registration_permit_invalid|storage_object_under_review/);
    }finally{await db.query('rollback');}
    assert.equal(await scalar('select count(*)::integer v from public.clued_audit_receipts'),receiptCount);
    assert.deepEqual(await scalar('select to_jsonb(a) v from clued_private.resource_center_artifacts_v1 a where id=$1',[source.id]),baseline);
   });
   await t.test('a separate Receipt atomically qualifies current ACLs and resolves only the original object',async()=>{
    const result=await currentRpc(commit);
    assert.equal(result.status,'resolved');assert.equal(result.resolution,'automatically_registered_current_state');
    assert.notEqual(result.receipt_id,result.source_receipt_id);assert.equal(result.base_version,load.base_version);
    const updated=await scalar('select to_jsonb(a) v from clued_private.resource_center_artifacts_v1 a where id=$1',[source.id]);
    assert.equal(updated.provider_file_version,'30');assert.ok(updated.provider_access_digest);assert.ok(updated.provider_sharing_digest);
    assert.equal(updated.version,baseline.version+1);assert.equal(updated.receipt_id,result.receipt_id);
    for(const field of ['id','path','provider_file_id','state','target_kind','governance_class','delete_authority','source_decision_id'])assert.deepEqual(updated[field],baseline[field],field);
    const journal=await ctx.journal(job);
    assert.equal(journal.state,'conflict');assert.equal(journal.receipt_id,load.source_receipt_id);assert.equal(journal.verified_result_v2,null);
    assert.deepEqual(journal.provider_attempt,original.provider_attempt);assert.equal(journal.provider_attempt_receipt_id,original.provider_attempt_receipt_id);
    assert.equal(await scalar('select state v from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[original.id]),'resolved');
    assert.equal(await scalar('select state v from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[siblingOriginal.id]),'active');
    assert.deepEqual((await ctx.journal(siblingJob)).provider_attempt,siblingOriginal.provider_attempt);
    assert.equal(await scalar('select status v from public.clued_audit_receipts where id=$1',[result.receipt_id]),'committed');
    const audit=await scalar('select to_jsonb(r) v from public.clued_audit_receipts r where id=$1',[result.receipt_id]);
    for(const node of [...load.registration_plan.parents,load.registration_plan.target]){
     assert.equal(audit.base_versions[node.artifact_id],node.artifact_version);
     assert.equal(audit.committed_versions[node.artifact_id],node.artifact_version+1);
     assert.ok(audit.target_refs.some(ref=>ref.id===node.artifact_id&&ref.role==='target'));
     assert.equal(await scalar('select receipt_id v from clued_private.resource_center_artifacts_v1 where id=$1',[node.artifact_id]),result.receipt_id);
    }
    const total=await scalar('select count(*)::integer v from public.clued_audit_receipts');
    assert.deepEqual(await currentRpc(commit),result);assert.deepEqual(await currentRpc({...job.reference,action:'registration_current_load'}),result);
    assert.equal(await scalar('select count(*)::integer v from public.clued_audit_receipts'),total);
    assert.equal(await scalar('select count(*)::integer v from clued_private.storage_current_registration_results_v1 where intent_id=$1',[original.id]),1);
    assert.deepEqual(f.storage.files.get(unmanagedChild.id),childBefore);
    assert.equal(await scalar('select count(*)::int v from clued_private.resource_center_artifacts_v1 where profile_id=$1 and provider_file_id=$2',[f.target.profile,unmanagedChild.id]),0);
    const oldBefore=baseline,newAfter=updated;
    assert.equal(await scalar(`select clued_private.storage_registration_artifact_permitted_v1(
     jsonb_populate_record(null::clued_private.resource_center_artifacts_v1,$1::jsonb),
     jsonb_populate_record(null::clued_private.resource_center_artifacts_v1,$2::jsonb)) v`,[JSON.stringify(oldBefore),JSON.stringify(newAfter)]),false,
     'a genuine completed transaction permit cannot be replayed in a later transaction');
    const projected=await scalar('select clued_private.storage_conflict_public_status_v1(j) v from clued_private.storage_jobs_v1 j where job_id=$1',[job.reference.job_id]);
    assert.equal(projected.status,'resolved');assert.equal(projected.resolution,'automatically_registered_current_state');
    assert.equal(projected.receipt_id,result.receipt_id);assert.equal(projected.review_available,false);assert.equal(projected.abandon_available,false);
    const normal=await scalar('select clued_private.storage_job_status_v1(j) v from clued_private.storage_jobs_v1 j where job_id=$1',[job.reference.job_id]);
    assert.equal(normal.resolution,'automatically_registered_current_state');assert.notEqual(normal.status,'committed');
   });
   await t.test('forged GUC is not an external credential and helper is owner-only',async()=>{
    const identity=await scalar("select id v from clued_private.issuer_identities_v1 where kind='storage' and legacy_key=$1",[issuer]);
    for(const role of ['anon','authenticated','service_role','clued_worker_gateway']){
     assert.equal(await scalar("select has_function_privilege($1,'clued_private.storage_registration_program_authority_v1(text,uuid,uuid,uuid)','execute') v",[role]),false);
     for(const signature of ['clued_private.storage_current_registration_reconcile_v1(text,jsonb)',
      'clued_private.storage_current_registration_plan_v1(text,uuid,uuid)',
      'clued_private.storage_registration_artifact_permitted_v1(clued_private.resource_center_artifacts_v1,clued_private.resource_center_artifacts_v1)'])
      assert.equal(await scalar('select has_function_privilege($1,$2,\'execute\') v',[role,signature]),false);
     assert.equal(await scalar("select has_table_privilege($1,'clued_private.storage_registration_artifact_permits_v1','insert') v",[role]),false);
    }
    await db.query('begin');try{
     await setWorkerGatewayCaller(db);
     await db.query("select set_config('clued.issuer_credential_context_v1',$1,true)",[JSON.stringify({[identity]:1})]);
     await assert.rejects(db.query('select clued_private.storage_registration_program_authority_v1($1,$2,$3)',[issuer,job.reference.connection_id,job.reference.job_id]),/permission denied/);
    }finally{await db.query('rollback');}
   });
   await assertGatewayCloseoutBoundary(db);
   assert.equal(f.storage.patches,0);assert.equal(f.storage.deletes,0);
  }});
 }finally{
  if(native)await native.end();if(db)await db.end();
  if(started){
   // embedded-postgres.stop resolves on exit, before its Windows stdio has
   // necessarily closed. Wait for producer close before deleting its scratch.
   const producer=server.process,closed=producer?once(producer,'close'):Promise.resolve();
   await stopCluster(server);
   producer?.stdin?.destroy();producer?.stdout?.destroy();producer?.stderr?.destroy();
   await closed;
  }
  const actual=await fs.realpath(directory);assert.equal(path.dirname(actual).toLowerCase(),parent.toLowerCase());
  assert.ok(path.basename(actual).startsWith('kooyumi-registration-db-'));
  await removeTestDirectory(actual);
 }
});
