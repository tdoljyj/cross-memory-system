// Fixed private SQL transport primitives. Host verifier owns cryptographic checks.
import crypto from 'node:crypto';
export const projectRef='uscrdifznmlvczcekqpw';
export const rootId='ctr_414bd3c724264a83894b0c55cf2ab878';
const sha=raw=>crypto.createHash('sha256').update(raw,'utf8').digest('hex');
export function createExecutionStore({project,query}){
 if(project!==projectRef||typeof query!=='function')throw Error('Wrong explicit nonproduction transport');
 const value=async(sql,args=[])=>{const result=await query(sql,args);if(result.rows.length!==1)throw Error('Exact control row missing');return result.rows[0].value;};
 return Object.freeze({
  read:()=>value('select clued_control.read_execution() value'),
  reserveExactGa:raw=>{if(typeof raw!=='string')throw Error('Exact UTF8 GA required');return value('select clued_control.reserve_gate($1,$2) value',[raw,sha(raw)]);},
  transition:request=>value('select clued_control.execution_transition($1::jsonb) value',[JSON.stringify(request)]),
  rotate:request=>value('select clued_control.rotate_execution_generation($1::jsonb) value',[JSON.stringify(request)]),
  commitExactResult:(raw,reservation)=>{if(typeof raw!=='string'||!/^[0-9a-f]{64}$/.test(reservation))throw Error('Exact result/reservation required');return value('select clued_control.commit_gate_result($1,$2,$3) value',[raw,sha(raw),reservation]);},
 });
}
// No DSN/key loading, public RPC, alternate project, signing or unverified grant.
