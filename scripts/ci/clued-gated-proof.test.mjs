import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {parseWorkflowProfiles,REQUIRED_TESTS_SOURCE} from './clued-workflow-profile.mjs';
import {qualifyPrimary,qualifiedCI,applicableCI,gateIdentityWitness,checkoutIdentityWitness,QUALITY,DOCUMENTATION_STEPS} from './clued-gated-proof.mjs';
const profiles=parseWorkflowProfiles(fs.readFileSync(new URL('./clued-gated-proof-profiles.json',import.meta.url)));
const FILE='.github/workflows/clued-components.yml',HEAD='a'.repeat(40);
const profile=profiles.workflows[FILE],route=profile.routes[0];
const step=(name,conclusion='success')=>({name,status:'completed',conclusion});
const primary=(extra={})=>({id:2,name:route.name,status:'completed',conclusion:'success',labels:['self-hosted'],
  steps:Object.entries(route.required_steps).flatMap(([name,count])=>Array.from({length:count},()=>step(name))),...extra});
const gate={id:1,name:'admission-gate',status:'completed',conclusion:'success',labels:['self-hosted']};

const requiredProfile=profiles.workflows[REQUIRED_TESTS_SOURCE.file];
function requiredJobs(){
  return [{...gate,id:101,run_id:777,run_attempt:2},...requiredProfile.routes.map((r,i)=>({
    id:102+i,run_id:777,run_attempt:2,name:r.name,status:'completed',conclusion:'success',labels:['self-hosted','Linux'],
    steps:[...Object.entries(r.required_steps).flatMap(([name,count])=>Array.from({length:count},()=>step(name))),
      ...(r.job_id==='migration-verify'?[step('Not affected','skipped')]:[])],
  }))];
}
const requiredProof=(jobs=requiredJobs(),p=requiredProfile,file=REQUIRED_TESTS_SOURCE.file)=>qualifyPrimary(p,jobs,file);

test('exact compound Source requires all three real primaries and the gate on one native attempt',()=>{
  const result=requiredProof();assert.equal(result.passed,true);assert.equal(result.scope,'workflow_execution');
  assert.deepEqual(result.job_ids,[102,103,104]);assert.equal(result.execution_mode,'all_required_primaries');
  const strings=requiredJobs();for(const j of strings)j.run_id=String(j.run_id);assert.equal(requiredProof(strings).passed,true);
});

test('no missing duplicate skipped neutral failed or active required primary can be replaced by another success',()=>{
  for(let i=1;i<=3;i++){
    const missing=requiredJobs();missing.splice(i,1);assert.equal(requiredProof(missing).passed,false);
    const duplicate=requiredJobs();duplicate.push({...duplicate[i],id:900+i});assert.equal(requiredProof(duplicate).passed,false);
    for(const conclusion of ['skipped','neutral','failure','cancelled']){
      const jobs=requiredJobs();jobs[i].conclusion=conclusion;assert.equal(requiredProof(jobs).passed,false);
    }
    const running=requiredJobs();running[i].status='in_progress';assert.equal(requiredProof(running).passed,false);
  }
  const helper=requiredJobs();helper.push({id:999,run_id:777,run_attempt:2,name:'helper',status:'completed',conclusion:'success'});
  assert.equal(requiredProof(helper).passed,false);
});

test('compound proof rejects native identity mixing, missing identities, duplicate IDs and wrong runner route',()=>{
  for(let i=0;i<=3;i++)for(const edit of [j=>j.run_id=778,j=>j.run_attempt=3,j=>delete j.run_id,
    j=>j.id=NaN,(j,jobs,index)=>j.id=jobs[(index+1)%jobs.length].id,j=>j.run_attempt='2']){
    const jobs=requiredJobs();edit(jobs[i],jobs,i);
    assert.equal(requiredProof(jobs).passed,false);
  }
  for(let i=1;i<=3;i++){
    const jobs=requiredJobs();jobs[i].labels=['ubuntu-latest'];assert.equal(requiredProof(jobs).passed,false);
  }
});

test('compound proof binds every full execution step and never treats not-affected as migration execution',()=>{
  for(let i=1;i<=3;i++)for(const edit of [j=>j.steps.shift(),j=>j.steps.push({...j.steps[0]}),
    j=>j.steps[0].conclusion='skipped',j=>j.steps[0].conclusion='neutral',j=>j.steps[0].conclusion='failure',
    j=>j.steps[0].name='different command step']){
    const jobs=requiredJobs();edit(jobs[i]);assert.equal(requiredProof(jobs).passed,false);
  }
  const unaffected=requiredJobs(),migration=unaffected[3];
  migration.steps.find(s=>s.name==='Verify migrations on the production schema').conclusion='skipped';
  migration.steps.find(s=>s.name==='Not affected').conclusion='success';
  const r=requiredProof(unaffected);assert.equal(r.passed,false);assert.equal(r.state,'unknown');
  assert.equal(r.code,'NOT_APPLICABLE_WITHOUT_INDEPENDENT_DIFF');assert.equal(r.gate_only,undefined);
  assert.equal(requiredProof().passed,true,'the full path permits only the pinned auxiliary no-op to be skipped');
});

test('compound profile mode, exact Source, three role projection and command hashes cannot be forged',()=>{
  for(const edit of [p=>delete p.execution_mode,p=>p.execution_mode='alternative',p=>p.workflow_blob='a'.repeat(40),
    p=>p.source_sha256='b'.repeat(64),p=>p.source_yaml+='# changed\n',p=>p.primary_ids.pop(),
    p=>p.routes[1].job_id='other-role',p=>p.routes[2].command_digests['Not affected'][0]='c'.repeat(64),
    p=>delete p.routes[0].required_steps['Lint, ledger, typecheck, build and unit tests']]){
    const p=structuredClone(requiredProfile);edit(p);assert.equal(requiredProof(requiredJobs(),p).passed,false);
  }
  assert.equal(requiredProof(requiredJobs(),requiredProfile,'.github/workflows/borrowed.yml').passed,false);
  const forged=structuredClone(profile);forged.execution_mode='all_required_primaries';
  assert.equal(qualifyPrimary(forged,[gate,primary()],FILE).passed,false);
});

test('derived metadata with execution explicitly disabled is never execution or gate recovery',()=>{
  for(const p of [{...requiredProfile,execution_eligible:false},{...profile,execution_eligible:false}]) {
    const r=qualifyPrimary(p,requiredJobs(),REQUIRED_TESTS_SOURCE.file);
    assert.equal(r.passed,false);assert.equal(r.state,'unknown');assert.equal(r.reason,'source_metadata_only_disabled');
    assert.equal(r.code,'SOURCE_METADATA_ONLY_DISABLED');assert.equal(r.gate_only,false);assert.equal(r.rerun,undefined);
  }
  const borrowed={...requiredProfile,execution_eligible:true};
  assert.equal(requiredProof(requiredJobs(),borrowed).passed,false,'a true flag cannot mint compound Source qualification');
});

test('the outer CI proof applies all-primary execution and final Source/attempt barriers unchanged',async()=>{
  const make=(jobs=requiredJobs(),extra={})=>{
    const run={id:777,path:REQUIRED_TESTS_SOURCE.file,head_sha:HEAD,event:'pull_request',status:'completed',
      conclusion:'success',run_attempt:2,pull_requests:[{number:5}]};
    return {repository:'o/r',head:HEAD,prNumber:5,
      workflows:new Map([[REQUIRED_TESTS_SOURCE.file,REQUIRED_TESTS_SOURCE.workflow_blob]]),
      profiles:{workflows:{[REQUIRED_TESTS_SOURCE.file]:requiredProfile}},authorizeSource:async()=>true,
      revalidateSources:async()=>true,
      read:async url=>url.includes('/actions/runs?')?{total_count:1,workflow_runs:[run]}:
        url.includes('/attempts/')?{total_count:jobs.length,jobs}:url.endsWith('/777')?run:null,...extra};
  };
  assert.equal((await qualifiedCI(make())).passed,true);
  for(const extra of [{authorizeSource:async()=>false},{revalidateSources:async()=>false}])
    assert.equal((await qualifiedCI(make(requiredJobs(),extra))).passed,false);
  const mixed=requiredJobs();mixed[2].run_attempt=1;assert.equal((await qualifiedCI(make(mixed))).passed,false);
  const notApplicable=requiredJobs();
  notApplicable[3].steps.find(s=>s.name==='Verify migrations on the production schema').conclusion='skipped';
  notApplicable[3].steps.find(s=>s.name==='Not affected').conclusion='success';
  const r=await qualifiedCI(make(notApplicable));assert.equal(r.passed,false);
  assert.equal(r.code,'NOT_APPLICABLE_WITHOUT_INDEPENDENT_DIFF');assert.equal(r.rerun,undefined);
});
test('auxiliary success, primary skipped and missing/duplicate execution steps cannot qualify',()=>{
  for(const jobs of [[gate,{id:4,name:'helper',status:'completed',conclusion:'success'}],
    [gate,primary({conclusion:'skipped'}),{id:4,name:'helper',status:'completed',conclusion:'success'}],
    [gate,primary({steps:[]})],[gate,primary(),primary({id:3})]]) assert.equal(qualifyPrimary(profile,jobs,FILE).passed,false);
  const good=qualifyPrimary(profile,[gate,primary(),{id:3,name:'alternate',status:'completed',conclusion:'skipped'}],FILE);
  assert.equal(good.state,'qualified');
});
test('critical skipped/neutral never passes; actual test failure is typed failed',()=>{
  const name=Object.keys(route.required_steps)[0];
  for(const conclusion of ['skipped','neutral','failure']) {
    const job=primary();job.steps.find(x=>x.name===name).conclusion=conclusion;
    const result=qualifyPrimary(profile,[gate,job],FILE);assert.equal(result.passed,false);
    assert.equal(result.state,conclusion==='failure'?'failed':'unknown');
  }
});
test('only all-skipped primary jobs beside a successful gate preserve the accepted recovery case',()=>{
  assert.equal(qualifyPrimary(profile,[gate,primary({conclusion:'skipped'})],FILE).gate_only,true);
  assert.equal(qualifyPrimary(profile,[gate,primary({conclusion:'skipped'}),{name:'helper',status:'completed',conclusion:'success'}],FILE).gate_only,false);
});
test('documentation produces a candidate scope and never Full application execution',()=>{
  const p=profiles.workflows[QUALITY],r=p.routes[0];
  const job={...primary(),name:r.name,steps:Object.keys(r.required_steps).map(name=>step(name,DOCUMENTATION_STEPS.includes(name)?'skipped':'success'))};
  const result=qualifyPrimary(p,[gate,job],QUALITY);
  assert.equal(result.passed,false);assert.equal(result.state,'documentation_candidate');assert.equal(result.scope,'documentation');
  job.steps[0].conclusion='failure';assert.equal(qualifyPrimary(p,[gate,job],QUALITY).passed,false);
});
test('Full app steps can qualify after a failed auxiliary classifier only when every app step actually succeeds',()=>{
  const p=profiles.workflows[QUALITY],r=p.routes[0];
  const job={...primary(),name:r.name,steps:Object.keys(r.required_steps).map(name=>step(name,name==='Qualify ordinary documentation changes'?'failure':'success'))};
  assert.equal(qualifyPrimary(p,[gate,job],QUALITY).passed,true);
  job.steps.find(x=>x.name==='Run npm run test:unit').conclusion='skipped';assert.equal(qualifyPrimary(p,[gate,job],QUALITY).passed,false);
});

test('only the exact Self source docs telemetry exception may skip; Full still requires it',()=>{
  const p=profiles.workflows[QUALITY];
  for(const entry of [p,...(p.accepted_sources??[])])for(const r of entry.routes) {
    const skip=[...DOCUMENTATION_STEPS,...(r.documentation_skipped_steps??[])];
    const job={id:8,name:r.name,status:'completed',conclusion:'success',labels:r.self_hosted?['self-hosted']:['ubuntu-latest'],
      steps:Object.entries(r.required_steps).flatMap(([name,count])=>Array.from({length:count},()=>step(name,skip.includes(name)?'skipped':'success')))};
    assert.equal(qualifyPrimary(entry,[gate,job],QUALITY).state,'documentation_candidate');
    if(r.documentation_skipped_steps) {
      const observer=job.steps.find(x=>x.name==='Observe npm HTTP cache events');
      observer.conclusion='failure';assert.equal(qualifyPrimary(entry,[gate,job],QUALITY).state,'failed');
      job.steps.forEach(x=>x.conclusion='success');observer.conclusion='skipped';
      assert.equal(qualifyPrimary(entry,[gate,job],QUALITY).state,'unknown');
      const altered=structuredClone(entry);altered.routes.find(x=>x.job_id===r.job_id).required_steps['Unreviewed helper']=1;
      job.steps.push(step('Unreviewed helper','skipped'));
      assert.equal(qualifyPrimary(altered,[gate,job],QUALITY).passed,false);
    }
  }
});
function world({runDelta={},jobs=[gate,primary()],readFailure=false,changedAttempt=false,newRun=false,finalAttempt=false,source=true}={}) {
  const run={id:7,path:FILE,head_sha:HEAD,event:'pull_request',status:'completed',conclusion:'success',run_attempt:1,pull_requests:[{number:5}],...runDelta};
  let lists=0;const calls=[];
  const read=async url=>{calls.push(url);if(readFailure)throw new Error('read failed');
    if(url.includes('/actions/runs?')){lists++;const rows=lists>1&&newRun?[run,{...run,id:8}]:
      lists>1&&finalAttempt?[{...run,run_attempt:2,status:'in_progress',conclusion:null}]:[run];return{total_count:rows.length,workflow_runs:rows};}
    if(url.includes('/attempts/'))return{total_count:jobs.length,jobs:jobs.map(job=>({run_id:run.id,run_attempt:run.run_attempt,...job}))};
    if(url.endsWith('/actions/runs/7'))return{...run,run_attempt:changedAttempt?2:1};
    throw new Error('unexpected mocked read');};
  return{read,calls,repository:'o/r',head:HEAD,prNumber:5,workflows:new Map([[FILE,'default-blob']]),profiles,
    authorizeSource:async()=>source,revalidateSources:async()=>true};
}

test('all actionable terminal results require a fresh strict source-authority recheck',async()=>{
  for(const result of [{},{runDelta:{conclusion:'failure'}},{jobs:[gate,primary({conclusion:'skipped'})]}]) {
    for(const callback of [undefined,async()=>false,async()=>({passed:false}),async()=>{throw Error('final source read');}]) {
      const w=world(result);w.revalidateSources=callback;
      const proof=await qualifiedCI(w);
      assert.equal(proof.state,'unknown');assert.equal(proof.passed,false);assert.equal(proof.rerun,undefined);
    }
    const w=world(result);let count=0;
    w.revalidateSources=async descriptor=>{
      count++;assert.equal(descriptor.head,HEAD);assert.equal(descriptor.prNumber,5);
      assert.equal(descriptor.runs.length,1);assert.equal(descriptor.runs[0].run.id,7);
      assert.equal(descriptor.runs[0].run.run_attempt,1);return true;
    };
    const proof=await qualifiedCI(w);
    if(result.jobs)assert.equal(proof.rerun?.id,7);
    else assert.equal(proof.state,result.runDelta?'failed':'qualified');
    assert.equal(count,1);
  }
});
test('a new run during final source reads invalidates full, failed and gate recovery results',async()=>{
  for(const result of [{},{runDelta:{conclusion:'failure'}},{jobs:[gate,primary({conclusion:'skipped'})]}]) {
    const w=world(result),read=w.read;let late=false;
    w.revalidateSources=async()=>{late=true;return true;};
    w.read=async url=>{
      const body=await read(url);
      if(late && body.workflow_runs) {
        body.workflow_runs.push({...body.workflow_runs[0],id:9,status:'queued',conclusion:null});body.total_count++;
      }
      return body;
    };
    const proof=await qualifiedCI(w);assert.equal(proof.state,'unknown');assert.equal(proof.rerun,undefined);
  }
});
test('latest-set read comes after final details so a new run cannot be hidden during the detail walk',async()=>{
  for(const result of [{},{runDelta:{conclusion:'failure'}},{jobs:[gate,primary({conclusion:'skipped'})]}]) {
    const w=world(result),read=w.read;let sourceDone=false,newRun=false;
    w.revalidateSources=async()=>{sourceDone=true;return true;};
    w.read=async url=>{
      const body=await read(url);
      if(sourceDone && url.endsWith('/actions/runs/7'))newRun=true;
      if(newRun && body.workflow_runs) {
        body.workflow_runs.push({...body.workflow_runs[0],id:9,status:'queued',conclusion:null});body.total_count++;
      }
      return body;
    };
    const proof=await qualifiedCI(w);assert.equal(proof.state,'unknown');assert.equal(proof.rerun,undefined);
  }
});
test('qualified run is bound to head, PR, complete lists, actual steps and unchanged latest attempt',async()=>{
  const w=world();const result=await qualifiedCI(w);assert.equal(result.passed,true);assert.equal(result.scopes[0].scope,'workflow_execution');
  assert.ok(w.calls.some(x=>x.includes('/attempts/1/jobs')));assert.ok(w.calls.some(x=>x.endsWith('/actions/runs/7')));
});
test('unknown/in-progress/source mismatch/retry/new run/ambiguous PR stay unknown',async()=>{
  for(const options of [{readFailure:true},{source:false},{changedAttempt:true},{newRun:true},
    {finalAttempt:true},{runDelta:{status:'in_progress'}},{runDelta:{pull_requests:[]}},{runDelta:{pull_requests:[{number:5},{number:6}]}}])
    assert.equal((await qualifiedCI(world(options))).state,'unknown');
});
test('truncated totals and duplicate job IDs never establish a completed sample',async()=>{
  for(const count of [null,3]) {
    const w=world(),read=w.read;w.read=async url=>url.includes('/attempts/')?{jobs:[gate,primary()],total_count:count}:read(url);
    assert.equal((await qualifiedCI(w)).state,'unknown');
  }
  assert.equal((await qualifiedCI(world({jobs:[gate,primary({id:1})]}))).state,'unknown');
});
test('new unprofiled gated workflows fail closed rather than borrowing another profile',async()=>{
  const w=world();w.workflows.set('.github/workflows/new.yml','new-blob');assert.equal((await qualifiedCI(w)).state,'unknown');
});
test('a successful gate-only run returns typed recovery and not qualified execution',async()=>{
  const result=await qualifiedCI(world({jobs:[gate,primary({conclusion:'skipped'})]}));
  assert.equal(result.passed,false);assert.equal(result.rerun.run_attempt,1);
});
test('documentation requires an independent source/range qualifier',async()=>{
  const p=profiles.workflows[QUALITY],r=p.routes[0];
  const job={...primary(),name:r.name,steps:Object.keys(r.required_steps).map(name=>step(name,DOCUMENTATION_STEPS.includes(name)?'skipped':'success'))};
  const w=world({jobs:[gate,job]});w.workflows=new Map([[QUALITY,'quality-blob']]);const read=w.read;
  w.read=async url=>{const b=await read(url);if(b.workflow_runs)b.workflow_runs=b.workflow_runs.map(x=>({...x,path:QUALITY}));
    if(b.id===7)b.path=QUALITY;return b;};
  assert.equal((await qualifiedCI(w)).state,'unknown');
  w.qualifyDocumentation=async()=>true;const result=await qualifiedCI(w);assert.equal(result.passed,true);assert.equal(result.scopes[0].scope,'documentation');
});

test('unqualified or wrong-PR failure is unknown; qualified failure is failed',async()=>{
  assert.equal((await qualifiedCI(world({runDelta:{conclusion:'failure',pull_requests:[{number:6}]}}))).state,'unknown');
  assert.equal((await qualifiedCI(world({runDelta:{conclusion:'failure'},source:false}))).state,'unknown');
  assert.equal((await qualifiedCI(world({runDelta:{conclusion:'failure'}}))).state,'failed');
});
test('profile counts must be positive safe integers and recovery is first attempt only',async()=>{
  for(const count of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1]) {
    const p=structuredClone(profile);p.routes[0].required_steps['Missing step']=count;
    assert.equal(qualifyPrimary(p,[gate,primary()],FILE).state,'unknown');
  }
  const result=await qualifiedCI(world({runDelta:{run_attempt:2},jobs:[gate,primary({conclusion:'skipped'})]}));
  assert.equal(result.state,'unknown');assert.equal(result.rerun,undefined);
});
test('out-of-scope workflows cannot provide or invalidate target execution proof',async()=>{
  const w=world(),read=w.read;w.read=async url=>{const b=await read(url);
    if(b.workflow_runs){b.workflow_runs.push({...b.workflow_runs[0],id:99,path:'.github/workflows/unrelated.yml',conclusion:'failure'});b.total_count++;}
    return b;};
  assert.equal((await qualifiedCI(w)).passed,true);
});
test('failure and recovery results recheck the latest attempt and run before driving writes',async()=>{
  for(const change of [{changedAttempt:true},{finalAttempt:true},{newRun:true}]) {
    assert.equal((await qualifiedCI(world({...change,runDelta:{conclusion:'failure'}}))).state,'unknown');
    const recovery=await qualifiedCI(world({...change,jobs:[gate,primary({conclusion:'skipped'})]}));
    assert.equal(recovery.state,'unknown');assert.equal(recovery.rerun,undefined);
  }
  const job=primary();job.steps[0].conclusion='failure';
  assert.equal((await qualifiedCI(world({jobs:[gate,job],finalAttempt:true}))).state,'unknown');
});
test('source qualification does not accept truthy failed objects',async()=>{
  const w=world();w.authorizeSource=async()=>({passed:false});
  assert.equal((await qualifiedCI(w)).state,'unknown');
});
test('terminal-only detail or final-list read failures remain unknown without rejection',async()=>{
  for(const terminalResult of [{runDelta:{conclusion:'failure'}},{jobs:[gate,primary({conclusion:'skipped'})]}]) {
    for(const stage of ['detail','list']) {
      const w=world(terminalResult),read=w.read;let lists=0;
      w.read=async url=>{
        if(url.includes('/actions/runs?') && ++lists===2 && stage==='list')throw Error('terminal list');
        if(url.endsWith('/actions/runs/7') && stage==='detail')throw Error('terminal detail');
        return read(url);
      };
      assert.equal((await qualifiedCI(w)).state,'unknown');
    }
  }
});
test('audited documentation diff preserves the original five and includes the new unconditional required-tests Source',()=>{
  const workflows=new Map(Object.entries(profiles.workflows).map(([file,p])=>[file,p.workflow_blob]));
  const w={workflows,profiles,changedFiles:['docs/README.md'],commits:1,diffComplete:true,sourceQualified:true};
  const result=applicableCI(w);assert.equal(result.passed,true);
  const expected=[QUALITY,'.github/workflows/clued-components.yml','.github/workflows/contract-placement.yml',
    '.github/workflows/gitleaks.yml','.github/workflows/trivy.yml',REQUIRED_TESTS_SOURCE.file].sort();
  assert.deepEqual([...result.workflows.keys()].sort(),expected);
  assert.deepEqual([...applicableCI({...w,changedFiles:[]}).workflows.keys()].sort(),expected);
  assert.equal(applicableCI({...w,changedFiles:[],diffComplete:false}).state,'unknown');
  assert.ok(result.workflows.has(QUALITY));assert.equal(result.workflows.has('.github/workflows/clued-g4-database.yml'),false);
  w.changedFiles=['apps/clued-cloud/worker/nested/file.ts'];assert.ok(applicableCI(w).workflows.has('.github/workflows/clued-connection-authorization.yml'));
  w.changedFiles=['apps/clued-cloud/tests/owner-authorization-db.test.mjs'];assert.ok(applicableCI(w).workflows.has('.github/workflows/clued-connection-authorization.yml'));
});
test('trigger applicability refuses incomplete, excessive, changed or unsupported sources',()=>{
  const workflows=new Map(Object.entries(profiles.workflows).map(([file,p])=>[file,p.workflow_blob]));
  const w={workflows,profiles,changedFiles:['docs/README.md'],commits:1,diffComplete:true,sourceQualified:true};
  for(const changes of [{diffComplete:false},{sourceQualified:false},{commits:1001},{changedFiles:Array(301).fill('docs/a.md')},
    {changedFiles:['../escape']},{workflows:new Map([[QUALITY,'b'.repeat(40)]])},
    {workflows:new Map([[QUALITY,profiles.workflows[QUALITY].workflow_blob]])},
    ...['\n','\r','\u2028','\u2029','\0'].map(separator=>({changedFiles:[`apps/clued-cloud/worker/a${separator}name.ts`]}))])
    assert.equal(applicableCI({...w,...changes}).state,'unknown');
  for(const paths of [['!docs/**'],['apps/**/deep'],['apps/?.js']]) {
    const altered=structuredClone(profiles);altered.workflows[QUALITY].pull_request={paths};
    assert.equal(applicableCI({...w,profiles:altered}).state,'unknown');
  }
});
test('gate identity log is bound to an authenticated attempt and qualified gate source, not execution',()=>{
  const gateSource='b'.repeat(40),run={id:7,run_attempt:1,event:'pull_request',head_sha:HEAD,repository:{full_name:'o/r'}};
  const result={mode:'gate',event:'pull_request',head_sha:HEAD,base_sha:gateSource,pr_ref:'o/r#5',enforced:true,
    admitted:false,verdict:'NO_ADMISSION_RUN',error:null,admission_run:{id:9,source:'trusted admission'},reasons:[]};
  const text=JSON.stringify(result,null,2).split('\n').map(line=>'2026-10-10T14:48:30.123Z '+line).join('\n');
  const w={sourceQualified:true,run,job:{...gate,run_id:7,run_attempt:1},repository:'o/r',head:HEAD,prNumber:5,gateSource,
    log:{complete:true,job_id:1,run_id:7,run_attempt:1,text}};
  assert.equal(gateIdentityWitness(w).scope,'pr_identity');
  for(const change of [{sourceQualified:false},{prNumber:6},{prNumber:0},{run:null},{gateSource:'c'.repeat(40)},
    {job:{...w.job,run_id:8}},{job:{...w.job,run_attempt:2}},{run:{...run,event:'push'}},
    {run:{...run,head_sha:'c'.repeat(40)}},{run:{...run,repository:{full_name:'other/repo'}}},
    {log:{...w.log,run_attempt:2}},{log:{...w.log,complete:false}},{log:{...w.log,text:text+'\n'+text}}])
    assert.equal(gateIdentityWitness({...w,...change}).state,'unknown');
});
test('job metadata cannot cross the qualified workflow attempt',async()=>{
  assert.equal((await qualifiedCI(world({jobs:[gate,primary({run_id:99})]}))).state,'unknown');
  assert.equal((await qualifiedCI(world({jobs:[gate,primary({run_attempt:99})]}))).state,'unknown');
});
test('empty native PR membership requires a source-qualified attempt witness; ambiguous membership cannot be overridden',async()=>{
  const w=world({runDelta:{pull_requests:[]}});w.qualifyRunIdentity=async()=>true;
  assert.equal((await qualifiedCI(w)).passed,true);
  for(const associations of [[{number:6}],[{number:5},{number:6}],null]) {
    const wrong=world({runDelta:{pull_requests:associations}});wrong.qualifyRunIdentity=async()=>true;
    assert.equal((await qualifiedCI(wrong)).state,'unknown');
  }
  for(const changes of [{finalAttempt:true},{changedAttempt:true},{newRun:true}]) {
    const changed=world({...changes,runDelta:{pull_requests:[]}});changed.qualifyRunIdentity=async()=>true;
    assert.equal((await qualifiedCI(changed)).state,'unknown');
  }
  w.qualifyRunIdentity=async()=>({passed:false});assert.equal((await qualifiedCI(w)).state,'unknown');
});
test('ungated checkout identity requires a unique attempt checkout and exact two-parent merge',()=>{
  const base='b'.repeat(40),merge='c'.repeat(40);
  const text=`[command]/usr/bin/git checkout --progress --force refs/remotes/pull/5/merge\n[command]/usr/bin/git log -1 --format=%H\n${merge}`;
  const w={sourceQualified:true,repository:'o/r',head:HEAD,prNumber:5,base,
    run:{id:7,run_attempt:1,event:'pull_request',head_sha:HEAD,repository:{full_name:'o/r'}},
    job:{id:2,run_id:7,run_attempt:1},commit:{sha:merge,parents:[{sha:base},{sha:HEAD}]},
    log:{complete:true,run_id:7,run_attempt:1,job_id:2,text}};
  assert.equal(checkoutIdentityWitness(w).scope,'pr_identity');
  for(const changes of [{sourceQualified:false},{prNumber:6},{job:{...w.job,run_id:8}},
    {commit:{...w.commit,parents:[{sha:HEAD},{sha:base}]}},{log:{...w.log,text:text+'\n'+text}},
    {log:{...w.log,complete:false}},{run:{...w.run,head_sha:base}}])
    assert.equal(checkoutIdentityWitness({...w,...changes}).state,'unknown');
});


test('registered G4 still requires one real complete primary and cannot borrow gate-only or migration-verify success',()=>{
  const file='.github/workflows/clued-g4-database.yml',p=profiles.workflows[file].accepted_sources.find(source=>source.workflow_blob==='d7876890a4df616fddae675c4d66737a70eb7045'),
    route=p.routes.find(route=>route.self_hosted),other=p.routes.find(route=>!route.self_hosted),
    make=()=>[{...gate}, {id:2,name:route.name,status:'completed',conclusion:'success',labels:['self-hosted','Linux'],
      steps:Object.entries(route.required_steps).flatMap(([name,count])=>Array.from({length:count},()=>step(name)))},
      {id:3,name:other.name,status:'completed',conclusion:'skipped',labels:['ubuntu-latest'],steps:[]}];
  assert.equal(qualifyPrimary(p,make(),file).passed,true);
  for(const edit of [jobs=>jobs[1].steps.shift(),jobs=>jobs[1].steps.push({...jobs[1].steps[0]}),
    jobs=>jobs[1].conclusion='skipped',jobs=>jobs[1].conclusion='failure',jobs=>jobs[1].labels=['ubuntu-latest'],
    jobs=>jobs[1].name='migration-verify',jobs=>jobs.splice(1,1),jobs=>jobs[1].steps[0].conclusion='skipped']) {
    const jobs=make();edit(jobs);assert.equal(qualifyPrimary(p,jobs,file).passed,false);
  }
});
