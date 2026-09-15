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

// A separately signed temporal amendment never changes the original GA or its
// signed clock. This parser is a rejection check, not proof of Owner authority.
export const root10TemporalIdentity=Object.freeze({
 ga_id:'ga_32daa5daf52c4deb8e893c25b08eff38',
 ga_sha256:'68afb1e6dc1367729cd6864b9ba9b5d846ab123ff5539d7a646f7fa1df988f78',
 controller_sha256:'d01bd55e02614c0d2b6f51f80fe5b56816aecc2f29e753344a4bcac56aaaf559',
 budget_sha256:'669d96057a44ed5e9c3eae9fed6ed8720aae8a2b48eef03761b8e9361433a462',
 amendment_sha256:'38eb6adca66de464fa88f4b7333649e9555d6a7d6b3fc23cd20ac18a0cfec4a6',
 activation_operation:'TEMPORAL_CONTINUATION_ACTIVATED',
 activation_key:'root10_same_ga_temporal_continuation_20260915',
 original_deadline:'2026-09-15T09:37:03.454Z',
 finalization_expires_at:'2026-09-16T03:00:00Z'
});
const temporalContexts=new WeakSet();
const temporalDescriptorKeys=['amendment_ref','publication','activation_operation','activation_idempotency_key','expected_activation_sequence','prior_ga_ref','budget_ref','effect_seconds','finalization_expires_at','predecessor_controller_sha256','continuation_controller_sha256','no_new_ga','no_new_budget','no_refund','no_automatic_retry','source_ref'];
const temporalBodyKeys=['activated_at','amendment_ref','amendment_sha256','automatic_retry','budget_raw_sha256','budget_refund','budget_sequence','effect_deadline','finalization_expires_at','new_binding','new_binding_sha256','new_budget','new_ga','old_binding','old_binding_sha256','prior_ga_sha256'];
const sameTemporal=(a,b)=>canonicalDigest(a)===canonicalDigest(b);
const temporalUtc=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)&&Number.isFinite(Date.parse(value));
// PostgreSQL jsonb::text uses UTF-8 key length, then byte order, with spaces.
export function postgresJsonbText(value){
 safe(value);
 if(Array.isArray(value))return '['+value.map(postgresJsonbText).join(', ')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort((a,b)=>Buffer.byteLength(a)-Buffer.byteLength(b)||Buffer.compare(Buffer.from(a),Buffer.from(b))).map(k=>JSON.stringify(k)+': '+postgresJsonbText(value[k])).join(', ')+'}';
 return JSON.stringify(value);
}
export function readRoot10TemporalContext({gaRaw,execution,descriptor}){
 if(descriptor===undefined||descriptor===null)return null;
 const fixed=root10TemporalIdentity;
 need(exact(descriptor,temporalDescriptorKeys),'EXACT_TEMPORAL_RUNTIME_DESCRIPTOR');
 need(ref(descriptor.amendment_ref)&&descriptor.amendment_ref.sha256===fixed.amendment_sha256&&descriptor.activation_operation===fixed.activation_operation&&descriptor.activation_idempotency_key===fixed.activation_key&&descriptor.expected_activation_sequence===118,'EXACT_TEMPORAL_ACTIVATION_CONTRACT');
 need(descriptor.prior_ga_ref?.ga_id===fixed.ga_id&&descriptor.prior_ga_ref.sha256===fixed.ga_sha256&&descriptor.budget_ref?.sha256===fixed.budget_sha256&&descriptor.effect_seconds===600&&descriptor.finalization_expires_at===fixed.finalization_expires_at,'EXACT_TEMPORAL_GA_BUDGET_WINDOW');
 need(descriptor.predecessor_controller_sha256===fixed.controller_sha256&&hex(descriptor.continuation_controller_sha256)&&descriptor.continuation_controller_sha256!==fixed.controller_sha256&&['no_new_ga','no_new_budget','no_refund','no_automatic_retry'].every(k=>descriptor[k]===true),'EXACT_TEMPORAL_NONEXPANDING_SUCCESSOR');
 need(typeof gaRaw==='string'&&sha(gaRaw)===fixed.ga_sha256,'EXACT_UNCHANGED_TEMPORAL_GA_BYTES');
 const ga=JSON.parse(gaRaw);
 need(ga.gate_authorization_id===fixed.ga_id&&ga.controller_digest===fixed.controller_sha256&&ga.deadline===fixed.original_deadline&&ga.expires_at===fixed.original_deadline,'ORIGINAL_GA_CLOCK_IMMUTABLE');
 const events=execution?.events;
 need(Array.isArray(events)&&events.length===execution.current.sequence&&events.every((e,i)=>e.sequence===i+1),'COMPLETE_TEMPORAL_EVENT_HISTORY');
 const matches=events.filter(e=>e.request?.operation===fixed.activation_operation);
 need(matches.length===1&&matches[0].sequence===118&&matches[0].idempotency_key===fixed.activation_key,'ONE_TEMPORAL_ACTIVATION_ONLY');
 const event=matches[0],request=event.request,body=request.body;
 need(exact(request,['operation','ga_id','expected_sequence','idempotency_key','body'])&&request.ga_id===fixed.ga_id&&request.expected_sequence===117&&request.idempotency_key===fixed.activation_key&&exact(body,temporalBodyKeys),'EXACT_TEMPORAL_ACTIVATION_EVENT');
 need(event.root_id===execution.current.root_id&&event.root_id===ga.authority_source_ref.uri.split(':').at(-1)&&sameTemporal(body.amendment_ref,descriptor.amendment_ref)&&body.amendment_sha256===descriptor.amendment_ref.sha256&&body.prior_ga_sha256===fixed.ga_sha256&&body.budget_sequence===117&&body.budget_raw_sha256===fixed.budget_sha256,'EXACT_TEMPORAL_EVENT_BINDINGS');
 need(['automatic_retry','budget_refund','new_budget','new_ga'].every(k=>body[k]===false),'NO_TEMPORAL_BUDGET_OR_GA_EFFECT');
 need(!events.slice(0,117).some(e=>e.request?.ga_id===fixed.ga_id),'TEMPORAL_ZERO_PRIOR_GA_EFFECT');
 const changed=['controller_sha256','qualification_sha256','runtime_acceptance_sha256'];
 need(body.old_binding?.controller_sha256===fixed.controller_sha256&&body.new_binding?.controller_sha256===descriptor.continuation_controller_sha256&&changed.every(k=>hex(body.new_binding[k]))&&sameTemporal({...body.new_binding,...Object.fromEntries(changed.map(k=>[k,body.old_binding[k]]))},body.old_binding),'ONLY_ACCEPTED_TEMPORAL_BINDING_COLUMNS_CHANGE');
 need(sha(postgresJsonbText(body.old_binding))===body.old_binding_sha256&&sha(postgresJsonbText(body.new_binding))===body.new_binding_sha256&&sameTemporal(body.new_binding,execution.binding),'EXACT_TEMPORAL_BINDING_PREIMAGE_AND_CURRENT');
 const attempt=execution.attempts?.filter(a=>a.ga_id===fixed.ga_id);
 need(attempt?.length===1&&attempt[0].ga_raw===gaRaw&&attempt[0].ga_sha256===fixed.ga_sha256&&attempt[0].budget_sequence===117&&Date.parse(attempt[0].expires_at)===Date.parse(fixed.original_deadline)&&attempt[0].revoked===false,'ORIGINAL_TEMPORAL_ATTEMPT_UNCHANGED');
 const budget=events[116];
 need(budget.request?.operation==='BUDGET_RESERVED'&&sha(budget.request.body.raw)===fixed.budget_sha256&&budget.request.body.sha256===fixed.budget_sha256&&execution.attempts.filter(a=>a.budget_sequence===117).length===1,'ORIGINAL_TEMPORAL_BUDGET_UNCHANGED');
 need(execution.current.charged_seconds===11706&&execution.current.charged_evidence_bytes===2604247987,'TEMPORAL_CUMULATIVE_CHARGES_UNCHANGED');
 const issued=Date.parse(body.activated_at),deadline=Date.parse(body.effect_deadline),expires=Date.parse(body.finalization_expires_at);
 need(temporalUtc(body.activated_at)&&temporalUtc(body.effect_deadline)&&body.finalization_expires_at===fixed.finalization_expires_at&&deadline-issued===600000&&Date.parse(fixed.original_deadline)<issued&&deadline<=expires,'EXACT_DATABASE_DERIVED_TEMPORAL_WINDOW');
 const context=Object.freeze({state:'TEMPORAL_SEMANTICS_ONLY_NOT_AUTHORITY',descriptor,event,body,issued,deadline,expires,execution_baseline_sequence:118,authority_effect:'NONE'});
 temporalContexts.add(context);return context;
}
export function checkRoot10TemporalTime({context,execution,operation,now=Date.now()}){
 need(temporalContexts.has(context)&&Number.isFinite(now)&&now>=context.issued,'RECOGNIZED_TEMPORAL_CONTEXT_AND_REAL_CLOCK');
 if(['CREATE','START','STOP'].includes(operation)){
  need(now<context.deadline,'TEMPORAL_EFFECT_WINDOW_EXPIRED');
  return {effect_deadline:context.deadline,authority_effect:'NONE'};
 }
 need(operation==='GRR'&&now<context.expires,'TEMPORAL_FINALIZATION_WINDOW_EXPIRED');
 const gaId=root10TemporalIdentity.ga_id,events=execution.events.filter(e=>e.request?.ga_id===gaId&&e.request.operation!==root10TemporalIdentity.activation_operation),stopped=events.filter(e=>e.request.operation==='STOPPED');
 need(stopped.length===1&&['STOPPED','DECISION_RESERVED','SIGNING'].includes(execution.attempts.find(a=>a.ga_id===gaId)?.phase),'REAL_STOP_REQUIRED_FOR_TEMPORAL_FINALIZATION');
 const effectOperations=['INTENT_RECORDED','CREATE_SENT','CREATED','INTENT_RECORDED','START_SENT','RUNNING','STOP_SENT','STOPPED'];
 const effects=events.filter(e=>effectOperations.includes(e.request.operation));
 need(effects.length===8&&effects.every((e,i)=>e.sequence===119+i&&e.request.operation===effectOperations[i])&&events.every(e=>effectOperations.includes(e.request.operation)||['DECISION_RESERVED','SIGNING'].includes(e.request.operation)),'ONE_COMPLETE_TEMPORAL_EFFECT_CHAIN');
 const raw=stopped[0].request.body.raw,stop=JSON.parse(raw),container=execution.attempts.find(a=>a.ga_id===gaId).container_id;
 need(sha(raw)===stopped[0].request.body.sha256&&stop.ga_id===gaId&&stop.ga_sha256===root10TemporalIdentity.ga_sha256&&stop.container_id===container&&/^[a-f0-9]{64}$/.test(container??'')&&stop.observation?.Id===container&&stop.observation.State?.Running===false&&stop.observation.State?.Pid===0&&stop.observation.State?.Status==='exited','EXACT_TEMPORAL_REAL_STOP');
 for(const e of events.filter(e=>['CREATED','RUNNING','STOPPED'].includes(e.request.operation))){
  const value=JSON.parse(e.request.body.raw),start=Date.parse(value.started_utc),end=Date.parse(value.ended_utc);
  need(sha(e.request.body.raw)===e.request.body.sha256&&Number.isFinite(start)&&Number.isFinite(end)&&context.issued<=start&&start<=end&&end<=context.deadline,'NO_POSTDEADLINE_TEMPORAL_EFFECT');
 }
 const finished=Date.parse(stop.observation.State.FinishedAt),ended=Date.parse(stop.ended_utc);
 need(Number.isFinite(finished)&&finished>=context.issued&&finished<=ended&&ended<=context.deadline,'TEMPORAL_STOP_FINISHED_WITHIN_EFFECT_WINDOW');
 return {finalization_expires_at:context.expires,authority_effect:'NONE'};
}

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
