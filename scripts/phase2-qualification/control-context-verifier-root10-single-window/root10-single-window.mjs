import fs from 'node:fs';
import crypto from 'node:crypto';

const need=(value,message)=>{if(!value)throw Error(message);};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const id=(value,prefix)=>typeof value==='string'&&new RegExp('^'+prefix+'[a-f0-9]{32}$').test(value);
const utc=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value)&&Number.isFinite(Date.parse(value));
const safe=value=>{if(typeof value==='number')need(Number.isSafeInteger(value),'UNSAFE_NUMBER');else if(value&&typeof value==='object')for(const item of Object.values(value))safe(item);};
const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
// Same canonicalization used by the published root protocol: sorted JSON, UTF-8, one LF.
export const canonicalDigest=value=>crypto.createHash('sha256').update(JSON.stringify(ordered(value))+'\n','utf8').digest('hex');
export const sha=value=>crypto.createHash('sha256').update(value).digest('hex');

const ref=value=>exact(value,['uri','sha256'])&&typeof value.uri==='string'&&/^https:\/\/api\.github\.com\/repos\/tdoljyj\/cross-memory-system\/git\/blobs\/[a-f0-9]{40}$/.test(value.uri)&&hex(value.sha256);
const contractKeys=['schema_version','ready','root_id','predecessor_generation','generation_id','generation_ordinal','window','baseline','postbaseline','caps','fixed_digests','accepted_suite','issuer_qualification_refs','reviewer_delegation','source_closure','invariants'];
export function validateRoot10ControllerContract(value){
 safe(value);need(exact(value,contractKeys),'EXACT_ROOT10_CONTRACT_FIELDS');
 need(value.schema_version==='root10-single-window-controller-contract/1'&&value.ready===true,'ROOT10_CONTRACT_NOT_FINAL');
 need(id(value.root_id,'ctr_')&&id(value.predecessor_generation,'ctrgen_')&&id(value.generation_id,'ctrgen_')&&value.predecessor_generation!==value.generation_id&&value.generation_ordinal===10,'EXACT_ROOT10_IDENTITY');
 need(exact(value.window,['not_before','expires_at'])&&utc(value.window.not_before)&&utc(value.window.expires_at)&&Date.parse(value.window.not_before)<Date.parse(value.window.expires_at),'EXACT_ROOT10_WINDOW');
 const baseline=value.baseline;
 need(exact(baseline,['root_sequence','root_events_sha256','execution_sequence','historical_preimage110','closure','charged_seconds','charged_evidence_bytes','series_start_sequence','allocation_count','historical_budget_count','series_forward_count','active_ga_id','pending_budget_sequence']),'EXACT_ROOT10_BASELINE_FIELDS');
 need(baseline.root_sequence===9&&hex(baseline.root_events_sha256)&&baseline.execution_sequence===112,'FINAL_TERMINATED_ROOT9_BASELINE_REQUIRED');
 const pre=baseline.historical_preimage110,closure=baseline.closure;
 need(exact(pre,['execution_events_sha256','other_attempts_sha256','attempt_ids'])&&hex(pre.execution_events_sha256)&&hex(pre.other_attempts_sha256)&&Array.isArray(pre.attempt_ids)&&pre.attempt_ids.length===17&&pre.attempt_ids.every(x=>id(x,'ga_'))&&new Set(pre.attempt_ids).size===17,'EXACT_ROOT9_PREIMAGE110_REQUIRED');
 need(exact(closure,['ga_id','ga_sha256','budget_sequence','decision_sequence','decision_idempotency_key','signing_sequence','signing_idempotency_key','termination_mode','decision_sha256','evidence_index_sha256','observation_sha256','receipt_id','receipt_sha256'])&&id(closure.ga_id,'ga_')&&[closure.ga_sha256,closure.decision_sha256,closure.evidence_index_sha256,closure.observation_sha256,closure.receipt_sha256].every(hex)&&closure.budget_sequence===102&&closure.decision_sequence===111&&closure.signing_sequence===112&&closure.decision_idempotency_key==='root9_ga6_single_window_close_decision_111'&&closure.signing_idempotency_key==='root9_ga6_single_window_close_signing_112'&&closure.termination_mode==='EXPIRED_PREDISPATCH_NOT_STARTED_BLOCKED_ROOT9_SUCCESSOR_GA6'&&closure.receipt_id==='grr_root9_exact_pair_ga6_blocked_20260915'&&pre.attempt_ids.includes(closure.ga_id),'EXACT_ROOT9_GA6_CLOSURE_RULE');
 need(baseline.charged_seconds===11106&&baseline.charged_evidence_bytes===2470030259&&baseline.series_start_sequence===44&&baseline.allocation_count===10&&baseline.historical_budget_count===16&&baseline.series_forward_count===17&&baseline.active_ga_id===null&&baseline.pending_budget_sequence===null,'TERMINATED_ROOT9_NONREFUNDING_BASELINE');
 const post=value.postbaseline;
 need(exact(post,['budget_sequence','budget_idempotency_key','seconds','evidence_bytes','max_budgets','max_ga'])&&Number.isSafeInteger(post.budget_sequence)&&post.budget_sequence>baseline.execution_sequence&&post.budget_sequence!==102&&post.budget_idempotency_key==='root10_single_window_budget_20260915'&&post.seconds===600&&post.evidence_bytes===134217728&&post.max_budgets===1&&post.max_ga===1,'EXACT_SINGLE_POSTBASELINE_BUDGET');
 need(exact(value.caps,['allocations','seconds','evidence_bytes','forwards','original_input_bytes','publication_bytes'])&&value.caps.allocations===11&&value.caps.seconds===11706&&value.caps.evidence_bytes===2604247987&&value.caps.forwards===19&&value.caps.original_input_bytes===4000000&&value.caps.publication_bytes===8388608,'EXACT_AUTHORIZED_ROOT10_CAPS');
 need(exact(value.fixed_digests,['gate_sha256','profile_sha256','scope_sha256'])&&Object.values(value.fixed_digests).every(hex),'EXACT_UNCHANGED_GATE_PROFILE_SCOPE');
 const suite=value.accepted_suite,formal=Array.from({length:17},(_,i)=>`PQUAL-${String(i+1).padStart(2,'0')}`).concat(['PQUAL-19','PQUAL-20']);
 need(exact(suite,['uri','sha256','original_executor_sha256','formal_test_ids','pqual18_disposition'])&&ref({uri:suite.uri,sha256:suite.sha256})&&hex(suite.original_executor_sha256)&&JSON.stringify(suite.formal_test_ids)===JSON.stringify(formal)&&suite.pqual18_disposition==='NEGATIVE_ADMISSION_CHECK_NOT_FORMAL_RESULT','EXACT_19_PLUS_NEGATIVE_18_CONTRACT');
 need(exact(value.issuer_qualification_refs,['STATUS','GATE_AUTHORIZATION','GATE_RESULT'])&&Object.values(value.issuer_qualification_refs).every(ref),'ROOT10_ISSUER_QUALIFICATIONS_NOT_FINAL');
 need(exact(value.reviewer_delegation,['ref','independent_reviewer'])&&ref(value.reviewer_delegation.ref)&&value.reviewer_delegation.independent_reviewer==='/root/root9_recovery_review','EXACT_ROOT10_REVIEWER_DELEGATION');
 need(Array.isArray(value.source_closure)&&value.source_closure.length===3&&new Set(value.source_closure.map(x=>x.path)).size===3&&value.source_closure.every(x=>exact(x,['path','sha256'])&&typeof x.path==='string'&&!x.path.includes('..')&&hex(x.sha256)),'EXACT_HISTORICAL_COMPONENT_SOURCE_CLOSURE');
 need(exact(value.invariants,['automatic_retry','successor_ga','repair_refs','refund','reset_counters','budget_reassignment','root9_seq102_historical_only'])&&value.invariants.automatic_retry===false&&value.invariants.successor_ga===false&&value.invariants.repair_refs===0&&value.invariants.refund===false&&value.invariants.reset_counters===false&&value.invariants.budget_reassignment===false&&value.invariants.root9_seq102_historical_only===true,'EXACT_NO_RETRY_SUCCESSOR_REPAIR_INVARIANTS');
 return Object.freeze(structuredClone(value));
}

export function loadRoot10ControllerContract(){
 const raw=fs.readFileSync(new URL('./Root10ControllerContract.candidate.json',import.meta.url),'utf8');
 need(JSON.stringify(JSON.parse(raw),null,2)+'\n'===raw,'EXACT_ROOT10_CONTRACT_BYTES');
 return {raw,sha256:sha(raw),value:validateRoot10ControllerContract(JSON.parse(raw))};
}

function hasForbiddenKey(value){
 if(!value||typeof value!=='object')return false;
 for(const [key,item] of Object.entries(value)){
  if(['required_repair_refs','repair_refs'].includes(key)&&!(Array.isArray(item)&&item.length===0))return true;
  if(['pending_budget_inheritance','successor_ga','automatic_retry','budget_reassignment','refund'].includes(key)&&item!==false&&item!==null)return true;
  if(hasForbiddenKey(item))return true;
 }
 return false;
}
function terminal(attempt){return ['PASS','FAIL','BLOCKED','STALE'].includes(attempt?.phase)&&typeof attempt.receipt_raw==='string'&&sha(attempt.receipt_raw)===attempt.receipt_sha256;}
export function checkRoot10SingleWindowSeries({contract:input,execution,operation,gaId,result=null}){
 const contract=validateRoot10ControllerContract(input);
 need(['CURRENT_DISPATCH','RESULT_RECONCILIATION'].includes(operation),'ROOT10_NO_NEXT_ALLOCATION_OR_FORWARD_ENTRY');
 if(operation==='RESULT_RECONCILIATION')need(['PASS','FAIL','BLOCKED','STALE'].includes(result),'ROOT10_EXACT_TERMINAL_RESULT');
 const root=execution?.root,current=execution?.current,binding=execution?.binding;
 need(root?.root_set_id===contract.root_id&&root.generation_id===contract.generation_id&&current?.root_id===contract.root_id&&binding?.root_id===contract.root_id,'EXACT_ROOT10_CURRENT_ROOT');
 need(Array.isArray(root.events)&&root.events.length===contract.baseline.root_sequence+1&&canonicalDigest(root.events.slice(0,contract.baseline.root_sequence))===contract.baseline.root_events_sha256,'EXACT_ROOT9_ROOT_EVENT_PREFIX');
 const registration=root.events.at(-1),body=registration?.request?.body;
 need(registration?.request?.kind==='GENERATION_REGISTERED'&&registration.request.generation_id===contract.generation_id&&registration.request.predecessor_generation_id===contract.predecessor_generation&&body?.control_trust_root_generation===contract.generation_id&&body.history?.prefix_sequence===contract.baseline.root_sequence&&body.history?.prefix_digest===contract.baseline.root_events_sha256&&body.not_before===contract.window.not_before&&body.expires_at===contract.window.expires_at,'EXACT_ROOT10_REGISTRATION');
 need(Array.isArray(execution.events)&&execution.events.length>=contract.baseline.execution_sequence&&canonicalDigest(execution.events.slice(0,110))===contract.baseline.historical_preimage110.execution_events_sha256,'EXACT_ROOT9_EXECUTION_PREIMAGE110');
 const closure=contract.baseline.closure,decisionEvent=execution.events[closure.decision_sequence-1],signingEvent=execution.events[closure.signing_sequence-1],decisionRequest=decisionEvent?.request,signingRequest=signingEvent?.request,decisionBody=decisionRequest?.body;
 need(decisionEvent?.root_id===contract.root_id&&decisionEvent.sequence===closure.decision_sequence&&decisionEvent.idempotency_key===closure.decision_idempotency_key&&exact(decisionRequest,['idempotency_key','expected_sequence','ga_id','operation','body'])&&decisionRequest.idempotency_key===closure.decision_idempotency_key&&decisionRequest.expected_sequence===110&&decisionRequest.ga_id===closure.ga_id&&decisionRequest.operation==='DECISION_RESERVED','EXACT_ROOT9_DECISION111_CLOSURE');
 need(exact(decisionBody,['result','termination_mode','decision_raw','decision_sha256','evidence_index_raw','evidence_index_sha256','not_started_evidence_raw','not_started_evidence_ref'])&&decisionBody.result==='BLOCKED'&&decisionBody.termination_mode===closure.termination_mode&&decisionBody.decision_sha256===closure.decision_sha256&&sha(decisionBody.decision_raw)===closure.decision_sha256&&decisionBody.evidence_index_sha256===closure.evidence_index_sha256&&sha(decisionBody.evidence_index_raw)===closure.evidence_index_sha256&&sha(decisionBody.not_started_evidence_raw)===closure.observation_sha256&&exact(decisionBody.not_started_evidence_ref,['uri','sha256'])&&decisionBody.not_started_evidence_ref.uri==='urn:clued:execution-evidence:'+contract.root_id+':'+closure.observation_sha256&&decisionBody.not_started_evidence_ref.sha256===closure.observation_sha256,'EXACT_ROOT9_DECISION111_BYTES');
 need(signingEvent?.root_id===contract.root_id&&signingEvent.sequence===closure.signing_sequence&&signingEvent.idempotency_key===closure.signing_idempotency_key&&exact(signingRequest,['idempotency_key','expected_sequence','ga_id','operation','body'])&&signingRequest.idempotency_key===closure.signing_idempotency_key&&signingRequest.expected_sequence===111&&signingRequest.ga_id===closure.ga_id&&signingRequest.operation==='SIGNING'&&exact(signingRequest.body,['decision_sha256'])&&signingRequest.body.decision_sha256===closure.decision_sha256,'EXACT_ROOT9_SIGNING112_CLOSURE');
 need(Array.isArray(execution.attempts),'ACTUAL_ATTEMPTS_REQUIRED');
 const baselineIds=new Set(contract.baseline.historical_preimage110.attempt_ids),baselineAttempts=execution.attempts.filter(a=>baselineIds.has(a.ga_id)),otherAttempts=baselineAttempts.filter(a=>a.ga_id!==closure.ga_id);
 need(baselineAttempts.length===baselineIds.size&&canonicalDigest([...otherAttempts].sort((a,b)=>a.ga_id.localeCompare(b.ga_id)))===contract.baseline.historical_preimage110.other_attempts_sha256,'EXACT_UNCHANGED_ROOT9_OTHER_ATTEMPTS');
 const closed=baselineAttempts.filter(a=>a.ga_id===closure.ga_id);need(closed.length===1&&closed[0].ga_sha256===closure.ga_sha256&&closed[0].budget_sequence===102&&closed[0].phase==='BLOCKED'&&closed[0].sequence===2&&closed[0].container_id===null&&closed[0].revoked===false&&closed[0].receipt_id===closure.receipt_id&&closed[0].receipt_sha256===closure.receipt_sha256&&sha(closed[0].receipt_raw)===closure.receipt_sha256&&closed[0].decision?.decision_sha256===closure.decision_sha256&&closed[0].decision?.evidence_index_sha256===closure.evidence_index_sha256,'EXACT_ROOT9_GA6_BLOCKED_CLOSURE');
 const seq102=baselineAttempts.filter(a=>a.budget_sequence===102);need(seq102.length===3&&seq102.every(terminal),'ROOT9_MULTI_GA_SEQ102_HISTORICAL_TERMINAL_ONLY');
 const newAttempts=execution.attempts.filter(a=>!baselineIds.has(a.ga_id));need(newAttempts.length===1&&newAttempts[0].ga_id===gaId&&newAttempts[0].budget_sequence===contract.postbaseline.budget_sequence,'EXACT_ONE_ROOT10_GA');
 const postEvents=execution.events.slice(contract.baseline.execution_sequence);need(postEvents.every((e,i)=>e.root_id===contract.root_id&&e.sequence===contract.baseline.execution_sequence+i+1),'CONTIGUOUS_POSTBASELINE_EVENTS');
 need(!hasForbiddenKey(postEvents)&&!hasForbiddenKey(newAttempts),'NO_ROOT10_REPAIR_SUCCESSOR_RETRY_OR_REFUND_FIELDS');
 const budgets=postEvents.filter(e=>e.request?.operation==='BUDGET_RESERVED');need(budgets.length===1&&budgets[0].sequence===contract.postbaseline.budget_sequence&&budgets[0].idempotency_key===contract.postbaseline.budget_idempotency_key,'EXACT_ONE_ROOT10_BUDGET_EVENT');
 const budgetBody=budgets[0].request.body;need(exact(budgetBody,['raw','sha256'])&&typeof budgetBody.raw==='string'&&sha(budgetBody.raw)===budgetBody.sha256&&JSON.stringify(JSON.parse(budgetBody.raw))+'\n'===budgetBody.raw,'EXACT_ROOT10_BUDGET_BYTES');
 const budget=JSON.parse(budgetBody.raw),budgetKeys=['controller_digest','credential_generation','environment','evidence_bytes','expires_at','idempotency_key','not_before','profile_digest','purpose','root_generation','runner_generation','scope_digest','seconds','session_generation'];
 const ga=newAttempts[0].ga;need(typeof newAttempts[0].ga_raw==='string'&&sha(newAttempts[0].ga_raw)===newAttempts[0].ga_sha256&&JSON.stringify(ga)+'\n'===newAttempts[0].ga_raw&&ga.gate_authorization_id===gaId&&ga.control_trust_root_generation===contract.generation_id&&ga.profile_digest===contract.fixed_digests.profile_sha256&&ga.scope_digest===contract.fixed_digests.scope_sha256,'EXACT_ROOT10_GA_BYTES_AND_SCOPE');
 need(exact(budget,budgetKeys)&&budget.idempotency_key===contract.postbaseline.budget_idempotency_key&&budget.seconds===600&&budget.evidence_bytes===134217728&&budget.environment==='ISOLATED_TEST'&&budget.purpose==='SKILL_COEXISTENCE_QUALIFICATION'&&budget.root_generation===contract.generation_id&&budget.not_before===contract.window.not_before&&budget.expires_at===contract.window.expires_at&&budget.controller_digest===ga.controller_digest&&budget.profile_digest===contract.fixed_digests.profile_sha256&&budget.scope_digest===contract.fixed_digests.scope_sha256&&budget.runner_generation===ga.runner_generation&&budget.credential_generation===ga.credential_generation&&budget.session_generation===ga.session_generation,'EXACT_ROOT10_BUDGET_SCOPE');
 const allBudgets=execution.events.filter(e=>e.request?.operation==='BUDGET_RESERVED'),seriesEvents=execution.events.filter(e=>e.sequence>contract.baseline.series_start_sequence),seriesBudgets=seriesEvents.filter(e=>e.request?.operation==='BUDGET_RESERVED'),seriesForwards=seriesEvents.filter(e=>e.request?.operation==='EXECUTION_BINDING_FORWARD_ACCEPTED');
 need(allBudgets.length===contract.baseline.historical_budget_count+1&&seriesBudgets.length===contract.caps.allocations&&seriesForwards.length===contract.baseline.series_forward_count&&seriesForwards.length<=contract.caps.forwards&&current.charged_seconds===contract.caps.seconds&&current.charged_evidence_bytes===contract.caps.evidence_bytes,'EXACT_CUMULATIVE_CAPS_AFTER_SINGLE_ROOT10_BUDGET');
 need(current.active_ga_id===gaId&&current.pending_budget_sequence===null,'EXACT_SOLE_ROOT10_ACTIVE_GA');
 return {state:'ROOT10_SINGLE_WINDOW_SERIES_CHECKED',baseline_attempts:baselineAttempts.length,postbaseline_budgets:1,postbaseline_ga:1,repairs:0,successors:0,automatic_retry:false,authority_effect:'NONE'};
}

export function checkRoot10RuntimeBinding({contract:input,contractSha256,runtime,binding}){
 const contract=validateRoot10ControllerContract(input),subject=runtime?.accepted_subject,root10=subject?.root10_single_window;
 need(runtime?.state==='ACCEPTED_EXACT_PREENTRY_CONTROLLER_RUNTIME'&&subject&&exact(root10,['contract_ref','issuer_qualification_refs','result_reviewer','executor_applicability']),'SIGNED_ROOT10_RUNTIME_BINDING_REQUIRED');
 need(ref(root10.contract_ref)&&root10.contract_ref.sha256===contractSha256&&exact(root10.issuer_qualification_refs,['STATUS','GATE_AUTHORIZATION','GATE_RESULT'])&&JSON.stringify(root10.issuer_qualification_refs)===JSON.stringify(contract.issuer_qualification_refs),'EXACT_SIGNED_ROOT10_CONTRACT_AND_ISSUERS');
 need(JSON.stringify(root10.result_reviewer.ref)===JSON.stringify(contract.reviewer_delegation.ref),'EXACT_SIGNED_ROOT10_REVIEWER_REF');
 need(binding?.gate_sha256===contract.fixed_digests.gate_sha256&&binding.profile_sha256===contract.fixed_digests.profile_sha256&&binding.scope_sha256===contract.fixed_digests.scope_sha256,'UNCHANGED_GATE_PROFILE_SCOPE_BINDING');
 for(const key of ['result_reviewer','executor_applicability'])need(root10[key]&&exact(root10[key],['ref','publication'])&&ref(root10[key].ref)&&exact(root10[key].publication,['commitSha','artifactPath'])&&/^[a-f0-9]{40}$/.test(root10[key].publication.commitSha)&&typeof root10[key].publication.artifactPath==='string'&&root10[key].publication.artifactPath.length>0,'FINAL_OWNER_PUBLISHED_'+key.toUpperCase()+'_REQUIRED');
 return root10;
}
