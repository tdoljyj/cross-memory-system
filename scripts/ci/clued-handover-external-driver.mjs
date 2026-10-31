// Candidate integration destination: scripts/ci/clued-handover-external-driver.mjs.
// No production Binding/Supabase/Worker transport exists in this driver.
import assert from 'node:assert/strict';
export const COMPONENT_VERSION = "1.0.3";
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {fixtureEnvironment,guardedProvider,publishWithSource,revokeWithSource,projectRegisteredRuntimeProfile}
  from './clued-handover-external-provider.mjs';
import {postAppCheckCore} from './clued-work-admission.mjs';
import {acceptedSourceCheck,acceptedGateSourcePins} from './clued-handover-external-source-check.mjs';
import {readCanonicalGate,createEvidenceReaders,createImmutableSourceReaderCache} from './clued-handover-external-gate-evidence.mjs';
import {resolveFixtureLocator} from './clued-handover-external-fixture-locator.mjs';
import {verifyEmptyCluster} from './clued-handover-external-catalog.mjs';
import {platformDescriptor,verifySupabasePlatform} from './clued-handover-external-bootstrap.mjs';
import {preparePgTransport,makePgClientConfig,PG_IDENTITY_SQL,assertPgIdentity} from './clued-handover-external-pg-transport.mjs';
import {cancellationJournal,validateCompleted,assertIdleSelectionPolicy,assertEarlyFixtureLocators,applyFixtureLocator,assertCanonicalClaimMatch,assertQualifierRun,makeIdleBinding,assertBoundIdleObservation,providerGetBudget}
  from './clued-handover-external-journal.mjs';

const sha = value=>crypto.createHash('sha256').update(value).digest('hex');
const uuid = ()=>crypto.randomUUID();
const quote = value=>'"'+value.replaceAll('"','""')+'"';
const qtable = name=>name.split('.').map(quote).join('.');
const workspace=process.env.GITHUB_WORKSPACE;
const actualFile=fileURLToPath(import.meta.url);
const outputRoot=path.join(process.env.RUNNER_TEMP??os.tmpdir(),'clued-handover-evidence');
const numeric=value=>/^[0-9]{1,20}$/.test(String(value));
const getBudget=providerGetBudget();
const boundedRealFetch=(url,init={})=>{
  if((init.method??'GET')==='GET')getBudget.take();
  return fetch(url,init);
};
const sourceCache=createImmutableSourceReaderCache({repository:'tdoljyj/cross-memory-system'});
const evidenceReaders=createEvidenceReaders({repository:'tdoljyj/cross-memory-system',
  token:process.env.GITHUB_TOKEN,realFetch:boundedRealFetch,sourceCache});
function safeSummary(phase,body) {
  return {schema:'clued.disposable-external-qualification-evidence.candidate/1',
    fixture_only:true,canonical_authority:'none',production_qualified:false,
    phase,observed_at:new Date().toISOString(),provider_get_count:getBudget.count,...body};
}
async function saveSafe(name,value) {
  const encoded=JSON.stringify(value,null,2);
  assert.ok(!/clued_(lk|wch|bnd|rk)_|BEGIN .*PRIVATE KEY|github_pat_/.test(encoded),'unsafe evidence');
  await fs.mkdir(outputRoot,{recursive:true,mode:0o700});
  await fs.writeFile(path.join(outputRoot,name),encoded,{mode:0o600});
}
async function loadProfile() {
  const verified=acceptedSourceCheck(workspace,process.env);
  const p=verified.profile;
  assert.equal(p.fixture_mode,'continuous','RECOVERY_UNSUPPORTED');
  platformDescriptor(p);
  assert.equal(p.project_id,'0597aa60-9b98-4da6-a4ab-63d7705b632f');
  assert.equal(p.engineering_task_id,'6176fdcc-c5b0-46c9-9769-d5e0bc0ce4f8');
  assertEarlyFixtureLocators(p);
  assertIdleSelectionPolicy(p);
  const selected=process.env.QUALIFICATION_IDLE_RUN_ID??'';
  if(process.env.QUALIFICATION_PHASE==='publish'){
    assert.match(selected,/^[1-9][0-9]{0,19}$/);assert.notEqual(selected,process.env.GITHUB_RUN_ID);
  }else assert.equal(selected,'','REVOKE_IDLE_RESELECTION_PROHIBITED');
  assert.equal(Number(process.env.GITHUB_RUN_ATTEMPT),1);
  assert.ok(Date.parse(p.valid_until)>Date.now());
  return {...p,idle_run_id:selected||null,gate_source_pins:acceptedGateSourcePins(verified),profile_hash:verified.profile_sha256,runtime_source_commit:verified.source_commit,
    accepted_source_commit:verified.accepted_source_commit,acceptance_sha256:verified.acceptance_sha256};
}
function testCiProof() {
  const proof=process.env.QUALIFICATION_TEST_CI_PROOF??'';
  assert.match(proof,/^[0-9a-f]{64}$/,'dedicated synthetic fixture CI Host proof missing');
  return proof;
}
async function api(route,{method='GET',body}={}) {
  assert.ok(route.startsWith('/repos/tdoljyj/cross-memory-system/'));
  const r=await boundedRealFetch('https://api.github.com'+route,{method,redirect:'error',signal:AbortSignal.timeout(20000),
    headers:{accept:'application/vnd.github+json',authorization:'Bearer '+process.env.GITHUB_TOKEN,
      'x-github-api-version':'2022-11-28','user-agent':'clued-disposable-qualification'},
    ...(body?{body:JSON.stringify(body)}:{})});
  assert.ok(r.ok,'GitHub observation '+r.status);
  return r.status===204?null:r.json();
}
async function observeHostRun(p,id,{completed=false,successful=true}={}) {
  assert.ok(numeric(id));
  const run=await api('/repos/'+p.repository+'/actions/runs/'+id);
  assert.equal(run.repository.full_name,p.repository);
  assert.equal(run.head_repository.full_name,p.repository);
  assert.equal(run.event,'workflow_dispatch');assert.equal(run.run_attempt,1);
  assert.equal(run.path,'.github/workflows/'+p.qualifier_workflow);
  assert.equal(run.head_sha,p.runtime_source_commit);
  if(completed){assert.equal(run.status,'completed');if(successful)assert.equal(run.conclusion,'success');}
  else assert.equal(String(run.id),process.env.GITHUB_RUN_ID);
  assertQualifierRun(p,run,{id,completed});
  return {id:String(run.id),status:run.status,conclusion:run.conclusion,path:run.path,
    head_sha:run.head_sha,run_attempt:run.run_attempt,created_at:run.created_at,updated_at:run.updated_at};
}
async function openFixture(p,phase) {
  assert.equal(p.fixture_mode,'continuous','RECOVERY_UNSUPPORTED');
  const transport=preparePgTransport(p);
  const req=createRequire(path.join(workspace,'apps/clued-cloud/package.json'));
  const Pg=(await import(pathToFileURL(req.resolve('pg')).href)).default;
  const raw=process.env.QUALIFICATION_DISPOSABLE_PG_URL??'';
  const clients=[];
  const connectVerified=async database=>{
    const c=new Pg.Client(makePgClientConfig(transport,raw,{database}));
    try{await c.connect();assertPgIdentity(await c.query(PG_IDENTITY_SQL),database);return c;}
    catch{await c.end().catch(()=>{});throw new Error('PG_CLIENT_CONNECTION_OR_IDENTITY_REJECTED');}
  };
  async function client(database=p.database_name){const c=await connectVerified(database);clients.push(c);return c;}
  const admin=await client();
  try{
  const expected=JSON.parse(await fs.readFile(path.join(workspace,'config/clued-handover-external-catalog.json'),'utf8'));
  assert.equal(expected.operator_authority_receipt,p.operator_authority_receipt);
  const registry=(await admin.query('select * from qualification_guard.registration_v1')).rows;
  assert.equal(registry.length,1);const row=registry[0];
  assert.equal(row.realm,'clued-handover-disposable');assert.equal(row.synthetic_only,true);
  assert.equal(row.registration,p.disposable_pg_registration);assert.equal(row.database_name,p.database_name);
  assert.equal(row.registered_host,p.database_host);assert.equal(row.profile_sha256,p.profile_hash);
  assert.equal(row.operator_authority_receipt,p.operator_authority_receipt);
  assert.equal(row.source_baseline,p.source_baseline);assert.equal(row.source_pins_sha256,p.source_pins_sha256);
  assert.equal((await admin.query('select current_database() d')).rows[0].d,p.database_name);
  if(phase==='publish')await verifyEmptyCluster({admin,connectDatabase:async name=>{
    return connectVerified(name);
  },expected:expected.before_bootstrap,targetDatabase:p.database_name});
  const empty=(await admin.query("select to_regclass('public.clued_memories') is null as empty")).rows[0].empty;
  if(phase==='publish')assert.equal(empty,true,'fixture is not fresh');
  else assert.equal(empty,false,'continuous state lost; reconstruction unsupported');
  const rawFixtures=await import(pathToFileURL(path.join(workspace,'apps/clued-cloud/tests/raw-binding-grants-fixture.mjs')).href);
  const sourceFixtures=await import(pathToFileURL(path.join(workspace,'apps/clued-cloud/tests/worker-gateway-caller-fixture.mjs')).href);
  let prepared=false;
  async function prepare(){
    assert.equal(prepared,false,'DUPLICATE_FIXTURE_PREPARATION');
    if(empty){
    // The selected Supabase project already owns its Auth/roles/extensions.
    // Their exact preexisting definitions/counts were independently accepted;
    // never create, replace or synthesize that platform inside this path.
    await verifySupabasePlatform(admin,p);
    const dir=path.join(workspace,'apps/clued-cloud/supabase/migrations');
    for(const file of (await fs.readdir(dir)).filter(n=>n.endsWith('.sql')).sort())await admin.query(await fs.readFile(path.join(dir,file),'utf8'));
  }
    if(empty)await rawFixtures.allowRawTestBindings(admin);
    await sourceFixtures.assertGatewayCloseoutBoundary(admin);prepared=true;
  }
  async function close(){for(const c of clients)await c.end().catch(()=>{});}
  assert.match(row.registered_run_id,/^[1-9][0-9]{0,19}$/);
  return {admin,client,close,sourceFixtures,prepare,registration_run_id:row.registered_run_id,registration_rows:registry};
  }catch(error){
    for(const c of clients)await c.end().catch(()=>{});
    throw error;
  }
}
async function inspectFixture(db,p) {
  assert.equal((await db.query('select count(*)::int n from auth.users')).rows[0].n,1);
  const owner=(await db.query('select id from auth.users')).rows[0].id;
  const claims=(await db.query('select claim_id,task_id,context_key,execution_epoch,execution_handover_pending,lease_key_hash from clued_private.work_claims_v1')).rows;
  assert.equal(claims.length,1);assert.equal(claims[0].claim_id,p.fixture_claim_id);
  assert.equal(claims[0].task_id,p.engineering_task_id);
  assert.equal(claims[0].context_key,'project:'+p.project_id);
  const state={owner_id:owner,claim_id:p.fixture_claim_id,scope:'project:'+p.project_id,
    publisher_run_id:String(publisherId(p)),execution_epoch:String(claims[0].execution_epoch)};
  return {state,claims};
}
function publisherId(p){return process.env.QUALIFICATION_PHASE==='publish'?process.env.GITHUB_RUN_ID:process.env.QUALIFICATION_PUBLISHER_RUN_ID;}
async function installObservationViews(db,p,state) {
  await db.query('create schema if not exists qualification_guard;revoke all on schema qualification_guard from public;');
  await db.query("create table if not exists qualification_guard.fixture_identity_v1("+
    "singleton boolean primary key default true check(singleton),realm text not null,synthetic_only boolean not null,"+
    "database_name text not null,registered_host text not null,registration text not null,operator_authority_receipt text not null,"+
    "source_baseline text not null,source_pins_sha256 text not null,profile_sha256 text not null,publisher_run_id text not null,"+
    "owner_id uuid not null,claim_id uuid not null,scope text not null,created_at timestamptz not null default clock_timestamp());"+
    "revoke all on qualification_guard.fixture_identity_v1 from public,anon,authenticated,service_role;");
  const realDb=(await db.query('select current_database() d')).rows[0].d;
  const name=p.fixture_mode==='continuous'?p.database_name:realDb;
  const host=p.fixture_mode==='continuous'?p.database_host:'127.0.0.1';
  const values=[name,host,p.disposable_pg_registration,p.operator_authority_receipt,p.source_baseline,
    p.source_pins_sha256,p.profile_hash,state.publisher_run_id,state.owner_id,state.claim_id,state.scope];
  const exists=(await db.query('select count(*)::int n from qualification_guard.fixture_identity_v1')).rows[0].n;
  if(!exists)await db.query("insert into qualification_guard.fixture_identity_v1("+
    "realm,synthetic_only,database_name,registered_host,registration,operator_authority_receipt,source_baseline,"+
    "source_pins_sha256,profile_sha256,publisher_run_id,owner_id,claim_id,scope) "+
    "values('clued-handover-disposable',true,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",values);
  else{
    const r=(await db.query('select * from qualification_guard.fixture_identity_v1')).rows[0];
    assert.equal(r.profile_sha256,p.profile_hash);assert.equal(r.publisher_run_id,state.publisher_run_id);
    assert.equal(r.owner_id,state.owner_id);assert.equal(r.claim_id,state.claim_id);
  }
  await db.query("create or replace view qualification_guard.runtime_identity_v1 as select realm,synthetic_only,database_name,"+
    "registered_host,registration,operator_authority_receipt,source_baseline,source_pins_sha256 from qualification_guard.fixture_identity_v1;"+
    "create or replace view qualification_guard.publication_observation_v1 as "+
    "select publication_id,run_id,head_sha,check_run_id from clued_private.work_claim_publications_v1;"+
    "revoke all on qualification_guard.runtime_identity_v1,qualification_guard.publication_observation_v1 from public;"+
    "grant usage on schema qualification_guard to anon;grant select on qualification_guard.runtime_identity_v1,"+
    "qualification_guard.publication_observation_v1 to anon;");
  return {...p,database_name:name,database_host:host};
}
async function seedFixture(h,p,ciProof) {
  const db=h.admin,owner=uuid(),holderHash=sha(crypto.randomBytes(32));
  assert.equal((await db.query('select count(*)::int n from auth.users')).rows[0].n,0);
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'isolated-handover@example.invalid',now())",[owner]);
  await db.query('begin isolation level read committed');
  try{
    await db.query('select clued_private.authorization_writer_guard_v2($1)',[owner]);
    await db.query('select clued_private.authorization_writer_lock_fanout_v2($1)',[owner]);
  await db.query("insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at) "+
    "values($1,$2,'Synthetic external fixture','synthetic external fixture',$3,'confirmed',now())",[p.project_id,owner,'project:'+p.project_id]);
    await db.query('commit');
  }catch(error){
    await db.query('rollback').catch(()=>{});
    throw error;
  }
  await db.query("insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,"+
    "record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason) "+
    "values($1,$2,'SYNTHETIC Task617 replica','Fixture realm only','project',$3,'task','active',1,'active',$4,"+
    "'{\"execution_bucket\":\"next\"}','{}','{}','observed','Empty independently registered fixture')",
    [p.engineering_task_id,owner,p.project_id,'project:'+p.project_id]);
  async function binding(name,hash,scopes){
    return (await db.query("insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys) "+
      "values($1,'synthetic',$2,$3,$4,array['*']) returning id",[owner,name,hash,scopes])).rows[0].id;
  }
  const holder=await binding('synthetic isolated holder',holderHash,['context:read','context:write']);
  const ci=await binding('synthetic isolated admission',sha(ciProof),['context:read']);
  const roleReceipt=(await db.query("insert into public.clued_audit_receipts(user_id,context_key,operation,object_type,object_id,version,metadata,status) "+
    "values($1,$2,'fixture_role','binding',$3,1,'{\"fixture_only\":true}','committed') returning id",
    [owner,'project:'+p.project_id,ci])).rows[0].id;
  await db.query("insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id) "+
    "values($1,$2,'ci-admission',clock_timestamp(),$3)",[owner,ci,roleReceipt]);
  await db.query("insert into clued_private.work_claims_v1(claim_id,user_id,task_id,context_key,holder_binding_id,"+
    "holder_session_ref,holder_label,base_commit,write_set,fence,issued_at,expires_at,hard_deadline_at,status,idempotency_key) "+
    "values($1,$2,$3,$4,$5,'synthetic-publisher','Synthetic fixture holder',$6,$7,1,clock_timestamp(),"+
    "clock_timestamp()+interval '2 hours',clock_timestamp()+interval '1 day','ACTIVE',$8)",
    [p.fixture_claim_id,owner,p.engineering_task_id,'project:'+p.project_id,holder,p.runtime_source_commit,p.fixture_paths,uuid()]);
  const key=(await db.query('select clued_private.work_claim_lease_key_issue_v1($1) k',[p.fixture_claim_id])).rows[0].k;
  // Active policy only inside this empty synthetic fixture; Source function,
  // not a fabricated boolean and never a production migration.
  const activated=(await db.query('select clued_private.work_claim_execution_activate_v1($1) v',[p.runtime_source_commit])).rows[0].v;
  assert.equal(activated.status,'activated');
  await db.query('update clued_private.work_claims_v1 set lease_key_required=true where claim_id=$1',[p.fixture_claim_id]);
  const generation=(await db.query('select fence,lease_version from clued_private.work_claims_v1 where claim_id=$1',[p.fixture_claim_id])).rows[0];
  const gw=await h.client();
  const authorized=await h.sourceFixtures.workerGatewayRpc(gw,'clued_work_renew_v1',holderHash,{
    action:'authorize_head',scope:'project:'+p.project_id,claim_id:p.fixture_claim_id,
    fence:Number(generation.fence),lease_version:Number(generation.lease_version),lease_key:key,
    repository:p.repository,pr_ref:p.repository+'#'+p.pr_number,head_sha:p.head_sha,
    target_branch:p.target_branch,idempotency_key:uuid()});
  assert.equal(authorized.status,'committed');
  return {owner_id:owner,claim_id:p.fixture_claim_id,scope:'project:'+p.project_id,publisher_run_id:process.env.GITHUB_RUN_ID};
}
async function fixtureCi(h) {const c=await h.client();await c.query('set role anon');return c;}
async function nativePending(h,p,state) {
  const native=await h.client();await native.query('set role authenticated');
  const jwt={sub:state.owner_id,role:'authenticated',session_id:'synthetic-owner-'+p.fixture_realm_id,
    aal:'aal1',amr:[{method:'password',timestamp:Math.floor(Date.now()/1000)}]};
  await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
    [state.owner_id,JSON.stringify(jwt)]);
  const preview=(await native.query('select public.clued_work_claim_handover_confirmation_issue_v1($1::jsonb) v',
    [{claim_id:p.fixture_claim_id}])).rows[0].v;
  assert.equal(preview.status,'issued');
  const moved=(await native.query('select public.clued_work_claim_handover_v1($1::jsonb) v',
    [{confirmation_token:preview.confirmation_token,view_digest:preview.view_digest}])).rows[0].v;
  assert.equal(moved.status,'pending');assert.equal('lease_key' in moved,false);
  return {status:moved.status,receipt_id:moved.receipt_id,delivery_id:moved.delivery_id,execution_epoch:moved.execution_epoch};
}
async function observeIdle(p,{cancelled=false,prior=null}={}) {
  const run=await api('/repos/'+p.repository+'/actions/runs/'+p.idle_run_id);
  assert.equal(run.repository.full_name,p.repository);assert.equal(run.head_sha,p.head_sha);
  assert.equal(run.event,'workflow_dispatch');assert.equal(run.path,'.github/workflows/'+p.fixture_idle_workflow);
  assert.equal(run.run_attempt,1);
  const response=await api('/repos/'+p.repository+'/actions/runs/'+p.idle_run_id+'/jobs?per_page=100&page=1');
  assert.ok(Array.isArray(response.jobs)&&response.total_count===response.jobs.length&&response.jobs.length<100);
  const gate=response.jobs.filter(j=>j.name==='admission-gate');
  const idle=response.jobs.filter(j=>j.name==='disposable-idle');
  assert.equal(gate.length,1);assert.equal(gate[0].status,'completed');assert.equal(gate[0].conclusion,'success');
  assert.equal(idle.length,1);assert.ok(idle[0].started_at);
  if(cancelled||(prior?.attempted_at&&run.status==='completed')){
    assert.equal(run.status,'completed');assert.equal(run.conclusion,'cancelled');
    assert.equal(idle[0].status,'completed');assert.equal(idle[0].conclusion,'cancelled');
  }else{
    assert.equal(run.status,'in_progress');assert.equal(idle[0].status,'in_progress');
    const steps=idle[0].steps?.filter(s=>s.name==='Bounded idle process to prove real provider cancellation');
    assert.equal(steps?.length,1);assert.equal(steps[0].status,'in_progress');assert.ok(steps[0].started_at);
  }
  const fact={run_id:String(run.id),run_status:run.status,run_conclusion:run.conclusion,
    gate_job_id:String(gate[0].id),gate_conclusion:gate[0].conclusion,idle_job_id:String(idle[0].id),
    idle_started_at:idle[0].started_at,idle_completed_at:idle[0].completed_at,idle_conclusion:idle[0].conclusion};
  if(prior?.attempted_at&&run.status==='completed')validateCompleted(fact,prior.started_fact,p.idle_run_id);
  if(prior)assert.deepEqual(fact,assertBoundIdleObservation(p,{run,jobs:response},prior.binding_fact));
  return fact;
}
async function main(){
  const phase=process.env.QUALIFICATION_PHASE,trace=[];
  let category='SOURCE_ACCEPTANCE',h=null,partial=null;
  try{
    assert.ok(['publish','revoke'].includes(phase));
    let p=await loadProfile();
    if(process.argv.includes('--preflight-only')){
      await saveSafe('preflight.json',safeSummary(phase,{status:'EXACT_ACCEPTED_SOURCE_BYTES',
        source_commit:p.runtime_source_commit,accepted_source_commit:p.accepted_source_commit,
        acceptance_sha256:p.acceptance_sha256,external_effects_started:false}));return;
    }
    assert.ok(process.argv.includes('--execute'));
    if(process.env.CLUED_CONTEXT_READ_TOKEN||process.env.CLUED_ADMISSION_CLUED_TOKEN)
      throw new Error('production Clued Binding prohibited');
    category='HOST_RUN_IDENTITY';
    assert.equal(Number(process.env.CLUED_ADMISSION_APP_ID),5164952);
    await observeHostRun(p,process.env.GITHUB_RUN_ID);
    category='CURRENT_MAIN_CANONICAL_GATE';
    const mainGateFact=await readCanonicalGate({profile:p,runId:String(process.env.GITHUB_RUN_ID),
      targetWorkflow:p.qualifier_workflow,targetRef:'main',targetHead:p.runtime_source_commit,
      ...evidenceReaders,realFetch:boundedRealFetch});
    let producer=null;
    if(phase==='revoke'){
      assert.ok(numeric(publisherId(p)));assert.notEqual(String(publisherId(p)),process.env.GITHUB_RUN_ID);
      producer=await observeHostRun(p,String(publisherId(p)),{completed:true});
    }
    category='EMPTY_REGISTERED_CLUSTER';h=await openFixture(p,phase);
    p.registration_run_id=h.registration_run_id;
    category='COMPLETED_OPERATOR_REGISTRATION';
    const registrationRun=await api('/repos/'+p.repository+'/actions/runs/'+p.registration_run_id);
    const registrationJobs=await api('/repos/'+p.repository+'/actions/runs/'+p.registration_run_id+'/jobs?per_page=100&page=1');
    p=projectRegisteredRuntimeProfile(p,{registrationRows:h.registration_rows,run:registrationRun,jobs:registrationJobs});
    let idleBefore,journal;
    if(phase==='publish'){
      category='LATE_REAL_IDLE_SELECTION';
      const run=await api('/repos/'+p.repository+'/actions/runs/'+p.idle_run_id);
      const jobs=await api('/repos/'+p.repository+'/actions/runs/'+p.idle_run_id+'/jobs?per_page=100&page=1');
      const idleGateFact=await readCanonicalGate({profile:p,runId:p.idle_run_id,
        targetWorkflow:p.fixture_idle_workflow,targetRef:run.head_branch,targetHead:run.head_sha,
        ...evidenceReaders,realFetch:boundedRealFetch});
      const locator=await resolveFixtureLocator({profile:p,idleGateFact,mainGateFact,api});
      p=applyFixtureLocator(p,locator);
      const content=await evidenceReaders.api('/repos/'+p.repository+'/contents/.github/workflows/'+p.fixture_idle_workflow+'?ref='+p.head_sha);
      const binding=makeIdleBinding(p,{run,jobs,content,registrationRun,registrationJobs,locator,mainGateFact});
      idleBefore=binding.started_fact;
      await h.prepare();journal=await cancellationJournal(h.admin,p);
      category='ORIGINAL_IDLE_BINDING_CAS';await journal.bindIdle(binding);
    }else{
      await h.prepare();journal=await cancellationJournal(h.admin,p);
      const prior=await journal.read();assert.ok(prior?.started_fact,'original idle journal missing');
      p=applyFixtureLocator(p,prior.binding_fact.fixture_locator);
      p.idle_run_id=prior.run_id;
      assertCanonicalClaimMatch(p,prior.binding_fact.fixture_locator.canonical_gate_fact,mainGateFact);
      category='ORIGINAL_IDLE_READ_ONLY_RECOVERY';idleBefore=await observeIdle(p,{prior});
      if(idleBefore.run_status==='completed')await journal.rememberCompleted(idleBefore);
    }
    const proof=testCiProof();let state;
    if(phase==='publish')state=await seedFixture(h,p,proof);
    else{
      const r=(await h.admin.query('select * from qualification_guard.fixture_identity_v1')).rows[0];
      assert.equal(r.profile_sha256,p.profile_hash);assert.equal(r.publisher_run_id,String(publisherId(p)));
      state={owner_id:r.owner_id,claim_id:r.claim_id,scope:r.scope,publisher_run_id:r.publisher_run_id};
      await inspectFixture(h.admin,p);
    }
    const runtimeProfile=await installObservationViews(h.admin,p,state);
    const ci=await fixtureCi(h),env=fixtureEnvironment(process.env,proof);
    if(phase==='publish'){
      category='MISSING_APP_NEGATIVE';let mutations=0;
      const missing=await postAppCheckCore({env:{...env,CLUED_ADMISSION_APP_ID:'',CLUED_ADMISSION_APP_PRIVATE_KEY:''},
        fetchImpl:async()=>{mutations++;throw new Error('missing-App path must not fetch');},
        headSha:p.head_sha,prNumber:p.pr_number,success:true,title:'QUALIFICATION: missing App',summary:'fixture only'});
      assert.equal(missing.posted,false);assert.equal(mutations,0);
      trace.push({kind:'missing_app_negative',network_calls:0,posted:false});
      category='ACTUAL_PUBLICATION_BEGIN_FINISH';
      const happy=await guardedProvider({env,profile:runtimeProfile,fixture:state,ciClient:ci,trace,journal,realFetch:boundedRealFetch,sourceCache});
      const successful=await publishWithSource({env,profile:p,boundary:happy,title:'QUALIFICATION: actual successful publication'});
      assert.equal(successful.posted,true);assert.equal(successful.conclusion,'success');
      assert.ok(successful.publication_observation?.begin_receipt_id&&successful.publication_observation?.finish_receipt_id);
      category='ACTUAL_UNCERTAIN_PUBLICATION';
      const uncertain=await guardedProvider({env,profile:runtimeProfile,fixture:state,ciClient:ci,loseNextCheckPostResponse:true,trace,journal,realFetch:boundedRealFetch,sourceCache});
      const lost=await publishWithSource({env,profile:p,boundary:uncertain,title:'QUALIFICATION: actual reply loss'});
      assert.equal(lost.posted,false);
      assert.ok(trace.some(t=>t.kind==='controlled_response_loss'&&t.provider_accepted));
      const open=(await h.admin.query("select publication_id,run_id,state,check_run_id from clued_private.work_claim_publications_v1 where state='open'")).rows;
      assert.equal(open.length,1);assert.equal(open[0].run_id,process.env.GITHUB_RUN_ID);
      category='PENDING_FIXTURE_HANDOVER';const pending=await nativePending(h,p,state);
      const outboxes=(await h.admin.query("select outbox_id,execution_epoch from clued_private.work_claim_revocation_outbox_v1 where state='pending'")).rows;
      assert.ok(outboxes.length);
      const denied=(await ci.query('select public.clued_work_verify_v1($1::text,$2::jsonb) v',[sha(proof),{
        action:'revocation_ack',scope:state.scope,outbox_id:outboxes[0].outbox_id,execution_epoch:Number(outboxes[0].execution_epoch),
        evidence:{checks_revoked:true,auto_merge_disabled:true,dispatch_revoked:true}}])).rows[0].v;
      assert.equal(denied.error_code,'work_claim_publications_unresolved');
      trace.push({kind:'fixture_ack_negative',error_code:denied.error_code,acknowledged:false});
      // Construct success only after ALL assertions. Database stays live.
      const result=safeSummary(phase,{status:'PUBLISHER_PHASE_OBSERVED_REQUIRES_SEPARATE_COMPLETED_RUN',
        source_commit:p.runtime_source_commit,acceptance_sha256:p.acceptance_sha256,
        publisher_run_id:state.publisher_run_id,idle_before:idleBefore,idle_binding:(await journal.read()).binding_fact,
        successful_publication:successful.publication_observation,uncertain_open_publication_id:open[0].publication_id,
        pending,pending_outbox_count:outboxes.length,state_scope:'continuous',trace,external_facts:uncertain.publicFacts()});
      await saveSafe('publish.json',result);
    }else{
      category='EXTERNAL_REVOKER';
      const boundary=await guardedProvider({env,profile:runtimeProfile,fixture:state,ciClient:ci,trace,journal,realFetch:boundedRealFetch,sourceCache});
      let swept;
      for(let attempt=1;attempt<=12;attempt++){
        try{swept=await revokeWithSource({env,boundary});if(swept.pending===0)break;}
        catch(error){if(error.code!=='CANCELLATION_ALREADY_SENT_READ_ONLY')throw error;}
        await new Promise(resolve=>setTimeout(resolve,10000));
      }
      const remaining=(await h.admin.query("select (select count(*) from clued_private.work_claim_publications_v1 where state='open')::int publications,"+
        "(select count(*) from clued_private.work_claim_revocation_outbox_v1 where state='pending')::int outboxes")).rows[0];
      partial={sweep:swept,remaining};
      category='FINAL_EXTERNAL_ASSERTIONS';
      assert.equal(remaining.publications,0);assert.equal(remaining.outboxes,0);
      const idleAfter=await observeIdle(p,{cancelled:true,prior:await journal.read()});
      assert.equal(idleAfter.idle_job_id,idleBefore.idle_job_id);
      assert.equal(idleAfter.gate_job_id,idleBefore.gate_job_id);
      assert.equal(idleAfter.idle_started_at,idleBefore.idle_started_at);
      const originalCancellation=await journal.read();
      assert.ok(originalCancellation?.attempted_at);
      assert.equal(originalCancellation.response_status,202,'original actual202 proof unavailable: settlement only, not positive qualification');
      validateCompleted(idleAfter,originalCancellation.started_fact,p.idle_run_id);
      const durableEvidence=await journal.evidence();
      const reconciled=durableEvidence.filter(t=>t.kind==='fixture_rpc'&&t.action==='publication_reconcile'&&t.status==='committed');
      const acknowledged=durableEvidence.filter(t=>t.kind==='fixture_rpc'&&t.action==='revocation_ack'&&t.status==='committed');
      assert.ok(reconciled.length&&acknowledged.length);
      const stopIndex=durableEvidence.findIndex(t=>t.kind==='github'&&t.run_id===String(publisherId(p))&&t.run_status==='completed');
      const reconcileIndex=durableEvidence.findIndex(t=>t.kind==='fixture_rpc'&&t.action==='publication_reconcile'&&t.status==='committed');
      const ackIndex=durableEvidence.findIndex(t=>t.kind==='fixture_rpc'&&t.action==='revocation_ack'&&t.status==='committed');
      assert.ok(stopIndex>=0&&reconcileIndex>stopIndex&&ackIndex>reconcileIndex);
      const result=safeSummary(phase,{status:'EXTERNAL_BOUNDARY_OBSERVED_REQUIRES_INDEPENDENT_ACCEPTANCE',
        source_commit:p.runtime_source_commit,acceptance_sha256:p.acceptance_sha256,producer,idle_before:idleBefore,idle_after:idleAfter,
        state_scope:'continuous',sweep:swept,remaining,trace,external_facts:boundary.publicFacts(),
        idle_binding:(await journal.read()).binding_fact,
        original_cancellation:{attempted_at:originalCancellation.attempted_at,response_status:originalCancellation.response_status,
          started_fact:originalCancellation.started_fact,completed_fact:originalCancellation.completed_fact},
        durable_evidence:durableEvidence,
        reconcile_receipt_ids:reconciled.map(t=>t.receipt_id),ack_receipt_ids:acknowledged.map(t=>t.receipt_id)});
      await saveSafe('revoke.json',result);
    }
  }catch(error){
    // Never reserialize a previously optimistic success result as a failure.
    await saveSafe((phase??'unknown')+'-failure.json',safeSummary(phase,{status:'FAILED',success:false,
      failure_category:category,error_type:error.name,partial_observation:partial,trace,
      continuous_fixture_state_retained:!!h}));
    throw error;
  }finally{if(h)await h.close();}
}
main().catch(error=>{console.error('Disposable qualification FAILED:'+error.name);process.exitCode=1;});
