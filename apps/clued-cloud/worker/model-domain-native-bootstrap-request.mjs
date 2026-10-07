/** Prepares a genuine Native write request; does not submit or approve it.
 * Existing installed-source RPC closure only. Fixed anchor resolver is a
 * neutral read and never pretends to be domain permission or a write proof.
 */
import {DOMAIN_POLICY as P} from './model-domain-policy.mjs';
import {POLICY} from './model-domain-readonly.mjs';
import {FullDomainDenied} from './model-domain-consumer.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...k].sort().join('|');
const deny=()=>{throw new FullDomainDenied('NATIVE_BOOTSTRAP_REQUEST_NOT_READY_OR_INVALID');};
export async function prepareNativeBootstrapRequest(rpc,input){
 const keys=['producer_record_id','permission_record_id','recognition_record_id','idempotency_key','immutable_plan_resource'];
 if(typeof rpc!=='function'||!exact(input,keys)||!keys.slice(0,3).every(k=>typeof input[k]==='string'&&uuid.test(input[k]))||new Set(keys.slice(0,3).map(k=>input[k])).size!==3||typeof input.idempotency_key!=='string'||input.idempotency_key.length<8||input.idempotency_key.length>100)deny();
 if(typeof input.immutable_plan_resource!=='string'||!/^repo:tdoljyj\/cross-memory-system\/[0-9a-f]{40}\/development\/contracts\/model-program\/stage-admission\/[A-Za-z0-9_.-]+\.json$/.test(input.immutable_plan_resource))deny();
 let output;try{output=await rpc('clued_model_dataset_split_owner_anchor_refs_candidate',{schema:'clued.model-owner-anchor-refs/1'});}catch{deny();}
 if(!exact(output,['owner_adoption_server_ref','final_recognizer_server_ref','status','projection_only','source_scope','authority_effect','domain_permission','m2_verdict'])||output.status!=='OWNER_ANCHOR_PROJECTION_REFS_ONLY'||output.projection_only!==true||output.source_scope!==POLICY.scope||output.authority_effect!=='NONE'||output.domain_permission!=='NOT_GRANTED'||output.m2_verdict!=='NOT_ISSUED')deny();
 const refs=[output.owner_adoption_server_ref,output.final_recognizer_server_ref],ids=[P.domain.owner_adoption.canonical_record_id,P.server.owner_final_recognizer.record_ref.id];
 for(let i=0;i<2;i++)if(!exact(refs[i],['id','version','content_hash'])||refs[i].id!==ids[i]||refs[i].version!==1||typeof refs[i].content_hash!=='string'||!/^[0-9a-f]{64}$/.test(refs[i].content_hash))deny();
 if(keys.slice(0,3).some(k=>ids.includes(input[k])))deny();
 const resources=[...refs.map(r=>`record:${r.id}@${r.version}#${r.content_hash}`),...keys.slice(0,3).map(k=>'record:'+input[k]),input.immutable_plan_resource];
 return Object.freeze({status:'NATIVE_WRITE_REQUEST_PAYLOAD_CANDIDATE_NOT_SUBMITTED',request:{action:P.bootstrap_action,scope:POLICY.scope,task_id:POLICY.task,resources,suggested_grant:{expires_seconds:3600,max_uses:1},idempotency_key:input.idempotency_key,agent_note:'仅一次创建这三个目标ID对应的固定非生产DatasetSplit producer/permission/recognition投影，来源绑定已存在Owner两个Decision的真实serverhash；请在Native页面选择requester、精确资源、≤1小时/一次。它不批准Kernel DomainAuthorityReceipt、M2验收、训练或产品发布。写路径仍需精确不可变create包及SQL同事务/隐私规范化验证后激活。'}});
}
