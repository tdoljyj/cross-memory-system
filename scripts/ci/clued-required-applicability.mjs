// Live, request-bound applicability only. No Source, installation or execution
// authority is minted here. Raw logs and provider bodies never leave this module.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {REQUIRED_TESTS_SOURCE} from './clued-workflow-profile.mjs';

export const COMPONENT_VERSION='1.0.15';
export const REQUIRED_MIGRATION_PATHS=Object.freeze([
  'apps/clued-cloud/supabase/**','apps/clued-cloud/scripts/production-schema-*.mjs',
  'apps/clued-cloud/scripts/migration-ledger.mjs','apps/clued-cloud/scripts/production-release-baseline.json',
  'apps/clued-cloud/tests/production-schema-drift.test.mjs','apps/clued-cloud/package.json','apps/clued-cloud/package-lock.json',
]);
export const REQUIRED_SELECT_ALL_PATHS=Object.freeze([
  'scripts/ci/ci-required-selection.mjs','scripts/ci/ci-known-failures.json','scripts/ci/ci-test-failures-reporter.mjs',
  '.github/workflows/clued-required-tests.yml','.github/actions/**',
]);
const tokens=new WeakMap(),SHA=/^[a-f0-9]{40}$/,REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SOURCE_GATE='scripts/ci/clued-work-admission.mjs',MAX_READ_MS=20000,MAX_CONTEXT_AGE_MS=120000;
const hash=value=>createHash('sha256').update(value).digest('hex');
const blob=value=>createHash('sha1').update('blob '+Buffer.byteLength(value)+'\0').update(value).digest('hex');
function localSelectorSource(){
  const path='scripts/ci/ci-required-selection.mjs';
  try{
    const bytes=readFileSync(new URL('./ci-required-selection.mjs',import.meta.url));
    return Object.freeze({path,blob:blob(bytes),sha256:hash(bytes)});
  }catch{
    return Object.freeze({path,blob:null,sha256:null});
  }
}
export const REQUIRED_SELECTOR_SOURCE=localSelectorSource();
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?
  Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const digest=value=>hash(JSON.stringify(canonical(value)));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const positive=n=>Number.isSafeInteger(n)&&n>0;
const safePath=p=>typeof p==='string'&&p.length>0&&p.length<=4096&&!/[\u0000-\u001f\u007f\u0085\u2028\u2029\\]/.test(p)&&
  !p.startsWith('/')&&!p.split('/').some(x=>!x||x==='.'||x==='..');
function glob(pattern) {
  let out='';
  for(let i=0;i<pattern.length;i++) {
    if(pattern[i]==='*'&&pattern[i+1]==='*'){out+='.*';i++;if(pattern[i+1]==='/')i++;}
    else out+=pattern[i]==='*'?'[^/]*':pattern[i].replace(/[.+?^${}()|[\]\\]/g,'\\$&');
  }
  return new RegExp('^'+out+'$');
}
const migrationPatterns=[...REQUIRED_MIGRATION_PATHS,...REQUIRED_SELECT_ALL_PATHS].map(glob);
const policySha=digest({migration:REQUIRED_MIGRATION_PATHS,select_all:REQUIRED_SELECT_ALL_PATHS});
function pull(pr,{repository,prNumber,head,base}) {
  if(pr?.number!==prNumber||pr.state!=='open'||pr.head?.sha!==head||pr.base?.sha!==base||
    pr.base?.repo?.full_name!==repository||!REPO.test(pr.head?.repo?.full_name??'')||
    typeof pr.base.ref!=='string'||!pr.base.ref||pr.base.ref!==pr.base.repo.default_branch||
    /[\u0000-\u0020\u007f]/.test(pr.base.ref)||!positive(pr.commits)||pr.commits>1000||
    !positive(pr.changed_files)||pr.changed_files>300)return null;
  return {repository,pr_number:prNumber,head,base,head_repository:pr.head.repo.full_name,
    default_branch:pr.base.ref,changed_files:pr.changed_files,commits:pr.commits};
}
function runSnapshot(run,s) {
  if(run?.id!==s.runId||run.run_attempt!==s.runAttempt||run.path!==REQUIRED_TESTS_SOURCE.file||
    run.event!=='pull_request'||run.head_sha!==s.head||run.repository?.full_name!==s.repository||
    run.status!=='completed'||run.conclusion!=='success'||!Array.isArray(run.pull_requests)||run.pull_requests.length>1||
    run.pull_requests.some(pr=>pr?.number!==s.prNumber||pr.head?.sha!==undefined&&pr.head.sha!==s.head||
      pr.base?.sha!==undefined&&pr.base.sha!==s.base))return null;
  return {id:run.id,attempt:run.run_attempt,path:run.path,head:run.head_sha,event:run.event,
    repository:run.repository.full_name,status:run.status,conclusion:run.conclusion,
    pull_requests:run.pull_requests.map(pr=>pr.number)};
}
function sourceBytes(content,path,expectedBlob) {
  if(content?.type!=='file'||content.path!==path||content.sha!==expectedBlob||content.encoding!=='base64'||
    !positive(content.size)||content.size>524288||typeof content.content!=='string'||
    !/^[A-Za-z0-9+/=\r\n]*$/.test(content.content))return null;
  const bytes=Buffer.from(content.content.replace(/[\r\n]/g,''),'base64');
  if(bytes.length!==content.size||blob(bytes)!==expectedBlob||!Buffer.from(bytes.toString('utf8'),'utf8').equals(bytes))return null;
  return bytes;
}
function gateBase(log,job,s) {
  if(log?.complete!==true||log.job_id!==job.id||log.run_id!==s.runId||log.run_attempt!==s.runAttempt||
    typeof log.text!=='string'||Buffer.byteLength(log.text)>524288)return null;
  const lines=log.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g,'').split(/\r?\n/)
    .map(line=>line.replace(/^\d{4}-\d\d-\d\dT\S+ /,''));
  const commits=[],results=[];let chunk=[];
  for(let i=0;i<lines.length;i++) {
    const line=lines[i];
    if(/^\[command\].*\/git log -1 --format=%H$/.test(line))commits.push(lines[i+1]);
    if(chunk.length) {
      chunk.push(line);
      if(line==='}') {try{const v=JSON.parse(chunk.join('\n'));if(v?.mode==='gate')results.push(v);}catch{}chunk=[];}
    }else if(line.trim()==='{')chunk=[line];
    else {try{const v=JSON.parse(line);if(v?.mode==='gate')results.push(v);}catch{}}
  }
  const v=results[0];
  if(chunk.length||commits.length!==1||commits[0]!==s.base||results.length!==1||v.event!=='pull_request'||
    v.base_sha!==s.base||v.head_sha!==s.head||v.pr_ref!==s.repository+'#'+s.prNumber||
    v.enforced!==true||v.admitted!==true||typeof v.verdict!=='string'||v.error)return null;
  return hash(log.text);
}

// The only issuer performs the protected reads itself. No importable
// mint-from-boolean, serialized proof, or caller-supplied path policy exists.
export async function readRequiredApplicability(options) {
  if(!REQUIRED_SELECTOR_SOURCE.blob)return null;
  let active=true,timer,externalAbort,externalSignal;const abort=new AbortController();
  const refused=new Error('REQUIRED_APPLICABILITY_UNCONFIRMED');
  try {
    const allowed=new Set(['read','readLog','repository','prNumber','head','base','runId','runAttempt','requestKey','trustedGateBlob','signal']);
    if(!options||typeof options!=='object'||Object.keys(options).some(k=>!allowed.has(k)))return null;
    const {read,readLog,requestKey,signal,...subject}=options;
    if(typeof read!=='function'||typeof readLog!=='function'||!requestKey||typeof requestKey!=='object'||
      !REPO.test(subject.repository??'')||!positive(subject.prNumber)||!SHA.test(subject.head??'')||
      !SHA.test(subject.base??'')||!positive(subject.runId)||!positive(subject.runAttempt)||
      !SHA.test(subject.trustedGateBlob??'')||signal?.aborted)return null;
    let expire;
    const deadline=new Promise((_,reject)=>{expire=()=>{active=false;abort.abort();reject(refused);};timer=setTimeout(expire,MAX_READ_MS);});
    if(signal){externalAbort=expire;signal.addEventListener('abort',externalAbort,{once:true});externalSignal=signal;}
    const call=fn=>{
      if(!active)throw refused;
      return Promise.race([Promise.resolve().then(()=>{if(!active)throw refused;return fn();}),deadline]);
    };
    const get=route=>call(()=>read(route,{signal:abort.signal}));
    const prRoute='/repos/'+subject.repository+'/pulls/'+subject.prNumber;
    const descriptor=pull(await get(prRoute),subject);if(!descriptor)return null;
    const runRoute='/repos/'+subject.repository+'/actions/runs/'+subject.runId;
    const nativeRun=await get(runRoute),native=runSnapshot(nativeRun,subject);if(!native)return null;
    const commits=[],seen=new Set();let mergeBase=null,files=null;
    for(let page=1;page<=10;page++) {
      const body=await get('/repos/'+subject.repository+'/compare/'+subject.base+'...'+subject.head+'?per_page=100&page='+page);
      if(body?.base_commit?.sha!==subject.base||!SHA.test(body.merge_base_commit?.sha??'')||
        mergeBase!==null&&mergeBase!==body.merge_base_commit.sha||body.total_commits!==descriptor.commits||
        !Array.isArray(body.commits)||body.commits.length>100)return null;
      mergeBase=body.merge_base_commit.sha;
      if(page===1){if(!Array.isArray(body.files)||body.files.length!==descriptor.changed_files)return null;files=body.files;}
      for(const commit of body.commits){if(!SHA.test(commit?.sha??'')||seen.has(commit.sha))return null;seen.add(commit.sha);commits.push(commit.sha);}
      if(commits.length===descriptor.commits)break;
      if(commits.length>descriptor.commits||body.commits.length!==100)return null;
    }
    if(commits.length!==descriptor.commits||commits.at(-1)!==subject.head)return null;
    const paths=new Set(),names=new Set();
    for(const file of files) {
      if(!safePath(file?.filename)||names.has(file.filename)||!['added','removed','modified','renamed','copied','changed','unchanged'].includes(file.status))return null;
      names.add(file.filename);paths.add(file.filename);
      if(file.status==='renamed') {
        if(!safePath(file.previous_filename)||file.previous_filename===file.filename)return null;paths.add(file.previous_filename);
      }else if(file.previous_filename!==undefined)return null;
    }
    const changedPaths=[...paths].sort();
    if(!changedPaths.length||Buffer.byteLength(JSON.stringify(changedPaths))>131072||
      changedPaths.some(p=>migrationPatterns.some(pattern=>pattern.test(p))))return null;
    const body=await get(runRoute+'/attempts/'+subject.runAttempt+'/jobs?per_page=100&page=1');
    const requiredNames=['admission-gate',...REQUIRED_TESTS_SOURCE.primary_ids];
    if(body?.total_count!==4||!Array.isArray(body.jobs)||body.jobs.length!==4||
      body.jobs.some(j=>!positive(j?.id)||j.run_id!==subject.runId||j.run_attempt!==subject.runAttempt||
        !requiredNames.includes(j.name)||j.status!=='completed'||j.conclusion!=='success')||
      new Set(body.jobs.map(j=>j.id)).size!==4||new Set(body.jobs.map(j=>j.name)).size!==4)return null;
    const gate=body.jobs.find(j=>j.name==='admission-gate');
    const logSha=gateBase(await call(()=>readLog(gate,nativeRun,{signal:abort.signal})),gate,subject);if(!logSha)return null;
    const selector=sourceBytes(await get('/repos/'+subject.repository+'/contents/'+REQUIRED_SELECTOR_SOURCE.path+'?ref='+subject.base),
      REQUIRED_SELECTOR_SOURCE.path,REQUIRED_SELECTOR_SOURCE.blob);
    if(!selector||hash(selector)!==REQUIRED_SELECTOR_SOURCE.sha256)return null;
    const gateScript=sourceBytes(await get('/repos/'+subject.repository+'/contents/'+SOURCE_GATE+'?ref='+subject.base),SOURCE_GATE,subject.trustedGateBlob);
    if(!gateScript)return null;
    if(!same(pull(await get(prRoute),subject),descriptor)||!same(runSnapshot(await get(runRoute),subject),native)||
      !active||signal?.aborted)return null;
    const diff={descriptor,merge_base:mergeBase,changed_paths:changedPaths,commits};
    const evidence={contract:'clued.required-primary-applicability/1',scope:'migration-verify:not_applicable',
      authority:'none',source_authority:false,execution_authority:false,repository:subject.repository,pr_number:subject.prNumber,
      head_sha:subject.head,base_sha:subject.base,merge_base_sha:mergeBase,run_id:subject.runId,run_attempt:subject.runAttempt,
      workflow_blob:REQUIRED_TESTS_SOURCE.workflow_blob,workflow_source_sha256:REQUIRED_TESTS_SOURCE.source_sha256,
      selector_path:REQUIRED_SELECTOR_SOURCE.path,selector_blob:REQUIRED_SELECTOR_SOURCE.blob,selector_sha256:REQUIRED_SELECTOR_SOURCE.sha256,
      selector_policy_sha256:policySha,gate_job_id:gate.id,gate_script_blob:subject.trustedGateBlob,gate_script_sha256:hash(gateScript),
      gate_log_sha256:logSha,changed_paths:changedPaths,changed_file_count:descriptor.changed_files,commit_count:commits.length,
      diff_sha256:digest(diff),native_job_ids:body.jobs.map(j=>j.id).sort((a,b)=>a-b)};
    const safe=freeze({...evidence,evidence_sha256:digest(evidence)}),token=Object.freeze({});
    tokens.set(token,{requestKey,subject:{...subject},evidence:safe,at:performance.now()});return token;
  }catch{return null;}
  finally {active=false;clearTimeout(timer);abort.abort();try{externalSignal?.removeEventListener('abort',externalAbort);}catch{}}
}

export function inspectRequiredApplicability(token,expected) {
  try {
    const value=tokens.get(token);
    if(!value||!expected||expected.requestKey!==value.requestKey||performance.now()-value.at>MAX_CONTEXT_AGE_MS)return null;
    for(const key of ['repository','prNumber','head','base','runId','runAttempt'])if(expected[key]!==value.subject[key])return null;
    return freeze(structuredClone(value.evidence));
  }catch{return null;}
}
