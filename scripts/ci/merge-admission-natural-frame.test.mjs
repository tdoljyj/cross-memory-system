// All provider/Owner data below are synthetic wire fixtures. No live usage,
// actual Source qualification, permission, CI or natural observation window.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {registerHooks} from 'node:module';
const here=path.dirname(fileURLToPath(import.meta.url)),repo=process.env.CLUED_PRODUCER_TEST_REPO_ROOT??path.resolve(here,'../..');
registerHooks({resolve(s,c,next){if(s.startsWith('./')&&c.parentURL?.startsWith(pathToFileURL(here).href)){
  const own=path.join(here,s),real=path.join(repo,'scripts/ci',s);if(!fs.existsSync(own)&&fs.existsSync(real))return {url:pathToFileURL(real).href,shortCircuit:true};}return next(s,c);}});
const {assembleNaturalFourSourceFrame}=await import('./merge-admission-natural-frame.mjs');
const {createNaturalRecorder}=await import('./merge-admission-source-producer.mjs');
const {collectNativeActivity}=await import('./merge-admission-native-activity.mjs');
const C=await import('./merge-admission-r9-collector.mjs');
const {emptyNativePopulationStore}=await import('./merge-admission-native-population.mjs');
const h=x=>createHash('sha256').update(x).digest('hex'),blob=x=>createHash('sha1').update('blob '+Buffer.byteLength(x)+'\0').update(x).digest('hex');
const repository='tdoljyj/cross-memory-system',subject='891ea2e7a68e0a3201b64a8fd173f4d50a4c18dc',head='a'.repeat(40),base='b'.repeat(40),
  scope={project_id:'0597aa60-9b98-4da6-a4ab-63d7705b632f',queue_ref:'merge:'+repository+':main'},uid='10000000-0000-4000-8000-000000000001';
const at=s=>'2026-10-11T06:00:'+String(s).padStart(2,'0')+'.000000Z',window={start:at(0),end:at(59)},closed=at(59);
function fixture(){
  const paths={script:'scripts/ci/clued-work-admission.mjs',workflow:'.github/workflows/clued-work-admission.yml',reverify_workflow:'.github/workflows/clued-work-admission-reverify.yml',policy:'config/merge-admission-policy.json'},
    texts=Object.fromEntries(Object.entries(paths).map(([k,p])=>[k,fs.readFileSync(path.join(repo,p),'utf8')])),source={grammar:'clued.work-admission.evaluate-observation/1',source_checkout_sha:subject,default_branch:'main',app_id:5164952};
  for(const [k,p]of Object.entries(paths)){source[k+'_path']=p;source[k+'_blob']=blob(texts[k]);}
  const profiles=fs.readFileSync(path.join(repo,'scripts/ci/clued-gated-proof-profiles.json'),'utf8'),roles=fs.readFileSync(path.join(repo,'scripts/ci/clued-gated-proof-role-specs.json'),'utf8'),
    expected={schema:'clued.merge-admission-four-source-expectations/1',repository,scope,admission_sources:[source],execution_source:{source_checkout_sha:subject,profiles_sha256:h(profiles),role_specs_sha256:h(roles)}},
    runtime={source_contract_raw:JSON.stringify({schema:'clued.merge-admission-r9-source-contract/1',repository,scope,window,four_expected_sources_raw:JSON.stringify(expected),clock:null}),
      forward_epoch:{epoch_id:uid},operation_coverage:{schema:'clued.r9-finite-recorded-operation-coverage/1',owner_receipt_id:uid,epoch_id:uid,repository,scope,mode:'explicit_recorded_origins_during_this_epoch',original_source_paths:['scripts/ci/clued-work-admission.mjs','scripts/ci/clued-merge-executor.mjs']},
      proof_profiles_raw:profiles,role_specs_raw:roles,natural_selection:{default_branch:'main'},execution_workflow_blobs:Object.fromEntries(Object.keys(JSON.parse(profiles).workflows).map(p=>[p,blob(fs.readFileSync(path.join(repo,p),'utf8'))]))};
  return {runtime,native:{status:'COMPLETE',population_packets:[],population:{cohort_digest:'actual-synthetic-native-snapshot'}},attemptRows:[],
    natural:{status:'NATIVE_ORIGIN_BOUND',entries:[]},closedAt:closed,sourceBytes:{[subject]:{texts,...Object.fromEntries(['script','workflow','reverify_workflow','policy'].map(k=>[k+'_blob',source[k+'_blob']]))}}};
}
test('actual assembly entry builds eight closed empty populations only from a complete Native/provider fixture, never authentication flags',()=>{
  const f=fixture(),r=assembleNaturalFourSourceFrame(f);assert.equal(r.status,'FOUR_SOURCE_FRAME_DATA_CANDIDATE',JSON.stringify(r.gaps));
  assert.equal(Object.keys(JSON.parse(r.frame.packet_raw).populations).length,8);assert.equal(r.math.metrics.update_main_rounds.value,0);
  assert.equal(r.source_authenticated,false);assert.equal(r.official_metric,false);assert.equal(r.t0,null);
});
test('missing real finite-epoch selection or partial Native source cannot be converted to a hand-written complete zero',()=>{
  for(const change of [f=>f.runtime.operation_coverage=null,f=>f.native.status='PARTIAL',f=>f.natural.status='PARTIAL',f=>f.runtime.operation_coverage.epoch_id='10000000-0000-4000-8000-000000000002']){
    const f=fixture();change(f);f.complete=true;f.source_authenticated=true;assert.equal(assembleNaturalFourSourceFrame(f).status,'PARTIAL');}
});
test('real natural evaluator records map a rejected admission through the actual eight-population entry',()=>{
  const f=fixture(),events=[],env={GITHUB_REPOSITORY:repository,GITHUB_RUN_ID:'42',GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:'clued-work-admission',GITHUB_SHA:base};let second=1;
  const r=createNaturalRecorder({env,sourcePath:'scripts/ci/clued-work-admission.mjs',write:e=>events.push(e),now:()=>at(second++)});
  const pr={number:727,state:'open',draft:false,head:{sha:head},base:{sha:base,ref:'main',repo:{full_name:repository}}};
  r.record('admission_input',{evaluation_id:uid,pr,entry:'required'});r.record('admission_selected',{evaluation_id:uid,pr,entry:'required'});
  r.record('admission_final',{evaluation_id:uid,entry:'required',completion:'returned',outcome:{head_sha:head,pr_ref:repository+'#727',claim_id:null,enforced:true,admitted:false,verdict:'REJECTED',reasons:['claim_trailer_missing'],admission_mode:{state:'normal',layer:'code'}}});
  for(const e of events)e.source.executed_checkout_sha=subject;
  const n={run:{run_id:'42',run_attempt:1,path:'.github/workflows/clued-work-admission.yml',event:'pull_request_target',head_sha:base,status:'completed',conclusion:'failure',created_at:at(0),run_started_at:at(1),updated_at:at(6),pull_requests:[727]},
    jobs:[{id:'43',run_id:'42',run_attempt:1,name:'clued-work-admission',status:'completed',conclusion:'failure',created_at:at(1),started_at:at(1),completed_at:at(5),labels:['ubuntu-slim'],steps:[{name:'Verify the work claim with Clued and summarize applicable workflows',conclusion:'failure'}]}]};
  f.native.population_packets=[n];f.attemptRows=[{run_id:'42',attempt:1,pr_number:727,head_sha:base,kind:'admission',status:'completed',conclusion:'failure',started_at:at(1),completed_at:null,
    terminal_interval:{lower_at:at(5),upper_at:at(6),basis:'native_job_completion_lower_and_terminal_update_upper_bounds'}}];
  f.natural.entries=[{run_key:'42:1',job_id:'clued-work-admission',checkout_sha:subject,artifact_digest:'sha256:'+'d'.repeat(64),native_origin:{head_branch:'main',event:'pull_request_target'},packet_raw:JSON.stringify({events})}];
  const built=assembleNaturalFourSourceFrame(f);assert.equal(built.status,'FOUR_SOURCE_FRAME_DATA_CANDIDATE',JSON.stringify(built.gaps));
  assert.equal(built.math.metrics.admission_failures_by_reason.rejected,1);assert.equal(built.math.metrics.admission_failures_by_reason.denominator,1);
  assert.equal(built.math.metrics.unclaimed_admitted.value,0);assert.equal(built.source_authenticated,false);
  f.natural.entries=[];const missing=assembleNaturalFourSourceFrame(f);assert.equal(missing.status,'PARTIAL');assert.ok(missing.gaps.some(x=>x.includes('ADMISSION_NATIVE_ORIGIN_MISSING')));
});
test('bootstrap source packet has no observation window and cannot carry a fabricated measurement',()=>{
  const fields=Object.fromEntries(C.R9_SOURCE_PATHS.map(p=>[p,'b'.repeat(40)])),publisher={run_id:'42',run_attempt:1,head_sha:base,workflow_path:C.R9_PUBLISHER_PATH,job_id:'report'},
    nativeStoreRaw=JSON.stringify({schema:'clued.native-population-store/1',repository,packets:{}});
  // Use the actual existing store grammar rather than a lookalike caller flag.
  const N=JSON.parse(C.emptyR9ArtifactCache(repository));assert.equal(N.artifact_id,null);
  const input={repository,publisher,sourceBlobs:fields,window:null,sealedAt:closed,nativeStoreRaw};
  assert.throws(()=>C.sealR9Packet(input),'the invented store schema is rejected');
  input.nativeStoreRaw=emptyNativePopulationStore(repository);const actual=JSON.parse(C.sealR9Packet(input));assert.equal(actual.window,null);assert.equal(actual.four_source,null);assert.equal(actual.clock,null);
  input.fourSource={packet_raw:'{}',expected_sources_raw:'{}'};assert.throws(()=>C.sealR9Packet(input),/BOOTSTRAP_PACKET_CANNOT_CONTAIN_OBSERVATIONS/);
});
test('actual provider event time, stable pagination and interval scope are retained without actors or commit timestamps',async()=>{
  const e={id:'91',repo:{name:repository},type:'PushEvent',created_at:at(2),actor:{login:'not-a-canceller'},payload:{before:base,head,ref:'refs/heads/main',commits:[{timestamp:'forged'}]}},
    request=async()=>({ok:true,body:[e]});const r=await collectNativeActivity({request,repository,window});
  assert.equal(r.status,'PARTIAL');assert.equal(r.delivery_through_window_end,'UNKNOWN');assert.equal(r.events[0].created_at,at(2));assert.ok(!JSON.stringify(r.events).includes('canceller'));assert.ok(!JSON.stringify(r.events).includes('forged'));
  let calls=0;const changed=await collectNativeActivity({request:async()=>({ok:true,body:++calls===1?[e]:[{...e,payload:{...e.payload,head:base}}]}),repository,window});
  assert.equal(changed.status,'PARTIAL');assert.equal(changed.reason_code,'NATIVE_ACTIVITY_IMMUTABLE_EVENT_CHANGED');assert.equal(changed.events.length,0);
  assert.deepEqual(changed.quarantined_ids,['91']);assert.equal(changed.quarantine[0].observations.length,2);
});
