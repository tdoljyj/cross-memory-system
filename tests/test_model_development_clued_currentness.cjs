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
  const responses = {resume:{status:'restored',context_key:SCOPE,session_token:'SOURCE-NOT-A-TOKEN',active_work_claims:[claim]},
    approval:{status:'ok',results:[row(record.id,'decision',1,record.content)]},
    task:{status:'ok',results:[row(TASK,'task',2,'SOURCE ONLY TASK')]},
    verify:{status:'ok',verdict:'ADMITTED',current_fence:1,claim},
    reconcile:{currentness_state:'CURRENT',admission_eligible:true}};
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
  return {tools,ownerCapture,issued,sessionRef:'SOURCE-ONLY-SESSION',responses,calls,bound};
}

test('fixed read-only calls preserve observation-only authority and no secrets returned',async()=>{
  const f=fixture(), reader=makeDevelopmentCurrentnessReader(f);
  const result=await reader.read('before_resume',f.bound);
  assert.equal(result.authority_effect,'NONE');assert.equal(result.permission_issued,false);
  assert.equal(result.attempt_consumed,false);assert.equal(result.approval_version,1);
  assert.ok(!JSON.stringify(result).includes('SOURCE-NOT-A-TOKEN'));
  assert.equal(f.calls.filter(([name])=>name==='search').length,4);
  assert.ok(f.calls.every(([name])=>['resume','search','verify','reconcile'].includes(name)));
  assert.ok(!('pr_ref' in f.calls.find(([name])=>name==='verify')[1]));
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
    f=>f.responses.approval.results[0].lifecycle_status='revoked',
    f=>f.responses.task.results[0].version++,
    f=>f.responses.verify.claim={...f.responses.verify.claim,execution_handover_pending:true},
    f=>f.responses.verify.claim={...f.responses.verify.claim,status:'RELEASED'},
    f=>f.responses.verify.claim={...f.responses.verify.claim,holder_session_ref:'OTHER'}]) {
    const f=fixture();
    f.tools.mcp__codex_apps__clued_clued_session_reconcile=async args=>{
      f.calls.push(['reconcile',args]); change(f);
      return {structuredContent:f.responses.reconcile};
    };
    await assert.rejects(makeDevelopmentCurrentnessReader(f).read('consume',f.bound));
    assert.equal(f.calls.filter(([name])=>name==='verify').length,2);
  }
});
