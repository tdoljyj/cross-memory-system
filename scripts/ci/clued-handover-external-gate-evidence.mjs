// Candidate only. Caller supplies the original, shared-budget GitHub readers.
// Never retain signed URLs, log bytes, authorization headers or claim DTOs.
import nodeAssert from 'node:assert/strict';
import crypto from 'node:crypto';

const SHA40=/^[0-9a-f]{40}$/, SHA64=/^[0-9a-f]{64}$/;
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const DISPATCH='clued-work-admission-dispatch.yml';
const GATE_PATH='scripts/ci/clued-work-admission.mjs';
const LOG_MATCHER_SOURCE_PATH='scripts/ci/clued-gated-proof-runtime.mjs';
const CHECKOUT='Run actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683';
const LIMIT=262144, TTL=1800000;
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
// Only this module can brand a failure. Transport exceptions, including ones
// shaped like an uppercase internal code, never supply public error text.
const GENERIC_FAILURE='CANONICAL_GATE_EVIDENCE_REJECTED',failureCodes=new WeakMap();
const failure=code=>{const error=Object.assign(new Error(code),{code});failureCodes.set(error,code);return error;};
const fail=code=>{throw failure(code);};
const redactedFailure=error=>failure(failureCodes.get(error)??GENERIC_FAILURE);
// Fixed assertion messages below are authored internal codes. Drop the native
// assertion's value-bearing message and retain only that private branded code.
const assert=Object.fromEntries(['ok','equal','notEqual','deepEqual','match'].map(method=>[method,(...args)=>{
  try{return nodeAssert[method](...args);}catch{
    const code=args[method==='ok'?1:2];throw failure(typeof code==='string'?code:GENERIC_FAILURE);
  }
}]));
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,expected,code)=>{
  assert.ok(object(value),code);assert.deepEqual(Object.keys(value).sort(),[...expected].sort(),code);
};
const id=value=>{
  assert.ok(typeof value==='string'||(typeof value==='number'&&Number.isSafeInteger(value)),'UNSAFE_PROVIDER_ID');
  const text=String(value);assert.match(text,/^[1-9][0-9]{0,19}$/,'INVALID_PROVIDER_ID');return text;
};
const time=value=>{
  assert.equal(typeof value,'string','INVALID_PROVIDER_TIME');assert.match(value,ISO,'INVALID_PROVIDER_TIME');
  const parsed=Date.parse(value);assert.ok(Number.isFinite(parsed),'INVALID_PROVIDER_TIME');return parsed;
};
const claimTime=value=>{
  assert.ok(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|\+00:00)$/.test(value),'INVALID_CLAIM_TIME');
  const parsed=Date.parse(value);assert.ok(Number.isFinite(parsed),'INVALID_CLAIM_TIME');return parsed;
};
const endTime=value=>time(value)+(/\.\d+Z$/.test(value)?0:999);
const workflowPath=name=>'.github/workflows/'+name;
const SOURCE_PATHS=[GATE_PATH,workflowPath(DISPATCH),workflowPath('clued-handover-disposable-idle.yml'),
  workflowPath('clued-handover-external-qualification.yml'),LOG_MATCHER_SOURCE_PATH];
// Matcher semantics are the accepted 87cc githubAttemptLogReader family.
// This successor also refuses nonstandard ports and a second redirect.
function nativeLogOrigin(url){
  return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.hash&&
    (url.origin==='https://api.github.com'||url.origin==='https://github.com'||
      /\.blob\.core\.windows\.net$/.test(url.hostname)||/\.actions\.githubusercontent\.com$/.test(url.hostname));
}
function assertLogOrigin(value){
  let url;try{url=new URL(value);}catch{fail('LOG_DOWNLOAD_ORIGIN_INVALID');}
  if(typeof value!=='string'||url.origin!==value||!nativeLogOrigin(url))fail('LOG_DOWNLOAD_ORIGIN_NOT_NATIVE');
}
const caches=new WeakSet();

// Cache eligibility is narrower than API eligibility. No mutable provider facts
// or redirects enter this cache, and a hit still passes the original raw pins.
export function createImmutableSourceReaderCache({repository,paths=SOURCE_PATHS,maxEntries=64}){
  assert.equal(repository,'tdoljyj/cross-memory-system','CACHE_REPOSITORY_REQUIRED');
  assert.ok(Number.isSafeInteger(maxEntries)&&maxEntries>0&&maxEntries<=64,'SOURCE_CACHE_LIMIT_INVALID');
  assert.ok(Array.isArray(paths)&&paths.length>0&&new Set(paths).size===paths.length,'SOURCE_CACHE_PATHS_INVALID');
  for(const path of paths)assert.ok(typeof path==='string'&&/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path)&&
    !path.split('/').some(part=>part==='.'||part==='..'),'SOURCE_CACHE_PATH_INVALID');
  const entries=new Map(), allowed=new Set(paths), prefix='/repos/'+repository+'/contents/';
  const match=route=>{
    if(typeof route!=='string'||!route.startsWith(prefix))return null;
    const found=/^([A-Za-z0-9_.\/-]+)\?ref=([0-9a-f]{40})$/.exec(route.slice(prefix.length));
    return found&&allowed.has(found[1])?{path:found[1],commit:found[2]}:null;
  };
  const knownFields=new Set(['name','path','sha','size','url','html_url','git_url','download_url','type','content','encoding','_links']);
  const verified=(route,dto)=>{
    const ref=match(route);if(!ref||!object(dto)||Object.keys(dto).some(key=>!knownFields.has(key)))return null;
    if(dto.type!=='file'||dto.path!==ref.path||dto.encoding!=='base64'||typeof dto.content!=='string'||
      !Number.isSafeInteger(dto.size)||dto.size<=0||dto.size>524288||!SHA40.test(dto.sha))return null;
    const encoded=dto.content.replace(/\r?\n/g,'');
    if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))return null;
    const bytes=Buffer.from(encoded,'base64');
    if(bytes.length!==dto.size||bytes.toString('base64')!==encoded||
      crypto.createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex')!==dto.sha)return null;
    return {dto:{type:'file',path:ref.path,sha:dto.sha,size:bytes.length,encoding:'base64',content:encoded},sha256:sha(bytes)};
  };
  const cache=Object.freeze({repository,maxEntries,
    get size(){return entries.size;},
    get(route){const entry=match(route)&&entries.get(route);return entry?structuredClone(entry.dto):undefined;},
    remember(route,dto){const value=verified(route,dto);if(!value)return false;
      const existing=entries.get(route);
      if(existing){if(existing.sha256!==value.sha256)fail('IMMUTABLE_SOURCE_CONTENT_CONFLICT');return true;}
      if(entries.size>=maxEntries)return false;
      entries.set(route,value);return true;}
  });caches.add(cache);return cache;
}

async function boundedJson(response){
  if(response.status!==200)fail('GITHUB_JSON_GET_NOT_SUCCESSFUL');
  assert.ok(/^(?:application\/json|application\/[A-Za-z0-9.+-]+\+json)(?:;|$)/i.test(response.headers.get('content-type')??''),'GITHUB_JSON_CONTENT_TYPE');
  assert.ok(response.body?.getReader,'GITHUB_JSON_BODY_MISSING');
  const reader=response.body.getReader(), chunks=[];let length=0;
  try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;
    if(length>524288){await reader.cancel();fail('GITHUB_JSON_SIZE_LIMIT');}chunks.push(Buffer.from(part.value));
  }}catch(error){if(failureCodes.get(error)==='GITHUB_JSON_SIZE_LIMIT')throw error;fail('GITHUB_JSON_INCOMPLETE');}
  finally{reader.releaseLock();}
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,length));}catch{fail('GITHUB_JSON_UTF8_INVALID');}
  try{return JSON.parse(text);}catch{fail('GITHUB_JSON_INVALID');}
}

// realFetch is the driver's already-bounded, shared GET160 transport. This
// factory creates neither an extra counter nor an alternate network client.
export function createEvidenceReaders({repository,token,realFetch,sourceCache}){
  assert.equal(repository,'tdoljyj/cross-memory-system','GITHUB_REPOSITORY_REQUIRED');
  assert.ok(typeof token==='string'&&token.length>0&&token.length<=8192&&!/[\r\n]/.test(token),'GITHUB_TOKEN_REQUIRED');
  assert.equal(typeof realFetch,'function','SHARED_REAL_FETCH_REQUIRED');
  const cache=sourceCache??createImmutableSourceReaderCache({repository});
  assert.ok(caches.has(cache)&&cache.repository===repository,'TRUSTED_SOURCE_CACHE_REQUIRED');
  const root='/repos/'+repository;
  const sourceRoute=route=>typeof route==='string'&&SOURCE_PATHS.some(path=>
    new RegExp('^'+root+'/contents/'+path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\?ref=[0-9a-f]{40}$').test(route));
  const mutableRoute=route=>{
    if(typeof route!=='string'||!route.startsWith(root+'/'))return false;
    const suffix=route.slice(root.length);
    return /^\/actions\/runs\/[1-9][0-9]{0,19}$/.test(suffix)||
      /^\/actions\/jobs\/[1-9][0-9]{0,19}$/.test(suffix)||
      /^\/actions\/runs\/[1-9][0-9]{0,19}\/(?:attempts\/1\/)?jobs\?per_page=100&page=1$/.test(suffix)||
      /^\/check-runs\/[1-9][0-9]{0,19}\/annotations\?per_page=100&page=1$/.test(suffix)||
      /^\/pulls\/[1-9][0-9]{0,19}(?:\/(?:commits|files)\?per_page=100&page=[1-3])?$/.test(suffix)||
      /^\/commits\/[0-9a-f]{40}\/check-runs\?filter=all&per_page=100&page=1$/.test(suffix)||
      /^\/actions\/runs\?head_sha=[0-9a-f]{40}&per_page=100&page=1$/.test(suffix);
  };
  const request=async(route,redirect)=>{
    let response;
    try{response=await realFetch('https://api.github.com'+route,{method:'GET',redirect,
      signal:AbortSignal.timeout(20000),headers:{accept:'application/vnd.github+json',authorization:'Bearer '+token,
        'x-github-api-version':'2022-11-28','user-agent':'clued-disposable-qualification'}});
    }catch{fail('GITHUB_API_GET_FAILED');}
    if(response.redirected||(response.url&&response.url!=='https://api.github.com'+route))fail('GITHUB_API_REDIRECTED');
    return response;
  };
  return Object.freeze({sourceCache:cache,
    async api(route){try{
      if(!sourceRoute(route)&&!mutableRoute(route))fail('GITHUB_JSON_ROUTE_NOT_ALLOWED');
      const prior=sourceRoute(route)?cache.get(route):undefined;if(prior!==undefined)return prior;
      const value=await boundedJson(await request(route,'error'));
      if(sourceRoute(route))cache.remember(route,value);return value;
    }catch(error){throw redactedFailure(error);}},
    async apiResponse(route,options={redirect:'manual'}){try{
      keys(options,['redirect'],'GITHUB_LOG_OPTIONS_INVALID');assert.equal(options.redirect,'manual');
      if(typeof route!=='string'||!new RegExp('^'+root+'/actions/jobs/[1-9][0-9]{0,19}/logs$').test(route))fail('GITHUB_LOG_ROUTE_NOT_ALLOWED');
      return await request(route,'manual');
    }catch(error){throw redactedFailure(error);}}
  });
}
const sameRepo=(run,repository)=>{
  assert.equal(run.repository?.full_name,repository,'RUN_OTHER_REPOSITORY');
  assert.equal(run.head_repository?.full_name,repository,'RUN_OTHER_HEAD_REPOSITORY');
};
const POLICY_KEYS=['mode','task_id','scope','repository','target_branch','branch_prefix','pr_state',
  'draft','auto_merge','unique_match','claim_relation','log_download_policy'];
function policyOf(profile){
  const policy=profile.fixture_selection_policy;keys(policy,POLICY_KEYS,'FIXTURE_POLICY_FIELDS');
  assert.equal(policy.mode,'derive_from_admitted_idle_v1');assert.equal(policy.repository,profile.repository);
  assert.equal(policy.task_id,profile.engineering_task_id);assert.match(policy.task_id,UUID);
  assert.equal(policy.scope,'project:'+profile.project_id);assert.match(profile.project_id,UUID);
  assert.equal(policy.target_branch,'main');assert.equal(profile.target_branch,'main');
  assert.equal(policy.branch_prefix,'clued-handover-disposable-');
  assert.equal(policy.pr_state,'open');assert.equal(policy.draft,true);assert.equal(policy.auto_merge,null);
  assert.equal(policy.unique_match,true);assert.equal(policy.claim_relation,'single_canonical_claim');
  assert.equal(policy.log_download_policy,'github_native_job_log_single_redirect_v1','LOG_DOWNLOAD_POLICY_NOT_ACCEPTED');
  assert.match(profile.runtime_source_commit,SHA40,'RUNTIME_SOURCE_REQUIRED');
  assert.ok(object(profile.gate_source_pins),'ACCEPTED_GATE_SOURCE_PINS_REQUIRED');
  // The actual acceptedSourceCheck files supply the matcher pin; no guessed
  // profile hash or extra network read replaces that whole-Source acceptance.
  for(const path of [GATE_PATH,workflowPath(DISPATCH),workflowPath(profile.fixture_idle_workflow),workflowPath(profile.qualifier_workflow),LOG_MATCHER_SOURCE_PATH])
    assert.match(profile.gate_source_pins[path],SHA64,'ACCEPTED_SOURCE_HASH_MISSING');
  return policy;
}
const FACT_KEYS=['schema','repository','canonical_claim_id','task_id','scope','fence','bound_pr',
  'claim_status','claim_expires_at','claim_base_commit','claim_write_set_sha256',
  'run_id','run_attempt','workflow','ref','head_sha','created_at','actor_id','triggering_actor_id',
  'gate_job_id','gate_step_number','gate_step_started_at','gate_step_completed_at','gate_log_sha256','gate_log_download_origin',
  'admission_run_id','admission_run_attempt','admission_created_at','admission_head_sha','admission_job_id',
  'admission_step_number','admission_step_started_at','admission_step_completed_at','admission_log_sha256','admission_log_download_origin',
  'admission_actor_id','admission_triggering_actor_id','runtime_source_commit','checkout_main_commit',
  'gate_source_sha256','dispatch_workflow_source_sha256','target_workflow_source_sha256'];

// Structural validation also applies to original journal facts after TTL expiry.
// Live time/currentness is checked when reading, not invented from stored facts.
function assertCanonicalGateFactCore(profile,fact,{fresh=true,now=Date.now}={}){
  const policy=policyOf(profile);keys(fact,FACT_KEYS,'CANONICAL_GATE_FACT_FIELDS');
  assert.equal(fact.schema,'clued.handover-canonical-gate-fact/1');
  assert.equal(fact.repository,profile.repository);assert.match(fact.canonical_claim_id,UUID);
  assert.equal(fact.task_id,policy.task_id);assert.equal(fact.scope,policy.scope);
  assert.equal(fact.claim_status,'ACTIVE');assert.ok(Number.isSafeInteger(fact.fence)&&fact.fence>0,'INVALID_CANONICAL_FENCE');
  assert.ok(fact.bound_pr.startsWith(profile.repository+'#'),'BOUND_PR_OTHER_REPOSITORY');
  id(fact.bound_pr.slice(profile.repository.length+1));
  for(const field of ['run_id','gate_job_id','admission_run_id','admission_job_id','actor_id','triggering_actor_id',
    'admission_actor_id','admission_triggering_actor_id'])assert.equal(id(fact[field]),fact[field]);
  assert.notEqual(fact.run_id,fact.admission_run_id);assert.notEqual(fact.gate_job_id,fact.admission_job_id);
  assert.equal(fact.run_attempt,1);assert.equal(fact.admission_run_attempt,1);
  for(const field of ['gate_step_number','admission_step_number'])assert.ok(Number.isSafeInteger(fact[field])&&fact[field]>0,'INVALID_STEP_NUMBER');
  for(const field of ['head_sha','admission_head_sha','runtime_source_commit','checkout_main_commit'])assert.match(fact[field],SHA40);
  if(fact.claim_base_commit!==null)assert.match(fact.claim_base_commit,SHA40);
  for(const field of ['gate_log_sha256','admission_log_sha256','claim_write_set_sha256','gate_source_sha256',
    'dispatch_workflow_source_sha256','target_workflow_source_sha256'])assert.match(fact[field],SHA64);
  assertLogOrigin(fact.gate_log_download_origin);assertLogOrigin(fact.admission_log_download_origin);
  claimTime(fact.claim_expires_at);
  for(const field of ['created_at','admission_created_at','gate_step_started_at','gate_step_completed_at',
    'admission_step_started_at','admission_step_completed_at'])time(fact[field]);
  assert.equal(fact.runtime_source_commit,profile.runtime_source_commit);assert.equal(fact.checkout_main_commit,profile.runtime_source_commit);
  assert.equal(fact.gate_source_sha256,profile.gate_source_pins[GATE_PATH]);
  assert.equal(fact.dispatch_workflow_source_sha256,profile.gate_source_pins[workflowPath(DISPATCH)]);
  assert.equal(fact.target_workflow_source_sha256,profile.gate_source_pins[workflowPath(fact.workflow)]);
  assert.ok([profile.fixture_idle_workflow,profile.qualifier_workflow].includes(fact.workflow),'UNKNOWN_TARGET_WORKFLOW');
  const idle=fact.workflow===profile.fixture_idle_workflow, actors=profile.idle_selection_policy;
  assert.equal(fact.actor_id,id(actors[idle?'idle_actor_id':'qualifier_actor_id']));
  assert.equal(fact.triggering_actor_id,id(actors[idle?'idle_triggering_actor_id':'qualifier_triggering_actor_id']));
  assert.equal(fact.admission_actor_id,fact.actor_id);assert.equal(fact.admission_triggering_actor_id,fact.triggering_actor_id);
  if(idle)assert.ok(fact.ref.startsWith(policy.branch_prefix),'IDLE_BRANCH_OUTSIDE_FIXED_PREFIX');
  else{assert.equal(fact.ref,'main');assert.equal(fact.head_sha,profile.runtime_source_commit);}
  assert.ok(time(fact.created_at)<=time(fact.gate_step_started_at));
  assert.ok(time(fact.gate_step_started_at)<=endTime(fact.gate_step_completed_at));
  assert.ok(time(fact.admission_created_at)<=time(fact.admission_step_started_at));
  assert.ok(time(fact.admission_step_started_at)<=endTime(fact.admission_step_completed_at));
  assert.ok(time(fact.admission_step_completed_at)<=endTime(fact.gate_step_started_at),'ADMISSION_AFTER_HEAVY_GATE');
  assert.ok(claimTime(fact.claim_expires_at)>time(fact.admission_step_completed_at),'CLAIM_EXPIRED_DURING_ADMISSION');
  assert.ok(claimTime(fact.claim_expires_at)>time(fact.created_at),'CLAIM_EXPIRED_BEFORE_TARGET_RUN');
  assert.ok(time(fact.created_at)-time(fact.admission_created_at)>=0&&
    time(fact.created_at)-time(fact.admission_created_at)<=TTL,'ORIGINAL_ADMISSION_TTL_INVALID');
  if(fresh){const at=typeof now==='function'?now():now;assert.ok(Number.isFinite(at),'CURRENT_TIME_REQUIRED');
    assert.ok(at>=time(fact.admission_created_at)&&at-time(fact.admission_created_at)<=TTL,'ADMISSION_EXPIRED');
    assert.ok(claimTime(fact.claim_expires_at)>at,'CANONICAL_CLAIM_EXPIRED');}
  return fact;
}
export function assertCanonicalGateFact(profile,fact,options={}){
  try{return assertCanonicalGateFactCore(profile,fact,options);}catch(error){throw redactedFailure(error);}
}

async function completeBytes(response){
  assert.equal(response.status,200,'LOG_DOWNLOAD_NOT_SUCCESSFUL');
  const type=response.headers.get('content-type')??'';
  assert.ok(/^(?:text\/plain|application\/octet-stream)(?:;|$)/i.test(type),'LOG_CONTENT_TYPE_UNEXPECTED');
  const length=response.headers.get('content-length');
  if(length!==null)assert.ok(/^[0-9]+$/.test(length)&&Number(length)<=LIMIT,'LOG_SIZE_LIMIT');
  assert.ok(response.body?.getReader,'LOG_BODY_MISSING');
  const reader=response.body.getReader(), chunks=[];let size=0;
  try{while(true){const part=await reader.read();if(part.done)break;
    size+=part.value.byteLength;if(size>LIMIT){await reader.cancel();fail('LOG_SIZE_LIMIT');}chunks.push(Buffer.from(part.value));
  }}catch{fail('LOG_DOWNLOAD_INCOMPLETE');}finally{reader.releaseLock();}
  if(length!==null)assert.equal(size,Number(length),'LOG_CONTENT_LENGTH_MISMATCH');
  assert.ok(size>0,'EMPTY_JOB_LOG');return Buffer.concat(chunks,size);
}
async function logOf({root,job,run,api,apiResponse,realFetch}){
  // Repeat the existing native reader's job detail observation immediately
  // before requesting the signed location. Mutable detail is never cached.
  const current=await api(root+'/actions/jobs/'+id(job.id));
  assert.equal(id(current.id),id(job.id),'LOG_JOB_ID_CHANGED');
  assert.equal(id(current.run_id),id(run.id),'LOG_JOB_RUN_CHANGED');
  assert.equal(current.run_attempt,run.run_attempt,'LOG_JOB_ATTEMPT_CHANGED');
  assert.equal(current.status,'completed','LOG_JOB_NOT_COMPLETED');
  assert.equal(current.conclusion,job.conclusion,'LOG_JOB_CONCLUSION_CHANGED');
  const response=await apiResponse(root+'/actions/jobs/'+id(job.id)+'/logs',{redirect:'manual'});
  assert.equal(response.status,302,'LOG_API_REDIRECT_REQUIRED');
  let url;try{url=new URL(response.headers.get('location'));}catch{fail('LOG_DOWNLOAD_LOCATION_INVALID');}
  assert.equal(url.protocol,'https:','LOG_DOWNLOAD_REQUIRES_HTTPS');
  if(url.username||url.password||url.port)fail('LOG_DOWNLOAD_URL_AUTHORITY_INVALID');
  if(!nativeLogOrigin(url))fail('LOG_DOWNLOAD_ORIGIN_NOT_NATIVE');
  assert.equal(url.hash,'');
  let download;
  try{download=await realFetch(url.href,{method:'GET',redirect:'error',credentials:'omit',
    signal:AbortSignal.timeout(20000),headers:{accept:'text/plain','user-agent':'clued-disposable-qualification'}});
  }catch{fail('LOG_DOWNLOAD_FAILED');}
  if(download.redirected||(download.url&&download.url!==url.href))fail('LOG_DOWNLOAD_REDIRECTED');
  const bytes=await completeBytes(download);
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('LOG_UTF8_INVALID');}
  assert.ok(text.endsWith('\n'),'LOG_TERMINATOR_MISSING');
  assert.ok(!/log (?:output )?(?:was )?truncated|log size exceeded|log output (?:is )?too (?:large|long)|\[truncated\]/i.test(text),'LOG_TRUNCATED');
  const lines=[];let last=0;
  for(const line of text.replace(/^\uFEFF/,'').split(/\r?\n/)){
    if(line==='')continue;
    const match=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z) (.*)$/.exec(line);
    assert.ok(match,'LOG_TIMESTAMP_LINE_REQUIRED');const at=time(match[1]);
    assert.ok(at>=last,'LOG_TIMESTAMPS_NOT_MONOTONIC');last=at;lines.push({at,text:match[2]});
  }
  return {lines,sha256:sha(bytes),origin:url.origin};
}
function stepOf(job,name){
  assert.ok(Array.isArray(job.steps),'JOB_STEPS_MISSING');const rows=job.steps.filter(s=>s.name===name);
  assert.equal(rows.length,1,'EXPECTED_STEP_NOT_UNIQUE');const step=rows[0];
  assert.ok(Number.isSafeInteger(step.number)&&step.number>0,'INVALID_STEP_NUMBER');
  assert.equal(step.status,'completed');assert.equal(step.conclusion,'success');
  assert.ok(time(step.started_at)>=time(job.started_at));
  assert.ok(time(step.completed_at)>=time(step.started_at));
  assert.ok(endTime(step.completed_at)<=endTime(job.completed_at));return step;
}
function linesOfStep(lines,step){
  return lines.filter(line=>line.at>=time(step.started_at)&&line.at<=endTime(step.completed_at));
}
function checkoutCommit(lines,job){
  const step=stepOf(job,CHECKOUT), rows=linesOfStep(lines,step);
  assert.equal(rows.filter(r=>r.text==='##[group]'+CHECKOUT).length,1,'CHECKOUT_RUN_GROUP_NOT_UNIQUE');
  const commands=rows.flatMap((r,i)=>/^\[command\](?:\/usr\/bin\/git|git) log -1 --format=%H$/.test(r.text)?[i]:[]);
  assert.equal(commands.length,1,'CHECKOUT_COMMIT_COMMAND_NOT_UNIQUE');
  const next=rows[commands[0]+1];assert.ok(next,'CHECKOUT_COMMIT_MISSING');assert.match(next.text,SHA40,'CHECKOUT_COMMIT_INVALID');
  return next.text;
}
const OUTCOME_KEYS=['mode','event','admitted','enforced','verdict','reasons','notices','claim_id','scope','head_sha',
  'base_sha','pr_ref','changed_paths','applicable_workflows','error','admission_mode'];
function outcomeOf(lines,step,mode){
  const command='node '+GATE_PATH+' --mode '+mode, rows=linesOfStep(lines,step);
  const starts=rows.flatMap((r,i)=>r.text==='##[group]Run '+command?[i]:[]);
  assert.equal(starts.length,1,'OUTCOME_COMMAND_GROUP_NOT_UNIQUE');
  let offset=starts[0]+1;assert.equal(rows[offset++]?.text,command,'OUTCOME_COMMAND_MISMATCH');
  while(offset<rows.length&&rows[offset].text!=='##[endgroup]'){
    assert.ok(!rows[offset].text.startsWith('##['),'OUTCOME_COMMAND_GROUP_MALFORMED');offset++;
  }
  assert.equal(rows[offset++]?.text,'##[endgroup]','OUTCOME_COMMAND_GROUP_UNCLOSED');
  const section=[];
  for(;offset<rows.length;offset++){
    const text=rows[offset].text;
    if(text.startsWith('##[group]')||text.startsWith('##[start-action')||text==='Post job cleanup.')break;
    section.push(text);
  }
  let noticeHead=null;
  if(mode==='dispatch-admit'){
    const notice=/^(?:::notice title=clued-admitted-head::|##\[notice\])([0-9a-f]{40})$/.exec(section.shift()??'');
    assert.ok(notice,'ADMITTED_HEAD_NOTICE_MISSING');noticeHead=notice[1];
  }
  assert.equal(section[0],'{','OUTCOME_STRUCTURE_START_MISSING');
  assert.equal(section.at(-1),'}','OUTCOME_STRUCTURE_END_MISSING');
  assert.ok(!section.some(s=>s.includes('***')||s.includes('\u001b')||s.startsWith('##[')),'OUTCOME_MASKED_OR_INTERLEAVED');
  let parsed;try{parsed=JSON.parse(section.join('\n'));}catch{fail('OUTCOME_NOT_UNIQUE_COMPLETE_JSON');}
  keys(parsed,[...OUTCOME_KEYS,mode==='gate'?'admission_run':'claim'],'OUTCOME_FIELDS');
  assert.equal(parsed.mode,mode);assert.equal(parsed.event,'workflow_dispatch');assert.equal(parsed.admitted,true);
  assert.equal(parsed.enforced,true);assert.equal(parsed.verdict,'ADMITTED');
  for(const field of ['reasons','notices','changed_paths','applicable_workflows'])
    assert.ok(Array.isArray(parsed[field])&&parsed[field].length===0,'OUTCOME_UNEXPECTED_ARRAY_CONTENT');
  for(const field of ['error','admission_mode','base_sha','pr_ref'])assert.ok(parsed[field]===null,'OUTCOME_UNEXPECTED_CONTENT');
  assert.match(parsed.claim_id,UUID);assert.match(parsed.head_sha,SHA40);
  if(noticeHead!==null)assert.equal(noticeHead,parsed.head_sha,'ADMITTED_NOTICE_HEAD_MISMATCH');
  // JSON.parse accepts duplicate object keys. Demand the producer's exact pretty
  // serialization so duplicate/extra blocks or caller-selected JSON cannot pass.
  if(section.join('\n')!==JSON.stringify(parsed,null,2))fail('OUTCOME_NOT_CANONICAL_STDOUT');
  return parsed;
}
async function sourceOf(api,root,path,commit,expected){
  assert.match(commit,SHA40);assert.match(expected,SHA64,'ACCEPTED_SOURCE_HASH_MISSING');
  const file=await api(root+'/contents/'+path+'?ref='+commit);
  assert.equal(file.type,'file');assert.equal(file.path,path);assert.equal(file.encoding,'base64');
  assert.ok(Number.isSafeInteger(file.size)&&file.size>0&&file.size<=524288,'SOURCE_SIZE_INVALID');
  assert.match(file.sha,SHA40);assert.equal(typeof file.content,'string');
  assert.ok(/^[A-Za-z0-9+/=\r\n]+$/.test(file.content),'SOURCE_BASE64_INVALID');
  const bytes=Buffer.from(file.content,'base64');assert.equal(bytes.length,file.size);
  assert.equal(crypto.createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex'),file.sha,'SOURCE_GIT_BLOB_MISMATCH');
  assert.equal(sha(bytes),expected,'SOURCE_NOT_ACCEPTED');return expected;
}
function assertJob(job,run){
  id(job.id);assert.equal(id(job.run_id),id(run.id));assert.equal(job.run_attempt,1);assert.equal(job.head_sha,run.head_sha);
  assert.equal(job.status,'completed');assert.equal(job.conclusion,'success');
  assert.ok(time(job.started_at)>=time(run.created_at));assert.ok(time(job.completed_at)>=time(job.started_at));
}
async function jobsOf(api,root,run){
  const result=await api(root+'/actions/runs/'+id(run.id)+'/attempts/1/jobs?per_page=100&page=1');
  assert.ok(Array.isArray(result.jobs)&&result.jobs.length>0&&result.jobs.length<100,'INCOMPLETE_RUN_JOBS');
  assert.equal(result.total_count,result.jobs.length,'INCOMPLETE_RUN_JOBS');
  assert.equal(new Set(result.jobs.map(j=>id(j.id))).size,result.jobs.length,'DUPLICATE_JOB_ID');return result.jobs;
}

async function readCanonicalGateCore({profile,runId,targetWorkflow,targetRef,targetHead,api,apiResponse,realFetch,now=Date.now}){
  const policy=policyOf(profile), at=typeof now==='function'?now():now;
  assert.ok(Number.isFinite(at),'CURRENT_TIME_REQUIRED');assert.match(targetHead,SHA40);
  assert.ok([profile.fixture_idle_workflow,profile.qualifier_workflow].includes(targetWorkflow),'UNKNOWN_TARGET_WORKFLOW');
  assert.equal(typeof api,'function');assert.equal(typeof apiResponse,'function');assert.equal(typeof realFetch,'function');
  const root='/repos/'+profile.repository, run=await api(root+'/actions/runs/'+id(runId));
  assert.equal(id(run.id),id(runId));sameRepo(run,profile.repository);
  assert.equal(run.path,workflowPath(targetWorkflow));assert.equal(run.event,'workflow_dispatch');assert.equal(run.run_attempt,1);
  assert.equal(run.head_sha,targetHead);assert.equal(run.head_branch,targetRef);
  assert.ok(['in_progress','completed'].includes(run.status),'HEAVY_RUN_NOT_STARTED');
  assert.ok(time(run.created_at)<=at,'FUTURE_HEAVY_RUN');
  const idle=targetWorkflow===profile.fixture_idle_workflow, actors=profile.idle_selection_policy;
  const actor=id(actors[idle?'idle_actor_id':'qualifier_actor_id']);
  const triggering=id(actors[idle?'idle_triggering_actor_id':'qualifier_triggering_actor_id']);
  assert.equal(id(run.actor?.id),actor);assert.equal(id(run.triggering_actor?.id),triggering);
  const jobs=await jobsOf(api,root,run), gates=jobs.filter(j=>j.name==='admission-gate');
  assert.equal(gates.length,1,'ADMISSION_GATE_NOT_UNIQUE');const gate=gates[0];assertJob(gate,run);
  assert.ok(endTime(gate.completed_at)<=at+999,'FUTURE_GATE_COMPLETION');
  const gateStep=stepOf(gate,'Run node '+GATE_PATH+' --mode gate');
  const gateLog=await logOf({root,job:gate,run,api,apiResponse,realFetch});
  assert.equal(checkoutCommit(gateLog.lines,gate),profile.runtime_source_commit,'GATE_CHECKOUT_SOURCE_MISMATCH');
  const gated=outcomeOf(gateLog.lines,gateStep,'gate');assert.equal(gated.scope,null);
  assert.equal(gated.head_sha,targetHead);keys(gated.admission_run,['id','status','conclusion','html_url'],'GATE_ADMISSION_RUN_FIELDS');
  assert.equal(gated.admission_run.status,'completed');assert.equal(gated.admission_run.conclusion,'success');
  const admissionId=id(gated.admission_run.id);assert.notEqual(admissionId,id(run.id));
  const admission=await api(root+'/actions/runs/'+admissionId);assert.equal(id(admission.id),admissionId);sameRepo(admission,profile.repository);
  assert.equal(admission.path,workflowPath(DISPATCH));assert.equal(admission.event,'workflow_dispatch');assert.equal(admission.run_attempt,1);
  assert.equal(admission.head_branch,'main');assert.match(admission.head_sha,SHA40);
  assert.equal(admission.status,'completed');assert.equal(admission.conclusion,'success');
  assert.equal(admission.display_title,'admit '+targetWorkflow+' '+targetRef+' '+gated.claim_id,'ADMISSION_OTHER_TARGET');
  assert.equal(id(admission.actor?.id),actor);assert.equal(id(admission.triggering_actor?.id),triggering);
  const admissionCreated=time(admission.created_at);assert.ok(admissionCreated<=time(run.created_at),'ADMISSION_AFTER_TARGET_RUN');
  assert.ok(at>=admissionCreated&&at-admissionCreated<=TTL,'ADMISSION_EXPIRED');
  const admitJobs=await jobsOf(api,root,admission), admitRows=admitJobs.filter(j=>j.name==='clued-work-admission-dispatch');
  assert.equal(admitRows.length,1,'DISPATCH_ADMIT_JOB_NOT_UNIQUE');assert.equal(admitJobs.length,1,'DISPATCH_ADMIT_EXTRA_JOBS');
  const admit=admitRows[0];assertJob(admit,admission);const admitStep=stepOf(admit,'Verify the work claim with Clued');
  assert.ok(time(admitStep.completed_at)<=endTime(gateStep.started_at),'ADMISSION_AFTER_HEAVY_GATE');
  const annotations=await api(root+'/check-runs/'+id(admit.id)+'/annotations?per_page=100&page=1');
  assert.ok(Array.isArray(annotations)&&annotations.length<100,'INCOMPLETE_ADMISSION_ANNOTATIONS');
  const heads=annotations.filter(note=>note.title==='clued-admitted-head');assert.equal(heads.length,1,'ADMITTED_HEAD_NOT_UNIQUE');
  assert.equal(heads[0].annotation_level,'notice');assert.equal(heads[0].message,targetHead,'ADMITTED_HEAD_MISMATCH');
  const admitLog=await logOf({root,job:admit,run:admission,api,apiResponse,realFetch});
  assert.equal(checkoutCommit(admitLog.lines,admit),profile.runtime_source_commit,'ADMIT_CHECKOUT_SOURCE_MISMATCH');
  const admitted=outcomeOf(admitLog.lines,admitStep,'dispatch-admit');
  assert.equal(admitted.claim_id,gated.claim_id);assert.equal(admitted.scope,policy.scope);assert.equal(admitted.head_sha,targetHead);
  keys(admitted.claim,['task_id','status','fence','expires_at','base_commit','bound_pr','write_set'],'ADMITTED_CLAIM_FIELDS');
  assert.ok(Array.isArray(admitted.claim.write_set)&&admitted.claim.write_set.length>0&&admitted.claim.write_set.length<=512,'CLAIM_WRITE_SET_INVALID');
  for(const path of admitted.claim.write_set)assert.ok(typeof path==='string'&&path.length>0&&path.length<=8192&&!/[\x00-\x1f]/.test(path),'CLAIM_WRITE_SET_INVALID');
  assert.equal(new Set(admitted.claim.write_set).size,admitted.claim.write_set.length,'CLAIM_WRITE_SET_DUPLICATE');
  assert.ok(claimTime(admitted.claim.expires_at)>at,'CANONICAL_CLAIM_EXPIRED');
  const pins=profile.gate_source_pins;
  const gateHash=await sourceOf(api,root,GATE_PATH,profile.runtime_source_commit,pins[GATE_PATH]);
  const dispatchPath=workflowPath(DISPATCH), targetPath=workflowPath(targetWorkflow);
  const dispatchHash=await sourceOf(api,root,dispatchPath,profile.runtime_source_commit,pins[dispatchPath]);
  await sourceOf(api,root,dispatchPath,admission.head_sha,pins[dispatchPath]);
  const targetHash=await sourceOf(api,root,targetPath,profile.runtime_source_commit,pins[targetPath]);
  await sourceOf(api,root,targetPath,targetHead,pins[targetPath]);
  const fact={schema:'clued.handover-canonical-gate-fact/1',repository:profile.repository,
    canonical_claim_id:admitted.claim_id,task_id:admitted.claim.task_id,scope:admitted.scope,fence:admitted.claim.fence,
    bound_pr:admitted.claim.bound_pr,claim_status:admitted.claim.status,claim_expires_at:admitted.claim.expires_at,
    claim_base_commit:admitted.claim.base_commit,claim_write_set_sha256:sha(JSON.stringify(admitted.claim.write_set)),
    run_id:id(run.id),run_attempt:1,workflow:targetWorkflow,ref:targetRef,head_sha:targetHead,created_at:run.created_at,
    actor_id:actor,triggering_actor_id:triggering,gate_job_id:id(gate.id),gate_step_number:gateStep.number,
    gate_step_started_at:gateStep.started_at,gate_step_completed_at:gateStep.completed_at,gate_log_sha256:gateLog.sha256,
    gate_log_download_origin:gateLog.origin,
    admission_run_id:admissionId,admission_run_attempt:1,admission_created_at:admission.created_at,admission_head_sha:admission.head_sha,
    admission_job_id:id(admit.id),admission_step_number:admitStep.number,admission_step_started_at:admitStep.started_at,
    admission_step_completed_at:admitStep.completed_at,admission_log_sha256:admitLog.sha256,
    admission_log_download_origin:admitLog.origin,
    admission_actor_id:actor,admission_triggering_actor_id:triggering,runtime_source_commit:profile.runtime_source_commit,
    checkout_main_commit:profile.runtime_source_commit,gate_source_sha256:gateHash,
    dispatch_workflow_source_sha256:dispatchHash,target_workflow_source_sha256:targetHash};
  const finalAt=typeof now==='function'?now():now;
  assert.ok(Number.isFinite(finalAt)&&finalAt>=at,'CURRENT_TIME_MOVED_BACKWARD');
  assert.ok(endTime(fact.gate_step_completed_at)<=finalAt+999,'FUTURE_GATE_COMPLETION');
  return assertCanonicalGateFact(profile,fact,{fresh:true,now:finalAt});
}
export async function readCanonicalGate(args){
  try{return await readCanonicalGateCore(args);}catch(error){throw redactedFailure(error);}
}
