// Native data reader. All network calls use the caller's existing budgetedFetch
// request(route); this module creates no token, budget, retry or official metric.
import { createHash } from 'node:crypto';

export const NATIVE_POPULATION_SCHEMA = 'clued.merge-admission-native-population/1';
export const NATIVE_REPOSITORY = 'tdoljyj/cross-memory-system';
const PAGE_SIZE = 100, MAX_RUNS = 100000, MAX_ATTEMPTS = 100, MAX_JOBS = 10000;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const CONCLUSIONS = new Set(['success','failure','neutral','cancelled','skipped','timed_out','action_required','stale','startup_failure']);
const STATUSES = new Set(['completed','queued','in_progress','requested','waiting','pending']);
const STOPS = new Set(['request_cap','rate_limit_floor','time_budget','rate_limited']);
const fail = code => { throw code; };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compareId = (a,b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
const clone = value => JSON.parse(JSON.stringify(value));
function id(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)) return value;
  fail('invalid_native_identity');
}
function ordinal(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ATTEMPTS) fail('invalid_native_attempt');
  return value;
}
function text(value, max = 500) {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail('invalid_native_text');
  return value;
}
function time(value, nullable = false) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) fail('invalid_native_timestamp');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().replace('.000Z','Z') !== value.replace('.000Z','Z')) fail('invalid_native_timestamp');
  return new Date(ms).toISOString();
}
function rawJson(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_STORE_BYTES) fail('invalid_raw_json');
  try { return JSON.parse(raw); } catch { fail('invalid_raw_json'); }
}
function windowOf(raw) {
  const value = rawJson(raw);
  if (!exact(value,['start','end'])) fail('invalid_window');
  const start=time(value.start),end=time(value.end);
  if (start >= end) fail('invalid_window');
  return {start,end};
}
function repositoryOf(repository) {
  if (repository !== NATIVE_REPOSITORY) fail('repository_out_of_scope');
  return repository;
}
function normalizeRun(value) {
  if (!object(value) || !STATUSES.has(value.status) || !/^[0-9a-f]{40}$/.test(value.head_sha ?? '')) fail('invalid_native_run');
  const runId=id(value.id ?? value.run_id),attempt=ordinal(value.run_attempt),workflowId=id(value.workflow_id);
  const created=time(value.created_at),started=time(value.run_started_at ?? null,true),updated=time(value.updated_at);
  if (created>updated || (started!==null && (started<created || started>updated))) fail('invalid_native_run_time');
  const conclusion=value.conclusion ?? null;
  if (value.status==='completed' ? !CONCLUSIONS.has(conclusion) : conclusion!==null) fail('invalid_native_run_conclusion');
  if (!Array.isArray(value.pull_requests) || value.pull_requests.length>1000) fail('invalid_native_pull_association');
  const seen=new Set();
  const pulls=value.pull_requests.map(row=>{
    if (!object(row) || !Number.isSafeInteger(row.number) || row.number<1 || seen.has(row.number)) fail('invalid_native_pull_association');
    seen.add(row.number);return row.number;
  }).sort((a,b)=>a-b);
  return {run_id:runId,run_attempt:attempt,workflow_id:workflowId,path:text(value.path),event:text(value.event,64),
    head_sha:value.head_sha,status:value.status,conclusion,created_at:created,run_started_at:started,updated_at:updated,pull_requests:pulls};
}
function nativeWireRun(run) {
  return {id:run.run_id,run_attempt:run.run_attempt,workflow_id:run.workflow_id,path:run.path,event:run.event,
    head_sha:run.head_sha,status:run.status,conclusion:run.conclusion,created_at:run.created_at,
    run_started_at:run.run_started_at,updated_at:run.updated_at,pull_requests:run.pull_requests.map(number=>({number}))};
}
function normalizeJob(value, run) {
  if (!object(value) || id(value.run_id)!==run.run_id || ordinal(value.run_attempt)!==run.run_attempt ||
      value.status!=='completed' || !CONCLUSIONS.has(value.conclusion)) fail('invalid_native_job_member');
  const created=time(value.created_at),started=time(value.started_at ?? null,true),completed=time(value.completed_at ?? null,true);
  // Creation must fit the associated Native run envelope even when execution
  // timestamps are absent. updated_at remains an update bound, not completion.
  if (created<run.created_at || created>run.updated_at ||
      (started!==null && (created>started || run.run_started_at===null || started<run.run_started_at)) ||
      (completed!==null && (created>completed || (started!==null && started>completed) || completed>run.updated_at)) ||
      (completed===null && !['cancelled','skipped'].includes(value.conclusion))) fail('invalid_native_job_time');
  if (!Array.isArray(value.labels) || value.labels.length>100 || !Array.isArray(value.steps) || value.steps.length>10000) fail('invalid_native_job_details');
  const stepIds=new Set();
  const steps=value.steps.map(step=>{
    if (!object(step) || !Number.isSafeInteger(step.number) || step.number<1 || stepIds.has(step.number) ||
        !['completed','queued','in_progress'].includes(step.status)) fail('invalid_native_step');
    stepIds.add(step.number);const conclusion=step.conclusion ?? null;
    if (step.status==='completed' ? !CONCLUSIONS.has(conclusion) : conclusion!==null) fail('invalid_native_step');
    const s=time(step.started_at ?? null,true),e=time(step.completed_at ?? null,true);
    if ((s!==null && (started===null || s<started || (completed!==null && s>completed))) ||
        (e!==null && (s!==null && s>e || completed!==null && e>completed))) fail('invalid_native_step_time');
    return {number:step.number,name:text(step.name),status:step.status,conclusion,started_at:s,completed_at:e};
  }).sort((a,b)=>a.number-b.number);
  return {id:id(value.id),run_id:run.run_id,run_attempt:run.run_attempt,name:text(value.name),status:value.status,
    conclusion:value.conclusion,created_at:created,started_at:started,completed_at:completed,
    labels:value.labels.map(label=>text(label,200)),steps};
}
const keyOf = run => `${run.run_id}:${run.run_attempt}`;
function packetOf(run,jobs) {
  const sorted=[...jobs].sort((a,b)=>compareId(a.id,b.id));
  return {run,jobs:sorted,run_digest:digest(run),jobs_digest:digest(sorted),job_count:sorted.length,
    timing_basis:{attempt_start:'native_run_started_at_nullable',terminal_update:'native_updated_at_not_completion_time'}};
}
function validateStore(raw,repository) {
  const value=rawJson(raw);
  if (!exact(value,['schema','repository','packets']) || value.schema!==NATIVE_POPULATION_SCHEMA || value.repository!==repository ||
      !object(value.packets) || Object.keys(value.packets).length>MAX_RUNS*MAX_ATTEMPTS) fail('invalid_attempt_store');
  const packets=Object.create(null),owners=new Map(),runs=new Map();
  for (const [key,p] of Object.entries(value.packets)) {
    if (!exact(p,['run','jobs','run_digest','jobs_digest','job_count','timing_basis']) || !Array.isArray(p.jobs)) fail('invalid_attempt_store');
    const run=normalizeRun(nativeWireRun(p.run));
    if (run.status!=='completed' || key!==keyOf(run) || p.jobs.length>MAX_JOBS) fail('invalid_attempt_store');
    const jobs=p.jobs.map(job=>normalizeJob(job,run)),packet=packetOf(run,jobs);
    if (JSON.stringify(packet)!==JSON.stringify(p)) fail('invalid_attempt_store');
    for (const job of jobs) { if (owners.has(job.id)) fail('duplicate_native_job_identity');owners.set(job.id,key); }
    let list=runs.get(run.run_id);if(!list){list=[];runs.set(run.run_id,list);}list.push(packet);
    packets[key]=packet;
  }
  for (const list of runs.values()) {
    list.sort((a,b)=>a.run.run_attempt-b.run.run_attempt);
    for (let i=1;i<list.length;i++) {
      const prior=list[i-1],a=prior.run,b=list[i].run;
      if (a.head_sha!==b.head_sha || a.created_at!==b.created_at || a.workflow_id!==b.workflow_id || a.path!==b.path || a.event!==b.event) fail('cross_attempt_identity_changed');
      // updated_at is not a completion clock. Only actual start/job end values
      // can demonstrate contradictory execution overlap between ordinals.
      if (b.run_started_at!==null && ((a.run_started_at!==null&&a.run_started_at>b.run_started_at) ||
          prior.jobs.some(job=>job.completed_at!==null&&job.completed_at>b.run_started_at))) fail('attempt_chronology_invalid');
    }
  }
  return {schema:NATIVE_POPULATION_SCHEMA,repository,packets};
}
function serialize(store) {
  const raw=JSON.stringify(store);if(Buffer.byteLength(raw)>MAX_STORE_BYTES)fail('store_size_limit');return raw;
}
export function emptyNativePopulationStore(repository=NATIVE_REPOSITORY) {
  repositoryOf(repository);return serialize({schema:NATIVE_POPULATION_SCHEMA,repository,packets:{}});
}
function transportQualification(cacheUsed=false) {
  return {native_data_consistency:'NOT_ESTABLISHED',credential_authentication:'TRUSTED_CALLER_TRANSPORT_REQUIRED',
    persisted_cache_authentication:cacheUsed?'PLATFORM_BOUND_CACHE_VERIFICATION_REQUIRED':'NOT_USED',official_metric:'OUTSIDE_NATIVE_READER'};
}
const safeReason = error => typeof error==='string' && /^[a-z_]{1,80}$/.test(error) ? error : 'native_request_failed';
function caller(request) {
  if(typeof request!=='function')fail('budgeted_request_required');
  const routes=[];
  return {routes,async get(route){
    routes.push(route);let response;
    try{response=await request(route);}catch{fail('native_request_failed');}
    if(!object(response)||response.ok!==true){fail(STOPS.has(response?.stopped)?response.stopped:'native_request_stopped');}
    if(!object(response.body))fail('invalid_native_response');return response.body;
  }};
}
async function paged(call,route,key,normalize,max) {
  const items=[],seen=new Set();let total=null,pages=0;
  for(let page=1;page<=Math.ceil(max/PAGE_SIZE)+1;page++) {
    const body=await call.get(`${route}${route.includes('?')?'&':'?'}per_page=${PAGE_SIZE}&page=${page}`);
    if(!Number.isSafeInteger(body.total_count)||body.total_count<0||body.total_count>max||!Array.isArray(body[key]))fail('native_page_total_unknown');
    if(total!==null&&total!==body.total_count)fail('native_page_total_changed');total=body.total_count;
    const expected=Math.min(PAGE_SIZE,total-items.length);
    if(expected<0||body[key].length!==expected)fail('native_page_short_or_overfull');
    for(const raw of body[key]) {
      const row=normalize(raw),identity=row.run_id&&key==='workflow_runs'?row.run_id:row.id;
      if(seen.has(identity))fail(key==='workflow_runs'?'duplicate_native_run_identity':'duplicate_native_job_identity');
      seen.add(identity);items.push(row);
    }
    pages++;if(items.length===total){
      const identity=row=>key==='workflow_runs'?row.run_id:row.id;
      return {items,total_count:total,pages,digest:digest([...items].sort((a,b)=>compareId(identity(a),identity(b))))};
    }
  }
  fail('native_page_bound');
}
function sameRunIdentity(a,b) {
  return a.run_id===b.run_id&&a.head_sha===b.head_sha&&a.created_at===b.created_at&&a.workflow_id===b.workflow_id&&a.path===b.path&&a.event===b.event;
}
async function capture(call,repository,runId,attempt,store) {
  const root=`/repos/${repository}/actions/runs/${runId}`;
  const before=normalizeRun(await call.get(root));
  if(before.run_id!==runId || attempt>before.run_attempt)fail('native_run_barrier_invalid');
  const run=normalizeRun(await call.get(`${root}/attempts/${attempt}`));
  if(run.run_id!==runId||run.run_attempt!==attempt||!sameRunIdentity(before,run))fail('native_attempt_identity_changed');
  if(run.status!=='completed')fail('native_attempt_not_terminal');
  const existing=store.packets[keyOf(run)];let first,last,jobs,cacheUsed=false;
  if(existing && existing.run_digest===digest(run)) {
    jobs=existing.jobs;cacheUsed=true;
  } else {
    first=await paged(call,`${root}/attempts/${attempt}/jobs`,'jobs',row=>normalizeJob(row,run),MAX_JOBS);
    last=await paged(call,`${root}/attempts/${attempt}/jobs`,'jobs',row=>normalizeJob(row,run),MAX_JOBS);
    if(first.digest!==last.digest||first.total_count!==last.total_count)fail('native_jobs_changed_at_close');jobs=first.items;
  }
  const afterAttempt=normalizeRun(await call.get(`${root}/attempts/${attempt}`));
  const after=normalizeRun(await call.get(root));
  if(digest(afterAttempt)!==digest(run))fail('native_attempt_changed_at_close');
  if(digest(before)!==digest(after))fail('native_latest_attempt_changed');
  const packet=packetOf(run,jobs),key=keyOf(run);
  if(existing && JSON.stringify(existing)!==JSON.stringify(packet))fail('immutable_attempt_packet_conflict');
  const next={...store,packets:{...store.packets,[key]:packet}};
  const verified=validateStore(serialize(next),repository);
  return {packet,store:verified,key,cacheUsed,barriers:{latest_digest:digest(before),attempt_digest:digest(run),
    jobs_first_digest:first?.digest??null,jobs_last_digest:last?.digest??null,jobs_pages:first?.pages??0,jobs_total:packet.job_count},
    qualification:{...transportQualification(cacheUsed),native_data_consistency:cacheUsed?'CACHED_DATA_REQUIRES_SOURCE_VERIFICATION':'QUALIFIED'}};
}

// Stores keep old terminal packets on every refusal. A legacy run-level cache
// is rejected here; its jobs remain valid only for the old cost report.
export async function captureNativeAttempt({request,repository=NATIVE_REPOSITORY,runId,attempt,storeRaw=emptyNativePopulationStore()}) {
  let store=null,call=null;
  try {
    repositoryOf(repository);store=validateStore(storeRaw,repository);call=caller(request);
    const result=await capture(call,repository,id(runId),ordinal(attempt),store);
    return {status:'COMPLETE',packet:result.packet,key:result.key,store_raw:serialize(result.store),from_cache:result.cacheUsed,
      barriers:result.barriers,native_capture:{kind:result.cacheUsed?'CACHE_NATIVE_METADATA_REVALIDATED':'NATIVE_RUN_ATTEMPT_JOBS_DOUBLE_CAPTURE',routes:call.routes},qualification:result.qualification};
  } catch(error) {
    return {status:'PARTIAL',reason_code:safeReason(error),store_raw:store?serialize(store):null,packet:null,
      native_capture:{kind:'INCOMPLETE',routes:call?.routes??[]},qualification:transportQualification()};
  }
}

function selectedRuns(items,window) {
  // Old-created runs can be rerun in the window. Native updated_at is a search
  // candidate, not a cancellation/completion timestamp or causal proof.
  return items.filter(run=>run.created_at<window.end && run.updated_at>=window.start)
    .sort((a,b)=>compareId(a.run_id,b.run_id));
}
function selectAttempts(packets,window) {
  const included=[],unknown=[];
  for(const packet of packets) {
    const run=packet.run;
    if(run.run_started_at===null) {unknown.push(keyOf(run));continue;}
    if(run.run_started_at>=window.start&&run.run_started_at<window.end)included.push(packet);
  }
  return {included,unknown};
}

// Enumerate the unfiltered Native run inventory, not only created-in-window or
// merged-PR samples. With filters GitHub caps searches at 1,000; this uses none.
// Initial and closing inventories must independently page to their exact totals
// and agree for the selected cohort. All calls share the supplied budget.
export async function collectNativePopulation({request,repository=NATIVE_REPOSITORY,windowRaw,storeRaw=emptyNativePopulationStore()}) {
  let store=null,call=null,window=null,initial=null,closing=null;
  const captured=[],gaps=[];let fromCache=0;
  try {
    repositoryOf(repository);window=windowOf(windowRaw);store=validateStore(storeRaw,repository);call=caller(request);
    const route=`/repos/${repository}/actions/runs`;
    initial=await paged(call,route,'workflow_runs',normalizeRun,MAX_RUNS);
    const first=selectedRuns(initial.items,window);
    for(const selected of first) {
      for(let number=1;number<=selected.run_attempt;number++) {
        // A latest attempt known to begin beyond this fixed window is not part
        // of its attempt-start cohort. A queued/null start is never omitted.
        if(number===selected.run_attempt&&selected.run_started_at!==null&&selected.run_started_at>=window.end)continue;
        try {
          const result=await capture(call,repository,selected.run_id,number,store);
          if(result.barriers.latest_digest!==digest(selected))fail('native_inventory_run_changed');
          store=result.store;captured.push(result.packet);if(result.cacheUsed)fromCache++;
        } catch(error) {
          const reason=safeReason(error);gaps.push({run_id:selected.run_id,run_attempt:number,reason_code:reason});
          if(STOPS.has(reason)||reason==='native_request_stopped')throw reason;
        }
      }
    }
    closing=await paged(call,route,'workflow_runs',normalizeRun,MAX_RUNS);
    const last=selectedRuns(closing.items,window);
    if(digest(first)!==digest(last))fail('native_cohort_changed_at_close');
    const cohort=selectAttempts(captured,window);
    if(cohort.unknown.length)gaps.push(...cohort.unknown.map(key=>({run_id:key.split(':')[0],run_attempt:Number(key.split(':')[1]),reason_code:'attempt_start_unknown'})));
    const complete=gaps.length===0;
    return {schema:NATIVE_POPULATION_SCHEMA,status:complete?'COMPLETE':'PARTIAL',repository,window,
      cohort_basis:'native_run_started_at_half_open',run_count:new Set(cohort.included.map(p=>p.run.run_id)).size,
      attempt_count:cohort.included.length,attempts:cohort.included,observed_terminal_packets:captured,cohort_unknown:cohort.unknown,
      gaps,store_raw:serialize(store),from_cache:fromCache,population_manifest:{complete,selected_run_count:first.length,
        initial_inventory_total:initial.total_count,closing_inventory_total:closing.total_count,
        initial_pages:initial.pages,closing_pages:closing.pages,initial_selection_digest:digest(first),closing_selection_digest:digest(last)},
      native_capture:{kind:'NATIVE_INVENTORY_AND_ATTEMPT_BARRIERS',routes:call.routes},
      qualification:{...transportQualification(fromCache>0),native_data_consistency:complete?
        (fromCache>0?'CACHED_DATA_REQUIRES_SOURCE_VERIFICATION':'QUALIFIED'):'NOT_ESTABLISHED'}};
  } catch(error) {
    return {schema:NATIVE_POPULATION_SCHEMA,status:'PARTIAL',reason_code:safeReason(error),repository:NATIVE_REPOSITORY,window,
      cohort_basis:'native_run_started_at_half_open',attempts:[],observed_terminal_packets:captured,gaps,
      run_count:null,attempt_count:null,store_raw:store?serialize(store):null,from_cache:fromCache,
      population_manifest:{complete:false,initial_inventory_total:initial?.total_count??null,closing_inventory_total:closing?.total_count??null},
      native_capture:{kind:'INCOMPLETE',routes:call?.routes??[]},qualification:transportQualification(fromCache>0)};
  }
}

export function inspectNativePopulationStore(storeRaw,repository=NATIVE_REPOSITORY) {
  try {repositoryOf(repository);const store=validateStore(storeRaw,repository);return {status:'VALID_DATA_STORE',packet_count:Object.keys(store.packets).length,
    packets:clone(store.packets),qualification:transportQualification(true)};}
  catch(error){return {status:'INVALID_DATA_STORE',reason_code:safeReason(error),packet_count:null,qualification:transportQualification()};}
}
