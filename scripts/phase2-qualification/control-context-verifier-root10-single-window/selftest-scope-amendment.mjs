// Scope-amendment unit tests. Rejection-check coverage only; passing grants no
// qualification, admission or authority. Each case builds a synthetic execution
// state and proves one rule live by showing the exact refusal fires, in the same
// harness style as selftest-runtime-clock.mjs.
//
// One difference from that file, and the reason this one can also test the
// accepting path. readRoot10ScopeContext pins the real signed GA bytes and the
// real reserved budget bytes; synthetic bytes can never reproduce either, so on
// the controller itself every read here refuses at EXACT_UNCHANGED_SCOPE_GA_BYTES
// and no context is ever built -- which would leave the whole of
// checkRoot10ScopeTime, and every rule after the GA pin, untested. So the two
// pins, and only those two, are re-pinned to this file's synthetic bytes in a
// byte-for-byte copy of the controller loaded from memory (never written to
// disk, never imported by anything else). Test 19 proves the real pin still
// refuses these bytes on the real module, and test 36 proves the copy differs
// from the controller in exactly those two digests and nothing else, so every
// other rule exercised below is the controller's own code running unmodified.
import fs from 'node:fs';
import crypto from 'node:crypto';
import * as controller from './root10-single-window.mjs';
import {root10ScopeIdentity,root10RuntimeClockIdentity,root10TemporalIdentity,postgresJsonbText,canonicalDigest,loadRoot10ControllerContract} from './root10-single-window.mjs';
// Fixed gate/scope/profile digests come from the accepted contract, never bare
// literals here, so the digest-pin census stays exact for this file.
const FIXED=loadRoot10ControllerContract().value.fixed_digests;

const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const fixed=root10ScopeIdentity,clock=root10RuntimeClockIdentity,temporal=root10TemporalIdentity;
let passed=0,failed=0;
function test(name,fn){
 try{fn();passed++;console.log('PASS '+name);}
 catch(error){failed++;console.log('FAIL '+name+' -- '+error.message);}
}
function expectThrow(fn,message,name){
 try{fn();}catch(error){
  if(error.message===message)return;
  throw Error(name+': expected '+message+', got '+error.message);
 }
 throw Error(name+': expected refusal '+message+' did not fire');
}
function expectPass(fn,name){
 try{return fn();}catch(error){throw Error(name+': expected acceptance, got refusal '+error.message);}
}

// --- Synthetic fixture -------------------------------------------------------
const ROOT='ctr_414bd3c724264a83894b0c55cf2ab878';
const AMEND_URI='https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'+'4'.repeat(40);
const SOURCE_REF={commit:'6'.repeat(40),tree:'7'.repeat(40),blobs:[]};
const NEW_CONTROLLER='1'.repeat(64),NEW_QUALIFICATION='2'.repeat(64),NEW_ACCEPTANCE='3'.repeat(64);
const OTHER_DIGEST='8'.repeat(64),CONTAINER='a'.repeat(64);
const CLOCK_ACTIVATED='2026-09-15T15:00:00.000000+00:00',SCOPE_ACTIVATED='2026-09-15T16:00:00.000000+00:00';
const STARTED='2026-09-15T16:05:00.000Z',FINISHED='2026-09-15T16:12:00.000Z';
const GRR_NOW=Date.parse('2026-09-16T00:00:00Z');
const gaValue={gate_authorization_id:fixed.ga_id,controller_digest:fixed.original_controller_sha256,
 deadline:fixed.original_deadline,expires_at:fixed.original_deadline,
 authority_source_ref:{uri:'urn:clued:control-trust-root-set:uscrdifznmlvczcekqpw:'+ROOT,sha256:'5'.repeat(64)}};
const GA_RAW=JSON.stringify(gaValue)+'\n',GA_SHA=sha(GA_RAW);
const BUDGET_RAW=JSON.stringify({purpose:'SKILL_COEXISTENCE_QUALIFICATION',seconds:600,evidence_bytes:134217728,sequence:117})+'\n';
const BUDGET_SHA=sha(BUDGET_RAW);

// --- The pin-substituted copy ------------------------------------------------
const SOURCE=fs.readFileSync(new URL('./root10-single-window.mjs',import.meta.url),'utf8');
const occurrences=(text,needle)=>text.split(needle).length-1;
function substitute(gaRawValue,budgetRawValue){
 // Both pins are restated once per amendment identity (temporal, runtime clock,
 // scope). Anything else means the controller was reshaped and this copy can no
 // longer claim to be faithful, so refuse rather than test a fiction.
 if(occurrences(SOURCE,fixed.ga_sha256)!==3||occurrences(SOURCE,fixed.budget_sha256)!==3)
  throw Error('controller pin layout changed; the pin-substituted copy is no longer faithful');
 const patched=SOURCE.split(fixed.ga_sha256).join(sha(gaRawValue)).split(fixed.budget_sha256).join(sha(budgetRawValue));
 if(patched.length!==SOURCE.length||occurrences(patched,fixed.ga_sha256)||occurrences(patched,fixed.budget_sha256))
  throw Error('pin substitution did not replace exactly the two pinned digests');
 return patched;
}
const load=text=>import('data:text/javascript;base64,'+Buffer.from(text,'utf8').toString('base64'));
const PATCHED=substitute(GA_RAW,BUDGET_RAW);
const copy=await load(PATCHED);
// A second copy pinned to GA bytes whose signed clock has been moved, so the
// clock-immutability rule can be reached at all.
const MOVED_GA_RAW=JSON.stringify({...gaValue,deadline:'2026-10-01T00:00:00.000Z',expires_at:'2026-10-01T00:00:00.000Z'})+'\n';
const movedCopy=await load(substitute(MOVED_GA_RAW,BUDGET_RAW));

function binding(controllerDigest,qualification,acceptance){
 return {gate_id:'G-PREENTRY-SKILL-QUALIFICATION',root_id:ROOT,
  gate_sha256:FIXED.gate_sha256,
  gate_version:'fixed-synthetic-20260910.v10-env-order-repair',
  scope_sha256:FIXED.scope_sha256,
  prior_seconds:1506,profile_sha256:FIXED.profile_sha256,
  controller_sha256:controllerDigest,prior_evidence_bytes:322546611,
  qualification_sha256:qualification,runtime_acceptance_sha256:acceptance};
}
// Taken from the frozen identities rather than restated as literals here, so the
// digest census for this file stays at zero and no pin can hide in a test.
const CLOCK_OLD_BINDING=binding(clock.predecessor_controller_sha256,clock.predecessor_qualification_sha256,clock.predecessor_runtime_acceptance_sha256);
// Event 119's new binding IS event 120's old binding; the scope identity's
// predecessor triple is the runtime clock's accepted successor.
const CARRIED_BINDING=binding(fixed.predecessor_controller_sha256,fixed.predecessor_qualification_sha256,fixed.predecessor_runtime_acceptance_sha256);
const SCOPE_NEW_BINDING=binding(NEW_CONTROLLER,NEW_QUALIFICATION,NEW_ACCEPTANCE);

// EXACT_SCOPE_GA_AND_BUDGET_REF pins prior_ga_ref and budget_ref against the
// identity of the module doing the reading, and that check runs BEFORE the GA
// byte pin so each rule stays independently provable. A descriptor is therefore
// only well formed with respect to one identity: the synthetic pins for a
// pin-substituted copy, the real pins for the controller itself. `identity`
// carries that, so a test never has to remember which module it is aimed at.
function descriptor(overrides={},identity=copy.root10ScopeIdentity){
 return {activation_idempotency_key:fixed.activation_key,activation_operation:fixed.activation_operation,
  amendment_ref:{uri:AMEND_URI,sha256:fixed.amendment_sha256},
  applicable_test_ids:[...fixed.applicable_test_ids],
  budget_ref:{sequence:117,sha256:identity.budget_sha256,seconds:600,evidence_bytes:134217728},
  carries_forward_sequence:fixed.carries_forward_sequence,
  continuation_controller_sha256:NEW_CONTROLLER,
  expected_activation_sequence:fixed.activation_sequence,
  finalization_expires_at:fixed.finalization_expires_at,
  max_predispatch_resets:fixed.max_predispatch_resets,
  no_automatic_retry:true,no_new_budget:true,no_new_ga:true,no_refund:true,
  out_of_scope_test_ids:[...fixed.out_of_scope_test_ids],
  predecessor_controller_sha256:fixed.predecessor_controller_sha256,
  preparation_expires_at:fixed.preparation_expires_at,
  prior_ga_ref:{ga_id:identity.ga_id,sha256:identity.ga_sha256},
  runtime_clock_amendment_sha256:fixed.runtime_clock_amendment_sha256,
  runtime_seconds:fixed.runtime_seconds,source_ref:SOURCE_REF,...overrides};
}
function clockBody(){
 const newBinding=structuredClone(CARRIED_BINDING),oldBinding=structuredClone(CLOCK_OLD_BINDING);
 return {activated_at:CLOCK_ACTIVATED,amendment_ref:{uri:AMEND_URI,sha256:clock.amendment_sha256},
  amendment_sha256:clock.amendment_sha256,automatic_retry:false,budget_raw_sha256:BUDGET_SHA,
  budget_refund:false,budget_sequence:117,finalization_expires_at:clock.finalization_expires_at,
  max_predispatch_resets:clock.max_predispatch_resets,new_binding:newBinding,
  new_binding_sha256:sha(postgresJsonbText(newBinding)),new_budget:false,new_ga:false,
  old_binding:oldBinding,old_binding_sha256:sha(postgresJsonbText(oldBinding)),
  preparation_expires_at:clock.preparation_expires_at,prior_ga_sha256:GA_SHA,
  runtime_seconds:clock.runtime_seconds};
}
function scopeBody(){
 const newBinding=structuredClone(SCOPE_NEW_BINDING),oldBinding=structuredClone(CARRIED_BINDING);
 return {activated_at:SCOPE_ACTIVATED,amendment_ref:{uri:AMEND_URI,sha256:fixed.amendment_sha256},
  amendment_sha256:fixed.amendment_sha256,applicable_test_ids:[...fixed.applicable_test_ids],
  automatic_retry:false,budget_raw_sha256:BUDGET_SHA,budget_refund:false,budget_sequence:117,
  carries_forward_sequence:fixed.carries_forward_sequence,
  control_trust_root_generation:fixed.control_trust_root_generation,
  finalization_expires_at:fixed.finalization_expires_at,max_predispatch_resets:fixed.max_predispatch_resets,
  new_binding:newBinding,new_binding_sha256:sha(postgresJsonbText(newBinding)),new_budget:false,new_ga:false,
  old_binding:oldBinding,old_binding_sha256:sha(postgresJsonbText(oldBinding)),
  out_of_scope_test_ids:[...fixed.out_of_scope_test_ids],preparation_expires_at:fixed.preparation_expires_at,
  prior_ga_sha256:GA_SHA,runtime_seconds:fixed.runtime_seconds};
}
function history(){
 const events=[];
 for(let sequence=1;sequence<=116;sequence++)events.push({root_id:ROOT,sequence,idempotency_key:'historical_'+sequence,request:{operation:'HISTORICAL',body:{}}});
 events.push({root_id:ROOT,sequence:117,idempotency_key:'root10_single_window_budget_20260915',
  request:{operation:'BUDGET_RESERVED',body:{raw:BUDGET_RAW,sha256:BUDGET_SHA}}});
 events.push({root_id:ROOT,sequence:118,idempotency_key:temporal.activation_key,
  request:{operation:temporal.activation_operation,ga_id:fixed.ga_id,body:{amendment_sha256:temporal.amendment_sha256}}});
 events.push({root_id:ROOT,sequence:clock.activation_sequence,idempotency_key:clock.activation_key,
  request:{operation:clock.activation_operation,ga_id:fixed.ga_id,expected_sequence:118,idempotency_key:clock.activation_key,body:clockBody()}});
 events.push(scopeEvent());
 return events;
}
function scopeEvent(){
 return {root_id:ROOT,sequence:fixed.activation_sequence,idempotency_key:fixed.activation_key,
  request:{operation:fixed.activation_operation,ga_id:fixed.ga_id,expected_sequence:fixed.activation_sequence-1,
   idempotency_key:fixed.activation_key,body:scopeBody()}};
}
// Named accessors so a test says which event it is rewriting, not which index.
const carriedOf=events=>events[clock.activation_sequence-1].request.body;
const scopeOf=events=>events[fixed.activation_sequence-1].request.body;
function execution({events=history(),phase='PENDING',container=null,sequence=null}={}){
 const activation=events[fixed.activation_sequence-1];
 return {current:{root_id:ROOT,sequence:sequence??events.length,active_ga_id:fixed.ga_id,
   charged_seconds:11706,charged_evidence_bytes:2604247987,pending_budget_sequence:null},
  binding:structuredClone(activation?.request?.body?.new_binding??SCOPE_NEW_BINDING),events,
  attempts:[{root_id:ROOT,ga_id:fixed.ga_id,ga_raw:GA_RAW,ga_sha256:GA_SHA,budget_sequence:117,
   phase,container_id:container,expires_at:fixed.original_deadline,revoked:false}]};
}
// The default descriptor is always built for the module being read, never for
// whichever module happened to be the usual one.
const read=(module,{descriptorValue=null,executionValue=execution(),gaRawValue=GA_RAW}={})=>
 ()=>module.readRoot10ScopeContext({gaRaw:gaRawValue,execution:executionValue,
  descriptor:descriptorValue??descriptor({},module.root10ScopeIdentity)});

// --- Effect-chain fixtures for the time check --------------------------------
const CHAIN=['INTENT_RECORDED','CREATE_SENT','CREATED','INTENT_RECORDED','START_SENT','RUNNING','STOP_SENT','STOPPED'];
function runningBody({started=STARTED,deadline=null}={}){
 const raw=JSON.stringify({observation:{State:{StartedAt:started}}})+'\n';
 return {raw,sha256:sha(raw),runtime_deadline:deadline??new Date(Date.parse(started)+fixed.runtime_seconds*1000).toISOString()};
}
function stoppedBody({state={},overrun=false,container=CONTAINER,digest=null}={}){
 const observation={Id:container,State:{Running:false,Pid:0,Status:'exited',StartedAt:STARTED,FinishedAt:FINISHED,...state}};
 const raw=JSON.stringify({ga_id:fixed.ga_id,ga_sha256:GA_SHA,container_id:container,observation})+'\n';
 return {raw,sha256:digest??sha(raw),overrun};
}
function chain(start){
 return CHAIN.map((operation,index)=>({root_id:ROOT,sequence:start+index,idempotency_key:'effect_'+(start+index),
  request:{operation,ga_id:fixed.ga_id,
   body:operation==='RUNNING'?runningBody():operation==='STOPPED'?stoppedBody():{}}}));
}
const gaEvent=(sequence,operation,body={})=>({root_id:ROOT,sequence,idempotency_key:operation.toLowerCase()+'_'+sequence,
 request:{operation,ga_id:fixed.ga_id,body}});
const resetEvent=(sequence,body={automatic_retry:false,reason:'predispatch repair'})=>gaEvent(sequence,'PREDISPATCH_RESET',body);
function ran({before=[],mutate=null,phase='STOPPED',container=CONTAINER}={}){
 const events=[...history(),...before];
 const effects=chain(events.length+1);
 if(mutate)mutate(effects);
 return execution({events:[...events,...effects],phase,container});
}
// Every time-check case reads first, so a refusal from the read names itself
// instead of hiding as an unrecognized context.
function timed(value,{operation='GRR',now=GRR_NOW,module=copy}={}){
 const context=module.readRoot10ScopeContext({gaRaw:GA_RAW,execution:value,descriptor:descriptor({},module.root10ScopeIdentity)});
 return {context,call:()=>module.checkRoot10ScopeTime({context,execution:value,operation,now})};
}

// --- Accepting path ----------------------------------------------------------
test('01 a valid scope context is accepted',()=>{
 const context=expectPass(read(copy),'01');
 if(context.state!=='SCOPE_SEMANTICS_ONLY_NOT_AUTHORITY')throw Error('unexpected state '+context.state);
 if(context.authority_effect!=='NONE')throw Error('a scope context must never carry authority');
 if(context.execution_baseline_sequence!==fixed.activation_sequence)throw Error('baseline must be the activation sequence');
 if(context.runtimeSeconds!==fixed.runtime_seconds||context.resets!==0)throw Error('carried runtime terms changed');
 if(context.applicable_test_ids.length!==5||context.applicable_test_ids.join()!==fixed.applicable_test_ids.join())throw Error('applicable set changed');
 if(context.issued!==Date.parse(SCOPE_ACTIVATED)||context.prep!==Date.parse(fixed.preparation_expires_at)||context.final!==Date.parse(fixed.finalization_expires_at))throw Error('derived window changed');
 if(!Object.isFrozen(context))throw Error('a scope context must be frozen');
});
test('02 a widened preparation/finalization window is accepted (extend only)',()=>{
 // Event 119 and event 120 now close at the same instant. An earlier revision of this
 // amendment moved the window to 2026-10-15 and was withdrawn: validateRootShape requires
 // the controller contract window to EQUAL the signed trust root generation's, and that
 // generation ends 2026-09-16T03:00:00Z. So equality is the shape the live amendment uses.
 //
 // The extend-only rule is still live and still has to be tested, so 02a moves the CARRIED
 // window earlier to exercise admission of a later one. 02b is the live shape, equality.
 const events=history(),carried=carriedOf(events);
 carried.preparation_expires_at='2026-09-15T12:00:00Z';
 carried.finalization_expires_at='2026-09-15T12:00:00Z';
 if(Date.parse(fixed.preparation_expires_at)<=Date.parse(carried.preparation_expires_at))throw Error('fixture no longer widens the carried window');
 expectPass(read(copy,{executionValue:execution({events})}),'02a');
 const equalEvents=history(),equalCarried=carriedOf(equalEvents);
 equalCarried.preparation_expires_at=fixed.preparation_expires_at;
 equalCarried.finalization_expires_at=fixed.finalization_expires_at;
 expectPass(read(copy,{executionValue:execution({events:equalEvents})}),'02b');
});

// --- Carry-forward of event 119's runtime clock ------------------------------
test('03 an EARLIER window than event 119 is refused',()=>{
 const preparation=history();carriedOf(preparation).preparation_expires_at='2026-11-01T03:00:00Z';
 expectThrow(read(copy,{executionValue:execution({events:preparation})}),'SCOPE_MUST_CARRY_RUNTIME_CLOCK_FORWARD','03a');
 const finalization=history();carriedOf(finalization).finalization_expires_at='2026-11-01T03:00:00Z';
 expectThrow(read(copy,{executionValue:execution({events:finalization})}),'SCOPE_MUST_CARRY_RUNTIME_CLOCK_FORWARD','03b');
});
test('04 a changed runtime_seconds is refused',()=>{
 const shorter=history();carriedOf(shorter).runtime_seconds=599;
 expectThrow(read(copy,{executionValue:execution({events:shorter})}),'SCOPE_MUST_CARRY_RUNTIME_CLOCK_FORWARD','04a');
 const longer=history();carriedOf(longer).runtime_seconds=601;
 expectThrow(read(copy,{executionValue:execution({events:longer})}),'SCOPE_MUST_CARRY_RUNTIME_CLOCK_FORWARD','04b');
});
test('05 a raised max_predispatch_resets is refused',()=>{
 // Event 119 allowed 2; event 120 claiming 3 would hand back a reset.
 const raised=history();carriedOf(raised).max_predispatch_resets=2;
 expectThrow(read(copy,{executionValue:execution({events:raised})}),'SCOPE_MUST_CARRY_RUNTIME_CLOCK_FORWARD','05a');
 const budget=history();carriedOf(budget).budget_raw_sha256=OTHER_DIGEST;
 expectThrow(read(copy,{executionValue:execution({events:budget})}),'SCOPE_MUST_CARRY_RUNTIME_CLOCK_FORWARD','05b');
 const sequence=history();carriedOf(sequence).budget_sequence=118;
 expectThrow(read(copy,{executionValue:execution({events:sequence})}),'SCOPE_MUST_CARRY_RUNTIME_CLOCK_FORWARD','05c');
});
test('06 old_binding that is not event 119 new_binding is refused',()=>{
 const events=history();carriedOf(events).new_binding.prior_seconds=0;
 expectThrow(read(copy,{executionValue:execution({events})}),'SCOPE_OLD_BINDING_IS_RUNTIME_CLOCK_NEW_BINDING','06a');
 const other=history();carriedOf(other).new_binding=structuredClone(CLOCK_OLD_BINDING);
 expectThrow(read(copy,{executionValue:execution({events:other})}),'SCOPE_OLD_BINDING_IS_RUNTIME_CLOCK_NEW_BINDING','06b');
});
test('07 a scope event with no valid event 119 is refused',()=>{
 const absent=history();absent[clock.activation_sequence-1].request.operation='SOMETHING_ELSE';
 expectThrow(read(copy,{executionValue:execution({events:absent})}),'SCOPE_REQUIRES_ACCEPTED_RUNTIME_CLOCK','07a');
 const rekeyed=history();rekeyed[clock.activation_sequence-1].request.idempotency_key='rewritten';
 expectThrow(read(copy,{executionValue:execution({events:rekeyed})}),'SCOPE_REQUIRES_ACCEPTED_RUNTIME_CLOCK','07b');
 const wrongAmendment=history();carriedOf(wrongAmendment).amendment_sha256=OTHER_DIGEST;
 expectThrow(read(copy,{executionValue:execution({events:wrongAmendment})}),'SCOPE_REQUIRES_ACCEPTED_RUNTIME_CLOCK','07c');
 const foreignGa=history();foreignGa[clock.activation_sequence-1].request.ga_id='ga_ffffffffffffffffffffffffffffffff';
 expectThrow(read(copy,{executionValue:execution({events:foreignGa})}),'SCOPE_REQUIRES_ACCEPTED_RUNTIME_CLOCK','07d');
});

// --- Descriptor and event shape rules ---------------------------------------
test('08 a descriptor naming a different amendment digest is refused',()=>{
 expectThrow(read(copy,{descriptorValue:descriptor({amendment_ref:{uri:AMEND_URI,sha256:OTHER_DIGEST}})}),'EXACT_SCOPE_ACTIVATION_CONTRACT','08a');
 expectThrow(read(copy,{descriptorValue:descriptor({activation_operation:clock.activation_operation})}),'EXACT_SCOPE_ACTIVATION_CONTRACT','08b');
 expectThrow(read(copy,{descriptorValue:descriptor({activation_idempotency_key:clock.activation_key})}),'EXACT_SCOPE_ACTIVATION_CONTRACT','08c');
 expectThrow(read(copy,{descriptorValue:descriptor({expected_activation_sequence:clock.activation_sequence})}),'EXACT_SCOPE_ACTIVATION_CONTRACT','08d');
});
test('09 a truncated or non-contiguous event history is refused',()=>{
 const truncated=history();truncated.pop();
 expectThrow(read(copy,{executionValue:execution({events:truncated,sequence:fixed.activation_sequence})}),'EXACT_COMPLETE_SCOPE_EVENT_HISTORY','09a');
 const short=history();
 expectThrow(read(copy,{executionValue:execution({events:short,sequence:fixed.activation_sequence+1})}),'EXACT_COMPLETE_SCOPE_EVENT_HISTORY','09b');
 const gapped=history();gapped[80].sequence=999;
 expectThrow(read(copy,{executionValue:execution({events:gapped})}),'EXACT_COMPLETE_SCOPE_EVENT_HISTORY','09c');
 const reordered=history();const moved=reordered[40];reordered[40]=reordered[41];reordered[41]=moved;
 expectThrow(read(copy,{executionValue:execution({events:reordered})}),'EXACT_COMPLETE_SCOPE_EVENT_HISTORY','09d');
});
test('10 two SCOPE_AMENDMENT_ACTIVATED events are refused',()=>{
 const events=history();const duplicate=scopeEvent();
 duplicate.sequence=fixed.activation_sequence+1;duplicate.request.expected_sequence=fixed.activation_sequence;
 events.push(duplicate);
 expectThrow(read(copy,{executionValue:execution({events})}),'ONE_EXACT_SCOPE_ACTIVATION_EVENT','10a');
 // One event, but not at the contracted sequence, is equally refused.
 const displaced=history();const activation=displaced[fixed.activation_sequence-1];
 displaced[fixed.activation_sequence-1]={root_id:ROOT,sequence:fixed.activation_sequence,idempotency_key:'filler',request:{operation:'HISTORICAL',body:{}}};
 activation.sequence=fixed.activation_sequence+1;activation.request.expected_sequence=fixed.activation_sequence;
 displaced.push(activation);
 expectThrow(read(copy,{executionValue:execution({events:displaced})}),'ONE_EXACT_SCOPE_ACTIVATION_EVENT','10b');
});
test('11 any authority boolean set true is refused',()=>{
 for(const key of ['automatic_retry','budget_refund','new_budget','new_ga']){
  const events=history();scopeOf(events)[key]=true;
  expectThrow(read(copy,{executionValue:execution({events})}),'NO_SCOPE_BUDGET_OR_GA_EFFECT','11-body-'+key);
 }
 for(const key of ['no_automatic_retry','no_new_budget','no_new_ga','no_refund']){
  expectThrow(read(copy,{descriptorValue:descriptor({[key]:false})}),'NO_SCOPE_BUDGET_OR_GA_EFFECT','11-descriptor-'+key);
 }
});
test('12 a changed applicable/out-of-scope id list is refused',()=>{
 expectThrow(read(copy,{descriptorValue:descriptor({applicable_test_ids:fixed.applicable_test_ids.slice(1)})}),'EXACT_SCOPE_APPLICABLE_SET','12a');
 expectThrow(read(copy,{descriptorValue:descriptor({applicable_test_ids:[...fixed.applicable_test_ids,fixed.out_of_scope_test_ids[0]]})}),'EXACT_SCOPE_APPLICABLE_SET','12b');
 expectThrow(read(copy,{descriptorValue:descriptor({applicable_test_ids:[...fixed.applicable_test_ids].reverse()})}),'EXACT_SCOPE_APPLICABLE_SET','12c');
 expectThrow(read(copy,{descriptorValue:descriptor({out_of_scope_test_ids:fixed.out_of_scope_test_ids.slice(0,-1)})}),'EXACT_SCOPE_APPLICABLE_SET','12d');
 // PQUAL-18 is a negative guard and belongs in neither list.
 expectThrow(read(copy,{descriptorValue:descriptor({out_of_scope_test_ids:[...fixed.out_of_scope_test_ids,'PQUAL-18']})}),'EXACT_SCOPE_APPLICABLE_SET','12e');
});
test('13 a moved charged counter is refused',()=>{
 for(const [key,value] of [['charged_seconds',11707],['charged_seconds',11705],['charged_evidence_bytes',2604247988],['charged_evidence_bytes',2604247986]]){
  const executionValue=execution();executionValue.current[key]=value;
  expectThrow(read(copy,{executionValue}),'SCOPE_CUMULATIVE_CHARGES_UNCHANGED','13-'+key+'-'+value);
 }
});
test('14 a body key set that is not exactly scBodyKeys is refused',()=>{
 const missing=history();delete scopeOf(missing).control_trust_root_generation;
 expectThrow(read(copy,{executionValue:execution({events:missing})}),'EXACT_SCOPE_ACTIVATION_EVENT','14a');
 const extra=history();scopeOf(extra).effect_deadline=SCOPE_ACTIVATED;
 expectThrow(read(copy,{executionValue:execution({events:extra})}),'EXACT_SCOPE_ACTIVATION_EVENT','14b');
 const renamed=history();const body=scopeOf(renamed);body.applicable_tests=body.applicable_test_ids;delete body.applicable_test_ids;
 expectThrow(read(copy,{executionValue:execution({events:renamed})}),'EXACT_SCOPE_ACTIVATION_EVENT','14c');
 const request=history();request[fixed.activation_sequence-1].request.note='extra';
 expectThrow(read(copy,{executionValue:execution({events:request})}),'EXACT_SCOPE_ACTIVATION_EVENT','14d');
 const expected=history();expected[fixed.activation_sequence-1].request.expected_sequence=fixed.activation_sequence;
 expectThrow(read(copy,{executionValue:execution({events:expected})}),'EXACT_SCOPE_ACTIVATION_EVENT','14e');
 const key=history();key[fixed.activation_sequence-1].idempotency_key='rewritten';
 expectThrow(read(copy,{executionValue:execution({events:key})}),'EXACT_SCOPE_ACTIVATION_EVENT','14f');
});

// --- Time-check surface ------------------------------------------------------
test('15 CREATE and START past the preparation window are refused',()=>{
 const value=execution();
 for(const operation of ['CREATE','START']){
  const open=timed(value,{operation,now:Date.parse(SCOPE_ACTIVATED)+1000});
  const allowed=expectPass(open.call,'15-open-'+operation);
  if(allowed.preparation_expires_at!==Date.parse(fixed.preparation_expires_at))throw Error('preparation bound changed');
  if(allowed.authority_effect!=='NONE')throw Error('a time check must never carry authority');
  expectThrow(timed(value,{operation,now:Date.parse(fixed.preparation_expires_at)}).call,'SCOPE_PREPARATION_WINDOW_EXPIRED','15-edge-'+operation);
  expectThrow(timed(value,{operation,now:Date.parse(fixed.preparation_expires_at)+60000}).call,'SCOPE_PREPARATION_WINDOW_EXPIRED','15-past-'+operation);
 }
});
test('16 STOP is never refused on a clock',()=>{
 const value=execution({phase:'RUNNING',container:CONTAINER});
 for(const now of [Date.parse(SCOPE_ACTIVATED),Date.parse(fixed.preparation_expires_at)+1,Date.parse(fixed.finalization_expires_at)+30*86400000]){
  const stopped=expectPass(timed(value,{operation:'STOP',now}).call,'16-'+now);
  if(stopped.stop_never_clock_refused!==true)throw Error('STOP must report that no clock refused it');
  if(stopped.authority_effect!=='NONE')throw Error('STOP must not carry authority');
 }
});
test('17 GRR past the finalization window is refused',()=>{
 const value=ran();
 expectThrow(timed(value,{now:Date.parse(fixed.finalization_expires_at)}).call,'SCOPE_FINALIZATION_WINDOW_EXPIRED','17a');
 expectThrow(timed(value,{now:Date.parse(fixed.finalization_expires_at)+1}).call,'SCOPE_FINALIZATION_WINDOW_EXPIRED','17b');
 // An unknown operation falls through to the same guarded branch.
 expectThrow(timed(value,{operation:'PROMOTE'}).call,'SCOPE_FINALIZATION_WINDOW_EXPIRED','17c');
});
test('18 an overrun STOPPED is refused',()=>{
 const value=ran({mutate:effects=>{effects[7].request.body=stoppedBody({overrun:true});}});
 expectThrow(timed(value).call,'OVERRUN_RUN_CANNOT_PASS','18a');
 const missing=ran({mutate:effects=>{delete effects[7].request.body.overrun;}});
 expectThrow(timed(missing).call,'OVERRUN_RUN_CANNOT_PASS','18b');
});

// --- The two pins, and the copy that stands in for them ----------------------
test('19 the controller GA byte pin refuses synthetic bytes',()=>{
 // On the real controller nothing synthetic can reach a context; this is the
 // rule that makes the pin-substituted copy necessary, and it is live. The
 // state is first restated against the REAL pins everywhere a digest is only
 // compared -- the descriptor via `read`, which builds it for the module it is
 // reading, and the event body here -- so the GA byte pin, which compares bytes
 // and cannot be talked around, is the first rule left that can refuse.
 const events=history();
 scopeOf(events).prior_ga_sha256=fixed.ga_sha256;
 scopeOf(events).budget_raw_sha256=fixed.budget_sha256;
 carriedOf(events).budget_raw_sha256=fixed.budget_sha256;
 const value=execution({events});value.attempts[0].ga_sha256=fixed.ga_sha256;
 expectThrow(read(controller,{executionValue:value}),'EXACT_UNCHANGED_SCOPE_GA_BYTES','19a');
 // The same rule on the copy: bytes that do not hash to its pin are refused.
 expectThrow(read(copy,{gaRawValue:GA_RAW+' '}),'EXACT_UNCHANGED_SCOPE_GA_BYTES','19b');
 expectThrow(read(copy,{gaRawValue:null}),'EXACT_UNCHANGED_SCOPE_GA_BYTES','19c');
});

// --- Remaining descriptor rules ---------------------------------------------
test('20 a descriptor whose key set is not exactly scDescriptorKeys is refused',()=>{
 const missing=descriptor();delete missing.carries_forward_sequence;
 expectThrow(read(copy,{descriptorValue:missing}),'EXACT_SCOPE_DESCRIPTOR','20a');
 const extra=descriptor();extra.effect_seconds=600;
 expectThrow(read(copy,{descriptorValue:extra}),'EXACT_SCOPE_DESCRIPTOR','20b');
 const missingIds=descriptor();delete missingIds.out_of_scope_test_ids;
 expectThrow(read(copy,{descriptorValue:missingIds}),'EXACT_SCOPE_DESCRIPTOR','20c');
});
test('21 the continuation controller must move forward',()=>{
 expectThrow(read(copy,{descriptorValue:descriptor({continuation_controller_sha256:fixed.predecessor_controller_sha256})}),'EXACT_SCOPE_CONTROLLER_FORWARD','21a');
 // The ORIGINAL Root10 controller predates both amendments, so naming it as the
 // continuation moves the binding backwards while reading as a forward step.
 expectThrow(read(copy,{descriptorValue:descriptor({continuation_controller_sha256:fixed.original_controller_sha256})}),'EXACT_SCOPE_CONTROLLER_FORWARD','21d');
 expectThrow(read(copy,{descriptorValue:descriptor({continuation_controller_sha256:'not-a-digest'})}),'EXACT_SCOPE_CONTROLLER_FORWARD','21b');
 expectThrow(read(copy,{descriptorValue:descriptor({predecessor_controller_sha256:clock.predecessor_controller_sha256})}),'EXACT_SCOPE_CONTROLLER_FORWARD','21c');
});
test('22 the descriptor must name event 119 as what it carries forward',()=>{
 expectThrow(read(copy,{descriptorValue:descriptor({runtime_clock_amendment_sha256:OTHER_DIGEST})}),'EXACT_SCOPE_CARRIES_FORWARD_RUNTIME_CLOCK','22a');
 expectThrow(read(copy,{descriptorValue:descriptor({runtime_clock_amendment_sha256:fixed.amendment_sha256})}),'EXACT_SCOPE_CARRIES_FORWARD_RUNTIME_CLOCK','22b');
 expectThrow(read(copy,{descriptorValue:descriptor({carries_forward_sequence:118})}),'EXACT_SCOPE_CARRIES_FORWARD_RUNTIME_CLOCK','22c');
});
test('23 the descriptor must name the original GA and the reserved budget',()=>{
 // A descriptor that names any other GA or any other budget is refused before
 // the byte pin is reached, so this rule is provable on its own.
 const identity=copy.root10ScopeIdentity;
 expectThrow(read(copy,{descriptorValue:descriptor({prior_ga_ref:{ga_id:'ga_ffffffffffffffffffffffffffffffff',sha256:identity.ga_sha256}})}),'EXACT_SCOPE_GA_AND_BUDGET_REF','23a');
 expectThrow(read(copy,{descriptorValue:descriptor({prior_ga_ref:{ga_id:identity.ga_id,sha256:OTHER_DIGEST}})}),'EXACT_SCOPE_GA_AND_BUDGET_REF','23b');
 // The controller's own GA digest is still the wrong answer for this module.
 expectThrow(read(copy,{descriptorValue:descriptor({prior_ga_ref:{ga_id:identity.ga_id,sha256:fixed.ga_sha256}})}),'EXACT_SCOPE_GA_AND_BUDGET_REF','23c');
 expectThrow(read(copy,{descriptorValue:descriptor({budget_ref:{sequence:117,sha256:OTHER_DIGEST,seconds:600,evidence_bytes:134217728}})}),'EXACT_SCOPE_GA_AND_BUDGET_REF','23d');
 expectThrow(read(copy,{descriptorValue:descriptor({prior_ga_ref:{ga_id:identity.ga_id}})}),'EXACT_SCOPE_GA_AND_BUDGET_REF','23e');
 expectThrow(read(copy,{descriptorValue:descriptor({budget_ref:null})}),'EXACT_SCOPE_GA_AND_BUDGET_REF','23f');
});
test('24 window terms are fixed in both the descriptor and the event body',()=>{
 for(const [key,value] of [['preparation_expires_at','2026-11-15T03:00:00Z'],['finalization_expires_at','2026-11-15T03:00:00Z'],['runtime_seconds',601],['max_predispatch_resets',4]]){
  expectThrow(read(copy,{descriptorValue:descriptor({[key]:value})}),'EXACT_SCOPE_WINDOW_TERMS','24-descriptor-'+key);
  const events=history();scopeOf(events)[key]=value;
  expectThrow(read(copy,{executionValue:execution({events})}),'EXACT_SCOPE_EVENT_WINDOW_TERMS','24-body-'+key);
 }
});
test('25 the event body applicable set and generation are fixed',()=>{
 const dropped=history();const body=scopeOf(dropped);body.applicable_test_ids=body.applicable_test_ids.slice(1);
 expectThrow(read(copy,{executionValue:execution({events:dropped})}),'EXACT_SCOPE_EVENT_APPLICABLE_SET','25a');
 const widened=history();scopeOf(widened).out_of_scope_test_ids=fixed.out_of_scope_test_ids.slice(1);
 expectThrow(read(copy,{executionValue:execution({events:widened})}),'EXACT_SCOPE_EVENT_APPLICABLE_SET','25b');
 const generation=history();scopeOf(generation).control_trust_root_generation='ctrgen_00000000000000000000000000000000';
 expectThrow(read(copy,{executionValue:execution({events:generation})}),'EXACT_SCOPE_EVENT_APPLICABLE_SET','25c');
 const carries=history();scopeOf(carries).carries_forward_sequence=118;
 expectThrow(read(copy,{executionValue:execution({events:carries})}),'EXACT_SCOPE_EVENT_APPLICABLE_SET','25d');
});
test('26 the event must bind to this root, amendment, GA and budget',()=>{
 const root=history();root[fixed.activation_sequence-1].root_id='ctr_00000000000000000000000000000000';
 expectThrow(read(copy,{executionValue:execution({events:root})}),'EXACT_SCOPE_EVENT_BINDINGS','26a');
 const amendment=history();scopeOf(amendment).amendment_ref={uri:AMEND_URI.slice(0,-1)+'0',sha256:fixed.amendment_sha256};
 expectThrow(read(copy,{executionValue:execution({events:amendment})}),'EXACT_SCOPE_EVENT_BINDINGS','26b');
 const digest=history();scopeOf(digest).amendment_sha256=OTHER_DIGEST;
 expectThrow(read(copy,{executionValue:execution({events:digest})}),'EXACT_SCOPE_EVENT_BINDINGS','26c');
 const priorGa=history();scopeOf(priorGa).prior_ga_sha256=OTHER_DIGEST;
 expectThrow(read(copy,{executionValue:execution({events:priorGa})}),'EXACT_SCOPE_EVENT_BINDINGS','26d');
 const budget=history();scopeOf(budget).budget_sequence=118;
 expectThrow(read(copy,{executionValue:execution({events:budget})}),'EXACT_SCOPE_EVENT_BINDINGS','26e');
 const budgetBytes=history();scopeOf(budgetBytes).budget_raw_sha256=OTHER_DIGEST;
 expectThrow(read(copy,{executionValue:execution({events:budgetBytes})}),'EXACT_SCOPE_EVENT_BINDINGS','26f');
});
test('27 the binding may change only the three accepted columns',()=>{
 const fourth=history();scopeOf(fourth).new_binding.prior_seconds=0;
 expectThrow(read(copy,{executionValue:execution({events:fourth})}),'ONLY_ACCEPTED_SCOPE_BINDING_COLUMNS_CHANGE','27a');
 const unmoved=history();scopeOf(unmoved).new_binding.controller_sha256=fixed.predecessor_controller_sha256;
 expectThrow(read(copy,{executionValue:execution({events:unmoved})}),'ONLY_ACCEPTED_SCOPE_BINDING_COLUMNS_CHANGE','27b');
 // An old binding that is not the accepted predecessor triple, carried forward
 // consistently from event 119 so the carry-forward rule is not what fires.
 const wrongOld=history();const substitute=binding(NEW_CONTROLLER,fixed.predecessor_qualification_sha256,fixed.predecessor_runtime_acceptance_sha256);
 carriedOf(wrongOld).new_binding=structuredClone(substitute);
 scopeOf(wrongOld).old_binding=structuredClone(substitute);
 expectThrow(read(copy,{executionValue:execution({events:wrongOld})}),'ONLY_ACCEPTED_SCOPE_BINDING_COLUMNS_CHANGE','27c');
 const preimage=history();scopeOf(preimage).new_binding_sha256=OTHER_DIGEST;
 expectThrow(read(copy,{executionValue:execution({events:preimage})}),'EXACT_SCOPE_BINDING_PREIMAGE_AND_CURRENT','27d');
 const oldPreimage=history();scopeOf(oldPreimage).old_binding_sha256=OTHER_DIGEST;
 expectThrow(read(copy,{executionValue:execution({events:oldPreimage})}),'EXACT_SCOPE_BINDING_PREIMAGE_AND_CURRENT','27e');
 const current=execution();current.binding=structuredClone(CARRIED_BINDING);
 expectThrow(read(copy,{executionValue:current}),'EXACT_SCOPE_BINDING_PREIMAGE_AND_CURRENT','27f');
});
test('28 no pre-118 event may carry this GA',()=>{
 const events=history();events[50].request.ga_id=fixed.ga_id;
 expectThrow(read(copy,{executionValue:execution({events})}),'SCOPE_ZERO_PRIOR_GA_EFFECT','28a');
 const budget=history();budget[116].request.ga_id=fixed.ga_id;
 expectThrow(read(copy,{executionValue:execution({events:budget})}),'SCOPE_ZERO_PRIOR_GA_EFFECT','28b');
});
test('29 the original GA, attempt and budget stay unchanged',()=>{
 // Reachable only against a copy pinned to these moved GA bytes; on any other
 // pin the byte check fires first, which is itself the point of the byte check.
 const events=history();scopeOf(events).prior_ga_sha256=sha(MOVED_GA_RAW);
 const value=execution({events});
 value.attempts[0].ga_raw=MOVED_GA_RAW;value.attempts[0].ga_sha256=sha(MOVED_GA_RAW);
 expectThrow(read(movedCopy,{executionValue:value,gaRawValue:MOVED_GA_RAW}),'ORIGINAL_GA_CLOCK_IMMUTABLE','29a');
 const revoked=execution();revoked.attempts[0].revoked=true;
 expectThrow(read(copy,{executionValue:revoked}),'ORIGINAL_SCOPE_ATTEMPT_UNCHANGED','29b');
 const moved=execution();moved.attempts[0].expires_at=fixed.preparation_expires_at;
 expectThrow(read(copy,{executionValue:moved}),'ORIGINAL_SCOPE_ATTEMPT_UNCHANGED','29c');
 const rebudgeted=execution();rebudgeted.attempts[0].budget_sequence=118;
 expectThrow(read(copy,{executionValue:rebudgeted}),'ORIGINAL_SCOPE_ATTEMPT_UNCHANGED','29d');
 const twice=execution();twice.attempts.push({...twice.attempts[0]});
 expectThrow(read(copy,{executionValue:twice}),'ORIGINAL_SCOPE_ATTEMPT_UNCHANGED','29e');
 const budgetBytes=history();budgetBytes[116].request.body.raw=BUDGET_RAW+' ';
 expectThrow(read(copy,{executionValue:execution({events:budgetBytes})}),'ORIGINAL_SCOPE_BUDGET_UNCHANGED','29f');
 const budgetOperation=history();budgetOperation[116].request.operation='HISTORICAL';
 expectThrow(read(copy,{executionValue:execution({events:budgetOperation})}),'ORIGINAL_SCOPE_BUDGET_UNCHANGED','29g');
 const shared=execution();shared.attempts.push({...shared.attempts[0],ga_id:'ga_ffffffffffffffffffffffffffffffff'});
 expectThrow(read(copy,{executionValue:shared}),'ORIGINAL_SCOPE_BUDGET_UNCHANGED','29h');
});
test('30 the derived window is taken from the database, not from prose',()=>{
 const before=history();scopeOf(before).activated_at='2026-09-15T14:00:00.000000+00:00';
 expectThrow(read(copy,{executionValue:execution({events:before})}),'EXACT_DATABASE_DERIVED_SCOPE_WINDOW','30a');
 const past=history();scopeOf(past).activated_at='2026-11-01T00:00:00.000000+00:00';
 expectThrow(read(copy,{executionValue:execution({events:past})}),'EXACT_DATABASE_DERIVED_SCOPE_WINDOW','30b');
 const offset=history();scopeOf(offset).activated_at='2026-09-15T17:00:00.000000+01:00';
 expectThrow(read(copy,{executionValue:execution({events:offset})}),'EXACT_DATABASE_DERIVED_SCOPE_WINDOW','30c');
 const unparsable=history();scopeOf(unparsable).activated_at='shortly after approval';
 expectThrow(read(copy,{executionValue:execution({events:unparsable})}),'EXACT_DATABASE_DERIVED_SCOPE_WINDOW','30d');
});
test('31 the reset bound and the one-run rule are carried forward, not reset',()=>{
 const bounded=[121,122,123,124].map(sequence=>resetEvent(sequence));
 expectThrow(read(copy,{executionValue:execution({events:[...history(),...bounded]})}),'BOUNDED_PREDISPATCH_RESETS','31a');
 const retrying=[resetEvent(121,{automatic_retry:true,reason:'retry'})];
 expectThrow(read(copy,{executionValue:execution({events:[...history(),...retrying]})}),'EXACT_ZERO_EFFECT_RESET_EVENT','31b');
 const unexplained=[resetEvent(121,{automatic_retry:false,reason:''})];
 expectThrow(read(copy,{executionValue:execution({events:[...history(),...unexplained]})}),'EXACT_ZERO_EFFECT_RESET_EVENT','31c');
 const verbose=[resetEvent(121,{automatic_retry:false,reason:'x'.repeat(201)})];
 expectThrow(read(copy,{executionValue:execution({events:[...history(),...verbose]})}),'EXACT_ZERO_EFFECT_RESET_EVENT','31d');
 const afterRun=[gaEvent(121,'RUNNING',runningBody()),resetEvent(122)];
 expectThrow(read(copy,{executionValue:execution({events:[...history(),...afterRun]})}),'RESET_ONLY_BEFORE_ANY_RUN','31e');
 const twice=[gaEvent(121,'RUNNING',runningBody()),gaEvent(122,'RUNNING',runningBody())];
 expectThrow(read(copy,{executionValue:execution({events:[...history(),...twice]})}),'ONE_RUNTIME_INTERVAL_ONLY','31f');
 // Three resets before any run remain admissible: the bound is 3, not 0.
 expectPass(read(copy,{executionValue:execution({events:[...history(),resetEvent(121),resetEvent(122),resetEvent(123)]})}),'31g');
});
test('32 only a context this module issued is recognized',()=>{
 const value=ran();
 const {context}=timed(value);
 expectThrow(()=>copy.checkRoot10ScopeTime({context:{issued:0,prep:1,final:2},execution:value,operation:'CREATE',now:Date.now()}),'RECOGNIZED_SCOPE_CONTEXT_AND_REAL_CLOCK','32a');
 // A structural copy of a real context is still not a context.
 expectThrow(()=>copy.checkRoot10ScopeTime({context:{...context},execution:value,operation:'CREATE',now:GRR_NOW}),'RECOGNIZED_SCOPE_CONTEXT_AND_REAL_CLOCK','32b');
 expectThrow(()=>copy.checkRoot10ScopeTime({context,execution:value,operation:'CREATE',now:context.issued-1}),'RECOGNIZED_SCOPE_CONTEXT_AND_REAL_CLOCK','32c');
 expectThrow(()=>copy.checkRoot10ScopeTime({context,execution:value,operation:'CREATE',now:Number.NaN}),'RECOGNIZED_SCOPE_CONTEXT_AND_REAL_CLOCK','32d');
 // Contexts do not cross module instances either.
 expectThrow(()=>movedCopy.checkRoot10ScopeTime({context,execution:value,operation:'CREATE',now:GRR_NOW}),'RECOGNIZED_SCOPE_CONTEXT_AND_REAL_CLOCK','32e');
});
test('33 a complete effect chain finalizes, with or without a spent reset',()=>{
 const clean=expectPass(timed(ran()).call,'33a');
 if(clean.finalization_expires_at!==Date.parse(fixed.finalization_expires_at))throw Error('finalization bound changed');
 if(clean.authority_effect!=='NONE')throw Error('finalization must never carry authority');
 const repaired=ran({before:[gaEvent(121,'INTENT_RECORDED'),resetEvent(122)]});
 expectPass(timed(repaired).call,'33b');
 const signing=ran({mutate:effects=>{effects.push(gaEvent(effects.at(-1).sequence+1,'DECISION_RESERVED'));},phase:'DECISION_RESERVED'});
 expectPass(timed(signing).call,'33c');
});
test('34 the effect chain must be complete, ordered and the only round with effect',()=>{
 const broken=ran({mutate:effects=>{effects[6].request.operation='NOTE_RECORDED';}});
 expectThrow(timed(broken).call,'ONE_COMPLETE_SCOPE_EFFECT_CHAIN','34a');
 const swapped=ran({mutate:effects=>{const operation=effects[4].request.operation;effects[4].request.operation=effects[5].request.operation;effects[5].request.operation=operation;}});
 expectThrow(timed(swapped).call,'ONE_COMPLETE_SCOPE_EFFECT_CHAIN','34b');
 const gapped=ran({mutate:effects=>{effects[3].request.operation='NOTE_RECORDED';}});
 expectThrow(timed(gapped).call,'ONE_COMPLETE_SCOPE_EFFECT_CHAIN','34c');
 // An earlier round that reserved a decision before a reset is zero-effect only.
 const earlier=ran({before:[gaEvent(121,'DECISION_RESERVED'),resetEvent(122)]});
 expectThrow(timed(earlier).call,'EARLIER_ROUNDS_ZERO_EFFECT_ONLY','34d');
});
test('35 the runtime deadline and the real stop are both checked',()=>{
 const drifted=ran({mutate:effects=>{effects[5].request.body=runningBody({deadline:'2026-09-15T16:20:00.000Z'});}});
 expectThrow(timed(drifted).call,'EXACT_IMMUTABLE_RUNTIME_DEADLINE','35a');
 const untyped=ran({mutate:effects=>{effects[5].request.body.runtime_deadline=Date.parse(STARTED)+600000;}});
 expectThrow(timed(untyped).call,'EXACT_IMMUTABLE_RUNTIME_DEADLINE','35b');
 const rewritten=ran({mutate:effects=>{effects[5].request.body.raw+=' ';}});
 expectThrow(timed(rewritten).call,'EXACT_IMMUTABLE_RUNTIME_DEADLINE','35c');
 const running=ran({mutate:effects=>{effects[7].request.body=stoppedBody({state:{Running:true}});}});
 expectThrow(timed(running).call,'EXACT_SCOPE_REAL_STOP','35d');
 const alive=ran({mutate:effects=>{effects[7].request.body=stoppedBody({state:{Pid:41}});}});
 expectThrow(timed(alive).call,'EXACT_SCOPE_REAL_STOP','35e');
 const unexited=ran({mutate:effects=>{effects[7].request.body=stoppedBody({state:{Status:'running'}});}});
 expectThrow(timed(unexited).call,'EXACT_SCOPE_REAL_STOP','35f');
 const wrongContainer=ran({mutate:effects=>{effects[7].request.body=stoppedBody({container:'b'.repeat(64)});}});
 expectThrow(timed(wrongContainer).call,'EXACT_SCOPE_REAL_STOP','35g');
 const unsigned=ran({mutate:effects=>{effects[7].request.body=stoppedBody({digest:OTHER_DIGEST});}});
 expectThrow(timed(unsigned).call,'EXACT_SCOPE_REAL_STOP','35h');
});
test('36 the observed interval must fit the budget and the attempt must be stopped',()=>{
 const overlong=ran({mutate:effects=>{effects[7].request.body=stoppedBody({state:{FinishedAt:'2026-09-15T16:16:00.000Z'}});}});
 expectThrow(timed(overlong).call,'RUNTIME_INTERVAL_WITHIN_BUDGET','36a');
 const backwards=ran({mutate:effects=>{effects[7].request.body=stoppedBody({state:{FinishedAt:'2026-09-15T16:04:00.000Z'}});}});
 expectThrow(timed(backwards).call,'RUNTIME_INTERVAL_WITHIN_BUDGET','36b');
 const early=ran({mutate:effects=>{effects[7].request.body=stoppedBody({state:{StartedAt:'2026-09-15T15:30:00.000Z'}});}});
 expectThrow(timed(early).call,'RUNTIME_INTERVAL_WITHIN_BUDGET','36c');
 const unfinished=ran({phase:'RUNNING'});
 expectThrow(timed(unfinished).call,'REAL_STOP_REQUIRED_FOR_SCOPE_FINALIZATION','36d');
});

// --- Harness guarantees ------------------------------------------------------
test('37 an absent descriptor reads as null and the pin-substituted copy is faithful',()=>{
 if(controller.readRoot10ScopeContext({gaRaw:GA_RAW,execution:execution(),descriptor:null})!==null)throw Error('null descriptor must not create a context');
 if(copy.readRoot10ScopeContext({gaRaw:GA_RAW,execution:execution(),descriptor:undefined})!==null)throw Error('undefined descriptor must not create a context');
 // Substituting the two pins back reproduces the controller byte for byte, so
 // every other rule exercised above is the controller's own unmodified code.
 const restored=PATCHED.split(GA_SHA).join(fixed.ga_sha256).split(BUDGET_SHA).join(fixed.budget_sha256);
 if(restored!==SOURCE)throw Error('the copy differs from the controller in more than the two pinned digests');
 if(copy.root10ScopeIdentity.activation_operation!==fixed.activation_operation||copy.root10ScopeIdentity.activation_sequence!==fixed.activation_sequence)throw Error('the copy no longer carries the scope identity');
 if(copy.root10ScopeIdentity.ga_sha256!==GA_SHA||copy.root10ScopeIdentity.budget_sha256!==BUDGET_SHA)throw Error('the copy is not pinned to this file synthetic bytes');
 for(const key of Object.keys(fixed))
  if(!['ga_sha256','budget_sha256'].includes(key)&&JSON.stringify(copy.root10ScopeIdentity[key])!==JSON.stringify(fixed[key]))throw Error('the copy changed identity field '+key);
});
test('38 canonical digests of the carried bindings stay stable under jsonb text rules',()=>{
 const text=postgresJsonbText(CARRIED_BINDING);
 if(!text.startsWith('{"gate_id": ')||!text.includes('"controller_sha256": '))throw Error('postgres jsonb text ordering changed: '+text.slice(0,60));
 if(canonicalDigest(CARRIED_BINDING)===canonicalDigest(SCOPE_NEW_BINDING))throw Error('distinct bindings must not collide');
 if(canonicalDigest(CARRIED_BINDING)===canonicalDigest(CLOCK_OLD_BINDING))throw Error('the carried binding must differ from the runtime clock predecessor');
});

console.log(JSON.stringify({state:'ROOT10_SCOPE_AMENDMENT_UNIT_TESTS'+(failed?'_FAILED':'_PASS'),unit_tests_passed:passed,unit_tests_failed:failed,formal_preflight_claimed:false,formal_suite_claimed:false,authority_effect:'NONE'}));
if(failed)process.exit(1);
