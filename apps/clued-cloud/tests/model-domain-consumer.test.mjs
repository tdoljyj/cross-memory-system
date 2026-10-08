import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {DOMAIN_POLICY as P} from '../worker/model-domain-policy.mjs';
import {POLICY} from '../worker/model-domain-readonly.mjs';
import {createFullDomainConsumer,prepareBootstrapCandidate} from '../worker/model-domain-consumer.mjs';
import {prepareM1CreatePlan} from '../worker/model-domain-m1-bootstrap-plan.mjs';
import {prepareNativeBootstrapRequest} from '../worker/model-domain-native-bootstrap-request.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;const at='2026-10-07T12:00:00Z',now=Date.parse(at);
const reference=(n,h)=>({id:id(n),version:1,content_hash:h.repeat(64)});const resource=r=>`record:${r.id}@${r.version}#${r.content_hash}`;
const planResource='repo:tdoljyj/cross-memory-system/'+'1'.repeat(40)+'/development/contracts/model-program/stage-admission/BootstrapExactTest.json';
function fixture(){
  const principal={subject_id:id(90),binding_id:id(91)},permission=reference(1,'a'),producer=reference(2,'b'),recognition=reference(3,'c');
  const request={schema_version:'clued.model-dataset-split-domain-recognition-request-candidate/1',contract_sha256:P.contract_sha256,subject:P.domain.subject,recognition_record_ref:recognition,recognition_receipt_id:id(4)};
  const auth={status:'AUTHENTICATED',currentness:'CURRENT',revoked_at:null,canonical_scope:POLICY.scope,environment:'NON_PRODUCTION',service:POLICY.service,action:'DatasetSplit.definition.verify',principal,owner_subject_id:principal.subject_id,expires_at:'2026-10-07T12:45:00Z',evaluated_at:at};
  const grant=(action,n,resources,max_uses=null)=>({storage_source:'clued_private.owner_grants_v1',id:id(10+n),token_id:id(20+n),receipt_id:id(30+n),native_confirmation_receipt_verified:true,action,user_id:principal.subject_id,grantee_binding_id:principal.binding_id,task_id:POLICY.task,revoked_at:null,granted_at:'2026-10-07T11:55:00Z',expires_at:'2026-10-07T12:30:00Z',uses:0,max_uses,resources});
  const state={auth,issuer_catalog:POLICY.actions.map(action=>({action,doors:['model-domain']})),native_grants:POLICY.actions.map((action,n)=>grant(action,n,[resource(action.endsWith('.producer')?producer:permission)]))};
  const row=(ref,type,authority,type_fields)=>({...ref,record_type:type,authority,type_fields,canonical_scope:POLICY.scope,record_currentness:'CURRENT',lifecycle_status:'active',evaluated_at:at,canonical_hash_algorithm:'clued_private.m1_record_content_hash',recomputed_server_content_hash:ref.content_hash});
  const owner=P.domain.owner_adoption,designation=P.server.owner_final_recognizer;
  const foundation={adoption:row({id:owner.canonical_record_id,version:1,content_hash:owner.record_content_sha256},'decision','user_explicit',{}),recognizer:row(designation.record_ref,'decision','user_explicit',{model_final_recognizer:designation.expected_fields}),permission:row(permission,'decision','user_explicit',{domain_permission:{status:'active',revoked_at:null,not_before:'2026-10-07T11:55:00Z',expires_at:'2026-10-07T12:30:00Z',action:'DatasetSplit.definition.recognize',effect:P.domain.effect,environment:'NON_PRODUCTION',canonical_scope:POLICY.scope,subject:P.domain.subject,principal,producer_registration_ref:producer}}),producer:row(producer,'state','user_explicit',{domain_producer:{service:POLICY.service,role:'EXISTING_MODEL_DOMAIN_AUTHORITY_DELEGATE',domain_owner:'MODEL PROGRAM',environment:'NON_PRODUCTION',principal,authority_registry_sha256:P.domain.authority_registry_sha256}})};
  foundation.adoption.body_utf8_sha256=owner.record_content_sha256;foundation.adoption.receipt_id=owner.canonical_receipt_id;
  foundation.recognizer.body_utf8_sha256=designation.record_ref.content_hash;foundation.recognizer.receipt_id=designation.receipt_id;
  const expected={contract_id:P.domain.contract_id,contract_version:P.domain.version,contract_sha256:P.contract_sha256,subject:P.domain.subject,owner_adoption:P.domain.owner_adoption,permission_record_ref:permission,producer_registration_ref:producer,producer:{service:POLICY.service,...principal},effect:P.domain.effect};
  const recognized=row(recognition,'state','observed',{state_kind:'model_dataset_split_domain_recognition',domain_recognition:expected});recognized.receipt_id=request.recognition_receipt_id;
  const targets=[{id:recognition.id,kind:'record',role:'primary'}];
  const receipt={id:request.recognition_receipt_id,status:'committed',operation_family:'record_mutation',user_id:principal.subject_id,binding_id:principal.binding_id,target_refs:targets,committed_versions:{[recognition.id]:1},canonical_version:123,event_ids:['88'],evaluated_at:at};
  const event={id:'88',canonical_event_type:'record_created',result:'success',receipt_id:receipt.id,event_scope:POLICY.scope,target_refs:targets,committed_canonical_version:123,actor_user_id:principal.subject_id,actor_binding_id:principal.binding_id,evaluated_at:at};
  const f={state,foundation,recognition:{recognition:recognized,receipt,event},request,principal,grant,reads:0,foundationReads:0,recognitionReads:0,writes:0};
  f.source={pinned_artifacts:{contract_sha256:P.contract_sha256,definition_sha256:P.domain.subject.definition_sha256,instance_schema_sha256:P.domain.subject.instance_schema_sha256,authority_registry_sha256:P.domain.authority_registry_sha256},readProtectedAuthority:async()=>structuredClone(f.state),readFoundationBundle:async()=>{f.reads++;f.foundationReads++;if(f.change&&f.foundationReads>1)f.change(f);return structuredClone(f.foundation);},readRecognitionBundle:async()=>{f.reads++;f.recognitionReads++;return structuredClone(f.recognition);},readOwnerAnchorBundle:async()=>{f.reads++;return structuredClone({adoption:f.foundation.adoption,recognizer:f.foundation.recognizer});}};
  return f;
}
const denied=async f=>assert.rejects(createFullDomainConsumer(f.source,()=>now).verify(f.request));
function bootstrap(f){
  const input={owner_adoption_server_ref:{id:f.foundation.adoption.id,version:1,content_hash:f.foundation.adoption.content_hash},final_recognizer_server_ref:{id:f.foundation.recognizer.id,version:1,content_hash:f.foundation.recognizer.content_hash},producer_record_id:id(60),permission_record_id:id(61),recognition_record_id:id(62),idempotency_key:'bootstrap-fixed-test',immutable_plan_resource:planResource};
  const resources=[resource(input.owner_adoption_server_ref),resource(input.final_recognizer_server_ref),'record:'+id(60),'record:'+id(61),'record:'+id(62),planResource];
  f.state.auth.action=P.bootstrap_action;f.state.issuer_catalog=[{action:P.bootstrap_action,doors:[P.bootstrap_door]}];f.state.native_grants=[f.grant(P.bootstrap_action,5,resources,1)];return input;
}
test('full legacy nine-field recognition and Owner guards accept only definition read',async()=>{
  const f=fixture(),result=await createFullDomainConsumer(f.source,()=>now).verify(f.request);assert.equal(result.m2_verdict,'NOT_ISSUED');assert.equal(result.domain_authority_receipt,'NOT_KERNEL_RECEIPT');assert.equal(f.reads,4);assert(!JSON.stringify(result).includes(f.principal.subject_id));assert(!JSON.stringify(result).includes(f.principal.binding_id));
});
test('missing Native grant and caller authorization stop before any target read',async()=>{
  const f=fixture();f.state.native_grants=[];await denied(f);assert.equal(f.reads,0);const g=fixture();g.request.verified=true;await denied(g);assert.equal(g.reads,0);
});
test('adoption and designation exact server hash/receipt/currentness all retain independent guards',async()=>{
  for(const change of [f=>f.foundation.adoption.content_hash='f'.repeat(64),f=>f.foundation.adoption.receipt_id=id(9),f=>f.foundation.recognizer.record_currentness='UNKNOWN',f=>f.foundation.recognizer.type_fields.model_final_recognizer={...P.server.owner_final_recognizer.expected_fields,domain_permission_granted:true},f=>f.foundation.recognizer.recomputed_server_content_hash='f'.repeat(64)]){const f=fixture();change(f);await denied(f);}
});
test('unresolved legacy hash mismatch is denied even with matching body digest and genuine new server hash',async()=>{
  const f=fixture();f.foundation.adoption.content_hash='d'.repeat(64);f.foundation.adoption.recomputed_server_content_hash='d'.repeat(64);f.foundation.adoption.body_utf8_sha256=P.domain.owner_adoption.record_content_sha256;await denied(f);
});
test('complete contract/version/adoption fields cannot be omitted or substituted by minimal DTO',async()=>{
  for(const field of ['contract_id','contract_version','owner_adoption']){const f=fixture();delete f.recognition.recognition.type_fields.domain_recognition[field];await denied(f);}
});
test('subject/schema/registry/principal and exact permission shape reject drift',async()=>{
  for(const change of [f=>f.foundation.permission.type_fields.domain_permission.subject={...P.domain.subject,instance_schema_sha256:'f'.repeat(64)},f=>f.foundation.producer.type_fields.domain_producer.authority_registry_sha256='f'.repeat(64),f=>f.foundation.permission.type_fields.domain_permission.principal={...f.principal,binding_id:id(99)},f=>f.foundation.permission.type_fields.domain_permission.extra=true]){const f=fixture();change(f);await denied(f);}
});
test('real M1 committed receipt/event actor/target/version chain rejects any mismatch',async()=>{
  for(const change of [f=>f.recognition.receipt.status='rejected',f=>f.recognition.receipt.binding_id=id(99),f=>f.recognition.event.actor_user_id=id(99),f=>f.recognition.event.canonical_event_type=null,f=>f.recognition.event.committed_canonical_version=124]){const f=fixture();change(f);await denied(f);}
});
test('full final snapshot and final Native authority recheck detect drift',async()=>{
  for(const change of [f=>f.foundation.adoption.version=2,f=>f.state.native_grants[0].revoked_at=at,f=>f.recognition.event.result='failure']){const f=fixture();f.change=change;await denied(f);}
});
test('first-write bootstrap needs no existing producer/permission/recognition or future hash',async()=>{
  const f=fixture(),input=bootstrap(f);delete f.foundation.permission;delete f.foundation.producer;delete f.recognition;
  const result=await prepareBootstrapCandidate(f.source,input,()=>now);assert.equal(result.status,'BOOTSTRAP_PREFLIGHT_COMPLETE_WRITE_NOT_READY');assert.equal(result.mutation_permitted,false);assert.equal(f.reads,2);assert.equal(f.writes,0);
});
test('historical read grants never authorize bootstrap; denial precedes source reads',async()=>{
  const f=fixture(),input={owner_adoption_server_ref:{id:f.foundation.adoption.id,version:1,content_hash:f.foundation.adoption.content_hash},final_recognizer_server_ref:{id:f.foundation.recognizer.id,version:1,content_hash:f.foundation.recognizer.content_hash},producer_record_id:id(60),permission_record_id:id(61),recognition_record_id:id(62),idempotency_key:'bootstrap-fixed-test',immutable_plan_resource:planResource};
  await assert.rejects(prepareBootstrapCandidate(f.source,input,()=>now));assert.equal(f.reads,0);
});
test('bootstrap cannot widen binding/task/targets, reuse consumed grant, or accept caller confirmed',async()=>{
  for(const change of [f=>f.state.native_grants[0].grantee_binding_id=id(99),f=>f.state.native_grants[0].uses=1,f=>f.state.native_grants[0].task_id=id(99),f=>f.state.native_grants[0].resources=['record:*']]){const f=fixture(),input=bootstrap(f);change(f);await assert.rejects(prepareBootstrapCandidate(f.source,input,()=>now));assert.equal(f.reads,0);}
  const f=fixture(),input=bootstrap(f);input.user_confirmed=true;await assert.rejects(prepareBootstrapCandidate(f.source,input,()=>now));assert.equal(f.reads,0);
});
test('M1 create plan retains three exact targets, source refs are not Receipt IDs, and never sets caller confirmed',async()=>{
  const f=fixture(),input=bootstrap(f),plan=await prepareM1CreatePlan(f.source,input,()=>now);assert.equal(plan.mutation_permitted,false);assert.equal(plan.atomic_order.length,3);for(const mutation of plan.atomic_order){assert.equal(mutation.operation,'create');assert.equal(mutation.scope,POLICY.scope);assert.deepEqual(mutation.source_refs,[]);assert(!('user_confirmed'in mutation));assert(mutation.idempotency_key.length<=160);}
});
test('generic Record DTO/string serialization cannot leak Actor subject/binding/token from persistent templates',async()=>{
  const f=fixture(),input=bootstrap(f),plan=await prepareM1CreatePlan(f.source,input,()=>now);
  // Simulate the current generic projection: recursive reserved field removal,
  // then stringify content/typed fields. No special source endpoint involved.
  function generic(v){if(Array.isArray(v))return v.map(generic);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>!['user_id','actor_user_id','binding_id','actor_binding_id'].includes(k)).map(([k,x])=>[k,generic(x)]));return v;}
  const text=JSON.stringify(generic(plan.atomic_order.map(m=>({id:m.id,content:m.mutation.content,type_fields:m.mutation.type_fields}))));
  assert(!text.includes(f.principal.subject_id));assert(!text.includes(f.principal.binding_id));assert(!text.includes('subject_id'));assert(!text.includes('token_id'));assert(!text.includes('confirmation_token'));
});
test('SQL write interface fails closed without calling M1 or granting runtime execution',()=>{
  const sql=readFileSync(new URL('../../../development/contracts/model-program/stage-admission/repo-integration-candidate/unvalidated-full-domain/m1-producer-interface.candidate.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'');assert(sql.includes('MODEL_DOMAIN_BOOTSTRAP_NOT_READY'));assert(!sql.includes('public.clued_record_mutate('));assert(!/grant\s+execute|insert\s+into|update\s+|delete\s+from/i.test(sql));
});
test('exact read action cannot be missing or replaced by generic context permission',async()=>{
  for(const value of [undefined,'context:read',P.bootstrap_action]){const f=fixture();f.state.auth.action=value;await denied(f);assert.equal(f.reads,0);}
});
test('bootstrap final expiry, clock regression and Owner currentness drift deny',async()=>{
  const f=fixture(),input=bootstrap(f);let count=0;await assert.rejects(prepareBootstrapCandidate(f.source,input,()=>count++===2?Date.parse(f.state.native_grants[0].expires_at):now));
  const g=fixture(),ginput=bootstrap(g);let c=0;await assert.rejects(prepareBootstrapCandidate(g.source,ginput,()=>c++?now-1:now));
  const h=fixture(),hinput=bootstrap(h);let reads=0;h.source.readOwnerAnchorBundle=async()=>{if(++reads>1)h.foundation.adoption.record_currentness='UNKNOWN';return structuredClone({adoption:h.foundation.adoption,recognizer:h.foundation.recognizer});};await assert.rejects(prepareBootstrapCandidate(h.source,hinput,()=>now));
});
test('private normalization reuses real canonical hash and transaction Actor, never public storage writes',()=>{
  const sql=readFileSync(new URL('../../../development/contracts/model-program/stage-admission/repo-integration-candidate/unvalidated-full-domain/private-normalization.candidate.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'');
  assert(sql.includes('clued_private.m1_record_content_hash('));assert(sql.includes("convert_to(p_record.content,'UTF8')"));
  assert(sql.includes('r.binding_id is distinct from p_binding.id'));assert(sql.includes('e.actor_binding_ref is distinct from p_binding.id::text'));
  assert(sql.includes("coalesce(e.canonical_event_type,'') not in"));assert(sql.includes('PRIVATE_IDENTITY_MUST_NOT_BE_PERSISTED'));
  assert(!/insert\s+into|update\s+|delete\s+from|grant\s+execute/i.test(sql));
});
test('Native write request bootstraps from only existing Owner refs, no future projection hash or read grant',async()=>{
  const f=fixture(),input={producer_record_id:id(60),permission_record_id:id(61),recognition_record_id:id(62),idempotency_key:'native-bootstrap-request',immutable_plan_resource:planResource};let calls=0;
  const result=await prepareNativeBootstrapRequest(async(name,request)=>{calls++;assert.equal(name,'clued_model_dataset_split_owner_anchor_refs_candidate');assert.deepEqual(request,{schema:'clued.model-owner-anchor-refs/1'});return {owner_adoption_server_ref:{id:f.foundation.adoption.id,version:1,content_hash:f.foundation.adoption.content_hash},final_recognizer_server_ref:{id:f.foundation.recognizer.id,version:1,content_hash:f.foundation.recognizer.content_hash},status:'OWNER_ANCHOR_PROJECTION_REFS_ONLY',projection_only:true,source_scope:POLICY.scope,authority_effect:'NONE',domain_permission:'NOT_GRANTED',m2_verdict:'NOT_ISSUED'};},input);
  assert.equal(calls,1);assert.equal(result.request.action,P.bootstrap_action);assert.equal(result.request.resources.length,6);assert.deepEqual(result.request.suggested_grant,{expires_seconds:3600,max_uses:1});assert.equal(result.status,'NATIVE_WRITE_REQUEST_PAYLOAD_CANDIDATE_NOT_SUBMITTED');assert(!('status'in result.request));
});
test('Native request builder rejects caller proof and private identity leak before any approval',async()=>{
  let calls=0;await assert.rejects(prepareNativeBootstrapRequest(async()=>{calls++;},{producer_record_id:id(60),permission_record_id:id(61),recognition_record_id:id(62),idempotency_key:'native-bootstrap-request',user_confirmed:true}));assert.equal(calls,0);
  const input={producer_record_id:id(60),permission_record_id:id(61),recognition_record_id:id(62),idempotency_key:'native-bootstrap-request',immutable_plan_resource:planResource};await assert.rejects(prepareNativeBootstrapRequest(async()=>({actor_user_id:id(90)}),input));
});
test('atomic SQL writer derives real Native confirmation before target reads and three public M1 writes',()=>{
  const sql=readFileSync(new URL('../../../development/contracts/model-program/stage-admission/repo-integration-candidate/unvalidated-full-domain/native-m1-atomic-writer.candidate.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'');
  assert(sql.includes('clued_private.native_confirmation_tokens'));assert(sql.includes("t.consume_outcome='committed'"));
  assert(sql.includes("nr.metadata->>'principal'='native_account_session'"));assert(sql.includes('approved_native is distinct from true'));
  assert(sql.indexOf('approved_native is distinct from true')<sql.indexOf('select * into own from public.clued_memories'));
  assert(sql.includes('for n in 1..3 loop'));assert(sql.includes('result:=public.clued_record_mutate(p_token_hash,input)'));
  assert(!/insert\s+into\s+public\.clued_memories|m1_finish_receipt\(/i.test(sql));
  assert(sql.includes("'user_confirmed',case when n=3 then false else approved_native end"));
  assert(sql.includes("'actual_execution','CANONICAL_RECORD_MUTATION'"));assert(!/exception\s+when\s+others/i.test(sql));
  assert(sql.includes('own.content_hash is distinct from adoption'));assert(!sql.includes('body_utf8_sha256'));
});
test('atomic writer requires trusted actual plan bytes/resource/hash and exact create input before any target or M1 use',()=>{
  const sql=readFileSync(new URL('../../../development/contracts/model-program/stage-admission/repo-integration-candidate/unvalidated-full-domain/native-m1-atomic-writer.candidate.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'');
  assert(sql.includes('MODEL_DOMAIN_EXACT_PLAN_NOT_INSTALLED'));assert(sql.includes("convert_to(installed_plan->>'raw_utf8','UTF8')"));
  assert(sql.includes("installed_plan->>'source_resource' is distinct from p_input->>'immutable_plan_resource'"));
  assert(sql.includes("plan->'mutation_roles' is distinct from expected_role_policy"));assert(sql.includes("plan->'max_window_seconds' is distinct from '3600'::jsonb"));
  assert(sql.indexOf('MODEL_DOMAIN_EXACT_PLAN_INPUT_ROLE_WINDOW_MISMATCH')<sql.indexOf('select * into own from public.clued_memories'));
  const binding=readFileSync(new URL('../../../development/contracts/model-program/stage-admission/repo-integration-candidate/unvalidated-full-domain/exact-plan-binding.candidate.sql',import.meta.url),'utf8');assert(binding.includes('"raw_utf8":null'));assert(!/grant\s+execute/i.test(binding.replace(/--[^\n]*/g,'')));
});
