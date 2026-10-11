import { DOMAIN_POLICY as P } from './model-domain-policy.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex=/^[0-9a-f]{64}$/;
export const BOOTSTRAP_READINESS_RPC='clued_model_dataset_split_bootstrap_readiness_candidate';
export const BOOTSTRAP_COMMIT_RPC='clued_model_dataset_split_bootstrap_commit_candidate';
export const EXACT_BOOTSTRAP_PLAN=Object.freeze({
 resource:'repo:tdoljyj/cross-memory-system/8a975c42ddba3ee7a80fe54a4223b7f590014b67/development/contracts/model-program/stage-admission/DatasetSplitBootstrapPlan.fc83a4a1.json',
 sha256:'fc83a4a1f69de07d6de9dea5e879f1498b1b8f288ba3f9b8fba11d979de110ea',
 targets:Object.freeze({"producer_record_id":"36f0b1f1-3352-4a0a-abab-011b39164143","permission_record_id":"adfb0f98-c415-42a5-944c-c5fc91af0fc6","recognition_record_id":"1f443b83-e612-4bec-84ea-b5f2e0e22eb5"}),
 idempotency_key:'model-bootstrap-1b397478-b792-4d73-864b-cee9af714052',
});
const inputKeys=['owner_adoption_server_ref','final_recognizer_server_ref','producer_record_id','permission_record_id','recognition_record_id','idempotency_key','immutable_plan_resource'];
function exact(value,keys){
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;
 const own=Reflect.ownKeys(value);
 return own.length===keys.length&&own.every(k=>typeof k==='string'&&keys.includes(k)&&
   Object.getOwnPropertyDescriptor(value,k)?.enumerable===true&&
   Object.hasOwn(Object.getOwnPropertyDescriptor(value,k),'value'));
}
const ref=v=>exact(v,['id','version','content_hash'])&&typeof v.id==='string'&&uuid.test(v.id)&&
 Number.isSafeInteger(v.version)&&v.version===1&&typeof v.content_hash==='string'&&hex.test(v.content_hash);
const sameRef=(a,b)=>ref(a)&&ref(b)&&a.id===b.id&&a.version===b.version&&a.content_hash===b.content_hash;
function recent(value,now){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(value))return false;
 const parsed=Date.parse(value);return Number.isSafeInteger(now)&&Number.isFinite(parsed)&&parsed<=now&&now-parsed<=300000;
}
export class BootstrapInputDenied extends Error{constructor(){super('BOOTSTRAP_EXACT_INPUT_REQUIRED');this.name='BootstrapInputDenied';}}
export class BootstrapExecutionDenied extends Error{constructor(){super('BOOTSTRAP_DATABASE_TRANSACTION_REJECTED');this.name='BootstrapExecutionDenied';}}
export class BootstrapCompletionUnknown extends Error{constructor(){super('BOOTSTRAP_COMPLETION_UNVERIFIED_INSPECT_ORIGINAL_RECEIPTS_DO_NOT_RETRY');this.name='BootstrapCompletionUnknown';}}
const readinessReasons=new Set(['INPUT','RPC','RESULT_SCHEMA','FIXED_SOURCE','TIME_INVALID','TIME_FUTURE','TIME_STALE','UNSPECIFIED']);
export class BootstrapReadinessDenied extends Error{constructor(reason='UNSPECIFIED'){super('BOOTSTRAP_FIXED_SOURCE_READINESS_DENIED_OR_UNAVAILABLE');this.name='BootstrapReadinessDenied';this.reason=readinessReasons.has(reason)?reason:'UNSPECIFIED';}}
// Passive system-time samples are diagnostic only; never validation inputs.
function sampleReadinessSystemTime(){
 try{const value=Date.now();return Number.isSafeInteger(value)?value:null;}catch{return null;}
}
export async function readBootstrapReadiness(rpc,input,clock=()=>Date.now()){
 if(!exact(input,[])||typeof rpc!=='function')throw new BootstrapReadinessDenied('INPUT');
 const rpcStartedMs=sampleReadinessSystemTime();
 let result;try{result=await rpc(BOOTSTRAP_READINESS_RPC,{});}catch{throw new BootstrapReadinessDenied('RPC');}
 const rpcResolvedMs=sampleReadinessSystemTime();
 const keys=['status','owner_adoption_server_ref','final_recognizer_server_ref','immutable_plan_resource','plan_sha256',
  'max_uses','max_window_seconds','evaluated_at','bootstrap_write_authorized','domain_permission','m2_verdict','private_actor_fields_exposed'];
 if(!exact(result,keys))throw new BootstrapReadinessDenied('RESULT_SCHEMA');
 if(result.status!=='FIXED_OWNER_CHAIN_AND_PLAN_READINESS_ONLY'||
  !ref(result.owner_adoption_server_ref)||!ref(result.final_recognizer_server_ref)||
  result.owner_adoption_server_ref.id!==P.domain.owner_adoption.canonical_record_id||
  result.owner_adoption_server_ref.content_hash!==P.domain.owner_adoption.record_content_sha256||
  !sameRef(result.final_recognizer_server_ref,P.server.owner_final_recognizer.record_ref)||
  result.immutable_plan_resource!==EXACT_BOOTSTRAP_PLAN.resource||result.plan_sha256!==EXACT_BOOTSTRAP_PLAN.sha256||
  result.max_uses!==1||result.max_window_seconds!==3600||result.bootstrap_write_authorized!==false||
  result.domain_permission!=='NOT_GRANTED'||result.m2_verdict!=='NOT_ISSUED'||result.private_actor_fields_exposed!==false)throw new BootstrapReadinessDenied('FIXED_SOURCE');
 const now=clock();
 if(!recent(result.evaluated_at,now)){
  const parsed=typeof result.evaluated_at==='string'?Date.parse(result.evaluated_at):NaN;
  const valid=typeof result.evaluated_at==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(result.evaluated_at)&&Number.isSafeInteger(now)&&Number.isFinite(parsed);
  const reason=!valid?'TIME_INVALID':parsed>now?'TIME_FUTURE':'TIME_STALE';
  if(valid)try{
   // Fixed scalar allowlist: never log input/result objects, refs or errors.
   console.warn(JSON.stringify({event:'model_bootstrap_readiness_time_diagnostic',schema_version:1,
    rpc_started_ms:rpcStartedMs,rpc_resolved_ms:rpcResolvedMs,validation_ms:now,
    evaluated_at:result.evaluated_at,parsed_ms:parsed,delta_ms:parsed-now,reason}));
  }catch{/* Observation failure cannot change the original denial. */}
  throw new BootstrapReadinessDenied(reason);
 }
 return structuredClone(result);
}
export async function commitBootstrap(rpc,input,clock=()=>Date.now()){
 if(typeof rpc!=='function'||!exact(input,inputKeys)||!ref(input.owner_adoption_server_ref)||!ref(input.final_recognizer_server_ref)||
  input.owner_adoption_server_ref.id!==P.domain.owner_adoption.canonical_record_id||
  input.owner_adoption_server_ref.content_hash!==P.domain.owner_adoption.record_content_sha256||
  !sameRef(input.final_recognizer_server_ref,P.server.owner_final_recognizer.record_ref)||
  !['producer_record_id','permission_record_id','recognition_record_id'].every(k=>typeof input[k]==='string'&&uuid.test(input[k]))||
  new Set([input.producer_record_id,input.permission_record_id,input.recognition_record_id]).size!==3||
  typeof input.idempotency_key!=='string'||input.idempotency_key.length<8||input.idempotency_key.length>100||
  input.immutable_plan_resource!==EXACT_BOOTSTRAP_PLAN.resource||input.idempotency_key!==EXACT_BOOTSTRAP_PLAN.idempotency_key||
  !['producer_record_id','permission_record_id','recognition_record_id'].every(k=>input[k]===EXACT_BOOTSTRAP_PLAN.targets[k]))throw new BootstrapInputDenied();
 // Do not read neutral Owner readiness inside a write invocation. The SQL
 // transaction checks exact Native permission before its first Canonical read;
 // callers may invoke the separate read-only readiness tool explicitly.
 const request=structuredClone(input);let result;
 try{result=await rpc(BOOTSTRAP_COMMIT_RPC,request);}catch(error){
  // Only the owned Worker transport can classify a definite database rollback.
  // A caller-shaped status/code object or any transport uncertainty is not proof.
  if(error instanceof BootstrapExecutionDenied)throw error;
  throw new BootstrapCompletionUnknown();
 }
 const keys=['status','actual_execution','producer_record_ref','permission_record_ref','recognition_record_ref',
  'canonical_receipt_ids','canonical_event_ids','evaluated_at','domain_authority_receipt','data_gate','m2_verdict',
  'training_or_data_use_authorized','private_actor_fields_exposed'];
 if(!exact(result,keys)||result.status!=='COMMITTED_NON_PRODUCTION_M1_DEFINITION_PROJECTIONS_ONLY'||
  result.actual_execution!=='CANONICAL_RECORD_MUTATION'||
  !ref(result.producer_record_ref)||result.producer_record_ref.id!==request.producer_record_id||
  !ref(result.permission_record_ref)||result.permission_record_ref.id!==request.permission_record_id||
  !ref(result.recognition_record_ref)||result.recognition_record_ref.id!==request.recognition_record_id||
  !Array.isArray(result.canonical_receipt_ids)||result.canonical_receipt_ids.length!==3||
  !result.canonical_receipt_ids.every(v=>typeof v==='string'&&uuid.test(v))||new Set(result.canonical_receipt_ids).size!==3||
  !Array.isArray(result.canonical_event_ids)||result.canonical_event_ids.length!==3||
  !result.canonical_event_ids.every(v=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n)||
  new Set(result.canonical_event_ids).size!==3||!recent(result.evaluated_at,clock())||
  result.domain_authority_receipt!=='NOT_KERNEL_RECEIPT'||result.data_gate!=='NOT_ISSUED'||result.m2_verdict!=='NOT_ISSUED'||
  result.training_or_data_use_authorized!==false||result.private_actor_fields_exposed!==false)throw new BootstrapCompletionUnknown();
 return structuredClone(result);
}
