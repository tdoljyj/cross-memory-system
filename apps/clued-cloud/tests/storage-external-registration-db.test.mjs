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
import {scopeString} from '../worker/storage-google-scopes.ts';
import {allowRawTestBindings} from './raw-binding-grants-fixture.mjs';
import {assertGatewayCloseoutBoundary,setWorkerGatewayCaller} from './worker-gateway-caller-fixture.mjs';
import {testStorageDestructive} from './resource-center-storage-destructive-db.fixture.mjs';
import {createGoogleDriveMetadataApi} from '../../../kernel/host/resource-center-google-drive-metadata.mjs';
import {createGoogleDriveExternalRegistrationObserver} from '../../../kernel/host/resource-center-google-drive-external-registration.mjs';
import {googleDriveSharingDigest} from '../../../kernel/host/resource-center-google-drive-sharing.mjs';
const cloud=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const uuid=()=>crypto.randomUUID();
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));
 const p=s.address().port;await new Promise(r=>s.close(r));return p;}

test('external registration: real migration, Native opt-in and program commit',{timeout:240000},async t=>{
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
  await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[owner,JSON.stringify({sub:owner,session_id:session,role:'authenticated'})]);
  const scalar=async(sql,args)=>(await db.query(sql,args)).rows[0].v;

  await testStorageDestructive(t,db,server,owner,decision,{gateway:true,only_extra:true,extra_cases:async ctx=>{
   const f=await ctx.setup();
   const source=await ctx.directoryIn(f.target,f.storage,'old-name');
   const child=await ctx.directoryIn(f.target,f.storage,'child',source.path,source.provider_file_id);
   const issuer=await scalar('select issuer_hash v from clued_private.storage_oauth_apps_v1 where oauth_client_id=$1',[ctx.oauth_client_id]);
   await db.query("update clued_private.storage_connections_v1 set provider_scope_profile='full' where id=$1",[f.target.connection]);
   await db.query("update clued_private.storage_oauth_apps_v1 set read_enabled=true where issuer_hash=$1",[issuer]);
   const ownerRpc=async(name,input)=>(await native.query('select public.'+name+'($1::jsonb) v',[JSON.stringify(input)])).rows[0].v;
   const master=await ownerRpc('clued_storage_owner_manage_v2',{action:'master_status',connection_id:f.target.connection});
   await ownerRpc('clued_storage_owner_manage_v2',{action:'master_set',connection_id:f.target.connection,enabled:true,
    base_generation:master.master_generation,base_status_digest:master.status_digest,
    disclosure_version:'clued.storage-master-disclosure/1',idempotency_key:uuid()});
   const gateway=server.getPgClient();await gateway.connect();await setWorkerGatewayCaller(gateway);
   try{
    const rpc=async input=>(await gateway.query('select public.clued_storage_access_digest_backfill_v1($1,$2::jsonb) v',[issuer,JSON.stringify(input)])).rows[0].v;
    const reference={connection_id:f.target.connection,artifact_id:source.id};
    const prepare=async request=>(await gateway.query('select public.clued_storage_refresh_worker_v1($1,$2::jsonb) v',
     [issuer,JSON.stringify({action:'prepare_credential',connection_id:f.target.connection,caller_kind:'maintenance',request})])).rows[0].v;
    const renewalRequest={operation:'external_registration',artifact_id:source.id};
    await assert.rejects(rpc({action:'external_load',...reference}),/registration_denied/);
    await assert.rejects(prepare(renewalRequest),/registration_denied/);
    const enableInput={action:'external_set',connection_id:f.target.connection,enabled:true,
     base_version:0,disclosure_version:'clued.storage-external-registration-disclosure/1',idempotency_key:uuid()};
    const enabled=await ownerRpc('clued_storage_write_access_v1',enableInput);
    assert.equal(enabled.enabled,true);
    await t.test('typed renewal preflight requires current opt-in and the exact ordinary directory',async()=>{
     const prepared=await prepare(renewalRequest);
     assert.equal(prepared.contract,'clued.storage-demand-preflight/1');
     assert.equal(prepared.connection_id,f.target.connection);
     await assert.rejects(prepare({...renewalRequest,artifact_id:uuid()}),/demand_denied/);
     await assert.rejects(prepare({...renewalRequest,path:'untrusted'}),/demand_denied/);
     const rootId=await scalar(`select a.id v from clued_private.resource_center_artifacts_v1 a
      join clued_private.resource_center_profiles_v1 p on p.id=a.profile_id where a.profile_id=$1 and a.provider_file_id=p.root_folder_id`,[f.target.profile]);
     await assert.rejects(prepare({...renewalRequest,artifact_id:rootId}),/demand_denied/);
    });
    await t.test('Native policy lost-reply replay returns the original version and does not retoggle',async()=>{
     assert.deepEqual(await ownerRpc('clued_storage_write_access_v1',enableInput),enabled);
     assert.equal((await ownerRpc('clued_storage_write_access_v1',{...enableInput,enabled:false})).status,'rejected');
     await assert.rejects(ownerRpc('clued_storage_write_access_v1',{...enableInput,idempotency_key:uuid()}),/version_conflict/);
    });
    await t.test('due reservations advance even when a directory subsequently cannot load',async()=>{
     const first=await rpc({action:'external_due'}),next=await rpc({action:'external_due'});
     assert.ok(first.directories.length>0);
     assert.ok(next.directories.every(x=>!first.directories.some(y=>x.artifact_id===y.artifact_id)));
    });
    for(const file of f.storage.files.values())Object.assign(file,{shared:false,permissionIds:['fixture-owner'],
      capabilities:{...file.capabilities,canListChildren:true}});
    const metadata=createGoogleDriveMetadataApi({registration_details:true,
     get_credential:async()=>({access_token:ctx.access_token,scope:scopeString('full')}),fetch:f.storage.fetch});
    const rootRow=await scalar('select to_jsonb(a) v from clued_private.resource_center_artifacts_v1 a join clued_private.resource_center_profiles_v1 p on p.id=a.profile_id where a.profile_id=$1 and a.provider_file_id=p.root_folder_id',[f.target.profile]);
    await db.query('update clued_private.resource_center_artifacts_v1 set provider_sharing_digest=$2 where id=$1',
     [rootRow.id,googleDriveSharingDigest(f.storage.files.get(rootRow.provider_file_id))]);
    const load=await rpc({action:'external_load',...reference});
    f.storage.files.get(source.provider_file_id).name='new-name';
    f.storage.files.get(source.provider_file_id).version='4';
    const observation=await createGoogleDriveExternalRegistrationObserver({metadata}).observe(load.plan);
    const input={action:'external_commit',connection_id:f.target.connection,attempt_id:load.attempt_id,observation};
    const baseline=await ctx.artifactById(source.id),baselineChild=await ctx.artifactById(child.id);
    const unchanged=async()=>{
     assert.deepEqual(await ctx.artifactById(source.id),baseline);
     assert.deepEqual(await ctx.artifactById(child.id),baselineChild);
    };
    for(const fault of ['missing-field','different-read','incomplete-subtree','outside-root','ancestor-access','existing-id-forgery'])await t.test(fault+' cannot mutate a registry',async()=>{
     const bad=structuredClone(input),one=bad.observation.first_observation;
     if(fault==='missing-field')delete one.nodes.find(n=>n.provider_file_id===source.provider_file_id).path;
     if(fault==='incomplete-subtree'){
      one.nodes=one.nodes.filter(n=>n.provider_file_id!==child.provider_file_id);
      one.selected_ids=one.selected_ids.filter(id=>id!==child.provider_file_id);
     }
     if(fault==='outside-root')one.nodes.find(n=>n.provider_file_id===source.provider_file_id).path='outside/new-name';
     if(fault==='ancestor-access')one.nodes.find(n=>n.provider_file_id===load.plan.root_folder_id).sharing_digest='a'.repeat(64);
     if(fault==='existing-id-forgery')one.new_ids.push(load.plan.root_folder_id);
     if(fault!=='different-read')bad.observation.second_observation=structuredClone(one);
     else bad.observation.second_observation.nodes[0].provider_file_version='999';
     await assert.rejects(rpc(bad),/registration_/);await unchanged();
    });
    await t.test('a concurrent registry update is not overwritten by the observed plan',async()=>{
     await db.query('update clued_private.resource_center_artifacts_v1 set version=version+1 where id=$1',[source.id]);
     try{await assert.rejects(rpc(input),/registration_conflict/);}
     finally{await db.query('update clued_private.resource_center_artifacts_v1 set version=$2 where id=$1',[source.id,baseline.version]);}
     await unchanged();
    });
    await t.test('issuer revocation after both observations blocks commit',async()=>{
     await db.query('update clued_private.storage_oauth_apps_v1 set execution_enabled=false where issuer_hash=$1',[issuer]);
     try{await assert.rejects(rpc(input),/denied/);}
     finally{await db.query('update clued_private.storage_oauth_apps_v1 set execution_enabled=true where issuer_hash=$1',[issuer]);}
     await unchanged();
    });
    await t.test('an active storage work claim fences the same folder',async()=>{
     const holder=(await db.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','active editor',$2,array['context:read','context:write'],array['*']) returning id`,[owner,crypto.createHash('sha256').update(uuid()).digest('hex')])).rows[0].id;
     const task=uuid();await db.query(`insert into public.clued_memories(id,user_id,title,content,scope,record_type,status,record_schema_version,lifecycle_status,
      canonical_scope,type_fields,relations,source_refs,authority,confidence_reason) values($1,$2,'Synthetic editor','fixture','global','task','active',1,'active',
      'global','{"execution_bucket":"next"}','{}','{}','observed','fixture')`,[task,owner]);
     const claim=(await db.query(`insert into clued_private.work_claims_v1(user_id,task_id,context_key,holder_binding_id,holder_session_ref,write_set,fence,issued_at,expires_at,hard_deadline_at,status,idempotency_key)
      values($1,$2,'global',$3,'fixture-session',$4,1,clock_timestamp(),clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 day','ACTIVE',$5) returning claim_id`,
      [owner,task,holder,[`storage:${f.target.connection}/${source.path.slice(load.plan.managed_root.length+1)}/**`],uuid()])).rows[0].claim_id;
     try{await assert.rejects(rpc(input),/work_claim_conflict/);await unchanged();}
     finally{await db.query('delete from clued_private.work_claims_v1 where claim_id=$1',[claim]);}
    });
    await t.test('failure of the final receipt rolls the complete subtree back',async()=>{
     const count=await scalar('select count(*)::integer v from public.clued_audit_receipts');
     await db.query(`create function public.synthetic_external_receipt_failure() returns trigger language plpgsql as $$begin
      if new.operation='storage_external_registration' and new.status='committed' then raise exception 'synthetic_external_commit_failure';end if;return new;end$$;
      create trigger synthetic_external_receipt_failure before update on public.clued_audit_receipts for each row execute function public.synthetic_external_receipt_failure()`);
     try{await assert.rejects(rpc(input),/synthetic_external_commit_failure/);await unchanged();
      assert.equal(await scalar('select count(*)::integer v from public.clued_audit_receipts'),count);}
     finally{await db.query('drop trigger synthetic_external_receipt_failure on public.clued_audit_receipts;drop function public.synthetic_external_receipt_failure()');}
    });
    await t.test('registration serializes with concurrent claim creation and expansion through settlement',async()=>{
     const token=crypto.createHash('sha256').update(uuid()).digest('hex'),task=uuid();
     await db.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','concurrent editor',$2,array['context:read','context:write'],array['*'])`,[owner,token]);
     await db.query(`insert into public.clued_memories(id,user_id,title,content,scope,record_type,status,record_schema_version,lifecycle_status,
      canonical_scope,type_fields,relations,source_refs,authority,confidence_reason) values($1,$2,'Synthetic concurrent editor','fixture','global','task','active',1,'active',
      'global','{"execution_bucket":"next"}','{}','{}','observed','fixture')`,[task,owner]);
     const claimInput={scope:'global',task_id:task,write_set:[`storage:${f.target.connection}/unrelated/**`],
      holder_session_ref:'synthetic-external-concurrency',idempotency_key:uuid()};
     const claim=await scalar('select public.clued_work_claim_v1($1,$2::jsonb) v',[token,JSON.stringify(claimInput)]);
     assert.equal(claim.status,'committed',JSON.stringify(claim));
     try{
      await db.query('begin');
      try{
       await db.query('select clued_private.work_claim_lock($1)',[owner]);
       await assert.rejects(rpc(input),e=>e.code==='55P03');await unchanged();
      }finally{await db.query('rollback');}
      await gateway.query('begin');
      try{
       assert.equal((await rpc(input)).status,'committed');
       await db.query("set lock_timeout='75ms'");
       const path=`storage:${f.target.connection}/${source.path.slice(load.plan.managed_root.length+1)}/**`;
       await assert.rejects(db.query('select public.clued_work_claim_v1($1,$2::jsonb)',[token,JSON.stringify({...claimInput,write_set:[path],idempotency_key:uuid()})]),e=>e.code==='55P03');
       await assert.rejects(db.query('select public.clued_work_renew_v1($1,$2::jsonb)',[token,JSON.stringify({scope:'global',claim_id:claim.claim.claim_id,
        fence:claim.claim.fence,lease_version:claim.claim.lease_version,lease_key:claim.lease_key,write_set:[path],progress_ref:uuid(),idempotency_key:uuid()})]),e=>e.code==='55P03');
      }finally{await db.query("set lock_timeout='0'");await gateway.query('rollback');}
      await unchanged();
     }finally{await db.query('delete from clued_private.work_claims_v1 where claim_id=$1',[claim.claim.claim_id]);}
    });
    const result=await rpc(input);assert.equal(result.status,'committed',JSON.stringify(result));assert.equal(result.changed,2);
    assert.equal((await ctx.artifactById(source.id)).path,source.path.replace('old-name','new-name'));
    assert.equal((await ctx.artifactById(child.id)).path,child.path.replace('old-name','new-name'));
    assert.deepEqual(await rpc(input),result,'identical commit replay');
    await assert.rejects(rpc({...input,observation:{...observation,observed_at:new Date().toISOString()}}),/registration_conflict/);
    const quiet=await rpc({action:'external_load',...reference});
    const beforeQuiet=await scalar('select count(*)::integer v from public.clued_audit_receipts');
    const quietResult=await rpc({action:'external_commit',connection_id:f.target.connection,attempt_id:quiet.attempt_id,
     observation:await createGoogleDriveExternalRegistrationObserver({metadata}).observe(quiet.plan)});
    assert.equal(quietResult.status,'unchanged');
    assert.equal(await scalar('select count(*)::integer v from public.clued_audit_receipts'),beforeQuiet);
    const newId='new-'+uuid();
    const newFile={...f.storage.directory(newId,'owner-created.txt',source.provider_file_id),mimeType:'text/plain',shared:false,
     permissionIds:['fixture-owner'],size:'4',headRevisionId:'new-rev',md5Checksum:'a'.repeat(32)};
    f.storage.files.set(newId,newFile);
    const adopt=await rpc({action:'external_load',...reference});
    const adopted=await rpc({action:'external_commit',connection_id:f.target.connection,attempt_id:adopt.attempt_id,
     observation:await createGoogleDriveExternalRegistrationObserver({metadata}).observe(adopt.plan)});
    assert.equal(adopted.changed,1);
    const newRow=await scalar('select to_jsonb(a) v from clued_private.resource_center_artifacts_v1 a where profile_id=$1 and provider_file_id=$2',[f.target.profile,newId]);
    assert.equal(newRow.governance_class,'ordinary');assert.equal(newRow.delete_authority,false);
    await t.test('content edits update the same ID and fresh observations recover after a diagnostic',async()=>{
     newFile.version='2';newFile.headRevisionId='edited-revision';
     const current=await rpc({action:'external_load',...reference});
     await rpc({action:'external_failed',connection_id:f.target.connection,attempt_id:current.attempt_id,reason:'scan_unavailable'});
     assert.ok((await ownerRpc('clued_storage_write_access_v1',{action:'external_status',connection_id:f.target.connection})).attention_count>0);
     const edited=await rpc({action:'external_commit',connection_id:f.target.connection,attempt_id:current.attempt_id,
      observation:await createGoogleDriveExternalRegistrationObserver({metadata}).observe(current.plan)});
     assert.equal(edited.changed,1);
     const updated=await scalar('select to_jsonb(a) v from clued_private.resource_center_artifacts_v1 a where id=$1',[newRow.id]);
     assert.equal(updated.provider_file_version,'2');assert.equal(updated.version,newRow.version+1);
    });
    await t.test('two registered files may exchange paths atomically while real collisions still roll back',async()=>{
     const secondId='second-'+uuid(),second={...newFile,id:secondId,name:'second.txt',version:'1'};
     f.storage.files.set(secondId,second);
     const initial=await rpc({action:'external_load',...reference});
     await rpc({action:'external_commit',connection_id:f.target.connection,attempt_id:initial.attempt_id,
      observation:await createGoogleDriveExternalRegistrationObserver({metadata}).observe(initial.plan)});
     const secondRow=await ctx.artifactById(await scalar('select id v from clued_private.resource_center_artifacts_v1 where profile_id=$1 and provider_file_id=$2',[f.target.profile,secondId]));
     const firstRow=await ctx.artifactById(newRow.id);
     await assert.rejects(db.query('update clued_private.resource_center_artifacts_v1 set path=$2 where id=$1',[newRow.id,secondRow.path]),/exclusion constraint/);
     const current=await rpc({action:'external_load',...reference});
     [newFile.name,second.name]=[second.name,newFile.name];newFile.version='3';second.version='2';
     const observed=await createGoogleDriveExternalRegistrationObserver({metadata}).observe(current.plan);
     const bad=structuredClone(observed),first=bad.first_observation.nodes.find(n=>n.provider_file_id===newId),other=bad.first_observation.nodes.find(n=>n.provider_file_id===secondId);
     other.path=first.path;other.name=first.name;bad.second_observation=structuredClone(bad.first_observation);
     const count=await scalar('select count(*)::integer v from public.clued_audit_receipts');
     await assert.rejects(rpc({action:'external_commit',connection_id:f.target.connection,attempt_id:current.attempt_id,observation:bad}),/exclusion constraint/);
     assert.deepEqual(await ctx.artifactById(newRow.id),firstRow);assert.deepEqual(await ctx.artifactById(secondRow.id),secondRow);
     assert.equal(await scalar('select count(*)::integer v from public.clued_audit_receipts'),count);
     const swapped=await rpc({action:'external_commit',connection_id:f.target.connection,attempt_id:current.attempt_id,observation:observed});
     assert.equal(swapped.changed,2);
     assert.equal((await ctx.artifactById(newRow.id)).path,secondRow.path);
     assert.equal((await ctx.artifactById(secondRow.id)).path,firstRow.path);
     assert.equal(await scalar('select count(*)::integer v from public.clued_audit_receipts'),count+1);
    });
    await t.test('a move into a newly created parent chain registers parents and the same file together',async()=>{
     const parentId='parent-'+uuid(),nestedId='nested-'+uuid();
     for(const [id,name,parent] of [[parentId,'新父目录',source.provider_file_id],[nestedId,'新子目录',parentId]])
      f.storage.files.set(id,{...f.storage.directory(id,name,parent),shared:false,permissionIds:['fixture-owner'],capabilities:{canListChildren:true}});
     newFile.parents=[nestedId];newFile.version='4';
     const current=await rpc({action:'external_load',...reference});
     const observed=await createGoogleDriveExternalRegistrationObserver({metadata}).observe(current.plan);
     assert.deepEqual(new Set(observed.first_observation.new_ids),new Set([parentId,nestedId]));
     const result=await rpc({action:'external_commit',connection_id:f.target.connection,attempt_id:current.attempt_id,observation:observed});
     assert.equal(result.changed,3);
     assert.equal((await ctx.artifactById(newRow.id)).path,(await ctx.artifactById(source.id)).path+'/新父目录/新子目录/'+newFile.name);
     for(const id of [parentId,nestedId]){
      const row=await scalar('select to_jsonb(a) v from clued_private.resource_center_artifacts_v1 a where profile_id=$1 and provider_file_id=$2',[f.target.profile,id]);
      assert.equal(row.source_decision_id,source.source_decision_id);assert.equal(row.delete_authority,false);
     }
    });
    const revokedAttempt=await rpc({action:'external_load',...reference});
    const revokedObservation=await createGoogleDriveExternalRegistrationObserver({metadata}).observe(revokedAttempt.plan);
    await ownerRpc('clued_storage_write_access_v1',{action:'external_set',connection_id:f.target.connection,enabled:false,
     base_version:enabled.version,disclosure_version:'clued.storage-external-registration-disclosure/1',idempotency_key:uuid()});
    await assert.rejects(rpc({action:'external_load',...reference}),/registration_denied/);
    await assert.rejects(prepare(renewalRequest),/registration_denied/);
    await assert.rejects(rpc({action:'external_commit',connection_id:f.target.connection,attempt_id:revokedAttempt.attempt_id,observation:revokedObservation}),/registration_denied/);
    assert.equal(f.storage.patches,0);assert.equal(f.storage.deletes,0);
   }finally{await gateway.end();}
   await assertGatewayCloseoutBoundary(db);
   for(const role of ['anon','authenticated','service_role','clued_worker_gateway']){
    for(const fn of ['storage_external_registration_policy_call_v1(jsonb)','storage_external_registration_authority_v1(text,uuid)','storage_external_registration_call_v1(text,jsonb)'])
     assert.equal(await scalar('select has_function_privilege($1,$2,\'execute\') v',[role,'clued_private.'+fn]),false);
    for(const table of ['storage_external_registration_policy_v1','storage_external_registration_scan_v1','storage_external_registration_attempt_v1'])
     assert.equal(await scalar('select has_table_privilege($1,$2,\'select,insert,update,delete\') v',[role,'clued_private.'+table]),false);
   }
  }});
 }finally{
  if(native)await native.end();if(db)await db.end();
  if(started){const producer=server.process,closed=producer?once(producer,'close'):Promise.resolve();
   await server.stop();producer?.stdin?.destroy();producer?.stdout?.destroy();producer?.stderr?.destroy();await closed;}
  const actual=await fs.realpath(directory);assert.equal(path.dirname(actual).toLowerCase(),parent.toLowerCase());
  assert.ok(path.basename(actual).startsWith('kooyumi-registration-db-'));
  await fs.rm(actual,{recursive:true,force:false,maxRetries:5,retryDelay:100});
 }
});

