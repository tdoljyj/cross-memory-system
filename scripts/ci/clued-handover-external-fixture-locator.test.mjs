import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {resolveFixtureLocator,assertFixturePull,fixturePublicationInput} from './clued-handover-external-fixture-locator.mjs';
import {assertEarlyFixtureLocators,assertFixtureSelectionPolicy,applyFixtureLocator,fixtureClaimDomains,
  bindingIdentity,assertIdleBinding,assertCanonicalClaimMatch,cancellationJournal,cancellationPlan,
  providerGetBudget,assertIdleSelectionPolicy} from './clued-handover-external-journal.mjs';

const repo='tdoljyj/cross-memory-system',task='6176fdcc-c5b0-46c9-9769-d5e0bc0ce4f8';
const project='0597aa60-9b98-4da6-a4ab-63d7705b632f',scope='project:'+project;
const canonical='11111111-1111-4111-8111-111111111111',synthetic='22222222-2222-4222-8222-222222222222';
const main='a'.repeat(40),head='b'.repeat(40),h64='a'.repeat(64),branch='clued-handover-disposable-exact';
const paths=['work/handover-protection/disposable-fixture/exact.txt'];
const NOW=Date.parse('2026-11-01T00:00:00Z'),iso=offset=>new Date(NOW+offset).toISOString();
mock.timers.enable({apis:['Date'],now:NOW}); // the code under test reads Date.now(): hold it at NOW so the offsets below stay in the window
function fixture(){
  const p={repository:repo,engineering_task_id:task,project_id:project,target_branch:'main',fixture_mode:'continuous',
    fixture_idle_workflow:'clued-handover-disposable-idle.yml',qualifier_workflow:'clued-handover-external-qualification.yml',
    pr_number:null,head_sha:null,disposable_branch:null,idle_run_id:null,fixture_claim_id:synthetic,fixture_paths:paths,
    runtime_source_commit:main,accepted_source_commit:'c'.repeat(40),profile_hash:h64,acceptance_sha256:h64,
    operator_authority_receipt:'33333333-3333-4333-8333-333333333333',disposable_pg_registration:'exact-registration',
    registration_run_id:'30',valid_until:iso(3600000),
    fixture_selection_policy:{mode:'derive_from_admitted_idle_v1',task_id:task,scope,repository:repo,target_branch:'main',
      branch_prefix:'clued-handover-disposable-',pr_state:'open',draft:true,auto_merge:null,unique_match:true,
      claim_relation:'single_canonical_claim',log_download_policy:'github_native_job_log_single_redirect_v1'},
    idle_selection_policy:{mode:'late-bound-single-original-journal',workflow:'clued-handover-disposable-idle.yml',
      workflow_blob:'97c39730ce75f2ea2427c9fa3845f9df32e998f8',
      source_sha256:'133554a025b122737198289925920b31992191a96a5321242d3c78cf119acf66',
      primary_definition_sha256:'d6dce50d38f3a75a290776243f8065ad69cbfd4fa68327f75a8ce3055965fd3d',
      qualifier_actor_id:'10',qualifier_triggering_actor_id:'10',idle_actor_id:'10',idle_triggering_actor_id:'10'},
    gate_source_pins:Object.fromEntries(['scripts/ci/clued-work-admission.mjs','scripts/ci/clued-gated-proof-runtime.mjs',
      '.github/workflows/clued-work-admission-dispatch.yml','.github/workflows/clued-handover-disposable-idle.yml',
      '.github/workflows/clued-handover-external-qualification.yml'].map(path=>[path,h64]))};
  const fact={schema:'clued.handover-canonical-gate-fact/1',repository:repo,canonical_claim_id:canonical,task_id:task,
    scope,fence:7,bound_pr:repo+'#999',claim_status:'ACTIVE',claim_expires_at:iso(3600000),claim_base_commit:main,
    claim_write_set_sha256:h64,run_id:'1',run_attempt:1,workflow:p.fixture_idle_workflow,ref:branch,head_sha:head,
    created_at:iso(-60000),actor_id:'10',triggering_actor_id:'10',gate_job_id:'11',gate_step_number:4,
    gate_step_started_at:iso(-50000),gate_step_completed_at:iso(-40000),gate_log_sha256:h64,
    gate_log_download_origin:'https://productionresultssa8.blob.core.windows.net',
    admission_run_id:'2',admission_run_attempt:1,admission_created_at:iso(-90000),admission_head_sha:'d'.repeat(40),
    admission_job_id:'21',admission_step_number:4,admission_step_started_at:iso(-80000),
    admission_step_completed_at:iso(-70000),admission_log_sha256:h64,admission_actor_id:'10',
    admission_log_download_origin:'https://productionresultssa9.blob.core.windows.net',
    admission_triggering_actor_id:'10',runtime_source_commit:main,checkout_main_commit:main,
    gate_source_sha256:h64,dispatch_workflow_source_sha256:h64,target_workflow_source_sha256:h64};
  const current={...fact,run_id:'3',admission_run_id:'4',gate_job_id:'31',admission_job_id:'41',
    workflow:p.qualifier_workflow,ref:'main',head_sha:main};
  const locator={schema:'clued.fixture-locator-from-admitted-idle/1',pr_number:'999',head_sha:head,branch,canonical_gate_fact:fact};
  const pull={number:999,state:'open',draft:true,auto_merge:null,changed_files:1,
    head:{sha:head,ref:branch,repo:{full_name:repo}},base:{ref:'main',repo:{full_name:repo}},
    body:'Fixture only\nClued-Work-Claim: '+canonical+'\nClued-Work-Scope: '+scope};
  const started={run_id:'1',run_status:'in_progress',run_conclusion:null,gate_job_id:'11',gate_conclusion:'success',
    idle_job_id:'12',idle_started_at:iso(-30000),idle_completed_at:null,idle_conclusion:null};
  const binding={schema:'clued.external2-idle-binding/2',identity:bindingIdentity(p),started_fact:started,
    fixture_locator:locator,publisher_gate_fact:current,idle_created_at:fact.created_at,
    idle_process_started_at:iso(-20000),registration_completed_at:iso(-120000),registration_job_id:'301'};
  return {p,fact,current,locator,pull,binding,started};
}
function selector(f,overrides={}){const seen=[];return {seen,api:async route=>{seen.push(route);
  if(route.includes('/pulls?'))return overrides.pulls??[f.pull];
  assert.equal(route,'/repos/'+repo+'/pulls/999/files?per_page=100&page=1');
  return overrides.files??[{filename:paths[0]}];}};}

test('Source has four null locators and no caller Canonical authority; policy remains exact',()=>{
  const {p}=fixture();assertEarlyFixtureLocators(p);assertFixtureSelectionPolicy(p);
  for(const key of ['pr_number','head_sha','disposable_branch','idle_run_id'])
    assert.throws(()=>assertEarlyFixtureLocators({...p,[key]:'invented'}),/EARLY_FIXTURE_LOCATOR_PROHIBITED/);
  assert.throws(()=>assertEarlyFixtureLocators({...p,canonical_claim_id:canonical}),/CANONICAL_RUNTIME_FACT_IN_SOURCE/);
  assert.throws(()=>assertFixtureSelectionPolicy({...p,fixture_selection_policy:{...p.fixture_selection_policy,extra:true}}),/FIXTURE_SELECTION_POLICY_FIELDS/);
});
test('real admitted idle selects one exact PR; synthetic identity is a separate domain',async()=>{
  const f=fixture(),s=selector(f),locator=await resolveFixtureLocator({profile:f.p,idleGateFact:f.fact,mainGateFact:f.current,api:s.api});
  assert.deepEqual(locator,f.locator);assert.equal(s.seen.length,2);
  const p=applyFixtureLocator(f.p,locator);assert.equal(f.p.pr_number,null,'Source object mutated');
  assert.deepEqual(fixtureClaimDomains(p,{claim_id:synthetic,scope}),
    {canonical_claim_id:canonical,canonical_scope:scope,synthetic_claim_id:synthetic,synthetic_scope:scope});
  assert.throws(()=>fixtureClaimDomains(p,{claim_id:canonical,scope}));
});
test('0/multiple PRs, head/branch/path drift, and wrong BoundPR cannot select another fixture',async()=>{
  for(const rows of [[],[fixture().pull,fixture().pull]]){const f=fixture(),s=selector(f,{pulls:rows});
    await assert.rejects(resolveFixtureLocator({profile:f.p,idleGateFact:f.fact,mainGateFact:f.current,api:s.api}),/FIXTURE_PR_NOT_UNIQUE/);}
  for(const change of [f=>f.pull.head.sha=main,f=>f.pull.head.ref=branch+'-other',f=>f.pull.draft=false,
    f=>f.pull.auto_merge={},f=>f.pull.base.ref='other',f=>f.pull.number='999',
    f=>f.locator.canonical_gate_fact.bound_pr=repo+'#998']){
    const f=fixture();change(f);assert.throws(()=>assertFixturePull(f.p,f.pull,f.locator));}
  const f=fixture(),s=selector(f,{files:[{filename:'work/handover-protection/disposable-fixture/other.txt'}]});
  await assert.rejects(resolveFixtureLocator({profile:f.p,idleGateFact:f.fact,mainGateFact:f.current,api:s.api}),/FIXTURE_PATHS_CHANGED/);
});
test('real Claim/Scope trailers reject synthetic substitution and duplicates',()=>{
  for(const body of ['Clued-Work-Claim: '+synthetic+'\nClued-Work-Scope: '+scope,
    'Clued-Work-Claim: '+canonical+'\nClued-Work-Scope: global',
    'Clued-Work-Claim: '+canonical+'\nClued-Work-Claim: '+canonical+'\nClued-Work-Scope: '+scope,
    'Clued-Work-Claim: '+canonical+'\n Clued-Work-Claim: '+synthetic+'\nClued-Work-Scope: '+scope]){
    const f=fixture();f.pull.body=body;assert.throws(()=>assertFixturePull(f.p,f.pull,f.locator),/FIXTURE_CANONICAL_TRAILER_MISMATCH/);}
});
test('Source Canonical publication is explicitly projected to synthetic PG only after exact domain validation',()=>{
  const f=fixture(),p=applyFixtureLocator(f.p,f.locator),fixtureState={claim_id:synthetic,scope};
  const input={action:'publication_begin',claim_id:canonical,scope,pr_ref:repo+'#999',head_sha:head,
    target_branch:'main',run_id:'3',publication_key:'public-fixture-key'};
  assert.deepEqual(fixturePublicationInput(p,fixtureState,input),{...input,claim_id:synthetic});
  assert.equal(input.claim_id,canonical,'Source Canonical input mutated');
  for(const change of [{claim_id:synthetic},{scope:'global'},{action:'revocation_ack'},
    {pr_ref:repo+'#998'},{head_sha:main},{target_branch:'other'}])
    assert.throws(()=>fixturePublicationInput(p,fixtureState,{...input,...change}));
});
test('current Canonical Task/Scope/fence/claim/BoundPR must agree with original idle',()=>{
  const f=fixture();assertCanonicalClaimMatch(f.p,f.fact,f.current);
  for(const [field,value]of [['task_id',canonical],['scope','global'],['fence',8],['canonical_claim_id',synthetic],
    ['bound_pr',repo+'#998'],['claim_status','RELEASED']])
    assert.throws(()=>assertCanonicalClaimMatch(f.p,f.fact,{...f.current,[field]:value}));
});
test('fixed binding identity excludes late locator but v2 freezes original locator and original main facts',()=>{
  const f=fixture(),runtime=applyFixtureLocator(f.p,f.locator);runtime.idle_run_id='1';
  assert.deepEqual(bindingIdentity(runtime),bindingIdentity(f.p));assertIdleBinding(runtime,f.binding);
  for(const change of [b=>b.fixture_locator.head_sha=main,b=>b.fixture_locator.pr_number='998',
    b=>b.publisher_gate_fact.fence=8,b=>b.identity.synthetic_claim_id=canonical]){
    const b=structuredClone(f.binding);change(b);assert.throws(()=>assertIdleBinding(runtime,b));}
});
test('original Canonical gate and actual started tuple must agree on run, gate job and creation time',()=>{
  for(const [field,value,code]of [['run_id','5','ORIGINAL_CANONICAL_IDLE_RUN_MISMATCH'],
    ['gate_job_id','51','ORIGINAL_CANONICAL_IDLE_GATE_JOB_MISMATCH'],
    ['created_at',iso(-61000),'ORIGINAL_CANONICAL_IDLE_CREATED_AT_MISMATCH']]){
    const f=fixture(),binding=structuredClone(f.binding);
    binding.fixture_locator.canonical_gate_fact[field]=value;
    assert.throws(()=>assertIdleBinding(f.p,binding),new RegExp(code));
  }
});
test('historical idle expiry is retained for recovery; only a fresh matching main gate authorizes current work',async()=>{
  const f=fixture();f.fact.claim_expires_at=iso(-1000);f.current.claim_expires_at=iso(3600000);
  assertIdleBinding(f.p,f.binding);assertCanonicalClaimMatch(f.p,f.fact,f.current);
  const s=selector(f);await assert.rejects(resolveFixtureLocator({profile:f.p,idleGateFact:f.fact,mainGateFact:f.current,api:s.api}));
  assert.throws(()=>assertCanonicalClaimMatch(f.p,f.fact,{...f.current,claim_expires_at:iso(-1000)}));
});
function memoryJournal(f,{loseInsertResponse=false}={}){
  let row=null,inserts=0,cancelClaims=0;
  const db={async query(sql,values=[]){
    if(sql.startsWith('create table'))return {rows:[]};
    if(sql.startsWith('select *'))return {rows:row?[structuredClone(row)]:[]};
    if(sql.startsWith('insert into qualification_guard.provider_cancellation_journal')){
      inserts++;if(!row)row={profile_sha256:values[0],run_id:values[1],started_fact:JSON.parse(values[2]),
        binding_fact:JSON.parse(values[3]),attempted_at:null,response_status:null,completed_fact:null};
      if(loseInsertResponse)throw new Error('MOCK_INSERT_REPLY_LOST');return {rows:[]};}
    if(sql.includes('set attempted_at=')){cancelClaims++;if(row.attempted_at)return {rows:[],rowCount:0};
      row.attempted_at=iso(0);return {rows:[{run_id:row.run_id}],rowCount:1};}
    throw new Error('UNEXPECTED_MOCK_JOURNAL_QUERY');}};
  return {db,get row(){return row;},get inserts(){return inserts;},get cancelClaims(){return cancelClaims;}};
}
test('unknown original CAS response reads exact original row once; replacement is rejected before another insert',async()=>{
  const f=fixture(),m=memoryJournal(f,{loseInsertResponse:true}),j=await cancellationJournal(m.db,f.p);
  const row=await j.bindIdle(f.binding);assert.equal(row.run_id,'1');assert.equal(m.inserts,1);
  await j.bindIdle(f.binding);assert.equal(m.inserts,1);
  const replacement=structuredClone(f.binding);replacement.fixture_locator.canonical_gate_fact.fence=8;
  replacement.publisher_gate_fact.fence=8;
  await assert.rejects(j.bindIdle(replacement),/IDLE_ALREADY_BOUND_TO_OTHER_FACT/);assert.equal(m.inserts,1);
});
test('unknown cancellation response retains same run and prevents another POST claim',async()=>{
  const f=fixture(),m=memoryJournal(f),j=await cancellationJournal(m.db,f.p);await j.bindIdle(f.binding);
  assert.equal(await j.beginExactOnce(),true);assert.equal(cancellationPlan(await j.read(),f.started),'READ_ONLY_WAIT');
  assert.equal(await j.beginExactOnce(),false);assert.equal((await j.read()).run_id,'1');
  assert.equal(m.inserts,1);assert.equal(m.cancelClaims,2);
});
test('shared provider GET budget is exactly160; actualGET161 is rejected before transport',()=>{
  const b=providerGetBudget();for(let n=0;n<160;n++)b.take();assert.equal(b.count,160);
  assert.throws(()=>b.take(),/PROVIDER_GET_BUDGET_EXCEEDED/);assert.equal(b.count,160);
});

test('Native idle Source uses exact new triplet, historical triplet stays indivisible',()=>{
  const p=fixture().p;assertIdleSelectionPolicy(p);
  const previous={workflow_blob:'3c94569a38f27ba34ac53ff3bb207d9ccd674f35',
    source_sha256:'f72524c1b5ab32a762aec59007bf85dc0ae1ddb9a9e74f38e768dbf712faaa0e',
    primary_definition_sha256:'c26bfb67a0637206f3a26ad72bc9d9e45c039005e53602416df57871735d3647'};
  const old=structuredClone(p);Object.assign(old.idle_selection_policy,previous);assertIdleSelectionPolicy(old);
  for(const key of Object.keys(previous)){
    const mixed=structuredClone(p);mixed.idle_selection_policy[key]=previous[key];
    assert.throws(()=>assertIdleSelectionPolicy(mixed));
  }
});
