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

// Runtime-clock amendment: the 600 authorized seconds bound the container's own
// observed run, never approval, transport, preparation, repair, acceptance or
// archival. It supersedes the temporal continuation's wall-clock effect window,
// which twice destroyed budget 117 without any container ever being created.
// This parser is a rejection check, not proof of Owner authority.
export const root10RuntimeClockIdentity=Object.freeze({
 ga_id:'ga_32daa5daf52c4deb8e893c25b08eff38',
 ga_sha256:'68afb1e6dc1367729cd6864b9ba9b5d846ab123ff5539d7a646f7fa1df988f78',
 original_controller_sha256:'d01bd55e02614c0d2b6f51f80fe5b56816aecc2f29e753344a4bcac56aaaf559',
 original_qualification_sha256:'3cd157e704660dac18d3e6c5fb790f6854f29d644c66d53b968bf94c07f12143',
 original_runtime_acceptance_sha256:'bc6cb688231763f2ad1a56bbc77a22eb7a35cfd749b12e8827f5040582443a88',
 predecessor_controller_sha256:'aca4db237a7572426fdf43c384abcc7fd945e5d0554b8a3b01a71959c2102041',
 predecessor_qualification_sha256:'e3ded3a817082660fce7edc6e5a1964327cb7e7af413d15d49ce155298788405',
 predecessor_runtime_acceptance_sha256:'17a5d20b7e6236cb276c7321955f6d0a5e5f83d9a35e83a570fcef251d59af42',
 budget_sha256:'669d96057a44ed5e9c3eae9fed6ed8720aae8a2b48eef03761b8e9361433a462',
 amendment_sha256:'e92a252a0ab62600d6153ece3e3df92a35bd5680b3d9e2c8f65b6c77ff236402',
 activation_operation:'RUNTIME_CLOCK_AMENDMENT_ACTIVATED',
 activation_key:'root10_runtime_clock_amendment_20260915',
 original_deadline:'2026-09-15T09:37:03.454Z',
 preparation_expires_at:'2026-09-16T03:00:00Z',
 finalization_expires_at:'2026-09-16T03:00:00Z',
 runtime_seconds:600,
 max_predispatch_resets:3,
 activation_sequence:119
});
const rcContexts=new WeakSet();
const rcDescriptorKeys=['activation_idempotency_key','activation_operation','amendment_ref','budget_ref','continuation_controller_sha256','expected_activation_sequence','finalization_expires_at','max_predispatch_resets','no_automatic_retry','no_new_budget','no_new_ga','no_refund','predecessor_controller_sha256','preparation_expires_at','prior_ga_ref','runtime_seconds','source_ref'];
const rcBodyKeys=['activated_at','amendment_ref','amendment_sha256','automatic_retry','budget_raw_sha256','budget_refund','budget_sequence','finalization_expires_at','max_predispatch_resets','new_binding','new_binding_sha256','new_budget','new_ga','old_binding','old_binding_sha256','preparation_expires_at','prior_ga_sha256','runtime_seconds'];
const rcEffectOperations=['INTENT_RECORDED','CREATE_SENT','CREATED','INTENT_RECORDED','START_SENT','RUNNING','STOP_SENT','STOPPED'];
export function readRoot10RuntimeClockContext({gaRaw,execution,descriptor}){
 if(descriptor===undefined||descriptor===null)return null;
 const fixed=root10RuntimeClockIdentity;
 need(exact(descriptor,rcDescriptorKeys),'EXACT_RUNTIME_CLOCK_DESCRIPTOR');
 need(ref(descriptor.amendment_ref)&&descriptor.amendment_ref.sha256===fixed.amendment_sha256&&descriptor.activation_operation===fixed.activation_operation&&descriptor.activation_idempotency_key===fixed.activation_key&&descriptor.expected_activation_sequence===fixed.activation_sequence,'EXACT_RUNTIME_CLOCK_ACTIVATION_CONTRACT');
 need(descriptor.prior_ga_ref?.ga_id===fixed.ga_id&&descriptor.prior_ga_ref.sha256===fixed.ga_sha256&&descriptor.budget_ref?.sha256===fixed.budget_sha256&&descriptor.runtime_seconds===fixed.runtime_seconds&&descriptor.max_predispatch_resets===fixed.max_predispatch_resets&&descriptor.preparation_expires_at===fixed.preparation_expires_at&&descriptor.finalization_expires_at===fixed.finalization_expires_at,'EXACT_RUNTIME_CLOCK_GA_BUDGET_WINDOW');
 need(descriptor.predecessor_controller_sha256===fixed.predecessor_controller_sha256&&hex(descriptor.continuation_controller_sha256)&&descriptor.continuation_controller_sha256!==fixed.predecessor_controller_sha256&&descriptor.continuation_controller_sha256!==fixed.original_controller_sha256&&['no_new_ga','no_new_budget','no_refund','no_automatic_retry'].every(k=>descriptor[k]===true),'EXACT_RUNTIME_CLOCK_NONEXPANDING_SUCCESSOR');
 // History and event-shape rules are checked before the GA byte pin so each is
 // independently provable live; nothing below grants anything before the pin.
 const events=execution?.events;
 need(Array.isArray(events)&&events.length===execution.current.sequence&&events.every((e,i)=>e.sequence===i+1),'COMPLETE_RUNTIME_CLOCK_EVENT_HISTORY');
 // The superseded temporal activation stays immutable in history at sequence 118.
 need(events[117]?.request?.operation===root10TemporalIdentity.activation_operation&&events[117].idempotency_key===root10TemporalIdentity.activation_key&&events[117].request.body?.amendment_sha256===root10TemporalIdentity.amendment_sha256,'SUPERSEDED_TEMPORAL_EVENT_IMMUTABLE');
 const matches=events.filter(e=>e.request?.operation===fixed.activation_operation);
 need(matches.length===1&&matches[0].sequence===fixed.activation_sequence&&matches[0].idempotency_key===fixed.activation_key,'ONE_RUNTIME_CLOCK_ACTIVATION_ONLY');
 const event=matches[0],request=event.request,body=request.body;
 need(exact(request,['operation','ga_id','expected_sequence','idempotency_key','body'])&&request.ga_id===fixed.ga_id&&request.expected_sequence===fixed.activation_sequence-1&&request.idempotency_key===fixed.activation_key&&exact(body,rcBodyKeys),'EXACT_RUNTIME_CLOCK_ACTIVATION_EVENT');
 need(event.root_id===execution.current.root_id&&sameTemporal(body.amendment_ref,descriptor.amendment_ref)&&body.amendment_sha256===descriptor.amendment_ref.sha256&&body.prior_ga_sha256===fixed.ga_sha256&&body.budget_sequence===117&&body.budget_raw_sha256===fixed.budget_sha256,'EXACT_RUNTIME_CLOCK_EVENT_BINDINGS');
 need(['automatic_retry','budget_refund','new_budget','new_ga'].every(k=>body[k]===false),'NO_RUNTIME_CLOCK_BUDGET_OR_GA_EFFECT');
 need(body.preparation_expires_at===fixed.preparation_expires_at&&body.finalization_expires_at===fixed.finalization_expires_at&&body.runtime_seconds===fixed.runtime_seconds&&body.max_predispatch_resets===fixed.max_predispatch_resets,'EXACT_RUNTIME_CLOCK_WINDOW_TERMS');
 need(!events.slice(0,117).some(e=>e.request?.ga_id===fixed.ga_id),'RUNTIME_CLOCK_ZERO_PRIOR_GA_EFFECT');
 const changed=['controller_sha256','qualification_sha256','runtime_acceptance_sha256'];
 need(body.old_binding?.controller_sha256===fixed.predecessor_controller_sha256&&body.old_binding.qualification_sha256===fixed.predecessor_qualification_sha256&&body.old_binding.runtime_acceptance_sha256===fixed.predecessor_runtime_acceptance_sha256&&body.new_binding?.controller_sha256===descriptor.continuation_controller_sha256&&changed.every(k=>hex(body.new_binding[k]))&&sameTemporal({...body.new_binding,...Object.fromEntries(changed.map(k=>[k,body.old_binding[k]]))},body.old_binding),'ONLY_ACCEPTED_RUNTIME_CLOCK_BINDING_COLUMNS_CHANGE');
 need(sha(postgresJsonbText(body.old_binding))===body.old_binding_sha256&&sha(postgresJsonbText(body.new_binding))===body.new_binding_sha256&&sameTemporal(body.new_binding,execution.binding),'EXACT_RUNTIME_CLOCK_BINDING_PREIMAGE_AND_CURRENT');
 need(execution.current.charged_seconds===11706&&execution.current.charged_evidence_bytes===2604247987,'RUNTIME_CLOCK_CUMULATIVE_CHARGES_UNCHANGED');
 const budget=events[116];
 need(budget.request?.operation==='BUDGET_RESERVED'&&sha(budget.request.body.raw)===fixed.budget_sha256&&budget.request.body.sha256===fixed.budget_sha256&&execution.attempts.filter(a=>a.budget_sequence===117).length===1,'ORIGINAL_RUNTIME_CLOCK_BUDGET_UNCHANGED');
 need(typeof gaRaw==='string'&&sha(gaRaw)===fixed.ga_sha256,'EXACT_UNCHANGED_RUNTIME_CLOCK_GA_BYTES');
 const ga=JSON.parse(gaRaw);
 need(ga.gate_authorization_id===fixed.ga_id&&ga.controller_digest===fixed.original_controller_sha256&&ga.deadline===fixed.original_deadline&&ga.expires_at===fixed.original_deadline,'ORIGINAL_GA_CLOCK_IMMUTABLE');
 need(event.root_id===ga.authority_source_ref.uri.split(':').at(-1),'EXACT_RUNTIME_CLOCK_EVENT_BINDINGS');
 const attempt=execution.attempts?.filter(a=>a.ga_id===fixed.ga_id);
 need(attempt?.length===1&&attempt[0].ga_raw===gaRaw&&attempt[0].ga_sha256===fixed.ga_sha256&&attempt[0].budget_sequence===117&&Date.parse(attempt[0].expires_at)===Date.parse(fixed.original_deadline)&&attempt[0].revoked===false,'ORIGINAL_RUNTIME_CLOCK_ATTEMPT_UNCHANGED');
 const issued=Date.parse(body.activated_at),prep=Date.parse(body.preparation_expires_at),final=Date.parse(body.finalization_expires_at);
 need(temporalUtc(body.activated_at)&&Date.parse(fixed.original_deadline)<issued&&issued<prep&&prep<=final,'EXACT_DATABASE_DERIVED_RUNTIME_CLOCK_WINDOW');
 // Bounded in-place predispatch repair: a reset is only ever zero-effect, and at
 // most one runtime interval can ever exist for the GA.
 const gaEvents=events.filter(e=>e.request?.ga_id===fixed.ga_id&&e.sequence>fixed.activation_sequence);
 const resets=gaEvents.filter(e=>e.request.operation==='PREDISPATCH_RESET');
 need(resets.length<=fixed.max_predispatch_resets,'BOUNDED_PREDISPATCH_RESETS');
 for(const reset of resets){
  need(reset.request.body?.automatic_retry===false&&typeof reset.request.body.reason==='string'&&reset.request.body.reason.length>0&&reset.request.body.reason.length<=200,'EXACT_ZERO_EFFECT_RESET_EVENT');
  need(!gaEvents.some(e=>e.sequence<reset.sequence&&['RUNNING','STOPPED'].includes(e.request.operation)),'RESET_ONLY_BEFORE_ANY_RUN');
 }
 need(gaEvents.filter(e=>e.request.operation==='RUNNING').length<=1,'ONE_RUNTIME_INTERVAL_ONLY');
 const lastReset=resets.length?resets.at(-1).sequence:fixed.activation_sequence;
 const context=Object.freeze({state:'RUNTIME_CLOCK_SEMANTICS_ONLY_NOT_AUTHORITY',descriptor,event,body,issued,prep,final,runtimeSeconds:fixed.runtime_seconds,resets:resets.length,lastReset,execution_baseline_sequence:fixed.activation_sequence,authority_effect:'NONE'});
 rcContexts.add(context);return context;
}
export function checkRoot10RuntimeClockTime({context,execution,operation,now=Date.now()}){
 need(rcContexts.has(context)&&Number.isFinite(now)&&now>=context.issued,'RECOGNIZED_RUNTIME_CLOCK_CONTEXT_AND_REAL_CLOCK');
 if(['CREATE','START'].includes(operation)){
  // Preparation is not runtime: CREATE and START are bounded only by the
  // preparation window, never by a clock that started at an approval instant.
  need(now<context.prep,'RUNTIME_CLOCK_PREPARATION_WINDOW_EXPIRED');
  return {preparation_expires_at:context.prep,authority_effect:'NONE'};
 }
 if(operation==='STOP'){
  // Stopping a container is never refused on account of any clock. A limit that
  // forbids stopping a running container is itself the runaway risk.
  return {stop_never_clock_refused:true,authority_effect:'NONE'};
 }
 need(operation==='GRR'&&now<context.final,'RUNTIME_CLOCK_FINALIZATION_WINDOW_EXPIRED');
 const gaId=root10RuntimeClockIdentity.ga_id;
 const events=execution.events.filter(e=>e.request?.ga_id===gaId&&e.sequence>context.execution_baseline_sequence&&e.request.operation!=='PREDISPATCH_RESET');
 const finalRound=events.filter(e=>e.sequence>context.lastReset);
 const effects=finalRound.filter(e=>rcEffectOperations.includes(e.request.operation));
 need(effects.length===8&&effects.every((e,i)=>e.request.operation===rcEffectOperations[i]&&e.sequence===effects[0].sequence+i)&&finalRound.every(e=>rcEffectOperations.includes(e.request.operation)||['DECISION_RESERVED','SIGNING'].includes(e.request.operation)),'ONE_COMPLETE_RUNTIME_CLOCK_EFFECT_CHAIN');
 need(!events.some(e=>e.sequence<=context.lastReset&&['RUNNING','STOPPED','DECISION_RESERVED','SIGNING'].includes(e.request.operation)),'EARLIER_ROUNDS_ZERO_EFFECT_ONLY');
 const running=effects[5],runningValue=JSON.parse(running.request.body.raw);
 need(sha(running.request.body.raw)===running.request.body.sha256&&typeof running.request.body.runtime_deadline==='string'&&Math.abs(Date.parse(running.request.body.runtime_deadline)-(Date.parse(runningValue.observation?.State?.StartedAt)+context.runtimeSeconds*1000))<1000,'EXACT_IMMUTABLE_RUNTIME_DEADLINE');
 const stopped=effects[7],raw=stopped.request.body.raw,stop=JSON.parse(raw),container=execution.attempts.find(a=>a.ga_id===gaId).container_id;
 need(sha(raw)===stopped.request.body.sha256&&stop.ga_id===gaId&&stop.ga_sha256===root10RuntimeClockIdentity.ga_sha256&&stop.container_id===container&&/^[a-f0-9]{64}$/.test(container??'')&&stop.observation?.Id===container&&stop.observation.State?.Running===false&&stop.observation.State?.Pid===0&&stop.observation.State?.Status==='exited','EXACT_RUNTIME_CLOCK_REAL_STOP');
 // Runaway control: an overrun run was still stopped, but it can never pass.
 need(stopped.request.body.overrun===false,'OVERRUN_RUN_CANNOT_PASS');
 const startedAt=Date.parse(stop.observation.State.StartedAt),finishedAt=Date.parse(stop.observation.State.FinishedAt);
 need(Number.isFinite(startedAt)&&Number.isFinite(finishedAt)&&startedAt>=context.issued&&startedAt<=finishedAt&&finishedAt-startedAt<=context.runtimeSeconds*1000,'RUNTIME_INTERVAL_WITHIN_BUDGET');
 need(['STOPPED','DECISION_RESERVED','SIGNING'].includes(execution.attempts.find(a=>a.ga_id===gaId)?.phase),'REAL_STOP_REQUIRED_FOR_RUNTIME_CLOCK_FINALIZATION');
 return {finalization_expires_at:context.final,authority_effect:'NONE'};
}

// Scope amendment: the applicable formal test set for this generation is the
// five tests the accepted runtime already carries component evidence for. It
// narrows what a result claims; it relaxes no evidence rule. Every runtime-clock
// term of event 119 is carried forward and re-checked here, so a scope event
// cannot quietly widen a window, lift the reset bound or forgive an overrun.
// This parser is a rejection check, not proof of Owner authority.
export const root10ScopeIdentity=Object.freeze({
 ga_id:'ga_32daa5daf52c4deb8e893c25b08eff38',
 ga_sha256:'68afb1e6dc1367729cd6864b9ba9b5d846ab123ff5539d7a646f7fa1df988f78',
 control_trust_root_generation:'ctrgen_48100437d24e448ba01c542ebe1290da',
 amendment_sha256:'a71bd7128eff8d3125711bf7967faddc9eab3c4ef675035db711b95b45136537',
 original_controller_sha256:'d01bd55e02614c0d2b6f51f80fe5b56816aecc2f29e753344a4bcac56aaaf559',
 predecessor_controller_sha256:'5c72dd8923436f6e9ab5b51160cd8751944158d3919d3ef09f6f3ec5006e40b6',
 predecessor_qualification_sha256:'6a7145fa0c09a00a917b40c42f5dbaa38f4c6028e75ab747dd234351b993b849',
 predecessor_runtime_acceptance_sha256:'321221816f4c368d98833de6f698adcb1835d88e6b7c991c0b9d9537abba3c1e',
 budget_sha256:'669d96057a44ed5e9c3eae9fed6ed8720aae8a2b48eef03761b8e9361433a462',
 runtime_clock_amendment_sha256:'e92a252a0ab62600d6153ece3e3df92a35bd5680b3d9e2c8f65b6c77ff236402',
 activation_operation:'SCOPE_AMENDMENT_ACTIVATED',
 activation_key:'root10_scope_amendment_20260915',
 original_deadline:'2026-09-15T09:37:03.454Z',
 preparation_expires_at:'2026-09-16T03:00:00Z',
 finalization_expires_at:'2026-09-16T03:00:00Z',
 runtime_seconds:600,
 max_predispatch_resets:3,
 activation_sequence:120,
 carries_forward_sequence:119,
 applicable_test_ids:['PQUAL-11','PQUAL-13','PQUAL-15','PQUAL-16','PQUAL-17'],
 out_of_scope_test_ids:['PQUAL-01','PQUAL-02','PQUAL-03','PQUAL-04','PQUAL-05','PQUAL-06','PQUAL-07','PQUAL-08','PQUAL-09','PQUAL-10','PQUAL-12','PQUAL-14','PQUAL-19','PQUAL-20']
});
const scContexts=new WeakSet();
const scDescriptorKeys=['activation_idempotency_key','activation_operation','amendment_ref','applicable_test_ids','budget_ref','carries_forward_sequence','continuation_controller_sha256','expected_activation_sequence','finalization_expires_at','max_predispatch_resets','no_automatic_retry','no_new_budget','no_new_ga','no_refund','out_of_scope_test_ids','predecessor_controller_sha256','preparation_expires_at','prior_ga_ref','runtime_clock_amendment_sha256','runtime_seconds','source_ref'];
const scBodyKeys=['activated_at','amendment_ref','amendment_sha256','applicable_test_ids','automatic_retry','budget_raw_sha256','budget_refund','budget_sequence','carries_forward_sequence','control_trust_root_generation','finalization_expires_at','max_predispatch_resets','new_binding','new_binding_sha256','new_budget','new_ga','old_binding','old_binding_sha256','out_of_scope_test_ids','preparation_expires_at','prior_ga_sha256','runtime_seconds'];
const scEffectOperations=rcEffectOperations;
const sameIds=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>v===b[i]);
export function readRoot10ScopeContext({gaRaw,execution,descriptor}){
 if(descriptor===undefined||descriptor===null)return null;
 const fixed=root10ScopeIdentity;
 need(exact(descriptor,scDescriptorKeys),'EXACT_SCOPE_DESCRIPTOR');
 need(ref(descriptor.amendment_ref)&&descriptor.amendment_ref.sha256===fixed.amendment_sha256&&descriptor.activation_operation===fixed.activation_operation&&descriptor.activation_idempotency_key===fixed.activation_key&&descriptor.expected_activation_sequence===fixed.activation_sequence,'EXACT_SCOPE_ACTIVATION_CONTRACT');
 // The exclusion list is the runtime clock's, not a shorter one. A scope descriptor
 // naming the ORIGINAL Root10 controller as its continuation would move the binding
 // backwards to a controller that predates both amendments while reading as a forward
 // step, and the shorter list admitted it.
 need(descriptor.predecessor_controller_sha256===fixed.predecessor_controller_sha256&&hex(descriptor.continuation_controller_sha256)&&descriptor.continuation_controller_sha256!==fixed.predecessor_controller_sha256&&descriptor.continuation_controller_sha256!==fixed.original_controller_sha256,'EXACT_SCOPE_CONTROLLER_FORWARD');
 // The runtime clock pins these two in EXACT_RUNTIME_CLOCK_GA_BUDGET_WINDOW. The scope
 // read required them present and never looked at them, so a descriptor could name any
 // GA and any budget and still be accepted.
 need(descriptor.prior_ga_ref?.ga_id===fixed.ga_id&&descriptor.prior_ga_ref.sha256===fixed.ga_sha256&&descriptor.budget_ref?.sha256===fixed.budget_sha256,'EXACT_SCOPE_GA_AND_BUDGET_REF');
 need(descriptor.runtime_clock_amendment_sha256===fixed.runtime_clock_amendment_sha256&&descriptor.carries_forward_sequence===fixed.carries_forward_sequence,'EXACT_SCOPE_CARRIES_FORWARD_RUNTIME_CLOCK');
 need(descriptor.preparation_expires_at===fixed.preparation_expires_at&&descriptor.finalization_expires_at===fixed.finalization_expires_at&&descriptor.runtime_seconds===fixed.runtime_seconds&&descriptor.max_predispatch_resets===fixed.max_predispatch_resets,'EXACT_SCOPE_WINDOW_TERMS');
 need(sameIds(descriptor.applicable_test_ids,fixed.applicable_test_ids)&&sameIds(descriptor.out_of_scope_test_ids,fixed.out_of_scope_test_ids),'EXACT_SCOPE_APPLICABLE_SET');
 need(['no_automatic_retry','no_new_budget','no_new_ga','no_refund'].every(k=>descriptor[k]===true),'NO_SCOPE_BUDGET_OR_GA_EFFECT');
 const events=execution.events;
 need(Array.isArray(events)&&events.length===execution.current.sequence&&events.every((e,i)=>e.sequence===i+1),'EXACT_COMPLETE_SCOPE_EVENT_HISTORY');
 // The runtime clock must still be present and valid in history: a scope event
 // has no independent force and may only ride on the accepted event 119.
 const carried=events.filter(e=>e.sequence===fixed.carries_forward_sequence&&e.request?.operation===root10RuntimeClockIdentity.activation_operation&&e.request.ga_id===fixed.ga_id);
 need(carried.length===1&&carried[0].request.idempotency_key===root10RuntimeClockIdentity.activation_key&&carried[0].request.body?.amendment_sha256===fixed.runtime_clock_amendment_sha256,'SCOPE_REQUIRES_ACCEPTED_RUNTIME_CLOCK');
 need(!events.slice(0,117).some(e=>e.request?.ga_id===fixed.ga_id),'SCOPE_ZERO_PRIOR_GA_EFFECT');
 const carriedBody=carried[0].request.body;
 const anywhere=events.filter(e=>e.request?.operation===fixed.activation_operation);
 const selected=anywhere.filter(e=>e.sequence===fixed.activation_sequence&&e.request.ga_id===fixed.ga_id);
 need(anywhere.length===1&&selected.length===1&&events[fixed.activation_sequence-1]===selected[0],'ONE_EXACT_SCOPE_ACTIVATION_EVENT');
 const event=selected[0],request=event.request,body=request.body;
 need(exact(request,['operation','ga_id','expected_sequence','idempotency_key','body'])&&request.ga_id===fixed.ga_id&&request.expected_sequence===fixed.activation_sequence-1&&request.idempotency_key===fixed.activation_key&&event.idempotency_key===fixed.activation_key&&exact(body,scBodyKeys),'EXACT_SCOPE_ACTIVATION_EVENT');
 need(event.root_id===execution.current.root_id&&sameTemporal(body.amendment_ref,descriptor.amendment_ref)&&body.amendment_sha256===descriptor.amendment_ref.sha256&&body.prior_ga_sha256===fixed.ga_sha256&&body.budget_sequence===117&&body.budget_raw_sha256===fixed.budget_sha256,'EXACT_SCOPE_EVENT_BINDINGS');
 need(['automatic_retry','budget_refund','new_budget','new_ga'].every(k=>body[k]===false),'NO_SCOPE_BUDGET_OR_GA_EFFECT');
 need(body.preparation_expires_at===fixed.preparation_expires_at&&body.finalization_expires_at===fixed.finalization_expires_at&&body.runtime_seconds===fixed.runtime_seconds&&body.max_predispatch_resets===fixed.max_predispatch_resets,'EXACT_SCOPE_EVENT_WINDOW_TERMS');
 need(sameIds(body.applicable_test_ids,fixed.applicable_test_ids)&&sameIds(body.out_of_scope_test_ids,fixed.out_of_scope_test_ids)&&body.carries_forward_sequence===fixed.carries_forward_sequence&&body.control_trust_root_generation===fixed.control_trust_root_generation,'EXACT_SCOPE_EVENT_APPLICABLE_SET');
 // Carry-forward is machine-checked, not asserted in prose: event 120 must restate
 // event 119's window terms exactly and must start from event 119's own new binding.
 need(Date.parse(body.preparation_expires_at)>=Date.parse(carriedBody.preparation_expires_at)&&Date.parse(body.finalization_expires_at)>=Date.parse(carriedBody.finalization_expires_at)&&body.runtime_seconds===carriedBody.runtime_seconds&&body.max_predispatch_resets===carriedBody.max_predispatch_resets&&body.budget_raw_sha256===carriedBody.budget_raw_sha256&&body.budget_sequence===carriedBody.budget_sequence,'SCOPE_MUST_CARRY_RUNTIME_CLOCK_FORWARD');
 need(sameTemporal(body.old_binding,carriedBody.new_binding),'SCOPE_OLD_BINDING_IS_RUNTIME_CLOCK_NEW_BINDING');
 const changed=['controller_sha256','qualification_sha256','runtime_acceptance_sha256'];
 need(body.old_binding?.controller_sha256===fixed.predecessor_controller_sha256&&body.old_binding.qualification_sha256===fixed.predecessor_qualification_sha256&&body.old_binding.runtime_acceptance_sha256===fixed.predecessor_runtime_acceptance_sha256&&body.new_binding?.controller_sha256===descriptor.continuation_controller_sha256&&changed.every(k=>hex(body.new_binding[k]))&&sameTemporal({...body.new_binding,...Object.fromEntries(changed.map(k=>[k,body.old_binding[k]]))},body.old_binding),'ONLY_ACCEPTED_SCOPE_BINDING_COLUMNS_CHANGE');
 need(sha(postgresJsonbText(body.old_binding))===body.old_binding_sha256&&sha(postgresJsonbText(body.new_binding))===body.new_binding_sha256&&sameTemporal(body.new_binding,execution.binding),'EXACT_SCOPE_BINDING_PREIMAGE_AND_CURRENT');
 need(execution.current.charged_seconds===11706&&execution.current.charged_evidence_bytes===2604247987,'SCOPE_CUMULATIVE_CHARGES_UNCHANGED');
 need(typeof gaRaw==='string'&&sha(gaRaw)===fixed.ga_sha256,'EXACT_UNCHANGED_SCOPE_GA_BYTES');
 const ga=JSON.parse(gaRaw);
 need(ga.gate_authorization_id===fixed.ga_id&&ga.controller_digest===fixed.original_controller_sha256&&ga.deadline===fixed.original_deadline&&ga.expires_at===fixed.original_deadline,'ORIGINAL_GA_CLOCK_IMMUTABLE');
 const attempt=execution.attempts?.filter(a=>a.ga_id===fixed.ga_id);
 need(attempt?.length===1&&attempt[0].ga_raw===gaRaw&&attempt[0].ga_sha256===fixed.ga_sha256&&attempt[0].budget_sequence===117&&Date.parse(attempt[0].expires_at)===Date.parse(fixed.original_deadline)&&attempt[0].revoked===false,'ORIGINAL_SCOPE_ATTEMPT_UNCHANGED');
 const budget=events[116];
 need(budget.request?.operation==='BUDGET_RESERVED'&&sha(budget.request.body.raw)===fixed.budget_sha256&&budget.request.body.sha256===fixed.budget_sha256&&execution.attempts.filter(a=>a.budget_sequence===117).length===1,'ORIGINAL_SCOPE_BUDGET_UNCHANGED');
 const issued=Date.parse(body.activated_at),prep=Date.parse(fixed.preparation_expires_at),final=Date.parse(fixed.finalization_expires_at);
 need(temporalUtc(body.activated_at)&&Date.parse(carriedBody.activated_at)<=issued&&issued<prep&&prep<=final,'EXACT_DATABASE_DERIVED_SCOPE_WINDOW');
 // The reset bound and the one-run rule are the runtime clock's, carried forward
 // unchanged. Rounds are counted from event 119, not from event 120, so a scope
 // amendment can never hand back a reset that was already spent.
 const gaEvents=events.filter(e=>e.request?.ga_id===fixed.ga_id&&e.sequence>fixed.carries_forward_sequence&&e.sequence!==fixed.activation_sequence);
 const resets=gaEvents.filter(e=>e.request.operation==='PREDISPATCH_RESET');
 need(resets.length<=fixed.max_predispatch_resets,'BOUNDED_PREDISPATCH_RESETS');
 for(const reset of resets){
  need(reset.request.body?.automatic_retry===false&&typeof reset.request.body.reason==='string'&&reset.request.body.reason.length>0&&reset.request.body.reason.length<=200,'EXACT_ZERO_EFFECT_RESET_EVENT');
  need(!gaEvents.some(e=>e.sequence<reset.sequence&&['RUNNING','STOPPED'].includes(e.request.operation)),'RESET_ONLY_BEFORE_ANY_RUN');
 }
 need(gaEvents.filter(e=>e.request.operation==='RUNNING').length<=1,'ONE_RUNTIME_INTERVAL_ONLY');
 const lastReset=resets.length?resets.at(-1).sequence:fixed.activation_sequence;
 const context=Object.freeze({state:'SCOPE_SEMANTICS_ONLY_NOT_AUTHORITY',descriptor,event,body,issued,prep,final,runtimeSeconds:fixed.runtime_seconds,resets:resets.length,lastReset,execution_baseline_sequence:fixed.activation_sequence,applicable_test_ids:fixed.applicable_test_ids,authority_effect:'NONE'});
 scContexts.add(context);return context;
}
export function checkRoot10ScopeTime({context,execution,operation,now=Date.now()}){
 need(scContexts.has(context)&&Number.isFinite(now)&&now>=context.issued,'RECOGNIZED_SCOPE_CONTEXT_AND_REAL_CLOCK');
 if(['CREATE','START'].includes(operation)){
  // Identical to the runtime clock: preparation is not runtime.
  need(now<context.prep,'SCOPE_PREPARATION_WINDOW_EXPIRED');
  return {preparation_expires_at:context.prep,authority_effect:'NONE'};
 }
 if(operation==='STOP')return {stop_never_clock_refused:true,authority_effect:'NONE'};
 need(operation==='GRR'&&now<context.final,'SCOPE_FINALIZATION_WINDOW_EXPIRED');
 const gaId=root10ScopeIdentity.ga_id;
 const events=execution.events.filter(e=>e.request?.ga_id===gaId&&e.sequence>context.execution_baseline_sequence&&e.request.operation!=='PREDISPATCH_RESET');
 const finalRound=events.filter(e=>e.sequence>context.lastReset);
 const effects=finalRound.filter(e=>scEffectOperations.includes(e.request.operation));
 need(effects.length===8&&effects.every((e,i)=>e.request.operation===scEffectOperations[i]&&e.sequence===effects[0].sequence+i)&&finalRound.every(e=>scEffectOperations.includes(e.request.operation)||['DECISION_RESERVED','SIGNING'].includes(e.request.operation)),'ONE_COMPLETE_SCOPE_EFFECT_CHAIN');
 need(!events.some(e=>e.sequence<=context.lastReset&&['RUNNING','STOPPED','DECISION_RESERVED','SIGNING'].includes(e.request.operation)),'EARLIER_ROUNDS_ZERO_EFFECT_ONLY');
 const running=effects[5],runningValue=JSON.parse(running.request.body.raw);
 need(sha(running.request.body.raw)===running.request.body.sha256&&typeof running.request.body.runtime_deadline==='string'&&Math.abs(Date.parse(running.request.body.runtime_deadline)-(Date.parse(runningValue.observation?.State?.StartedAt)+context.runtimeSeconds*1000))<1000,'EXACT_IMMUTABLE_RUNTIME_DEADLINE');
 const stopped=effects[7],raw=stopped.request.body.raw,stop=JSON.parse(raw),container=execution.attempts.find(a=>a.ga_id===gaId).container_id;
 need(sha(raw)===stopped.request.body.sha256&&stop.ga_id===gaId&&stop.ga_sha256===root10ScopeIdentity.ga_sha256&&stop.container_id===container&&/^[a-f0-9]{64}$/.test(container??'')&&stop.observation?.Id===container&&stop.observation.State?.Running===false&&stop.observation.State?.Pid===0&&stop.observation.State?.Status==='exited','EXACT_SCOPE_REAL_STOP');
 // Runaway control is carried forward verbatim: an overrun run can never pass.
 need(stopped.request.body.overrun===false,'OVERRUN_RUN_CANNOT_PASS');
 const startedAt=Date.parse(stop.observation.State.StartedAt),finishedAt=Date.parse(stop.observation.State.FinishedAt);
 need(Number.isFinite(startedAt)&&Number.isFinite(finishedAt)&&startedAt>=context.issued&&startedAt<=finishedAt&&finishedAt-startedAt<=context.runtimeSeconds*1000,'RUNTIME_INTERVAL_WITHIN_BUDGET');
 need(['STOPPED','DECISION_RESERVED','SIGNING'].includes(execution.attempts.find(a=>a.ga_id===gaId)?.phase),'REAL_STOP_REQUIRED_FOR_SCOPE_FINALIZATION');
 return {finalization_expires_at:context.final,authority_effect:'NONE'};
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
 const suite=value.accepted_suite,formal=['PQUAL-11','PQUAL-13','PQUAL-15','PQUAL-16','PQUAL-17'];
 need(exact(suite,['uri','sha256','original_executor_sha256','formal_test_ids','pqual18_disposition'])&&ref({uri:suite.uri,sha256:suite.sha256})&&hex(suite.original_executor_sha256)&&JSON.stringify(suite.formal_test_ids)===JSON.stringify(formal)&&suite.pqual18_disposition==='NEGATIVE_ADMISSION_CHECK_NOT_FORMAL_RESULT','EXACT_5_PLUS_NEGATIVE_18_CONTRACT');
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
