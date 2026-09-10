import fs from 'node:fs';
import {createRequire} from 'node:module';
import {parseExact,checkGAShape,time,audience,generation,gateID} from './context.mjs';
import {sha,verifyDynamicPayload,readBlobRef} from '../control-context-verifier-next-window-successor/trusted-github.mjs';
const require=createRequire(new URL('../../../apps/clued-cloud/package.json',import.meta.url)),Ajv=require('ajv');
const localSchema=fs.readFileSync(new URL('./gate-result-receipt.candidate.schema.json',import.meta.url));
const checkSchema=new Ajv({allErrors:true,strictKeywords:true,format:'full'}).compile(JSON.parse(localSchema));
const need=(v,m)=>{if(!v)throw Error(m);};
export function checkResultSemantics({raw,gaRaw,state,acceptedSchemaSha256,now=Date.now()}){
 const receipt=parseExact(raw),ga=checkGAShape(gaRaw);
 need(acceptedSchemaSha256===sha(localSchema)&&receipt.schema_digest===acceptedSchemaSha256&&checkSchema(receipt),'EXACT_ACCEPTED_COMPLETE_GRR_SCHEMA');
 need(receipt.issuer_purpose==='GATE_RESULT'&&receipt.audience===audience&&receipt.control_trust_root_generation===generation,'GRR_PURPOSE_AUDIENCE_GENERATION');
 need(receipt.gate_authorization_id===ga.gate_authorization_id&&receipt.gate_authorization_sha256===sha(gaRaw),'EXACT_ORIGINAL_GA');
 const attempts=state.attempts.filter(a=>a.ga_id===receipt.gate_authorization_id);need(attempts.length===1,'ONE_ORIGINAL_ATTEMPT');const a=attempts[0];
 need(a.phase==='SIGNING'&&a.receipt_raw===null&&a.receipt_id===null&&a.decision?.decision_sha256===receipt.decision_sha256&&a.decision.result===receipt.result,'ONE_EXACT_DECISION_RESERVATION');
 need(state.current.active_ga_id===a.ga_id&&receipt.gate_definition_ref.gate_id===gateID&&receipt.gate_definition_ref.definition_version===state.binding.gate_version&&receipt.gate_definition_ref.content_digest===state.binding.gate_sha256,'ONE_EXACT_GATE');
 const stopped=state.events.filter(e=>e.request.ga_id===a.ga_id&&e.request.operation==='STOPPED');
 need(stopped.length===1&&stopped[0].request.body?.sha256===receipt.stop_evidence_ref.sha256,'ACTUAL_UNIQUE_STOP_EVIDENCE');
 const actual=stopped[0].request.body.raw;need(typeof actual==='string'&&sha(actual)===receipt.stop_evidence_ref.sha256,'EXACT_STOP_RAW_BYTES');
 const stop=JSON.parse(actual);checkStoppedObservation(stop.observation,a.container_id);need(stop.ga_id===a.ga_id&&stop.ga_sha256===sha(gaRaw)&&stop.operation==='STOPPED'&&stop.container_id===a.container_id&&stop.observation?.State?.Running===false,'ACTUAL_STOP_OBSERVATION');
 const started=time(receipt.started_at),ended=time(receipt.ended_at),issued=time(receipt.issued_at),expires=time(receipt.expires_at);
 need(started<=ended&&ended<=issued&&issued<=now&&now<expires,'GRR_TIME_WINDOW');
 need(a.decision.evidence_index_sha256===receipt.evidence_index_ref.sha256,'RESERVED_EVIDENCE_INDEX_BINDING');
 need(new Set(receipt.actual_write_set).size===receipt.actual_write_set.length,'UNIQUE_CONCRETE_WRITE_TARGETS');
 need(new Set(receipt.test_results.map(t=>t.test_id)).size===receipt.test_results.length,'UNIQUE_TEST_RESULTS');
 if(receipt.result==='PASS'){
  const ids=Array.from({length:20},(_,i)=>'PQUAL-'+String(i+1).padStart(2,'0')).filter(x=>x!=='PQUAL-18');
  need(ids.every(id=>receipt.test_results.some(t=>t.test_id===id&&t.result==='PASS'))&&receipt.test_results.length===19,'COMPLETE_ACTUAL_APPLICABLE_COVERAGE');
  need(!a.revoked&&now<Date.parse(a.expires_at)&&state.root.state==='STORED_NO_GATE_AUTHORITY'&&state.root.generation_id===ga.control_trust_root_generation,'NO_STALE_OR_REVOKED_PASS');
  for(const name of ['runner_generation','credential_generation','session_generation'])need(ga[name]===state.current[name],'NO_GENERATION_DRIFT_PASS');
 }
 return {state:'RESULT_SEMANTICS_ONLY_NOT_A_SIGNED_GRR',receipt};
}
export function verifyResultSignature(input,acceptedSchemaRef){
 // Accepted ref must originate in the already signature-verified runtime subject.
 need(sha(readBlobRef(acceptedSchemaRef))===sha(localSchema),'ACTUAL_ACCEPTED_GRR_SCHEMA_BYTES');
 const result=checkResultSemantics({...input,acceptedSchemaSha256:acceptedSchemaRef.sha256});
 verifyDynamicPayload(input.raw,'GateResultReceipt',result.receipt.expires_at);
 return {state:'HISTORICAL_RESULT_SIGNATURE_AND_SEMANTICS_CHECKED',requires_exact_raw_evidence_and_test_oracle_resolution:true,requires_fresh_same_reservation_and_terminal_sql_cas:true,not_final_receipt_admission:true};
}

// Same fixed stopped-observation contract as docker-isolation/prepare.py.
export function checkStoppedObservation(observation,containerId){
 need(typeof containerId==='string'&&/^[a-f0-9]{64}$/.test(containerId)&&observation?.Id===containerId,'EXACT_STOP_CONTAINER_ID');
 const s=observation.State;
 need(s&&s.Running===false&&Number.isSafeInteger(s.Pid)&&s.Pid===0&&s.Status==='exited','ACTUAL_COMPLETE_PROCESS_EXIT');
 const match=typeof s.FinishedAt==='string'&&s.FinishedAt.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/);
 need(match,'REAL_NONZERO_FINISHED_TIMESTAMP');
 const [year,month,day,hour,minute,second]=match.slice(1,7).map(Number),leap=year%4===0&&(year%100!==0||year%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
 need(year>1&&month>=1&&month<=12&&day>=1&&day<=days[month-1]&&hour<24&&minute<60&&second<60&&Number.isFinite(Date.parse(s.FinishedAt)),'REAL_NONZERO_FINISHED_TIMESTAMP');
 if(match[7]!=='Z')need(Number(match[7].slice(1,3))<24&&Number(match[7].slice(4,6))<60,'REAL_FINISHED_TIMEZONE');
 return {state:'EXACT_STOP_FIELDS_CHECKED_NOT_AUTHORITY',authority_effect:'NONE'};
}
