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
import {allowRawTestBindings} from './raw-binding-grants-fixture.mjs';
import {testStorageDestructive} from './resource-center-storage-destructive-db.fixture.mjs';
import {createResourceCenterCloudExecutor} from '../../../kernel/host/resource-center-cloud-executor.mjs';
const cloud=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const uuid=()=>crypto.randomUUID();
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));
 const p=s.address().port;await new Promise(r=>s.close(r));return p;}

test('durable execution entry: real coordinator jobs and closed nonjob boundary',{timeout:240000},async t=>{
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
  for(const name of (await fs.readdir(path.join(cloud,'supabase/migrations'))).filter(n=>n.endsWith('.sql')&&n!=='20261017205505_storage_durable_execution_entry_v1.sql').sort()){
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
  await testStorageDestructive(t,db,server,owner,decision,{gateway:true,only_extra:true,extra_cases:async ctx=>{
   const scalar=async(sql,args)=>(await db.query(sql,args)).rows[0].v;
   const legacyExecutor=f=>{let loaded;return createResourceCenterCloudExecutor({verified_result_mode:false,
    load_job:async ref=>{loaded=await ctx.cloud({action:'load',...ref});const descriptor={...loaded};delete descriptor.credential_envelope;delete descriptor.oauth_client_id;return descriptor;},
    get_credential:async expected=>({...expected,access_token:ctx.access_token,scope:'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly',expires_at_ms:Date.now()+3600000}),
    drive_fetch:f.storage.fetch,rpc:async input=>{const {connection_id,job_id,action,...body}=input;return ctx.cloud({connection_id,job_id,action,
     credential_version:loaded.credential_version,...(action==='finalize'?{finish:{action,...body}}:body)});}});};
   const capture=async f=>{
    const job=await ctx.submitJob(f.target,f.client,{operation:'create',target_kind:'file',destination_path:f.target.root+'/20_P_产品与体验/held-'+uuid()+'.txt',content:'synthetic held'});
    let begin;
    const result=await ctx.executor(f.target,f.storage,async input=>{if(input.action==='begin'){
     begin=structuredClone(input);throw Error('synthetic pause before durable begin');}}).run(job.reference);
    assert.ok(begin);assert.equal(result.side_effects,0);assert.equal(await ctx.journal(job),undefined);
    return {f,job,begin};
   };
   const write=(x,input)=>scalar(`select public.clued_resource_center_write_v1(clued_private.credential_internal_proof_v1(w.token_hash),$2::jsonb) v
    from clued_private.storage_jobs_v1 j join clued_private.resource_center_writer_bindings_v1 w on w.id=j.cloud_writer_binding_id
    where j.owner_id=$3 and j.job_id=$1`,[x.job.reference.job_id,JSON.stringify(input),owner]);
   const journalRequest=(x,input)=>scalar(`select $2::jsonb||jsonb_build_object('profile_id',a.profile_id,
    'source_decision_id',w.source_decision_id,'authority_token_hash',a.token_hash,'writer_binding_id',w.id) v
    from clued_private.storage_jobs_v1 j join clued_private.resource_center_writer_bindings_v1 w on w.id=j.cloud_writer_binding_id
    join clued_private.resource_center_bindings_v1 a on a.id=w.authority_binding_id where j.owner_id=$3 and j.job_id=$1`,
    [x.job.reference.job_id,JSON.stringify(input),owner]);
   const directBegin=x=>scalar(`select clued_private.storage_job_begin_v2($1,$2,clued_private.credential_internal_proof_v1(w.token_hash),$3::jsonb) v
    from clued_private.storage_jobs_v1 j join clued_private.resource_center_writer_bindings_v1 w on w.id=j.cloud_writer_binding_id
    where j.owner_id=$1 and j.job_id=$2`,[owner,x.job.reference.job_id,JSON.stringify(x.begin.prepare)]);
   const snapshot=()=>scalar(`select jsonb_build_object(
    'jobs',(select jsonb_agg(to_jsonb(x) order by job_id) from clued_private.storage_jobs_v1 x),
    'mutations',(select jsonb_agg(to_jsonb(x) order by id) from clued_private.resource_center_mutations_v1 x),
    'artifacts',(select jsonb_agg(to_jsonb(x) order by id) from clued_private.resource_center_artifacts_v1 x),
    'receipts',(select count(*) from public.clued_audit_receipts),
    'permits',(select coalesce(jsonb_agg(to_jsonb(x) order by job_id),'[]'::jsonb) from clued_private.storage_execution_entry_permits_v1 x)) v`);
   // Construct genuine unlinked nonjob history with the old, still-installed
   // writer/journal contract. No trigger is disabled and no outcome is seeded.
   const history=[];
   for(const state of ['prepared','started']){
    const x=await capture(await ctx.setup()),prepare={...x.begin.prepare,request_key:'nonjob-history:'+uuid(),idempotency_key:'nonjob-history:'+uuid()};
    const prepared=await write(x,prepare);assert.equal(prepared.state,'prepared');assert.equal(prepared.status,'committed');
    let result=prepared;
    if(state==='started')result=await write(x,{action:'start',intent_id:prepared.intent_id,base_version:prepared.version,
     request_sha256:prepared.request_sha256,idempotency_key:'nonjob-history:'+uuid()});
    assert.equal(result.state,state);const row=await scalar('select to_jsonb(m) v from clued_private.resource_center_mutations_v1 m where id=$1',[result.intent_id]);
    assert.equal(await scalar('select count(*)::int v from clued_private.storage_jobs_v1 where intent_id=$1',[row.id]),0);
    const receipt=await scalar('select to_jsonb(r) v from public.clued_audit_receipts r where id=$1',[row.receipt_id]);
    history.push({...x,row,receipt});
   }
   const callerBoundary=()=>db.query(`select p.oid::text id,p.oid::regprocedure::text signature,p.proacl,p.proconfig,p.prosecdef,pg_get_userbyid(p.proowner) owner
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'clued_storage_%'
     or p.proname like 'clued_resource_center_%') order by p.oid`).then(r=>r.rows);
   const beforeCallers=await callerBoundary();
   const wrapperBefore=await scalar("select pg_get_functiondef('clued_private.ii_priv_storage_cloud_worker_v2(text,jsonb)'::regprocedure) v");
   await db.query(await fs.readFile(path.join(cloud,'supabase/migrations/20261017205505_storage_durable_execution_entry_v1.sql'),'utf8'));
   await t.test('actual upgrade preserves public caller identities and the V2 registration wrapper',async()=>{
    assert.deepEqual(await callerBoundary(),beforeCallers);
    assert.equal(await scalar("select pg_get_functiondef('clued_private.ii_priv_storage_cloud_worker_v2(text,jsonb)'::regprocedure) v"),wrapperBefore);
    for(const x of history){
     assert.deepEqual(await scalar('select to_jsonb(m) v from clued_private.resource_center_mutations_v1 m where id=$1',[x.row.id]),x.row);
     assert.deepEqual(await scalar('select to_jsonb(r) v from public.clued_audit_receipts r where id=$1',[x.receipt.id]),x.receipt);
    }
   });
   for(const mode of ['account_policy','legacy'])await t.test(mode+' genuine normal create finalizes through the private entry and leaves no permit',async()=>{
    const f=await (mode==='legacy'?ctx.setupLegacy():ctx.setup());
    let artifact;
    if(mode==='legacy'){
     const job=await ctx.submitJob(f.target,f.client,{operation:'create',target_kind:'file',destination_path:f.target.root+'/20_P_产品与体验/durable-'+uuid()+'.txt',content:'synthetic durable'});
     assert.equal((await legacyExecutor(f).run(job.reference)).status,'committed');artifact=await ctx.artifact(f.target,job.mutation.destination_path);
    }else artifact=await ctx.createFile(f.target,f.client,f.storage,'durable-'+uuid()+'.txt');
    assert.equal(artifact.target_kind,'file');assert.equal(artifact.state,'active');
    assert.equal(await scalar('select count(*)::int v from clued_private.storage_execution_entry_permits_v1'),0);
   });
   await t.test('valid old writer, real job-shaped key and direct service journal cannot prepare outside the coordinator',async()=>{
    const x=await capture(await ctx.setup()),request=await journalRequest(x,x.begin.prepare),before=await snapshot();
    assert.deepEqual(await write(x,x.begin.prepare),{status:'denied'});
    await assert.rejects(db.query('select public.clued_resource_center_mutation_journal_v1($1,$2::jsonb)',[owner,JSON.stringify(request)]),/storage_durable_job_required/);
    await assert.rejects(directBegin(x),/storage_durable_job_required/);
    await db.query('begin');try{
     await db.query("select set_config('clued.storage_execution_entry_v1',$1,true),set_config('clued.storage_job_id',$2,true)",[JSON.stringify({allowed:true,job_id:x.job.reference.job_id}),x.job.reference.job_id]);
     assert.deepEqual(await write(x,x.begin.prepare),{status:'denied'});
    }finally{await db.query('rollback');}
    assert.deepEqual(await snapshot(),before);
   });
   await t.test('old prepared work remains inspectable and cancellable but receives no new start permission',async()=>{
    const x=history.find(x=>x.row.state==='prepared'),request={intent_id:x.row.id,request_sha256:x.row.request_sha256};
    const before=await snapshot();assert.equal((await write(x,{action:'inspect',...request})).status,'prepared');
    assert.deepEqual(await write(x,{action:'start',...request,base_version:x.row.version,idempotency_key:'retired-start:'+uuid()}),{status:'denied'});
    await assert.rejects(db.query("update clued_private.resource_center_mutations_v1 set state='started',version=version+1 where id=$1",[x.row.id]),/storage_durable_job_required/);
    assert.deepEqual(await snapshot(),before);
    const cancelled=await write(x,{action:'cancel',...request,base_version:x.row.version,idempotency_key:'retired-cancel:'+uuid()});
    assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.execution_permitted,false);
    assert.deepEqual(await scalar('select to_jsonb(r) v from public.clued_audit_receipts r where id=$1',[x.receipt.id]),x.receipt);
   });
   await t.test('historical started inspection and uncertain marking retain the old Receipt and never create an execution permit',async()=>{
    const x=history.find(x=>x.row.state==='started'),request={intent_id:x.row.id,request_sha256:x.row.request_sha256};
    assert.equal((await write(x,{action:'inspect',...request})).status,'started');
    const uncertain=await write(x,{action:'uncertain',...request,base_version:x.row.version,idempotency_key:'history-uncertain:'+uuid()});
    assert.equal(uncertain.state,'uncertain');assert.equal(uncertain.execution_permitted,false);
    assert.equal(await scalar('select count(*)::int v from clued_private.storage_execution_entry_permits_v1'),0);
    assert.deepEqual(await scalar('select to_jsonb(r) v from public.clued_audit_receipts r where id=$1',[x.receipt.id]),x.receipt);
   });
   const guarded=await capture(await ctx.setup());
   for(const [name,sql] of [
    ['prepare','create trigger synthetic_entry_fault before insert on clued_private.resource_center_mutations_v1 for each row execute function public.synthetic_entry_fault()'],
    ['start',"create trigger synthetic_entry_fault before update on clued_private.resource_center_mutations_v1 for each row when (new.state='started' and old.state='prepared') execute function public.synthetic_entry_fault()"],
    ['job link',"create trigger synthetic_entry_fault before update on clued_private.storage_jobs_v1 for each row when (new.intent_id is not null and old.intent_id is null) execute function public.synthetic_entry_fault()"],
   ])await t.test(name+' failure rolls back the whole actual coordinator transaction and permit',async()=>{
    await db.query("create function public.synthetic_entry_fault() returns trigger language plpgsql as $$begin raise exception 'synthetic_entry_fault';end$$");
    const table=name==='job link'?'clued_private.storage_jobs_v1':'clued_private.resource_center_mutations_v1';
    try{await db.query(sql);const before=await snapshot();await assert.rejects(ctx.cloud(guarded.begin));assert.deepEqual(await snapshot(),before);}
    finally{await db.query('drop trigger if exists synthetic_entry_fault on '+table);await db.query('drop function public.synthetic_entry_fault()');}
   });
   await t.test('an admitted start replay returns only stored state and cannot recreate a permit or intent',async()=>{
    const x=await capture(await ctx.setup());const first=await ctx.cloud(x.begin);assert.equal(first.state,'started');assert.equal(first.execution_permitted,true);
    const before=await snapshot(),replay=await ctx.cloud(x.begin);assert.equal(replay.replayed,true);assert.notEqual(replay.execution_permitted,true);
    assert.deepEqual(await snapshot(),before);assert.equal(await scalar('select count(*)::int v from clued_private.storage_execution_entry_permits_v1'),0);
   });
   for(const [name,patch] of [
    ['another transaction',"transaction_id=transaction_id+1"],['another Owner',"owner_id=gen_random_uuid()"],
    ['another job',"job_id=gen_random_uuid()"],['another connection',"connection_id=gen_random_uuid()"],
    ['another profile',"profile_id=gen_random_uuid()"],['another physical root',"root_folder_id='synthetic-other-root'"],
    ['another writer',"writer_binding_id=gen_random_uuid()"],['another original digest',"request_digest=repeat('0',64)"],
    ['another prepare hash',"prepare_hash=repeat('0',64)"],['an already armed phase',"phase='prepare'"],
   ])await t.test(name+' cannot advance even a trusted-owner adversarial permit fixture',async()=>{
    const x=await capture(await ctx.setup());await db.query('begin');try{
     // Only the disposable database owner can seed this private table. This
     // tests stage binding; transport principals cannot issue even this row.
     await db.query(`insert into clued_private.storage_execution_entry_permits_v1(transaction_id,owner_id,connection_id,job_id,
      profile_id,root_folder_id,writer_binding_id,request_digest,prepare_hash,phase)
      select txid_current(),j.owner_id,j.connection_id,j.job_id,p.id,p.root_folder_id,j.cloud_writer_binding_id,j.request_digest,
       clued_private.m1_sha256($2::jsonb),'coordinator' from clued_private.storage_jobs_v1 j
       join clued_private.storage_connections_v1 c on c.id=j.connection_id join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id
       where j.owner_id=$3 and j.job_id=$1`,[x.job.reference.job_id,JSON.stringify(x.begin.prepare),owner]);
     await db.query('update clued_private.storage_execution_entry_permits_v1 set '+patch);
     const before=await snapshot();await db.query('savepoint bad_entry');
     await assert.rejects(directBegin(x),/storage_durable_job_required/);await db.query('rollback to savepoint bad_entry');
     assert.deepEqual(await snapshot(),before);
    }finally{await db.query('rollback');}
   });
   await t.test('a final currentness rejection rolls back start, job link and the binding revocation injected before that check',async()=>{
    const x=await capture(await ctx.setup());
    await db.query(`create function public.synthetic_entry_revoke() returns trigger language plpgsql as $$begin
     update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=new.binding_id;return new;end$$;
     create trigger synthetic_entry_revoke after update on clued_private.storage_jobs_v1 for each row
      when (new.intent_id is not null and old.intent_id is null) execute function public.synthetic_entry_revoke()`);
    try{
     const before=await snapshot();await assert.rejects(ctx.cloud(x.begin));assert.deepEqual(await snapshot(),before);
     assert.equal(await scalar('select revoked_at is null v from public.clued_agent_bindings where id=$1',[x.f.client.id]),true);
    }finally{await db.query('drop trigger synthetic_entry_revoke on clued_private.storage_jobs_v1;drop function public.synthetic_entry_revoke()');}
   });
   await t.test('private permit table and every stage helper remain closed to every transport role',async()=>{
    const signatures=['storage_execution_entry_arm_v1(uuid,uuid,text,jsonb)','storage_execution_entry_check_v1(uuid,jsonb)',
     'storage_execution_entry_guard_v1()','storage_execution_entry_start_v1(uuid,uuid,jsonb)','storage_execution_entry_complete_v1(uuid,uuid)'];
    for(const role of ['anon','authenticated','service_role','clued_worker_gateway']){
     assert.equal(await scalar("select has_table_privilege($1,'clued_private.storage_execution_entry_permits_v1','select,insert,update,delete') v",[role]),false);
     for(const sig of signatures)assert.equal(await scalar("select has_function_privilege($1,$2,'execute') v",[role,'clued_private.'+sig]),false);
    }
    assert.equal(await scalar("select relrowsecurity v from pg_class where oid='clued_private.storage_execution_entry_permits_v1'::regclass"),true);
   });
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
