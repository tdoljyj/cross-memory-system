// No live API/usage: actual helper modules with deterministic Native wire data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {registerHooks} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
const here=path.dirname(fileURLToPath(import.meta.url));
const dependencies=process.env.CLUED_R9_TEST_DEPENDENCY_ROOT;
const repo=process.env.CLUED_R9_TEST_REPO_ROOT??(dependencies?path.join(dependencies,'capabilities-repo'):path.resolve(here,'../..'));
const overrides={
  'merge-admission-native-population.mjs':path.join(here,'merge-admission-native-population.mjs'),
  'merge-admission-four-sources.mjs':path.join(here,'merge-admission-four-sources.mjs'),
};
registerHooks({resolve(specifier,context,next){
  if(specifier.startsWith('./')&&context.parentURL?.startsWith(pathToFileURL(here).href)){
    const local=path.join(here,specifier),actual=path.join(repo,'scripts/ci',specifier);
    if(!fs.existsSync(local)&&fs.existsSync(actual))return {url:pathToFileURL(actual).href,shortCircuit:true};
  }
  return next(specifier,context);
}});
const C=await import('./merge-admission-r9-collector.mjs');
const U=await import('./ci-usage-report.mjs');
const N=await import(pathToFileURL(overrides['merge-admission-native-population.mjs']).href);
const F=await import(pathToFileURL(overrides['merge-admission-four-sources.mjs']).href);
const {workflowBlob}=await import(pathToFileURL(path.join(repo,'scripts/ci/clued-workflow-profile.mjs')).href);
const repository='tdoljyj/cross-memory-system',head='a'.repeat(40),window={start:'2026-10-10T00:00:00.000Z',end:'2026-10-11T00:00:00.000Z'};
const digest=x=>createHash('sha256').update(x).digest('hex');
const scope={project_id:'0597aa60-9b98-4da6-a4ab-63d7705b632f',queue_ref:'merge:tdoljyj/cross-memory-system:main'};
const run=(id=42,extra={})=>({id,run_attempt:1,workflow_id:7,path:C.R9_PUBLISHER_PATH,event:'schedule',head_sha:head,
  status:'completed',conclusion:'success',created_at:'2026-10-10T10:00:00Z',run_started_at:'2026-10-10T10:00:01Z',updated_at:'2026-10-10T10:10:00Z',
  pull_requests:[],head_branch:'main',head_repository:{full_name:repository},...extra});
const job=(id=42,extra={})=>({id:id+100,run_id:id,run_attempt:1,name:'clued-ci-usage-report',status:'completed',conclusion:'success',
  created_at:'2026-10-10T10:00:01Z',started_at:'2026-10-10T10:00:02Z',completed_at:'2026-10-10T10:09:00Z',labels:['ubuntu-latest'],
  steps:[{number:1,name:'Measure CI usage',status:'completed',conclusion:'success',started_at:'2026-10-10T10:00:02Z',completed_at:'2026-10-10T10:09:00Z'}],...extra});
const content=Object.fromEntries(C.R9_SOURCE_PATHS.map(file=>[file,'// reviewed fixture '+file+'\n']));
const blobs=Object.fromEntries(Object.entries(content).map(([f,t])=>[f,workflowBlob(t)]));
function contract(registered=true){
  const profile={registration_status:'registered',workflow_blob:blobs[C.R9_PUBLISHER_PATH],source_sha256:digest(content[C.R9_PUBLISHER_PATH]),
    source_yaml:content[C.R9_PUBLISHER_PATH],primary_ids:['report'],gated:false,pull_request:null,
    routes:[{job_id:'report',name:'clued-ci-usage-report',self_hosted:false,required_steps:{'Measure CI usage':1},command_digests:{'Measure CI usage':['b'.repeat(64)]}}]};
  return {repository,repository_id:'1',default_branch:'main',head_sha:head,
    profiles:{schema:'clued.gated-proof-profiles/2',workflows:registered?{[C.R9_PUBLISHER_PATH]:profile}:{}},
    roles:{schema:'clued.gated-proof-role-specs/2',workflows:{[C.R9_PUBLISHER_PATH]:{sources:{[blobs[C.R9_PUBLISHER_PATH]]:[{job_id:'report',definition_sha256:'c'.repeat(64)}]}}}}};
}
const packet=extra=>C.sealR9Packet({repository,publisher:{run_id:'42',run_attempt:1,head_sha:head,workflow_path:C.R9_PUBLISHER_PATH,job_id:'report'},
  sourceBlobs:blobs,window,sealedAt:'2026-10-11T00:01:00.000Z',nativeStoreRaw:N.emptyNativePopulationStore(),...extra});
function zip(raw,name=C.R9_PACKET_FILE){
  const b=Buffer.from(raw),n=Buffer.from(name),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);local.writeUInt32LE(b.length,18);local.writeUInt32LE(b.length,22);local.writeUInt16LE(n.length,26);
  central.writeUInt32LE(0x02014b50);central.writeUInt32LE(b.length,20);central.writeUInt32LE(b.length,24);central.writeUInt16LE(n.length,28);
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+n.length,12);end.writeUInt32LE(local.length+n.length+b.length,16);
  return Buffer.concat([local,n,b,central,n,end]);
}
function nativeRequest({runs=[run()],jobs=[job()],artifact=zip(packet()),mutation=()=>null,sourceContract=contract()}={}){
  const routes=[];
  const request=async(route,opts={})=>{
    routes.push(route);const changed=mutation(route,opts,routes.length);if(changed)return changed;
    if(route===`/repos/${repository}`)return {ok:true,body:{full_name:repository,id:1,default_branch:'main',created_at:'2026-01-01T00:00:00Z'}};
    if(route===`/repos/${repository}/branches/main`)return {ok:true,body:{name:'main',commit:{sha:head}}};
    if(route.includes('/git/trees/'))return {ok:true,body:{truncated:false,tree:Object.entries(content).map(([path,text])=>({path,sha:workflowBlob(text),type:'blob',mode:'100644'}))}};
    if(route.includes('/contents/')){
      const file=route.split('/contents/')[1].split('?')[0];let text=content[file];
      if(file.endsWith('clued-gated-proof-profiles.json'))text=JSON.stringify(sourceContract.profiles);
      if(file.endsWith('clued-gated-proof-role-specs.json'))text=JSON.stringify(sourceContract.roles);
      if(text===undefined)throw Error('UNKNOWN_FIXTURE_SOURCE');
      return {ok:true,body:{type:'file',path:file,encoding:'base64',sha:workflowBlob(text),content:Buffer.from(text).toString('base64')}};
    }
    if(route.endsWith('/actions/artifacts/9'))return {ok:true,body:{id:9,name:C.R9_ARTIFACT_NAME,expired:false,digest:'sha256:'+digest(artifact),workflow_run:{id:42,head_sha:head,head_branch:'main'}}};
    if(route.endsWith('/actions/artifacts/9/zip'))return {ok:true,body:artifact};
    if(route.includes('/actions/artifacts?'))return {ok:true,body:{total_count:1,artifacts:[{id:9,name:C.R9_ARTIFACT_NAME,expired:false}]}};
    if(route.includes('/compare/'))return {ok:true,body:{status:'identical',merge_base_commit:{sha:head}}};
    if(route.includes('/actions/runs?'))return {ok:true,body:{total_count:runs.length,workflow_runs:runs}};
    if(route.includes('/jobs?')){const id=Number(/\/runs\/(\d+)/.exec(route)[1]);const members=jobs.filter(j=>j.run_id===id);return {ok:true,body:{total_count:members.length,jobs:members}};}
    const m=/\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?$/.exec(route);
    if(m)return {ok:true,body:runs.find(r=>String(r.id)===m[1])};
    throw Error('UNMOCKED_NETWORK_ROUTE');
  };
  return {request,routes};
}

function selection(clock=null,four=null,w=window){return JSON.stringify({schema:'clued.merge-admission-r9-source-contract/1',repository,scope,window:w,four_expected_sources_raw:four,clock});}
function clockFrame({queue=scope.queue_ref,w=window,transport=true}={}){
  const foundation='a'.repeat(64),catalog='b'.repeat(64),definition='c'.repeat(64),uid=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
  const us=t=>String(BigInt(Date.parse(t))*1000n);
  const p={status:'ok',stream_id:uid(1),source_digest:foundation,after_sequence:0,next_sequence:0,end_sequence:0,has_more:false,candidate_ready:true,events:[],clock_samples:[],
    epoch:{epoch_id:uid(2),stream_id:uid(1),queue_ref:queue,clock_generation_id:uid(3),start_sequence:0,opening_us:us(w.start),foundation_digest:foundation,catalog_digest:catalog,
      initial_events:[{kind:'policy',object_key:'fifo-v1',context_key:'global',payload:{profile:{merge_slot_seconds:1,merge_slot_running_seconds:1,merge_slot_green_seconds:1}}}]},
    seal:{seal_id:uid(4),epoch_id:uid(2),end_sequence:0,closing_us:us(w.end),catalog_digest:catalog,raw_regression:false,sample_gap:false,ddl_tainted:false},
    observation_seals:[{end_sequence:0,closing_us:us(w.end)}],coverage_manifest:{queue_ref:queue,event_count:0}};
  const response={status:'ok',operation:'clock_page',measurement:p,pins:{epoch_id:uid(2),stream_id:uid(1),clock_generation_id:uid(3),foundation_digest:foundation,catalog_digest:catalog},
    seal_pins:{end_sequence:0,closing_us:us(w.end),catalog_digest:catalog},server_auth:{schema:'clued.clock-audit-transport-auth/1',status:'AUTHENTICATED_TARGET_READ',required_scope:'audit:read',
      context_key:'project:'+scope.project_id,queue_ref:queue,contributor_count:1,binding_scope_fingerprint:'d'.repeat(64),observed_at:w.end,transport_definition_digest:definition},source_auth:false,official_metric:false,t0:null};
  return {clock:{pages_raw:JSON.stringify([p]),options_raw:JSON.stringify({queueRef:queue,expectedFoundationDigest:foundation,expectedCatalogDigest:catalog}),
    ...(transport?{transport_raw:JSON.stringify([response])}:{})},pins:{foundation_digest:foundation,catalog_digest:catalog,transport_definition_digest:definition}};
}
function fourFrame(rows){
  const protocol=F.MERGE_ADMISSION_FOUR_SOURCE_PROTOCOL,read=p=>fs.readFileSync(path.join(repo,p),'utf8');
  const paths={script:'scripts/ci/clued-work-admission.mjs',workflow:'.github/workflows/clued-work-admission.yml',
    reverify_workflow:'.github/workflows/clued-work-admission-reverify.yml',policy:'config/merge-admission-policy.json'};
  const texts=Object.fromEntries(Object.entries(paths).map(([k,p])=>[k,read(p)])),profiles=read('scripts/ci/clued-gated-proof-profiles.json'),roles=read('scripts/ci/clued-gated-proof-role-specs.json');
  const source={grammar:protocol.admission_grammar,source_checkout_sha:head,default_branch:'main',app_id:5164952};
  for(const [k,p]of Object.entries(paths)){source[k+'_path']=p;source[k+'_blob']=workflowBlob(texts[k]);}
  const expected=JSON.stringify({schema:protocol.expectations_schema,repository,scope,admission_sources:[source],execution_source:{source_checkout_sha:head,profiles_sha256:digest(profiles),role_specs_sha256:digest(roles)}});
  const names=['attempts','targets','admission_batches','admissions','operations','head_moves','rounds','cancellations'];
  const ids={attempts:'native_attempts',targets:'admission_targets',admission_batches:'admission_selection_journal',admissions:'final_admission_journal',operations:'operation_journal_all_origins',head_moves:'native_head_move_journal',rounds:'final_round_journal',cancellations:'native_cancel_evidence'};
  const p={schema:protocol.schema,repository,scope,window,collection:{watermark:'fixed.1',closed_at:'2026-10-11T00:01:00.000Z',window_status:'closed',retention_start:window.start},populations:{},
    sources_raw:JSON.stringify([{source_checkout_sha:head,sources_raw:JSON.stringify(texts)}]),proof_profiles_raw:profiles,role_specs_raw:roles,
    execution_sources:{source_checkout_sha:head,entries:Object.entries(JSON.parse(profiles).workflows).map(([workflow_file,s])=>({workflow_file,workflow_blob:s.workflow_blob})),manifest:null}};
  for(const n of names)p[n]=[];p.attempts=rows;
  const manifest=(source_id,members)=>{const b={snapshot_id:'fixed.1',total:members.length,member_digest:digest(JSON.stringify(members)),first_member:members[0]??null,last_member:members.at(-1)??null};
    return {reader_source:protocol.reader_source,source_id,scope,cohort:protocol.population_cohort,window,retention_start:window.start,watermark:p.collection.watermark,collected_at:p.collection.closed_at,
      before:{...b,read_id:'before.'+source_id},after:{...b,read_id:'after.'+source_id},pages:[{page:1,cursor:null,next_cursor:null,members}]};};
  for(const n of names)p.populations[n]=manifest(ids[n],n==='attempts'?p[n].map(a=>a.run_id+':'+a.attempt):[]);
  p.execution_sources.manifest=manifest('native_execution_workflow_sources:'+head,p.execution_sources.entries.map(x=>x.workflow_file+':'+x.workflow_blob));
  const frame={packet_raw:JSON.stringify(p),expected_sources_raw:expected};
  return {frame,expected,p,seal(){
    const rowKey=(n,x)=>['attempts','admission_batches','cancellations'].includes(n)?x.run_id+':'+x.attempt:
      n==='targets'?x.run_id+':'+x.attempt+':'+x.pr_number+':'+x.head_sha:n==='admissions'?x.target_key:n==='operations'?x.operation_id:n==='head_moves'?x.move_id:x.round_id;
    for(const n of names)p.populations[n]=manifest(ids[n],p[n].map(x=>rowKey(n,x)));frame.packet_raw=JSON.stringify(p);return frame;
  }};
}
test('real caller seals and authenticates safe non-Push identities then quarantines a later same-ID Push without denying independent data',async()=>{
  const f=fourFrame([]),clock=clockFrame(),expected=JSON.parse(f.expected),
    descriptor={registration_status:'registered',workflow_path:'.github/workflows/clued-merge-slot-ci.yml',workflow_blob:'d'.repeat(40),job_id:'report',job_name:'clued-merge-slot-ci',source_paths:['scripts/ci/clued-merge-slot-ci.mjs'],required_steps:['Export','Upload']},
    coverage={schema:'clued.r9-finite-recorded-operation-coverage/1',epoch_id:'10000000-0000-4000-8000-000000000001',owner_receipt_id:'10000000-0000-4000-8000-000000000001',repository,scope,mode:'explicit_recorded_origins_during_this_epoch',original_source_paths:['scripts/ci/clued-merge-executor.mjs']},
    cfg={schema:'clued.r9-runtime-source-selection/1',registration_status:'registered',repository,scope,natural_producers:[descriptor],operation_coverage:coverage,forward_epoch:{epoch_id:coverage.epoch_id}},rawCfg=JSON.stringify(cfg),
    sourceSelection={repository,head_sha:head,default_branch:'main',natural_producers:[descriptor],profiles_raw:f.p.proof_profiles_raw,workflow_blobs:Object.fromEntries(Object.keys(JSON.parse(f.p.proof_profiles_raw).workflows).filter(file=>fs.existsSync(path.join(repo,file))).map(file=>[file,workflowBlob(fs.readFileSync(path.join(repo,file),'utf8'))]))},
    paths={script:'scripts/ci/clued-work-admission.mjs',workflow:'.github/workflows/clued-work-admission.yml',reverify_workflow:'.github/workflows/clued-work-admission-reverify.yml',policy:'config/merge-admission-policy.json'},
    texts=Object.fromEntries(Object.entries(paths).map(([k,relative])=>[k,fs.readFileSync(path.join(repo,relative),'utf8')])),
    runtime={source_contract_raw:selection(clock.pins,f.expected),forward_epoch:{epoch_id:coverage.epoch_id},operation_coverage:coverage,natural_selection:sourceSelection,
      proof_profiles_raw:f.p.proof_profiles_raw,role_specs_raw:f.p.role_specs_raw,execution_workflow_blobs:sourceSelection.workflow_blobs,
      admission_source_bytes:{[head]:{texts,...Object.fromEntries(['script','workflow','reverify_workflow','policy'].map(k=>[k+'_blob',expected.admission_sources[0][k+'_blob']]))}}};
  const nonPush={id:'99',repo:{name:repository},type:'IssueCommentEvent',created_at:'2026-10-10T10:00:00.000Z',actor:{login:'PRIVATE_ACTOR'},payload:{body:'PRIVATE_BODY'}},
    push={...nonPush,type:'PushEvent',payload:{before:'b'.repeat(40),head:'d'.repeat(40),ref:'refs/heads/main'}};
  const req=(events,artifact=null)=>nativeRequest({runs:artifact?[run()]:[],jobs:artifact?[job()]:[],...(artifact?{artifact}:{}),mutation:route=>{
    if(route.includes('/contents/scripts/ci/merge-admission-r9-source.json'))return {ok:true,body:{type:'file',path:'scripts/ci/merge-admission-r9-source.json',encoding:'base64',sha:workflowBlob(rawCfg),content:Buffer.from(rawCfg).toString('base64')}};
    if(route.includes('/events?'))return {ok:true,body:events};return null;
  }}),options={repository,window,sourceContractRaw:runtime.source_contract_raw,naturalSelection:sourceSelection,runtimeInputs:runtime,liveClock:clock.clock};
  const first=await C.collectR9Measurement({...options,request:req([nonPush]).request,budget:U.createBudget({source:'app',cap:2000})});
  assert.deepEqual(first.natural_inputs.activity.observed_identities,[{id:'99',type:'IssueCommentEvent',created_at:nonPush.created_at,payload:null}]);
  assert.doesNotMatch(JSON.stringify(first.natural_inputs.activity),/PRIVATE_BODY|PRIVATE_ACTOR/);
  const sealed=packet({sourceBlobs:{...blobs,'scripts/ci/merge-admission-r9-source.json':workflowBlob(rawCfg)},nativeStoreRaw:first.next_native_store_raw,
    fourSource:first.authenticated_source_inputs.four_source,clock:clock.clock,naturalInputs:first.natural_inputs}),bytes=zip(sealed),
    proof=await C.verifyR9SealedArtifact({request:req([],bytes).request,repository,contract:contract(),artifactId:'9'});
  assert.equal(proof.status,'AUTHENTICATED_SEALED_ARTIFACT',proof.reason_code);
  assert.deepEqual(proof.packet.natural_inputs.activity.observed_identities,first.natural_inputs.activity.observed_identities);
  const cache=JSON.stringify({schema:C.R9_CACHE_SCHEMA,repository,artifact_id:'9',zip_base64:bytes.toString('base64')}),
    second=await C.collectR9Measurement({...options,request:req([push],bytes).request,budget:U.createBudget({source:'app',cap:2000}),cacheRaw:cache});
  assert.deepEqual(second.natural_inputs.activity.quarantined_ids,['99']);assert.equal(second.natural_inputs.activity.events.length,0);
  assert.equal(second.activity_coverage.reason_code,'NATIVE_ACTIVITY_IMMUTABLE_EVENT_CHANGED');
  assert.deepEqual(second.natural_inputs.activity.quarantine[0].observations.map(e=>e.type),['IssueCommentEvent','PushEvent']);
  assert.doesNotMatch(JSON.stringify(second.natural_inputs.activity),/PRIVATE_BODY|PRIVATE_ACTOR/);
  assert.equal(second.native.status,'COMPLETE');assert.equal(second.metrics.queue_depth_p95.official_metric,true);assert.equal(second.metrics.queue_depth_p95.value,0);
  assert.equal(second.metrics.update_main_rounds.official_metric,true);assert.equal(second.metrics.update_main_rounds.value,0);assert.equal(second.metrics.cancellation_causes.denominator,0);
  assert.equal(second.t0,null);
});
const attemptRow=(id='42',extra={})=>({run_id:id,attempt:1,pr_number:null,head_sha:head,kind:'other',status:'completed',conclusion:'success',started_at:'2026-10-10T10:00:01.000Z',completed_at:null,terminal_interval:{lower_at:'2026-10-10T10:09:00.000Z',upper_at:'2026-10-10T10:10:00.000Z',basis:'native_job_completion_lower_and_terminal_update_upper_bounds'},...extra});
