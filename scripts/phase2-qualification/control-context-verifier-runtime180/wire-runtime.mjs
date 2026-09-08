// Deterministic successor wiring; called only by build-verifier.mjs, no operations.
import fs from 'node:fs';
import path from 'node:path';
export function applyWiring(here){
 let source=fs.readFileSync(path.join(here,'context.mjs'),'utf8');
 source="import {verifyResultMaterials,resultCommitRequest,checkAuthorizationLifetime} from './result-terminal.mjs';\nimport {checkResultSemantics} from './grr.mjs';\n"+source;
 source="import {intentFor} from '../preentry-parent/runtime-successor/sql_effect.mjs';\nimport {deriveEventKey} from '../preentry-parent/runtime-successor/supervisor.mjs';\nimport {checkDispatchEvidence} from './dispatch-evidence.mjs';\nimport {invokeFixedHost} from './host-effect.mjs';\nimport {checkConsumedBudget} from './budget-evidence.mjs';\nimport {checkLateBoundPolicy} from './late-bound-policy.mjs';\nimport {verifySourcePublication} from './source-publication.mjs';\n"+source;
 source=source.replace("const varying=new Set(['gate_authorization_id'","checkLateBoundPolicy(subject.late_bound_fields);\n const varying=new Set(['budget_reservation_ref','status_manifest_ref','target_revision','gate_authorization_id'");
 source=source.replace("check(attempt.receipt_raw===null", "checkConsumedBudget({ga,state,attempt,root:body,project,now});\n check(attempt.receipt_raw===null");
 source=source.replace("signedMetadata(material.controller_qualification,binding.qualification_sha256);", "signedMetadata(material.controller_qualification,binding.qualification_sha256);\n check(result.ga.target_revision===material.runtime_acceptance.publication.commitSha,'ACTUAL_RUNTIME_PUBLICATION_TARGET');\n verifySourcePublication({sourceRef:result.ga.source_ref,ownerMerge:material.runtime_acceptance.publication.commitSha,controllerDigest:binding.controller_sha256});");
 source=source.replace("const smPayload=structuredClone(sm);delete smPayload.signature_binding;", "const smPayload=structuredClone(sm);delete smPayload.signature_binding;\n check(canonicalDigest(smPayload)===result.accepted_subject.late_bound_fields.status_manifest_ref.signed_payload_sha256,'EXACT_ACCEPTED_LATE_BOUND_STATUS_PAYLOAD');");
 source=source.replace('qualification,now=Date.now()})','qualification,now=Date.now(),admissionPhase=\'PREFLIGHT\',expectedQuerySha256=sha(sql)})');
 source=source.replace("expectedQuerySha256=sha(sql)})", "expectedQuerySha256=sha(sql),terminalResult=null})");
 source=source.replace("const ga=checkGAShape(gaRaw);", "const ga=checkGAShape(gaRaw);\n const nonPass=operation==='GRR'&&['FAIL','BLOCKED','STALE'].includes(terminalResult);");
 source=source.replace("&&state.current[name]===ga[name]", "&&(nonPass||state.current[name]===ga[name])");
 source=source.replace('issued<=now&&now<deadline', 'issued<=now&&(nonPass||now<deadline)');
 source=source.replace("check(issued<=now&&(nonPass||now<deadline)&&deadline<=expires&&expires-issued<=180000&&profile.max_lifetime_seconds===180", "checkAuthorizationLifetime({operation,result:terminalResult,issued,deadline,expires,now});\n check(profile.max_lifetime_seconds===180");
 source=source.replace('&&!attempt.revoked&&attempt.ga_raw', '&&(nonPass||!attempt.revoked)&&attempt.ga_raw');
 source=source.replace('checkConsumedBudget({ga,state,attempt,root:body,project,now});', 'checkConsumedBudget({ga,state,attempt,root:body,project,now:nonPass?issued:now});');
 source=source.replace(' const runtime=JSON.parse(material.runtime_acceptance.raw),qualification=JSON.parse(material.controller_qualification.raw);', " const runtime=JSON.parse(material.runtime_acceptance.raw),qualification=JSON.parse(material.controller_qualification.raw);\n const terminal=material.operation==='GRR'?parseExact(material.grr_raw):null;\n const nonPass=terminal&&['FAIL','BLOCKED','STALE'].includes(terminal.result);");
 source=source.replace('runtimeAcceptance:runtime,qualification});', 'runtimeAcceptance:runtime,qualification,terminalResult:terminal?.result});');
 source=source.replace("verifyDynamicPayload(material.ga_raw,'GateAuthorization',result.ga.deadline);", "verifyDynamicPayload(material.ga_raw,'GateAuthorization',result.ga.deadline,nonPass?result.ga.issued_at:null);");
 source=source.replace("time(sm.as_of)<=Date.now()&&Date.now()<time(sm.expires_at)", "time(sm.as_of)<=Date.now()&&(nonPass||Date.now()<time(sm.expires_at))");
 source=source.replace("observation.query_sha256===sha(sql)","observation.query_sha256===expectedQuerySha256");
 source=source.replace("check(attempt.phase===({CREATE:'PENDING',START:'CREATED',GRR:'SIGNING'}[operation]),'NO_REDISPATCH_OR_UNKNOWN');","check(['PREFLIGHT','DISPATCHED_ONCE'].includes(admissionPhase),'FIXED_ADMISSION_PHASE');\n check(attempt.phase===(admissionPhase==='DISPATCHED_ONCE'?operation+'_SENT':({CREATE:'PENDING',START:'CREATED',GRR:'SIGNING'}[operation])),'NO_REDISPATCH_OR_UNKNOWN');");
 const start=source.indexOf(' // Keep verified exact bytes privately in this process;');
 if(start<0)throw Error('EXACT_PRIVATE_CONTEXT_PATCH_REQUIRED');
 source=source.slice(0,start)+`
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
  const actual=invokeFixedHost({gaRaw,operation,containerId:current.attempt.container_id,deadline:time(current.ga.deadline)});
  const eventOperation=operation==='CREATE'?'CREATED':'RUNNING';
  const raw=JSON.stringify({ga_id:intent.gaId,ga_sha256:sha(gaRaw),operation:eventOperation,container_id:actual.container_id,observation:actual.observation,started_utc:actual.started_utc,ended_utc:actual.ended_utc})+'\\n';
  return {state:'ACTUAL_HOST_EFFECT_REQUIRES_REMOTE_RESULT',ga_sha256:sha(gaRaw),operation,container_id:actual.container_id,
   event_request:{idempotency_key:deriveEventKey(gaRaw,operation,'observed'),expected_sequence:current.sequence,ga_id:intent.gaId,operation:eventOperation,body:{container_id:actual.container_id,raw,sha256:sha(raw)}},capacity_released:false,qualified:false,automatic_retry:false};
 }});
}
`;
 fs.writeFileSync(path.join(here,'context.mjs'),source);
 const github=fs.readFileSync(path.join(here,'trusted-github.mjs'),'utf8');
 let updated=github.replace('function api(endpoint){','export function api(endpoint){');
 updated=updated.replace('verifyDynamicPayload(raw,type,expiresAt){','verifyDynamicPayload(raw,type,expiresAt,historicalNotBefore=null){');
 updated=updated.replace('return verifyObservedCommit({plan,commit,comparison,tree,blobRaw,now:Date.now(),expiresAt});', "let observedNow=Date.now();\n if(historicalNotBefore!==null){\n  check(type==='GateAuthorization','HISTORICAL_GA_ONLY');\n  observedNow=Date.parse(commit.commit?.committer?.date);\n  check(Number.isFinite(observedNow)&&Date.parse(historicalNotBefore)<=observedNow&&observedNow<Date.parse(expiresAt)&&observedNow<=Date.now(),'ACTUAL_HISTORICAL_GA_SIGNING_TIME');\n }\n return verifyObservedCommit({plan,commit,comparison,tree,blobRaw,now:observedNow,expiresAt});");
 fs.writeFileSync(path.join(here,'trusted-github.mjs'),updated);
 let grr=fs.readFileSync(path.join(here,'grr.mjs'),'utf8');
 grr=grr.replace(" const stop=JSON.parse(actual);", " const stop=JSON.parse(actual);checkStoppedObservation(stop.observation,a.container_id);");
 grr+=`
// Same fixed stopped-observation contract as docker-isolation/prepare.py.
export function checkStoppedObservation(observation,containerId){
 need(typeof containerId==='string'&&/^[a-f0-9]{64}$/.test(containerId)&&observation?.Id===containerId,'EXACT_STOP_CONTAINER_ID');
 const s=observation.State;
 need(s&&s.Running===false&&Number.isSafeInteger(s.Pid)&&s.Pid===0&&s.Status==='exited','ACTUAL_COMPLETE_PROCESS_EXIT');
 const match=typeof s.FinishedAt==='string'&&s.FinishedAt.match(/^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.\\d{1,9})?(Z|[+-]\\d{2}:\\d{2})$/);
 need(match,'REAL_NONZERO_FINISHED_TIMESTAMP');
 const [year,month,day,hour,minute,second]=match.slice(1,7).map(Number),leap=year%4===0&&(year%100!==0||year%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
 need(year>1&&month>=1&&month<=12&&day>=1&&day<=days[month-1]&&hour<24&&minute<60&&second<60&&Number.isFinite(Date.parse(s.FinishedAt)),'REAL_NONZERO_FINISHED_TIMESTAMP');
 if(match[7]!=='Z')need(Number(match[7].slice(1,3))<24&&Number(match[7].slice(4,6))<60,'REAL_FINISHED_TIMEZONE');
 return {state:'EXACT_STOP_FIELDS_CHECKED_NOT_AUTHORITY',authority_effect:'NONE'};
}
`;
 fs.writeFileSync(path.join(here,'grr.mjs'),grr);
 fs.writeFileSync(path.join(here,'cli.mjs'),`// Only the fixed trusted tool entry may start this process after exact source checks.
import readline from 'node:readline';
import crypto from 'node:crypto';
import {prepareTrustedToolMaterial,project} from './context.mjs';
if(process.stdin.isTTY)process.stdin.setRawMode(true);
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity,terminal:false}),it=lines[Symbol.asyncIterator]();
const next=async()=>{const x=await it.next();if(x.done||Buffer.byteLength(x.value)>2*1024*1024)throw Error('BOUNDED_STDIN_INPUT_REQUIRED');return JSON.parse(x.value);};
let dispatchMayExist=false;
const watchdog=setTimeout(()=>{process.stdout.write(JSON.stringify({state:dispatchMayExist?'UNKNOWN':'BLOCKED',reason:'VERIFIER_PROCESS_DEADLINE',capacity_released:false,automatic_retry:false})+'\\n');process.exit(1);},180000);
try{
 const prepared=await prepareTrustedToolMaterial(await next()),challenge=crypto.randomBytes(24).toString('hex');
 dispatchMayExist=true;
 process.stdout.write(JSON.stringify(prepared.kind==='RESULT_TERMINAL'?{state:'NEED_FRESH_RESULT_CONTEXT',challenge,project}:{state:'NEED_COMMITTED_DISPATCH',challenge,project,intent:prepared.intent,dispatch_key:prepared.dispatch_key})+'\\n');
 const fresh=await next();if(fresh.challenge!==challenge)throw Error('EXACT_LIVE_PROCESS_CHALLENGE_REQUIRED');
 process.stdout.write(JSON.stringify(prepared.kind==='RESULT_TERMINAL'?prepared.finishResult(fresh.observation):prepared.finishDispatch(fresh))+'\\n');
}catch(e){process.stdout.write(JSON.stringify({state:dispatchMayExist?'UNKNOWN':'BLOCKED',reason:String(e.message),capacity_released:false,automatic_retry:false,qualified:false})+'\\n');process.exitCode=1;}
finally{clearTimeout(watchdog);lines.close();}
`);
 const transport=fs.readFileSync(path.join(here,'transport.mjs'),'utf8').replaceAll('export function ','function ');
 const template=fs.readFileSync(path.join(here,'tool-entry.template.js'),'utf8');
 fs.writeFileSync(path.join(here,'tool-entry.functions.js'),template.replace('// EXACT_TRANSPORT_FUNCTIONS',transport));
}
