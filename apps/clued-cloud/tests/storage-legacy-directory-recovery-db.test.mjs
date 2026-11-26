// Actual disposable PostgreSQL, original executor and Worker recovery. The
// provider transport and elapsed-time fixtures are synthetic; no production
// authorization, Drive file or machine synchronization state is asserted.
import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build,stop} from 'esbuild';
import { newCluster } from './pg-cluster-fixture.mjs';
import {allowRawTestBindings} from './raw-binding-grants-fixture.mjs';
import {workerGatewayRpc,assertGatewayCloseoutBoundary} from './worker-gateway-caller-fixture.mjs';
import {testStorageDestructive} from './resource-center-storage-destructive-db.fixture.mjs';
const cloud=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const uuid=()=>crypto.randomUUID();

test('legacy directory: real P5 attempts and independent before recovery',{timeout:240000},async t=>{
 const parent=await fs.realpath(os.tmpdir()),directory=await fs.mkdtemp(path.join(parent,'kooyumi-legacy-directory-'));
 const server=newCluster({databaseDir:directory,user:'postgres',password:uuid(),persistent:true,
  initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags:[...EPHEMERAL_POSTGRES_FLAGS, '-c', 'listen_addresses=127.0.0.1'],onLog(){},onError(){}});
 let db,started=false;
 try{
  await startCluster(server);started=true;db=server.getPgClient();await db.connect();
  const modules={};
  for(const name of ['storage-cloud-recovery','storage-credential-vault']){
   const output=path.join(directory,name+'.mjs');await build({entryPoints:[path.join(cloud,'worker',name+'.ts')],outfile:output,bundle:true,platform:'node',format:'esm'});
   modules[name]=await import(pathToFileURL(output));
  }stop();
  const {createStorageCloudRecovery}=modules['storage-cloud-recovery'],{createStorageCredentialVault}=modules['storage-credential-vault'];
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
  const owner=uuid(),project=uuid(),decision=uuid();
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'legacy-directory@synthetic.invalid',now())",[owner]);
  await db.query("insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at) values($1,$2,'Legacy directory','legacy directory',$3,'confirmed',now())",[project,owner,'project:'+project]);
  await db.query(`insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,record_schema_version,lifecycle_status,
   canonical_scope,type_fields,relations,source_refs,authority,confidence_reason) values($1,$2,'Synthetic approval','Disposable only','project',$3,'decision','active',1,'active',
   $4,'{"rationale":"legacy directory test"}','{}','{}','user_explicit','Owner confirmed')`,[decision,owner,project,'project:'+project]);
  const scalar=async(sql,args)=>(await db.query(sql,args)).rows[0].v;
  const scheduled=async(issuer,input)=>{
   try{return await workerGatewayRpc(db,'clued_storage_scheduled_recovery_v2',issuer,input);}
   finally{await db.query('reset role');await db.query("select set_config('request.jwt.claims','{}',false)");}
  };
  const vaultConfig={current_key_id:'synthetic',keys:{synthetic:crypto.randomBytes(32).toString('base64url')}};
  const vault=await createStorageCredentialVault(vaultConfig);
  await testStorageDestructive(t,db,server,owner,decision,{gateway:true,only_extra:true,extra_cases:async ctx=>{
   const make=async(operation='delete',historicalFault=null)=>{
    const {target,client,storage}=await ctx.setup();let source=await ctx.directoryIn(target,storage,'original-'+uuid());
    if(operation==='restore')source=await ctx.trashed(target,client,storage,source);
    const job=await ctx.submitJob(target,client,operation==='restore'?ctx.untrash(source):ctx.trash(source));
    const beforeWrites=storage.patches;
    const engine=ctx.executor(target,storage,async request=>{
     if(request.action==='provider_attempt'){await ctx.cloud(request);throw Error('synthetic lost acknowledgment before the original PATCH');}
    });
    assert.equal((await engine.run(job.reference)).status,'unreconciled');assert.equal(storage.patches,beforeWrites);
    const original=await ctx.journal(job);assert.ok(original.provider_attempt_receipt_id);
    assert.equal(await scalar('select count(*)::int v from clued_private.storage_semantic_attempts_v1 where intent_id=$1',[original.id]),0);
    // Represent registration drift that already existed when I9 classified
    // the old journal. Never disable its current Artifact isolation trigger.
    if(historicalFault==='artifact-version')await db.query('update clued_private.resource_center_artifacts_v1 set version=version+1 where id=$1',[source.id]);
    if(historicalFault==='registered-descendant')await db.query(`insert into clued_private.resource_center_artifacts_v1
     select (jsonb_populate_record(null::clued_private.resource_center_artifacts_v1,to_jsonb(a)||jsonb_build_object(
      'id',$2::uuid,'path',a.path||'/registered-child','provider_file_id','registered-child-'||$2::text,'target_kind','file'))).*
      from clued_private.resource_center_artifacts_v1 a where a.id=$1`,[source.id,uuid()]);
    // Only this disposable time fixture ages; the actual P5 attempt and its
    // original Receipt identities are not replaced or fabricated.
    await db.query("update public.clued_audit_receipts set created_at=clock_timestamp()-interval '3 hours' where id=$1",[original.provider_attempt_receipt_id]);
    await db.query("update clued_private.resource_center_mutations_v1 set expires_at=clock_timestamp()-interval '3 hours' where id=$1",[original.id]);
    assert.equal(await scalar('select clued_private.storage_conflict_close_v1($1) v',[original.id]),'conflict');
    const closed=await ctx.journal(job),issuer=await scalar('select issuer_hash v from clued_private.storage_oauth_apps_v1 where oauth_client_id=$1',[ctx.oauth_client_id]);
    const envelope=await vault.seal(JSON.stringify({token_type:'Bearer',access_token:ctx.access_token,
     scope:'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly',expires_at_ms:Date.now()+3600000}),
     {owner_id:owner,connection_id:target.connection,provider:'google-drive',provider_subject:ctx.provider_subject,oauth_client_id:ctx.oauth_client_id,credential_version:1});
    await db.query('update clued_private.storage_connections_v1 set credential_envelope=$2 where id=$1',[target.connection,JSON.stringify(envelope)]);
    assert.equal(await scalar('select clued_private.storage_legacy_directory_candidate_v1(j) v from clued_private.storage_jobs_v1 j where j.job_id=$1',[job.reference.job_id]),true);
    const descriptor=await scheduled(issuer,{action:'load',...job.reference});assert.equal(descriptor.status,'recovery_only');
    assert.deepEqual(descriptor.conflict_reconcile,{closed_version:3,source_receipt_id:closed.receipt_id});assert.ok(descriptor.recovery_reader);
    const calls=[];let submitted;
    const recover=async(transform=x=>x)=>{
     const recovery=await createStorageCloudRecovery({client_id:ctx.oauth_client_id,vault:vaultConfig,timeout_ms:10000,fetch:storage.fetch,
      verified:{descriptor,rpc:ctx.cloud},rpc:async input=>{calls.push(structuredClone(input));submitted=transform(input);return scheduled(issuer,submitted);}});
     return recovery.run(job.reference);
    };
    return {target,client,storage,source,job,original,closed,issuer,descriptor,calls,recover,get submitted(){return submitted;}};
   };
   for(const operation of ['delete','restore'])await t.test(operation+' before retains the Artifact and original uncertainty, resolves once without provider write',async()=>{
    const f=await make(operation),priorArtifact=await ctx.artifactById(f.source.id),writes=f.storage.patches;
    const result=await f.recover();assert.equal(result.status,'resolved',JSON.stringify({result,calls:f.calls}));
    const final=await ctx.journal(f.job);assert.equal(final.state,'conflict');assert.equal(final.version,'4');assert.equal(final.receipt_id,f.closed.receipt_id);
    assert.deepEqual(final.provider_attempt,f.original.provider_attempt);assert.equal(final.provider_attempt_receipt_id,f.original.provider_attempt_receipt_id);
    assert.deepEqual(await ctx.artifactById(f.source.id),priorArtifact);assert.equal(f.storage.patches,writes);assert.equal(f.storage.deletes,0);
    assert.equal((await scheduled(f.issuer,f.submitted)).receipt_id,result.receipt_id,'same original operation replay reads one Receipt');
    const exit=(await db.query(`select q.state,r.operation,r.status from clued_private.storage_conflict_isolations_v1 q
     join public.clued_audit_receipts r on r.id=q.resolution_receipt_id where q.intent_id=$1`,[final.id])).rows[0];
    assert.deepEqual(exit,{state:'resolved',operation:'storage_automatic_reconcile',status:'committed'});
    assert.equal(f.calls[0].second_observation.empty,true);assert.equal(f.calls[0].second_observation.trashed,operation==='restore');
    const next=await ctx.submitJob(f.target,f.client,operation==='restore'?ctx.untrash(f.source):ctx.trash(f.source));
    assert.equal((await ctx.cloud({action:'load',...next.reference})).status,'queued','same object can enter a new authorized operation');
   });
   for(const fault of ['version','namespace','trashed-child','permission-missing','artifact-version','registered-descendant','cas','reader'])await t.test(fault+' cannot clear a legacy directory isolation',async()=>{
    const f=await make('delete',fault),file=f.storage.files.get(f.source.provider_file_id);
    if(fault==='version')file.version='99';
    if(fault==='namespace')f.storage.files.set('other',f.storage.directory('other',file.name,file.parents[0]));
    if(fault==='trashed-child')f.storage.files.set('child',{...f.storage.directory('child','child',file.id),trashed:true,explicitlyTrashed:true});
    if(fault==='permission-missing')delete file.permissions;
    const result=await f.recover(input=>fault==='cas'?{...input,base_version:99}:fault==='reader'?{...input,recovery_reader:{...input.recovery_reader,auth_generation:99}}:input);
    assert.notEqual(result.status,'resolved',JSON.stringify(result));
    assert.equal(await scalar('select state v from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[f.original.id]),'active');
    assert.equal(f.storage.patches,0);assert.equal(f.storage.deletes,0);
   });
   await t.test('two real gateway sessions serialize the same automatic result into one independent Receipt',async()=>{
    const f=await make();await f.recover(input=>{f.calls.push(structuredClone(input));throw Error('synthetic pause before sending private RPC');});
    const input=f.calls[0];assert.ok(input?.first_observation);
    const left=server.getPgClient(),right=server.getPgClient();await left.connect();await right.connect();
    try{
     const replies=await Promise.all([left,right].map(client=>workerGatewayRpc(client,'clued_storage_scheduled_recovery_v2',f.issuer,input)));
     assert.equal(replies[0].status,'resolved');assert.equal(replies[0].receipt_id,replies[1].receipt_id);
     assert.equal(await scalar("select count(*)::int v from public.clued_audit_receipts where user_id=$1 and operation='storage_automatic_reconcile' and target_refs @> $2::jsonb",[owner,JSON.stringify([{id:f.original.id}])]),1);
     assert.equal((await ctx.journal(f.job)).version,'4');assert.equal(f.storage.patches,0);
    }finally{await left.end();await right.end();}
   });
   await t.test('independent Receipt failure rolls back every exit and original observation',async()=>{
    const f=await make();await db.query(`create function public.test_directory_receipt_failure() returns trigger language plpgsql as $$begin
     if new.operation='storage_automatic_reconcile' and new.status='committed' then raise exception 'synthetic_directory_receipt_failure';end if;return new;end$$;
     create trigger test_directory_receipt_failure before update on public.clued_audit_receipts for each row execute function public.test_directory_receipt_failure()`);
    try{assert.notEqual((await f.recover()).status,'resolved');}finally{await db.query('drop trigger test_directory_receipt_failure on public.clued_audit_receipts;drop function public.test_directory_receipt_failure()');}
    assert.equal((await ctx.journal(f.job)).version,'3');
    assert.equal(await scalar('select state v from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[f.original.id]),'active');
    assert.equal(await scalar('select count(*)::int v from clued_private.storage_automatic_reconcile_checks_v1 where intent_id=$1',[f.original.id]),0);
    assert.equal((await f.recover()).status,'resolved');
   });
   const makeCreate=async(kind='directory',fault=null)=>{
    const {target,client,storage}=await ctx.setup();
    const parentPath=await scalar('select path v from clued_private.resource_center_artifacts_v1 where profile_id=$1 and provider_file_id=$2',[target.profile,target.trackId]);
    const mutation={operation:'create',target_kind:kind,destination_path:parentPath+'/absent-'+uuid(),
     ...(kind==='file'?{content:'original legacy create'}:{directory_semantics:'topic'})};
    const job=await ctx.submitJob(target,client,mutation);
    const engine=ctx.executor(target,storage,async request=>{
     if(request.action==='provider_attempt'){await ctx.cloud(request);throw Error('synthetic lost original attempt acknowledgment before POST');}
    });
    assert.equal((await engine.run(job.reference)).status,'unreconciled');
    const original=await ctx.journal(job);assert.ok(original.provider_attempt_receipt_id);
    await db.query("update public.clued_audit_receipts set created_at=clock_timestamp()-interval '3 hours' where id=$1",[original.provider_attempt_receipt_id]);
    await db.query("update clued_private.resource_center_mutations_v1 set expires_at=clock_timestamp()-interval '3 hours' where id=$1",[original.id]);
    assert.equal(await scalar('select clued_private.storage_conflict_close_v1($1) v',[original.id]),'conflict');
    const closed=await ctx.journal(job),issuer=await scalar('select issuer_hash v from clued_private.storage_oauth_apps_v1 where oauth_client_id=$1',[ctx.oauth_client_id]);
    const envelope=await vault.seal(JSON.stringify({token_type:'Bearer',access_token:ctx.access_token,
     scope:'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly',expires_at_ms:Date.now()+3600000}),
     {owner_id:owner,connection_id:target.connection,provider:'google-drive',provider_subject:ctx.provider_subject,oauth_client_id:ctx.oauth_client_id,credential_version:1});
    await db.query('update clued_private.storage_connections_v1 set credential_envelope=$2 where id=$1',[target.connection,JSON.stringify(envelope)]);
    assert.equal(await scalar('select clued_private.storage_legacy_create_absent_candidate_v1(j) v from clued_private.storage_jobs_v1 j where j.job_id=$1',
     [job.reference.job_id]),true,JSON.stringify(original.provider_attempt));
    const descriptor=await scheduled(issuer,{action:'load',...job.reference});assert.equal(descriptor.status,'recovery_only');
    assert.ok(descriptor.recovery_reader);assert.equal(descriptor.conflict_reconcile,undefined,'create must not enter the P5 before observer');
    assert.deepEqual(descriptor.conflict_absence,{closed_version:3,source_receipt_id:closed.receipt_id});
    const requests=[],submissions=[];
    const fetch=async(input,init)=>{
     const url=new URL(String(input));requests.push({method:init.method,path:url.pathname,q:url.searchParams.get('q')});
     if(url.pathname.endsWith('/'+original.provider_attempt.provider_file_id)&&fault==='present')return Response.json({id:original.provider_attempt.provider_file_id});
     if(url.searchParams.get('q')?.startsWith('appProperties has'))return Response.json({files:fault==='tagged'?[{id:'original-tag-visible-elsewhere'}]:[],incompleteSearch:fault==='incomplete'});
     return storage.fetch(input,init);
    };
    const absent=async(input,database=db)=>{
     try{return await workerGatewayRpc(database,'clued_storage_recovery_absent_v1',issuer,input);}
     finally{await database.query('reset role');await database.query("select set_config('request.jwt.claims','{}',false)");}
    };
    const recover=async(transform=x=>x)=>{
     const recovery=await createStorageCloudRecovery({client_id:ctx.oauth_client_id,vault:vaultConfig,timeout_ms:2000,fetch,
      verified:{descriptor,rpc:ctx.cloud},rpc:async()=>assert.fail('legacy absence uses only its fixed absence RPC'),
      absent:{rpc:async input=>{const submitted=transform(input);submissions.push(submitted);return absent(submitted);}}});
     return recovery.run(job.reference);
    };
    return {target,client,storage,job,original,closed,issuer,descriptor,requests,submissions,recover,absent};
   };
   for(const kind of ['file','directory'])await t.test('I9 '+kind+' create absent releases exactly its isolation without rewriting history or creating a file',async()=>{
    const f=await makeCreate(kind);const result=await f.recover();assert.equal(result.status,'resolved',JSON.stringify(result));
    const after=await ctx.journal(f.job);assert.equal(after.state,'conflict');assert.equal(after.version,'4');
    assert.equal(after.receipt_id,f.closed.receipt_id);assert.deepEqual(after.provider_attempt,f.original.provider_attempt);
    assert.equal(after.provider_attempt_receipt_id,f.original.provider_attempt_receipt_id);
    assert.equal(await scalar('select count(*)::int v from clued_private.resource_center_artifacts_v1 where profile_id=$1 and path=$2',
     [f.target.profile,f.job.mutation.destination_path]),0);
    assert.ok(f.requests.every(request=>request.method==='GET'));assert.equal(f.storage.patches,0);assert.equal(f.storage.deletes,0);
    assert.equal(f.submissions[0].recovery_reader.connection_id,f.target.connection);assert.equal(f.submissions[0].credential_version,1);
    assert.equal((await f.absent(f.submissions[0])).receipt_id,result.receipt_id,'lost response replay reuses the independent Receipt');
    const next=await ctx.submitJob(f.target,f.client,f.job.mutation);assert.equal((await ctx.cloud({action:'load',...next.reference})).status,'queued');
   });
   for(const fault of ['present','tagged','incomplete','cas','reader'])await t.test('I9 create absence '+fault+' cannot release its isolation',async()=>{
    const f=await makeCreate('directory',fault);const result=await f.recover(input=>fault==='cas'?{...input,base_version:99}
     :fault==='reader'?{...input,recovery_reader:{...input.recovery_reader,connection_version:99}}:input);
    assert.notEqual(result.status,'resolved');assert.equal((await ctx.journal(f.job)).version,'3');
    assert.equal(await scalar('select state v from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[f.original.id]),'active');
    assert.equal(await scalar("select count(*)::int v from public.clued_audit_receipts where operation='storage_automatic_reconcile' and target_refs @> $1::jsonb",
     [JSON.stringify([{id:f.original.id}])]),0);
   });
   await t.test('two actual gateway calls return one I9 create absence Receipt',async()=>{
    const f=await makeCreate();await f.recover(()=>{throw Error('pause before first absence submit');});
    const recovery=await createStorageCloudRecovery({client_id:ctx.oauth_client_id,vault:vaultConfig,timeout_ms:2000,
     fetch:async(input,init)=>new URL(String(input)).searchParams.get('q')?.startsWith('appProperties has')
      ?Response.json({files:[],incompleteSearch:false}):f.storage.fetch(input,init),verified:{descriptor:f.descriptor,rpc:ctx.cloud},rpc:ctx.cloud,
     absent:{rpc:async input=>{f.submissions.push(input);throw Error('pause at complete private input');}}});
    await recovery.run(f.job.reference);const input=f.submissions.at(-1);assert.ok(input.proof);
    const left=server.getPgClient(),right=server.getPgClient();await left.connect();await right.connect();
    try{const replies=await Promise.all([left,right].map(client=>workerGatewayRpc(client,'clued_storage_recovery_absent_v1',f.issuer,input)));
     assert.equal(replies[0].status,'resolved');assert.equal(replies[0].receipt_id,replies[1].receipt_id);assert.equal((await ctx.journal(f.job)).version,'4');
    }finally{await left.end();await right.end();}
   });
   await t.test('I9 create absent Receipt failure rolls back its permit, resolution and version',async()=>{
    const f=await makeCreate();await db.query(`create function public.test_create_absent_failure() returns trigger language plpgsql as $$begin
     if new.operation='storage_automatic_reconcile' and new.status='committed' then raise exception 'synthetic_create_absent_failure';end if;return new;end$$;
     create trigger test_create_absent_failure before update on public.clued_audit_receipts for each row execute function public.test_create_absent_failure()`);
    try{assert.notEqual((await f.recover()).status,'resolved');}finally{await db.query('drop trigger test_create_absent_failure on public.clued_audit_receipts;drop function public.test_create_absent_failure()');}
    assert.equal((await ctx.journal(f.job)).version,'3');assert.equal(await scalar('select state v from clued_private.storage_conflict_isolations_v1 where intent_id=$1',[f.original.id]),'active');
    assert.equal(await scalar('select count(*)::int v from clued_private.storage_automatic_reconcile_checks_v1 where intent_id=$1',[f.original.id]),0);
    assert.equal((await f.recover()).status,'resolved');
   });
  }});
  for(const role of ['anon','authenticated','service_role','clued_worker_gateway'])for(const helper of [
   'clued_private.storage_legacy_directory_candidate_v1(clued_private.storage_jobs_v1)',
   'clued_private.storage_legacy_directory_reconcile_v1(text,jsonb)',
   'clued_private.storage_legacy_create_absent_candidate_v1(clued_private.storage_jobs_v1)',
   'clued_private.storage_legacy_create_absent_v1(text,jsonb)',
   'clued_private.storage_absent_before_legacy_create_v1(text,jsonb)',
   'clued_private.storage_automatic_before_directory_v1(text,jsonb)',
   'clued_private.storage_conflict_load_before_directory_v1(text,jsonb)'])
   assert.equal(await scalar('select has_function_privilege($1,$2,\'EXECUTE\') v',[role,helper]),false);
  await assertGatewayCloseoutBoundary(db);
 }finally{
  if(db)await db.end().catch(()=>{});
  if(started&&process.platform==='win32'){
   const child=server.process;
   if(child&&child.exitCode===null&&child.signalCode===null)await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Own disposable PostgreSQL shutdown timed out')),10000);
    child.once('exit',()=>{clearTimeout(timer);resolve();});child.once('error',error=>{clearTimeout(timer);reject(error);});
    if(!child.kill('SIGTERM')){clearTimeout(timer);reject(Error('Own disposable PostgreSQL shutdown refused'));}
   });server.process=undefined;
  }
  if(started)await stopCluster(server);const resolved=await fs.realpath(directory).catch(()=>null);
  if(resolved&&path.dirname(resolved)===parent&&path.basename(resolved).startsWith('kooyumi-legacy-directory-'))
   await removeTestDirectory(resolved);
 }
});
