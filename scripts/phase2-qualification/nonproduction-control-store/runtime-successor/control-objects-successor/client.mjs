// Same private transport; no credentials, issuer or alternate project.
import crypto from 'node:crypto';
import {createExecutionStore} from '../client.mjs';
export {projectRef,rootId} from '../client.mjs';
export function createControlObjectStore(options){
 const existing=createExecutionStore(options);
 return Object.freeze({...existing,appendStatus:async raw=>{
  if(typeof raw!=='string'||Buffer.byteLength(raw)>65536)throw Error('Bounded exact Status bytes required');
  const sha=crypto.createHash('sha256').update(raw).digest('hex');
  const response=await options.query('select clued_control.append_status_manifest($1,$2) value',[raw,sha]);
  if(response.rows.length!==1)throw Error('Exact Status response missing');
  return response.rows[0].value;
 }});
}
