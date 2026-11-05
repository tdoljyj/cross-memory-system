import {loadPublisherSourceHistoryFixture} from './production-publisher-source-history.fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {registerHooks} from 'node:module';
import {execFileSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {decodeSourceHistoryFixture,loadSourceHistoryFixture} from './hosted-migration-source-history.fixture.mjs';
import {createNaturalRecorder,formatNaturalPayload,observeEvaluation,admissionEnvelopeInput,operationEnvelopeInput,observeMutation,exportNaturalArtifact,readNaturalArtifact,NATURAL_EVENT_SCHEMA} from './merge-admission-source-producer.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),stage=path.resolve(here,'../..');
const repo=process.env.CLUED_PRODUCER_TEST_REPO_ROOT??stage;
// Compare the integrated workflow against the real, immutable parent source,
// not a private adjacent checkout or this same already-patched workflow.
const ORIGINAL_WORKFLOW_BASE='b8d021ad974890d77801ed33ae8a8ff3eda80b68';
registerHooks({resolve(specifier,context,next){
  if(specifier.startsWith('./')&&(context.parentURL?.startsWith(pathToFileURL(here).href)||context.parentURL?.includes('/four-sources-formal-implementation/'))){
    const local=path.join(here,specifier),actual=path.join(repo,'scripts/ci',specifier);
    if(!fs.existsSync(local)&&fs.existsSync(actual))return {url:pathToFileURL(actual).href,shortCircuit:true};
  }return next(specifier,context);
}});
const {loadIndependentR9RuntimeInputs,R9_RUNTIME_CONFIG,r9CredentialFingerprint}=await import('./merge-admission-r9-runtime-inputs.mjs');
const {evaluate,reverify,appCheck,postAppCheck}=await import('./clued-work-admission.mjs');
const {appRequest}=await import('./clued-managed-auto-merge.mjs');
const {runRecordedHolderOperation}=await import('./clued-merge-executor.mjs');
const {collectNaturalSourceArtifacts,mapNaturalSourceEvents}=await import('./merge-admission-natural-intake.mjs');
const head='a'.repeat(40),base='b'.repeat(40),at='2026-10-11T06:00:03.000Z';
const env={GITHUB_REPOSITORY:'tdoljyj/cross-memory-system',GITHUB_RUN_ID:'42',GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:'admission',GITHUB_SHA:base};
const recorder=write=>createNaturalRecorder({env,sourcePath:'scripts/ci/clued-work-admission.mjs',now:()=>at,write});

test('typed PR reference preserves a real repo#PR identity without admitting arbitrary secret-bearing text',()=>{
  const projected=formatNaturalPayload('admission_final',{completion:'returned',outcome:{pr_ref:'tdoljyj/cross-memory-system#727'}});
  assert.equal(projected.pr_ref,'tdoljyj/cross-memory-system#727');
  for(const pr_ref of ['owner/repo#0','owner/repo#727 Bearer SECRET','../repo#727','owner/repo#1\nSECRET'])
    assert.equal(formatNaturalPayload('admission_final',{completion:'returned',outcome:{pr_ref}}).pr_ref,null);
});
test('natural allowlist never serializes credentials, raw errors, body, actor or diagnostic reason tails',()=>{
  const events=[],r=recorder(e=>events.push(e));
  r.record('admission_final',{completion:'returned',evaluation_id:'10000000-0000-4000-8000-000000000001',entry:'required',
    outcome:{head_sha:head,pr_ref:'tdoljyj/cross-memory-system#727',admitted:false,verdict:'REJECTED',enforced:true,
      reasons:['claim_trailer_missing: Bearer SECRET','secretishrawreason'],error:'github_pat_SECRET',token:'private',body:'private',actor:'not_canceller'}});
  const raw=JSON.stringify(events);assert.ok(!/SECRET|secretish|github_pat|not_canceller/.test(raw));
  assert.deepEqual(events[0].payload.reason_codes,['CLAIM_TRAILER_MISSING','UNKNOWN_REASON']);
  assert.equal(events[0].source_authenticated,false);assert.equal(events[0].population_completeness,'NOT_ATTESTED');assert.equal(events[0].t0,null);
});
test('source observation time and GITHUB_SHA claim do not become Native lifecycle/current checkout facts',()=>{
  const events=[],r=recorder(e=>events.push(e));r.record('round_ci_observation',{seen:{state:'green',execution:{native_runs:[]}}});
  assert.equal(events[0].event_at,at);assert.match(events[0].time_semantics,/not Native/);
  assert.equal(events[0].source.checkout_sha_claimed,base);assert.match(events[0].source.checkout_semantics,/collector must verify/);
  assert.equal(events[0].payload.termination_cause,'NOT_OBSERVED');
});
test('recording failure is explicit and cannot erase itself from later local records',()=>{
  let fail=true;const events=[],r=recorder(e=>{if(fail)throw Error('SECRET');events.push(e);});
  assert.equal(r.record('batch_initial',{pulls:[]}).status,'NOT_RECORDED');fail=false;r.record('batch_closing',{selected:[],completion:'normal'});
  assert.equal(r.failures,1);assert.equal(events[0].known_recording_failures,1);assert.equal(events[0].sequence,1);
  assert.equal(formatNaturalPayload('cancel_intent',{reason_code:'OWNER_STOP_REQUEST'}).cause,'UNKNOWN_CAUSE');
});
test('observer preserves original returned decision and distinguishes preselection from actual evaluator subject',async()=>{
  const events=[],r=recorder(e=>events.push(e)),value={verdict:'REJECTED',admitted:false,reasons:['claim_trailer_missing']};
  const result=await observeEvaluation(async args=>{args.observation_recorder.record('admission_selected',{evaluation_id:args.evaluation_id,entry:'required',pr:{number:727,head:{sha:head}}});return value;},
    {event:{pull_request:{number:727,head:{sha:base}}}},r);
  assert.equal(result,value);assert.deepEqual(events.map(e=>e.kind),['admission_input','admission_selected','admission_final']);
  assert.equal(events[0].payload.head_sha,base);assert.equal(events[1].payload.head_sha,head);assert.equal(events[2].payload.final_decision_observed,true);
});
test('original evaluator exception remains an exception and only a genuine no-final observation is recorded',async()=>{
  const events=[],r=recorder(e=>events.push(e));await assert.rejects(()=>observeEvaluation(async()=>{throw Error('original');},{},r),/original/);
  assert.equal(events.at(-1).payload.final_decision_observed,false);assert.equal(events.at(-1).payload.evaluation_completion,'exception');
});
test('actual patched evaluator early return runs without network and retains old result',async()=>{
  const events=[],r=recorder(e=>events.push(e));const result=await evaluate({env:{},event:{},eventName:'push',
    observation_recorder:r,fetchImpl:()=>{throw Error('NETWORK_FORBIDDEN');},workspace:repo});
  assert.equal(result.verdict,'NOT_APPLICABLE');assert.equal(result.admitted,true);assert.equal(events.at(-1).kind,'admission_final');
});
test('actual original mutation request exposes only real provider request id, not invented success/cause',async()=>{
  const seen=[];const response=await appRequest(async(url,init)=>{seen.push(init.method);return Response.json({message:'Updating branch',token:'SECRET'},
    {status:202,headers:{'x-github-request-id':'native:42'}});},env,'PUT','/repos/tdoljyj/cross-memory-system/pulls/727/update-branch','mock-only',{expected_head_sha:head});
  assert.deepEqual(seen,['PUT']);assert.equal(response.request_id,'native:42');
  const p=formatNaturalPayload('operation_response',{operation_id:'10000000-0000-4000-8000-000000000001',action:'update_branch',response});
  assert.equal(p.status,202);assert.equal(p.update_confirmation,'NATIVE_POST_OBSERVATION_REQUIRED');assert.equal(p.cancellation_cause,'UNKNOWN_CAUSE');assert.ok(!JSON.stringify(p).includes('SECRET'));
});
test('37a-compatible final input bridge refuses missing Native identity/checkouts and never invents a completed update',()=>{
  assert.equal(admissionEnvelopeInput().status,'PARTIAL');
  const f={schema:NATURAL_EVENT_SCHEMA,kind:'admission_final',payload:{entry:'dispatch_admit'}};
  assert.ok(admissionEnvelopeInput({finalEvent:f}).missing.includes('ENTRY_NOT_IN_PER_PR_GRAMMAR'));
});
test('five original workflow blocks preserve exact accepted successors and added same-job artifacts',()=>{
  // Exact accepted trigger additions verified from the immutable 59522b source.
  // Keep the original baseline for every other byte; CI needs no newer Git
  // history object, and no arbitrary future choice or hook is normalized away.
  const acceptedAdditions={
    'clued-work-admission-dispatch.yml':{anchor:'          - information-flow-e2e.yml\n',lines:[
      '          - clued-handover-external-qualification.yml','          - clued-handover-disposable-idle.yml',
      '          - clued-standard-runner-actor-qualification.yml']},
    'clued-merge-slot-ci.yml':[{anchor:'      - clued-components\n',lines:[
      '      - clued-required-tests','      - runner-budget-policy']},{anchor:'      - public-mcp-protocol\n',lines:[
      '      - Clued handover hook qualification / company-linux-01','      - Clued handover hook qualification / company-linux-02',
      '      - Clued handover hook qualification / company-linux-03','      - Clued handover hook qualification / company-linux-04',
      '      - Clued handover hook qualification / home-linux-01','      - Clued handover hook qualification / company-win-01',
      '      - Clued handover hook qualification / home-win-01','      - Clued disposable external handover qualification',
      '      - Clued disposable cancellation fixture']}],
  };
  for(const name of ['clued-work-admission.yml','clued-work-admission-reverify.yml','clued-work-admission-dispatch.yml','clued-merge-executor.yml','clued-merge-slot-ci.yml']){
    const old=execFileSync('git',['show',ORIGINAL_WORKFLOW_BASE+':.github/workflows/'+name],{cwd:repo,encoding:'utf8'}),next=fs.readFileSync(path.join(stage,'.github/workflows',name),'utf8').replace(/\r\n/g,'\n');
    let ordinary=name==='clued-merge-executor.yml'?next.replace(/  workflow_dispatch:\n    inputs:[\s\S]*?\npermissions:/,'  workflow_dispatch:\n\npermissions:').replace(/        if: \$\{\{ !inputs.measurement_opt_in \}\}\n/,''):next;
    // The reviewed display-name migration changes no trigger, permission,
    // environment, job ID or executable. Normalize only these exact lines
    // when comparing with the immutable pre-migration workflow witness.
    const renamedLines=name==='clued-work-admission.yml'?[
      ['name: kooyumi-work-admission','name: clued-work-admission'],
      ['    name: kooyumi-work-admission','    name: clued-work-admission'],
      ['# kooyumi-work-admission; both are GitHub Actions check runs. Closing that needs','# clued-work-admission; both are GitHub Actions check runs. Closing that needs'],
      ['          # Owner Decision 2ea795e4: the kooyumi-merge-slot check on the same','          # Owner Decision 2ea795e4: the clued-merge-slot check on the same'],
    ]:name==='clued-merge-slot-ci.yml'?[
      ["# fails the head's kooyumi-merge-slot check. The hourly report is a step of","# fails the head's clued-merge-slot check. The hourly report is a step of"],
      ['      - kooyumi-work-admission','      - clued-work-admission'],
    ]:[];
    for(const [current,previous]of renamedLines){
      const lines=ordinary.split('\n');assert.equal(lines.filter(line=>line===current).length,1,name+': exact reviewed display-name change');
      ordinary=lines.map(line=>line===current?previous:line).join('\n');
    }
    for(const additions of [].concat(acceptedAdditions[name]??[])){
      const exact=additions.anchor+additions.lines.join('\n')+'\n';
      assert.equal(ordinary.split(exact).length-1,1,name+': exact accepted trigger additions appear once');
      ordinary=ordinary.replace(exact,additions.anchor);
    }
    const removed=ordinary.replace(/      - name: Export the closed local natural R9 packet\n[\s\S]*?        run: node scripts\/ci\/merge-admission-source-producer.mjs --export[^\n]*\n/,'').replace(/      - name: Preserve natural R9 source observations\n[\s\S]*?          retention-days: 90\n/,'').replace(/\n\n\n/g,'\n\n');
    assert.equal(removed.trim(),old.replace(/\n\n\n/g,'\n\n').trim(),name);
    assert.equal((next.match(/name: Preserve natural R9/g)||[]).length,1);assert.equal((next.match(/if: \$\{\{ always\(\) \}\}/g)||[]).length,2);
  }
});
test('self-contained installed runner patch emits only pre-job permission and preserves original enforce exits',()=>{
  const file=fs.readFileSync(path.join(stage,'scripts/runner/clued-runner-job-started.mjs'),'utf8');
  assert.match(file,/phase:"pre_job_permission",native_job_started_at:null,native_job_completed_at:null/);
  assert.match(file,/return enforce \? 1 : 0/);assert.ok(!file.includes('merge-admission-source-producer.mjs'));
});

const tempFixture=()=>{const directory=fs.mkdtempSync(path.join(os.tmpdir(),'clued-natural-source-test-'));
  return {directory,dispose(){const actual=fs.realpathSync(directory);assert.equal(path.dirname(actual),fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(actual).startsWith('clued-natural-source-test-'));fs.rmSync(actual,{recursive:true});}};};
test('actual local file streams export a sealed same-attempt packet and refuse cross-attempt or caller authority',()=>{
  const f=tempFixture();try{
    const e={...env,GITHUB_WORKSPACE:f.directory},r=createNaturalRecorder({env:e,sourceUrl:import.meta.url,
      sourcePath:'scripts/ci/clued-work-admission.mjs',readCheckout:()=>base,now:()=>at});
    r.record('admission_final',{completion:'returned',outcome:{pr_ref:'tdoljyj/cross-memory-system#727'}});r.finish();
    const result=exportNaturalArtifact({env:e,expected:['admission'],now:()=>at}),raw=fs.readFileSync(result.filename,'utf8'),p=JSON.parse(raw);
    assert.equal(result.local_stream.status,'CLOSED_LOCAL_STREAM');assert.equal(p.sessions[0].executed_checkout_sha,base);
    assert.equal(p.provider_population.status,'NOT_ATTESTED');assert.equal(p.events[0].payload.pr_ref,'tdoljyj/cross-memory-system#727');
    assert.equal(readNaturalArtifact(raw,p.identity).status,'NATURAL_ARTIFACT_DATA_CANDIDATE');
    assert.equal(readNaturalArtifact(raw,{...p.identity,attempt:2}).status,'PARTIAL');
    p.source_authenticated=true;p.official_metric=true;assert.equal(readNaturalArtifact(JSON.stringify(p),p.identity).official_metric,false);
  }finally{f.dispose();}
});
test('open, missing-producer, unknown-selection and corrupt streams retain explicit gaps rather than empty zeros',()=>{
  const f=tempFixture();try{
    const e={...env,GITHUB_WORKSPACE:f.directory},r=createNaturalRecorder({env:e,sourceUrl:import.meta.url,sourcePath:'scripts/ci/clued-work-admission.mjs',readCheckout:()=>base});
    r.record('batch_candidate',{selection_state:'unknown',reason_code:'SELECTION_READ_FAILED'});
    const first=exportNaturalArtifact({env:e,expected:['admission','slot']});assert.ok(first.local_stream.known_gaps.includes('PRODUCER_SESSION_NOT_CLOSED'));
    assert.ok(first.local_stream.known_gaps.includes('EXPECTED_PRODUCER_MISSING:slot'));assert.ok(first.local_stream.known_gaps.includes('BATCH_SELECTION_UNKNOWN'));
    const dir=path.join(f.directory,'.clued-r9-source-events','42-1-admission'),stream=fs.readdirSync(dir).find(n=>n.endsWith('.jsonl'));
    fs.appendFileSync(path.join(dir,stream),'TRUNCATED');const broken=exportNaturalArtifact({env:e,expected:['admission']});
    assert.equal(broken.status,'ARTIFACT_GAP_WITNESS');const p=JSON.parse(fs.readFileSync(broken.filename));assert.equal(p.events,null);assert.equal(p.population_count,null);
  }finally{f.dispose();}
});
test('original mutation exceptions keep the exception and produce an explicit no-response witness',async()=>{
  const events=[],r=recorder(e=>events.push(e));await assert.rejects(()=>observeMutation(async()=>{throw Error('SECRET');},r,
    {operation_id:'10000000-0000-4000-8000-000000000001',action:'update_branch'}),/SECRET/);
  assert.equal(events[0].kind,'operation_failure');assert.equal(events[0].payload.response_observed,false);assert.ok(!JSON.stringify(events).includes('SECRET'));
});
test('actual App posting failures are preserved as failures and projected without raw errors',async()=>{
  const events=[],r=recorder(e=>events.push(e)),key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
  const result=await appCheck({env:{...env,ADMISSION_HEAD_SHA:head,ADMISSION_PR_NUMBER:'727',ADMISSION_OUTCOME:'failure',
    CLUED_ADMISSION_APP_ID:'5164952',CLUED_ADMISSION_APP_PRIVATE_KEY:key},observation_recorder:r,
    fetchImpl:async()=>{throw Error('SECRET provider exception');}});
  assert.equal(result.posted,false);assert.equal(events.filter(e=>e.kind==='app_check').length,2);
  assert.ok(events.every(e=>e.payload.posting_state==='post_failed'));assert.ok(!JSON.stringify(events).includes('SECRET'));
});
test('actual publication begin/finish evidence survives the recorder and binds Native suffix; revoked or mismatched epochs never qualify',async()=>{
  const uid=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0'),pub=uid(20),claim=uid(21),begin=uid(22),finish=uid(23);
  const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
  for(const revoked of [false,true]){
    const events=[],r=recorder(e=>events.push(e));let posted=null,patches=0;
    const fetchImpl=async(url,init={})=>{let body;
      if(url.includes('/rpc/clued_work_verify_v1')){const input=JSON.parse(init.body).p_input;
        body=input.action==='publication_begin'?{verdict:'ADMITTED',publication_id:pub,receipt_id:begin,execution_epoch:3}:
          {status:'committed',receipt_id:finish,execution_epoch:3,must_revoke:revoked};}
      else if(url.endsWith('/pulls/727'))body={state:'open',head:{sha:head},base:{sha:base,ref:'main'},changed_files:1,body:`Clued-Work-Claim: ${claim}`};
      else if(url.includes('/pulls/727/files?'))body=[{filename:'docs/test.md',status:'modified'}];
      else if(url.endsWith('/installation'))body={id:99};
      else if(url.endsWith('/access_tokens'))body={token:'mock-app-only'};
      else if(url.endsWith('/check-runs')&&init.method==='POST'){posted=JSON.parse(init.body);body={id:555};}
      else if(url.endsWith('/check-runs/555')&&init.method==='PATCH'){patches++;body={id:555};}
      else throw Error('Unexpected mocked original publication request');
      return Response.json(body);
    };
    const result=await postAppCheck({env:{...env,GITHUB_TOKEN:'mock-gh-only',CLUED_CONTEXT_READ_TOKEN:'mock-binding-only',
      CLUED_SUPABASE_URL:'https://supabase.test',CLUED_SUPABASE_PUBLISHABLE_KEY:'mock-public',CLUED_ADMISSION_APP_ID:'5164952',
      CLUED_ADMISSION_APP_PRIVATE_KEY:key,ADMISSION_OUTCOME:'success'},headSha:head,prNumber:727,success:true,title:'test',summary:'test',
      observation_recorder:r,fetchImpl});
    assert.equal(result.posted,true);assert.equal(patches,revoked?1:0);assert.equal(result.conclusion,revoked?'failure':'success');
    assert.equal(posted.external_id,`pr:727:run:42:publication:${pub}`);
    const observed=events[0];assert.equal(observed.payload.publication_observation.finish_receipt_id,finish);
    assert.ok(!JSON.stringify(events).includes('mock-binding-only'));assert.ok(!JSON.stringify(events).includes('mock-app-only'));
    const native={repository:env.GITHUB_REPOSITORY,pr_number:727,head_sha:head,run_id:'42',run_attempt:1,
      native_pr:{number:727,head_sha:head,base_repository:env.GITHUB_REPOSITORY,base_ref:'main',default_branch:'main',state:'open',draft:false},
      native_run:{id:'42',run_attempt:1,event:'pull_request_target',path:'.github/workflows/clued-work-admission.yml',head_sha:base,head_branch:'main',pull_requests:[727],status:'completed',conclusion:'success',run_started_at:at},
      native_job:{id:'101',run_id:'42',run_attempt:1,name:'kooyumi-work-admission',status:'completed',conclusion:'success'}};
    const f={...observed,kind:'admission_final',source:{...observed.source,executed_checkout_sha:subject},payload:{entry:'required',final_decision_observed:true,head_sha:head,pr_ref:env.GITHUB_REPOSITORY+'#727',claim_id:null,verdict:'ADMITTED',admitted:true,reason_codes:[]}};
    const app={id:555,app:{id:5164952},name:'kooyumi-admission-verified',head_sha:head,status:'completed',conclusion:result.conclusion,external_id:posted.external_id};
    const args={finalEvent:f,appEvent:observed,nativeIdentity:native,appNativeObservation:app,sourceCheckoutSha:subject};
    const mapped=admissionEnvelopeInput(args);assert.equal(mapped.status,revoked?'PARTIAL':'ENVELOPE_INPUT_CANDIDATE');
    if(!revoked){assert.equal(mapped.packet.app_observation.external_id,posted.external_id);
      const mismatched=structuredClone(observed);mismatched.payload.publication_observation.finish_execution_epoch=4;
      assert.equal(admissionEnvelopeInput({...args,appEvent:mismatched}).status,'PARTIAL');
      assert.equal(admissionEnvelopeInput({...args,appNativeObservation:{...app,external_id:`pr:728:run:42:publication:${pub}`}}).status,'PARTIAL');
      const absent=structuredClone(observed);absent.payload.publication_observation=null;
      assert.equal(admissionEnvelopeInput({...args,appEvent:absent}).status,'PARTIAL');}
  }
});
test('a known no-prior-green candidate records exclusion and a closed original reverify loop, without network use outside mocks',async()=>{
  const events=[],r=recorder(e=>events.push(e)),pr={number:727,draft:false,head:{sha:head},base:{sha:base,ref:'main',repo:{default_branch:'main',full_name:env.GITHUB_REPOSITORY}}};
  const result=await reverify({env:{...env,GITHUB_TOKEN:'mock-only',CLUED_ADMISSION_APP_ID:'5164952',CLUED_ADMISSION_APP_PRIVATE_KEY:'mock-only'},
    workspace:repo,observation_recorder:r,fetchImpl:async url=>Response.json(url.includes('/pulls?')?[pr]:{total_count:0,check_runs:[]})});
  assert.equal(result.errors.length,0);assert.deepEqual(events.map(e=>e.kind),['batch_initial','batch_candidate','batch_closing']);
  assert.equal(events[1].payload.reason_code,'NO_PRIOR_GREEN');assert.equal(events[0].payload.candidate_count,1);
});

const sha256=x=>createHash('sha256').update(x).digest('hex');
const gitBlob=x=>createHash('sha1').update('blob '+Buffer.byteLength(x)+'\0').update(x).digest('hex');
const subject='891ea2e7a68e0a3201b64a8fd173f4d50a4c18dc';
test('recorded holder entry refuses non-opt-in and changed live authority without issuing an operation',async()=>{
  let calls=0;const fetchImpl=()=>{calls++;throw Error('NETWORK_FORBIDDEN');};
  assert.equal((await runRecordedHolderOperation({env:{},input:{},fetchImpl})).status,'REFUSED');assert.equal(calls,0);
  const pr={number:727,state:'open',draft:false,auto_merge:null,head:{sha:head},base:{ref:'main',repo:{full_name:env.GITHUB_REPOSITORY,default_branch:'main'}},
    body:'Clued-Work-Claim: 10000000-0000-4000-8000-000000000001\nClued-Work-Scope: project:0597aa60-9b98-4da6-a4ab-63d7705b632f'};
  const outcome=await runRecordedHolderOperation({env:{...env,GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_ACTOR:'owner',GITHUB_REPOSITORY_OWNER:'owner'},
    input:{measurement_opt_in:'true',measurement_operation:'update_branch',measurement_pr:'727',measurement_head:head},
    fetchImpl:async url=>{assert.ok(!url.includes('update-branch'));return Response.json(url.includes('/pulls/')?pr:{commit:{sha:base}});},authorizeOperation:async()=>({valid:false})});
  assert.equal(outcome.status,'REFUSED');
});
test('holder actual source entry records its own pre/request/real response/fresh post and never authenticates caller JSON',async()=>{
  const events=[],r=recorder(e=>events.push(e)),next='c'.repeat(40);let changed=false;const methods=[];
  const pr={number:727,state:'open',draft:false,auto_merge:null,head:{sha:head},base:{ref:'main',repo:{full_name:env.GITHUB_REPOSITORY,default_branch:'main'}},
    body:'Clued-Work-Claim: 10000000-0000-4000-8000-000000000001\nClued-Work-Scope: project:0597aa60-9b98-4da6-a4ab-63d7705b632f'};
  const fetchImpl=async(url,init={})=>{methods.push(init.method??'GET');
    if(url.endsWith('/update-branch')){changed=true;return Response.json({message:'accepted',head:'untrusted extra',token:'SECRET'},{status:202,headers:{'x-github-request-id':'provider:actual'}});}
    if(url.includes('/commits/'))return Response.json({sha:next,parents:[{sha:head},{sha:base}]});
    return Response.json(url.includes('/pulls/')?{...pr,head:{sha:changed?next:head}}:{commit:{sha:base}});
  };
  const actual=await runRecordedHolderOperation({env:{...env,GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_ACTOR:'owner',GITHUB_REPOSITORY_OWNER:'owner'},workspace:repo,
    input:{measurement_opt_in:'true',measurement_operation:'update_branch',measurement_pr:'727',measurement_head:head,source_authenticated:true,receipt_id:'HANDWRITTEN'},
    observation_recorder:r,fetchImpl,authorizeOperation:async()=>({valid:true,pr,mode:{state:'normal'},observation_fence:12}),getToken:async()=>({token:'mock-only'})});
  assert.equal(actual.status,'RECORDED_ORIGINAL_OPERATION');assert.equal(methods.filter(m=>m==='PUT').length,1);
  assert.deepEqual(events.map(e=>e.kind),['manual_operation_input','operation_pre','operation_request','operation_response','operation_post']);
  assert.equal(events.at(-1).payload.head_sha,next);assert.equal(events[3].payload.status,202);assert.equal(events[3].payload.provider_request_id,'provider:actual');
  assert.ok(!JSON.stringify(events).includes('SECRET'));assert.ok(!JSON.stringify(events).includes('HANDWRITTEN'));
  const entry={packet_raw:JSON.stringify({events}),artifact_digest:'sha256:'+'d'.repeat(64),checkout_sha:base};
  const mapped=mapNaturalSourceEvents(entry,{scope:{project_id:'0597aa60-9b98-4da6-a4ab-63d7705b632f',queue_ref:'merge:'+env.GITHUB_REPOSITORY+':main'},collected_at:at});
  assert.equal(mapped.operations.length,1);assert.equal(JSON.parse(mapped.operations[0].after_raw).head_sha,next);assert.equal(JSON.parse(mapped.operations[0].before_raw).origin,'holder_adapter');
});
test('holder 202 with unchanged actual fresh post stays unconfirmed, rather than inventing a success',async()=>{
  const events=[],r=recorder(e=>events.push(e)),pr={number:727,state:'open',draft:false,auto_merge:null,head:{sha:head},base:{ref:'main',repo:{full_name:env.GITHUB_REPOSITORY,default_branch:'main'}},
    body:'Clued-Work-Claim: 10000000-0000-4000-8000-000000000001\nClued-Work-Scope: project:0597aa60-9b98-4da6-a4ab-63d7705b632f'};
  const result=await runRecordedHolderOperation({env:{...env,GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_ACTOR:'owner',GITHUB_REPOSITORY_OWNER:'owner'},workspace:repo,
    input:{measurement_opt_in:'true',measurement_operation:'update_branch',measurement_pr:'727',measurement_head:head},observation_recorder:r,
    fetchImpl:async url=>Response.json(url.endsWith('/update-branch')?{message:'accepted'}:url.includes('/commits/')?{sha:head,parents:[{sha:base}]}:url.includes('/pulls/')?pr:{commit:{sha:base}},url.endsWith('/update-branch')?{status:202}:{}),
    authorizeOperation:async()=>({valid:true,pr,mode:{state:'normal'},observation_fence:12}),getToken:async()=>({token:'mock-only'})});
  assert.equal(result.confirmation,'NOT_YET_CHANGED');assert.equal(events.at(-1).payload.head_sha,head);
});
const targetScope={project_id:'0597aa60-9b98-4da6-a4ab-63d7705b632f',queue_ref:'merge:tdoljyj/cross-memory-system:main'};
function sourceFixture(){const paths={script:'scripts/ci/clued-work-admission.mjs',workflow:'.github/workflows/clued-work-admission.yml',
  reverify_workflow:'.github/workflows/clued-work-admission-reverify.yml',policy:'config/merge-admission-policy.json'};
  const bytes=Object.fromEntries(Object.entries(paths).map(([k,v])=>[k,fs.readFileSync(path.join(repo,v),'utf8')]));
  const s={grammar:'clued.work-admission.evaluate-observation/1',...Object.fromEntries(Object.entries(paths).flatMap(([k,v])=>[[k+'_path',v],[k+'_blob',gitBlob(bytes[k])]])),app_id:5164952};
  const execution={profiles_sha256:sha256(fs.readFileSync(path.join(repo,'scripts/ci/clued-gated-proof-profiles.json'))),
    role_specs_sha256:sha256(fs.readFileSync(path.join(repo,'scripts/ci/clued-gated-proof-role-specs.json')))};
  return {paths,bytes,s,execution};}
test('positive final packet maps safe natural fields through the real four-source envelope grammar without authorizing a source',async()=>{
  const events=[],r=recorder(e=>events.push(e)),fixture=sourceFixture();
  r.record('admission_final',{entry:'required',evaluation_id:'10000000-0000-4000-8000-000000000001',completion:'returned',
    outcome:{head_sha:head,pr_ref:env.GITHUB_REPOSITORY+'#727',claim_id:null,enforced:true,admitted:false,verdict:'REJECTED',
      reasons:['claim_trailer_missing'],admission_mode:{state:'normal',layer:'code'}}});
  events[0].source.executed_checkout_sha=subject; // Synthetic observation; immutable fixture bytes, no source-auth claim.
  const native={repository:env.GITHUB_REPOSITORY,pr_number:727,head_sha:head,run_id:'42',run_attempt:1,
    native_pr:{number:727,head_sha:head,base_repository:env.GITHUB_REPOSITORY,base_ref:'main',default_branch:'main',state:'open',draft:false},
    native_run:{id:'42',run_attempt:1,event:'pull_request_target',path:fixture.paths.workflow,head_sha:base,head_branch:'main',pull_requests:[727],
      status:'completed',conclusion:'failure',run_started_at:'2026-10-11T06:00:00.000Z'},
    native_job:{id:'43',run_id:'42',run_attempt:1,name:'kooyumi-work-admission',status:'completed',conclusion:'failure'}};
  const mapped=admissionEnvelopeInput({finalEvent:events[0],nativeIdentity:native,sourceCheckoutSha:subject});
  assert.equal(mapped.status,'ENVELOPE_INPUT_CANDIDATE');
  const expected={schema:'clued.merge-admission-four-source-expectations/1',repository:env.GITHUB_REPOSITORY,scope:targetScope,
    admission_sources:[{...fixture.s,source_checkout_sha:subject,default_branch:'main'}],execution_source:{source_checkout_sha:subject,...fixture.execution}};
  const four=await import('./merge-admission-four-sources.mjs');
  const checked=four.finalAdmissionObservation(mapped.packet_raw,JSON.stringify(fixture.bytes),JSON.stringify(expected));
  assert.equal(checked.status,'ADMISSION_PACKET_CANDIDATE');assert.equal(checked.projection.status,'FINAL_OUTCOME_CANDIDATE');assert.equal(checked.official_metric,false);
  assert.equal(admissionEnvelopeInput({finalEvent:events[0],nativeIdentity:{...native,run_attempt:2},sourceCheckoutSha:subject}).status,'PARTIAL');
  assert.equal(admissionEnvelopeInput({finalEvent:events[0],nativeIdentity:native,sourceCheckoutSha:base}).status,'PARTIAL');
});
test('real request/response mapping leaves 202 pending and requires an independently observed Native post',()=>{
  const events=[],r=recorder(e=>events.push(e)),operation_id='10000000-0000-4000-8000-000000000001',pr={number:727,head:{sha:head},base:{sha:base,ref:'main'}};
  r.record('operation_pre',{operation_id,pr,main_sha:base});r.record('operation_request',{operation_id,pre_observation_id:events[0].record_id,pr,main_sha:base,
    expected_head_sha:head,action:'update_branch'});r.record('operation_response',{operation_id,action:'update_branch',response:{status:202,request_id:'actual:mock'}});
  const result=operationEnvelopeInput({preEvent:events[0],requestEvent:events[1],responseEvent:events[2],scope:targetScope,sourceRef:'a'.repeat(64),collectedAt:at});
  assert.equal(result.status,'OPERATION_INPUT_CANDIDATE');assert.equal(result.after_raw,null);assert.equal(JSON.parse(result.response_raw).status,202);
  const bad=structuredClone(events[2]);bad.attempt=2;assert.equal(operationEnvelopeInput({preEvent:events[0],requestEvent:events[1],responseEvent:bad,
    scope:targetScope,sourceRef:'a'.repeat(64),collectedAt:at}).status,'PARTIAL');
});
function runtimeFixture(epoch=null,configured=null){const x=sourceFixture(),files=new Map(Object.entries(x.paths).map(([k,v])=>[v,x.bytes[k]]));
  for(const n of ['scripts/ci/clued-gated-proof-profiles.json','scripts/ci/clued-gated-proof-role-specs.json'])files.set(n,fs.readFileSync(path.join(repo,n),'utf8'));
  const cfg={schema:'clued.r9-runtime-source-selection/1',repository:env.GITHUB_REPOSITORY,scope:targetScope,admission_source:x.s,execution_source:x.execution,
    previous_admission_sources:[],...structuredClone(configured??{}),forward_epoch:epoch,
    minimum_clock_binding:{credential_fingerprint:r9CredentialFingerprint('mock-only'),binding_scope_fingerprint:'d'.repeat(64),contributor_count:1},clock:{foundation_digest:'a'.repeat(64),catalog_digest:'b'.repeat(64),transport_definition_digest:'c'.repeat(64)}};
  for(const d of cfg.natural_producers??[])for(const n of [d.workflow_path,...d.source_paths])if(!files.has(n))files.set(n,fs.readFileSync(path.join(repo,n),'utf8'));
  files.set(R9_RUNTIME_CONFIG,JSON.stringify(cfg));let calls=0;const routes=[];
  const request=async route=>{calls++;routes.push(route);if(route===`/repos/${env.GITHUB_REPOSITORY}`)return {ok:true,body:{full_name:env.GITHUB_REPOSITORY,default_branch:'main'}};
    if(route.includes('/git/ref/'))return {ok:true,body:{object:{type:'commit',sha:subject}}};
    if(route.includes('/git/trees/'))return {ok:true,body:{truncated:false,tree:[...files].map(([path,text])=>({path,type:'blob',mode:'100644',sha:gitBlob(text)}))}};
    const text=[...files.values()].find(v=>route.endsWith('/'+gitBlob(v)));if(!text)throw Error('unexpected request');return {ok:true,body:{sha:gitBlob(text),encoding:'base64',size:Buffer.byteLength(text),content:Buffer.from(text).toString('base64')}};};
  return {request,files,routes,get calls(){return calls;}};
}
test('default runtime entry actually reads immutable main configuration and never substitutes old workload or packet window for a missing epoch',async()=>{
  const f=runtimeFixture(),r=await loadIndependentR9RuntimeInputs({request:f.request,budget:{source:'app',deadline:null,stopped:null},repository:env.GITHUB_REPOSITORY});
  assert.equal(r.reason_code,'FORWARD_EPOCH_NOT_ESTABLISHED');assert.equal(r.window,null);assert.ok(f.calls>=8);assert.equal(r.source_checkout_sha,subject);
  assert.ok(JSON.parse(r.reviewed_expected_sources_raw).admission_sources[0].script_blob);
  assert.equal(JSON.parse(r.reviewed_expected_sources_raw).schema,'clued.merge-admission-four-source-expectations/1');
  assert.equal(Object.hasOwn(r.natural_selection,'execution_source_templates'),false);assert.equal(Object.hasOwn(r.natural_selection,'current_execution_snapshot'),false);
  const caller=fs.readFileSync(path.join(here,'ci-usage-report.mjs'),'utf8');assert.match(caller,/await loadIndependentR9RuntimeInputs/);assert.match(caller,/window: runtime\.window/);
});
test('runtime loader validates the current Source registry against actual bytes and retains the complete old main admission template',async()=>{
  const cfg=JSON.parse(fs.readFileSync(path.join(repo,R9_RUNTIME_CONFIG),'utf8')),f=runtimeFixture(null,cfg);
  // The sealed exact predecessor is available in fresh shallow checkouts.
  // Its complete bytes and immutable commit are independently pinned by the
  // fixture loader, rather than recreated from today's descriptors.
  const previous=JSON.parse(loadPublisherSourceHistoryFixture()),sealedLegacy=JSON.parse(loadSourceHistoryFixture().predecessor_config);
  for(const name of fs.readdirSync(path.join(repo,'.github/workflows')))if(fs.statSync(path.join(repo,'.github/workflows',name)).isFile())
    f.files.set('.github/workflows/'+name,fs.readFileSync(path.join(repo,'.github/workflows',name),'utf8'));
  const r=await loadIndependentR9RuntimeInputs({request:f.request,budget:{source:'app',deadline:null,stopped:null},repository:env.GITHUB_REPOSITORY,
      fetchImpl:()=>{throw Error('SOURCE_ONLY_MOCK_MUST_NOT_ENTER_CLOCK');}});
  for(const k of ['script','workflow','reverify_workflow','policy'])assert.equal(cfg.admission_source[k+'_blob'],gitBlob(fs.readFileSync(path.join(repo,cfg.admission_source[k+'_path']))));
  for(const d of cfg.natural_producers){
    assert.equal(d.workflow_blob,gitBlob(fs.readFileSync(path.join(repo,d.workflow_path))));
    assert.deepEqual(Object.keys(d.source_blobs).sort(),[...d.source_paths].sort());
    for(const p of d.source_paths)assert.equal(d.source_blobs[p],gitBlob(fs.readFileSync(path.join(repo,p))));
    assert.equal(Object.hasOwn(d,'previous_source_blobs'),false);assert.equal(Object.hasOwn(d,'previous_job_name'),false);
    assert.equal(d.previous_source_versions.length,6);
    const old=previous.natural_producers.find(p=>p.workflow_path===d.workflow_path&&p.job_id===d.job_id);
    assert.ok(old);assert.deepEqual(d.previous_source_versions.slice(0,5),old.previous_source_versions);
    assert.deepEqual(d.previous_source_versions[5],{job_name:old.job_name,source_blobs:old.source_blobs});
    assert.deepEqual(d.previous_source_versions.slice(0,4).map(v=>v.job_name),d.job_id==='clued-work-admission'
      ?['clued-work-admission','clued-work-admission','clued-work-admission','kooyumi-work-admission']:Array(4).fill(d.job_name));
  }
  // These regression-only digests come from immutable main 462f74c3, before
  // this successor. They prove the 20 old expanded descriptors and untouched
  // clock/epoch/receipts remain byte-identical; they grant no Source qualification.
  const oldDescriptors=cfg.natural_producers.map(d=>{
    const {previous_source_versions,...base}=d;
    return previous_source_versions.slice(0,4).map(v=>({...base,job_name:v.job_name,workflow_blob:v.source_blobs[d.workflow_path],source_blobs:v.source_blobs}));
  });
  assert.equal(sha256(JSON.stringify(oldDescriptors)),'15e90b3554151f0daaeaa3f32a02e5d9dbf9038cca6dc8a6dd547693542a8d97');
  assert.deepEqual(cfg.previous_admission_sources.slice(0,-1),previous.previous_admission_sources);
  assert.equal(sha256(JSON.stringify(cfg.previous_admission_sources.slice(0,2))),'3441f3d86af8ad00a270128a89812922e242d1a5c2f11f7cc608cf977a153cf5');
  const unchanged=Object.fromEntries(Object.entries(cfg).filter(([key])=>!['admission_source','previous_admission_sources','natural_producers'].includes(key)));
  assert.deepEqual(Object.fromEntries(Object.entries(unchanged).filter(([key])=>!['execution_source','previous_execution_sources'].includes(key))),
    Object.fromEntries(Object.entries(previous).filter(([key])=>!['admission_source','previous_admission_sources','natural_producers','execution_source','previous_execution_sources'].includes(key))));
  assert.equal(sha256(JSON.stringify({...unchanged,execution_source:sealedLegacy.execution_source,previous_execution_sources:sealedLegacy.previous_execution_sources})),
    'a7011398d87dbfdb907d583765ef9b899fb149eaa47dd8ecad58da8772188fe0');
  assert.deepEqual(cfg.previous_admission_sources.at(-1),{...cfg.admission_source,
    script_blob:previous.admission_source.script_blob,source_checkout_sha:'80bd559f283b7c009cd37f1fbde700b6d6be41ae',default_branch:'main'});
  assert.equal(cfg.execution_source.profiles_sha256,sha256(fs.readFileSync(path.join(repo,'scripts/ci/clued-gated-proof-profiles.json'))));
  assert.equal(cfg.execution_source.role_specs_sha256,sha256(fs.readFileSync(path.join(repo,'scripts/ci/clued-gated-proof-role-specs.json'))));
  assert.equal(r.reason_code,'FORWARD_EPOCH_NOT_ESTABLISHED');assert.equal(r.window,null);
  const expected=JSON.parse(r.reviewed_expected_sources_raw);
  assert.equal(expected.schema,'clued.merge-admission-four-source-expectations/2');assert.deepEqual(expected.previous_execution_sources,cfg.previous_execution_sources);
  assert.equal(cfg.previous_admission_sources.length,4);assert.equal(expected.admission_sources.length,5);
  assert.deepEqual(cfg.execution_source,previous.execution_source);assert.deepEqual(cfg.previous_execution_sources,previous.previous_execution_sources);
  assert.deepEqual(expected.admission_sources[0],{...cfg.admission_source,source_checkout_sha:subject,default_branch:'main'});
  assert.deepEqual(expected.admission_sources.slice(1),cfg.previous_admission_sources);
  const old=expected.admission_sources.find(s=>s.source_checkout_sha==='ea7d09330583e3fc417997b621579de16fee239e');assert.ok(old);assert.equal(old.default_branch,'main');
  const beforeRename=expected.admission_sources.find(s=>s.source_checkout_sha==='90b9e5acfdf5e459bf5a188ff1ebb7a729f2a305');
  assert.ok(beforeRename);assert.equal(beforeRename.default_branch,'main');
  assert.equal(old.grammar,'clued.work-admission.evaluate-observation/1');
  for(const k of ['script','workflow','reverify_workflow','policy']){assert.equal(old[k+'_path'],cfg.admission_source[k+'_path']);assert.match(old[k+'_blob'],/^[a-f0-9]{40}$/);}
  assert.deepEqual(r.natural_selection.execution_source_templates,[expected.execution_source,...cfg.previous_execution_sources]);
  const snapshot=r.natural_selection.current_execution_snapshot;
  const file='.github/workflows/clued-handover-external-qualification.yml',actualBlob=gitBlob(f.files.get(file)),
    {registeredWorkflowSource,rolesForSource,roleDefinitionDigest}=await import('./clued-workflow-profile.mjs'),
    selected=registeredWorkflowSource(JSON.parse(snapshot.proof_profiles_raw),file,actualBlob),actualRoles=rolesForSource(JSON.parse(snapshot.role_specs_raw),file,actualBlob);
  assert.equal(actualBlob,'b8fee41077d854e906244b9fa2d374f058dbd4a3');assert.equal(snapshot.workflow_directory.find(row=>row.path===file).sha,actualBlob);
  assert.equal(selected.passed,true);assert.equal(selected.profile.workflow_blob,actualBlob);assert.equal(actualRoles.length,1);assert.equal(actualRoles[0].job_id,'qualify');
  assert.equal(actualRoles[0].definition_sha256,'fab079be15c3b25abe44ff6bcc2af3ff86161db853b0017ae92cb3f5ececb074');
  assert.equal(roleDefinitionDigest(actualRoles[0].definition),actualRoles[0].definition_sha256);assert.equal(actualRoles[0].definition.env.QUALIFICATION_IDLE_RUN_ID,'${{ inputs.idle_run_id }}');
  assert.deepEqual(snapshot,{source_checkout_sha:subject,proof_profiles_raw:fs.readFileSync(path.join(repo,'scripts/ci/clued-gated-proof-profiles.json'),'utf8'),
    role_specs_raw:fs.readFileSync(path.join(repo,'scripts/ci/clued-gated-proof-role-specs.json'),'utf8'),
    workflow_directory:[...f.files].filter(([p])=>p.startsWith('.github/workflows/')).map(([path,text])=>({path,sha:gitBlob(text),type:'blob',mode:'100644'})),
    main_history:{base_commit:subject,head_commit:subject,merge_base_commit:subject,status:'identical'}});
  const legacy=structuredClone(cfg);delete legacy.previous_execution_sources;const oldFixture=runtimeFixture(null,legacy);
  await loadIndependentR9RuntimeInputs({request:oldFixture.request,budget:{source:'app',deadline:null,stopped:null},repository:env.GITHUB_REPOSITORY});
  assert.equal(f.calls,oldFixture.calls,'history templates and current snapshot add no HTTP reads');
  for(const s of cfg.previous_execution_sources)assert.equal(f.routes.some(route=>route.includes(s.source_checkout_sha)),false,'history bytes are delegated to intake');
  assert.equal(r.source_authenticated,false);assert.equal(r.official_metric,false);assert.equal(r.t0,null);
});

test('sealed Source history rejects changed metadata, corrupted bytes and decompression beyond its fixed raw bound',()=>{
  const document=JSON.parse(fs.readFileSync(new URL('./fixtures/hosted-migration-source-history.v1.json',import.meta.url),'utf8'));
  const raw=loadSourceHistoryFixture();
  assert.equal(Buffer.byteLength(raw.predecessor_config),33363);
  for(const [label,mutate]of [
    ['commit',d=>{d.inputs.predecessor_config.commit='a'.repeat(40);}],
    ['byte count',d=>{d.inputs.historical_profiles.bytes++;}],
    ['expected hash',d=>{d.inputs.historical_roles.sha256='a'.repeat(64);}],
    ['corrupted exact-size bytes',d=>{d.inputs.predecessor_config.gzip_base64=gzipSync(Buffer.alloc(33363)).toString('base64');}],
    ['oversized decompression',d=>{d.inputs.historical_profiles.gzip_base64=gzipSync(Buffer.alloc(468323)).toString('base64');}],
    ['invalid base64',d=>{d.inputs.historical_roles.gzip_base64+='!';}],
  ]){
    const changed=structuredClone(document);mutate(changed);assert.throws(()=>decodeSourceHistoryFixture(changed),undefined,label);
  }
});

test('runtime execution history requires a bounded unique list of exact checkout and profile/role hash selectors before clock use',async()=>{
  const original=JSON.parse(fs.readFileSync(path.join(repo,R9_RUNTIME_CONFIG),'utf8')),old=original.previous_execution_sources[0],
    selectors=[
      ['non-array',{}],['more than four',['0','1','2','3','4'].map(c=>({...old,source_checkout_sha:c.repeat(40)}))],
      ['missing role hash',[{source_checkout_sha:old.source_checkout_sha,profiles_sha256:old.profiles_sha256}]],
      ['extra boolean',[{...old,source_authenticated:true}]],['invalid checkout',[{...old,source_checkout_sha:'g'.repeat(40)}]],
      ['invalid profile hash',[{...old,profiles_sha256:'a'.repeat(63)}]],['invalid role hash',[{...old,role_specs_sha256:'A'.repeat(64)}]],
      ['duplicate history',[old,{...old}]],['duplicate current',[{...old,source_checkout_sha:subject}]],
      ['same historical pair at another checkout',[old,{...old,source_checkout_sha:'c'.repeat(40)}]],
      ['same current pair at another checkout',[{source_checkout_sha:'c'.repeat(40),...original.execution_source}]]
    ];
  for(const [label,previous_execution_sources]of selectors){
    const f=runtimeFixture(null,{...original,previous_execution_sources});let clockCalls=0;
    const r=await loadIndependentR9RuntimeInputs({request:f.request,budget:{source:'app',deadline:null,stopped:null},repository:env.GITHUB_REPOSITORY,
      fetchImpl:()=>{clockCalls++;throw Error('INVALID_EXECUTION_HISTORY_MUST_NOT_ENTER_CLOCK');}});
    assert.equal(r.status,'PARTIAL',label);assert.equal(r.reason_code,'INDEPENDENT_R9_SOURCE_CONFIG_INVALID',label);assert.equal(clockCalls,0,label);
    assert.equal(r.source_contract_raw,null,label);assert.equal(r.window,null,label);assert.equal(r.clock,null,label);
    assert.equal(r.source_authenticated,false,label);assert.equal(r.official_metric,false,label);assert.equal(r.t0,null,label);
  }
  const f=runtimeFixture(null,{...original,previous_execution_sources:[]}),r=await loadIndependentR9RuntimeInputs({request:f.request,
    budget:{source:'app',deadline:null,stopped:null},repository:env.GITHUB_REPOSITORY});
  const expected=JSON.parse(r.reviewed_expected_sources_raw);
  assert.equal(expected.schema,'clued.merge-admission-four-source-expectations/2');assert.deepEqual(expected.previous_execution_sources,[]);
  assert.deepEqual(r.natural_selection.execution_source_templates,[expected.execution_source]);
});

test('current admission, dispatch and slot workflow, profile or role hash mismatches fail before any clock request despite retained old templates',async()=>{
  const original=JSON.parse(fs.readFileSync(path.join(repo,R9_RUNTIME_CONFIG),'utf8')),changes=[
    ['admission script',cfg=>{const p=cfg.admission_source.script_path;cfg.admission_source.script_blob=gitBlob(Buffer.concat([fs.readFileSync(path.join(repo,p)),Buffer.from('\n// mismatched mock pin\n')]));}],
    ...['.github/workflows/clued-work-admission-dispatch.yml','.github/workflows/clued-merge-slot-ci.yml'].map(p=>[p,cfg=>{
      const d=cfg.natural_producers.find(d=>d.workflow_path===p);assert.ok(d,'current registered workflow is required');
      d.workflow_blob=gitBlob(Buffer.concat([fs.readFileSync(path.join(repo,p)),Buffer.from('\n# mismatched mock pin\n')]));}]),
    ['profiles',cfg=>{cfg.execution_source.profiles_sha256=sha256(Buffer.concat([fs.readFileSync(path.join(repo,'scripts/ci/clued-gated-proof-profiles.json')),Buffer.from('\n ')]));}],
    ['roles',cfg=>{cfg.execution_source.role_specs_sha256=sha256(Buffer.concat([fs.readFileSync(path.join(repo,'scripts/ci/clued-gated-proof-role-specs.json')),Buffer.from('\n ')]));}]
  ];
  for(const [label,change]of changes){
    const cfg=structuredClone(original);change(cfg);const f=runtimeFixture(null,cfg);let clockCalls=0;
    const r=await loadIndependentR9RuntimeInputs({request:f.request,budget:{source:'app',deadline:null,stopped:null},repository:env.GITHUB_REPOSITORY,
      fetchImpl:()=>{clockCalls++;throw Error('MISMATCH_MUST_NOT_ENTER_CLOCK');}});
    assert.equal(r.status,'PARTIAL',label);assert.equal(r.reason_code,'INDEPENDENT_R9_SOURCE_CONFIG_INVALID',label);assert.equal(clockCalls,0,label);
    assert.equal(r.source_contract_raw,null,label);assert.equal(r.window,null,label);assert.equal(r.clock,null,label);
    assert.equal(r.source_authenticated,false,label);assert.equal(r.official_metric,false,label);assert.equal(r.t0,null,label);
  }
});

test('real loader wire obtains a separately pinned forward epoch through the actual C1 operations under mock HTTP, never a seven-day packet selection',async()=>{
  const uid=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0'),opening=String(BigInt(Date.parse('2026-10-08T06:00:00Z'))*1000n),closing=String(BigInt(Date.parse(at))*1000n);
  const pins={epoch_id:uid(1),stream_id:uid(2),clock_generation_id:uid(3),foundation_digest:'a'.repeat(64),catalog_digest:'b'.repeat(64)},
    epoch={epoch_id:uid(1),activation_receipt_id:uid(9),opening_us:opening,pins},cfg=JSON.parse(fs.readFileSync(path.join(repo,R9_RUNTIME_CONFIG),'utf8')),f=runtimeFixture(epoch,cfg),calls=[];
  const auth={schema:'clued.clock-audit-transport-auth/1',status:'AUTHENTICATED_TARGET_READ',context_key:'project:'+targetScope.project_id,
    queue_ref:targetScope.queue_ref,transport_definition_digest:'c'.repeat(64),binding_scope_fingerprint:'d'.repeat(64),contributor_count:1};
  const r=await loadIndependentR9RuntimeInputs({request:f.request,budget:{source:'app',deadline:null,stopped:null},repository:env.GITHUB_REPOSITORY,
    env:{CLUED_CONTEXT_READ_TOKEN:'mock-only'},
    fetchImpl:async(url,init)=>{const b=JSON.parse(init.body),m=b.measurement;calls.push(m.operation);assert.equal(b.context_key,'project:'+targetScope.project_id);
      assert.equal(url,'https://clued.pixelgrav.com/v1/continuity/audit');assert.equal(init.redirect,'error');
      assert.equal(init.headers.authorization,'Bearer mock-only');assert.equal(init.headers.apikey,undefined);
      assert.equal(b.p_token_hash,undefined);assert.equal(b.p_input,undefined);
      return Response.json(m.operation==='clock_seal'?{status:'ok',operation:m.operation,pins,seal_pins:{end_sequence:0,closing_us:closing,catalog_digest:pins.catalog_digest},
        measurement:{seal_id:uid(4)},server_auth:auth}:{status:'ok',operation:m.operation,server_auth:auth,measurement:{status:'ok',after_sequence:0,next_sequence:0,has_more:false,
          epoch:{epoch_id:uid(1),queue_ref:targetScope.queue_ref,opening_us:opening},seal:{closing_us:closing}}});}});
  assert.deepEqual(calls,['clock_seal','clock_page']);assert.equal(r.status,'R9_RUNTIME_INPUT_CANDIDATE');
  assert.equal(r.window.start,'2026-10-08T06:00:00.000000Z');assert.equal(r.window.end,'2026-10-11T06:00:03.000000Z');
  const expected=JSON.parse(JSON.parse(r.source_contract_raw).four_expected_sources_raw);
  assert.equal(expected.schema,'clued.merge-admission-four-source-expectations/2');assert.deepEqual(expected.previous_execution_sources,cfg.previous_execution_sources);
  assert.deepEqual(expected.admission_sources,[{...cfg.admission_source,source_checkout_sha:subject,default_branch:'main'},...cfg.previous_admission_sources]);
  assert.equal(r.forward_epoch.required_continuous_hours,24);assert.equal(r.source_authenticated,false);assert.equal(r.official_metric,false);assert.equal(r.t0,null);
});
test('clock intake never substitutes public database credentials for a denied or wrong audit Binding',async()=>{
  const uid=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0'),epoch={epoch_id:uid(1),activation_receipt_id:uid(9),
    opening_us:'1791442800000000',pins:{epoch_id:uid(1)}};
  for(const [token,expected,requests] of [['wrong-only','CLOCK_CREDENTIAL_IS_NOT_THE_ACCEPTED_MINIMAL_BINDING',0],
    ['mock-only','CLOCK_TYPED_TRANSPORT_UNAVAILABLE',1]]){
    const f=runtimeFixture(epoch);let calls=0;
    const r=await loadIndependentR9RuntimeInputs({request:f.request,budget:{source:'app',deadline:null,stopped:null},repository:env.GITHUB_REPOSITORY,
      env:{CLUED_CONTEXT_READ_TOKEN:token,CLUED_SUPABASE_URL:'https://must-not-be-used.invalid',CLUED_SUPABASE_PUBLISHABLE_KEY:'public-must-not-be-used'},
      fetchImpl:async(url,init)=>{calls++;assert.equal(url,'https://clued.pixelgrav.com/v1/continuity/audit');
        assert.equal(init.headers.authorization,'Bearer mock-only');return Response.json({status:'rejected'},{status:403});}});
    assert.equal(calls,requests);assert.equal(r.reason_code,expected);assert.equal(r.window,null);assert.equal(r.t0,null);
  }
});
test('an inactive recorder does not query checkout identity or perform a hidden Git read',()=>{
  let queried=0;const r=createNaturalRecorder({env:{},workspace:repo,sourceUrl:import.meta.url,readCheckout:()=>{queried++;throw Error('FORBIDDEN');}});
  assert.equal(r.record('batch_initial',{pulls:[]}).status,'NOT_RECORDED');assert.equal(queried,0);
});
test('real artifact intake binds provider digest, run/attempt/job, main ancestry and actual source bytes; caller flags remain inert',async()=>{
  const text='// immutable mocked Source bytes\n',wf='name: immutable mocked workflow\n',sourcePath='scripts/ci/clued-work-admission.mjs',workflow='.github/workflows/clued-work-admission.yml',
    identity={repository:env.GITHUB_REPOSITORY,run_id:'42',attempt:1,logical_job_key:'admission'},events=[],r=recorder(e=>events.push(e));
  r.record('admission_final',{completion:'returned',outcome:{pr_ref:env.GITHUB_REPOSITORY+'#727'}});
  events[0].source={path:sourcePath,sha256:sha256(text),executed_checkout_sha:base};
  const packet={schema:'clued.merge-admission-natural-artifact/1',identity,events,sessions:[{executed_checkout_sha:base}],files:[],local_stream:{status:'CLOSED_LOCAL_STREAM',known_gaps:[]},source_authenticated:true};
  const bytes=Buffer.from(JSON.stringify(packet)),artifact={id:9,name:'clued-r9-natural-source-42-1-admission',expired:false,digest:'sha256:'+sha256(bytes),workflow_run:{id:42,head_sha:base}},
    descriptor={registration_status:'registered',workflow_path:workflow,workflow_blob:gitBlob(wf),job_id:'admission',job_name:'source-job',source_paths:[sourcePath],source_blobs:{[sourcePath]:gitBlob(text)},required_steps:['Export','Upload']},
    n={run:{run_id:'42',run_attempt:1,status:'completed',conclusion:'failure',head_sha:base,path:workflow},jobs:[{id:'43',name:'source-job',steps:[{name:'Export',status:'completed',conclusion:'success'},{name:'Upload',status:'completed',conclusion:'success'}]}]},
    selection={repository:env.GITHUB_REPOSITORY,head_sha:base,default_branch:'main',natural_producers:[descriptor]},routes=[];
  const request=async route=>{routes.push(route);
    if(route.includes('/artifacts?'))return {ok:true,body:{total_count:1,artifacts:[artifact]}};
    if(route.endsWith('/artifacts/9'))return {ok:true,body:artifact};if(route.endsWith('/artifacts/9/zip'))return {ok:true,body:bytes};
    if(route.endsWith('/attempts/1'))return {ok:true,body:{id:42,run_attempt:1,head_sha:base,event:'pull_request_target',head_branch:'a-real-PR-branch',head_repository:{full_name:'fork/repo'}}};
    if(route.includes('/compare/'))return {ok:true,body:{status:'identical',merge_base_commit:{sha:base}}};
    const path=route.split('/contents/')[1]?.split('?')[0],body=path===workflow?wf:path===sourcePath?text:null;if(body===null)throw Error('UNMOCKED');
    return {ok:true,body:{type:'file',path,encoding:'base64',sha:gitBlob(body),content:Buffer.from(body).toString('base64')}};
  };
  const result=await collectNaturalSourceArtifacts({request,repository:env.GITHUB_REPOSITORY,native:{status:'COMPLETE',population_packets:[n]},selection,readZip:b=>b.toString()});
  assert.equal(result.status,'NATIVE_ORIGIN_BOUND',JSON.stringify(result.gaps));assert.equal(result.entries.length,1);assert.equal(result.source_authenticated,false);assert.equal(result.official_metric,false);
  const tampered=await collectNaturalSourceArtifacts({request:async route=>route.endsWith('/zip')?{ok:true,body:Buffer.from('tampered')}:request(route),repository:env.GITHUB_REPOSITORY,native:{status:'COMPLETE',population_packets:[n]},selection,readZip:b=>b.toString()});
  assert.equal(tampered.status,'PARTIAL');assert.ok(tampered.gaps.some(g=>g.code==='NATURAL_ARTIFACT_DIGEST_MISMATCH'));
  packet.local_stream={status:'GAP',known_gaps:['KNOWN_PRODUCER_RECORDING_FAILURE']};
  const broken=Buffer.from(JSON.stringify(packet)),gap=await collectNaturalSourceArtifacts({request:async route=>route.endsWith('/artifacts/9')?{ok:true,body:{...artifact,digest:'sha256:'+sha256(broken)}}:route.endsWith('/zip')?{ok:true,body:broken}:request(route),repository:env.GITHUB_REPOSITORY,native:{status:'COMPLETE',population_packets:[n]},selection,readZip:b=>b.toString()});
  assert.equal(gap.status,'PARTIAL');assert.ok(gap.gaps.some(g=>g.code==='NATURAL_LOCAL_STREAM_INCOMPLETE'));
  // workflow_run is added only for the already registered default-main slot
  // job, not as a generic privilege shortcut for any other producer.
  packet.local_stream={status:'CLOSED_LOCAL_STREAM',known_gaps:[]};
  for(const origin of [{event:'workflow_run',head_branch:'main',head_repository:{full_name:env.GITHUB_REPOSITORY}},
    {event:'push',head_branch:'foreign-branch',head_repository:{full_name:env.GITHUB_REPOSITORY}},
    {event:'push',head_branch:'main',head_repository:{full_name:'fork/repo'}}]){
    const refused=await collectNaturalSourceArtifacts({request:async route=>route.endsWith('/attempts/1')?{ok:true,body:{id:42,run_attempt:1,head_sha:base,...origin}}:request(route),
      repository:env.GITHUB_REPOSITORY,native:{status:'COMPLETE',population_packets:[n]},selection,readZip:b=>b.toString()});
    assert.equal(refused.status,'PARTIAL');assert.ok(refused.gaps.some(g=>g.code==='NATURAL_PRODUCER_ORIGIN_INVALID'));
  }
});
test('minimal credential public pin is domain-separated from the actual RPC credential hash',()=>{
  assert.notEqual(r9CredentialFingerprint('mock-only'),sha256('mock-only'));
  assert.match(r9CredentialFingerprint('mock-only'),/^[a-f0-9]{64}$/);
});

test('Native zero-execution producers retain attempts without requiring an unexecuted export',async()=>{
  const workflow='.github/workflows/clued-work-admission.yml',descriptor={registration_status:'registered',workflow_path:workflow,
    workflow_blob:base,job_id:'admission',job_name:'source-job',source_paths:['scripts/ci/clued-work-admission.mjs'],required_steps:['Export','Upload']},
    selection={repository:env.GITHUB_REPOSITORY,head_sha:base,natural_producers:[descriptor]},at='2026-10-12T21:30:00.000Z',
    n={run:{run_id:'42',run_attempt:1,status:'completed',conclusion:'success',path:workflow},jobs:[]};
  const skipped={id:'43',name:'source-job',status:'completed',conclusion:'skipped',created_at:at,started_at:at,completed_at:at,steps:[]},
    cancelled={...skipped,conclusion:'cancelled',completed_at:'2026-10-12T21:29:59.000Z'};
  for(const j of [skipped,cancelled]){
    n.jobs=[j,{id:'44',name:'clued-work-adopt',status:'completed',conclusion:'success',steps:[{name:'Report the merge',status:'completed',conclusion:'success'}]}];
    const original=JSON.stringify(n);let calls=0;
    const result=await collectNaturalSourceArtifacts({request:async()=>{calls++;throw Error('UNEXPECTED_ARTIFACT_READ');},
      repository:env.GITHUB_REPOSITORY,native:{status:'COMPLETE',population_packets:[n]},selection,readZip:b=>b.toString()});
    assert.equal(result.status,'NATIVE_ORIGIN_BOUND',JSON.stringify(result.gaps));assert.equal(result.entries.length,0);assert.equal(calls,0);
    assert.equal(JSON.stringify(n),original);assert.equal(result.source_authenticated,false);assert.equal(result.official_metric,false);
  }
  for(const j of [{...cancelled,started_at:'2026-10-12T21:30:01.000Z'},
    {...cancelled,steps:[{name:'Export',status:'completed',conclusion:'failure'}]},
    {...skipped,conclusion:'success'}, {...skipped,steps:[{name:'Export',status:'completed',conclusion:'skipped'}]}]){
    n.jobs=[j];let calls=0;
    const result=await collectNaturalSourceArtifacts({request:async()=>{calls++;return {ok:true,body:{total_count:0,artifacts:[]}};},
      repository:env.GITHUB_REPOSITORY,native:{status:'COMPLETE',population_packets:[n]},selection,readZip:b=>b.toString()});
    assert.equal(result.status,'PARTIAL');assert.ok(result.gaps.some(g=>g.code==='NATURAL_EXPECTED_ARTIFACT_MISSING_OR_DUPLICATE'));assert.equal(calls,1);
  }
  n.jobs=[skipped,skipped];
  const duplicate=await collectNaturalSourceArtifacts({request:async()=>{throw Error('UNEXPECTED_READ');},repository:env.GITHUB_REPOSITORY,
    native:{status:'COMPLETE',population_packets:[n]},selection,readZip:b=>b.toString()});
  assert.equal(duplicate.status,'PARTIAL');assert.ok(duplicate.gaps.some(g=>g.code==='NATURAL_PRODUCER_NATIVE_JOB_MISSING_OR_DUPLICATE'));
});

test('positive-duration cancelled slot requires stable complete unassigned Hosted runner metadata and registered main origin',async()=>{
  const workflow='.github/workflows/clued-merge-slot-ci.yml',wf='name: immutable declared slot fixture\n',created='2026-10-12T21:29:56.000Z',completed='2026-10-12T21:30:08.000Z',
    descriptor={registration_status:'registered',workflow_path:workflow,workflow_blob:gitBlob(wf),job_id:'report',job_name:'clued-merge-slot-ci',
      source_paths:['scripts/ci/clued-merge-slot-ci.mjs'],required_steps:['Export','Upload']},
    selection={repository:env.GITHUB_REPOSITORY,head_sha:head,default_branch:'main',natural_producers:[descriptor]},
    job={id:'43',name:descriptor.job_name,status:'completed',conclusion:'cancelled',created_at:created,started_at:created,completed_at:completed,labels:['ubuntu-slim'],steps:[]},
    n={run:{run_id:'42',run_attempt:1,status:'completed',conclusion:'cancelled',head_sha:base,path:workflow,event:'workflow_run'},jobs:[job]},
    origin={id:42,run_attempt:1,status:'completed',conclusion:'cancelled',head_sha:base,path:workflow,event:'workflow_run',head_branch:'main',head_repository:{full_name:env.GITHUB_REPOSITORY}},
    wire={...job,id:43,run_id:42,run_attempt:1,runner_id:0,runner_name:'',runner_group_id:0,runner_group_name:''};
  const collect=async variant=>{
    let reads=0;const routes=[];
    const request=async route=>{routes.push(route);
      if(route.endsWith('/attempts/1'))return {ok:true,body:variant?.origin??origin};
      if(route.includes('/contents/'))return {ok:true,body:{type:'file',path:workflow,encoding:'base64',sha:gitBlob(wf),content:Buffer.from(wf).toString('base64')}};
      if(route.includes('/compare/'))return {ok:true,body:variant?.history??{status:'ahead',merge_base_commit:{sha:base}}};
      if(route.includes('/jobs?')){reads++;return {ok:true,body:variant?.jobs?.(reads)??{total_count:1,jobs:[wire]}};}
      if(route.includes('/artifacts?'))return {ok:true,body:{total_count:0,artifacts:[]}};
      throw Error('UNMOCKED');
    };
    const result=await collectNaturalSourceArtifacts({request,repository:env.GITHUB_REPOSITORY,native:{status:'COMPLETE',population_packets:[n]},
      selection:variant?.selection??selection,readZip:b=>b.toString()});return {result,routes,reads};
  };
  const before=JSON.stringify(n),valid=await collect();
  assert.equal(valid.result.status,'NATIVE_ORIGIN_BOUND',JSON.stringify(valid.result.gaps));assert.equal(valid.reads,2);
  assert.equal(valid.result.entries.length,0);assert.equal(valid.result.non_execution_proofs.length,1);
  assert.equal(valid.result.non_execution_proofs[0].before_digest,valid.result.non_execution_proofs[0].after_digest);
  assert.equal(valid.result.source_authenticated,false);assert.equal(valid.result.official_metric,false);assert.equal(JSON.stringify(n),before);
  const changed=w=>({total_count:1,jobs:[{...wire,...w}]});
  for(const variant of [
    {jobs:()=>changed({runner_id:7,runner_name:'assigned'})},
    {jobs:()=>changed({runner_group_id:7})},
    {jobs:()=>changed({runner_name:undefined})},
    {jobs:()=>changed({labels:['self-hosted']})},
    {jobs:()=>changed({steps:[{name:'Run producer',status:'completed',conclusion:'cancelled'}]})},
    {jobs:()=>changed({id:44})},
    {jobs:()=>changed({started_at:'2026-10-12T21:29:57.000Z'})},
    {jobs:()=>({total_count:2,jobs:[wire]})},
    {jobs:i=>i===1?{total_count:1,jobs:[wire]}:changed({html_url:'changed'})},
    {origin:{...origin,head_repository:{full_name:'fork/repo'}}},
    {history:{status:'behind',merge_base_commit:{sha:base}}},
    {selection:{...selection,natural_producers:[{...descriptor,workflow_blob:head}]}}
  ]){
    const refused=await collect(variant);assert.equal(refused.result.status,'PARTIAL',JSON.stringify(variant));
    assert.equal(refused.result.non_execution_proofs.length,0);assert.ok(refused.result.gaps.some(g=>g.code==='NATURAL_EXPECTED_ARTIFACT_MISSING_OR_DUPLICATE'));
  }
});


test('actual RPC offset times retain microseconds, optional receipts do not replace RPC or Native binding',async()=>{
  const fixture=sourceFixture(),evaluation='10000000-0000-4000-8000-000000000001',claim='10000000-0000-4000-8000-000000000002',
    four=await import('./merge-admission-four-sources.mjs'),expected={schema:'clued.merge-admission-four-source-expectations/1',repository:env.GITHUB_REPOSITORY,scope:targetScope,
      admission_sources:[{...fixture.s,source_checkout_sha:subject,default_branch:'main'}],execution_source:{source_checkout_sha:subject,...fixture.execution}};
  const events=[],r=recorder(e=>events.push(e));
  r.record('claim_verification',{evaluation_id:evaluation,input:{scope:'project:'+targetScope.project_id,claim_id:claim,head_sha:head},
    result:{kind:'verdict',verdict:'ADMITTED',reasons:[],payload:{verified_at:'2026-10-11T06:00:02.123456+00:00',claim:{fence:31}}}});
  r.record('admission_final',{entry:'required',evaluation_id:evaluation,completion:'returned',outcome:{head_sha:head,pr_ref:env.GITHUB_REPOSITORY+'#727',
    claim_id:claim,enforced:true,admitted:true,verdict:'ADMITTED',reasons:[],admission_mode:{state:'normal',layer:'code'}}});
  r.record('app_check',{prNumber:727,headSha:head,name:'kooyumi-admission-verified',admitStepOutcome:'success',result:{check_run_id:555,posted:true,conclusion:'success',external_id:'pr:727:run:42'}});
  for(const e of events)e.source.executed_checkout_sha=subject;
  const native={repository:env.GITHUB_REPOSITORY,pr_number:727,head_sha:head,run_id:'42',run_attempt:1,
    native_pr:{number:727,head_sha:head,base_repository:env.GITHUB_REPOSITORY,base_ref:'main',default_branch:'main',state:'open',draft:false},
    native_run:{id:'42',run_attempt:1,event:'pull_request_target',path:fixture.paths.workflow,head_sha:base,head_branch:'main',pull_requests:[727],status:'completed',conclusion:'success',run_started_at:'2026-10-11T06:00:00.000Z'},
    native_job:{id:'43',run_id:'42',run_attempt:1,name:'kooyumi-work-admission',status:'completed',conclusion:'success'}},
    app={id:555,app:{id:5164952},name:'kooyumi-admission-verified',head_sha:head,status:'completed',conclusion:'success',external_id:'pr:727:run:42'},
    args={finalEvent:events[1],claimEvent:events[0],appEvent:events[2],nativeIdentity:native,appNativeObservation:app,sourceCheckoutSha:subject},
    check=m=>four.finalAdmissionObservation(m.packet_raw,JSON.stringify(fixture.bytes),JSON.stringify(expected));
  assert.equal(events[0].payload.verified_at,'2026-10-11T06:00:02.123456Z');assert.equal(events[0].payload.head_admitted_receipt_id,null);
  for(const receipt of [null,'10000000-0000-4000-8000-000000000003']){
    const mapped=admissionEnvelopeInput({...args,claimReceiptId:receipt});assert.equal(mapped.status,'ENVELOPE_INPUT_CANDIDATE');
    assert.equal(mapped.packet.claim_observation.disposition,'valid');assert.equal(mapped.packet.claim_observation.head_admitted_receipt_id,receipt);
    assert.equal(check(mapped).status,'ADMISSION_PACKET_CANDIDATE');assert.equal(mapped.official_metric,false);assert.equal(mapped.t0,null);
  }
  for(const [wire,canonical] of [['2026-10-11T14:00:02.123456+08:00','2026-10-11T06:00:02.123456Z'],
    ['2026-10-11T01:00:02.000001-05:00','2026-10-11T06:00:02.000001Z'],['2026-10-11T06:00:02+00:00','2026-10-11T06:00:02.000000Z']]){
    const p=formatNaturalPayload('claim_verification',{result:{payload:{verified_at:wire}}});assert.equal(p.verified_at,canonical);
  }
  for(const wire of [null,'2026-02-30T06:00:02.123456+00:00','2026-10-11T06:00:02.1234567+00:00','2026-10-11T06:00:02+99:00','invalid'])
    assert.equal(formatNaturalPayload('claim_verification',{result:{payload:{verified_at:wire}}}).verified_at,null);
  const final=formatNaturalPayload('admission_final',{outcome:{claim:{expires_at:'2026-10-11T14:00:02.123456+08:00'},merge_slot:{until:'2026-10-11T06:00:02.000001+00:00'}}});
  assert.equal(final.claim.expires_at,'2026-10-11T06:00:02.123456Z');assert.equal(final.merge_slot.until,'2026-10-11T06:00:02.000001Z');
  for(const change of [c=>c.payload.verified_at=null,c=>c.payload.claim_id='10000000-0000-4000-8000-000000000004',c=>c.payload.head_sha=base,c=>c.attempt=2]){
    const c=structuredClone(events[0]);change(c);assert.equal(admissionEnvelopeInput({...args,claimEvent:c}).status,'PARTIAL');
  }
  for(const change of [c=>c.payload.response_kind='error',c=>c.payload.verdict='REJECTED',c=>c.payload.verified_at='2026-10-11T05:59:59.999999Z',c=>c.payload.verified_at='2026-10-11T06:00:03.000001Z']){
    const c=structuredClone(events[0]);change(c);const m=admissionEnvelopeInput({...args,claimEvent:c});
    assert.equal(m.status,'ENVELOPE_INPUT_CANDIDATE');assert.notEqual(check(m).status,'ADMISSION_PACKET_CANDIDATE');
  }
  const onlyFinal=admissionEnvelopeInput({...args,claimEvent:undefined});assert.equal(onlyFinal.packet.claim_observation.disposition,'unverified');
  assert.notEqual(check(onlyFinal).status,'ADMISSION_PACKET_CANDIDATE');
});
