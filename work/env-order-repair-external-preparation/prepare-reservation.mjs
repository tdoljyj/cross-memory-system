// Pure original DECISION_RESERVED request; no SQL call.
import {sha,moduleAt,successor} from './dependencies.mjs';import {createAssembler} from './assemble-results.mjs';
import {measureDecisionRequest} from '../qualification-live-preparation/transition-size.mjs';
const {project,sql}=await moduleAt(successor+'context.mjs');const need=(v,m)=>{if(!v)throw Error(m);};
export function prepareReservation({material,observation,assembly_input,idempotency_key,expected_sequence}){
 const ga=JSON.parse(material.ga_raw),state=observation?.row?.execution;
 need(observation?.project===project&&observation.query_sha256===sha(sql)&&state?.binding?.runtime_acceptance_sha256===sha(material.runtime_acceptance.raw)&&state.binding.qualification_sha256===sha(material.controller_qualification.raw),'ACTUAL_CURRENT_STOPPED_READBACK');
 const attempts=state.attempts.filter(a=>a.ga_id===ga.gate_authorization_id);need(attempts.length===1&&attempts[0].phase==='STOPPED'&&attempts[0].ga_raw===material.ga_raw&&state.current.sequence===expected_sequence,'EXACT_STOPPED_GA_AND_CURRENT_CAS');
 const assembly=createAssembler(material).assemble(assembly_input);if(assembly.state.startsWith('BLOCKED'))return assembly;
 const decision=JSON.parse(assembly.decision.raw),request={ga_id:decision.ga_id,idempotency_key,expected_sequence,operation:'DECISION_RESERVED',body:{decision_raw:assembly.decision.raw,decision_sha256:assembly.decision.sha256,evidence_index_raw:assembly.index.raw,evidence_index_sha256:assembly.index.sha256,result:decision.result}};
 const size=measureDecisionRequest(request);return {state:size.within_limit?'ORIGINAL_REQUEST_PREPARED_REQUIRES_ACTUAL_CURRENT_SQL_CAS':'BLOCKED_ENTIRE_TRANSITION_EXCEEDS_131072',assembly,request,size,authority_effect:'NONE',sql_called:false};
}
export function prepareSigning({material,observation,reservation,idempotency_key,expected_sequence}){
 const state=observation?.row?.execution,ga=JSON.parse(material.ga_raw);createAssembler(material);
 need(observation?.project===project&&observation.query_sha256===sha(sql)&&state?.binding?.runtime_acceptance_sha256===sha(material.runtime_acceptance.raw)&&state.binding.qualification_sha256===sha(material.controller_qualification.raw),'ACTUAL_CURRENT_RESERVED_READBACK');
 const attempts=state.attempts.filter(a=>a.ga_id===ga.gate_authorization_id),a=attempts[0];need(attempts.length===1&&a.phase==='DECISION_RESERVED'&&a.ga_raw===material.ga_raw&&state.current.sequence===expected_sequence,'EXACT_RESERVED_GA_CURRENT_CAS');
 need(reservation?.state==='ORIGINAL_REQUEST_PREPARED_REQUIRES_ACTUAL_CURRENT_SQL_CAS'&&reservation.size?.within_limit===true&&a.decision.decision_raw===reservation.assembly.decision.raw&&a.decision.decision_sha256===sha(reservation.assembly.decision.raw)&&a.decision.evidence_index_raw===reservation.assembly.index.raw&&a.decision.evidence_index_sha256===sha(reservation.assembly.index.raw),'ACTUAL_RESERVED_COMPLETE_ASSEMBLY_BYTES');
 need(typeof idempotency_key==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(idempotency_key)&&Number.isSafeInteger(expected_sequence)&&expected_sequence>=0,'EXACT_CURRENT_KEY_CAS');
 return {state:'ORIGINAL_SIGNING_REQUEST_PREPARED_REQUIRES_ACTUAL_CURRENT_SQL_CAS',request:{ga_id:ga.gate_authorization_id,idempotency_key,expected_sequence,operation:'SIGNING',body:{decision_sha256:a.decision.decision_sha256}},authority_effect:'NONE',sql_called:false};
}
