import assert from 'node:assert/strict';
import test from 'node:test';
import {performNextFixedEffect} from './supervisor.mjs';
const id='a'.repeat(64);
function fixture(){
 const gaRaw=JSON.stringify({gate_authorization_id:'ga_synthetic',idempotency_key:'synthetic',deadline:'2026-09-08T15:01:00Z'});
 let now=Date.parse('2026-09-08T15:00:00Z');
 const calls=[],records=new Map();
 const state={current:{active_ga_id:'ga_synthetic',sequence:0},attempts:[{ga_id:'ga_synthetic',ga_raw:gaRaw,phase:'PENDING',revoked:false,container_id:null}]};
 const ports={gaRaw,operation:'CREATE',clock:()=>now,
  store:{read:async()=>{calls.push('read');return structuredClone(state);},transition:async p=>{calls.push(p.operation);state.current.sequence++;state.attempts[0].phase=p.operation;return {status:'RECORDED',phase:p.operation};}},
  verifyCurrent:async()=>{calls.push('verify');},
  evidence:{publish:async raw=>{const key=String(records.size);records.set(key,raw);return key;},readBack:async key=>records.get(key)},
  docker:{createFixed:async()=>{calls.push('docker-create');return id;},startExact:async()=>{calls.push('docker-start');},inspectExact:async()=>({Id:id})},
  watchdog:{armExact:async()=>{},isAlive:async()=>true}};
 return {ports,calls,state,setNow:v=>{now=v;}};
}
test('trusted host orchestration: two fresh checks and durable intent before fixed create',async()=>{
 const f=fixture();const out=await performNextFixedEffect(f.ports);
 assert.equal(out.state,'OBSERVED');assert.equal(out.qualification_result,null);
 assert.deepEqual(f.calls,['read','verify','read','verify','CREATE_SENT','docker-create','read','CREATED']);
});
test('missing verifier is rejected rather than shaped data authorizing an action',async()=>{
 const f=fixture();f.ports.verifyCurrent={authorized:true};await assert.rejects(performNextFixedEffect(f.ports),/missing_trusted_port/);assert.equal(f.calls.length,0);
});
test('fresh check after remote publication catches revoked authority with zero dispatch',async()=>{
 const f=fixture();let checks=0;f.ports.verifyCurrent=async()=>{if(++checks===2)throw Error('root_revoked');};
 assert.equal((await performNextFixedEffect(f.ports)).state,'BLOCKED');assert.ok(!f.calls.includes('docker-create'));
});
test('deadline crossed by fresh SQL acknowledgement leaves UNKNOWN without Docker call',async()=>{
 const f=fixture();f.ports.store.transition=async p=>{f.setNow(Date.parse('2026-09-08T15:01:00Z'));return {status:'RECORDED',phase:p.operation};};
 const out=await performNextFixedEffect(f.ports);assert.equal(out.state,'UNKNOWN');assert.equal(out.capacity_released,false);assert.ok(!f.calls.includes('docker-create'));
});
test('historical transition replay never grants permission to redispatch',async()=>{
 const f=fixture();f.ports.store.transition=async()=>({status:'DUPLICATE',phase:'CREATE_SENT'});
 const out=await performNextFixedEffect(f.ports);assert.equal(out.state,'UNKNOWN');assert.ok(!f.calls.includes('docker-create'));
});
test('watchdog loss immediately before START blocks launch and keeps UNKNOWN capacity',async()=>{
 const f=fixture();f.ports.operation='START';Object.assign(f.state.attempts[0],{phase:'CREATED',container_id:id});
 let checks=0;f.ports.watchdog.isAlive=async()=>++checks===1;
 const out=await performNextFixedEffect(f.ports);assert.equal(out.state,'UNKNOWN');assert.ok(!f.calls.includes('docker-start'));assert.equal(out.capacity_released,false);
});
