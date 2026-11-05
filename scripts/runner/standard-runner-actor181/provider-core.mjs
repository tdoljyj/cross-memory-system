import {ChildProcess} from 'node:child_process';import {createHash} from 'node:crypto';import {refuse} from './errors.mjs';import {assertRootOwnedLaunchHandle212,assertRootOwnedCaptureHandle212} from './installed-authority.mjs';
export const PORT_NAMES=Object.freeze(['requireAcceptedSource','bindNativeInvocation','requireCurrent','captureAcceptedTools','readOwnPrimaryRuntime','requireOwnedLiveObserver','invokeCapturedRunnerOnce','requireOwnedLiveObserverPhase','reopenAndValidateExactProof']);
const TOOL_NAMES=['actor','runner_entry','observer_entry','observer_core','observer_os','identity','definition','registration'];
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// Internal composition seam. These callbacks are NOT authority. The installed
// no-argument resolver obtains only the protected Root-owned authority factory.
// CLI/environment never chooses this constructor, callbacks, executable or path.
export function composeOwnedProvider208({authority,captured,mechanics}){
 let spent=false,captureSpent=false,preparing=false,owned=null,prepared=null;
 const call=(name,input)=>{if(!authority||typeof authority[name]!=='function')refuse('ROOT_OWNED_NATIVE_INVOCATION_NOT_ATTACHED');return authority[name](input);};
 const exact=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||!same(Object.keys(v).sort(),[...keys].sort()))refuse('PROVIDER_PORT_INPUT_REFUSED');};
 const sha=b=>createHash('sha256').update(b).digest('hex');
 const tuple=q=>sha(JSON.stringify({row:q.row,binding:q.binding,runtime:q.runtime}));
 const prepareCapturedSelf=async q=>{
  if(prepared){if(prepared.tuple!==tuple(q))refuse('ACTUAL_NODE_PS_CHAIN_REFUSED');return;}
  if(captureSpent||preparing||q.runtime?.process_id!==process.pid)refuse('OWNED_INVOKE_ALREADY_ATTEMPTED');
  preparing=true;
  try{
   // A genuine current Root session permits capture-only; it is a different
   // opaque capability from the later BA-ready permission to start the actor.
   const capturePermission=await call('requireOwnedCaptureReady',q);assertRootOwnedCaptureHandle212(capturePermission);
   captureSpent=true;if(typeof mechanics?.spawnOwnedSelfOnce!=='function')refuse('ACTUAL_CHILDPROCESS_REQUIRED');
   owned=mechanics.spawnOwnedSelfOnce();
   if(!(owned.child instanceof ChildProcess)||!Number.isSafeInteger(owned.child.pid)||owned.child.pid<=0)refuse('ACTUAL_CHILDPROCESS_REQUIRED');
   const m=await owned.captureReady;
   if(m.ps_pid!==owned.child.pid||m.ps_parent_pid!==process.pid||m.node_pid!==process.pid||m.node_start!==q.runtime.creation_file_time||m.node_sid!==q.row.sid||m.ps_sid!==q.row.sid||m.host!==q.row.host||m.node_elevated!==0||m.ps_elevated!==0||m.authority_granted!==false||m.source_captured!==true||m.runner_name!==q.row.runner_name)refuse('ACTUAL_NODE_PS_CHAIN_REFUSED');
   // Root independently reopens this real Node child's identity, then binds
   // its separately owned BA/relay. It never uses the broker PID as Self.
   const start=await call('bindActualCapturedChild',{...q,owned,metadata:m});
   exact(start,['attempt_id','node_pid','node_start','node_image','relay_pid','relay_start','relay_sid']);
   if(start.attempt_id!==q.binding.attempt_id||start.node_pid!==process.pid||start.node_start!==m.node_start||start.node_image!==m.node_image||!Number.isSafeInteger(start.relay_pid)||start.relay_pid<=0||start.relay_pid===owned.child.pid||typeof start.relay_start!=='string'||!/^[1-9][0-9]{0,18}$/.test(start.relay_start)||typeof start.relay_sid!=='string')refuse('ACTUAL_NODE_PS_CHAIN_REFUSED');
   prepared={tuple:tuple(q),start};
  }catch(error){try{owned?.closeBeforeStart()}catch{}throw error}finally{preparing=false}
 };
 const ports={
  requireAcceptedSource:q=>call('requireAcceptedSource',q),
  bindNativeInvocation:q=>call('bindNativeInvocation',q),
  requireCurrent:q=>call('requireCurrent',q),
  captureAcceptedTools:async q=>{await call('requireCurrent',{...q,phase:'source'});return Object.fromEntries(TOOL_NAMES.map(k=>[k,Buffer.from(captured['capture/'+k+(k==='identity'?'.dll':'.ps1')]) ]));},
  readOwnPrimaryRuntime:async q=>{await call('requireCurrent',{...q,phase:'own-primary-identity'});if(typeof authority.readActualNodePrimaryRuntime!=='function')refuse('NODE_PRIMARY_TOKEN_FACTS_UNAVAILABLE');const value=await authority.readActualNodePrimaryRuntime(q);if(value.process_id!==process.pid)refuse('ACTUAL_NODE_PS_CHAIN_REFUSED');return value;},
  requireOwnedLiveObserver:async q=>{await prepareCapturedSelf(q);return call('requireOwnedLiveObserver',q);},
  requireOwnedLiveObserverPhase:async q=>{const v=await call('requireOwnedLiveObserverPhase',q);exact(v,['status']);if(v.status!=='VERIFIED_BY_TRUSTED_AUTHORITY')refuse('ROOT_OPERATION_REFUSED_OR_UNKNOWN');},
  invokeCapturedRunnerOnce:async q=>{
   exact(q,['row','binding','runtime','tools','entrySha256','allowedOperations','beforeOperation']);if(spent)refuse('OWNED_INVOKE_ALREADY_ATTEMPTED');
   if(!same(q.allowedOperations,['self-register','self-run'])||q.runtime.process_id!==process.pid||typeof q.beforeOperation!=='function')refuse('PROVIDER_PORT_INPUT_REFUSED');
   if(q.entrySha256!==sha(captured['capture/runner_entry.ps1']))refuse('PROVIDER_PORT_INPUT_REFUSED');
   for(const k of TOOL_NAMES){const original=captured['capture/'+k+(k==='identity'?'.dll':'.ps1')];if(!Buffer.isBuffer(q.tools[k])||sha(q.tools[k])!==sha(original))refuse('SOURCE_CAPTURE_REFUSED');}
   if(!prepared||!owned||prepared.tuple!==tuple(q))refuse('ACTUAL_NODE_PS_CHAIN_REFUSED');
   const permission=await call('requireOwnedLaunchReady',q);assertRootOwnedLaunchHandle212(permission);
   spent=true;
   try{
    await q.beforeOperation('self-register');owned.startOnce(prepared.start);
    // Actual Register/Run are guarded again inside original captured entry and
    // fresh authenticated Root relay. Never synthesize a Node-side Run ACK.
    const observed=await call('awaitActualNativeProof',{...q,owned});return observed;
   }catch(error){try{owned.closeBeforeStart();}catch{}throw error;}
  },
  reopenAndValidateExactProof:async q=>{try{const v=await call('reopenAndValidateExactProof',q);exact(v,['status','proof_sha256','export_sha256']);if(v.status!=='EXACT_NATIVE_PROOF_REOPENED'||v.proof_sha256!==q.outcome.proof_sha256||v.export_sha256!==q.outcome.export_sha256)refuse('NATIVE_PROOF_NOT_REOPENED');}finally{if(typeof authority?.close==='function')authority.close();}}
 };
 return Object.freeze({acceptedRows:()=>authority.acceptedRows(),...ports});
}
