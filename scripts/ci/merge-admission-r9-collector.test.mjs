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
const {workflowBlob,parseWorkflowProfiles,serializeWorkflowProfiles}=await import(pathToFileURL(path.join(repo,'scripts/ci/clued-workflow-profile.mjs')).href);
const repository='tdoljyj/cross-memory-system',head='a'.repeat(40),window={start:'2026-10-10T00:00:00.000Z',end:'2026-10-11T00:00:00.000Z'};
const digest=x=>createHash('sha256').update(x).digest('hex');
const scope={project_id:'0597aa60-9b98-4da6-a4ab-63d7705b632f',queue_ref:'merge:tdoljyj/cross-memory-system:main'};
test('Native admission membership distinguishes skipped evaluator plus adoption from an executed or unknown evaluator',()=>{
  const workflow='.github/workflows/clued-work-admission.yml',expected=JSON.stringify({admission_sources:[{
    workflow_path:workflow,reverify_workflow_path:'.github/workflows/clued-work-admission-reverify.yml'}]}),
    at='2026-10-10T10:00:01.000Z',r={run_id:'42',run_attempt:1,path:workflow,head_sha:'a'.repeat(40),pull_requests:[727],
      status:'completed',conclusion:'success',created_at:'2026-10-10T10:00:00.000Z',run_started_at:at,updated_at:'2026-10-10T10:01:00.000Z'},
    skipped={id:'43',name:'clued-work-admission',status:'completed',conclusion:'skipped',created_at:at,started_at:at,completed_at:at,steps:[]},
    cancelled={...skipped,conclusion:'cancelled',completed_at:'2026-10-10T10:00:00.000Z'},
    adopt={id:'44',name:'clued-work-adopt',status:'completed',conclusion:'success',created_at:at,started_at:at,completed_at:at,
      steps:[{name:'Report the merge',status:'completed',conclusion:'success'}]};
  for(const [jobs,kind] of [[[skipped,adopt],'other'],[[skipped],'other'],[[cancelled],'other'],[[adopt],'other'],[[],'admission'],
    [[{...cancelled,steps:[{name:'Evaluate',status:'completed',conclusion:'failure'}]}],'admission'],
    [[{...cancelled,started_at:'2026-10-10T10:00:02.000Z'}],'admission']]){
    const native={population_packets:[{run:r,jobs}]},before=JSON.stringify(native),rows=C.mapNativeAttemptsForFourSource(native,expected,window);
    assert.equal(rows.length,1);assert.equal(rows[0].kind,kind);assert.equal(rows[0].status,r.status);assert.equal(rows[0].conclusion,r.conclusion);
    assert.equal(JSON.stringify(native),before);
  }
});
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
    if(route.includes('/actions/runs?'))return {ok:true,body:{total_count:runs.length,workflow_runs:[...runs].sort((a,b)=>BigInt(a.id)>BigInt(b.id)?-1:1)}};
    if(route.includes('/jobs?')){const id=Number(/\/runs\/(\d+)/.exec(route)[1]);const members=jobs.filter(j=>j.run_id===id);return {ok:true,body:{total_count:members.length,jobs:members}};}
    const m=/\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?$/.exec(route);
    if(m)return {ok:true,body:runs.find(r=>String(r.id)===m[1])};
    throw Error('UNMOCKED_NETWORK_ROUTE');
  };
  return {request,routes};
}

test('same-budget R9 share leaves the legacy remainder and adds no pool',async()=>{
  const budget=U.createBudget({cap:2000,source:'app'});let calls=0;
  const slice=C.r9RequestSlice(async()=>{calls++;budget.used++;return {ok:true,body:{}};},budget);
  for(let i=0;i<1500;i++)assert.equal((await slice.request('/x')).ok,true);
  assert.equal((await slice.request('/x')).stopped,'r9_slice_exhausted');
  assert.equal(calls,1500);assert.equal(budget.used,1500);assert.equal(budget.stopped,null);
  assert.equal(C.r9RequestSlice(()=>{},U.createBudget()).allowance,0);
});
test('bounded artifact bytes use existing cap/floor/deadline and never retry',async()=>{
  let calls=0;const budget=U.createBudget({cap:1});
  const request=U.budgetedFetch(async()=>{calls++;return new Response(Buffer.from('z'),{headers:{'x-ratelimit-remaining':'4000'}});},{GITHUB_TOKEN:'mock'},budget);
  assert.equal((await request(`/repos/${repository}/actions/artifacts/9/zip`,{responseType:'bytes'})).body.toString(),'z');
  assert.equal((await request(`/repos/${repository}/actions/artifacts/9/zip`,{responseType:'bytes'})).stopped,'request_cap');
  assert.equal(calls,1);await assert.rejects(()=>request('https://other.invalid',{responseType:'bytes'}));
});
test('ZIP accepts the exact single JSON member and refuses renamed/truncated bytes',()=>{
  assert.equal(C.readSealedPacketZip(zip(packet())),packet());
  assert.throws(()=>C.readSealedPacketZip(zip(packet(),'../r9-sealed-packet.json')));
  assert.throws(()=>C.readSealedPacketZip(zip(packet()).subarray(0,60)));
});
test('real Native artifact/run/default-branch/source-role proof authenticates a batch',async()=>{
  const fake=nativeRequest();const proof=await C.verifyR9SealedArtifact({request:fake.request,repository,contract:contract(),artifactId:'9'});
  assert.equal(proof.status,'AUTHENTICATED_SEALED_ARTIFACT');
  assert.equal(proof.proof.kind,'NATIVE_ARTIFACT_DIGEST_DEFAULTBRANCH_REGISTERED_SOURCE_ROLE');
  assert.equal(proof.packet.four_source,null);assert.equal(proof.packet.clock,null);
  assert.equal(fake.routes.filter(route=>route===`/repos/${repository}/contents/${C.R9_PUBLISHER_PATH}?ref=${head}`).length,1,
    'reuse the same verified immutable publisher bytes for role and source-blob validation');
});
test('hash, current default-branch and caller authority flags do not register a publisher',async()=>{
  const fake=nativeRequest();const proof=await C.verifyR9SealedArtifact({request:fake.request,repository,contract:contract(false),artifactId:'9'});
  assert.equal(proof.status,'PARTIAL');assert.equal(proof.reason_code,'USAGE_PUBLISHER_SOURCE_NOT_REGISTERED');
  const p=JSON.parse(packet());p.authenticated=true;assert.throws(()=>C.readSealedPacketZip(zip(JSON.stringify(p)))&&C.sealR9Packet({...p}));
});
test('tampering with restored ZIP fails the platform digest, not merely local hashes',async()=>{
  const fake=nativeRequest();const bad=Buffer.from(zip(packet()));bad[40]^=1;
  const proof=await C.verifyR9SealedArtifact({request:fake.request,repository,contract:contract(),artifactId:'9',zipBytes:bad});
  assert.equal(proof.reason_code,'ARTIFACT_DIGEST_MISMATCH');
});
test('a successful fork/wrong-branch publisher is refused',async()=>{
  const fake=nativeRequest({runs:[run(42,{head_repository:{full_name:'fork/repo'}})]});
  const proof=await C.verifyR9SealedArtifact({request:fake.request,repository,contract:contract(),artifactId:'9'});
  assert.equal(proof.reason_code,'ARTIFACT_PUBLISHER_ORIGIN_INVALID');
});
test('new Native attempts are captured and sealed once; subsequent batch reuse needs no old jobs request',async()=>{
  const fake=nativeRequest();const saved=[];
  const first=await C.collectIncrementalNative({request:fake.request,repository,window,onStore:s=>saved.push(s)});
  assert.equal(first.status,'COMPLETE');assert.equal(first.fresh,1);assert.equal(saved.length,1);
  const secondFake=nativeRequest();const second=await C.collectIncrementalNative({request:secondFake.request,repository,window,authenticatedStoreRaw:first.store_raw});
  assert.equal(second.status,'COMPLETE');assert.equal(second.from_sealed,1);assert.equal(second.fresh,0);
  assert.equal(secondFake.routes.length,2);assert.ok(secondFake.routes.every(r=>r.includes('/actions/runs?')));
  assert.equal(first.population.cache_reuse_diagnostics.reason_counts.ATTEMPT_PACKET_ABSENT,1);
  assert.equal(second.population.cache_reuse_diagnostics.reason_counts.EXACT_SEALED_HEADER_REUSE,1);
  assert.equal(second.population.cache_reuse_diagnostics.sealed_current_attempt_recapture_count,0);
  assert.deepEqual(second.population.cache_reuse_diagnostics.sealed_current_attempt_recapture_samples,[]);
});
test('reuse diagnostics retain bounded samples and complete capture when current endpoint headers differ',async()=>{
  const original=Array.from({length:6},(_,i)=>run(42+i)),jobs=original.map(r=>job(r.id)),firstFake=nativeRequest({runs:original,jobs}),
    initial=await C.collectIncrementalNative({request:firstFake.request,repository,window});
  assert.equal(initial.status,'COMPLETE');assert.equal(firstFake.routes.length,38);
  const longPath='.github/workflows/'+('x'.repeat(300))+'.yml',pulls=Array.from({length:24},(_,i)=>({number:i+1})),
    current=original.map((r,i)=>({...r,updated_at:'2026-10-10T10:11:00Z',...(i===0?{path:longPath,pull_requests:pulls}:{})})),cold=run(41),
    fake=nativeRequest({runs:[cold,...current],jobs:[job(41),...jobs]});
  const result=await C.collectIncrementalNative({request:fake.request,repository,window,authenticatedStoreRaw:initial.store_raw}),
    diag=result.population.cache_reuse_diagnostics;
  assert.equal(result.status,'PARTIAL');assert.equal(result.population.complete,false);
  assert.equal(result.fresh,1);assert.equal(result.from_sealed,0);assert.equal(fake.routes.length,49);
  assert.equal(fake.routes.filter(route=>route.includes('/jobs?')).length,14);
  for(const member of [cold,...current])assert.equal(fake.routes.filter(route=>route===('/repos/'+repository+'/actions/runs/'+member.id)).length,2);
  assert.equal(diag.reason_counts.ATTEMPT_PACKET_ABSENT,1);assert.equal(diag.reason_counts.LATEST_SEALED_HEADER_VALUES_DIFFER,6);
  assert.equal(diag.sealed_current_attempt_recapture_count,6);assert.equal(diag.sample_limit,4);
  assert.deepEqual(diag.sealed_current_attempt_recapture_samples.map(s=>s.key),['42:1','43:1','44:1','45:1']);
  const sample=diag.sealed_current_attempt_recapture_samples[0];
  assert.equal(sample.reason_code,'LATEST_SEALED_HEADER_VALUES_DIFFER');
  assert.deepEqual(sample.changed_fields,['path','updated_at','pull_requests']);
  assert.equal(sample.public_values.updated_at.sealed.value,'2026-10-10T10:10:00.000Z');
  assert.equal(sample.public_values.updated_at.inventory.value,'2026-10-10T10:11:00.000Z');
  assert.equal(sample.public_values.path.inventory.value.length,256);assert.equal(sample.public_values.path.inventory.count,longPath.length);
  assert.equal(sample.public_values.path.inventory.truncated,true);
  assert.deepEqual(sample.public_values.pull_requests.inventory,{values:Array.from({length:16},(_,i)=>i+1),count:24,truncated:true});
  assert.deepEqual(JSON.parse(result.store_raw).packets['42:1'],JSON.parse(initial.store_raw).packets['42:1']);
  assert.ok(JSON.parse(result.store_raw).packets['41:1']);
});
async function endpointWitnessFixture({directoryPatch={},endpointPatch={},closingPatch=null,endpointBody=undefined,refused=false}={}){
  const original=run(42,{updated_at:'2026-10-10T10:10:16Z'}),endpoint={...original,created_at:'2026-10-10T10:00:01Z'};
  const old=nativeRequest({runs:[original],mutation:route=>route.endsWith('/attempts/1')?{ok:true,body:endpoint}:null});
  const sealed=await N.captureNativeAttempt({request:old.request,repository,runId:'42',attempt:1});assert.equal(sealed.status,'COMPLETE');
  const directory={...original,updated_at:'2026-10-10T10:10:15Z',...directoryPatch};let inventories=0;
  const current=nativeRequest({runs:[directory],mutation:route=>{
    if(route.includes('/actions/runs?')&&++inventories===2&&closingPatch)return {ok:true,body:{total_count:1,workflow_runs:[{...directory,...closingPatch}]}};
    if(/\/attempts\/\d+$/.test(route))return refused?{ok:false,stopped:'request_cap'}:
      {ok:true,body:endpointBody===undefined?{...endpoint,...endpointPatch}:endpointBody};
    return null;
  }});
  return {sealed,current};
}
test('current attempt endpoint witness reuses exact sealed header despite one-second directory metadata lag',async()=>{
  const {sealed,current}=await endpointWitnessFixture(),result=await C.collectIncrementalNative({request:current.request,repository,window,authenticatedStoreRaw:sealed.store_raw});
  assert.equal(result.status,'COMPLETE');assert.equal(result.population.complete,true);assert.equal(result.from_sealed,1);assert.equal(result.fresh,0);
  assert.equal(result.store_raw,sealed.store_raw,'the old packet values and JSON serialization stay unchanged');
  assert.deepEqual(current.routes,[`/repos/${repository}/actions/runs?per_page=100&page=1`,
    `/repos/${repository}/actions/runs/42/attempts/1`,`/repos/${repository}/actions/runs?per_page=100&page=1`]);
  assert.equal(JSON.parse(result.store_raw).packets['42:1'].timing_basis.reported_attempt_created_at,'2026-10-10T10:00:01.000Z');
  const diag=result.population.cache_reuse_diagnostics;
  assert.equal(diag.reason_counts.CURRENT_ATTEMPT_ENDPOINT_HEADER_REUSE,1);assert.equal(diag.reason_counts.EXACT_SEALED_HEADER_REUSE,0);
  assert.equal(diag.sealed_current_attempt_recapture_count,0);
});
test('current attempt endpoint witness covers only its latest ordinal and leaves historical capture unchanged',async()=>{
  const prior=run(42,{updated_at:'2026-10-10T10:10:16Z'}),latest=run(42,{run_attempt:2,run_started_at:'2026-10-10T10:20:00Z',updated_at:'2026-10-10T10:30:16Z'}),
    second={...latest,created_at:'2026-10-10T10:20:00Z'},jobs=[job(42),job(42,{id:242,run_attempt:2,created_at:'2026-10-10T10:20:00Z',
      started_at:'2026-10-10T10:20:01Z',completed_at:'2026-10-10T10:29:00Z',steps:[]})];
  const requestFor=directory=>nativeRequest({runs:[directory],mutation:route=>{
    if(route.endsWith('/attempts/1'))return {ok:true,body:prior};
    if(route.endsWith('/attempts/2'))return {ok:true,body:second};
    if(route.includes('/attempts/')&&route.includes('/jobs?'))return {ok:true,body:{total_count:1,jobs:[jobs[Number(/\/attempts\/(\d+)/.exec(route)[1])-1]]}};
    return null;
  }});
  const initial=requestFor(latest),one=await N.captureNativeAttempt({request:initial.request,repository,runId:'42',attempt:1});
  const two=await N.captureNativeAttempt({request:initial.request,repository,runId:'42',attempt:2,storeRaw:one.store_raw});
  assert.equal(one.status,'COMPLETE');assert.equal(two.status,'COMPLETE');
  const current=requestFor({...latest,updated_at:'2026-10-10T10:30:15Z'}),result=await C.collectIncrementalNative({request:current.request,repository,window,authenticatedStoreRaw:two.store_raw});
  assert.equal(result.status,'COMPLETE');assert.equal(result.from_sealed,1);assert.equal(result.fresh,1);assert.equal(result.store_raw,two.store_raw);
  assert.equal(current.routes.filter(route=>route.endsWith('/attempts/2')).length,1);
  assert.equal(current.routes.filter(route=>route.endsWith('/attempts/1')).length,2);assert.equal(current.routes.length,7);
  assert.equal(result.population.cache_reuse_diagnostics.reason_counts.CURRENT_ATTEMPT_ENDPOINT_HEADER_REUSE,1);
});
test('current attempt endpoint witness refuses other fields, ordinal, unknown DTO and changed reported creation',async()=>{
  for(const options of [{directoryPatch:{head_sha:'d'.repeat(40)}},{directoryPatch:{run_attempt:2}},
    {endpointPatch:{run_attempt:2}},{endpointBody:null},{endpointPatch:{updated_at:'2026-10-10T10:10:17Z'}},
    {endpointPatch:{created_at:'2026-10-10T10:00:02Z'}},{endpointPatch:{updated_at:'2026-10-10T10:10:16.000001Z'}},
    {endpointPatch:{pull_requests:[{number:727}]}},{endpointPatch:{run_started_at:undefined}}]){
    const {sealed,current}=await endpointWitnessFixture(options),result=await C.collectIncrementalNative({request:current.request,repository,window,authenticatedStoreRaw:sealed.store_raw});
    assert.equal(result.from_sealed,0,JSON.stringify(options));assert.equal(result.population.complete,false);
    assert.equal(result.population.cache_reuse_diagnostics.reason_counts.CURRENT_ATTEMPT_ENDPOINT_HEADER_REUSE,0);
    assert.deepEqual(JSON.parse(result.store_raw).packets['42:1'],sealed.packet);
  }
});
test('current attempt endpoint witness preserves window boundaries and rejects changed serialization',async()=>{
  for(const windowOverride of [{start:'2026-10-10T10:10:15.500Z',end:window.end},
    {start:window.start,end:'2026-10-10T10:10:15.500Z'}]){
    const {sealed,current}=await endpointWitnessFixture(),result=await C.collectIncrementalNative({request:current.request,repository,window:windowOverride,authenticatedStoreRaw:sealed.store_raw});
    assert.equal(result.from_sealed,0);assert.equal(result.population.cache_reuse_diagnostics.reason_counts.CURRENT_ATTEMPT_ENDPOINT_HEADER_REUSE,0);
    assert.deepEqual(JSON.parse(result.store_raw).packets['42:1'],sealed.packet);
  }
  const {sealed,current}=await endpointWitnessFixture(),bad=JSON.parse(sealed.store_raw),r=bad.packets['42:1'].run;
  bad.packets['42:1'].run={pull_requests:r.pull_requests,...r};
  const refused=await C.collectIncrementalNative({request:current.request,repository,window,authenticatedStoreRaw:JSON.stringify(bad)});
  assert.equal(refused.status,'PARTIAL');assert.equal(refused.reason_code,'NATIVE_STORE_INVALID');assert.equal(refused.from_sealed,0);assert.equal(current.routes.length,0);
});
test('current attempt endpoint witness retains refusal, closing directory and the original budget barriers',async()=>{
  const failed=await endpointWitnessFixture({refused:true}),partial=await C.collectIncrementalNative({request:failed.current.request,repository,window,authenticatedStoreRaw:failed.sealed.store_raw});
  assert.equal(partial.status,'PARTIAL');assert.equal(partial.from_sealed,0);assert.equal(partial.population.complete,false);
  assert.equal(failed.current.routes.filter(route=>route.endsWith('/attempts/1')).length,1,'no retry after the endpoint refusal');
  assert.ok(!failed.current.routes.some(route=>route.endsWith('/runs/42')||route.includes('/jobs?')));
  const shifted=await endpointWitnessFixture({closingPatch:{updated_at:'2026-10-10T10:10:14Z'}}),changed=await C.collectIncrementalNative({request:shifted.current.request,repository,window,authenticatedStoreRaw:shifted.sealed.store_raw});
  assert.equal(changed.status,'PARTIAL');assert.equal(changed.reason_code,'NATIVE_COHORT_CHANGED_AT_CLOSE');assert.equal(changed.population.complete,false);
  assert.equal(changed.store_raw,shifted.sealed.store_raw);
  for(const cap of [1,2]){
    const f=await endpointWitnessFixture(),budget=U.createBudget({cap,source:'app'});let http=0;
    const request=U.budgetedFetch(async url=>{http++;const reply=await f.current.request(new URL(url).pathname+new URL(url).search);
      return new Response(JSON.stringify(reply.body),{headers:{'x-ratelimit-remaining':'4000','x-ratelimit-limit':'5000'}});},{},budget,'mock');
    const result=await C.collectIncrementalNative({request,repository,window,authenticatedStoreRaw:f.sealed.store_raw});
    assert.equal(result.status,'PARTIAL');assert.equal(result.population.complete,false);assert.equal(http,cap);assert.equal(budget.stopped,'request_cap');
    assert.equal(result.store_raw,f.sealed.store_raw);assert.equal(result.from_sealed,cap===1?0:1);
  }
});
test('numeric Native conclusion is masked in reuse diagnostics while the original capture remains refused',async()=>{
  const original=nativeRequest(),initial=await C.collectIncrementalNative({request:original.request,repository,window}),
    invalid=nativeRequest({runs:[run(42,{conclusion:17})]});
  assert.equal(initial.status,'COMPLETE');
  const result=await C.collectIncrementalNative({request:invalid.request,repository,window,authenticatedStoreRaw:initial.store_raw}),
    diag=result.population.cache_reuse_diagnostics,sample=diag.sealed_current_attempt_recapture_samples[0];
  assert.equal(result.status,'PARTIAL');assert.equal(result.population.complete,false);
  assert.equal(result.fresh,0);assert.equal(result.from_sealed,0);
  assert.deepEqual(result.gaps,[{key:'42:1',reason_code:'invalid_native_run_conclusion'}]);
  assert.equal(diag.reason_counts.LATEST_SEALED_HEADER_VALUES_DIFFER,1);assert.equal(diag.sealed_current_attempt_recapture_count,1);
  assert.equal(sample.key,'42:1');assert.deepEqual(sample.changed_fields,['conclusion']);
  assert.deepEqual(sample.public_values.conclusion.inventory,{not_published:'UNVALIDATED_NATIVE_HEADER_VALUE'});
  assert.deepEqual(sample.public_values.conclusion.sealed,{value:'success',count:7,truncated:false});
  assert.equal(invalid.routes.length,3);assert.equal(invalid.routes.filter(route=>route.endsWith('/actions/runs/42')).length,1);
  assert.ok(!invalid.routes.some(route=>route.includes('/jobs?')));
  assert.deepEqual(JSON.parse(result.store_raw),JSON.parse(initial.store_raw));
});
test('never-started cancelled rows survive with unknown membership; updated_at is not invented completion',async()=>{
  const fake=nativeRequest({runs:[run(42,{run_started_at:null,conclusion:'cancelled'})],jobs:[job(42,{started_at:null,completed_at:null,terminal_interval:{lower_at:'2026-10-10T10:00:01.000Z',upper_at:'2026-10-10T10:10:00.000Z',basis:'native_job_completion_lower_and_terminal_update_upper_bounds'},conclusion:'cancelled',steps:[]})]});
  const result=await C.collectIncrementalNative({request:fake.request,repository,window});
  assert.equal(result.status,'COMPLETE');assert.deepEqual(result.population.attempt_start_unknown,['42:1']);
  const raw=JSON.parse(result.store_raw).packets['42:1'];assert.equal(raw.run.run_started_at,null);assert.equal(raw.jobs[0].completed_at,null);
});
test('interrupted batches retain every completed immutable packet and report partial',async()=>{
  let snapshots=0;const fake=nativeRequest({runs:[run(42),run(43)],jobs:[job(42),job(43)],mutation:route=>
    route.includes('/runs/43')?{ok:false,stopped:'request_cap'}:null});
  const result=await C.collectIncrementalNative({request:fake.request,repository,window,onStore:()=>snapshots++});
  assert.equal(result.status,'PARTIAL');assert.equal(snapshots,1);assert.ok(JSON.parse(result.store_raw).packets['42:1']);
  assert.equal(result.population.complete,false);
});
test('fee Native scope is the fixed six Source workflows and default R9 scope remains unchanged',async()=>{
  assert.deepEqual(C.FEE_NATIVE_WORKFLOW_PATHS,[
    '.github/workflows/clued-merge-slot-ci.yml','.github/workflows/clued-merge-executor.yml',
    '.github/workflows/clued-work-admission-reverify.yml','.github/workflows/clued-work-admission.yml',
    '.github/workflows/clued-ci-health.yml','.github/workflows/clued-work-admission-dispatch.yml']);
  assert.equal(Object.isFrozen(C.FEE_NATIVE_WORKFLOW_PATHS),true);
  const members=C.FEE_NATIVE_WORKFLOW_PATHS.map((workflow,i)=>run(42+i,{path:workflow})),outside=run(70),
    jobs=[...members,outside].map(r=>job(r.id)),fake=nativeRequest({runs:[...members,outside],jobs});
  const fee=await C.collectFeeNativePopulation({request:fake.request,repository,window,workflowPaths:[C.R9_PUBLISHER_PATH]});
  assert.equal(fee.status,'COMPLETE');assert.equal(fee.population.complete,true);
  assert.equal(fee.population.initial_total,7);assert.equal(fee.population.initial_scope_runs,6);assert.equal(fee.population.closing_scope_runs,6);
  assert.deepEqual(fee.population.workflow_paths,C.FEE_NATIVE_WORKFLOW_PATHS);
  assert.deepEqual(fee.population.window,window);assert.equal(fee.all_population_packets.length,6);
  assert.equal(fee.population.cohort.length,6);assert.ok(!fake.routes.some(route=>route.includes('/runs/70')));
  const original=nativeRequest({runs:[...members,outside],jobs}),r9=await C.collectIncrementalNative({request:original.request,repository,window});
  assert.equal(r9.status,'COMPLETE');assert.equal(r9.all_population_packets.length,7);
  assert.equal(Object.hasOwn(r9.population,'workflow_paths'),false);assert.equal(r9.population.scope,'native_terminal_packets_run_envelope_intersection');
});
test('fee Native keeps old-created rerun ordinals and cross-midnight jobs outside the attempt-start subset',async()=>{
  const path=C.FEE_NATIVE_WORKFLOW_PATHS[0],created_at='2026-10-09T23:55:00Z',
    first=run(42,{path,created_at,run_started_at:'2026-10-09T23:56:00Z',updated_at:'2026-10-10T00:05:00Z'}),
    latest=run(42,{path,created_at,run_attempt:2,run_started_at:'2026-10-12T23:58:00Z',updated_at:'2026-10-13T00:02:00Z'}),
    previous=job(42,{created_at:'2026-10-09T23:57:00Z',started_at:'2026-10-09T23:58:00Z',completed_at:'2026-10-10T00:04:00Z',
      steps:[{number:1,name:'Run workload',status:'completed',conclusion:'success',started_at:'2026-10-09T23:58:00Z',completed_at:'2026-10-10T00:04:00Z'}]}),
    current=job(42,{id:242,run_attempt:2,created_at:'2026-10-12T23:58:01Z',started_at:'2026-10-12T23:58:02Z',completed_at:'2026-10-13T00:01:00Z',
      steps:[{number:1,name:'Run workload',status:'completed',conclusion:'success',started_at:'2026-10-12T23:58:02Z',completed_at:'2026-10-13T00:01:00Z'}]}),
    envelope={start:window.start,end:'2026-10-13T00:00:00.000Z'};
  const fake=nativeRequest({runs:[latest],mutation:route=>{
    if(route.endsWith('/attempts/1'))return {ok:true,body:first};
    if(route.endsWith('/attempts/2'))return {ok:true,body:latest};
    if(route.includes('/attempts/1/jobs?'))return {ok:true,body:{total_count:1,jobs:[previous]}};
    if(route.includes('/attempts/2/jobs?'))return {ok:true,body:{total_count:1,jobs:[current]}};return null;
  }});
  const fee=await C.collectFeeNativePopulation({request:fake.request,repository,window:envelope});
  assert.equal(fee.status,'COMPLETE');assert.equal(fee.all_population_packets.length,2);assert.equal(fee.attempts.length,1);
  const old=fee.all_population_packets.find(p=>p.run.run_attempt===1);
  assert.equal(old.jobs[0].started_at,'2026-10-09T23:58:00.000Z');assert.equal(old.jobs[0].completed_at,'2026-10-10T00:04:00.000Z');
  assert.equal(fake.routes.filter(route=>route.includes('/attempts/1/jobs?')).length,2);
  assert.equal(fake.routes.filter(route=>route.includes('/attempts/2/jobs?')).length,2);
  assert.ok(fake.routes.filter(route=>route.includes('/actions/runs?')).every(route=>!new URL(route,'https://native.invalid').searchParams.has('created')));
});
test('fee Native authenticated packet reuse still closes its own scoped directory twice',async()=>{
  const r=run(42,{path:C.FEE_NATIVE_WORKFLOW_PATHS[0]}),initial=nativeRequest({runs:[r]}),
    first=await C.collectFeeNativePopulation({request:initial.request,repository,window}),fake=nativeRequest({runs:[r]});
  const repeated=await C.collectFeeNativePopulation({request:fake.request,repository,window,authenticatedStoreRaw:first.store_raw});
  assert.equal(repeated.status,'COMPLETE');assert.equal(repeated.from_sealed,1);assert.equal(repeated.fresh,0);
  assert.equal(fake.routes.length,2);assert.ok(fake.routes.every(route=>route.includes('/actions/runs?')));
  assert.equal(repeated.population.cohort_digest,first.population.cohort_digest);
});
test('fee Native records a proved latest attempt after close while retaining earlier ordinals',async()=>{
  const path=C.FEE_NATIVE_WORKFLOW_PATHS[0],first=run(42,{path}),latest=run(42,{path,run_attempt:2,
    run_started_at:window.end,updated_at:'2026-10-11T00:00:01Z',status:'in_progress',conclusion:null});
  const fake=nativeRequest({runs:[latest],mutation:route=>route.endsWith('/attempts/1')?{ok:true,body:first}:null});
  const fee=await C.collectFeeNativePopulation({request:fake.request,repository,window});
  assert.equal(fee.status,'COMPLETE');assert.equal(fee.all_population_packets.length,1);
  assert.equal(fee.all_population_packets[0].run.run_attempt,1);
  assert.deepEqual(fee.population.excluded_attempts,[{key:'42:2',reason_code:'ATTEMPT_START_AT_OR_AFTER_WINDOW_CLOSE'}]);
  assert.ok(!fake.routes.some(route=>route.includes('/attempts/2')));
});
test('fee Native unknown execution times remain null without becoming a population gap',async()=>{
  const fake=nativeRequest({runs:[run(42,{path:C.FEE_NATIVE_WORKFLOW_PATHS[0],run_started_at:null,conclusion:'cancelled'})],
    jobs:[job(42,{started_at:null,completed_at:null,conclusion:'cancelled',steps:[]})]});
  const fee=await C.collectFeeNativePopulation({request:fake.request,repository,window});
  assert.equal(fee.status,'COMPLETE');assert.equal(fee.population.complete,true);assert.deepEqual(fee.gaps,[]);
  assert.deepEqual(fee.population.attempt_start_unknown,['42:1']);assert.equal(fee.all_population_packets[0].run.run_started_at,null);
  assert.equal(fee.all_population_packets[0].jobs[0].started_at,null);assert.equal(fee.all_population_packets[0].jobs[0].completed_at,null);
});
test('fee Native refusal keeps the saved packet union and returns explicitly partial workload coverage',async()=>{
  const paths=C.FEE_NATIVE_WORKFLOW_PATHS,saved=[],fake=nativeRequest({runs:[run(42,{path:paths[0]}),run(43,{path:paths[1]})],
    jobs:[job(42),job(43)],mutation:route=>route.includes('/runs/43')?{ok:false,stopped:'request_cap'}:null});
  const fee=await C.collectFeeNativePopulation({request:fake.request,repository,window,onStore:raw=>saved.push(raw)});
  assert.equal(fee.status,'PARTIAL');assert.equal(fee.population.complete,false);assert.equal(saved.length,1);
  assert.equal(fee.store_raw,saved[0]);assert.ok(JSON.parse(fee.store_raw).packets['42:1']);
  assert.equal(fee.all_population_packets.length,1);assert.equal(fee.all_population_packets[0].run.run_id,'42');
  assert.equal(fee.population.closing_scope_runs,null);assert.equal(fee.population.cohort.length,2);
  assert.doesNotThrow(()=>packet({nativeStoreRaw:fee.store_raw}));
});
test('fee Native rejects changed closing cohort and incomplete job pages instead of claiming complete',async()=>{
  let directories=0;const member=run(42,{path:C.FEE_NATIVE_WORKFLOW_PATHS[0]});
  const changed=nativeRequest({runs:[member],mutation:route=>route.includes('/actions/runs?')&&++directories===2?
    {ok:true,body:{total_count:1,workflow_runs:[{...member,run_attempt:2}]}}:null});
  const closure=await C.collectFeeNativePopulation({request:changed.request,repository,window});
  assert.equal(closure.status,'PARTIAL');assert.equal(closure.reason_code,'NATIVE_COHORT_CHANGED_AT_CLOSE');
  assert.equal(closure.population.complete,false);assert.equal(closure.all_population_packets.length,1);
  let jobPages=0;const short=nativeRequest({runs:[member],mutation:route=>route.includes('/jobs?')&&++jobPages===2?
    {ok:true,body:{total_count:2,jobs:[job()]}}:null});
  const pages=await C.collectFeeNativePopulation({request:short.request,repository,window});
  assert.equal(pages.status,'PARTIAL');assert.equal(pages.population.complete,false);assert.equal(pages.all_population_packets.length,0);
  assert.equal(pages.gaps[0].reason_code,'native_page_short_or_overfull');
});
test('fee Native still proves the entire retained directory when no scoped run is selected',async()=>{
  const complete=uncappedDirectoryFixture({grow:false}),fee=await C.collectFeeNativePopulation({request:complete.request,repository,window});
  assert.equal(fee.status,'COMPLETE');assert.equal(fee.population.initial_total,250);assert.equal(fee.population.initial_scope_runs,0);
  assert.equal(fee.population.closing_scope_runs,0);assert.equal(complete.calls,8);assert.equal(fee.all_population_packets.length,0);
  const removed=uncappedDirectoryFixture({remove:true}),partial=await C.collectFeeNativePopulation({request:removed.request,repository,window});
  assert.equal(partial.status,'PARTIAL');assert.equal(partial.population.complete,false);
});
test('authenticated Native consistency does not produce missing four-source/clock values or T0',async()=>{
  const fake=nativeRequest();const result=await C.collectR9Measurement({request:fake.request,budget:U.createBudget({source:'app',cap:2000}),repository,window});
  assert.equal(result.source_authenticated,true);assert.equal(result.official_metric,false);assert.equal(result.t0,null);
  assert.equal(result.native.status,'COMPLETE');
  assert.equal(result.metrics.update_main_rounds.value,null);assert.equal(result.metrics.queue_depth_p95.value,null);
  assert.ok(result.gaps.includes('NATURAL_ADMISSION_OPERATION_ROUND_PRODUCER_PACKETS_MISSING'));
  assert.ok(result.gaps.includes('AUTHENTICATED_SEALED_CLOCK_TRANSPORT_MISSING'));
});
test('current real registry has no usage publisher: the integration gives a specific preparation gap',async()=>{
  const profiles=parseWorkflowProfiles(fs.readFileSync(path.join(repo,'scripts/ci/clued-gated-proof-profiles.json')));
  assert.equal(Object.hasOwn(profiles.workflows,C.R9_PUBLISHER_PATH),false);
  const fake=nativeRequest({sourceContract:contract(false)});const result=await C.collectR9Measurement({request:fake.request,budget:U.createBudget({source:'app',cap:2000}),repository,window});
  assert.equal(result.source_authenticated,false);assert.equal(result.official_metric,false);assert.equal(result.native.status,'COMPLETE');
  assert.ok(result.gaps.includes('USAGE_PUBLISHER_SOURCE_NOT_REGISTERED'));
});

test('closing inventory change refuses a complete denominator and retains new captures',async()=>{
  let inventories=0;const fake=nativeRequest({mutation:route=>{
    if(route.includes('/actions/runs?')&&++inventories===2)return {ok:true,body:{total_count:1,workflow_runs:[run(42,{head_sha:'d'.repeat(40)})]}};
    return null;
  }});
  const result=await C.collectIncrementalNative({request:fake.request,repository,window});
  assert.equal(result.reason_code,'NATIVE_COHORT_CHANGED_AT_CLOSE');assert.equal(result.population.complete,false);
  assert.ok(JSON.parse(result.store_raw).packets['42:1']);
});
test('publisher failure of a required step never authenticates an immutable cache',async()=>{
  const bad=job();bad.steps[0].conclusion='skipped';
  const fake=nativeRequest({jobs:[bad]});const proof=await C.verifyR9SealedArtifact({request:fake.request,repository,contract:contract(),artifactId:'9'});
  assert.equal(proof.reason_code,'USAGE_PUBLISHER_EXECUTION_INCOMPLETE');
});
test('main actually runs the R9 segment, seals progress, keeps old workload values and one App budget',async()=>{
  const sourceContract=contract(false),fake=nativeRequest({sourceContract});
  const files=new Map(),calls=[];
  const fetchImpl=async(url,init)=>{
    const route=String(url).replace('https://api.github.com','');calls.push(route);
    let body;
    if(route===`/repos/${repository}/installation`)body={id:1};
    else if(route==='/app/installations/1/access_tokens')return new Response(JSON.stringify({token:'mock-measurement-token'}),{status:201});
    else if(route.startsWith(`/repos/${repository}/pulls?`))body=[];
    else body=(await fake.request(route)).body;
    return new Response(JSON.stringify(body),{headers:{'x-ratelimit-remaining':'4000','x-ratelimit-limit':'5000'}});
  };
  const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
  const env={GITHUB_REPOSITORY:repository,GITHUB_WORKSPACE:'/fixture',GITHUB_TOKEN:'mock-fallback',
    CLUED_MEASURE_APP_ID:'1',CLUED_MEASURE_APP_KEY:key,GITHUB_RUN_ID:'42',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:head,CI_USAGE_DAYS:'1'};
  const result=await U.main(env,fetchImpl,{now:new Date(window.end),readFile:p=>{
    const rel=String(p).replace(/\\/g,'/').replace('/fixture/','');if(Object.hasOwn(content,rel))return content[rel];throw Error('MISSING_FIXTURE_FILE');},
    writeFile:(p,b)=>files.set(path.basename(p),b),mkdir:()=>{},appendFile:()=>{},log:()=>{},logError:()=>{},clock:()=>0,r9SourceContractRaw:selection()});
  assert.equal(result,0);const report=JSON.parse(files.get('ci-usage-report.json'));
  assert.equal(report.window.start,window.start);assert.equal(report.window.end,window.end);
  assert.equal(report.metrics.hosted_minutes.total,9);assert.equal(report.metrics.self_hosted_minutes.total,0);
  assert.equal(report.metrics.update_main_rounds.status,'not_measured');assert.equal(report.metrics.update_main_rounds.value,null);
  assert.equal(report.r9.source_authenticated,false);assert.equal(report.r9.t0,null);assert.ok(report.r9.requests.used<=1500);
  assert.equal(report.r9.native_coverage.population.cache_reuse_diagnostics.schema,'clued.r9-native-cache-reuse-diagnostics/1');
  assert.equal(report.r9.native_coverage.population.cache_reuse_diagnostics.reason_counts.ATTEMPT_PACKET_ABSENT,1);
  assert.equal(report.metrics.api_requests.cap,2000);assert.equal(report.metrics.api_requests.used,calls.length-2);
  assert.equal(JSON.parse(files.get(C.R9_PACKET_FILE)).publisher.run_id,'42');
  assert.ok(files.has('r9-native-pending.json'));assert.ok(files.has('runs.json'));
});

function selection(clock=null,four=null,w=window){return JSON.stringify({schema:'clued.merge-admission-r9-source-contract/1',repository,scope,window:w,four_expected_sources_raw:four,clock});}
function clockFrame({queue=scope.queue_ref,w=window,transport=true,ambiguous=false}={}){
  const foundation='a'.repeat(64),catalog='b'.repeat(64),definition='c'.repeat(64),uid=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
  const us=t=>String(BigInt(Date.parse(t))*1000n);
  const p={status:'ok',stream_id:uid(1),source_digest:foundation,after_sequence:0,next_sequence:0,end_sequence:0,has_more:false,candidate_ready:true,events:[],clock_samples:[],
    epoch:{epoch_id:uid(2),stream_id:uid(1),queue_ref:queue,clock_generation_id:uid(3),start_sequence:0,opening_us:us(w.start),foundation_digest:foundation,catalog_digest:catalog,
      initial_events:[{kind:'policy',object_key:'fifo-v1',context_key:'global',payload:{profile:{merge_slot_seconds:1,merge_slot_running_seconds:1,merge_slot_green_seconds:1}}}]},
    seal:{seal_id:uid(4),epoch_id:uid(2),end_sequence:0,closing_us:us(w.end),catalog_digest:catalog,raw_regression:false,sample_gap:false,ddl_tainted:false},
    observation_seals:[{end_sequence:0,closing_us:us(w.end)}],coverage_manifest:{queue_ref:queue,event_count:0}};
  if(ambiguous){
    const start=BigInt(us(w.start)),duration=BigInt(us(w.end))-start,
      lower=start+duration*94n/100n,upper=start+duration*96n/100n,at=x=>new Date(Number(x/1000n)).toISOString();
    p.epoch.initial_events[0].payload.profile={merge_slot_seconds:86400,merge_slot_running_seconds:86400,merge_slot_green_seconds:86400};
    p.next_sequence=p.end_sequence=p.seal.end_sequence=p.coverage_manifest.event_count=1;
    p.events=[{sequence:1,transaction_id:'1',kind:'claim',context_key:'project:'+scope.project_id,object_key:uid(5),recorded_at:at(lower),source_digest:foundation,
      payload:{claim_id:uid(5),status:'ACTIVE',fence:1,merge_refs:[queue],merge_queued_at:at(lower),expires_at:at(BigInt(us(w.end))+86400000000n),
        merge_slot_at:at(lower),merge_slot_ci_at:null,merge_slot_ci_state:null,merge_slot_hard_cap_seconds:null}}];
    p.clock_samples=[{sequence:1,transaction_id:'1',raw_us:String(lower)}];
    p.observation_seals=[{end_sequence:1,closing_us:String(upper)},{end_sequence:1,closing_us:us(w.end)}];
  }
  const response={status:'ok',operation:'clock_page',measurement:p,pins:{epoch_id:uid(2),stream_id:uid(1),clock_generation_id:uid(3),foundation_digest:foundation,catalog_digest:catalog},
    seal_pins:{end_sequence:p.end_sequence,closing_us:us(w.end),catalog_digest:catalog},server_auth:{schema:'clued.clock-audit-transport-auth/1',status:'AUTHENTICATED_TARGET_READ',required_scope:'audit:read',
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
    execution_sources:{source_checkout_sha:head,entries:Object.entries(parseWorkflowProfiles(profiles).workflows).map(([workflow_file,s])=>({workflow_file,workflow_blob:s.workflow_blob})),manifest:null}};
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
const attemptRow=(id='42',extra={})=>({run_id:id,attempt:1,pr_number:null,head_sha:head,kind:'other',status:'completed',conclusion:'success',started_at:'2026-10-10T10:00:01.000Z',completed_at:null,terminal_interval:{lower_at:'2026-10-10T10:09:00.000Z',upper_at:'2026-10-10T10:10:00.000Z',basis:'native_job_completion_lower_and_terminal_update_upper_bounds'},...extra});

test('M1: an authenticated prior artifact does not select or republish the requested next period',async()=>{
  const next={start:window.end,end:'2026-10-12T00:00:00.000Z'},fake=nativeRequest();
  const r=await C.collectR9Measurement({request:fake.request,budget:U.createBudget({source:'app',cap:2000}),repository,window:next});
  assert.deepEqual(r.window,next);assert.equal(r.native.attempts.length,0);
  const rep={repository,window:next,metrics:{queue_depth_p95:{status:'not_measured',value:null}}};
  assert.equal(U.applyR9Metrics(rep,{repository,official_metric:true,window,metrics:{queue_depth_p95:{status:'measured',value:9,official_metric:true,source_authenticated:true}}}),false);
  assert.equal(rep.metrics.queue_depth_p95.value,null);
});
test('M2: complete supplied manifests cannot add a nonexistent Native attempt to the denominator',async()=>{
  const f=fourFrame([attemptRow(),attemptRow('999')]);assert.equal(F.readMergeAdmissionFourSources(f.frame.packet_raw,f.expected).candidate_ready,true);
  const fake=nativeRequest({artifact:zip(packet({fourSource:f.frame}))});
  const r=await C.collectR9Measurement({request:fake.request,budget:U.createBudget({source:'app',cap:2000}),repository,window,sourceContractRaw:selection(null,f.expected)});
  assert.equal(r.metrics.unclaimed_admitted.official_metric,false);assert.ok(r.gaps.includes('FOUR_SOURCE_NATIVE_POPULATION_MISMATCH'));
});
test('M2: a complete actually bound supplied frame has a promotion path, while a PR primary cannot hide as other',async()=>{
  const f=fourFrame([attemptRow()]),fake=nativeRequest({artifact:zip(packet({fourSource:f.frame}))});
  const r=await C.collectR9Measurement({request:fake.request,budget:U.createBudget({source:'app',cap:2000}),repository,window,sourceContractRaw:selection(null,f.expected)});
  assert.equal(r.metrics.unclaimed_admitted.official_metric,true);assert.equal(r.metrics.unclaimed_admitted.value,0);
  const file=Object.entries(parseWorkflowProfiles(f.p.proof_profiles_raw).workflows).find(([,p])=>p.primary_ids.length)?.[0];assert.ok(file);
  const native=await C.collectIncrementalNative({request:nativeRequest({runs:[run(42,{path:file,pull_requests:[{number:727}]})]}).request,repository,window});
  assert.equal(C.bindFourSourceNativePopulation(f.frame.packet_raw,native,f.expected).reason_code,'FOUR_SOURCE_NATIVE_KIND_MISMATCH');
});
test('M2: complete Native jobs and critical steps are bound, not just the matching run header',async()=>{
  const fake=nativeRequest(),n=await C.collectIncrementalNative({request:fake.request,repository,window}),f=fourFrame([attemptRow()]);
  const p=f.p,np=n.population_packets[0],wire=job();
  p.rounds=[{execution_packets:[{run_key:'42:1',workflow_file:C.R9_PUBLISHER_PATH,jobs:[wire],before_attempt:{run_id:'42',attempt:1,head_sha:head,status:'completed',conclusion:'success'},after_attempt:{run_id:'42',attempt:1,head_sha:head,status:'completed',conclusion:'success'}}]}];
  assert.equal(C.bindFourSourceNativePopulation(JSON.stringify(p),n,f.expected).complete,true);
  p.rounds[0].execution_packets[0].jobs[0].steps[0].conclusion='skipped';
  assert.equal(C.bindFourSourceNativePopulation(JSON.stringify(p),n,f.expected).reason_code,'FOUR_SOURCE_NATIVE_EXECUTION_JOBS_MISMATCH');
  assert.equal(np.jobs[0].steps[0].conclusion,'success');
});
test('M2: nullable cancellation and real outside-window reference closure retain their actual Native identity',async()=>{
  const fake=nativeRequest({runs:[run(42,{run_started_at:null,conclusion:'cancelled'})],jobs:[job(42,{started_at:null,completed_at:null,terminal_interval:{lower_at:'2026-10-10T10:00:01.000Z',upper_at:'2026-10-10T10:10:00.000Z',basis:'native_job_completion_lower_and_terminal_update_upper_bounds'},conclusion:'cancelled',steps:[]})]});
  const n=await C.collectIncrementalNative({request:fake.request,repository,window});
  const f=fourFrame([attemptRow('42',{started_at:null,completed_at:null,terminal_interval:{lower_at:'2026-10-10T10:00:01.000Z',upper_at:'2026-10-10T10:10:00.000Z',basis:'native_job_completion_lower_and_terminal_update_upper_bounds'},conclusion:'cancelled'})]);
  assert.equal(C.bindFourSourceNativePopulation(f.frame.packet_raw,n,f.expected).complete,true);
  assert.equal(JSON.parse(n.store_raw).packets['42:1'].jobs[0].completed_at,null);
  const normal=await C.collectIncrementalNative({request:nativeRequest().request,repository,window});
  const later=await C.collectIncrementalNative({request:nativeRequest().request,repository,window:{start:window.end,end:'2026-10-12T00:00:00.000Z'},authenticatedStoreRaw:normal.store_raw});
  assert.equal(C.bindFourSourceNativePopulation(fourFrame([attemptRow()]).frame.packet_raw,later,fourFrame([attemptRow()]).expected).complete,true);
});
test('M2: completion cohort is proved from bounds; crossing boundaries and unknown timestamps are not invented',async()=>{
  const n=await C.collectIncrementalNative({request:nativeRequest().request,repository,window}),p=n.population_packets[0];
  const m=C.nativeCompletionMembership(p,window);assert.equal(m.membership,'IN_WINDOW');assert.equal(m.exact_completed_at,null);
  assert.notEqual(m.lower_us,m.upper_us);
  const cut={start:'2026-10-10T10:09:30.000Z',end:window.end};assert.equal(C.nativeCompletionMembership(p,cut).membership,'UNKNOWN');
  const f=fourFrame([attemptRow()]);f.p.window=cut;
  assert.equal(C.bindFourSourceNativePopulation(JSON.stringify(f.p),n,f.expected).complete,true,'a real crossing interval stays bound data, not a forged point');
  const c=structuredClone(p);c.run.run_started_at=null;c.jobs[0].started_at=null;c.jobs[0].completed_at=null;
  const beforeStart={start:'2026-10-10T10:00:30.000Z',end:window.end};
  assert.equal(C.nativeCompletionMembership(c,beforeStart).membership,'UNKNOWN');assert.equal(c.jobs[0].completed_at,null);
});
test('M3: a self-consistent clock packet cannot choose another queue or period for an official metric',async()=>{
  const c=clockFrame({queue:'merge:other/repo:main',transport:false}),fake=nativeRequest({artifact:zip(packet({clock:c.clock}))});
  const r=await C.collectR9Measurement({request:fake.request,budget:U.createBudget({source:'app',cap:2000}),repository,window,sourceContractRaw:selection(c.pins)});
  assert.equal(r.metrics.queue_depth_p95.official_metric,false);
  const valid=clockFrame();assert.equal(C.bindClockSource(valid.clock,selection(valid.pins),repository,window).status,'TYPED_SOURCE_BOUND');
  const wrong={...window,end:'2026-10-11T01:00:00.000Z'};
  assert.equal(C.bindClockSource(valid.clock,selection(valid.pins,null,wrong),repository,wrong).status,'PARTIAL');
});
test('M3: matching authenticated publisher plus complete typed source metadata has an actual promotion path',async()=>{
  const c=clockFrame(),fake=nativeRequest({artifact:zip(packet({clock:c.clock}))});
  const r=await C.collectR9Measurement({request:fake.request,budget:U.createBudget({source:'app',cap:2000}),repository,window,sourceContractRaw:selection(c.pins)});
  assert.equal(r.metrics.queue_depth_p95.value,0);assert.equal(r.metrics.queue_depth_p95.official_metric,true);
  assert.equal(r.t0,null);assert.equal(r.natural_continuity,'NOT_ESTABLISHED');
  const rep={repository,window,metrics:{unclaimed_admitted:{status:'not_measured',value:null}}};
  assert.equal(U.applyR9Metrics(rep,r),true);assert.equal(rep.metrics.queue_depth_p95.value,0);assert.equal(rep.metrics.unclaimed_admitted.status,'not_measured');
  const bad=structuredClone(c.clock),raw=JSON.parse(bad.transport_raw);raw[0].server_auth.transport_definition_digest='f'.repeat(64);bad.transport_raw=JSON.stringify(raw);
  assert.equal(C.bindClockSource(bad,selection(c.pins),repository,window).status,'PARTIAL');
});
test('N1: outer independent Project must equal the complete expected and issued frame target',async()=>{
  const f=fourFrame([attemptRow()]),bad=JSON.parse(selection(null,f.expected));bad.scope.project_id='10000000-0000-4000-8000-000000000002';
  const r=await C.collectR9Measurement({request:nativeRequest({artifact:zip(packet({fourSource:f.frame}))}).request,budget:U.createBudget({source:'app',cap:2000}),repository,window,sourceContractRaw:JSON.stringify(bad)});
  assert.equal(r.metrics.unclaimed_admitted.official_metric,false);assert.ok(r.gaps.includes('INDEPENDENT_SOURCE_CONTRACT_MISSING_OR_INVALID'));
  const expected=JSON.parse(f.expected);expected.repository='other/repo';
  const n=await C.collectIncrementalNative({request:nativeRequest().request,repository,window});
  assert.equal(C.bindFourSourceNativePopulation(f.frame.packet_raw,n,JSON.stringify(expected)).complete,false);
});
test('N1: the same authenticated frame issuer cannot promote an incomplete source manifest as a full frame',async()=>{
  const f=fourFrame([attemptRow()]);f.p.populations.operations.before.total=1;f.frame.packet_raw=JSON.stringify(f.p);
  const fake=nativeRequest({artifact:zip(packet({fourSource:f.frame}))});
  const r=await C.collectR9Measurement({request:fake.request,budget:U.createBudget({source:'app',cap:2000}),repository,window,sourceContractRaw:selection(null,f.expected)});
  assert.equal(r.source_authenticated,true);assert.equal(r.native.population.complete,true);
  assert.equal(r.metrics.update_main_rounds.official_metric,false);assert.equal(r.metrics.update_main_rounds.value,null);
  assert.ok(r.gaps.includes('FOUR_SOURCE_SUPPLIED_POPULATION_INCOMPLETE'));
});
test('N2: a nullable cancelled completion before actual creation is contradictory, even within the same day',async()=>{
  const fake=nativeRequest({runs:[run(42,{run_started_at:null,conclusion:'cancelled'})],jobs:[job(42,{started_at:null,completed_at:null,terminal_interval:{lower_at:'2026-10-10T10:00:01.000Z',upper_at:'2026-10-10T10:10:00.000Z',basis:'native_job_completion_lower_and_terminal_update_upper_bounds'},conclusion:'cancelled',steps:[]})]});
  const n=await C.collectIncrementalNative({request:fake.request,repository,window});
  const f=fourFrame([attemptRow('42',{started_at:null,completed_at:'2026-10-10T05:00:00.000Z',conclusion:'cancelled'})]);
  assert.equal(C.bindFourSourceNativePopulation(f.frame.packet_raw,n,f.expected).complete,false);
  assert.equal(C.bindFourSourceNativePopulation(f.frame.packet_raw,n,f.expected).reason_code,'UNSOURCED_NATIVE_TERMINAL_POINT');
  f.p.attempts[0].completed_at='2026-10-10T10:00:02.000Z';f.seal();
  assert.equal(C.bindFourSourceNativePopulation(f.frame.packet_raw,n,f.expected).reason_code,'UNSOURCED_NATIVE_TERMINAL_POINT');
  f.p.attempts[0].completed_at=null;f.p.attempts[0].terminal_interval={lower_at:'2026-10-10T10:00:01.000Z',upper_at:'2026-10-10T10:10:00.000Z',basis:'native_job_completion_lower_and_terminal_update_upper_bounds'};
  f.seal();assert.equal(C.bindFourSourceNativePopulation(f.frame.packet_raw,n,f.expected).complete,true);
});
test('N3: fresh latest barrier must match the selected inventory, while captured old bytes are preserved',async()=>{
  const latest=run(42,{run_attempt:2,run_started_at:'2026-10-10T10:15:00Z',updated_at:'2026-10-10T10:20:00Z',conclusion:'cancelled'});
  const fake=nativeRequest({mutation:route=>route.endsWith('/actions/runs/42')?{ok:true,body:latest}:null});
  let stored=null;const r=await C.collectIncrementalNative({request:fake.request,repository,window,onStore:s=>{stored=s;}});
  assert.equal(r.status,'PARTIAL');assert.equal(r.reason_code,'NATIVE_CAPTURE_INVENTORY_BARRIER_MISMATCH');assert.equal(r.population.complete,false);
  assert.ok(JSON.parse(r.store_raw).packets['42:1']);assert.equal(stored,r.store_raw);assert.equal(r.fresh,1);
});
test('N3: a stable latest-2 inventory admits complete independent old and new ordinal captures',async()=>{
  const first=run(),latest=run(42,{run_attempt:2,run_started_at:'2026-10-10T10:15:00Z',updated_at:'2026-10-10T10:20:00Z',conclusion:'cancelled'});
  const second=job(42,{id:242,run_attempt:2,conclusion:'cancelled',created_at:'2026-10-10T10:15:01Z',started_at:'2026-10-10T10:15:02Z',completed_at:'2026-10-10T10:19:00Z',
    steps:[{number:1,name:'Measure CI usage',status:'completed',conclusion:'success',started_at:'2026-10-10T10:15:02Z',completed_at:'2026-10-10T10:19:00Z'}]});
  const fake=nativeRequest({runs:[latest],mutation:route=>{
    if(route.endsWith('/attempts/1'))return {ok:true,body:first};
    if(route.endsWith('/attempts/2'))return {ok:true,body:latest};
    if(route.includes('/attempts/1/jobs?'))return {ok:true,body:{total_count:1,jobs:[job()]}};
    if(route.includes('/attempts/2/jobs?'))return {ok:true,body:{total_count:1,jobs:[second]}};return null;
  }});
  const r=await C.collectIncrementalNative({request:fake.request,repository,window});
  assert.equal(r.status,'COMPLETE');assert.equal(r.population.complete,true);assert.equal(r.fresh,2);
  assert.deepEqual(Object.keys(JSON.parse(r.store_raw).packets),['42:1','42:2']);
});
function gapAdmissionFrame(){
  const f=fourFrame([attemptRow(),attemptRow('43',{pr_number:727,kind:'admission',conclusion:'cancelled'})]);
  const e=JSON.parse(f.expected),s=e.admission_sources[0],mainHead='b'.repeat(40),targetKey='43:1:727:'+head;
  const t=n=>'2026-10-10T10:'+n+'.000Z';
  const ep={schema:F.MERGE_ADMISSION_FOUR_SOURCE_PROTOCOL.admission_packet_schema,
    identity:{repository,pr_number:727,head_sha:head,run_id:'43',run_attempt:1,job_id:null,entry:'required',dispatch_reason:null,source_checkout_sha:head,
      native_pr:{number:727,head_sha:head,base_repository:repository,base_ref:'main',default_branch:'main',state:'open',draft:false},
      native_run:{id:43,run_attempt:1,event:'pull_request_target',path:s.workflow_path,head_sha:mainHead,head_branch:'main',pull_requests:[727],status:'in_progress',conclusion:null,run_started_at:null},native_job:null},
    timing:{decision_at:null,observed_at:t('00:04')},final_decision_observed:false,outcome:null,claim_observation:null,admit_step_outcome:null,selection_observation:null,app_observation:null};
  f.p.targets=[{run_id:'43',attempt:1,pr_number:727,head_sha:head,entry:'required',scope,selected_at:t('00:02')}];
  f.p.admission_batches=[{run_id:'43',attempt:1,entry:'required',scope,initial:{receipt_id:'initial.43',event_at:t('00:02'),collected_at:t('00:03'),target_keys:[targetKey]},selection_events:[],
    closing:{receipt_id:'closing.43',event_at:t('10:01'),collected_at:t('10:02'),status:'cancelled',target_keys:[targetKey]},ever_target_keys:[targetKey]}];
  f.p.admissions=[{target_key:targetKey,packet_raw:JSON.stringify(ep),collected_at:t('10:03')}];f.seal();
  const req=(artifact=null)=>nativeRequest({runs:[run(),run(43,{head_sha:mainHead,path:s.workflow_path,event:'pull_request_target',conclusion:'cancelled',pull_requests:[{number:727}]})],
    jobs:[job(),job(43,{name:'clued-work-admission',conclusion:'cancelled'})],...(artifact?{artifact}:{})});
  return {f,ep,req};
}
test('N4: a valid historical no-final GAP progresses from unknown to known start without faking a final',async()=>{
  const {f,ep,req}=gapAdmissionFrame();const p=F.readMergeAdmissionFourSources(f.frame.packet_raw,f.expected);
  assert.equal(p.candidate_ready,true);assert.equal(p.metrics.unclaimed_admitted.explicit_no_final_decision,1);
  const n=await C.collectIncrementalNative({request:req().request,repository,window});
  assert.equal(C.bindFourSourceNativePopulation(f.frame.packet_raw,n,f.expected).complete,true);
  const r=await C.collectR9Measurement({request:req(zip(packet({fourSource:f.frame}))).request,budget:U.createBudget({source:'app',cap:2000}),repository,window,sourceContractRaw:selection(null,f.expected)});
  assert.equal(r.metrics.unclaimed_admitted.official_metric,true);assert.equal(r.metrics.unclaimed_admitted.explicit_no_final_decision,1);
  assert.equal(r.metrics.cancellation_causes.denominator,1);assert.equal(r.metrics.cancellation_causes.value.UNKNOWN_CAUSE,1);
  assert.equal(r.t0,null);assert.equal(ep.final_decision_observed,false);
});
test('N4: known-known start conflict and a false FINAL keep the original strict start guard',async()=>{
  const {f,ep,req}=gapAdmissionFrame(),n=await C.collectIncrementalNative({request:req().request,repository,window});
  ep.identity.native_run.run_started_at='2026-10-10T10:00:02.000Z';f.p.admissions[0].packet_raw=JSON.stringify(ep);f.seal();
  assert.equal(C.bindFourSourceNativePopulation(f.frame.packet_raw,n,f.expected).reason_code,'FOUR_SOURCE_NATIVE_ADMISSION_IDENTITY_MISMATCH');
  ep.identity.native_run.run_started_at=null;ep.final_decision_observed=true;f.p.admissions[0].packet_raw=JSON.stringify(ep);f.seal();
  assert.equal(C.bindFourSourceNativePopulation(f.frame.packet_raw,n,f.expected).reason_code,'FOUR_SOURCE_NATIVE_ADMISSION_IDENTITY_MISMATCH');
});
// Yield n event-loop turns (no timer): the concurrency checks below only need the requests to overlap.
const turns=async n=>{for(let i=0;i<n;i++)await new Promise(resolve=>setImmediate(resolve));};
// M4 proves the checkout shape from the private mode, where the test file and its overrides sit outside the tree. In a
// checkout (CI) the run itself is that proof, so M4 is not registered there. The tree is the four roots copied whole, so a
// file a pull request adds, imported or read, is in it (board line 241).
const privateMode=Boolean(dependencies||process.env.CLUED_R9_TEST_REPO_ROOT)||path.resolve(here)!==path.resolve(repo,'scripts/ci');
if(privateMode)test('M4: default self-test loads a checkout-shaped tree without any private directory or override',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'clued-r9-checkout-'));
  try{
    for(const root of ['scripts/ci','scripts/runner','.github/workflows','config'])fs.cpSync(path.join(repo,root),path.join(temp,root),{recursive:true});
    for(const entry of fs.readdirSync(here,{withFileTypes:true}))if(entry.isFile())fs.copyFileSync(path.join(here,entry.name),path.join(temp,'scripts/ci',entry.name));
    const env={...process.env};delete env.CLUED_R9_TEST_DEPENDENCY_ROOT;delete env.CLUED_R9_TEST_REPO_ROOT;
    delete env.NODE_TEST_CONTEXT;
    const run=spawnSync(process.execPath,['--test','--test-reporter=tap','scripts/ci/merge-admission-r9-collector.test.mjs'],{cwd:temp,env,encoding:'utf8'});
    assert.equal(run.status,0,(run.stdout??'')+(run.stderr??''));assert.match(run.stdout,/# fail 0/);assert.doesNotMatch(run.stdout,/MODULE_NOT_FOUND/);
  }finally{if(!path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep))throw Error('TEMP_SCOPE_REFUSED');fs.rmSync(temp,{recursive:true,force:true});}
});

test('R6 actual caller exposes activity PARTIAL without blanketing independent Native and live clock',async()=>{
  const f=fourFrame([]),clock=clockFrame(),expected=JSON.parse(f.expected),
    descriptor={registration_status:'registered',workflow_path:'.github/workflows/clued-merge-slot-ci.yml',workflow_blob:'d'.repeat(40),job_id:'report',job_name:'clued-merge-slot-ci',source_paths:['scripts/ci/clued-merge-slot-ci.mjs'],required_steps:['Export','Upload']},
    coverage={schema:'clued.r9-finite-recorded-operation-coverage/1',epoch_id:'10000000-0000-4000-8000-000000000001',owner_receipt_id:'10000000-0000-4000-8000-000000000001',repository,scope,mode:'explicit_recorded_origins_during_this_epoch',original_source_paths:['scripts/ci/clued-merge-executor.mjs']},
    cfg={schema:'clued.r9-runtime-source-selection/1',registration_status:'registered',repository,scope,natural_producers:[descriptor],operation_coverage:coverage,forward_epoch:{epoch_id:coverage.epoch_id}},
    rawCfg=JSON.stringify(cfg),sourceSelection={repository,head_sha:head,default_branch:'main',natural_producers:[descriptor],profiles_raw:f.p.proof_profiles_raw,workflow_blobs:Object.fromEntries(f.p.execution_sources.entries.map(({workflow_file,workflow_blob})=>[workflow_file,workflow_blob]))},
    paths={script:'scripts/ci/clued-work-admission.mjs',workflow:'.github/workflows/clued-work-admission.yml',reverify_workflow:'.github/workflows/clued-work-admission-reverify.yml',policy:'config/merge-admission-policy.json'},
    texts=Object.fromEntries(Object.entries(paths).map(([k,relative])=>[k,fs.readFileSync(path.join(repo,relative),'utf8')])),
    runtime={source_contract_raw:selection(clock.pins,f.expected),forward_epoch:{epoch_id:coverage.epoch_id},operation_coverage:coverage,natural_selection:sourceSelection,
      proof_profiles_raw:f.p.proof_profiles_raw,role_specs_raw:f.p.role_specs_raw,execution_workflow_blobs:sourceSelection.workflow_blobs,
      admission_source_bytes:{[head]:{texts,...Object.fromEntries(['script','workflow','reverify_workflow','policy'].map(k=>[k+'_blob',expected.admission_sources[0][k+'_blob']]))}}};
  let registryReads=0;
  const fake=nativeRequest({runs:[],jobs:[],mutation:route=>{
    if(route.includes('/contents/scripts/ci/merge-admission-r9-source.json')){
      if(++registryReads>1)return {ok:false,stopped:'request_cap'};
      return {ok:true,body:{type:'file',path:'scripts/ci/merge-admission-r9-source.json',encoding:'base64',sha:workflowBlob(rawCfg),content:Buffer.from(rawCfg).toString('base64')}};}
    if(route.includes('/events?'))return {ok:true,body:[]};return null;
  }}),result=await C.collectR9Measurement({request:fake.request,budget:U.createBudget({source:'app',cap:2000}),repository,window,
    sourceContractRaw:runtime.source_contract_raw,naturalSelection:sourceSelection,runtimeInputs:runtime,liveClock:clock.clock});
  assert.equal(registryReads,1,'reuse the independent immutable registry captured with this contract head');
  assert.ok(!result.gaps.includes('INDEPENDENT_NATURAL_SOURCE_REGISTRY_NOT_ESTABLISHED'));
  assert.equal(result.native.status,'COMPLETE');assert.equal(result.activity_coverage.status,'PARTIAL');assert.equal(result.activity_coverage.delivery_through_window_end,'UNKNOWN');
  assert.equal(result.activity_coverage.closing_delivery_watermark,null);assert.equal(result.metrics.queue_depth_p95.official_metric,true);assert.equal(result.metrics.queue_depth_p95.value,0);
  assert.equal(result.metrics.update_main_rounds.official_metric,true);assert.equal(result.metrics.update_main_rounds.value,0);assert.equal(result.metrics.cancellation_causes.denominator,0);
  assert.equal(result.metrics.wasted_final_rounds.activity_coverage.delivery_through_window_end,'UNKNOWN');assert.equal(result.t0,null);
});

async function authenticatedConfigurationCollectorFixture(){
  const seeded=await C.collectIncrementalNative({request:nativeRequest().request,repository,window});assert.equal(seeded.status,'COMPLETE');
  const n=seeded.population_packets[0],c=contract(),script='scripts/ci/ci-usage-report.mjs',registryPath='scripts/ci/merge-admission-r9-source.json',tip='b'.repeat(40),
    profiles=JSON.stringify(c.profiles),roles=JSON.stringify(c.roles),key=digest(profiles)+':'+digest(roles),
    configuration={proof_profiles_raw:profiles,role_specs_raw:roles},snapshot={source_checkout_sha:tip,configuration_key:key,
      workflow_directory:[{path:C.R9_PUBLISHER_PATH,sha:blobs[C.R9_PUBLISHER_PATH],type:'blob',mode:'100644'}],
      main_history:{base_commit:tip,head_commit:head,merge_base_commit:tip,status:'ahead'}},
    descriptor={registration_status:'registered',workflow_path:C.R9_PUBLISHER_PATH,workflow_blob:blobs[C.R9_PUBLISHER_PATH],job_id:'report',
      job_name:'clued-ci-usage-report',source_paths:[script],source_blobs:{[script]:blobs[script]},required_steps:['Measure CI usage']},
    cfg={schema:'clued.r9-runtime-source-selection/1',registration_status:'registered',repository,scope,natural_producers:[descriptor]},rawCfg=JSON.stringify(cfg);
  const {createNaturalRecorder}=await import('./merge-admission-source-producer.mjs'),events=[],recorder=createNaturalRecorder({
    env:{GITHUB_REPOSITORY:repository,GITHUB_RUN_ID:'42',GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:'report',GITHUB_SHA:head},
    sourcePath:script,write:e=>events.push(e),now:()=>window.end});
  recorder.record('round_ci_observation',{scope,pr:{number:727,head:{sha:head}},seen:{state:'green',execution:{tip,native_runs:[n.run],
    observation_context:{changed_files:['README.md'],commits:1,default_branch:'main',workflow_files:[C.R9_PUBLISHER_PATH]}}}});recorder.finish();
  assert.equal(events.length,1);events[0].source.executed_checkout_sha=head;events[0].source.sha256=digest(content[script]);
  const entry={run_key:'42:1',job_id:'report',checkout_sha:head,artifact_digest:'sha256:'+'d'.repeat(64),packet_raw:JSON.stringify({events}),
    descriptor_digest:digest(JSON.stringify(descriptor)),native_run_digest:digest(JSON.stringify(n.run)),native_jobs_digest:digest(JSON.stringify(n.jobs)),execution_snapshot_tips:[tip]},
    naturalInputs={schema:'clued.r9-natural-origin-cache/1',status:'NATIVE_ORIGIN_BOUND',entries:[entry],gaps:[],source_bytes:{[head]:{texts:{}}},app_checks:{},
      execution_snapshots:{[tip]:snapshot},execution_configurations:{[key]:configuration},source_authenticated:true,official_metric:true},
    raw=packet({nativeStoreRaw:seeded.store_raw,sourceBlobs:{...blobs,[registryPath]:workflowBlob(rawCfg)},naturalInputs}),artifact=zip(raw),
    sourceSelection={repository,head_sha:head,default_branch:'main',natural_producers:[descriptor],execution_source_templates:[{
      source_checkout_sha:head,profiles_sha256:digest(profiles),role_specs_sha256:digest(roles)}],
      // Unauthenticated caller flags/tables cannot substitute for restored proof.
      source_authenticated:true,execution_snapshots:naturalInputs.execution_snapshots,execution_configurations:naturalInputs.execution_configurations};
  const fakeFor=refusal=>nativeRequest({artifact,jobs:[refusal==='publisher_job'?job(42,{steps:[]}):job()],mutation:route=>{
    if(route.includes('/contents/'+registryPath))return {ok:true,body:{type:'file',path:registryPath,encoding:'base64',
      sha:workflowBlob(rawCfg),content:Buffer.from(rawCfg).toString('base64')}};
    if(route.includes('/actions/runs/42/artifacts?'))return {ok:true,body:{total_count:0,artifacts:[]}};
    if(route.includes('/events?'))return {ok:true,body:[]};
    if(refusal==='platform_digest'&&route.endsWith('/actions/artifacts/9'))return {ok:true,body:{id:9,name:C.R9_ARTIFACT_NAME,expired:false,
      digest:'sha256:'+digest(Buffer.concat([artifact,Buffer.from('changed platform bytes')])),workflow_run:{id:42,head_sha:head,head_branch:'main'}}};
    return null;
  }}),collect=fake=>C.collectR9Measurement({request:fake.request,budget:U.createBudget({source:'app',cap:2000}),repository,window,
    sourceContractRaw:selection(),naturalSelection:sourceSelection});
  return {seeded,n,tip,key,configuration,snapshot,entry,naturalInputs,fakeFor,collect};
}

test('collector supplies shared execution snapshot/configuration tables only after the restored writer passes real sealed-artifact authentication',async()=>{
  const f=await authenticatedConfigurationCollectorFixture(),fake=f.fakeFor(),r=await f.collect(fake);
  assert.equal(r.source_proof?.kind,'NATIVE_ARTIFACT_DIGEST_DEFAULTBRANCH_REGISTERED_SOURCE_ROLE');assert.equal(r.native.status,'COMPLETE');assert.equal(r.native.from_sealed,1);
  assert.equal(r.natural_inputs.status,'NATIVE_ORIGIN_BOUND',JSON.stringify(r.natural_inputs.gaps));assert.deepEqual(r.natural_inputs.execution_snapshots,{[f.tip]:f.snapshot});
  assert.deepEqual(r.natural_inputs.execution_configurations,{[f.key]:f.configuration});assert.equal(r.natural_inputs.entries.length,1);
  assert.deepEqual(r.natural_inputs.entries[0].execution_snapshot_tips,[f.tip]);assert.equal(Object.hasOwn(r.natural_inputs.entries[0],'execution_snapshots'),false);
  assert.equal(fake.routes.filter(route=>route.includes('/jobs?')).length,2,'the writer still needs the complete Native job barrier');
  assert.equal(fake.routes.some(route=>route.includes('/actions/runs/42/artifacts?')),false,'authenticated exact entry reuse does not reread a producer artifact');
  assert.equal(fake.routes.some(route=>route.includes(f.tip)),false,'shared authenticated history does not trigger tree/source/ancestry reads');
  assert.deepEqual(r.native.population_packets,[f.n]);assert.equal(r.natural_inputs.source_authenticated,false);assert.equal(r.natural_inputs.official_metric,false);
  assert.equal(r.official_metric,false);assert.equal(r.t0,null);
});

test('collector rejects caller-authority shared tables when platform digest or the actual publisher job cannot authenticate the restored writer',async()=>{
  const f=await authenticatedConfigurationCollectorFixture();
  for(const [refusal,reason]of [['platform_digest','ARTIFACT_DIGEST_MISMATCH'],['publisher_job','USAGE_PUBLISHER_EXECUTION_INCOMPLETE']]){
    const fake=f.fakeFor(refusal),r=await f.collect(fake);assert.ok(r.gaps.includes(reason),refusal);assert.equal(r.source_proof,null,refusal);
    assert.equal(r.native.status,'COMPLETE',refusal);assert.equal(r.native.population_packets.length,1,refusal);
    assert.equal(r.natural_inputs.status,'PARTIAL',refusal);assert.equal(r.natural_inputs.entries.length,0,refusal);
    assert.deepEqual(r.natural_inputs.execution_snapshots,{},refusal);assert.deepEqual(r.natural_inputs.execution_configurations,{},refusal);
    assert.equal(r.source_authenticated,false,refusal);assert.equal(r.official_metric,false,refusal);assert.equal(r.t0,null,refusal);
  }
});

test('same-source main advance needs the complete independent source bytes, not a matching flag',()=>{
  const profiles=serializeWorkflowProfiles({schema:'clued.gated-proof-profiles/2',workflows:{}}),roles=JSON.stringify({roles:[]}),path='.github/workflows/clued-work-admission.yml',wf='b'.repeat(40),
    admission=Object.fromEntries(['script','workflow','reverify_workflow','policy'].flatMap(k=>[[k+'_path','source/'+k],[k+'_blob','a'.repeat(40)]])),
    cfg={admission_source:admission,execution_source:{profiles_sha256:digest(profiles),role_specs_sha256:digest(roles)},natural_producers:[{workflow_path:path,workflow_blob:wf,source_blobs:{[path]:wf}}]},
    selection={admission_source:admission,workflow_blobs:{[path]:wf}},runtime={proof_profiles_raw:profiles,role_specs_raw:roles},
    contract={profiles:parseWorkflowProfiles(profiles),roles:JSON.parse(roles),profiles_sha256:digest(profiles),role_specs_sha256:digest(roles),
      source_tree:Object.fromEntries(['source/script','source/workflow','source/reverify_workflow','source/policy',path].map(p=>[p,{sha:p===path?wf:'a'.repeat(40),type:'blob',mode:'100644'}]))};
  assert.equal(C.sameNaturalSourceSnapshot(cfg,selection,runtime,contract),true);
  assert.equal(C.sameNaturalSourceSnapshot(cfg,{...selection,admission_source:{script_blob:'c'.repeat(40)}},runtime,contract),false);
  assert.equal(C.sameNaturalSourceSnapshot(cfg,{...selection,workflow_blobs:{[path]:'c'.repeat(40)}},runtime,contract),false);
  assert.equal(C.sameNaturalSourceSnapshot(cfg,selection,runtime,{...contract,roles:{roles:['changed']}}),false);
  assert.equal(C.sameNaturalSourceSnapshot({...cfg,admission_source:null},{...selection,admission_source:null},runtime,contract),false);
  assert.equal(C.sameNaturalSourceSnapshot(cfg,selection,runtime,{...contract,profiles_sha256:digest('{"workflows": {}}')}),false);
  assert.equal(C.sameNaturalSourceSnapshot(cfg,selection,runtime,{...contract,source_tree:{...contract.source_tree,'source/script':{sha:'c'.repeat(40),type:'blob',mode:'100644'}}}),false);
  assert.equal(C.sameNaturalSourceSnapshot(cfg,selection,runtime,{...contract,source_tree:{...contract.source_tree,[path]:{sha:wf,type:'blob',mode:'120000'}}}),false);
  assert.equal(C.sameNaturalSourceSnapshot({...cfg,natural_producers:[...cfg.natural_producers,{workflow_path:path,workflow_blob:wf,source_blobs:{[path]:'c'.repeat(40)}}]},selection,runtime,contract),false);
});

test('source equivalence cannot replace raw profile/role digest pins with reformatted or malformed bytes',()=>{
  const semantic={schema:'clued.gated-proof-profiles/2',workflows:{}},roles='{"roles":[]}',
    admission=Object.fromEntries(['script','workflow','reverify_workflow','policy'].flatMap(k=>[[k+'_path','source/'+k],[k+'_blob','a'.repeat(40)]]));
  for(const profiles of [JSON.stringify(semantic),serializeWorkflowProfiles(semantic)]){
    const cfg={admission_source:admission,execution_source:{profiles_sha256:digest(profiles),role_specs_sha256:digest(roles)},natural_producers:[]},
      selection={admission_source:admission,workflow_blobs:{}},runtime={proof_profiles_raw:profiles,role_specs_raw:roles},
      contract={profiles:parseWorkflowProfiles(profiles),roles:JSON.parse(roles),profiles_sha256:digest(profiles),role_specs_sha256:digest(roles),
        source_tree:Object.fromEntries(['script','workflow','reverify_workflow','policy'].map(k=>['source/'+k,{sha:'a'.repeat(40),type:'blob',mode:'100644'}]))};
    assert.equal(C.sameNaturalSourceSnapshot(cfg,selection,runtime,contract),true,'the exact valid /2 or /3 baseline must qualify');
    const reformatted=profiles+' ';
    assert.deepEqual(JSON.parse(reformatted),JSON.parse(profiles),'raw difference preserves the JSON value');
    assert.equal(C.sameNaturalSourceSnapshot(cfg,selection,{...runtime,proof_profiles_raw:reformatted},contract),false);
    assert.equal(C.sameNaturalSourceSnapshot(cfg,selection,{...runtime,role_specs_raw:'{"roles": []}'},contract),false);
    assert.equal(C.sameNaturalSourceSnapshot(cfg,selection,{...runtime,proof_profiles_raw:'not-json'},contract),false);
  }
});

test('bounded parallel Native captures retain every member under the same request function',async()=>{
  const runs=Array.from({length:7},(_,i)=>({id:426-i,run_attempt:1,workflow_id:8,head_sha:'a'.repeat(40),path:'.github/workflows/test.yml',event:'pull_request',status:'completed',conclusion:'success',
    created_at:'2026-10-09T00:00:01Z',run_started_at:'2026-10-09T00:00:02Z',updated_at:'2026-10-09T00:00:05Z',pull_requests:[]}));
  let active=0,maximum=0,calls=0;
  const request=async route=>{calls++;active++;maximum=Math.max(maximum,active);await turns(2);active--;
    const u=new URL(route,'https://native.invalid');
    if(u.pathname.endsWith('/actions/runs'))return {ok:true,body:{total_count:runs.length,workflow_runs:structuredClone(runs)}};
    const id=Number(u.pathname.match(/\/runs\/(\d+)/)?.[1]),r=runs.find(x=>x.id===id);assert.ok(r);
    if(u.pathname.endsWith('/jobs'))return {ok:true,body:{total_count:1,jobs:[{id:1000+id,run_id:id,run_attempt:1,name:'test',status:'completed',conclusion:'success',
      created_at:'2026-10-09T00:00:02Z',started_at:'2026-10-09T00:00:03Z',completed_at:'2026-10-09T00:00:04Z',labels:['ubuntu-slim'],steps:[]}]}};
    return {ok:true,body:structuredClone(r)};
  };
  const result=await C.collectIncrementalNative({request,repository,window:{start:'2026-10-09T00:00:00Z',end:'2026-10-09T00:00:10Z'}});
  assert.equal(result.status,'COMPLETE');assert.equal(result.population_packets.length,7);assert.equal(Object.keys(JSON.parse(result.store_raw).packets).length,7);
  assert.ok(maximum>1);assert.ok(maximum<=4);assert.equal(calls,44);assert.equal(result.population.complete,true);
});

test('a failed directory page drains its existing batch before another stage can spend requests',async()=>{
  const rows=Array.from({length:500},(_,i)=>run(1199-i));let active=0,maximum=0;
  const request=async route=>{const page=Number(new URL(route,'https://native.invalid').searchParams.get('page'));
    if(page===1)return {ok:true,body:{total_count:500,workflow_runs:rows.slice(0,100)}};
    active++;maximum=Math.max(maximum,active);await turns(page===2?1:10);active--;
    if(page===2)throw Error('HTTP_PAGE_FAILED');return {ok:true,body:{total_count:500,workflow_runs:rows.slice((page-1)*100,page*100)}};
  };
  const result=await C.collectIncrementalNative({request,repository,window});
  assert.equal(result.status,'PARTIAL');assert.equal(result.reason_code,'HTTP_PAGE_FAILED');assert.equal(active,0);assert.equal(maximum,4);
});

const Native=await import('./merge-admission-native-population.mjs');
const projectionRoot='/repos/'+repository+'/actions/runs/38280673705';
function wireProjectionFixture({attemptCreated='2026-10-12T16:54:45Z',jobConclusion='cancelled',jobEnded='2026-10-12T16:55:27Z',skipSteps=[],mutateAfter=false}={}){
  const run={id:38280673705,run_attempt:1,workflow_id:123,head_sha:'a'.repeat(40),path:'.github/workflows/clued-merge-slot-ci.yml',event:'workflow_run',status:'completed',conclusion:'cancelled',created_at:'2026-10-12T16:54:44Z',run_started_at:'2026-10-12T16:54:44Z',updated_at:'2026-10-12T16:55:28Z',pull_requests:[]};
  const jobs=[{id:114916915569,run_id:run.id,run_attempt:1,name:'clued-merge-slot-ci',status:'completed',conclusion:jobConclusion,created_at:'2026-10-12T16:54:45Z',started_at:'2026-10-12T16:54:45Z',completed_at:jobEnded,labels:['ubuntu-slim'],steps:skipSteps}];
  let attempts=0;
  return {async request(route){if(route===projectionRoot)return {ok:true,body:structuredClone(run)};
    if(route===projectionRoot+'/attempts/1'){attempts++;return {ok:true,body:{...structuredClone(run),created_at:mutateAfter&&attempts>1?'2026-10-12T16:54:46Z':attemptCreated}};}
    if(route.startsWith(projectionRoot+'/attempts/1/jobs?'))return {ok:true,body:{total_count:jobs.length,jobs:structuredClone(jobs)}};
    throw Error('unexpected diagnostic route');}};
}
test('actual attempt DTO creation does not replace original Native run identity',async()=>{
  const f=wireProjectionFixture(),r=await Native.captureNativeAttempt({request:f.request,repository,runId:'38280673705',attempt:1});
  assert.equal(r.status,'COMPLETE');assert.equal(r.packet.run.created_at,'2026-10-12T16:54:44.000Z');
  assert.equal(r.packet.timing_basis.reported_attempt_created_at,'2026-10-12T16:54:45.000Z');
  assert.equal(r.packet.run.conclusion,'cancelled');assert.equal(Native.inspectNativePopulationStore(r.store_raw).status,'VALID_DATA_STORE');
});
test('no-op skipped scheduler timestamps are retained as metadata, never execution',async()=>{
  const f=wireProjectionFixture({jobConclusion:'skipped',jobEnded:'2026-10-12T16:54:44Z'}),r=await Native.captureNativeAttempt({request:f.request,repository,runId:'38280673705',attempt:1});
  assert.equal(r.status,'COMPLETE');assert.equal(r.packet.jobs[0].conclusion,'skipped');
  assert.equal(r.packet.jobs[0].completed_at,'2026-10-12T16:54:44.000Z');assert.deepEqual(r.packet.jobs[0].steps,[]);
});
test('cancelled or successful execution retains the original contradictory-time rejection',async()=>{
  for(const conclusion of ['cancelled','success']){
    const f=wireProjectionFixture({jobConclusion:conclusion,jobEnded:'2026-10-12T16:54:44Z',skipSteps:[{number:1,name:'actual execution',status:'completed',conclusion:'success',started_at:'2026-10-12T16:54:45Z',completed_at:'2026-10-12T16:54:45Z'}]}),r=await Native.captureNativeAttempt({request:f.request,repository,runId:'38280673705',attempt:1});
    assert.equal(r.status,'PARTIAL');assert.equal(r.reason_code,'invalid_native_job_time');
  }
});
test('skipped label with execution steps cannot bypass execution chronology',async()=>{
  const f=wireProjectionFixture({jobConclusion:'skipped',jobEnded:'2026-10-12T16:54:44Z',skipSteps:[{number:1,name:'untrusted execution',status:'completed',conclusion:'success',started_at:'2026-10-12T16:54:45Z',completed_at:'2026-10-12T16:54:46Z'}]}),r=await Native.captureNativeAttempt({request:f.request,repository,runId:'38280673705',attempt:1});
  assert.equal(r.status,'PARTIAL');assert.equal(r.reason_code,'invalid_native_job_time');
});
test('attempt creation metadata changing between independent reads is rejected',async()=>{
  const f=wireProjectionFixture({mutateAfter:true}),r=await Native.captureNativeAttempt({request:f.request,repository,runId:'38280673705',attempt:1});
  assert.equal(r.status,'PARTIAL');assert.equal(r.reason_code,'native_attempt_reported_creation_changed');
});

test('late no-step skipped projections preserve timestamps beyond the run update',async()=>{
  const r=run(38284356268,{created_at:'2026-10-12T17:27:45Z',run_started_at:'2026-10-12T17:27:45Z',updated_at:'2026-10-12T17:27:46Z',conclusion:'skipped'});
  const j=job(r.id,{id:114929091627,name:'public-mcp-gate-receipt-evaluate',conclusion:'skipped',created_at:'2026-10-12T17:27:55Z',started_at:'2026-10-12T17:27:55Z',completed_at:'2026-10-12T17:27:46Z',steps:[]});
  const f=nativeRequest({runs:[r],jobs:[j]}),n=await Native.captureNativeAttempt({request:f.request,repository,runId:String(r.id),attempt:1});
  assert.equal(n.status,'COMPLETE');assert.equal(n.packet.jobs[0].created_at,'2026-10-12T17:27:55.000Z');
  assert.equal(C.nativeCompletionMembership(n.packet,{start:'2026-10-12T17:27:00Z',end:'2026-10-12T17:28:00Z'}).membership,'IN_WINDOW');
  assert.equal(Native.inspectNativePopulationStore(n.store_raw).status,'VALID_DATA_STORE');
});

test('Native check-only rows added after a workflow preserve metadata without extending execution',async()=>{
  const r=run(38280832886,{created_at:'2026-10-12T16:56:07Z',run_started_at:'2026-10-12T16:56:07Z',updated_at:'2026-10-12T16:56:50Z'}),
    j=job(r.id,{id:114921378190,name:'public-mcp-gate-receipt-verdict',created_at:'2026-10-12T17:06:46Z',started_at:'2026-10-12T17:06:46Z',completed_at:'2026-10-12T17:06:46Z',labels:[],steps:[],html_url:'https://github.com/'+repository+'/runs/114921378190'});
  const f=nativeRequest({runs:[r],jobs:[j]}),n=await Native.captureNativeAttempt({request:f.request,repository,runId:String(r.id),attempt:1});
  assert.equal(n.status,'COMPLETE');assert.equal(n.packet.jobs[0].reported_check_url,j.html_url);
  assert.equal(Native.nativeJobIsNonExecution(n.packet.jobs[0]),true);assert.equal(Native.inspectNativePopulationStore(n.store_raw).status,'VALID_DATA_STORE');
  assert.equal(C.nativeCompletionMembership(n.packet,{start:'2026-10-12T16:56:00Z',end:'2026-10-12T17:00:00Z'}).membership,'IN_WINDOW');
  for(const change of [{html_url:'https://github.com/other/repo/runs/114921378190'},{labels:['ubuntu-latest']},{steps:[{number:1,name:'actual work',status:'completed',conclusion:'success',started_at:j.started_at,completed_at:j.completed_at}]},{completed_at:'2026-10-12T17:06:47Z'}]){
    const bad=nativeRequest({runs:[r],jobs:[{...j,...change}]}),q=await Native.captureNativeAttempt({request:bad.request,repository,runId:String(r.id),attempt:1});
    assert.equal(q.status,'PARTIAL');
  }
});

function uncappedDirectoryFixture({grow=true,remove=false,ascending=false,createdInversion=false,replaced=false}={}){
  const old=Array.from({length:250},(_,i)=>run(250-i,{created_at:'2026-10-09T00:00:00Z',run_started_at:'2026-10-09T00:00:01Z',updated_at:'2026-10-09T00:01:00Z'}));
  const fresh=Array.from({length:3},(_,i)=>run(500-i,{created_at:'2026-10-12T00:00:00Z',run_started_at:'2026-10-12T00:00:01Z',updated_at:'2026-10-12T00:01:00Z'}));
  let changed=false,calls=0,active=0,max=0;
  return {get calls(){return calls;},get max(){return max;},async request(route){
    const u=new URL(route,'https://native.invalid');assert.equal(u.pathname,'/repos/'+repository+'/actions/runs');assert.equal(u.searchParams.has('created'),false);
    const page=Number(u.searchParams.get('page'));calls++;active++;max=Math.max(max,active);await turns(2);active--;
    if(page>1)changed=true;let rows=changed?(remove?old.slice(1):replaced?[fresh[0],...old.slice(1)]:grow?[...fresh,...old]:old):old;
    if(createdInversion)rows=rows.map((r,i)=>i===106?{...r,created_at:'2026-10-09T00:00:01Z',run_started_at:'2026-10-09T00:00:02Z'}:r);
    if(ascending)rows=[...rows].reverse().map((r,i)=>({...r,created_at:i?'2026-10-09T00:00:01Z':'2026-10-09T00:00:00Z',run_started_at:'2026-10-09T00:00:02Z'}));
    return {ok:true,body:{total_count:rows.length,workflow_runs:rows.slice((page-1)*100,page*100)}};
  }};
}

async function directoryProgressFixture({stop=false,unsafe=null,initialFailure=null}={}){
  const existing=run(42),seed=N.emptyNativePopulationStore(repository),old=nativeRequest({runs:[existing]}),
    captured=await N.captureNativeAttempt({request:old.request,repository,runId:'42',attempt:1,storeRaw:seed});
  assert.equal(captured.status,'COMPLETE');
  const missing=run(43),before=run(999,{created_at:'2026-10-10T23:00:00Z',run_started_at:'2026-10-10T23:00:01Z',
    updated_at:'2026-10-10T23:10:00Z',conclusion:'failure'}),after={...before,run_attempt:2,status:'queued',conclusion:null,
    run_started_at:'2026-10-11T00:01:00Z',updated_at:'2026-10-11T00:01:01Z'},
    quiet=Array.from({length:99},(_,i)=>run(100+i,{created_at:'2026-10-09T00:00:00Z',run_started_at:'2026-10-09T00:00:01Z',updated_at:'2026-10-09T00:01:00Z'})),
    lateJob=job(999,{created_at:'2026-10-10T23:00:01Z',started_at:'2026-10-10T23:00:02Z',completed_at:'2026-10-10T23:09:00Z',conclusion:'failure',
      steps:[{number:1,name:'Measure CI usage',status:'completed',conclusion:'failure',started_at:'2026-10-10T23:00:02Z',completed_at:'2026-10-10T23:09:00Z'}]}),
    actualMissing=unsafe==='identity'?{...missing,head_sha:'b'.repeat(40)}:missing,
    actualJob=unsafe==='job_owner_conflict'?job(43,{id:142}):job(43);
  let directoryReads=0;
  const fake=nativeRequest({runs:[existing,actualMissing,after],jobs:[job(42),actualJob,lateJob],artifact:zip(packet({nativeStoreRaw:captured.store_raw})),mutation:route=>{
    if(route.includes('/actions/runs?')){
      directoryReads++;const page=Number(new URL(route,'https://native.invalid').searchParams.get('page'));
      if(initialFailure==='budget'&&page===2)return {ok:false,stopped:'time_budget'};
      const current=directoryReads===3?after:before,rows=[current,...quiet.slice().reverse(),missing,existing];
      if(initialFailure==='order'&&page===1)rows.reverse();
      return {ok:true,body:{total_count:rows.length,workflow_runs:rows.slice((page-1)*100,page*100)}};
    }
    if(stop&&route.endsWith('/actions/runs/999'))return {ok:false,stopped:'request_cap'};
    if(route.endsWith('/actions/runs/999/attempts/1'))return {ok:true,body:before};
    return null;
  }});
  return {...fake,store_raw:captured.store_raw,get directoryReads(){return directoryReads;}};
}

test('typed initial ordinal conflict salvages only independently complete missing packets and keeps the directory refusal',async()=>{
  const f=await directoryProgressFixture(),saved=[],result=await C.collectIncrementalNative({request:f.request,repository,window,
    authenticatedStoreRaw:f.store_raw,onStore:raw=>saved.push(raw)}),progress=result.population.directory_progress;
  assert.equal(result.status,'PARTIAL');assert.equal(result.reason_code,'NATIVE_INVENTORY_BOUNDARY_CHANGED');
  assert.equal(result.inventory_conflict.run_id,'999');assert.equal(result.inventory_conflict.stage,'CLOSING_DIRECTORY_HEAD');
  assert.ok(result.inventory_conflict.changed_fields.includes('run_attempt'));
  assert.equal(result.population.initial_total,null);assert.equal(result.population.closing_total,null);assert.equal(result.population.complete,false);
  assert.equal(result.fresh,2);assert.equal(result.from_sealed,0);assert.equal(f.directoryReads,3);assert.equal(f.routes.length,15);
  assert.equal(saved.length,1);assert.equal(saved[0],result.store_raw);
  const store=JSON.parse(result.store_raw);assert.ok(store.packets['43:1']);assert.ok(store.packets['999:1']);
  assert.deepEqual(store.packets['42:1'],JSON.parse(f.store_raw).packets['42:1']);
  assert.ok(!f.routes.some(route=>route.endsWith('/actions/runs/42')));
  assert.deepEqual(f.routes.filter(route=>route.endsWith('/actions/runs/43')||route.endsWith('/actions/runs/999')).slice(0,2),
    ['/repos/'+repository+'/actions/runs/43','/repos/'+repository+'/actions/runs/999']);
  assert.equal(progress.inventory_closed,false);assert.equal(progress.before_packet_count,1);assert.equal(progress.after_packet_count,3);
  assert.equal(progress.new_packet_keys_count,2);assert.deepEqual(progress.new_packet_key_samples,['43:1','999:1']);
  assert.equal(progress.existing_packet_attempts_preserved,1);assert.equal(progress.missing_attempt_capture_requests,2);
  assert.equal(result.population.cache_reuse_diagnostics.reason_counts.EXACT_SEALED_HEADER_REUSE,0);
  assert.equal(N.inspectNativePopulationStore(result.store_raw,repository).status,'VALID_DATA_STORE');
});
test('salvage budget refusal retains the completed sibling packet and never replaces the original directory conflict',async()=>{
  const f=await directoryProgressFixture({stop:true}),saved=[],result=await C.collectIncrementalNative({request:f.request,repository,window,
    authenticatedStoreRaw:f.store_raw,onStore:raw=>saved.push(raw)});
  assert.equal(result.status,'PARTIAL');assert.equal(result.reason_code,'NATIVE_INVENTORY_BOUNDARY_CHANGED');
  assert.equal(result.inventory_conflict.run_id,'999');assert.equal(result.population.complete,false);
  assert.ok(JSON.parse(result.store_raw).packets['43:1']);assert.ok(!JSON.parse(result.store_raw).packets['999:1']);
  assert.equal(saved.at(-1),result.store_raw);assert.equal(result.population.directory_progress.new_packet_keys_count,1);
  assert.equal(result.population.directory_progress.stop_reason_code,'NATIVE_CAPTURE_BUDGET_PARTIAL');
  assert.equal(f.routes.filter(route=>route.endsWith('/actions/runs/999')).length,1);assert.equal(f.directoryReads,3);
});
test('salvage rejects a changed fixed identity and a packet conflicting with an existing Native job owner',async()=>{
  for(const unsafe of ['identity','job_owner_conflict']){
    const f=await directoryProgressFixture({unsafe}),result=await C.collectIncrementalNative({request:f.request,repository,window,authenticatedStoreRaw:f.store_raw}),
      store=JSON.parse(result.store_raw);
    assert.equal(result.status,'PARTIAL');assert.equal(result.reason_code,'NATIVE_INVENTORY_BOUNDARY_CHANGED');
    assert.equal(result.population.complete,false);assert.ok(!store.packets['43:1']);assert.ok(store.packets['999:1']);
    assert.deepEqual(store.packets['42:1'],JSON.parse(f.store_raw).packets['42:1']);
    assert.ok(result.gaps.some(g=>g.key==='43:1'&&g.reason_code===(unsafe==='identity'?'NATIVE_PROGRESS_OBSERVATION_IDENTITY_CHANGED':'duplicate_native_job_identity')));
    assert.equal(result.population.directory_progress.new_packet_keys_count,1);
    assert.equal(N.inspectNativePopulationStore(result.store_raw,repository).status,'VALID_DATA_STORE');
  }
});
test('untyped initial pagination and budget failures start no salvage or extra capture requests',async()=>{
  for(const initialFailure of ['order','budget']){
    const f=await directoryProgressFixture({initialFailure}),result=await C.collectIncrementalNative({request:f.request,repository,window,authenticatedStoreRaw:f.store_raw});
    assert.equal(result.status,'PARTIAL');assert.equal(result.population.complete,false);assert.equal(result.fresh,0);
    assert.equal(Object.hasOwn(result.population,'directory_progress'),false);
    assert.ok(f.routes.every(route=>route.includes('/actions/runs?')));
    assert.equal(f.routes.length,initialFailure==='order'?1:2);assert.deepEqual(JSON.parse(result.store_raw),JSON.parse(f.store_raw));
  }
});
test('existing R9 wrapper seals salvaged Native progress while preserving partial source readiness and null T0',async()=>{
  const f=await directoryProgressFixture(),result=await C.collectR9Measurement({request:f.request,budget:U.createBudget({source:'app',cap:2000}),
    repository,window,sourceContractRaw:selection()});
  assert.equal(result.source_authenticated,true);assert.equal(result.status,'partial');assert.equal(result.t0,null);
  assert.equal(result.native.status,'PARTIAL');assert.equal(result.native.population.complete,false);assert.equal(result.source_readiness.complete,false);
  const next=N.inspectNativePopulationStore(result.next_native_store_raw,repository);
  assert.equal(next.status,'VALID_DATA_STORE');assert.ok(next.packets['43:1']);assert.ok(next.packets['999:1']);
  assert.equal(f.directoryReads,3);assert.doesNotThrow(()=>packet({nativeStoreRaw:result.next_native_store_raw}));
});

test('uncapped directory closes all historical members despite a growing post-window prefix',async()=>{
  const f=uncappedDirectoryFixture(),r=await C.collectIncrementalNative({request:f.request,repository,window});
  assert.equal(r.status,'COMPLETE');assert.equal(r.population.initial_total,250);assert.equal(r.population.closing_total,250);
  assert.equal(r.population.complete,true);assert.equal(r.fresh,0);assert.equal(f.calls,8);assert.ok(f.max<=4);
});

function advancingPostWindowPrefix(change={}){
  const old=Array.from({length:250},(_,i)=>run(250-i,{created_at:'2026-10-09T00:00:00Z',run_started_at:'2026-10-09T00:00:01Z',updated_at:'2026-10-09T00:01:00Z'}));
  const outside=run(500,{created_at:window.end,run_started_at:null,updated_at:'2026-10-11T00:00:00.001Z',status:'queued',conclusion:null});
  let calls=0;
  return {get calls(){return calls;},async request(route){
    const url=new URL(route,'https://native.invalid'),page=Number(url.searchParams.get('page'));
    assert.equal(url.pathname,'/repos/'+repository+'/actions/runs');assert.equal(url.searchParams.has('created'),false);
    const latest=++calls===1?outside:{...outside,status:'completed',conclusion:'success',run_started_at:'2026-10-11T00:00:01Z',updated_at:'2026-10-11T00:00:02Z',...change};
    const rows=[latest,...old];return {ok:true,body:{total_count:rows.length,workflow_runs:rows.slice((page-1)*100,page*100)}};
  }};
}

test('post-close queued work may start and finish without changing the fixed window denominator',async()=>{
  const f=advancingPostWindowPrefix(),r=await C.collectIncrementalNative({request:f.request,repository,window});
  assert.equal(r.status,'COMPLETE');assert.equal(r.population.complete,true);
  assert.equal(r.population.initial_total,250);assert.equal(r.population.closing_total,250);
  assert.equal(r.fresh,0);assert.equal(f.calls,8);
});

test('post-close progress allowance cannot hide changed identity, ordinal, creation or regressed time',async()=>{
  for(const change of [{head_sha:'d'.repeat(40)},{run_attempt:2},{workflow_id:8},{event:'workflow_dispatch'},
    {pull_requests:[{number:727}]},{created_at:'2026-10-10T23:59:59Z'},{updated_at:'2026-10-11T00:00:00Z',run_started_at:null}]){
    const f=advancingPostWindowPrefix(change),r=await C.collectIncrementalNative({request:f.request,repository,window});
    assert.equal(r.status,'PARTIAL');assert.equal(r.population.complete,false);
  }
});

test('a refused directory head identity change reports bounded public conflict fields',async()=>{
  const f=advancingPostWindowPrefix({head_sha:'d'.repeat(40)}),r=await C.collectIncrementalNative({request:f.request,repository,window});
  assert.equal(r.status,'PARTIAL');assert.equal(r.reason_code,'NATIVE_INVENTORY_BOUNDARY_CHANGED');
  assert.equal(r.inventory_conflict.run_id,'500');assert.equal(r.inventory_conflict.stage,'CLOSING_DIRECTORY_HEAD');
  assert.ok(r.inventory_conflict.changed_fields.includes('head_sha'));
  assert.deepEqual(Object.keys(r.inventory_conflict).sort(),['after','before','changed_fields','run_id','stage']);
  assert.deepEqual(Object.keys(r.inventory_conflict.before).sort(),['conclusion','created_at','run_attempt','run_started_at','status','updated_at']);
  assert.equal(r.inventory_conflict.before.status,'queued');assert.equal(r.inventory_conflict.after.status,'completed');
  assert.equal(r.population.complete,false);
});

test('conflict diagnostics never echo an unvalidated Native conclusion',async()=>{
  for(const conclusion of [{private:'untrusted-body'},'https://untrusted.invalid/'+('x'.repeat(4000)),17]){
    const f=advancingPostWindowPrefix({head_sha:'d'.repeat(40),conclusion}),r=await C.collectIncrementalNative({request:f.request,repository,window});
    assert.equal(r.status,'PARTIAL');assert.equal(r.reason_code,'NATIVE_INVENTORY_BOUNDARY_CHANGED');
    assert.equal(r.inventory_conflict.after.conclusion,null);assert.equal(r.population.complete,false);
    assert.ok(r.inventory_conflict.changed_fields.includes('conclusion'));
    assert.ok(!JSON.stringify(r.inventory_conflict).includes('untrusted'));
  }
});

test('the actual report writer retains a conflict diagnosis without promoting metrics or T0',async()=>{
  const conflict=advancingPostWindowPrefix({head_sha:'d'.repeat(40)}),fake=nativeRequest({sourceContract:contract(false),mutation:route=>
    route.includes('/actions/runs?')&&!new URL(route,'https://native.invalid').searchParams.has('created')?conflict.request(route):null});
  const files=new Map();
  const fetchImpl=async(url)=>{
    const route=String(url).replace('https://api.github.com','');let body;
    if(route===`/repos/${repository}/installation`)body={id:1};
    else if(route==='/app/installations/1/access_tokens')return new Response(JSON.stringify({token:'mock-measurement-token'}),{status:201});
    else if(route.startsWith(`/repos/${repository}/pulls?`))body=[];
    else body=(await fake.request(route)).body;
    return new Response(JSON.stringify(body),{headers:{'x-ratelimit-remaining':'4000','x-ratelimit-limit':'5000'}});
  };
  const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
  const result=await U.main({GITHUB_REPOSITORY:repository,GITHUB_WORKSPACE:'/fixture',GITHUB_TOKEN:'mock-fallback',
    CLUED_MEASURE_APP_ID:'1',CLUED_MEASURE_APP_KEY:key,GITHUB_RUN_ID:'42',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:head,CI_USAGE_DAYS:'1'},fetchImpl,
    {now:new Date(window.end),readFile:p=>{const rel=String(p).replace(/\\/g,'/').replace('/fixture/','');
      if(Object.hasOwn(content,rel))return content[rel];throw Error('MISSING_FIXTURE_FILE');},
    writeFile:(p,b)=>files.set(path.basename(p),b),mkdir:()=>{},appendFile:()=>{},log:()=>{},logError:()=>{},clock:()=>0,r9SourceContractRaw:selection()});
  assert.equal(result,0);const report=JSON.parse(files.get('ci-usage-report.json'));
  assert.equal(report.r9.native_coverage.inventory_conflict.run_id,'500');
  assert.equal(report.r9.native_coverage.reason_code,'NATIVE_INVENTORY_BOUNDARY_CHANGED');
  assert.equal(report.r9.native_coverage.population.cache_reuse_diagnostics.schema,'clued.r9-native-cache-reuse-diagnostics/1');
  assert.equal(report.r9.native_coverage.population.cache_reuse_diagnostics.sealed_current_attempt_recapture_count,0);
  assert.equal(report.r9.source_readiness.complete,false);assert.equal(report.r9.t0,null);
  assert.equal(report.r9.metrics.update_main_rounds.value,null);assert.equal(report.metrics.hosted_minutes.total,9);
});

function advancingFixedMember(change={},duringCapture=false,beforeChange={}){
  const old=Array.from({length:250},(_,i)=>run(250-i,{created_at:'2026-10-09T00:00:00Z',run_started_at:'2026-10-09T00:00:01Z',updated_at:'2026-10-09T00:01:00Z'}));
  const before=run(500,{created_at:'2026-10-10T23:59:58Z',run_started_at:'2026-10-10T23:59:58Z',updated_at:'2026-10-11T00:00:01Z',status:'in_progress',conclusion:null,...beforeChange});
  const after={...before,status:'completed',conclusion:'success',updated_at:'2026-10-11T00:00:02Z',...change};
  const f=nativeRequest({runs:[after],jobs:[job(500,{created_at:before.created_at,started_at:before.run_started_at,completed_at:after.updated_at,
    steps:[{number:1,name:'Measure CI usage',status:'completed',conclusion:'success',started_at:before.run_started_at,completed_at:after.updated_at}]})]});
  let directory=0,captured=false;
  return {before,after,async request(route,opts){
    const u=new URL(route,'https://native.invalid');
    if(u.pathname==='/repos/'+repository+'/actions/runs'){
      const page=Number(u.searchParams.get('page')),latest=duringCapture?(captured?after:before):++directory===1?before:after,rows=[latest,...old];
      return {ok:true,body:{total_count:rows.length,workflow_runs:rows.slice((page-1)*100,page*100)}};
    }
    if(u.pathname==='/repos/'+repository+'/actions/runs/500')captured=true;
    return f.request(route,opts);
  }};
}

test('a fixed member already observed after close can finish without changing its denominator or inventing window completion',async()=>{
  const f=advancingFixedMember(),r=await C.collectIncrementalNative({request:f.request,repository,window});
  assert.equal(r.status,'COMPLETE',JSON.stringify({reason_code:r.reason_code,gaps:r.gaps,inventory_conflict:r.inventory_conflict}));assert.equal(r.population.initial_total,251);assert.equal(r.population.closing_total,251);
  assert.equal(r.population.complete,true);assert.equal(r.fresh,1);assert.equal(r.population_packets.length,1);
  assert.equal(r.population_packets[0].run.status,'completed');assert.equal(r.population_packets[0].run.updated_at,new Date(f.after.updated_at).toISOString());
  assert.equal(C.nativeCompletionMembership(r.population_packets[0],window).membership,'OUTSIDE_WINDOW');
});

test('actual Native current-attempt capture can prove the same post-close progression before the final exact cohort barrier',async()=>{
  const f=advancingFixedMember({},true),r=await C.collectIncrementalNative({request:f.request,repository,window});
  assert.equal(r.status,'COMPLETE',JSON.stringify({reason_code:r.reason_code,gaps:r.gaps}));assert.equal(r.population.complete,true);
  assert.equal(r.fresh,1);assert.equal(r.population.initial_total,251);assert.equal(r.population.closing_total,251);
  assert.equal(r.population_packets[0].run.updated_at,new Date(f.after.updated_at).toISOString());
  assert.equal(C.nativeCompletionMembership(r.population_packets[0],window).membership,'OUTSIDE_WINDOW');
  for(const change of [{head_sha:'d'.repeat(40)},{run_attempt:2},{run_started_at:'2026-10-10T23:59:59Z'},
    {updated_at:'2026-10-11T00:00:00Z'},{status:'queued',conclusion:null}]){
    const bad=advancingFixedMember(change,true),q=await C.collectIncrementalNative({request:bad.request,repository,window});
    assert.equal(q.status,'PARTIAL');assert.equal(q.population.complete,false);
  }
});

test('fixed member post-close progress retains identity ordinal creation start and monotonic state guards',async()=>{
  for(const change of [{head_sha:'d'.repeat(40)},{run_attempt:2},{workflow_id:8},{event:'workflow_dispatch'},
    {path:'.github/workflows/other.yml'},{pull_requests:[{number:727}]},{created_at:'2026-10-10T23:59:57Z'},
    {run_started_at:'2026-10-10T23:59:59Z'},{updated_at:'2026-10-11T00:00:00Z'},
    {status:'queued',conclusion:null}]){
    const f=advancingFixedMember(change),r=await C.collectIncrementalNative({request:f.request,repository,window});
    assert.equal(r.status,'PARTIAL');assert.equal(r.population.complete,false);
  }
});

test('real cross-close completion keeps its fixed member and actual outside-window completion',async()=>{
  for(const duringCapture of [false,true]){
    const f=advancingFixedMember({},duringCapture,{updated_at:'2026-10-10T23:59:59Z'}),r=await C.collectIncrementalNative({request:f.request,repository,window});
    assert.equal(r.status,'COMPLETE',JSON.stringify({reason_code:r.reason_code,gaps:r.gaps}));
    assert.equal(r.population.complete,true);assert.equal(r.population.initial_total,251);assert.equal(r.population.closing_total,251);
    assert.equal(r.fresh,1);assert.equal(C.nativeCompletionMembership(r.population_packets[0],window).membership,'OUTSIDE_WINDOW');
  }
});

test('cross-close progress still refuses identity ordinal known start time and status regressions',async()=>{
  for(const duringCapture of [false,true])for(const change of [{head_sha:'d'.repeat(40)},{run_attempt:2},
    {workflow_id:8},{event:'workflow_dispatch'},{path:'.github/workflows/other.yml'},{pull_requests:[{number:727}]},
    {created_at:'2026-10-10T23:59:57Z'},{run_started_at:'2026-10-10T23:59:59Z'},
    {updated_at:'2026-10-10T23:59:58Z'},{status:'queued',conclusion:null}]){
    const f=advancingFixedMember(change,duringCapture,{updated_at:'2026-10-10T23:59:59Z'}),r=await C.collectIncrementalNative({request:f.request,repository,window});
    assert.equal(r.status,'PARTIAL');assert.equal(r.population.complete,false);
  }
});

test('changed progress with only pre-close timestamps cannot supply post-close consistency',async()=>{
  const f=advancingFixedMember({updated_at:'2026-10-10T23:59:59.500Z'},false,{updated_at:'2026-10-10T23:59:59Z'}),
    r=await C.collectIncrementalNative({request:f.request,repository,window});
  assert.equal(r.status,'PARTIAL');assert.equal(r.population.complete,false);
});

test('uncapped directory refuses changed retention or an unproved provider order',async()=>{
  for(const options of [{remove:true},{ascending:true}]){
    const f=uncappedDirectoryFixture(options),r=await C.collectIncrementalNative({request:f.request,repository,window});
    assert.equal(r.status,'PARTIAL');assert.equal(r.population.complete,false);
  }
});

test('the current Native main observer is disclosed outside its own terminal denominator',async()=>{
  const live=run(42,{status:'in_progress',conclusion:null}),f=nativeRequest({runs:[live],jobs:[]}),observer={run_id:'42',run_attempt:1,head_sha:head};
  const r=await C.collectR9Measurement({request:f.request,budget:U.createBudget({source:'app',cap:2000}),repository,window,observer});
  assert.equal(r.native.status,'COMPLETE');assert.equal(r.native.population.complete,true);
  assert.equal(r.native.population.current_observer_exclusion.run_id,'42');assert.equal(r.native.population_packets.length,0);
  assert.equal(r.t0,null);assert.equal(r.official_metric,false);
});

test('self-observation exclusion cannot hide another workflow or a terminal measurement',async()=>{
  for(const live of [run(42,{status:'in_progress',conclusion:null,path:'.github/workflows/clued-g4-database.yml'}),run()]){
    const f=nativeRequest({runs:[live]}),r=await C.collectR9Measurement({request:f.request,budget:U.createBudget({source:'app',cap:2000}),repository,window,
      observer:{run_id:'42',run_attempt:1,head_sha:head}});
    assert.equal(r.native.population.current_observer_exclusion,undefined);
    assert.ok(r.gaps.includes('CURRENT_OBSERVER_NATIVE_ROLE_NOT_PROVED'));assert.equal(r.official_metric,false);
  }
});

test('a live report exclusion retains all earlier terminal ordinal captures',async()=>{
  const first=run(),latest=run(42,{run_attempt:2,status:'in_progress',conclusion:null,run_started_at:'2026-10-10T10:15:00Z',updated_at:'2026-10-10T10:15:01Z'}),
    f=nativeRequest({runs:[latest],jobs:[job()],mutation:route=>route.endsWith('/attempts/1')?{ok:true,body:first}:null});
  const r=await C.collectIncrementalNative({request:f.request,repository,window,observer:{run_id:'42',run_attempt:2,head_sha:head}});
  assert.equal(r.status,'COMPLETE');assert.deepEqual(Object.keys(JSON.parse(r.store_raw).packets),['42:1']);assert.equal(r.fresh,1);
});

test('an observer ordinal moving after its independent proof cannot omit the now-historical execution',async()=>{
  const first=run(),live1=run(42,{status:'in_progress',conclusion:null}),live2=run(42,{run_attempt:2,status:'in_progress',conclusion:null,
    run_started_at:'2026-10-11T00:01:00Z',updated_at:'2026-10-11T00:01:01Z'});let rootReads=0;
  const f=nativeRequest({runs:[live2],jobs:[job()],mutation:route=>{
    if(route.includes('/actions/artifacts?'))return {ok:true,body:{total_count:0,artifacts:[]}};
    if(route.endsWith('/actions/runs/42'))return {ok:true,body:++rootReads===1?live1:live2};
    if(route.endsWith('/attempts/1'))return {ok:true,body:first};return null;
  }});
  const r=await C.collectR9Measurement({request:f.request,budget:U.createBudget({source:'app',cap:2000}),repository,window,
    observer:{run_id:'42',run_attempt:1,head_sha:head}});
  assert.equal(r.native.status,'PARTIAL');assert.equal(r.native.population.complete,false);
  assert.ok(r.native.gaps.some(g=>g.reason_code==='CURRENT_OBSERVER_INVENTORY_CHANGED'));
  assert.ok(JSON.parse(r.native.store_raw).packets['42:1']);assert.equal(r.native.population.current_observer_exclusion,undefined);
  assert.equal(r.official_metric,false);assert.equal(r.t0,null);
});

test('actual descending Native IDs tolerate the observed one-second creation inversion',async()=>{
  const f=uncappedDirectoryFixture({grow:false,createdInversion:true}),r=await C.collectIncrementalNative({request:f.request,repository,window});
  assert.equal(r.status,'COMPLETE');assert.equal(r.population.initial_total,250);assert.equal(r.population.closing_total,250);
});

test('a deletion offset by a new head cannot counterfeit the whole fixed denominator',async()=>{
  const f=uncappedDirectoryFixture({replaced:true}),r=await C.collectIncrementalNative({request:f.request,repository,window});
  assert.equal(r.status,'PARTIAL');assert.equal(r.population.complete,false);
});

test('a newer authenticated artifact cannot erase older independently authenticated Native increments',async()=>{
  const seed=await Native.captureNativeAttempt({request:nativeRequest().request,repository,runId:'42',attempt:1});
  assert.equal(seed.status,'COMPLETE');const old=zip(packet({nativeStoreRaw:seed.store_raw})),newest=zip(packet());
  const members=[{id:9,name:C.R9_ARTIFACT_NAME,expired:false},{id:10,name:C.R9_ARTIFACT_NAME,expired:false}];
  const f=nativeRequest({artifact:old,mutation:route=>{
    if(route.includes('/actions/artifacts?'))return {ok:true,body:{total_count:2,artifacts:members}};
    if(route.endsWith('/actions/artifacts/10'))return {ok:true,body:{id:10,name:C.R9_ARTIFACT_NAME,expired:false,digest:'sha256:'+digest(newest),workflow_run:{id:42,head_sha:head,head_branch:'main'}}};
    if(route.endsWith('/actions/artifacts/10/zip'))return {ok:true,body:newest};return null;
  }});
  const cache=JSON.stringify({schema:C.R9_CACHE_SCHEMA,repository,artifact_id:'9',zip_base64:old.toString('base64')}),
    r=await C.collectR9Measurement({request:f.request,budget:U.createBudget({source:'app',cap:2000}),repository,window,cacheRaw:cache});
  assert.equal(r.source_authenticated,true);assert.deepEqual(r.source_proof.native_history_union.artifact_ids,['10','9']);
  assert.equal(r.source_proof.native_history_union.packet_count,1);assert.equal(r.native.from_sealed,1);
  assert.ok(JSON.parse(r.native.store_raw).packets['42:1']);assert.equal(JSON.parse(r.cache_raw).artifact_id,'10');
  assert.equal(r.metrics.update_main_rounds.value,null);assert.equal(r.metrics.queue_depth_p95.value,null);assert.equal(r.t0,null);
  assert.equal(f.routes.filter(r=>r.endsWith('/actions/artifacts/9/zip')).length,0);
});

test('actual cancelled no-step scheduler rows retain cancellation without claiming an execution interval',async()=>{
  const r=run(38288051247,{path:'.github/workflows/clued-g4-database.yml',created_at:'2026-10-12T18:00:48Z',run_started_at:'2026-10-12T18:00:48Z',updated_at:'2026-10-12T18:02:42Z',conclusion:'cancelled'}),
    j=job(r.id,{id:114941745530,name:'Verify prior PR tested tree',conclusion:'cancelled',created_at:'2026-10-12T18:02:42Z',started_at:'2026-10-12T18:02:42Z',completed_at:'2026-10-12T18:02:41Z',steps:[],labels:['ubuntu-slim']});
  const f=nativeRequest({runs:[r],jobs:[j]}),n=await Native.captureNativeAttempt({request:f.request,repository,runId:String(r.id),attempt:1});
  assert.equal(n.status,'COMPLETE');assert.equal(n.packet.jobs[0].conclusion,'cancelled');assert.equal(Native.nativeJobIsNonExecution(n.packet.jobs[0]),true);
  assert.equal(n.packet.jobs[0].completed_at,'2026-10-12T18:02:41.000Z');assert.equal(Native.inspectNativePopulationStore(n.store_raw).status,'VALID_DATA_STORE');
  for(const change of [{started_at:'2026-10-12T18:02:43Z'},{steps:[{number:1,name:'actual execution',status:'completed',conclusion:'success',started_at:'2026-10-12T18:02:42Z',completed_at:'2026-10-12T18:02:42Z'}]},{conclusion:'success'}]){
    const bad=nativeRequest({runs:[r],jobs:[{...j,...change}]}),q=await Native.captureNativeAttempt({request:bad.request,repository,runId:String(r.id),attempt:1});
    assert.equal(q.status,'PARTIAL');assert.equal(q.reason_code,'invalid_native_job_time');
  }
});


test('complete authenticated clock source with an ambiguous percentile keeps integrity separate from an unproved value',async()=>{
  const c=clockFrame({ambiguous:true}),bound=C.bindClockSource(c.clock,selection(c.pins),repository,window);
  assert.equal(bound.status,'TYPED_SOURCE_BOUND');assert.equal(bound.result.candidate_ready,true);
  assert.equal(bound.result.status,'NOT_QUALIFIED');assert.equal(bound.result.reason,'conservative_bounds_do_not_prove_unique_percentile');
  assert.equal(bound.result.value,null);assert.equal(bound.official_metric,false);
  const f=fourFrame([attemptRow()]),fake=nativeRequest({artifact:zip(packet({fourSource:f.frame,clock:c.clock}))}),
    result=await C.collectR9Measurement({request:fake.request,budget:U.createBudget({source:'app',cap:2000}),repository,window,sourceContractRaw:selection(c.pins,f.expected)});
  assert.equal(result.source_readiness.complete,true);assert.equal(result.source_readiness.clock_source,true);assert.equal(result.source_readiness.four_source,true);
  assert.equal(result.status,'partial');assert.equal(result.metrics.queue_depth_p95.status,'partial');assert.equal(result.metrics.queue_depth_p95.value,null);
  assert.equal(result.metrics.queue_depth_p95.official_metric,false);assert.equal(result.metrics.queue_depth_p95.source_authenticated,true);
  assert.equal(result.metrics.queue_depth_p95.reason,'conservative_bounds_do_not_prove_unique_percentile');
  assert.ok(!result.gaps.includes('SEALED_CLOCK_SOURCE_INCOMPLETE'));assert.equal(result.t0,null);assert.equal(result.natural_continuity,'NOT_ESTABLISHED');
  for(const change of [p=>p.seal.sample_gap=true,p=>p.events=[],p=>p.clock_samples=[],p=>p.observation_seals=[]]){
    const broken=structuredClone(c.clock),page=JSON.parse(broken.pages_raw)[0],response=JSON.parse(broken.transport_raw)[0];change(page);
    response.measurement=page;broken.pages_raw=JSON.stringify([page]);broken.transport_raw=JSON.stringify([response]);
    assert.equal(C.bindClockSource(broken,selection(c.pins),repository,window).status,'PARTIAL');
  }
  const badAuth=structuredClone(c.clock),responses=JSON.parse(badAuth.transport_raw);responses[0].server_auth.required_scope='context:read';
  badAuth.transport_raw=JSON.stringify(responses);assert.equal(C.bindClockSource(badAuth,selection(c.pins),repository,window).status,'PARTIAL');
});


test('default contract collector binds a large encoding:none profile to immutable regular tree and blob facts',async()=>{
  const profilePath='scripts/ci/clued-gated-proof-profiles.json';
  async function load(size,change=()=>{}) {
    const base=nativeRequest(),sourceContract=contract(),original=JSON.stringify(sourceContract.profiles),
      text=original+' '.repeat(size-Buffer.byteLength(original)),oid=workflowBlob(text),routes=[],
      facts={content:{type:'file',path:profilePath,sha:oid,size,encoding:'none',content:'',download_url:'https://untrusted.invalid/ignored'},
        tree:{sha:'9'.repeat(40),truncated:false,tree:[...Object.entries(content).map(([path,value])=>({path,type:'blob',mode:'100644',sha:workflowBlob(value)})),
          {path:profilePath,type:'blob',mode:'100644',sha:oid,size}]},
        blob:{sha:oid,size,encoding:'base64',content:Buffer.from(text).toString('base64')}};
    change(facts);
    const request=async(route,opts)=>{
      routes.push(route);
      if(route===`/repos/${repository}/contents/${profilePath}?ref=${head}`)return {ok:true,body:facts.content};
      if(route===`/repos/${repository}/git/trees/${head}?recursive=1`)return {ok:true,body:facts.tree};
      if(route===`/repos/${repository}/git/blobs/${oid}`)return {ok:true,body:facts.blob};
      return base.request(route,opts);
    };
    return {result:await C.loadR9DefaultBranchContract({request,repository}),routes};
  }
  for(const size of [1048577,2097152]) {
    const {result,routes}=await load(size);assert.equal(result.profiles_sha256.length,64);
    assert.equal(routes.filter(route=>route.includes('/git/blobs/')).length,1);
    assert.ok(!routes.some(route=>route.includes('untrusted.invalid')));
  }
  for(const change of [f=>f.content.path='scripts/ci/other.json',f=>f.content.type='symlink',f=>f.content.sha='a'.repeat(40),
    f=>f.content.size++,f=>f.tree.truncated=true,f=>f.tree.tree.at(-1).mode='120000',f=>f.tree.tree.at(-1).size++,
    f=>f.blob.sha='a'.repeat(40),f=>f.blob.size++,f=>delete f.blob.content,
    f=>f.blob.content=Buffer.concat([Buffer.alloc(1048576,120),Buffer.from([255])]).toString('base64')])
    await assert.rejects(load(1048577,change),/NATIVE_SOURCE_INVALID/);
  await assert.rejects(load(2097153),/NATIVE_SOURCE_INVALID/);
  const small=nativeRequest();assert.ok((await C.loadR9DefaultBranchContract({request:small.request,repository})).profiles);
  assert.ok(!small.routes.some(route=>route.includes('/git/blobs/')));
});
