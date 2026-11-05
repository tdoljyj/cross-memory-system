// Real disposable PostgreSQL. Synthetic identities/time/Drive transport only;
// these tests never query production, change a real grant or mutate Google.
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

test('directory current state: automatic registration preserves the original journal',{timeout:240000},async t=>{
 const parent=await fs.realpath(os.tmpdir()),directory=await fs.mkdtemp(path.join(parent,'kooyumi-registration-db-'));
 const server=new EmbeddedPostgres({databaseDir:directory,user:'postgres',password:uuid(),port:await port(),persistent:true,
  postgresFlags:['-c','listen_addresses=127.0.0.1'],onLog(){},onError(){}});
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

   const prepare=async(initial='active',current='trashed')=>{
    const f=await ctx.setup();let source=await ctx.directoryIn(f.target,f.storage,'state-'+uuid());
    if(initial==='trashed')source=await ctx.trashed(f.target,f.client,f.storage,source);
    const job=await ctx.submitJob(f.target,f.client,initial==='active'?ctx.trash(source):ctx.untrash(source));
    const engine=ctx.executor(f.target,f.storage,async request=>{
     if(request.action==='provider_attempt'){await ctx.cloud(request);throw Error('synthetic lost original attempt acknowledgement');}
    });
    assert.equal((await engine.run(job.reference)).status,'unreconciled');
    const original=await ctx.journal(job);
    await db.query("update public.clued_audit_receipts set created_at=clock_timestamp()-interval '3 hours' where id=$1",[original.provider_attempt_receipt_id]);
    await db.query("update clued_private.resource_center_mutations_v1 set expires_at=clock_timestamp()-interval '3 hours' where id=$1",[original.id]);
    assert.equal(await scalar('select clued_private.storage_conflict_close_v1($1) v',[original.id]),'conflict');
    const issuer=await scalar('select issuer_hash v from clued_private.storage_oauth_apps_v1 where oauth_client_id=$1',[ctx.oauth_client_id]);
    const vault=await createStorageCredentialVault({current_key_id:'synthetic',keys:{synthetic:crypto.randomBytes(32).toString('base64url')}});
    const envelope=await vault.seal(JSON.stringify({token_type:'Bearer',access_token:ctx.access_token,scope:scopeString('full'),expires_at_ms:Date.now()+3600000}),
     {owner_id:owner,connection_id:f.target.connection,provider:'google-drive',provider_subject:ctx.provider_subject,oauth_client_id:ctx.oauth_client_id,credential_version:1});
    await db.query("update clued_private.storage_connections_v1 set credential_envelope=$2,provider_scope_profile='full' where id=$1",[f.target.connection,JSON.stringify(envelope)]);
    const policy=(await native.query("select public.clued_storage_write_access_v1($1::jsonb) v",[JSON.stringify({action:'status',connection_id:f.target.connection})])).rows[0].v;
    const grant=(await native.query("select public.clued_storage_write_access_v1($1::jsonb) v",[JSON.stringify({action:'set_classes',connection_id:f.target.connection,
     classes:['modify','destructive'],base_generation:policy.policy_generation,disclosure_version:'clued.storage-modify-disclosure/1',idempotency_key:uuid()})])).rows[0].v;
    assert.equal(grant.status,'committed');
    for(const file of f.storage.files.values()){
     Object.assign(file,{shared:false,permissionIds:['fixture-owner']});file.capabilities={...file.capabilities,canShare:true,canListChildren:true};
    }
    const target=f.storage.files.get(source.provider_file_id);target.version='30';target.trashed=current==='trashed';target.explicitlyTrashed=target.trashed;
    if(target.trashed)target.capabilities.canListChildren=false;
    const rpc=input=>scalar('select public.clued_storage_scheduled_recovery_v2($1,$2::jsonb) v',[issuer,JSON.stringify(input)]);
    const metadata=createGoogleDriveMetadataApi({registration_details:true,get_credential:async()=>({access_token:ctx.access_token,scope:scopeString('full')}),fetch:f.storage.fetch});
    const load=await rpc({...job.reference,action:'registration_current_load'});
    assert.equal(load.registration_plan.mode,'refresh_directory_state');assert.equal(load.registration_plan.target.registered_state,initial);
    const observations=await createGoogleDriveRegistrationRecovery({metadata}).observe(load.registration_plan);
    const commit={...job.reference,action:'registration_current_commit',base_version:load.base_version,source_receipt_id:load.source_receipt_id,
     registration_authority:load.registration_authority,registration_plan:load.registration_plan,...observations};
    return {f,source,job,original,issuer,target,rpc,load,commit};
   };
   const snapshot=async()=>scalar(`select jsonb_build_object(
    'artifacts',(select jsonb_agg(to_jsonb(x) order by id) from clued_private.resource_center_artifacts_v1 x),
    'mutations',(select jsonb_agg(to_jsonb(x) order by id) from clued_private.resource_center_mutations_v1 x),
    'isolations',(select jsonb_agg(to_jsonb(x) order by intent_id) from clued_private.storage_conflict_isolations_v1 x),
    'results',(select jsonb_agg(to_jsonb(x) order by intent_id) from clued_private.storage_current_registration_results_v1 x),
    'permits',(select count(*) from clued_private.storage_directory_state_permits_v3),
    'receipts',(select count(*) from public.clued_audit_receipts)) v`);
   for(const initial of ['active','trashed'])for(const current of ['active','trashed'])await t.test(initial+' registry -> '+current+' Drive is a new atomic qualification, never original success',async()=>{
    const x=await prepare(initial,current),before=await ctx.artifactById(x.source.id),oldJournal=await ctx.journal(x.job),files=structuredClone([...x.f.storage.files]);
    assert.equal(x.commit.second_observation.target.current_state,current);
    assert.equal(x.commit.second_observation.target.empty,current==='trashed'?null:true);
    const result=await x.rpc(x.commit);assert.equal(result.status,'resolved');assert.equal(result.current_artifact_state,current);
    assert.notEqual(result.receipt_id,result.source_receipt_id);
    const after=await ctx.artifactById(x.source.id);assert.equal(after.state,current);assert.equal(Number(after.version),Number(before.version)+1);
    assert.equal(after.receipt_id,result.receipt_id);
    for(const key of ['id','user_id','profile_id','path','provider_file_id','target_kind','governance_class','delete_authority','source_decision_id'])assert.deepEqual(after[key],before[key],key);
    const journal=await ctx.journal(x.job);assert.equal(journal.state,'conflict');
    for(const key of ['receipt_id','provider_attempt','provider_attempt_receipt_id','verified_result_v2','exact_request','authority_request'])assert.deepEqual(journal[key],oldJournal[key],key);
    assert.deepEqual([...x.f.storage.files],files);
    const publicState=await scalar(`select clued_private.storage_conflict_public_status_v1(j) v from clued_private.storage_jobs_v1 j where connection_id=$1 and job_id=$2`,[x.job.reference.connection_id,x.job.reference.job_id]);
    assert.equal(publicState.current_artifact_state,current);
    const inspectState=await scalar(`select clued_private.storage_job_status_v1(j) v from clued_private.storage_jobs_v1 j where connection_id=$1 and job_id=$2`,[x.job.reference.connection_id,x.job.reference.job_id]);
    assert.equal(inspectState.current_artifact_state,current);
    const saved=await snapshot();assert.deepEqual(await x.rpc(x.commit),result);assert.deepEqual(await snapshot(),saved);
    assert.equal(x.f.storage.deletes,0);
   });
   const x=await prepare('active','trashed');
   const rejectSeed=async(seed,pattern)=>{
    await db.query('begin');try{
     await seed();const before=await snapshot();await db.query('savepoint recover_attempt');
     await assert.rejects(x.rpc(x.commit),pattern);await db.query('rollback to savepoint recover_attempt');
     assert.deepEqual(await snapshot(),before);
    }finally{await db.query('rollback');}
   };
   await t.test('a registered descendant is not silently reclassified with its directory',async()=>{
    await rejectSeed(async()=>{
     // Disposable adversarial historical registry, not an executable insert API.
     await db.query('set local session_replication_role=replica');
     await db.query(`insert into clued_private.resource_center_artifacts_v1 select (jsonb_populate_record(null::clued_private.resource_center_artifacts_v1,
      to_jsonb(a)||jsonb_build_object('id',$2::text,'path',a.path||'/nested','provider_file_id',$3::text))).*
      from clued_private.resource_center_artifacts_v1 a where id=$1`,[x.source.id,uuid(),'synthetic-child-'+uuid()]);
     await db.query('set local session_replication_role=origin');
    },/storage_current_registration_unavailable/);
   });
   await t.test('a physical alias in another profile is protected globally',async()=>{
    const other=await ctx.setup();
    await rejectSeed(async()=>{
     await db.query('set local session_replication_role=replica');
     await db.query(`insert into clued_private.resource_center_artifacts_v1 select (jsonb_populate_record(null::clued_private.resource_center_artifacts_v1,
      to_jsonb(a)||jsonb_build_object('id',$2::text,'profile_id',$3::text,'path',$4::text))).*
      from clued_private.resource_center_artifacts_v1 a where id=$1`,[x.source.id,uuid(),other.target.profile,other.target.root+'/20_P_产品与体验/alias']);
     await db.query('set local session_replication_role=origin');
    },/storage_directory_state_permit_invalid/);
   });
   await t.test('the physical object lock held by another database connection aborts without waiting',async()=>{
    const blocker=server.getPgClient();await blocker.connect();const before=await snapshot();
    try{await blocker.query('begin');await blocker.query("select pg_advisory_xact_lock(hashtextextended('storage-object:'||$1,0))",[x.source.provider_file_id]);
     await db.query("set statement_timeout='1500ms'");
     await assert.rejects(x.rpc(x.commit),/storage_current_registration_object_busy/);
     assert.deepEqual(await snapshot(),before);
    }finally{await db.query('set statement_timeout=0');await blocker.query('rollback');await blocker.end();}
   });
   await t.test('final independent Receipt failure rolls back state, metadata, isolation, result and permits',async()=>{
    await rejectSeed(async()=>{await db.query(`create function public.synthetic_state_receipt_failure() returns trigger language plpgsql as $$begin
     if new.operation='storage_current_registration_reconcile' and new.status='committed' then raise exception 'synthetic_state_receipt_failure';end if;return new;end$$;
     create trigger synthetic_state_receipt_failure before update on public.clued_audit_receipts for each row execute function public.synthetic_state_receipt_failure()`);},/synthetic_state_receipt_failure/);
   });
   for(const [name,change] of [
    ['missing state',v=>delete v.second_observation.target.current_state],
    ['string state typo',v=>v.second_observation.target.current_state='deleted'],
    ['trash child absence invented',v=>v.second_observation.target.empty=true],
    ['registered state tampered',v=>v.registration_plan.target.registered_state='trashed'],
    ['registered state omitted',v=>delete v.second_observation.target.registered_state],
    ['different double read state',v=>{v.first_observation.target.current_state='active';v.first_observation.target.empty=true;}],
    ['stale version',v=>v.base_version++],
    ['wrong source Receipt',v=>v.source_receipt_id=uuid()],
    ['forged ACL',v=>v.second_observation.target.access_digest='c'.repeat(64)],
    ['Agent confirmation',v=>v.confirmed=true],
   ])await t.test(name+' is atomic refusal',async()=>{
    const input=structuredClone(x.commit);change(input);const before=await snapshot();await assert.rejects(x.rpc(input));assert.deepEqual(await snapshot(),before);
   });
   await t.test('overlapping quarantines protect their scopes while an unrelated same-parent quarantine does not block',async st=>{
    const sibling=await ctx.directoryIn(x.f.target,x.f.storage,'other-'+uuid());
    const job=await ctx.submitJob(x.f.target,x.f.client,ctx.trash(sibling));
    const engine=ctx.executor(x.f.target,x.f.storage,async req=>{if(req.action==='provider_attempt'){await ctx.cloud(req);throw Error('synthetic lost sibling reply');}});
    assert.equal((await engine.run(job.reference)).status,'unreconciled');const original=await ctx.journal(job);
    await db.query("update public.clued_audit_receipts set created_at=clock_timestamp()-interval '3 hours' where id=$1",[original.provider_attempt_receipt_id]);
    await db.query("update clued_private.resource_center_mutations_v1 set expires_at=clock_timestamp()-interval '3 hours' where id=$1",[original.id]);
    assert.equal(await scalar('select clued_private.storage_conflict_close_v1($1) v',[original.id]),'conflict');
    const before=await scalar('select to_jsonb(q) v from clued_private.storage_conflict_isolations_v1 q where intent_id=$1',[original.id]);
    for(const [name,sql,args] of [
     ['unknown scope',"update clued_private.storage_conflict_isolations_v1 set scope_complete=false where intent_id=$1",[original.id]],
     ['same object',"update clued_private.storage_conflict_isolations_v1 set object_ids=array[$2] where intent_id=$1",[original.id,x.source.provider_file_id]],
     ['ancestor-dependent work',"update clued_private.storage_conflict_isolations_v1 set ancestor_ids=array[$2] where intent_id=$1",[original.id,x.source.provider_file_id]],
     ['child namespace',"update clued_private.storage_conflict_isolations_v1 set slots=jsonb_build_array(jsonb_build_object('parent_id',$2::text,'name','new')) where intent_id=$1",[original.id,x.source.provider_file_id]],
     ['containing subtree',"update clued_private.storage_conflict_isolations_v1 set subtree_paths=array[$2] where intent_id=$1",[original.id,x.source.path.replace(/\/[^/]+$/,'')]],
     ['descendant subtree',"update clued_private.storage_conflict_isolations_v1 set subtree_paths=array[$2] where intent_id=$1",[original.id,x.source.path+'/child']],
    ])await st.test(name+' remains protected with no new Receipt or state change',async()=>{
     await rejectSeed(async()=>{
      // Seed each adversarial historical scope only in this disposable DB;
      // immutable production isolations are never edited through recovery.
      await db.query('set local session_replication_role=replica');await db.query(sql,args);
      await db.query('set local session_replication_role=origin');
     },/storage_object_under_review/);
    });
    assert.equal((await x.rpc(x.commit)).current_artifact_state,'trashed');
    assert.deepEqual(await scalar('select to_jsonb(q) v from clued_private.storage_conflict_isolations_v1 q where intent_id=$1',[original.id]),before);
   });
   for(const role of ['anon','authenticated','service_role','clued_worker_gateway'])await t.test(role+' has no private state permit or helper access',async()=>{
    for(const name of ['storage_directory_state_plan_v3(text,uuid,uuid)','storage_directory_state_observation_v3(jsonb,jsonb)',
     'storage_directory_state_reconcile_v3(text,jsonb)','storage_directory_state_permitted_v3(clued_private.resource_center_artifacts_v1,clued_private.resource_center_artifacts_v1)'])
     assert.equal(await scalar("select has_function_privilege($1,$2,'execute') v",[role,'clued_private.'+name]),false);
    assert.equal(await scalar("select has_table_privilege($1,'clued_private.storage_directory_state_permits_v3','insert') v",[role]),false);
   });
   await assertGatewayCloseoutBoundary(db);
  }});
 }finally{
  if(native)await native.end();if(db)await db.end();
  if(started){
   // embedded-postgres.stop resolves on exit, before its Windows stdio has
   // necessarily closed. Wait for producer close before deleting its scratch.
   const producer=server.process,closed=producer?once(producer,'close'):Promise.resolve();
   await server.stop();
   producer?.stdin?.destroy();producer?.stdout?.destroy();producer?.stderr?.destroy();
   await closed;
  }
  const actual=await fs.realpath(directory);assert.equal(path.dirname(actual).toLowerCase(),parent.toLowerCase());
  assert.ok(path.basename(actual).startsWith('kooyumi-registration-db-'));
  await fs.rm(actual,{recursive:true,force:false,maxRetries:5,retryDelay:100});
 }
});
