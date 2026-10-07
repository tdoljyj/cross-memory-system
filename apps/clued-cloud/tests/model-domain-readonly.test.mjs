import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { POLICY, createM2ServerReadonlyReader, DomainReadDenied, parseSourceUTC } from '../worker/model-domain-readonly.mjs';
import { verifyWithExistingBindingRpc } from '../worker/model-domain-rpc-source.mjs';
// Fictional private database fixtures only. They are never actual grants.
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const at = '2026-10-07T09:20:00Z', now = Date.parse(at);
function fixture() {
  const principal = { subject_id:id(1), binding_id:id(2) };
  const ref = (n,h) => ({id:id(n),version:1,content_hash:h.repeat(64)});
  const input = { permission_record_ref:ref(3,'a'), producer_registration_ref:ref(4,'b'), recognition_record_ref:ref(5,'c'), recognition_receipt_id:id(6) };
  const resource = r => `record:${r.id}@${r.version}#${r.content_hash}`;
  const auth = {status:'AUTHENTICATED',principal,canonical_scope:POLICY.scope,environment:'NON_PRODUCTION',currentness:'CURRENT',revoked_at:null,expires_at:'2026-10-07T10:00:00Z',evaluated_at:at};
  const ctx = {auth,issuer_catalog:POLICY.actions.map(action=>({action,doors:['model-domain']})),native_grants:POLICY.actions.map((action,i)=>({ storage_source:'clued_private.owner_grants_v1',id:id(10+i),user_id:principal.subject_id,grantee_binding_id:principal.binding_id,action,resources:[resource(action.endsWith('.producer')?input.producer_registration_ref:input.permission_record_ref)],task_id:POLICY.task,token_id:id(20+i),receipt_id:id(30+i),granted_at:'2026-10-07T09:00:00Z',expires_at:'2026-10-07T10:00:00Z',revoked_at:null,max_uses:null,uses:0}))};
  const record = (r,type,authority,type_fields) => ({...r,record_type:type,authority,type_fields,canonical_scope:POLICY.scope,lifecycle_status:'active',record_currentness:'CURRENT',evaluated_at:at});
  const permission = record(input.permission_record_ref,'decision','user_explicit',{domain_permission:{status:'active',revoked_at:null,not_before:'2026-10-07T09:00:00Z',expires_at:'2026-10-07T10:00:00Z',action:'DatasetSplit.definition.recognize',effect:'NON_PRODUCTION_DEFINITION_RECOGNITION_ONLY',environment:'NON_PRODUCTION',canonical_scope:POLICY.scope,subject:POLICY.subject,principal,producer_registration_ref:input.producer_registration_ref}});
  const producer = record(input.producer_registration_ref,'state','user_explicit',{domain_producer:{service:POLICY.service,role:'EXISTING_MODEL_DOMAIN_AUTHORITY_DELEGATE',domain_owner:'MODEL PROGRAM',environment:'NON_PRODUCTION',principal,authority_registry_sha256:POLICY.registry}});
  const recognition = record(input.recognition_record_ref,'state','observed',{state_kind:'model_dataset_split_domain_recognition',domain_recognition:{contract_sha256:POLICY.contract,subject:POLICY.subject,permission_record_ref:input.permission_record_ref,producer_registration_ref:input.producer_registration_ref,producer:{service:POLICY.service,...principal},effect:'NON_PRODUCTION_DEFINITION_RECOGNITION_ONLY'}});
  recognition.receipt_id=input.recognition_receipt_id;
  const targets=[{id:recognition.id,kind:'record',role:'primary'}];
  const receipt={id:input.recognition_receipt_id,status:'committed',operation_family:'record_mutation',user_id:principal.subject_id,binding_id:principal.binding_id,target_refs:targets,committed_versions:{[recognition.id]:1},event_ids:['42'],canonical_version:100,evaluated_at:at};
  const event={id:'42',canonical_event_type:'record_created',result:'success',receipt_id:receipt.id,event_scope:POLICY.scope,target_refs:targets,committed_canonical_version:100,actor_user_id:principal.subject_id,actor_binding_id:principal.binding_id,evaluated_at:at};
  const f={input,ctx,rows:{permission,producer,recognition,receipt,event},canonicalReads:0,authorityReads:0};
  f.source={readProtectedAuthority:async()=>{f.authorityReads++; if(f.changeAfter && f.authorityReads>1) f.changeAfter(f.ctx); return structuredClone(f.ctx);},readCanonicalBundle:async()=>{f.canonicalReads++;if(f.changeCanonicalAfter && f.canonicalReads>1) f.changeCanonicalAfter(f.rows);return structuredClone(f.rows);}};
  return f;
}
const rejected = async f => {await assert.rejects(createM2ServerReadonlyReader(f.source,()=>now).verify(f.input),DomainReadDenied);};
test('standard private fixture verifies only source refs and hides actual actors',async()=>{
  const f=fixture(),r=await createM2ServerReadonlyReader(f.source,()=>now).verify(f.input);
  assert.equal(r.m2_qualification,'NOT_ISSUED');assert.equal(r.authority_effect,'NONE');assert.equal(f.canonicalReads,2);assert.equal(f.authorityReads,3);
  const text=JSON.stringify(r);assert(!text.includes(id(1)));assert(!text.includes(id(2)));assert(!text.includes('token_id'));
});
test('unregistered issuer stops before canonical reads',async()=>{const f=fixture();f.ctx.issuer_catalog=[];await rejected(f);assert.equal(f.canonicalReads,0);});
test('context read and user editable flags cannot replace native grants',async()=>{const f=fixture();f.ctx.native_grants=[];f.rows.permission.type_fields.domain_permission.authorized=true;await rejected(f);assert.equal(f.canonicalReads,0);});
test('missing protected producer registration stops before canonical reads',async()=>{const f=fixture();f.ctx.native_grants.pop();await rejected(f);assert.equal(f.canonicalReads,0);});
test('ordinary Record storage claimed as native grant is rejected',async()=>{const f=fixture();f.ctx.native_grants[0].storage_source='clued_memories.type_fields';await rejected(f);assert.equal(f.canonicalReads,0);});
test('revoked or expired grant stops before canonical reads',async()=>{for(const mutation of [g=>g.revoked_at=at,g=>g.expires_at=at]){const f=fixture();mutation(f.ctx.native_grants[0]);await rejected(f);assert.equal(f.canonicalReads,0);}});
test('wrong binding/task or wildcard resource cannot widen grant',async()=>{for(const mutation of [g=>g.grantee_binding_id=id(90),g=>g.task_id=id(90),g=>g.resources=['*']]){const f=fixture();mutation(f.ctx.native_grants[0]);await rejected(f);assert.equal(f.canonicalReads,0);}});
test('missing/foreign transaction actor rejects recognition',async()=>{for(const value of [undefined,id(99)]){const f=fixture();f.rows.event.actor_binding_id=value;await rejected(f);}});
test('server canonical hash drift rejects without deriving text hash',async()=>{const f=fixture();f.rows.permission.content_hash='f'.repeat(64);await rejected(f);});
test('target/version/receipt transaction mismatch rejects',async()=>{const f=fixture();f.rows.receipt.committed_versions={[id(5)]:2};await rejected(f);});
test('revocation after first reads rejects source proof',async()=>{const f=fixture();f.changeAfter=ctx=>ctx.auth.revoked_at=at;await rejected(f);});
test('regressed trusted clock rejects',async()=>{const f=fixture();let n=0;await assert.rejects(createM2ServerReadonlyReader(f.source,()=>n++?now-1:now).verify(f.input),/CLOCK_REGRESSED/);});
test('caller principal/authority fake is not a valid selector',async()=>{const f=fixture();f.input.principal={subject_id:id(1)};await rejected(f);assert.equal(f.authorityReads,0);});
test('existing RPC unavailable remains denial, never issued source',async()=>{await assert.rejects(verifyWithExistingBindingRpc(async()=>{throw Error('database unavailable');},fixture().input,()=>now),/AUTHENTICATED_SOURCE_DENIED/);});
test('public RPC adapter rejects raw actor identity fields',async()=>{
  const f=fixture(),result=await createM2ServerReadonlyReader(f.source,()=>now).verify(f.input);
  await assert.rejects(verifyWithExistingBindingRpc(async()=>({...result,actor_user_id:id(1)}),f.input,()=>now),/PRIVATE_IDENTITY_LEAK/);
});
test('SQL catalog and protected grants precede canonical reads; register/read separate',()=>{
  const sql=readFileSync(new URL('../../../development/contracts/model-program/stage-admission/repo-integration-candidate/readonly/domain-reader.candidate.sql',import.meta.url),'utf8');
  assert(sql.indexOf('DOMAIN_ISSUER_NOT_REGISTERED')<sql.indexOf('from public.clued_memories'));
  assert(sql.indexOf('INDEPENDENT_NATIVE_GRANT_MISSING')<sql.indexOf('from public.clued_memories'));
  assert(!/insert\s+into|update\s+public\.|delete\s+from|grant\s+execute/i.test(sql.replace(/--[^\n]*/g,'')));
  assert(sql.includes('m.content_hash'));assert(sql.includes('e.actor_user_id'));assert(sql.includes('e.actor_binding_ref'));
  assert(sql.includes('resolve_binding'));assert(sql.includes('record_currentness_fence'));assert(sql.includes('from public,anon,authenticated,service_role'));
});

test('existing RPC chain accepts minimal refs with reordered JSON keys',async()=>{const f=fixture(),r=await createM2ServerReadonlyReader(f.source,()=>now).verify(f.input);r.recognition_record_ref;const raw={...r,recognition_record_ref:{content_hash:f.input.recognition_record_ref.content_hash,version:1,id:f.input.recognition_record_ref.id}};const out=await verifyWithExistingBindingRpc(async(name,input)=>{assert.equal(name,'clued_model_dataset_split_verify_candidate');assert.deepEqual(input,f.input);return raw;},f.input,()=>now);assert.equal(out.private_actor_fields_exposed,false);});

test('private record hash/version/currentness drift between reads denies',async()=>{
  for(const mutation of [r=>r.permission.content_hash='f'.repeat(64),r=>r.producer.version=2,r=>r.recognition.record_currentness='UNKNOWN']){
    const f=fixture();f.changeCanonicalAfter=mutation;await rejected(f);assert.equal(f.canonicalReads,2);
  }
});
test('second snapshot extra source change denies even when existing guards still match',async()=>{
  const f=fixture();f.changeCanonicalAfter=r=>r.recognition.source_revision='new';
  await assert.rejects(createM2ServerReadonlyReader(f.source,()=>now).verify(f.input),/CANONICAL_SOURCE_CHANGED_DURING_READ/);
});
test('re-observation timestamps alone may change between complete reads',async()=>{
  const f=fixture();const earlier='2026-10-07T09:19:59Z';
  for(const row of Object.values(f.rows)) row.evaluated_at=earlier;
  f.changeCanonicalAfter=rows=>{for(const row of Object.values(rows)) row.evaluated_at=at;};
  const result=await createM2ServerReadonlyReader(f.source,()=>now).verify(f.input);
  assert.equal(result.status,'VERIFIED_EXISTING_SOURCE_REFERENCES_READ_ONLY');assert.equal(f.canonicalReads,2);
});
test('revocation during second canonical read denies at final authority check',async()=>{
  const f=fixture();f.changeCanonicalAfter=()=>{f.ctx.native_grants[0].revoked_at=at;};
  await rejected(f);assert.equal(f.canonicalReads,2);assert.equal(f.authorityReads,3);
});
test('null or missing typed window/event type always denies',async()=>{
  for(const mutation of [r=>r.permission.type_fields.domain_permission.not_before=null,r=>r.permission.type_fields.domain_permission.expires_at=null,r=>delete r.permission.type_fields.domain_permission.not_before,r=>r.event.canonical_event_type=null,r=>delete r.event.canonical_event_type]){
    const f=fixture();mutation(f.rows);await rejected(f);
  }
});
test('SQL nullable values have explicit fail-closed guards before window casts',()=>{
  const sql=readFileSync(new URL('../../../development/contracts/model-program/stage-admission/repo-integration-candidate/readonly/domain-reader.candidate.sql',import.meta.url),'utf8');
  const typeCheck=sql.indexOf("jsonb_typeof(g->'not_before') is distinct from 'string'");
  const cast=sql.indexOf("permission_not_before:=(g->>'not_before')::timestamptz");
  assert(typeCheck>0 && typeCheck<cast);assert(sql.includes("jsonb_typeof(g->'expires_at') is distinct from 'string'"));
  assert(sql.includes('permission_not_before is null or permission_expires_at is null'));
  assert(sql.includes('not isfinite(permission_not_before)'));assert(sql.includes('permission_expires_at<=permission_not_before'));
  assert(sql.includes("coalesce(event->>'canonical_event_type','') not in ('record_created','record_updated')"));
  assert(!sql.includes("event->>'canonical_event_type' not in"));
});
test('Native expiry exactly at final acceptance sample denies',async()=>{
  const f=fixture(),deadline=now+1000;f.ctx.native_grants[0].expires_at=new Date(deadline).toISOString();
  let samples=0;await assert.rejects(createM2ServerReadonlyReader(f.source,()=>samples++>=5?deadline:now).verify(f.input),/GRANT_REVOKED_EXPIRED_OR_WINDOW/);
  assert.equal(f.canonicalReads,2);
});
test('accepted verdict time is the same instant checked for Native and typed windows',async()=>{
  const f=fixture(),deadline=now+1000;f.ctx.native_grants[0].expires_at=new Date(deadline).toISOString();
  let samples=0;const result=await createM2ServerReadonlyReader(f.source,()=>samples++>=6?deadline:now).verify(f.input);
  assert(Date.parse(result.evaluated_at)<deadline);assert.equal(samples,6);
});
test('extra unregistered resource kinds or different exact record pin denies',async()=>{
  for(const mutation of [g=>g.resources.push('scope:'+POLICY.scope),g=>g.resources=['record:'+id(3)+'@2#'+'a'.repeat(64)],g=>g.resources=['record:'+id(3)+'@1#'+'f'.repeat(64)]]){
    const f=fixture();mutation(f.ctx.native_grants[0]);await rejected(f);assert.equal(f.canonicalReads,0);
  }
});
test('same acceptance timestamp is returned by SQL after final binding check',()=>{
  const sql=readFileSync(new URL('../../../development/contracts/model-program/stage-admission/repo-integration-candidate/readonly/domain-reader.candidate.sql',import.meta.url),'utf8');
  const tail=sql.slice(sql.lastIndexOf('perform clued_private.resolve_binding'));
  assert(tail.indexOf('now_at:=clock_timestamp()')>0);
  assert(tail.includes("'evaluated_at',to_char(now_at at time zone 'UTC'"));
  assert(!tail.includes("'evaluated_at',to_char(clock_timestamp()"));
});
test('UTC parser rejects calendar/time normalization and permits actual fractional instants',()=>{
  for(const value of ['2026-02-30T09:00:00Z','2026-10-07T24:00:00Z','2026-10-07T09:20:60Z','2026-10-07T09:00:00+01:00','2026-10-07']) assert.throws(()=>parseSourceUTC(value));
  assert.equal(parseSourceUTC('2026-10-07T09:20:00.123456Z'),now+123);
  assert.equal(parseSourceUTC('2026-10-07T09:20:00+00:00'),now);
  const sql=readFileSync(new URL('../../../development/contracts/model-program/stage-admission/repo-integration-candidate/readonly/domain-reader.candidate.sql',import.meta.url),'utf8');
  assert(sql.includes("is distinct from left(g->>'not_before',19)"));assert(sql.includes("is distinct from left(g->>'expires_at',19)"));
});
test('provider reusing a mutable source object cannot erase the first snapshot',async()=>{
  const f=fixture();f.source.readCanonicalBundle=async()=>{
    f.canonicalReads++;if(f.canonicalReads>1) f.rows.recognition.source_revision='new';return f.rows;
  };
  await assert.rejects(createM2ServerReadonlyReader(f.source,()=>now).verify(f.input),/CANONICAL_SOURCE_CHANGED_DURING_READ/);
});
