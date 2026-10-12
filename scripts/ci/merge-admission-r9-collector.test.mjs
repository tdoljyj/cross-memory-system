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
test('authenticated Native consistency does not produce missing four-source/clock values or T0',async()=>{
  const fake=nativeRequest();const result=await C.collectR9Measurement({request:fake.request,budget:U.createBudget({source:'app',cap:2000}),repository,window});
  assert.equal(result.source_authenticated,true);assert.equal(result.official_metric,false);assert.equal(result.t0,null);
  assert.equal(result.native.status,'COMPLETE');
  assert.equal(result.metrics.update_main_rounds.value,null);assert.equal(result.metrics.queue_depth_p95.value,null);
  assert.ok(result.gaps.includes('NATURAL_ADMISSION_OPERATION_ROUND_PRODUCER_PACKETS_MISSING'));
  assert.ok(result.gaps.includes('AUTHENTICATED_SEALED_CLOCK_TRANSPORT_MISSING'));
});
test('current real registry has no usage publisher: the integration gives a specific preparation gap',async()=>{
  const profiles=JSON.parse(fs.readFileSync(path.join(repo,'scripts/ci/clued-gated-proof-profiles.json'),'utf8'));
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
  assert.equal(report.metrics.api_requests.cap,2000);assert.equal(report.metrics.api_requests.used,calls.length-2);
  assert.equal(JSON.parse(files.get(C.R9_PACKET_FILE)).publisher.run_id,'42');
  assert.ok(files.has('r9-native-pending.json'));assert.ok(files.has('runs.json'));
});

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
  const file=Object.entries(JSON.parse(f.p.proof_profiles_raw).workflows).find(([,p])=>p.primary_ids.length)?.[0];assert.ok(file);
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
if(process.env.CLUED_R9_CHECKOUT_CHILD!=='1')test('M4: default self-test loads a checkout-shaped tree without any private directory or override',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'clued-r9-checkout-'));
  try{
    const paths=[...C.R9_SOURCE_PATHS,...Object.keys(JSON.parse(fs.readFileSync(path.join(repo,'scripts/ci/clued-gated-proof-profiles.json'),'utf8')).workflows),'scripts/ci/ci-usage-attribution.mjs','scripts/ci/merge-admission-policy.mjs','scripts/ci/merge-admission-r9-collector.test.mjs','scripts/ci/clued-gated-proof-profiles.json','scripts/ci/clued-gated-proof-role-specs.json',
      'scripts/ci/clued-work-admission.mjs','.github/workflows/clued-work-admission.yml','.github/workflows/clued-work-admission-reverify.yml','config/merge-admission-policy.json'];
    for(const rel of paths){const author=path.join(here,path.basename(rel)),src=fs.existsSync(author)?author:['scripts/ci/merge-admission-r9-collector.mjs','scripts/ci/merge-admission-r9-collector.test.mjs','scripts/ci/ci-usage-report.mjs'].includes(rel)?author:
      rel==='scripts/ci/merge-admission-native-population.mjs'?overrides['merge-admission-native-population.mjs']:rel==='scripts/ci/merge-admission-four-sources.mjs'?overrides['merge-admission-four-sources.mjs']:path.join(repo,rel);
      fs.mkdirSync(path.dirname(path.join(temp,rel)),{recursive:true});fs.copyFileSync(src,path.join(temp,rel));}
    const env={...process.env,CLUED_R9_CHECKOUT_CHILD:'1'};delete env.CLUED_R9_TEST_DEPENDENCY_ROOT;delete env.CLUED_R9_TEST_REPO_ROOT;
    delete env.NODE_TEST_CONTEXT;
    const run=spawnSync(process.execPath,['--test','scripts/ci/merge-admission-r9-collector.test.mjs'],{cwd:temp,env,encoding:'utf8'});
    assert.equal(run.status,0,(run.stdout??'')+(run.stderr??''));assert.match(run.stdout,/# fail 0/);assert.doesNotMatch(run.stdout,/MODULE_NOT_FOUND/);
  }finally{if(!path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep))throw Error('TEMP_SCOPE_REFUSED');fs.rmSync(temp,{recursive:true,force:true});}
});

test('R6 actual caller exposes activity PARTIAL without blanketing independent Native and live clock',async()=>{
  const f=fourFrame([]),clock=clockFrame(),expected=JSON.parse(f.expected),
    descriptor={registration_status:'registered',workflow_path:'.github/workflows/clued-merge-slot-ci.yml',workflow_blob:'d'.repeat(40),job_id:'report',job_name:'clued-merge-slot-ci',source_paths:['scripts/ci/clued-merge-slot-ci.mjs'],required_steps:['Export','Upload']},
    coverage={schema:'clued.r9-finite-recorded-operation-coverage/1',epoch_id:'10000000-0000-4000-8000-000000000001',owner_receipt_id:'10000000-0000-4000-8000-000000000001',repository,scope,mode:'explicit_recorded_origins_during_this_epoch',original_source_paths:['scripts/ci/clued-merge-executor.mjs']},
    cfg={schema:'clued.r9-runtime-source-selection/1',registration_status:'registered',repository,scope,natural_producers:[descriptor],operation_coverage:coverage,forward_epoch:{epoch_id:coverage.epoch_id}},
    rawCfg=JSON.stringify(cfg),sourceSelection={repository,head_sha:head,default_branch:'main',natural_producers:[descriptor],profiles_raw:f.p.proof_profiles_raw,workflow_blobs:Object.fromEntries(Object.keys(JSON.parse(f.p.proof_profiles_raw).workflows).map(file=>[file,workflowBlob(fs.readFileSync(path.join(repo,file),'utf8'))]))},
    paths={script:'scripts/ci/clued-work-admission.mjs',workflow:'.github/workflows/clued-work-admission.yml',reverify_workflow:'.github/workflows/clued-work-admission-reverify.yml',policy:'config/merge-admission-policy.json'},
    texts=Object.fromEntries(Object.entries(paths).map(([k,relative])=>[k,fs.readFileSync(path.join(repo,relative),'utf8')])),
    runtime={source_contract_raw:selection(clock.pins,f.expected),forward_epoch:{epoch_id:coverage.epoch_id},operation_coverage:coverage,natural_selection:sourceSelection,
      proof_profiles_raw:f.p.proof_profiles_raw,role_specs_raw:f.p.role_specs_raw,execution_workflow_blobs:sourceSelection.workflow_blobs,
      admission_source_bytes:{[head]:{texts,...Object.fromEntries(['script','workflow','reverify_workflow','policy'].map(k=>[k+'_blob',expected.admission_sources[0][k+'_blob']]))}}};
  const fake=nativeRequest({runs:[],jobs:[],mutation:route=>{
    if(route.includes('/contents/scripts/ci/merge-admission-r9-source.json'))return {ok:true,body:{type:'file',path:'scripts/ci/merge-admission-r9-source.json',encoding:'base64',sha:workflowBlob(rawCfg),content:Buffer.from(rawCfg).toString('base64')}};
    if(route.includes('/events?'))return {ok:true,body:[]};return null;
  }}),result=await C.collectR9Measurement({request:fake.request,budget:U.createBudget({source:'app',cap:2000}),repository,window,
    sourceContractRaw:runtime.source_contract_raw,naturalSelection:sourceSelection,runtimeInputs:runtime,liveClock:clock.clock});
  assert.equal(result.native.status,'COMPLETE');assert.equal(result.activity_coverage.status,'PARTIAL');assert.equal(result.activity_coverage.delivery_through_window_end,'UNKNOWN');
  assert.equal(result.activity_coverage.closing_delivery_watermark,null);assert.equal(result.metrics.queue_depth_p95.official_metric,true);assert.equal(result.metrics.queue_depth_p95.value,0);
  assert.equal(result.metrics.update_main_rounds.official_metric,true);assert.equal(result.metrics.update_main_rounds.value,0);assert.equal(result.metrics.cancellation_causes.denominator,0);
  assert.equal(result.metrics.wasted_final_rounds.activity_coverage.delivery_through_window_end,'UNKNOWN');assert.equal(result.t0,null);
});
