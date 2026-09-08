import crypto from 'node:crypto';
import {createControlObjectStore} from '../control-objects-successor/client.mjs';
export {projectRef,rootId} from '../client.mjs';
export function createBudgetStore(options){
 const old=createControlObjectStore(options);
 return Object.freeze({...old,reserveBudget:async raw=>{
  if(typeof raw!=='string'||Buffer.byteLength(raw)>16384)throw Error('Bounded exact allocation bytes required');
  const digest=crypto.createHash('sha256').update(raw).digest('hex');
  const response=await options.query('select clued_control.reserve_execution_budget($1,$2) value',[raw,digest]);
  if(response.rows.length!==1)throw Error('Exact allocation response missing');return response.rows[0].value;
 }});
}
