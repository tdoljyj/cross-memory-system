// Pure repository-ready evidence calculus. No collection, permissions, actions,
// network or persistence. The collector owns actual source/role, Binding and
// official-metric qualification outside this module.
// Supplied immutable frames may come from a verified durable artifact/cache.
// This calculus neither authenticates that cache nor requires refetching every
// historical job. Population scope and collection budgets belong to the Owner
// contract and the real collector, rather than to a caller completeness flag.
import {createHash} from 'node:crypto';
import {timestampMicros} from './merge-admission-measurement-history.mjs';
import {qualifyPrimary} from './clued-gated-proof.mjs';
import {registeredWorkflowSource,selectRegisteredProfiles,rolesForSource,parseWorkflowProfiles} from './clued-workflow-profile.mjs';
import {createCatalogueSourceReader} from './clued-source-only-workflow.mjs';

// Profile bytes retain their independent raw digest and the original strict
// duplicate-key/depth checks; only the runtime view is hydrated from disk/3.
const parseProfileCatalogue=raw=>{parseFourSourceRawData(raw);return parseWorkflowProfiles(raw);};

export const MERGE_ADMISSION_FOUR_SOURCE_PROTOCOL=Object.freeze({
  schema:'clued.merge-admission-four-source-observations/1',
  expectations_schema:'clued.merge-admission-four-source-expectations/1',
  reader_source:'clued.merge-admission-four-sources.reader/1',
  population_cohort:'fixed_window_event_union_and_reference_closure',
  admission_packet_schema:'clued.final-admission-observation/1',
  admission_grammar:'clued.work-admission.evaluate-observation/1',
});
// Candidate data-contract successor. /1 remains a strict singleton Source;
// /2 adds reviewed historical execution snapshots without splitting any
// population, changing metric mathematics, or granting execution authority.
export const MERGE_ADMISSION_FOUR_SOURCE_PROTOCOL_V2=Object.freeze({...MERGE_ADMISSION_FOUR_SOURCE_PROTOCOL,
  schema:'clued.merge-admission-four-source-observations/2',expectations_schema:'clued.merge-admission-four-source-expectations/2',
  reader_source:'clued.merge-admission-four-sources.reader/2'});
export const FOUR_SOURCE_TRANSPORT_INTERFACES=Object.freeze({
  admission:'Actual final evaluate/claim/App observation plus authenticated initial/change/closing/ever-target journal',
  operation:'Real automatic/manual/Owner/holder pre-read/request/response/post receipts and current claim fence',
  round:'Complete qualified workflow/role/attempt/jobs and explicit original-round termination or exact Native merge receipt',
  cancellation:'Full immutable Native cancelled-attempt population; actual causal receipt when available, otherwise UNKNOWN',
  qualification:'Independent current source selections, least-privilege collection, fixed watermark and natural continuity; never a caller boolean',
});
const FORMAL_TRANSPORT_REQUIREMENTS=Object.freeze([
  'typed_project_queue_authorized_reader','immutable_native_attempts_and_complete_jobs',
  'retention_and_fixed_watermark_pagination','authenticated_initial_selection_closing_ever_target_journal',
  'all_automatic_manual_owner_holder_operation_population','reviewed_defaultbranch_producer_source_and_role',
  'operation_fence_request_response_native_pre_post_binding','explicit_final_round_termination_or_native_merge_receipt',
  'native_cancelled_attempt_denominator_with_known_or_unknown_cause',
]);
const isObject=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const hasExact=(x,fields)=>isObject(x)&&Object.keys(x).sort().join(',')===[...fields].sort().join(',');
const validSha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const validDigest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const validUuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const safePath=x=>typeof x==='string'&&x.length>0&&x.length<300&&!x.startsWith('/')&&!/[\\\s]/.test(x)&&x.split('/').every(p=>p&&p!=='.'&&p!=='..');
const gitBlobOf=x=>{if(typeof x!=='string'||Buffer.from(x).toString('utf8')!==x)throw Error('source type');const b=Buffer.from(x);return createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');};
const expectationFailure=()=>({status:'NOT_QUALIFIED',reason_code:'EXPECTED_SOURCE_SELECTION_INVALID',candidate_ready:false,
  source_permission_qualification:'NOT_ESTABLISHED',source_authenticated:false,official_metric:false,execution_permission:false,t0:null});

// Historical observations use the names in their exact reviewed Source bytes.
// These names grant no authority; the caller still verifies every Source pin.
export function admissionDisplayNames(source){
  const checks=[...String(source?.script??'').replace(/\r\n?/g,'\n').matchAll(/^export const APP_CHECK_NAME = "((?:clued|kooyumi)-admission-verified)";$/gm)];
  const jobs=[...String(source?.workflow??'').replace(/\r\n?/g,'\n').matchAll(/^  clued-work-admission:\n    name: ((?:clued|kooyumi)-work-admission)$/gm)];
  if(checks.length!==1||jobs.length!==1)throw Error('ADMISSION_DISPLAY_NAMES_NOT_IN_REVIEWED_SOURCE');
  return {app_check_name:checks[0][1],job_name:jobs[0][1]};
}

// Duplicate decoded keys are rejected. Expected source selection is per call.
export function parseFourSourceRawData(raw){
  if(typeof raw!=='string'||Buffer.byteLength(raw)>32*1024*1024)throw Error('raw data limit');let at=0;
  const ws=()=>{while(/[ \r\n\t]/.test(raw[at]??'!'))at++;};
  const string=()=>{const start=at;if(raw[at++]!=='"')throw Error('JSON');while(at<raw.length){const c=raw[at++];if(c==='"')return JSON.parse(raw.slice(start,at));if(c==='\\')at++;}throw Error('JSON');};
  const value=depth=>{if(depth>40)throw Error('JSON depth');ws();const c=raw[at];
    if(c==='{'){at++;ws();const seen=new Set();if(raw[at]==='}'){at++;return;}while(true){ws();const k=string();if(seen.has(k))throw Error('duplicate key');seen.add(k);ws();if(raw[at++]!==':')throw Error('JSON');value(depth+1);ws();const d=raw[at++];if(d==='}')return;if(d!==',')throw Error('JSON');}}
    if(c==='['){at++;ws();if(raw[at]===']'){at++;return;}while(true){value(depth+1);ws();const d=raw[at++];if(d===']')return;if(d!==',')throw Error('JSON');}}
    if(c==='"'){string();return;}const start=at;while(at<raw.length&&!/[\s,}\]]/.test(raw[at]))at++;if(at===start)throw Error('JSON');JSON.parse(raw.slice(start,at));};
  value(0);ws();if(at!==raw.length)throw Error('JSON');return JSON.parse(raw);
}
function parseExpectations(raw){
  const e=parseFourSourceRawData(raw);
  const v2=e.schema===MERGE_ADMISSION_FOUR_SOURCE_PROTOCOL_V2.expectations_schema;
  if(!hasExact(e,['schema','repository','scope','admission_sources','execution_source',...(v2?['previous_execution_sources']:[])])||
    ![MERGE_ADMISSION_FOUR_SOURCE_PROTOCOL.expectations_schema,MERGE_ADMISSION_FOUR_SOURCE_PROTOCOL_V2.expectations_schema].includes(e.schema)||
    typeof e.repository!=='string'||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(e.repository)||
    !hasExact(e.scope,['project_id','queue_ref'])||!validUuid(e.scope.project_id)||
    typeof e.scope.queue_ref!=='string'||!e.scope.queue_ref.startsWith('merge:'+e.repository.toLowerCase()+':')||
    !/^merge:[a-z0-9_.-]+\/[a-z0-9_.-]+:[a-z0-9_.-]+$/.test(e.scope.queue_ref)||
    !Array.isArray(e.admission_sources)||e.admission_sources.length===0||e.admission_sources.length>20||
    !hasExact(e.execution_source,['source_checkout_sha','profiles_sha256','role_specs_sha256'])||!validSha(e.execution_source.source_checkout_sha)||
    !validDigest(e.execution_source.profiles_sha256)||!validDigest(e.execution_source.role_specs_sha256))throw Error('expectations');
  if(v2){
    if(!Array.isArray(e.previous_execution_sources)||e.previous_execution_sources.length>4)throw Error('expectations');
    const checkouts=new Set([e.execution_source.source_checkout_sha]),versions=new Set([e.execution_source.profiles_sha256+':'+e.execution_source.role_specs_sha256]);
    for(const s of e.previous_execution_sources){
      if(!hasExact(s,['source_checkout_sha','profiles_sha256','role_specs_sha256'])||!validSha(s.source_checkout_sha)||
        !validDigest(s.profiles_sha256)||!validDigest(s.role_specs_sha256)||checkouts.has(s.source_checkout_sha)||versions.has(s.profiles_sha256+':'+s.role_specs_sha256))throw Error('expectations');
      checkouts.add(s.source_checkout_sha);versions.add(s.profiles_sha256+':'+s.role_specs_sha256);
    }
  }
  const seen=new Set(),fields=['grammar','source_checkout_sha','default_branch','script_path','script_blob','workflow_path','workflow_blob','reverify_workflow_path','reverify_workflow_blob','policy_path','policy_blob','app_id'];
  for(const s of e.admission_sources){
    if(!hasExact(s,fields)||s.grammar!==MERGE_ADMISSION_FOUR_SOURCE_PROTOCOL.admission_grammar||!validSha(s.source_checkout_sha)||seen.has(s.source_checkout_sha)||
      !Number.isSafeInteger(s.app_id)||s.app_id<1||typeof s.default_branch!=='string'||!/^[a-z0-9_.-]+$/.test(s.default_branch)||
      e.scope.queue_ref!=='merge:'+e.repository.toLowerCase()+':'+s.default_branch||
      ['script','workflow','reverify_workflow','policy'].some(k=>!safePath(s[k+'_path'])||!validSha(s[k+'_blob'])))throw Error('expectations');
    seen.add(s.source_checkout_sha);
  }return e;
}
function validatedAdmissionSources(raw,expectations){
  const rows=parseFourSourceRawData(raw);if(!Array.isArray(rows)||rows.length>20)throw Error('source packets');const out=new Map();
  for(const row of rows){
    if(!hasExact(row,['source_checkout_sha','sources_raw'])||out.has(row.source_checkout_sha))throw Error('source packets');
    const source=expectations.admission_sources.find(s=>s.source_checkout_sha===row.source_checkout_sha);
    if(!source||typeof row.sources_raw!=='string'||Buffer.byteLength(row.sources_raw)>1024*1024)throw Error('source packets');
    const bytes=parseFourSourceRawData(row.sources_raw);
    if(!hasExact(bytes,['script','workflow','reverify_workflow','policy'])||['script','workflow','reverify_workflow','policy'].some(k=>gitBlobOf(bytes[k])!==source[k+'_blob']))throw Error('source packets');
    out.set(row.source_checkout_sha,row.sources_raw);
  }return out;
}
function projectAdmissionPacket(packetRaw,sources,expectations){
  const packet=parseFourSourceRawData(packetRaw),checkout=packet?.identity?.source_checkout_sha;
  const selected=expectations.admission_sources.find(s=>s.source_checkout_sha===checkout);
  if(!selected)return {status:'NOT_QUALIFIED',reason_code:'ADMISSION_SOURCE_NOT_IN_REVIEWED_SELECTION'};
  if(!sources.has(checkout))return {status:'SOURCE_PACKET_MISSING',source_checkout_sha:checkout};
  return admissionEnvelopeFor({...selected,repository:expectations.repository})(packetRaw,sources.get(checkout));
}

/** Supplied evidence mathematics only. The collector obtains the independent
 * reviewed source contract and authenticates actual evidence outside this API. */
export function readMergeAdmissionFourSources(packetRaw,expectedSourcesRaw){
  let expectations;try{expectations=parseExpectations(expectedSourcesRaw);}catch{return expectationFailure();}
  return readerFor(expectations)(packetRaw);
}
export function finalAdmissionObservation(packetRaw,sourcesRaw,expectedSourcesRaw){
  try{const e=parseExpectations(expectedSourcesRaw),p=parseFourSourceRawData(packetRaw),s=e.admission_sources.find(x=>x.source_checkout_sha===p?.identity?.source_checkout_sha);
    if(!s)return expectationFailure();const sources=validatedAdmissionSources(JSON.stringify([{source_checkout_sha:s.source_checkout_sha,sources_raw:sourcesRaw}]),e);
    const projection=projectAdmissionPacket(packetRaw,sources,e);if(!['FINAL_OUTCOME_CANDIDATE','GAP'].includes(projection.status))return {...expectationFailure(),reason_code:'FINAL_ADMISSION_OBSERVATION_INVALID'};
    return {status:'ADMISSION_PACKET_CANDIDATE',target_key:projection.identity.run_id+':'+projection.identity.run_attempt+':'+projection.identity.pr_number+':'+projection.identity.head_sha,
      packet_raw:packetRaw,projection,source_authenticated:false,official_metric:false,execution_permission:false,t0:null};
  }catch{return expectationFailure();}
}
export function updateOperationObservation(beforeRaw,responseRaw,afterRaw,expectedSourcesRaw){
  try{return operationProducerFor(parseExpectations(expectedSourcesRaw))(beforeRaw,responseRaw,afterRaw);}catch{return expectationFailure();}
}

function admissionEnvelopeFor(SOURCE){
const flags=()=>({provenance_bound:false,source_authenticated:false,official_metric:false,
  execution_qualified:false,merge_permission:false,complete_denominator:false});
const bad=()=>{throw 'invalid_input';};
const obj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>obj(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const SHA=/^[a-f0-9]{40}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha=v=>typeof v==='string'&&SHA.test(v);
const uuid=v=>typeof v==='string'&&UUID.test(v);
const id=v=>typeof v==='string'&&/^[1-9][0-9]{0,19}$/.test(v)?v:
  typeof v==='number'&&Number.isSafeInteger(v)&&v>0?String(v):bad();
const integer=v=>Number.isSafeInteger(v)&&v>0?v:bad();
// Reject duplicate decoded keys, including escaped spellings. JSON.parse alone
// would silently keep the last contradictory identity/verdict/provenance field.
function parse(raw){
  if(typeof raw!=='string'||raw.length>1024*1024)bad();let at=0;
  const ws=()=>{while(/[ \t\n\r]/.test(raw[at]??'!'))at++;};
  const string=()=>{const start=at;if(raw[at++]!=='"')bad();
    while(at<raw.length){const c=raw[at++];if(c==='"'){try{return JSON.parse(raw.slice(start,at));}catch{bad();}}
      if(c==='\\')at++;}bad();};
  const value=depth=>{
    if(depth>64)bad();ws();const c=raw[at];
    if(c==='"'){string();return;}
    if(c==='{'||c==='['){at++;ws();const close=c==='{'?'}':']',keys=new Set();
      if(raw[at]===close){at++;return;}
      for(;;){if(c==='{'){ws();const key=string();if(keys.has(key))bad();keys.add(key);ws();if(raw[at++]!==':')bad();}
        value(depth+1);ws();if(raw[at]===close){at++;return;}if(raw[at++]!==',')bad();}
    }
    const token=/^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(raw.slice(at));
    if(!token)bad();at+=token[0].length;
  };
  value(0);ws();if(at!==raw.length)bad();try{return JSON.parse(raw);}catch{bad();}
}
function time(v){
  if(typeof v!=='string')bad();
  const m=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|\+00:00)$/.exec(v);
  if(!m)bad();const base=Date.parse(m[1]+'Z');
  if(!Number.isFinite(base)||new Date(base).toISOString().slice(0,19)!==m[1])bad();
  return {text:v,micro:BigInt(base)*1000n+BigInt((m[2]??'').padEnd(6,'0'))};
}
const blob=text=>{if(typeof text!=='string'||!Buffer.from(text).equals(Buffer.from(text,'utf8'))||
  Buffer.from(text).toString('utf8')!==text)bad();const b=Buffer.from(text);return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');};
function sources(raw){
  const s=parse(raw);if(!exact(s,['script','workflow','reverify_workflow','policy'])||blob(s.script)!==SOURCE.script_blob||
    blob(s.workflow)!==SOURCE.workflow_blob||blob(s.reverify_workflow)!==SOURCE.reverify_workflow_blob||blob(s.policy)!==SOURCE.policy_blob)bad();
  return {policy:JSON.parse(s.policy),digest:createHash('sha256').update(s.policy).digest('hex'),...admissionDisplayNames(s)};
}
// Prefixes below are actual evaluate()/ownerReview()/workflowFindings outputs
// of the exact source above (lines 832, 889, 922-924, 1099-1112,1195-1223;
// workflow guards lines 415-575). Suffix paths/URLs/errors never leave here.
const REASONS=Object.freeze([
  ['claim_trailer_missing', 'CLAIM_TRAILER_MISSING'],
  ['changed_files_truncated:', 'CHANGED_FILES_TRUNCATED'],
  ['claim_base_unknown:', 'CLAIM_BASE_UNKNOWN'],
  ['workflow_gate:', 'WORKFLOW_GATE_REJECTED'],
  ['policy_file_removed:', 'POLICY_FILE_REMOVED'],
  ['policy_file_invalid:', 'POLICY_FILE_INVALID'],
  ['protected_change_not_up_to_date:', 'PROTECTED_HEAD_NOT_CURRENT'],
  ['owner_review_required (', 'OWNER_REVIEW_REQUIRED'],
  ['owner_review_unavailable:', 'OWNER_REVIEW_UNAVAILABLE'],
  ['workflow runs unavailable:', 'SUMMARY_WORKFLOW_READ_UNAVAILABLE'],
]);
function reasonCodes(rows){
  if(!Array.isArray(rows)||rows.length>1000||rows.some(r=>typeof r!=='string'||r.length>16384))bad();
  const codes=rows.map(r=>REASONS.find(([prefix])=>prefix==='claim_trailer_missing'?r===prefix:r.startsWith(prefix))?.[1]??'UNCLASSIFIED_REASON');
  return {codes:[...new Set(codes)].sort(),unmapped_count:codes.filter(c=>c==='UNCLASSIFIED_REASON').length};
}
function claimObservation(c,o,policy,state,layer,start,decision){
  if(!exact(c,['disposition','claim_id','verified_at','rpc_verdict','reasons','head_admitted_receipt_id'])||
    !['missing','valid','rejected','unverified','unknown','not_evaluated'].includes(c.disposition)||
    (c.claim_id!==null&&!uuid(c.claim_id))||c.claim_id!==o.claim_id||
    (c.head_admitted_receipt_id!==null&&!uuid(c.head_admitted_receipt_id)))bad();
  const reasons=reasonCodes(c.reasons),rpc=['valid','rejected'].includes(c.disposition);
  if(rpc){
    if(c.claim_id===null||c.rpc_verdict!==(c.disposition==='valid'?'ADMITTED':'REJECTED'))bad();
    const at=time(c.verified_at);if(at.micro<start.micro||at.micro>decision.micro)bad();
    if(c.disposition==='rejected'&&c.head_admitted_receipt_id!==null)bad();
  }else if(c.verified_at!==null||c.rpc_verdict!==null||c.head_admitted_receipt_id!==null||c.reasons.length)bad();
  if(c.disposition==='missing'&&c.claim_id!==null)bad();
  if(c.disposition==='not_evaluated'&&(c.claim_id!==null||!['PR_NOT_OPEN','ERROR'].includes(o.verdict)))bad();
  if(['valid','rejected','unverified'].includes(c.disposition)&&c.claim_id===null)bad();
  const advisory=state==='efficiency'&&['code','docs'].includes(layer)&&policy.rules[state][layer].work_claim==='advise';
  if(o.verdict==='ADMITTED'&&!['valid'].includes(c.disposition)&&!advisory)bad();
  return {disposition:c.disposition,claim_id:c.claim_id,verified_at:c.verified_at,rpc_verdict:c.rpc_verdict,
    rpc_head_admitted_receipt_id:c.head_admitted_receipt_id,...reasons,
    semantics:'claim RPC observation only; not the final admission decision'};
}
function appObservation(a,i,o,step,selection,expectedName){
  if(a===null)return {state:'not_observed'};
  const publication=a.publication_observation;
  const expectedExternal=`pr:${i.pr_number}:run:${id(i.run_id)}`+(publication?`:publication:${publication.publication_id}`:'');
  if(publication&&(!exact(publication,['publication_id','begin_receipt_id','begin_execution_epoch','finish_receipt_id','finish_execution_epoch','finish_status','must_revoke'])||
    !uuid(publication.publication_id)||!uuid(publication.begin_receipt_id)||!uuid(publication.finish_receipt_id)||
    !Number.isSafeInteger(publication.begin_execution_epoch)||publication.begin_execution_epoch<1||
    publication.finish_execution_epoch!==publication.begin_execution_epoch||publication.finish_status!=='committed'||publication.must_revoke!==false))bad();
  if(!exact(a,['id','app_id','name','head_sha','pr_number','run_id','run_attempt','external_id','status','conclusion',...(publication?['publication_observation']:[])])||
    a.app_id!==SOURCE.app_id||a.name!==expectedName||a.head_sha!==i.head_sha||
    a.pr_number!==i.pr_number||id(a.run_id)!==id(i.run_id)||a.run_attempt!==i.run_attempt||
    a.external_id!==expectedExternal||a.status!=='completed'||
    !['success','failure'].includes(a.conclusion)||o.verdict==='PR_NOT_OPEN')bad();
  let expected=null;
  if(i.entry==='required')expected=step===null?null:step==='success'?'success':'failure';
  else if(i.entry==='rejudge'){
    if(o.owner_review?.kind==='transient')bad();expected=o.admitted?'success':'failure';
  }else{
    // Scheduled reverify posts only a NEW failing admission check, and only
    // when its previous admission check was green. Still-green posts none.
    if(o.admitted||!selection.admission_green||o.owner_review?.kind==='transient')bad();expected='failure';
  }
  if(expected!==null&&a.conclusion!==expected)bad();
  return {state:'supplied_app_observation',check_run_id:id(a.id),app_id:a.app_id,conclusion:a.conclusion,
    linkage:expected===null?'unknown_admit_step_outcome':'supplied_entry_semantics',
    expected_conclusion:expected,admit_step_outcome:step,
    attempt_binding_authenticated:false};
}

function buildAdmissionMeasurementEnvelopeCandidate(packetRaw,sourcesRaw){
  try{
    return buildParsed(parse(packetRaw),sources(sourcesRaw));
  }catch{return {status:'NOT_QUALIFIED',reason_code:'INVALID_INPUT',...flags()};}
}
function buildParsed(p,supplied){
    if(p.schema!==MERGE_ADMISSION_FOUR_SOURCE_PROTOCOL.admission_packet_schema||!exact(p,['schema','identity','timing','final_decision_observed','outcome','claim_observation','admit_step_outcome','selection_observation','app_observation']))bad();
    const i=p.identity;
    if(!exact(i,['repository','pr_number','head_sha','run_id','run_attempt','job_id','entry','dispatch_reason','source_checkout_sha','native_pr','native_run','native_job'])||
      i.repository!==SOURCE.repository||!sha(i.head_sha)||i.source_checkout_sha!==SOURCE.source_checkout_sha||!['required','reverify','rejudge'].includes(i.entry))bad();
    integer(i.pr_number);integer(i.run_attempt);id(i.run_id);
    // A no-execution/no-final observation may have no Native job at all.
    // FINAL observations still require the actual job and execution start.
    const noJob=i.job_id===null&&i.native_job===null&&p.final_decision_observed===false;
    if(!noJob)id(i.job_id);
    const pr=i.native_pr,r=i.native_run,j=i.native_job;
    if(!exact(pr,['number','head_sha','base_repository','base_ref','default_branch','state','draft'])||
      pr.number!==i.pr_number||pr.head_sha!==i.head_sha||pr.base_repository!==i.repository||
      pr.base_ref!==SOURCE.default_branch||pr.default_branch!==SOURCE.default_branch||!['open','closed'].includes(pr.state)||typeof pr.draft!=='boolean')bad();
    // pull_request_target's native run head is the base, NOT the PR's head.
    if(!exact(r,['id','run_attempt','event','path','head_sha','head_branch','pull_requests','status','conclusion','run_started_at'])||
      id(r.id)!==id(i.run_id)||r.run_attempt!==i.run_attempt||!sha(r.head_sha)||typeof r.head_branch!=='string'||
      !r.head_branch.length||r.head_branch.length>200||/[\x00-\x20\x7f]/.test(r.head_branch)||
      !Array.isArray(r.pull_requests)||r.pull_requests.length>100||r.pull_requests.some(n=>!Number.isSafeInteger(n)||n<1)||
      new Set(r.pull_requests).size!==r.pull_requests.length||!['in_progress','completed'].includes(r.status)||
      (r.status==='completed'?!['success','failure','cancelled','timed_out','skipped','neutral','action_required','startup_failure'].includes(r.conclusion):r.conclusion!==null))bad();
    if(i.entry==='required'){
      if(r.event!=='pull_request_target'||r.path!==SOURCE.workflow_path||i.dispatch_reason!==null||
        (r.pull_requests.length&&(r.pull_requests.length!==1||r.pull_requests[0]!==i.pr_number)))bad();
    }else{
      if(pr.draft||r.head_branch!==SOURCE.default_branch||r.path!==SOURCE.reverify_workflow_path||!['schedule','push','workflow_dispatch'].includes(r.event)||
        (i.entry==='rejudge'?(r.event!=='workflow_dispatch'||i.dispatch_reason!=='state_change'):
          i.dispatch_reason!=='scheduled'))bad();
    }
    if(!noJob&&(!exact(j,['id','run_id','run_attempt','name','status','conclusion'])||id(j.id)!==id(i.job_id)||
      id(j.run_id)!==id(i.run_id)||j.run_attempt!==i.run_attempt||
      j.name!==(i.entry==='required'?supplied.job_name:'clued-work-admission-reverify')||
      !['in_progress','completed'].includes(j.status)||
      (j.status==='completed'?!['success','failure','cancelled','timed_out','skipped','neutral','action_required','startup_failure'].includes(j.conclusion):j.conclusion!==null)))bad();
    if(!exact(p.timing,['decision_at','observed_at'])||typeof p.final_decision_observed!=='boolean')bad();
    const start=r.run_started_at===null?null:time(r.run_started_at),observed=time(p.timing.observed_at);
    if(start!==null&&observed.micro<start.micro||noJob&&p.admit_step_outcome!==null)bad();
    const identity={repository:i.repository,pr_number:i.pr_number,head_sha:i.head_sha,run_id:id(i.run_id),
      run_attempt:i.run_attempt,job_id:noJob?null:id(i.job_id),entry:i.entry,dispatch_reason:i.dispatch_reason,native_event:r.event,
      native_run_head_sha:r.head_sha,source_checkout_sha:i.source_checkout_sha};
    const native={run_status:r.status,run_conclusion:r.conclusion,run_started_at:start?.text??null,
      job_status:noJob?null:j.status,job_conclusion:noJob?null:j.conclusion,
      terminal_gap:r.conclusion==='cancelled'||j?.conclusion==='cancelled'};
    const source={...SOURCE,expected_selection_only:true,executed_workflow_path:r.path,bytes_match_reviewed_selection:true,policy_digest:supplied.digest};
    if(p.admit_step_outcome!==null&&(!['success','failure','skipped','cancelled'].includes(p.admit_step_outcome)||i.entry!=='required'))bad();
    // The pinned workflow's !cancelled() App step cannot post a new check
    // when the admit step itself was cancelled. Keep any earlier decision,
    // but do not attach a manufactured App result to that cancelled step.
    if(i.entry==='required'&&p.admit_step_outcome==='cancelled'&&p.app_observation!==null)bad();
    if(i.entry==='reverify'&&!(p.final_decision_observed===false&&p.selection_observation===null)){
      if(!exact(p.selection_observation,['admission_green','slot_green'])||
        typeof p.selection_observation.admission_green!=='boolean'||typeof p.selection_observation.slot_green!=='boolean'||
        (!p.selection_observation.admission_green&&!p.selection_observation.slot_green))bad();
    }else if(p.selection_observation!==null)bad();
    if(!p.final_decision_observed){
      if(p.timing.decision_at!==null||p.outcome!==null||p.claim_observation!==null||p.app_observation!==null)bad();
      return {status:'GAP',reason_code:'NO_FINAL_DECISION',identity,source,native,observed_at:observed.text,...flags()};
    }
    if(start===null||noJob)bad();
    const decision=time(p.timing.decision_at);if(decision.micro<start.micro||decision.micro>observed.micro)bad();
    const o=p.outcome;
    if(!obj(o)||typeof o.admitted!=='boolean'||o.enforced!==true||o.event!=='pull_request_target'||
      !['ADMITTED','REJECTED','ERROR','PR_NOT_OPEN'].includes(o.verdict)||
      o.admitted!==(o.verdict==='ADMITTED')||(o.mode!==undefined&&o.mode!==null&&o.mode!=='required'))bad();
    // CLI main returns 1 for REJECTED / PR_NOT_OPEN / ERROR. A successful
    // required step cannot contain those outcomes. The reverse is possible:
    // an observed ADMITTED decision can precede a later step failure.
    if(i.entry==='required'&&(p.admit_step_outcome==='skipped'||
      (p.admit_step_outcome==='success'&&o.verdict!=='ADMITTED')))bad();
    if(o.head_sha===null&&o.verdict==='ERROR')return {status:'GAP',reason_code:'FINAL_IDENTITY_UNAVAILABLE',identity,source,native,observed_at:observed.text,...flags()};
    if(o.head_sha!==i.head_sha||o.pr_ref!==`${i.repository}#${i.pr_number}`||
      (o.claim_id!==null&&!uuid(o.claim_id)))bad();
    if(o.verdict==='PR_NOT_OPEN'&&(pr.state!=='closed'||o.claim_id!==null||o.claim!==undefined||
      (o.scope!==undefined&&o.scope!==null)||o.owner_review!==undefined||o.claim_verdict!==undefined||o.merge_slot!==undefined||
      p.claim_observation?.disposition!=='not_evaluated'||p.app_observation!==null))bad();
    if(o.verdict!=='PR_NOT_OPEN'&&pr.state!=='open')bad();
    const m=o.admission_mode;
    if(!obj(m)||!['normal','efficiency','frozen'].includes(m.state)||
      (m.layer!==null&&!['protected','code','docs'].includes(m.layer))||
      (o.verdict==='PR_NOT_OPEN'&&m.layer!==null)||
      (['ADMITTED','REJECTED'].includes(o.verdict)&&m.layer===null))bad();
    const claim=claimObservation(p.claim_observation,o,supplied.policy,m.state,m.layer,start,decision);
    const reasons=reasonCodes(o.reasons),app=appObservation(p.app_observation,i,o,p.admit_step_outcome,p.selection_observation,supplied.app_check_name);
    if(o.admitted&&reasons.codes.some(c=>c!=='UNCLASSIFIED_REASON'&&c!=='SUMMARY_WORKFLOW_READ_UNAVAILABLE'))bad();
    return {schema:'clued.final-admission-measurement-candidate/1',status:'FINAL_OUTCOME_CANDIDATE',
      identity,source,native,decision_at:decision.text,observed_at:observed.text,
      admit_step_outcome:p.admit_step_outcome,selection_observation:p.selection_observation,
      policy:{state:m.state,layer:m.layer,digest:supplied.digest,version:supplied.policy.version},
      final_verdict:o.verdict,final_admitted:o.admitted,claim_observation:claim,app_observation:app,
      observed_reason_codes:reasons.codes,unmapped_reason_count:reasons.unmapped_count,
      failure_reason_codes:o.verdict==='REJECTED'?reasons.codes.filter(c=>c!=='SUMMARY_WORKFLOW_READ_UNAVAILABLE'):[],
      reason_semantics:'reported final reason classes only; diagnostic reads do not establish rejection or causality',
      final_not_equivalent_to_head_admitted:true,...flags()};
}


return buildAdmissionMeasurementEnvelopeCandidate;
}
function readerFor(expectations){
const SOURCE={repository:expectations.repository};
const PROFILE_SOURCE_SHA256=expectations.execution_source.profiles_sha256;
const ROLE_SOURCE_SHA256=expectations.execution_source.role_specs_sha256;
const EXECUTION_SOURCE_COMMIT=expectations.execution_source.source_checkout_sha;
const isV2=expectations.schema===MERGE_ADMISSION_FOUR_SOURCE_PROTOCOL_V2.expectations_schema;
const FOUR_SOURCE_CONTRACT={...(isV2?MERGE_ADMISSION_FOUR_SOURCE_PROTOCOL_V2:MERGE_ADMISSION_FOUR_SOURCE_PROTOCOL),repository:expectations.repository,...expectations.scope};
const names=['attempts','targets','admission_batches','admissions','operations','head_moves','rounds','cancellations'];
const sourceIds=Object.freeze({attempts:'native_attempts',targets:'admission_targets',admission_batches:'admission_selection_journal',
  admissions:'final_admission_journal',operations:'operation_journal_all_origins',head_moves:'native_head_move_journal',
  rounds:'final_round_journal',cancellations:'native_cancel_evidence'});
const flags={source_authenticated:false,official_metric:false,execution_permission:false,t0:null};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).sort().join(',')===[...keys].sort().join(',');
const bad=()=>{throw new Error('invalid supplied structure');};
const sha=x=>typeof x==='string'&&/^[0-9a-f]{40}$/.test(x),digest=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(x);
const id=x=>typeof x==='string'&&/^[1-9][0-9]{0,19}$/.test(x)?x:bad();
const integer=x=>Number.isSafeInteger(x)&&x>0?x:bad(),count=x=>Number.isSafeInteger(x)&&x>=0&&x<=100000?x:bad();
const opaque=x=>typeof x==='string'&&/^[a-zA-Z0-9_.:-]{1,128}$/.test(x);
const code=x=>typeof x==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(x)?x:bad();
const key=x=>id(x.run_id)+':'+integer(x.attempt);
const targetKey=x=>key(x)+':'+integer(x.pr_number)+':'+(sha(x.head_sha)?x.head_sha:bad());
const hash=x=>createHash('sha256').update(x).digest('hex');
const gitBlob=x=>{if(typeof x!=='string'||Buffer.from(x).toString('utf8')!==x)bad();const b=Buffer.from(x);return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const scope=x=>exact(x,['project_id','queue_ref'])&&x.project_id===FOUR_SOURCE_CONTRACT.project_id&&x.queue_ref===FOUR_SOURCE_CONTRACT.queue_ref;
const sortedUnique=x=>{if(!Array.isArray(x)||x.length>100000||x.some(v=>typeof v!=='string'||v.length>200)||new Set(x).size!==x.length)bad();return [...x].sort();};

function parseRawFourSourceDataCandidate(raw){
  if(typeof raw!=='string'||Buffer.byteLength(raw)>32*1024*1024)bad();let at=0;
  const ws=()=>{while(/[ \r\n\t]/.test(raw[at]??'!'))at++;};
  const string=()=>{const start=at;if(raw[at++]!=='"')bad();while(at<raw.length){const c=raw[at++];if(c==='"')return JSON.parse(raw.slice(start,at));if(c==='\\')at++;}bad();};
  const value=depth=>{if(depth>40)bad();ws();const c=raw[at];
    if(c==='{'){at++;ws();const seen=new Set();if(raw[at]==='}'){at++;return;}
      while(true){ws();const k=string();if(seen.has(k))bad();seen.add(k);ws();if(raw[at++]!==':')bad();value(depth+1);ws();const d=raw[at++];if(d==='}')return;if(d!==',')bad();}}
    if(c==='['){at++;ws();if(raw[at]===']'){at++;return;}while(true){value(depth+1);ws();const d=raw[at++];if(d===']')return;if(d!==',')bad();}}
    if(c==='"'){string();return;}const start=at;while(at<raw.length&&!/[\s,}\]]/.test(raw[at]))at++;if(at===start)bad();JSON.parse(raw.slice(start,at));};
  value(0);ws();if(at!==raw.length)bad();return JSON.parse(raw);
}
const array=x=>{if(!Array.isArray(x)||x.length>100000)bad();return x;};
const rowKeys=(name,rows)=>rows.map(x=>name==='attempts'||name==='admission_batches'||name==='cancellations'?key(x):name==='targets'?targetKey(x):
  name==='admissions'?x.target_key:name==='operations'?x.operation_id:name==='head_moves'?x.move_id:x.round_id);
const metric=(value,known,unknown,denominator,detail={})=>({status:unknown===0?'CALCULATION_CANDIDATE':'PARTIAL_KNOWLEDGE',
  value:unknown===0?value:null,known,unknown,denominator,...detail,...flags});

// This checks the supplied transcript, never a caller authority boolean.
function pagesConsistent(m,members,c,sourceId){
  if(!exact(m,['reader_source','source_id','scope','cohort','window','retention_start','watermark','collected_at','before','after','pages'])||
    m.reader_source!==FOUR_SOURCE_CONTRACT.reader_source||m.source_id!==sourceId||!scope(m.scope)||m.cohort!==FOUR_SOURCE_CONTRACT.population_cohort||
    !same(m.window,c.window)||timestampMicros(m.retention_start)>c.from||m.watermark!==c.collection.watermark||
    timestampMicros(m.collected_at)>c.closed||!Array.isArray(m.pages)||!m.pages.length||m.pages.length>1000)bad();
  const fields=['read_id','snapshot_id','total','member_digest','first_member','last_member'];
  if(!exact(m.before,fields)||!exact(m.after,fields)||!opaque(m.before.read_id)||!opaque(m.after.read_id)||m.before.read_id===m.after.read_id||
    !opaque(m.before.snapshot_id)||m.before.snapshot_id!==m.after.snapshot_id||!digest(m.before.member_digest)||
    m.before.member_digest!==m.after.member_digest||count(m.before.total)!==count(m.after.total))bad();
  const listed=[];let cursor=null;
  for(let i=0;i<m.pages.length;i++){
    const page=m.pages[i];if(!exact(page,['page','cursor','next_cursor','members'])||page.page!==i+1||page.cursor!==cursor||
      (page.next_cursor!==null&&!opaque(page.next_cursor))||!Array.isArray(page.members)||page.members.length>1000)bad();
    if(!page.members.length&&(m.pages.length!==1||m.before.total!==0))bad();
    listed.push(...page.members);cursor=page.next_cursor;if(i<m.pages.length-1&&cursor===null)bad();
  }
  const sorted=sortedUnique(listed);sortedUnique(members);
  if(m.before.first_member!==m.after.first_member||m.before.last_member!==m.after.last_member)bad();
  return cursor===null&&listed.length===m.before.total&&same(sorted,[...members].sort())&&hash(JSON.stringify(listed))===m.before.member_digest&&
    m.before.first_member===(listed[0]??null)&&m.before.last_member===(listed.at(-1)??null);
}
function applicability(profiles,changedFiles){
  if(!Array.isArray(changedFiles)||changedFiles.length>300||changedFiles.some(x=>typeof x!=='string'||!x.length||x.startsWith('/')||
    /[\x00-\x20\x7f]/.test(x)||x.split('/').some(part=>!part||part==='.'||part==='..')))bad();
  const applicable=[];
  for(const [file,p]of Object.entries(profiles.workflows)){
    if(!sha(p.workflow_blob)||typeof p.source_yaml!=='string'||gitBlob(p.source_yaml)!==p.workflow_blob)bad();
    if(p.pull_request===null){applicable.push(file);continue;}
    if(!exact(p.pull_request,['paths'])||!Array.isArray(p.pull_request.paths)||!p.pull_request.paths.length)bad();
    const expressions=p.pull_request.paths.map(pattern=>{
      if(typeof pattern!=='string'||!/^[A-Za-z0-9._/*-]+$/.test(pattern)||pattern.includes('***')||
        pattern.replace(/\/\*\*$/,'').includes('**')||pattern.split('/').some(x=>!x||x==='.'||x==='..'))bad();
      const deep=pattern.endsWith('/**'),prefix=deep?pattern.slice(0,-3):pattern;
      const exp=prefix.split('*').map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[^/]*');
      return new RegExp(`^${exp}${deep?'/(?:.*)':''}$`);
    });
    if(changedFiles.some(x=>expressions.some(r=>r.test(x))))applicable.push(file);
  }
  return applicable.sort();
}
function executionSourceSelection(s,profiles,roles,c,descriptor=expectations.execution_source){
  if(!exact(s,['source_checkout_sha','entries','manifest'])||s.source_checkout_sha!==descriptor.source_checkout_sha)bad();
  const sources=new Map(),members=[],identified=new Map(),
    readCatalogueSource=createCatalogueSourceReader({registry:profiles,roleSpecs:roles});
  for(const x of array(s.entries)){
    if(!exact(x,['workflow_file','workflow_blob'])||!Object.hasOwn(profiles.workflows,x.workflow_file)||!sha(x.workflow_blob)||sources.has(x.workflow_file))bad();
    const source=readCatalogueSource({file:x.workflow_file,blob:x.workflow_blob}),accepted=source.roles;
    if(!source.source_identified||!accepted||!same(accepted.map(x=>x.job_id).sort(),[...source.profile.primary_ids].sort()))bad();
    sources.set(x.workflow_file,x.workflow_blob);identified.set(x.workflow_file,source);members.push(x.workflow_file+':'+x.workflow_blob);
  }
  // This fixed private corpus checks every known reviewed workflow path and
  // an independently supplied source-directory transcript. These internal
  // selection booleans mean byte/transcript consistency, never authorization.
  if(!same([...sources.keys()].sort(),Object.keys(profiles.workflows).sort())||
    !pagesConsistent(s.manifest,members,c,'native_execution_workflow_sources:'+s.source_checkout_sha))bad();
  // Metadata identity closes the directory transcript; it never proves execution.
  // Source-only projections carry execution_eligible:false and every actual
  // workflow-source execution read continues through registeredWorkflowSource.
  if([...identified.values()].some(source=>source.kind==='SOURCE_METADATA_ONLY_DISABLED'))
    return {schema:profiles.schema,workflows:Object.fromEntries([...identified].map(([file,source])=>[file,source.profile]))};
  const selected=selectRegisteredProfiles(profiles,sources,{sourceApproved:true,directoryComplete:true});
  if(!selected.passed)bad();return selected.profiles;
}
function timing(event,collected,c){const e=timestampMicros(event),at=timestampMicros(collected);if(at<e||at>c.closed)bad();return e;}
const cancelCodes=new Set(['PLATFORM_CANCEL_OPERATION','PLATFORM_CONCURRENCY_CANCELLATION','PLATFORM_POLICY_CANCELLATION',
  'MANUAL_CANCELLATION_REQUEST','EXPLICIT_SUPERSESSION_REQUEST','EXPLICIT_FAILURE_RECOVERY_REQUEST','OWNER_STOP_REQUEST']);

function readFourSourcesCandidate(packetRaw){
  try{return parsed(parseRawFourSourceDataCandidate(packetRaw));}
  catch{return {status:'NOT_QUALIFIED',reason_code:'INVALID_OR_CONTRADICTORY_INPUT',candidate_ready:false,
    supplied_data_consistency:false,source_permission_qualification:'NOT_ESTABLISHED',...flags};}
}
function parsed(p){
  const compact=isV2&&Object.hasOwn(p,'execution_configurations');
  if(!exact(p,['schema','repository','scope','window','collection','populations','sources_raw','proof_profiles_raw','role_specs_raw','execution_sources',...(isV2?['previous_execution_snapshots']:[]),...(compact?['execution_configurations']:[]),...names])||
    p.schema!==FOUR_SOURCE_CONTRACT.schema||p.repository!==FOUR_SOURCE_CONTRACT.repository||!scope(p.scope)||
    !exact(p.window,['start','end'])||!exact(p.collection,['watermark','closed_at','window_status','retention_start'])||
    !opaque(p.collection.watermark)||!['open','closed'].includes(p.collection.window_status)||typeof p.sources_raw!=='string'||
    Buffer.byteLength(p.sources_raw)>8*1024*1024||typeof p.proof_profiles_raw!=='string'||hash(p.proof_profiles_raw)!==PROFILE_SOURCE_SHA256||
    typeof p.role_specs_raw!=='string'||hash(p.role_specs_raw)!==ROLE_SOURCE_SHA256)bad();
  const admissionSources=validatedAdmissionSources(p.sources_raw,expectations);
  const roles=parseRawFourSourceDataCandidate(p.role_specs_raw);
  const from=timestampMicros(p.window.start),to=timestampMicros(p.window.end),closed=timestampMicros(p.collection.closed_at);
  if(from>=to||closed<from||to-from>31n*86400000000n||timestampMicros(p.collection.retention_start)>from||
    (p.collection.window_status==='closed'&&closed<to))bad();
  const c={from,to,closed,window:p.window,collection:p.collection},registry=parseProfileCatalogue(p.proof_profiles_raw);
  if(!object(registry.workflows)||!object(p.populations)||Object.keys(p.populations).some(x=>!names.includes(x)))bad();
  const profiles=executionSourceSelection(p.execution_sources,registry,roles,c);
  const executionVersions=new Map([[EXECUTION_SOURCE_COMMIT,{descriptor:expectations.execution_source,profiles}]]);
  if(isV2){
    const configurations=new Map([[PROFILE_SOURCE_SHA256+':'+ROLE_SOURCE_SHA256,{proof_profiles_raw:p.proof_profiles_raw,role_specs_raw:p.role_specs_raw}]]);
    if(compact){
      if(!object(p.execution_configurations)||Object.keys(p.execution_configurations).length>4)bad();
      for(const [key,cfg]of Object.entries(p.execution_configurations)){
        if(!exact(cfg,['proof_profiles_raw','role_specs_raw'])||typeof cfg.proof_profiles_raw!=='string'||typeof cfg.role_specs_raw!=='string'||
          key!==hash(cfg.proof_profiles_raw)+':'+hash(cfg.role_specs_raw)||configurations.has(key)||
          !expectations.previous_execution_sources.some(s=>key===s.profiles_sha256+':'+s.role_specs_sha256))bad();
        configurations.set(key,cfg);
      }
    }
    if(!Array.isArray(p.previous_execution_snapshots)||p.previous_execution_snapshots.length>1000)bad();
    for(const snapshot of p.previous_execution_snapshots){
      if(!exact(snapshot,['source_checkout_sha',...(compact?['configuration_key']:['proof_profiles_raw','role_specs_raw']),'execution_sources','main_history'])||!sha(snapshot.source_checkout_sha)||executionVersions.has(snapshot.source_checkout_sha))bad();
      const cfg=compact?configurations.get(snapshot.configuration_key):snapshot;
      if(!cfg||typeof cfg.proof_profiles_raw!=='string'||typeof cfg.role_specs_raw!=='string')bad();
      const template=[expectations.execution_source,...expectations.previous_execution_sources].find(s=>s.profiles_sha256===hash(cfg.proof_profiles_raw)&&s.role_specs_sha256===hash(cfg.role_specs_raw)),history=snapshot.main_history;
      const anchored=[expectations.execution_source,...expectations.previous_execution_sources].find(s=>s.source_checkout_sha===snapshot.source_checkout_sha);
      if(!template||!exact(history,['base_commit','head_commit','merge_base_commit','status'])||history.base_commit!==snapshot.source_checkout_sha||
        history.merge_base_commit!==snapshot.source_checkout_sha||history.head_commit!==EXECUTION_SOURCE_COMMIT||
        history.status!==(snapshot.source_checkout_sha===EXECUTION_SOURCE_COMMIT?'identical':'ahead')||anchored&&
        (anchored.profiles_sha256!==template.profiles_sha256||anchored.role_specs_sha256!==template.role_specs_sha256))bad();
      // A reviewed configuration may appear at many immutable main tips. The
      // actual tip, full directory and ancestry bind each round; only exact
      // complete raw hash pairs select a reviewed version.
      const descriptor={...template,source_checkout_sha:snapshot.source_checkout_sha};
      const historicalRegistry=parseProfileCatalogue(cfg.proof_profiles_raw),historicalRoles=parseRawFourSourceDataCandidate(cfg.role_specs_raw);
      const selected=executionSourceSelection(snapshot.execution_sources,historicalRegistry,historicalRoles,c,descriptor);
      executionVersions.set(snapshot.source_checkout_sha,{descriptor,profiles:selected});
    }
  }
  const inWindow=at=>at>=from&&at<to;
  const populationGaps=[];
  if(admissionSources.size===0)populationGaps.push('missing_admission_source_packets');
  for(const name of names){array(p[name]);if(!p.populations[name]||!pagesConsistent(p.populations[name],rowKeys(name,p[name]),c,sourceIds[name]))populationGaps.push(name);}
  const attempts=new Map(),terminals=new Map();
  const terminalInterval=r=>{
    if(r.completed_at!==null){if(r.terminal_interval!==undefined&&r.terminal_interval!==null)bad();const at=timestampMicros(r.completed_at);return {lower:at,upper:at};}
    if(r.terminal_interval===undefined||r.terminal_interval===null)return null;
    const b=r.terminal_interval;
    if(!exact(b,['lower_at','upper_at','basis'])||b.basis!=='native_job_completion_lower_and_terminal_update_upper_bounds')bad();
    const lower=timestampMicros(b.lower_at),upper=timestampMicros(b.upper_at);if(lower>upper)bad();return {lower,upper};
  };
  const insideTerminal=b=>b&&b.lower>=from&&b.upper<to;
  const outsideTerminal=b=>b&&(b.upper<from||b.lower>=to);

  for(const r of p.attempts){
    if(![ ['run_id','attempt','pr_number','head_sha','kind','status','conclusion','started_at','completed_at'],['run_id','attempt','pr_number','head_sha','kind','status','conclusion','started_at','completed_at','terminal_interval'] ].some(fields=>exact(r,fields))||!sha(r.head_sha)||
      !['admission','ci','other'].includes(r.kind)||!['queued','in_progress','completed'].includes(r.status)||attempts.has(key(r)))bad();
    if(r.pr_number!==null)integer(r.pr_number);const start=r.started_at===null?null:timestampMicros(r.started_at);
    const retained=timestampMicros(p.collection.retention_start);
    if(start!==null&&(start>closed||start<retained))bad();
    if(r.status==='completed'){
      if(!['success','failure','cancelled','timed_out','skipped','neutral','action_required','startup_failure'].includes(r.conclusion))bad();
      const bound=terminalInterval(r);terminals.set(key(r),bound);
      if(!bound)populationGaps.push(`native_terminal_membership_unknown:${key(r)}`);
      else if(bound.upper<retained||bound.upper>closed||start!==null&&bound.upper<start)bad();
    }else if(r.conclusion!==null||r.completed_at!==null||r.terminal_interval!==undefined&&r.terminal_interval!==null)bad();attempts.set(key(r),r);
  }
  const targets=new Map(),batches=new Map(),finals=new Map();
  for(const t of p.targets){
    if(!exact(t,['run_id','attempt','pr_number','head_sha','entry','scope','selected_at'])||!scope(t.scope)||targets.has(targetKey(t))||
      !['required','reverify','rejudge'].includes(t.entry)||attempts.get(key(t))?.kind!=='admission')bad();
    const at=timestampMicros(t.selected_at),start=attempts.get(key(t)).started_at;
    if(at<timestampMicros(p.collection.retention_start)||start!==null&&at<timestampMicros(start)||at>closed)bad();targets.set(targetKey(t),t);
  }
  for(const b of p.admission_batches){
    const a=attempts.get(key(b));
    if(!exact(b,['run_id','attempt','entry','scope','initial','selection_events','closing','ever_target_keys'])||!scope(b.scope)||
      !a||a.kind!=='admission'||batches.has(key(b))||!['required','reverify','rejudge'].includes(b.entry)||
      !exact(b.initial,['receipt_id','event_at','collected_at','target_keys'])||!opaque(b.initial.receipt_id)||
      !exact(b.closing,['receipt_id','event_at','collected_at','status','target_keys'])||!opaque(b.closing.receipt_id)||
      !['running','completed','cancelled','failed'].includes(b.closing.status))bad();
    const begin=timing(b.initial.event_at,b.initial.collected_at,c),end=timing(b.closing.event_at,b.closing.collected_at,c);
    if(begin<timestampMicros(p.collection.retention_start)||a.started_at!==null&&begin<timestampMicros(a.started_at)||end<begin)bad();
    const status=a.status!=='completed'?'running':a.conclusion==='cancelled'?'cancelled':a.conclusion==='success'?'completed':'failed';
    if(b.closing.status!==status||(terminals.get(key(a))!==undefined&&terminals.get(key(a))!==null&&end<terminals.get(key(a)).upper))bad();
    const active=new Set(sortedUnique(b.initial.target_keys)),ever=new Set(active),firstSelected=new Map([...active].map(x=>[x,begin]));
    let previous=begin;const receipts=new Set([b.initial.receipt_id,b.closing.receipt_id]);if(receipts.size!==2)bad();
    for(const [i,e]of array(b.selection_events).entries()){
      if(!exact(e,['seq','receipt_id','event_at','collected_at','kind','target_key'])||e.seq!==i+1||!opaque(e.receipt_id)||receipts.has(e.receipt_id)||
        !['selected','unselected'].includes(e.kind)||typeof e.target_key!=='string')bad();
      const at=timing(e.event_at,e.collected_at,c);if(at<previous||at>end)bad();previous=at;receipts.add(e.receipt_id);
      if(e.kind==='selected'){if(active.has(e.target_key))bad();active.add(e.target_key);ever.add(e.target_key);if(!firstSelected.has(e.target_key))firstSelected.set(e.target_key,at);}
      else if(!active.delete(e.target_key))bad();
    }
    if(!same([...active].sort(),sortedUnique(b.closing.target_keys))||!same([...ever].sort(),sortedUnique(b.ever_target_keys)))bad();
    if(b.entry==='required'&&ever.size!==1)populationGaps.push(`required_batch:${key(b)}`);
    for(const k of ever){const t=targets.get(k);if(!t){populationGaps.push(`missing_target:${key(b)}`);continue;}
      if(key(t)!==key(b)||t.entry!==b.entry||timestampMicros(t.selected_at)!==firstSelected.get(k))bad();}
    const supplied=[...targets].filter(([,t])=>key(t)===key(b)).map(([k])=>k).sort();
    if(!same(supplied,[...ever].sort()))populationGaps.push(`ever_target_population:${key(b)}`);batches.set(key(b),b);
  }
  for(const [k,a]of attempts)if(a.kind==='admission'&&!batches.has(k))populationGaps.push(`missing_admission_batch:${k}`);
  const appOwners=new Map();
  for(const a of p.admissions){
    if(!exact(a,['target_key','packet_raw','collected_at'])||typeof a.target_key!=='string'||finals.has(a.target_key)||!targets.has(a.target_key))bad();
    const e=projectAdmissionPacket(a.packet_raw,admissionSources,expectations),t=targets.get(a.target_key),native=attempts.get(key(t));
    if(e.status==='SOURCE_PACKET_MISSING'){populationGaps.push('missing_admission_source_packet:'+e.source_checkout_sha);continue;}
    if(!['FINAL_OUTCOME_CANDIDATE','GAP'].includes(e.status)||!e.identity||e.identity.repository!==p.repository||e.identity.run_id!==t.run_id||
      e.identity.run_attempt!==t.attempt||e.identity.pr_number!==t.pr_number||e.identity.head_sha!==t.head_sha||e.identity.entry!==t.entry)bad();
    if(e.status!=='GAP'&&(native.started_at===null||native.status==='completed'&&!terminals.get(key(native))))bad();
    // Known starts describe the same immutable run/attempt. An earlier unknown
    // GAP can progress to known; two known observations must be time-equivalent.
    if(e.native.run_started_at!==null&&native.started_at!==null&&
      timestampMicros(e.native.run_started_at)!==timestampMicros(native.started_at))bad();
    // The producer's final observation can precede the run's terminal state.
    // In-progress -> completed is monotonic; a completed contradictory result
    // or an event after immutable Native completion is not.
    if(e.native.run_status==='completed'&&(native.status!=='completed'||e.native.run_conclusion!==native.conclusion)||
      e.native.run_status==='in_progress'&&native.status==='queued')bad();
    const at=timing(e.status==='GAP'?e.observed_at:e.decision_at,a.collected_at,c);if(at<timestampMicros(t.selected_at))bad();
    if(e.status!=='GAP'&&timing(e.observed_at,a.collected_at,c)<at)bad();
    if(e.status!=='GAP'&&terminals.get(key(native))&&at>terminals.get(key(native)).upper)bad();
    if(e.claim_observation?.verified_at!==null&&e.claim_observation?.verified_at!==undefined&&timestampMicros(e.claim_observation.verified_at)<timestampMicros(t.selected_at))bad();
    if(e.app_observation?.check_run_id){const previous=appOwners.get(e.app_observation.check_run_id);
      if(previous&&previous!==a.target_key)bad();appOwners.set(e.app_observation.check_run_id,a.target_key);}
    finals.set(a.target_key,e);
  }
  // All ever-target packets belong to closure, including post-end selections.
  // Only the first-selection event in this fixed window enters the denominator.
  if([...targets.keys()].some(k=>!finals.has(k)))populationGaps.push('missing_final_admission_packets');
  const cohortTargets=[...targets].filter(([,t])=>inWindow(timestampMicros(t.selected_at)));
  const failures={},admitted={valid:0,efficiency_no_valid_claim:0,unknown_claim:0,invalid_mandatory_claim:0};
  let missingFinal=0,explicitNoDecision=0,rejected=0,unknownFailureReason=0,admissionErrors=0,lateAdmissions=0;
  for(const [k,t]of cohortTargets){
    const e=finals.get(k);if(!e){missingFinal++;continue;}if(e.status==='GAP'){explicitNoDecision++;continue;}
    if(timestampMicros(e.decision_at)>=to)lateAdmissions++;
    if(e.final_verdict==='ERROR'){admissionErrors++;failures.EVALUATION_ERROR=(failures.EVALUATION_ERROR??0)+1;continue;}
    if(e.final_verdict==='REJECTED'){
      rejected++;const codes=e.failure_reason_codes.length?e.failure_reason_codes:['UNKNOWN_REASON'];
      if(codes.some(x=>['UNCLASSIFIED_REASON','UNKNOWN_REASON'].includes(x)))unknownFailureReason++;
      for(const reason of new Set(codes)){code(reason);failures[reason]=(failures[reason]??0)+1;}continue;
    }
    if(!e.final_admitted)continue;
    // A final ADMITTED evaluator result followed by a failed/cancelled admit
    // step is not a successful App admission. Keep the unknown explicitly.
    if(t.entry==='required'&&(e.app_observation.state!=='supplied_app_observation'||e.app_observation.conclusion!=='success')){explicitNoDecision++;continue;}
    const d=e.claim_observation.disposition;
    if(d==='valid')admitted.valid++;
    else if(['missing','rejected'].includes(d)&&e.policy.state==='efficiency'&&['code','docs'].includes(e.policy.layer))admitted.efficiency_no_valid_claim++;
    else if(['unknown','unverified'].includes(d))admitted.unknown_claim++;
    else admitted.invalid_mandatory_claim++;
  }
  if(missingFinal)populationGaps.push('missing_final_admission_packets');

  const moves=new Map(),ops=new Map();
  for(const m of p.head_moves){
    if(!exact(m,['move_id','pr_number','old_head_sha','new_head_sha','event_at','collected_at','operation_id','observation_id'])||
      !uuid(m.move_id)||!opaque(m.observation_id)||!sha(m.old_head_sha)||!sha(m.new_head_sha)||m.old_head_sha===m.new_head_sha||moves.has(m.move_id)||
      (m.operation_id!==null&&!uuid(m.operation_id)))bad();integer(m.pr_number);const at=timing(m.event_at,m.collected_at,c);
    if(at<timestampMicros(p.collection.retention_start))bad();moves.set(m.move_id,m);
  }
  let acceptedPending=0,requestFailed=0,responseUnknown=0,lateUpdates=0;
  for(const o of p.operations){
    if(!exact(o,['operation_id','pr_number','origin','old_head_sha','main_sha','pre_observation_at','pre_collected_at','pre_observation_id','request_at','request_collected_at','response_at','response_collected_at',
      'response_status','reason_code','request_receipt_id','response_receipt_id','claim_id','fence','source_ref','confirmation'])||
      !uuid(o.operation_id)||ops.has(o.operation_id)||!['executor','holder_adapter','platform_operation'].includes(o.origin)||!sha(o.old_head_sha)||
      !sha(o.main_sha)||o.old_head_sha===o.main_sha||!opaque(o.request_receipt_id)||(o.response_receipt_id!==null&&!opaque(o.response_receipt_id))||
      (o.claim_id!==null&&!uuid(o.claim_id))||(o.fence!==null&&(!Number.isSafeInteger(o.fence)||o.fence<1))||(o.claim_id===null)!==(o.fence===null)||
      !opaque(o.pre_observation_id)||!digest(o.source_ref)||
      (o.response_status!==null&&(!Number.isSafeInteger(o.response_status)||!(o.response_status===0||o.response_status>=100&&o.response_status<=599))))bad();
    integer(o.pr_number);code(o.reason_code);
    const request=timing(o.request_at,o.request_collected_at,c),response=o.response_at===null?null:timing(o.response_at,o.response_collected_at,c);
    if(timing(o.pre_observation_at,o.pre_collected_at,c)>request||timestampMicros(o.pre_collected_at)>request)bad();
    if(request<timestampMicros(p.collection.retention_start)||response!==null&&response<request||
      o.response_at===null&&(o.response_status!==null||o.response_collected_at!==null||o.response_receipt_id!==null)||
      response!==null&&o.response_receipt_id===null||o.response_status===0&&o.origin!=='holder_adapter')bad();
    const linked=[...moves.values()].filter(m=>m.operation_id===o.operation_id);
    for(const m of linked)if(m.pr_number!==o.pr_number||m.old_head_sha!==o.old_head_sha||timestampMicros(m.event_at)<request)bad();
    let state=o.response_status===202||o.response_status===0?'ACCEPTED_NOT_CONFIRMED':
      o.response_status!==null&&o.response_status>=400?'REQUEST_FAILED':'RESPONSE_OUTCOME_UNKNOWN',confirmedMove=null;
    if(o.confirmation!==null){
      const q=o.confirmation;
      if(state!=='ACCEPTED_NOT_CONFIRMED'||!exact(q,['event_at','collected_at','new_head_sha','parents','pre_head_sha','post_head_sha','pre_main_sha','post_main_sha',
        'pre_observation_id','post_observation_id','operation_id','request_receipt_id','response_receipt_id'])||!sha(q.new_head_sha)||q.new_head_sha===o.old_head_sha||
        q.pre_head_sha!==o.old_head_sha||q.post_head_sha!==q.new_head_sha||q.pre_main_sha!==o.main_sha||q.post_main_sha!==o.main_sha||
        !Array.isArray(q.parents)||q.parents.length!==2||new Set(q.parents).size!==2||!q.parents.includes(o.old_head_sha)||!q.parents.includes(o.main_sha)||
        q.pre_observation_id!==o.pre_observation_id||!opaque(q.post_observation_id)||q.pre_observation_id===q.post_observation_id||q.operation_id!==o.operation_id||
        q.request_receipt_id!==o.request_receipt_id||q.response_receipt_id!==o.response_receipt_id||timing(q.event_at,q.collected_at,c)<response)bad();
      if(linked.length!==1||linked[0].new_head_sha!==q.new_head_sha||linked[0].observation_id!==q.post_observation_id||
        timestampMicros(linked[0].event_at)<response||timestampMicros(linked[0].event_at)>timestampMicros(q.event_at)||
        timestampMicros(linked[0].collected_at)>timestampMicros(q.collected_at))bad();
      state='CONFIRMED_UPDATE';confirmedMove=linked[0].move_id;
      if(inWindow(timestampMicros(linked[0].event_at))&&timestampMicros(q.event_at)>=to)lateUpdates++;
    }
    if(inWindow(request)){if(state==='ACCEPTED_NOT_CONFIRMED')acceptedPending++;else if(state==='REQUEST_FAILED')requestFailed++;else if(state==='RESPONSE_OUTCOME_UNKNOWN')responseUnknown++;}
    ops.set(o.operation_id,{...o,state,confirmedMove});
  }
  // An operation UUID is not causal attribution. Failed/pending/absent
  // operations cannot remove a real Native head change from UNKNOWN.
  const cohortMoves=[...moves.values()].filter(m=>inWindow(timestampMicros(m.event_at)));
  const confirmedMoves=cohortMoves.filter(m=>ops.get(m.operation_id)?.confirmedMove===m.move_id);
  const unknownMoves=cohortMoves.length-confirmedMoves.length;
  const linkedFailedMoves=cohortMoves.filter(m=>ops.get(m.operation_id)?.state==='REQUEST_FAILED').length;

  const rounds=new Map(),runOwners=new Set(),jobOwners=new Set();
  for(const r of p.rounds){
    if(![ ['round_id','scope','pr_number','head_sha','main_sha','started_at','completed_at','run_keys','execution_packets','applicability','termination','main_move','merge_proof'],['round_id','scope','pr_number','head_sha','main_sha','started_at','completed_at','terminal_interval','run_keys','execution_packets','applicability','termination','main_move','merge_proof'] ].some(fields=>exact(r,fields))||
      !uuid(r.round_id)||!scope(r.scope)||rounds.has(r.round_id)||!sha(r.head_sha)||!sha(r.main_sha)||!Array.isArray(r.run_keys)||r.run_keys.length>1000||
      new Set(r.run_keys).size!==r.run_keys.length||r.run_keys.some(x=>!attempts.has(x)||attempts.get(x).kind!=='ci')||
      !Array.isArray(r.execution_packets)||r.execution_packets.length!==r.run_keys.length||
      !exact(r.applicability,['changed_files','diff_complete','commit_count','workflow_files','profile_sha256','source_checkout_sha']))bad();
    integer(r.pr_number);const start=timestampMicros(r.started_at);if(start<timestampMicros(p.collection.retention_start)||start>closed)bad();
    if(r.completed_at!==null&&(timestampMicros(r.completed_at)<start||timestampMicros(r.completed_at)>closed))bad();
    const executionVersion=executionVersions.get(r.applicability.source_checkout_sha);
    if(r.applicability.diff_complete!==true||!executionVersion||isV2&&r.applicability.source_checkout_sha!==r.main_sha||r.applicability.profile_sha256!==executionVersion.descriptor.profiles_sha256||
      !Number.isSafeInteger(r.applicability.commit_count)||r.applicability.commit_count<1||r.applicability.commit_count>1000)bad();
    const roundProfiles=executionVersion.profiles,roundDescriptor=executionVersion.descriptor;
    const applicable=applicability(roundProfiles,r.applicability.changed_files);
    if(!same(sortedUnique(r.applicability.workflow_files),applicable)||!applicable.length)bad();
    const executionSeen=new Set(),fileSeen=new Set();let primaryReady=true,jobsComplete=true;
    for(const x of r.execution_packets){
      if(!exact(x,['run_key','workflow_file','jobs','jobs_manifest','before_attempt','after_attempt','source_descriptor'])||!r.run_keys.includes(x.run_key)||
        executionSeen.has(x.run_key)||fileSeen.has(x.workflow_file)||!roundProfiles.workflows[x.workflow_file]||!Array.isArray(x.jobs)||
        !exact(x.source_descriptor,['workflow_blob','workflow_source_sha256','source_checkout_sha','role','role_source_sha256']))bad();
      const a=attempts.get(x.run_key),profile=roundProfiles.workflows[x.workflow_file];
      if(a.pr_number!==r.pr_number||a.head_sha!==r.head_sha||runOwners.has(x.run_key)||x.source_descriptor.workflow_blob!==profile.workflow_blob||
        x.source_descriptor.workflow_source_sha256!==hash(profile.source_yaml)||x.source_descriptor.source_checkout_sha!==r.applicability.source_checkout_sha||
        x.source_descriptor.role!=='primary_execution'||x.source_descriptor.role_source_sha256!==roundDescriptor.role_specs_sha256)bad();
      for(const barrier of [x.before_attempt,x.after_attempt])if(!exact(barrier,['run_id','attempt','head_sha','status','conclusion'])||
        barrier.run_id!==a.run_id||barrier.attempt!==a.attempt||barrier.head_sha!==a.head_sha||barrier.status!==a.status||barrier.conclusion!==a.conclusion)bad();
      const members=[];
      for(const j of x.jobs){if(!object(j)||!Number.isSafeInteger(j.id)||j.id<1||jobOwners.has(j.id)||String(j.run_id)!==a.run_id||j.run_attempt!==a.attempt)bad();jobOwners.add(j.id);members.push(String(j.id));}
      if(!pagesConsistent(x.jobs_manifest,members,c,`native_jobs:${x.run_key}`))jobsComplete=false;
      const q=qualifyPrimary(profile,x.jobs,x.workflow_file);if(q.passed!==true||q.scope!=='workflow_execution')primaryReady=false;
      runOwners.add(x.run_key);executionSeen.add(x.run_key);fileSeen.add(x.workflow_file);
    }
    if(!same([...fileSeen].sort(),applicable))populationGaps.push(`incomplete_round_workflows:${r.round_id}`);
    if(!jobsComplete)populationGaps.push(`incomplete_round_jobs:${r.round_id}`);
    const rb=terminalInterval(r);if(rb&&(rb.lower<start||rb.upper>closed))bad();
    if(r.completed_at===null&&rb){const member=r.run_keys.map(k=>terminals.get(k));if(member.some(b=>!b)||rb.lower!==member.reduce((v,b)=>b.lower>v?b.lower:v,member[0].lower)||rb.upper!==member.reduce((v,b)=>b.upper>v?b.upper:v,member[0].upper))bad();}
    rounds.set(r.round_id,{...r,primaryReady,terminalBounds:rb});
  }
  let wasted=0,roundUnknown=0,used=0,notSuccessful=0;
  const mergeOwners=new Map(),cohortRounds=[...rounds.values()].filter(r=>inWindow(timestampMicros(r.started_at)));
  const bindMerge=(identity,r,m)=>{
    const binding=JSON.stringify([r.round_id,[...m.used_run_keys].sort(),r.pr_number,r.head_sha,m.response_merged_commit_sha,m.event_at]);
    if(mergeOwners.has(identity)&&mergeOwners.get(identity)!==binding)bad();mergeOwners.set(identity,binding);
  };
  for(const r of rounds.values()){
    const counted=inWindow(timestampMicros(r.started_at));
    // Merge identities are unique across the entire reference closure, not
    // merely within the counted cohort or a successful local round branch.
    if(r.merge_proof!==null){
      const m=r.merge_proof;
      if(r.termination!==null||r.main_move!==null||!exact(m,['receipt_id','event_at','collected_at','round_id','used_run_keys','operation_id','expected_head_sha','response_merged_commit_sha','native_pr'])||
        !opaque(m.receipt_id)||m.round_id!==r.round_id||!same(sortedUnique(m.used_run_keys),[...r.run_keys].sort())||!uuid(m.operation_id)||
        m.expected_head_sha!==r.head_sha||!sha(m.response_merged_commit_sha)||!r.terminalBounds||
        !exact(m.native_pr,['number','head_sha','state','merged','merged_at','merge_commit_sha'])||m.native_pr.number!==r.pr_number||m.native_pr.head_sha!==r.head_sha||
        m.native_pr.state!=='closed'||m.native_pr.merged!==true||m.native_pr.merge_commit_sha!==m.response_merged_commit_sha||timestampMicros(m.native_pr.merged_at)!==timing(m.event_at,m.collected_at,c)||
        timestampMicros(m.event_at)<r.terminalBounds.lower)bad();
      bindMerge('operation:'+m.operation_id,r,m);bindMerge('receipt:'+m.receipt_id,r,m);
      bindMerge('native_pr:'+r.pr_number,r,m);
      bindMerge('native:'+r.pr_number+':'+r.head_sha+':'+m.response_merged_commit_sha,r,m);
    }
    const primary=r.run_keys.map(k=>attempts.get(k));
    const roundStart=timestampMicros(r.started_at),roundEnd=r.terminalBounds?.upper??null;
    // Retain valid non-executed cancelled members, but check every known bound
    // before an unsuccessful/unknown path can bypass execution classification.
    if(primary.some(a=>a.started_at!==null&&(timestampMicros(a.started_at)<roundStart||roundEnd!==null&&timestampMicros(a.started_at)>roundEnd)||
      a.completed_at!==null&&(timestampMicros(a.completed_at)<roundStart||roundEnd!==null&&timestampMicros(a.completed_at)>roundEnd)||
      terminals.get(key(a))&&(terminals.get(key(a)).upper<roundStart||roundEnd!==null&&terminals.get(key(a)).lower>roundEnd)))bad();
    if(!r.terminalBounds||primary.some(a=>a.status!=='completed')){if(counted)roundUnknown++;continue;}
    if(primary.some(a=>a.conclusion!=='success')||!r.primaryReady){if(counted){notSuccessful++;roundUnknown++;}continue;}
    // Only fully qualified successful execution can become used/wasted Full.
    if(primary.some(a=>a.started_at===null||!terminals.get(key(a))))bad();
    if(r.merge_proof!==null){if(counted){if(timestampMicros(r.merge_proof.event_at)>=r.terminalBounds.upper)used++;else roundUnknown++;}continue;}
    const t=r.termination;if(t===null){if(counted)roundUnknown++;continue;}
    if(!exact(t,['receipt_id','event_at','collected_at','kind','reason_code','original_round_id','operation_id','replacement_round_id'])||!opaque(t.receipt_id)||
      !['MAIN_ADVANCED_REPLACED','OTHER','UNKNOWN'].includes(t.kind)||t.original_round_id!==r.round_id||
      (t.operation_id!==null&&!uuid(t.operation_id))||(t.replacement_round_id!==null&&!uuid(t.replacement_round_id))||timing(t.event_at,t.collected_at,c)<r.terminalBounds.lower)bad();
    if(timestampMicros(t.event_at)<r.terminalBounds.upper){if(counted)roundUnknown++;continue;}
    if(t.kind!=='MAIN_ADVANCED_REPLACED'){if(counted)roundUnknown++;continue;}if(t.reason_code!=='MAIN_ADVANCED_INVALIDATED_FINAL_ROUND')bad();
    const o=ops.get(t.operation_id),next=rounds.get(t.replacement_round_id),m=r.main_move,terminated=timestampMicros(t.event_at);
    if(!o||o.state!=='CONFIRMED_UPDATE'||o.reason_code!=='MAIN_MOVED_REQUIRES_RERUN'||!next||m===null){if(counted)roundUnknown++;continue;}
    if(!exact(m,['old_main_sha','new_main_sha','event_at','collected_at','observation_id'])||!opaque(m.observation_id)||m.old_main_sha!==r.main_sha||m.new_main_sha!==o.main_sha||
      m.old_main_sha===m.new_main_sha||timing(m.event_at,m.collected_at,c)<timestampMicros(r.started_at)||timestampMicros(m.event_at)>timestampMicros(o.request_at)||
      o.pr_number!==r.pr_number||o.old_head_sha!==r.head_sha||timestampMicros(o.request_at)<r.terminalBounds.upper||terminated<timestampMicros(o.confirmation.event_at)||
      next.pr_number!==r.pr_number||next.head_sha!==o.confirmation.new_head_sha||timestampMicros(next.started_at)<terminated)bad();
    // Full supplied rounds, not a self-reported last-round boolean.
    const intervening=[...rounds.values()].some(x=>x.round_id!==r.round_id&&x.round_id!==next.round_id&&x.pr_number===r.pr_number&&
      timestampMicros(x.started_at)>=timestampMicros(r.started_at)&&timestampMicros(x.started_at)<=terminated);
    if(intervening){if(counted)roundUnknown++;continue;}if(counted)wasted++;
  }
  const unknownCancelMembership=[...attempts].filter(([,r])=>r.status==='completed'&&r.conclusion==='cancelled'&&!insideTerminal(terminals.get(key(r)))&&!outsideTerminal(terminals.get(key(r))));
  const cancelled=[...attempts].filter(([,r])=>r.status==='completed'&&r.conclusion==='cancelled'&&insideTerminal(terminals.get(key(r))));
  const cancelEvidence=new Map();
  for(const x of p.cancellations){
    const a=attempts.get(key(x));
    if(!exact(x,['run_id','attempt','basis','reason_code','event_at','collected_at','request_id','provider_receipt_id'])||cancelEvidence.has(key(x))||
      !a||a.conclusion!=='cancelled'||!['platform_causal_receipt','explicit_operation_receipt','unknown'].includes(x.basis))bad();
    if(x.basis==='unknown'){
      if(x.reason_code!==null||x.event_at!==null||x.request_id!==null||x.provider_receipt_id!==null||timestampMicros(x.collected_at)>closed||
        timestampMicros(x.collected_at)<timestampMicros(p.collection.retention_start)||terminals.get(key(a))&&timestampMicros(x.collected_at)<terminals.get(key(a)).upper)bad();
    }else{
      if(!cancelCodes.has(x.reason_code)||!opaque(x.request_id)||(x.basis==='platform_causal_receipt'?!opaque(x.provider_receipt_id):x.provider_receipt_id!==null))bad();
      // A real cancellation request/cause can precede execution start. Keep
      // retention/observation/actual terminal bounds, never invent a start.
      const event=timing(x.event_at,x.collected_at,c);
      if(event<timestampMicros(p.collection.retention_start)||terminals.get(key(a))&&event>terminals.get(key(a)).upper)bad();
    }cancelEvidence.set(key(x),x);
  }
  const cancelReasons={UNKNOWN_CAUSE:0},cancelRequests={};let knownCancel=0,lateCancelEvidence=0;
  for(const [k]of cancelled){const x=cancelEvidence.get(k);if(!x||x.basis==='unknown'){cancelReasons.UNKNOWN_CAUSE++;continue;}
    if(timestampMicros(x.collected_at)>=to)lateCancelEvidence++;
    if(x.basis==='explicit_operation_receipt'){cancelRequests[x.reason_code]=(cancelRequests[x.reason_code]??0)+1;cancelReasons.UNKNOWN_CAUSE++;continue;}
    cancelReasons[x.reason_code]=(cancelReasons[x.reason_code]??0)+1;knownCancel++;
  }
  const unknownFinal=admitted.unknown_claim+explicitNoDecision+missingFinal;
  const metrics={
    unclaimed_admitted:metric(admitted.invalid_mandatory_claim,admitted.valid+admitted.efficiency_no_valid_claim+admitted.invalid_mandatory_claim,unknownFinal,
      cohortTargets.length,{admitted_with_valid_claim:admitted.valid,legal_efficiency_exemptions:admitted.efficiency_no_valid_claim,cohort:'target_first_selection_in_window',
        explicit_no_final_decision:explicitNoDecision,missing_packet_count:missingFinal}),
    admission_failures_by_reason:{status:unknownFinal?'PARTIAL_KNOWLEDGE':'CATEGORIZED_CANDIDATE',value:failures,rejected,evaluation_errors:admissionErrors,
      unknown_reason_decisions:unknownFailureReason,explicit_no_final_decision:explicitNoDecision,missing_packet_count:missingFinal,denominator:cohortTargets.length,
      late_resolutions_before_watermark:lateAdmissions,reason_counts_are_multi_label:true,...flags},
    update_main_rounds:metric(confirmedMoves.length,confirmedMoves.length,unknownMoves,cohortMoves.length,{cohort:'native_head_move_event_in_window',
      confirmed_updates:confirmedMoves.length,unattributed_head_moves:unknownMoves,linked_failed_operation_moves:linkedFailedMoves,
      accepted_not_confirmed_intents:acceptedPending,failed_request_intents:requestFailed,response_outcome_unknown_intents:responseUnknown,
      late_confirmations_before_watermark:lateUpdates,request_intents_are_not_update_count:true}),
    wasted_final_rounds:metric(wasted,wasted+used,roundUnknown,cohortRounds.length,{cohort:'round_start_in_window',confirmed_wasted:wasted,used_for_merge:used,
      non_successful_rounds:notSuccessful,execution_qualification:'SUPPLIED_EXECUTION_CONSISTENCY_ONLY'}),
    cancellation_causes:{status:unknownCancelMembership.length?'PARTIAL_MEMBERSHIP':'CATEGORIZED_CANDIDATE',value:unknownCancelMembership.length?null:cancelReasons,observed_known_cause_counts:cancelReasons,cohort:'native_attempt_completion_in_window',denominator:unknownCancelMembership.length?null:cancelled.length,
      observed_known_denominator:cancelled.length,membership_unknown_count:unknownCancelMembership.length,
      known_cause_count:knownCancel,unknown_cause_count:cancelReasons.UNKNOWN_CAUSE,explicit_requests_by_intent:cancelRequests,
      late_evidence_before_watermark:lateCancelEvidence,cause_coverage:unknownCancelMembership.length?null:cancelled.length?knownCancel/cancelled.length:null,
      fully_explained:unknownCancelMembership.length===0&&cancelReasons.UNKNOWN_CAUSE===0,...flags},
  };
  const manifestComplete=populationGaps.length===0;
  if(!manifestComplete)for(const m of Object.values(metrics)){m.supplied_observation_value=m.value;m.value=null;m.status='SUPPLIED_POPULATION_INCOMPLETE';}
  return {status:'FOUR_SOURCE_CALCULATION_CANDIDATE',candidate_ready:manifestComplete&&p.collection.window_status==='closed',supplied_data_consistency:true,
    supplied_population_manifest_complete:manifestComplete,population_gaps:[...new Set(populationGaps)],actual_population_completeness:'NOT_ESTABLISHED',
    source_permission_qualification:'NOT_ESTABLISHED',source_acceptance_required:true,reference_closure:{fixed_at:p.collection.closed_at,
      targets_outside_cohort:targets.size-cohortTargets.length,head_moves_outside_cohort:moves.size-cohortMoves.length,rounds_outside_cohort:rounds.size-cohortRounds.length},
    window:{...p.window,status:p.collection.window_status,closed_at:p.collection.closed_at,
      fixed_watermark:p.collection.watermark},semantic_unknown_is_not_population_gap:true,formal_transport_requirements:FORMAL_TRANSPORT_REQUIREMENTS,metrics,...flags};
}

return readFourSourcesCandidate;
}
function operationProducerFor(expectations){
const FOUR_SOURCE_CONTRACT={...expectations.scope};
const flags={source_authenticated:false,official_metric:false,execution_permission:false,t0:null};
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,fields)=>obj(x)&&Object.keys(x).sort().join(',')===[...fields].sort().join(',');
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x),digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const opaque=x=>typeof x==='string'&&/^[a-zA-Z0-9_.:-]{1,128}$/.test(x);
const scope=x=>exact(x,['project_id','queue_ref'])&&x.project_id===FOUR_SOURCE_CONTRACT.project_id&&x.queue_ref===FOUR_SOURCE_CONTRACT.queue_ref;
const safeNo=()=>({status:'NOT_QUALIFIED',reason_code:'INVALID_SUPPLIED_OPERATION_OBSERVATION',...flags});
const parseRawFourSourceDataCandidate=parseFourSourceRawData;
const raw=x=>{if(typeof x!=='string'||Buffer.byteLength(x)>1024*1024)throw new Error('invalid raw');return parseRawFourSourceDataCandidate(x);};
const timing=(event,collected)=>{const at=timestampMicros(event);if(timestampMicros(collected)<at)throw new Error('time order');return at;};

const NATURAL_PRODUCER_INTERFACES=Object.freeze({
  final_admission:'actual final evaluate result plus separately observed claim/App identity',
  admission_population:'authenticated initial selection, ordered selection changes, closing snapshot and ever-target set',
  operation:'actual typed pre-read -> request receipt/fence -> exact response -> independent Native post-read',
  final_round:'complete applicable source/role/attempt/jobs -> explicit termination or Native merge receipt',
  cancellation:'complete Native cancelled attempts, separate provider causal receipt or UNKNOWN; actor is not canceller',
  persisted_transport:'NOT_IMPLEMENTED_PRIVATE_ADAPTERS_ONLY',
});

// 'before' is the supplied independent Native pre-read, not after's restated
// old-head fields. The formal natural caller must actually perform and bind it.
function updateOperationObservationCandidate(beforeRaw,responseRaw,afterRaw){
  try{
    const b=raw(beforeRaw),r=responseRaw===null?null:raw(responseRaw),a=afterRaw===null?null:raw(afterRaw);
    if(!exact(b,['scope','operation_id','pr_number','origin','request_at','request_collected_at','reason_code','request_receipt_id','claim_id','fence','source_ref','native_pre'])||
      !scope(b.scope)||!uuid(b.operation_id)||!Number.isSafeInteger(b.pr_number)||b.pr_number<1||
      !['executor','holder_adapter','platform_operation'].includes(b.origin)||!opaque(b.request_receipt_id)||!digest(b.source_ref)||
      (b.claim_id!==null&&!uuid(b.claim_id))||(b.fence!==null&&(!Number.isSafeInteger(b.fence)||b.fence<1))||(b.claim_id===null)!==(b.fence===null)||
      !['MAIN_MOVED_REQUIRES_RERUN','OWNER_UPDATE','GENERAL_UPDATE'].includes(b.reason_code)||
      !exact(b.native_pre,['number','head_sha','main_sha','event_at','collected_at','observation_id'])||b.native_pre.number!==b.pr_number||
      !sha(b.native_pre.head_sha)||!sha(b.native_pre.main_sha)||b.native_pre.head_sha===b.native_pre.main_sha||!opaque(b.native_pre.observation_id))return safeNo();
    const request=timing(b.request_at,b.request_collected_at),pre=timing(b.native_pre.event_at,b.native_pre.collected_at);
    if(pre>request||timestampMicros(b.native_pre.collected_at)>request)return safeNo();
    if(r!==null&&(!exact(r,['operation_id','request_receipt_id','status','event_at','collected_at','response_receipt_id'])||
      r.operation_id!==b.operation_id||r.request_receipt_id!==b.request_receipt_id||!opaque(r.response_receipt_id)||
      r.status!==null&&(!Number.isSafeInteger(r.status)||!(r.status===0||r.status>=100&&r.status<=599))||
      r.status===0&&b.origin!=='holder_adapter'||timing(r.event_at,r.collected_at)<request))return safeNo();
    let confirmation=null,confirmation_reason='NOT_OBSERVED';
    if(a!==null){
      if(r===null||!exact(a,['operation_id','number','head_sha','main_sha','parents','event_at','collected_at','observation_id'])||
        a.operation_id!==b.operation_id||a.number!==b.pr_number||!sha(a.head_sha)||!sha(a.main_sha)||!opaque(a.observation_id)||
        a.observation_id===b.native_pre.observation_id||!Array.isArray(a.parents)||a.parents.length>100||a.parents.some(x=>!sha(x))||
        timing(a.event_at,a.collected_at)<timestampMicros(r.event_at)||timestampMicros(a.collected_at)<timestampMicros(r.collected_at))return safeNo();
      const accepted=r.status===202||r.status===0;
      if(accepted&&a.head_sha!==b.native_pre.head_sha&&a.main_sha===b.native_pre.main_sha&&a.parents.length===2&&
        new Set(a.parents).size===2&&a.parents.includes(b.native_pre.head_sha)&&a.parents.includes(b.native_pre.main_sha)){
        confirmation={event_at:a.event_at,collected_at:a.collected_at,new_head_sha:a.head_sha,parents:a.parents,
          pre_head_sha:b.native_pre.head_sha,post_head_sha:a.head_sha,pre_main_sha:b.native_pre.main_sha,post_main_sha:a.main_sha,
          pre_observation_id:b.native_pre.observation_id,post_observation_id:a.observation_id,operation_id:b.operation_id,
          request_receipt_id:b.request_receipt_id,response_receipt_id:r.response_receipt_id};
        confirmation_reason='SUPPLIED_REQUEST_RESPONSE_AND_NATIVE_BARRIERS_MATCH';
      }else confirmation_reason='NATIVE_OPERATION_COMPLETION_NOT_PROVED';
    }
    return {status:'UPDATE_OPERATION_PACKET_CANDIDATE',confirmation_reason,operation:{operation_id:b.operation_id,pr_number:b.pr_number,
      origin:b.origin,old_head_sha:b.native_pre.head_sha,main_sha:b.native_pre.main_sha,pre_observation_at:b.native_pre.event_at,
      pre_collected_at:b.native_pre.collected_at,pre_observation_id:b.native_pre.observation_id,request_at:b.request_at,request_collected_at:b.request_collected_at,
      response_at:r?.event_at??null,response_collected_at:r?.collected_at??null,response_status:r?.status??null,reason_code:b.reason_code,
      request_receipt_id:b.request_receipt_id,response_receipt_id:r?.response_receipt_id??null,claim_id:b.claim_id,fence:b.fence,source_ref:b.source_ref,confirmation},...flags};
  }catch{return safeNo();}
}

return updateOperationObservationCandidate;
}
