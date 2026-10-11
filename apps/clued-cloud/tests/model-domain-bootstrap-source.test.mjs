import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import test from 'node:test';
import {readBootstrapReadiness,commitBootstrap,EXACT_BOOTSTRAP_PLAN,BOOTSTRAP_READINESS_RPC,BOOTSTRAP_COMMIT_RPC,BootstrapInputDenied,BootstrapExecutionDenied,BootstrapCompletionUnknown,BootstrapReadinessDenied} from '../worker/model-domain-bootstrap-source.mjs';
const planBytes=fs.readFileSync(new URL('../../../development/contracts/model-program/stage-admission/DatasetSplitBootstrapPlan.fc83a4a1.json',import.meta.url));
assert.equal(crypto.createHash('sha256').update(planBytes).digest('hex'),EXACT_BOOTSTRAP_PLAN.sha256);
const plan=JSON.parse(planBytes.toString('utf8'));
const now=Date.parse('2026-10-08T11:00:00Z');
const input=()=>({...structuredClone(plan.owner_anchor_refs),...plan.targets,idempotency_key:plan.idempotency_key,immutable_plan_resource:EXACT_BOOTSTRAP_PLAN.resource});
const readiness=()=>({status:'FIXED_OWNER_CHAIN_AND_PLAN_READINESS_ONLY',...structuredClone(plan.owner_anchor_refs),immutable_plan_resource:EXACT_BOOTSTRAP_PLAN.resource,plan_sha256:EXACT_BOOTSTRAP_PLAN.sha256,max_uses:1,max_window_seconds:3600,evaluated_at:new Date(now).toISOString(),bootstrap_write_authorized:false,domain_permission:'NOT_GRANTED',m2_verdict:'NOT_ISSUED',private_actor_fields_exposed:false});
const committed=()=>({status:'COMMITTED_NON_PRODUCTION_M1_DEFINITION_PROJECTIONS_ONLY',actual_execution:'CANONICAL_RECORD_MUTATION',
 producer_record_ref:{id:plan.targets.producer_record_id,version:1,content_hash:'1'.repeat(64)},permission_record_ref:{id:plan.targets.permission_record_id,version:1,content_hash:'2'.repeat(64)},
 recognition_record_ref:{id:plan.targets.recognition_record_id,version:1,content_hash:'3'.repeat(64)},canonical_receipt_ids:[crypto.randomUUID(),crypto.randomUUID(),crypto.randomUUID()],
 canonical_event_ids:['1','2','3'],evaluated_at:new Date(now).toISOString(),domain_authority_receipt:'NOT_KERNEL_RECEIPT',data_gate:'NOT_ISSUED',m2_verdict:'NOT_ISSUED',training_or_data_use_authorized:false,private_actor_fields_exposed:false});
function stub(changeReady=v=>v,changeCommit=v=>v){const calls=[];return{calls,rpc:async(name,body)=>{calls.push({name,body:structuredClone(body)});if(name===BOOTSTRAP_READINESS_RPC)return changeReady(readiness());if(name===BOOTSTRAP_COMMIT_RPC)return changeCommit(committed());throw Error('Unexpected RPC');}};}
test('relay-only fixture: exact plan and minimal committed DTO; no real source or write qualification',async()=>{
 const s=stub();const value=await commitBootstrap(s.rpc,input(),()=>now);
 assert.equal(value.m2_verdict,'NOT_ISSUED');assert.equal(value.training_or_data_use_authorized,false);
 assert.deepEqual(s.calls.map(x=>x.name),[BOOTSTRAP_COMMIT_RPC]);assert.deepEqual(s.calls[0].body,input());
});
test('readiness never invokes a writer or grants bootstrap authority',async()=>{
 const s=stub();const r=await readBootstrapReadiness(s.rpc,{},()=>now);assert.equal(r.bootstrap_write_authorized,false);assert.equal(s.calls.length,1);
});
test('input rejects caller Actor/proof/scope/clock before any RPC',async()=>{
 for(const key of ['actor','verified','scope','clock','grant','session_token']){const s=stub();await assert.rejects(commitBootstrap(s.rpc,{...input(),[key]:'forged'},()=>now),BootstrapInputDenied);assert.equal(s.calls.length,0);}
});
test('readiness denies changed bytes, elevated result, stale source and private payload with no write',async()=>{
 for(const mutate of [v=>({...v,plan_sha256:'f'.repeat(64)}),v=>({...v,bootstrap_write_authorized:true}),v=>({...v,evaluated_at:'2026-10-08T10:00:00Z'}),v=>({...v,actor:'private'})]){
  const s=stub(mutate);await assert.rejects(readBootstrapReadiness(s.rpc,{},()=>now),BootstrapReadinessDenied);assert.equal(s.calls.length,1);
 }
});
test('readiness reason is bounded and time gates retain exact future/stale boundaries',async()=>{
 for(const [value,reason] of [[new Date(now+1).toISOString(),'TIME_FUTURE'],[new Date(now-300001).toISOString(),'TIME_STALE'],['not-a-time','TIME_INVALID']]){
  const s=stub(v=>({...v,evaluated_at:value}));
  await assert.rejects(readBootstrapReadiness(s.rpc,{},()=>now),e=>e instanceof BootstrapReadinessDenied&&e.reason===reason);
  assert.deepEqual(s.calls.map(v=>v.name),[BOOTSTRAP_READINESS_RPC]);
 }
 for(const offset of [0,-300000]){
  const s=stub(v=>({...v,evaluated_at:new Date(now+offset).toISOString()}));
  assert.equal((await readBootstrapReadiness(s.rpc,{},()=>now)).bootstrap_write_authorized,false);
 }
 assert.equal(new BootstrapReadinessDenied('private detail').reason,'UNSPECIFIED');
});
test('one failed dispatch is completion unknown and never retried',async()=>{
 const s=stub(v=>v,()=>{throw Error('lost response');});await assert.rejects(commitBootstrap(s.rpc,input(),()=>now),BootstrapCompletionUnknown);assert.equal(s.calls.length,1);
});
test('post-dispatch private fields, wrong target, repeated Receipt or Gate claims cannot be completion',async()=>{
 for(const mutate of [v=>({...v,actor:'private'}),v=>({...v,producer_record_ref:{...v.producer_record_ref,id:crypto.randomUUID()}}),v=>({...v,canonical_receipt_ids:[v.canonical_receipt_ids[0],v.canonical_receipt_ids[0],v.canonical_receipt_ids[2]]}),v=>({...v,m2_verdict:'PASS'})]){
  const s=stub(v=>v,mutate);await assert.rejects(commitBootstrap(s.rpc,input(),()=>now),BootstrapCompletionUnknown);assert.equal(s.calls.length,1);
 }
});
test('descriptors, inherited fields and duplicate targets are rejected without hidden getters',async()=>{
 let read=0;const a=input();Object.defineProperty(a,'actor',{enumerable:false,get(){read++;return'private';}});
 const s=stub();await assert.rejects(commitBootstrap(s.rpc,a,()=>now),BootstrapInputDenied);assert.equal(read,0);assert.equal(s.calls.length,0);
 await assert.rejects(commitBootstrap(s.rpc,{...input(),permission_record_id:plan.targets.producer_record_id},()=>now),BootstrapInputDenied);
});

test('owned transport definite database rollback is denied once without neutral reads or retry',async()=>{
 const s=stub(v=>v,()=>{throw new BootstrapExecutionDenied();});
 await assert.rejects(commitBootstrap(s.rpc,input(),()=>now),BootstrapExecutionDenied);
 assert.deepEqual(s.calls.map(v=>v.name),[BOOTSTRAP_COMMIT_RPC]);
});
test('bare HTTP/SQLSTATE objects and generic transport errors remain completion unknown',async()=>{
 for(const error of [{status:403,details:{code:'42501'}},{status:400,code:'22023'},new Error('network/5xx')]){
  const s=stub(v=>v,()=>{throw error;});
  await assert.rejects(commitBootstrap(s.rpc,input(),()=>now),BootstrapCompletionUnknown);
  assert.equal(s.calls.length,1);
 }
});

async function observeTimeDiagnostic(run,{samples=[now-2,now-1],samplingThrows=false,loggingThrows=false}={}){
 const originalNow=Date.now,originalWarn=console.warn;
 const logs=[];let sampleCalls=0;
 Date.now=()=>{sampleCalls++;if(samplingThrows)throw Error('private sampling failure');return samples[sampleCalls-1];};
 console.warn=(...args)=>{logs.push(args);if(loggingThrows)throw Error('private logging failure');};
 try{return await run({logs,sampleCalls:()=>sampleCalls});}finally{Date.now=originalNow;console.warn=originalWarn;}
}

test('diagnostic fixture: six-digit future timestamp keeps exact denial, one RPC and one validation clock',async()=>{
 await observeTimeDiagnostic(async({logs,sampleCalls})=>{
  const value='2026-10-08T11:00:00.001234Z',s=stub(v=>({...v,evaluated_at:value}));
  let validationCalls=0;
  await assert.rejects(readBootstrapReadiness(s.rpc,{},()=>{validationCalls++;return now;}),e=>
   e instanceof BootstrapReadinessDenied&&e.reason==='TIME_FUTURE'&&e.message==='BOOTSTRAP_FIXED_SOURCE_READINESS_DENIED_OR_UNAVAILABLE');
  assert.equal(validationCalls,1);assert.equal(s.calls.length,1);assert.equal(sampleCalls(),2);
  assert.equal(logs.length,1);assert.equal(logs[0].length,1);
  const log=JSON.parse(logs[0][0]);
  assert.deepEqual(Object.keys(log).sort(),['event','schema_version','rpc_started_ms','rpc_resolved_ms','validation_ms','evaluated_at','parsed_ms','delta_ms','reason'].sort());
  assert.equal(log.event,'model_bootstrap_readiness_time_diagnostic');assert.equal(log.schema_version,1);
  assert.equal(log.rpc_started_ms,now-2);assert.equal(log.rpc_resolved_ms,now-1);
  assert.equal(log.validation_ms,now);assert.equal(log.evaluated_at,value);
  assert.equal(log.parsed_ms,Date.parse(value));assert.equal(log.delta_ms,1);assert.equal(log.reason,'TIME_FUTURE');
 });
});

test('diagnostic fixture: stale denial remains strict and passive samples never admit a future value',async()=>{
 await observeTimeDiagnostic(async({logs})=>{
  for(const [offset,reason] of [[1,'TIME_FUTURE'],[-300001,'TIME_STALE']]){
   const s=stub(v=>({...v,evaluated_at:new Date(now+offset).toISOString()}));
   await assert.rejects(readBootstrapReadiness(s.rpc,{},()=>now),e=>e instanceof BootstrapReadinessDenied&&e.reason===reason);
   assert.equal(s.calls.length,1);
  }
  assert.deepEqual(logs.map(([line])=>JSON.parse(line).reason),['TIME_FUTURE','TIME_STALE']);
 },{samples:[now+600000,now+600000,now+600000,now+600000]});
});

test('diagnostic fixture: accepted zero/five-minute and six-digit values return the unchanged public DTO silently',async()=>{
 await observeTimeDiagnostic(async({logs})=>{
  for(const value of [new Date(now).toISOString(),new Date(now-300000).toISOString(),'2026-10-08T11:00:00.000001Z']){
   const r={...readiness(),evaluated_at:value},s=stub(()=>r);let validationCalls=0;
   const result=await readBootstrapReadiness(s.rpc,{},()=>{validationCalls++;return now;});
   assert.deepEqual(result,r);assert.notEqual(result,r);assert.equal(validationCalls,1);assert.equal(s.calls.length,1);
  }
  assert.equal(logs.length,0);
 });
});

test('diagnostic fixture: invalid time/schema/source/RPC and caller data produce no temporal log',async()=>{
 await observeTimeDiagnostic(async({logs})=>{
  for(const mutate of [v=>({...v,evaluated_at:'private invalid time'}),v=>({...v,actor:'private actor'}),v=>({...v,plan_sha256:'f'.repeat(64)}),v=>({...v,bootstrap_write_authorized:true})]){
   await assert.rejects(readBootstrapReadiness(stub(mutate).rpc,{},()=>now),BootstrapReadinessDenied);
  }
  await assert.rejects(readBootstrapReadiness(async()=>{throw Error('private token detail');},{},()=>now),e=>e.reason==='RPC');
  await assert.rejects(readBootstrapReadiness(stub().rpc,{token:'private token'},()=>now),e=>e.reason==='INPUT');
  await assert.rejects(readBootstrapReadiness(stub().rpc,{},()=>NaN),e=>e.reason==='TIME_INVALID');
  assert.equal(logs.length,0);
 });
});

test('diagnostic fixture: failed passive sampling reports null without changing the original future denial',async()=>{
 await observeTimeDiagnostic(async({logs})=>{
  const s=stub(v=>({...v,evaluated_at:new Date(now+1).toISOString()}));
  await assert.rejects(readBootstrapReadiness(s.rpc,{},()=>now),e=>e instanceof BootstrapReadinessDenied&&e.reason==='TIME_FUTURE');
  const log=JSON.parse(logs[0][0]);assert.equal(log.rpc_started_ms,null);assert.equal(log.rpc_resolved_ms,null);
  assert.equal(log.delta_ms,1);assert.equal(s.calls.length,1);
 },{samplingThrows:true});
});

test('diagnostic fixture: logger failure preserves the original bounded denial and never retries',async()=>{
 await observeTimeDiagnostic(async()=>{
  const s=stub(v=>({...v,evaluated_at:new Date(now+1).toISOString()}));let validationCalls=0;
  await assert.rejects(readBootstrapReadiness(s.rpc,{},()=>{validationCalls++;return now;}),e=>
   e instanceof BootstrapReadinessDenied&&e.reason==='TIME_FUTURE'&&e.message==='BOOTSTRAP_FIXED_SOURCE_READINESS_DENIED_OR_UNAVAILABLE');
  assert.equal(validationCalls,1);assert.deepEqual(s.calls.map(v=>v.name),[BOOTSTRAP_READINESS_RPC]);
 },{loggingThrows:true});
});

test('diagnostic fixture: commit result time denial stays completion unknown with no telemetry or retry',async()=>{
 await observeTimeDiagnostic(async({logs,sampleCalls})=>{
  const s=stub(v=>v,v=>({...v,evaluated_at:new Date(now+1).toISOString()}));
  await assert.rejects(commitBootstrap(s.rpc,input(),()=>now),BootstrapCompletionUnknown);
  assert.deepEqual(s.calls.map(v=>v.name),[BOOTSTRAP_COMMIT_RPC]);
  assert.equal(logs.length,0);assert.equal(sampleCalls(),0);
 });
});
