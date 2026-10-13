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
const {collectNaturalSourceArtifacts}=await import('./merge-admission-natural-intake.mjs');
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

function intakeVersionFixture(){
  const paths={script:'scripts/ci/clued-work-admission.mjs',workflow:'.github/workflows/clued-work-admission.yml',
    reverify_workflow:'.github/workflows/clued-work-admission-reverify.yml',policy:'config/merge-admission-policy.json'},sourcePaths=Object.values(paths),
    oldTexts={[paths.script]:'// reviewed old script\n',[paths.workflow]:'name: reviewed producer\n',[paths.reverify_workflow]:'name: reviewed reverify\n',[paths.policy]:'{"version":"old"}\n'},
    currentTexts={...oldTexts,[paths.script]:'// reviewed current script\n',[paths.policy]:'{"version":"current"}\n'},
    pins=texts=>Object.fromEntries(sourcePaths.map(p=>[p,blob(texts[p])])),oldMap=pins(oldTexts),currentMap=pins(currentTexts),
    currentDescriptor={registration_status:'registered',workflow_path:paths.workflow,workflow_blob:currentMap[paths.workflow],job_id:'admission',
      job_name:'source-job',source_paths:sourcePaths,source_blobs:currentMap,required_steps:['Export','Upload']},
    oldDescriptor={...currentDescriptor,source_blobs:oldMap},descriptor={...currentDescriptor,previous_source_blobs:[oldMap]},
    textsByCommit={[base]:oldTexts,[head]:currentTexts},records=[];
  for(const [run,artifactId,commit]of [['42','9',base],['44','11',head]]){
    const r=createNaturalRecorder({env:{GITHUB_REPOSITORY:repository,GITHUB_RUN_ID:run,GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:'admission'},
      sourcePath:paths.script,write:()=>{},now:()=>at(1)}),session={...r.finish(),executed_checkout_sha:commit},
      bytes=Buffer.from(JSON.stringify({schema:'clued.merge-admission-natural-artifact/1',identity:{repository,run_id:run,attempt:1,logical_job_key:'admission'},
        events:[],sessions:[session],files:[],local_stream:{status:'CLOSED_LOCAL_STREAM',known_gaps:[]}})),
      artifact={id:artifactId,name:`clued-r9-natural-source-${run}-1-admission`,expired:false,digest:'sha256:'+h(bytes),workflow_run:{id:run,head_sha:commit}},
      native={run:{run_id:run,run_attempt:1,status:'completed',conclusion:'success',head_sha:commit,path:paths.workflow,event:'push'},
        jobs:[{id:String(Number(run)+1),name:'source-job',status:'completed',conclusion:'success',steps:['Export','Upload'].map(name=>({name,status:'completed',conclusion:'success'}))}]};
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
  return {paths,sourcePaths,oldMap,currentMap,oldDescriptor,currentDescriptor,descriptor,oldTexts,currentTexts,textsByCommit,records,native,selection,routes,collect};
}

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
  const profiles='{"workflows":{}}',roles='{"roles":[]}',workflow='.github/workflows/clued-work-admission.yml',runtimePath='scripts/ci/clued-gated-proof-runtime.mjs',wf='b'.repeat(40),
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
