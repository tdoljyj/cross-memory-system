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
const cloud=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const uuid=()=>crypto.randomUUID();
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));
 const p=s.address().port;await new Promise(r=>s.close(r));return p;}

test('registration reconciliation: actual program authority, independent of the original Agent',{timeout:240000},async t=>{
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
   const f=await ctx.setup(),source=await ctx.directoryIn(f.target,f.storage,'registered-'+uuid());
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
   await t.test('forged GUC is not an external credential and helper is owner-only',async()=>{
    const identity=await scalar("select id v from clued_private.issuer_identities_v1 where kind='storage' and legacy_key=$1",[issuer]);
    for(const role of ['anon','authenticated','service_role','clued_worker_gateway']){
     assert.equal(await scalar("select has_function_privilege($1,'clued_private.storage_registration_program_authority_v1(text,uuid,uuid,uuid)','execute') v",[role]),false);
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
   await server.stop();
   producer?.stdin?.destroy();producer?.stdout?.destroy();producer?.stderr?.destroy();
   await closed;
  }
  const actual=await fs.realpath(directory);assert.equal(path.dirname(actual).toLowerCase(),parent.toLowerCase());
  assert.ok(path.basename(actual).startsWith('kooyumi-registration-db-'));
  await fs.rm(actual,{recursive:true,force:false});
 }
});
