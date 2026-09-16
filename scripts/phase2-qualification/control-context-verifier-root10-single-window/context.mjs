import {intentFor} from '../preentry-parent/runtime-successor/sql_effect.mjs';
import {deriveEventKey} from '../preentry-parent/runtime-successor/supervisor.mjs';
import {checkDispatchEvidence} from '../control-context-verifier-runtime180/dispatch-evidence.mjs';
import {invokeFixedHost} from './host-effect.mjs';
import {checkConsumedBudget} from '../control-context-verifier-runtime600/budget-evidence.mjs';
import {checkLateBoundPolicy} from '../control-context-verifier-runtime600/late-bound-policy.mjs';
import {verifySourcePublication} from './source-publication.mjs';
import {verifyResultMaterials,resultCommitRequest,checkAuthorizationLifetime} from './result-terminal.mjs';
import {checkResultSemantics} from './grr.mjs';
import fs from 'node:fs';
import boundedCrypto from 'node:crypto';import {isDeepStrictEqual as boundedSame} from 'node:util';
import {createRequire} from 'node:module';
import {sha,readBlobRef,verifyOwnerMergeArtifact,verifyDynamicPayload} from './trusted-github.mjs';
import {validateRootShape,canonicalDigest,signaturePayloadDigest} from './root-window-validation.mjs';
import {loadRoot10ControllerContract,checkRoot10RuntimeBinding,checkRoot10SingleWindowSeries,readRoot10TemporalContext,checkRoot10TemporalTime,root10TemporalIdentity,readRoot10RuntimeClockContext,checkRoot10RuntimeClockTime,root10RuntimeClockIdentity,readRoot10ScopeContext,checkRoot10ScopeTime,root10ScopeIdentity} from './root10-single-window.mjs';
import {verifyRuntimeDependencies} from './runtime-dependencies.mjs';
const root10Contract=loadRoot10ControllerContract();
export const project='uscrdifznmlvczcekqpw',rootID=root10Contract.value.root_id,generation=root10Contract.value.generation_id;
export const windowExpiry=root10Contract.value.window.expires_at;
export const gateID='G-PREENTRY-SKILL-QUALIFICATION',audience='urn:clued:audience:skill-coexistence-qualification:'+project;
export const sql="select clock_timestamp() as observed_at, clued_control.read_execution() as execution";
export const qualificationLimits=Object.freeze({allocations:root10Contract.value.caps.allocations,forwards:root10Contract.value.caps.forwards,seconds:root10Contract.value.caps.seconds,evidenceBytes:root10Contract.value.caps.evidence_bytes,originalInputBytes:root10Contract.value.caps.original_input_bytes,publicationBytes:root10Contract.value.caps.publication_bytes});
verifyRuntimeDependencies();
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
export function checkCumulativeBudget(current,binding){check(current.charged_seconds>=binding.prior_seconds&&current.charged_seconds<=qualificationLimits.seconds&&current.charged_evidence_bytes>=binding.prior_evidence_bytes&&current.charged_evidence_bytes<=qualificationLimits.evidenceBytes,'ACTUAL_CUMULATIVE_BUDGET');}
const same=(a,b)=>canonicalDigest(a)===canonicalDigest(b);
function safe(value){if(typeof value==='number')check(Number.isSafeInteger(value),'UNSAFE_NUMBER');else if(value&&typeof value==='object')for(const v of Object.values(value))safe(v);}
export function parseExact(raw){check(typeof raw==='string'&&Buffer.byteLength(raw)<=131072,'BOUNDED_RAW_JSON');const p=JSON.parse(raw);safe(p);check(JSON.stringify(p)+'\n'===raw,'EXACT_UNIQUE_COMPACT_JSON');return p;}
export function checkGAShape(raw){const ga=parseExact(raw);check(gaCheck(ga),'COMPLETE_GA_SCHEMA_REJECTED');check(ga.schema_digest===sha(gaSchemaBytes),'EXACT_ACCEPTED_GA_SCHEMA');return ga;}
export function checkFixedGAFields(ga,subject){
 checkLateBoundPolicy(subject.late_bound_fields);
 const varying=new Set(['budget_reservation_ref','status_manifest_ref','target_revision','gate_authorization_id','authorization_status','issued_at','expires_at','deadline','idempotency_key','signature','runner_generation','credential_generation','session_generation']);
 for(const field of JSON.parse(gaSchemaBytes).required)if(!varying.has(field))check(subject.expected_ga&&Object.hasOwn(subject.expected_ga,field)&&same(ga[field],subject.expected_ga[field]),'EXACT_ACCEPTED_GA_FIELD:'+field);
}
function parseAdministrative(raw){
 check(typeof raw==='string','ADMIN_JSON_STRING');const value=JSON.parse(raw);let compact='',quoted=false,escaped=false;
 for(const ch of raw){if(quoted){compact+=ch;if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;}else if(ch==='"'){quoted=true;compact+=ch;}else if(!' \t\r\n'.includes(ch))compact+=ch;}
 check(compact===JSON.stringify(value),'ADMIN_JSON_UNIQUE_CANONICAL_VALUES');return value;
}
export function parseStoredStatus(raw){check(typeof raw==='string'&&Buffer.byteLength(raw)<=131072,'BOUNDED_STATUS_JSON');const value=parseAdministrative(raw);safe(value);return value;}
export function time(s){check(typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(s),'UTC_TIME_REQUIRED');const v=Date.parse(s);check(Number.isFinite(v)&&new Date(v).toISOString().slice(0,19)===s.slice(0,19),'INVALID_CALENDAR_TIME');return v;}
function currentWindow(start,end,now){check(time(start)<=now&&now<time(end),'EXPIRED_OR_NOT_YET_VALID');}
export function checkCurrentSemantics({gaRaw,operation,observation,runtimeAcceptance,qualification,now=Date.now(),admissionPhase='PREFLIGHT',expectedQuerySha256=sha(sql),terminalResult=null}){
 const ga=checkGAShape(gaRaw);
 const nonPass=operation==='GRR'&&['FAIL','BLOCKED','STALE'].includes(terminalResult);
 check(['CREATE','START','STOP','GRR'].includes(operation),'FIXED_OPERATION_ONLY');
 check(observation?.project===project&&observation.query_sha256===expectedQuerySha256,'FIXED_CURRENT_QUERY_REQUIRED');
 const readTime=Date.parse(observation.row?.observed_at);check(Number.isFinite(readTime)&&readTime<=now+1000&&now-readTime<=15000,'FRESH_SQL_OBSERVATION_REQUIRED');
 const state=observation.row.execution;check(state&&state.binding?.root_id===rootID&&state.current?.root_id===rootID,'EXACT_EXECUTION_BINDING');
 const root=state.root;check(root?.root_set_id===rootID&&root.state==='STORED_NO_GATE_AUTHORITY'&&root.generation_id===generation,'CURRENT_ROOT_GENERATION_REQUIRED');
 check(Array.isArray(root.events)&&root.events.length===root.sequence&&root.events.every((e,i)=>e.root_id===rootID&&e.sequence===i+1),'COMPLETE_ROOT_HISTORY');
 const registration=root.events.filter(e=>e.request.kind==='GENERATION_REGISTERED').at(-1);check(registration?.request.generation_id===generation,'CURRENT_ROOT_EVENT');
 const body=registration.request.body;validateRootShape(body,root10Contract.value.window);
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
 const temporal=readRoot10TemporalContext({gaRaw,execution:state,descriptor:runtimeAcceptance?.accepted_subject?.temporal_continuation});
 const runtimeClock=readRoot10RuntimeClockContext({gaRaw,execution:state,descriptor:runtimeAcceptance?.accepted_subject?.runtime_clock});
 // The scope amendment carries the runtime clock forward and occupies the same
 // slot, so exactly one clock amendment is ever in force.
 const scope=readRoot10ScopeContext({gaRaw,execution:state,descriptor:runtimeAcceptance?.accepted_subject?.scope_amendment});
 check([temporal,runtimeClock,scope].filter(Boolean).length<=1,'ONE_CLOCK_AMENDMENT_ONLY');
 const rc=scope??runtimeClock;
 check(binding.gate_id===gateID&&ga.gate_id===gateID,'EXACT_SINGLE_REGISTERED_GATE');
 const gaBinding=rc?{controller_sha256:root10RuntimeClockIdentity.original_controller_sha256,qualification_sha256:root10RuntimeClockIdentity.original_qualification_sha256}:temporal?temporal.body.old_binding:binding;
 check(ga.controller_digest===gaBinding.controller_sha256&&ga.controller_qualification_ref.sha256===gaBinding.qualification_sha256&&ga.scope_digest===binding.scope_sha256&&ga.profile_digest===binding.profile_sha256,'EXACT_CONTROLLER_SCOPE_BINDING');
 check(runtimeAcceptance?.state==='ACCEPTED_EXACT_PREENTRY_CONTROLLER_RUNTIME'&&runtimeAcceptance.independent_reviewer==='/root','EXACT_RUNTIME_ACCEPTANCE_METADATA_REQUIRED');
 currentWindow(runtimeAcceptance.not_before,runtimeAcceptance.expires_at,now);
 const subject=runtimeAcceptance.accepted_subject;
 check(subject?.root_id===rootID&&subject.project_ref===project&&subject.gate.gate_id===gateID&&subject.gate.definition_version===binding.gate_version&&subject.gate.content_digest===binding.gate_sha256,'ACCEPTED_GATE_VERSION_DIGEST');
 check(ga.artifact_refs.some(r=>r.sha256===binding.gate_sha256)&&ga.scope_ref.sha256===binding.scope_sha256,'GATE_AND_SCOPE_IN_SIGNED_GA');
 check(qualification?.state==='ACCEPTED_SCOPED_CONTROLLER_QUALIFICATION'&&qualification.independent_reviewer==='/root'&&qualification.controller_digest===binding.controller_sha256&&qualification.scope_digest===binding.scope_sha256&&qualification.environment==='ISOLATED_TEST'&&qualification.purpose===ga.purpose,'EXACT_CONTROLLER_QUALIFICATION');
 currentWindow(qualification.not_before,qualification.expires_at,now);
 check(qualification.independent_of_tested_skill===true&&qualification.forbidden_stage_dependencies_excluded===true,'CONTROLLER_SELF_QUALIFICATION_FORBIDDEN');
 // Reuse the same fixed/late-bound contract in execution and result preparation.
 checkFixedGAFields(ga,subject);
 check(ga.stage_receipt_refs.length===6&&subject.required_stages?.join(',')==='R05,R06,R07,R08,R09,R10','EXACT_STAGE_INPUTS');
 const issued=time(ga.issued_at),expires=time(ga.expires_at),deadline=time(ga.deadline);
 if(rc){
  // Validate the original signed lifetime without substituting a new clock in
  // the GA; the separately accepted runtime-clock amendment supplies the
  // preparation and finalization windows, and the container's own observed
  // start supplies the runtime clock.
  check(issued<deadline&&deadline===expires&&expires-issued===600000,'ORIGINAL_GA_WINDOW');
  if(scope)checkRoot10ScopeTime({context:scope,execution:state,operation,now});
  else checkRoot10RuntimeClockTime({context:rc,execution:state,operation,now});
 }else if(temporal){
  // Validate the original signed lifetime without substituting a new clock in
  // the GA; the separately accepted amendment supplies the current window.
  check(issued<deadline&&deadline===expires&&expires-issued===600000,'ORIGINAL_GA_WINDOW');
  checkRoot10TemporalTime({context:temporal,execution:state,operation,now});
 }else checkAuthorizationLifetime({operation,result:terminalResult,issued,deadline,expires,now});
 check(profile.max_lifetime_seconds===600&&issued<deadline&&expires<=time(body.expires_at)&&expires<=time(runtimeAcceptance.expires_at)&&expires<=time(qualification.expires_at),'GA_WINDOW');
 check(Array.isArray(attempts),'ACTUAL_ATTEMPTS_REQUIRED');
 const selected=attempts.filter(a=>a.ga_id===ga.gate_authorization_id);check(selected.length===1,'ONE_EXACT_GA_ATTEMPT');const attempt=selected[0];
 check(current.active_ga_id===ga.gate_authorization_id&&attempt.root_id===rootID&&(nonPass||!attempt.revoked)&&attempt.ga_raw===gaRaw&&attempt.ga_sha256===sha(gaRaw)&&same(attempt.ga,ga),'EXACT_ACTIVE_RESERVATION');
 checkConsumedBudget({ga,state,attempt,root:body,project,now:nonPass?issued:now});
 check(attempt.receipt_raw===null&&attempt.receipt_id===null,'NO_SECOND_RECEIPT');
 check(['PREFLIGHT','DISPATCHED_ONCE'].includes(admissionPhase),'FIXED_ADMISSION_PHASE');
 check(attempt.phase===(admissionPhase==='DISPATCHED_ONCE'?operation+'_SENT':({CREATE:'PENDING',START:'CREATED',STOP:'RUNNING',GRR:'SIGNING'}[operation])),'NO_REDISPATCH_OR_UNKNOWN');
 check(Date.parse(attempt.expires_at)===deadline,'RESERVATION_DEADLINE');
 checkCumulativeBudget(current,binding);
 return {state:'SEMANTICS_ONLY_NOT_ADMISSION',ga,root:body,attempt,accepted_subject:subject,sequence:current.sequence,temporal,rc,scope};
}
function signedMetadata(item,expectedSha){check(typeof item?.raw==='string'&&sha(item.raw)===expectedSha,'ACCEPTANCE_BYTES_MISSING_OR_DRIFT');verifyOwnerMergeArtifact({...item.publication,raw:item.raw});return JSON.parse(item.raw);}

// BEGIN ROOT10 EXACT SINGLE-WINDOW SERIES
// The signed runtime binds the local contract and all Owner-published descriptors. The controller
// exposes no NEXT_ALLOCATION/NEXT_FORWARD/repair/successor entry: Root9 is an immutable baseline.
function loadAuthenticatedBoundedSeries(runtime,binding){
 const root10=checkRoot10RuntimeBinding({contract:root10Contract.value,contractSha256:root10Contract.sha256,runtime,binding});
 return Object.freeze({
  root10,
  check(execution,operation,gaId,result){
   return checkRoot10SingleWindowSeries({contract:root10Contract.value,execution,operation,gaId,result});
  }
 });
}
// END ROOT10 EXACT SINGLE-WINDOW SERIES

export async function prepareTrustedToolMaterial(material){
 // This function is called by the fixed tool-origin entry below, never by child input.
 // SQL tool-call authenticity comes from that trusted caller, not a JSON member.
 const binding=material?.observation?.row?.execution?.binding;check(binding,'ACTUAL_SQL_BINDING_MISSING');
 check(sha(material.runtime_acceptance?.raw??'')===binding.runtime_acceptance_sha256&&sha(material.controller_qualification?.raw??'')===binding.qualification_sha256,'EXACT_METADATA_BYTES_REQUIRED');
 const runtime=JSON.parse(material.runtime_acceptance.raw),qualification=JSON.parse(material.controller_qualification.raw);
 const terminal=material.operation==='GRR'?parseExact(material.grr_raw):null;
 const nonPass=terminal&&['FAIL','BLOCKED','STALE'].includes(terminal.result);
 // Consume the initial snapshot freshness before GitHub I/O. This grants no
 // authority; the committed-dispatch challenge below rechecks fresh SQL state.
 const result=checkCurrentSemantics({gaRaw:material.ga_raw,operation:material.operation,observation:material.observation,runtimeAcceptance:runtime,qualification,terminalResult:terminal?.result});
 signedMetadata(material.runtime_acceptance,binding.runtime_acceptance_sha256);
 const series=loadAuthenticatedBoundedSeries(runtime,binding);
 const seriesOperation=terminal?'RESULT_RECONCILIATION':'CURRENT_DISPATCH';
 const seriesCheck=execution=>series.check(execution,seriesOperation,parseExact(material.ga_raw).gate_authorization_id,terminal?.result);
 seriesCheck(material.observation.row.execution);
 // No effects or admission exist while these initially untrusted metadata bytes are checked.
 signedMetadata(material.controller_qualification,binding.qualification_sha256);
 if(result.scope){
  // The scope amendment is a separately published Owner document, authenticated
  // exactly as its predecessor is. It occupies the runtime clock's material slot
  // because it carries that clock forward; the host window it bounds is still the
  // 600 seconds event 119 fixed, never a longer one.
  const descriptor=result.scope.descriptor,input=material.scope_amendment;
  check(input&&Object.keys(input).sort().join(',')==='event,host_window,publication,raw,sha256'&&sha(input.raw)===descriptor.amendment_ref.sha256&&input.sha256===descriptor.amendment_ref.sha256&&same(input.event,result.scope.event),'EXACT_SEPARATE_SCOPE_AUTHORITY_MATERIAL');
  const hw=input.host_window;
  check(hw&&Object.keys(hw).sort().join(',')==='deadline_utc,prepared_utc'&&time(hw.deadline_utc)-time(hw.prepared_utc)===600000&&time(hw.prepared_utc)>=result.scope.issued&&time(hw.prepared_utc)<=Date.now()+2000&&time(hw.deadline_utc)<=result.scope.final,'EXACT_SCOPE_HOST_WINDOW');
  const publication=verifyOwnerMergeArtifact({commitSha:input.publication.commitSha,artifactPath:input.publication.artifactPath,raw:input.raw});
  check(same(publication.blob_ref,descriptor.amendment_ref),'ACTUAL_OWNER_SCOPE_AMENDMENT_PUBLICATION');
  const amendment=JSON.parse(input.raw);
  check(amendment.object_type==='Root10ScopeAmendment'&&amendment.root_id===rootID&&amendment.control_trust_root_generation===generation&&amendment.activation?.ga_ref?.ga_id===root10ScopeIdentity.ga_id&&amendment.activation.ga_ref.sha256===sha(material.ga_raw)&&amendment.activation.budget_ref?.sequence===117&&amendment.activation.budget_ref.sha256===root10ScopeIdentity.budget_sha256&&amendment.activation.maximum_activations===1&&amendment.activation.expected_sequence===119&&amendment.activation.runtime_seconds===600&&amendment.activation.max_predispatch_resets===3&&amendment.activation.preparation_expires_at===windowExpiry&&amendment.activation.finalization_expires_at===windowExpiry&&amendment.supersedes?.sha256===root10RuntimeClockIdentity.amendment_sha256,'EXACT_SIGNED_SCOPE_AUTHORITY_SCOPE');
  const originalManifest=result.ga.source_ref.blobs.filter(ref=>ref.sha256===result.ga.controller_digest);
  check(originalManifest.length===1,'ONE_ORIGINAL_SCOPE_SOURCE_MANIFEST');
  const originalRaw=readBlobRef(originalManifest[0]);
  verifyOwnerMergeArtifact({commitSha:result.ga.target_revision,artifactPath:'scripts/phase2-qualification/control-context-verifier-root10-single-window/ControllerSourceManifest.candidate.json',raw:originalRaw});
  verifySourcePublication({sourceRef:descriptor.source_ref,ownerMerge:material.runtime_acceptance.publication.commitSha,controllerDigest:binding.controller_sha256});
 }else if(result.rc){
  const descriptor=result.rc.descriptor,input=material.runtime_clock;
  check(input&&Object.keys(input).sort().join(',')==='event,host_window,publication,raw,sha256'&&sha(input.raw)===descriptor.amendment_ref.sha256&&input.sha256===descriptor.amendment_ref.sha256&&same(input.event,result.rc.event),'EXACT_SEPARATE_RUNTIME_CLOCK_AUTHORITY_MATERIAL');
  const hw=input.host_window;
  check(hw&&Object.keys(hw).sort().join(',')==='deadline_utc,prepared_utc'&&time(hw.deadline_utc)-time(hw.prepared_utc)===600000&&time(hw.prepared_utc)>=result.rc.issued&&time(hw.prepared_utc)<=Date.now()+2000&&time(hw.deadline_utc)<=result.rc.final,'EXACT_RUNTIME_CLOCK_HOST_WINDOW');
  const publication=verifyOwnerMergeArtifact({commitSha:input.publication.commitSha,artifactPath:input.publication.artifactPath,raw:input.raw});
  check(same(publication.blob_ref,descriptor.amendment_ref),'ACTUAL_OWNER_RUNTIME_CLOCK_AMENDMENT_PUBLICATION');
  const amendment=JSON.parse(input.raw);
  check(amendment.object_type==='Root10RuntimeClockAmendment'&&amendment.root_id===rootID&&amendment.control_trust_root_generation===generation&&amendment.activation?.ga_ref?.ga_id===root10RuntimeClockIdentity.ga_id&&amendment.activation.ga_ref.sha256===sha(material.ga_raw)&&amendment.activation.budget_ref?.sequence===117&&amendment.activation.budget_ref.sha256===root10RuntimeClockIdentity.budget_sha256&&amendment.activation.maximum_activations===1&&amendment.activation.expected_sequence===118&&amendment.activation.runtime_seconds===600&&amendment.activation.max_predispatch_resets===3&&amendment.activation.preparation_expires_at===windowExpiry&&amendment.activation.finalization_expires_at===windowExpiry&&amendment.supersedes?.sha256===root10TemporalIdentity.amendment_sha256,'EXACT_SIGNED_RUNTIME_CLOCK_AUTHORITY_SCOPE');
  const originalManifest=result.ga.source_ref.blobs.filter(ref=>ref.sha256===result.ga.controller_digest);
  check(originalManifest.length===1,'ONE_ORIGINAL_RUNTIME_CLOCK_SOURCE_MANIFEST');
  const originalRaw=readBlobRef(originalManifest[0]);
  verifyOwnerMergeArtifact({commitSha:result.ga.target_revision,artifactPath:'scripts/phase2-qualification/control-context-verifier-root10-single-window/ControllerSourceManifest.candidate.json',raw:originalRaw});
  verifySourcePublication({sourceRef:descriptor.source_ref,ownerMerge:material.runtime_acceptance.publication.commitSha,controllerDigest:binding.controller_sha256});
 }else if(result.temporal){
  const descriptor=result.temporal.descriptor,input=material.temporal_continuation;
  check(input&&Object.keys(input).sort().join(',')==='event,publication,raw,sha256'&&sha(input.raw)===descriptor.amendment_ref.sha256&&input.sha256===descriptor.amendment_ref.sha256&&same(input.event,result.temporal.event)&&same(input.publication,descriptor.publication),'EXACT_SEPARATE_TEMPORAL_AUTHORITY_MATERIAL');
  const publication=verifyOwnerMergeArtifact({commitSha:input.publication.commitSha,artifactPath:input.publication.artifactPath,raw:input.raw});
  check(same(publication.blob_ref,descriptor.amendment_ref),'ACTUAL_OWNER_TEMPORAL_AMENDMENT_PUBLICATION');
  const amendment=JSON.parse(input.raw);
  check(amendment.object_type==='Root10TemporalContinuationAmendment'&&amendment.root_id===rootID&&amendment.control_trust_root_generation===generation&&amendment.ga_ref?.ga_id===root10TemporalIdentity.ga_id&&amendment.ga_ref.sha256===sha(material.ga_raw)&&amendment.ga_ref.original_deadline===result.ga.deadline&&amendment.budget_ref?.sequence===117&&amendment.budget_ref.sha256===root10TemporalIdentity.budget_sha256&&amendment.activation?.maximum_activations===1&&amendment.activation.expected_sequence===117&&amendment.time_authority?.effect_seconds===600&&amendment.time_authority.finalization_expires_at===windowExpiry,'EXACT_SIGNED_TEMPORAL_AUTHORITY_SCOPE');
  check(amendment.predecessor_contract?.controller_sha256===result.ga.controller_digest&&amendment.predecessor_contract.runtime_acceptance_sha256===result.temporal.body.old_binding.runtime_acceptance_sha256&&amendment.predecessor_contract.controller_qualification_sha256===result.ga.controller_qualification_ref.sha256&&amendment.predecessor_contract.status_manifest_sha256===result.ga.status_manifest_ref.sha256,'EXACT_ORIGINAL_GA_PREDECESSOR_AUTHORITY');
  const originalManifest=result.ga.source_ref.blobs.filter(ref=>ref.sha256===result.ga.controller_digest);
  check(originalManifest.length===1,'ONE_ORIGINAL_TEMPORAL_SOURCE_MANIFEST');
  const originalRaw=readBlobRef(originalManifest[0]);
  verifyOwnerMergeArtifact({commitSha:result.ga.target_revision,artifactPath:'scripts/phase2-qualification/control-context-verifier-root10-single-window/ControllerSourceManifest.candidate.json',raw:originalRaw});
  verifySourcePublication({sourceRef:descriptor.source_ref,ownerMerge:material.runtime_acceptance.publication.commitSha,controllerDigest:binding.controller_sha256});
 }else{
  check(result.ga.target_revision===material.runtime_acceptance.publication.commitSha,'ACTUAL_RUNTIME_PUBLICATION_TARGET');
  verifySourcePublication({sourceRef:result.ga.source_ref,ownerMerge:material.runtime_acceptance.publication.commitSha,controllerDigest:binding.controller_sha256});
 }
 const root=result.root,rootProof=JSON.parse(readBlobRef(root.signature_binding.signature_evidence_ref));
 const rootPayloadRaw=readBlobRef({uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'+rootProof.payload.blob_sha,sha256:rootProof.payload.file_sha256});
 check(rootProof.merge.sha===root.signature_binding.owner_merge_commit&&signaturePayloadDigest(root)===canonicalDigest(JSON.parse(rootPayloadRaw))&&root.signature_binding.signed_object_sha256===signaturePayloadDigest(root),'EXACT_ROOT_SIGNING_PAYLOAD');
 verifyOwnerMergeArtifact({commitSha:rootProof.merge.sha,artifactPath:rootProof.payload.artifact_path??rootProof.payload.path,raw:rootPayloadRaw});
 for(const purpose of ['STATUS','GATE_AUTHORIZATION','GATE_RESULT']){
  const issuers=root.issuer_bindings.filter(i=>i.purpose===purpose);check(issuers.length===1&&issuers[0].subject_id==='tdoljyj'&&issuers[0].signing_service==='web-flow'&&issuers[0].audience===audience,'SEPARATE_ROOT_ISSUER_PURPOSE');
  const expectedQualification=root10Contract.value.issuer_qualification_refs[purpose];check(same(issuers[0].qualification_ref,expectedQualification)&&same(series.root10.issuer_qualification_refs[purpose],expectedQualification),'EXACT_ROOT10_PURPOSE_ALGORITHM_METADATA_REF');
  const metadata=JSON.parse(readBlobRef(issuers[0].qualification_ref));
  check(metadata.control_trust_root_generation===generation&&metadata.root_set_id===rootID&&metadata.subject_id==='tdoljyj'&&metadata.signing_service==='web-flow'&&metadata.accepted_audience===audience&&metadata.accepted_scope?.new_gate_authorizations_max===1&&metadata.accepted_scope?.cumulative_controlled_execution_seconds===qualificationLimits.seconds&&metadata.accepted_scope?.cumulative_evidence_bytes===qualificationLimits.evidenceBytes&&metadata.accepted_scope?.series_allocations_max===qualificationLimits.allocations&&metadata.accepted_scope?.no_refund===true&&metadata.accepted_scope?.no_automatic_retry===true&&metadata.accepted_issuer_purposes?.length===1&&metadata.accepted_issuer_purposes[0].purpose===purpose&&metadata.accepted_issuer_purposes[0].accepted===true&&metadata.accepted_issuer_purposes[0].audience===audience,'EXACT_ROOT10_PURPOSE_QUALIFICATION');currentWindow(metadata.not_before,metadata.expires_at,Date.now());
  if(purpose==='GATE_AUTHORIZATION')check(same(result.ga.issuer_ref,issuers[0].qualification_ref),'ACTUAL_GA_ISSUER_QUALIFICATION_REF');
 }
 check(result.ga.authority_source_ref.uri==='urn:clued:control-trust-root-set:'+project+':'+rootID&&result.ga.authority_source_ref.sha256===canonicalDigest(root),'ACTUAL_CURRENT_ROOT_REF');
 const gate=material.gate_definition;check(sha(gate?.raw??'')===binding.gate_sha256,'GATE_DEFINITION_BYTES');verifyOwnerMergeArtifact({...gate.publication,raw:gate.raw});
 const profileInput=material.profile_signing_payload;
 check(profileInput?.raw&&sha(profileInput.raw)===result.accepted_subject.profile_signing_payload_ref?.sha256,'EXACT_ACCEPTED_PROFILE_PAYLOAD_INPUT');
 const profileProof=JSON.parse(profileInput.raw);check(same(profileProof.profile_definition,profile),'PROFILE_SOURCE');
 verifyOwnerMergeArtifact({...profileInput.publication,raw:profileInput.raw});
 verifyDynamicPayload(material.ga_raw,'GateAuthorization',result.ga.deadline,(nonPass||result.temporal||result.rc)?result.ga.issued_at:null);
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
 const sm=parseStoredStatus(statusInput.raw);check(sha(statusInput.raw)===result.ga.status_manifest_ref.sha256,'EXACT_STATUS_BYTES');
 check(same(sm.issuer_ref,root.issuer_bindings.find(i=>i.purpose==='STATUS').qualification_ref),'EXACT_STATUS_ISSUER_REF');
 check(result.ga.status_manifest_ref.uri==='control://status-manifests/'+sm.status_manifest_id,'ORIGINAL_TYPED_STATUS_URI');
 const storedStatus=material.observation.row.execution.control_objects?.filter(x=>x.object_type==='StatusManifest'&&x.uri===result.ga.status_manifest_ref.uri);
 check(storedStatus?.length===1&&storedStatus[0].raw===statusInput.raw&&storedStatus[0].sha256===sha(statusInput.raw),'ACTUAL_STORED_STATUS_READ_REQUIRED');
 const statusSchemaRaw=readBlobRef(acceptedStatus);
 check(sha(statusSchemaRaw)===sha(fs.readFileSync(new URL('./status-manifest.root5.schema.json',import.meta.url))),'EXACT_LOCAL_ROOT10_STATUS_SCHEMA_SUCCESSOR');
 const statusCheck=new Ajv({allErrors:true,strictKeywords:true,format:'full'}).compile(JSON.parse(statusSchemaRaw));
 check(statusCheck(sm)&&sm.schema_digest===acceptedStatus.sha256&&sm.issuer_purpose==='STATUS'&&sm.audience===audience&&sm.control_trust_root_generation===generation,'EXACT_SIGNED_STATUS_SCHEMA_PURPOSE');
 check(time(sm.as_of)<=Date.now()&&(nonPass||Date.now()<time(sm.expires_at))&&Array.isArray(sm.source_digests)&&sm.source_digests.length>0,'STATUS_CURRENT_INPUTS');
 // Status29 remains the original signed GA input. The separate immutable
 // temporal or runtime-clock event binds the new controller; Status29 is never
 // rewritten, so it always names the original controller and acceptance.
 const statusBinding=result.rc?{controller_sha256:root10RuntimeClockIdentity.original_controller_sha256,runtime_acceptance_sha256:root10RuntimeClockIdentity.original_runtime_acceptance_sha256}:result.temporal?result.temporal.body.old_binding:binding;
 const statusExpected={root_set_id:rootID,root_generation:generation,profile_digest:binding.profile_sha256,gate_digest:binding.gate_sha256,controller_digest:statusBinding.controller_sha256,scope_digest:binding.scope_sha256,runner_generation:result.ga.runner_generation,credential_generation:result.ga.credential_generation,session_generation:result.ga.session_generation,stage_receipt_refs:result.ga.stage_receipt_refs};
 check(same(sm.observations,statusExpected)&&[binding.profile_sha256,binding.gate_sha256,statusBinding.controller_sha256,binding.scope_sha256].every(h=>sm.source_digests.includes(h)),'STATUS_EXACT_CURRENT_OBSERVATION_BINDING');
 const statusSources=[...result.ga.stage_receipt_refs,result.ga.scope_ref,result.ga.controller_qualification_ref,result.ga.authority_source_ref];
 check(statusSources.every(ref=>sm.source_refs.some(x=>same(x,ref))),'STATUS_EXACT_SOURCE_REFS');
 check(same(statusInput.store_ref,result.ga.status_manifest_ref)&&statusInput.source_binding_sha256===statusBinding.runtime_acceptance_sha256,'STATUS_STORE_MAPPING');
 verifyOwnerMergeArtifact({...statusInput.publication,raw:statusInput.payload_raw});
 const smPayload=structuredClone(sm);delete smPayload.signature_binding;
 check(canonicalDigest(smPayload)===result.accepted_subject.late_bound_fields.status_manifest_ref.signed_payload_sha256,'EXACT_ACCEPTED_LATE_BOUND_STATUS_PAYLOAD');
 check(sm.object_type==='StatusManifest'&&sm.signature_binding?.owner_merge_commit===statusInput.publication.commitSha&&sm.signature_binding.signed_object_sha256===canonicalDigest(smPayload)&&same(smPayload,JSON.parse(statusInput.payload_raw)),'EXACT_ORIGINAL_STATUS_OWNER_MERGE_PAYLOAD');

 // Retain exact verified source privately until this single committed dispatch returns.
 const originalBinding=canonicalDigest(binding),originalRoot=canonicalDigest(material.observation.row.execution.root);
 const gaRaw=material.ga_raw,operation=material.operation;
 if(operation==='STOP'){
  check(result.temporal||result.rc,'EXACT_CLOCK_AMENDED_STOP_AUTHORITY_REQUIRED');
  let used=false;
  return Object.freeze({kind:'VERIFIED_TEMPORAL_STOP_AUTHORITY',verifyCommittedStop(observation){
   check(!used,'ONE_STOP_AUTHORITY_USE_ONLY');used=true;
   const execution=observation?.row?.execution;
   check(canonicalDigest(execution?.binding)===originalBinding&&canonicalDigest(execution.root)===originalRoot&&same(execution.control_objects,material.observation.row.execution.control_objects),'STOP_AUTHORITY_BOUNDARY_CHANGED');
   const checked=checkCurrentSemantics({gaRaw,operation,observation,runtimeAcceptance:runtime,qualification,admissionPhase:'DISPATCHED_ONCE'});
   seriesCheck(execution);
   return {state:'VERIFIED_TEMPORAL_STOP_DISPATCH',ga_id:checked.ga.gate_authorization_id,container_id:checked.attempt.container_id,deadline:checked.temporal?checked.temporal.deadline:checked.rc.final};
  }});
 }
 if(operation==='GRR'){
  const receipt=verifyResultMaterials({material,subject:result.accepted_subject,root,state:material.observation.row.execution,ga:result.ga});
  const originalState=canonicalDigest(material.observation.row.execution);
  let finished=false;
  return Object.freeze({kind:'RESULT_TERMINAL',finishResult(observation){
   check(!finished,'ONE_RESULT_FINISH_ONLY');finished=true;
   check(canonicalDigest(observation?.row?.execution)===originalState,'RESULT_RESERVATION_OR_CURRENT_CHANGED');
   checkCurrentSemantics({gaRaw,operation,observation,runtimeAcceptance:runtime,qualification,terminalResult:receipt.result});
   seriesCheck(observation.row.execution);
   checkResultSemantics({raw:material.grr_raw,gaRaw,state:observation.row.execution,acceptedSchemaSha256:result.accepted_subject.control_schema_refs.GateResultReceipt.sha256,temporalDescriptor:result.accepted_subject.temporal_continuation??null,runtimeClockDescriptor:result.accepted_subject.runtime_clock??null,scopeDescriptor:result.accepted_subject.scope_amendment??null});
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
  // Which material the fixed host is handed follows which amendment is in force, not
  // which slot the runtime clock used to occupy. current.rc is scope ?? runtimeClock, so
  // it is TRUTHY under the scope amendment -- reading material.runtime_clock off the back
  // of it dereferenced undefined and every CREATE and START died here with a TypeError,
  // after the host had been taught event 120 and before its caller had. The clock context
  // and the clock material have to be selected by the same question.
  const clock=current.scope?material.scope_amendment:material.runtime_clock;
  const actual=invokeFixedHost({gaRaw,operation,containerId:current.attempt.container_id,deadline:current.rc?time(clock.host_window.deadline_utc):current.temporal?.deadline??time(current.ga.deadline),temporal:current.rc?{raw:clock.raw,sha256:clock.sha256,event:current.rc.event,host_window:clock.host_window}:current.temporal?{raw:material.temporal_continuation.raw,sha256:material.temporal_continuation.sha256,event:current.temporal.event}:null});
  const eventOperation=operation==='CREATE'?'CREATED':'RUNNING';
  const raw=JSON.stringify({ga_id:intent.gaId,ga_sha256:sha(gaRaw),operation:eventOperation,container_id:actual.container_id,observation:actual.observation,started_utc:actual.started_utc,ended_utc:actual.ended_utc})+'\n';
  // Under the runtime-clock amendment the RUNNING event immutably records the
  // container-derived runtime deadline: observed State.StartedAt plus 600s.
  const runtimeDeadline=(current.rc&&eventOperation==='RUNNING')?{runtime_deadline:new Date(Date.parse(actual.observation.State.StartedAt)+600000).toISOString()}:{};
  return {state:'ACTUAL_HOST_EFFECT_REQUIRES_REMOTE_RESULT',ga_sha256:sha(gaRaw),operation,container_id:actual.container_id,
   event_request:{idempotency_key:deriveEventKey(gaRaw,operation,'observed'),expected_sequence:current.sequence,ga_id:intent.gaId,operation:eventOperation,body:{container_id:actual.container_id,raw,sha256:sha(raw),...runtimeDeadline}},capacity_released:false,qualified:false,automatic_retry:false};
 }});
}
