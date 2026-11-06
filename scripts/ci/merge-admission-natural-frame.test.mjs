// All provider/Owner data below are synthetic wire fixtures. No live usage,
// actual Source qualification, permission, CI or natural observation window.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {registerHooks} from 'node:module';
import {loadSourceHistoryFixture} from './hosted-migration-source-history.fixture.mjs';
import {loadPublisherSourceHistoryFixture} from './production-publisher-source-history.fixture.mjs';
import {loadHistoricalWorkflowProfiles69e} from './fixtures/workflow-profiles-69e30b6/fixture.mjs';
import {parseWorkflowProfiles,registeredWorkflowSource,rolesForSource,roleDefinitionDigest} from './clued-workflow-profile.mjs';
import {createCatalogueSourceReader} from './clued-source-only-workflow.mjs';
import {qualifiedCI} from './clued-gated-proof.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),repo=process.env.CLUED_PRODUCER_TEST_REPO_ROOT??path.resolve(here,'../..');
registerHooks({resolve(s,c,next){if(s.startsWith('./')&&c.parentURL?.startsWith(pathToFileURL(here).href)){
  const own=path.join(here,s),real=path.join(repo,'scripts/ci',s);if(!fs.existsSync(own)&&fs.existsSync(real))return {url:pathToFileURL(real).href,shortCircuit:true};}return next(s,c);}});
const {assembleNaturalFourSourceFrame}=await import('./merge-admission-natural-frame.mjs');
const {createNaturalRecorder}=await import('./merge-admission-source-producer.mjs');
const {collectNaturalSourceArtifacts}=await import('./merge-admission-natural-intake.mjs');
const {collectNativeActivity}=await import('./merge-admission-native-activity.mjs');
const C=await import('./merge-admission-r9-collector.mjs');
const {emptyNativePopulationStore}=await import('./merge-admission-native-population.mjs');
const {R9_HISTORY_CAPS}=await import('./merge-admission-r9-reregister.mjs');
const h=x=>createHash('sha256').update(x).digest('hex'),blob=x=>createHash('sha1').update('blob '+Buffer.byteLength(x)+'\0').update(x).digest('hex');
const repository='tdoljyj/cross-memory-system',subject='891ea2e7a68e0a3201b64a8fd173f4d50a4c18dc',head='a'.repeat(40),base='b'.repeat(40),
  scope={project_id:'0597aa60-9b98-4da6-a4ab-63d7705b632f',queue_ref:'merge:'+repository+':main'},uid='10000000-0000-4000-8000-000000000001';
const at=s=>'2026-10-11T06:00:'+String(s).padStart(2,'0')+'.000000Z',window={start:at(0),end:at(59)},closed=at(59);
function fixture({executionSnapshot=null}={}){
  const paths={script:'scripts/ci/clued-work-admission.mjs',workflow:'.github/workflows/clued-work-admission.yml',reverify_workflow:'.github/workflows/clued-work-admission-reverify.yml',policy:'config/merge-admission-policy.json'},
    texts=Object.fromEntries(Object.entries(paths).map(([k,p])=>[k,fs.readFileSync(path.join(repo,p),'utf8')])),source={grammar:'clued.work-admission.evaluate-observation/1',source_checkout_sha:subject,default_branch:'main',app_id:5164952};
  for(const [k,p]of Object.entries(paths)){source[k+'_path']=p;source[k+'_blob']=blob(texts[k]);}
  const profiles=executionSnapshot?.profilesRaw??fs.readFileSync(path.join(repo,'scripts/ci/clued-gated-proof-profiles.json'),'utf8'),
    roles=executionSnapshot?.rolesRaw??fs.readFileSync(path.join(repo,'scripts/ci/clued-gated-proof-role-specs.json'),'utf8'),
    registry=parseWorkflowProfiles(profiles),independent=JSON.parse(roles),
    // Ordinary positive cases declare a registry-defined synthetic Source
    // world. They retain today's real raw /3 catalogue and role bytes, while
    // selecting only an exact already-registered blob and its independent
    // roles. This is not a claim that today's working tree is qualified.
    executionBlobs=Object.fromEntries(Object.keys(registry.workflows).map(file=>{
      const sha=executionSnapshot?executionSnapshot.workflowDirectory.find(row=>row.path===file).sha:
        registry.workflows[file].workflow_blob;
      const picked=registeredWorkflowSource(registry,file,sha),assigned=rolesForSource(independent,file,sha);
      assert.equal(picked.passed,true);assert.ok(Array.isArray(assigned));
      assert.deepEqual(assigned.map(role=>role.job_id).sort(),[...picked.profile.primary_ids].sort());
      for(const role of assigned)if(Object.hasOwn(role,'definition'))
        assert.equal(roleDefinitionDigest(role.definition),role.definition_sha256);
      return [file,sha];
    })),
    expected={schema:'clued.merge-admission-four-source-expectations/1',repository,scope,admission_sources:[source],execution_source:{source_checkout_sha:subject,profiles_sha256:h(profiles),role_specs_sha256:h(roles)}},
    runtime={source_contract_raw:JSON.stringify({schema:'clued.merge-admission-r9-source-contract/1',repository,scope,window,four_expected_sources_raw:JSON.stringify(expected),clock:null}),
      forward_epoch:{epoch_id:uid},operation_coverage:{schema:'clued.r9-finite-recorded-operation-coverage/1',owner_receipt_id:uid,epoch_id:uid,repository,scope,mode:'explicit_recorded_origins_during_this_epoch',original_source_paths:['scripts/ci/clued-work-admission.mjs','scripts/ci/clued-merge-executor.mjs']},
      proof_profiles_raw:profiles,role_specs_raw:roles,natural_selection:{default_branch:'main'},execution_workflow_blobs:executionBlobs};
  return {runtime,native:{status:'COMPLETE',population_packets:[],population:{cohort_digest:'actual-synthetic-native-snapshot'}},attemptRows:[],
    natural:{status:'NATIVE_ORIGIN_BOUND',entries:[]},closedAt:closed,sourceBytes:{[subject]:{texts,...Object.fromEntries(['script','workflow','reverify_workflow','policy'].map(k=>[k+'_blob',source[k+'_blob']]))}}};
}
test('actual assembly entry builds eight closed empty populations only from a complete Native/provider fixture, never authentication flags',()=>{
  const f=fixture(),r=assembleNaturalFourSourceFrame(f);assert.equal(r.status,'FOUR_SOURCE_FRAME_DATA_CANDIDATE',JSON.stringify(r.gaps));
  assert.equal(Object.keys(JSON.parse(r.frame.packet_raw).populations).length,8);assert.equal(r.math.metrics.update_main_rounds.value,0);
  assert.equal(r.source_authenticated,false);assert.equal(r.official_metric,false);assert.equal(r.t0,null);
});

test('exact disabled External2 metadata closes the source directory but never supplies execution proof',()=>{
  for(const [file,expectedBlob]of [
    ['.github/workflows/clued-handover-disposable-idle.yml','97c39730ce75f2ea2427c9fa3845f9df32e998f8'],
    ['.github/workflows/clued-handover-external-qualification.yml','689a1c5fcdbefa5353715f55e39c0fc08a9f5230']
  ]){
    const f=fixture(),actual=blob(fs.readFileSync(path.join(repo,file),'utf8')),
      registry=parseWorkflowProfiles(f.runtime.proof_profiles_raw),roles=JSON.parse(f.runtime.role_specs_raw),
      expected=JSON.parse(JSON.parse(f.runtime.source_contract_raw).four_expected_sources_raw);
    assert.equal(actual,expectedBlob,'the real unaccepted Source bytes remain independently witnessed');
    assert.equal(registeredWorkflowSource(registry,file,actual).passed,false);
    assert.equal(rolesForSource(roles,file,actual),null);
    assert.equal(h(f.runtime.proof_profiles_raw),expected.execution_source.profiles_sha256);
    assert.equal(h(f.runtime.role_specs_raw),expected.execution_source.role_specs_sha256);
    f.runtime.execution_workflow_blobs[file]=actual;
    const before=JSON.stringify(f),r=assembleNaturalFourSourceFrame(f);
    assert.equal(r.status,'FOUR_SOURCE_FRAME_DATA_CANDIDATE',JSON.stringify(r.gaps));
    const packet=JSON.parse(r.frame.packet_raw);
    assert.ok(packet.execution_sources.entries.some(source=>source.workflow_file===file&&source.workflow_blob===actual));
    assert.equal(packet.rounds.length,0);assert.equal(r.math.metrics.wasted_final_rounds.denominator,0);
    assert.equal(JSON.stringify(f),before);assert.equal(r.source_authenticated,false);
    assert.equal(r.official_metric,false);assert.equal(r.t0,null);
  }
});

test('complete Native run and primary-job observations cannot turn disabled External metadata into execution proof',async()=>{
  for(const file of ['.github/workflows/clued-handover-disposable-idle.yml','.github/workflows/clued-handover-external-qualification.yml']){
    const f=fixture(),registry=parseWorkflowProfiles(f.runtime.proof_profiles_raw),roleSpecs=JSON.parse(f.runtime.role_specs_raw),
      actual=blob(fs.readFileSync(path.join(repo,file))),source=createCatalogueSourceReader({registry,roleSpecs})({file,blob:actual});
    assert.equal(source.source_identified,true);assert.equal(source.execution_eligible,false);
    const run={id:9800,run_attempt:1,event:'pull_request',path:file,head_sha:head,status:'completed',conclusion:'success',pull_requests:[{number:727}]},
      jobs=[{id:9801,run_id:run.id,run_attempt:1,name:'admission-gate',status:'completed',conclusion:'success',labels:['self-hosted'],steps:[]},
        ...source.profile.routes.map((route,index)=>({id:9802+index,run_id:run.id,run_attempt:1,name:route.name,status:'completed',conclusion:'success',
          labels:['self-hosted'],steps:Object.entries(route.required_steps).flatMap(([name,count])=>
            Array.from({length:count},()=>({name,status:'completed',conclusion:'success'})))}))];
    let jobReads=0;
    const proof=await qualifiedCI({repository,head,prNumber:727,workflows:new Map([[file,actual]]),profiles:{workflows:{[file]:source.profile}},
      // Even an erroneously positive caller authorization cannot override the
      // actual disabled Source mode at the production execution qualifier.
      authorizeSource:async()=>true,revalidateSources:async()=>true,read:async route=>{
        if(route.includes('/jobs?')){jobReads++;return {total_count:jobs.length,jobs};}
        if(route.includes('/actions/runs?'))return {total_count:1,workflow_runs:[run]};
        if(route.endsWith('/actions/runs/'+run.id))return run;
        throw Error('UNEXPECTED_PURE_NATIVE_READ');
      }});
    assert.equal(jobReads,1,'the real qualifier consumed the complete Native job fixture');
    assert.equal(proof.passed,false);assert.equal(proof.code,'SOURCE_METADATA_ONLY_DISABLED');
    assert.equal(proof.gate_only,false);assert.equal(proof.rerun,undefined);
    assert.equal(registeredWorkflowSource(registry,file,actual).passed,false);
    assert.equal(source.host_qualified,false);assert.equal(source.operator_accepted,false);
  }
});
test('missing real finite-epoch selection or partial Native source cannot be converted to a hand-written complete zero',()=>{
  for(const change of [f=>f.runtime.operation_coverage=null,f=>f.native.status='PARTIAL',f=>f.natural.status='PARTIAL',f=>f.runtime.operation_coverage.epoch_id='10000000-0000-4000-8000-000000000002']){
    const f=fixture();change(f);f.complete=true;f.source_authenticated=true;assert.equal(assembleNaturalFourSourceFrame(f).status,'PARTIAL');}
});
function rejectedAdmissionFixture(){
  const f=fixture(),events=[],env={GITHUB_REPOSITORY:repository,GITHUB_RUN_ID:'42',GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:'clued-work-admission',GITHUB_SHA:base};let second=1;
  const r=createNaturalRecorder({env,sourcePath:'scripts/ci/clued-work-admission.mjs',write:e=>events.push(e),now:()=>at(second++)});
  const pr={number:727,state:'open',draft:false,head:{sha:head},base:{sha:base,ref:'main',repo:{full_name:repository}}};
  r.record('admission_input',{evaluation_id:uid,pr,entry:'required'});r.record('admission_selected',{evaluation_id:uid,pr,entry:'required'});
  r.record('admission_final',{evaluation_id:uid,entry:'required',completion:'returned',outcome:{head_sha:head,pr_ref:repository+'#727',claim_id:null,enforced:true,admitted:false,verdict:'REJECTED',reasons:['claim_trailer_missing'],admission_mode:{state:'normal',layer:'code'}}});
  for(const e of events)e.source.executed_checkout_sha=subject;
  const n={run:{run_id:'42',run_attempt:1,path:'.github/workflows/clued-work-admission.yml',event:'pull_request_target',head_sha:base,status:'completed',conclusion:'failure',created_at:at(0),run_started_at:at(1),updated_at:at(6),pull_requests:[727]},
    jobs:[{id:'43',run_id:'42',run_attempt:1,name:'kooyumi-work-admission',status:'completed',conclusion:'failure',created_at:at(1),started_at:at(1),completed_at:at(5),labels:['ubuntu-slim'],steps:[{name:'Verify the work claim with Clued and summarize applicable workflows',conclusion:'failure'}]}]};
  f.native.population_packets=[n];f.attemptRows=[{run_id:'42',attempt:1,pr_number:727,head_sha:base,kind:'admission',status:'completed',conclusion:'failure',started_at:at(1),completed_at:null,
    terminal_interval:{lower_at:at(5),upper_at:at(6),basis:'native_job_completion_lower_and_terminal_update_upper_bounds'}}];
  f.natural.entries=[{run_key:'42:1',job_id:'clued-work-admission',checkout_sha:subject,artifact_digest:'sha256:'+'d'.repeat(64),native_origin:{head_branch:'main',event:'pull_request_target'},packet_raw:JSON.stringify({events})}];
  return f;
}
test('real natural evaluator records map a rejected admission through the actual eight-population entry',()=>{
  const f=rejectedAdmissionFixture(),built=assembleNaturalFourSourceFrame(f);assert.equal(built.status,'FOUR_SOURCE_FRAME_DATA_CANDIDATE',JSON.stringify(built.gaps));
  assert.equal(built.math.metrics.admission_failures_by_reason.rejected,1);assert.equal(built.math.metrics.admission_failures_by_reason.denominator,1);
  assert.equal(built.math.metrics.unclaimed_admitted.value,0);assert.equal(built.source_authenticated,false);
  f.natural.entries=[];const missing=assembleNaturalFourSourceFrame(f);assert.equal(missing.status,'PARTIAL');assert.ok(missing.gaps.some(x=>x.includes('ADMISSION_NATIVE_ORIGIN_MISSING')));
});

test('the existing exact four-blob admission template qualifies a historical checkout without treating history as current',()=>{
  const baseFixture=fixture(),current=JSON.parse(JSON.parse(baseFixture.runtime.source_contract_raw).four_expected_sources_raw).admission_sources[0],
    texts={...baseFixture.sourceBytes[subject].texts,script:baseFixture.sourceBytes[subject].texts.script+'\n// exact mocked historical admission bytes\n'},
    source={texts,...Object.fromEntries(['script','workflow','reverify_workflow','policy'].map(k=>[k+'_blob',blob(texts[k])]))},
    template={...current,...Object.fromEntries(['script','workflow','reverify_workflow','policy'].map(k=>[k+'_blob',source[k+'_blob']])),source_checkout_sha:'d'.repeat(40)},checkout='c'.repeat(40);
  const make=()=>{const f=rejectedAdmissionFixture(),contract=JSON.parse(f.runtime.source_contract_raw),expected=JSON.parse(contract.four_expected_sources_raw);
    expected.admission_sources.push(template);contract.four_expected_sources_raw=JSON.stringify(expected);f.runtime.source_contract_raw=JSON.stringify(contract);
    const entry=f.natural.entries[0],packet=JSON.parse(entry.packet_raw);entry.checkout_sha=checkout;
    for(const event of packet.events)event.source.executed_checkout_sha=checkout;entry.packet_raw=JSON.stringify(packet);
    f.sourceBytes[checkout]=structuredClone(source);return f;};
  const f=make(),r=assembleNaturalFourSourceFrame(f);assert.equal(r.status,'FOUR_SOURCE_FRAME_DATA_CANDIDATE',JSON.stringify(r.gaps));
  const inherited=JSON.parse(r.frame.expected_sources_raw).admission_sources.find(s=>s.source_checkout_sha===checkout);
  assert.equal(inherited.script_blob,template.script_blob);assert.equal(inherited.default_branch,'main');
  assert.notEqual(inherited.script_blob,current.script_blob);assert.equal(r.source_authenticated,false);assert.equal(r.official_metric,false);assert.equal(r.t0,null);
  const noTemplate=make(),contract=JSON.parse(noTemplate.runtime.source_contract_raw),expected=JSON.parse(contract.four_expected_sources_raw);
  expected.admission_sources=expected.admission_sources.filter(s=>s.source_checkout_sha!==template.source_checkout_sha);
  contract.four_expected_sources_raw=JSON.stringify(expected);noTemplate.runtime.source_contract_raw=JSON.stringify(contract);
  const refused=assembleNaturalFourSourceFrame(noTemplate);assert.equal(refused.status,'PARTIAL');assert.ok(refused.gaps.some(g=>g.includes('ADMISSION_ACTUAL_CHECKOUT_NOT_REVIEWED')));
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

function intakeVersionFixture({succession=false,renamed=false}={}){
  const jobId=renamed?'clued-work-admission':'admission',oldName=renamed?'clued-work-admission':'source-job',currentName=renamed?'kooyumi-work-admission':'source-job';
  const paths={script:'scripts/ci/clued-work-admission.mjs',workflow:'.github/workflows/clued-work-admission.yml',
    reverify_workflow:'.github/workflows/clued-work-admission-reverify.yml',policy:'config/merge-admission-policy.json'},runtimePath='scripts/ci/clued-gated-proof-runtime.mjs',
    sourcePaths=[...Object.values(paths),...(succession?[runtimePath]:[])],
    oldTexts={[paths.script]:'// reviewed old script\n',[paths.workflow]:'name: reviewed producer\n',[paths.reverify_workflow]:'name: reviewed reverify\n',[paths.policy]:'{"version":"old"}\n',
      ...(succession?{[runtimePath]:'// reviewed runtime 454\n'}:{})},
    middleTexts={...oldTexts,...(succession?{[runtimePath]:'// reviewed runtime b093\n'}:{})},
    currentTexts={...middleTexts,[paths.script]:'// reviewed current script\n',[paths.policy]:'{"version":"current"}\n',
      ...(succession?{[paths.workflow]:'name: reviewed successor producer\n'}:{})},
    pins=texts=>Object.fromEntries(sourcePaths.map(p=>[p,blob(texts[p])])),oldMap=pins(oldTexts),middleMap=pins(middleTexts),currentMap=pins(currentTexts),
    currentDescriptor={registration_status:'registered',workflow_path:paths.workflow,workflow_blob:currentMap[paths.workflow],job_id:jobId,
      job_name:currentName,source_paths:sourcePaths,source_blobs:currentMap,required_steps:['Export','Upload']},
    oldDescriptor={...currentDescriptor,job_name:oldName,workflow_blob:oldMap[paths.workflow],source_blobs:oldMap},
    middleDescriptor={...currentDescriptor,job_name:oldName,workflow_blob:middleMap[paths.workflow],source_blobs:middleMap},
    descriptor={...currentDescriptor,previous_source_blobs:[oldMap,...(succession?[middleMap]:[])],...(renamed?{previous_job_name:oldName}:{})},middle='c'.repeat(40),
    textsByCommit={[base]:oldTexts,[head]:currentTexts,...(succession?{[middle]:middleTexts}:{})},records=[];
  for(const [run,artifactId,commit]of [['42','9',base],...(succession?[['46','13',middle]]:[]),['44','11',head]]){
    const r=createNaturalRecorder({env:{GITHUB_REPOSITORY:repository,GITHUB_RUN_ID:run,GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:jobId},
      sourcePath:paths.script,write:()=>{},now:()=>at(1)}),session={...r.finish(),executed_checkout_sha:commit},
      bytes=Buffer.from(JSON.stringify({schema:'clued.merge-admission-natural-artifact/1',identity:{repository,run_id:run,attempt:1,logical_job_key:jobId},
        events:[],sessions:[session],files:[],local_stream:{status:'CLOSED_LOCAL_STREAM',known_gaps:[]}})),
      artifact={id:artifactId,name:`clued-r9-natural-source-${run}-1-${jobId}`,expired:false,digest:'sha256:'+h(bytes),workflow_run:{id:run,head_sha:commit}},
      native={run:{run_id:run,run_attempt:1,status:'completed',conclusion:'success',head_sha:commit,path:paths.workflow,event:'push'},
        jobs:[{id:String(Number(run)+1),name:commit===head?currentName:oldName,status:'completed',conclusion:'success',steps:['Export','Upload'].map(name=>({name,status:'completed',conclusion:'success'}))}]};
    records.push({native,bytes,artifact,commit});
  }
  const routes=[],request=async route=>{
    routes.push(route);let m=route.match(/\/actions\/runs\/(\d+)\/artifacts\?/);
    if(m)return {ok:true,body:{total_count:1,artifacts:[records.find(r=>r.native.run.run_id===m[1]).artifact]}};
    m=route.match(/\/actions\/artifacts\/(\d+)(\/zip)?$/);
    if(m){const r=records.find(r=>r.artifact.id===m[1]);return {ok:true,body:m[2]?r.bytes:r.artifact};}
    m=route.match(/\/actions\/runs\/(\d+)\/attempts\/1$/);
    if(m){const r=records.find(r=>r.native.run.run_id===m[1]);return {ok:true,body:{id:m[1],run_attempt:1,head_sha:r.commit,event:'push',head_branch:'main',head_repository:{full_name:repository}}};}
    m=route.match(/\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})$/);
    if(m)return {ok:true,body:{status:m[1]===m[2]?'identical':'ahead',merge_base_commit:{sha:m[1]}}};
    m=route.match(/\/contents\/(.+)\?ref=(.+)$/);
    if(m){const text=textsByCommit[decodeURIComponent(m[2])]?.[m[1]];assert.equal(typeof text,'string','every requested source has mocked bytes');
      return {ok:true,body:{type:'file',path:m[1],encoding:'base64',sha:blob(text),content:Buffer.from(text).toString('base64')}};}
    throw Error('UNMOCKED_NATURAL_INTAKE_ROUTE');
  },native={status:'COMPLETE',population_packets:records.map(r=>r.native)},
    selection={repository,head_sha:head,default_branch:'main',admission_source:Object.fromEntries(Object.entries(paths).map(([k,p])=>[k+'_path',p])),natural_producers:[descriptor]},
    collect=overrides=>collectNaturalSourceArtifacts({request,repository,native,selection,readZip:b=>b.toString(),...overrides});
  return {paths,runtimePath,sourcePaths,oldMap,middleMap,currentMap,oldDescriptor,middleDescriptor,currentDescriptor,descriptor,oldTexts,middleTexts,currentTexts,textsByCommit,records,native,selection,routes,request,collect};
}

function namedSuccessorFixture({capacitySuccessor=false,publisherSuccessor=false}={}){
  const f=intakeVersionFixture({succession:true,renamed:true}),pins=texts=>Object.fromEntries(f.sourcePaths.map(p=>[p,blob(texts[p])])),
    thirdTexts={...f.middleTexts,[f.paths.script]:'// reviewed third legacy script\n'},
    successorTexts={...f.currentTexts,[f.paths.script]:'// reviewed Kooyumi successor script\n'},
    rows=[
      {run:'42',artifact:'9',commit:base,texts:f.oldTexts,name:'clued-work-admission'},
      {run:'46',artifact:'13',commit:'c'.repeat(40),texts:f.middleTexts,name:'clued-work-admission'},
      {run:'48',artifact:'15',commit:'d'.repeat(40),texts:thirdTexts,name:'clued-work-admission'},
      {run:'44',artifact:'11',commit:head,texts:f.currentTexts,name:'kooyumi-work-admission'},
      {run:'50',artifact:'17',commit:'e'.repeat(40),texts:successorTexts,name:'kooyumi-work-admission'}
    ];
  if(capacitySuccessor||publisherSuccessor)rows.push({run:'52',artifact:'19',commit:'f'.repeat(40),
    texts:{...successorTexts,[f.paths.script]:'// reviewed profile-capacity successor script\n'},name:'kooyumi-work-admission'});
  if(publisherSuccessor)rows.push({run:'54',artifact:'21',commit:'9'.repeat(40),
    texts:{...successorTexts,[f.paths.script]:'// reviewed dispatch publisher Source successor script\n'},name:'kooyumi-work-admission'});
  for(const row of rows){
    row.map=pins(row.texts);f.textsByCommit[row.commit]=row.texts;
    row.descriptor={...f.currentDescriptor,job_name:row.name,workflow_blob:row.map[f.paths.workflow],source_blobs:row.map};
    const recorder=createNaturalRecorder({env:{GITHUB_REPOSITORY:repository,GITHUB_RUN_ID:row.run,GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:'clued-work-admission'},
      sourcePath:f.paths.script,write:()=>{},now:()=>at(1)}),
      session={...recorder.finish(),executed_checkout_sha:row.commit,source_sha256:h(row.texts[f.paths.script])},
      bytes=Buffer.from(JSON.stringify({schema:'clued.merge-admission-natural-artifact/1',identity:{repository,run_id:row.run,attempt:1,logical_job_key:'clued-work-admission'},
        events:[],sessions:[session],files:[],local_stream:{status:'CLOSED_LOCAL_STREAM',known_gaps:[]}}));
    row.record={commit:row.commit,bytes,artifact:{id:row.artifact,name:`clued-r9-natural-source-${row.run}-1-clued-work-admission`,expired:false,
      digest:'sha256:'+h(bytes),workflow_run:{id:row.run,head_sha:row.commit}},
      native:{run:{run_id:row.run,run_attempt:1,status:'completed',conclusion:'success',head_sha:row.commit,path:f.paths.workflow,event:'push'},
        jobs:[{id:String(Number(row.run)+1),name:row.name,status:'completed',conclusion:'success',steps:['Export','Upload'].map(name=>({name,status:'completed',conclusion:'success'}))}]}};
  }
  f.records.splice(0,f.records.length,...rows.map(r=>r.record));f.native.population_packets=f.records.map(r=>r.native);
  const current=rows.at(-1),descriptor={...current.descriptor,previous_source_versions:rows.slice(0,-1).map(r=>({job_name:r.name,source_blobs:r.map}))};
  f.selection.head_sha=current.commit;f.selection.natural_producers=[descriptor];
  return {...f,rows,descriptor};
}

test('explicit Source versions retain three legacy generations and both Kooyumi generations with unchanged descriptor digests and old caches',async()=>{
  const f=namedSuccessorFixture(),before=JSON.stringify(f.selection),r=await f.collect();
  assert.equal(r.status,'NATIVE_ORIGIN_BOUND',JSON.stringify(r.gaps));assert.equal(r.entries.length,5);
  for(const [i,row]of f.rows.entries()){
    assert.equal(r.entries[i].descriptor_digest,h(JSON.stringify(row.descriptor)));
    assert.deepEqual(r.source_bytes[row.commit],{texts:Object.fromEntries(Object.entries(f.paths).map(([k,p])=>[k,row.texts[p]])),
      ...Object.fromEntries(Object.entries(f.paths).map(([k,p])=>[k+'_blob',row.map[p]]))});
    assert.ok(f.routes.some(route=>route.includes('/actions/artifacts/'+row.artifact+'/zip')));
  }
  assert.equal(f.rows[3].descriptor.workflow_blob,f.rows[4].descriptor.workflow_blob,'the Kooyumi successor changes the script, not the job name or workflow');
  assert.notEqual(f.rows[3].map[f.paths.script],f.rows[4].map[f.paths.script]);
  const entries=[],sources={};
  for(const row of f.rows.slice(0,-1)){
    const old=await f.collect({native:{status:'COMPLETE',population_packets:[row.record.native]},
      selection:{...f.selection,natural_producers:[row.descriptor]}});
    assert.equal(old.status,'NATIVE_ORIGIN_BOUND',JSON.stringify(old.gaps));entries.push(...old.entries);Object.assign(sources,old.source_bytes);
  }
  let reads=0;const reused=await f.collect({native:{status:'COMPLETE',population_packets:f.rows.slice(0,-1).map(r=>r.record.native)},
    authenticatedEntries:entries,authenticatedSourceBytes:sources,request:async()=>{reads++;throw Error('BOTH_HISTORICAL_NAMES_MUST_REUSE_EXACT_AUTHENTICATED_CACHE');}});
  assert.equal(reused.status,'NATIVE_ORIGIN_BOUND',JSON.stringify(reused.gaps));assert.equal(reads,0);assert.deepEqual(reused.entries,entries);
  const current=f.rows.at(-1),empty=await f.collect({native:{status:'COMPLETE',population_packets:[current.record.native]},
    selection:{...f.selection,natural_producers:[{...current.descriptor,previous_source_versions:[]}]}});
  assert.equal(empty.status,'NATIVE_ORIGIN_BOUND');assert.equal(empty.entries[0].descriptor_digest,h(JSON.stringify(current.descriptor)));
  assert.equal(JSON.stringify(f.selection),before);assert.equal(r.source_authenticated,false);assert.equal(r.official_metric,false);assert.equal(r.t0,null);
});

test('a fifth exact historical generation preserves every prior descriptor and cache identity',async()=>{
  const f=namedSuccessorFixture({capacitySuccessor:true}),r=await f.collect();
  assert.equal(f.descriptor.previous_source_versions.length,5);
  assert.equal(r.status,'NATIVE_ORIGIN_BOUND',JSON.stringify(r.gaps));assert.equal(r.entries.length,6);
  for(const [i,row]of f.rows.entries())assert.equal(r.entries[i].descriptor_digest,h(JSON.stringify(row.descriptor)));
  assert.equal(r.source_authenticated,false);assert.equal(r.official_metric,false);assert.equal(r.t0,null);
});

test('dispatch Source successor retains six exact prior generations; a seventh unique prior map is refused before HTTP',async()=>{
  const f=namedSuccessorFixture({publisherSuccessor:true}),r=await f.collect();
  // The re-registration helper rotates at this exact capacity; the intake accepts it and refuses one more.
  assert.equal(f.descriptor.previous_source_versions.length,R9_HISTORY_CAPS.previous_source_versions);
  assert.equal(r.status,'NATIVE_ORIGIN_BOUND',JSON.stringify(r.gaps));assert.equal(r.entries.length,7);
  for(const [i,row]of f.rows.entries())assert.equal(r.entries[i].descriptor_digest,h(JSON.stringify(row.descriptor)));
  const d=structuredClone(f.descriptor);
  d.previous_source_versions.push({job_name:d.job_name,source_blobs:{...d.source_blobs,[f.paths.script]:'1'.repeat(40)}});
  let reads=0;const refused=await f.collect({native:{status:'COMPLETE',population_packets:[]},selection:{...f.selection,natural_producers:[d]},
    request:async()=>{reads++;throw Error('SEVENTH_PRIOR_GENERATION_MUST_NOT_READ');}});
  assert.equal(refused.status,'PARTIAL');assert.equal(reads,0);
  assert.ok(refused.gaps.some(g=>g.code==='NATURAL_PRODUCER_SELECTION_INVALID'));
  assert.equal(r.source_authenticated,false);assert.equal(r.official_metric,false);assert.equal(r.t0,null);
});

test('explicit Source histories reject ambiguous formats, names, incomplete maps and duplicates before HTTP',async()=>{
  const f=namedSuccessorFixture(),copy=()=>structuredClone(f.descriptor),without=(m,p)=>Object.fromEntries(Object.entries(m).filter(([k])=>k!==p)),
    changes=[
      ['non-array',d=>d.previous_source_versions={}],
      ['over bound',d=>d.previous_source_versions.push({...d.previous_source_versions[0]},{...d.previous_source_versions[0]},{...d.previous_source_versions[0]})],
      ['mixed old maps',d=>d.previous_source_blobs=[]],
      ['mixed old name',d=>d.previous_job_name='clued-work-admission'],
      ['missing current',d=>delete d.source_blobs],
      ['non-object row',d=>d.previous_source_versions[0]=null],
      ['extra row field',d=>d.previous_source_versions[0].source_authenticated=true],
      ['missing row name',d=>delete d.previous_source_versions[0].job_name],
      ['missing row map',d=>delete d.previous_source_versions[0].source_blobs],
      ...['unknown','Kooyumi-work-admission',' kooyumi-work-admission',''].map(name=>['bad name '+name,d=>d.previous_source_versions[0].job_name=name]),
      ['legacy name on another technical job',d=>d.job_id='unreviewed-job'],
      ['current map incomplete',d=>d.source_blobs=without(d.source_blobs,f.paths.policy)],
      ['historical map incomplete',d=>d.previous_source_versions[0].source_blobs=without(d.previous_source_versions[0].source_blobs,f.paths.policy)],
      ['extra map path',d=>d.previous_source_versions[0].source_blobs['scripts/unreviewed.mjs']='a'.repeat(40)],
      ['invalid map SHA',d=>d.previous_source_versions[0].source_blobs[f.paths.script]='A'.repeat(40)],
      ['workflow absent',d=>d.source_paths=d.source_paths.filter(p=>p!==d.workflow_path)],
      ['duplicate current',d=>d.previous_source_versions[0].source_blobs=Object.fromEntries(Object.entries(d.source_blobs).reverse())],
      ['duplicate historical',d=>d.previous_source_versions[1].source_blobs=Object.fromEntries(Object.entries(d.previous_source_versions[0].source_blobs).reverse())]
    ];
  for(const [label,change]of changes){
    const d=copy();change(d);let reads=0;const r=await f.collect({native:{status:'COMPLETE',population_packets:[]},
      selection:{...f.selection,natural_producers:[d]},request:async()=>{reads++;throw Error('INVALID_EXPLICIT_HISTORY_MUST_NOT_READ');}});
    assert.equal(r.status,'PARTIAL',label);assert.equal(r.entries.length,0,label);assert.equal(reads,0,label);
    assert.ok(r.gaps.some(g=>g.code==='NATURAL_PRODUCER_SELECTION_INVALID'),label);
  }
});

test('explicit names cannot borrow another generation and cached proof changes still require fresh Native artifacts',async()=>{
  for(const [index,name]of [[0,'kooyumi-work-admission'],[2,'kooyumi-work-admission'],[3,'clued-work-admission'],[4,'clued-work-admission'],[4,'unknown']]){
    const f=namedSuccessorFixture();f.rows[index].record.native.jobs[0].name=name;
    const r=await f.collect({native:{status:'COMPLETE',population_packets:[f.rows[index].record.native]}});
    assert.equal(r.status,'PARTIAL',name);assert.equal(r.entries.length,0,name);
  }
  for(const change of [f=>{f.textsByCommit[f.rows[3].commit]={...f.rows[3].texts,[f.paths.policy]:f.rows[0].texts[f.paths.policy]};},
    f=>{f.textsByCommit[f.rows[3].commit]={...f.rows[3].texts,[f.runtimePath]:f.rows[0].texts[f.runtimePath]};}]){
    const f=namedSuccessorFixture();change(f);const r=await f.collect({native:{status:'COMPLETE',population_packets:[f.rows[3].record.native]}});
    assert.equal(r.status,'PARTIAL');assert.equal(r.entries.length,0);assert.ok(r.gaps.some(g=>g.code==='NATURAL_SOURCE_SELECTION_BYTES_MISMATCH'));
  }
  for(const index of [0,3]){
    const f=namedSuccessorFixture(),native={status:'COMPLETE',population_packets:[f.rows[index].record.native]},old=await f.collect({native});
    assert.equal(old.status,'NATIVE_ORIGIN_BOUND');
    for(const change of [{native_run_digest:'f'.repeat(64)},{native_jobs_digest:'f'.repeat(64)},{descriptor_digest:h(JSON.stringify(f.descriptor))},null]){
      let reads=0;const r=await f.collect({native,authenticatedEntries:change?[{...old.entries[0],...change}]:old.entries,
        authenticatedSourceBytes:change?old.source_bytes:{},request:async()=>{reads++;return {ok:true,body:{total_count:0,artifacts:[]}};}});
      assert.equal(r.status,'PARTIAL');assert.equal(r.entries.length,0);assert.equal(reads,1);
    }
  }
});

test('workflow/script succession retains three exact runtime Source versions and both old authenticated descriptor digests',async()=>{
  const f=intakeVersionFixture({succession:true}),r=await f.collect();
  assert.equal(r.status,'NATIVE_ORIGIN_BOUND',JSON.stringify(r.gaps));assert.equal(r.entries.length,3);
  for(const [i,d]of [f.oldDescriptor,f.middleDescriptor,f.currentDescriptor].entries()){
    assert.equal(r.entries[i].descriptor_digest,h(JSON.stringify(d)));
    assert.equal(r.source_bytes[r.entries[i].checkout_sha].workflow_blob,d.workflow_blob);
  }
  assert.notEqual(f.oldDescriptor.workflow_blob,f.currentDescriptor.workflow_blob);
  const entries=[],sources={};
  for(const [i,d]of [f.oldDescriptor,f.middleDescriptor].entries()){
    const old=await f.collect({native:{status:'COMPLETE',population_packets:[f.records[i].native]},selection:{...f.selection,natural_producers:[d]}});
    assert.equal(old.status,'NATIVE_ORIGIN_BOUND',JSON.stringify(old.gaps));entries.push(...old.entries);Object.assign(sources,old.source_bytes);
  }
  let reads=0;const reused=await f.collect({native:{status:'COMPLETE',population_packets:f.records.slice(0,2).map(r=>r.native)},
    authenticatedEntries:entries,authenticatedSourceBytes:sources,request:async()=>{reads++;throw Error('OLD_WF_CACHE_MUST_NOT_REREAD');}});
  assert.equal(reused.status,'NATIVE_ORIGIN_BOUND',JSON.stringify(reused.gaps));assert.equal(reads,0);assert.deepEqual(reused.entries,entries);
  assert.equal(r.source_authenticated,false);assert.equal(r.official_metric,false);assert.equal(r.t0,null);
});

test('check-name migration binds each Native job name to its exact current or historical workflow bytes',async()=>{
  const f=intakeVersionFixture({succession:true,renamed:true}),r=await f.collect();
  assert.equal(r.status,'NATIVE_ORIGIN_BOUND',JSON.stringify(r.gaps));assert.equal(r.entries.length,3);
  for(const [i,d]of [f.oldDescriptor,f.middleDescriptor,f.currentDescriptor].entries())
    assert.equal(r.entries[i].descriptor_digest,h(JSON.stringify(d)));
  const old=await f.collect({native:{status:'COMPLETE',population_packets:[f.records[0].native]},
    selection:{...f.selection,natural_producers:[f.oldDescriptor]}});
  assert.equal(old.status,'NATIVE_ORIGIN_BOUND');assert.equal(old.entries[0].descriptor_digest,r.entries[0].descriptor_digest);
  let reads=0;const reused=await f.collect({native:{status:'COMPLETE',population_packets:[f.records[0].native]},
    authenticatedEntries:old.entries,authenticatedSourceBytes:old.source_bytes,
    request:async()=>{reads++;throw Error('OLD_NAME_CACHE_MUST_NOT_REREAD');}});
  assert.equal(reused.status,'NATIVE_ORIGIN_BOUND');assert.equal(reads,0);
  for(const [index,name]of [[0,'kooyumi-work-admission'],[2,'clued-work-admission'],[2,'unreviewed-name']]){
    const bad=intakeVersionFixture({succession:true,renamed:true});bad.records[index].native.jobs[0].name=name;
    const refused=await bad.collect({native:{status:'COMPLETE',population_packets:[bad.records[index].native]}});
    assert.equal(refused.status,'PARTIAL',name);assert.equal(refused.entries.length,0,name);
  }
});

test('an old workflow cannot borrow successor script or runtime bytes outside its declared complete Source version',async()=>{
  for(const change of [f=>{f.textsByCommit[base]={...f.oldTexts,[f.paths.script]:f.currentTexts[f.paths.script]};},
    f=>{f.textsByCommit[base]={...f.currentTexts,[f.paths.workflow]:f.oldTexts[f.paths.workflow]};},
    f=>{f.textsByCommit[base]={...f.oldTexts,[f.runtimePath]:'// unknown runtime\n'};}]){
    const f=intakeVersionFixture({succession:true});change(f);
    const r=await f.collect({native:{status:'COMPLETE',population_packets:[f.records[0].native]}});
    assert.equal(r.status,'PARTIAL');assert.equal(r.entries.length,0);assert.ok(r.gaps.some(g=>g.code==='NATURAL_SOURCE_SELECTION_BYTES_MISMATCH'));
    assert.equal(r.source_authenticated,false);assert.equal(r.official_metric,false);assert.equal(r.t0,null);
  }
});

test('intake accepts coexisting complete old and current Source versions and seals the exact legacy-compatible descriptor digest',async()=>{
  const f=intakeVersionFixture(),input=JSON.stringify({native:f.native,selection:f.selection}),r=await f.collect();
  assert.equal(r.status,'NATIVE_ORIGIN_BOUND',JSON.stringify(r.gaps));assert.deepEqual(r.entries.map(e=>e.run_key),['42:1','44:1']);
  for(const [i,d]of [f.oldDescriptor,f.currentDescriptor].entries()){
    const e=r.entries[i],n=f.records[i].native;
    assert.equal(e.descriptor_digest,h(JSON.stringify(d)));assert.notEqual(e.descriptor_digest,h(JSON.stringify(f.descriptor)));
    assert.equal(e.native_run_digest,h(JSON.stringify(n.run)));assert.equal(e.native_jobs_digest,h(JSON.stringify(n.jobs)));
    assert.equal(e.artifact_digest,f.records[i].artifact.digest);assert.equal(e.checkout_sha,f.records[i].commit);
    assert.deepEqual(r.source_bytes[e.checkout_sha].texts,Object.fromEntries(Object.entries(f.paths).map(([k,p])=>[k,f.textsByCommit[e.checkout_sha][p]])));
    for(const [k,p]of Object.entries(f.paths))assert.equal(r.source_bytes[e.checkout_sha][k+'_blob'],d.source_blobs[p]);
  }
  assert.equal(JSON.stringify({native:f.native,selection:f.selection}),input);
  assert.equal(r.source_authenticated,false);assert.equal(r.official_metric,false);assert.equal(r.t0,null);
});

test('an authenticated old descriptor cache survives Source inheritance with zero HTTP reads and unchanged Native and Source proofs',async()=>{
  const f=intakeVersionFixture(),oldNative={status:'COMPLETE',population_packets:[f.records[0].native]},
    old=await f.collect({native:oldNative,selection:{...f.selection,natural_producers:[f.oldDescriptor]}});
  assert.equal(old.status,'NATIVE_ORIGIN_BOUND',JSON.stringify(old.gaps));let calls=0;
  const r=await f.collect({native:oldNative,authenticatedEntries:old.entries,authenticatedSourceBytes:old.source_bytes,
    request:async()=>{calls++;throw Error('AUTHENTICATED_OLD_CACHE_MUST_NOT_REREAD');}});
  assert.equal(r.status,'NATIVE_ORIGIN_BOUND',JSON.stringify(r.gaps));assert.equal(calls,0);assert.equal(r.entries[0],old.entries[0]);
  assert.equal(r.entries[0].descriptor_digest,h(JSON.stringify(f.oldDescriptor)));assert.equal(r.source_bytes[base],old.source_bytes[base]);
  assert.deepEqual(r.artifact_population,{before:[],after:[]});assert.equal(r.source_authenticated,false);assert.equal(r.official_metric,false);assert.equal(r.t0,null);
});

test('Source inheritance cannot bypass Native run/jobs, exact variant digest or authenticated Source bytes in a restored cache',async()=>{
  const f=intakeVersionFixture(),oldNative={status:'COMPLETE',population_packets:[f.records[0].native]},
    old=await f.collect({native:oldNative,selection:{...f.selection,natural_producers:[f.oldDescriptor]}});
  assert.equal(old.status,'NATIVE_ORIGIN_BOUND',JSON.stringify(old.gaps));
  for(const change of [
    {authenticatedEntries:[{...old.entries[0],native_run_digest:'f'.repeat(64)}]},
    {authenticatedEntries:[{...old.entries[0],native_jobs_digest:'f'.repeat(64)}]},
    {authenticatedEntries:[{...old.entries[0],descriptor_digest:h(JSON.stringify(f.descriptor))}]},
    {authenticatedSourceBytes:{}}
  ]){
    let calls=0;const r=await f.collect({native:oldNative,authenticatedEntries:old.entries,authenticatedSourceBytes:old.source_bytes,...change,
      request:async()=>{calls++;return {ok:true,body:{total_count:0,artifacts:[]}};}});
    assert.equal(r.status,'PARTIAL');assert.equal(r.entries.length,0);assert.equal(calls,1);
    assert.ok(r.gaps.some(g=>g.code==='NATURAL_EXPECTED_ARTIFACT_MISSING_OR_DUPLICATE'));
  }
});

test('intake refuses unknown bytes and mixed old/current checkout maps rather than matching each path independently',async()=>{
  for(const change of [f=>{f.textsByCommit[base]={...f.oldTexts,[f.paths.script]:'// unreviewed script\n'};},
    f=>{f.textsByCommit[base]={...f.oldTexts,[f.paths.policy]:f.currentTexts[f.paths.policy]};}]){
    const f=intakeVersionFixture();change(f);const r=await f.collect({native:{status:'COMPLETE',population_packets:[f.records[0].native]}});
    assert.equal(r.status,'PARTIAL');assert.equal(r.entries.length,0);assert.ok(r.gaps.some(g=>g.code==='NATURAL_SOURCE_SELECTION_BYTES_MISMATCH'));
    assert.equal(r.source_bytes[base],undefined);assert.equal(r.source_authenticated,false);assert.equal(r.official_metric,false);assert.equal(r.t0,null);
  }
});

test('invalid Source histories are rejected before HTTP: bounded complete SHA maps and canonical uniqueness are required',async()=>{
  const f=intakeVersionFixture(),reverse=m=>Object.fromEntries(Object.entries(m).reverse()),without=(m,p)=>Object.fromEntries(Object.entries(m).filter(([k])=>k!==p)),
    variants=[
      ['non-array history',{...f.descriptor,previous_source_blobs:{}}],
      ['more than four versions',{...f.descriptor,previous_source_blobs:['0','1','2','3','4'].map(c=>({...f.oldMap,[f.paths.script]:c.repeat(40)}))}],
      ['missing current map',without(f.descriptor,'source_blobs')],
      ['empty history still needs current map',{...without(f.descriptor,'source_blobs'),previous_source_blobs:[]}],
      ['incomplete current map',{...f.descriptor,source_blobs:without(f.currentMap,f.paths.policy)}],
      ['incomplete previous map',{...f.descriptor,previous_source_blobs:[without(f.oldMap,f.paths.policy)]}],
      ['extra previous path',{...f.descriptor,previous_source_blobs:[{...f.oldMap,'scripts/ci/unreviewed.mjs':'a'.repeat(40)}]}],
      ['invalid current SHA',{...f.descriptor,source_blobs:{...f.currentMap,[f.paths.script]:'g'.repeat(40)}}],
      ['invalid previous SHA',{...f.descriptor,previous_source_blobs:[{...f.oldMap,[f.paths.script]:'A'.repeat(40)}]}],
      ['duplicate current despite key order',{...f.descriptor,previous_source_blobs:[reverse(f.currentMap)]}],
      ['duplicate history despite key order',{...f.descriptor,previous_source_blobs:[f.oldMap,reverse(f.oldMap)]}]
    ];
  for(const [label,d]of variants){
    let calls=0;const r=await f.collect({native:{status:'COMPLETE',population_packets:[]},selection:{...f.selection,natural_producers:[d]},
      request:async()=>{calls++;throw Error('INVALID_HISTORY_MUST_NOT_READ');}});
    assert.equal(r.status,'PARTIAL',label);assert.equal(r.entries.length,0,label);assert.equal(calls,0,label);
    assert.ok(r.gaps.some(g=>g.code==='NATURAL_PRODUCER_SELECTION_INVALID'),label);
  }
});

test('zero to four previous versions preserve exact descriptors and no-map legacy intake remains compatible',async()=>{
  const f=intakeVersionFixture(),oldNative={status:'COMPLETE',population_packets:[f.records[0].native]},currentNative={status:'COMPLETE',population_packets:[f.records[1].native]},
    history=[f.oldMap,...['0','1','2'].map(c=>({...f.oldMap,[f.paths.script]:c.repeat(40)}))],legacy={...f.oldDescriptor};delete legacy.source_blobs;
  for(const [d,native,expected]of [[{...f.currentDescriptor,previous_source_blobs:[]},currentNative,f.currentDescriptor],
    [{...f.currentDescriptor,previous_source_blobs:history},oldNative,f.oldDescriptor],[legacy,oldNative,legacy]]){
    const r=await f.collect({native,selection:{...f.selection,natural_producers:[d]}});
    assert.equal(r.status,'NATIVE_ORIGIN_BOUND',JSON.stringify(r.gaps));assert.equal(r.entries.length,1);assert.equal(r.entries[0].descriptor_digest,h(JSON.stringify(expected)));
    assert.equal(r.source_authenticated,false);assert.equal(r.official_metric,false);assert.equal(r.t0,null);
  }
});

test('same Natural Source snapshot still requires current runtime bytes even when a complete previous map is accepted for artifacts',()=>{
  const profiles='{"schema":"clued.gated-proof-profiles/2","workflows":{}}',
    roles='{"schema":"clued.gated-proof-role-specs/2","workflows":{}}',
    workflow='.github/workflows/clued-work-admission.yml',runtimePath='scripts/ci/clued-gated-proof-runtime.mjs',wf='b'.repeat(40),
    admission=Object.fromEntries(['script','workflow','reverify_workflow','policy'].flatMap(k=>[[k+'_path','source/'+k],[k+'_blob','a'.repeat(40)]])),
    currentMap={[workflow]:wf,[runtimePath]:'c'.repeat(40)},oldMap={[workflow]:wf,[runtimePath]:'d'.repeat(40)},
    cfg={admission_source:admission,execution_source:{profiles_sha256:h(profiles),role_specs_sha256:h(roles)},natural_producers:[{
      workflow_path:workflow,workflow_blob:wf,source_paths:[workflow,runtimePath],source_blobs:currentMap,previous_source_blobs:[oldMap]}]},
    selection={admission_source:admission,workflow_blobs:{[workflow]:wf}},runtime={proof_profiles_raw:profiles,role_specs_raw:roles},
    contract={profiles:JSON.parse(profiles),roles:JSON.parse(roles),profiles_sha256:h(profiles),role_specs_sha256:h(roles),
      source_tree:Object.fromEntries([...Object.entries(currentMap),...['script','workflow','reverify_workflow','policy'].map(k=>['source/'+k,'a'.repeat(40)])].map(([p,sha])=>[p,{sha,type:'blob',mode:'100644'}]))};
  assert.equal(C.sameNaturalSourceSnapshot(cfg,selection,runtime,contract),true);
  assert.equal(C.sameNaturalSourceSnapshot(cfg,selection,runtime,{...contract,source_tree:{...contract.source_tree,[runtimePath]:{sha:oldMap[runtimePath],type:'blob',mode:'100644'}}}),false);
});

const {registeredWorkflowSource:registeredHistoryAssemblySource}=await import('./clued-workflow-profile.mjs');
const {applicableCI:historyAssemblyApplicability}=await import('./clued-gated-proof.mjs');
const historyAssemblyAddedWorkflows=['.github/workflows/clued-handover-external-qualification.yml','.github/workflows/clued-handover-disposable-idle.yml'];
function historicalAssemblyFixture({oldSnapshot=null,currentTip=subject}={}){
  const frozen=loadHistoricalWorkflowProfiles69e(),f=fixture({executionSnapshot:frozen}),
    oldTip=oldSnapshot?.source_checkout_sha??'f'.repeat(40),oldRegistry=parseWorkflowProfiles(oldSnapshot?.proof_profiles_raw??f.runtime.proof_profiles_raw),
    oldRoles=JSON.parse(oldSnapshot?.role_specs_raw??f.runtime.role_specs_raw);
  assert.equal(Object.keys(oldRegistry.workflows).length,22);
  if(!oldSnapshot)for(const file of historyAssemblyAddedWorkflows){delete oldRegistry.workflows[file];delete oldRoles.workflows[file];}
  const currentDirectory=structuredClone(frozen.workflowDirectory),
    oldDirectory=oldSnapshot?.workflow_directory??currentDirectory.filter(row=>!historyAssemblyAddedWorkflows.includes(row.path)),
    snapshot={source_checkout_sha:oldTip,proof_profiles_raw:oldSnapshot?.proof_profiles_raw??JSON.stringify(oldRegistry),role_specs_raw:oldSnapshot?.role_specs_raw??JSON.stringify(oldRoles),workflow_directory:oldDirectory,
      main_history:{base_commit:oldTip,head_commit:currentTip,merge_base_commit:oldTip,status:'ahead'}},
    descriptor={source_checkout_sha:oldTip,profiles_sha256:h(snapshot.proof_profiles_raw),role_specs_sha256:h(snapshot.role_specs_raw)},
    blobs=new Map(oldDirectory.map(row=>[row.path,row.sha])),selected={workflows:Object.fromEntries(Object.keys(oldRegistry.workflows).map(file=>{
      const q=registeredHistoryAssemblySource(oldRegistry,file,blobs.get(file));assert.equal(q.passed,true);return [file,q.profile];}))},
    changedFiles=['scripts/ci/clued-handover-external-driver.mjs'],selection=historyAssemblyApplicability({workflows:new Map(Object.keys(oldRegistry.workflows).map(file=>[file,blobs.get(file)])),profiles:selected,
      changedFiles,commits:1,diffComplete:true,sourceQualified:true});
  assert.equal(selection.passed,true);const workflowFiles=[...selection.workflows.keys()].sort();assert.ok(workflowFiles.length);
  const contract=JSON.parse(f.runtime.source_contract_raw),expected=JSON.parse(contract.four_expected_sources_raw);
  expected.execution_source.source_checkout_sha=currentTip;
  expected.schema='clued.merge-admission-four-source-expectations/2';expected.previous_execution_sources=[descriptor];
  contract.four_expected_sources_raw=JSON.stringify(expected);f.runtime.source_contract_raw=JSON.stringify(contract);
  f.runtime.natural_selection={...f.runtime.natural_selection,execution_source_templates:[expected.execution_source,descriptor],
    current_execution_snapshot:{source_checkout_sha:currentTip,proof_profiles_raw:f.runtime.proof_profiles_raw,role_specs_raw:f.runtime.role_specs_raw,workflow_directory:currentDirectory,
      main_history:{base_commit:currentTip,head_commit:currentTip,merge_base_commit:currentTip,status:'identical'}}};
  const ciPackets=[];let jobId=10000;
  for(const [index,file]of workflowFiles.entries()){
    const run=String(1000+index),profile=selected.workflows[file],route=profile.routes.find(r=>r.self_hosted)??profile.routes[0],
      makeJob=(name,labels,steps)=>({id:String(++jobId),run_id:run,run_attempt:1,name,status:'completed',conclusion:'success',
        created_at:at(20),started_at:at(21),completed_at:at(28),labels,steps}),jobs=[];
    if(profile.gated)jobs.push(makeJob('admission-gate',['self-hosted'],[]));
    jobs.push(makeJob(route.name,route.self_hosted?['self-hosted']:['ubuntu-slim'],Object.entries(route.required_steps).flatMap(([name,count])=>
      Array.from({length:count},()=>({name,status:'completed',conclusion:'success'})))));
    ciPackets.push({run:{run_id:run,run_attempt:1,path:file,event:'pull_request',head_sha:head,status:'completed',conclusion:'success',
      created_at:at(10),run_started_at:at(20),updated_at:at(30),pull_requests:[727]},jobs});
  }
  const producer={run:{run_id:'900',run_attempt:1,path:'.github/workflows/clued-merge-slot-ci.yml',event:'workflow_run',head_sha:subject,status:'completed',conclusion:'success',
      created_at:at(0),run_started_at:at(1),updated_at:at(51),pull_requests:[]},jobs:[{id:'91000',run_id:'900',run_attempt:1,name:'clued-merge-slot-ci',status:'completed',conclusion:'success',
      created_at:at(1),started_at:at(1),completed_at:at(50),labels:['ubuntu-slim'],steps:[]}]};
  f.native.population_packets=[producer,...ciPackets];f.attemptRows=f.native.population_packets.map(n=>({run_id:n.run.run_id,attempt:1,
    pr_number:n===producer?null:727,head_sha:n.run.head_sha,kind:n===producer?'other':'ci',status:'completed',conclusion:'success',started_at:n.run.run_started_at,completed_at:null,
    terminal_interval:{lower_at:n===producer?at(50):at(28),upper_at:n.run.updated_at,basis:'native_job_completion_lower_and_terminal_update_upper_bounds'}}));
  const events=[],r=createNaturalRecorder({env:{GITHUB_REPOSITORY:repository,GITHUB_RUN_ID:'900',GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:'report',GITHUB_SHA:subject},
    sourcePath:'scripts/ci/clued-merge-slot-ci.mjs',write:e=>events.push(e),now:()=>at(35)}),
    pr={number:727,state:'open',draft:false,head:{sha:head},base:{sha:oldTip,ref:'main',repo:{full_name:repository,default_branch:'main'}}};
  r.record('round_ci_observation',{scope,pr,seen:{state:'green',execution:{scope:'workflow_execution',tip:oldTip,native_runs:ciPackets.map(n=>n.run),
    observation_context:{changed_files:changedFiles,commits:1,default_branch:'main',workflow_files:workflowFiles}}}});r.finish();
  assert.equal(events.length,1);events[0].source.executed_checkout_sha=subject;events[0].source.sha256=h(fs.readFileSync(path.join(repo,'scripts/ci/clued-merge-slot-ci.mjs')));
  f.natural.entries=[{run_key:'900:1',job_id:'report',checkout_sha:subject,artifact_digest:'sha256:'+'d'.repeat(64),
    native_origin:{head_branch:'main',event:'workflow_run'},packet_raw:JSON.stringify({events})}];f.natural.execution_snapshots={[oldTip]:snapshot};
  return {f,oldTip,snapshot,descriptor,workflowFiles,ciPackets,producer};
}
function historicalAssemblyRowsRemain(packet,prepared){
  assert.equal(packet.schema,'clued.merge-admission-four-source-observations/2');assert.deepEqual(packet.attempts,prepared.f.attemptRows);assert.equal(packet.rounds.length,1);
  const round=packet.rounds[0],witness=JSON.parse(prepared.f.natural.entries[0].packet_raw).events[0].payload;
  assert.equal(round.main_sha,witness.tip);assert.deepEqual(round.applicability.workflow_files,witness.applicability.workflow_files);
  assert.deepEqual(round.applicability.changed_files,witness.applicability.changed_files);assert.equal(round.applicability.commit_count,witness.applicability.commits);
  assert.deepEqual(round.run_keys,prepared.ciPackets.map(n=>n.run.run_id+':1').sort());assert.equal(round.execution_packets.length,prepared.ciPackets.length);
  for(const n of prepared.ciPackets){const x=round.execution_packets.find(x=>x.run_key===n.run.run_id+':1');assert.ok(x);
    assert.deepEqual(x.jobs,n.jobs.map(j=>({...j,id:Number(j.id)})));}
}

test('v2 actual 595 old22 replay preserves ac90 while current Source selects exact registered b8 FullRole; unknown and mixed pairs retain the full population',async()=>{
  const oldTip='59522b4158322e833ef152472a924c5fb40e0b24',currentTip='69e30b6bf1633e4637865b8c7f1ae0ff6cd746b8',
    sealed=loadSourceHistoryFixture(),
    file='.github/workflows/clued-handover-external-qualification.yml',current=fixture({executionSnapshot:loadHistoricalWorkflowProfiles69e()}),
    currentRegistry=parseWorkflowProfiles(current.runtime.proof_profiles_raw),
    currentRoles=JSON.parse(current.runtime.role_specs_raw),profilesRaw=sealed.historical_profiles,
    rolesRaw=sealed.historical_roles,oldRegistry=JSON.parse(profilesRaw),oldRoles=JSON.parse(rolesRaw),
    wrapper=oldRegistry.workflows[file],future=currentRegistry.workflows[file].accepted_sources;
  assert.equal(wrapper.workflow_blob,'ac90bc2f7e34a94be3c50c4581ba49cc139b3980');assert.equal(future.length,1);
  assert.equal(future[0].workflow_blob,'b8fee41077d854e906244b9fa2d374f058dbd4a3');assert.equal(wrapper.accepted_sources,undefined);
  assert.equal(oldRoles.workflows[file].sources[future[0].workflow_blob],undefined);
  // Later exact Source additions cannot reconstruct a historical snapshot by
  // deleting one entry from today's registry. Replay the sealed immutable tree
  // without needing remote access or historical objects in a shallow checkout.
  const directory=sealed.historical_workflow_tree.trim().split('\n').map(line=>{
    const m=/^(\d{6}) (blob) ([a-f0-9]{40})\t(.+)$/.exec(line);assert.ok(m);return {path:m[4],sha:m[3],type:m[2],mode:m[1]};});
  if(Object.hasOwn(process.env,'CLUED_NATURAL_FRAME_HISTORY_COMMIT')){
    assert.match(process.env.CLUED_NATURAL_FRAME_HISTORY_COMMIT,/^[a-f0-9]{40}$/);assert.equal(process.env.CLUED_NATURAL_FRAME_HISTORY_COMMIT,oldTip);
    const {execFileSync}=await import('node:child_process'),
      show=relative=>execFileSync('git',['show',oldTip+':'+relative],{cwd:repo,encoding:'utf8',windowsHide:true,maxBuffer:2097152});
    assert.equal(profilesRaw,show('scripts/ci/clued-gated-proof-profiles.json'));
    assert.equal(rolesRaw,show('scripts/ci/clued-gated-proof-role-specs.json'));
    assert.equal(sealed.historical_workflow_tree,execFileSync('git',['ls-tree','-r',oldTip,'--','.github/workflows'],{cwd:repo,encoding:'utf8',windowsHide:true}));
  }
  const cfg=JSON.parse(fs.readFileSync(path.join(repo,'scripts/ci/merge-admission-r9-source.json'),'utf8')),
    reviewed=cfg.previous_execution_sources.find(s=>s.source_checkout_sha===oldTip);assert.ok(reviewed);
  assert.equal(h(profilesRaw),reviewed.profiles_sha256);assert.equal(h(rolesRaw),reviewed.role_specs_sha256);
  // This replay's "current" side is the sealed predecessor (80bd559f), not today's registry execution_source.
  const sealedExecution=JSON.parse(loadPublisherSourceHistoryFixture()).execution_source;
  assert.equal(h(current.runtime.proof_profiles_raw),sealedExecution.profiles_sha256);assert.equal(h(current.runtime.role_specs_raw),sealedExecution.role_specs_sha256);
  const actualBlob=current.runtime.execution_workflow_blobs[file],selected=registeredHistoryAssemblySource(currentRegistry,file,actualBlob);
  assert.equal(selected.passed,true);assert.equal(actualBlob,future[0].workflow_blob);assert.equal(selected.profile.workflow_blob,actualBlob);
  const {rolesForSource,roleDefinitionDigest}=await import('./clued-workflow-profile.mjs'),roles=rolesForSource(currentRoles,file,actualBlob);
  assert.equal(roles.length,1);assert.equal(roles[0].job_id,'qualify');assert.equal(roles[0].definition_sha256,'fab079be15c3b25abe44ff6bcc2af3ff86161db853b0017ae92cb3f5ececb074');
  assert.equal(roleDefinitionDigest(roles[0].definition),roles[0].definition_sha256);
  assert.equal(roles[0].definition.env.QUALIFICATION_IDLE_RUN_ID,'${{ inputs.idle_run_id }}');
  assert.deepEqual(currentRoles.workflows[file].sources[wrapper.workflow_blob],oldRoles.workflows[file].sources[wrapper.workflow_blob]);
  assert.equal(directory.find(row=>row.path===file).sha,wrapper.workflow_blob);
  const make=()=>historicalAssemblyFixture({currentTip,oldSnapshot:{source_checkout_sha:oldTip,proof_profiles_raw:profilesRaw,role_specs_raw:rolesRaw,workflow_directory:directory}}),
    prepared=make(),before=JSON.stringify(prepared.f),built=assembleNaturalFourSourceFrame(prepared.f);
  assert.equal(built.status,'FOUR_SOURCE_FRAME_DATA_CANDIDATE',JSON.stringify(built.gaps));assert.equal(built.math.candidate_ready,true);
  const packet=JSON.parse(built.frame.packet_raw);historicalAssemblyRowsRemain(packet,prepared);assert.equal(Object.keys(packet.populations).length,8);
  assert.equal(packet.execution_sources.source_checkout_sha,currentTip);assert.equal(packet.execution_sources.entries.length,22);
  assert.equal(packet.execution_sources.entries.find(row=>row.workflow_file===file).workflow_blob,actualBlob);
  const old=packet.previous_execution_snapshots[0];assert.equal(old.source_checkout_sha,oldTip);assert.equal(old.execution_sources.entries.length,22);
  assert.equal(old.execution_sources.entries.find(row=>row.workflow_file===file).workflow_blob,wrapper.workflow_blob);
  assert.equal(packet.execution_configurations[old.configuration_key].proof_profiles_raw,profilesRaw);assert.equal(packet.execution_configurations[old.configuration_key].role_specs_raw,rolesRaw);
  assert.equal(packet.rounds[0].applicability.profile_sha256,reviewed.profiles_sha256);
  for(const x of packet.rounds[0].execution_packets)assert.equal(x.source_descriptor.role_source_sha256,reviewed.role_specs_sha256);
  const historicalExternal=packet.rounds[0].execution_packets.find(x=>x.workflow_file===file);
  assert.equal(historicalExternal.source_descriptor.workflow_blob,wrapper.workflow_blob);assert.equal(historicalExternal.source_descriptor.workflow_source_sha256,h(wrapper.source_yaml));
  for(const workflow of historyAssemblyAddedWorkflows)assert.ok(packet.rounds[0].execution_packets.some(x=>x.workflow_file===workflow));
  assert.equal(JSON.stringify(prepared.f),before);assert.equal(built.source_authenticated,false);assert.equal(built.official_metric,false);assert.equal(built.t0,null);
  for(const [label,change]of [['unknown pair',p=>{p.snapshot.proof_profiles_raw+='\n';}],['mixed roles',p=>{p.snapshot.role_specs_raw=p.f.runtime.role_specs_raw;}]]){
    const p=make();change(p);const original=JSON.stringify(p.f),r=assembleNaturalFourSourceFrame(p.f);assert.equal(r.status,'PARTIAL',label);assert.ok(r.gaps.length,label);
    historicalAssemblyRowsRemain(JSON.parse(r.partial_packet_raw),p);assert.equal(JSON.stringify(p.f),original,label);
    assert.equal(r.source_authenticated,false,label);assert.equal(r.official_metric,false,label);assert.equal(r.t0,null,label);
  }
});

test('v2 assembly binds old round witnesses and Native jobs to the historical 20-path snapshot while current remains 22',()=>{
  const prepared=historicalAssemblyFixture(),before=JSON.stringify(prepared.f),built=assembleNaturalFourSourceFrame(prepared.f);
  assert.equal(built.status,'FOUR_SOURCE_FRAME_DATA_CANDIDATE',JSON.stringify(built.gaps));assert.equal(built.math.candidate_ready,true);
  const packet=JSON.parse(built.frame.packet_raw);historicalAssemblyRowsRemain(packet,prepared);assert.equal(Object.keys(packet.populations).length,8);
  assert.equal(packet.execution_sources.source_checkout_sha,subject);assert.equal(packet.execution_sources.entries.length,22);assert.equal(packet.previous_execution_snapshots.length,1);
  const historical=packet.previous_execution_snapshots[0];assert.equal(historical.source_checkout_sha,prepared.oldTip);assert.equal(historical.execution_sources.entries.length,20);
  const historicalConfig=packet.execution_configurations[historical.configuration_key];
  assert.equal(historicalConfig.proof_profiles_raw,prepared.snapshot.proof_profiles_raw);assert.equal(historicalConfig.role_specs_raw,prepared.snapshot.role_specs_raw);
  const round=packet.rounds[0];assert.equal(round.applicability.source_checkout_sha,prepared.oldTip);assert.equal(round.applicability.profile_sha256,prepared.descriptor.profiles_sha256);
  for(const x of round.execution_packets){assert.equal(x.source_descriptor.source_checkout_sha,prepared.oldTip);assert.equal(x.source_descriptor.role_source_sha256,prepared.descriptor.role_specs_sha256);
    assert.equal(x.source_descriptor.workflow_blob,prepared.snapshot.workflow_directory.find(row=>row.path===x.workflow_file).sha);}
  for(const file of historyAssemblyAddedWorkflows)assert.equal(round.execution_packets.some(x=>x.workflow_file===file),false);
  assert.equal(JSON.stringify(prepared.f),before);assert.equal(built.source_authenticated,false);assert.equal(built.official_metric,false);assert.equal(built.t0,null);
});

test('v2 assembly retains full round and Native populations when historical snapshots or future-installation witnesses cannot qualify',()=>{
  for(const [label,change]of [
    ['missing snapshot',p=>{delete p.f.natural.execution_snapshots[p.oldTip];}],
    ['unknown snapshot',p=>{p.snapshot.source_checkout_sha='e'.repeat(40);}],
    ['mixed profiles',p=>{p.snapshot.proof_profiles_raw=p.f.runtime.proof_profiles_raw;}],
    ['mixed roles',p=>{p.snapshot.role_specs_raw=p.f.runtime.role_specs_raw;}],
    ['authority flag',p=>{p.snapshot.approved=true;}],
    ['duplicate directory',p=>{p.snapshot.workflow_directory.push({...p.snapshot.workflow_directory[0]});}],
    ['malformed directory',p=>{p.snapshot.workflow_directory[0]=null;}],
    ['shared budget gap',p=>{p.f.natural.status='PARTIAL';p.f.natural.gaps=[{code:'NATURAL_SHARED_REQUEST_STOPPED'}];}],
    ['unknown configuration reference',p=>{p.f.natural.execution_snapshots[p.oldTip]={source_checkout_sha:p.oldTip,configuration_key:'unknown',workflow_directory:p.snapshot.workflow_directory,main_history:p.snapshot.main_history};p.f.natural.execution_configurations={};}],
    ['mixed shared configuration',p=>{const key=p.descriptor.profiles_sha256+':'+p.descriptor.role_specs_sha256;
      p.f.natural.execution_snapshots[p.oldTip]={source_checkout_sha:p.oldTip,configuration_key:key,workflow_directory:p.snapshot.workflow_directory,main_history:p.snapshot.main_history};
      p.f.natural.execution_configurations={[key]:{proof_profiles_raw:p.snapshot.proof_profiles_raw,role_specs_raw:p.f.runtime.role_specs_raw}};}],
    ['mismatched reviewed hash',p=>{const contract=JSON.parse(p.f.runtime.source_contract_raw),expected=JSON.parse(contract.four_expected_sources_raw);
      expected.previous_execution_sources[0].profiles_sha256=h(p.snapshot.proof_profiles_raw+'\n');contract.four_expected_sources_raw=JSON.stringify(expected);p.f.runtime.source_contract_raw=JSON.stringify(contract);}],
    ['future workflows absent on old head',p=>{const entry=p.f.natural.entries[0],packet=JSON.parse(entry.packet_raw);
      packet.events[0].payload.applicability.workflow_files.push(...historyAssemblyAddedWorkflows);entry.packet_raw=JSON.stringify(packet);for(const file of historyAssemblyAddedWorkflows)assert.equal(p.snapshot.workflow_directory.some(row=>row.path===file),false);}]
  ]){
    const prepared=historicalAssemblyFixture();change(prepared);const before=JSON.stringify(prepared.f),built=assembleNaturalFourSourceFrame(prepared.f);
    assert.equal(built.status,'PARTIAL',label);assert.equal(built.frame,null,label);assert.ok(built.gaps.length,label);assert.ok(built.partial_packet_raw,label);
    const partial=JSON.parse(built.partial_packet_raw);historicalAssemblyRowsRemain(partial,prepared);assert.equal(Object.keys(partial.populations).length,8,label);
    assert.equal(JSON.stringify(prepared.f),before,label);assert.equal(built.source_authenticated,false,label);assert.equal(built.official_metric,false,label);assert.equal(built.t0,null,label);
  }
});

function executionIntakeFixture({tips=['f'.repeat(40)],includeCurrent=true,currentDiskBytes=false}={}){
  const history=historicalAssemblyFixture(),f=intakeVersionFixture();
  // The 22/20 replay is immutable historical data. The separate capacity
  // experiment uses today's actual disk bytes with an explicitly synthetic
  // directory of their registered Source templates; it grants no qualification
  // to the current checkout's potentially unregistered workflow files.
  const actualProfiles=currentDiskBytes?fs.readFileSync(path.join(repo,'scripts/ci/clued-gated-proof-profiles.json'),'utf8'):null;
  const current=currentDiskBytes?{proof_profiles_raw:actualProfiles,
    role_specs_raw:fs.readFileSync(path.join(repo,'scripts/ci/clued-gated-proof-role-specs.json'),'utf8'),
    workflow_directory:Object.entries(parseWorkflowProfiles(actualProfiles).workflows).map(([path,profile])=>
      ({path,sha:profile.workflow_blob,type:'blob',mode:'100644'}))}:history.f.runtime.natural_selection.current_execution_snapshot,
    currentSnapshot={...current,source_checkout_sha:head,main_history:{base_commit:head,head_commit:head,merge_base_commit:head,status:'identical'}},
    snapshots=new Map(tips.map(tip=>[tip,{...structuredClone(history.snapshot),source_checkout_sha:tip,
      main_history:{base_commit:tip,head_commit:head,merge_base_commit:tip,status:'ahead'}}]));
  f.selection.execution_source_templates=[{source_checkout_sha:head,profiles_sha256:h(current.proof_profiles_raw),role_specs_sha256:h(current.role_specs_raw)},history.descriptor];
  f.selection.current_execution_snapshot=currentSnapshot;
  const events=[],r=createNaturalRecorder({env:{GITHUB_REPOSITORY:repository,GITHUB_RUN_ID:'42',GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:'admission',GITHUB_SHA:base},
    sourcePath:f.paths.script,write:e=>events.push(e),now:()=>at(2)});
  for(const tip of [...tips,...(includeCurrent?[head]:[])]){
    const pr={number:727,state:'open',draft:false,head:{sha:head},base:{sha:tip,ref:'main',repo:{full_name:repository}}};
    r.record('round_ci_observation',{scope,pr,seen:{state:'green',execution:{scope:'workflow_execution',tip,native_runs:history.ciPackets.map(n=>n.run),
      observation_context:{changed_files:['scripts/ci/clued-handover-external-driver.mjs'],commits:1,default_branch:'main',workflow_files:history.workflowFiles}}}});
  }
  const session={...r.finish(),executed_checkout_sha:base,source_sha256:h(f.oldTexts[f.paths.script])},packet=JSON.parse(f.records[0].bytes);
  for(const event of events){event.source.executed_checkout_sha=base;event.source.sha256=session.source_sha256;}
  packet.events=events;packet.sessions=[session];f.records[0].bytes=Buffer.from(JSON.stringify(packet));f.records[0].artifact.digest='sha256:'+h(f.records[0].bytes);
  const responses=new Map();
  for(const [tip,snapshot]of snapshots){
    for(const [file,text]of [['scripts/ci/clued-gated-proof-profiles.json',snapshot.proof_profiles_raw],['scripts/ci/clued-gated-proof-role-specs.json',snapshot.role_specs_raw]])
      responses.set(`/repos/${repository}/contents/${file}?ref=${tip}`,{ok:true,body:{type:'file',path:file,encoding:'base64',sha:blob(text),content:Buffer.from(text).toString('base64')}});
    responses.set(`/repos/${repository}/compare/${tip}...${head}`,{ok:true,body:{status:'ahead',merge_base_commit:{sha:tip}}});
    responses.set(`/repos/${repository}/git/trees/${tip}?recursive=1`,{ok:true,body:{truncated:false,tree:[...snapshot.workflow_directory,
      ...[['scripts/ci/clued-gated-proof-profiles.json',snapshot.proof_profiles_raw],['scripts/ci/clued-gated-proof-role-specs.json',snapshot.role_specs_raw]]
        .map(([path,text])=>({path,sha:blob(text),type:'blob',mode:'100644'}))]}});
  }
  const request=async(route,options)=>{if(responses.has(route)){f.routes.push(route);return responses.get(route);}return f.request(route,options);},
    collect=overrides=>f.collect({request,...overrides});
  return {...f,tips,history,snapshots,currentSnapshot,responses,request,collect};
}
test('v2 intake proves every actual tip and reuses the current Source tree, allowing five historical tips in one reviewed configuration',async()=>{
  const tips=['f','c','d','e','9'].map(c=>c.repeat(40)),f=executionIntakeFixture({tips}),before=JSON.stringify(f.selection),r=await f.collect();
  assert.equal(r.status,'NATIVE_ORIGIN_BOUND',JSON.stringify(r.gaps));assert.equal(r.entries.length,2);assert.equal(Object.keys(r.execution_snapshots).length,6);
  assert.equal(f.selection.execution_source_templates.length,2);assert.equal(JSON.stringify(f.selection),before);
  for(const tip of tips){const snapshot=r.execution_snapshots[tip],{configuration_key,...rest}=snapshot;assert.deepEqual({...rest,...r.execution_configurations[configuration_key]},f.snapshots.get(tip));
    const routes=f.routes.filter(route=>route.includes(tip));assert.equal(routes.length,4);assert.ok(routes.some(route=>route.includes('/git/trees/')));
    assert.equal(routes.filter(route=>route.includes('/contents/')).length,2);assert.equal(routes.filter(route=>route.includes('/compare/')).length,1);}
  const {configuration_key:currentKey,...currentRest}=r.execution_snapshots[head];assert.deepEqual({...currentRest,...r.execution_configurations[currentKey]},f.currentSnapshot);
  assert.equal(f.routes.some(route=>route===`/repos/${repository}/git/trees/${head}?recursive=1`),false);
  assert.deepEqual(JSON.parse(r.entries[0].packet_raw).events,JSON.parse(f.records[0].bytes).events);
  let reads=0;const saved=JSON.stringify(r.entries),cached=await f.collect({authenticatedEntries:r.entries,authenticatedSourceBytes:r.source_bytes,
    authenticatedExecutionSnapshots:r.execution_snapshots,authenticatedExecutionConfigurations:r.execution_configurations,
    request:async()=>{reads++;throw Error('QUALIFIED_SNAPSHOT_CACHE_MUST_NOT_REREAD');}});
  assert.equal(cached.status,'NATIVE_ORIGIN_BOUND',JSON.stringify(cached.gaps));assert.equal(reads,0);assert.equal(JSON.stringify(r.entries),saved);
  assert.deepEqual(cached.execution_snapshots,r.execution_snapshots);assert.equal(cached.source_authenticated,false);assert.equal(cached.official_metric,false);assert.equal(cached.t0,null);
});
test('v2 intake rechecks cached snapshot ancestry when main moves without rereading immutable profiles roles or directory bytes',async()=>{
  const f=executionIntakeFixture({includeCurrent:false}),first=await f.collect();assert.equal(first.status,'NATIVE_ORIGIN_BOUND',JSON.stringify(first.gaps));
  const next='8'.repeat(40),routes=[],input=JSON.stringify(first.entries),selection={...f.selection,head_sha:next},request=async route=>{
    routes.push(route);assert.equal(route,`/repos/${repository}/compare/${head}...${next}`);return {ok:true,body:{status:'ahead',merge_base_commit:{sha:head}}};};
  const r=await f.collect({selection,authenticatedEntries:first.entries,authenticatedSourceBytes:first.source_bytes,
    authenticatedExecutionSnapshots:first.execution_snapshots,authenticatedExecutionConfigurations:first.execution_configurations,request});
  assert.equal(r.status,'NATIVE_ORIGIN_BOUND',JSON.stringify(r.gaps));assert.equal(routes.length,1);assert.equal(JSON.stringify(first.entries),input);
  assert.deepEqual(r.execution_snapshots[f.tips[0]].main_history,{base_commit:f.tips[0],head_commit:next,merge_base_commit:f.tips[0],status:'ahead'});
  const stopped=await f.collect({selection,authenticatedEntries:first.entries,authenticatedSourceBytes:first.source_bytes,
    authenticatedExecutionSnapshots:first.execution_snapshots,authenticatedExecutionConfigurations:first.execution_configurations,
    request:async()=>({ok:true,body:{status:'diverged',merge_base_commit:{sha:base}}})});
  assert.equal(stopped.status,'PARTIAL');assert.equal(stopped.entries.length,2);assert.deepEqual(stopped.execution_snapshots,{});
  assert.ok(stopped.gaps.some(g=>g.code==='NATURAL_EXECUTION_SOURCE_MAIN_HISTORY_UNPROVEN'));assert.equal(stopped.t0,null);
});
test('v2 intake rejects unknown mixed or unbound historical bytes and unsafe cached claims while retaining original artifact entries and witnesses',async()=>{
  for(const [label,change,reason]of [
    ['mixed roles',f=>{const route=`/repos/${repository}/contents/scripts/ci/clued-gated-proof-role-specs.json?ref=${f.tips[0]}`,text=f.currentSnapshot.role_specs_raw;
      f.responses.set(route,{ok:true,body:{type:'file',path:'scripts/ci/clued-gated-proof-role-specs.json',encoding:'base64',sha:blob(text),content:Buffer.from(text).toString('base64')}});},'NATURAL_EXECUTION_SOURCE_BYTES_NOT_REVIEWED'],
    ['unknown pair',f=>{const route=`/repos/${repository}/contents/scripts/ci/clued-gated-proof-profiles.json?ref=${f.tips[0]}`,text=f.snapshots.get(f.tips[0]).proof_profiles_raw+'\n';
      f.responses.set(route,{ok:true,body:{type:'file',path:'scripts/ci/clued-gated-proof-profiles.json',encoding:'base64',sha:blob(text),content:Buffer.from(text).toString('base64')}});},'NATURAL_EXECUTION_SOURCE_BYTES_NOT_REVIEWED'],
    ['truncated tree',f=>{f.responses.get(`/repos/${repository}/git/trees/${f.tips[0]}?recursive=1`).body.truncated=true;},'NATURAL_EXECUTION_SOURCE_DIRECTORY_INCOMPLETE'],
    ['duplicate tree',f=>{const tree=f.responses.get(`/repos/${repository}/git/trees/${f.tips[0]}?recursive=1`).body.tree;tree.push({...tree[0]});},'NATURAL_EXECUTION_SOURCE_DIRECTORY_INCOMPLETE'],
    ['tree disagrees with contents',f=>{f.responses.get(`/repos/${repository}/git/trees/${f.tips[0]}?recursive=1`).body.tree.find(x=>x.path==='scripts/ci/clued-gated-proof-profiles.json').sha='0'.repeat(40);},'NATURAL_EXECUTION_SOURCE_TREE_BYTES_MISMATCH'],
    ['missing active workflow',f=>{const body=f.responses.get(`/repos/${repository}/git/trees/${f.tips[0]}?recursive=1`).body;body.tree=body.tree.filter(x=>x.path!==f.history.workflowFiles[0]);},'NATURAL_EXECUTION_SOURCE_SNAPSHOT_INVALID'],
    ['wrong ancestry',f=>{f.responses.get(`/repos/${repository}/compare/${f.tips[0]}...${head}`).body.merge_base_commit.sha=base;},'NATURAL_EXECUTION_SOURCE_MAIN_HISTORY_UNPROVEN']
  ]){const f=executionIntakeFixture({includeCurrent:false});change(f);const raw=f.records[0].bytes.toString(),r=await f.collect();
    assert.equal(r.status,'PARTIAL',label);assert.equal(r.entries.length,2,label);assert.equal(r.entries[0].packet_raw,raw,label);assert.deepEqual(r.execution_snapshots,{},label);
    assert.ok(r.gaps.some(g=>g.code===reason),label);assert.equal(r.source_authenticated,false,label);assert.equal(r.official_metric,false,label);assert.equal(r.t0,null,label);}
  for(const bad of [snapshot=>{snapshot.approved=true;},snapshot=>{snapshot.main_history.status='identical';},snapshot=>{snapshot.workflow_directory.push({...snapshot.workflow_directory[0]});}]){
    const f=executionIntakeFixture({includeCurrent:false}),first=await f.collect();assert.equal(first.status,'NATIVE_ORIGIN_BOUND');
    const entries=structuredClone(first.entries),{configuration_key,...rest}=first.execution_snapshots[f.tips[0]];
    entries[0].execution_snapshots={[f.tips[0]]:{...structuredClone(rest),...structuredClone(first.execution_configurations[configuration_key])}};
    bad(entries[0].execution_snapshots[f.tips[0]]);let reads=0;
    const r=await f.collect({authenticatedEntries:entries,authenticatedSourceBytes:first.source_bytes,request:async()=>{reads++;return {ok:false};}});
    assert.equal(r.status,'PARTIAL');assert.equal(reads,1);assert.equal(r.entries.length,2);assert.deepEqual(r.execution_snapshots,{});
    assert.ok(r.gaps.some(g=>g.code==='NATURAL_SHARED_REQUEST_STOPPED'));assert.equal(r.t0,null);
  }
});
test('v2 intake stops snapshot reads at the existing shared budget and retains every already proved snapshot and original artifact population',async()=>{
  const tips=['f','c','d'].map(c=>c.repeat(40)),f=executionIntakeFixture({tips,includeCurrent:false}),first=await f.collect();assert.equal(first.status,'NATIVE_ORIGIN_BOUND');
  const entries=first.entries.map(({execution_snapshots,...entry})=>entry),routes=[],stop=`/repos/${repository}/contents/scripts/ci/clued-gated-proof-profiles.json?ref=${tips[1]}`;
  const r=await f.collect({authenticatedEntries:entries,authenticatedSourceBytes:first.source_bytes,request:async(route,options)=>{
    routes.push(route);if(route===stop)return {ok:false};assert.equal(routes.includes(stop),false,'a stopped slice cannot start another read');return f.request(route,options);}});
  assert.equal(r.status,'PARTIAL');assert.equal(r.entries.length,2);assert.deepEqual(Object.keys(r.execution_snapshots),[tips[0]]);assert.equal(routes.length,5);
  assert.equal(routes.at(-1),stop);assert.ok(r.gaps.some(g=>g.code==='NATURAL_SHARED_REQUEST_STOPPED'&&g.source_checkout_sha===tips[1]));
  assert.equal(r.entries[0].packet_raw,first.entries[0].packet_raw);assert.equal(r.entries[1].packet_raw,first.entries[1].packet_raw);
  assert.deepEqual(r.artifact_population,{before:[],after:[]});assert.equal(r.source_authenticated,false);assert.equal(r.official_metric,false);assert.equal(r.t0,null);
});

test('67 authenticated entries or actual tips share actual profile and role bytes once and seal below the unchanged limit with zero restore reads',async()=>{
  for(const differentTips of [false,true]){
    const f=executionIntakeFixture({tips:[],includeCurrent:true,currentDiskBytes:true}),key=h(f.currentSnapshot.proof_profiles_raw)+':'+h(f.currentSnapshot.role_specs_raw),
      cfg={proof_profiles_raw:f.currentSnapshot.proof_profiles_raw,role_specs_raw:f.currentSnapshot.role_specs_raw},entries=[],packets=[],snapshots={};
    assert.equal(Buffer.byteLength(cfg.proof_profiles_raw),fs.statSync(path.join(repo,'scripts/ci/clued-gated-proof-profiles.json')).size);
    assert.equal(Buffer.byteLength(cfg.role_specs_raw),fs.statSync(path.join(repo,'scripts/ci/clued-gated-proof-role-specs.json')).size);
    for(let i=0;i<67;i++){
      const run=String(100000+i),tip=differentTips?'c'+i.toString(16).padStart(39,'0'):head,n=structuredClone(f.records[0].native);
      n.run.run_id=run;n.jobs[0].id=String(200000+i);const packet=JSON.parse(f.records[0].bytes);
      packet.identity.run_id=run;for(const event of packet.events){event.run_id=run;event.record_id='10000000-0000-4000-8000-'+String(i+1).padStart(12,'0');
        event.producer_session_id='20000000-0000-4000-8000-'+String(i+1).padStart(12,'0');event.payload.tip=tip;event.payload.base_sha=tip;
        if(differentTips)for(const [j,ref]of event.payload.native_runs.entries())ref.run_id=String(400000+i*10+j);}
      for(const session of packet.sessions){session.run_id=run;session.producer_session_id=packet.events[0].producer_session_id;}const raw=JSON.stringify(packet);
      entries.push({run_key:run+':1',job_id:f.descriptor.job_id,checkout_sha:base,descriptor_digest:h(JSON.stringify(f.oldDescriptor)),
        native_run_digest:h(JSON.stringify(n.run)),native_jobs_digest:h(JSON.stringify(n.jobs)),artifact_id:String(300000+i),artifact_digest:'sha256:'+h(raw),packet_raw:raw,
        execution_snapshot_tips:[tip],origin_basis:'NATIVE_ARTIFACT_DIGEST_JOB_MAIN_HISTORY_EXACT_REVIEWED_SOURCE'});
      packets.push(n);snapshots[tip]={source_checkout_sha:tip,configuration_key:key,workflow_directory:f.currentSnapshot.workflow_directory,
        main_history:{base_commit:tip,head_commit:head,merge_base_commit:tip,status:tip===head?'identical':'ahead'}};
    }
    const sources={[base]:{texts:Object.fromEntries(Object.entries(f.paths).map(([k,p])=>[k,f.oldTexts[p]])),
      ...Object.fromEntries(Object.entries(f.paths).map(([k,p])=>[k+'_blob',f.oldMap[p]]))}},native={status:'COMPLETE',population_packets:packets};let reads=0;
    const collect=overrides=>f.collect({native,authenticatedEntries:entries,authenticatedSourceBytes:sources,authenticatedExecutionSnapshots:snapshots,
      authenticatedExecutionConfigurations:{[key]:cfg},request:async()=>{reads++;throw Error('AUTHENTICATED_SNAPSHOT_RESTORE_MUST_NOT_READ');},...overrides});
    const result=await collect();assert.equal(result.status,'NATIVE_ORIGIN_BOUND',JSON.stringify(result.gaps));assert.equal(reads,0);assert.equal(result.entries.length,67);
    assert.equal(Object.keys(result.execution_snapshots).length,differentTips?67:1);assert.deepEqual(Object.keys(result.execution_configurations),[key]);
    for(const entry of result.entries){assert.equal(Object.hasOwn(entry,'execution_snapshots'),false);assert.equal(entry.execution_snapshot_tips.length,1);}
    const seal=naturalInputs=>C.sealR9Packet({repository,publisher:{run_id:'42',run_attempt:1,head_sha:head,workflow_path:C.R9_PUBLISHER_PATH,job_id:'report'},
      sourceBlobs:Object.fromEntries(C.R9_SOURCE_PATHS.map(p=>[p,'b'.repeat(40)])),window,sealedAt:closed,nativeStoreRaw:emptyNativePopulationStore(repository),naturalInputs});
    const sealed=seal(result);assert.ok(Buffer.byteLength(sealed)<32*1024*1024);const restored=JSON.parse(sealed).natural_inputs;
    const again=await collect({authenticatedEntries:restored.entries,authenticatedSourceBytes:restored.source_bytes,
      authenticatedExecutionSnapshots:restored.execution_snapshots,authenticatedExecutionConfigurations:restored.execution_configurations});
    assert.equal(again.status,'NATIVE_ORIGIN_BOUND',JSON.stringify(again.gaps));assert.equal(reads,0);assert.equal(again.entries.length,67);
    assert.deepEqual(again.execution_snapshots,result.execution_snapshots);assert.deepEqual(again.execution_configurations,result.execution_configurations);
    const inline=Object.fromEntries(Object.entries(snapshots).map(([tip,{configuration_key,...rest}])=>[tip,{...rest,...cfg}]));
    const old={...result,entries:entries.map(entry=>({...entry,execution_snapshots:{[entry.execution_snapshot_tips[0]]:inline[entry.execution_snapshot_tips[0]]}})),execution_snapshots:inline};
    delete old.execution_configurations;assert.throws(()=>seal(old),/raw data limit/,'the real 67-copy defect is still rejected by the original limit');
    assert.equal(result.source_authenticated,false);assert.equal(result.official_metric,false);assert.equal(result.t0,null);
    console.log(JSON.stringify({size_regression:differentTips?'67_actual_tips':'67_same_tip_entries',entries:67,snapshots:Object.keys(result.execution_snapshots).length,
      actual_configuration_raw_bytes:Buffer.byteLength(cfg.proof_profiles_raw)+Buffer.byteLength(cfg.role_specs_raw),sealed_bytes:Buffer.byteLength(sealed),restore_http_reads:reads,limit_bytes:32*1024*1024}));
  }
});
test('authenticated legacy inline snapshots are read once and normalized to configuration and tip references without changing entries or issuing HTTP',async()=>{
  const f=executionIntakeFixture({tips:['c'.repeat(40)],includeCurrent:false}),first=await f.collect();assert.equal(first.status,'NATIVE_ORIGIN_BOUND');
  const entries=structuredClone(first.entries),{configuration_key,...rest}=first.execution_snapshots[f.tips[0]],inline={...rest,...first.execution_configurations[configuration_key]};
  entries[0].execution_snapshots={[f.tips[0]]:inline};const before=JSON.stringify(entries);let reads=0;
  const normalized=await f.collect({authenticatedEntries:entries,authenticatedSourceBytes:first.source_bytes,
    request:async()=>{reads++;throw Error('LEGACY_INLINE_CACHE_MUST_NOT_READ');}});
  assert.equal(normalized.status,'NATIVE_ORIGIN_BOUND',JSON.stringify(normalized.gaps));assert.equal(reads,0);assert.equal(JSON.stringify(entries),before);
  assert.equal(Object.hasOwn(normalized.entries[0],'execution_snapshots'),false);assert.deepEqual(normalized.entries[0].execution_snapshot_tips,[f.tips[0]]);
  assert.equal(normalized.entries.length,first.entries.length);assert.deepEqual(normalized.execution_snapshots,first.execution_snapshots);
  assert.deepEqual(normalized.execution_configurations,first.execution_configurations);assert.equal(normalized.entries[0].packet_raw,entries[0].packet_raw);
});
test('unknown shared references mixed raw pairs and changed historical directory bytes cannot reuse authenticated snapshots or erase original entries',async()=>{
  for(const change of [(snapshots,configs,tip)=>{snapshots[tip].configuration_key='unknown';},
    (snapshots,configs,tip,f)=>{configs[snapshots[tip].configuration_key].role_specs_raw=f.currentSnapshot.role_specs_raw;},
    (snapshots,configs,tip,f)=>{snapshots[tip].workflow_directory.find(row=>row.path===f.history.workflowFiles[0]).sha='e'.repeat(40);}]){
    const f=executionIntakeFixture({tips:['c'.repeat(40)],includeCurrent:false}),first=await f.collect();assert.equal(first.status,'NATIVE_ORIGIN_BOUND');
    const snapshots=structuredClone(first.execution_snapshots),configs=structuredClone(first.execution_configurations);change(snapshots,configs,f.tips[0],f);let reads=0;
    const r=await f.collect({authenticatedEntries:first.entries,authenticatedSourceBytes:first.source_bytes,authenticatedExecutionSnapshots:snapshots,authenticatedExecutionConfigurations:configs,
      request:async()=>{reads++;return {ok:false};}});
    assert.equal(r.status,'PARTIAL');assert.equal(reads,1);assert.equal(r.entries.length,first.entries.length);assert.deepEqual(r.execution_snapshots,{});
    assert.ok(r.gaps.some(g=>g.code==='NATURAL_SHARED_REQUEST_STOPPED'));assert.equal(r.entries[0].packet_raw,first.entries[0].packet_raw);assert.equal(r.t0,null);
  }
});
