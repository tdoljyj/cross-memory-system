// Fixed two-effect orchestration. Host ports are trusted code, NOT JSON authority.
// No CLI, DSN, arbitrary command, automatic retry or embedded signature issuer.
import crypto from 'node:crypto';
const digest=s=>crypto.createHash('sha256').update(s,'utf8').digest('hex');
const requireValue=(ok,message)=>{if(!ok)throw Error(message);};
const hex=s=>typeof s==='string'&&/^[0-9a-f]{64}$/.test(s);
export function deriveEventKey(gaRaw,operation,stage){
 requireValue(typeof gaRaw==='string'&&['CREATE','START'].includes(operation)&&['sent','observed'].includes(stage),'fixed_event_domain_required');
 return 'clued_'+digest('clued-fixed-effect-v1\0'+operation+'\0'+stage+'\0'+gaRaw);
}
export async function performNextFixedEffect({gaRaw,operation,store,verifyCurrent,evidence,docker,watchdog,clock=Date.now}){
 requireValue(typeof gaRaw==='string'&&['CREATE','START'].includes(operation),'fixed_effect_required');
 // verifyCurrent must validate exact raw Schema, trusted signature/issuer,
 // accepted Gate/Profile/controller, NA reasons and fresh tool-side SQL read.
 // A caller-provided JSON {authorized:true} is never an accepted verifier port.
 for(const [name,fn] of Object.entries({read:store?.read,transition:store?.transition,verifyCurrent,publish:evidence?.publish,readBack:evidence?.readBack,createFixed:docker?.createFixed,startExact:docker?.startExact,inspectExact:docker?.inspectExact,armExact:watchdog?.armExact,isAlive:watchdog?.isAlive}))
  requireValue(typeof fn==='function','missing_trusted_port:'+name);
 const ga=JSON.parse(gaRaw),sha=digest(gaRaw),deadline=Date.parse(ga.deadline);
 requireValue(Number.isFinite(deadline),'invalid_deadline');
 let sent=false,container=null;
 const live=async()=>{
  requireValue(clock()<deadline,'deadline_expired');
  const state=await store.read(); // Actual fresh query per call; no cached readback.
  await verifyCurrent({gaRaw,gaSha256:sha,state,now:clock(),operation});
  requireValue(clock()<deadline,'deadline_expired_after_verification');
  const attempt=state?.attempts?.find(a=>a.ga_id===ga.gate_authorization_id);
  requireValue(state?.current?.active_ga_id===ga.gate_authorization_id&&attempt?.ga_raw===gaRaw&&!attempt.revoked,'exact_active_ga_missing');
  requireValue(attempt.phase===(operation==='CREATE'?'PENDING':'CREATED'),'no_redispatch_after_unknown_or_sent');
  container=attempt.container_id;
  return state;
 };
 try{
  await live();
  const intentRaw=JSON.stringify({kind:'AUXILIARY_ENGINEERING_INTENT',ga_sha256:sha,operation,container_id:container});
  const reference=await evidence.publish(intentRaw);
  requireValue(await evidence.readBack(reference)===intentRaw,'remote_intent_exact_readback_missing');
  const state=await live(); // Durable publication does not replace current authority.
  if(operation==='START'){
   requireValue(hex(container),'exact_container_missing');
   await watchdog.armExact({containerId:container,deadline});
   requireValue(await watchdog.isAlive({containerId:container,deadline}),'watchdog_not_armed');
  }
  const event={idempotency_key:deriveEventKey(gaRaw,operation,'sent'),expected_sequence:state.current.sequence,ga_id:ga.gate_authorization_id,operation:operation+'_SENT',body:{intent_sha256:digest(intentRaw)}};
  sent=true; // A lost SQL response may already have durably reserved this dispatch.
  const recorded=await store.transition(event); // SQL itself rechecks current Root/gens/window.
  requireValue(recorded?.status==='RECORDED'&&recorded.phase===operation+'_SENT','transition_not_new_dispatch');
  requireValue(clock()<deadline,'deadline_expired_before_effect');
  if(operation==='START')requireValue(await watchdog.isAlive({containerId:container,deadline}),'watchdog_died_before_start');
  requireValue(clock()<deadline,'deadline_expired_after_watchdog_check');
  if(operation==='CREATE'){
   container=await docker.createFixed({gaSha256:sha,deadline});
   requireValue(hex(container),'create_identity_unknown');
  }else await docker.startExact({containerId:container,deadline});
  const observation=await docker.inspectExact({containerId:container,deadline});
  requireValue(observation?.Id===container,'inspect_identity_changed');
  // The fixed Docker port verifies all accepted config/mount/env/host hashes.
  // Inspection alone is not qualification; publication remains an exact raw fact.
  const resultRaw=JSON.stringify({kind:'AUXILIARY_ENGINEERING_RESULT',ga_sha256:sha,operation,container_id:container,observation});
  const resultRef=await evidence.publish(resultRaw);
  requireValue(await evidence.readBack(resultRef)===resultRaw,'remote_result_exact_readback_missing');
  const current=await store.read();
  const result=await store.transition({idempotency_key:deriveEventKey(gaRaw,operation,'observed'),expected_sequence:current.current.sequence,ga_id:ga.gate_authorization_id,operation:operation==='CREATE'?'CREATED':'RUNNING',body:{container_id:container}});
  return {state:'OBSERVED',container_id:container,result_ref:resultRef,store_result:result,qualification_result:null};
 }catch(error){
  // Never resend an effect. The independent watchdog retains responsibility for
  // an armed container. This function cannot declare STOP or release capacity.
  return {state:sent?'UNKNOWN':'BLOCKED',container_id:container,reason:String(error.message),capacity_released:false,automatic_retry:false,qualification_result:null};
 }
}
