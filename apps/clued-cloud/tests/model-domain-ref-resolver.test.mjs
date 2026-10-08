import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {POLICY} from '../worker/model-domain-readonly.mjs';
import {RESOLVE_RPC,resolveWithExistingBindingRpc} from '../worker/model-domain-ref-resolver.mjs';
import {prepareNativeGrantBundle} from '../worker/model-domain-native-read-request.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const at='2026-10-07T12:00:00Z',now=Date.parse(at);
const input=()=>({permission_record_id:id(1),producer_registration_id:id(2),recognition_record_id:id(3)});
function projection(){return {permission_record_ref:{id:id(1),version:1,content_hash:'a'.repeat(64)},producer_registration_ref:{id:id(2),version:2,content_hash:'b'.repeat(64)},recognition_record_ref:{id:id(3),version:3,content_hash:'c'.repeat(64)},status:'RESOLVED_EXISTING_PROJECTION_REFERENCES_READ_ONLY',source_scope:POLICY.scope,evaluated_at:at,projection_only:true,authority_effect:'NONE',actual_execution:'NONE',m2_qualification:'NOT_ISSUED'};}
test('resolver invokes only fixed projection RPC and returns non-authorizing refs',async()=>{
  const calls=[];const out=await resolveWithExistingBindingRpc(async(name,selectors)=>{calls.push(name);assert.deepEqual(selectors,input());return projection();},input(),()=>now);
  assert.deepEqual(calls,[RESOLVE_RPC]);assert.equal(out.projection_only,true);assert.equal(out.authority_effect,'NONE');
});
test('caller principal/hash/authority or non-fixed selectors deny before RPC',async()=>{
  for(const extra of [{principal:{subject_id:id(9)}},{permission_record_ref:{content_hash:'f'.repeat(64)}},{authority:'NativeOwner'},{record_id:id(1)}]){
    let calls=0;await assert.rejects(resolveWithExistingBindingRpc(async()=>{calls++;return projection();},{...input(),...extra},()=>now));assert.equal(calls,0);
  }
});
test('actor-bearing/raw-record/authorizing projection responses deny',async()=>{
  for(const extra of [{actor_user_id:id(9)},{type_fields:{}},{domain_permission:true},{m2_qualification:'PASS'}]){
    await assert.rejects(resolveWithExistingBindingRpc(async()=>({...projection(),...extra}),input(),()=>now));
  }
});
test('foreign ids/hash shape/scope/stale projection deny',async()=>{
  for(const mutate of [r=>r.permission_record_ref.id=id(9),r=>r.producer_registration_ref.content_hash='local-text-hash',r=>r.source_scope='global',r=>r.evaluated_at='2026-10-07T11:54:59Z']){
    const result=projection();mutate(result);await assert.rejects(resolveWithExistingBindingRpc(async()=>result,input(),()=>now));
  }
});
test('unavailable fixed source is denial, never a source ref guess',async()=>{
  await assert.rejects(resolveWithExistingBindingRpc(async()=>{throw Error('private failure');},input(),()=>now),/REF_PROJECTION_DENIED_OR_INVALID/);
});
test('Native bundle uses existing registered record kind and exact hashes, no max-use suggestion',async()=>{
  const bundle=await prepareNativeGrantBundle(async()=>projection(),input(),'m2-native-test-key',()=>now);
  assert.equal(bundle.task_id,POLICY.task);assert.equal(bundle.scope,POLICY.scope);assert.equal(bundle.actions.length,3);
  assert.deepEqual(bundle.suggested_grant,{expires_seconds:3600});
  assert.deepEqual(bundle.actions.map(row=>row.resources),[[`record:${id(1)}@1#${'a'.repeat(64)}`],[`record:${id(1)}@1#${'a'.repeat(64)}`],[`record:${id(2)}@2#${'b'.repeat(64)}`]]);
  assert(!JSON.stringify(bundle).includes('scope:project:'));assert(!JSON.stringify(bundle).includes('model-subject:'));
});
test('resolver SQL is separate, fixed-scope read and does not bypass verify grant order',()=>{
  const sql=readFileSync(new URL('../../../development/contracts/model-program/stage-admission/repo-integration-candidate/readonly/ref-resolver.candidate.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'');
  assert(sql.includes("resolve_binding(p_token_hash,'context:read',s)"));assert(sql.includes('record_currentness_fence'));
  assert(sql.includes('for pass in 1..2'));assert(sql.includes('M2_REF_PROJECTION_CHANGED_DURING_READ'));
  assert(!/insert\s+into|update\s+|delete\s+from|grant\s+execute/i.test(sql));
  assert(!sql.includes('owner_grants_v1'));assert(!sql.includes('model_domain_source_candidate'));
  const verify=readFileSync(new URL('../../../development/contracts/model-program/stage-admission/repo-integration-candidate/readonly/domain-reader.candidate.sql',import.meta.url),'utf8');
  assert(verify.indexOf('INDEPENDENT_NATIVE_GRANT_MISSING')<verify.indexOf('from public.clued_memories'));
});
