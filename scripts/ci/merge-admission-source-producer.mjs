// Natural observation formatter/sink only. No token, API, authority, CI trigger,
// Canon append or population-completeness assertion. Original consumers decide.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {timestampMicros} from './merge-admission-measurement-history.mjs';
export const NATURAL_EVENT_SCHEMA='clued.merge-admission-natural-source-event/1';
export const NATURAL_DIRECTORY='.clued-r9-source-events';
export const NATURAL_ARTIFACT_SCHEMA='clued.merge-admission-natural-artifact/1';
export const NATURAL_INTAKE_PROTOCOL=Object.freeze({event_schema:NATURAL_EVENT_SCHEMA,artifact_schema:NATURAL_ARTIFACT_SCHEMA,
  artifact_name:'clued-r9-natural-source-RUN-ATTEMPT-JOB',file:'natural-packet.json',
  authentication:'actual Native artifact/run/attempt/job and accepted executed source/role proof; never a JSON flag',
  population:'local producer closure only; complete Native/manual/Owner/holder and reference populations remain separate'});
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x)?x:null;
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x)?x:null;
const number=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const id=x=>typeof x==='string'&&/^[1-9][0-9]{0,19}$/.test(x)?x:Number.isSafeInteger(x)&&x>0?String(x):null;
const appExternal=x=>typeof x==='string'&&/^pr:[1-9][0-9]{0,9}:run:[1-9][0-9]{0,19}(?::publication:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})?$/.test(x)?x:null;
const publicationOf=x=>x?{publication_id:uuid(x.publication_id),begin_receipt_id:uuid(x.begin_receipt_id),
  begin_execution_epoch:number(x.begin_execution_epoch),finish_receipt_id:uuid(x.finish_receipt_id),
  finish_execution_epoch:number(x.finish_execution_epoch),finish_status:x.finish_status==='committed'?'committed':null,
  must_revoke:typeof x.must_revoke==='boolean'?x.must_revoke:null}:null;
const currentPublication=p=>p&&uuid(p.publication_id)&&uuid(p.begin_receipt_id)&&uuid(p.finish_receipt_id)&&
  number(p.begin_execution_epoch)&&p.begin_execution_epoch===p.finish_execution_epoch&&p.finish_status==='committed'&&p.must_revoke===false;
const scope=x=>typeof x==='string'&&/^(global|project:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(x)?x:null;
const safe=x=>typeof x==='string'&&/^[A-Za-z0-9_./:@-]{1,250}$/.test(x)?x:null;
const prReference=x=>{
  if(typeof x!=='string'||x.length>250||/\s/.test(x)||! /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*#[1-9][0-9]{0,15}$/.test(x))return null;
  const n=Number(x.slice(x.lastIndexOf('#')+1));return Number.isSafeInteger(n)?x:null;
};
// Canonicalize actual SQL offsets without rounding their microseconds. Missing
// or invalid RPC time stays missing; producer event_at is never a substitute.
const timestamp=x=>{
  try{
    const micros=timestampMicros(x);if(x.endsWith('Z'))return x;
    let seconds=micros/1000000n,fraction=micros%1000000n;
    if(fraction<0n){seconds--;fraction+=1000000n;}
    const utc=new Date(Number(seconds*1000n)).toISOString();
    if(!/^\d{4}-/.test(utc))return null;
    return utc.slice(0,19)+'.'+String(fraction).padStart(6,'0')+'Z';
  }catch{return null;}
};
const digest=x=>createHash('sha256').update(x).digest('hex');
export const naturalRoundId=keys=>{const h=digest(JSON.stringify([...keys].sort())).slice(0,32);return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');};
const refs=rows=>Array.isArray(rows)?rows.slice(0,2000).map(r=>({run_id:id(r.id??r.run_id),attempt:number(r.run_attempt),
  workflow_path:safe(r.path),head_sha:sha(r.head_sha),status:safe(r.status),conclusion:safe(r.conclusion)})):[];
const REASONS=new Set(['claim_trailer_missing','claim_not_found','work_claim_conflict','changed_files_truncated','claim_base_unknown',
  'protected_change_not_up_to_date','path_outside_write_set','paths_outside_write_set','head_budget_exhausted','ci_budget_exhausted',
  'merge_slot_required','merge_slot_missing','owner_grant_required','owner_grant_missing','owner_grant_revoked','owner_grant_expired',
  'admission_binding_required','authorization_revoked_or_expired','binding_not_authorized','resource_action_not_authorized',
  'evaluation_not_completed','workflow_change_not_authorized','workflow_missing_admission_gate']);
// These are the reader's real known evaluator prefixes. The typed event keeps
// only the class; the envelope restores the diagnostic-free grammar prefix.
const READER_REASON_PREFIXES=Object.freeze({
  CLAIM_TRAILER_MISSING:'claim_trailer_missing',CHANGED_FILES_TRUNCATED:'changed_files_truncated:',CLAIM_BASE_UNKNOWN:'claim_base_unknown:',
  WORKFLOW_GATE:'workflow_gate:',POLICY_FILE_REMOVED:'policy_file_removed:',POLICY_FILE_INVALID:'policy_file_invalid:',
  PROTECTED_CHANGE_NOT_UP_TO_DATE:'protected_change_not_up_to_date:',OWNER_REVIEW_REQUIRED:'owner_review_required (',
  OWNER_REVIEW_UNAVAILABLE:'owner_review_unavailable:',WORKFLOW_RUNS_UNAVAILABLE:'workflow runs unavailable:',
});
const readerReason=code=>READER_REASON_PREFIXES[code]??(typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code.toLowerCase():'unknown_reason');
const reasonCodes=rows=>Array.isArray(rows)?[...new Set(rows.map(x=>{
  if(typeof x!=='string')return 'UNKNOWN_REASON';
  const known=Object.entries(READER_REASON_PREFIXES).find(([code,prefix])=>prefix==='claim_trailer_missing'?x===prefix:x.startsWith(prefix));
  if(known)return known[0];const p=x.split(':',1)[0];
  return REASONS.has(p)?p.toUpperCase():'UNKNOWN_REASON';}))]:[];
function prOf(pr){return {pr_number:number(pr?.number),head_sha:sha(pr?.head?.sha),base_sha:sha(pr?.base?.sha),
  base_ref:safe(pr?.base?.ref),base_repository:safe(pr?.base?.repo?.full_name),state:['open','closed'].includes(pr?.state)?pr.state:null,draft:typeof pr?.draft==='boolean'?pr.draft:null};}
function operationAuthorityFields(data){return {
  ...(data.task_id===undefined?{}:{task_id:uuid(data.task_id)}),
  ...(data.execution_epoch===undefined?{}:{execution_epoch:number(data.execution_epoch)}),
  ...(data.head_authorization_id===undefined?{}:{head_authorization_id:uuid(data.head_authorization_id)})};}
function finalOf(o){return {pr_ref:prReference(o?.pr_ref),head_sha:sha(o?.head_sha),base_sha:sha(o?.base_sha),enforced:o?.enforced===true,
  scope:scope(o?.scope),claim_id:uuid(o?.claim_id),admitted:o?.admitted===true,
  verdict:['ADMITTED','REJECTED','ERROR','PR_NOT_OPEN','NOT_APPLICABLE'].includes(o?.verdict)?o.verdict:'ERROR',
  reason_codes:reasonCodes(o?.reasons),claim_verdict:safe(o?.claim_verdict),
  mode:o?.mode==='required'?'required':null,owner_review_kind:safe(o?.owner_review?.kind),
  admission_mode:{state:safe(o?.admission_mode?.state),layer:safe(o?.admission_mode?.layer)},
  claim:{status:safe(o?.claim?.status),fence:number(o?.claim?.fence),expires_at:timestamp(o?.claim?.expires_at)},
  merge_slot:{state:safe(o?.merge_slot?.state),tip:sha(o?.merge_slot?.tip),until:timestamp(o?.merge_slot?.until)}};}

// Every kind is an allowlist. Never stringify a raw outcome/response, body,
// error, Actor, environment, credential, provider message or private raw claim.
export function formatNaturalPayload(kind,data={}){
  switch(kind){
    case 'admission_input':return {evaluation_id:uuid(data.evaluation_id),...prOf(data.pr),entry:safe(data.entry),selection_semantics:'event_input_not_fresh_selection'};
    case 'admission_selected':return {evaluation_id:uuid(data.evaluation_id),...prOf(data.pr),entry:safe(data.entry),selection_semantics:'actual_fresh_evaluator_subject'};
    case 'admission_final':return {evaluation_id:uuid(data.evaluation_id),entry:safe(data.entry),
      final_decision_observed:data.completion==='returned',evaluation_completion:data.completion==='returned'?'returned':'exception',...finalOf(data.outcome)};
    case 'claim_verification':return {evaluation_id:uuid(data.evaluation_id),scope:scope(data.input?.scope),claim_id:uuid(data.input?.claim_id),
      head_sha:sha(data.input?.head_sha),response_kind:safe(data.result?.kind),verdict:safe(data.result?.verdict),
      verified_at:timestamp(data.result?.payload?.verified_at),reason_codes:reasonCodes(data.result?.reasons),
      fence:number(data.result?.payload?.claim?.fence),head_admitted_receipt_id:uuid(data.result?.payload?.head_admitted_receipt_id)};
    case 'batch_initial':return {batch_id:uuid(data.batch_id),entry:safe(data.entry),candidate_count:number(data.pulls?.length)??0,
      candidates:Array.isArray(data.pulls)?data.pulls.slice(0,2000).map(prOf):[],population_semantics:'listed_candidates_not_selected_targets',
      projection_truncated:Array.isArray(data.pulls)&&data.pulls.length>2000,listing_completeness:'NOT_ATTESTED'};
    case 'batch_selection':return {batch_id:uuid(data.batch_id),...prOf(data.pr),
      evaluation_id:uuid(data.evaluation_id),entry:safe(data.entry),criterion:data.criterion==='state_change'?'state_change':data.criterion==='prior_app_green'?'prior_app_green':'unknown',
      admission_green:typeof data.admission_green==='boolean'?data.admission_green:null,slot_green:typeof data.slot_green==='boolean'?data.slot_green:null};
    case 'batch_candidate':return {batch_id:uuid(data.batch_id),...prOf(data.pr),
      selection_state:['excluded','selected','unknown'].includes(data.selection_state)?data.selection_state:'unknown',
      reason_code:['DRAFT','OTHER_BASE','NO_PRIOR_GREEN','SELECTION_READ_FAILED','NATIVE_PR_IDENTITY_UNAVAILABLE','STATE_CHANGE','PRIOR_APP_GREEN'].includes(data.reason_code)?data.reason_code:'UNKNOWN_SELECTION',
      admission_green:typeof data.admission_green==='boolean'?data.admission_green:null,slot_green:typeof data.slot_green==='boolean'?data.slot_green:null};
    case 'batch_closing':return {batch_id:uuid(data.batch_id),completion:data.completion==='normal'?'normal':'exception',
      selected_evaluations:Array.isArray(data.selected)?data.selected.map(x=>({evaluation_id:uuid(x.evaluation_id),...prOf(x.pr)})):[],
      closure_semantics:'normal_local_loop_only; missing close is a genuine gap'};
    case 'app_check':return {pr_number:number(data.prNumber),head_sha:sha(data.headSha),app_check_name:safe(data.name),
      admit_step_outcome:['success','failure','skipped','cancelled'].includes(data.admitStepOutcome)?data.admitStepOutcome:null,
      check_run_id:id(data.result?.check_run_id),posted:data.result?.posted===true,
      conclusion:['success','failure'].includes(data.result?.conclusion)?data.result.conclusion:null,
      external_id:appExternal(data.result?.external_id),publication_observation:publicationOf(data.result?.publication_observation),
      posting_state:data.result?.posted===true?'posted':data.failure_code==='APP_NOT_CONFIGURED'?'not_configured':data.failure_code==='HEAD_NOT_REPORTED'?'head_not_reported':'post_failed',
      run_attempt_binding:'NATIVE_CONFIRMATION_REQUIRED'};
    case 'operation_request':return {operation_id:uuid(data.operation_id),action:safe(data.action),scope:scope(data.scope),...prOf(data.pr),
      expected_head_sha:sha(data.expected_head_sha),main_sha:sha(data.main_sha),claim_id:uuid(data.claim_id),fence:number(data.fence),
      ...operationAuthorityFields(data),
      pre_observation_id:uuid(data.pre_observation_id),
      reason_code:data.reason_code==='MAIN_MOVED_REQUIRES_RERUN'?'MAIN_MOVED_REQUIRES_RERUN':data.action==='update_branch'?'DEFAULT_BRANCH_UPDATE_REQUEST':'UNKNOWN_OPERATION_REASON',
      origin:data.origin===undefined?'executor':['executor','holder_adapter','platform_operation'].includes(data.origin)?data.origin:null,
      run_keys:Array.isArray(data.run_keys)?data.run_keys.map(safe):null,
      native_pre_basis:'original_consumer_read',original_round_id:uuid(data.original_round_id)};
    case 'operation_pre':return {operation_id:uuid(data.operation_id),...prOf(data.pr),main_sha:sha(data.main_sha),
      provenance:'actual original consumer GET response before mutation; authenticated writer proof required'};
    case 'operation_response':return {operation_id:uuid(data.operation_id),action:safe(data.action),status:number(data.response?.status),
      provider_request_id:safe(data.response?.request_id),
      response_sha:sha(data.response?.body?.sha),merged:data.response?.body?.merged===true,
      update_confirmation:'NATIVE_POST_OBSERVATION_REQUIRED',cancellation_cause:'UNKNOWN_CAUSE'};
    case 'operation_failure':return {operation_id:uuid(data.operation_id),action:safe(data.action),response_observed:false,
      failure_code:'ORIGINAL_REQUEST_THROWN',native_post_confirmation:'NOT_OBSERVED',cancellation_cause:'UNKNOWN_CAUSE'};
    case 'operation_post':return {operation_id:uuid(data.operation_id),pr_number:number(data.pr?.number),head_sha:sha(data.pr?.head?.sha),main_sha:sha(data.main_sha),
      parents:Array.isArray(data.parents)?data.parents.map(sha):null,provider_request_id:safe(data.provider_request_id),
      observation_basis:'actual fresh Native PR/commit GET after the original request; not a 202 or an inferred DAG event'};
    case 'operation_post_gap':return {operation_id:uuid(data.operation_id),native_post_observed:false,reason_code:'FRESH_NATIVE_POST_UNAVAILABLE'};
    case 'merge_native_post':return {operation_id:uuid(data.operation_id),native_pr:{number:number(data.pr?.number),head_sha:sha(data.pr?.head?.sha),
      state:data.pr?.state==='closed'?'closed':null,merged:data.pr?.merged===true,merge_commit_sha:sha(data.pr?.merge_commit_sha),merged_at:timestamp(data.pr?.merged_at)}};
    case 'round_termination':return {operation_id:uuid(data.operation_id),round_id:uuid(data.round_id),scope:scope(data.scope),...prOf(data.pr),
      kind:'new_main_requires_rerun',main_sha:sha(data.main_sha),run_keys:Array.isArray(data.run_keys)?data.run_keys.slice(0,2000).map(safe):null,
      provider_round_basis:'explicit original operation supersession of this supplied Native execution set; full jobs/source binding still required'};
    case 'manual_operation_input':return {operation_id:uuid(data.operation_id),action:safe(data.action),pr_number:number(data.pr_number),expected_head_sha:sha(data.expected_head_sha),
      ...operationAuthorityFields(data),
      run_id:id(data.run_id),attempt:number(data.attempt),origin:'holder',authority:'CURRENT_ORIGINAL_GATES_REQUIRED'};
    case 'round_ci_observation':return {scope:scope(data.scope),...prOf(data.pr),state:safe(data.seen?.state),
      native_runs:refs(data.seen?.execution?.native_runs),tip:sha(data.seen?.execution?.tip),
      applicability:data.seen?.execution?.observation_context?{changed_files:Array.isArray(data.seen.execution.observation_context.changed_files)?data.seen.execution.observation_context.changed_files.slice(0,300).map(safe):null,
        commits:number(data.seen.execution.observation_context.commits),default_branch:safe(data.seen.execution.observation_context.default_branch),
        workflow_files:Array.isArray(data.seen.execution.observation_context.workflow_files)?data.seen.execution.observation_context.workflow_files.map(safe):null}:null,
      role_scope:safe(data.seen?.execution?.scope),termination_cause:'NOT_OBSERVED',
      round_semantics:'CI_state_observation_not_explicit_final_round_termination'};
    case 'slot_touch':return {scope:scope(data.scope),...prOf(data.pr),ci_state:safe(data.seen?.state),
      rpc_status:number(data.response?.status),returned:data.response?.body?.returned===true,touched:data.response?.body?.touched===true,
      termination_cause:'NOT_OBSERVED'};
    case 'cancel_intent':return {operation_id:uuid(data.operation_id),run_id:id(data.run_id),attempt:number(data.attempt),
      request_receipt_id:safe(data.request_receipt_id),reason_code:safe(data.reason_code),cause:'UNKNOWN_CAUSE'};
    case 'cancel_native_post':return {operation_id:uuid(data.operation_id),run_id:id(data.run?.id),attempt:number(data.run?.run_attempt),head_sha:sha(data.run?.head_sha),
      status:safe(data.run?.status),conclusion:safe(data.run?.conclusion),cause:'UNKNOWN_CAUSE',semantics:'fresh actual Native state; not a causal provider receipt'};
    default:throw Error('UNSUPPORTED_NATURAL_EVENT_KIND');
  }
}

export function createNaturalRecorder({env={},workspace=env.GITHUB_WORKSPACE,sourceUrl,sourcePath,
  now=()=>new Date().toISOString(),write,readFile=fs.readFileSync,mkdir=fs.mkdirSync,appendFile=fs.appendFileSync,
  stateWrite,readCheckout=()=>execFileSync('git',['rev-parse','HEAD'],{cwd:workspace,encoding:'utf8'}).trim()}={}){
  const run=id(env.GITHUB_RUN_ID),attempt=number(env.GITHUB_RUN_ATTEMPT),repository=safe(env.GITHUB_REPOSITORY);
  let seq=0,failed=0,sourceHash=null,checkout=null,closed=false;const session=randomUUID();
  const job=typeof env.GITHUB_JOB==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(env.GITHUB_JOB)?env.GITHUB_JOB:null;
  try{if(sourceUrl)sourceHash=digest(readFile(fileURLToPath(sourceUrl)));}catch{}
  try{if(!write&&workspace&&run&&attempt&&repository&&job&&sourceHash)checkout=sha(readCheckout());}catch{}
  const active=Boolean(write||workspace&&path.isAbsolute(workspace)&&run&&attempt&&repository&&job&&sourceHash);
  const local=()=>path.join(workspace,NATURAL_DIRECTORY,[run,attempt,safe(env.GITHUB_JOB)??'job'].join('-'));
  const persist=stateWrite??(write?()=>{}:state=>{mkdir(local(),{recursive:true});fs.writeFileSync(path.join(local(),session+'.state.json'),JSON.stringify(state)+'\n');});
  const state=completion=>({schema:'clued.natural-producer-session/1',producer_session_id:session,repository,run_id:run,attempt,
    logical_job_key:safe(env.GITHUB_JOB),source_path:sourcePath??null,source_sha256:sourceHash,executed_checkout_sha:checkout,
    recorded_events:seq,known_recording_failures:failed,closed,completion,source_authenticated:false,population_completeness:'NOT_ATTESTED'});
  const save=completion=>{if(active)try{persist(state(completion));}catch{failed++;}};
  save('started');
  const sink=write??(event=>{
    mkdir(local(),{recursive:true});appendFile(path.join(local(),session+'.jsonl'),JSON.stringify(event)+'\n');
  });
  return {get recorded(){return seq;},get failures(){return failed;},newId:randomUUID,
    finish(completion='returned'){closed=true;save(['returned','exception'].includes(completion)?completion:'exception');return state(completion);},
    record(kind,data){
      if(!active)return {status:'NOT_RECORDED',reason_code:'NATURAL_RUNTIME_IDENTITY_UNAVAILABLE'};
      if(closed){failed++;save('record_after_close');return {status:'NOT_RECORDED',reason_code:'NATURAL_SESSION_ALREADY_CLOSED'};}
      try{const event={schema:NATURAL_EVENT_SCHEMA,record_id:randomUUID(),sequence:seq+1,kind,event_at:now(),
        producer_session_id:session,known_recording_failures:failed,
        time_semantics:'producer_observation_time; not Native run/job start or completion',
        repository,run_id:run,attempt,logical_job_key:safe(env.GITHUB_JOB),
        source:{path:sourcePath??null,sha256:sourceHash,checkout_sha_claimed:sha(env.GITHUB_SHA),
          executed_checkout_sha:checkout,
          checkout_semantics:'event_sha_claim_only; collector must verify actual executed checkout/blob/role'},
        clock_pins:null,payload:formatNaturalPayload(kind,data),
        source_authenticated:false,official_metric:false,population_completeness:'NOT_ATTESTED',t0:null};
        sink(event);seq++;save('started');return {status:'LOCAL_EVENT_RECORDED',record_id:event.record_id};
      }catch{failed++;save('recording_failure');return {status:'NOT_RECORDED',reason_code:'NATURAL_EVENT_RECORDING_FAILED'};}
    }};
}

export async function observeMutation(request,recorder,{operation_id,action}){
  try {const response=await request();recorder.record('operation_response',{operation_id,action,response});return response;}
  catch(error){recorder.record('operation_failure',{operation_id,action});throw error;}
}

// The original evaluate body runs unchanged through this wrapper. A finally
// record captures early returns/exceptions without authorizing any decision.
export async function observeEvaluation(core,args,recorder){
  const evaluation_id=uuid(args.observation_evaluation_id)??recorder.newId();let outcome=null;
  recorder.record('admission_input',{evaluation_id,pr:args.event?.pull_request,entry:args.observation_entry??'required'});
  try{outcome=await core({...args,observation_recorder:recorder,evaluation_id});return outcome;}
  finally{recorder.record('admission_final',{evaluation_id,entry:args.observation_entry??'required',completion:outcome===null?'exception':'returned',
    outcome:outcome??{verdict:'ERROR',admitted:false,reasons:['evaluation_not_completed']}});
    if(args.observation_close_owned)recorder.finish(outcome===null?'exception':'returned');}
}

// Concrete bridge to the reviewed four-source envelope grammar. The collector
// supplies actual immutable Native identity, independent source selection and
// any real head-admission receipt; the event alone cannot invent those fields.
export function admissionEnvelopeInput({finalEvent,inputEvent,claimEvent,appEvent,selectionEvent,nativeIdentity,appNativeObservation,sourceCheckoutSha,claimReceiptId=null,observedAt=null}={}){
  const missing=[];const f=finalEvent?.payload,c=claimEvent?.payload,a=appEvent?.payload;
  const legacyExternal=`pr:${nativeIdentity?.pr_number}:run:${id(nativeIdentity?.run_id)}`;
  const publication=a?.publication_observation??null;
  const expectedExternal=publication?`${legacyExternal}:publication:${publication.publication_id}`:legacyExternal;
  if(publication&&(!currentPublication(publication)||a.external_id!==expectedExternal))missing.push('ACTUAL_PUBLICATION_CURRENT_EPOCH_UNBOUND');
  if(finalEvent?.schema!==NATURAL_EVENT_SCHEMA||finalEvent.kind!=='admission_final')missing.push('NATURAL_FINAL_EVENT_MISSING');
  if(!nativeIdentity?.native_pr||!nativeIdentity?.native_run)missing.push('ACTUAL_NATIVE_IDENTITY_MISSING');
  if(!sha(sourceCheckoutSha))missing.push('ACTUAL_EXECUTED_CHECKOUT_MISSING');
  if(sha(sourceCheckoutSha)&&finalEvent?.source?.executed_checkout_sha!==sourceCheckoutSha)missing.push('RECORDED_EXECUTED_CHECKOUT_MISMATCH');
  if(!['required','reverify','rejudge'].includes(f?.entry))missing.push('ENTRY_NOT_IN_PER_PR_GRAMMAR');
  if(f?.final_decision_observed&&(!nativeIdentity?.native_job||!nativeIdentity.native_run.run_started_at))missing.push('FINAL_NATIVE_EXECUTION_MISSING');
  if(f?.final_decision_observed===false&&(!inputEvent||inputEvent.kind!=='admission_input'||inputEvent.payload.evaluation_id!==f.evaluation_id||
    inputEvent.payload.pr_number!==nativeIdentity?.pr_number||inputEvent.payload.head_sha!==nativeIdentity?.head_sha||
    ['repository','run_id','attempt'].some(k=>inputEvent[k]!==finalEvent[k])))missing.push('NO_FINAL_SUBJECT_BINDING_MISSING');
  if(f?.entry==='reverify'&&f.final_decision_observed&&(!selectionEvent||selectionEvent.payload.evaluation_id!==f.evaluation_id||
    typeof selectionEvent.payload.admission_green!=='boolean'||typeof selectionEvent.payload.slot_green!=='boolean'||
    !selectionEvent.payload.admission_green&&!selectionEvent.payload.slot_green))missing.push('ACTUAL_REVERIFY_SELECTION_MISSING');
  if(f?.entry==='required'&&f?.admitted&&(!a?.check_run_id||String(appNativeObservation?.id)!==String(a.check_run_id)||
    appNativeObservation?.head_sha!==f.head_sha||appNativeObservation?.app?.id!==5164952))missing.push('ACTUAL_APP_CHECK_OBSERVATION_MISSING');
  if(a?.check_run_id&&(!appNativeObservation||String(appNativeObservation.id)!==a.check_run_id||appNativeObservation.app?.id!==5164952||
    appNativeObservation.head_sha!==a.head_sha||appNativeObservation.name!==a.app_check_name||appNativeObservation.status!=='completed'||
    appNativeObservation.conclusion!==a.conclusion||appNativeObservation.external_id!==expectedExternal))
    missing.push('ACTUAL_APP_EVENT_BINDING_INVALID');
  if(missing.length)return {status:'PARTIAL',missing,packet:null,source_authenticated:false,official_metric:false,t0:null};
  // Exact DTO projection; a raw response or credential is never copied.
  const p=nativeIdentity.native_pr,r=nativeIdentity.native_run,j=nativeIdentity.native_job;
  const i={repository:nativeIdentity.repository,pr_number:number(nativeIdentity.pr_number),head_sha:sha(nativeIdentity.head_sha),
    run_id:id(nativeIdentity.run_id),run_attempt:number(nativeIdentity.run_attempt),job_id:j?id(j.id):null,
    entry:f.entry,dispatch_reason:f.entry==='required'?null:f.entry==='rejudge'?'state_change':'scheduled',source_checkout_sha:sourceCheckoutSha,
    native_pr:{number:number(p.number),head_sha:sha(p.head_sha),base_repository:safe(p.base_repository),base_ref:safe(p.base_ref),
      default_branch:safe(p.default_branch),state:['open','closed'].includes(p.state)?p.state:null,draft:p.draft===true},
    native_run:{id:id(r.id),run_attempt:number(r.run_attempt),event:safe(r.event),path:safe(r.path),head_sha:sha(r.head_sha),head_branch:safe(r.head_branch),
      pull_requests:Array.isArray(r.pull_requests)?r.pull_requests.map(x=>number(typeof x==='object'?x.number:x)).filter(x=>x!==null):[],
      status:safe(r.status),conclusion:safe(r.conclusion),run_started_at:timestamp(r.run_started_at)},
    native_job:j?{id:id(j.id),run_id:id(j.run_id),run_attempt:number(j.run_attempt),name:safe(j.name),status:safe(j.status),conclusion:safe(j.conclusion)}:null};
  if(i.repository!==finalEvent.repository||String(i.run_id)!==finalEvent.run_id||i.run_attempt!==finalEvent.attempt||
    f.head_sha!==null&&i.head_sha!==f.head_sha||f.pr_ref!==null&&f.pr_ref!==`${i.repository}#${i.pr_number}`||
    claimEvent&&(c.evaluation_id!==f.evaluation_id||claimEvent.repository!==i.repository||claimEvent.run_id!==i.run_id||claimEvent.attempt!==i.run_attempt)||
    selectionEvent&&(selectionEvent.repository!==i.repository||selectionEvent.run_id!==i.run_id||selectionEvent.attempt!==i.run_attempt||selectionEvent.payload.head_sha!==i.head_sha)||
    appEvent&&(appEvent.repository!==i.repository||appEvent.run_id!==i.run_id||appEvent.attempt!==i.run_attempt||a.head_sha!==i.head_sha||a.pr_number!==i.pr_number))
    return {status:'PARTIAL',missing:['NATURAL_NATIVE_IDENTITY_MISMATCH'],packet:null,source_authenticated:false,official_metric:false,t0:null};
  const observed=timestamp(observedAt)??finalEvent.event_at;
  const claim_id=f.claim_id;
  const receipt=uuid(claimReceiptId)??uuid(c?.head_admitted_receipt_id);
  const disposition=['ERROR','PR_NOT_OPEN'].includes(f.verdict)&&claim_id===null?'not_evaluated':claim_id===null?'missing':c?.response_kind==='verdict'&&c?.verdict==='ADMITTED'?'valid':
    c?.response_kind==='verdict'&&c?.verdict==='REJECTED'?'rejected':'unverified';
  const rpc=['valid','rejected'].includes(disposition);
  const claim={disposition,claim_id,verified_at:rpc?(c?.verified_at??null):null,rpc_verdict:rpc?c.verdict:null,
    reasons:rpc?(c?.reason_codes?.map(readerReason)??[]):[],head_admitted_receipt_id:disposition==='valid'?receipt:null};
  if(claimEvent&&(c.claim_id!==claim_id||c.head_sha!==i.head_sha)||disposition==='valid'&&!timestamp(c.verified_at))
    return {status:'PARTIAL',missing:['CLAIM_NATIVE_EVENT_BINDING_INVALID'],packet:null,source_authenticated:false,official_metric:false,t0:null};
  const app=a?.check_run_id&&appNativeObservation?{id:a.check_run_id,app_id:number(appNativeObservation.app?.id),name:a.app_check_name,
    head_sha:a.head_sha,pr_number:a.pr_number,run_id:i.run_id,run_attempt:i.run_attempt,external_id:appNativeObservation.external_id,
    status:'completed',conclusion:a.conclusion,...(publication?{publication_observation:publication}:{})}:null;
  const packet={schema:'clued.final-admission-observation/1',identity:i,timing:{decision_at:f.final_decision_observed?finalEvent.event_at:null,observed_at:observed},
    final_decision_observed:f.final_decision_observed,
    outcome:f.final_decision_observed?{mode:f.mode,event:'pull_request_target',enforced:f.enforced,
      head_sha:f.head_sha,pr_ref:f.pr_ref,claim_id,admitted:f.admitted,verdict:f.verdict,reasons:f.reason_codes.map(readerReason),
      admission_mode:f.admission_mode,...(f.owner_review_kind?{owner_review:{kind:f.owner_review_kind}}:{})}:null,
    claim_observation:f.final_decision_observed?claim:null,admit_step_outcome:f.entry==='required'?(a?.admit_step_outcome??null):null,
    selection_observation:f.entry==='reverify'&&selectionEvent?{admission_green:selectionEvent.payload.admission_green,slot_green:selectionEvent.payload.slot_green}:null,
    app_observation:f.final_decision_observed?app:null};
  return {status:'ENVELOPE_INPUT_CANDIDATE',packet,packet_raw:JSON.stringify(packet),source_authenticated:false,official_metric:false,t0:null,
    required_before_formal_use:'actual Native App/attempt evidence, executed source blobs/role, complete selection journal and all population transcripts'};
}

const SOURCE_PATHS=Object.freeze({admission:'scripts/ci/clued-work-admission.mjs',slot:'scripts/ci/clued-merge-slot-ci.mjs',executor:'scripts/ci/clued-merge-executor.mjs'});
const STREAM_LIMIT=32*1024*1024;
const artifactIdentity=env=>{
  const repository=safe(env.GITHUB_REPOSITORY),run_id=id(env.GITHUB_RUN_ID),attempt=number(env.GITHUB_RUN_ATTEMPT),job=env.GITHUB_JOB;
  if(!repository||!run_id||!attempt||typeof job!=='string'||! /^[A-Za-z0-9_-]{1,120}$/.test(job))throw Error('NATURAL_ARTIFACT_IDENTITY_INVALID');
  return {repository,run_id,attempt,logical_job_key:job};
};
const naturalLocation=(workspace,i)=>path.join(workspace,NATURAL_DIRECTORY,[i.run_id,i.attempt,i.logical_job_key].join('-'));

// Closes this job's local packet, not a Native/manual population. This step has
// no credentials or network call, and runs after the original source commands.
function exportNaturalArtifactCore({env=process.env,workspace=env.GITHUB_WORKSPACE,expected=[],now=()=>new Date().toISOString()}={}){
  const i=artifactIdentity(env);if(!workspace||!path.isAbsolute(workspace)||expected.some(x=>!SOURCE_PATHS[x]))throw Error('NATURAL_EXPORT_INPUT_INVALID');
  const dir=naturalLocation(workspace,i),sessions=[],events=[],files=[],gaps=[];let bytes=0;
  if(!fs.existsSync(dir))gaps.push('PRODUCER_DIRECTORY_MISSING');
  else for(const name of fs.readdirSync(dir).sort()){
    if(!/^[a-f0-9-]{36}\.(state\.json|jsonl)$/.test(name))throw Error('NATURAL_UNEXPECTED_LOCAL_FILE');
    const filename=path.join(dir,name),info=fs.lstatSync(filename);
    if(!info.isFile()||info.isSymbolicLink()||(bytes+=info.size)>STREAM_LIMIT)throw Error('NATURAL_STREAM_LIMIT_OR_FILE_INVALID');
    const raw=fs.readFileSync(filename);files.push({name,bytes:raw.length,sha256:digest(raw)});
    if(name.endsWith('.state.json'))sessions.push(JSON.parse(raw.toString()));
    else {if(raw.length&&!raw.toString().endsWith('\n'))throw Error('NATURAL_TRUNCATED_LINE');
      for(const line of raw.toString().split('\n').filter(Boolean)){if(Buffer.byteLength(line)>64*1024||events.length>=100000)throw Error('NATURAL_EVENT_LIMIT');events.push(JSON.parse(line));}}
  }
  const owners=new Map();for(const s of sessions){
    if(s.schema!=='clued.natural-producer-session/1'||!uuid(s.producer_session_id)||owners.has(s.producer_session_id)||
      s.repository!==i.repository||s.run_id!==i.run_id||s.attempt!==i.attempt||s.logical_job_key!==i.logical_job_key)throw Error('NATURAL_SESSION_IDENTITY_INVALID');
    owners.set(s.producer_session_id,s);
  }
  const grouped=new Map();for(const e of events){
    if(e.schema!==NATURAL_EVENT_SCHEMA||e.repository!==i.repository||e.run_id!==i.run_id||e.attempt!==i.attempt||e.logical_job_key!==i.logical_job_key||
      !owners.has(e.producer_session_id)||!uuid(e.record_id))throw Error('NATURAL_EVENT_IDENTITY_INVALID');
    const rows=grouped.get(e.producer_session_id)??[];rows.push(e);grouped.set(e.producer_session_id,rows);
  }
  for(const [sid,s] of owners){const rows=grouped.get(sid)??[];
    rows.sort((a,b)=>a.sequence-b.sequence);
    if(rows.length!==s.recorded_events||rows.some((e,n)=>e.sequence!==n+1||e.source.path!==s.source_path||e.source.sha256!==s.source_sha256||
      e.source.executed_checkout_sha!==s.executed_checkout_sha))throw Error('NATURAL_LOCAL_SEQUENCE_OR_SOURCE_INVALID');
    if(s.closed!==true)gaps.push('PRODUCER_SESSION_NOT_CLOSED');
    if(s.known_recording_failures!==0||rows.some(e=>e.known_recording_failures!==0))gaps.push('KNOWN_PRODUCER_RECORDING_FAILURE');
    if(!sha(s.executed_checkout_sha)||! /^[a-f0-9]{64}$/.test(s.source_sha256??''))gaps.push('EXECUTED_SOURCE_WITNESS_MISSING');
  }
  for(const key of expected)if(!sessions.some(s=>s.source_path===SOURCE_PATHS[key]))gaps.push('EXPECTED_PRODUCER_MISSING:'+key);
  // The initial list and normal close do not erase per-candidate unknown reads.
  if(events.some(e=>e.kind==='batch_candidate'&&e.payload.selection_state==='unknown'))gaps.push('BATCH_SELECTION_UNKNOWN');
  if(events.some(e=>e.kind==='batch_initial'&&e.payload.projection_truncated))gaps.push('BATCH_INITIAL_PROJECTION_TRUNCATED');
  const packet={schema:NATURAL_ARTIFACT_SCHEMA,identity:i,exported_at:now(),files,sessions,events,
    local_stream:{status:gaps.length?'GAP':'CLOSED_LOCAL_STREAM',known_gaps:[...new Set(gaps)],expected_source_paths:expected.map(x=>SOURCE_PATHS[x])},
    provider_population:{status:'NOT_ATTESTED',required_witnesses:['complete immutable Native run/attempt/job and reference closure',
      'accepted executed Source/role and artifact origin','all automatic/manual/Owner/holder operation origins',
      'actual operation Native before/after confirmation','explicit original-round termination cause; UNKNOWN cancel cause is legal']},
    source_authenticated:false,official_metric:false,t0:null};
  const out=path.join(workspace,NATURAL_DIRECTORY,'sealed',[i.run_id,i.attempt,i.logical_job_key].join('-'));
  fs.mkdirSync(out,{recursive:true});const filename=path.join(out,'natural-packet.json');fs.writeFileSync(filename,JSON.stringify(packet)+'\n');
  return {status:'ARTIFACT_INPUT_CANDIDATE',filename,sha256:digest(fs.readFileSync(filename)),local_stream:packet.local_stream,
    source_authenticated:false,official_metric:false,t0:null};
}

export function exportNaturalArtifact(args={}){
  try{return exportNaturalArtifactCore(args);}
  catch{
    // An incomplete/corrupt local stream still exports a closed gap witness.
    // Null events preserve unknown population; this is never an empty zero.
    const env=args.env??process.env,workspace=args.workspace??env.GITHUB_WORKSPACE,i=artifactIdentity(env);
    if(!workspace||!path.isAbsolute(workspace))throw Error('NATURAL_EXPORT_WORKSPACE_INVALID');
    const out=path.join(workspace,NATURAL_DIRECTORY,'sealed',[i.run_id,i.attempt,i.logical_job_key].join('-'));
    fs.mkdirSync(out,{recursive:true});const filename=path.join(out,'natural-packet.json');
    const packet={schema:NATURAL_ARTIFACT_SCHEMA,identity:i,events:null,sessions:null,files:null,
      local_stream:{status:'GAP',known_gaps:['LOCAL_STREAM_INTEGRITY_OR_EXPORT_FAILURE']},
      population_count:null,source_authenticated:false,official_metric:false,t0:null};
    fs.writeFileSync(filename,JSON.stringify(packet)+'\n');
    return {status:'ARTIFACT_GAP_WITNESS',filename,sha256:digest(fs.readFileSync(filename)),local_stream:packet.local_stream,
      source_authenticated:false,official_metric:false,t0:null};
  }
}

// Collector data stage after ZIP/digest extraction. Authentication belongs to
// the existing Native accepted-source/artifact verifier, never to these flags.
export function readNaturalArtifact(raw,expectedIdentity){
  try{
    if(typeof raw!=='string'||Buffer.byteLength(raw)>STREAM_LIMIT)throw Error();const p=JSON.parse(raw);
    if(p.schema!==NATURAL_ARTIFACT_SCHEMA||!expectedIdentity||['repository','run_id','attempt','logical_job_key'].some(k=>p.identity?.[k]!==expectedIdentity[k])||!p.local_stream)throw Error();
    if(p.events===null&&p.local_stream.status==='GAP')return {status:'PARTIAL',events:null,local_stream:p.local_stream,
      population_count:null,source_authenticated:false,official_metric:false,t0:null};
    if(!Array.isArray(p.events)||!Array.isArray(p.sessions)||!Array.isArray(p.files))throw Error();
    const ids=new Set();for(const e of p.events){if(e.schema!==NATURAL_EVENT_SCHEMA||ids.has(e.record_id)||!uuid(e.record_id)||
      ['repository','run_id','attempt','logical_job_key'].some(k=>e[k]!==p.identity[k]))throw Error();ids.add(e.record_id);}
    return {status:'NATURAL_ARTIFACT_DATA_CANDIDATE',events:p.events,sessions:p.sessions,local_stream:p.local_stream,
      population_qualification:'NOT_ESTABLISHED',source_authenticated:false,official_metric:false,t0:null,
      authentication_required:NATURAL_INTAKE_PROTOCOL.authentication};
  }catch{return {status:'PARTIAL',reason_code:'NATURAL_ARTIFACT_DATA_INVALID',events:null,source_authenticated:false,official_metric:false,t0:null};}
}

export function operationEnvelopeInput({preEvent,requestEvent,responseEvent,nativePost,collectedAt,scope:targetScope,sourceRef}={}){
  const partial=reason=>({status:'PARTIAL',missing:[reason],before_raw:null,response_raw:null,after_raw:null,source_authenticated:false,official_metric:false,t0:null});
  const pre=preEvent?.payload,q=requestEvent?.payload,r=responseEvent?.payload;
  if(preEvent?.kind!=='operation_pre'||requestEvent?.kind!=='operation_request'||q.action!=='update_branch'||
    q.pre_observation_id!==preEvent.record_id||pre.operation_id!==q.operation_id||pre.pr_number!==q.pr_number||pre.head_sha!==q.expected_head_sha||pre.main_sha!==q.main_sha||
    !timestamp(collectedAt)||!targetScope?.project_id||!targetScope?.queue_ref||!/^[a-f0-9]{64}$/.test(sourceRef??''))return partial('ACTUAL_BOUND_OPERATION_PRE_REQUEST_MISSING');
  if(responseEvent&&(responseEvent.kind!=='operation_response'||r.operation_id!==q.operation_id||r.action!==q.action))return partial('OPERATION_RESPONSE_MISMATCH');
  for(const e of [preEvent,responseEvent].filter(Boolean))if(['repository','run_id','attempt','logical_job_key','producer_session_id'].some(k=>e[k]!==requestEvent[k]))return partial('OPERATION_PRODUCER_IDENTITY_MISMATCH');
  const before={scope:targetScope,operation_id:q.operation_id,pr_number:q.pr_number,origin:q.origin===undefined?'executor':q.origin,request_at:requestEvent.event_at,request_collected_at:collectedAt,
    reason_code:q.reason_code==='MAIN_MOVED_REQUIRES_RERUN'?'MAIN_MOVED_REQUIRES_RERUN':'GENERAL_UPDATE',request_receipt_id:requestEvent.record_id,claim_id:q.claim_id,fence:q.fence,source_ref:sourceRef,
    native_pre:{number:pre.pr_number,head_sha:pre.head_sha,main_sha:pre.main_sha,event_at:preEvent.event_at,collected_at:preEvent.event_at,observation_id:preEvent.record_id}};
  const response=responseEvent?{operation_id:q.operation_id,request_receipt_id:requestEvent.record_id,status:r.status,event_at:responseEvent.event_at,
    collected_at:collectedAt,response_receipt_id:responseEvent.record_id}:null;
  // Native after is independent provider data from the collector's existing
  // budget. Never substitute later-head/DAG-only inference or a 202 response.
  const after=nativePost?{operation_id:q.operation_id,number:number(nativePost.number),head_sha:sha(nativePost.head_sha),main_sha:sha(nativePost.main_sha),
    parents:Array.isArray(nativePost.parents)?nativePost.parents.map(sha):null,event_at:timestamp(nativePost.event_at),collected_at:timestamp(nativePost.collected_at),
    observation_id:safe(nativePost.observation_id)}:null;
  return {status:'OPERATION_INPUT_CANDIDATE',before_raw:JSON.stringify(before),response_raw:response?JSON.stringify(response):null,after_raw:after?JSON.stringify(after):null,
    update_confirmed:false,confirmation:'pure reader must bind the request/response and actual Native after',source_authenticated:false,official_metric:false,t0:null};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.argv[2]!=='--export')throw Error('NATURAL_EXPORT_MODE_REQUIRED');
  console.log(JSON.stringify(exportNaturalArtifact({expected:process.argv.slice(3)})));
}
