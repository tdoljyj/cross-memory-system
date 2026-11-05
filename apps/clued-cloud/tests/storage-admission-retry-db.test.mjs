// Real disposable PostgreSQL. Synthetic identities/time/Drive transport only;
// these tests never query production, change a real grant or mutate Google.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import {build} from 'esbuild';
import {stopOwnedPostgres} from './model-domain-postgres-lifecycle.fixture.mjs';
import {batchRequests,batchReply} from './google-batch-fixture.mjs';
import {createStorageCredentialVault} from '../worker/storage-credential-vault.ts';
import {scopeString} from '../worker/storage-google-scopes.ts';
import {allowRawTestBindings} from './raw-binding-grants-fixture.mjs';
import {setWorkerGatewayCaller} from './worker-gateway-caller-fixture.mjs';
import {testStorageDestructive} from './resource-center-storage-destructive-db.fixture.mjs';
const cloud=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const uuid=()=>crypto.randomUUID();
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));
 const p=s.address().port;await new Promise(r=>s.close(r));return p;}

test('admission rollback recovery: real PostgreSQL and private Worker',{timeout:240000},async t=>{
 const parent=await fs.realpath(os.tmpdir()),directory=await fs.mkdtemp(path.join(parent,'kooyumi-registration-db-'));
 const databaseDir=path.join(directory,'database'),runId=uuid();
 const ownership={run_id:runId,parent,directory,database_dir:databaseDir};
 await fs.writeFile(path.join(directory,'Ownership.json'),JSON.stringify(ownership)+'\n',{flag:'wx'});
 const ownedBoundary=async()=>{
  assert.equal(await fs.realpath(parent),parent);
  const actual=await fs.realpath(directory);
  assert.equal(actual,directory);assert.equal(path.dirname(actual),parent);
  assert.ok(path.basename(actual).startsWith('kooyumi-registration-db-'));
  assert.equal((await fs.lstat(directory)).isSymbolicLink(),false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(actual,'Ownership.json'),'utf8')),ownership);
  return actual;
 };
 const server=new EmbeddedPostgres({databaseDir,user:'postgres',password:uuid(),port:await port(),persistent:true,
  postgresFlags:['-c','listen_addresses=127.0.0.1'],onLog(){},onError(){}});
 let db,native,retainedChild,startAttempted=false,initialiseSettled=false;
 try{
  try{await server.initialise();}finally{initialiseSettled=true;}
  startAttempted=true;
  try{await server.start();}finally{
   retainedChild=server.process;
   if(retainedChild?.pid)await fs.writeFile(path.join(directory,'OwnProcess.json'),JSON.stringify({
    run_id:runId,pid:retainedChild.pid,database_dir:databaseDir,port:server.options.port})+'\n',{flag:'wx'});
  }
  assert.ok(retainedChild?.pid,'Retain the exact owned PostgreSQL child');
  db=server.getPgClient();await db.connect();
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
  await testStorageDestructive(t,db,server,owner,decision,{gateway:true,only_extra:true,extra_cases:async ctx=>{


   const bundle=await build({stdin:{contents:"export {createStorageCloudWorker} from './worker/storage-cloud-executor.ts';",
    resolveDir:cloud},bundle:true,platform:'node',format:'esm',write:false});
   const {createStorageCloudWorker}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
   const caller=server.getPgClient(),blocker=server.getPgClient();await caller.connect();await blocker.connect();
   await setWorkerGatewayCaller(caller);
   const rpc=input=>ctx.cloud(input,caller);
   const row=async job=>(await db.query(`select j.intent_id,j.dispatch_outcome,j.request_digest,
    (select count(*)::int from clued_private.resource_center_mutations_v1 m where m.user_id=j.owner_id
      and m.request_key='account-job:'||j.job_id::text) as matching_intents
    from clued_private.storage_jobs_v1 j where j.owner_id=$1 and j.job_id=$2`,[owner,job.reference.job_id])).rows[0];
   const postgresError=error=>Object.assign(new Error(error.message),{status:500,details:{code:error.code}});
   const setup=async()=>{
    const f=await ctx.setup();
    const vaultConfig={current_key_id:'synthetic',keys:{synthetic:crypto.randomBytes(32).toString('base64url')}};
    const vault=await createStorageCredentialVault(vaultConfig);
    const envelope=await vault.seal(JSON.stringify({token_type:'Bearer',access_token:ctx.access_token,
      scope:scopeString('full'),expires_at_ms:Date.now()+3600000}),{owner_id:owner,connection_id:f.target.connection,
      provider:'google-drive',provider_subject:ctx.provider_subject,oauth_client_id:ctx.oauth_client_id,credential_version:1});
    await db.query('update clued_private.storage_connections_v1 set credential_envelope=$2 where id=$1',[f.target.connection,JSON.stringify(envelope)]);
    let posts=0;
    const fetch=async(url,init={})=>{
     const u=new URL(url);
     if(u.href==='https://www.googleapis.com/batch/drive/v3'){
      return batchReply(await Promise.all(batchRequests(init.body).map(async part=>{
       const reply=await f.storage.fetch(new URL(part.path,u.origin),{method:'GET',headers:init.headers});
       return {...part,status:reply.status,value:await reply.json()};
      })));
     }
     if(init.method==='POST')posts++;
     return f.storage.fetch(url,init);
    };
    const job=await ctx.submitJob(f.target,f.client,{operation:'create',target_kind:'file',
      destination_path:f.target.root+'/20_P_产品与体验/admission-'+uuid()+'.txt',content:'same exact original content'});
    const worker=privateRpc=>createStorageCloudWorker({client_id:ctx.oauth_client_id,vault:vaultConfig,
      account_policy_v2:true,fetch,rpc:privateRpc??rpc});
    return {...f,job,worker,posts:()=>posts};
   };
   // A second real PostgreSQL connection holds this exact original job row.
   // PostgreSQL itself cancels this begin; no fake rollback boolean is used.
   const cancelBegin=async(f,input)=>{
    await blocker.query('begin');
    try{
     await blocker.query('select job_id from clued_private.storage_jobs_v1 where owner_id=$1 and job_id=$2 for update',[owner,f.job.reference.job_id]);
     await caller.query("set statement_timeout='80ms'");
     let aborted;
     try{await rpc(input);}catch(error){aborted=error;}
     assert.equal(aborted?.code,'57014','the real begin must be cancelled by PostgreSQL');
     assert.equal(aborted.message,'canceling statement due to statement timeout');
     const stored=await row(f.job);
     assert.equal(stored.intent_id,null);assert.equal(stored.dispatch_outcome,null);
     assert.equal(stored.matching_intents,0);assert.equal(f.posts(),0);
     throw postgresError(aborted);
    }finally{await caller.query("set statement_timeout='10s'");await blocker.query('rollback');}
   };
   try{
    await t.test('a Native terminal settlement before retry-load keeps its real denial Receipt and skips any second begin',async()=>{
     const f=await setup();let begins=0,reports=0,settled;
     const engine=await f.worker(async input=>{
      if(input.action==='begin'){
       begins++;
       try{return await cancelBegin(f,input);}catch(error){
        // Another authorized program can settle the original queued job after
        // this transaction rolled back and before its authenticated reload.
        settled=await rpc({...f.job.reference,action:'report',credential_version:1,
          outcome:{status:'denied',reason:{code:'STORAGE_OBJECT_UNDER_REVIEW'}}});
        throw error;
       }
      }
      if(input.action==='report')reports++;
      return rpc(input);
     });
     const result=await engine.run(f.job.reference);
     assert.equal(result.status,'denied');assert.equal(result.reason_code,'STORAGE_OBJECT_UNDER_REVIEW');
     assert.equal(result.receipt_id,settled.receipt_id);assert.equal(result.job_id,f.job.reference.job_id);
     assert.equal(result.execution_permitted,false);assert.equal(begins,1);assert.equal(reports,0);assert.equal(f.posts(),0);
     const stored=await row(f.job);assert.equal(stored.intent_id,null);assert.equal(stored.matching_intents,0);
     assert.equal(stored.dispatch_outcome.status,'denied');
    });
    await t.test('timeout after prepare and start rolls back the intent, job link and new Receipts before one safe retry',async()=>{
     const f=await setup();let begins=0;
     await db.query(`create function clued_private.admission_retry_test_pause() returns trigger
      language plpgsql security definer set search_path='' as $body$ begin
       if new.job_id=tg_argv[0]::uuid and new.intent_id is not null then perform pg_catalog.pg_sleep(1);end if;
       return new;end $body$;
      revoke all on function clued_private.admission_retry_test_pause() from public,anon,authenticated,service_role,clued_worker_gateway;`);
     const engine=await f.worker(async input=>{
      if(input.action==='begin'&&++begins===1){
       assert.match(f.job.reference.job_id,/^[0-9a-f-]{36}$/);
       await db.query("create trigger admission_retry_test_pause after update of intent_id on clued_private.storage_jobs_v1 for each row execute function clued_private.admission_retry_test_pause('"+f.job.reference.job_id+"')");
       const receiptCount=(await db.query('select count(*)::int n from public.clued_audit_receipts where user_id=$1',[owner])).rows[0].n;
       let aborted;
       try{await caller.query("set statement_timeout='80ms'");await rpc(input);}catch(error){aborted=error;}
       finally{await caller.query("set statement_timeout='10s'");await db.query('drop trigger admission_retry_test_pause on clued_private.storage_jobs_v1');}
       assert.equal(aborted?.code,'57014');assert.equal(aborted.message,'canceling statement due to statement timeout');
       const stored=await row(f.job);assert.equal(stored.intent_id,null);assert.equal(stored.matching_intents,0);assert.equal(stored.dispatch_outcome,null);
       assert.equal((await db.query('select count(*)::int n from public.clued_audit_receipts where user_id=$1',[owner])).rows[0].n,receiptCount);
       assert.equal(f.posts(),0);throw postgresError(aborted);
      }
      return rpc(input);
     });
     try{assert.equal((await engine.run(f.job.reference)).status,'committed');assert.equal(begins,2);assert.equal(f.posts(),1);}
     finally{await db.query('drop trigger if exists admission_retry_test_pause on clued_private.storage_jobs_v1');await db.query('drop function clued_private.admission_retry_test_pause()');}
    });
    await t.test('two confirmed transaction rollbacks re-read the same queued job, then one start and one provider effect commit',async()=>{
     const f=await setup(),attempts=[];let failures=0;
     const before=await row(f.job);
     const engine=await f.worker(async input=>{
      if(input.action==='begin'){
       attempts.push(structuredClone(input));
       if(failures++<2)return cancelBegin(f,input);
      }
      return rpc(input);
     });
     const result=await engine.run(f.job.reference);
     assert.equal(result.status,'committed',JSON.stringify(result));assert.equal(f.posts(),1);
     assert.equal(attempts.length,3);assert.deepEqual(attempts[1],attempts[0]);assert.deepEqual(attempts[2],attempts[0]);
     const after=await row(f.job);assert.equal(after.request_digest,before.request_digest);
     assert.equal(after.matching_intents,1);assert.notEqual(after.intent_id,null);
     assert.equal((await ctx.journal(f.job)).state,'committed');
    });
    await t.test('exhausted rollback retries preserve the original queued job; a later real executor commits it once',async()=>{
     const f=await setup();let begins=0,reports=0;
     const engine=await f.worker(async input=>{
      if(input.action==='begin'){begins++;return cancelBegin(f,input);}
      if(input.action==='report')reports++;
      return rpc(input);
     });
     const result=await engine.run(f.job.reference);
     assert.equal(result.status,'unavailable');assert.equal(result.error_code,'STORAGE_ADMISSION_RETRY_PENDING');
     assert.equal(begins,3);assert.equal(reports,0);assert.equal(f.posts(),0);
     const queued=await row(f.job);assert.equal(queued.intent_id,null);assert.equal(queued.dispatch_outcome,null);assert.equal(queued.matching_intents,0);
     const unrelated=await setup();assert.equal((await(await unrelated.worker()).run(unrelated.job.reference)).status,'committed');
     assert.equal(unrelated.posts(),1,'the failure must not hold unrelated storage');
     assert.equal((await(await f.worker()).run(f.job.reference)).status,'committed');assert.equal(f.posts(),1);
     assert.equal((await row(f.job)).request_digest,queued.request_digest);
    });
    await t.test('an actually committed begin with a lost reply is not retried; report returns the real original started journal',async()=>{
     const f=await setup();let begins=0,reports=0;
     const engine=await f.worker(async input=>{
      if(input.action==='begin'){begins++;await rpc(input);throw new Error('synthetic lost HTTP reply');}
      if(input.action==='report')reports++;
      return rpc(input);
     });
     const result=await engine.run(f.job.reference);
     assert.equal(result.status,'inspection_required');assert.equal(begins,1);assert.equal(reports,1);assert.equal(f.posts(),0);
     const stored=await row(f.job);assert.notEqual(stored.intent_id,null);assert.equal(stored.dispatch_outcome,null);assert.equal(stored.matching_intents,1);
     const original=await ctx.journal(f.job);assert.equal(original.state,'started');assert.equal(original.provider_attempt,null);
    });
    await t.test('a real database business rejection is never retried or converted to a transient permit',async()=>{
     const f=await setup();let begins=0;
     const engine=await f.worker(async input=>{
      if(input.action==='begin'){
       begins++;
       const invalid=structuredClone(input);invalid.prepare.action='invalid';
       try{return await rpc(invalid);}catch(error){assert.equal(error.code,'42501');throw postgresError(error);}
      }
      return rpc(input);
     });
     const result=await engine.run(f.job.reference);
     assert.equal(result.status,'deny');assert.equal(begins,1);assert.equal(f.posts(),0);
     const stored=await row(f.job);assert.equal(stored.intent_id,null);assert.equal(stored.matching_intents,0);
     assert.equal(stored.dispatch_outcome.status,'denied');
    });
   }finally{await blocker.query('rollback');await caller.end();await blocker.end();}
  }});
 }finally{
  if(native){try{await native.end();}catch{}}if(db){try{await db.end();}catch{}}
  let cleanup=false,diagnostic={stage:'ownership',code:'OWNED_DIRECTORY_NOT_VERIFIED',
   exit_code:retainedChild?.exitCode??null,signal_code:retainedChild?.signalCode??null};
  try{
   await ownedBoundary();
   if(retainedChild){
    const result=await stopOwnedPostgres({server,child:retainedChild,timeoutMs:15000,verifyIdentity:async()=>{
     await ownedBoundary();
     assert.equal(await fs.realpath(databaseDir),databaseDir);
     assert.equal((await fs.lstat(databaseDir)).isSymbolicLink(),false);
     assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory,'OwnProcess.json'),'utf8')),
      {run_id:runId,pid:retainedChild.pid,database_dir:databaseDir,port:server.options.port});
     const postmaster=(await fs.readFile(path.join(databaseDir,'postmaster.pid'),'utf8')).split(/\r?\n/)[0];
     assert.equal(Number(postmaster),retainedChild.pid);
    }});
    cleanup=result.cleanup;diagnostic=result.diagnostic;
   }else{
    cleanup=!startAttempted&&initialiseSettled;
    diagnostic={stage:'initialise',code:cleanup?'NO_POSTGRES_START_ATTEMPT':'POSTGRES_CHILD_NOT_RETAINED',
     exit_code:null,signal_code:null};
   }
  }catch{
   // An ownership error never authorizes a signal or recursive deletion.
  }
  let sdkProcessReferenceCleared=false;
  // An already-exited child skips SDK stop. Prevent its global exit hook
  // from stopping that same old PID later; never clear a new or live child.
  if(cleanup&&retainedChild&&server.process===retainedChild&&
   (typeof retainedChild.exitCode==='number'||typeof retainedChild.signalCode==='string')){
   server.process=undefined;sdkProcessReferenceCleared=true;
  }
  if(cleanup){
   retainedChild?.stdin?.destroy();retainedChild?.stdout?.destroy();retainedChild?.stderr?.destroy();
   const actual=await ownedBoundary();
   await fs.rm(actual,{recursive:true,force:false,maxRetries:20,retryDelay:250});
   await assert.rejects(fs.lstat(actual),{code:'ENOENT'});
   console.log(JSON.stringify({fixture_cleanup:'OWN_PROCESS_EXIT_AND_OWN_DIRECTORY_REMOVAL_PROVEN',
    fixture_directory:directory,retained_child_pid:retainedChild?.pid??null,...diagnostic,directory_removed:true,
    postgres_stop_timeout_ms:15000,sdk_process_reference_cleared:sdkProcessReferenceCleared}));
  }else{
   console.error(JSON.stringify({fixture_cleanup:'NO_CLEANUP',fixture_directory:directory,
    retained_child_pid:retainedChild?.pid??null,...diagnostic,directory_removed:false,postgres_stop_timeout_ms:15000}));
   throw Error('NO_CLEANUP: '+diagnostic.code+'; preserve owned PostgreSQL directory '+directory);
  }
 }
});
