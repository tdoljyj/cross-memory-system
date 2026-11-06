// issuer-credentials: disposable PostgreSQL only. Synthetic issuer credentials,
// users and provider metadata exercise the actual migration and caller boundary;
// no production connection, Google request, secret or file body is used.
import { stopCluster, removeTestDirectory } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import {allowTestIssuerCredentials} from './issuer-credentials-fixture.mjs';
import {allowRawTestBindings} from './raw-binding-grants-fixture.mjs';
import {setWorkerGatewayCaller,assertGatewayCloseoutBoundary} from './worker-gateway-caller-fixture.mjs';
import {createResourceCenterCloudExecutor} from '../../../kernel/host/resource-center-cloud-executor.mjs';
import {createGoogleDriveMetadataApi} from '../../../kernel/host/resource-center-google-drive-metadata.mjs';
import {createGoogleDriveCreatePostconditionVerifier} from '../../../kernel/host/resource-center-google-drive-postcondition.mjs';
import {build,stop} from 'esbuild';
const cloud=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const id=()=>crypto.randomUUID(),sha=v=>crypto.createHash('sha256').update(v).digest('hex');
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}

test('A4 I9 conflict isolation: actual PostgreSQL migration and scoped receipts',{timeout:240000},async t=>{
 const dir=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'kooyumi-conflict-db-'));
 const server=new EmbeddedPostgres({databaseDir:dir,user:'postgres',password:sha(id()),port:await port(),persistent:true,
  postgresFlags:['-c','listen_addresses=127.0.0.1'],onLog(){},onError(){}});
 const clients=[];let started=false;
 try{
  await server.initialise();await server.start();started=true;
  const db=server.getPgClient();clients.push(db);await db.connect();
  await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
   create role authenticator nologin noinherit;create schema auth;create schema extensions;create extension pgcrypto with schema extensions;
   create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
   create table auth.sessions(id uuid primary key,user_id uuid not null,not_after timestamptz);
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
   grant usage on schema auth,extensions to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;
   -- Only pg_cron's registration transport is synthetic; the actual sweep runs below.
   create schema cron;create table cron.job(jobid bigserial primary key,jobname text unique,schedule text,command text,active boolean default true,database text default current_database(),username text default current_user);
   create function cron.schedule(text,text,text) returns bigint language sql as $$insert into cron.job(jobname,schedule,command) values($1,$2,$3)
    on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command,active=true returning jobid$$;
   create table public.test_storage_publication_ledger(version text primary key);
   create function public.test_storage_publication_v1(p_sql text,p_version text) returns void language plpgsql as $$begin
    execute p_sql;
    if to_regprocedure('clued_private.storage_conflict_require_scheduler_v1()') is not null then
     perform clued_private.storage_conflict_require_scheduler_v1();
    end if;
    insert into public.test_storage_publication_ledger(version) values(p_version);
   end$$;
   revoke all on function public.test_storage_publication_v1(text,text) from public,anon,authenticated,service_role;`);
  for(const name of (await fs.readdir(path.join(cloud,'supabase/migrations'))).filter(n=>n.endsWith('.sql')).sort()){
   try{
    const migration=await fs.readFile(path.join(cloud,'supabase/migrations',name),'utf8');
    if(name==='20261016040000_storage_conflict_isolation_v1.sql'){
     // A generic schema consumer can load the migration without pg_cron;
     // neither loading it nor the sweep may assert scheduler readiness.
     await db.query('begin');try{
      await db.query('drop schema cron cascade');await db.query(migration);
      assert.equal((await db.query("select to_regprocedure('clued_private.storage_conflict_require_scheduler_v1()') is not null ready")).rows[0].ready,true);
      await db.query('savepoint missing_scheduler');
      await assert.rejects(db.query('select clued_private.storage_conflict_require_scheduler_v1()'),/storage_conflict_scheduler_required/);await db.query('rollback to savepoint missing_scheduler');
      await assert.rejects(db.query('select clued_private.storage_conflict_sweep_v1()'),/storage_conflict_scheduler_required/);
     }finally{await db.query('rollback');}
     // Production-shaped publication executes this actual complete migration,
     // checks the scheduler, then writes its ledger within one transaction.
     await db.query('begin');try{
      await db.query('drop schema cron cascade');await assert.rejects(db.query('select public.test_storage_publication_v1($1,$2)',[migration,name]),/storage_conflict_scheduler_required/);
     }finally{await db.query('rollback');}
     assert.equal((await db.query("select to_regprocedure('clued_private.storage_conflict_require_scheduler_v1()') is null absent")).rows[0].absent,true,'failed publication rolls back the actual migration DDL');
     assert.equal((await db.query('select count(*)::int n from public.test_storage_publication_ledger where version=$1',[name])).rows[0].n,0);
     await db.query('select public.test_storage_publication_v1($1,$2)',[migration,name]);
     assert.equal((await db.query('select count(*)::int n from public.test_storage_publication_ledger where version=$1',[name])).rows[0].n,1,'available exact scheduler commits DDL and ledger together');
    }else await db.query(migration);
   }
   catch(error){throw new Error('Migration '+name+': '+error.message,{cause:error});}
  }
  await t.test('scheduler readiness and publication ledger fail closed together',async()=>{
   const check=()=>db.query('select clued_private.storage_conflict_require_scheduler_v1()');await check();
   for(const fault of [()=>db.query('drop function cron.schedule(text,text,text)'),()=>db.query("update cron.job set active=false where jobname='clued-storage-i9-conflict'"),()=>db.query("update cron.job set command='select 1' where jobname='clued-storage-i9-conflict'"),()=>db.query("update cron.job set schedule='*/2 * * * *' where jobname='clued-storage-i9-conflict'"),()=>db.query("update cron.job set database='different_database' where jobname='clued-storage-i9-conflict'"),()=>db.query("update cron.job set username='anon' where jobname='clued-storage-i9-conflict'")]){
    await db.query('begin');try{await fault();await assert.rejects(check(),/storage_conflict_scheduler_required|storage_conflict_scheduler_unconfirmed/);}finally{await db.query('rollback');}
   }
   await db.query('begin');try{
    await db.query("update cron.job set active=false where jobname='clued-storage-i9-conflict'");
    await assert.rejects(db.query('select public.test_storage_publication_v1($1,$2)',['create table public.test_failed_storage_ddl(id integer)','disabled-publication']),/storage_conflict_scheduler_unconfirmed/);
   }finally{await db.query('rollback');}
   assert.equal((await db.query("select to_regclass('public.test_failed_storage_ddl') is null absent")).rows[0].absent,true);
   assert.equal((await db.query("select count(*)::int n from public.test_storage_publication_ledger where version='disabled-publication'")).rows[0].n,0);
   await db.query('select public.test_storage_publication_v1($1,$2)',['create table public.test_successful_storage_ddl(id integer)','active-publication']);
   assert.equal((await db.query("select to_regclass('public.test_successful_storage_ddl') is not null ready")).rows[0].ready,true);
   assert.equal((await db.query("select count(*)::int n from public.test_storage_publication_ledger where version='active-publication'")).rows[0].n,1);
   const workflow=await fs.readFile(path.resolve(cloud,'../../.github/workflows/clued-cloud-production-release.yml'),'utf8'),execute=workflow.indexOf('            execute s;'),scheduler=workflow.indexOf('              perform clued_private.storage_conflict_require_scheduler_v1();',execute),ledger=workflow.indexOf('            insert into supabase_migrations.schema_migrations(',scheduler),commit=workflow.indexOf('          commit;',ledger);
   assert.ok(execute>workflow.indexOf('-c "begin;')&&scheduler>execute&&ledger>scheduler&&commit>ledger,'actual publisher orders execute → readiness → ledger → commit');
   assert.match(workflow.slice(execute,ledger),/if to_regprocedure\('clued_private\.storage_conflict_require_scheduler_v1\(\)'\) is not null then/);assert.doesNotMatch(workflow.slice(execute,ledger),/\bcommit\s*;/i);
  });
  await allowTestIssuerCredentials(db);
  await allowRawTestBindings(db);
  const owner=id(),other=id(),project=id(),decision=id(),session=id(),otherSession=id(),issuer=sha(id()),client='conflict.synthetic.invalid';
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'owner@synthetic.invalid',now()),($2,'other@synthetic.invalid',now())",[owner,other]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2),($3,$4)',[session,owner,otherSession,other]);
  await db.query("insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at) values($1,$2,'Isolation','isolation',$3,'confirmed',now())",[project,owner,'project:'+project]);
  await db.query(`insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,record_schema_version,lifecycle_status,
   canonical_scope,type_fields,relations,source_refs,authority,confidence_reason) values($1,$2,'Synthetic approval','Disposable only','project',$3,'decision','active',1,'active',
   $4,'{"rationale":"test fixture"}','{}','{}','user_explicit','Owner confirmed')`,[decision,owner,project,'project:'+project]);
  const register=async input=>(await db.query('select public.clued_resource_center_admin_v1($1,$2::jsonb) v',[owner,JSON.stringify({source_decision_id:decision,idempotency_key:id(),...input})])).rows[0].v;
  const root='/synthetic/Clued_资料中心',rootId='root-'+id(),parent='track-'+id();
  const registered=await register({action:'profile_register',project_id:project,profile_version:'isolation/1',managed_root:root,root_folder_id:rootId,root_parent_id:'my-drive',root_folder_version:'1'});
  assert.equal(registered.status,'committed',JSON.stringify(registered));const profile=registered.target_refs.find(r=>r.role==='primary').id;
  await register({action:'artifact_register',profile_id:profile,path:root+'/docs',provider_file_id:parent,provider_file_version:'1',target_kind:'directory',governance_class:'ordinary',delete_authority:false});
  const file='file-'+id(),filePath=root+'/docs/original.zip';
  await register({action:'artifact_register',profile_id:profile,path:filePath,provider_file_id:file,provider_file_version:'2',target_kind:'file',governance_class:'ordinary',delete_authority:false});
  const receipt=async()=> (await db.query("insert into public.clued_audit_receipts(user_id,context_key,operation,object_type,object_id,metadata) values($1,'global','resource_center_journal','system',$2,'{}') returning id",[owner,id()])).rows[0].id;
  const seed=async({state='started',operation='replace',target_kind='file',age='3 hours',providerAttempt=true,destination=filePath,source=null,fixtureProfile=profile,fixtureRoot=rootId,fixtureParent=parent}={})=>{
   const intent=id(),r=await receipt(),syntheticParent=target_kind==='directory'?'isolated-parent-'+id():fixtureParent,before={root_folder_id:fixtureRoot,root_parent_id:'my-drive',destination_file_id:destination===filePath?file:'unrelated-'+id(),destination_parent_id:syntheticParent,
    source_file_id:source?(source===root+'/docs'?file:'unrelated-directory-'+id()):null,source_parent_id:source?syntheticParent:null,ancestors:[{id:fixtureRoot},{id:syntheticParent}]};
   const mutation={operation,target_kind,source_path:source,destination_path:destination};
   await db.query(`insert into clued_private.resource_center_mutations_v1(id,user_id,profile_id,request_key,request_sha256,exact_request,authority_request,
    authority_result,authority_token_hash,profile_version,source_decision_id,state,version,expires_at,receipt_id,provider_attempt,provider_attempt_receipt_id)
    values($1,$2,$3,$4,$5,$6,$7,'{}',$5,1,$8,$9,$10,clock_timestamp()-$11::interval,$12,$13,$14)`,
    [intent,owner,fixtureProfile,id(),sha(id()),{mutation},{mutation,provider_identity:before},decision,state,state==='prepared'?1:2,age,r,
     providerAttempt?{provider_file_id:file,parent_id:parent}:null,providerAttempt?r:null]);return intent;
  };
  const inspect=async intent=>(await db.query('select state,version,receipt_id,final_result from clued_private.resource_center_mutations_v1 where id=$1',[intent])).rows[0];
  const guard=async(mutation,provider={})=>db.query('select clued_private.storage_conflict_assert_v1($1,$2,$3,$4)',[owner,profile,mutation,provider]);
  const intent=await seed();
  await t.test('production sweep ends an expired non-job journal as conflict with an independent object isolation',async()=>{
   assert.equal((await db.query('select clued_private.storage_conflict_supported_v1($1) v',[intent])).rows[0].v,true);
   const result=(await db.query('select clued_private.storage_conflict_sweep_v1() v')).rows[0].v;
   assert.equal(result.conflicted,1);assert.equal(result.errors,0);assert.equal((await inspect(intent)).state,'conflict');
   const q=(await db.query('select state,scope_complete,job_id,connection_id,object_ids from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[intent])).rows[0];
   assert.equal(q.state,'active');assert.equal(q.scope_complete,true);assert.equal(q.job_id,null);assert.equal(q.connection_id,null);
   assert.ok(q.object_ids.includes(file));
  });
  await t.test('the original conflict receipt survives repeated public classification without another effect',async()=>{
   const previous=await inspect(intent);
   assert.equal((await db.query('select clued_private.storage_conflict_close_v1($1) v',[intent])).rows[0].v,'unchanged');
   const m=await inspect(intent);assert.equal(m.state,'conflict');assert.equal(m.version,'3');assert.equal(m.final_result.reason_code,'PROVIDER_STATE_CONFLICT');
   const r=(await db.query('select operation,status,event_ids from public.clued_audit_receipts where id=$1',[m.receipt_id])).rows[0];
   assert.equal(r.operation,'storage_conflict_settle');assert.equal(r.status,'committed');assert.ok(r.event_ids.length);
   assert.deepEqual(m,previous);
   assert.equal((await db.query('select clued_private.storage_conflict_close_candidate_v1($1) v',[intent])).rows[0].v,'unchanged');
  });
  await t.test('prepared non-job work releases only after 60 seconds without inventing an effect or isolation',async()=>{
   await db.query('begin');try{
    const pending=await seed({state:'prepared',age:'30 seconds',providerAttempt:false,destination:root+'/docs/prepared.txt'});
    assert.equal((await db.query('select clued_private.storage_conflict_close_v1($1) v',[pending])).rows[0].v,'not_due');
    await db.query("update clued_private.resource_center_mutations_v1 set expires_at=clock_timestamp()-interval '61 seconds' where id=$1",[pending]);
    assert.equal((await db.query('select clued_private.storage_conflict_close_v1($1) v',[pending])).rows[0].v,'cancelled');
    const row=await inspect(pending);assert.equal(row.state,'cancelled');assert.equal(row.final_result.reason_code,'NO_PROVIDER_ATTEMPT');
    assert.equal((await db.query('select count(*)::int n from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[pending])).rows[0].n,0);
   }finally{await db.query('rollback');}
  });
  await t.test('a started non-job writer without a database attempt is never inferred to have no provider effect',async()=>{
   await db.query('begin');try{
    const pending=await seed({age:'10 minutes',providerAttempt:false,destination:root+'/docs/unknown-effect.txt'});
    assert.equal((await db.query('select clued_private.storage_conflict_close_v1($1) v',[pending])).rows[0].v,'not_due');
    await db.query("update clued_private.resource_center_mutations_v1 set expires_at=clock_timestamp()-interval '3 hours' where id=$1",[pending]);
    assert.equal((await db.query('select clued_private.storage_conflict_close_v1($1) v',[pending])).rows[0].v,'conflict');
    const row=await inspect(pending);assert.equal(row.final_result.reason_code,'PROVIDER_STATE_CONFLICT');
    const q=(await db.query('select * from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[pending])).rows[0];
    const input={action:'conflict_abandon',intent_id:pending,base_version:Number(row.version),source_receipt_id:q.close_receipt_id,idempotency_key:id(),confirmed:true};
    await db.query('savepoint missing_termination');
    await assert.rejects(db.query('select clued_private.storage_conflict_abandon_v1($1,$2::jsonb)',[owner,JSON.stringify(input)]),/storage_conflict_termination_evidence_required/);
    await db.query('rollback to savepoint missing_termination');
    assert.deepEqual(await inspect(pending),row);
    assert.equal((await db.query('select state from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[pending])).rows[0].state,'active');
   }finally{await db.query('rollback');}
  });
  await t.test('same-parent legacy rename derives its source slot only from immutable exact paths and destination identity',async()=>{
   await db.query('begin');try{
    const pending=await seed({operation:'rename',source:root+'/docs/old-name.txt',destination:root+'/docs/new-name.txt'});
    await db.query("update clued_private.resource_center_mutations_v1 set authority_request=authority_request#-'{provider_identity,source_parent_id}' where id=$1",[pending]);
    assert.equal((await db.query('select clued_private.storage_conflict_close_v1($1) v',[pending])).rows[0].v,'conflict');
    const q=(await db.query('select scope_complete,slots from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[pending])).rows[0];
    assert.equal(q.scope_complete,true);assert.deepEqual(q.slots.map(slot=>slot.parent_id),[parent,parent]);
   }finally{await db.query('rollback');}
   await db.query('begin');try{
    const pending=await seed({operation:'rename',source:root+'/unknown/old-name.txt',destination:root+'/docs/new-name.txt'});
    await db.query("update clued_private.resource_center_mutations_v1 set authority_request=authority_request#-'{provider_identity,source_parent_id}' where id=$1",[pending]);
    assert.equal((await db.query('select clued_private.storage_conflict_close_v1($1) v',[pending])).rows[0].v,'conflict');
    assert.equal((await db.query('select scope_complete from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[pending])).rows[0].scope_complete,false);
   }finally{await db.query('rollback');}
  });
  await t.test('unrelated create is admitted while original file, namespace aliases and ancestor directory moves stay fenced',async()=>{
   await guard({operation:'create',target_kind:'file',destination_path:root+'/docs/unrelated.txt'},{destination_parent_id:parent});
   await guard({operation:'move',target_kind:'directory',source_path:root+'/docs/sibling',destination_path:root+'/elsewhere/sibling',source_file_id:'sibling-'+id()},{source_parent_id:parent,destination_parent_id:'distinct-parent-'+id()});
   await register({action:'artifact_register',profile_id:profile,path:root+'/docs/unrelated.txt',provider_file_id:'other-'+id(),provider_file_version:'1',target_kind:'file',governance_class:'ordinary',delete_authority:false});
   for(const [m,p] of [[{operation:'replace',target_kind:'file',destination_path:filePath},{}],
    [{operation:'replace',target_kind:'file',destination_path:root+'/alias.zip'},{destination_file_id:file}],
    [{operation:'create',target_kind:'file',destination_path:'/alias/original.zip'},{destination_parent_id:parent}],
    [{operation:'move',target_kind:'directory',source_path:root+'/docs',destination_path:root+'/other/docs',source_file_id:parent},{}]])
    await assert.rejects(guard(m,p),e=>e.code==='42501'&&e.message==='storage_object_under_review');
  });
  await t.test('physical file and parent/name aliases remain fenced across roots, profiles and Owners',async()=>{
   const alternate=await register({action:'profile_register',project_id:project,profile_version:'other-root/1',managed_root:'/alternate/Clued_资料中心',root_folder_id:'alternate-'+id(),root_parent_id:'my-drive',root_folder_version:'1'});
   const alternateProfile=alternate.target_refs.find(r=>r.role==='primary').id;
   const otherProject=id(),otherDecision=id();
   await db.query("insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at) values($1,$2,'Other fixture','other-fixture',$3,'confirmed',now())",[otherProject,other,'project:'+otherProject]);
   await db.query(`insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason)
    values($1,$2,'Other synthetic approval','Disposable only','project',$3,'decision','active',1,'active',$4,'{"rationale":"test fixture"}','{}','{}','user_explicit','Owner confirmed')`,[otherDecision,other,otherProject,'project:'+otherProject]);
   const otherRegistered=(await db.query('select public.clued_resource_center_admin_v1($1,$2::jsonb) v',[other,JSON.stringify({action:'profile_register',project_id:otherProject,profile_version:'other-owner/1',managed_root:'/other-owner/Clued_资料中心',root_folder_id:'other-owner-'+id(),root_parent_id:'my-drive',root_folder_version:'1',source_decision_id:otherDecision,idempotency_key:id()})])).rows[0].v;
   assert.equal(otherRegistered.status,'committed');const otherProfile=otherRegistered.target_refs.find(r=>r.role==='primary').id;
   for(const [user,profileId] of [[owner,alternateProfile],[other,otherProfile]]){
    await db.query('select clued_private.storage_conflict_assert_v1($1,$2,$3,$4)',[user,profileId,{operation:'create',target_kind:'file',destination_path:'/unrelated/different.txt'},{destination_parent_id:'distinct-parent-'+id()}]);
    for(const [mutation,provider] of [[{operation:'replace',target_kind:'file',destination_path:'/renamed/alias.zip'},{destination_file_id:file}],
     [{operation:'create',target_kind:'file',destination_path:'/renamed/original.zip'},{destination_parent_id:parent}],
     [{operation:'move',target_kind:'directory',source_path:'/alias/ancestor',destination_path:'/elsewhere/ancestor',source_file_id:parent},{}]])
     await assert.rejects(db.query('select clued_private.storage_conflict_assert_v1($1,$2,$3,$4)',[user,profileId,mutation,provider]),/storage_object_under_review/);
   }
  });
  await t.test('I11 cannot be bypassed by a GUC, direct registry update, deletion or raw isolation update',async()=>{
   await db.query("select set_config('clued.storage_review','true',false)");
   await assert.rejects(db.query("update clued_private.storage_conflict_isolations_v1 set state='resolved',resolution_receipt_id=close_receipt_id where intent_id=$1",[intent]),/storage_isolation_immutable/);
   await assert.rejects(db.query('delete from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[intent]),/storage_isolation_immutable/);
   await assert.rejects(db.query("update clued_private.resource_center_artifacts_v1 set state='revoked' where user_id=$1 and provider_file_id=$2",[owner,file]),/storage_object_under_review/);
   await assert.rejects(db.query('delete from clued_private.resource_center_artifacts_v1 where user_id=$1 and provider_file_id=$2',[owner,file]),/storage_object_under_review/);
  });
  await t.test('all API roles are denied direct sweep, guards and isolation data',async()=>{
   await assertGatewayCloseoutBoundary(db);
   assert.equal((await db.query("select count(*)::int n from cron.job where jobname='clued-storage-i9-conflict' and active and schedule='* * * * *' and command='select clued_private.storage_conflict_sweep_v1()'")).rows[0].n,1,'DB scheduler registration is mandatory and exact');
   for(const role of ['anon','authenticated','service_role','clued_worker_gateway']){
    for(const signature of ['storage_conflict_sweep_v1()','storage_conflict_close_v1(uuid)','storage_conflict_close_candidate_v1(uuid)','storage_conflict_supported_v1(uuid)','storage_conflict_assert_v1(uuid,uuid,jsonb,jsonb)','storage_automatic_reconcile_v1(text,jsonb)','storage_automatic_reconcile_candidate_v1(clued_private.storage_jobs_v1)','storage_conflict_load_before_automatic_v1(text,jsonb)'])
     assert.equal((await db.query('select has_function_privilege($1,$2,\'execute\') v',[role,'clued_private.'+signature])).rows[0].v,false);
    assert.equal((await db.query("select has_table_privilege($1,'clued_private.storage_conflict_isolations_v1','update') v",[role])).rows[0].v,false);
    assert.equal((await db.query("select has_table_privilege($1,'clued_private.storage_automatic_reconcile_checks_v1','select,insert,update,delete') v",[role])).rows[0].v,false);
   }
  });
  await t.test('prepared expires without creating a quarantine; a directory move keeps native recovery',async()=>{
   const prepared=await seed({state:'prepared',destination:root+'/docs/prepared.txt',providerAttempt:false});
   assert.equal((await db.query('select clued_private.storage_conflict_close_candidate_v1($1) v',[prepared])).rows[0].v,'cancelled');
   assert.equal((await inspect(prepared)).state,'cancelled');
   const directory=await seed({operation:'move',target_kind:'directory',source:root+'/elsewhere',destination:root+'/other/elsewhere'});
   assert.equal((await db.query('select clued_private.storage_conflict_close_candidate_v1($1) v',[directory])).rows[0].v,'owner_directory_recovery');
   assert.equal((await inspect(directory)).state,'started');
  });
  await t.test('real account cloud jobs retain their receipt lineage through late-after settlement and explicit Owner review',async real=>{
   const native=server.getPgClient(),worker=server.getPgClient();clients.push(native,worker);await native.connect();await worker.connect();
   await native.query('set role authenticated');
   await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[owner,JSON.stringify({sub:owner,session_id:session})]);
   await setWorkerGatewayCaller(worker);
   const cloudSecret=id()+id(),cloudIssuer=sha(cloudSecret),clientIssuer=sha(id()),oauthClient='conflict-oauth-'+id(),resource='https://conflict-fixture.invalid/mcp';
   await db.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'conflict-fixture')",[clientIssuer,resource]);
   await db.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,execution_enabled) values($1,$2,'https://conflict-fixture.invalid/storage/google/callback',true)",[cloudIssuer,oauthClient]);
   const rpc=async(name,proof,input,caller=worker)=>(await caller.query(`select public.${name}($1,$2::jsonb) v`,[proof,JSON.stringify(input)])).rows[0].v;
   const account=async input=>(await native.query('select public.clued_storage_account_v1($1::jsonb) v',[JSON.stringify(input)])).rows[0].v;
   const suffix=id(),managedRoot='/cloud-'+suffix+'/Clued_资料中心',cloudRoot='cr-'+suffix,cloudParent='cp-'+suffix,track='ct-'+suffix;
   const pr=await register({action:'profile_register',project_id:project,profile_version:'cloud/'+suffix,managed_root:managedRoot,root_folder_id:cloudRoot,root_parent_id:cloudParent,root_folder_version:'1'});
   const profileId=pr.target_refs.find(r=>r.role==='primary').id;
   await register({action:'artifact_register',profile_id:profileId,path:managedRoot+'/20_P_产品与体验',provider_file_id:track,provider_file_version:'1',target_kind:'directory',governance_class:'ordinary',delete_authority:false});
   assert.equal((await db.query('select public.clued_storage_cloud_qualify_v1($1,$2::jsonb) v',[owner,JSON.stringify({profile_id:profileId,base_version:1,allowed_root_children:['20_P_产品与体验'],source_decision_id:decision,idempotency_key:id()})])).rows[0].v.status,'committed');
   const connected=await account({action:'register',profile_id:profileId,source_decision_id:decision,idempotency_key:id()});assert.equal(connected.status,'committed',JSON.stringify(connected));
   const connection=connected.target_refs.find(r=>r.role==='primary').id;
   await db.query("update clued_private.storage_connections_v1 set state='active',provider_subject='conflict-fixture-subject',oauth_client_id=$2,credential_version=1,credential_envelope=$3 where id=$1",[connection,oauthClient,{contract:'clued.storage-credential/1',key_id:'disposable',nonce:'abcdefghijklmnop',ciphertext:'abcdefghijklmnopqrstuvwxyz'}]);
   const clientId='conflict-client-'+id(),token=sha(id());
   const prepared=(await native.query('select public.clued_authorization_prepare_v12($1,$2::jsonb) v',[clientIssuer,JSON.stringify({request_digest:sha(id()),client_id:clientId,client_name:'Disposable conflict fixture',redirect_uri:'https://conflict-fixture.invalid/client-callback',resource,requested_scopes:['context:write']})])).rows[0].v;
   const approved=(await native.query('select public.clued_authorization_approve_v12($1,$2,$3,$4::jsonb,$5,$6) v',[clientIssuer,prepared.request_id,prepared.version,JSON.stringify([{resource_kind:'scope',resource_id:'project:'+project,environment:'canonical',actions:['write','close']}]),token,new Date(Date.now()+10800000).toISOString()])).rows[0].v;
   assert.ok(approved.binding_id,JSON.stringify(approved));
   const lineage=id(),digest=(await db.query('select clued_private.storage_client_request_digest_v2($1) v',[prepared.request_id])).rows[0].v;
   await db.query('insert into clued_private.storage_client_registrations_v2(lineage_id,generation,issuer_hash,resource,client_id,metadata_digest,review_receipt_id) values($1,1,$2,$3,$4,$5,$6)',[lineage,clientIssuer,resource,clientId,digest,connected.receipt_id]);
   await db.query('insert into clued_private.storage_client_request_links_v2(request_id,lineage_id,registration_generation,metadata_digest,review_receipt_id) values($1,$2,1,$3,$4)',[prepared.request_id,lineage,digest,connected.receipt_id]);
   await db.query('insert into clued_private.storage_client_capabilities_v2(lineage_id,registration_generation,receipt_id) values($1,1,$2)',[lineage,connected.receipt_id]);
   const policy=id();await db.query('begin');
   try{
    await db.query(`insert into clued_private.storage_account_policies_v2(id,owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id)
     select $1,c.owner_id,c.id,c.provider,c.provider_subject,p.root_folder_id,p.id,clued_private.storage_policy_scope_digest_v2(c.id),1,c.source_decision_id,c.decision_version,'reviewed_transition','conflict-fixture/1',c.receipt_id
     from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=$2`,[policy,connection]);
    await db.query("update clued_private.storage_account_policies_v2 set state='active',activation_receipt_id=$2 where id=$1",[policy,connected.receipt_id]);
    await db.query("update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=$2,auth_generation=auth_generation+1 where id=$1",[connection,policy]);await db.query('commit');
   }catch(error){await db.query('rollback');throw error;}
   const status=(await native.query('select public.clued_storage_write_access_v1($1::jsonb) v',[JSON.stringify({action:'status',connection_id:connection})])).rows[0].v;
   const enabled=(await native.query('select public.clued_storage_write_access_v1($1::jsonb) v',[JSON.stringify({action:'set_classes',connection_id:connection,classes:[...status.classes,'overwrite'].sort(),base_generation:status.policy_generation,disclosure_version:status.overwrite_disclosure_version,idempotency_key:id()})])).rows[0].v;
   assert.equal(enabled.status,'committed',JSON.stringify(enabled));
   const destructiveStatus=(await native.query('select public.clued_storage_write_access_v1($1::jsonb) v',[JSON.stringify({action:'status',connection_id:connection})])).rows[0].v;
   assert.equal((await native.query('select public.clued_storage_write_access_v1($1::jsonb) v',[JSON.stringify({action:'set_classes',connection_id:connection,classes:[...destructiveStatus.classes,'destructive'].sort(),base_generation:destructiveStatus.policy_generation,disclosure_version:destructiveStatus.destructive_disclosure_version,idempotency_key:id()})])).rows[0].v.status,'committed','the physical-ID alias probe has genuine Owner-approved destructive permission in this disposable fixture');
   const folder=(id,name,parent)=>({id,name,parents:parent?[parent]:[],version:'1',trashed:false,mimeType:'application/vnd.google-apps.folder'});
   const files=new Map([[cloudParent,folder(cloudParent,'cloud-'+suffix,null)],[cloudRoot,folder(cloudRoot,'Clued_资料中心',cloudParent)],[track,folder(track,'20_P_产品与体验',cloudRoot)]]),revisions=new Map();
   let writes=0,posts=0,blockPatch=false;
   const drive=async(url,init={})=>{
    const u=new URL(url),parts=u.pathname.split('/'),revAt=parts.indexOf('revisions');assert.equal(u.hostname,'www.googleapis.com');
    if(init.method==='POST'){
     posts++;const boundary=/boundary=(.+)$/.exec(new Headers(init.headers).get('content-type'))[1];
     const raw=init.body,match=/\{[^\r\n]+"appProperties":\{[^\r\n]+\}\}/.exec(raw),metadata=JSON.parse(match?.[0]??raw),media=raw.split('--'+boundary)[2],content=media.slice(media.indexOf('\r\n\r\n')+4,media.lastIndexOf('\r\n'));
     const bytes=Buffer.from(content),rev='rev-'+id(),created={...metadata,version:'1',trashed:false,headRevisionId:rev,size:String(bytes.length),sha256Checksum:sha(bytes),md5Checksum:crypto.createHash('md5').update(bytes).digest('hex')};files.set(created.id,created);revisions.set(created.id,new Map([[rev,{id:rev,keepForever:false,bytes}]]));return Response.json(created);
    }
    if(init.method==='PATCH'){
     const fileId=revAt>0?parts[revAt-1]:parts.at(-1);
     assert.equal((await db.query("select count(*)::int n from clued_private.resource_center_mutations_v1 where state='started' and provider_attempt->>'provider_file_id'=$1",[fileId])).rows[0].n,1,'attempt is durable before any provider PATCH');
     if(blockPatch)throw new Error('synthetic no reply before provider effect');writes++;
     if(revAt>0){const rev=revisions.get(fileId).get(parts[revAt+1]);rev.keepForever=JSON.parse(init.body).keepForever;return Response.json({id:rev.id,keepForever:rev.keepForever});}
     throw new Error('fixture supports only the before-state replace observation');
    }
    assert.equal(init.method??'GET','GET');
    if(u.pathname.endsWith('/generateIds'))return Response.json({ids:['cloud-file-'+id()]});
    if(revAt>0){const all=revisions.get(parts[revAt-1])??new Map();if(revAt===parts.length-1)return Response.json({revisions:[...all.values()].map(r=>({id:r.id,keepForever:r.keepForever}))});const rev=all.get(parts[revAt+1]);return rev?Response.json({id:rev.id,keepForever:rev.keepForever,size:String(rev.bytes.length)}):new Response('',{status:404});}
    const query=u.searchParams.get('q');if(query){const parent=/'([^']+)' in parents/.exec(query)?.[1],name=/name = '([^']+)'/.exec(query)?.[1];return Response.json({files:[...files.values()].filter(f=>f.parents.includes(parent)&&(!name||f.name===name)),incompleteSearch:false});}
    return files.has(parts.at(-1))?Response.json(files.get(parts.at(-1))):new Response('',{status:404});
   };
   const cloudRpc=input=>rpc('clued_storage_cloud_worker_router_v2',cloudIssuer,input);
   const submit=async(mutation,targetConnection=connection)=>{const reference={connection_id:targetConnection,job_id:id()};const result=await rpc('clued_storage_jobs_router_v2',token,{action:'submit',...reference,mutation});assert.equal(result.status,'queued',JSON.stringify(result));return {reference,mutation};};
   const journal=async job=>(await db.query('select m.* from clued_private.storage_jobs_v1 j join clued_private.resource_center_mutations_v1 m on m.id=j.intent_id where j.owner_id=$1 and j.job_id=$2',[owner,job.reference.job_id])).rows[0];
   let withheld;
   const execute=async(job,hold=false)=>{
    let loaded;return createResourceCenterCloudExecutor({verified_result_mode:true,load_job:async ref=>{loaded=await cloudRpc({action:'load',...ref});const d={...loaded};delete d.credential_envelope;delete d.oauth_client_id;return d;},get_credential:async expected=>({...expected,access_token:'fixture-conflict-access-token',scope:'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly',expires_at_ms:Date.now()+3600000}),drive_fetch:drive,rpc:async input=>{
     const {connection_id,job_id,action,...body}=input,request={connection_id,job_id,action,...(action==='settle_verified'?{}:{credential_version:loaded.credential_version}),...body};
     if(hold&&action==='verified_record'){withheld=structuredClone(request);throw new Error('synthetic lost verification request');}return cloudRpc(request);
    }}).run(job.reference);
   };
   const late=await submit({operation:'create',target_kind:'file',destination_path:managedRoot+'/20_P_产品与体验/late.txt',content:'late after metadata proof'});
   assert.equal((await execute(late,true)).status,'unreconciled');assert.ok(withheld,'real verifier reached the withheld receipt boundary');
   let row=await journal(late);assert.equal(row.state,'started');assert.ok(row.provider_attempt_receipt_id);assert.equal(row.verified_result_v2,null);assert.equal(posts,1);
   await real.test('a historical null-snapshot cloud row closes without rewriting an immutable current job',async()=>{
    await db.query('begin');try{
     const legacyRoot='/legacy-'+id()+'/Clued_资料中心',legacyRootId='legacy-root-'+id(),legacyParent='legacy-parent-'+id();
     const legacyRegistered=await register({action:'profile_register',project_id:project,profile_version:'legacy/'+id(),managed_root:legacyRoot,root_folder_id:legacyRootId,root_parent_id:'my-drive',root_folder_version:'1'});
     const legacyProfile=legacyRegistered.target_refs.find(ref=>ref.role==='primary').id;
     await register({action:'artifact_register',profile_id:legacyProfile,path:legacyRoot+'/docs',provider_file_id:legacyParent,provider_file_version:'1',target_kind:'directory',governance_class:'ordinary',delete_authority:false});
     const legacyIntent=await seed({providerAttempt:false,destination:legacyRoot+'/docs/legacy-unknown.zip',fixtureProfile:legacyProfile,fixtureRoot:legacyRootId,fixtureParent:legacyParent}),legacyJob=id(),legacyReceipt=await receipt(),legacyConnection=id();
     // Historical insertion-time data, without modifying current authority or
     // disabling its immutability trigger. A disconnected/unauthenticated
     // legacy connection cannot prevent ending its expired old journal.
     await db.query(`insert into clued_private.storage_connections_v1(id,owner_id,profile_id,profile_version,
      source_decision_id,decision_version,provider,receipt_id) values($1,$2,$3,1,$4,1,'google-drive',$5)`,[legacyConnection,owner,legacyProfile,decision,legacyReceipt]);
     await db.query(`insert into clued_private.storage_jobs_v1
      select (jsonb_populate_record(null::clued_private.storage_jobs_v1,to_jsonb(j)||jsonb_build_object(
       'job_id',$2::uuid,'intent_id',$3::uuid,'connection_id',$5::uuid,'authority_snapshot_v2',null,'cloud_writer_binding_id',null,
       'request_digest',$6::text,'mutation',(select m.exact_request->'mutation' from clued_private.resource_center_mutations_v1 m where m.id=$3::uuid))))
       .* from clued_private.storage_jobs_v1 j where j.owner_id=$1 and j.job_id=$4`,[owner,legacyJob,legacyIntent,late.reference.job_id,legacyConnection,sha(id())]);
     assert.equal((await db.query('select clued_private.storage_conflict_supported_v1($1) v',[legacyIntent])).rows[0].v,true);
     assert.equal((await db.query('select clued_private.storage_conflict_close_v1($1) v',[legacyIntent])).rows[0].v,'conflict');
     const closed=await journal({reference:{job_id:legacyJob}});assert.equal(closed.state,'conflict');assert.equal(closed.final_result.reason_code,'PROVIDER_STATE_CONFLICT');
     assert.equal(closed.verified_result_v2,null);assert.equal(posts,1);
     const q=(await db.query('select state,job_id,connection_id,scope_complete from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[legacyIntent])).rows[0];
     assert.deepEqual(q,{state:'active',job_id:legacyJob,connection_id:legacyConnection,scope_complete:true});
     assert.equal((await journal(late)).state,'started');
    }finally{await db.query('rollback');}
   });
   const prequeuedOverlap=await submit({...late.mutation,content:'queued before isolation publication'});
   const stagingPredicate=async(name,deleted)=>(await db.query(`select clued_private.${name}(jsonb_populate_record(null::clued_private.storage_staging_v1,$1::jsonb)) v`,[JSON.stringify({owner_id:owner,job_id:late.reference.job_id,state:'consumed',bytes_received:true,object_deleted_at:deleted?new Date(Date.now()-86400000).toISOString():null,created_at:new Date(Date.now()-8*86400000).toISOString()})])).rows[0].v;
   assert.equal(await stagingPredicate('storage_staging_deletable_v1',false),false,'running uploads retain staging');
   assert.equal(await stagingPredicate('storage_staging_purgeable_v1',true),false,'running upload history cannot be purged');
   assert.equal((await db.query('select clued_private.storage_conflict_close_v1($1) v',[row.id])).rows[0].v,'not_due','future unknown keeps its running fence until the approved I9 bound');
   // Sweep classification is database-owned even when original credentials
   // cannot be used. Restore only this disposable fixture connection afterward
   // to exercise the separately authenticated GET-only settlement path.
   await db.query("update clued_private.storage_connections_v1 set state='reauthorization_required',credential_envelope=null where id=$1",[connection]);
   await db.query("update clued_private.resource_center_mutations_v1 set expires_at=clock_timestamp()-interval '3 hours' where id=$1",[row.id]);
   const sweepBlocker=server.getPgClient();clients.push(sweepBlocker);await sweepBlocker.connect();
   for(const key of ['storage-client:'+owner+':'+lineage,'storage-job:'+owner+':'+late.reference.job_id,owner+':'+cloudRoot]){
    await sweepBlocker.query('begin');
    try{
     await sweepBlocker.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
     await db.query("set statement_timeout='1500ms'");
     assert.equal((await db.query('select clued_private.storage_conflict_close_candidate_v1($1) v',[row.id])).rows[0].v,'not_due','a sweep never waits on a new client/job/root lock while retaining previous candidates');
     assert.equal((await journal(late)).state,'started');
    }finally{await sweepBlocker.query('rollback');await db.query('reset statement_timeout');}
   }
   const beforeBusyReceipts=(await db.query('select count(*)::int n from public.clued_audit_receipts where user_id=$1',[owner])).rows[0].n;
   await sweepBlocker.query('begin');try{
    await sweepBlocker.query("select pg_advisory_xact_lock(hashtextextended('storage-object:'||$1,0))",[row.provider_attempt.provider_file_id]);
    await db.query("set statement_timeout='1500ms'");
    await assert.rejects(db.query('select clued_private.storage_conflict_close_candidate_v1($1) v',[row.id]),/storage_conflict_candidate_busy/);
    assert.equal((await journal(late)).state,'started');
    assert.equal((await db.query('select count(*)::int n from public.clued_audit_receipts where user_id=$1',[owner])).rows[0].n,beforeBusyReceipts,'busy object rolls back the candidate Receipt rather than leaving it pending');
   }finally{await sweepBlocker.query('rollback');await db.query('reset statement_timeout');}
   const swept=(await db.query('select clued_private.storage_conflict_sweep_v1() v')).rows[0].v;assert.ok(swept);row=await journal(late);assert.equal(row.state,'conflict');
   await db.query("update clued_private.storage_connections_v1 set state='active',credential_envelope=$2 where id=$1",[connection,{contract:'clued.storage-credential/1',key_id:'disposable',nonce:'abcdefghijklmnop',ciphertext:'abcdefghijklmnopqrstuvwxyz'}]);
   const quarantine=(await db.query('select * from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[row.id])).rows[0];assert.equal(quarantine.scope_complete,true);
   const historicalReplay=await rpc('clued_storage_jobs_router_v2',token,{action:'submit',...late.reference,mutation:late.mutation});assert.equal(historicalReplay.status,'attention_required');assert.equal(historicalReplay.job_id,late.reference.job_id,'same-job replay remains historical inspection');
   const jobCountBeforeOverlap=(await db.query('select count(*)::int n from clued_private.storage_jobs_v1')).rows[0].n,writerCountBeforeOverlap=(await db.query('select count(*)::int n from clued_private.resource_center_writer_bindings_v1')).rows[0].n;
   const probe=async operation=>{try{const value=await operation();return {allowed:true,status:value.status,value};}catch(error){return {allowed:false,error:error.message,code:error.code};}};
   const wrongToken=await probe(()=>rpc('clued_storage_jobs_router_v2',sha(id()),{action:'submit',connection_id:connection,job_id:id(),mutation:late.mutation}));assert.equal(wrongToken.allowed,false);assert.notEqual(wrongToken.error,'storage_object_under_review','invalid credentials fail before private quarantine information');
   const otherProject=(await db.query("select project_id from public.clued_memories where user_id=$1 and record_type='decision' limit 1",[other])).rows[0].project_id,otherToken=sha(id());
   await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[other,JSON.stringify({sub:other,session_id:otherSession})]);
   try{
    const otherPrepared=(await native.query('select public.clued_authorization_prepare_v12($1,$2::jsonb) v',[clientIssuer,JSON.stringify({request_digest:sha(id()),client_id:'other-conflict-'+id(),client_name:'Other Owner boundary fixture',redirect_uri:'https://conflict-fixture.invalid/client-callback',resource,requested_scopes:['context:write']})])).rows[0].v;
    assert.ok((await native.query('select public.clued_authorization_approve_v12($1,$2,$3,$4::jsonb,$5,$6) v',[clientIssuer,otherPrepared.request_id,otherPrepared.version,JSON.stringify([{resource_kind:'scope',resource_id:'project:'+otherProject,environment:'canonical',actions:['write','close']}]),otherToken,new Date(Date.now()+3600000).toISOString()])).rows[0].v.binding_id);
   }finally{await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[owner,JSON.stringify({sub:owner,session_id:session})]);}
   const wrongOwner=await probe(()=>rpc('clued_storage_jobs_router_v2',otherToken,{action:'submit',connection_id:connection,job_id:id(),mutation:late.mutation}));assert.equal(wrongOwner.allowed,false);assert.notEqual(wrongOwner.error,'storage_object_under_review','another authenticated Owner receives no private isolation state');
   const overlapOutcomes={queuedLoad:await probe(()=>cloudRpc({action:'load',...prequeuedOverlap.reference})),exactSlotSubmit:await probe(()=>rpc('clued_storage_jobs_router_v2',token,{action:'submit',connection_id:connection,job_id:id(),mutation:{...late.mutation,content:'new conflicting request'}})),exactFileSubmit:await probe(()=>rpc('clued_storage_jobs_router_v2',token,{action:'submit',connection_id:connection,job_id:id(),mutation:{operation:'replace',target_kind:'file',destination_path:late.mutation.destination_path,destination_file_version:'1',content:'conflicting replace'}})),physicalAliasSubmit:await probe(()=>rpc('clued_storage_jobs_router_v2',token,{action:'submit',connection_id:connection,job_id:id(),mutation:{operation:'delete',target_kind:'file',source_path:managedRoot+'/20_P_产品与体验/physical-alias.txt',source_file_id:row.provider_attempt.provider_file_id,source_file_version:'1'}}))};
   assert.deepEqual(Object.fromEntries(Object.entries(overlapOutcomes).map(([key,value])=>[key,value.status??value.error])),{queuedLoad:'denied',exactSlotSubmit:'rejected',exactFileSubmit:'rejected',physicalAliasSubmit:'rejected'});
   for(const [key,result] of Object.entries(overlapOutcomes)){
    assert.equal(result.value.execution_permitted,false);if(key==='queuedLoad')assert.equal(result.value.reason_code,'STORAGE_OBJECT_UNDER_REVIEW');else assert.equal(result.value.error_code,'storage_object_under_review');
   }
   assert.equal((await db.query('select count(*)::int n from clued_private.storage_jobs_v1')).rows[0].n,jobCountBeforeOverlap,'blocked submit creates no queued job');
   assert.equal((await db.query('select count(*)::int n from clued_private.resource_center_writer_bindings_v1')).rows[0].n,writerCountBeforeOverlap,'blocked queued load creates no writer');
   const deniedQueued=overlapOutcomes.queuedLoad.value;for(const field of ['credential_envelope','credential_version','provider_subject','oauth_client_id','profile','mutation'])assert.equal(Object.hasOwn(deniedQueued,field),false,'blocked load returns no execution/credential descriptor');
   const dispatch=(await db.query('select intent_id,cloud_writer_binding_id,dispatch_outcome,dispatch_outcome_receipt_id from clued_private.storage_jobs_v1 where owner_id=$1 and job_id=$2',[owner,prequeuedOverlap.reference.job_id])).rows[0];
   assert.equal(dispatch.intent_id,null);assert.equal(dispatch.cloud_writer_binding_id,null);assert.deepEqual(dispatch.dispatch_outcome,{status:'denied',reason:{code:'STORAGE_OBJECT_UNDER_REVIEW'}});assert.equal(dispatch.dispatch_outcome_receipt_id,deniedQueued.receipt_id);
   const dispatchReceipt=(await db.query('select operation,status,event_ids from public.clued_audit_receipts where id=$1',[deniedQueued.receipt_id])).rows[0];assert.equal(dispatchReceipt.operation,'storage_dispatch_outcome');assert.equal(dispatchReceipt.status,'committed');assert.ok(dispatchReceipt.event_ids.length);
   assert.equal((await rpc('clued_storage_jobs_router_v2',token,{action:'inspect',...prequeuedOverlap.reference})).reason_code,'STORAGE_OBJECT_UNDER_REVIEW','normal inspection sees the real terminal dispatch receipt');
   assert.equal(await stagingPredicate('storage_staging_deletable_v1',false),true,'conflict closure ends staging retention');
   assert.equal(await stagingPredicate('storage_staging_purgeable_v1',true),true,'settled conflict staging follows the existing seven-day purge bound');
   await db.query("update public.clued_audit_receipts set created_at=clock_timestamp()-interval '30 seconds' where id=$1",[row.provider_attempt_receipt_id]);
   const refreshPrivate=async(claim=true,attemptJob=null,attemptIntent=null,attemptDigest=null)=>(await db.query('select * from clued_private.storage_account_recovery_refresh_v1($1,$2,$3,$4,$5,$6,$7,$8)',[connection,owner,profileId,late.reference.job_id,claim,attemptJob,attemptIntent,attemptDigest])).rows[0];
   const refreshIdentity=await refreshPrivate();assert.equal(refreshIdentity.intent_id,row.id);assert.match(refreshIdentity.attempt_digest,/^[0-9a-f]{64}$/);
   assert.deepEqual(await refreshPrivate(false,late.reference.job_id,row.id,refreshIdentity.attempt_digest),refreshIdentity,'claim/commit bind the same original job, intent and attempt digest');
   await assert.rejects(refreshPrivate(false,late.reference.job_id,row.id,'0'.repeat(64)),/storage_refresh_denied/);
   const transactionDenial=async mutation=>{await db.query('begin');try{await mutation();await assert.rejects(refreshPrivate(),/storage_refresh_denied/);}finally{await db.query('rollback');}};
   const originalPolicy=(await db.query("select authority_snapshot_v2->>'policy_id' id from clued_private.storage_jobs_v1 where owner_id=$1 and job_id=$2",[owner,late.reference.job_id])).rows[0].id;
   await transactionDenial(()=>db.query("update clued_private.storage_account_policies_v2 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=$2 where id=$1",[originalPolicy,row.receipt_id]));
   await transactionDenial(()=>db.query("insert into clued_private.storage_root_denies_v2(owner_id,provider,provider_subject,root_folder_id,receipt_id) values($1,'google-drive','conflict-fixture-subject',$2,$3)",[owner,cloudRoot,row.receipt_id]));
   await transactionDenial(()=>db.query('insert into clued_private.storage_client_denies_v2(owner_id,lineage_id,receipt_id) values($1,$2,$3)',[owner,lineage,row.receipt_id]));
   await transactionDenial(()=>db.query("insert into clued_private.storage_root_denies_v2(owner_id,provider,provider_subject,root_folder_id,lineage_id,receipt_id) values($1,'google-drive','conflict-fixture-subject',$2,$3,$4)",[owner,cloudRoot,lineage,row.receipt_id]));
   const refreshClaim=()=>rpc('clued_storage_refresh_worker_v1',cloudIssuer,{action:'claim',connection_id:connection,attempt_id:id(),recovery_job_id:late.reference.job_id});
   assert.equal((await db.query('select count(*)::int n from clued_private.storage_refresh_delegations_v1 where connection_id=$1',[connection])).rows[0].n,0);
   await assert.rejects(refreshClaim(),/storage_refresh_denied/,'an eligible original job does not create standing refresh permission');
   const refreshOwner=async input=>(await native.query('select public.clued_storage_refresh_manage_v1($1::jsonb) v',[JSON.stringify(input)])).rows[0].v;
   const refreshStatus=await refreshOwner({action:'status',connection_id:connection});
   assert.equal((await refreshOwner({action:'disable',connection_id:connection,base_version:refreshStatus.connection_version,delegation_version:refreshStatus.version,idempotency_key:id()})).status,'committed');
   await assert.rejects(refreshClaim(),/storage_refresh_denied/,'Owner stop remains effective for job-bound recovery refresh');
   assert.equal((await db.query('select count(*)::int n from clued_private.storage_refresh_attempts_v1 where connection_id=$1',[connection])).rows[0].n,0,'denied refresh never creates an exchange attempt');
   const nativeDescriptor=await rpc('clued_storage_native_recovery_load_v2',cloudSecret,{action:'recovery_load',...late.reference},native);
   assert.equal(nativeDescriptor.status,'recovery_only');assert.equal(nativeDescriptor.owner_id,owner);assert.equal(nativeDescriptor.version,3);
   await assert.rejects(rpc('clued_storage_native_recovery_load_v2',id(),{action:'recovery_load',...late.reference},native),/storage_recovery_denied/);
   const wrongSecret=id()+id();await db.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,execution_enabled) values($1,$2,'https://conflict-fixture.invalid/storage/google/callback',true)",[sha(wrongSecret),'different-client-'+id()]);
   await assert.rejects(rpc('clued_storage_native_recovery_load_v2',wrongSecret,{action:'recovery_load',...late.reference},native),/storage_recovery_denied/);
   const unrelated=await submit({operation:'create',target_kind:'file',destination_path:managedRoot+'/20_P_产品与体验/unrelated.txt',content:'allowed during original quarantine'});
   assert.equal((await execute(unrelated)).status,'committed','the first I9 sweep releases the old root single-writer so unrelated real work can start');
   assert.equal((await db.query('select state from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[row.id])).rows[0].state,'active','unrelated work does not clear the old object quarantine');
   const descriptor=(await rpc('clued_storage_scheduled_recovery_v2',cloudIssuer,{action:'load',...late.reference}));assert.equal(descriptor.status,'recovery_only');assert.equal(descriptor.version,3);
   const countBeforeRecovery={posts,writes},metadata=createGoogleDriveMetadataApi({get_credential:async()=>({access_token:'fixture-conflict-access-token',scope:'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly'}),fetch:drive});
   const verify=createGoogleDriveCreatePostconditionVerifier({managed_root:managedRoot,root_folder_id:cloudRoot,root_parent_id:cloudParent,get_file:metadata.getFile,list_children:metadata.listChildren,require_effect_provider_id:true,include_verified_proof:true});
   const observation=await verify({profile:{managed_root:managedRoot},mutation:late.mutation,provider_before:descriptor.provider_before,effect_result:{operation:'create',destination_path:late.mutation.destination_path,provider_file_id:descriptor.attempt.provider_file_id}});
   const {verified_proof:proof,...postcondition}=observation;
   const recorded=await cloudRpc({...withheld,finish:{...withheld.finish,base_version:3,postcondition},proof});assert.equal(recorded.status,'verified',JSON.stringify(recorded));
   const settled=await cloudRpc({action:'settle_verified',...late.reference,intent_id:row.id,base_version:recorded.version,request_sha256:row.request_sha256,verified_receipt_id:recorded.verified_receipt_id,verified_digest:recorded.verified_digest});
   assert.equal(settled.status,'committed',JSON.stringify(settled));assert.equal(settled.state,'committed');assert.deepEqual({posts,writes},countBeforeRecovery,'late-after recovery performs GETs only');
   const resolved=(await db.query('select state,resolution_receipt_id from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[row.id])).rows[0];assert.equal(resolved.state,'resolved');assert.equal(resolved.resolution_receipt_id,settled.receipt_id);
   const finalReceipt=(await db.query('select operation,status from public.clued_audit_receipts where id=$1',[settled.receipt_id])).rows[0];assert.equal(finalReceipt.operation,'storage_verified_settle');assert.equal(finalReceipt.status,'committed');
   const ordinaryStatus=await rpc('clued_storage_jobs_router_v2',token,{action:'inspect',...late.reference});assert.equal(ordinaryStatus.status,'committed');assert.notEqual(ordinaryStatus.reason_code,'PROVIDER_RESULT_RECONCILED');
   // A second real job can start on the same root after the first sweep. Its
   // provider attempt is durable, but no mutation is replayed to obtain review.
   const prior=files.get(descriptor.attempt.provider_file_id),replacement=await submit({operation:'replace',target_kind:'file',destination_path:late.mutation.destination_path,destination_file_version:prior.version,content:'replacement not sent'});
   blockPatch=true;assert.equal((await execute(replacement)).status,'unreconciled');blockPatch=false;
   row=await journal(replacement);assert.equal(row.state,'started');assert.ok(row.provider_attempt_receipt_id);
   await db.query("update clued_private.resource_center_mutations_v1 set expires_at=clock_timestamp()-interval '3 hours' where id=$1",[row.id]);assert.equal((await db.query('select clued_private.storage_conflict_close_v1($1) v',[row.id])).rows[0].v,'conflict');row=await journal(replacement);
   const loadWorker=async name=>{const built=await build({entryPoints:[path.join(cloud,'worker',name+'.ts')],bundle:true,platform:'node',format:'esm',write:false});return import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));};
   const {createStorageCredentialVault}=await loadWorker('storage-credential-vault'),{createStorageRecoveryReview}=await loadWorker('storage-recovery-review');stop();
   const vaultConfig={current_key_id:'disposable',keys:{disposable:crypto.randomBytes(32).toString('base64url')}},vault=await createStorageCredentialVault(vaultConfig);
   const sealed=await vault.seal(JSON.stringify({token_type:'Bearer',access_token:'fixture-conflict-access-token',scope:'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly',expires_at_ms:Date.now()+3600000}),{owner_id:owner,connection_id:connection,provider:'google-drive',provider_subject:'conflict-fixture-subject',oauth_client_id:oauthClient,credential_version:1});
   await db.query('update clued_private.storage_connections_v1 set credential_envelope=$2 where id=$1',[connection,sealed]);
   const reviewDescriptor=await rpc('clued_storage_native_recovery_load_v2',cloudSecret,{action:'recovery_load',...replacement.reference},native);let reviewInput,reviewRpcResponse;
   const reviewBridge=await createStorageRecoveryReview({client_id:oauthClient,vault:vaultConfig,descriptor:reviewDescriptor,source_receipt_id:row.receipt_id,fetch:drive,rpc:async input=>{
    const response=await rpc('clued_storage_scheduled_recovery_v2',cloudIssuer,input);if(input.action==='review_observe'){reviewInput=structuredClone(input);reviewRpcResponse=structuredClone(response);}return response;
   }});
   const review=await reviewBridge.prepare(replacement.reference);assert.equal(review.status,'review_prepared',JSON.stringify(review));
   assert.match(review.observation_id,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
   const exactReview={status:'review_prepared',connection_id:connection,job_id:replacement.reference.job_id,observation_id:review.observation_id,base_version:3,source_receipt_id:row.receipt_id,observed_at:reviewRpcResponse.observed_at,observed_state:'before',execution_permitted:false,file_name:prior.name,provider_file_id:prior.id,provider_file_version:prior.version,mime_type:prior.mimeType,size:prior.size,sha256:prior.sha256Checksum};
   assert.deepEqual(reviewRpcResponse,exactReview,'actual PostgreSQL response satisfies every Worker-required identity and display field');assert.deepEqual(review,exactReview,'the real Worker accepts the actual Native descriptor and PostgreSQL observation response');
   assert.equal(new Date(review.observed_at).getTime(),new Date(reviewInput.observation.observed_at).getTime(),'provider observation clock is preserved');
   const acceptance={action:'review_accept',...replacement.reference,observation_id:review.observation_id,base_version:review.base_version,source_receipt_id:review.source_receipt_id,confirmed:true};
   await assert.rejects(rpc('clued_storage_native_recovery_v1',cloudIssuer,acceptance,native),/storage_conflict_review_conflict/,'an observation TTL alone is insufficient without a fresh server GET comparison');
   await assert.rejects(db.query('select clued_private.storage_conflict_accept_v1($1,$2::jsonb)',[other,JSON.stringify(acceptance)]),/storage_conflict_review_conflict/);
   await assert.rejects(rpc('clued_storage_native_recovery_v1',cloudIssuer,{...acceptance,base_version:review.base_version+1},native),/storage_conflict_review_conflict/);
   const deniedRoot=(await db.query("insert into clued_private.storage_root_denies_v2(owner_id,provider,provider_subject,root_folder_id,lineage_id,receipt_id) values($1,'google-drive','conflict-fixture-subject',$2,$3,$4) returning id",[owner,cloudRoot,lineage,row.receipt_id])).rows[0].id;
   await assert.rejects(rpc('clued_storage_scheduled_recovery_v2',cloudIssuer,{action:'load',...replacement.reference}),/storage_recovery_denied/);
   await assert.rejects(rpc('clued_storage_native_recovery_v1',cloudIssuer,acceptance,native),/storage_conflict_review_conflict/);
   await db.query('update clued_private.storage_root_denies_v2 set denied=false,generation=generation+1,receipt_id=$2 where id=$1',[deniedRoot,connected.receipt_id]);
   await assert.rejects(db.query("update clued_private.storage_conflict_observations_v1 set observation=observation||'{\"observed_state\":\"after\"}' where id=$1",[review.observation_id]),/storage_observation_immutable/);
   const expired=id();await db.query(`insert into clued_private.storage_conflict_observations_v1(id,intent_id,user_id,connection_id,job_id,base_version,source_receipt_id,observation,artifact_id,artifact_version,profile_version,parent_artifact_id,parent_artifact_version,observed_at,expires_at)
    select $1,intent_id,user_id,connection_id,job_id,base_version,source_receipt_id,observation,artifact_id,artifact_version,profile_version,parent_artifact_id,parent_artifact_version,clock_timestamp()-interval '6 minutes',clock_timestamp()-interval '1 minute'
    from clued_private.storage_conflict_observations_v1 where id=$2`,[expired,review.observation_id]);
   await assert.rejects(rpc('clued_storage_native_recovery_v1',cloudIssuer,{...acceptance,observation_id:expired},native),/storage_conflict_review_conflict/);
   const revalidation={action:'review_revalidate',...replacement.reference,observation_id:review.observation_id,base_version:review.base_version,source_receipt_id:review.source_receipt_id,observation:{...reviewInput.observation,observed_at:new Date().toISOString()}};
   await assert.rejects(rpc('clued_storage_scheduled_recovery_v2',cloudIssuer,{...revalidation,observation:{...revalidation.observation,provider_file_version:'999'}}),/storage_conflict_observation_changed/);
   assert.equal((await metadata.getFile(prior.id)).version,prior.version,'final review rechecks the original provider object');
   assert.equal((await reviewBridge.prepare(replacement.reference,{observation_id:review.observation_id,base_version:review.base_version,source_receipt_id:review.source_receipt_id})).status,'review_revalidated','the real Worker revalidates through the actual PostgreSQL RPC');
   await db.query(`create function public.test_conflict_receipt_failure() returns trigger language plpgsql as $$begin
    if new.operation='storage_conflict_accept' and new.status='committed' then raise exception 'synthetic_receipt_failure';end if;return new;end$$;
    create trigger test_conflict_receipt_failure before update on public.clued_audit_receipts for each row execute function public.test_conflict_receipt_failure()`);
   await assert.rejects(rpc('clued_storage_native_recovery_v1',cloudIssuer,acceptance,native),/synthetic_receipt_failure/);
   assert.equal((await db.query('select state from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[row.id])).rows[0].state,'active','failed final receipt rolls back quarantine clearance');
   assert.equal((await db.query('select resolution_receipt_id from clued_private.storage_conflict_observations_v1 where id=$1',[review.observation_id])).rows[0].resolution_receipt_id,null);
   await db.query('drop trigger test_conflict_receipt_failure on public.clued_audit_receipts;drop function public.test_conflict_receipt_failure()');
   const accepted=await rpc('clued_storage_native_recovery_v1',cloudIssuer,acceptance,native);assert.equal(accepted.status,'resolved',JSON.stringify(accepted));assert.equal(accepted.resolution,'accepted_current_state');
   for(const key of ['observation_id','base_version','source_receipt_id'])assert.equal(accepted[key],acceptance[key]);
   assert.deepEqual(await rpc('clued_storage_native_recovery_v1',cloudIssuer,acceptance,native),accepted,'lost final reply replays the exact consumed CAS references');
   const inspected=await rpc('clued_storage_native_recovery_v1',cloudIssuer,{action:'recovery_inspect',...replacement.reference},native);for(const key of ['observation_id','base_version','source_receipt_id','receipt_id'])assert.equal(inspected[key],accepted[key]);
   const acceptedStatus=await rpc('clued_storage_jobs_router_v2',token,{action:'inspect',...replacement.reference});
   assert.equal(acceptedStatus.status,'attention_required');assert.equal(acceptedStatus.reason_code,'PROVIDER_RESULT_RECONCILED');assert.equal(acceptedStatus.resolution,'accepted_current_state');assert.equal(acceptedStatus.resolution_receipt_id,accepted.receipt_id);assert.equal(acceptedStatus.source_receipt_id,accepted.source_receipt_id);
   assert.equal((await journal(replacement)).state,'conflict','accepting current metadata does not fabricate replace success');assert.equal(posts,2);assert.equal(writes,0);
   const absent=await submit({operation:'create',target_kind:'file',destination_path:managedRoot+'/20_P_产品与体验/disappeared.txt',content:'external removal after attempt'});
   assert.equal((await execute(absent,true)).status,'unreconciled');row=await journal(absent);assert.ok(row.provider_attempt_receipt_id);
   const absentFile=row.provider_attempt.provider_file_id;files.delete(absentFile);
   assert.equal((await drive('https://www.googleapis.com/drive/v3/files/'+absentFile)).status,404,'review reads the exact original provider object');
   await db.query("update clued_private.resource_center_mutations_v1 set expires_at=clock_timestamp()-interval '3 hours' where id=$1",[row.id]);
   assert.equal((await db.query('select clued_private.storage_conflict_close_v1($1) v',[row.id])).rows[0].v,'conflict');row=await journal(absent);
   const absentObservation={observed_at:new Date().toISOString(),provider_file_id:absentFile,provider_file_version:null,parent_id:null,name:null,trashed:null,mime_type:null,size:null,sha256:null,head_revision_id:null,observed_state:'absent'};
   const absentDescriptor=await rpc('clued_storage_scheduled_recovery_v2',cloudIssuer,{action:'load',...absent.reference});
   const absentReadContext=absentDescriptor.recovery_reader?{recovery_reader:absentDescriptor.recovery_reader}:{};
   const absentReviewInput={action:'review_observe',...absent.reference,base_version:Number(row.version),source_receipt_id:row.receipt_id,observation:absentObservation};
   if(absentDescriptor.recovery_reader)await assert.rejects(rpc('clued_storage_scheduled_recovery_v2',cloudIssuer,absentReviewInput),/storage_recovery_reader_changed/,
    'a private current reader returned by load cannot be omitted by a manual test caller');
   const absentReview=await rpc('clued_storage_scheduled_recovery_v2',cloudIssuer,{...absentReviewInput,...absentReadContext});
   assert.equal(absentReview.status,'review_prepared',JSON.stringify(absentReview));
   assert.match(absentReview.observation_id,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
   assert.deepEqual(absentReview,{status:'review_prepared',connection_id:connection,job_id:absent.reference.job_id,observation_id:absentReview.observation_id,base_version:3,source_receipt_id:row.receipt_id,observed_at:absentReview.observed_at,observed_state:'absent',execution_permitted:false,file_name:'disappeared.txt',provider_file_id:absentFile,provider_file_version:null,mime_type:null,size:null,sha256:null});
   assert.equal(Date.parse(absentReview.observed_at),Date.parse(absentObservation.observed_at));
   assert.equal((await drive('https://www.googleapis.com/drive/v3/files/'+absentFile)).status,404);
   assert.equal((await rpc('clued_storage_scheduled_recovery_v2',cloudIssuer,{action:'review_revalidate',...absent.reference,observation_id:absentReview.observation_id,base_version:absentReview.base_version,source_receipt_id:absentReview.source_receipt_id,...absentReadContext,observation:{...absentObservation,observed_at:new Date().toISOString()}})).status,'review_revalidated');
   const absentAccepted=await rpc('clued_storage_native_recovery_v1',cloudIssuer,{action:'review_accept',...absent.reference,observation_id:absentReview.observation_id,base_version:absentReview.base_version,source_receipt_id:absentReview.source_receipt_id,confirmed:true},native);
   assert.equal(absentAccepted.resolution,'accepted_current_state');assert.equal((await journal(absent)).state,'conflict');
   assert.equal((await db.query('select count(*)::int n from clued_private.resource_center_artifacts_v1 where profile_id=$1 and provider_file_id=$2',[profileId,absentFile])).rows[0].n,0,'accepting absence never invents an artifact or reports the old create committed');
   assert.equal(posts,3);assert.equal(writes,0);
   const makeConflictCreate=async name=>{
    const job=await submit({operation:'create',target_kind:'file',destination_path:managedRoot+'/20_P_产品与体验/'+name,content:'history fixture'});
    assert.equal((await execute(job,true)).status,'unreconciled');let current=await journal(job);
    await db.query("update clued_private.resource_center_mutations_v1 set expires_at=clock_timestamp()-interval '3 hours' where id=$1",[current.id]);
    assert.equal((await db.query('select clued_private.storage_conflict_close_v1($1) v',[current.id])).rows[0].v,'conflict');current=await journal(job);return {...job,row:current};
   };
   const waiting=await makeConflictCreate('old-active-review.txt');
   // These are genuine resolved histories through the same public Owner exit,
   // rather than synthetic copies with fabricated receipt lineage.
   for(let index=0;index<21;index++){
    const history=await makeConflictCreate('resolved-history-'+index+'.txt');
    const abandoned=await rpc('clued_storage_native_recovery_v1',cloudIssuer,{action:'review_abandon',...history.reference,base_version:Number(history.row.version),source_receipt_id:history.row.receipt_id,confirmed:true},native);
    assert.equal(abandoned.resolution,'abandoned_registration');assert.equal(abandoned.base_version,3);assert.equal(abandoned.source_receipt_id,history.row.receipt_id);
   }
   const listed=await rpc('clued_storage_native_recovery_v1',cloudIssuer,{action:'recovery_list',connection_id:connection},native);
   assert.equal(listed.status,'ok');assert.equal(listed.jobs.length,20);assert.equal(listed.jobs[0].job_id,waiting.reference.job_id,'twenty-one newer resolved histories cannot starve the older active conflict');
   const abandonInput={action:'review_abandon',...waiting.reference,base_version:Number(waiting.row.version),source_receipt_id:waiting.row.receipt_id,confirmed:true};
   const abandoned=await rpc('clued_storage_native_recovery_v1',cloudIssuer,abandonInput,native);assert.equal(abandoned.resolution,'abandoned_registration');
   const abandonedStatus=await rpc('clued_storage_jobs_router_v2',token,{action:'inspect',...waiting.reference});
   assert.equal(abandonedStatus.status,'attention_required');assert.equal(abandonedStatus.reason_code,'PROVIDER_RESULT_RECONCILED');assert.equal(abandonedStatus.resolution,'abandoned_registration');assert.equal(abandonedStatus.resolution_receipt_id,abandoned.receipt_id);assert.equal(abandonedStatus.source_receipt_id,abandoned.source_receipt_id);
   const replayed=await rpc('clued_storage_native_recovery_v1',cloudIssuer,abandonInput,native);
   for(const key of ['base_version','source_receipt_id','observation_id','receipt_id'])assert.equal(replayed[key],abandoned[key]);
   assert.equal((await journal(waiting)).state,'conflict');assert.equal(writes,0,'review and abandon do not mutate the provider');
   const persisted=await submit({operation:'create',target_kind:'file',destination_path:managedRoot+'/20_P_产品与体验/persisted-before-i9.txt',content:'immutable pre-I9 verification'});
   assert.equal((await execute(persisted,true)).status,'unreconciled');const originalRecord=structuredClone(withheld),savedRecord=await cloudRpc(originalRecord);assert.equal(savedRecord.status,'verified');assert.equal(savedRecord.version,2);
   const beforeIsolation=await journal(persisted),immutableProof=structuredClone(beforeIsolation.verified_result_v2),immutableDigest=beforeIsolation.verified_digest_v2;
   assert.equal(immutableProof.intent_version,2);assert.equal(immutableProof.finish.base_version,2);
   await db.query(`create sequence public.test_conflict_settle_failure_calls;
    create function public.test_conflict_settle_failure() returns trigger language plpgsql as $$begin
     if new.operation='storage_verified_settle' and new.status='committed' then perform nextval('public.test_conflict_settle_failure_calls');raise exception 'synthetic_verified_receipt_failure';end if;return new;end$$;
    create trigger test_conflict_settle_failure before update on public.clued_audit_receipts for each row execute function public.test_conflict_settle_failure()`);
   await db.query("update clued_private.resource_center_mutations_v1 set expires_at=clock_timestamp()-interval '3 hours' where id=$1",[beforeIsolation.id]);
   assert.equal((await db.query('select clued_private.storage_conflict_close_v1($1) v',[beforeIsolation.id])).rows[0].v,'conflict');
   assert.equal((await db.query('select is_called from public.test_conflict_settle_failure_calls')).rows[0].is_called,true,'I9 first reached actual saved-proof settlement and its final receipt boundary');
   const savedConflict=await journal(persisted);assert.equal(savedConflict.version,'3');assert.deepEqual(savedConflict.verified_result_v2,immutableProof);assert.equal(savedConflict.verified_digest_v2,immutableDigest);
   await db.query('drop trigger test_conflict_settle_failure on public.clued_audit_receipts;drop function public.test_conflict_settle_failure();drop sequence public.test_conflict_settle_failure_calls');
   const savedInspection=await cloudRpc({action:'verified_inspect',...persisted.reference});assert.equal(savedInspection.status,'verified');assert.equal(savedInspection.version,3,'inspection maps only the quarantine CAS version');
   const beforeSavedSettle={posts,writes},savedSettled=await cloudRpc({action:'settle_verified',...persisted.reference,intent_id:beforeIsolation.id,base_version:savedInspection.version,request_sha256:beforeIsolation.request_sha256,verified_receipt_id:savedRecord.verified_receipt_id,verified_digest:savedRecord.verified_digest});
   assert.equal(savedSettled.status,'committed');const afterSavedSettle=await journal(persisted);assert.equal(afterSavedSettle.version,'4');assert.deepEqual(afterSavedSettle.verified_result_v2,immutableProof);assert.equal(afterSavedSettle.verified_digest_v2,immutableDigest);assert.deepEqual({posts,writes},beforeSavedSettle);
   const savedExit=(await db.query('select q.state,q.resolution_receipt_id,r.operation,r.status from clued_private.storage_conflict_isolations_v1 q join public.clued_audit_receipts r on r.id=q.resolution_receipt_id where q.intent_id=$1',[beforeIsolation.id])).rows[0];
   assert.deepEqual(savedExit,{state:'resolved',resolution_receipt_id:savedSettled.receipt_id,operation:'storage_verified_settle',status:'committed'});

   const automaticJob=async label=>{
    const created=await submit({operation:'create',target_kind:'file',destination_path:managedRoot+'/20_P_产品与体验/automatic-'+label+'-'+id()+'.txt',content:'registered original baseline'});
    assert.equal((await execute(created)).status,'committed');
    const registered=(await db.query('select * from clued_private.resource_center_artifacts_v1 where user_id=$1 and profile_id=$2 and path=$3 and state=\'active\'',[owner,profileId,created.mutation.destination_path])).rows[0];
    const job=await submit({operation:'replace',target_kind:'file',destination_path:created.mutation.destination_path,destination_file_version:registered.provider_file_version,content:'original failed replacement'});
    blockPatch=true;try{assert.equal((await execute(job)).status,'unreconciled');}finally{blockPatch=false;}
    let original=await journal(job);
    if(label==='bridge'){
     // Historical Native-origin shape: this one disposable journal predates
     // content_before. Stable original/registered Drive ID+version remain;
     // this does not manufacture a historical no-effect proof.
     await db.query("update clued_private.resource_center_mutations_v1 set provider_attempt=provider_attempt-'content_before' where id=$1",[original.id]);original=await journal(job);
    }
    // Simulate the actual old operation clock, not a relaxed recovery window.
    await db.query("update public.clued_audit_receipts set created_at=clock_timestamp()-interval '3 hours' where id=$1",[original.provider_attempt_receipt_id]);
    await db.query("update clued_private.resource_center_mutations_v1 set expires_at=clock_timestamp()-interval '3 hours' where id=$1",[original.id]);
    assert.equal((await db.query('select clued_private.storage_conflict_close_v1($1) v',[original.id])).rows[0].v,'conflict');
    const closed=await journal(job),descriptor=await rpc('clued_storage_scheduled_recovery_v2',cloudIssuer,{action:'load',...job.reference});
    assert.deepEqual(descriptor.conflict_reconcile,{closed_version:3,source_receipt_id:closed.receipt_id});
    return {...job,original,closed,descriptor,registered};
   };
   const automaticInput=job=>{
    const f=files.get(job.registered.provider_file_id),observation={observed_at:new Date().toISOString(),observed_state:'before',boundary_status:'qualified',provider_file_id:f.id,provider_file_version:f.version,parent_id:f.parents[0],name:f.name,trashed:f.trashed,mime_type:f.mimeType,size:f.size,sha256:f.sha256Checksum,head_revision_id:f.headRevisionId};
    return {action:'reconcile_before',...job.reference,base_version:3,source_receipt_id:job.closed.receipt_id,credential_version:1,first_observation:observation,second_observation:{...observation}};
   };
   await real.test('automatic before reconciliation consumes real Worker double GET and separate atomic receipt while preserving original uncertainty',async()=>{
    const job=await automaticJob('bridge'),beforeWrites={posts,writes},request=automaticInput(job);let actualReply,actualRequest;
    const bridge=await createStorageRecoveryReview({client_id:oauthClient,vault:vaultConfig,descriptor:job.descriptor,source_receipt_id:job.closed.receipt_id,fetch:drive,rpc:async input=>{
     actualRequest=structuredClone(input);actualReply=await rpc('clued_storage_scheduled_recovery_v2',cloudIssuer,input);return actualReply;
    }});
    const result=await bridge.reconcile(job.reference);assert.equal(result.status,'resolved',JSON.stringify(result));
    assert.equal(result.resolution,'automatically_reconciled_before');assert.equal(actualReply.automatic_recovery,'resolved');
    assert.notEqual(result.receipt_id,job.closed.receipt_id);assert.equal(result.base_version,3);assert.equal(result.source_receipt_id,job.closed.receipt_id);
    assert.equal(actualRequest.action,'reconcile_before');assert.equal(actualRequest.first_observation.observed_state,'before');
    assert.deepEqual({...actualRequest.first_observation,observed_at:null},{...actualRequest.second_observation,observed_at:null});
    const final=await journal(job);assert.equal(final.state,'conflict');assert.equal(final.version,'4');assert.equal(final.receipt_id,job.closed.receipt_id);
    assert.deepEqual(final.provider_attempt,job.original.provider_attempt);assert.equal(final.provider_attempt_receipt_id,job.original.provider_attempt_receipt_id);assert.equal(final.verified_result_v2,null);
    const exit=(await db.query('select q.state,q.resolution_receipt_id,r.operation,r.status from clued_private.storage_conflict_isolations_v1 q join public.clued_audit_receipts r on r.id=q.resolution_receipt_id where q.intent_id=$1',[job.closed.id])).rows[0];
    assert.deepEqual(exit,{state:'resolved',resolution_receipt_id:result.receipt_id,operation:'storage_automatic_reconcile',status:'committed'});
    const inspected=await rpc('clued_storage_native_recovery_v1',cloudIssuer,{action:'recovery_inspect',...job.reference},native);
    assert.equal(inspected.status,'resolved');assert.equal(inspected.automatic_recovery,'resolved');assert.equal(inspected.receipt_id,result.receipt_id);assert.equal(inspected.base_version,3);assert.equal(inspected.source_receipt_id,job.closed.receipt_id);
    const normal=await rpc('clued_storage_jobs_router_v2',token,{action:'inspect',...job.reference});assert.equal(normal.status,'attention_required');assert.equal(normal.resolution,'automatically_reconciled_before');assert.equal(normal.resolution_receipt_id,result.receipt_id);
    assert.equal((await rpc('clued_storage_scheduled_recovery_v2',cloudIssuer,request)).receipt_id,result.receipt_id,'lost reply only reads the same independent receipt');
    assert.deepEqual({posts,writes},beforeWrites,'automatic recovery never writes to Drive');
    const next=await submit({...job.mutation,content:'next authorized operation after automatic recovery'});assert.equal((await cloudRpc({action:'load',...next.reference})).status,'queued','the same object is usable by a new normally authorized job');
   });
   await real.test('automatic proof rejects changed GETs, stale/CAS/issuer/credential/revocation and rolls back every write on receipt failure',async()=>{
    const job=await automaticJob('negative'),input=automaticInput(job),call=value=>rpc('clued_storage_scheduled_recovery_v2',cloudIssuer,value);
    const pending=await rpc('clued_storage_native_recovery_v1',cloudIssuer,{action:'recovery_inspect',...job.reference},native);assert.equal(pending.automatic_recovery,'pending');assert.equal(pending.review_available,false);assert.equal(pending.abandon_available,false);
    for(const bad of [
     {...input,base_version:2},{...input,source_receipt_id:id()},{...input,credential_version:2},
     {...input,first_observation:{...input.first_observation,observed_at:new Date(Date.now()-31000).toISOString()}},
     {...input,second_observation:{...input.second_observation,provider_file_version:'999'}},
     {...input,first_observation:{...input.first_observation,sha256:'a'.repeat(64)},second_observation:{...input.second_observation,sha256:'a'.repeat(64)}}
    ])await assert.rejects(call(bad),/storage_automatic_reconcile_(conflict|proof_changed)/);
    await assert.rejects(rpc('clued_storage_scheduled_recovery_v2',sha(id()),input),/storage_scheduled_recovery_denied/);
    await db.query("update clued_private.storage_connections_v1 set state='reauthorization_required' where id=$1",[connection]);
    try{await assert.rejects(call(input),/storage_recovery_denied/);}finally{await db.query("update clued_private.storage_connections_v1 set state='active' where id=$1",[connection]);}
    await db.query("update clued_private.storage_oauth_apps_v1 set revoked_at=clock_timestamp() where issuer_hash=$1",[cloudIssuer]);
    try{await assert.rejects(call(input),/storage_(scheduled_)?recovery_denied/);}finally{await db.query('update clued_private.storage_oauth_apps_v1 set revoked_at=null where issuer_hash=$1',[cloudIssuer]);}
    const observedBefore=(await db.query('select count(*)::int n from clued_private.storage_conflict_observations_v1 where intent_id=$1',[job.closed.id])).rows[0].n;
    await db.query(`create function public.test_automatic_receipt_failure() returns trigger language plpgsql as $$begin if new.operation='storage_automatic_reconcile' and new.status='committed' then raise exception 'synthetic_automatic_receipt_failure';end if;return new;end$$;
     create trigger test_automatic_receipt_failure before update on public.clued_audit_receipts for each row execute function public.test_automatic_receipt_failure()`);
    try{await assert.rejects(call(automaticInput(job)),/synthetic_automatic_receipt_failure/);}finally{await db.query('drop trigger test_automatic_receipt_failure on public.clued_audit_receipts;drop function public.test_automatic_receipt_failure()');}
    assert.equal((await journal(job)).version,'3');assert.equal((await db.query('select state from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[job.closed.id])).rows[0].state,'active');
    assert.equal((await db.query('select count(*)::int n from clued_private.storage_conflict_observations_v1 where intent_id=$1',[job.closed.id])).rows[0].n,observedBefore,'failed final receipt rolls back technical observations too');
    assert.equal((await call(automaticInput(job))).status,'resolved');
   });
   await real.test('two actual PostgreSQL recovery sessions serialize to one automatic receipt',async()=>{
    const job=await automaticJob('race'),input=automaticInput(job),otherWorker=server.getPgClient();clients.push(otherWorker);await otherWorker.connect();await setWorkerGatewayCaller(otherWorker);
    await worker.query('begin');let first;
    try{
     first=await rpc('clued_storage_scheduled_recovery_v2',cloudIssuer,input);let finished=false;
     const second=rpc('clued_storage_scheduled_recovery_v2',cloudIssuer,input,otherWorker).then(value=>{finished=true;return value;});
     await new Promise(resolve=>setTimeout(resolve,30));assert.equal(finished,false,'the second connection waits on the original transaction identity lock');
     await worker.query('commit');const again=await second;assert.equal(again.receipt_id,first.receipt_id);
    }catch(error){await worker.query('rollback');throw error;}
    assert.equal((await journal(job)).version,'4');assert.equal((await db.query("select count(*)::int n from public.clued_audit_receipts where operation='storage_automatic_reconcile' and idempotency_key=$1",['storage-auto-before:'+job.closed.id+':3'])).rows[0].n,1);
   });
   await real.test('genuine changed current content remains isolated with optional review, never automatic success',async()=>{
    const job=await automaticJob('changed'),f=files.get(job.registered.provider_file_id);files.set(f.id,{...f,version:'2',sha256Checksum:sha('external different content')});
    const beforeEffects={posts,writes},bridge=await createStorageRecoveryReview({client_id:oauthClient,vault:vaultConfig,descriptor:job.descriptor,source_receipt_id:job.closed.receipt_id,fetch:drive,rpc:input=>rpc('clued_storage_scheduled_recovery_v2',cloudIssuer,input)});
    const result=await bridge.reconcile(job.reference);assert.equal(result.status,'inspection_required');assert.equal(result.diagnostic.reason,'CONTENT_MISMATCH');
    const inspected=await rpc('clued_storage_native_recovery_v1',cloudIssuer,{action:'recovery_inspect',...job.reference},native);assert.equal(inspected.automatic_recovery,'current_state_conflict');assert.equal(inspected.review_available,true);assert.equal(inspected.abandon_available,true);
    assert.equal((await journal(job)).version,'3');assert.equal((await db.query('select state from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[job.closed.id])).rows[0].state,'active');assert.deepEqual({posts,writes},beforeEffects);
   });
   await real.test('late after proof wins the original CAS and a previously prepared before cannot clear it',async()=>{
    const job=await automaticJob('late-after'),beforeInput=automaticInput(job),f=files.get(job.registered.provider_file_id),attempt=job.closed.provider_attempt;
    revisions.get(f.id).get(attempt.pinned_revision_id).keepForever=true;
    files.set(f.id,{...f,version:'2',size:attempt.content_after.size,sha256Checksum:attempt.content_after.sha256,headRevisionId:'late-revision-'+id()});
    const {createStorageCloudRecovery}=await loadWorker('storage-cloud-recovery');stop();let withheldSettle;
    const recovery=await createStorageCloudRecovery({client_id:oauthClient,vault:vaultConfig,fetch:drive,timeout_ms:3000,
     rpc:input=>rpc('clued_storage_scheduled_recovery_v2',cloudIssuer,input),verified:{descriptor:job.descriptor,rpc:async input=>{
      if(input.action==='settle_verified'){withheldSettle=input;throw Error('synthetic lost settle request');}return cloudRpc(input);
     }}});
    assert.equal((await recovery.run(job.reference)).status,'inspection_required');assert.ok(withheldSettle,'late after reached real verified_record before settlement');
    const recorded=await journal(job);assert.ok(recorded.verified_result_v2);assert.equal(recorded.state,'conflict');
    await assert.rejects(rpc('clued_storage_scheduled_recovery_v2',cloudIssuer,beforeInput),/storage_automatic_reconcile_conflict/,'saved true after proof invalidates an older before observation');
    const beforeEffects={posts,writes},settled=await cloudRpc(withheldSettle);assert.equal(settled.status,'committed');
    const final=await journal(job);assert.equal(final.state,'committed');assert.deepEqual(final.verified_result_v2,recorded.verified_result_v2);assert.equal(final.verified_digest_v2,recorded.verified_digest_v2);assert.deepEqual({posts,writes},beforeEffects);
   });
   await real.test('stable trash, rename, move and occupied name slot expose withdrawal without adopting an unqualified boundary',async()=>{
    for(const mode of ['trash','rename','move','slot','absent','absent-slot']){
     const job=await automaticJob('boundary-'+mode),f=files.get(job.registered.provider_file_id);let duplicate;
     if(mode==='trash')files.set(f.id,{...f,version:'2',trashed:true});
     if(mode==='rename')files.set(f.id,{...f,version:'2',name:'externally-renamed.txt'});
     if(mode==='move')files.set(f.id,{...f,version:'2',parents:['outside-original-root']});
     if(mode==='slot'){duplicate='collision-'+id();files.set(duplicate,{...f,id:duplicate});}
     if(mode==='absent'||mode==='absent-slot')files.delete(f.id);
     if(mode==='absent-slot'){duplicate='collision-'+id();files.set(duplicate,{...f,id:duplicate});}
     const beforeEffects={posts,writes};let calls=0;
     const bridge=await createStorageRecoveryReview({client_id:oauthClient,vault:vaultConfig,descriptor:job.descriptor,source_receipt_id:job.closed.receipt_id,fetch:drive,rpc:input=>{calls++;return rpc('clued_storage_scheduled_recovery_v2',cloudIssuer,input);}});
     const result=await bridge.reconcile(job.reference);assert.equal(result.status,'inspection_required',mode);assert.equal(result.automatic_recovery,'current_state_conflict');assert.equal(calls,1);
     const inspected=await rpc('clued_storage_native_recovery_v1',cloudIssuer,{action:'recovery_inspect',...job.reference},native);
     assert.equal(inspected.automatic_recovery,'current_state_conflict',mode);assert.equal(inspected.review_available,false,mode);assert.equal(inspected.abandon_available,true,mode);assert.equal(inspected.base_version,3);assert.equal(inspected.source_receipt_id,job.closed.receipt_id);
     const listed=await rpc('clued_storage_native_recovery_v1',cloudIssuer,{action:'recovery_list',connection_id:connection},native);assert.equal(listed.jobs.find(value=>value.job_id===job.reference.job_id).automatic_recovery,'current_state_conflict');
     assert.equal((await journal(job)).version,'3');assert.equal((await db.query('select state from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[job.closed.id])).rows[0].state,'active');
     const check=(await db.query('select boundary_status,observation_id from clued_private.storage_automatic_reconcile_checks_v1 where intent_id=$1',[job.closed.id])).rows[0];assert.notEqual(check.boundary_status,'qualified');assert.equal(check.observation_id,null,'an unqualified new location is never an adoption observation');
     const abandon=await rpc('clued_storage_native_recovery_v1',cloudIssuer,{action:'review_abandon',...job.reference,base_version:3,source_receipt_id:job.closed.receipt_id,confirmed:true},native);assert.equal(abandon.resolution,'abandoned_registration');assert.equal((await journal(job)).state,'conflict');assert.deepEqual({posts,writes},beforeEffects);
     if(duplicate)files.delete(duplicate);
    }
   });
   await real.test('a failed target metadata read remains pending instead of inventing a current-state conflict',async()=>{
    const job=await automaticJob('read-failure');let calls=0;
    const bridge=await createStorageRecoveryReview({client_id:oauthClient,vault:vaultConfig,descriptor:job.descriptor,source_receipt_id:job.closed.receipt_id,fetch:async(url,init)=>new URL(String(url)).pathname.endsWith('/'+job.registered.provider_file_id)?new Response('',{status:403}):drive(url,init),rpc:async()=>{calls++;assert.fail('no proof from a failed metadata read');}});
    await assert.rejects(bridge.reconcile(job.reference));assert.equal(calls,0);
    const inspected=await rpc('clued_storage_native_recovery_v1',cloudIssuer,{action:'recovery_inspect',...job.reference},native);assert.equal(inspected.automatic_recovery,'pending');assert.equal(inspected.review_available,false);assert.equal(inspected.abandon_available,false);
    assert.equal((await db.query('select count(*)::int n from clued_private.storage_automatic_reconcile_checks_v1 where intent_id=$1',[job.closed.id])).rows[0].n,0);
   });

   // Directory moves remain an explicit I9 exception even for old non-job
   // journals. They exercise scanner ordering, never claim provider authority.
   for(let index=0;index<51;index++){
    const prefixRoot='/ineligible-'+id()+'/Clued_资料中心',prefixRootId='prefix-'+id();
    const registered=await register({action:'profile_register',project_id:project,profile_version:'prefix/'+index,managed_root:prefixRoot,root_folder_id:prefixRootId,root_parent_id:'my-drive',root_folder_version:'1'}),prefixProfile=registered.target_refs.find(r=>r.role==='primary').id;
    const request=sha(id());await db.query(`insert into clued_private.resource_center_mutations_v1(id,user_id,profile_id,request_key,request_sha256,exact_request,authority_request,authority_result,authority_token_hash,profile_version,source_decision_id,state,version,expires_at,receipt_id)
     values($1,$2,$3,$4,$5,$6,$7,'{}',$5,1,$8,'started',2,clock_timestamp()-interval '10 hours',$9)`,[id(),owner,prefixProfile,id(),request,{mutation:{operation:'move',target_kind:'directory',source_path:prefixRoot+'/old',destination_path:prefixRoot+'/new'}},{provider_identity:{root_folder_id:prefixRootId}},decision,await receipt()]);
   }
   const failedJob=await submit({operation:'create',target_kind:'file',destination_path:managedRoot+'/20_P_产品与体验/failing-sweep.txt',content:'failed sweep remains original'});assert.equal((await execute(failedJob,true)).status,'unreconciled');const failedRow=await journal(failedJob);
   const extraSuffix=id(),extraRoot='/extra-'+extraSuffix+'/Clued_资料中心',extraRootId='extra-root-'+extraSuffix,extraParent='extra-parent-'+extraSuffix,extraTrack='extra-track-'+extraSuffix;
   const extraRegistered=await register({action:'profile_register',project_id:project,profile_version:'extra/1',managed_root:extraRoot,root_folder_id:extraRootId,root_parent_id:extraParent,root_folder_version:'1'}),extraProfile=extraRegistered.target_refs.find(r=>r.role==='primary').id;
   await register({action:'artifact_register',profile_id:extraProfile,path:extraRoot+'/20_P_产品与体验',provider_file_id:extraTrack,provider_file_version:'1',target_kind:'directory',governance_class:'ordinary',delete_authority:false});
   assert.equal((await db.query('select public.clued_storage_cloud_qualify_v1($1,$2::jsonb) v',[owner,JSON.stringify({profile_id:extraProfile,base_version:1,allowed_root_children:['20_P_产品与体验'],source_decision_id:decision,idempotency_key:id()})])).rows[0].v.status,'committed');
   const extraConnected=await account({action:'register',profile_id:extraProfile,source_decision_id:decision,idempotency_key:id()}),extraConnection=extraConnected.target_refs.find(r=>r.role==='primary').id,extraPolicy=id();
   await db.query('begin');try{
    await db.query("update clued_private.storage_connections_v1 set state='active',provider_subject='conflict-fixture-subject',oauth_client_id=$2,credential_version=1,credential_envelope=$3 where id=$1",[extraConnection,oauthClient,{contract:'clued.storage-credential/1',key_id:'disposable',nonce:'abcdefghijklmnop',ciphertext:'abcdefghijklmnopqrstuvwxyz'}]);
    await db.query(`insert into clued_private.storage_account_policies_v2(id,owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id)
     select $1,c.owner_id,c.id,c.provider,c.provider_subject,p.root_folder_id,p.id,clued_private.storage_policy_scope_digest_v2(c.id),1,c.source_decision_id,c.decision_version,'reviewed_transition','conflict-fixture/1',c.receipt_id from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=$2`,[extraPolicy,extraConnection]);
    await db.query("update clued_private.storage_account_policies_v2 set state='active',activation_receipt_id=$2 where id=$1",[extraPolicy,extraConnected.receipt_id]);
    await db.query("update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=$2,auth_generation=auth_generation+1 where id=$1",[extraConnection,extraPolicy]);await db.query('commit');
   }catch(error){await db.query('rollback');throw error;}
   files.set(extraParent,folder(extraParent,'extra-'+extraSuffix,null));files.set(extraRootId,folder(extraRootId,'Clued_资料中心',extraParent));files.set(extraTrack,folder(extraTrack,'20_P_产品与体验',extraRootId));
   const laterJob=await submit({operation:'create',target_kind:'file',destination_path:extraRoot+'/20_P_产品与体验/later-eligible.txt',content:'later eligible job'},extraConnection);assert.equal((await execute(laterJob,true)).status,'unreconciled');const laterRow=await journal(laterJob);
   await db.query("update clued_private.resource_center_mutations_v1 set expires_at=clock_timestamp()-case when id=$1 then interval '4 hours' else interval '3 hours' end where id in ($1,$2)",[failedRow.id,laterRow.id]);
   await db.query(`create function public.test_conflict_candidate_failure() returns trigger language plpgsql as $$begin
    if old.id::text=tg_argv[0] and new.state='conflict' then raise exception 'synthetic_conflict_candidate_failure';end if;return new;end$$;
    create trigger test_conflict_candidate_failure before update on clued_private.resource_center_mutations_v1 for each row execute function public.test_conflict_candidate_failure('${failedRow.id}')`);
   const batch=(await db.query('select clued_private.storage_conflict_sweep_v1() v')).rows[0].v;assert.equal(batch.errors,1);assert.ok(batch.conflicted>=1);assert.equal((await journal(failedJob)).state,'started');assert.equal((await journal(laterJob)).state,'conflict','51 older ineligible journals and a failed candidate cannot starve a later eligible job');
   const backoff=(await db.query('select attempts,next_attempt_at>clock_timestamp() waiting from clued_private.storage_conflict_scan_v1 where intent_id=$1',[failedRow.id])).rows[0];assert.deepEqual(backoff,{attempts:1,waiting:true});
   assert.equal((await db.query('select count(*)::int n from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[failedRow.id])).rows[0].n,0,'failed closure rolls back its isolation and receipt as one transaction');
   assert.equal((await db.query('select clued_private.storage_conflict_sweep_v1() v')).rows[0].v.errors,0,'failed candidate waits for its own backoff');
   await db.query('drop trigger test_conflict_candidate_failure on clued_private.resource_center_mutations_v1;drop function public.test_conflict_candidate_failure()');
   await db.query("update clued_private.storage_conflict_scan_v1 set next_attempt_at=clock_timestamp()-interval '1 second' where intent_id=$1",[failedRow.id]);
   assert.ok((await db.query('select clued_private.storage_conflict_sweep_v1() v')).rows[0].v.conflicted>=1);assert.equal((await journal(failedJob)).state,'conflict');
   const incompleteJob=await submit({operation:'replace',target_kind:'file',destination_path:late.mutation.destination_path,destination_file_version:prior.version,content:'historical incomplete scope'});
   blockPatch=true;assert.equal((await execute(incompleteJob)).status,'unreconciled');blockPatch=false;const incompleteStarted=await journal(incompleteJob);assert.ok(incompleteStarted.provider_attempt_receipt_id);
   const beforeIncompleteExit={posts,writes},incompleteProviderState=structuredClone(files.get(prior.id)),incompleteWriters=(await db.query('select count(*)::int n from clued_private.resource_center_writer_bindings_v1')).rows[0].n;
   // Historical-format fixture only: the actual started/attempted cloud job
   // retains its root, provider ID, writer and policy lineage. No trigger or
   // caller guard is disabled to reproduce its missing qualified parent.
   await db.query("update clued_private.resource_center_mutations_v1 set authority_request=jsonb_set(authority_request,'{provider_identity,destination_parent_id}','null'::jsonb,false),expires_at=clock_timestamp()-interval '3 hours' where id=$1",[incompleteStarted.id]);
   assert.equal((await db.query('select clued_private.storage_conflict_supported_v1($1) supported',[incompleteStarted.id])).rows[0].supported,true);
   assert.equal((await db.query('select clued_private.storage_conflict_close_v1($1) v',[incompleteStarted.id])).rows[0].v,'conflict');const incompleteClosed=await journal(incompleteJob);
   assert.equal((await db.query('select scope_complete from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[incompleteStarted.id])).rows[0].scope_complete,false);
   const incompleteList=await rpc('clued_storage_native_recovery_v1',cloudIssuer,{action:'recovery_list',connection_id:connection},native),incompleteListed=incompleteList.jobs.find(j=>j.job_id===incompleteJob.reference.job_id);
   assert.ok(incompleteListed);assert.equal(incompleteListed.status,'attention_required');assert.equal(incompleteListed.review_available,false);assert.equal(incompleteListed.abandon_available,true);assert.equal(incompleteListed.base_version,3);assert.equal(incompleteListed.source_receipt_id,incompleteClosed.receipt_id);assert.equal(incompleteListed.execution_permitted,false);
   await assert.rejects(rpc('clued_storage_native_recovery_load_v2',cloudSecret,{action:'recovery_load',...incompleteJob.reference},native),/storage_recovery_denied/,'incomplete scope never acquires a metadata-review credential descriptor');
   const releaseMutation={operation:'create',target_kind:'file',destination_path:managedRoot+'/20_P_产品与体验/released-incomplete-root.txt',content:'root is available after explicit withdrawal'};
   await assert.rejects(db.query('select clued_private.storage_conflict_assert_v1($1,$2,$3)',[owner,profileId,releaseMutation]),/storage_object_under_review/,'incomplete scope keeps its root fallback fence');
   const incompleteAbandon={action:'review_abandon',...incompleteJob.reference,base_version:incompleteListed.base_version,source_receipt_id:incompleteListed.source_receipt_id,confirmed:true};
   const {confirmed:unusedConfirmation,...unconfirmedAbandon}=incompleteAbandon;await assert.rejects(rpc('clued_storage_native_recovery_v1',cloudIssuer,unconfirmedAbandon,native),/storage_conflict_review_invalid/);
   await assert.rejects(rpc('clued_storage_native_recovery_v1',cloudIssuer,{...incompleteAbandon,base_version:4},native),/storage_conflict_review_conflict/);
   await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[other,JSON.stringify({sub:other,session_id:otherSession})]);
   try{await assert.rejects(rpc('clued_storage_native_recovery_v1',cloudIssuer,incompleteAbandon,native),/storage_recovery_denied/);}finally{await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[owner,JSON.stringify({sub:owner,session_id:session})]);}
   const incompleteAbandoned=await rpc('clued_storage_native_recovery_v1',cloudIssuer,incompleteAbandon,native);assert.equal(incompleteAbandoned.resolution,'abandoned_registration');assert.equal(incompleteAbandoned.base_version,3);assert.equal(incompleteAbandoned.source_receipt_id,incompleteClosed.receipt_id);
   const incompleteFinal=await journal(incompleteJob);assert.equal(incompleteFinal.state,'conflict');assert.equal(incompleteFinal.receipt_id,incompleteClosed.receipt_id,'the original journal keeps its unknown-effect receipt');
   assert.equal((await db.query('select state from clued_private.resource_center_artifacts_v1 where profile_id=$1 and provider_file_id=$2',[profileId,prior.id])).rows[0].state,'revoked');
   const incompleteExit=(await db.query('select q.state,r.operation,r.status from clued_private.storage_conflict_isolations_v1 q join public.clued_audit_receipts r on r.id=q.resolution_receipt_id where q.intent_id=$1',[incompleteStarted.id])).rows[0];assert.deepEqual(incompleteExit,{state:'resolved',operation:'storage_conflict_abandon',status:'committed'});
   await db.query('select clued_private.storage_conflict_assert_v1($1,$2,$3)',[owner,profileId,releaseMutation]);await submit(releaseMutation);
   assert.deepEqual({posts,writes},beforeIncompleteExit);assert.deepEqual(files.get(prior.id),incompleteProviderState);assert.equal((await db.query('select count(*)::int n from clued_private.resource_center_writer_bindings_v1')).rows[0].n,incompleteWriters,'Owner withdrawal neither calls the provider nor grants a new writer');
   await real.test('a replacement legitimate read connection completes before and after recovery without reviving the old connection',async()=>{
    const beforeJob=await automaticJob('replacement-reader-before'),afterJob=await automaticJob('replacement-reader-after'),refreshJob=await automaticJob('replacement-reader-expired');
    // Historical OAuth connection retirement, distinct from an Owner root
    // stop: the latter is tested below and must continue to deny recovery.
    await db.query('begin');try{
     await db.query("update clued_private.storage_account_policies_v2 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=$2 where connection_id=$1 and state='active'",[connection,connected.receipt_id]);
     await db.query("update clued_private.storage_connections_v1 set state='revoked',revoked_at=clock_timestamp(),version=version+1,auth_mode='revoked',account_policy_id=null,auth_generation=auth_generation+1 where id=$1",[connection]);
     await db.query('commit');
    }catch(error){await db.query('rollback');throw error;}
    const registration=await account({action:'register',profile_id:profileId,source_decision_id:decision,idempotency_key:id()});
    assert.equal(registration.status,'committed',JSON.stringify(registration));
    const readerConnection=registration.target_refs.find(r=>r.role==='primary').id,newPolicy=id();
    const readEnvelope=await vault.seal(JSON.stringify({token_type:'Bearer',access_token:'synthetic-replacement-reader-access',scope:'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly',expires_at_ms:Date.now()+3600000}),
     {owner_id:owner,connection_id:readerConnection,provider:'google-drive',provider_subject:'conflict-fixture-subject',oauth_client_id:oauthClient,credential_version:2});
    await db.query('begin');try{
     await db.query("update clued_private.storage_connections_v1 set state='active',provider_subject='conflict-fixture-subject',oauth_client_id=$2,credential_version=2,credential_envelope=$3 where id=$1",[readerConnection,oauthClient,readEnvelope]);
     await db.query(`insert into clued_private.storage_account_policies_v2(id,owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id)
      select $1,c.owner_id,c.id,c.provider,c.provider_subject,p.root_folder_id,p.id,clued_private.storage_policy_scope_digest_v2(c.id),1,c.source_decision_id,c.decision_version,'reviewed_transition','conflict-reader-fixture/1',c.receipt_id
      from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=$2`,[newPolicy,readerConnection]);
     await db.query("update clued_private.storage_account_policies_v2 set state='active',activation_receipt_id=$2 where id=$1",[newPolicy,registration.receipt_id]);
     await db.query("update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=$2,auth_generation=auth_generation+1 where id=$1",[readerConnection,newPolicy]);
     await db.query('commit');
    }catch(error){await db.query('rollback');throw error;}
    const beforeEffects={posts,writes},writerCount=(await db.query('select count(*)::int n from clued_private.resource_center_writer_bindings_v1')).rows[0].n;
    const load=job=>rpc('clued_storage_scheduled_recovery_v2',cloudIssuer,{action:'load',...job.reference});
    const descriptor=await load(beforeJob);
    assert.equal(descriptor.connection_id,connection);assert.equal(descriptor.recovery_reader.connection_id,readerConnection);
    assert.equal(descriptor.credential_version,2);assert.deepEqual(descriptor.attempt,beforeJob.descriptor.attempt);
    const listCurrent=()=>rpc('clued_storage_native_recovery_v1',cloudIssuer,{action:'recovery_list',connection_id:readerConnection},native);
    const currentList=await listCurrent();
    for(const original of [beforeJob,afterJob]){
     const row=currentList.jobs.find(value=>value.job_id===original.reference.job_id);
     assert.ok(row,'the current Native view includes the original predecessor job');
     assert.equal(row.connection_id,connection);assert.equal(row.read_connection_id,readerConnection);
     assert.equal(row.receipt_id,original.closed.receipt_id);
    }
    assert.doesNotMatch(JSON.stringify(currentList),/credential_envelope|access_token|recovery_reader|provider_attempt/);
    // Keep a real list transaction open while another session owns job B.
    // The listing must acquire neither its job lock nor any root lock.
    const blocker=server.getPgClient();clients.push(blocker);await blocker.connect();
    await blocker.query('begin');await native.query('begin');
    try{
     await blocker.query("select pg_advisory_xact_lock(hashtextextended('storage-job:'||$1||':'||$2,0))",[owner,afterJob.reference.job_id]);
     await native.query("set local statement_timeout='1500ms'");
     assert.ok((await listCurrent()).jobs.some(value=>value.job_id===afterJob.reference.job_id),'list does not wait on a recovering predecessor job');
     assert.equal((await blocker.query("select pg_try_advisory_xact_lock(hashtextextended($1||':'||$2,0)) available",[owner,cloudRoot])).rows[0].available,true,'list holds no execution root lock');
    }finally{await native.query('rollback');await blocker.query('rollback');}
    for(const representation of [value=>value.toUpperCase(),value=>value.replaceAll('-','')]){
     await blocker.query('begin');try{
      await blocker.query('select clued_private.storage_recovery_client_input_guard_v1($1::jsonb)',[JSON.stringify({connection_id:representation(connection),job_id:representation(beforeJob.reference.job_id)})]);
      assert.equal((await db.query("select pg_try_advisory_xact_lock(hashtextextended('storage-client:'||$1||':'||$2,0)) available",[owner,lineage])).rows[0].available,false,'a valid noncanonical UUID cannot bypass the lineage guard');
     }finally{await blocker.query('rollback');}
    }
    const input={...automaticInput(beforeJob),credential_version:2,recovery_reader:descriptor.recovery_reader};
    await assert.rejects(rpc('clued_storage_scheduled_recovery_v2',cloudIssuer,{...input,recovery_reader:{...input.recovery_reader,connection_version:input.recovery_reader.connection_version+1}}),/storage_automatic_reconcile_conflict|storage_recovery_reader_changed/);
    for(const fault of ['root','client','credential','subject','client_id','policy']){
     await db.query('begin');try{
      if(fault==='root')await db.query('insert into clued_private.storage_root_denies_v2(owner_id,provider,provider_subject,root_folder_id,lineage_id,denied,receipt_id) values($1,\'google-drive\',\'conflict-fixture-subject\',$2,null,true,$3)',[owner,cloudRoot,registration.receipt_id]);
      if(fault==='client')await db.query('insert into clued_private.storage_read_client_denies_v1(owner_id,lineage_id,class,denied,receipt_id) values($1,$2,\'read\',true,$3)',[owner,lineage,registration.receipt_id]);
      if(fault==='credential')await db.query('update clued_private.storage_connections_v1 set credential_version=credential_version+1 where id=$1',[readerConnection]);
      if(fault==='subject')await db.query("update clued_private.storage_connections_v1 set provider_subject='wrong-subject' where id=$1",[readerConnection]);
      if(fault==='client_id')await db.query("update clued_private.storage_connections_v1 set oauth_client_id='wrong-client' where id=$1",[readerConnection]);
      if(fault==='policy'){
       await db.query("update clued_private.storage_account_policies_v2 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=$2 where id=$1",[newPolicy,registration.receipt_id]);
       await db.query("update clued_private.storage_connections_v1 set state='revoked',revoked_at=clock_timestamp(),auth_mode='revoked',account_policy_id=null,auth_generation=auth_generation+1 where id=$1",[readerConnection]);
      }
      if(fault!=='credential')assert.equal((await db.query('select clued_private.storage_recovery_native_visible_v1($1,$2,$3,$4) visible',[owner,readerConnection,beforeJob.reference.job_id,cloudIssuer])).rows[0].visible,false,'a denied current read context cannot enumerate predecessor jobs: '+fault);
      await assert.rejects(db.query('select clued_private.storage_recovery_reader_assert_v1($1,$2::jsonb)',[cloudIssuer,JSON.stringify(input)]),/storage_recovery_denied|storage_recovery_reader_changed/);
     }finally{await db.query('rollback');}
    }
    const recovering=server.getPgClient(),denying=server.getPgClient();clients.push(recovering,denying);
    await recovering.connect();await denying.connect();await setWorkerGatewayCaller(recovering);
    await denying.query('set role authenticated');
    await denying.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[owner,JSON.stringify({sub:owner,session_id:session})]);
    const deny=async(denied,generation)=>(await denying.query('select public.clued_storage_read_access_v1($1::jsonb) v',[JSON.stringify({action:'deny_class',binding_id:approved.binding_id,class:'read',denied,base_generation:generation,idempotency_key:id()})])).rows[0].v;
    const loadRacing=()=>rpc('clued_storage_scheduled_recovery_v2',cloudIssuer,{action:'load',...beforeJob.reference},recovering);
    const waitBlocked=async caller=>{const pid=(await caller.query('select pg_backend_pid() pid')).rows[0].pid;return pid;};
    const recoveringPid=await waitBlocked(recovering),denyingPid=await waitBlocked(denying);
    const blocked=async pid=>{for(let n=0;n<200;n++){if((await db.query('select exists(select 1 from pg_locks where pid=$1 and not granted) waiting',[pid])).rows[0].waiting)return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('the competing operation did not serialize on its lineage guard');};
    let pending;
    await recovering.query('begin');await denying.query('begin');
    try{
     assert.equal((await loadRacing()).recovery_reader.connection_id,readerConnection);
     pending=deny(true,0).then(value=>({value}),error=>({error}));await blocked(denyingPid);
     await recovering.query('commit');const outcome=await pending;assert.ifError(outcome.error);assert.equal(outcome.value.status,'committed');
     await denying.query('commit');await assert.rejects(loadRacing(),/storage_recovery_denied/);
     assert.equal((await deny(false,1)).status,'committed');
    }finally{await recovering.query('rollback');await denying.query('rollback');await pending;}
    await denying.query('begin');await recovering.query('begin');
    try{
     assert.equal((await deny(true,2)).status,'committed');
     pending=loadRacing().then(value=>({value}),error=>({error}));await blocked(recoveringPid);
     assert.equal((await db.query("select pg_try_advisory_xact_lock(hashtextextended($1||':'||$2,0)) available",[owner,cloudRoot])).rows[0].available,true,'a denied waiter has not taken the root before the client guard');
     await denying.query('commit');const outcome=await pending;assert.match(outcome.error?.message??'',/storage_recovery_denied/);
    }finally{await denying.query('rollback');await pending;await recovering.query('rollback');}
    assert.equal((await deny(false,3)).status,'committed');
    const bridge=await createStorageRecoveryReview({client_id:oauthClient,vault:vaultConfig,descriptor,source_receipt_id:beforeJob.closed.receipt_id,fetch:drive,rpc:value=>rpc('clued_storage_scheduled_recovery_v2',cloudIssuer,value)});
    const reconciled=await bridge.reconcile(beforeJob.reference);assert.equal(reconciled.status,'resolved');
    assert.equal((await journal(beforeJob)).state,'conflict','old unknown outcome is retained');
    const audits=(await db.query('select e.change_summary payload,r.received_payload_hash=clued_private.m1_sha256(e.change_summary) digest_valid from public.clued_audit_receipts r join public.clued_context_events e on e.receipt_id=r.id where r.id=$1',[reconciled.receipt_id])).rows;
    assert.equal(audits.length,1);assert.equal(audits[0].digest_valid,true);
    assert.equal(audits[0].payload.credential_version,2);assert.deepEqual(audits[0].payload.recovery_reader,descriptor.recovery_reader);
    const changed=files.get(afterJob.registered.provider_file_id),attempt=afterJob.descriptor.attempt;
    files.set(changed.id,{...changed,version:'2',size:attempt.content_after.size,sha256Checksum:attempt.content_after.sha256,headRevisionId:'replacement-reader-after-revision'});
    const {createStorageCloudRecovery}=await import('data:text/javascript;base64,'+Buffer.from((await build({entryPoints:[path.join(cloud,'worker/storage-cloud-recovery.ts')],bundle:true,platform:'node',format:'esm',write:false})).outputFiles[0].text).toString('base64'));
    let typedProofChallenged=false;
    const readerTrace=[],afterDescriptor=await load(afterJob),recovery=await createStorageCloudRecovery({client_id:oauthClient,vault:vaultConfig,fetch:drive,
     report_diagnostic:async(reference,diagnostic)=>readerTrace.push({reference,diagnostic}),
     rpc:value=>rpc('clued_storage_scheduled_recovery_v2',cloudIssuer,value),verified:{descriptor:afterDescriptor,rpc:async value=>{
      try{
       if(value.action==='verified_record'&&!typedProofChallenged){
        typedProofChallenged=true;
        await assert.rejects(cloudRpc({...value,proof:{...value.proof,unexpected_field:true}}),/storage_verified_mismatch/,'a current read credential never skips the original complete typed proof validator');
       }
       const result=await cloudRpc(value);readerTrace.push({action:value.action,result});return result;
      }catch(error){readerTrace.push({action:value.action,error:error.message});throw error;}
     }}});
    const unpinned=await recovery.run(afterJob.reference);assert.equal(unpinned.status,'inspection_required');
    assert.equal(unpinned.diagnostic.reason,'PREVIOUS_REVISION_UNCONFIRMED','replacement credentials cannot bypass the original revision-retention proof');
    revisions.get(changed.id).get(attempt.pinned_revision_id).keepForever=true;
    const settled=await recovery.run(afterJob.reference);assert.equal(settled.status,'committed',JSON.stringify({settled,readerTrace}));
    assert.equal(typedProofChallenged,true);
    const afterJournal=await journal(afterJob);assert.equal(afterJournal.state,'committed');assert.deepEqual(afterJournal.verified_result_v2.recovery_reader,afterDescriptor.recovery_reader);
    // No queued job belongs to the new reader. Idle discovery has already
    // observed this credential and is not a substitute for recovery demand.
    const {scopeString}=await loadWorker('storage-google-scopes'),{createStorageGoogleRefresh}=await loadWorker('storage-google-refresh');
    const {storageRecoveryRefreshReference}=await loadWorker('storage-cloud-recovery');stop();
    const readerRow=(await db.query('select provider_scope_profile from clued_private.storage_connections_v1 where id=$1',[readerConnection])).rows[0];
    const refreshScope=scopeString(readerRow.provider_scope_profile),expiredEnvelope=await vault.seal(JSON.stringify({token_type:'Bearer',access_token:'synthetic-expired-reader-access',refresh_token:'synthetic-reader-refresh-token',scope:refreshScope,expires_at_ms:Date.now()-60000}),
     {owner_id:owner,connection_id:readerConnection,provider:'google-drive',provider_subject:'conflict-fixture-subject',oauth_client_id:oauthClient,credential_version:2});
    await db.query('update clued_private.storage_connections_v1 set credential_envelope=$2 where id=$1',[readerConnection,expiredEnvelope]);
    await db.query(`insert into clued_private.storage_refresh_delegations_v1(connection_id,issuer_hash,enabled,receipt_id)
     values($1,$2,false,$3) on conflict(connection_id) do update set enabled=false,failures=0,next_refresh_at=clock_timestamp(),version=clued_private.storage_refresh_delegations_v1.version+1`,[readerConnection,cloudIssuer,registration.receipt_id]);
    await db.query(`insert into clued_private.storage_refresh_activity_v1(connection_id,credential_version,credential_expires_at,last_successful_exchange_at,keepalive_anchor_at)
     values($1,2,clock_timestamp()-interval '1 minute',clock_timestamp(),clock_timestamp())
     on conflict(connection_id) do update set credential_version=2,credential_expires_at=excluded.credential_expires_at,last_successful_exchange_at=excluded.last_successful_exchange_at,keepalive_anchor_at=excluded.keepalive_anchor_at`,[readerConnection]);
    const refreshInputs=[],refreshProvider=[];
    const refresher=await createStorageGoogleRefresh({client_id:oauthClient,client_secret:'synthetic-reader-client-secret',vault:vaultConfig,
     rpc:input=>{refreshInputs.push(input);return rpc('clued_storage_refresh_worker_v1',cloudIssuer,input);},fetch:async(url,init)=>{
      const parsed=new URL(String(url));refreshProvider.push({path:parsed.pathname,method:init.method??'GET'});
      if(parsed.origin==='https://oauth2.googleapis.com'){
       assert.equal(init.method,'POST');assert.equal(new URLSearchParams(init.body).get('refresh_token'),'synthetic-reader-refresh-token');
       return Response.json({token_type:'Bearer',access_token:'synthetic-renewed-reader-access',expires_in:3600});
      }
      assert.equal(parsed.origin,'https://www.googleapis.com');assert.equal(init.method,undefined);
      if(parsed.pathname.endsWith('/about'))return Response.json({user:{me:true,permissionId:'conflict-fixture-subject'}});
      assert.equal(parsed.pathname,'/drive/v3/files/'+cloudRoot);
      return Response.json({id:cloudRoot,parents:[cloudParent],mimeType:'application/vnd.google-apps.folder',trashed:false,isAppAuthorized:true,capabilities:{canAddChildren:true}});
     }});
    let expiredDescriptor=await load(refreshJob),refreshReference=storageRecoveryRefreshReference(expiredDescriptor,refreshJob.reference);
    assert.deepEqual(refreshReference,{connection_id:readerConnection,job_id:refreshJob.reference.job_id});
    assert.equal((await refresher.run(refreshReference.connection_id,refreshReference.job_id)).status,'unavailable','a disabled current delegation is never enabled by recovery');
    assert.equal(refreshProvider.length,0);
    await db.query('update clued_private.storage_refresh_delegations_v1 set enabled=true,version=version+1 where connection_id=$1',[readerConnection]);
    const idle=await rpc('clued_storage_refresh_worker_v1',cloudIssuer,{action:'due_demand'});
    assert.equal(idle.connections.some(row=>row.connection_id===readerConnection),false,'idle discovery misses this already-observed reader without its own queued job');
    await blocker.query('begin');await recovering.query('begin');
    try{
     await blocker.query("select pg_advisory_xact_lock(hashtextextended('storage-client:'||$1||':'||$2,0))",[owner,lineage]);
     await recovering.query("set local statement_timeout='1500ms'");
     pending=rpc('clued_storage_refresh_worker_v1',cloudIssuer,{action:'claim',connection_id:readerConnection,recovery_job_id:refreshJob.reference.job_id,attempt_id:id()},recovering).then(value=>({value}),error=>({error}));
     await blocked(recoveringPid);
     assert.equal((await db.query("select pg_try_advisory_xact_lock(hashtextextended($1||':'||$2,0)) available",[owner,cloudRoot])).rows[0].available,true,'reader refresh waits at the original lineage before taking root');
     await blocker.query('commit');const result=await pending;assert.ifError(result.error);assert.equal(result.value.status,'acquired');
    }finally{await blocker.query('rollback');await pending;await recovering.query('rollback');}
    const expiredRecovery=await createStorageCloudRecovery({client_id:oauthClient,vault:vaultConfig,fetch:drive,report_expiring:true,
     rpc:value=>rpc('clued_storage_scheduled_recovery_v2',cloudIssuer,value),verified:{descriptor:expiredDescriptor,rpc:cloudRpc}});
    assert.equal((await expiredRecovery.run(refreshJob.reference)).status,'credential_expiring');
    const refreshAttemptsBefore=(await db.query('select count(*)::int n from clued_private.storage_refresh_attempts_v1')).rows[0].n;
    assert.equal((await refresher.run(refreshReference.connection_id,refreshReference.job_id)).status,'committed',JSON.stringify(refreshInputs));
    assert.equal(refreshProvider.filter(row=>row.method==='POST').length,1,'the original recovery demand causes exactly one token exchange');
    const refreshAttempt=(await db.query('select connection_id,recovery_job_id,recovery_intent_id,recovery_attempt_digest,state from clued_private.storage_refresh_attempts_v1 where connection_id=$1',[readerConnection])).rows;
    assert.equal(refreshAttempt.length,1);assert.equal(refreshAttempt[0].state,'committed');assert.equal(refreshAttempt[0].connection_id,readerConnection);
    assert.equal(refreshAttempt[0].recovery_job_id,refreshJob.reference.job_id);assert.equal(refreshAttempt[0].recovery_intent_id,refreshJob.closed.id);
    assert.match(refreshAttempt[0].recovery_attempt_digest,/^[0-9a-f]{64}$/);
    assert.equal((await db.query('select count(*)::int n from clued_private.storage_refresh_attempts_v1')).rows[0].n,refreshAttemptsBefore+1);
    const refreshedDescriptor=await load(refreshJob);assert.equal(refreshedDescriptor.credential_version,3);assert.equal(refreshedDescriptor.connection_id,connection);
    assert.equal(refreshedDescriptor.recovery_reader.connection_id,readerConnection);
    const refreshedReview=await createStorageRecoveryReview({client_id:oauthClient,vault:vaultConfig,descriptor:refreshedDescriptor,source_receipt_id:refreshJob.closed.receipt_id,fetch:drive,
     rpc:value=>rpc('clued_storage_scheduled_recovery_v2',cloudIssuer,value)});
    assert.equal((await refreshedReview.reconcile(refreshJob.reference)).status,'resolved');
    assert.equal((await journal(refreshJob)).state,'conflict','refresh and before reconciliation never forge the old overwrite result');
    assert.equal((await db.query('select state from clued_private.storage_connections_v1 where id=$1',[connection])).rows[0].state,'revoked');
    assert.deepEqual({posts,writes},beforeEffects);assert.equal((await db.query('select count(*)::int n from clued_private.resource_center_writer_bindings_v1')).rows[0].n,writerCount);
   });
  });
  await t.test('incomplete candidate scope locks its physical root across Owners without blocking unrelated roots',async()=>{
   const partialRoot='/incomplete-'+id()+'/Clued_资料中心',physicalRoot='incomplete-root-'+id(),partialFile='incomplete-file-'+id();
   const partialRegistered=await register({action:'profile_register',project_id:project,profile_version:'incomplete/1',managed_root:partialRoot,root_folder_id:physicalRoot,root_parent_id:'my-drive',root_folder_version:'1'}),partialProfile=partialRegistered.target_refs.find(r=>r.role==='primary').id;
   const otherDecision=(await db.query("select id,project_id from public.clued_memories where user_id=$1 and record_type='decision' limit 1",[other])).rows[0];
   const aliasRoot='/other-alias-'+id()+'/Clued_资料中心',aliasRegistered=(await db.query('select public.clued_resource_center_admin_v1($1,$2::jsonb) v',[other,JSON.stringify({action:'profile_register',project_id:otherDecision.project_id,source_decision_id:otherDecision.id,idempotency_key:id(),profile_version:'same-physical/1',managed_root:aliasRoot,root_folder_id:physicalRoot,root_parent_id:'my-drive',root_folder_version:'1'})])).rows[0].v;
   assert.equal(aliasRegistered.status,'committed');const aliasProfile=aliasRegistered.target_refs.find(r=>r.role==='primary').id;
   const partialIntent=id(),partialReceipt=await receipt(),request=sha(id());
   // Private technical fixture: historical identity has a root and file ID,
   // but no qualified parent/ancestor chain, so only root fallback is honest.
   await db.query(`insert into clued_private.resource_center_mutations_v1(id,user_id,profile_id,request_key,request_sha256,exact_request,authority_request,authority_result,authority_token_hash,profile_version,source_decision_id,state,version,expires_at,receipt_id)
    values($1,$2,$3,$4,$5,$6,$7,'{}',$5,1,$8,'started',2,clock_timestamp()-interval '3 hours',$9)`,[partialIntent,owner,partialProfile,id(),request,{mutation:{operation:'replace',target_kind:'file',destination_path:partialRoot+'/unqualified/deep.txt'}},{provider_identity:{root_folder_id:physicalRoot,root_parent_id:'my-drive',destination_file_id:partialFile,destination_parent_id:null}},decision,partialReceipt]);
   const closer=server.getPgClient(),contender=server.getPgClient();clients.push(closer,contender);await closer.connect();await contender.connect();
   const contenderPid=(await contender.query('select pg_backend_pid() pid')).rows[0].pid;let pending;
   await closer.query('begin');
   try{
    assert.equal((await closer.query('select clued_private.storage_conflict_close_candidate_v1($1) v',[partialIntent])).rows[0].v,'conflict');
    pending=contender.query('select clued_private.storage_conflict_assert_v1($1,$2,$3,$4)',[other,aliasProfile,{operation:'create',target_kind:'file',destination_path:aliasRoot+'/unrelated/deep/file.txt'},{destination_parent_id:'unrelated-parent-'+id()}]).then(()=>({allowed:true}),error=>({allowed:false,error}));
    let waiting=false;for(let attempt=0;attempt<100;attempt++){
     waiting=(await db.query('select exists(select 1 from pg_locks where pid=$1 and not granted) waiting',[contenderPid])).rows[0].waiting;
     if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(waiting,true,'a different Owner sharing the same physical root waits for I9 publication');await closer.query('commit');
   }catch(error){await closer.query('rollback');if(pending)await pending;throw error;}
   const blocked=await pending;assert.equal(blocked.allowed,false);assert.equal(blocked.error.message,'storage_object_under_review');
   const isolation=(await db.query('select scope_complete,state from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[partialIntent])).rows[0];assert.deepEqual(isolation,{scope_complete:false,state:'active'});
   const distinctProfile=(await db.query('select id from clued_private.resource_center_profiles_v1 where user_id=$1 and root_folder_id<>$2 limit 1',[other,physicalRoot])).rows[0].id;
   await db.query('select clued_private.storage_conflict_assert_v1($1,$2,$3,$4)',[other,distinctProfile,{operation:'create',target_kind:'file',destination_path:'/other-owner-unrelated/new.txt'},{destination_parent_id:'separate-parent-'+id()}]);
   await guard({operation:'create',target_kind:'file',destination_path:root+'/docs/still-unrelated.txt'},{destination_parent_id:parent});
   await assert.rejects(db.query('select clued_private.storage_conflict_assert_v1($1,$2,$3,$4)',[other,distinctProfile,{operation:'replace',target_kind:'file',destination_path:'/other-root/physical-alias.txt'},{destination_file_id:partialFile}]),/storage_object_under_review/,'the known physical file identity remains protected through a root alias');
  });
 }catch(error){console.error(error.message);if(error.cause)console.error(error.cause.message);throw error;
 }finally{
  for(const c of clients.reverse())await c.end().catch(()=>{});
  if(started)await Promise.race([stopCluster(server),new Promise(resolve=>setTimeout(resolve,5000))]);
  await removeTestDirectory(dir);
 }
});
