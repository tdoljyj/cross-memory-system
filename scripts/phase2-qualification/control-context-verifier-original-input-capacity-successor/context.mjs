import {intentFor} from '../preentry-parent/runtime-successor/sql_effect.mjs';
import {deriveEventKey} from '../preentry-parent/runtime-successor/supervisor.mjs';
import {checkDispatchEvidence} from '../control-context-verifier-runtime180/dispatch-evidence.mjs';
import {invokeFixedHost} from '../control-context-verifier-next-window-successor/host-effect.mjs';
import {checkConsumedBudget} from '../control-context-verifier-runtime600/budget-evidence.mjs';
import {checkLateBoundPolicy} from '../control-context-verifier-runtime600/late-bound-policy.mjs';
import {verifySourcePublication} from './source-publication.mjs';
import {verifyResultMaterials,resultCommitRequest,checkAuthorizationLifetime} from './result-terminal.mjs';
import {checkResultSemantics} from './grr.mjs';
import fs from 'node:fs';
import boundedCrypto from 'node:crypto';import {isDeepStrictEqual as boundedSame} from 'node:util';
import {createRequire} from 'node:module';
import {sha,readBlobRef,verifyOwnerMergeArtifact,verifyDynamicPayload} from '../control-context-verifier-next-window-successor/trusted-github.mjs';
import {validateRootShape,canonicalDigest,signaturePayloadDigest} from '../control-context-verifier-next-window-successor/root-window-validation.mjs';
export const project='uscrdifznmlvczcekqpw',rootID='ctr_414bd3c724264a83894b0c55cf2ab878',generation='ctrgen_2e778ca66244459f974b081edca8c04e';
export const gateID='G-PREENTRY-SKILL-QUALIFICATION',audience='urn:clued:audience:skill-coexistence-qualification:'+project;
export const sql="select clock_timestamp() as observed_at, clued_control.read_execution() as execution";
const require=createRequire(new URL('../../../apps/clued-cloud/package.json',import.meta.url)),Ajv=require('ajv');
const ajv=new Ajv({allErrors:true,strictKeywords:true,format:'full'});
const profileBase=new URL('../preentry-parent/profile-successor/',import.meta.url);
const bytes=n=>fs.readFileSync(n==='ProfileDefinition.json'?new URL('../preentry-parent/profile-runtime600/ProfileDefinition.json',import.meta.url):new URL(n,profileBase));
const profile=JSON.parse(bytes('ProfileDefinition.json'));
const vectorSchema=JSON.parse(bytes('revocation-epoch-vector.candidate.schema.json'));
ajv.addSchema(vectorSchema,'revocation-epoch-vector.candidate.schema.json');
const gaSchemaBytes=bytes('gate-authorization.candidate.schema.json');
const gaCheck=ajv.compile(JSON.parse(gaSchemaBytes));
const check=(ok,msg)=>{if(!ok)throw Error(msg);};
const same=(a,b)=>canonicalDigest(a)===canonicalDigest(b);
function safe(value){if(typeof value==='number')check(Number.isSafeInteger(value),'UNSAFE_NUMBER');else if(value&&typeof value==='object')for(const v of Object.values(value))safe(v);}
export function parseExact(raw){check(typeof raw==='string'&&Buffer.byteLength(raw)<=131072,'BOUNDED_RAW_JSON');const p=JSON.parse(raw);safe(p);check(JSON.stringify(p)+'\n'===raw,'EXACT_UNIQUE_COMPACT_JSON');return p;}
export function checkGAShape(raw){const ga=parseExact(raw);check(gaCheck(ga),'COMPLETE_GA_SCHEMA_REJECTED');check(ga.schema_digest===sha(gaSchemaBytes),'EXACT_ACCEPTED_GA_SCHEMA');return ga;}
export function time(s){check(typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(s),'UTC_TIME_REQUIRED');const v=Date.parse(s);check(Number.isFinite(v)&&new Date(v).toISOString().slice(0,19)===s.slice(0,19),'INVALID_CALENDAR_TIME');return v;}
function currentWindow(start,end,now){check(time(start)<=now&&now<time(end),'EXPIRED_OR_NOT_YET_VALID');}
export function checkCurrentSemantics({gaRaw,operation,observation,runtimeAcceptance,qualification,now=Date.now(),admissionPhase='PREFLIGHT',expectedQuerySha256=sha(sql),terminalResult=null}){
 const ga=checkGAShape(gaRaw);
 const nonPass=operation==='GRR'&&['FAIL','BLOCKED','STALE'].includes(terminalResult);
 check(['CREATE','START','GRR'].includes(operation),'FIXED_OPERATION_ONLY');
 check(observation?.project===project&&observation.query_sha256===expectedQuerySha256,'FIXED_CURRENT_QUERY_REQUIRED');
 const readTime=Date.parse(observation.row?.observed_at);check(Number.isFinite(readTime)&&readTime<=now+1000&&now-readTime<=15000,'FRESH_SQL_OBSERVATION_REQUIRED');
 const state=observation.row.execution;check(state&&state.binding?.root_id===rootID&&state.current?.root_id===rootID,'EXACT_EXECUTION_BINDING');
 const root=state.root;check(root?.root_set_id===rootID&&root.state==='STORED_NO_GATE_AUTHORITY'&&root.generation_id===generation,'CURRENT_ROOT_GENERATION_REQUIRED');
 check(Array.isArray(root.events)&&root.events.length===root.sequence&&root.events.every((e,i)=>e.root_id===rootID&&e.sequence===i+1),'COMPLETE_ROOT_HISTORY');
 const registration=root.events.filter(e=>e.request.kind==='GENERATION_REGISTERED').at(-1);check(registration?.request.generation_id===generation,'CURRENT_ROOT_EVENT');
 const body=registration.request.body;validateRootShape(body);
 check(body.control_trust_root_generation===generation&&body.history.prefix_sequence===registration.sequence-1&&body.history.prefix_digest===canonicalDigest(root.events.slice(0,registration.sequence-1)),'EXACT_ROOT_HISTORY_PREFIX');
 check(!root.events.some(e=>e.request.kind==='ROOT_REVOKED'||(e.request.kind==='GENERATION_REVOKED'&&e.request.generation_id===generation)),'ROOT_REVOKED');
 currentWindow(body.not_before,body.expires_at,now);currentWindow(body.revocation.as_of,body.revocation.expires_at,now);
 check(ga.control_trust_root_generation===generation&&ga.audience===audience&&ga.issuer_purpose==='GATE_AUTHORIZATION'&&ga.purpose==='SKILL_COEXISTENCE_QUALIFICATION'&&ga.environment==='ISOLATED_TEST','PURPOSE_AUDIENCE_SCOPE');
 for(const name of ['runner_generation','credential_generation','session_generation'])check(typeof state.current[name]==='string'&&state.current[name]!=='not_applicable'&&(nonPass||state.current[name]===ga[name]),'INDEPENDENT_GENERATION_DRIFT');
 const layers=profile.not_applicable_layer_permissions,v=ga.revocation_epoch_vector;
 check(ajv.getSchema('revocation-epoch-vector.candidate.schema.json')(v),'ACCEPTED_FIXED_VECTOR_SCHEMA');
 check(same(v.not_applicable_evidence,layers),'EXACT_NA_ACCEPTANCE_AND_REASON');
 check(ga.profile_ref.profile_id===profile.profile_id&&ga.profile_ref.definition_version===profile.definition_version&&ga.profile_ref.content_digest===sha(bytes('ProfileDefinition.json'))&&ga.profile_digest===ga.profile_ref.content_digest,'EXACT_SIGNED_PROFILE');
 const {binding,current,attempts}=state;safe(current);safe(binding);
 check(binding.gate_id===gateID&&ga.gate_id===gateID,'EXACT_SINGLE_REGISTERED_GATE');
 check(ga.controller_digest===binding.controller_sha256&&ga.controller_qualification_ref.sha256===binding.qualification_sha256&&ga.scope_digest===binding.scope_sha256&&ga.profile_digest===binding.profile_sha256,'EXACT_CONTROLLER_SCOPE_BINDING');
 check(runtimeAcceptance?.state==='ACCEPTED_EXACT_PREENTRY_CONTROLLER_RUNTIME'&&runtimeAcceptance.independent_reviewer==='/root/project_list_auth_fix','EXACT_RUNTIME_ACCEPTANCE_METADATA_REQUIRED');
 currentWindow(runtimeAcceptance.not_before,runtimeAcceptance.expires_at,now);
 const subject=runtimeAcceptance.accepted_subject;
 check(subject?.root_id===rootID&&subject.project_ref===project&&subject.gate.gate_id===gateID&&subject.gate.definition_version===binding.gate_version&&subject.gate.content_digest===binding.gate_sha256,'ACCEPTED_GATE_VERSION_DIGEST');
 check(ga.artifact_refs.some(r=>r.sha256===binding.gate_sha256)&&ga.scope_ref.sha256===binding.scope_sha256,'GATE_AND_SCOPE_IN_SIGNED_GA');
 check(qualification?.state==='ACCEPTED_SCOPED_CONTROLLER_QUALIFICATION'&&qualification.independent_reviewer==='/root/project_list_auth_fix'&&qualification.controller_digest===binding.controller_sha256&&qualification.scope_digest===binding.scope_sha256&&qualification.environment==='ISOLATED_TEST'&&qualification.purpose===ga.purpose,'EXACT_CONTROLLER_QUALIFICATION');
 currentWindow(qualification.not_before,qualification.expires_at,now);
 check(qualification.independent_of_tested_skill===true&&qualification.forbidden_stage_dependencies_excluded===true,'CONTROLLER_SELF_QUALIFICATION_FORBIDDEN');
 checkLateBoundPolicy(subject.late_bound_fields);
 const varying=new Set(['budget_reservation_ref','status_manifest_ref','target_revision','gate_authorization_id','authorization_status','issued_at','expires_at','deadline','idempotency_key','signature','runner_generation','credential_generation','session_generation']);
 // An accepted full subject fixes every remaining GA field, not only a scope hash.
 const expected=subject.expected_ga;
 for(const field of gaSchemaBytes.length?JSON.parse(gaSchemaBytes).required:[])if(!varying.has(field))check(expected&&Object.hasOwn(expected,field)&&same(ga[field],expected[field]),'EXACT_ACCEPTED_GA_FIELD:'+field);
 check(ga.stage_receipt_refs.length===6&&subject.required_stages?.join(',')==='R05,R06,R07,R08,R09,R10','EXACT_STAGE_INPUTS');
 const issued=time(ga.issued_at),expires=time(ga.expires_at),deadline=time(ga.deadline);
 checkAuthorizationLifetime({operation,result:terminalResult,issued,deadline,expires,now});
 check(profile.max_lifetime_seconds===600&&issued<deadline&&expires<=time(body.expires_at)&&expires<=time(runtimeAcceptance.expires_at)&&expires<=time(qualification.expires_at),'GA_WINDOW');
 check(Array.isArray(attempts),'ACTUAL_ATTEMPTS_REQUIRED');
 const selected=attempts.filter(a=>a.ga_id===ga.gate_authorization_id);check(selected.length===1,'ONE_EXACT_GA_ATTEMPT');const attempt=selected[0];
 check(current.active_ga_id===ga.gate_authorization_id&&attempt.root_id===rootID&&(nonPass||!attempt.revoked)&&attempt.ga_raw===gaRaw&&attempt.ga_sha256===sha(gaRaw)&&same(attempt.ga,ga),'EXACT_ACTIVE_RESERVATION');
 checkConsumedBudget({ga,state,attempt,root:body,project,now:nonPass?issued:now});
 check(attempt.receipt_raw===null&&attempt.receipt_id===null,'NO_SECOND_RECEIPT');
 check(['PREFLIGHT','DISPATCHED_ONCE'].includes(admissionPhase),'FIXED_ADMISSION_PHASE');
 check(attempt.phase===(admissionPhase==='DISPATCHED_ONCE'?operation+'_SENT':({CREATE:'PENDING',START:'CREATED',GRR:'SIGNING'}[operation])),'NO_REDISPATCH_OR_UNKNOWN');
 check(Date.parse(attempt.expires_at)===deadline,'RESERVATION_DEADLINE');
 check(current.charged_seconds>=binding.prior_seconds&&current.charged_seconds<=7200&&current.charged_evidence_bytes>=binding.prior_evidence_bytes&&current.charged_evidence_bytes<=1530506163,'ACTUAL_CUMULATIVE_BUDGET');
 return {state:'SEMANTICS_ONLY_NOT_ADMISSION',ga,root:body,attempt,accepted_subject:subject,sequence:current.sequence};
}
function signedMetadata(item,expectedSha){check(typeof item?.raw==='string'&&sha(item.raw)===expectedSha,'ACCEPTANCE_BYTES_MISSING_OR_DRIFT');verifyOwnerMergeArtifact({...item.publication,raw:item.raw});return JSON.parse(item.raw);}

// BEGIN EXACT CAPACITY AND BOUNDED SERIES CANDIDATES
const capacityAdministration=(()=>{
// Pure capacity-administration consistency candidate. No signature, Owner or currentness verification here.
const crypto=boundedCrypto;
const same=boundedSame;
const need=(v,m)=>{if(!v)throw Error(m);},sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const exact=(o,keys)=>o&&same(Object.keys(o).sort(),[...keys].sort());
const hex=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const utc=s=>typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(s)&&Number.isFinite(Date.parse(s));
// Use only after original-byte authentication. Accept JSON.stringify pretty whitespace, not duplicate keys or numeric/escape normalization.
function parseAuthenticatedAdministrativeJSON(raw){
 need(typeof raw==='string','ADMIN_JSON_STRING');const value=JSON.parse(raw);let compact='',quoted=false,escaped=false;
 for(const ch of raw){if(quoted){compact+=ch;if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;}else if(ch==='"'){quoted=true;compact+=ch;}else if(!' \t\r\n'.includes(ch))compact+=ch;}
 need(compact===JSON.stringify(value),'ADMIN_JSON_UNIQUE_CANONICAL_VALUES');return value;
}
const capacityDelta=Object.freeze({original_input_bytes_before:2097152,original_input_bytes_after:3000000,original_input_kind_before:'EXACT_ORIGINAL_VERIFIER_INPUTS_BLOB_V2_2MIB',original_input_kind_after:'EXACT_ORIGINAL_VERIFIER_INPUTS_BLOB_V3_3000000',ga_raw_bytes:65536,control_request_and_grr_bytes:131072,evidence_index_bytes:131072,first_frame_bytes:4194304,second_frame_bytes:4194304,publisher_request_bytes:4194304,publisher_response_bytes:4194304,source_batch_response_bytes:33554432,source_refs_maximum:128,root_strict_json_bytes:2097152,original_field_count:5,original_nineteen_oracles_unchanged:true,old_signed_objects_rewritten:false,new_root:false,new_signing_identity:false,refund:false});
const capacityBaseline=Object.freeze({failed_ga_id:'ga_04377008dc04437d9ee9d28a3c79ff3a',failed_receipt_sha256:'b27286d6fcb54e34a62d8738f49c1ecafe3210c9a321a703c3828e38497e434c',terminal_phase:'BLOCKED',sequence:49,charged_seconds:5706,charged_evidence_bytes:1262070707,used_series_allocations:1,maximum_remaining_allocations:2});
const capacityRepairState='ACCEPTED_EXACT_QUALIFICATION_REPAIR_WITH_APPROVED_CAPACITY_DELTA';
function ref(x){return exact(x,['uri','sha256'])&&typeof x.uri==='string'&&/^https:\/\/api\.github\.com\/repos\/tdoljyj\/cross-memory-system\/git\/blobs\/[a-f0-9]{40}$/.test(x.uri)&&hex(x.sha256);}
function material(value,descriptor,label){need(descriptor&&ref(descriptor.ref)&&value&&same(value.ref,descriptor.ref)&&typeof value.raw==='string'&&sha(value.raw)===descriptor.ref.sha256,'CAPACITY_EXACT_'+label);return parseAuthenticatedAdministrativeJSON(value.raw);}
// Values arrive from the authenticated runtime loader; this pure module does not accept caller booleans as authentication.
function checkCapacityAdministration({runtime,pins,scope,proposalSHA,execution,now,capacity_materials=null}){
 const s=runtime?.accepted_subject,has=s&&Object.hasOwn(s,'capacity_materials');
 if(!has){need(!Object.hasOwn(s??{},'capacity_delta')&&capacity_materials===null,'CAPACITY_PARTIAL_BINDING_FORBIDDEN');return null;}
 need(same(s.capacity_delta,capacityDelta)&&exact(s.capacity_materials,['approval','applicability'])&&exact(capacity_materials,['approval','applicability']),'EXACT_CAPACITY_SUBJECT_AND_LOADED_SET');
 const a=material(capacity_materials.approval,s.capacity_materials.approval,'APPROVAL'),d=material(capacity_materials.applicability,s.capacity_materials.applicability,'APPLICABILITY');
 need(a.state==='APPROVED_EXACT_ORIGINAL_INPUT_CAPACITY_SUPPLEMENT'&&a.base_proposal_sha256===proposalSHA&&same(a.base_approval_ref,pins.approval_ref)&&same(a.bounded_series_constraints,scope)&&same(a.capacity_delta,capacityDelta)&&same(a.baseline,capacityBaseline),'REAL_EXACT_CAPACITY_APPROVAL_REQUIRED');
 need(ref(a.capacity_proposal_ref)&&utc(a.approved_at)&&utc(now)&&Date.parse(a.approved_at)<=Date.parse(now)&&Date.parse(a.approved_at)<Date.parse(scope.expires_at),'CAPACITY_APPROVAL_REFERENCE_AND_TIME');
 need(d.state==='ACCEPTED_EXACT_ROOT3_ORIGINAL_INPUT_CAPACITY_SUPPLEMENT'&&d.independent_reviewer==='/root/project_list_auth_fix'&&same(d.approval_ref,s.capacity_materials.approval.ref)&&same(d.base_approval_ref,pins.approval_ref)&&d.base_proposal_sha256===proposalSHA&&same(d.capacity_proposal_ref,a.capacity_proposal_ref),'EXACT_INDEPENDENT_CAPACITY_APPLICABILITY');
 need(same(d.bounded_series_constraints,scope)&&same(d.capacity_delta,capacityDelta)&&same(d.baseline,capacityBaseline)&&d.scope_unchanged_except_original_input_limit===true&&!Object.hasOwn(d,'scope_unchanged')&&d.new_action_authorized===false,'CAPACITY_ONLY_EXPLICIT_DELTA');
 need(utc(d.accepted_at)&&Date.parse(d.accepted_at)>=Date.parse(a.approved_at)&&Date.parse(d.accepted_at)<=Date.parse(now),'CAPACITY_ACCEPTANCE_TIME');
 need(hex(d.controller_digest)&&hex(d.scope_digest)&&d.controller_digest===s.expected_ga?.controller_digest&&d.scope_digest===s.expected_ga?.scope_digest,'CAPACITY_EXACT_CURRENT_CONTROLLER_SCOPE');
 need(ref(d.previous_evidence_sink_ref)&&d.previous_evidence_sink_ref.sha256==='33feb26ab01ec1cb45834c4b97d5d94f620507452f67146ce1ab7748a8500d96'&&ref(d.evidence_sink_ref)&&same(d.evidence_sink_ref,s.expected_ga?.evidence_sink_ref)&&s.expected_ga?.artifact_refs?.some(r=>same(r,d.evidence_sink_ref))&&d.previous_evidence_sink_ref.sha256!==d.evidence_sink_ref.sha256,'CAPACITY_EXACT_EVIDENCE_SUCCESSOR');
 need(Array.isArray(s.expected_ga?.source_ref?.blobs)&&s.expected_ga.source_ref.blobs.length<=128,'CAPACITY_SOURCE_REFS_MAXIMUM_UNCHANGED');
 need(Array.isArray(d.changed_source_refs)&&d.changed_source_refs.length>0&&d.changed_source_refs.every(ref)&&new Set(d.changed_source_refs.map(r=>r.uri)).size===d.changed_source_refs.length,'CAPACITY_EXACT_CHANGED_SOURCE_REFS');
 const a043=execution?.attempts?.filter(a=>a.ga_id===capacityBaseline.failed_ga_id);need(a043?.length===1&&a043[0].phase==='BLOCKED'&&a043[0].receipt_sha256===capacityBaseline.failed_receipt_sha256&&typeof a043[0].receipt_raw==='string'&&sha(a043[0].receipt_raw)===capacityBaseline.failed_receipt_sha256,'ACTUAL_043_BLOCKED_TERMINAL_REQUIRED');
 need(execution.current.sequence>=49&&execution.current.charged_seconds>=5706&&execution.current.charged_evidence_bytes>=1262070707,'CAPACITY_NO_BASELINE_REFUND_OR_REWIND');
 return Object.freeze({approval_ref:s.capacity_materials.approval.ref,applicability_ref:s.capacity_materials.applicability.ref,controller_digest:d.controller_digest,scope_digest:d.scope_digest,changed_source_refs:d.changed_source_refs});
}
function isApprovedCapacityRepair(r,a,c){return !!c&&r.state===capacityRepairState&&r.independent_reviewer==='/root/project_list_auth_fix'&&r.failed_ga_id===a.ga_id&&r.failed_receipt_sha256===a.receipt_sha256&&r.failed_ga_id===capacityBaseline.failed_ga_id&&r.failed_receipt_sha256===capacityBaseline.failed_receipt_sha256&&ref(r.identified_error_ref)&&same(r.changed_source_refs,c.changed_source_refs)&&r.scope_unchanged_except_original_input_limit===true&&!Object.hasOwn(r,'scope_unchanged')&&r.new_action_authorized===false&&same(r.capacity_approval_ref,c.approval_ref)&&same(r.capacity_applicability_ref,c.applicability_ref)&&r.controller_digest===c.controller_digest&&r.scope_digest===c.scope_digest;}

return Object.freeze({checkCapacityAdministration,isApprovedCapacityRepair,capacityBaseline,capacityDelta,parseAuthenticatedAdministrativeJSON});
})();
const boundedSeries=(()=>{
// Pure administrative consistency candidate. Not a signature verifier, reservation, or authority issuer.
const {checkCapacityAdministration,isApprovedCapacityRepair,capacityBaseline}=capacityAdministration;
const crypto=boundedCrypto,same=boundedSame;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),need=(v,m)=>{if(!v)throw Error(m);},hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),utc=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(x)&&Number.isFinite(Date.parse(x));
const proposalSHA='ea96914e218460339508bc51eff0d10de41e1a94cfa3a0a544a85a132219791b';
const baselineSHA='022c01e16cb0a20e410e4c6d09fc41285c9713fa6524a820360941507c686829';
const scope=Object.freeze({root_id:'ctr_414bd3c724264a83894b0c55cf2ab878',root_generation:'ctrgen_2e778ca66244459f974b081edca8c04e',project:'uscrdifznmlvczcekqpw',expires_at:'2026-09-10T10:13:16Z',maximum_new_ga:3,maximum_new_forward:3,per_ga_seconds:600,per_ga_evidence_bytes:134217728,maximum_series_charged_seconds:6906,root_seconds_cap:7200,evidence_cap:1530506163,first_pass_stops:true,refund:false,automatic_retry:false,production:false,model_budget:0,paid_budget:0});
const inherited={STATUS:'acaf2073c654be95a3beab820f1460de1e6e68caa267e9c75bdd3c891bd894b3',GATE_AUTHORIZATION:'b6d4782fcf79cf599f3ccc7e2c7b7434e41a26c6d4a28c6711eac0c9f469e146',GATE_RESULT:'b6d4782fcf79cf599f3ccc7e2c7b7434e41a26c6d4a28c6711eac0c9f469e146'};
function material(x,ref,label){need(ref&&hex(ref.sha256)&&typeof ref.uri==='string'&&x&&same(x.ref,ref)&&typeof x.raw==='string'&&sha(x.raw)===ref.sha256,'EXACT_PINNED_'+label);return JSON.parse(x.raw);}
function terminal(a){if(!['PASS','FAIL','BLOCKED','STALE'].includes(a.phase)||typeof a.receipt_raw!=='string'||sha(a.receipt_raw)!==a.receipt_sha256)return false;const r=JSON.parse(a.receipt_raw);return r.result===a.phase&&r.gate_authorization_id===a.ga_id&&r.gate_authorization_sha256===a.ga_sha256&&r.control_trust_root_generation===scope.root_generation;}
function checkBoundedSeries({pins,proposal_raw,baseline_raw,approval,applicability,runtime,execution,now,operation,ga_id=null,result=null,repair_acceptances=[],capacity_materials=null}){
 // These pins must be fixed by the independently reviewed future consumer, not accepted from GA/user args.
 need(pins&&same(Object.keys(pins).sort(),['approval_ref','applicability_ref','repair_refs'].sort())&&pins.approval_ref&&pins.applicability_ref,'REAL_APPROVAL_AND_APPLICABILITY_PINS_REQUIRED');
 need(sha(proposal_raw)===proposalSHA,'EXACT_APPROVAL_PROPOSAL_BYTES');need(sha(baseline_raw)===baselineSHA,'EXACT_ACTUAL_TERMINAL_BASELINE_BYTES');
 const base=JSON.parse(baseline_raw).row.metadata.execution,approved=material(approval,pins.approval_ref,'USER_APPROVAL'),appendix=material(applicability,pins.applicability_ref,'ADMINISTRATIVE_APPLICABILITY');
 need(approved.state==='APPROVED_EXACT_BOUNDED_QUALIFICATION_SERIES'&&approved.proposal_sha256===proposalSHA&&same(approved.scope,scope)&&utc(approved.approved_at),'ACTUAL_SPECIFIC_APPROVAL_SCOPE');
 need(appendix.state==='ACCEPTED_EXACT_ROOT3_BOUNDED_QUALIFICATION_SERIES_APPLICABILITY'&&appendix.independent_reviewer==='/root/project_list_auth_fix'&&appendix.proposal_sha256===proposalSHA&&same(appendix.approval_ref,pins.approval_ref)&&same(appendix.scope,scope)&&same(appendix.inherited_issuer_purpose_sha256,inherited)&&utc(appendix.not_before)&&Date.parse(appendix.not_before)>=Date.parse(approved.approved_at),'EXACT_INDEPENDENT_SCOPE_AND_INHERITED_PURPOSES');
 need(appendix.new_root_generation===false&&appendix.new_signing_identity===false&&appendix.old_signed_objects_rewritten===false,'NO_NEW_ROOT_OR_REWRITTEN_SIGNATURE_AUTHORITY');
 need(runtime?.state==='ACCEPTED_EXACT_PREENTRY_CONTROLLER_RUNTIME'&&same(runtime.accepted_subject?.bounded_series_applicability_ref,pins.applicability_ref)&&same(runtime.accepted_subject?.bounded_series_constraints,scope),'RUNTIME_MUST_ACTUALLY_BIND_THE_APPENDIX');
 need(utc(now)&&Date.parse(now)>=Date.parse(appendix.not_before),'TRUSTED_CURRENT_UTC_REQUIRED');
 need(['NEXT_ALLOCATION','CONSUME_RESERVED_BUDGET','NEXT_FORWARD','CURRENT_DISPATCH','RESULT_RECONCILIATION'].includes(operation),'EXACT_SERIES_CHECK_POINT');
 if(operation==='RESULT_RECONCILIATION')need(['FAIL','BLOCKED','STALE'].includes(result),'EXPIRED_LIFETIME_EXCEPTION_NONPASS_ONLY');else need(Date.parse(now)<Date.parse(scope.expires_at),'FIXED_OWNER_CUTOFF_NO_DISPATCH');
 const x=execution;need(x?.root?.root_set_id===scope.root_id&&x.root.generation_id===scope.root_generation&&same(x.root,base.root)&&x.current?.root_id===scope.root_id,'EXACT_REGISTERED_ROOT3_HISTORY_UNCHANGED');
 need(Array.isArray(x.events)&&Array.isArray(x.attempts)&&x.events.length>=base.events.length,'COMPLETE_EXECUTION_HISTORY_REQUIRED');need(same(x.events.slice(0,base.events.length),base.events),'ORIGINAL_44_EVENTS_UNCHANGED');
 for(const a of base.attempts)need(same(x.attempts.filter(t=>t.ga_id===a.ga_id),[a]),'ALL_SIX_ORIGINAL_ATTEMPTS_AND_RECEIPTS_UNCHANGED');
 const extra=x.events.slice(base.events.length),newAttempts=x.attempts.filter(a=>!base.attempts.some(p=>p.ga_id===a.ga_id));need(new Set(x.attempts.map(a=>a.ga_id)).size===x.attempts.length,'UNIQUE_GA_IDENTITIES');
 need(extra.every((e,i)=>e.root_id===scope.root_id&&e.sequence===45+i)&&x.current.sequence===44+extra.length,'CONTIGUOUS_REAL_EVENT_HISTORY');
 const budgets=extra.filter(e=>e.request?.operation==='BUDGET_RESERVED'),forwards=extra.filter(e=>e.request?.operation==='EXECUTION_BINDING_FORWARD_ACCEPTED');
 need(budgets.length<=3&&newAttempts.length<=3&&forwards.length<=3,'THREE_ALLOCATIONS_GAS_AND_FORWARDS_MAXIMUM');
 need(x.current.charged_seconds===5106+600*budgets.length&&x.current.charged_evidence_bytes===1127852979+134217728*budgets.length&&x.current.charged_seconds<=6906&&x.current.charged_seconds<=7200&&x.current.charged_evidence_bytes<=1530506163,'EXACT_NONREFUNDING_COUNTED_CHARGES_AND_CAPS');
 const capacity=checkCapacityAdministration({runtime,pins,scope,proposalSHA,execution,now,capacity_materials});
 const used=new Set();for(const e of budgets){const b=e.request.body;need(typeof b?.raw==='string'&&sha(b.raw)===b.sha256,'FULL_ORIGINAL_BUDGET_BYTES');const v=JSON.parse(b.raw);need(v.seconds===600&&v.evidence_bytes===134217728&&v.root_generation===scope.root_generation&&v.expires_at===scope.expires_at&&v.environment==='ISOLATED_TEST'&&v.purpose==='SKILL_COEXISTENCE_QUALIFICATION','FIXED_PER_ATTEMPT_BUDGET_SCOPE');}
 for(const a of newAttempts){need(a.root_id===scope.root_id&&typeof a.ga_raw==='string'&&sha(a.ga_raw)===a.ga_sha256&&same(JSON.parse(a.ga_raw),a.ga)&&a.ga.gate_authorization_id===a.ga_id&&a.ga.control_trust_root_generation===scope.root_generation,'EXACT_NEW_GA_ORIGINAL_BYTES_ROOT');need(utc(a.ga.issued_at)&&utc(a.ga.deadline)&&Date.parse(a.ga.deadline)<=Date.parse(scope.expires_at)&&Date.parse(a.ga.deadline)-Date.parse(a.ga.issued_at)<=600000,'FIXED_GA_DURATION_AND_CUTOFF');need(budgets.some(b=>b.sequence===a.budget_sequence)&&!used.has(a.budget_sequence),'ONE_GA_PER_ACTUAL_BUDGET');used.add(a.budget_sequence);}
 const ordered=[...newAttempts].sort((a,b)=>a.budget_sequence-b.budget_sequence),current=ordered.find(a=>a.ga_id===ga_id),prior=ordered.filter(a=>a.ga_id!==ga_id);
 need(!prior.some(a=>a.phase==='PASS'),'FIRST_FORMAL_PASS_CANCELS_REMAINING');need(prior.every(terminal),'PREVIOUS_UNKNOWN_OR_UNCLOSED_ATTEMPT');
 need(Array.isArray(pins.repair_refs)&&repair_acceptances.length===pins.repair_refs.length,'EXACT_REPAIR_ACCEPTANCE_SET');const repairs=repair_acceptances.map((r,i)=>material(r,pins.repair_refs[i],'REPAIR_ACCEPTANCE'));
 const repairAccepted=(r,a,strictArray)=>{if(capacity&&a.ga_id===capacityBaseline.failed_ga_id)return isApprovedCapacityRepair(r,a,capacity);return strictArray?(r.state==='ACCEPTED_EXACT_SAME_SCOPE_QUALIFICATION_REPAIR'&&r.independent_reviewer==='/root/project_list_auth_fix'&&r.failed_ga_id===a.ga_id&&r.failed_receipt_sha256===a.receipt_sha256&&r.identified_error_ref?.sha256&&Array.isArray(r.changed_source_refs)&&r.changed_source_refs.length>0&&r.scope_unchanged===true&&r.new_action_authorized===false):(r.failed_ga_id===a.ga_id&&r.failed_receipt_sha256===a.receipt_sha256&&r.state==='ACCEPTED_EXACT_SAME_SCOPE_QUALIFICATION_REPAIR'&&r.independent_reviewer==='/root/project_list_auth_fix'&&r.identified_error_ref?.sha256&&r.changed_source_refs?.length>0&&r.scope_unchanged===true&&r.new_action_authorized===false);};
 for(const a of ordered.slice(0,-1))need(repairs.some(r=>repairAccepted(r,a,true)),'INDEPENDENT_IDENTIFIED_ERROR_AND_FIX_BEFORE_NEXT_ATTEMPT');
 // Forward admission remains enforced by the original exact getter and independently reviewed registration transaction; no future-event back-reference.
 const unspent=budgets.filter(e=>!used.has(e.sequence));
 if(['NEXT_ALLOCATION','NEXT_FORWARD'].includes(operation)){need(x.current.active_ga_id===null&&x.current.pending_budget_sequence===null&&unspent.length===0&&newAttempts.every(terminal),'NO_UNKNOWN_ACTIVE_OR_PENDING_BEFORE_NEXT');need(!newAttempts.some(a=>a.phase==='PASS'),'FIRST_FORMAL_PASS_CANCELS_REMAINING');need((operation==='NEXT_ALLOCATION'?budgets.length:forwards.length)<3,'FOURTH_ATTEMPT_OR_FORWARD_FORBIDDEN');for(const a of ordered)need(repairs.some(r=>repairAccepted(r,a,false)),'FIX_REQUIRED_BEFORE_ANOTHER_ALLOCATION_OR_FORWARD');if(operation==='NEXT_ALLOCATION')need(Date.parse(now)+600000<Date.parse(scope.expires_at),'FULL_600_SECOND_WINDOW_REQUIRED');}
 else if(operation==='CONSUME_RESERVED_BUDGET'){need(x.current.active_ga_id===null&&unspent.length===1&&x.current.pending_budget_sequence===unspent[0].sequence&&newAttempts.every(terminal),'ONE_REAL_PENDING_BUDGET_ONLY');for(const a of ordered)need(repairs.some(r=>repairAccepted(r,a,false)),'FIX_REQUIRED_BEFORE_CONSUMING_NEXT_BUDGET');}
 else{need(current&&current===ordered.at(-1)&&x.current.active_ga_id===ga_id&&x.current.pending_budget_sequence===null&&unspent.length===0,'EXACT_SOLE_LATEST_CURRENT_ATTEMPT');if(operation==='CURRENT_DISPATCH')need(current.revoked===false&&!terminal(current)&&current.phase!=='UNKNOWN','NO_DISPATCH_AFTER_REVOKE_UNKNOWN_OR_TERMINAL');}
 // Static bytes are checked by the fixed preparer, without creating a new receipt or approval type.
 return {state:'LOCAL_SERIES_CONSISTENCY_CHECKED_NOT_ADMISSION',allocations:budgets.length,new_attempts:newAttempts.length,forwards:forwards.length,remaining_allocations:3-budgets.length,authority_effect:'NONE',signature_verified:false,actual_currentness_verified:false,reservation_performed:false};
}

return Object.freeze({checkBoundedSeries,scope,proposalSHA,baselineSHA});
})();
const capacityRuntime=(()=>{
// Candidate fragment for the authenticated context only. Never expose dependencies or descriptors as GA/child parameters.
const crypto=boundedCrypto;
const same=boundedSame;
const {capacityDelta,parseAuthenticatedAdministrativeJSON}=capacityAdministration;

const need=(v,m)=>{if(!v)throw Error(m);},sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const keys=(x,k)=>x&&same(Object.keys(x).sort(),[...k].sort());
function loadAuthenticatedCapacityMaterials(runtime,{readBlobRef,verifyOwnerMergeArtifact}){
 // Integration prerequisite: runtime itself has already passed the existing genuine signature/Owner/exact-subject validation.
 const s=runtime?.accepted_subject;
 need(runtime?.state==='ACCEPTED_EXACT_PREENTRY_CONTROLLER_RUNTIME'&&s,'EXISTING_AUTHENTICATED_RUNTIME_REQUIRED');
 // This loader belongs only to the new 3,000,000-byte consumer. Legacy compatibility is confined to the pure series core.
 need(Object.hasOwn(s,'capacity_materials'),'NEW_CAPACITY_CONSUMER_REQUIRES_REAL_SUPPLEMENT');
 need(keys(s.capacity_materials,['approval','applicability'])&&same(s.capacity_delta,capacityDelta),'EXACT_CAPACITY_RUNTIME_FIELDS');
 const actual=d=>{
  need(keys(d,['ref','publication'])&&keys(d.ref,['uri','sha256'])&&/^https:\/\/api\.github\.com\/repos\/tdoljyj\/cross-memory-system\/git\/blobs\/[a-f0-9]{40}$/.test(d.ref.uri)&&/^[a-f0-9]{64}$/.test(d.ref.sha256)&&keys(d.publication,['commitSha','artifactPath'])&&/^[a-f0-9]{40}$/.test(d.publication.commitSha)&&typeof d.publication.artifactPath==='string'&&d.publication.artifactPath.length>0,'EXACT_SIGNED_CAPACITY_DESCRIPTOR');
  const raw=readBlobRef(d.ref);need(typeof raw==='string'&&sha(raw)===d.ref.sha256,'ACTUAL_CAPACITY_BLOB_BYTES');
  verifyOwnerMergeArtifact({...d.publication,raw});
  // Admin JSON may be pretty. Hash/Owner bind original bytes; this never changes GA/GRR exact parsing.
  parseAuthenticatedAdministrativeJSON(raw);
  return Object.freeze({ref:Object.freeze({...d.ref}),raw});
 };
 return Object.freeze({approval:actual(s.capacity_materials.approval),applicability:actual(s.capacity_materials.applicability)});
}

return Object.freeze({loadAuthenticatedCapacityMaterials,parseAuthenticatedAdministrativeJSON});
})();
// END EXACT CAPACITY AND BOUNDED SERIES CANDIDATES
// All descriptors originate in the runtime bytes authenticated by signedMetadata.
// The ordinary pipe's caller cannot substitute an approval boolean or material pin.
function loadAuthenticatedBoundedSeries(runtime){
 const subject=runtime.accepted_subject,d=subject?.bounded_series_materials;
 check(d&&same(Object.keys(d).sort(),['approval','applicability','repairs'].sort()),'SIGNED_RUNTIME_BOUNDED_MATERIAL_DESCRIPTORS_REQUIRED');
 const actual=descriptor=>{
  check(descriptor&&same(Object.keys(descriptor).sort(),['ref','publication'].sort())&&descriptor.ref&&same(Object.keys(descriptor.ref).sort(),['uri','sha256'].sort())&&descriptor.publication&&same(Object.keys(descriptor.publication).sort(),['commitSha','artifactPath'].sort()),'EXACT_SIGNED_RUNTIME_MATERIAL_DESCRIPTOR');
  const raw=readBlobRef(descriptor.ref);check(sha(raw)===descriptor.ref.sha256,'ACTUAL_ADMINISTRATIVE_BLOB_BYTES');
  verifyOwnerMergeArtifact({...descriptor.publication,raw});
  return Object.freeze({raw,ref:Object.freeze({...descriptor.ref})});
 };
 check(Array.isArray(d.repairs)&&d.repairs.length<=3,'BOUNDED_SIGNED_RUNTIME_ACCEPTANCE_LISTS');
 const applicability=actual(d.applicability),appendix=capacityRuntime.parseAuthenticatedAdministrativeJSON(applicability.raw);
 check(same(d.applicability.ref,subject.bounded_series_applicability_ref)&&same(d.approval.ref,appendix.approval_ref),'RUNTIME_AND_APPENDIX_ACTUALLY_BIND_APPROVAL');
 const approval=actual(d.approval),repairs=d.repairs.map(actual);
 capacityRuntime.parseAuthenticatedAdministrativeJSON(approval.raw);for(const repair of repairs)capacityRuntime.parseAuthenticatedAdministrativeJSON(repair.raw);
 const capacity_materials=capacityRuntime.loadAuthenticatedCapacityMaterials(runtime,{readBlobRef,verifyOwnerMergeArtifact});
 check(capacity_materials!==null,'NEW_CAPACITY_CONSUMER_REQUIRES_ACTUAL_SUPPLEMENT');
 // This is a pre-existing local actual evidence input, not an executable source or a GitRef.
 // Hashes are fixed by the embedded module, not supplied by material or runtime descriptors.
 const proposal_raw=fs.readFileSync('C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/Phase2BoundedRemainingQualificationApprovalProposal20260910.md','utf8');
 const baseline_raw=fs.readFileSync('C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/c504-root3-schema-recovery/ActualTerminalFullObservation.json','utf8');
 check(sha(proposal_raw)===boundedSeries.proposalSHA&&sha(baseline_raw)===boundedSeries.baselineSHA,'EXACT_LOCAL_APPROVAL_PROPOSAL_AND_ACTUAL_BASELINE');
 const pins=Object.freeze({approval_ref:approval.ref,applicability_ref:applicability.ref,repair_refs:repairs.map(x=>x.ref)});
 return Object.freeze({check(execution,operation,ga_id,result){return boundedSeries.checkBoundedSeries({pins,proposal_raw,baseline_raw,approval,applicability,runtime,execution,now:new Date().toISOString(),operation,ga_id,result,repair_acceptances:repairs,capacity_materials});}});
}

export async function prepareTrustedToolMaterial(material){
 // This function is called by the fixed tool-origin entry below, never by child input.
 // SQL tool-call authenticity comes from that trusted caller, not a JSON member.
 const binding=material?.observation?.row?.execution?.binding;check(binding,'ACTUAL_SQL_BINDING_MISSING');
 check(sha(material.runtime_acceptance?.raw??'')===binding.runtime_acceptance_sha256&&sha(material.controller_qualification?.raw??'')===binding.qualification_sha256,'EXACT_METADATA_BYTES_REQUIRED');
 const runtime=JSON.parse(material.runtime_acceptance.raw),qualification=JSON.parse(material.controller_qualification.raw);
 const terminal=material.operation==='GRR'?parseExact(material.grr_raw):null;
 const nonPass=terminal&&['FAIL','BLOCKED','STALE'].includes(terminal.result);
 signedMetadata(material.runtime_acceptance,binding.runtime_acceptance_sha256);
 const series=loadAuthenticatedBoundedSeries(runtime);
 const seriesOperation=nonPass?'RESULT_RECONCILIATION':'CURRENT_DISPATCH';
 const seriesCheck=execution=>series.check(execution,seriesOperation,parseExact(material.ga_raw).gate_authorization_id,terminal?.result);
 seriesCheck(material.observation.row.execution);
 const result=checkCurrentSemantics({gaRaw:material.ga_raw,operation:material.operation,observation:material.observation,runtimeAcceptance:runtime,qualification,terminalResult:terminal?.result});
 // No effects or admission exist while these initially untrusted metadata bytes are checked.
 signedMetadata(material.runtime_acceptance,binding.runtime_acceptance_sha256);
 signedMetadata(material.controller_qualification,binding.qualification_sha256);
 check(result.ga.target_revision===material.runtime_acceptance.publication.commitSha,'ACTUAL_RUNTIME_PUBLICATION_TARGET');
 verifySourcePublication({sourceRef:result.ga.source_ref,ownerMerge:material.runtime_acceptance.publication.commitSha,controllerDigest:binding.controller_sha256});
 const root=result.root,rootProof=JSON.parse(readBlobRef(root.signature_binding.signature_evidence_ref));
 const rootPayloadRaw=readBlobRef({uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'+rootProof.payload.blob_sha,sha256:rootProof.payload.file_sha256});
 check(rootProof.merge.sha===root.signature_binding.owner_merge_commit&&signaturePayloadDigest(root)===canonicalDigest(JSON.parse(rootPayloadRaw))&&root.signature_binding.signed_object_sha256===signaturePayloadDigest(root),'EXACT_ROOT_SIGNING_PAYLOAD');
 verifyOwnerMergeArtifact({commitSha:rootProof.merge.sha,artifactPath:rootProof.payload.artifact_path,raw:rootPayloadRaw});
 for(const purpose of ['STATUS','GATE_AUTHORIZATION','GATE_RESULT']){
  const issuers=root.issuer_bindings.filter(i=>i.purpose===purpose);check(issuers.length===1&&issuers[0].subject_id==='tdoljyj'&&issuers[0].signing_service==='web-flow'&&issuers[0].audience===audience,'SEPARATE_ROOT_ISSUER_PURPOSE');
  check(issuers[0].qualification_ref.sha256===(purpose==='STATUS'?'acaf2073c654be95a3beab820f1460de1e6e68caa267e9c75bdd3c891bd894b3':'b6d4782fcf79cf599f3ccc7e2c7b7434e41a26c6d4a28c6711eac0c9f469e146'),'EXACT_ACCEPTED_PURPOSE_ALGORITHM_METADATA');
  const metadata=JSON.parse(readBlobRef(issuers[0].qualification_ref));
  check(metadata.control_trust_root_generation===generation&&metadata.root_set_id===rootID&&metadata.accepted_audience===audience&&metadata.accepted_issuer_purposes?.some(p=>p.purpose===purpose&&p.accepted===true&&p.audience===audience),'EXACT_PURPOSE_QUALIFICATION');currentWindow(metadata.not_before,metadata.expires_at,Date.now());
  if(purpose==='GATE_AUTHORIZATION')check(same(result.ga.issuer_ref,issuers[0].qualification_ref),'ACTUAL_GA_ISSUER_QUALIFICATION_REF');
 }
 check(result.ga.authority_source_ref.uri==='urn:clued:control-trust-root-set:'+project+':'+rootID&&result.ga.authority_source_ref.sha256===canonicalDigest(root),'ACTUAL_CURRENT_ROOT_REF');
 const gate=material.gate_definition;check(sha(gate?.raw??'')===binding.gate_sha256,'GATE_DEFINITION_BYTES');verifyOwnerMergeArtifact({...gate.publication,raw:gate.raw});
 const profileInput=material.profile_signing_payload;
 check(profileInput?.raw&&sha(profileInput.raw)===result.accepted_subject.profile_signing_payload_ref?.sha256,'EXACT_ACCEPTED_PROFILE_PAYLOAD_INPUT');
 const profileProof=JSON.parse(profileInput.raw);check(same(profileProof.profile_definition,profile),'PROFILE_SOURCE');
 verifyOwnerMergeArtifact({...profileInput.publication,raw:profileInput.raw});
 verifyDynamicPayload(material.ga_raw,'GateAuthorization',result.ga.deadline,nonPass?result.ga.issued_at:null);
 // Required prerequisite proof bytes must be actual accepted immutable sources; no digest-only admission.
 const requiredRefs=[result.ga.profile_ref.accepted_ref,...result.ga.stage_receipt_refs,...result.ga.upstream_gate_result_receipt_refs];
 for(const ref of requiredRefs){
  const entries=material.prerequisite_materials?.filter(x=>x.ref?.uri===ref.uri&&x.ref.sha256===ref.sha256);
  check(entries?.length===1&&sha(entries[0].raw)===ref.sha256,'EXACT_PREREQUISITE_SOURCE_REQUIRED');
  verifyOwnerMergeArtifact({...entries[0].publication,raw:entries[0].raw});
 }
 // Status is a live control object, not another Git payload authority. The collector must obtain
 // the complete immutable bytes from the current control source and the accepted schema/ref mapping.
 const statusInput=material.status_manifest,acceptedStatus=result.accepted_subject.control_schema_refs?.StatusManifest;
 check(statusInput?.raw&&acceptedStatus,'ACTUAL_STATUS_AND_ACCEPTED_SCHEMA_REQUIRED');
 const sm=parseExact(statusInput.raw);check(sha(statusInput.raw)===result.ga.status_manifest_ref.sha256,'EXACT_STATUS_BYTES');
 check(same(sm.issuer_ref,root.issuer_bindings.find(i=>i.purpose==='STATUS').qualification_ref),'EXACT_STATUS_ISSUER_REF');
 check(result.ga.status_manifest_ref.uri==='control://status-manifests/'+sm.status_manifest_id,'ORIGINAL_TYPED_STATUS_URI');
 const storedStatus=material.observation.row.execution.control_objects?.filter(x=>x.object_type==='StatusManifest'&&x.uri===result.ga.status_manifest_ref.uri);
 check(storedStatus?.length===1&&storedStatus[0].raw===statusInput.raw&&storedStatus[0].sha256===sha(statusInput.raw),'ACTUAL_STORED_STATUS_READ_REQUIRED');
 const statusSchemaRaw=readBlobRef(acceptedStatus);
 check(sha(statusSchemaRaw)===sha(fs.readFileSync(new URL('./status-manifest.candidate.schema.json',import.meta.url))),'EXACT_LOCAL_STATUS_SCHEMA_SUCCESSOR');
 const statusCheck=new Ajv({allErrors:true,strictKeywords:true,format:'full'}).compile(JSON.parse(statusSchemaRaw));
 check(statusCheck(sm)&&sm.schema_digest===acceptedStatus.sha256&&sm.issuer_purpose==='STATUS'&&sm.audience===audience&&sm.control_trust_root_generation===generation,'EXACT_SIGNED_STATUS_SCHEMA_PURPOSE');
 check(time(sm.as_of)<=Date.now()&&(nonPass||Date.now()<time(sm.expires_at))&&Array.isArray(sm.source_digests)&&sm.source_digests.length>0,'STATUS_CURRENT_INPUTS');
 const statusExpected={root_set_id:rootID,root_generation:generation,profile_digest:binding.profile_sha256,gate_digest:binding.gate_sha256,controller_digest:binding.controller_sha256,scope_digest:binding.scope_sha256,runner_generation:result.ga.runner_generation,credential_generation:result.ga.credential_generation,session_generation:result.ga.session_generation,stage_receipt_refs:result.ga.stage_receipt_refs};
 check(same(sm.observations,statusExpected)&&[binding.profile_sha256,binding.gate_sha256,binding.controller_sha256,binding.scope_sha256].every(h=>sm.source_digests.includes(h)),'STATUS_EXACT_CURRENT_OBSERVATION_BINDING');
 const statusSources=[...result.ga.stage_receipt_refs,result.ga.scope_ref,result.ga.controller_qualification_ref,result.ga.authority_source_ref];
 check(statusSources.every(ref=>sm.source_refs.some(x=>same(x,ref))),'STATUS_EXACT_SOURCE_REFS');
 check(same(statusInput.store_ref,result.ga.status_manifest_ref)&&statusInput.source_binding_sha256===binding.runtime_acceptance_sha256,'STATUS_STORE_MAPPING');
 verifyOwnerMergeArtifact({...statusInput.publication,raw:statusInput.payload_raw});
 const smPayload=structuredClone(sm);delete smPayload.signature_binding;
 check(canonicalDigest(smPayload)===result.accepted_subject.late_bound_fields.status_manifest_ref.signed_payload_sha256,'EXACT_ACCEPTED_LATE_BOUND_STATUS_PAYLOAD');
 check(sm.object_type==='StatusManifest'&&sm.signature_binding?.owner_merge_commit===statusInput.publication.commitSha&&sm.signature_binding.signed_object_sha256===canonicalDigest(smPayload)&&same(smPayload,JSON.parse(statusInput.payload_raw)),'EXACT_ORIGINAL_STATUS_OWNER_MERGE_PAYLOAD');

 // Retain exact verified source privately until this single committed dispatch returns.
 const originalBinding=canonicalDigest(binding),originalRoot=canonicalDigest(material.observation.row.execution.root);
 const gaRaw=material.ga_raw,operation=material.operation;
 if(operation==='GRR'){
  const receipt=verifyResultMaterials({material,subject:result.accepted_subject,root,state:material.observation.row.execution,ga:result.ga});
  const originalState=canonicalDigest(material.observation.row.execution);
  let finished=false;
  return Object.freeze({kind:'RESULT_TERMINAL',finishResult(observation){
   check(!finished,'ONE_RESULT_FINISH_ONLY');finished=true;
   check(canonicalDigest(observation?.row?.execution)===originalState,'RESULT_RESERVATION_OR_CURRENT_CHANGED');
   checkCurrentSemantics({gaRaw,operation,observation,runtimeAcceptance:runtime,qualification,terminalResult:receipt.result});
   seriesCheck(observation.row.execution);
   checkResultSemantics({raw:material.grr_raw,gaRaw,state:observation.row.execution,acceptedSchemaSha256:result.accepted_subject.control_schema_refs.GateResultReceipt.sha256});
   return {state:'EXACT_RESULT_REQUIRES_TERMINAL_CAS',request:resultCommitRequest(material.grr_raw,receipt),receipt_id:receipt.gate_result_receipt_id,ga_id:receipt.gate_authorization_id,result:receipt.result,automatic_retry:false,qualified:false};
  }});
 }
 check(['CREATE','START'].includes(operation),'FIXED_EFFECT_ENTRY_ONLY');
 const intent=intentFor(gaRaw,operation),dispatchKey=deriveEventKey(gaRaw,operation,'sent');
 let used=false;
 return Object.freeze({intent:structuredClone(intent),dispatch_key:dispatchKey,finishDispatch({record,dispatch}){
  check(!used,'ONE_DISPATCH_FINISH_ONLY');used=true;
  const {currentSource,expectedQuery,response}=checkDispatchEvidence({record,dispatch,intent,dispatchKey,project,operation});
  check(canonicalDigest(currentSource?.binding)===originalBinding&&canonicalDigest(currentSource.root)===originalRoot,'ROOT_OR_BINDING_CHANGED_AFTER_SIGNATURE');
  check(same(currentSource.control_objects,material.observation.row.execution.control_objects),'CONTROL_OBJECT_SOURCE_CHANGED_AFTER_SIGNATURE');
  const observation={project,query_sha256:sha(dispatch.query),row:{observed_at:currentSource.observed_at,execution:currentSource}};
  const current=checkCurrentSemantics({gaRaw,operation,observation,runtimeAcceptance:runtime,qualification,admissionPhase:'DISPATCHED_ONCE',expectedQuerySha256:sha(expectedQuery)});
  check(current.sequence===response.sequence,'EXACT_DISPATCH_CURRENT_SEQUENCE');currentWindow(sm.as_of,sm.expires_at,Date.now());
  seriesCheck(currentSource);
  const actual=invokeFixedHost({gaRaw,operation,containerId:current.attempt.container_id,deadline:time(current.ga.deadline)});
  const eventOperation=operation==='CREATE'?'CREATED':'RUNNING';
  const raw=JSON.stringify({ga_id:intent.gaId,ga_sha256:sha(gaRaw),operation:eventOperation,container_id:actual.container_id,observation:actual.observation,started_utc:actual.started_utc,ended_utc:actual.ended_utc})+'\n';
  return {state:'ACTUAL_HOST_EFFECT_REQUIRES_REMOTE_RESULT',ga_sha256:sha(gaRaw),operation,container_id:actual.container_id,
   event_request:{idempotency_key:deriveEventKey(gaRaw,operation,'observed'),expected_sequence:current.sequence,ga_id:intent.gaId,operation:eventOperation,body:{container_id:actual.container_id,raw,sha256:sha(raw)}},capacity_released:false,qualified:false,automatic_retry:false};
 }});
}
