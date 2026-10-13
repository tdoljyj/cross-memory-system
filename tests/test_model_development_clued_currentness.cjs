'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {makeDevelopmentCurrentnessReader} = require('../scripts/model-program/development_clued_currentness.cjs');
const SCOPE = 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
const TASK = '1502fd80-8ff8-4adc-b4f5-da6d462f4f8a';
const clone = value => JSON.parse(JSON.stringify(value));

// These are explicitly Source fixtures, not actual Owner approval or permission.
function fixture() {
  const window = {not_before: new Date(Date.now()-10000).toISOString(),
    stop_at: new Date(Date.now()+60000).toISOString()};
  const record = {id:'SOURCE-ONLY-APPROVAL', record_type:'decision', authority:'user_explicit',
    lifecycle_status:'active', canonical_scope:SCOPE, receipt_id:'SOURCE-ONLY-RECEIPT',
    content_hash:'1'.repeat(64), content:'SOURCE FIXTURE NOT PERMISSION', version:1,
    type_fields:{rationale:{model_development_experiment_approval:{kind:'EXACT_BOUNDED_DEVELOPMENT_EXPERIMENT',
      task_id:TASK, purpose_id:'development', profile_id:'DEV-SOURCE-ONLY', request_sha256:'2'.repeat(64),
      max_attempts:1, training_allowed:false, production_allowed:false, qualification_allowed:false, window}}}};
  const ownerCapture = {structuredContent:{status:'committed',receipt_id:record.receipt_id,
    event_ids:['999999999'], supplemental:{record}}};
  const issued = {status:'ISSUED',task_id:TASK,profile_id:'DEV-SOURCE-ONLY',request_sha256:'2'.repeat(64),
    profile_sha256:'3'.repeat(64),execution_plan_sha256:'4'.repeat(64),claim_id:'SOURCE-ONLY-CLAIM',
    claim_fence:1,task_version:2,task_query:'SOURCE ONLY TASK TITLE'};
  const claim = {status:'ACTIVE',task_id:TASK,context_key:SCOPE,claim_id:issued.claim_id,
    fence:1,holder_session_ref:'SOURCE-ONLY-SESSION',execution_handover_pending:false};
  const row = (id,record_type,version,content) => ({id,record_type,version,content,kind:'record',scope:SCOPE,
    authoritative:true,record_currentness:'CURRENT',projection_currentness:'CURRENT',lifecycle_status:'active'});
  const responses = {resume:{status:'restored',context_key:SCOPE,session_token:'SOURCE-NOT-A-TOKEN',
      required_reads:[],active_constraints:[{id:'SOURCE-CONSTRAINT',version:1}],active_work_claims:[claim]},
    approval:{status:'ok',results:[row(record.id,'decision',1,record.content)]},
    task:{status:'ok',results:[row(TASK,'task',2,'SOURCE ONLY TASK')]},
    verify:{status:'ok',verdict:'ADMITTED',current_fence:1,claim},
    reconcile:{status:'current',receipt_kind:'CURRENTNESS_ADMISSION',
      currentness_state:'CURRENT',admission_eligible:true,
      currentness_receipt_id:'123e4567-e89b-12d3-a456-426614174000',
      evaluation_digest:'5'.repeat(64),currentness_vector_digest:'6'.repeat(64)}};
  responses.approval.results[0].type_fields=clone(record.type_fields);
  const calls=[];
  const tools = {};
  tools.mcp__codex_apps__clued_clued_session_resume = async args => {calls.push(['resume',args]);return {structuredContent:responses.resume};};
  tools.mcp__codex_apps__clued_clued_search_context = async args => {
    calls.push(['search',args]);return {structuredContent:args.query===issued.profile_id?responses.approval:responses.task};};
  tools.mcp__codex_apps__clued_clued_work_verify = async args => {calls.push(['verify',args]);return {structuredContent:responses.verify};};
  tools.mcp__codex_apps__clued_clued_session_reconcile = async args => {calls.push(['reconcile',args]);return {structuredContent:responses.reconcile};};
  const bound = {identity:{task_id:TASK,profile_id:issued.profile_id,profile_sha256:issued.profile_sha256,
    request_sha256:issued.request_sha256,approval_record_id:record.id,approval_version:record.version,
    approval_receipt_id:record.receipt_id},execution_plan_sha256:issued.execution_plan_sha256};
  return {tools,ownerCapture,issued,sessionRef:'SOURCE-ONLY-SESSION',responses,calls,bound,
    readPrerequisiteRefs:[{id:'SOURCE-CONSTRAINT',version:1}]};
}

function reconciliationHints(f, overall='STALE') {
  f.responses.resume.required_reads=['project.task','project.state','global.authority'];
  f.responses.resume.currentness_evaluation={overall,authoritative:false,reconciliation_required:true,
    currentness_vector_digest:'7'.repeat(64),checkpoint_id:'223e4567-e89b-12d3-a456-426614174000'};
  return f;
}

test('fixed read-only calls preserve observation-only authority and no secrets returned',async()=>{
  const f=fixture(), reader=makeDevelopmentCurrentnessReader(f);
  const result=await reader.read('before_resume',f.bound);
  assert.equal(result.authority_effect,'NONE');assert.equal(result.permission_issued,false);
  assert.equal(result.attempt_consumed,false);assert.equal(result.approval_version,1);
  assert.ok(!JSON.stringify(result).includes('SOURCE-NOT-A-TOKEN'));
  assert.equal(f.calls.filter(([name])=>name==='search').length,2);
  assert.deepEqual(f.calls.map(([name])=>name),
    ['resume','reconcile','search','search','verify']);
  assert.ok(!('pr_ref' in f.calls.find(([name])=>name==='verify')[1]));
});

test('exact stale or unknown checkpoint hints enter formal admission without rewriting restore',async()=>{
  for(const overall of ['STALE','UNKNOWN']) {
    const f=reconciliationHints(fixture(),overall),restored=clone(f.responses.resume);
    assert.notEqual(f.responses.resume.currentness_evaluation.currentness_vector_digest,
      f.responses.reconcile.currentness_vector_digest);
    const result=await makeDevelopmentCurrentnessReader(f).read('preflight',f.bound);
    assert.deepEqual(f.responses.resume,restored);
    assert.deepEqual(f.calls.map(([name])=>name),['resume','reconcile','search','search','verify']);
    assert.equal(result.authority_effect,'NONE');
    assert.equal(result.permission_issued,false);
    assert.equal(result.attempt_consumed,false);
  }
});

test('partial duplicate reordered or unknown restore hints never enter reconcile',async()=>{
  for(const reads of [null,{},'project.task',
    ['project.task'],['project.task','project.state'],
    ['project.task','global.authority','project.state'],
    ['project.task','project.state','project.state'],
    ['project.task','project.state','unknown.authority'],
    ['project.task','project.state','global.authority','project.task'],
    Object.assign(new Array(3),{0:'project.task',2:'global.authority'})]) {
    const f=reconciliationHints(fixture());f.responses.resume.required_reads=reads;
    await assert.rejects(makeDevelopmentCurrentnessReader(f).read('preflight',f.bound),/UPSTREAM_READS_REQUIRED/);
    assert.deepEqual(f.calls.map(([name])=>name),['resume']);
  }
});

test('restore hints require the exact nested stale or unknown evaluation metadata',async()=>{
  for(const change of [f=>delete f.responses.resume.currentness_evaluation,
    f=>f.responses.resume.currentness_evaluation=null,
    f=>f.responses.resume.currentness_evaluation=[],
    f=>f.responses.resume.currentness_evaluation={},
    f=>f.responses.resume.currentness_evaluation.overall='CURRENT',
    f=>f.responses.resume.currentness_evaluation.overall='UNRECOGNIZED',
    f=>delete f.responses.resume.currentness_evaluation.overall,
    f=>f.responses.resume.currentness_evaluation.authoritative=true,
    f=>f.responses.resume.currentness_evaluation.authoritative='false',
    f=>delete f.responses.resume.currentness_evaluation.authoritative,
    f=>f.responses.resume.currentness_evaluation.reconciliation_required=false,
    f=>f.responses.resume.currentness_evaluation.reconciliation_required='true',
    f=>delete f.responses.resume.currentness_evaluation.reconciliation_required,
    f=>{delete f.responses.resume.currentness_evaluation;
      f.responses.resume.authoritative=false;f.responses.resume.reconciliation_required=true;}]) {
    const f=reconciliationHints(fixture());change(f);
    await assert.rejects(makeDevelopmentCurrentnessReader(f).read('preflight',f.bound),/UPSTREAM_READS_REQUIRED/);
    assert.deepEqual(f.calls.map(([name])=>name),['resume']);
  }
  const f=reconciliationHints(fixture());f.responses.resume.status='current';
  await assert.rejects(makeDevelopmentCurrentnessReader(f).read('preflight',f.bound),/AUTHORIZED_SESSION_REQUIRED/);
  assert.deepEqual(f.calls.map(([name])=>name),['resume']);
});

test('valid reconciliation hints cannot bypass a new or changed upstream constraint',async()=>{
  for(const constraint of [{id:'NEW-CONSTRAINT',version:1},{id:'SOURCE-CONSTRAINT',version:2}]) {
    const f=reconciliationHints(fixture());f.responses.resume.active_constraints=[constraint];
    await assert.rejects(makeDevelopmentCurrentnessReader(f).read('preflight',f.bound),/UPSTREAM_READS_REQUIRED/);
    assert.deepEqual(f.calls.map(([name])=>name),['resume']);
  }
});

test('a typed formal current admission receipt is mandatory before final reads',async()=>{
  const fields=['status','receipt_kind','currentness_state','admission_eligible',
    'currentness_receipt_id','evaluation_digest','currentness_vector_digest'];
  const changes=fields.map(field=>f=>delete f.responses.reconcile[field]);
  changes.push(f=>f.responses.reconcile.status='observation',
    f=>f.responses.reconcile.receipt_kind='OBSERVATION',
    f=>f.responses.reconcile.currentness_receipt_id='',
    f=>f.responses.reconcile.currentness_receipt_id='not-a-uuid',
    f=>f.responses.reconcile.currentness_receipt_id='123e4567e89b12d3a456426614174000',
    f=>f.responses.reconcile.currentness_receipt_id=null,
    f=>f.responses.reconcile.evaluation_digest='a'.repeat(63),
    f=>f.responses.reconcile.evaluation_digest='a'.repeat(65),
    f=>f.responses.reconcile.evaluation_digest='g'.repeat(64),
    f=>f.responses.reconcile.evaluation_digest=null,
    f=>f.responses.reconcile.currentness_vector_digest='a'.repeat(63),
    f=>f.responses.reconcile.currentness_vector_digest='g'.repeat(64),
    f=>f.responses.reconcile.currentness_vector_digest=null);
  for(const change of changes) {
    const f=reconciliationHints(fixture());change(f);
    await assert.rejects(makeDevelopmentCurrentnessReader(f).read('consume',f.bound),/CURRENTNESS_UNAVAILABLE/);
    assert.deepEqual(f.calls.map(([name])=>name),['resume','reconcile']);
  }
});

test('typed receipt validation accepts UUID versions and hex casing without old digest equality',async()=>{
  const f=reconciliationHints(fixture());
  f.responses.reconcile.currentness_receipt_id='01890B2C-88BD-7CC3-98C1-CC1227552479';
  f.responses.reconcile.evaluation_digest='A'.repeat(64);
  f.responses.reconcile.currentness_vector_digest='B'.repeat(64);
  const result=await makeDevelopmentCurrentnessReader(f).read('consume',f.bound);
  assert.equal(result.authority_effect,'NONE');assert.equal(f.calls.length,5);
});

test('authoring/adoption/observed capture cannot become experiment approval',()=>{
  for(const change of [r=>r.authority='observed',r=>r.type_fields={},r=>r.record_type='note']){
    const f=fixture();change(f.ownerCapture.structuredContent.supplemental.record);
    assert.throws(()=>makeDevelopmentCurrentnessReader(f));assert.equal(f.calls.length,0);
  }
});

test('malformed rationale never falls back to a valid legacy top-level approval',()=>{
  const approval=fixture().ownerCapture.structuredContent.supplemental.record.type_fields.rationale.model_development_experiment_approval;
  for(const rationale of [undefined,null,JSON.stringify(approval),[],{},
    Object.assign([],{model_development_experiment_approval:clone(approval)})]) {
    const f=fixture(), fields=f.ownerCapture.structuredContent.supplemental.record.type_fields;
    fields.model_development_experiment_approval=clone(approval);
    fields.rationale=rationale;
    assert.throws(()=>makeDevelopmentCurrentnessReader(f),/EXACT_DEVELOPMENT_APPROVAL_REQUIRED/);
    assert.equal(f.calls.length,0);
  }
});

test('missing or malformed nested approval never selects a valid legacy payload',()=>{
  const approval=fixture().ownerCapture.structuredContent.supplemental.record.type_fields.rationale.model_development_experiment_approval;
  for(const payload of [undefined,null,JSON.stringify(approval),[],{},Object.assign([],clone(approval))]) {
    const f=fixture(), fields=f.ownerCapture.structuredContent.supplemental.record.type_fields;
    fields.model_development_experiment_approval=clone(approval);
    fields.rationale.model_development_experiment_approval=payload;
    assert.throws(()=>makeDevelopmentCurrentnessReader(f),/EXACT_DEVELOPMENT_APPROVAL_REQUIRED/);
    assert.equal(f.calls.length,0);
  }
});

test('candidate and terminal M1 profiles reject before any protected read',()=>{
  for(const change of [f=>f.issued.status='CANDIDATE',f=>{
    f.issued.profile_id='M1-OLD';f.ownerCapture.structuredContent.supplemental.record.type_fields.rationale.model_development_experiment_approval.profile_id='M1-OLD';}]){
    const f=fixture();change(f);assert.throws(()=>makeDevelopmentCurrentnessReader(f));assert.equal(f.calls.length,0);
  }
});

test('request/plan drift cannot initiate live reads',async()=>{
  const f=fixture(), reader=makeDevelopmentCurrentnessReader(f), bad=clone(f.bound);
  bad.execution_plan_sha256='9'.repeat(64);
  await assert.rejects(reader.read('consume',bad),/REQUEST_BINDING_DRIFT/);assert.equal(f.calls.length,0);
});

test('revoked/changed/non-authoritative owner record remains unavailable',async()=>{
  for(const change of [r=>r.results=[],r=>r.results[0].version=2,r=>r.results[0].authoritative=false,
    r=>r.results[0].projection_currentness='UNKNOWN',r=>r.results[0].content='CHANGED']){
    const f=fixture();change(f.responses.approval);
    await assert.rejects(makeDevelopmentCurrentnessReader(f).read('consume',f.bound));
  }
});
test('only changing captured rationale cannot impersonate unchanged canonical approval',async()=>{
  const f=fixture();
  f.ownerCapture.structuredContent.supplemental.record.type_fields.rationale.extraSelfReportedAuthority=true;
  await assert.rejects(makeDevelopmentCurrentnessReader(f).read('consume',f.bound),/APPROVAL_CHANGED_OR_REVOKED/);
});

test('handover/fence/session changes never borrow another holder',async()=>{
  for(const change of [f=>f.responses.resume.active_work_claims[0].execution_handover_pending=true,
    f=>f.responses.verify.current_fence=2,f=>f.responses.resume.active_work_claims[0].holder_session_ref='FOREIGN']){
    const f=fixture();change(f);await assert.rejects(makeDevelopmentCurrentnessReader(f).read('consume',f.bound));
  }
});

test('task version and currentness failure require revalidation',async()=>{
  for(const change of [f=>f.responses.task.results[0].version=3,
    f=>f.responses.reconcile.currentness_state='UNKNOWN',f=>f.responses.reconcile.admission_eligible=false]){
    const f=fixture();change(f);await assert.rejects(makeDevelopmentCurrentnessReader(f).read('preflight',f.bound));
  }
});

test('expired or unzoned approval is never renewed by reading',()=>{
  const f=fixture();f.ownerCapture.structuredContent.supplemental.record.type_fields.rationale.model_development_experiment_approval.window.stop_at='2000-01-01T00:00:00';
  assert.throws(()=>makeDevelopmentCurrentnessReader(f),/UTC_WINDOW_REQUIRED/);assert.equal(f.calls.length,0);
});

test('invalid UTC calendar dates and normalized midnight reject before protected calls',()=>{
  for(const invalid of ['2026-02-30T00:00:00Z', '2026-10-13T24:00:00Z',
    '2026-04-31T12:00:00.000000Z', '2026-10-13T00:61:00Z']) {
    const f=fixture();
    f.ownerCapture.structuredContent.supplemental.record.type_fields.rationale.model_development_experiment_approval.window.not_before=invalid;
    assert.throws(()=>makeDevelopmentCurrentnessReader(f), /UTC_WINDOW_REQUIRED/);
    assert.equal(f.calls.length,0);
  }
});

test('changes adopted during reconcile still fail the final exact observation',async()=>{
  for(const change of [f=>f.responses.approval.results[0].version++,
    f=>f.responses.approval.results[0].content='CHANGED DURING RECONCILE',
    f=>f.responses.approval.results[0].type_fields.rationale.changed=true,
    f=>f.responses.approval.results[0].lifecycle_status='revoked',
    f=>f.responses.task.results[0].version++,
    f=>f.responses.verify.claim={...f.responses.verify.claim,execution_handover_pending:true},
    f=>f.responses.verify.claim={...f.responses.verify.claim,status:'RELEASED'},
    f=>f.responses.verify.claim={...f.responses.verify.claim,holder_session_ref:'OTHER'}]) {
    const f=reconciliationHints(fixture());
    f.tools.mcp__codex_apps__clued_clued_session_reconcile=async args=>{
      f.calls.push(['reconcile',args]); change(f);
      return {structuredContent:f.responses.reconcile};
    };
    await assert.rejects(makeDevelopmentCurrentnessReader(f).read('consume',f.bound));
    assert.equal(f.calls.filter(([name])=>name==='verify').length,1);
  }
});

test('unmet upstream reads or invalid resume claim never initiate later calls',async()=>{
  for(const change of [f=>f.responses.resume.required_reads=[{record_id:'NEW-REQUIRED-READ'}],
    f=>f.responses.resume.required_reads=null,
    f=>delete f.responses.resume.required_reads,
    f=>f.responses.resume.active_work_claims[0].execution_handover_pending=true]) {
    const f=fixture();change(f);
    await assert.rejects(makeDevelopmentCurrentnessReader(f).read('preflight',f.bound));
    assert.equal(f.calls.filter(([name])=>name==='search').length,0);
    assert.equal(f.calls.filter(([name])=>name==='verify').length,0);
    assert.equal(f.calls.filter(([name])=>name==='reconcile').length,0);
  }
});

test('new or changed delivered constraints require upstream reads before reconcile',async()=>{
  for(const field of ['active_constraints','active_constraint_refs','active_constraints_delivered']) {
    for(const value of [null,{},[{id:'UNKNOWN-CONSTRAINT',version:1}],
      [{id:'SOURCE-CONSTRAINT',version:2}],[{id:'SOURCE-CONSTRAINT'}]]) {
      const f=fixture();f.responses.resume[field]=value;
      await assert.rejects(makeDevelopmentCurrentnessReader(f).read('preflight',f.bound),/UPSTREAM_READS_REQUIRED/);
      assert.deepEqual(f.calls.map(([name])=>name),['resume']);
    }
  }
});

test('known delivered constraint refs are prerequisite evidence without new authority',async()=>{
  const f=fixture();
  f.responses.resume.active_constraint_refs=clone(f.readPrerequisiteRefs);
  f.responses.resume.active_constraints_delivered=clone(f.readPrerequisiteRefs);
  const result=await makeDevelopmentCurrentnessReader(f).read('preflight',f.bound);
  assert.equal(result.authority_effect,'NONE');
  assert.equal(result.permission_issued,false);
  assert.equal(result.attempt_consumed,false);
  assert.equal(f.calls.length,5);
});

test('empty prerequisite refs permit only a view without active constraints',async()=>{
  const f=fixture();delete f.readPrerequisiteRefs;f.responses.resume.active_constraints=[];
  await makeDevelopmentCurrentnessReader(f).read('preflight',f.bound);
  const missing=fixture();delete missing.readPrerequisiteRefs;
  await assert.rejects(makeDevelopmentCurrentnessReader(missing).read('preflight',missing.bound),/UPSTREAM_READS_REQUIRED/);
  assert.deepEqual(missing.calls.map(([name])=>name),['resume']);
});

test('invalid prerequisite refs reject before protected reads and later edits cannot repin them',async()=>{
  for(const refs of [null,{},[{id:'SOURCE-CONSTRAINT',version:0}],
    [{id:'SOURCE-CONSTRAINT',version:1},{id:'SOURCE-CONSTRAINT',version:2}]]) {
    const f=fixture();f.readPrerequisiteRefs=refs;
    assert.throws(()=>makeDevelopmentCurrentnessReader(f),/UPSTREAM_READ_REFS_REQUIRED/);
    assert.equal(f.calls.length,0);
  }
  const f=fixture(),reader=makeDevelopmentCurrentnessReader(f);
  f.readPrerequisiteRefs[0].version=2;f.responses.resume.active_constraints[0].version=2;
  await assert.rejects(reader.read('preflight',f.bound),/UPSTREAM_READS_REQUIRED/);
  assert.deepEqual(f.calls.map(([name])=>name),['resume']);
});

test('a newly surfaced reconcile read requirement or constraint blocks the final calls',async()=>{
  for(const change of [f=>f.responses.reconcile.required_reads=[{record_id:'NEW-REQUIRED-READ'}],
    f=>{f.responses.reconcile.required_reads=['project.task','project.state','global.authority'];
      f.responses.reconcile.currentness_evaluation={overall:'STALE',authoritative:false,reconciliation_required:true};},
    f=>f.responses.reconcile.active_constraints_delivered=[{id:'NEW-CONSTRAINT',version:1}]]) {
    const f=fixture();change(f);
    await assert.rejects(makeDevelopmentCurrentnessReader(f).read('consume',f.bound),/UPSTREAM_READS_REQUIRED/);
    assert.deepEqual(f.calls.map(([name])=>name),['resume','reconcile']);
  }
});

test('unknown reconcile cannot initiate the final admission verification',async()=>{
  const f=fixture();f.responses.reconcile.currentness_state='UNKNOWN';
  await assert.rejects(makeDevelopmentCurrentnessReader(f).read('consume',f.bound),/CURRENTNESS_UNAVAILABLE/);
  assert.equal(f.calls.filter(([name])=>name==='verify').length,0);
});

test('each phase makes a fresh final admission check and rejects a later denial',async()=>{
  const f=fixture(),reader=makeDevelopmentCurrentnessReader(f);
  await reader.read('preflight',f.bound);
  f.responses.verify.verdict='DENIED';
  await assert.rejects(reader.read('before_resume',f.bound),/CLAIM_NOT_VERIFIED/);
  assert.equal(f.calls.filter(([name])=>name==='resume').length,2);
  assert.equal(f.calls.filter(([name])=>name==='reconcile').length,2);
  assert.equal(f.calls.filter(([name])=>name==='search').length,4);
  assert.equal(f.calls.filter(([name])=>name==='verify').length,2);
  assert.deepEqual(f.calls.map(([name])=>name),[
    'resume','reconcile','search','search','verify',
    'resume','reconcile','search','search','verify']);
});

test('a pending final verifier blocks return and its refusal rejects the phase',async()=>{
  const f=fixture();let reply,started;
  const verifierStarted=new Promise(resolve=>{started=resolve;});
  f.tools.mcp__codex_apps__clued_clued_work_verify=args=>{
    f.calls.push(['verify',args]);
    assert.equal(f.calls.filter(([name])=>name==='reconcile').length,1);
    started();return new Promise(resolve=>{reply=resolve;});
  };
  let returned=false;
  const observed=makeDevelopmentCurrentnessReader(f).read('consume',f.bound);
  const checked=assert.rejects(observed,/TOOL_REFUSED/);
  observed.then(()=>{returned=true;},()=>{returned=true;});
  await verifierStarted;
  await Promise.resolve();
  assert.equal(returned,false);
  reply({isError:true});
  await checked;
  assert.equal(f.calls.filter(([name])=>name==='verify').length,1);
});
