import { EPHEMERAL_INITDB_FLAGS, EPHEMERAL_POSTGRES_FLAGS, removeTestDirectory } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import {DOMAIN_POLICY as P} from '../worker/model-domain-policy.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';

// Original Task 1502fd80. Real isolated PostgreSQL; no service/production URI.
// Candidate state is NOT_RUN until this file really executes in admitted CI.
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot=path.resolve(appRoot,'../..');
const defaultTestRoot=path.join(repoRoot,'work','host-harness','model-domain-successor-db');
const scope = 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
const projectId = scope.slice(8), taskId = '1502fd80-8ff8-4adc-b4f5-da6d462f4f8a';
const subject = {
  definition_id: 'clued.model-program.DatasetSplit', version: 'v0.1',
  definition_sha256: 'f51cefe8eccd0faa75b45e78380e5b389ed266ca4034b511a85f51771f2d4f77',
  instance_schema_sha256: '062860afd3dc16fa9ee1de27582439701a67b7c5976ad45981a7cca3e515468f',
};
const actions = ['model.dataset_split.verify', 'model.dataset_split.recognize', 'model.dataset_split.producer'];
const uuid = () => crypto.randomUUID(), hash = () => crypto.randomBytes(32).toString('hex');
async function lockedMigrations() {
  // Hold the actual complete migration byte set before starting any scene.
  // No extra Git history, source-substitution argument or network is required.
  const directory=path.join(appRoot,'supabase/migrations');
  const names=(await fs.readdir(directory)).filter(n=>n.endsWith('.sql')).sort();
  assert.ok(names.length>190);
  const held=[];
  for(const name of names){const raw=await fs.readFile(path.join(directory,name));held.push({name,sql:raw.toString('utf8'),sha256:crypto.createHash('sha256').update(raw).digest('hex')});}
  assert.deepEqual((await fs.readdir(directory)).filter(n=>n.endsWith('.sql')).sort(),names,'Migration set must remain stable while capturing source bytes');
  const changes=names.filter(n=>n.endsWith('_model_domain_actor_free_successor.sql'));
  assert.equal(changes.length,1,'Exactly one actor-free successor migration');
  console.log(JSON.stringify({migration_count:names.length,migration_bundle_sha256:crypto.createHash('sha256').update(JSON.stringify(held.map(({name,sha256})=>({name,sha256})))).digest('hex'),successor:changes[0],successor_sha256:held.find(m=>m.name===changes[0]).sha256,full_source_positive:'NOT_RUN_FIXED_CANONICAL_OWNER_SOURCES_UNAVAILABLE'}));
  return held;
}
async function freePort() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port; await new Promise(r => s.close(r)); return p;
}
test('actor-free successor: real M1 normalization and Native denial boundaries only',
  { timeout: 300000 }, async t => {
  const migrationBundle=await lockedMigrations();
  // Host-owned test location, derived from this test's checkout. An override
  // is diagnostic only and must resolve to the very same fixed location.
  if(process.env.M2_TEST_ROOT)assert.equal(path.resolve(process.env.M2_TEST_ROOT).toLowerCase(),path.resolve(defaultTestRoot).toLowerCase(),'M2_TEST_ROOT cannot widen the fixed owned test root');
  const resolvedRoot=path.resolve(defaultTestRoot);
  assert.match(resolvedRoot.replaceAll('\\','/'),/\/work\/host-harness\//i,'Test root must be inside the named workspace work/host-harness boundary');
  await fs.mkdir(resolvedRoot,{recursive:true});
  const testRoot=await fs.realpath(resolvedRoot);
  assert.equal(testRoot.toLowerCase(),resolvedRoot.toLowerCase(),'Symlink/reparse redirected roots are refused');
  const runId=uuid();
  const directory = await fs.mkdtemp(path.join(testRoot, 'clued-model-domain-db-'));
  const databaseDir=path.join(directory,'database');
  const ownership={run_id:runId,root:testRoot,directory,database_dir:databaseDir};
  await fs.writeFile(path.join(directory,'Ownership.json'),JSON.stringify(ownership)+'\n',{flag:'wx'});
  async function ownedBoundary() {
    assert.equal((await fs.realpath(resolvedRoot)).toLowerCase(),testRoot.toLowerCase());
    const actual=await fs.realpath(directory);
    assert.ok(actual.startsWith(testRoot+path.sep)&&path.basename(actual).startsWith('clued-model-domain-db-'));
    assert.equal((await fs.lstat(directory)).isSymbolicLink(),false);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(actual,'Ownership.json'),'utf8')),ownership);
    return actual;
  }
  const tempBefore=Object.fromEntries(['TEMP','TMP','TMPDIR'].map(k=>[k,process.env[k]]));
  for(const key of ['TEMP','TMP','TMPDIR'])process.env[key]=directory;
  const server = new EmbeddedPostgres({
    databaseDir, user: 'postgres', password: hash(), port: await freePort(),
    persistent: true, createPostgresUser:false,
    initdbFlags: EPHEMERAL_INITDB_FLAGS,
    postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS, '-c', 'listen_addresses=127.0.0.1'],
    onLog() {}, onError(message) { process.stderr.write(message + '\n'); },
  });
  let admin,ownProcess,startAttempted=false,initialiseSettled=false;
  try {
    try {await server.initialise();} finally {initialiseSettled=true;}
    startAttempted=true;
    await server.start();ownProcess=server.process;
    assert.ok(ownProcess?.pid,'The fixture must retain its own PostgreSQL child identity');
    await fs.writeFile(path.join(directory,'OwnProcess.json'),JSON.stringify({run_id:runId,pid:ownProcess.pid,database_dir:databaseDir,port:server.options.port})+'\n',{flag:'wx'});
    admin = server.getPgClient('postgres','127.0.0.1'); await admin.connect();
    await admin.query("set statement_timeout='10s'");
    await admin.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    for (const entry of migrationBundle) {
      try { await admin.query(entry.sql); }
      catch (e) { throw new Error('Migration ' + entry.name + ': ' + e.message, { cause: e }); }
    }
    await allowRawTestBindings(admin);
    const userId = uuid(), otherUser = uuid(), token = hash(), otherToken = hash();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'model-fixture@example.invalid',now()),($2,'other-fixture@example.invalid',now())", [userId, otherUser]);
    const bindingId = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Model DB fixture',$2,array['context:read','context:write','audit:read'],array['*']) returning id`, [userId, token])).rows[0].id;
    await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Other DB fixture',$2,array['context:read','context:write'],array['*']) returning id`, [userId, otherToken]);

    let faultTransaction=false,lastNativeTransaction=null;
    const nativeTransactionProof=[];
    async function roleCall(role, sql, params) {
      const ownTransaction=!faultTransaction;
      if(ownTransaction)await admin.query('begin');
      try {
        if(role==='authenticated') {
          assert.equal(faultTransaction,false,'Native issue/consume must each have a distinct committed transaction');
          await admin.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
            [userId,JSON.stringify({sub:userId,role:'authenticated',session_id:'model-fixture-native',aal:'aal1',
              amr:[{method:'password',timestamp:Math.floor(Date.now()/1000)}]})]);
          lastNativeTransaction=(await admin.query('select pg_current_xact_id()::text id')).rows[0].id;
        }
        await admin.query('set local role '+role);
        const result=await admin.query(sql,params);
        if(ownTransaction)await admin.query('commit');else await admin.query('reset role');
        return result;
      } catch(error) {
        if(ownTransaction)await admin.query('rollback');
        throw error;
      }
    }
    const rpc = async (name,input,tk=token) =>
      (await roleCall('anon','select public.'+name+'($1,$2) value',[tk,input])).rows[0].value;
    const project = await rpc('clued_project_mutate',{operation:'create',canonical_project_id:projectId,
      project_schema_version:1,base_version:null,idempotency_key:uuid(),
      mutation:{name:'Synthetic model fixture',progress_status:'active',certainty_status:'confirmed',aliases:[]}});
    assert.equal(project.status,'committed',JSON.stringify(project));
    await admin.query(`insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,
      record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason)
      values($1,$2,'Synthetic model fixture task','Ephemeral DB test only','project',$3,'task','active',1,'active',$4,
      '{"execution_bucket":"next"}','{}','{}','observed','DB fixture')`, [taskId,userId,projectId,scope]);
    const principal = {subject_id:userId,binding_id:bindingId};
    const native = async (name,input) => (await roleCall('authenticated','select public.'+name+'($1) value',[input])).rows[0].value;
    const ref = async id => {
      const m = (await admin.query('select id,version,content_hash from public.clued_memories where id=$1',[id])).rows[0];
      return {id:m.id,version:Number(m.version),content_hash:m.content_hash};
    };
    async function record(type,authority,typeFields) {
      const id = uuid();
      const result = await rpc('clued_record_mutate',{operation:'create',id,record_type:type,record_schema_version:1,
        lifecycle_status:'active',scope,idempotency_key:uuid(),authority,user_confirmed:authority==='user_explicit',
        confidence_reason:'Synthetic isolated DB fixture',source_refs:[],source_unavailable_reason:
          authority==='observed'?'Synthetic isolated PostgreSQL fixture; fictional source projections with no external evidence':null,
        mutation:{title:'Synthetic '+type+' fixture',content:'No real dataset or model content',type_fields:typeFields,relations:{}}});
      assert.equal(result.status,'committed',JSON.stringify(result));
      assert.equal((await admin.query('select count(*)::int n from public.clued_memories where id=$1 and user_id=$2',[id,userId])).rows[0].n,1);
      return id;
    }

    const identity={source:'NATIVE_GRANTEE_AND_M1_RECEIPT_EVENT_ACTOR',identity_not_persisted:true};
    const producerId=await record('state','user_explicit',{identity_binding:identity,state_kind:'model_dataset_split_domain_producer',domain_producer:{
      service:'clued-cloud/supabase',role:'EXISTING_MODEL_DOMAIN_AUTHORITY_DELEGATE',domain_owner:'MODEL PROGRAM',environment:'NON_PRODUCTION',authority_registry_sha256:P.domain.authority_registry_sha256}});
    const producerRef=await ref(producerId);
    const permissionId=await record('decision','user_explicit',{identity_binding:identity,rationale:'Fictional isolated M1 test',domain_permission:{
      status:'active',revoked_at:null,action:'DatasetSplit.definition.recognize',effect:P.domain.effect,environment:'NON_PRODUCTION',canonical_scope:scope,subject,
      producer_registration_ref:producerRef,not_before:new Date(Date.now()-1000).toISOString(),expires_at:new Date(Date.now()+1800000).toISOString()}});
    const permissionRef=await ref(permissionId);
    const ownerSources={owner_adoption_server_ref:{id:P.domain.owner_adoption.canonical_record_id,version:1,content_hash:P.domain.owner_adoption.record_content_sha256},
      final_recognizer_server_ref:P.server.owner_final_recognizer.record_ref,hash_binding:'ORIGINAL_EXACT_SERVER_HASH_GUARD_NO_BODY_HASH_FALLBACK'};
    const recognitionId=await record('state','observed',{identity_binding:identity,state_kind:'model_dataset_split_domain_recognition',owner_source_bindings:ownerSources,
      domain_recognition:{contract_id:P.domain.contract_id,contract_version:P.domain.version,contract_sha256:P.contract_sha256,subject,owner_adoption:P.domain.owner_adoption,
      permission_record_ref:permissionRef,producer_registration_ref:producerRef,producer:{service:'clued-cloud/supabase'},effect:P.domain.effect}});
    const recognitionRef=await ref(recognitionId);
    const recognitionReceipt=(await admin.query('select receipt_id from public.clued_memories where id=$1',[recognitionId])).rows[0].receipt_id;
    const input={permission_record_ref:permissionRef,producer_registration_ref:producerRef,recognition_record_ref:recognitionRef,recognition_receipt_id:recognitionReceipt};
    const verify=(i=input,tk=token)=>rpc('clued_model_dataset_split_verify_successor_candidate',i,tk);
    const normalize=async id=>(await admin.query(`select clued_private.model_domain_normalize_row_successor(b,m) value
      from public.clued_agent_bindings b,public.clued_memories m where b.id=$1 and m.id=$2`,[bindingId,id])).rows[0].value;
    await t.test('genuine M1 chains privately normalize all three actor-free rows without persistent identity',async()=>{
      for(const [id,key] of [[producerId,'domain_producer'],[permissionId,'domain_permission'],[recognitionId,'domain_recognition']]){
        const got=await normalize(id);assert.equal(got.record_currentness,'CURRENT');assert.equal(got.content_hash,got.recomputed_server_content_hash);
        const actual=got.type_fields[key];assert.deepEqual(key==='domain_recognition'?{subject_id:actual.producer.subject_id,binding_id:actual.producer.binding_id}:actual.principal,principal);
        const persistent=(await admin.query('select type_fields,content from public.clued_memories where id=$1',[id])).rows[0];
        assert.ok(!JSON.stringify(persistent).includes(userId));assert.ok(!JSON.stringify(persistent).includes(bindingId));
      }
    });
    async function fault(name,setup,operation,reason){
      await t.test(name,async()=>{faultTransaction=true;await admin.query('begin');
        try{await setup();await assert.rejects(operation,e=>reason.test(e.code+' '+e.message));}
        finally{await admin.query('rollback');faultTransaction=false;}
      });
    }
    // Genuine local M1 Owner-like Decision exercises the general private chain.
    // Its arbitrary ID/hash never replaces fixed b8/46 selectors or constants.
    const ownerLikeId=await record('decision','user_explicit',{rationale:'Fictional isolated Owner-chain regression'});
    const ownerReceipt=(await admin.query('select receipt_id from public.clued_memories where id=$1',[ownerLikeId])).rows[0].receipt_id;
    const ownerChain=async (readBinding=bindingId)=>(await admin.query(`select clued_private.model_domain_owner_chain_successor(b,m) value
      from public.clued_agent_bindings b,public.clued_memories m where b.id=$1 and m.id=$2`,[readBinding,ownerLikeId])).rows[0].value;
    await t.test('Owner M1 chain preserves historical writer Binding across current same-owner readers',async()=>{
      const historical=await ownerChain();assert.equal(historical.receipt.id,ownerReceipt);assert.equal(historical.event.actor_binding_ref,bindingId);
      const reader=(await admin.query("select id from public.clued_agent_bindings where user_id=$1 and agent_name='Other DB fixture'",[userId])).rows[0].id;
      assert.notEqual(reader,bindingId);assert.deepEqual(await ownerChain(reader),historical);
    });
    await fault('Owner helper direct anon execution denied',async()=>{},()=>roleCall('anon','select clued_private.model_domain_owner_chain_successor(null,null)'),/42501/);
    await fault('Owner Receipt must be committed',()=>admin.query("update public.clued_audit_receipts set status='rejected' where id=$1",[ownerReceipt]),()=>ownerChain(),/OWNER_M1_RECEIPT_TARGET_VERSION_INVALID/);
    await fault('Owner Receipt exact target required',()=>admin.query("update public.clued_audit_receipts set target_refs='[]' where id=$1",[ownerReceipt]),()=>ownerChain(),/OWNER_M1_RECEIPT_TARGET_VERSION_INVALID/);
    await fault('Owner Receipt exact committed version required',()=>admin.query('update public.clued_audit_receipts set committed_versions=jsonb_build_object($2::text,2) where id=$1',[ownerReceipt,ownerLikeId]),()=>ownerChain(),/OWNER_M1_RECEIPT_TARGET_VERSION_INVALID/);
    await fault('Owner Event actor must match Receipt writer Binding',()=>admin.query('update public.clued_context_events set actor_binding_ref=null where receipt_id=$1',[ownerReceipt]),()=>ownerChain(),/OWNER_M1_EVENT_ACTOR_TRANSACTION_INVALID/);
    await fault('Owner Event actor user must match actual owner',()=>admin.query('update public.clued_context_events set actor_user_id=$2 where receipt_id=$1',[ownerReceipt,otherUser]),()=>ownerChain(),/OWNER_M1_EVENT_ACTOR_TRANSACTION_INVALID/);
    await fault('Owner Event success required',()=>admin.query("update public.clued_context_events set result='failure' where receipt_id=$1",[ownerReceipt]),()=>ownerChain(),/OWNER_M1_EVENT_ACTOR_TRANSACTION_INVALID/);
    await fault('Owner Event and Receipt Canonical versions must agree',()=>admin.query('update public.clued_context_events set committed_canonical_version=committed_canonical_version+1 where receipt_id=$1',[ownerReceipt]),()=>ownerChain(),/OWNER_M1_EVENT_ACTOR_TRANSACTION_INVALID/);
    const rehash=id=>admin.query(`update public.clued_memories m set content_hash=clued_private.m1_record_content_hash(
      m.record_type,m.canonical_scope,m.lifecycle_status,m.title,m.content,m.type_fields,m.relations,m.source_refs,
      m.source_unavailable_reason,m.authority,m.observed_at,m.closed_at,m.confidence,m.confidence_reason) where id=$1`,[id]);
    await fault('generic permission cannot read private normalizer',async()=>{},()=>roleCall('anon','select clued_private.model_domain_normalize_row_successor(null,null)'),/42501/);
    await fault('wrong M1 Receipt actor denied',()=>admin.query('update public.clued_audit_receipts set binding_id=null where id=$1',[recognitionReceipt]),()=>normalize(recognitionId),/PRIVATE_MODEL_M1_TRANSACTION_NOT_BOUND/);
    await fault('wrong M1 Event actor denied',()=>admin.query('update public.clued_context_events set actor_binding_ref=null where receipt_id=$1',[recognitionReceipt]),()=>normalize(recognitionId),/PRIVATE_MODEL_M1_EVENT_ACTOR_NOT_BOUND/);
    await fault('server hash corruption cannot become a local body-hash alias',()=>admin.query("update public.clued_memories set content_hash=repeat('f',64) where id=$1",[producerId]),()=>normalize(producerId),/PRIVATE_MODEL_SERVER_CONTENT_HASH_INVALID/);
    await fault('missing actor-free identity marker denied',async()=>{await admin.query("update public.clued_memories set type_fields=type_fields-'identity_binding' where id=$1",[producerId]);await rehash(producerId);},()=>normalize(producerId),/ACTOR_FREE_DOMAIN_IDENTITY_BINDING_REQUIRED/);
    await fault('persisted principal denied even with real full hash',async()=>{await admin.query("update public.clued_memories set type_fields=jsonb_set(type_fields,'{domain_permission,principal}',$2,true) where id=$1",[permissionId,JSON.stringify(principal)]);await rehash(permissionId);},()=>normalize(permissionId),/PRIVATE_IDENTITY_MUST_NOT_BE_PERSISTED/);
    await fault('unknown top-level Actor slot denied',async()=>{await admin.query("update public.clued_memories set type_fields=type_fields||jsonb_build_object('actor_user_id',$2::text) where id=$1",[producerId,userId]);await rehash(producerId);},()=>normalize(producerId),/ACTOR_FREE_DOMAIN_TEMPLATE_SHAPE_REQUIRED/);
    await fault('normalization cannot erase a substituted persistent producer',async()=>{await admin.query("update public.clued_memories set type_fields=jsonb_set(type_fields,'{domain_recognition,producer}','{\"service\":\"forged\"}',true) where id=$1",[recognitionId]);await rehash(recognitionId);},()=>normalize(recognitionId),/ACTOR_FREE_RECOGNITION_PRODUCER_SHAPE_REQUIRED/);
    await fault('normalization cannot erase unknown producer fields',async()=>{await admin.query("update public.clued_memories set type_fields=jsonb_set(type_fields,'{domain_recognition,producer}','{\"service\":\"clued-cloud/supabase\",\"verified\":true}',true) where id=$1",[recognitionId]);await rehash(recognitionId);},()=>normalize(recognitionId),/ACTOR_FREE_RECOGNITION_PRODUCER_SHAPE_REQUIRED/);
    await fault('empty Native permissions block source before any Canonical rows',async()=>{},verify,/INDEPENDENT_NATIVE_GRANT_MISSING_OR_AMBIGUOUS/);
    await fault('caller authority fields rejected',async()=>{},()=>verify({...input,verified:true}),/CALLER_CONTEXT_OR_UNKNOWN_FIELD/);
    async function nativeGrant(action,r){
      const requested=await rpc('clued_owner_request_v1',{scope,action,resources:['record:'+r.id+'@'+r.version+'#'+r.content_hash],task_id:taskId,
        suggested_grant:{expires_seconds:3600},idempotency_key:'successor-'+uuid(),agent_note:'Fictional isolated PostgreSQL test'});
      assert.equal(requested.status,'committed',JSON.stringify(requested));
      const issued=await native('clued_owner_grant_confirmation_issue_v1',{request_id:requested.request.request_id,choice:'grant',expires_seconds:3600});
      assert.equal(issued.status,'issued',JSON.stringify(issued));const issueTransaction=lastNativeTransaction;
      const granted=await native('clued_owner_grant_v1',{confirmation_token:issued.confirmation_token,view_digest:issued.view_digest});
      assert.equal(granted.status,'committed',JSON.stringify(granted));assert.notEqual(lastNativeTransaction,issueTransaction);
      nativeTransactionProof.push({issue_transaction:issueTransaction,consume_transaction:lastNativeTransaction});return granted.grant.grant_id;
    }
    const grantIds=[];
    for(const action of actions)grantIds.push(await nativeGrant(action,action.endsWith('.producer')?producerRef:permissionRef));
    // No synthetic hash overwrite, M1 helper replacement, fake canonical Owner
    // or success-shaped source DTO is used to manufacture a full-source positive.
    await fault('real M1 plus Native approvals still fail without exact Canonical Owner anchors',async()=>{},verify,/SUCCESSOR_FIXED_OWNER_SOURCE_NOT_CURRENT/);
    await fault('corrupt Native receipt provenance rejected before records',()=>admin.query("update public.clued_audit_receipts set metadata=metadata||'{\"principal\":\"forged\"}' where id=(select receipt_id from clued_private.owner_grants_v1 where id=$1)",[grantIds[0]]),verify,/SOURCE_NATIVE_CONFIRMATION_NOT_EXACT/);
    await fault('revoked same-Binding grant rejected before records',()=>admin.query('update clued_private.owner_grants_v1 set revoked_at=clock_timestamp() where id=$1',[grantIds[0]]),verify,/INDEPENDENT_NATIVE_GRANT_MISSING_OR_AMBIGUOUS/);
    await fault('another Binding cannot borrow current Native grants',async()=>{},()=>verify(input,otherToken),/INDEPENDENT_NATIVE_GRANT_MISSING_OR_AMBIGUOUS/);
    const acl=(await admin.query(`select
      has_function_privilege('anon','public.clued_model_dataset_split_verify_successor_candidate(text,jsonb)','EXECUTE') verify,
      has_function_privilege('anon','clued_private.model_domain_normalize_row_successor(public.clued_agent_bindings,public.clued_memories)','EXECUTE') normal,
      has_function_privilege('authenticated','public.clued_model_dataset_split_verify_successor_candidate(text,jsonb)','EXECUTE') human,
      has_function_privilege('service_role','public.clued_model_dataset_split_verify_successor_candidate(text,jsonb)','EXECUTE') service`)).rows[0];
    assert.deepEqual(acl,{verify:true,normal:false,human:false,service:false});
    assert.equal(nativeTransactionProof.length,3);
  } finally {
    if(admin) {try {await admin.end();} catch {}}
    ownProcess??=server.process;
    let cleanup=false,stopError=null,stopTimer;
    try {
      await ownedBoundary();
      if(ownProcess) {
        const exited=()=>typeof ownProcess.exitCode==='number'||typeof ownProcess.signalCode==='string';
        if(exited())cleanup=true; // Never invoke the SDK's Windows PID kill on an already exited child.
        else {
          assert.equal(server.process,ownProcess,'Stop may affect only the retained own ChildProcess');
          const ownMarker=JSON.parse(await fs.readFile(path.join(directory,'OwnProcess.json'),'utf8'));
          assert.equal(ownMarker.pid,ownProcess.pid);assert.equal(ownMarker.run_id,runId);assert.equal(ownMarker.database_dir,databaseDir);
          const postmaster=(await fs.readFile(path.join(databaseDir,'postmaster.pid'),'utf8')).split(/\r?\n/)[0];
          assert.equal(Number(postmaster),ownProcess.pid,'The owned datadir must name this exact PostgreSQL child');
          await Promise.race([server.stop(),new Promise((_,reject)=>{stopTimer=setTimeout(()=>reject(new Error('OWN_POSTGRES_STOP_TIMEOUT')),15000);})]);
          cleanup=exited();
        }
      } else cleanup=!startAttempted&&initialiseSettled;
    } catch(error) {stopError=error.message;}
    finally {
      clearTimeout(stopTimer);
      for(const [key,value] of Object.entries(tempBefore)) {
        if(value===undefined)delete process.env[key];else process.env[key]=value;
      }
    }
    if(cleanup) {
      const actual=await ownedBoundary();
      await removeTestDirectory(actual);
    } else {
      await fs.writeFile(path.join(directory,'NO_CLEANUP.json'),JSON.stringify({run_id:runId,pid:ownProcess?.pid??null,database_dir:databaseDir,stop_error:stopError,reason:'Own process exit was not proven; directory preserved'})+'\n');
      throw new Error('NO_CLEANUP: own PostgreSQL exit was not proven; preserve '+directory);
    }
  }
});


