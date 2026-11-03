// Offline Source successor candidate. No existing Source/Role grants this purpose.
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export const COMPONENT_VERSION = "1.0.0";
export const BASELINE='d86854407a1a69ec44cafd721438988e8a9af7e8';
export const WORKFLOW='.github/workflows/clued-standard-runner-actor-qualification.yml';
export const REPOSITORY='tdoljyj/cross-memory-system';
export const REPOSITORY_ID='1334673495';
export const PURPOSE='standard_runner_self_s4u_qualification_once';
export const ROLE='standard-runner-actor-qualification';
export const MAX_ROWS=128;
export const SELF_CAPTURE_SHA='258f5437df03824066a1cf2bd8ef2f1a4cfb4c4b921d7aba904100e60cc1f1fd';
export const PHASES=Object.freeze(['source','native-current','own-primary-identity','observer-ready','self-register','self-run','proof-readback']);
export const TOOL_PINS=Object.freeze({
 actor:'c82a699dbbf5bfd44939fcdc1c5a211ed66d3571a8baa522fb955ab1d3859616',
 runner_entry:'aae77e546853bbb3c87b9d21a4b96537779d4860f48ef09d256fc9982ab56bd8',
 observer_entry:'6d2ae34fc7bc390708120e1b3f653fa49c49ac1ae9f7a61f77ddf08daa27f079',
 observer_core:'017d894f54a7bef4fae447b7e3b04d0c0faa29011efafb5b1e603b185d2ff95c',
 observer_os:'c27f400015fcf0628ff42f46d777892437fd688158b1e6b25c616d60e8c9971a',
 identity:'31a3f23a0db09cbd44fba46aaacacf72818a8e3759cd50ca716b7b0b57b157c8',
 definition:'0f8e12a1da7db668fc64b4ab10dde042f06ec26186a93833a446d284dec890a4',
 registration:'642cd65994270271ab12f88c81bfc5653852ae2fd1ad831e827ac016679e4fcb',
});
// These are bounded recovery rows, not the software's maximum universe.
export const INITIAL_ROWS=Object.freeze([
 Object.freeze({node_id:'desk-w-591-windows-runner-caches',host:'DESK-W-591',sid:'S-1-5-21-858977881-4031698862-3006450925-1005',runner_id:21,runner_name:'clued-ci-company-win-01',site:'site-company',job:'qualify-company',request_sha256:'556c2a224252ae9b84078075049ce6c46bd4c3ccf9cab9dcabdec16c9d6b9ce0',predecessor_sha256:'d24a9bd1a8b0d905af0a789e0c18e6a97d6433868d124eecaa67c7784d72f297'}),
 Object.freeze({node_id:'turing-windows-runner-caches',host:'TURING',sid:'S-1-5-21-1173730660-3877291096-655431861-1013',runner_id:23,runner_name:'clued-ci-home-win-01',site:'site-home',job:'qualify-home',request_sha256:'961a6a425a81ce2ef4e40fa42809c72210d65ded7bd30c164286e8351206e8b7',predecessor_sha256:'87f3aa2534d3999d9664c740f5eb5dc1d593fa1cdb075867c68000a788ab8c7c'}),
]);
const HASH=/^[a-f0-9]{64}$/,SHA=/^[a-f0-9]{40}$/,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const matches=(value,pattern)=>typeof value==='string'&&pattern.test(value);
const SID=/^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const check=(v,code)=>{if(v!==true)fail(code);};
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys,code)=>check(plain(v)&&JSON.stringify(Object.keys(v).sort())===JSON.stringify([...keys].sort()),code);
const canonical=v=>Array.isArray(v)?v.map(canonical):plain(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const digest=v=>createHash('sha256').update(Buffer.isBuffer(v)||typeof v==='string'?v:JSON.stringify(canonical(v))).digest('hex');
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const copy=v=>freeze(structuredClone(v));
const ROW_KEYS=['node_id','host','sid','runner_id','runner_name','site','job','request_sha256','predecessor_sha256'];
export function validateRows(rows){
 check(Array.isArray(rows)&&rows.length>=1&&rows.length<=MAX_ROWS,'ROWS_BOUND');
 const seen=new Set(),jobs=new Set(),runners=new Set(),subjects=new Set();
 for(const row of rows){
  exact(row,ROW_KEYS,'ROW_FIELDS');
  check(typeof row.node_id==='string'&&/^[a-z0-9][a-z0-9-]{1,79}$/.test(row.node_id),'ROW_NODE');
  check(typeof row.host==='string'&&/^[A-Z0-9][A-Z0-9-]{0,62}$/.test(row.host),'ROW_HOST');
  check(typeof row.sid==='string'&&SID.test(row.sid),'ROW_NON_SYSTEM_SID');
  check(Number.isSafeInteger(row.runner_id)&&row.runner_id>0&&typeof row.runner_name==='string'&&/^clued-ci-[a-z0-9-]{1,80}$/.test(row.runner_name),'ROW_RUNNER');
  check(matches(row.site,/^site-[a-z0-9-]{1,32}$/)&&matches(row.job,/^qualify-[a-z0-9-]{1,64}$/),'ROW_ROLE_ROUTE');
  check(matches(row.request_sha256,HASH)&&matches(row.predecessor_sha256,HASH),'ROW_HISTORY_SHA');
  for(const [set,value]of [[seen,row.node_id],[jobs,row.job],[runners,row.runner_id],[subjects,`${row.host}/${row.sid}`]]){check(!set.has(value),'ROW_DUPLICATE');set.add(value);}
 }
 return copy(rows);
}
export function selectRow(rows,job){const valid=validateRows(rows);const picked=valid.filter(r=>r.job===job);check(picked.length===1,'EXACT_ROLE_ROW_REQUIRED');return picked[0];}
const CONTEXT_KEYS=['schema','repository','repository_id','workflow_path','workflow_sha','head_sha','event','ref','run_id','run_attempt','job','actor_id','triggering_actor_login'];
export function validateContext(context){
 exact(context,CONTEXT_KEYS,'JOB_CONTEXT_FIELDS');
 check(context.schema==='clued.standard-runner-actor-context/1'&&context.repository===REPOSITORY&&context.repository_id===REPOSITORY_ID,'JOB_REPOSITORY');
 check(context.workflow_path===WORKFLOW&&matches(context.workflow_sha,SHA)&&context.head_sha===context.workflow_sha,'JOB_EXACT_WORKFLOW_SOURCE');
 check(context.event==='workflow_dispatch'&&context.ref==='refs/heads/main'&&context.run_attempt===1,'JOB_NON_PR_FIRST_ATTEMPT_ONLY');
 check(matches(context.run_id,/^[1-9][0-9]{0,19}$/)&&matches(context.job,/^qualify-[a-z0-9-]{1,64}$/),'JOB_RUN_ROLE');
 check(context.actor_id==='52366662'&&context.triggering_actor_login==='tdoljyj','JOB_OWNER_DISPATCH_IDENTITY');
 return copy(context);
}
export function readJobHints(env){
 // Hints are never signed source/run/runner identity. The Native port must bind
 // them to server-observed GitHub facts and current admitted dispatch.
 const names=['GITHUB_REPOSITORY','GITHUB_REPOSITORY_ID','GITHUB_WORKFLOW_REF','GITHUB_WORKFLOW_SHA','GITHUB_SHA','GITHUB_EVENT_NAME','GITHUB_REF','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_JOB','GITHUB_ACTOR_ID','GITHUB_TRIGGERING_ACTOR'];
 const v=Object.fromEntries(names.map(k=>[k,env[k]]));
 const prefix=REPOSITORY+'/'+WORKFLOW+'@refs/heads/main';check(v.GITHUB_WORKFLOW_REF===prefix,'JOB_WORKFLOW_REF');
 check(v.GITHUB_RUN_ATTEMPT==='1','JOB_FIRST_ATTEMPT_ONLY');
 return validateContext({schema:'clued.standard-runner-actor-context/1',repository:v.GITHUB_REPOSITORY,repository_id:v.GITHUB_REPOSITORY_ID,workflow_path:WORKFLOW,workflow_sha:v.GITHUB_WORKFLOW_SHA,head_sha:v.GITHUB_SHA,event:v.GITHUB_EVENT_NAME,ref:v.GITHUB_REF,run_id:v.GITHUB_RUN_ID,run_attempt:1,job:v.GITHUB_JOB,actor_id:v.GITHUB_ACTOR_ID,triggering_actor_login:v.GITHUB_TRIGGERING_ACTOR});
}
export function validateBinding(value,context,row,now){
 exact(value,['schema','purpose','role','context_sha256','node_id','runner_id','runner_name','request_sha256','predecessor_sha256','attempt_id','accepted_actor_packet_sha256','owner_receipt_id','claim_id','fence','execution_epoch','binding_ref','source_acceptance_ref','issued_at','expires_at','tool_pins'],'NATIVE_BINDING_FIELDS');
 check(value.schema==='clued.standard-runner-actor-native-binding/1'&&value.purpose===PURPOSE&&value.role===ROLE&&value.context_sha256===digest(context),'NATIVE_PURPOSE_CONTEXT');
 for(const k of ['node_id','runner_id','runner_name','request_sha256','predecessor_sha256'])check(value[k]===row[k],'NATIVE_ROW');
 check([value.owner_receipt_id,value.claim_id,value.binding_ref,value.source_acceptance_ref].every(v=>matches(v,UUID)),'NATIVE_REFERENCE');
 check(matches(value.attempt_id,/^[a-f0-9]{32}$/)&&matches(value.accepted_actor_packet_sha256,HASH),'NATIVE_ACTOR_ATTEMPT_PACKET');
 check(Number.isSafeInteger(value.fence)&&value.fence>0&&Number.isSafeInteger(value.execution_epoch)&&value.execution_epoch>0,'NATIVE_CLAIM_GENERATION');
 check(typeof value.issued_at==='string'&&typeof value.expires_at==='string','NATIVE_TIMESTAMP_STRING_FIELDS');
 check(Number.isFinite(now)&&Number.isFinite(Date.parse(value.issued_at))&&Number.isFinite(Date.parse(value.expires_at))&&Date.parse(value.issued_at)<=now&&now<Date.parse(value.expires_at)&&Date.parse(value.expires_at)-Date.parse(value.issued_at)<=300000,'NATIVE_FRESHNESS');
 exact(value.tool_pins,Object.keys(TOOL_PINS),'TOOLS_FIELDS');check(digest(value.tool_pins)===digest(TOOL_PINS),'TOOLS_EXACT_SHA');
 // This validates public binding shape only. It never grants execution.
 return copy(value);
}
export function validateOwnRuntime(runtime,row){
 exact(runtime,['schema','host','sid','process_id','creation_file_time','elevated','thread_impersonation','enabled_or_deny_only_admin_sid','primary_token_observed','node_major','source_capture_sha256'],'RUNTIME_FIELDS');
 check(runtime.schema==='clued.standard-runner-own-primary-runtime/1'&&runtime.host===row.host&&runtime.sid===row.sid,'RUNTIME_HOST_SELF_SID');
 check(Number.isSafeInteger(runtime.process_id)&&runtime.process_id===process.pid&&typeof runtime.creation_file_time==='string'&&/^[1-9][0-9]{0,19}$/.test(runtime.creation_file_time),'RUNTIME_PROCESS_INSTANCE');
 check(runtime.elevated===false&&runtime.thread_impersonation===false&&runtime.enabled_or_deny_only_admin_sid===false&&runtime.primary_token_observed===true,'RUNTIME_STANDARD_PRIMARY_ONLY');
 check(runtime.node_major===24&&runtime.source_capture_sha256===SELF_CAPTURE_SHA,'RUNTIME_TOOL_SOURCE');
 return copy(runtime);
}
export function captureTools(raw){
 exact(raw,Object.keys(TOOL_PINS),'TOOL_BYTES_FIELDS');const captured={};
 for(const [key,sha]of Object.entries(TOOL_PINS)){check(Buffer.isBuffer(raw[key])&&raw[key].length>0&&raw[key].length<=1048576,'TOOL_BYTES_BOUND');captured[key]=Buffer.from(raw[key]);check(digest(captured[key])===sha,'TOOL_BYTES_SHA');}
 return captured;
}
export function validateObserverReady(ready,row,binding){
 exact(ready,['schema','role','host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id','predecessor_r9_index_sha256','request_sha256','source_capture_sha256','phase'],'OBSERVER_READY_FIELDS');
 check(ready.schema==='clued.windows-self-entry-ready181/1'&&ready.role==='BA_OBSERVER'&&ready.phase==='FACTORY_PREFLIGHT_READY_WAITING_SELF_REGISTERED','OBSERVER_READY_PHASE');
 for(const [key,value]of Object.entries({host:row.host,node_id:row.node_id,attempt_id:binding.attempt_id,accepted_subject_sha256:binding.accepted_actor_packet_sha256,owner_receipt_id:binding.owner_receipt_id,predecessor_r9_index_sha256:row.predecessor_sha256,request_sha256:row.request_sha256,source_capture_sha256:'17c85ea6052ce15f4d501316247009ff374aebc435841e016fabd609fd7d12e3'}))check(ready[key]===value,'OBSERVER_READY_BINDING');
 return copy(ready);
}
// No production caller can pass ports on the CLI. This pure orchestration seam
// is exercised by fixtures. Only a registered protected Native integration may
// supply the real operations after its independently enforced authority.
export async function runActorWithTrustedPorts({context,acceptedRows,ports,now=Date.now}){
 context=validateContext(context);const row=selectRow(acceptedRows,context.job);
 let attempted=false,phase='source',binding=null;
 const live=async(p)=>{
  check(PHASES.includes(p),'FIXED_PHASE');const value=await ports.requireCurrent({context,row,binding,phase:p});
  exact(value,['status','binding_ref','fence','execution_epoch','phase'],'CURRENT_OBSERVATION_FIELDS');
  check(value.status==='CURRENT'&&value.binding_ref===binding.binding_ref&&value.fence===binding.fence&&value.execution_epoch===binding.execution_epoch&&value.phase===p,'CURRENT_OBSERVATION_STALE');
 };
 try{
  const source=await ports.requireAcceptedSource({context,role:ROLE,purpose:PURPOSE});
  exact(source,['schema','state','workflow_sha','role','purpose','source_acceptance_ref'],'SOURCE_OBSERVATION_FIELDS');
  check(source.schema==='clued.standard-runner-actor-source-observation/1'&&source.state==='EXACT_SOURCE_ACCEPTED'&&source.workflow_sha===context.workflow_sha&&source.role===ROLE&&source.purpose===PURPOSE&&matches(source.source_acceptance_ref,UUID),'SOURCE_NOT_EXACT_ACCEPTED');
  phase='native-current';binding=validateBinding(await ports.bindNativeInvocation({context,row}),context,row,now());
  check(source.source_acceptance_ref===binding.source_acceptance_ref,'SOURCE_NATIVE_REFERENCE_MISMATCH');
  await live(phase);
  const tools=captureTools(await ports.captureAcceptedTools({context,row,binding}));
  phase='own-primary-identity';const runtime=validateOwnRuntime(await ports.readOwnPrimaryRuntime({row,binding}),row);await live(phase);
  phase='observer-ready';validateObserverReady(await ports.requireOwnedLiveObserver({context,row,binding,runtime}),row,binding);await live(phase);
  // Only this fixed phase universe and captured entry may be invoked. Ports
  // never accept an executable, arbitrary argv, env, account, SID or token.
  check(!attempted,'ALREADY_ATTEMPTED');attempted=true;
  const outcome=await ports.invokeCapturedRunnerOnce({row,binding,runtime,tools,entrySha256:TOOL_PINS.runner_entry,allowedOperations:['self-register','self-run'],beforeOperation:async operation=>{
   check(['self-register','self-run'].includes(operation),'ARBITRARY_OPERATION_REFUSED');phase=operation;await live(operation);await ports.requireOwnedLiveObserverPhase({row,binding,operation});
  }});
  phase='proof-readback';await live(phase);
  exact(outcome,['schema','status','entry_exit_code','native_exit_code','child_exit_code','proof_sha256','export_sha256'],'OUTCOME_FIELDS');
  check(outcome.schema==='clued.standard-runner-actor-native-proof/1'&&outcome.status==='INDEPENDENT_NATIVE_PROOF_VALIDATED'&&outcome.entry_exit_code===0&&outcome.native_exit_code===0&&outcome.child_exit_code===0&&matches(outcome.proof_sha256,HASH)&&matches(outcome.export_sha256,HASH),'NO_QUALIFICATION_FROM_REGISTRATION_OR_JOB_EXIT');
  await ports.reopenAndValidateExactProof({row,binding,outcome});
  return {schema:'clued.standard-runner-actor-source-result/1',status:'ACCOUNT_PROOF_OBSERVED_REQUIRES_FACTORY_RECONCILIATION',node_id:row.node_id,phase,actor_attempted:attempted,proof_sha256:outcome.proof_sha256,installation:false,automatic_retry:false};
 }catch(error){return {schema:'clued.standard-runner-actor-source-result/1',status:'UNKNOWN_OR_REFUSED_NO_RETRY',node_id:row.node_id,phase,actor_attempted:attempted,error_code:typeof error?.code==='string'&&/^[A-Z0-9_]{1,96}$/.test(error.code)?error.code:'DEPENDENCY_REFUSED_OR_UNKNOWN',installation:false,automatic_retry:false};}
}
export function resolveInstalledNativeStandardRunnerActorPort(){
 // d868 baseline job/3 accepts PR>0 and six frozen roles. Its scan_start port
 // consumes those same PR facts. non-pr-control-source grants no execution.
 // No currently supported Native action has this new purpose/Role/once key.
 fail('UNSUPPORTED_NATIVE_NON_PR_STANDARD_RUNNER_ACTOR_CONTRACT');
}
export async function main(args=process.argv.slice(2),env=process.env){
 if(args.length===0||JSON.stringify(args)==='["--plan"]')return {schema:'clued.standard-runner-actor-source-preview/1',status:'SOURCE_CANDIDATE_NATIVE_NON_PR_UNSUPPORTED',baseline:BASELINE,workflow:WORKFLOW,role:ROLE,initial_rows:INITIAL_ROWS,rows_bound:MAX_ROWS,execution_authority:false,ci_dispatched:false};
 check(JSON.stringify(args)==='["--execute"]','ARGUMENTS_REFUSED');
 const context=readJobHints(env);const protectedPort=resolveInstalledNativeStandardRunnerActorPort();
 // Future shared integration must bind the registered Source/native contract;
 // the current resolver never returns and cannot be enabled by incoming data.
 return runActorWithTrustedPorts({context,acceptedRows:protectedPort.acceptedRows(),ports:protectedPort});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(JSON.stringify({schema:'clued.standard-runner-actor-source-refusal/1',status:'REFUSED',code:typeof error?.code==='string'?error.code:'INVALID_SOURCE_CONTEXT',execution_authority:false}));process.exitCode=2;});
