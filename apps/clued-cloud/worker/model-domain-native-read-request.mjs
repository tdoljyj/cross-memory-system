/** Prepares the existing Owner Request bundle. Does not submit or approve it. */
import { POLICY, DomainReadDenied } from './model-domain-readonly.mjs';
import { resolveWithExistingBindingRpc } from './model-domain-ref-resolver.mjs';
export async function prepareNativeGrantBundle(rpc,selectors,idempotencyKey,clock){
  if(typeof idempotencyKey!=='string'||idempotencyKey.length<8||idempotencyKey.length>150||/\s/.test(idempotencyKey))
    throw new DomainReadDenied('OWNER_REQUEST_IDEMPOTENCY_INVALID');
  const projection=await resolveWithExistingBindingRpc(rpc,selectors,clock);
  const resource=ref=>`record:${ref.id}@${ref.version}#${ref.content_hash}`;
  return Object.freeze({scope:POLICY.scope,task_id:POLICY.task,idempotency_key:idempotencyKey,
    actions:POLICY.actions.map(action=>({action,resources:[resource(action.endsWith('.producer')?projection.producer_registration_ref:projection.permission_record_ref)]})),
    suggested_grant:{expires_seconds:3600},
    agent_note:'仅对当前 requester Binding、原第一方模型任务及精确 Record 版本/服务 hash 做非生产 DatasetSplit 来源认定与核验准备。请在现有原生页面选限时授权≤1小时、保留精确资源且不选择任意 Agent；批准一次/24小时不满足此读取器。此申请不授权训练、正式M2验收、DataGate或产品发布。'});
}
