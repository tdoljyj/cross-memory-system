import assert from 'node:assert/strict';
import test from 'node:test';
import {intentFor,dispatchPreparedIntent} from './sql_effect.mjs';
function fixture(){
 const gaRaw=JSON.stringify({gate_authorization_id:'ga_sql',deadline:'2026-09-08T17:03:00Z'}),intent=intentFor(gaRaw,'CREATE'),calls=[];
 const response={status:'RECORDED',phase:'CREATE_SENT',sequence:2,prior_committed_intent_readback:{sequence:1,request:{ga_id:intent.gaId,operation:'INTENT_RECORDED',body:intent.body}},current_context:{current:{active_ga_id:intent.gaId},attempts:[{ga_id:intent.gaId,ga_raw:gaRaw,phase:'CREATE_SENT'}]}};
 return {response,calls,args:{gaRaw,operation:'CREATE',intentSequence:1,clock:()=>Date.parse('2026-09-08T17:00:00Z'),store:{dispatchIntent:async()=>{calls.push('fresh_sql');return response;}},verifyCurrent:async()=>{calls.push('actual_verifier_port');},host:{createFixed:async()=>{calls.push('fixed_create');return 'a'.repeat(64);},startExact:async()=>{},armExact:async()=>{}}}};
}
test('one fresh committed SQL response precedes verifier and exactly one effect',async()=>{const f=fixture();const out=await dispatchPreparedIntent(f.args);assert.equal(out.state,'EFFECT_RETURNED_NOT_YET_REMOTE_RESULT');assert.deepEqual(f.calls,['fresh_sql','actual_verifier_port','fixed_create']);assert.equal(out.qualification_result,null);});
test('wrong durable bytes, replay and rejected authority never launch',async()=>{for(const fault of ['raw','replay','authority']){const f=fixture();if(fault==='raw')f.response.prior_committed_intent_readback.request.body.raw='{}';if(fault==='replay')f.response.status='DUPLICATE';if(fault==='authority')f.args.verifyCurrent=async()=>{throw Error('revoked');};assert.equal((await dispatchPreparedIntent(f.args)).state,'UNKNOWN');assert.ok(!f.calls.includes('fixed_create'));}});
