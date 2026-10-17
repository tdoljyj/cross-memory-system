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
import {build,stop} from 'esbuild';
import EmbeddedPostgres from 'embedded-postgres';
import {createStorageCredentialVault} from '../worker/storage-credential-vault.ts';
import {scopeString} from '../worker/storage-google-scopes.ts';
import {allowRawTestBindings} from './raw-binding-grants-fixture.mjs';
import {testStorageDestructive} from './resource-center-storage-destructive-db.fixture.mjs';
import {createGoogleDriveMetadataApi} from '../../../kernel/host/resource-center-google-drive-metadata.mjs';
import {createGoogleDriveLocationRecovery} from '../../../kernel/host/resource-center-google-drive-location-recovery.mjs';
import {googleDriveAccessDigest,googleDriveSharingDigest} from '../../../kernel/host/resource-center-google-drive-sharing.mjs';
const cloud=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const workerBundle=await build({entryPoints:[path.join(cloud,'worker/storage-location-recovery.ts')],bundle:true,platform:'node',format:'esm',write:false});
const {createStorageCurrentLocationRecovery}=await import('data:text/javascript;base64,'+Buffer.from(workerBundle.outputFiles[0].text).toString('base64'));stop();
const uuid=()=>crypto.randomUUID();
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));
 const p=s.address().port;await new Promise(r=>s.close(r));return p;}

test('current location: real Native exact-plan atomic registration and lost-reply recovery',{timeout:240000},async t=>{
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

   const prepare=async(initial='active',moved=true,{oldParentInactive=false,inflightCurrentParent=false,inflightNewSlot=false,
    captureOriginalProof=false,recordOriginalProof=false,skipPlan=false}={})=>{
    const f=await ctx.setup();
    const parent=await ctx.directoryIn(f.target,f.storage,'new-parent-'+uuid());
    const oldParent=oldParentInactive?await ctx.directoryIn(f.target,f.storage,'old-parent-'+uuid()):null;
    let source=await ctx.directoryIn(f.target,f.storage,'old-topic-'+uuid(),oldParent?.path,oldParent?.provider_file_id);
    if(initial==='trashed')source=await ctx.trashed(f.target,f.client,f.storage,source);
    const job=await ctx.submitJob(f.target,f.client,initial==='active'?ctx.trash(source):ctx.untrash(source));
    let withheldProof;
    const engine=ctx.executor(f.target,f.storage,async input=>{
     if(input.action==='verified_record'&&captureOriginalProof){withheldProof=structuredClone(input);throw Error('synthetic delayed verified record');}
     if(input.action==='provider_attempt'&&!captureOriginalProof){await ctx.cloud(input);throw Error('synthetic lost original acknowledgement');}
    });
    assert.equal((await engine.run(job.reference)).status,'unreconciled');
    if(recordOriginalProof){assert.ok(withheldProof);assert.equal((await ctx.cloud(withheldProof)).status,'verified');}
    const original=await ctx.journal(job);
    await db.query("update public.clued_audit_receipts set created_at=clock_timestamp()-interval '3 hours' where id=$1",[original.provider_attempt_receipt_id]);
    await db.query("update clued_private.resource_center_mutations_v1 set expires_at=clock_timestamp()-interval '3 hours' where id=$1",[original.id]);
    assert.equal(await scalar('select clued_private.storage_conflict_close_v1($1) v',[original.id]),recordOriginalProof?'committed':'conflict');
    const issuer=await scalar('select issuer_hash v from clued_private.storage_oauth_apps_v1 where oauth_client_id=$1',[ctx.oauth_client_id]);
    const vaultConfig={current_key_id:'synthetic',keys:{synthetic:crypto.randomBytes(32).toString('base64url')}};
    const vault=await createStorageCredentialVault(vaultConfig);
    const envelope=await vault.seal(JSON.stringify({token_type:'Bearer',access_token:ctx.access_token,scope:scopeString('full'),expires_at_ms:Date.now()+3600000}),
     {owner_id:owner,connection_id:f.target.connection,provider:'google-drive',provider_subject:ctx.provider_subject,oauth_client_id:ctx.oauth_client_id,credential_version:1});
    await db.query("update clued_private.storage_connections_v1 set credential_envelope=$2,provider_scope_profile='full' where id=$1",[f.target.connection,JSON.stringify(envelope)]);
    const policy=(await native.query("select public.clued_storage_write_access_v1($1::jsonb) v",[JSON.stringify({action:'status',connection_id:f.target.connection})])).rows[0].v;
    const grant=(await native.query("select public.clued_storage_write_access_v1($1::jsonb) v",[JSON.stringify({action:'set_classes',connection_id:f.target.connection,
     classes:['modify','destructive'],base_generation:policy.policy_generation,disclosure_version:'clued.storage-modify-disclosure/1',idempotency_key:uuid()})])).rows[0].v;
    assert.equal(grant.status,'committed');
    for(const file of f.storage.files.values()){
     Object.assign(file,{shared:false,permissionIds:['fixture-owner']});
     file.capabilities={...file.capabilities,canShare:true,canListChildren:true};
    }
    let inflight;
    if(inflightCurrentParent){
     // An already-qualified parent is the actual remote target of another
     // legitimate original job. Stop after recording its real provider attempt
     // while the parent is still empty, BEFORE the external target moves here.
     const parentFile=f.storage.files.get(parent.provider_file_id);
     await db.query('update clued_private.resource_center_artifacts_v1 set provider_access_digest=$2,provider_sharing_digest=$3 where id=$1',
      [parent.id,googleDriveAccessDigest(parentFile),googleDriveSharingDigest(parentFile)]);
     inflight=await ctx.submitJob(f.target,f.client,ctx.trash(parent));
     const parentExecutor=ctx.executor(f.target,f.storage,async input=>{if(input.action==='provider_attempt'){
      await ctx.cloud(input);throw Error('synthetic delayed parent effect');}});
     assert.equal((await parentExecutor.run(inflight.reference)).status,'unreconciled');
     assert.equal((await ctx.journal(inflight)).state,'started');
    }
    if(inflightNewSlot){
     inflight=await ctx.submitJob(f.target,f.client,{operation:'create',target_kind:'file',
      destination_path:parent.path+'/'+path.posix.basename(source.path),content:'synthetic delayed create'});
     const slotExecutor=ctx.executor(f.target,f.storage,async input=>{if(input.action==='provider_attempt'){
      await ctx.cloud(input);throw Error('synthetic delayed same-slot effect');}});
     assert.equal((await slotExecutor.run(inflight.reference)).status,'unreconciled');
     assert.equal((await ctx.journal(inflight)).state,'started');
    }
    const target=f.storage.files.get(source.provider_file_id);
    target.version='30';target.trashed=false;target.explicitlyTrashed=false;
    if(moved)target.parents=[parent.provider_file_id];else target.name='renamed-'+uuid();
    if(oldParentInactive){
     // Adversarial historical registration after an external move. The old
     // parent is no longer current; it is not revived by this qualification.
     await db.query('begin');try{
      await db.query('set local session_replication_role=replica');
      await db.query("update clued_private.resource_center_artifacts_v1 set state='trashed' where id=$1",[oldParent.id]);
      await db.query('commit');
     }catch(error){await db.query('rollback');throw error;}
     f.storage.files.get(oldParent.provider_file_id).trashed=true;
    }
    const rpc=input=>scalar('select public.clued_storage_scheduled_recovery_v2($1,$2::jsonb) v',[issuer,JSON.stringify(input)]);
    if(skipPlan)return {f,parent,source,job,original,issuer,target,rpc,withheldProof};
    const load=await rpc({...job.reference,action:'registration_location_load'});
    const metadata=createGoogleDriveMetadataApi({registration_details:true,
     get_credential:async()=>({access_token:ctx.access_token,scope:scopeString('full')}),fetch:f.storage.fetch});
    const observer=createGoogleDriveLocationRecovery({metadata});
    const hint=await observer.discover(load.registration_seed);
    const plan=await rpc({...job.reference,action:'registration_location_plan',base_version:load.base_version,
     source_receipt_id:load.source_receipt_id,registration_authority:load.registration_authority,
     registration_seed:load.registration_seed,location_hint:hint});
    return {f,parent,oldParent,inflight,source,job,original,issuer,vaultConfig,target,load,hint,plan,observer,rpc,withheldProof};
   };
   const commit=async x=>({...x.job.reference,action:'registration_location_commit',base_version:x.plan.base_version,
    source_receipt_id:x.plan.source_receipt_id,registration_authority:x.plan.registration_authority,
    registration_plan:x.plan.registration_plan,...await x.observer.observe(x.plan.registration_plan)});
   const snapshot=()=>scalar(`select jsonb_build_object(
    'artifacts',(select jsonb_agg(to_jsonb(x) order by id) from clued_private.resource_center_artifacts_v1 x),
    'mutations',(select jsonb_agg(to_jsonb(x) order by id) from clued_private.resource_center_mutations_v1 x),
    'isolations',(select jsonb_agg(to_jsonb(x) order by intent_id) from clued_private.storage_conflict_isolations_v1 x),
    'results',(select jsonb_agg(to_jsonb(x) order by intent_id) from clued_private.storage_current_registration_results_v1 x),
    'permits',(select count(*) from clued_private.storage_directory_location_permits_v4),
    'exit_permits',(select count(*) from clued_private.storage_conflict_exit_permits_v1),
    'receipts',(select count(*) from public.clued_audit_receipts),
    'events',(select count(*) from public.clued_context_events)) v`);
   const baselineLockTimeout=await scalar("select current_setting('lock_timeout') v");
   await t.test('an actual verified_record recorded before expiry keeps typed-result priority over location recovery',async()=>{
    const x=await prepare('active',true,{captureOriginalProof:true,recordOriginalProof:true,skipPlan:true});
    assert.ok(x.original.verified_result_v2);const before=await snapshot();
    await assert.rejects(x.rpc({...x.job.reference,action:'registration_location_load'}),/storage_current_(?:location|registration)/);
    assert.deepEqual(await snapshot(),before);
   });
   await t.test('a real delayed verified_record after independent location settlement cannot overwrite current registration',async()=>{
    const x=await prepare('active',true,{captureOriginalProof:true});assert.ok(x.withheldProof);
    const before=await snapshot();
    await assert.rejects(ctx.cloud(x.withheldProof),error=>error.code==='42501'&&error.message==='storage_verified_denied');
    assert.deepEqual(await snapshot(),before);
    const result=await x.rpc(await commit(x));assert.equal(result.status,'resolved');
    const artifact=await ctx.artifactById(x.source.id),journal=await ctx.journal(x.job);
    const isolation=await scalar('select to_jsonb(q) v from clued_private.storage_conflict_isolations_v1 q where intent_id=$1',[x.original.id]);
    await assert.rejects(ctx.cloud(x.withheldProof),error=>error.code==='40001'&&error.message==='storage_verified_conflict');
    assert.deepEqual(await ctx.artifactById(x.source.id),artifact);
    assert.deepEqual(await ctx.journal(x.job),journal);
    assert.deepEqual(await scalar('select to_jsonb(q) v from clued_private.storage_conflict_isolations_v1 q where intent_id=$1',[x.original.id]),isolation);
    assert.deepEqual(await x.rpc({...x.job.reference,action:'registration_location_load'}),result);
   });
   for(const initial of ['active','trashed'])for(const moved of [false,true])
    await t.test(initial+' original registration: current '+(moved?'parent move':'rename')+' is a fresh bounded plan',async()=>{
     const x=await prepare(initial,moved),before=await ctx.artifactById(x.source.id),journal=await ctx.journal(x.job);
     assert.equal(x.load.registration_seed.target.artifact_id,x.source.id);
     assert.equal(x.load.registration_seed.target.registered_state,initial);
     assert.equal(x.plan.registration_plan.target.registered_path,x.source.path);
     assert.equal(x.plan.registration_plan.target.provider_file_id,x.source.provider_file_id);
     assert.notEqual(x.plan.registration_plan.target.path,x.source.path);
     assert.equal(x.plan.registration_authority.actor_kind,'storage_program');
     assert.equal(x.plan.execution_permitted,false);
     const observations=await x.observer.observe(x.plan.registration_plan);
     assert.equal(observations.second_observation.target.current_state,'active');
     assert.equal(observations.second_observation.target.provider_file_version,'30');
     assert.deepEqual(await ctx.artifactById(x.source.id),before);
     assert.deepEqual(await ctx.journal(x.job),journal);
     const input={...x.job.reference,action:'registration_location_commit',base_version:x.plan.base_version,
      source_receipt_id:x.plan.source_receipt_id,registration_authority:x.plan.registration_authority,
      registration_plan:x.plan.registration_plan,...observations};
     const result=await x.rpc(input),after=await ctx.artifactById(x.source.id),closed=await ctx.journal(x.job);
     assert.equal(result.status,'resolved');assert.equal(result.execution_permitted,false);
     assert.equal(result.current_path,x.plan.registration_plan.target.path);
     assert.equal(result.current_artifact_state,'active');
     assert.equal(after.path,result.current_path);assert.equal(after.state,'active');
     assert.equal(after.provider_file_id,before.provider_file_id);assert.equal(Number(after.version),Number(before.version)+1);
     assert.equal(closed.state,'conflict');assert.equal(closed.receipt_id,journal.receipt_id);
     assert.deepEqual(closed.provider_attempt,journal.provider_attempt);
     assert.deepEqual(closed.verified_result_v2,journal.verified_result_v2);
     assert.equal(Number(closed.version),Number(journal.version)+1);
     assert.deepEqual(await x.rpc(input),result);
     assert.deepEqual(await x.rpc({...x.job.reference,action:'registration_location_load'}),result);
     assert.deepEqual(await ctx.artifactById(x.source.id),after);
     assert.equal(await scalar("select state v from clued_private.storage_conflict_isolations_v1 where intent_id=$1",[x.original.id]),'resolved');
     assert.equal(await scalar("select status='committed' and response_hash=clued_private.m1_sha256(canonical_result) v from public.clued_audit_receipts where id=$1",[result.receipt_id]),true);
     const ownerStatus=await scalar('select clued_private.storage_conflict_public_status_v1(j) v from clued_private.storage_jobs_v1 j where connection_id=$1 and job_id=$2',
      [x.job.reference.connection_id,x.job.reference.job_id]);assert.equal(ownerStatus.current_path,result.current_path);
     assert.equal(x.f.storage.deletes,0);
    });
   await t.test('a new parent in another root cannot be supplied as an authorization hint',async()=>{
    const x=await prepare(),other=await ctx.setup();
    await assert.rejects(x.rpc({...x.job.reference,action:'registration_location_plan',base_version:x.load.base_version,
     source_receipt_id:x.load.source_receipt_id,registration_authority:x.load.registration_authority,
     registration_seed:x.load.registration_seed,location_hint:{...x.hint,parent_id:other.target.trackId}}),/storage_current_location_unavailable/);
   });
   await t.test('a current new parent qualifies without reviving an inactive old parent',async()=>{
    const x=await prepare('trashed',true,{oldParentInactive:true}),old=await ctx.artifactById(x.oldParent.id);
    const r=await x.rpc(await commit(x));assert.equal(r.status,'resolved');
    assert.equal(r.current_path,x.parent.path+'/'+x.target.name);
    assert.deepEqual(await ctx.artifactById(x.oldParent.id),old);
   });
   await t.test('the actual Worker adapter uses real Native program authority, sealed full credential and the public issuer-proof route',async()=>{
    const y=await prepare('trashed',true,{oldParentInactive:true});
    const priorPatches=y.f.storage.patches,files=structuredClone([...y.f.storage.files]);
    const adapter=await createStorageCurrentLocationRecovery({client_id:ctx.oauth_client_id,vault:y.vaultConfig,rpc:y.rpc,fetch:y.f.storage.fetch});
    const r=await adapter.run(y.job.reference,y.original.id);assert.equal(r.status,'resolved');
    assert.equal(r.current_path,y.plan.registration_plan.target.path);assert.equal(y.f.storage.patches,priorPatches);
    assert.deepEqual([...y.f.storage.files],files);
    assert.deepEqual(await adapter.run(y.job.reference,y.original.id),r);
   });
   await t.test('a genuinely started effect on an already-qualified current parent prevents registration at its soon-to-change location',async()=>{
    const y=await prepare('active',true,{inflightCurrentParent:true});
    assert.ok((await ctx.artifactById(y.parent.id)).provider_access_digest);
    const before=await snapshot(),r=await y.rpc(await commit(y));
    assert.equal(r.status,'pending');assert.equal(r.reason_code,'REGISTRATION_LOCATION_BUSY');
    assert.deepEqual(await snapshot(),before);assert.equal(y.f.storage.patches,0);
   });
   await t.test('a different generated-ID started create protects its physical name slot across a historical profile alias',async()=>{
    const y=await prepare('active',true,{inflightNewSlot:true}),other=await ctx.setup();
    const original=await ctx.journal(y.inflight);assert.notEqual(original.provider_attempt.provider_file_id,y.source.provider_file_id);
    await db.query('begin');try{
     // Preserve the real started request/attempt and physical slot. Model a
     // historical cross-profile alias instead of relying on equal local paths.
     await db.query('set local session_replication_role=replica');
     await db.query('update clued_private.resource_center_mutations_v1 set profile_id=$2 where id=$1',[original.id,other.target.profile]);
     await db.query('set local session_replication_role=origin');const before=await snapshot();
     const r=await y.rpc(await commit(y));assert.equal(r.status,'pending');assert.deepEqual(await snapshot(),before);
    }finally{await db.query('rollback');}
   });
   const x=await prepare(),originalInput=await commit(x);
   const refuse=async(input,pattern=/storage_current_(?:location|registration)/)=>{
    let response;
    try{response=await x.rpc(input);}catch(error){assert.match(error.message,pattern);return;}
    assert.equal(response.status,'pending');assert.equal(response.execution_permitted,false);
    assert.equal(response.automatic_recovery,'pending');assert.equal(response.reason_code,'REGISTRATION_LOCATION_BUSY');
   };
   const rejectSeed=async seed=>{
    await db.query('begin');try{
     await seed();const before=await snapshot();await db.query('savepoint recover_attempt');
     await refuse(originalInput,/storage_current_(?:location|registration)|storage_object_under_review|synthetic_location_receipt_failure/);
     await db.query('rollback to savepoint recover_attempt');assert.deepEqual(await snapshot(),before);
    }finally{await db.query('rollback');}
   };
   for(const [name,change] of [
    ['new path spoof',v=>v.registration_plan.target.path+='/invented'],
    ['old path spoof',v=>v.registration_plan.target.registered_path+='/invented'],
    ['old parent spoof',v=>v.registration_plan.target.registered_parent_id='invented-parent'],
    ['target identity spoof',v=>v.registration_plan.target.provider_file_id='invented-target'],
    ['new parent spoof',v=>v.registration_plan.target.parent_id='invented-parent'],
    ['original state omitted',v=>delete v.second_observation.target.registered_state],
    ['still trashed target',v=>{v.second_observation.target.current_state='trashed';v.second_observation.target.empty=null;}],
    ['target changed between reads',v=>v.second_observation.target.provider_file_version='31'],
    ['ACL forged',v=>v.second_observation.target.access_digest='c'.repeat(64)],
    ['parent ACL forged',v=>v.first_observation.parents[0].sharing_digest='c'.repeat(64)],
    ['expired observations',v=>{v.first_observation.observed_at=v.second_observation.observed_at=new Date(Date.now()-60000).toISOString();}],
    ['wrong old Receipt',v=>v.source_receipt_id=uuid()],
    ['wrong CAS',v=>v.base_version++],
    ['caller confirmation',v=>v.confirmed=true],
   ])await t.test(name+' cannot partially change registration',async()=>{
    const input=structuredClone(originalInput);change(input);const before=await snapshot();
    await refuse(input);assert.deepEqual(await snapshot(),before);
   });
   await t.test('final Receipt failure rolls back path, state, journal, isolation, Event, permits and result',async()=>{
    await rejectSeed(()=>db.query(`create function public.synthetic_location_receipt_failure() returns trigger language plpgsql as $$begin
     if new.operation='storage_current_registration_reconcile' and new.status='committed' then raise exception 'synthetic_location_receipt_failure';end if;return new;end$$;
     create trigger synthetic_location_receipt_failure before update on public.clued_audit_receipts for each row execute function public.synthetic_location_receipt_failure()`));
   });
   await t.test('two connections: physical target contention rolls back all qualification and permits a fresh retry',async()=>{
    const blocker=server.getPgClient();await blocker.connect();const before=await snapshot();
    try{
     await blocker.query('begin');await blocker.query("select pg_advisory_xact_lock(hashtextextended('storage-object:'||$1,0))",[x.source.provider_file_id]);
     await db.query("set statement_timeout='1500ms'");const r=await x.rpc(originalInput);
     assert.equal(r.status,'pending');assert.deepEqual(await snapshot(),before);
     assert.equal(await scalar("select current_setting('lock_timeout') v"),baselineLockTimeout);
    }finally{await db.query('set statement_timeout=0');await blocker.query('rollback');await blocker.end();}
   });
   await t.test('two connections: profile-first admin inversion is bounded and releases the root lock',async()=>{
    const blocker=server.getPgClient();await blocker.connect();const before=await snapshot();
    try{
     await blocker.query('begin');await blocker.query('select id from clued_private.resource_center_profiles_v1 where id=$1 for update',[x.f.target.profile]);
     await db.query("set statement_timeout='1500ms'");const r=await x.rpc(originalInput);
     assert.equal(r.status,'pending');assert.deepEqual(await snapshot(),before);
     assert.equal((await blocker.query("select pg_try_advisory_xact_lock(hashtextextended('storage-object:'||$1,0)) v",[x.f.target.rootId])).rows[0].v,true);
     assert.equal(await scalar("select current_setting('lock_timeout') v"),baselineLockTimeout);
    }finally{await db.query('set statement_timeout=0');await blocker.query('rollback');await blocker.end();}
   });
   await t.test('two connections: profile root-parent alias cannot appear during recovery or qualify after committing first',async()=>{
    const other=await ctx.setup(),blocker=server.getPgClient();await blocker.connect();
    try{
     await db.query('begin');const r=await x.rpc(await commit(x));assert.equal(r.status,'resolved');
     await assert.rejects(blocker.query('update clued_private.resource_center_profiles_v1 set root_parent_id=$2 where id=$1',
      [other.target.profile,x.source.provider_file_id]),/storage_current_location_busy/);
     await db.query('rollback');
     await blocker.query('begin');await blocker.query('update clued_private.resource_center_profiles_v1 set root_parent_id=$2 where id=$1',
      [other.target.profile,x.source.provider_file_id]);
     assert.equal((await x.rpc(await commit(x))).status,'pending');
     await blocker.query('commit');const before=await snapshot();
     await assert.rejects(x.rpc(await commit(x)),/storage_current_location_alias/);assert.deepEqual(await snapshot(),before);
    }finally{await db.query('rollback');await blocker.query('rollback');
     await blocker.query('update clued_private.resource_center_profiles_v1 set root_parent_id=$2 where id=$1',[other.target.profile,other.target.parentId]);await blocker.end();}
   });
   await t.test('two connections: a newly inserted profile and same-ID lifecycle revival use the target physical lock',async()=>{
    const y=await prepare(),other=await ctx.setup(),blocker=server.getPgClient();await blocker.connect();const alias=uuid();
    const insert=`insert into clued_private.resource_center_profiles_v1 select (jsonb_populate_record(null::clued_private.resource_center_profiles_v1,
     to_jsonb(p)||jsonb_build_object('id',$2::text,'root_folder_id','alias-root-'||$2::text,
      'managed_root',$3::text,'root_parent_id',$4::text,'state',$5::text))).*
     from clued_private.resource_center_profiles_v1 p where id=$1`;
    const params=[other.target.profile,alias,other.target.root+'/alias-'+uuid(),y.source.provider_file_id,'active'];
    try{
     await db.query('begin');assert.equal((await y.rpc(await commit(y))).status,'resolved');
     await assert.rejects(blocker.query(insert,params),/storage_current_location_busy/);await db.query('rollback');
     await blocker.query('begin');await blocker.query(insert,params);
     assert.equal((await y.rpc(await commit(y))).status,'pending');await blocker.query('rollback');
     await blocker.query(insert,[...params.slice(0,4),'revoked']);
     await db.query('begin');assert.equal((await y.rpc(await commit(y))).status,'resolved');
     await assert.rejects(blocker.query("update clued_private.resource_center_profiles_v1 set state='active' where id=$1",[alias]),/storage_current_location_busy/);
     await db.query('rollback');await blocker.query("update clued_private.resource_center_profiles_v1 set state='active' where id=$1",[alias]);
     const before=await snapshot();await assert.rejects(y.rpc(await commit(y)),/storage_current_location_alias/);assert.deepEqual(await snapshot(),before);
    }finally{await db.query('rollback');await blocker.query('rollback');await blocker.query('delete from clued_private.resource_center_profiles_v1 where id=$1',[alias]);await blocker.end();}
   });
   await t.test('two connections: installed Artifact INSERT guards serialize a new-path child in both commit orders',async()=>{
    const y=await prepare(),blocker=server.getPgClient();await blocker.connect();const child=uuid();
    const insert=`insert into clued_private.resource_center_artifacts_v1 select (jsonb_populate_record(null::clued_private.resource_center_artifacts_v1,
     to_jsonb(a)||jsonb_build_object('id',$2::text,'path',$3::text,'provider_file_id',$4::text,'target_kind','file'))).*
     from clued_private.resource_center_artifacts_v1 a where id=$1`;
    const args=[y.parent.id,child,y.plan.registration_plan.target.path+'/child','insert-child-'+uuid()];
    try{
     // Real relation INSERT with all installed triggers, not a mocked guard or
     // a disabled-trigger fixture. Its provider identity/path are synthetic.
     await db.query('begin');assert.equal((await y.rpc(await commit(y))).status,'resolved');
     await blocker.query("set statement_timeout='250ms'");
     await assert.rejects(blocker.query(insert,args),error=>error.code==='57014');
     await blocker.query('set statement_timeout=0');await db.query('rollback');
     assert.equal(await scalar('select count(*)::int v from clued_private.resource_center_artifacts_v1 where id=$1',[child]),0);
     await blocker.query('begin');await blocker.query(insert,args);
     assert.equal((await y.rpc(await commit(y))).status,'pending');await blocker.query('commit');
     const before=await snapshot();await assert.rejects(y.rpc(await commit(y)),/storage_current_location/);
     assert.deepEqual(await snapshot(),before);
     await blocker.query('delete from clued_private.resource_center_artifacts_v1 where id=$1',[child]);
     assert.equal((await y.rpc(await commit(y))).status,'resolved');
    }finally{await db.query('rollback');await blocker.query('rollback');
     await blocker.query('set statement_timeout=0');await blocker.query('delete from clued_private.resource_center_artifacts_v1 where id=$1',[child]);await blocker.end();}
   });
   await t.test('two connections: a true cross-profile Artifact identity INSERT cannot slip past an active isolation or location transaction',async()=>{
    const y=await prepare(),other=await ctx.setup(),blocker=server.getPgClient();await blocker.connect();const alias=uuid();
    const insert=`insert into clued_private.resource_center_artifacts_v1 select (jsonb_populate_record(null::clued_private.resource_center_artifacts_v1,
     to_jsonb(a)||jsonb_build_object('id',$2::text,'profile_id',$3::text,'path',$4::text))).*
     from clued_private.resource_center_artifacts_v1 a where id=$1`;
    const args=[y.source.id,alias,other.target.profile,other.target.root+'/alias-'+uuid()];
    try{
     await assert.rejects(blocker.query(insert,args),/storage_object_under_review/);
     await db.query('begin');assert.equal((await y.rpc(await commit(y))).status,'resolved');
     await blocker.query("set statement_timeout='250ms'");
     await assert.rejects(blocker.query(insert,args),error=>error.code==='57014');
     await blocker.query('set statement_timeout=0');await db.query('rollback');
     assert.equal(await scalar('select count(*)::int v from clued_private.resource_center_artifacts_v1 where id=$1',[alias]),0);
    }finally{await db.query('rollback');await blocker.query('rollback');await blocker.query('set statement_timeout=0');await blocker.end();}
   });
   await t.test('two connections: concurrent same-intent commits produce one independent result and exact replay',async()=>{
    const y=await prepare(),input=await commit(y),second=server.getPgClient();await second.connect();
    const rpc=input=>second.query('select public.clued_storage_scheduled_recovery_v2($1,$2::jsonb) v',[y.issuer,JSON.stringify(input)]).then(r=>r.rows[0].v);
    try{
     await db.query('begin');const first=await y.rpc(input);assert.equal(first.status,'resolved');
     const pending=await rpc(input);assert.equal(pending.status,'pending');await db.query('commit');
     const before=await snapshot();assert.deepEqual(await rpc(input),first);assert.deepEqual(await snapshot(),before);
    }finally{await db.query('rollback');await second.end();}
   });
   await t.test('overlapping old/new namespaces are protected while an unrelated sibling still works',async st=>{
    const sibling=await ctx.directoryIn(x.f.target,x.f.storage,'other-'+uuid());
    const job=await ctx.submitJob(x.f.target,x.f.client,ctx.trash(sibling));
    const engine=ctx.executor(x.f.target,x.f.storage,async input=>{if(input.action==='provider_attempt'){await ctx.cloud(input);throw Error('synthetic lost sibling acknowledgement');}});
    assert.equal((await engine.run(job.reference)).status,'unreconciled');const original=await ctx.journal(job);
    await db.query("update public.clued_audit_receipts set created_at=clock_timestamp()-interval '3 hours' where id=$1",[original.provider_attempt_receipt_id]);
    await db.query("update clued_private.resource_center_mutations_v1 set expires_at=clock_timestamp()-interval '3 hours' where id=$1",[original.id]);
    assert.equal(await scalar('select clued_private.storage_conflict_close_v1($1) v',[original.id]),'conflict');
    const qBefore=await scalar('select to_jsonb(q) v from clued_private.storage_conflict_isolations_v1 q where intent_id=$1',[original.id]);
    const target=x.plan.registration_plan.target;
    for(const [name,sql,args] of [
     ['unknown scope','scope_complete=false',[]],
     ['same object','object_ids=array[$2]',[x.source.provider_file_id]],
     ['ancestor-dependent work','ancestor_ids=array[$2]',[x.source.provider_file_id]],
     ['child slot',"slots=jsonb_build_array(jsonb_build_object('parent_id',$2::text,'name','new'))",[x.source.provider_file_id]],
     ['old slot',"slots=jsonb_build_array(jsonb_build_object('parent_id',$2::text,'name',$3::text))",[target.registered_parent_id,path.posix.basename(target.registered_path)]],
     ['new slot',"slots=jsonb_build_array(jsonb_build_object('parent_id',$2::text,'name',$3::text))",[target.parent_id,path.posix.basename(target.path)]],
     ['old containing subtree','subtree_paths=array[$2]',[path.posix.dirname(target.registered_path)]],
     ['new descendant subtree','subtree_paths=array[$2]',[target.path+'/child']],
    ])await st.test(name+' has no partial effects',()=>rejectSeed(async()=>{
     // Historical adversarial scopes in this disposable database only.
     await db.query('set local session_replication_role=replica');
     await db.query('update clued_private.storage_conflict_isolations_v1 set '+sql+' where intent_id=$1',[original.id,...args]);
     await db.query('set local session_replication_role=origin');
    }));
    assert.equal((await x.rpc(await commit(x))).status,'resolved');
    assert.deepEqual(await scalar('select to_jsonb(q) v from clued_private.storage_conflict_isolations_v1 q where intent_id=$1',[original.id]),qBefore);
   });
   await t.test('a different-root isolation of the same physical new parent is not filtered out',async()=>{
    const y=await prepare(),other=await prepare();
    await db.query('begin');try{
     // Historical cross-profile physical alias in the disposable database.
     // The other isolation is real; only its adversarial scope is seeded.
     await db.query('set local session_replication_role=replica');
     await db.query('update clued_private.storage_conflict_isolations_v1 set object_ids=array[$2] where intent_id=$1',
      [other.original.id,y.parent.provider_file_id]);await db.query('set local session_replication_role=origin');
     const before=await snapshot();await db.query('savepoint foreign_parent_attempt');
     await assert.rejects(y.rpc(await commit(y)),/storage_object_under_review/);
     await db.query('rollback to savepoint foreign_parent_attempt');assert.deepEqual(await snapshot(),before);
    }finally{await db.query('rollback');}
   });
   await t.test('all private V4 helpers and permit storage remain inaccessible to transport roles',async()=>{
    for(const role of ['anon','authenticated','service_role','clued_worker_gateway']){
     for(const signature of ['storage_directory_location_seed_v4(text,uuid,uuid)',
      'storage_directory_location_plan_v4(text,uuid,uuid,text,text)','storage_location_profile_guard_v4()',
      'storage_directory_location_reconcile_v4(text,jsonb)','storage_directory_location_inflight_v4(uuid,uuid,jsonb)',
      'storage_directory_location_permitted_v4(clued_private.resource_center_artifacts_v1,clued_private.resource_center_artifacts_v1)'])
      assert.equal(await scalar("select has_function_privilege($1,$2,'execute') v",[role,'clued_private.'+signature]),false);
     assert.equal(await scalar("select has_table_privilege($1,'clued_private.storage_directory_location_permits_v4','select,insert,update,delete') v",[role]),false);
    }
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
