// Optimized fixed tool orchestration: one fresh SQL dispatch response includes
// committed Intent bytes and current Root/context. No local record is authority.
import crypto from 'node:crypto';
import {deriveEventKey} from './supervisor.mjs';
const sha=raw=>crypto.createHash('sha256').update(raw,'utf8').digest('hex');
const need=(ok,reason)=>{if(!ok)throw Error(reason);};
export function intentFor(gaRaw,operation){
 need(typeof gaRaw==='string'&&['CREATE','START'].includes(operation),'fixed_effect_required');
 const ga=JSON.parse(gaRaw),raw=JSON.stringify({ga_id:ga.gate_authorization_id,ga_sha256:sha(gaRaw),operation});
 return {gaId:ga.gate_authorization_id,key:'intent_'+sha(operation+'\0'+gaRaw),body:{operation,raw,sha256:sha(raw)}};
}
export async function dispatchPreparedIntent({gaRaw,operation,intentSequence,store,verifyCurrent,host,clock=Date.now}){
 const intent=intentFor(gaRaw,operation),ga=JSON.parse(gaRaw),deadline=Date.parse(ga.deadline);
 for(const [name,fn] of Object.entries({dispatch:store?.dispatchIntent,verifyCurrent,create:host?.createFixed,start:host?.startExact,guard:host?.armExact}))
  need(typeof fn==='function','missing_fixed_trusted_port:'+name);
 need(Number.isSafeInteger(intentSequence)&&intentSequence>0&&Number.isFinite(deadline),'exact_prepared_intent_required');
 let attempted=false,container=null;
 try{
  need(clock()<deadline,'deadline_expired');
  attempted=true;
  const response=await store.dispatchIntent({gaId:intent.gaId,operation,key:deriveEventKey(gaRaw,operation,'sent'),sequence:intentSequence,digest:intent.body.sha256});
  need(response?.status==='RECORDED'&&response.phase===operation+'_SENT','no_dispatch_on_replay_or_uncertainty');
  const committed=response.prior_committed_intent_readback;
  need(committed?.sequence===intentSequence&&committed.request?.ga_id===intent.gaId&&committed.request.operation==='INTENT_RECORDED'
    &&committed.request.body?.raw===intent.body.raw&&committed.request.body.sha256===intent.body.sha256,'exact_committed_intent_readback_required');
  const current=response.current_context,attempt=current?.attempts?.find(x=>x.ga_id===intent.gaId);
  need(current?.current?.active_ga_id===intent.gaId&&attempt?.ga_raw===gaRaw&&attempt.phase===operation+'_SENT','exact_current_attempt_required');
  // Concrete fixed verifier is supplied by the trusted root/tool integration,
  // resolving actual signatures and exact accepted sources, not caller booleans.
  await verifyCurrent({gaRaw,gaSha256:sha(gaRaw),state:current,now:clock(),operation});
  need(clock()<deadline,'deadline_expired_after_current_verification');
  if(operation==='CREATE')container=await host.createFixed({gaSha256:sha(gaRaw),deadline});
  else{
   container=attempt.container_id;need(typeof container==='string'&&/^[0-9a-f]{64}$/.test(container),'exact_container_required');
   const guard=await host.armExact({containerId:container,deadline});
   need(clock()<deadline,'deadline_expired_after_guard');
   await host.startExact({containerId:container,guard,deadline});
  }
  need(typeof container==='string'&&/^[0-9a-f]{64}$/.test(container),'outcome_identity_unknown');
  return {state:'EFFECT_RETURNED_NOT_YET_REMOTE_RESULT',container_id:container,current_sequence:response.sequence,
   capacity_released:false,qualification_result:null};
 }catch(error){return {state:attempted?'UNKNOWN':'BLOCKED',reason:String(error.message),container_id:container,automatic_retry:false,capacity_released:false,qualification_result:null};}
}
