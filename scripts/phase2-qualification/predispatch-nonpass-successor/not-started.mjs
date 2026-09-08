// Fixed non-PASS reconciliation only. Pure checks do not authenticate caller evidence.
import crypto from 'node:crypto';import {isDeepStrictEqual as same} from 'node:util';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),need=(v,m)=>{if(!v)throw Error(m);};
export const mode='PREDISPATCH_NONPASS_NOT_STARTED';
export function checkNotStarted({receipt,ga,state}){
 need(['FAIL','BLOCKED','STALE'].includes(receipt.result)&&receipt.test_results.length===0,'NONPASS_WITH_NO_TEST_EXECUTION_ONLY');
 need(state.binding?.root_id==='ctr_414bd3c724264a83894b0c55cf2ab878'&&state.current?.root_id===state.binding.root_id&&state.current.active_ga_id===ga.gate_authorization_id,'EXACT_CURRENT_CONTROL_ROOT');
 need(state.root?.root_set_id===state.binding.root_id&&state.root.generation_id===ga.control_trust_root_generation&&state.root.state==='STORED_NO_GATE_AUTHORITY'&&state.binding.controller_sha256===ga.controller_digest,'ORIGINAL_ROOT_GENERATION_AND_CONTROLLER');
 const found=state.attempts.filter(a=>a.ga_id===ga.gate_authorization_id);need(found.length===1,'ONE_ORIGINAL_ATTEMPT');const a=found[0],d=a.decision;
 need(a.revoked===true&&a.container_id===null&&['DECISION_RESERVED','SIGNING'].includes(a.phase)&&d?.termination_mode===mode,'REVOKED_NOT_STARTED_RESERVATION_ONLY');
 need(a.ga_raw===JSON.stringify(ga)+'\n'&&a.ga_sha256===sha(a.ga_raw),'ORIGINAL_GA_BYTES');
 const events=state.events.filter(e=>e.request.ga_id===a.ga_id);need(events.some(e=>e.request.operation==='REVOKE')&&events.every(e=>e.root_id===state.binding.root_id&&['REVOKE','UNKNOWN','DECISION_RESERVED','SIGNING'].includes(e.request.operation)),'NO_INTENT_OR_DISPATCH_IN_COMPLETE_HISTORY');
 const reservations=events.filter(e=>e.request.operation==='DECISION_RESERVED');need(reservations.length===1&&same(reservations[0].request.body,d),'ONE_ACTUAL_FULL_DECISION_EVENT');
 need(sha(d.evidence_index_raw)===d.evidence_index_sha256&&sha(d.decision_raw)===d.decision_sha256,'EXACT_RESERVED_RAW');
 const index=JSON.parse(d.evidence_index_raw),prefix='urn:clued:execution-evidence:'+state.binding.root_id+':';
 function resolve(ref){const items=index.artifacts.filter(x=>same({uri:x.uri,sha256:x.sha256},ref));need(items.length===1,'ONE_EXACT_RECONCILIATION_ARTIFACT');const x=items[0];need(x.uri===prefix+sha(x.raw)&&x.sha256===sha(x.raw),'EXACT_RECONCILIATION_BYTES');return JSON.parse(x.raw);}
 need(same(receipt.stop_evidence_ref,d.not_started_evidence_ref),'EXPLICIT_NOT_STARTED_STOP_CONDITION_REF');const proof=resolve(d.not_started_evidence_ref);
 need(proof.kind==='PREDISPATCH_NOT_STARTED_RECONCILIATION'&&proof.ga_id===a.ga_id&&proof.ga_sha256===a.ga_sha256&&proof.controller_digest===ga.controller_digest&&proof.root_id===state.binding.root_id,'EXACT_NO_EFFECT_SUBJECT');
 need(proof.not_started===true&&proof.container_id===null&&proof.stop_action_performed===false&&proof.execution_sequence===reservations[0].request.expected_sequence,'NO_FAKE_STOP_OR_CONTAINER');
 const before=events.filter(e=>e.sequence<=proof.execution_sequence);need(same(proof.event_sequences,before.map(e=>e.sequence)),'COMPLETE_PRE_RESERVATION_EVENT_PREFIX');
 const sql=resolve(proof.sql_observation_ref),snap=sql.execution;need(Number.isFinite(Date.parse(sql.observed_at))&&Date.parse(sql.observed_at)<=Date.parse(proof.observed_at),'ACTUAL_PRIOR_SQL_TIME');
 need(snap?.binding?.root_id===state.binding.root_id&&snap.current?.active_ga_id===a.ga_id&&snap.current.sequence===proof.execution_sequence,'EXACT_RECONCILED_SQL_SEQUENCE');
 need(same(snap.root,state.root)&&same(snap.binding,state.binding),'EXACT_UNCHANGED_ORIGINAL_ROOT_AND_BINDING');
 const prior=snap.attempts.filter(x=>x.ga_id===a.ga_id);need(prior.length===1&&prior[0].phase==='UNKNOWN'&&prior[0].revoked===true&&prior[0].container_id===null&&prior[0].ga_raw===a.ga_raw&&prior[0].ga_sha256===a.ga_sha256,'ACTUAL_ORIGINAL_UNKNOWN_SNAPSHOT');
 need(same(snap.events.filter(e=>e.request.ga_id===a.ga_id),before),'ORIGINAL_SQL_EVENT_BYTES_MATCH_CURRENT_HISTORY');
 need(snap.current.charged_seconds===state.current.charged_seconds&&snap.current.charged_evidence_bytes===state.current.charged_evidence_bytes&&snap.current.pending_budget_sequence===null&&state.current.pending_budget_sequence===null,'NO_REFUND_OR_NEW_BUDGET');
 const nonce=sha('clued-fixed-host-v1\0'+a.ga_id).slice(0,32),docker=resolve(proof.container_lookup_ref);
 need(docker.kind==='ACTUAL_EXACT_NONCE_HOST_INVENTORY_READ_ONLY'&&docker.ga_id===a.ga_id&&docker.ga_sha256===a.ga_sha256&&docker.nonce===nonce&&docker.exact_name==='clued-synthetic-'+nonce,'THIS_GA_ABSENCE_OBSERVATION');
 need(docker.cli_sha256==='00ffff945b67c65aae98dd980621a80ee135ed4e0931b33ca03687caee019713','FIXED_DOCKER_CLI');
 const args=['--host','npipe:////./pipe/dockerDesktopLinuxEngine','ps','--all','--no-trunc','--filter','name=^/clued-synthetic-'+nonce+'$','--format','{{json .}}'];
 need(same(docker.arguments,args)&&docker.exit_code===0&&docker.signal===null&&docker.error===null&&docker.stdout===''&&docker.stderr==='','ACTUAL_SUCCESSFUL_EMPTY_EXACT_TARGET_LOOKUP');
 need(docker.directory_exists===false&&docker.exact_nonce_directory==='C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/kernel-phase2-repo/scripts/phase2-qualification/preentry-parent/work/'+nonce&&docker.host_mutations===0&&docker.not_a_stop_observation===true,'ACTUAL_ABSENT_NONCE_DIRECTORY_NO_STOP_CLAIM');
 need(Number.isFinite(Date.parse(proof.observed_at))&&Number.isFinite(Date.parse(docker.started_at))&&Number.isFinite(Date.parse(docker.ended_at))&&Date.parse(docker.started_at)>=Date.parse(ga.issued_at)&&Date.parse(docker.started_at)<=Date.parse(docker.ended_at)&&Date.parse(docker.ended_at)<=Date.parse(proof.observed_at)&&Date.parse(proof.observed_at)<=Date.parse(reservations[0].recorded_at),'RECONCILIATION_BEFORE_RESERVATION');
 need(Array.isArray(proof.entry_failure_refs)&&proof.entry_failure_refs.length>0,'REAL_ADMISSION_FAILURE_SOURCES_REQUIRED');
 for(const ref of proof.entry_failure_refs){const failure=resolve(ref);need(failure.kind==='ACTUAL_PRE_DISPATCH_ADMISSION_REJECTION'&&failure.ga_id===a.ga_id&&failure.ga_sha256===a.ga_sha256&&failure.controller_digest===ga.controller_digest,'THIS_GA_ENTRY_REJECTION');need(['ACTUAL_FIXED_ENTRY_TOOL_RESULT','ACTUAL_CAPTURED_PROCESS_OUTPUT'].includes(failure.original_output_origin),'EXPLICIT_ORIGINAL_DIAGNOSTIC_SOURCE_KIND');need(typeof failure.original_output_raw==='string'&&sha(failure.original_output_raw)===failure.original_output_sha256&&failure.original_output_raw.includes('FRESH_SQL_OBSERVATION_REQUIRED'),'ORIGINAL_FRESHNESS_REJECTION_BYTES');}
 const review=resolve(proof.independent_assessment_ref);need(review.kind==='INDEPENDENT_NOT_STARTED_RECONCILIATION_ASSESSMENT'&&review.ga_id===a.ga_id&&review.ga_sha256===a.ga_sha256&&same(review.reviewer_ref,receipt.independent_reviewer_ref)&&review.independent_reviewer==='/root/project_list_auth_fix'&&review.result===receipt.result&&review.not_started===true&&typeof review.reason==='string'&&review.reason.trim(),'ACTUAL_DISTINCT_NOT_STARTED_ASSESSMENT');
 need(!same(receipt.executor_actor_ref,receipt.independent_reviewer_ref)&&same(review.source_refs,[proof.sql_observation_ref,proof.container_lookup_ref,...proof.entry_failure_refs]),'INDEPENDENT_ASSESSMENT_COVERS_EXACT_SOURCES');
 const targets=before.map(e=>'urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:'+e.sequence);targets.push('urn:clued:sql:uscrdifznmlvczcekqpw:clued_control:gate_attempts:'+state.binding.root_id+':'+a.ga_id,'urn:clued:sql:uscrdifznmlvczcekqpw:clued_control:execution_current:'+state.binding.root_id);
 need(same([...receipt.actual_write_set].sort(),targets.sort()),'ONLY_ACTUAL_ORIGINAL_CONTROL_WRITES_NO_DOCKER_OR_FIXTURE');
 return {state:'EXACT_NOT_STARTED_RECONCILIATION_BYTES_CHECKED_NOT_AUTHORITY',proof,assessment:review,assessment_ref:proof.independent_assessment_ref,authority_effect:'NONE'};
}
