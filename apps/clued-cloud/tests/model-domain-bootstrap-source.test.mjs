import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import test from 'node:test';
import {readBootstrapReadiness,commitBootstrap,EXACT_BOOTSTRAP_PLAN,BOOTSTRAP_READINESS_RPC,BOOTSTRAP_COMMIT_RPC,BootstrapInputDenied,BootstrapCompletionUnknown,BootstrapReadinessDenied} from '../worker/model-domain-bootstrap-source.mjs';
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
 assert.deepEqual(s.calls.map(x=>x.name),[BOOTSTRAP_READINESS_RPC,BOOTSTRAP_COMMIT_RPC]);assert.deepEqual(s.calls[1].body,input());
});
test('readiness never invokes a writer or grants bootstrap authority',async()=>{
 const s=stub();const r=await readBootstrapReadiness(s.rpc,{},()=>now);assert.equal(r.bootstrap_write_authorized,false);assert.equal(s.calls.length,1);
});
test('input rejects caller Actor/proof/scope/clock before any RPC',async()=>{
 for(const key of ['actor','verified','scope','clock','grant','session_token']){const s=stub();await assert.rejects(commitBootstrap(s.rpc,{...input(),[key]:'forged'},()=>now),BootstrapInputDenied);assert.equal(s.calls.length,0);}
});
test('readiness denies changed bytes, elevated result, stale source and private payload with no write',async()=>{
 for(const mutate of [v=>({...v,plan_sha256:'f'.repeat(64)}),v=>({...v,bootstrap_write_authorized:true}),v=>({...v,evaluated_at:'2026-10-08T10:00:00Z'}),v=>({...v,actor:'private'})]){
  const s=stub(mutate);await assert.rejects(commitBootstrap(s.rpc,input(),()=>now),BootstrapReadinessDenied);assert.equal(s.calls.length,1);
 }
});
test('one failed dispatch is completion unknown and never retried',async()=>{
 const s=stub(v=>v,()=>{throw Error('lost response');});await assert.rejects(commitBootstrap(s.rpc,input(),()=>now),BootstrapCompletionUnknown);assert.equal(s.calls.length,2);
});
test('post-dispatch private fields, wrong target, repeated Receipt or Gate claims cannot be completion',async()=>{
 for(const mutate of [v=>({...v,actor:'private'}),v=>({...v,producer_record_ref:{...v.producer_record_ref,id:crypto.randomUUID()}}),v=>({...v,canonical_receipt_ids:[v.canonical_receipt_ids[0],v.canonical_receipt_ids[0],v.canonical_receipt_ids[2]]}),v=>({...v,m2_verdict:'PASS'})]){
  const s=stub(v=>v,mutate);await assert.rejects(commitBootstrap(s.rpc,input(),()=>now),BootstrapCompletionUnknown);assert.equal(s.calls.length,2);
 }
});
test('descriptors, inherited fields and duplicate targets are rejected without hidden getters',async()=>{
 let read=0;const a=input();Object.defineProperty(a,'actor',{enumerable:false,get(){read++;return'private';}});
 const s=stub();await assert.rejects(commitBootstrap(s.rpc,a,()=>now),BootstrapInputDenied);assert.equal(read,0);assert.equal(s.calls.length,0);
 await assert.rejects(commitBootstrap(s.rpc,{...input(),permission_record_id:plan.targets.producer_record_id},()=>now),BootstrapInputDenied);
});
