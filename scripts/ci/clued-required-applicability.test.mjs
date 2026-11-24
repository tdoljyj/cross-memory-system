import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {SUITES,selectSuites} from './ci-required-selection.mjs';
import {parseWorkflowProfiles,workflowBlob,REQUIRED_TESTS_SOURCE} from './clued-workflow-profile.mjs';
import {qualifiedCI,qualifyPrimary} from './clued-gated-proof.mjs';
import {COMPONENT_VERSION,readRequiredApplicability,inspectRequiredApplicability,REQUIRED_SELECTOR_SOURCE} from './clued-required-applicability.mjs';

const H='a'.repeat(40),B='b'.repeat(40),M='c'.repeat(40),repository='o/r',prNumber=17,runId=777,runAttempt=2;
assert.match(COMPONENT_VERSION,/^\d+\.\d+\.\d+$/);
const profile=parseWorkflowProfiles(fs.readFileSync(new URL('./clued-gated-proof-profiles.json',import.meta.url))).workflows[REQUIRED_TESTS_SOURCE.file];
const selector=fs.readFileSync(new URL('./ci-required-selection.mjs',import.meta.url));
test('the selector identity comes from the sibling file bytes',()=>{
  const source=fs.readFileSync(new URL('./clued-required-applicability.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/['"][a-f0-9]{40}(?:[a-f0-9]{24})?['"]/i);
  assert.equal(REQUIRED_SELECTOR_SOURCE.blob,workflowBlob(selector));
  assert.equal(REQUIRED_SELECTOR_SOURCE.sha256,hash(selector));
});
const gateScript=Buffer.from('public trusted gate fixture, not a credential');
const copy=value=>structuredClone(value),hash=x=>createHash('sha256').update(x).digest('hex');
const step=(name,conclusion='success')=>({name,status:'completed',conclusion});
function jobs(){return [{id:101,run_id:runId,run_attempt:runAttempt,name:'admission-gate',status:'completed',conclusion:'success',labels:['self-hosted']},
  ...profile.routes.map((r,i)=>({id:102+i,run_id:runId,run_attempt:runAttempt,name:r.name,status:'completed',conclusion:'success',labels:['self-hosted'],
    steps:[...Object.entries(r.required_steps).flatMap(([name,n])=>Array.from({length:n},()=>step(name,
      r.job_id==='migration-verify'&&name!=='Select suites'?'skipped':'success'))),...(r.job_id==='migration-verify'?[step('Not affected')]:[])]}))];}
const content=(path,bytes)=>({type:'file',path,sha:workflowBlob(bytes.toString('utf8')),encoding:'base64',size:bytes.length,content:bytes.toString('base64')});
function fixture(files=[{filename:'scripts/ci/safe-change.mjs',status:'modified'}]) {
  const calls=[],requestKey=Object.freeze({}),nativeJobs=jobs();
  const pr={number:prNumber,state:'open',head:{sha:H,repo:{full_name:repository}},base:{sha:B,ref:'main',repo:{full_name:repository,default_branch:'main'}},commits:1,changed_files:files.length};
  const run={id:runId,run_attempt:runAttempt,path:REQUIRED_TESTS_SOURCE.file,event:'pull_request',head_sha:H,
    repository:{full_name:repository},status:'completed',conclusion:'success',pull_requests:[{number:prNumber,head:{sha:H},base:{sha:B}}]};
  const compare={base_commit:{sha:B},merge_base_commit:{sha:M},total_commits:1,commits:[{sha:H}],files};
  const witness={mode:'gate',event:'pull_request',base_sha:B,head_sha:H,pr_ref:repository+'#'+prNumber,enforced:true,admitted:true,verdict:'ADMITTED'};
  const gateLog={complete:true,job_id:101,run_id:runId,run_attempt:runAttempt,
    text:'[command]/usr/bin/git log -1 --format=%H\n'+B+'\n'+JSON.stringify(witness,null,2)+'\n'};
  const prRoute='/repos/'+repository+'/pulls/'+prNumber,runRoute='/repos/'+repository+'/actions/runs/'+runId;
  const f={calls,requestKey,pr,run,compare,nativeJobs,gateLog,witness,
    expected:{repository,prNumber,head:H,base:B,runId,runAttempt,requestKey},
    read:async route=>{
      calls.push(route);
      if(route===prRoute)return copy(pr);
      if(route===runRoute)return copy(run);
      if(route.includes('/compare/'))return copy(compare);
      if(route===runRoute+'/attempts/2/jobs?per_page=100&page=1')return {total_count:nativeJobs.length,jobs:copy(nativeJobs)};
      if(route==='/repos/'+repository+'/contents/'+REQUIRED_SELECTOR_SOURCE.path+'?ref='+B)return content(REQUIRED_SELECTOR_SOURCE.path,selector);
      if(route==='/repos/'+repository+'/contents/scripts/ci/clued-work-admission.mjs?ref='+B)return content('scripts/ci/clued-work-admission.mjs',gateScript);
      throw Error('UNEXPECTED_FIXED_TEST_ROUTE');
    },readLog:async()=>copy(gateLog)};
  f.options=()=>({...f.expected,trustedGateBlob:workflowBlob(gateScript.toString('utf8')),read:(...a)=>f.read(...a),readLog:(...a)=>f.readLog(...a)});
  return f;
}

test('live issuer independently closes native diff, actual gate base and exact base selector without exposing logs',async()=>{
  const f=fixture(),token=await readRequiredApplicability(f.options());assert.ok(token);
  assert.deepEqual(Object.keys(token),[]);
  const e=inspectRequiredApplicability(token,f.expected);assert.ok(e);assert.ok(Object.isFrozen(e));assert.ok(Object.isFrozen(e.changed_paths));
  assert.deepEqual(e.changed_paths,['scripts/ci/safe-change.mjs']);assert.equal(e.base_sha,B);assert.equal(e.merge_base_sha,M);
  assert.equal(e.selector_blob,REQUIRED_SELECTOR_SOURCE.blob);assert.equal(e.selector_sha256,hash(selector));
  assert.equal(e.scope,'migration-verify:not_applicable');assert.equal(e.execution_authority,false);assert.equal(e.source_authority,false);
  assert.equal(e.gate_log_sha256,hash(f.gateLog.text));
  assert.equal(JSON.stringify(e).includes(f.gateLog.text),false);
  assert.ok(f.calls.includes('/repos/o/r/contents/'+REQUIRED_SELECTOR_SOURCE.path+'?ref='+B));
  assert.equal(f.calls.some(route=>route.includes('candidate')||route.includes('?ref='+H)),false);
  assert.equal(qualifyPrimary(profile,jobs(),REQUIRED_TESTS_SOURCE.file,{requiredDiffContext:{token,expected:f.expected}}).passed,true);
});

// R1: the scans follow migration-verify among the primaries; its not-applicable evidence stands in for it alone, so a
// failed or unexecuted scan still decides the proof.
test('migration-verify not applicable does not excuse a failed or unexecuted scan after it',async()=>{
  assert.deepEqual(REQUIRED_TESTS_SOURCE.primary_ids.slice(3),['gitleaks','trivy','contract-placement']);
  for(const [name,edit,state] of [
    ['gitleaks',job=>{job.conclusion='failure';},'failed'],
    ['trivy',job=>{job.steps.pop();},'unknown'],
    ['contract-placement',job=>{job.steps.at(-1).conclusion='failure';},'failed'],
  ]){
    // The evidence of an all-green attempt, then the proof over the same jobs with one scan broken.
    const f=fixture(),token=await readRequiredApplicability(f.options());assert.ok(token,name);
    const context={requiredDiffContext:{token,expected:f.expected}};
    assert.equal(qualifyPrimary(profile,copy(f.nativeJobs),REQUIRED_TESTS_SOURCE.file,context).passed,true,name);
    const broken=copy(f.nativeJobs);edit(broken.find(job=>job.name===name));
    const r=qualifyPrimary(profile,broken,REQUIRED_TESTS_SOURCE.file,context);
    assert.equal(r.passed,false,name);assert.equal(r.state,state,name);
  }
});

test('opaque context cannot be forged, serialized, replayed to another request or crossed to another subject/attempt',async()=>{
  const f=fixture(),token=await readRequiredApplicability(f.options());
  for(const bogus of [null,true,{},JSON.parse(JSON.stringify(token)),{passed:true,scope:'migration-verify:not_applicable'}])
    assert.equal(inspectRequiredApplicability(bogus,f.expected),null);
  for(const edit of [e=>e.requestKey={},e=>e.repository='different/repo',e=>e.prNumber++,e=>e.head=B,
    e=>e.base=M,e=>e.runId++,e=>e.runAttempt++]){
    const e={...f.expected};edit(e);assert.equal(inspectRequiredApplicability(token,e),null);
  }
  assert.equal(await readRequiredApplicability({...f.options(),passed:true}),null);
  assert.equal(inspectRequiredApplicability(JSON.parse(JSON.stringify(inspectRequiredApplicability(token,f.expected))),f.expected),null);
});

test('the migration and select-all paths of the selector deny no-op qualification, including rename origins',async()=>{
  const examples=['apps/clued-cloud/supabase/migrations/x.sql','apps/clued-cloud/scripts/production-schema-check.mjs',
    'apps/clued-cloud/scripts/migration-ledger.mjs','apps/clued-cloud/scripts/production-release-baseline.json',
    'apps/clued-cloud/tests/production-schema-drift.test.mjs','apps/clued-cloud/package.json','apps/clued-cloud/package-lock.json',
    'scripts/ci/ci-required-selection.mjs','scripts/ci/ci-known-failures.json','scripts/ci/ci-test-failures-reporter.mjs',
    '.github/workflows/clued-required-tests.yml','.github/actions/something/action.yml'];
  for(const path of examples){
    assert.deepEqual(selectSuites('migration-verify',[path]).suites,['production-schema']);
    assert.equal(await readRequiredApplicability(fixture([{filename:path,status:'modified'}]).options()),null);
    assert.equal(await readRequiredApplicability(fixture([{filename:'docs/moved.md',previous_filename:path,status:'renamed'}]).options()),null);
  }
  assert.equal(await readRequiredApplicability(fixture([]).options()),null);
});

test('incomplete ambiguous excessive or moving PR/compare facts cannot mint an applicability context',async()=>{
  for(const edit of [f=>f.pr.number++,f=>f.pr.head.sha=B,f=>f.pr.base.sha=M,f=>f.pr.base.repo.full_name='bad/repo',
    f=>f.pr.changed_files=2,f=>f.pr.changed_files=301,f=>f.pr.commits=1001,f=>f.compare.files=[],
    f=>f.compare.base_commit.sha=M,f=>f.compare.merge_base_commit.sha='bad',f=>f.compare.commits=[{sha:B}],
    f=>f.compare.files[0].filename='../unsafe',f=>f.compare.files[0].status='renamed',
    f=>f.compare.files[0].previous_filename='old/file',f=>{f.compare.files.push(copy(f.compare.files[0]));f.pr.changed_files=2;}]){
    const f=fixture();edit(f);assert.equal(await readRequiredApplicability(f.options()),null);
  }
  for(const target of ['pr','run']){
    const f=fixture(),read=f.read;let count=0;
    f.read=async route=>{const x=await read(route);if((target==='pr'&&route==='/repos/o/r/pulls/17')||
      (target==='run'&&route==='/repos/o/r/actions/runs/777')){if(++count===2){if(target==='pr')x.base.sha=M;else x.run_attempt++;}}return x;};
    assert.equal(await readRequiredApplicability(f.options()),null);
  }
});

test('complete compare pagination and unchanged nonmigration rename facts are independently retained',async()=>{
  const f=fixture([{filename:'docs/new.md',previous_filename:'docs/old.md',status:'renamed'}]),read=f.read;
  const commits=Array.from({length:100},(_,i)=>({sha:(i+1).toString(16).padStart(40,'0')}));
  f.pr.commits=101;
  f.read=async route=>route.includes('/compare/')?{base_commit:{sha:B},merge_base_commit:{sha:M},total_commits:101,
    commits:route.endsWith('page=1')?commits:[{sha:H}],...(route.endsWith('page=1')?{files:f.compare.files}:{})}:read(route);
  const token=await readRequiredApplicability(f.options()),e=inspectRequiredApplicability(token,f.expected);
  assert.ok(e);assert.equal(e.commit_count,101);assert.deepEqual(e.changed_paths,['docs/new.md','docs/old.md']);
  const duplicate=fixture(),original=duplicate.read;duplicate.pr.commits=101;
  duplicate.read=async route=>route.includes('/compare/')?{base_commit:{sha:B},merge_base_commit:{sha:M},total_commits:101,
    commits:route.endsWith('page=1')?commits:[commits[0]],...(route.endsWith('page=1')?{files:duplicate.compare.files}:{})}:original(route);
  assert.equal(await readRequiredApplicability(duplicate.options()),null);
});

test('missing logs, fake CLI identity, wrong native jobs or changed selector never fall back to candidate code',async()=>{
  for(const edit of [f=>f.run.head_sha=B,f=>f.run.repository.full_name='bad/repo',f=>f.run.run_attempt++,
    f=>f.run.path='.github/workflows/other.yml',f=>f.nativeJobs[0].id=102,f=>f.nativeJobs[2].run_attempt++,
    f=>f.gateLog.complete=false,f=>f.gateLog.run_id++,f=>f.gateLog.text+=f.gateLog.text,
    f=>f.gateLog.text=f.gateLog.text.replace(B,M),f=>f.gateLog.text+='\n{\n',
    f=>f.gateLog.text='no actual checkout or identity']){
    const f=fixture();edit(f);
    assert.equal(await readRequiredApplicability(f.options()),null);
  }
  for(const changed of ['missing','wrong']){
    const f=fixture(),read=f.read;f.read=async route=>route.includes('/contents/'+REQUIRED_SELECTOR_SOURCE.path+'?')?
      changed==='missing'?{message:'Not Found'}:content(REQUIRED_SELECTOR_SOURCE.path,Buffer.from('changed selector')):read(route);
    assert.equal(await readRequiredApplicability(f.options()),null);
    assert.equal(f.calls.some(route=>route.includes('?ref='+H)),false);
  }
});

test('abort and foreign port errors are closed, do not leak values and never start a late continuation',async()=>{
  const f=fixture(),control=new AbortController();let resolve,called=0;
  f.read=async()=>{called++;return new Promise(r=>{resolve=r;});};
  const result=readRequiredApplicability({...f.options(),signal:control.signal});await new Promise(r=>setImmediate(r));
  control.abort();assert.equal(await result,null);resolve(copy(f.pr));await new Promise(r=>setImmediate(r));assert.equal(called,1);
  for(const error of ['FOREIGN_SENSITIVE_VALUE',{get code(){throw Error('do not read foreign code');}},new Proxy({},{getPrototypeOf(){throw Error('foreign');}})]){
    const x=fixture();x.read=async()=>{throw error;};assert.equal(await readRequiredApplicability(x.options()),null);
  }
});

test('valid paths with spaces remain supported and a pre-aborted call reads nothing',async()=>{
  const f=fixture([{filename:'docs/Design notes.md',status:'modified'}]);
  const token=await readRequiredApplicability(f.options());assert.ok(token);
  assert.deepEqual(inspectRequiredApplicability(token,f.expected).changed_paths,['docs/Design notes.md']);
  const control=new AbortController();control.abort();const before=f.calls.length;
  assert.equal(await readRequiredApplicability({...f.options(),signal:control.signal}),null);assert.equal(f.calls.length,before);
});

test('outer CI preserves actual execution versus not-applicable children and keeps Source/native barriers',async()=>{
  const f=fixture(),tokenCall=async args=>readRequiredApplicability({...f.options(),requestKey:args.requestKey});
  let callbacks=0;
  const read=async route=>route.includes('/actions/runs?')?{total_count:1,workflow_runs:[copy(f.run)]}:
    route.includes('/attempts/')?{total_count:f.nativeJobs.length,jobs:copy(f.nativeJobs)}:route.endsWith('/777')?copy(f.run):null;
  const options={read,repository,head:H,base:B,prNumber,profiles:{workflows:{[REQUIRED_TESTS_SOURCE.file]:profile}},
    workflows:new Map([[REQUIRED_TESTS_SOURCE.file,REQUIRED_TESTS_SOURCE.workflow_blob]]),authorizeSource:async()=>true,
    revalidateSources:async()=>true,qualifyRequiredApplicability:async args=>{callbacks++;return tokenCall(args);}};
  const r=await qualifiedCI(options);assert.equal(r.passed,true);assert.equal(callbacks,1);
  assert.equal(r.scope,'required_workflow_requirements_satisfied');
  assert.deepEqual(r.scopes[0].primary_scopes.map(x=>[x.job_id,x.scope]),[
    ['clued-cloud-tests','actual_full'],['ci-suites','declared_selected_command'],['migration-verify','not_applicable'],
    ['gitleaks','actual_full'],['trivy','actual_full'],['contract-placement','actual_full']]);
  assert.equal(r.scopes[0].primary_scopes[2].evidence.execution_authority,false);
  for(const patch of [{qualifyRequiredApplicability:undefined},{qualifyRequiredApplicability:async()=>true},
    {qualifyRequiredApplicability:async()=>({passed:true})},{revalidateSources:async()=>false},{base:M}])
    assert.equal((await qualifiedCI({...options,...patch})).passed,false);
  callbacks=0;assert.equal((await qualifiedCI({...options,authorizeSource:async()=>false})).passed,false);assert.equal(callbacks,0);
  const wrong=copy(f.nativeJobs);wrong[3].steps.find(x=>x.name==='Not affected').conclusion='skipped';
  const wrongRead=async route=>route.includes('/attempts/')?{total_count:wrong.length,jobs:wrong}:read(route);
  callbacks=0;assert.equal((await qualifiedCI({...options,read:wrongRead})).passed,false);assert.equal(callbacks,0);
});

// Board line 251: the paths that need the migration verification are the selector's own (selectSuites), not a copy.
// One chain per change: the selector picks production-schema, the issuer mints no not-applicable evidence, and the
// primary proof refuses the attempt whose verification and install steps were skipped.
async function selectedAndRefused(files,label){
  const changed=[...new Set(files.flatMap(file=>[file.filename,...(file.previous_filename?[file.previous_filename]:[])]))];
  assert.deepEqual(selectSuites('migration-verify',changed,'linux').suites,['production-schema'],label);
  const f=fixture(files),token=await readRequiredApplicability(f.options());
  assert.equal(token,null,label);
  const r=qualifyPrimary(profile,copy(f.nativeJobs),REQUIRED_TESTS_SOURCE.file,{requiredDiffContext:{token,expected:f.expected}});
  assert.equal(r.passed,false,label);
}

test('a database test the selector sends to migration-verify gets no not-applicable evidence',async()=>{
  await selectedAndRefused([{filename:'apps/clued-cloud/tests/agent-messages-db.test.mjs',status:'modified'}],'database test');
});

test('a database test helper and a rename out of the migration paths get no not-applicable evidence',async()=>{
  await selectedAndRefused([{filename:'apps/clued-cloud/tests/cluster-cleanup.mjs',status:'modified'}],'helper');
  await selectedAndRefused([{filename:'docs/agent-messages-db.test.mjs',previous_filename:'apps/clued-cloud/tests/agent-messages-db.test.mjs',
    status:'renamed'}],'rename');
});

test('a change outside migration-verify still gets the not-applicable evidence',async()=>{
  assert.deepEqual(selectSuites('migration-verify',['docs/example.md'],'linux').suites,[]);
  const f=fixture([{filename:'docs/example.md',status:'modified'}]),token=await readRequiredApplicability(f.options());
  assert.ok(token);
  assert.equal(qualifyPrimary(profile,copy(f.nativeJobs),REQUIRED_TESTS_SOURCE.file,{requiredDiffContext:{token,expected:f.expected}}).passed,true);
});

test('the last migration-verify pattern of the selector is refused, however far its scope grows',async()=>{
  const pattern=SUITES['migration-verify']['production-schema'].at(-1);
  await selectedAndRefused([{filename:pattern.replaceAll('**','x/y').replaceAll('*','x'),status:'modified'}],pattern);
});
