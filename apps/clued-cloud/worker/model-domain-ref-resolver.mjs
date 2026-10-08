/** Existing Binding RPC closure only. No routes/tools/credentials/permission. */
import { POLICY, DomainReadDenied, parseSourceUTC } from './model-domain-readonly.mjs';
export const RESOLVE_RPC='clued_model_dataset_split_resolve_refs_candidate';
const ids=['permission_record_id','producer_registration_id','recognition_record_id'];
const refs=['permission_record_ref','producer_registration_ref','recognition_record_ref'];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const deny=()=>{throw new DomainReadDenied('REF_PROJECTION_DENIED_OR_INVALID');};
export async function resolveWithExistingBindingRpc(rpc,input,clock=()=>Date.now()){
  if(typeof rpc!=='function'||!exact(input,ids)||!ids.every(k=>typeof input[k]==='string'&&uuid.test(input[k]))) deny();
  let result;try{result=await rpc(RESOLVE_RPC,structuredClone(input));}catch{deny();}
  if(!exact(result,[...refs,'status','source_scope','evaluated_at','projection_only','authority_effect','actual_execution','m2_qualification'])||
     result.status!=='RESOLVED_EXISTING_PROJECTION_REFERENCES_READ_ONLY'||result.source_scope!==POLICY.scope||
     result.projection_only!==true||result.authority_effect!=='NONE'||result.actual_execution!=='NONE'||result.m2_qualification!=='NOT_ISSUED') deny();
  for(let n=0;n<refs.length;n++){
    const ref=result[refs[n]];
    if(!exact(ref,['id','version','content_hash'])||ref.id!==input[ids[n]]||
      !Number.isSafeInteger(ref.version)||ref.version<=0||typeof ref.content_hash!=='string'||!/^[0-9a-f]{64}$/.test(ref.content_hash)) deny();
  }
  const observed=parseSourceUTC(result.evaluated_at),now=clock();
  if(typeof result.evaluated_at!=='string'||!Number.isFinite(observed)||!Number.isSafeInteger(now)||observed>now||now-observed>POLICY.maxAgeMs) deny();
  return Object.freeze(structuredClone(result));
}
