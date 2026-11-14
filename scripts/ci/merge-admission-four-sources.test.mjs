import test from 'node:test';
import {retiredProfilesRaw,retiredRolesRaw,retiredWorkflowBlob} from './fixtures/retired-gated-proof-catalogue.mjs';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {registerHooks} from 'node:module';

// In-repository execution needs no override. The private author copy resolves
// only its three sibling helpers to the explicitly supplied current checkout.
const here=path.dirname(fileURLToPath(import.meta.url));
const repo=process.env.CLUED_FOUR_SOURCE_REPO_ROOT||path.resolve(here,'../..');
const moduleURL=pathToFileURL(process.env.CLUED_FOUR_SOURCE_MODULE_PATH||path.join(here,'merge-admission-four-sources.mjs')).href;
const helperNames=new Set(['./merge-admission-measurement-history.mjs','./clued-gated-proof.mjs','./clued-workflow-profile.mjs']);
registerHooks({resolve(specifier,context,next){if(context.parentURL===moduleURL&&helperNames.has(specifier))
  return next(pathToFileURL(path.join(repo,'scripts/ci',specifier.slice(2))).href,context);
  return next(specifier,context);}});
const {readMergeAdmissionFourSources:read,MERGE_ADMISSION_FOUR_SOURCE_PROTOCOL:FOUR_SOURCE_CONTRACT,MERGE_ADMISSION_FOUR_SOURCE_PROTOCOL_V2:FOUR_SOURCE_CONTRACT_V2,
  parseFourSourceRawData:parseRawFourSourceDataCandidate,updateOperationObservation:produceOperation,finalAdmissionObservation:produceAdmission,admissionDisplayNames}=await import(moduleURL);
const {registeredWorkflowSource,parseWorkflowProfiles}=await import(pathToFileURL(path.join(repo,'scripts/ci/clued-workflow-profile.mjs')).href);
const {loadHistoricalWorkflowProfiles69e}=await import(pathToFileURL(path.join(repo,'scripts/ci/fixtures/workflow-profiles-69e30b6/fixture.mjs')).href);
const {applicableCI}=await import(pathToFileURL(path.join(repo,'scripts/ci/clued-gated-proof.mjs')).href);
// Deterministic reader checkout marker; fixture Sources below are explicit data,
// not a claim that the current working tree was qualified at this commit.
const fixture=process.env.CLUED_FOUR_SOURCE_TEST_COMMIT||'891ea2e7a68e0a3201b64a8fd173f4d50a4c18dc';
const sourceText=relative=>readFileSync(path.join(repo,relative),'utf8');
const sourceBlob=relative=>{const text=sourceText(relative);return createHash('sha1').update('blob '+Buffer.byteLength(text)+'\0').update(text).digest('hex');};
const h=x=>createHash('sha256').update(x).digest('hex');
const SOURCE={repository:'tdoljyj/cross-memory-system',commit:fixture,source_checkout_sha:fixture,default_branch:'main',
  grammar:FOUR_SOURCE_CONTRACT.admission_grammar,app_id:5164952,
  script_path:'scripts/ci/clued-work-admission.mjs',workflow_path:'.github/workflows/clued-work-admission.yml',
  reverify_workflow_path:'.github/workflows/clued-work-admission-reverify.yml',policy_path:'config/merge-admission-policy.json'};
for(const k of ['script','workflow','reverify_workflow','policy'])SOURCE[k+'_blob']=sourceBlob(SOURCE[k+'_path']);
const sources=JSON.stringify({script:sourceText(SOURCE.script_path),workflow:sourceText(SOURCE.workflow_path),
  reverify_workflow:sourceText(SOURCE.reverify_workflow_path),policy:sourceText(SOURCE.policy_path)});
// The synthetic execution world is the last catalogue whose Full set still had the quality gate and clued-components
// (both deleted with their entries); the four-source rules under test do not depend on which catalogue is current.
const profiles=retiredProfilesRaw().toString('utf8'),roles=retiredRolesRaw().toString('utf8');
const legacyProfiles='{"schema":"unsupported-profile-fixture","workflows":{}}';
const PROFILE_SOURCE_SHA256=h(profiles),ROLE_SOURCE_SHA256=h(roles),EXECUTION_SOURCE_COMMIT=fixture;
const scope={project_id:'0597aa60-9b98-4da6-a4ab-63d7705b632f',queue_ref:'merge:tdoljyj/cross-memory-system:main'};
const admissionDescriptor=Object.fromEntries(Object.entries(SOURCE).filter(([k])=>!['repository','commit'].includes(k)));
const expectations={schema:FOUR_SOURCE_CONTRACT.expectations_schema,repository:SOURCE.repository,scope,
  admission_sources:[admissionDescriptor],execution_source:{source_checkout_sha:fixture,profiles_sha256:PROFILE_SOURCE_SHA256,role_specs_sha256:ROLE_SOURCE_SHA256}};
const expectationsRaw=JSON.stringify(expectations);
const sourcePackets=JSON.stringify([{source_checkout_sha:fixture,sources_raw:sources}]);
// Registry-defined synthetic execution world: this does not qualify working-tree workflows.
const registryObject=parseWorkflowProfiles(profiles);
const executionEntries=Object.entries(registryObject.workflows).map(([workflow_file,profile])=>{
  // A deleted workflow keeps the bytes it had when the retired catalogue was current.
  const candidate=existsSync(path.join(repo,workflow_file))?sourceBlob(workflow_file):retiredWorkflowBlob(workflow_file),
    actual=registeredWorkflowSource(registryObject,workflow_file,candidate);
  // Keep an explicitly registered fixture Source where the working-tree Source
  // is not yet registered. The separate counterexample below must still refuse it.
  return {workflow_file,workflow_blob:actual.passed?candidate:profile.workflow_blob};
});
const selectedProfileObject={workflows:Object.fromEntries(executionEntries.map(x=>{const q=registeredWorkflowSource(registryObject,x.workflow_file,x.workflow_blob);
  assert.equal(q.passed,true,'registry-defined fixture Source must actually register');return [x.workflow_file,q.profile];}))};
test('registry-defined synthetic execution fixtures do not qualify two unregistered current External Sources',()=>{
  for(const file of ['.github/workflows/clued-handover-external-qualification.yml','.github/workflows/clued-handover-disposable-idle.yml']){
    const actual=registeredWorkflowSource(registryObject,file,sourceBlob(file));
    assert.equal(actual.passed,false,file);
    assert.match(actual.reason,/exact source has no unique current registration/,file);
  }
});
const head='a'.repeat(40),at=second=>'2026-10-11T06:00:'+String(second).padStart(2,'0')+'.000000Z';
// F1's original, actually executed counterexample remains as a retained test.
// The old reader accepted this missing target batch as a complete zero.
test('F1: a Native admission attempt without any target batch never produces ready zero',()=>{
  const names=['attempts','targets','admissions','operations','head_moves','rounds','cancellations'];
  const p={repository:SOURCE.repository,window:{start:at(0),end:at(59)},coverage:{fixed_watermark:'supplied',pages_complete:true,unknown_target_batches:0,manual_update_source_complete:true},sources_raw:sources,proof_profiles_raw:legacyProfiles};
  for(const n of names){p[n]=[];p.coverage[n+'_total']=0;}
  p.attempts=[{run_id:'42',attempt:1,pr_number:727,head_sha:head,kind:'admission',status:'completed',conclusion:'cancelled',started_at:at(1),completed_at:at(3)}];p.coverage.attempts_total=1;
  const r=read(JSON.stringify(p));
  assert.notEqual(r.candidate_ready,true,'Missing batch must not become complete zero');
});

const names=['attempts','targets','admission_batches','admissions','operations','head_moves','rounds','cancellations'];
const sourceIds={attempts:'native_attempts',targets:'admission_targets',admission_batches:'admission_selection_journal',admissions:'final_admission_journal',
  operations:'operation_journal_all_origins',head_moves:'native_head_move_journal',rounds:'final_round_journal',cancellations:'native_cancel_evidence'};

const sha64='d'.repeat(64),base='b'.repeat(40),nextHead='c'.repeat(40),nextMain='d'.repeat(40);
const uuid=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const time=n=>new Date(Date.parse('2026-10-11T06:00:00Z')+n*1000).toISOString().replace('.000Z','.000000Z');
const hash=x=>createHash('sha256').update(x).digest('hex');
const call=p=>read(JSON.stringify(p),expectationsRaw),copy=p=>structuredClone(p);
function boundaries(r){assert.equal(r.source_authenticated,false);assert.equal(r.official_metric,false);assert.equal(r.execution_permission,false);assert.equal(r.t0,null);}
function packet(){
  const p={schema:FOUR_SOURCE_CONTRACT.schema,repository:SOURCE.repository,scope:copy(scope),window:{start:time(0),end:time(59)},
    collection:{watermark:'snapshot.20',closed_at:time(90),window_status:'closed',retention_start:time(0)},populations:{},
    sources_raw:sourcePackets,proof_profiles_raw:profiles,role_specs_raw:roles,
    execution_sources:{source_checkout_sha:EXECUTION_SOURCE_COMMIT,entries:structuredClone(executionEntries),manifest:null}};
  for(const n of names)p[n]=[];return seal(p);
}
function members(n,rows){return rows.map(x=>['attempts','admission_batches','cancellations'].includes(n)?`${x.run_id}:${x.attempt}`:
  n==='targets'?`${x.run_id}:${x.attempt}:${x.pr_number}:${x.head_sha}`:n==='admissions'?x.target_key:n==='operations'?x.operation_id:n==='head_moves'?x.move_id:x.round_id);}
function manifest(p,sourceId,list){
  const barrier={snapshot_id:'fixed.20',total:list.length,member_digest:hash(JSON.stringify(list)),first_member:list[0]??null,last_member:list.at(-1)??null};
  return {reader_source:p.schema===FOUR_SOURCE_CONTRACT_V2?.schema?FOUR_SOURCE_CONTRACT_V2.reader_source:FOUR_SOURCE_CONTRACT.reader_source,source_id:sourceId,scope:copy(scope),cohort:FOUR_SOURCE_CONTRACT.population_cohort,
    window:copy(p.window),retention_start:time(0),watermark:p.collection.watermark,collected_at:p.collection.closed_at,
    before:{...barrier,read_id:'before.'+sourceId},after:{...barrier,read_id:'after.'+sourceId},pages:[{page:1,cursor:null,next_cursor:null,members:list}]};
}
function seal(p){
  for(const n of names)p.populations[n]=manifest(p,sourceIds[n],members(n,p[n]));
  p.execution_sources.manifest=manifest(p,'native_execution_workflow_sources:'+p.execution_sources.source_checkout_sha,p.execution_sources.entries.map(x=>x.workflow_file+':'+x.workflow_blob));
  for(const s of p.previous_execution_snapshots??[])s.execution_sources.manifest=manifest(p,'native_execution_workflow_sources:'+s.source_checkout_sha,s.execution_sources.entries.map(x=>x.workflow_file+':'+x.workflow_blob));
  for(const r of p.rounds)for(const x of r.execution_packets)x.jobs_manifest=manifest(p,'native_jobs:'+x.run_key,x.jobs.map(j=>String(j.id)));
  return p;
}
function nativeAdmission({conclusion='success',entry='required'}={}){
  const run={run_id:'42',attempt:1,pr_number:727,head_sha:head,kind:'admission',status:'completed',conclusion,started_at:time(1),completed_at:time(6)};
  const t={run_id:'42',attempt:1,pr_number:727,head_sha:head,entry,scope:copy(scope),selected_at:time(1)};
  const k=`42:1:727:${head}`;
  const batch={run_id:'42',attempt:1,entry,scope:copy(scope),initial:{receipt_id:'initial.42',event_at:time(1),collected_at:time(2),target_keys:[k]},selection_events:[],
    closing:{receipt_id:'closing.42',event_at:time(6),collected_at:time(7),status:conclusion==='cancelled'?'cancelled':conclusion==='success'?'completed':'failed',target_keys:[k]},ever_target_keys:[k]};
  const ep={schema:FOUR_SOURCE_CONTRACT.admission_packet_schema,identity:{repository:SOURCE.repository,pr_number:727,head_sha:head,run_id:'42',run_attempt:1,job_id:'101',entry,dispatch_reason:null,source_checkout_sha:SOURCE.commit,
    native_pr:{number:727,head_sha:head,base_repository:SOURCE.repository,base_ref:'main',default_branch:'main',state:'open',draft:false},
    native_run:{id:42,run_attempt:1,event:'pull_request_target',path:SOURCE.workflow_path,head_sha:base,head_branch:'main',pull_requests:[727],status:'completed',conclusion,run_started_at:time(1)},
    native_job:{id:101,run_id:42,run_attempt:1,name:'kooyumi-work-admission',status:'completed',conclusion}},
    timing:{decision_at:time(3),observed_at:time(4)},final_decision_observed:true,
    outcome:{mode:'required',event:'pull_request_target',enforced:true,head_sha:head,pr_ref:`${SOURCE.repository}#727`,claim_id:uuid(1),admitted:true,
      verdict:'ADMITTED',reasons:[],admission_mode:{state:'normal',layer:'code'}},
    claim_observation:{disposition:'valid',claim_id:uuid(1),verified_at:time(2),rpc_verdict:'ADMITTED',reasons:[],head_admitted_receipt_id:uuid(2)},
    admit_step_outcome:'success',selection_observation:null,
    app_observation:{id:555,app_id:SOURCE.app_id,name:'kooyumi-admission-verified',head_sha:head,pr_number:727,run_id:42,run_attempt:1,external_id:'pr:727:run:42',status:'completed',conclusion:'success'}};
  if(entry!=='required'){
    ep.identity.dispatch_reason=entry==='rejudge'?'state_change':'scheduled';ep.identity.native_run.event=entry==='rejudge'?'workflow_dispatch':'schedule';
    ep.identity.native_run.path=SOURCE.reverify_workflow_path;ep.identity.native_job.name='clued-work-admission-reverify';
    ep.outcome.mode=null;ep.admit_step_outcome=null;ep.selection_observation=entry==='reverify'?{admission_green:true,slot_green:false}:null;ep.app_observation=null;
  }
  return {run,t,k,batch,ep};
}
test('historical display names come from exact Source bytes and cannot substitute for current Kooyumi checks',()=>{
  const current=JSON.parse(sources);
  assert.deepEqual(admissionDisplayNames(current),{app_check_name:'kooyumi-admission-verified',job_name:'kooyumi-work-admission'});
  const old={...current,script:current.script.replace('export const APP_CHECK_NAME = "kooyumi-admission-verified";',
    'export const APP_CHECK_NAME = "clued-admission-verified";'),workflow:current.workflow.replace('    name: kooyumi-work-admission','    name: clued-work-admission')};
  assert.deepEqual(admissionDisplayNames(old),{app_check_name:'clued-admission-verified',job_name:'clued-work-admission'});
  const {ep}=nativeAdmission();
  assert.equal(produceAdmission(JSON.stringify(ep),sources,expectationsRaw).status,'ADMISSION_PACKET_CANDIDATE');
  for(const mutate of [p=>p.app_observation.name='clued-admission-verified',p=>p.identity.native_job.name='clued-work-admission',
    p=>p.app_observation.app_id=15368]){
    const bad=copy(ep);mutate(bad);
    assert.notEqual(produceAdmission(JSON.stringify(bad),sources,expectationsRaw).status,'ADMISSION_PACKET_CANDIDATE');
  }
});
function addAdmission(p,opts){const a=nativeAdmission(opts);p.attempts.push(a.run);p.targets.push(a.t);p.admission_batches.push(a.batch);
  p.admissions.push({target_key:a.k,packet_raw:JSON.stringify(a.ep),collected_at:time(7)});return {p:seal(p),a};}
test('current guarded publication suffix retains its real settlement while malformed, revoked and wrong-epoch publications fail closed',()=>{
  const {p,a}=addAdmission(packet()),publication={publication_id:uuid(20),begin_receipt_id:uuid(21),begin_execution_epoch:3,
    finish_receipt_id:uuid(22),finish_execution_epoch:3,finish_status:'committed',must_revoke:false};
  a.ep.app_observation.external_id+=`:publication:${publication.publication_id}`;a.ep.app_observation.publication_observation=publication;
  p.admissions[0].packet_raw=JSON.stringify(a.ep);assert.equal(call(seal(p)).candidate_ready,true);
  for(const patch of [{must_revoke:true},{finish_execution_epoch:4},{finish_receipt_id:null},{finish_status:'rejected'}]){
    const bad=structuredClone(a.ep);Object.assign(bad.app_observation.publication_observation,patch);
    p.admissions[0].packet_raw=JSON.stringify(bad);assert.notEqual(call(seal(p)).candidate_ready,true);}
  const missing=structuredClone(a.ep);delete missing.app_observation.publication_observation;p.admissions[0].packet_raw=JSON.stringify(missing);
  assert.notEqual(call(seal(p)).candidate_ready,true);
});
function gap(ep){ep.final_decision_observed=false;ep.timing={decision_at:null,observed_at:time(6)};ep.outcome=null;ep.claim_observation=null;
  ep.admit_step_outcome=null;ep.app_observation=null;return ep;}
function operationFixture({start=10,main=base,status=202,after=true}={}){
  const b={scope:copy(scope),operation_id:uuid(201),pr_number:727,origin:'executor',request_at:time(start),request_collected_at:time(start+1),
    reason_code:'MAIN_MOVED_REQUIRES_RERUN',request_receipt_id:'request.201',claim_id:uuid(1),fence:11,source_ref:sha64,
    native_pre:{number:727,head_sha:head,main_sha:main,event_at:time(start-2),collected_at:time(start-1),observation_id:'native.pre.201'}};
  const r={operation_id:b.operation_id,request_receipt_id:b.request_receipt_id,status,event_at:time(start+2),collected_at:time(start+3),response_receipt_id:'response.201'};
  const a={operation_id:b.operation_id,number:727,head_sha:nextHead,main_sha:main,parents:[head,main],event_at:time(start+5),collected_at:time(start+6),observation_id:'native.post.201'};
  const produced=produceOperation(JSON.stringify(b),JSON.stringify(r),after?JSON.stringify(a):null,expectationsRaw);assert.equal(produced.status,'UPDATE_OPERATION_PACKET_CANDIDATE');boundaries(produced);
  const move={move_id:uuid(202),pr_number:727,old_head_sha:head,new_head_sha:nextHead,event_at:time(start+5),collected_at:time(start+6),operation_id:b.operation_id,observation_id:'native.post.201'};
  return {b,r,a,o:produced.operation,move};
}
function addOperation(p,opt){const x=operationFixture(opt);p.operations.push(x.o);if(opt?.after!==false)p.head_moves.push(x.move);return {p:seal(p),x};}

test('fixed byte-consistent empty manifests yield a mathematical zero, never actual population or T0',()=>{
  const r=call(packet());boundaries(r);assert.equal(r.status,'FOUR_SOURCE_CALCULATION_CANDIDATE');assert.equal(r.candidate_ready,true);
  assert.equal(r.supplied_data_consistency,true);assert.equal(r.supplied_population_manifest_complete,true);
  assert.equal(r.actual_population_completeness,'NOT_ESTABLISHED');assert.equal(r.source_permission_qualification,'NOT_ESTABLISHED');
  assert.equal(r.metrics.update_main_rounds.value,0);assert.equal(r.metrics.unclaimed_admitted.value,0);
});
test('F1: v2 complete attempt manifest with missing batch is population gap, not zero',()=>{
  const p=packet(),a=nativeAdmission({conclusion:'cancelled'});p.attempts.push(a.run);seal(p);
  const r=call(p);assert.equal(r.candidate_ready,false);assert.ok(r.population_gaps.includes('missing_admission_batch:42:1'));assert.equal(r.metrics.unclaimed_admitted.value,null);
});
test('F1: targets cannot disappear after initial selection or while being removed at close',()=>{
  const {p,a}=addAdmission(packet());p.admission_batches[0].selection_events=[{seq:1,receipt_id:'remove.42',event_at:time(5),collected_at:time(6),kind:'unselected',target_key:a.k}];
  p.admission_batches[0].closing.target_keys=[];let r=call(seal(p));assert.equal(r.candidate_ready,true);assert.equal(r.metrics.unclaimed_admitted.denominator,1);
  p.targets=[];p.admissions=[];r=call(seal(p));assert.equal(r.candidate_ready,false);assert.equal(r.metrics.unclaimed_admitted.value,null);
});
test('F1: a target first selected after initial snapshot is retained through ever-target and terminal closure',()=>{
  const {p,a}=addAdmission(packet(),{entry:'reverify'});p.targets[0].selected_at=time(3);p.admission_batches[0].initial.target_keys=[];
  p.admission_batches[0].selection_events=[{seq:1,receipt_id:'selected.later',event_at:time(3),collected_at:time(4),kind:'selected',target_key:a.k}];
  a.ep.timing={decision_at:time(4),observed_at:time(5)};a.ep.claim_observation.verified_at=time(3);p.admissions[0].packet_raw=JSON.stringify(a.ep);
  const r=call(seal(p));assert.equal(r.candidate_ready,true);assert.equal(r.metrics.unclaimed_admitted.denominator,1);assert.equal(r.metrics.unclaimed_admitted.admitted_with_valid_claim,1);
  p.admission_batches[0].ever_target_keys=[];assert.equal(call(seal(p)).status,'NOT_QUALIFIED');
});
test('F1/F6: explicitly closed scoped empty reverify batch yields supplied zero without a missing-batch loophole',()=>{
  const p=packet(),a=nativeAdmission({entry:'reverify'});p.attempts.push(a.run);a.batch.initial.target_keys=[];a.batch.closing.target_keys=[];a.batch.ever_target_keys=[];p.admission_batches.push(a.batch);
  const r=call(seal(p));assert.equal(r.candidate_ready,true);assert.equal(r.metrics.unclaimed_admitted.denominator,0);assert.equal(r.metrics.unclaimed_admitted.value,0);boundaries(r);
});
test('F1: missing final packet is a real population gap, explicit terminal GAP is semantic unknown',()=>{
  const {p,a}=addAdmission(packet(),{conclusion:'cancelled'});p.admissions[0].packet_raw=JSON.stringify(gap(a.ep));
  let r=call(seal(p));assert.equal(r.candidate_ready,true);assert.equal(r.metrics.unclaimed_admitted.value,null);
  assert.equal(r.metrics.unclaimed_admitted.explicit_no_final_decision,1);assert.equal(r.semantic_unknown_is_not_population_gap,true);
  p.admissions=[];r=call(seal(p));assert.equal(r.candidate_ready,false);assert.ok(r.population_gaps.includes('missing_final_admission_packets'));
});
test('historical final producer observation may progress to Native completion without becoming a missing packet',()=>{
  const {p,a}=addAdmission(packet());a.ep.identity.native_run.status='in_progress';a.ep.identity.native_run.conclusion=null;
  a.ep.identity.native_job.status='in_progress';a.ep.identity.native_job.conclusion=null;p.admissions[0].packet_raw=JSON.stringify(a.ep);
  assert.equal(call(seal(p)).candidate_ready,true);
  a.ep.timing.decision_at=time(8);a.ep.timing.observed_at=time(9);p.admissions[0].packet_raw=JSON.stringify(a.ep);assert.equal(call(seal(p)).status,'NOT_QUALIFIED');
});
test('F1: discontinuous pages, unstable members, changed watermarks and omitted pagination cannot produce ready zero',()=>{
  for(const change of [p=>delete p.populations.attempts,p=>p.populations.attempts.pages[0].next_cursor='not.fetched',
    p=>p.populations.attempts.after.total=1,p=>p.populations.attempts.after.member_digest='f'.repeat(64),
    p=>p.populations.attempts.watermark='other']){
    const p=packet();change(p);assert.notEqual(call(p).candidate_ready,true);
  }
});
test('F1: consistent two-page transcript checks cursor continuity and actual member list',()=>{
  const p=packet();for(let n=1;n<=2;n++)p.attempts.push({run_id:String(n),attempt:1,pr_number:null,head_sha:head,kind:'other',status:'completed',conclusion:'success',started_at:time(1),completed_at:time(2)});
  seal(p);p.populations.attempts.pages=[{page:1,cursor:null,next_cursor:'second',members:['1:1']},{page:2,cursor:'second',next_cursor:null,members:['2:1']}];
  assert.equal(call(p).candidate_ready,true);p.populations.attempts.pages[1].cursor='wrong';assert.equal(call(p).status,'NOT_QUALIFIED');
});
test('F2: typed fixed Project/queue, reader contract and source bytes are independently constrained even for zero',()=>{
  for(const change of [p=>p.scope.project_id=uuid(7),p=>p.scope.queue_ref='merge:tdoljyj/other:main',
    p=>p.populations.operations.reader_source='caller.authority',p=>p.proof_profiles_raw=legacyProfiles,
    p=>p.role_specs_raw='{}',p=>p.sources_raw='{}']){const p=packet();change(p);assert.equal(call(p).status,'NOT_QUALIFIED');}
});
test('F2/F6: caller authenticity booleans and totals are neither accepted schema nor source permission',()=>{
  const p=packet();p.source_authenticated=true;assert.equal(call(p).status,'NOT_QUALIFIED');delete p.source_authenticated;
  p.populations.attempts.pages_complete=true;assert.equal(call(p).status,'NOT_QUALIFIED');
});
test('F4: actual supplied request, response, separate Native pre/post and move bind one candidate update',()=>{
  const {p}=addOperation(packet());const r=call(p);boundaries(r);assert.equal(r.candidate_ready,true);assert.equal(r.metrics.update_main_rounds.value,1);
});
test('F4: failed operation does not swallow linked Native move as updates zero',()=>{
  const {p}=addOperation(packet(),{status:403});const r=call(p);assert.equal(r.candidate_ready,true);
  assert.equal(r.metrics.update_main_rounds.value,null);assert.equal(r.metrics.update_main_rounds.unattributed_head_moves,1);
  assert.equal(r.metrics.update_main_rounds.linked_failed_operation_moves,1);assert.equal(r.metrics.update_main_rounds.failed_request_intents,1);
});
test('F4/F6: 202 request without any observed head move is a pending intent, not an update or population failure',()=>{
  const {p}=addOperation(packet(),{after:false});const r=call(p);assert.equal(r.candidate_ready,true);
  assert.equal(r.metrics.update_main_rounds.value,0);assert.equal(r.metrics.update_main_rounds.accepted_not_confirmed_intents,1);
});
test('F4: pending operation with real unmatched move remains UNKNOWN',()=>{
  const {p,x}=addOperation(packet(),{after:false});p.head_moves.push(x.move);const r=call(seal(p));
  assert.equal(r.candidate_ready,true);assert.equal(r.metrics.update_main_rounds.value,null);assert.equal(r.metrics.update_main_rounds.unattributed_head_moves,1);
});
test('F4: a move preceding request, conflicting identities or a fabricated failed confirmation rejects',()=>{
  for(const change of [p=>p.head_moves[0].event_at=time(9),p=>p.head_moves[0].pr_number=728,p=>p.head_moves[0].observation_id='unrelated',
    p=>p.operations[0].response_status=403,p=>p.operations[0].pre_observation_at=time(11),
    p=>p.operations[0].confirmation.request_receipt_id='other']){const {p}=addOperation(packet());change(p);assert.equal(call(seal(p)).status,'NOT_QUALIFIED');}
});
test('F4: window is move-event cohort; late confirmation collected before fixed close is explicit',()=>{
  const {p}=addOperation(packet());p.window.end=time(16);p.operations[0].confirmation.event_at=time(20);p.operations[0].confirmation.collected_at=time(21);
  const r=call(seal(p));assert.equal(r.candidate_ready,true);assert.equal(r.metrics.update_main_rounds.value,1);assert.equal(r.metrics.update_main_rounds.late_confirmations_before_watermark,1);
  p.operations[0].confirmation.collected_at=time(91);assert.equal(call(seal(p)).status,'NOT_QUALIFIED');
});
test('F2/F4: producer refuses response identity, native-pre restatement, chronology and claim/fence mismatch',()=>{
  const x=operationFixture();for(const change of [y=>y.r.operation_id=uuid(777),y=>y.b.native_pre.collected_at=time(11),
    y=>y.b.native_pre.number=728,y=>y.a.observation_id=y.b.native_pre.observation_id,y=>y.b.fence=null]){
    const y=copy(x);change(y);assert.equal(produceOperation(JSON.stringify(y.b),JSON.stringify(y.r),JSON.stringify(y.a),expectationsRaw).status,'NOT_QUALIFIED');}
});
test('F5: complete Native cancelled population keeps unknown cause without requiring an admin audit',()=>{
  const p=packet();p.attempts.push(nativeAdmission({conclusion:'cancelled'}).run);p.attempts[0].kind='other';
  const r=call(seal(p));assert.equal(r.candidate_ready,true);assert.equal(r.metrics.cancellation_causes.denominator,1);
  assert.equal(r.metrics.cancellation_causes.value.UNKNOWN_CAUSE,1);assert.equal(r.metrics.cancellation_causes.cause_coverage,0);
});
test('F5: actual cancel event and collected time differ; late causal observation is allowed up to fixed close',()=>{
  const p=packet(),a=nativeAdmission({conclusion:'cancelled'}).run;a.kind='other';p.attempts.push(a);
  p.cancellations.push({run_id:'42',attempt:1,basis:'platform_causal_receipt',reason_code:'PLATFORM_CONCURRENCY_CANCELLATION',event_at:time(5),collected_at:time(70),request_id:'request.cancel.42',provider_receipt_id:'provider.cancel.42'});
  const r=call(seal(p));assert.equal(r.candidate_ready,true);assert.equal(r.metrics.cancellation_causes.known_cause_count,1);assert.equal(r.metrics.cancellation_causes.late_evidence_before_watermark,1);
  p.cancellations[0].event_at=time(7);assert.equal(call(seal(p)).status,'NOT_QUALIFIED');
});
test('F5: cancel intent remains UNKNOWN cause, and Native actor cannot masquerade as canceller',()=>{
  const p=packet(),a=nativeAdmission({conclusion:'cancelled'}).run;a.kind='other';p.attempts.push(a);
  p.cancellations.push({run_id:'42',attempt:1,basis:'explicit_operation_receipt',reason_code:'OWNER_STOP_REQUEST',event_at:time(5),collected_at:time(70),request_id:'request.cancel.42',provider_receipt_id:null});
  const r=call(seal(p));assert.equal(r.metrics.cancellation_causes.known_cause_count,0);assert.equal(r.metrics.cancellation_causes.value.UNKNOWN_CAUSE,1);
  assert.equal(r.metrics.cancellation_causes.explicit_requests_by_intent.OWNER_STOP_REQUEST,1);
  p.cancellations[0].actor='owner';assert.equal(call(seal(p)).status,'NOT_QUALIFIED');
});

// N1: completed_at is the supplied actual Native terminal observation here.
// No test derives it or started_at from updated_at/created_at/collection time.
test('N1: known-terminal never-started other/ci cancellations retain UNKNOWN denominator',()=>{
  for(const kind of ['other','ci']){
    const p=packet(),a=nativeAdmission({conclusion:'cancelled'}).run;a.kind=kind;a.started_at=null;p.attempts.push(a);
    const r=call(seal(p));assert.equal(r.status,'FOUR_SOURCE_CALCULATION_CANDIDATE');assert.equal(r.candidate_ready,true);
    assert.equal(r.metrics.cancellation_causes.denominator,1);assert.equal(r.metrics.cancellation_causes.value.UNKNOWN_CAUSE,1);
    assert.equal(r.metrics.cancellation_causes.known_cause_count,0);assert.equal(r.metrics.cancellation_causes.cause_coverage,0);boundaries(r);
  }
});
test('N1: valid pre-start request is intent; only an actual provider causal receipt establishes known cause',()=>{
  for(const started of [null,time(4)])for(const basis of ['explicit_operation_receipt','platform_causal_receipt']){
    const p=packet(),a=nativeAdmission({conclusion:'cancelled'}).run;a.kind='other';a.started_at=started;p.attempts.push(a);
    p.cancellations.push({run_id:'42',attempt:1,basis,reason_code:'OWNER_STOP_REQUEST',event_at:time(2),collected_at:time(7),
      request_id:'request.prestart.42',provider_receipt_id:basis==='platform_causal_receipt'?'provider.prestart.42':null});
    const r=call(seal(p));assert.equal(r.candidate_ready,true);assert.equal(r.metrics.cancellation_causes.denominator,1);
    assert.equal(r.metrics.cancellation_causes.known_cause_count,basis==='platform_causal_receipt'?1:0);
    assert.equal(r.metrics.cancellation_causes.value.UNKNOWN_CAUSE,basis==='platform_causal_receipt'?0:1);
    if(basis==='explicit_operation_receipt')assert.equal(r.metrics.cancellation_causes.explicit_requests_by_intent.OWNER_STOP_REQUEST,1);
  }
});
test('N1: unknown actual terminal membership is a retained genuine gap, never a complete zero',()=>{
  const p=packet(),a=nativeAdmission({conclusion:'cancelled'}).run;a.kind='other';a.started_at=null;a.completed_at=null;p.attempts.push(a);
  const r=call(seal(p));assert.equal(r.status,'FOUR_SOURCE_CALCULATION_CANDIDATE');assert.equal(r.candidate_ready,false);
  assert.ok(r.population_gaps.includes('native_terminal_membership_unknown:42:1'));
  assert.equal(r.metrics.cancellation_causes.value,null);assert.equal(r.metrics.cancellation_causes.denominator,null);
  assert.equal(r.metrics.cancellation_causes.observed_known_denominator,0);assert.equal(r.metrics.cancellation_causes.membership_unknown_count,1);
  assert.equal(r.metrics.cancellation_causes.cause_coverage,null);assert.equal(r.metrics.cancellation_causes.fully_explained,false);
  assert.equal(p.attempts[0].started_at,null);assert.equal(p.attempts[0].completed_at,null);
});
test('N1: scoped ever-target closure and explicit no-final GAP can retain a never-started admission with no Native job',()=>{
  const {p,a}=addAdmission(packet(),{conclusion:'cancelled'});a.run.started_at=null;
  gap(a.ep);a.ep.identity.native_run.run_started_at=null;a.ep.identity.job_id=null;a.ep.identity.native_job=null;
  p.admissions[0].packet_raw=JSON.stringify(a.ep);
  const r=call(seal(p));assert.equal(r.candidate_ready,true);assert.equal(r.supplied_population_manifest_complete,true);
  assert.equal(r.metrics.unclaimed_admitted.denominator,1);assert.equal(r.metrics.unclaimed_admitted.explicit_no_final_decision,1);
  assert.equal(r.metrics.cancellation_causes.denominator,1);assert.equal(r.metrics.cancellation_causes.value.UNKNOWN_CAUSE,1);
  const envelope=produceAdmission(JSON.stringify(a.ep),sources,expectationsRaw);assert.equal(envelope.status,'ADMISSION_PACKET_CANDIDATE');
  assert.equal(envelope.projection.status,'GAP');assert.equal(envelope.projection.identity.job_id,null);boundaries(envelope);
});
test('N1: nullable observation cannot manufacture FINAL admission or successful Full execution',()=>{
  const {p,a}=addAdmission(packet());a.run.started_at=null;a.ep.identity.native_run.run_started_at=null;p.admissions[0].packet_raw=JSON.stringify(a.ep);
  assert.equal(call(seal(p)).status,'NOT_QUALIFIED');
  a.ep.identity.job_id=null;a.ep.identity.native_job=null;p.admissions[0].packet_raw=JSON.stringify(a.ep);assert.equal(call(seal(p)).status,'NOT_QUALIFIED');
  const q=wastedFixture().p;q.attempts.find(x=>x.kind==='ci').started_at=null;assert.equal(call(seal(q)).status,'NOT_QUALIFIED');
});
test('N1: nullable cancelled rows still reject contradictory Native clocks and malformed lifecycle data',()=>{
  for(const change of [a=>a.completed_at=time(-1),a=>a.completed_at=time(91),a=>a.started_at='not.a.time',
    a=>a.status='in_progress']){
    const p=packet(),a=nativeAdmission({conclusion:'cancelled'}).run;a.kind='other';a.started_at=null;change(a);p.attempts.push(a);
    assert.equal(call(seal(p)).status,'NOT_QUALIFIED');
  }
});
test('N1: nullable start does not waive cancel receipt retention, event/collection order or terminal upper bound',()=>{
  for(const change of [x=>x.event_at=time(-1),x=>x.event_at=time(7),x=>x.collected_at=time(1),x=>x.provider_receipt_id=null]){
    const p=packet(),a=nativeAdmission({conclusion:'cancelled'}).run;a.kind='other';a.started_at=null;p.attempts.push(a);
    const x={run_id:'42',attempt:1,basis:'platform_causal_receipt',reason_code:'OWNER_STOP_REQUEST',event_at:time(2),collected_at:time(7),
      request_id:'request.prestart.42',provider_receipt_id:'provider.prestart.42'};change(x);p.cancellations.push(x);
    assert.equal(call(seal(p)).status,'NOT_QUALIFIED');
  }
});
test('F6: source/window close, supplied population and semantic UNKNOWN are separately reported',()=>{
  const p=packet();p.collection.window_status='open';assert.equal(call(p).candidate_ready,false);
  const {p:q}=addOperation(packet(),{after:false});const r=call(q);assert.equal(r.candidate_ready,true);assert.equal(r.source_permission_qualification,'NOT_ESTABLISHED');
  delete q.populations.operations;const missing=call(q);assert.equal(missing.candidate_ready,false);assert.equal(missing.metrics.update_main_rounds.value,null);
});
test('raw duplicate decoded keys and deep/oversized malformed structures refuse',()=>{
  assert.throws(()=>parseRawFourSourceDataCandidate('{"scope":1,"sco\\u0070e":2}'));
  assert.throws(()=>parseRawFourSourceDataCandidate('['.repeat(42)+'0'+']'.repeat(42)));
  const r=read('{"schema":1,"schema":2}');assert.equal(r.status,'NOT_QUALIFIED');boundaries(r);
});

const profileObject=parseWorkflowProfiles(profiles),fullFiles=Object.entries(selectedProfileObject.workflows).filter(([,p])=>p.pull_request===null).map(([f])=>f).sort();
let nextRun=1000,nextJob=5000;
function addRound(p,{rid=301,h=head,m=base,start=20,end=27,mergedAt=null,workflowFiles=fullFiles,profiles=selectedProfileObject,
  commit=EXECUTION_SOURCE_COMMIT,profileDigest=PROFILE_SOURCE_SHA256,roleDigest=ROLE_SOURCE_SHA256,changedFiles=['README.md']}={}){
  const r={round_id:uuid(rid),scope:copy(scope),pr_number:727,head_sha:h,main_sha:m,started_at:time(start),completed_at:time(end),run_keys:[],execution_packets:[],
    applicability:{changed_files:[...changedFiles],diff_complete:true,commit_count:1,workflow_files:[...workflowFiles],profile_sha256:profileDigest,source_checkout_sha:commit},
    termination:null,main_move:null,merge_proof:mergedAt===null?null:{receipt_id:'merge.'+rid,event_at:time(mergedAt),collected_at:time(mergedAt+1),
      round_id:uuid(rid),used_run_keys:[],operation_id:uuid(rid+500),expected_head_sha:h,response_merged_commit_sha:'e'.repeat(40),
      native_pr:{number:727,head_sha:h,state:'closed',merged:true,merged_at:time(mergedAt),merge_commit_sha:'e'.repeat(40)}}};
  for(const file of workflowFiles){
    const profile=profiles.workflows[file],routes=profile.execution_mode==='all_required_primaries'?profile.routes:
      [profile.routes.find(x=>x.self_hosted)??profile.routes[0]],run=++nextRun,runKey=`${run}:1`;
    const a={run_id:String(run),attempt:1,pr_number:727,head_sha:h,kind:'ci',status:'completed',conclusion:'success',started_at:time(start+1),completed_at:time(end-1)};
    p.attempts.push(a);r.run_keys.push(runKey);const jobs=[];
    if(profile.gated)jobs.push({id:++nextJob,run_id:run,run_attempt:1,name:'admission-gate',status:'completed',conclusion:'success',labels:['self-hosted'],steps:[]});
    for(const route of routes){
      const steps=Object.entries(route.required_steps).flatMap(([name,count])=>Array.from({length:count},()=>({name,status:'completed',conclusion:'success'})));
      // Compound Full execution keeps all three primaries on this run/attempt;
      // the migration no-op is present but skipped, never its Verify step.
      if(profile.execution_mode==='all_required_primaries'&&route.job_id==='migration-verify')
        steps.push({name:'Not affected',status:'completed',conclusion:'skipped'});
      jobs.push({id:++nextJob,run_id:run,run_attempt:1,name:route.name,status:'completed',conclusion:'success',labels:route.self_hosted?['self-hosted']:['ubuntu-slim'],steps});
    }
    const barrier={run_id:a.run_id,attempt:a.attempt,head_sha:a.head_sha,status:a.status,conclusion:a.conclusion};
    r.execution_packets.push({run_key:runKey,workflow_file:file,jobs,jobs_manifest:manifest(p,'native_jobs:'+runKey,jobs.map(x=>String(x.id))),before_attempt:copy(barrier),after_attempt:copy(barrier),
      source_descriptor:{workflow_blob:profile.workflow_blob,workflow_source_sha256:hash(profile.source_yaml),source_checkout_sha:commit,role:'primary_execution',role_source_sha256:roleDigest}});
  }
  if(r.merge_proof)r.merge_proof.used_run_keys=[...r.run_keys];p.rounds.push(r);seal(p);return r;
}

// Resident ADR 0032 step 2: the Windows side of the required tests has no path filter, so it is a Full member too,
// as an ordinary one-primary workflow (its own run; it never shares the compound run of clued-required-tests.yml).
test('current Full fixture retains five original workflows plus required-tests with three same-attempt primary jobs',()=>{
  assert.deepEqual(fullFiles,[
    '.github/workflows/clued-cloud-quality-gate.yml','.github/workflows/clued-components.yml',
    '.github/workflows/clued-required-tests-windows.yml','.github/workflows/clued-required-tests.yml','.github/workflows/contract-placement.yml',
    '.github/workflows/gitleaks.yml','.github/workflows/trivy.yml']);
  const p=packet(),round=addRound(p),required=round.execution_packets.find(x=>x.workflow_file==='.github/workflows/clued-required-tests.yml');
  assert.ok(required);assert.equal(round.execution_packets.length,7);assert.equal(p.attempts.length,7);
  const windows=round.execution_packets.find(x=>x.workflow_file==='.github/workflows/clued-required-tests-windows.yml');
  assert.deepEqual(windows.jobs.map(job=>job.name),['admission-gate','ci-suites-windows']);assert.notEqual(windows.run_key,required.run_key);
  assert.deepEqual(required.jobs.map(job=>job.name),['admission-gate','clued-cloud-tests','ci-suites','migration-verify']);
  assert.equal(new Set(required.jobs.map(job=>job.id)).size,4);
  assert.ok(required.jobs.every(job=>job.run_id===required.jobs[0].run_id&&job.run_attempt===1));
  const migration=required.jobs.find(job=>job.name==='migration-verify');
  assert.equal(migration.steps.find(step=>step.name==='Not affected').conclusion,'skipped');
  assert.equal(migration.steps.find(step=>step.name==='Verify migrations on the production schema').conclusion,'success');
  assert.equal(call(p).metrics.wasted_final_rounds.non_successful_rounds,0);
  for(const name of ['clued-cloud-tests','ci-suites','migration-verify']){
    const bad=copy(p),x=bad.rounds[0].execution_packets.find(x=>x.workflow_file==='.github/workflows/clued-required-tests.yml');
    x.jobs=x.jobs.filter(job=>job.name!==name);
    assert.equal(call(seal(bad)).metrics.wasted_final_rounds.non_successful_rounds,1,'no primary can borrow another job success');
  }
});
const addedHistoryWorkflowFiles=['.github/workflows/clued-handover-external-qualification.yml','.github/workflows/clued-handover-disposable-idle.yml'];
function historicalRoundFixture({optionalGit=false,v2=false}={}){
  // Reconstruct the frozen 22/20 historical worlds from exact reviewed 69e
  // bytes, never by subtracting files from the mutable current catalogue.
  const fixed=loadHistoricalWorkflowProfiles69e(),currentRegistry=parseWorkflowProfiles(fixed.profilesRaw),
    currentEntries=Object.entries(currentRegistry.workflows).map(([workflow_file,p])=>({workflow_file,workflow_blob:p.workflow_blob})),
    currentSelected={workflows:Object.fromEntries(currentEntries.map(e=>{const q=registeredWorkflowSource(currentRegistry,e.workflow_file,e.workflow_blob);
      assert.equal(q.passed,true);return [e.workflow_file,q.profile];}))},
    currentDescriptor={source_checkout_sha:fixed.commit,profiles_sha256:hash(fixed.profilesRaw),role_specs_sha256:hash(fixed.rolesRaw)};
  let commit='f'.repeat(40),oldProfilesRaw,oldRolesRaw;
  if(optionalGit&&Object.hasOwn(process.env,'CLUED_FOUR_SOURCE_HISTORY_COMMIT')){
    commit=process.env.CLUED_FOUR_SOURCE_HISTORY_COMMIT;assert.match(commit,/^[a-f0-9]{40}$/,'explicit history checkout must be exact SHA40');
    oldProfilesRaw=execFileSync('git',['show',commit+':scripts/ci/clued-gated-proof-profiles.json'],{cwd:repo,encoding:'utf8'});
    oldRolesRaw=execFileSync('git',['show',commit+':scripts/ci/clued-gated-proof-role-specs.json'],{cwd:repo,encoding:'utf8'});
  }else{
    const oldRegistry=copy(currentRegistry),oldRoles=JSON.parse(fixed.rolesRaw);
    for(const file of addedHistoryWorkflowFiles){delete oldRegistry.workflows[file];delete oldRoles.workflows[file];}
    oldProfilesRaw=JSON.stringify(oldRegistry);oldRolesRaw=JSON.stringify(oldRoles);
  }
  const oldRegistry=parseWorkflowProfiles(oldProfilesRaw),oldRoles=JSON.parse(oldRolesRaw);
  assert.equal(Object.keys(currentRegistry.workflows).length,22);assert.equal(Object.keys(oldRegistry.workflows).length,20);assert.equal(Object.keys(oldRoles.workflows).length,20);
  for(const file of addedHistoryWorkflowFiles){assert.equal(Object.hasOwn(oldRegistry.workflows,file),false);assert.equal(Object.hasOwn(oldRoles.workflows,file),false);}
  const entries=Object.entries(oldRegistry.workflows).map(([workflow_file,p])=>({workflow_file,workflow_blob:p.workflow_blob})),
    selected={workflows:Object.fromEntries(entries.map(e=>{const q=registeredWorkflowSource(oldRegistry,e.workflow_file,e.workflow_blob);assert.equal(q.passed,true);return [e.workflow_file,q.profile];}))},
    changedFiles=['scripts/ci/clued-handover-external-driver.mjs'],select=(entries,profiles)=>applicableCI({workflows:new Map(entries.map(e=>[e.workflow_file,e.workflow_blob])),profiles,changedFiles,commits:1,diffComplete:true,sourceQualified:true}),
    oldSelection=select(entries,selected),currentSelection=select(currentEntries,currentSelected);
  assert.equal(oldSelection.passed,true);assert.equal(currentSelection.passed,true);
  const workflowFiles=[...oldSelection.workflows.keys()].sort(),currentFiles=[...currentSelection.workflows.keys()].sort();
  assert.deepEqual(currentFiles.filter(file=>!workflowFiles.includes(file)),[...addedHistoryWorkflowFiles].sort());
  const descriptor={source_checkout_sha:commit,profiles_sha256:hash(oldProfilesRaw),role_specs_sha256:hash(oldRolesRaw)},
    snapshot={source_checkout_sha:commit,proof_profiles_raw:oldProfilesRaw,role_specs_raw:oldRolesRaw,execution_sources:{source_checkout_sha:commit,entries,manifest:null},
      main_history:{base_commit:commit,head_commit:fixed.commit,merge_base_commit:commit,status:commit===fixed.commit?'identical':'ahead'}},p=packet();
  p.proof_profiles_raw=fixed.profilesRaw;p.role_specs_raw=fixed.rolesRaw;
  p.execution_sources={source_checkout_sha:fixed.commit,entries:copy(currentEntries),manifest:null};
  let expected={...expectations,execution_source:currentDescriptor};
  if(v2){p.schema=FOUR_SOURCE_CONTRACT_V2.schema;p.previous_execution_snapshots=[snapshot];
    expected={...expected,schema:FOUR_SOURCE_CONTRACT_V2.expectations_schema,previous_execution_sources:[descriptor]};}
  else{p.proof_profiles_raw=oldProfilesRaw;p.role_specs_raw=oldRolesRaw;p.execution_sources=snapshot.execution_sources;expected={...expectations,execution_source:descriptor};}
  const round=addRound(p,{workflowFiles,profiles:selected,commit,m:commit,profileDigest:descriptor.profiles_sha256,roleDigest:descriptor.role_specs_sha256,changedFiles});
  return {p,round,descriptor,snapshot,expected,selected,currentFiles,workflowFiles,changedFiles,currentDescriptor,currentSelected,
    read:q=>read(JSON.stringify(q),JSON.stringify(expected))};
}

test('historical replay preserves old workflow witnesses and Native populations; current catalog relabeling cannot invent the two later workflows',()=>{
  const f=historicalRoundFixture({optionalGit:true}),before=JSON.stringify(f.p),old=f.read(f.p);assert.equal(old.candidate_ready,true);boundaries(old);
  const q=copy(f.p);q.proof_profiles_raw=profiles;q.role_specs_raw=roles;
  q.execution_sources={source_checkout_sha:EXECUTION_SOURCE_COMMIT,entries:copy(executionEntries),manifest:null};
  const r=q.rounds[0];r.applicability.profile_sha256=PROFILE_SOURCE_SHA256;r.applicability.source_checkout_sha=EXECUTION_SOURCE_COMMIT;
  for(const x of r.execution_packets){x.source_descriptor.source_checkout_sha=EXECUTION_SOURCE_COMMIT;x.source_descriptor.role_source_sha256=ROLE_SOURCE_SHA256;}
  const rejected=call(seal(q));assert.equal(rejected.status,'NOT_QUALIFIED');assert.equal(rejected.candidate_ready,false);boundaries(rejected);
  assert.deepEqual(r.applicability.workflow_files,f.workflowFiles);assert.deepEqual(q.attempts,f.p.attempts);assert.deepEqual(r.run_keys,f.round.run_keys);
  assert.deepEqual(r.execution_packets.map(x=>x.jobs),f.round.execution_packets.map(x=>x.jobs));assert.equal(JSON.stringify(f.p),before);
});

test('v2 historical execution snapshots qualify the old 20-path round inside one current 22-path population without changing its witness',()=>{
  const f=historicalRoundFixture({v2:true}),before=JSON.stringify(f.p),r=f.read(f.p);
  assert.equal(r.candidate_ready,true);boundaries(r);assert.equal(Object.keys(f.p.populations).length,8);
  assert.equal(f.p.execution_sources.entries.length,22);assert.equal(f.p.previous_execution_snapshots[0].execution_sources.entries.length,20);
  assert.deepEqual(f.round.applicability.workflow_files,f.workflowFiles);assert.equal(JSON.stringify(f.p),before);
  for(const file of addedHistoryWorkflowFiles)assert.equal(f.round.execution_packets.some(x=>x.workflow_file===file),false);
});

test('v2 five actual historical tips share one reviewed configuration pair and preserve every old witness and global Native population',()=>{
  const f=historicalRoundFixture({v2:true});
  for(const [index,c]of ['1','2','3','4'].entries()){
    const tip=c.repeat(40),snapshot=copy(f.snapshot);snapshot.source_checkout_sha=tip;snapshot.execution_sources.source_checkout_sha=tip;
    snapshot.main_history={base_commit:tip,head_commit:f.currentDescriptor.source_checkout_sha,merge_base_commit:tip,status:'ahead'};f.p.previous_execution_snapshots.push(snapshot);
    addRound(f.p,{rid:302+index,start:31+index,end:40+index,workflowFiles:f.workflowFiles,profiles:f.selected,commit:tip,m:tip,
      profileDigest:f.descriptor.profiles_sha256,roleDigest:f.descriptor.role_specs_sha256,changedFiles:f.changedFiles});
  }
  const before=JSON.stringify(f.p),r=f.read(f.p);assert.equal(r.candidate_ready,true);boundaries(r);
  assert.equal(f.expected.previous_execution_sources.length,1);assert.equal(f.p.previous_execution_snapshots.length,5);assert.equal(f.p.rounds.length,5);
  assert.equal(Object.keys(f.p.populations).length,8);assert.equal(f.p.attempts.length,5*f.workflowFiles.length);
  for(const round of f.p.rounds){assert.equal(round.main_sha,round.applicability.source_checkout_sha);assert.deepEqual(round.applicability.workflow_files,f.workflowFiles);
    assert.equal(round.run_keys.length,f.workflowFiles.length);assert.equal(round.execution_packets.length,f.workflowFiles.length);
    assert.equal(round.applicability.profile_sha256,f.descriptor.profiles_sha256);
    for(const file of addedHistoryWorkflowFiles)assert.equal(round.execution_packets.some(x=>x.workflow_file===file),false);}
  assert.equal(JSON.stringify(f.p),before);
});

function compactCurrentConfigurationFixture(count){
  const p=packet(),key=PROFILE_SOURCE_SHA256+':'+ROLE_SOURCE_SHA256,
    expected={...expectations,schema:FOUR_SOURCE_CONTRACT_V2.expectations_schema,previous_execution_sources:[]};
  p.schema=FOUR_SOURCE_CONTRACT_V2.schema;p.execution_configurations={};p.previous_execution_snapshots=[];
  for(let index=0;index<count;index++){
    const tip=createHash('sha1').update('synthetic-current-configuration-tip:'+index).digest('hex');
    p.previous_execution_snapshots.push({source_checkout_sha:tip,configuration_key:key,
      execution_sources:{source_checkout_sha:tip,entries:copy(executionEntries),manifest:null},
      main_history:{base_commit:tip,head_commit:EXECUTION_SOURCE_COMMIT,merge_base_commit:tip,status:'ahead'}});
    addRound(p,{rid:6000+index,workflowFiles:fullFiles,commit:tip,m:tip,profileDigest:PROFILE_SOURCE_SHA256,roleDigest:ROLE_SOURCE_SHA256});
  }
  return {p,key,expected,read:q=>read(JSON.stringify(q),JSON.stringify(expected))};
}

test('v2 compact 67-tip replay shares the actual current raw configuration below 32 MiB without splitting or dropping Native populations',()=>{
  const f=compactCurrentConfigurationFixture(67),raw=JSON.stringify(f.p),r=f.read(f.p);
  assert.equal(f.p.proof_profiles_raw,profiles);assert.equal(f.p.role_specs_raw,roles);assert.deepEqual(f.p.execution_configurations,{});
  assert.equal(f.p.previous_execution_snapshots.length,67);assert.equal(f.p.rounds.length,67);assert.equal(f.p.attempts.length,67*fullFiles.length);
  assert.ok(f.p.attempts.length<=1000,'the global Native attempt population remains within the existing bound');
  assert.ok(Buffer.byteLength(raw)<32*1024*1024,'one actual configuration is serialized once instead of inside 67 snapshots');
  assert.equal(r.candidate_ready,true);boundaries(r);assert.equal(Object.keys(f.p.populations).length,8);
  assert.equal(new Set(f.p.previous_execution_snapshots.map(s=>s.source_checkout_sha)).size,67);
  assert.equal(new Set(f.p.attempts.map(a=>a.run_id+':'+a.attempt)).size,f.p.attempts.length);
  const jobs=f.p.rounds.flatMap(round=>round.execution_packets.flatMap(x=>x.jobs));assert.equal(new Set(jobs.map(j=>j.id)).size,jobs.length);
  for(const round of f.p.rounds){assert.deepEqual(round.applicability.workflow_files,fullFiles);assert.equal(round.run_keys.length,fullFiles.length);
    assert.equal(round.execution_packets.length,fullFiles.length);assert.equal(round.main_sha,round.applicability.source_checkout_sha);}
  for(const snapshot of f.p.previous_execution_snapshots){assert.equal(snapshot.configuration_key,f.key);assert.equal(snapshot.execution_sources.entries.length,executionEntries.length);
    assert.equal(Object.hasOwn(snapshot,'proof_profiles_raw'),false);assert.equal(Object.hasOwn(snapshot,'role_specs_raw'),false);}
  assert.equal(JSON.stringify(f.p),raw);
});

test('v2 compact configuration references reject unknown keys, repeated current raw configuration and incomplete workflow directories',()=>{
  const f=compactCurrentConfigurationFixture(2);assert.equal(f.read(f.p).candidate_ready,true);
  for(const [label,change]of [
    ['unknown configuration key',p=>{p.previous_execution_snapshots[0].configuration_key='d'.repeat(64)+':'+'e'.repeat(64);}],
    ['duplicate implicit current configuration',p=>{p.execution_configurations[f.key]={proof_profiles_raw:profiles,role_specs_raw:roles};}],
    ['incomplete workflow directory',p=>{p.previous_execution_snapshots[0].execution_sources.entries.pop();seal(p);}]
  ]){
    const p=copy(f.p);change(p);const r=f.read(p);assert.equal(r.status,'NOT_QUALIFIED',label);assert.equal(r.candidate_ready,false,label);boundaries(r);
    assert.deepEqual(p.attempts,f.p.attempts,label);assert.deepEqual(p.rounds,f.p.rounds,label);assert.equal(Object.keys(p.populations).length,8,label);
  }
});

test('v2 history rejects unknown or mixed Source bytes, incomplete historical manifests, authority flags and current relabeling; v1 rejects history fields',()=>{
  const f=historicalRoundFixture({v2:true});assert.equal(f.read(f.p).candidate_ready,true);
  for(const [label,change]of [
    ['unknown checkout',p=>{p.previous_execution_snapshots[0].source_checkout_sha='e'.repeat(40);}],
    ['mixed profile bytes',p=>{p.previous_execution_snapshots[0].proof_profiles_raw=profiles;}],
    ['mixed role bytes',p=>{p.previous_execution_snapshots[0].role_specs_raw=roles;}],
    ['unknown configuration pair',p=>{const s=p.previous_execution_snapshots[0],registry=JSON.parse(s.proof_profiles_raw);registry.audit_source='e'.repeat(40);s.proof_profiles_raw=JSON.stringify(registry);}],
    ['incomplete manifest',p=>{p.previous_execution_snapshots[0].execution_sources.manifest.after.total++;}],
    ['wrong main history head',p=>{p.previous_execution_snapshots[0].main_history.head_commit='e'.repeat(40);}],
    ['contradictory identical history',p=>{p.previous_execution_snapshots[0].main_history.status='identical';}],
    ['round tip borrows another immutable snapshot',p=>{p.rounds[0].main_sha='e'.repeat(40);}],
    ['authority flag',p=>{p.previous_execution_snapshots[0].source_authenticated=true;}],
    ['approved flag',p=>{p.previous_execution_snapshots[0].approved=true;}],
    ['current relabeling',p=>{const r=p.rounds[0];r.applicability.source_checkout_sha=EXECUTION_SOURCE_COMMIT;r.applicability.profile_sha256=PROFILE_SOURCE_SHA256;
      for(const x of r.execution_packets){x.source_descriptor.source_checkout_sha=EXECUTION_SOURCE_COMMIT;x.source_descriptor.role_source_sha256=ROLE_SOURCE_SHA256;}}]
  ]){
    const q=copy(f.p);change(q);const r=f.read(q);assert.equal(r.status,'NOT_QUALIFIED',label);assert.equal(r.candidate_ready,false,label);boundaries(r);
    assert.deepEqual(q.attempts,f.p.attempts,label);assert.deepEqual(q.rounds[0].run_keys,f.round.run_keys,label);assert.deepEqual(q.rounds[0].applicability.workflow_files,f.workflowFiles,label);
  }
  const legacy=historicalRoundFixture();assert.equal(legacy.read(legacy.p).candidate_ready,true);
  const q=copy(legacy.p);q.previous_execution_snapshots=[copy(f.snapshot)];assert.equal(legacy.read(q).status,'NOT_QUALIFIED');
});

test('v2 global run and job ownership rejects reuse across current and historical execution versions',()=>{
  const f=historicalRoundFixture({v2:true}),current=addRound(f.p,{rid:302,start:30,end:40,m:f.currentDescriptor.source_checkout_sha,workflowFiles:f.currentFiles,profiles:f.currentSelected,changedFiles:f.changedFiles,
    commit:f.currentDescriptor.source_checkout_sha,profileDigest:f.currentDescriptor.profiles_sha256,roleDigest:f.currentDescriptor.role_specs_sha256});
  assert.equal(f.read(f.p).candidate_ready,true,'two distinct exact Native populations are internally consistent');
  for(const kind of ['run','job']){
    const q=copy(f.p),old=q.rounds[0].execution_packets[0],r=q.rounds[1],x=r.execution_packets.find(x=>x.workflow_file===old.workflow_file);
    assert.ok(x);
    if(kind==='run'){const original=x.run_key;x.run_key=old.run_key;r.run_keys=r.run_keys.map(k=>k===original?old.run_key:k);
      x.before_attempt=copy(old.before_attempt);x.after_attempt=copy(old.after_attempt);x.jobs=copy(old.jobs);}
    else x.jobs[0].id=old.jobs[0].id;
    const rejected=f.read(seal(q));assert.equal(rejected.status,'NOT_QUALIFIED',kind);assert.equal(rejected.candidate_ready,false,kind);boundaries(rejected);
    assert.deepEqual(q.attempts,f.p.attempts,kind);assert.equal(q.rounds.length,2);assert.deepEqual(q.rounds[0].applicability.workflow_files,f.workflowFiles,kind);
  }
  assert.equal(current.applicability.source_checkout_sha,f.currentDescriptor.source_checkout_sha);
});

function wastedFixture(){
  const p=packet(),original=addRound(p);const {x}=addOperation(p,{start:30,main:nextMain});
  const next=addRound(p,{rid:302,h:nextHead,m:nextMain,start:36,end:45,mergedAt:50});
  original.main_move={old_main_sha:base,new_main_sha:nextMain,event_at:time(28),collected_at:time(29),observation_id:'main.move'};
  original.termination={receipt_id:'terminated.301',event_at:time(35),collected_at:time(36),kind:'MAIN_ADVANCED_REPLACED',reason_code:'MAIN_ADVANCED_INVALIDATED_FINAL_ROUND',
    original_round_id:original.round_id,operation_id:x.o.operation_id,replacement_round_id:next.round_id};return {p:seal(p),original,next,x};
}
test('R1: FINAL rejects two conflicting known Native starts with every other field unchanged',()=>{
  const {p,a}=addAdmission(packet());a.ep.identity.native_run.run_started_at=time(0);
  p.admissions[0].packet_raw=JSON.stringify(a.ep);assert.equal(call(seal(p)).status,'NOT_QUALIFIED');
});
test('R1: equivalent known Native timestamps compare by actual time rather than spelling',()=>{
  for(const inner of ['2026-10-11T06:00:01Z','2026-10-11T06:00:01.000+00:00']){
    const {p,a}=addAdmission(packet());a.ep.identity.native_run.run_started_at=inner;
    a.run.started_at='2026-10-11T08:00:01.000000+02:00';p.admissions[0].packet_raw=JSON.stringify(a.ep);
    const r=call(seal(p));assert.equal(r.candidate_ready,true);assert.equal(r.metrics.unclaimed_admitted.admitted_with_valid_claim,1);boundaries(r);
  }
});
test('R1: legitimate unknown-to-known no-final progression remains valid, conflicting known GAP starts refuse',()=>{
  const {p,a}=addAdmission(packet(),{conclusion:'cancelled'});gap(a.ep);
  a.ep.identity.job_id=null;a.ep.identity.native_job=null;a.ep.identity.native_run.run_started_at=null;
  a.ep.identity.native_run.status='in_progress';a.ep.identity.native_run.conclusion=null;
  p.admissions[0].packet_raw=JSON.stringify(a.ep);let r=call(seal(p));assert.equal(r.candidate_ready,true);
  assert.equal(r.metrics.unclaimed_admitted.explicit_no_final_decision,1);assert.equal(r.metrics.cancellation_causes.denominator,1);
  a.ep.identity.native_run.run_started_at=time(0);p.admissions[0].packet_raw=JSON.stringify(a.ep);
  assert.equal(call(seal(p)).status,'NOT_QUALIFIED');
});
function cancelRoundMember(p,r){
  assert.equal(r.execution_packets.length,fullFiles.length,'all five original Full workflows plus both required-tests workflows remain applicable');
  const x=r.execution_packets[1],a=p.attempts.find(a=>`${a.run_id}:${a.attempt}`===x.run_key);
  a.started_at=null;a.conclusion='cancelled';
  x.before_attempt.conclusion='cancelled';x.after_attempt.conclusion='cancelled';
  for(const job of x.jobs){job.conclusion='cancelled';job.steps=[];}
  seal(p);return a;
}
test('R2: complete multi-workflow unsuccessful round preserves its never-started cancelled member',()=>{
  const p=packet(),round=addRound(p),a=cancelRoundMember(p,round);assert.equal(a.completed_at,time(26));
  const r=call(p);assert.equal(r.status,'FOUR_SOURCE_CALCULATION_CANDIDATE');assert.equal(r.candidate_ready,true);
  assert.equal(r.metrics.wasted_final_rounds.non_successful_rounds,1);assert.equal(r.metrics.wasted_final_rounds.value,null);
  assert.equal(r.metrics.wasted_final_rounds.confirmed_wasted,0);assert.equal(r.metrics.wasted_final_rounds.used_for_merge,0);
  assert.equal(r.metrics.cancellation_causes.denominator,1);assert.equal(r.metrics.cancellation_causes.value.UNKNOWN_CAUSE,1);
  assert.equal(r.metrics.cancellation_causes.cause_coverage,0);assert.equal(p.attempts.length,fullFiles.length);boundaries(r);
});
test('R2: every known round-member bound is checked even on unsuccessful or unknown aggregate paths',()=>{
  for(const end of [time(19),time(28)]){const p=packet(),round=addRound(p),a=cancelRoundMember(p,round);a.completed_at=end;
    assert.equal(call(seal(p)).status,'NOT_QUALIFIED');}
  const p=packet(),round=addRound(p);cancelRoundMember(p,round);round.completed_at=null;
  p.attempts[0].started_at=time(19);assert.equal(call(seal(p)).status,'NOT_QUALIFIED');
});
test('R2: a purported successful Full round still requires every actual start and terminal clock',()=>{
  for(const field of ['started_at','completed_at']){
    const p=packet();addRound(p);p.attempts[0][field]=null;assert.equal(call(seal(p)).status,'NOT_QUALIFIED');
  }
});
test('R2: actual merge uniqueness remains whole-closure before unsuccessful-round classification',()=>{
  const p=packet(),first=addRound(p,{rid:701,mergedAt:50});cancelRoundMember(p,first);
  addRound(p,{rid:702,start:30,end:37,mergedAt:50});assert.equal(call(seal(p)).status,'NOT_QUALIFIED');
});

function unfinishedContractPlacementFixture(){
  // R3's retained counterexample specifically has one ungated execution job.
  // Select that independently registered legacy Source explicitly rather than
  // changing this timing premise when the working tree advances to a gated one.
  const file='.github/workflows/contract-placement.yml',root=registryObject.workflows[file],
    selected=registeredWorkflowSource(registryObject,file,root.workflow_blob),p=packet();
  assert.equal(selected.passed,true);assert.equal(selected.profile.gated,false);
  p.execution_sources.entries.find(entry=>entry.workflow_file===file).workflow_blob=root.workflow_blob;
  const profileView={workflows:{...selectedProfileObject.workflows,[file]:selected.profile}},round=addRound(p,{profiles:profileView});
  return {p,round};
}
function unfinishedContractPlacementMember(p,round){
  const x=round.execution_packets.find(x=>x.workflow_file==='.github/workflows/contract-placement.yml');
  assert.ok(x,'the real selected ungated contract-placement workflow is present');assert.equal(x.jobs.length,1);
  const a=p.attempts.find(a=>`${a.run_id}:${a.attempt}`===x.run_key);
  a.status='in_progress';a.conclusion=null;a.started_at=time(28);a.completed_at=null;
  for(const barrier of [x.before_attempt,x.after_attempt]){barrier.status='in_progress';barrier.conclusion=null;}
  const job=x.jobs[0];job.status='in_progress';job.conclusion=null;
  for(const [index,step]of job.steps.entries()){step.status=index===0?'in_progress':'queued';step.conclusion=null;}
  return seal(p);
}
test('R3: an unfinished member starting after the known round end is contradictory, never ready UNKNOWN',()=>{
  const {p,round}=unfinishedContractPlacementFixture();unfinishedContractPlacementMember(p,round);
  assert.equal(round.completed_at,time(27));assert.equal(call(p).status,'NOT_QUALIFIED');
});
test('R3: a genuinely unknown round end retains the complete unfinished population and UNKNOWN classification',()=>{
  const {p,round}=unfinishedContractPlacementFixture();round.completed_at=null;unfinishedContractPlacementMember(p,round);
  const r=call(p);assert.equal(r.status,'FOUR_SOURCE_CALCULATION_CANDIDATE');assert.equal(r.candidate_ready,true);
  assert.equal(r.supplied_data_consistency,true);assert.equal(r.supplied_population_manifest_complete,true);
  assert.equal(r.metrics.wasted_final_rounds.value,null);assert.equal(r.metrics.wasted_final_rounds.unknown,1);
  assert.equal(r.metrics.wasted_final_rounds.denominator,1);assert.equal(r.metrics.wasted_final_rounds.confirmed_wasted,0);
  assert.equal(r.metrics.wasted_final_rounds.used_for_merge,0);assert.equal(p.attempts.length,fullFiles.length);boundaries(r);
});

test('F3: complete current source/profile/roles, supplied critical steps, explicit termination and supplied Native merge produce candidate classifications',()=>{
  const {p}=wastedFixture(),r=call(p);assert.equal(r.status,'FOUR_SOURCE_CALCULATION_CANDIDATE');assert.equal(r.candidate_ready,true);boundaries(r);
  assert.equal(r.metrics.wasted_final_rounds.confirmed_wasted,1);assert.equal(r.metrics.wasted_final_rounds.used_for_merge,1);assert.equal(r.metrics.wasted_final_rounds.value,1);
  assert.equal(r.metrics.wasted_final_rounds.execution_qualification,'SUPPLIED_EXECUTION_CONSISTENCY_ONLY');
});
test('F3: later head/main and replacement operation without explicit original termination are UNKNOWN, not wasted',()=>{
  const {p,original}=wastedFixture();original.termination=null;const r=call(p);assert.equal(r.candidate_ready,true);
  assert.equal(r.metrics.wasted_final_rounds.confirmed_wasted,0);assert.equal(r.metrics.wasted_final_rounds.value,null);
});
test('F3: an intervening complete round removes last-round uniqueness rather than inferring cause',()=>{
  const {p}=wastedFixture();addRound(p,{rid:303,start:29,end:34});const r=call(seal(p));assert.equal(r.candidate_ready,true);
  assert.equal(r.metrics.wasted_final_rounds.confirmed_wasted,0);assert.equal(r.metrics.wasted_final_rounds.value,null);
});
test('F3: simultaneous round ordering ambiguity and unbound merge round stay unknown/refused',()=>{
  const {p}=wastedFixture();addRound(p,{rid:304,start:20,end:26});let r=call(seal(p));assert.equal(r.metrics.wasted_final_rounds.confirmed_wasted,0);
  const q=wastedFixture().p;q.rounds[1].merge_proof.round_id=uuid(999);assert.equal(call(q).status,'NOT_QUALIFIED');
  const z=wastedFixture().p;z.rounds[1].merge_proof.used_run_keys.pop();assert.equal(call(z).status,'NOT_QUALIFIED');
});
test('F3: one omitted applicable workflow or its jobs is population incomplete, not successful final CI',()=>{
  const {p,original}=wastedFixture();const removed=original.execution_packets.pop();original.run_keys=original.run_keys.filter(x=>x!==removed.run_key);
  let r=call(seal(p));assert.equal(r.candidate_ready,false);assert.equal(r.metrics.wasted_final_rounds.value,null);
  const good=wastedFixture();good.original.execution_packets[0].jobs_manifest.pages[0].next_cursor='not.read';r=call(good.p);assert.equal(r.candidate_ready,false);
});
test('F3: source role pin, attempt barrier, skipped heavy step and mismatched merge identity cannot produce wasted PASS',()=>{
  for(const change of [p=>p.rounds[0].execution_packets[0].source_descriptor.role_source_sha256='e'.repeat(64),
    p=>p.rounds[0].execution_packets[0].after_attempt.attempt=2,p=>p.rounds[1].merge_proof.native_pr.head_sha=head]){
    const {p}=wastedFixture();change(p);assert.equal(call(p).status,'NOT_QUALIFIED');}
  const {p,original}=wastedFixture();original.execution_packets.find(x=>x.workflow_file.endsWith('quality-gate.yml')).jobs.at(-1).steps.find(x=>x.name==='Run npm run lint').conclusion='skipped';const r=call(p);
  assert.equal(r.candidate_ready,true);assert.equal(r.metrics.wasted_final_rounds.confirmed_wasted,0);assert.equal(r.metrics.wasted_final_rounds.value,null);
});

test('the registered Full fixture keeps documentation classifier auxiliary while all heavy steps run',()=>{
  const {p,original}=wastedFixture();original.execution_packets.find(x=>x.workflow_file.endsWith('quality-gate.yml')).jobs.at(-1).steps.find(x=>x.name==='Qualify ordinary documentation changes').conclusion='skipped';
  const r=call(p);assert.equal(r.candidate_ready,true);assert.equal(r.metrics.wasted_final_rounds.confirmed_wasted,1);
});

// S1鈥揝4 successor controls were first run against exact 3ea8 reader bytes.
// All five failed there; retain the counterexamples as regression controls.
test('S1: registry-defined source selection qualifies protocol paths and the accepted added critical step',()=>{
  const p=packet(),r=addRound(p),changed=['protocol/agent/example.json'];
  const sourceMap=new Map(executionEntries.map(x=>[x.workflow_file,x.workflow_blob]));
  const q=applicableCI({workflows:sourceMap,profiles:selectedProfileObject,changedFiles:changed,commits:1,diffComplete:true,sourceQualified:true});
  assert.equal(q.passed,true);r.applicability.changed_files=changed;r.applicability.workflow_files=[...q.workflows.keys()].sort();
  for(const file of r.applicability.workflow_files.filter(x=>!r.execution_packets.some(p=>p.workflow_file===x))){
    const profile=selectedProfileObject.workflows[file],route=profile.routes[0],run=++nextRun,runKey=String(run)+':1';
    const a={run_id:String(run),attempt:1,pr_number:727,head_sha:head,kind:'ci',status:'completed',conclusion:'success',started_at:time(21),completed_at:time(26)};
    p.attempts.push(a);r.run_keys.push(runKey);
    const jobs=[{id:++nextJob,run_id:run,run_attempt:1,name:'admission-gate',status:'completed',conclusion:'success',labels:['self-hosted'],steps:[]},
      {id:++nextJob,run_id:run,run_attempt:1,name:route.name,status:'completed',conclusion:'success',labels:route.self_hosted?['self-hosted']:['ubuntu-slim'],
        steps:Object.entries(route.required_steps).flatMap(([name,n])=>Array.from({length:n},()=>({name,status:'completed',conclusion:'success'})))}];
    const barrier={run_id:a.run_id,attempt:1,head_sha:head,status:'completed',conclusion:'success'};
    r.execution_packets.push({run_key:runKey,workflow_file:file,jobs,jobs_manifest:manifest(p,'native_jobs:'+runKey,jobs.map(x=>String(x.id))),before_attempt:copy(barrier),after_attempt:copy(barrier),
      source_descriptor:{workflow_blob:profile.workflow_blob,workflow_source_sha256:hash(profile.source_yaml),source_checkout_sha:EXECUTION_SOURCE_COMMIT,role:'primary_execution',role_source_sha256:ROLE_SOURCE_SHA256}});
  }
  let result=call(seal(p));assert.equal(result.candidate_ready,true);assert.equal(result.metrics.wasted_final_rounds.non_successful_rounds,0);
  const connection=r.execution_packets.find(x=>x.workflow_file==='.github/workflows/clued-connection-authorization.yml');
  assert.ok(connection);const job=connection.jobs.at(-1);assert.ok(job.steps.some(x=>x.name==='Verify DatasetSplit Native grant correction and Binding successor'));
  job.steps=job.steps.filter(x=>x.name!=='Verify DatasetSplit Native grant correction and Binding successor');
  result=call(p);assert.equal(result.candidate_ready,true);assert.equal(result.metrics.wasted_final_rounds.non_successful_rounds,1);
});
test('S2: post-end ever-target closure is retained without entering the admission cohort',()=>{
  const {p,a}=addAdmission(packet(),{entry:'reverify'});p.window.end=time(3);p.targets[0].selected_at=time(4);
  a.batch.initial.target_keys=[];a.batch.selection_events=[{seq:1,receipt_id:'post.end.target',event_at:time(4),collected_at:time(5),kind:'selected',target_key:a.k}];
  a.ep.timing={decision_at:time(5),observed_at:time(6)};a.ep.claim_observation.verified_at=time(4);p.admissions[0].packet_raw=JSON.stringify(a.ep);
  const r=call(seal(p));assert.equal(r.candidate_ready,true);assert.equal(r.metrics.unclaimed_admitted.denominator,0);
});
test('S2: post-end operation, move and replacement round close a window round without adding denominators',()=>{
  const {p}=wastedFixture();p.window.end=time(28);const r=call(seal(p));assert.equal(r.candidate_ready,true);
  assert.equal(r.metrics.wasted_final_rounds.denominator,1);assert.equal(r.metrics.wasted_final_rounds.confirmed_wasted,1);
  assert.equal(r.metrics.wasted_final_rounds.used_for_merge,0);assert.equal(r.metrics.update_main_rounds.denominator,0);
});
test('S3: one platform merge cannot adopt two rounds or two different exact run sets',()=>{
  const p=packet(),a=addRound(p,{rid:901,mergedAt:50});assert.equal(call(p).candidate_ready,true,'one merged round is valid before duplicate binding');
  const b=addRound(p,{rid:902,start:30,end:40,mergedAt:50});
  b.merge_proof.receipt_id=a.merge_proof.receipt_id;b.merge_proof.operation_id=a.merge_proof.operation_id;
  assert.equal(call(seal(p)).status,'NOT_QUALIFIED');
});
test('S4: FINAL observations after collection or fixed close refuse',()=>{
  for(const observed of [8,91]){const {p,a}=addAdmission(packet());a.ep.timing.observed_at=time(observed);p.admissions[0].packet_raw=JSON.stringify(a.ep);
    assert.equal(call(seal(p)).status,'NOT_QUALIFIED');}
});
test('S1: omitted, unknown or unstable independently supplied workflow directory cannot select registry roots by default',()=>{
  for(const change of [p=>p.execution_sources.entries.pop(),p=>p.execution_sources.entries[0].workflow_blob='f'.repeat(40),
    p=>p.execution_sources.manifest.after.snapshot_id='changed']){const p=packet();change(p);assert.equal(call(p).status,'NOT_QUALIFIED');}
});
test('S2: post-end target final evidence is required for closure, while explicit GAP does not expand the cohort',()=>{
  const {p,a}=addAdmission(packet(),{entry:'reverify'});p.window.end=time(3);a.t.selected_at=time(4);
  a.batch.initial.target_keys=[];a.batch.selection_events=[{seq:1,receipt_id:'post.end.target',event_at:time(4),collected_at:time(5),kind:'selected',target_key:a.k}];
  p.admissions[0].packet_raw=JSON.stringify(gap(a.ep));let r=call(seal(p));assert.equal(r.candidate_ready,true);assert.equal(r.metrics.unclaimed_admitted.denominator,0);
  assert.equal(r.reference_closure.targets_outside_cohort,1);p.admissions=[];r=call(seal(p));assert.equal(r.candidate_ready,false);assert.ok(r.population_gaps.includes('missing_final_admission_packets'));
});
test('S2: fixed closing watermark still rejects reference-only Native attempts or selections after close',()=>{
  const {p}=wastedFixture();p.window.end=time(28);p.rounds[1].started_at=time(91);assert.equal(call(seal(p)).status,'NOT_QUALIFIED');
  const q=packet();q.attempts.push({run_id:'99',attempt:1,pr_number:null,head_sha:head,kind:'other',status:'queued',conclusion:null,started_at:time(91),completed_at:null});
  assert.equal(call(seal(q)).status,'NOT_QUALIFIED');
});
test('S3: Native PR merge identity stays unique even when separate receipts and operation UUIDs are supplied',()=>{
  const p=packet();addRound(p,{rid:911,mergedAt:50});const b=addRound(p,{rid:912,start:30,end:40,mergedAt:50});
  assert.equal(call(seal(p)).status,'NOT_QUALIFIED');b.merge_proof.response_merged_commit_sha='f'.repeat(40);b.merge_proof.native_pr.merge_commit_sha='f'.repeat(40);
  assert.equal(call(seal(p)).status,'NOT_QUALIFIED');
});
test('S4: late FINAL observation after window end and Native completion is legal before fixed collection/close',()=>{
  const {p,a}=addAdmission(packet());a.ep.timing.observed_at=time(60);p.admissions[0].packet_raw=JSON.stringify(a.ep);p.admissions[0].collected_at=time(61);
  const r=call(seal(p));assert.equal(r.candidate_ready,true);assert.equal(r.metrics.unclaimed_admitted.admitted_with_valid_claim,1);boundaries(r);
});

test('formal interface: no implicit historic source set or caller authority option exists',()=>{
  const p=packet();assert.equal(read(JSON.stringify(p)).status,'NOT_QUALIFIED');
  const e=copy(expectations);e.source_authenticated=true;assert.equal(read(JSON.stringify(p),JSON.stringify(e)).status,'NOT_QUALIFIED');
  e.source_authenticated=undefined;delete e.source_authenticated;e.admission_sources[0].grammar='unknown-grammar';
  assert.equal(read(JSON.stringify(p),JSON.stringify(e)).status,'NOT_QUALIFIED');
});
test('formal producer absence is a genuine partial population, not a zero observation',()=>{
  const p=packet();p.sources_raw='[]';let r=call(p);assert.equal(r.candidate_ready,false);assert.equal(r.metrics.unclaimed_admitted.value,null);
  assert.ok(r.population_gaps.includes('missing_admission_source_packets'));
  const {p:q}=addAdmission(packet());q.admissions=[];r=call(seal(q));assert.equal(r.candidate_ready,false);
  assert.equal(r.metrics.admission_failures_by_reason.value,null);
});
test('formal expected producer checkout and current byte pins bind the final envelope',()=>{
  const {a}=addAdmission(packet());let r=produceAdmission(JSON.stringify(a.ep),sources,expectationsRaw);
  assert.equal(r.status,'ADMISSION_PACKET_CANDIDATE');assert.equal(r.projection.source.expected_selection_only,true);boundaries(r);
  const changed=copy(a.ep);changed.identity.source_checkout_sha='f'.repeat(40);
  assert.equal(produceAdmission(JSON.stringify(changed),sources,expectationsRaw).status,'NOT_QUALIFIED');
  const wrong=JSON.parse(sources);wrong.script+='\\n// changed source';
  assert.equal(produceAdmission(JSON.stringify(a.ep),JSON.stringify(wrong),expectationsRaw).status,'NOT_QUALIFIED');
});
test('formal versioned final-observation grammar does not accept unversioned claimed provenance',()=>{
  const {p,a}=addAdmission(packet());delete a.ep.schema;p.admissions[0].packet_raw=JSON.stringify(a.ep);
  assert.equal(call(p).status,'NOT_QUALIFIED');
  const e=copy(expectations);e.admission_sources[0].app_id++;
  assert.equal(read(JSON.stringify(addAdmission(packet()).p),JSON.stringify(e)).status,'NOT_QUALIFIED');
});
test('formal current corpus is explicitly pinned and a later invocation cannot reuse an earlier selection',()=>{
  const p=packet();assert.equal(call(p).candidate_ready,true);
  const e=copy(expectations);e.execution_source.profiles_sha256='e'.repeat(64);
  assert.equal(read(JSON.stringify(p),JSON.stringify(e)).status,'NOT_QUALIFIED');assert.equal(call(p).candidate_ready,true);
});

const terminalBounds=(lower,upper)=>({lower_at:time(lower),upper_at:time(upper),basis:'native_job_completion_lower_and_terminal_update_upper_bounds'});
test('Native interval: never-started cancelled inside the window preserves denominator one and UNKNOWN cause',()=>{
  const p=packet(),a=nativeAdmission({conclusion:'cancelled'}).run;a.kind='other';a.started_at=null;a.completed_at=null;a.terminal_interval=terminalBounds(2,6);p.attempts.push(a);
  const r=call(seal(p));assert.equal(r.candidate_ready,true);assert.equal(r.metrics.cancellation_causes.denominator,1);
  assert.equal(r.metrics.cancellation_causes.value.UNKNOWN_CAUSE,1);assert.equal(r.metrics.cancellation_causes.cause_coverage,0);boundaries(r);
});
test('Native interval: crossing membership is semantic UNKNOWN, never a selected representative completion',()=>{
  const p=packet(),a=nativeAdmission({conclusion:'cancelled'}).run;a.kind='other';a.started_at=null;a.completed_at=null;a.terminal_interval=terminalBounds(2,6);p.window.start=time(4);p.attempts.push(a);
  const r=call(seal(p));assert.equal(r.candidate_ready,true);assert.equal(r.metrics.cancellation_causes.denominator,null);
  assert.equal(r.metrics.cancellation_causes.value,null);assert.equal(r.metrics.cancellation_causes.membership_unknown_count,1);assert.equal(r.metrics.cancellation_causes.cause_coverage,null);
  assert.equal(a.completed_at,null);assert.equal(a.started_at,null);
});
test('Native interval: fully outside completion is excluded with an intact reference row',()=>{
  const p=packet(),a=nativeAdmission({conclusion:'cancelled'}).run;a.kind='other';a.started_at=null;a.completed_at=null;a.terminal_interval=terminalBounds(2,6);p.window.start=time(7);p.attempts.push(a);
  const r=call(seal(p));assert.equal(r.candidate_ready,true);assert.equal(r.metrics.cancellation_causes.denominator,0);assert.equal(p.attempts.length,1);
});
test('Native interval: reversed, over-close, contradicting start and simultaneous point/bounds refuse',()=>{
  for(const change of [a=>a.terminal_interval=terminalBounds(7,6),a=>a.terminal_interval=terminalBounds(2,91),
    a=>a.started_at=time(7),a=>a.completed_at=time(4)]){
    const p=packet(),a=nativeAdmission({conclusion:'cancelled'}).run;a.kind='other';a.started_at=null;a.completed_at=null;a.terminal_interval=terminalBounds(2,6);change(a);p.attempts.push(a);
    assert.equal(call(seal(p)).status,'NOT_QUALIFIED');
  }
});
test('Native interval: complete Full rounds retain actual causal/merge rules without a root workflow point',()=>{
  const {p}=wastedFixture();for(const r of p.rounds){for(const k of r.run_keys){const a=p.attempts.find(a=>a.run_id+':'+a.attempt===k);
    const end=Number(a.completed_at.slice(17,19));a.completed_at=null;a.terminal_interval=terminalBounds(end-1,end);}
    const members=r.run_keys.map(k=>p.attempts.find(a=>a.run_id+':'+a.attempt===k).terminal_interval);
    r.completed_at=null;r.terminal_interval={lower_at:members.map(x=>x.lower_at).sort().at(-1),upper_at:members.map(x=>x.upper_at).sort().at(-1),basis:'native_job_completion_lower_and_terminal_update_upper_bounds'};}
  const result=call(seal(p));assert.equal(result.candidate_ready,true);assert.equal(result.metrics.wasted_final_rounds.confirmed_wasted,1);assert.equal(result.metrics.wasted_final_rounds.used_for_merge,1);
  p.rounds[0].terminal_interval.upper_at=time(28);assert.equal(call(seal(p)).status,'NOT_QUALIFIED','round cannot choose a more convenient bound');
});
test('Native interval: an ambiguous cause inside the terminal interval never proves wasted Full',()=>{
  const {p,original}=wastedFixture();for(const k of original.run_keys){const a=p.attempts.find(a=>a.run_id+':'+a.attempt===k);a.completed_at=null;a.terminal_interval=terminalBounds(25,35);}
  original.completed_at=null;original.terminal_interval=terminalBounds(25,35);original.termination.event_at=time(34);
  const r=call(seal(p));assert.equal(r.candidate_ready,true);assert.equal(r.metrics.wasted_final_rounds.confirmed_wasted,0);
});
