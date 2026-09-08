// Real read-only observation adapter; fixed sources only, never an oracle/GA issuer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {checkGAShape,rootID} from './context.mjs';
import {checkStoppedObservation} from './grr.mjs';
import {canonicalDigest} from '../nonproduction-control-store/protocol-successor/validate-successor.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../preentry-parent/work');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const need=(ok,why)=>{if(!ok)throw Error(why);};
const raw=v=>JSON.stringify(v)+'\n';
function exactFile(filename){
 const rel=path.relative(root,filename);need(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel),'FIXED_OBSERVATION_PATH');
 for(let p=filename;p!==root;p=path.dirname(p))need(!fs.lstatSync(p).isSymbolicLink(),'UNLINKED_OBSERVATION_SOURCE');
 const stat=fs.statSync(filename);need(stat.isFile()&&stat.size<=131072,'BOUNDED_ORIGINAL_FILE');
 return fs.readFileSync(filename,'utf8');
}
export function observePositiveFixtureAndStop({gaRaw,state}){
 const ga=checkGAShape(gaRaw),gaSha=sha(gaRaw),nonce=sha('clued-fixed-host-v1\0'+ga.gate_authorization_id).slice(0,32),folder=path.join(root,nonce);
 const attempts=state.attempts?.filter(a=>a.ga_id===ga.gate_authorization_id);
 need(attempts?.length===1&&attempts[0].ga_raw===gaRaw&&attempts[0].ga_sha256===gaSha&&['STOPPED','DECISION_RESERVED','SIGNING'].includes(attempts[0].phase),'ACTUAL_SAME_STOPPED_GA_ATTEMPT');
 const attempt=attempts[0],events=state.events.filter(e=>e.request.ga_id===attempt.ga_id);
 const created=events.filter(e=>e.request.operation==='CREATED'),running=events.filter(e=>e.request.operation==='RUNNING'),stopped=events.filter(e=>e.request.operation==='STOPPED');
 need(created.length===1&&running.length===1&&stopped.length===1&&created[0].sequence<running[0].sequence&&running[0].sequence<stopped[0].sequence,'ACTUAL_ORDERED_CREATE_RUN_STOP_EVENTS');
 for(const event of [created[0],running[0],stopped[0]]){
  const b=event.request.body;need(typeof b.raw==='string'&&sha(b.raw)===b.sha256,'EXACT_ORIGINAL_HOST_OBSERVATION_RAW');
  const value=JSON.parse(b.raw);need(value.ga_id===attempt.ga_id&&value.ga_sha256===gaSha&&value.container_id===attempt.container_id&&value.observation?.Id===attempt.container_id,'SAME_ACTUAL_CONTAINER_OBSERVATIONS');
 }
 const actualStop=JSON.parse(stopped[0].request.body.raw);checkStoppedObservation(actualStop.observation,attempt.container_id);
 const fixtureRaw=exactFile(path.join(folder,'allowed/fixture.json')),intentRaw=exactFile(path.join(folder,'host-intent.json')),hostGaRaw=exactFile(path.join(folder,'ga.raw'));
 need(fixtureRaw==='{"fixture":"synthetic-v1","real_user_payload":false}\n','EXACT_ACTUAL_SYNTHETIC_FIXTURE_BYTES');
 const intent=JSON.parse(intentRaw);need(hostGaRaw===gaRaw&&intent.ga_sha256===gaSha&&intent.nonce===nonce,'ACTUAL_SAME_LOCAL_HOST_INTENT');
 const observation={kind:'ACTUAL_FIXED_SYNTHETIC_FIXTURE_AND_STOP_OBSERVATION',test_id:'PQUAL-01',observed_at:new Date().toISOString(),ga_id:attempt.ga_id,ga_sha256:gaSha,container_id:attempt.container_id,
  fixture:{raw:fixtureRaw,sha256:sha(fixtureRaw)},host_intent:{raw:intentRaw,sha256:sha(intentRaw)},actual_execution_events:[created[0],running[0],stopped[0]],
  authority_effect:'NONE',independent_oracle_assessment_created:false,complete_case_pass:false};
 return {raw:raw(observation),sha256:sha(raw(observation)),complete_case_pass:false};
}
export function observeNoBroaderAuthorityAfterResult({gaRaw,beforeState,afterState,actualCommitted}){
 const ga=checkGAShape(gaRaw),gaSha=sha(gaRaw),attempts=afterState.attempts?.filter(a=>a.ga_id===ga.gate_authorization_id);
 need(beforeState.root.root_set_id===rootID&&canonicalDigest(beforeState.root)===canonicalDigest(afterState.root),'ROOT_NOT_AUTOMATICALLY_ADVANCED_BY_RESULT');
 need(attempts?.length===1&&attempts[0].ga_raw===gaRaw&&attempts[0].ga_sha256===gaSha,'EXACT_COMPLETED_ORIGINAL_ATTEMPT');
 const a=attempts[0];need(typeof a.receipt_raw==='string'&&sha(a.receipt_raw)===a.receipt_sha256&&afterState.current.active_ga_id===null,'EXACT_IMMUTABLE_RECEIPT_READBACK');
 const receipt=JSON.parse(a.receipt_raw);need(['PASS','FAIL','BLOCKED','STALE'].includes(receipt.result)&&a.phase===receipt.result,'EXACT_ORIGINAL_RESULT_ENUM');
 need(actualCommitted?.status==='COMMITTED'&&actualCommitted.authority_effect==='NONE'&&actualCommitted.receipt_sha256===a.receipt_sha256&&actualCommitted.result===receipt.result,'ACTUAL_NONAUTHORITY_SQL_RESULT');
 const value={kind:'ACTUAL_RESULT_NO_BROADER_AUTHORITY_OBSERVATION',test_id:'PQUAL-20',observed_at:new Date().toISOString(),ga_id:a.ga_id,ga_sha256:gaSha,receipt_raw:a.receipt_raw,receipt_sha256:a.receipt_sha256,
  root_before_sha256:canonicalDigest(beforeState.root),root_after_sha256:canonicalDigest(afterState.root),actual_commit_response:actualCommitted,
  observation_boundary:'Exact control-store Root and original result response only. No inferred acceptance of R11, Entry, Slice A, model or production.',authority_effect:'NONE',complete_case_pass:false};
 return {raw:raw(value),sha256:sha(raw(value)),complete_case_pass:false};
}
export function observeNoBroaderAuthorityAfterCleanup({gaRaw,beforeState,afterState}){
 const ga=checkGAShape(gaRaw),gaSha=sha(gaRaw),attempts=afterState.attempts?.filter(a=>a.ga_id===ga.gate_authorization_id);
 need(beforeState.root.root_set_id===rootID&&canonicalDigest(beforeState.root)===canonicalDigest(afterState.root),'ROOT_NOT_AUTOMATICALLY_ADVANCED_BY_CLEANUP');
 need(attempts?.length===1&&attempts[0].ga_raw===gaRaw&&attempts[0].ga_sha256===gaSha&&attempts[0].phase==='STOPPED','ACTUAL_COMPLETED_CLEANUP');
 const a=attempts[0];need(a.receipt_raw===null&&a.receipt_id===null&&afterState.current.active_ga_id===a.ga_id,'STOP_IS_NOT_RESULT_ISSUANCE_OR_CAPACITY_RELEASE');
 const events=afterState.events.filter(e=>e.request.ga_id===a.ga_id&&e.request.operation==='STOPPED');
 need(events.length===1&&sha(events[0].request.body.raw)===events[0].request.body.sha256,'ACTUAL_UNIQUE_STOP_RAW');
 const stop=JSON.parse(events[0].request.body.raw);need(stop.ga_id===a.ga_id&&stop.ga_sha256===gaSha&&stop.container_id===a.container_id,'EXACT_CLEANUP_SUBJECT');checkStoppedObservation(stop.observation,a.container_id);
 const value={kind:'ACTUAL_CLEANUP_NO_BROADER_AUTHORITY_OBSERVATION',test_id:'PQUAL-20',observed_at:new Date().toISOString(),ga_id:a.ga_id,ga_sha256:gaSha,actual_stop_event:events[0],
  root_before_sha256:canonicalDigest(beforeState.root),root_after_sha256:canonicalDigest(afterState.root),active_slot_retained:true,receipt_issued:false,
  observation_boundary:'Original PQUAL20 cleanup-completed alternative; usable before GRR and does not depend on its own later result. Exact control-store boundary only.',authority_effect:'NONE',complete_case_pass:false};
 return {raw:raw(value),sha256:sha(raw(value)),complete_case_pass:false};
}
