/** Complete server-private guard implementation. Uninstalled candidate.
 * source is a Host-owned private M1 source, never JSON from a caller.
 * No Kernel Receipt, Gate, training permission or model execution is issued.
 */
import {DOMAIN_POLICY as P} from './model-domain-policy.mjs';
import {POLICY,parseSourceUTC} from './model-domain-readonly.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex=/^[0-9a-f]{64}$/;
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
export class FullDomainDenied extends Error{constructor(code){super(code);this.name='FullDomainDenied';}}
const assertContract=(ok,code)=>{if(!ok)throw new FullDomainDenied(code);};
const exact=(v,keys,code)=>assertContract(object(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|'),code);
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':object(v)?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const equal=(a,b)=>canonical(a)===canonical(b);
const clone=v=>structuredClone(v);
function ref(value){exact(value,['id','version','content_hash'],'SOURCE_REFERENCE_SHAPE');assertContract(uuid.test(value.id)&&Number.isSafeInteger(value.version)&&value.version>0&&hex.test(value.content_hash),'SOURCE_REFERENCE_INVALID');return value;}
const recordResource=r=>`record:${r.id}@${r.version}#${r.content_hash}`;
function parsedResource(value){const match=/^record:([0-9a-f-]{36})@([1-9][0-9]*)#([0-9a-f]{64})$/.exec(value);assertContract(match,'NATIVE_EXACT_RECORD_RESOURCE');return ref({id:match[1],version:Number(match[2]),content_hash:match[3]});}
function fresh(row,now){assertContract(object(row),'PRIVATE_SOURCE_SHAPE');const seen=parseSourceUTC(row.evaluated_at);assertContract(seen<=now&&now-seen<=POLICY.maxAgeMs,'PRIVATE_SOURCE_STALE');}
function authenticate(state,now,action='DatasetSplit.definition.verify'){
  assertContract(object(state)&&object(state.auth),'AUTHENTICATED_PRIVATE_SOURCE_REQUIRED');const a=state.auth;fresh(a,now);
  assertContract(a.status==='AUTHENTICATED'&&a.currentness==='CURRENT'&&a.revoked_at===null&&a.canonical_scope===POLICY.scope&&a.environment==='NON_PRODUCTION'&&a.service===POLICY.service&&a.action===action,'AUTH_SCOPE_ACTION_ENVIRONMENT_OR_CURRENTNESS');
  exact(a.principal,['subject_id','binding_id'],'SERVER_PRINCIPAL_SHAPE');assertContract(uuid.test(a.principal.subject_id)&&uuid.test(a.principal.binding_id)&&a.owner_subject_id===a.principal.subject_id,'SERVER_OWNER_AND_BINDING_REQUIRED');
  assertContract(now<parseSourceUTC(a.expires_at),'AUTH_EXPIRED');return a.principal;
}
function protectedGrants(state,now,actions,resources,bootstrap=false){
  const principal=authenticate(state,now,bootstrap?P.bootstrap_action:'DatasetSplit.definition.verify');assertContract(Array.isArray(state.issuer_catalog)&&Array.isArray(state.native_grants),'PROTECTED_NATIVE_SOURCE_REQUIRED');const grants=[];
  for(const action of actions){
    assertContract(state.issuer_catalog.some(a=>a.action===action&&Array.isArray(a.doors)&&a.doors.includes(bootstrap?P.bootstrap_door:'model-domain')),'REAL_ACTION_DOOR_NOT_REGISTERED');
    const matches=state.native_grants.filter(g=>g.action===action);assertContract(matches.length===1,'EXACT_NATIVE_GRANT_REQUIRED');const g=matches[0];
    assertContract(g.storage_source==='clued_private.owner_grants_v1'&&uuid.test(g.id)&&uuid.test(g.token_id)&&uuid.test(g.receipt_id)&&g.native_confirmation_receipt_verified===true,'NATIVE_CONFIRMATION_PROVENANCE_REQUIRED');
    assertContract(g.user_id===principal.subject_id&&g.grantee_binding_id===principal.binding_id&&g.task_id===POLICY.task&&g.revoked_at===null,'NATIVE_TASK_BINDING_OR_REVOKED');
    const granted=parseSourceUTC(g.granted_at),expires=parseSourceUTC(g.expires_at);assertContract(granted<=now&&now<expires&&expires>granted&&expires-granted<=POLICY.maxWindowMs,'NATIVE_TIME_WINDOW');
    assertContract(Number.isSafeInteger(g.uses)&&g.uses>=0&&(bootstrap?g.max_uses===1&&g.uses===0:g.max_uses===null),'NATIVE_WRITE_SINGLE_USE_OR_READ_WINDOW');
    assertContract(Array.isArray(g.resources)&&equal([...g.resources].sort(),resources(action).sort()),'NATIVE_RESOURCES_EXACT');grants.push(clone(g));
  }
  return {principal:clone(principal),grants};
}
function readAuthority(state,now){
  // Derive permission/producer selectors from protected grant resources,
  // before any Canonical target read; never from caller proof or flags.
  assertContract(Array.isArray(state?.native_grants),'PROTECTED_NATIVE_SOURCE_REQUIRED');
  const select=action=>{const rows=state.native_grants.filter(g=>g.action===action);assertContract(rows.length===1&&Array.isArray(rows[0].resources)&&rows[0].resources.length===1,'EXACT_NATIVE_GRANT_REQUIRED');return parsedResource(rows[0].resources[0]);};
  const permissionRef=select('model.dataset_split.recognize'),producerRef=select('model.dataset_split.producer');
  const authority=protectedGrants(state,now,POLICY.actions,action=>[recordResource(action.endsWith('.producer')?producerRef:permissionRef)]);
  return {...authority,permissionRef,producerRef};
}
function current(row,reference,type,authority,now){
  ref(reference);fresh(row,now);
  assertContract(row.id===reference.id&&row.version===reference.version&&row.content_hash===reference.content_hash,'SERVER_RECORD_REFERENCE');
  assertContract(row.canonical_hash_algorithm==='clued_private.m1_record_content_hash'&&hex.test(row.recomputed_server_content_hash)&&row.content_hash===row.recomputed_server_content_hash,'REAL_SERVER_FULL_RECORD_HASH_REQUIRED');
  assertContract(row.canonical_scope===POLICY.scope&&row.record_currentness==='CURRENT'&&row.lifecycle_status==='active'&&row.record_type===type&&row.authority===authority,'CURRENT_RECORD_SCOPE_TYPE_AUTHORITY');return row;
}
function legacyOwner(row,identity,legacyHash,receiptId,now){
  assertContract(object(row)&&row.id===identity.id&&row.version===identity.version,'FIXED_OWNER_RECORD');
  current(row,{id:row.id,version:row.version,content_hash:row.content_hash},'decision','user_explicit',now);
  assertContract(row.content_hash===legacyHash&&row.receipt_id===receiptId,'FROZEN_OWNER_SERVER_HASH_REFERENCE_UNRESOLVED_OR_RECEIPT');
  // Preserve the original exact server-hash guard. Legacy hash semantics are
  // not proven; a mismatch is NOT resolved by reinterpreting it as body SHA.
  return {id:row.id,version:row.version,content_hash:row.content_hash};
}
function verifyOwnerBundle(rows,now){
  assertContract(object(rows),'PRIVATE_FOUNDATION_BUNDLE');const adoption=P.domain.owner_adoption,recognizer=P.server.owner_final_recognizer;
  const adoptionRef=legacyOwner(rows.adoption,{id:adoption.canonical_record_id,version:adoption.record_version},adoption.record_content_sha256,adoption.canonical_receipt_id,now);
  const recognizerRef=legacyOwner(rows.recognizer,recognizer.record_ref,recognizer.record_ref.content_hash,recognizer.receipt_id,now);
  assertContract(equal(rows.recognizer.type_fields?.model_final_recognizer,recognizer.expected_fields),'COMPLETE_FINAL_RECOGNIZER_DESIGNATION');
  assertContract(recognizer.expected_fields.domain_permission_granted===false,'DESIGNATION_IS_NOT_DOMAIN_GRANT');
  return {owner_adoption_server_ref:adoptionRef,final_recognizer_server_ref:recognizerRef};
}
function foundation(rows,authority,now){
  const owners=verifyOwnerBundle(rows,now);const permission=current(rows.permission,authority.permissionRef,'decision','user_explicit',now),producer=current(rows.producer,authority.producerRef,'state','user_explicit',now);
  const g=permission.type_fields?.domain_permission;
  exact(g,['status','revoked_at','not_before','expires_at','action','effect','environment','canonical_scope','subject','principal','producer_registration_ref'],'COMPLETE_DOMAIN_PERMISSION_SHAPE');
  assertContract(g.status==='active'&&g.revoked_at===null&&g.action==='DatasetSplit.definition.recognize'&&g.effect===P.domain.effect&&g.environment==='NON_PRODUCTION'&&g.canonical_scope===POLICY.scope&&equal(g.subject,P.domain.subject)&&equal(g.principal,authority.principal)&&equal(g.producer_registration_ref,authority.producerRef),'DOMAIN_PERMISSION_BINDING');
  const start=parseSourceUTC(g.not_before),end=parseSourceUTC(g.expires_at);assertContract(start<=now&&now<end&&end>start&&end-start<=POLICY.maxWindowMs,'DOMAIN_PERMISSION_WINDOW');
  assertContract(equal(producer.type_fields?.domain_producer,{service:POLICY.service,role:'EXISTING_MODEL_DOMAIN_AUTHORITY_DELEGATE',domain_owner:'MODEL PROGRAM',environment:'NON_PRODUCTION',principal:authority.principal,authority_registry_sha256:P.domain.authority_registry_sha256}),'COMPLETE_REGISTERED_PRODUCER');
  return owners;
}
function expectedRecognition(a){return {contract_id:P.domain.contract_id,contract_version:P.domain.version,contract_sha256:P.contract_sha256,subject:P.domain.subject,owner_adoption:P.domain.owner_adoption,permission_record_ref:a.permissionRef,producer_registration_ref:a.producerRef,producer:{service:POLICY.service,...a.principal},effect:P.domain.effect};}
function recognitionBundle(rows,request,authority,now){
  assertContract(object(rows),'PRIVATE_RECOGNITION_BUNDLE');const row=current(rows.recognition,request.recognition_record_ref,'state','observed',now);
  assertContract(row.type_fields?.state_kind==='model_dataset_split_domain_recognition'&&equal(row.type_fields?.domain_recognition,expectedRecognition(authority)),'COMPLETE_NINE_FIELD_RECOGNITION_BINDING');
  const r=rows.receipt,e=rows.event;fresh(r,now);fresh(e,now);const targets=[{id:row.id,kind:'record',role:'primary'}];
  assertContract(r.id===request.recognition_receipt_id&&row.receipt_id===r.id&&r.status==='committed'&&r.operation_family==='record_mutation'&&r.user_id===authority.principal.subject_id&&r.binding_id===authority.principal.binding_id&&equal(r.target_refs,targets)&&equal(r.committed_versions,{[row.id]:row.version}),'COMMITTED_M1_RECEIPT_ACTOR_TARGET_VERSION');
  assertContract(Array.isArray(r.event_ids)&&r.event_ids.length===1&&String(e.id)===String(r.event_ids[0])&&['record_created','record_updated'].includes(e.canonical_event_type)&&e.result==='success'&&e.receipt_id===r.id&&e.event_scope===POLICY.scope&&equal(e.target_refs,targets)&&Number.isSafeInteger(r.canonical_version)&&r.canonical_version>0&&e.committed_canonical_version===r.canonical_version&&e.actor_user_id===authority.principal.subject_id&&e.actor_binding_id===authority.principal.binding_id,'COMMITTED_M1_EVENT_SAME_TRANSACTION_ACTOR');
}
function stable(rows){return Object.fromEntries(Object.entries(rows).map(([k,v])=>{assertContract(object(v),'PRIVATE_SOURCE_SHAPE');const {evaluated_at,...rest}=v;return[k,rest];}));}
function request(input){exact(input,['schema_version','contract_sha256','subject','recognition_record_ref','recognition_receipt_id'],'CALLER_AUTHORITY_OR_UNKNOWN_FIELD');assertContract(input.schema_version==='clued.model-dataset-split-domain-recognition-request-candidate/1'&&input.contract_sha256===P.contract_sha256&&equal(input.subject,P.domain.subject)&&uuid.test(input.recognition_receipt_id),'COMPLETE_REQUEST_CONTRACT_SUBJECT');ref(input.recognition_record_ref);return clone(input);}
function pinned(source){assertContract(equal(source?.pinned_artifacts,{contract_sha256:P.contract_sha256,definition_sha256:P.domain.subject.definition_sha256,instance_schema_sha256:P.domain.subject.instance_schema_sha256,authority_registry_sha256:P.domain.authority_registry_sha256}),'FROZEN_CONTRACT_DEFINITION_SCHEMA_REGISTRY');}
export function createFullDomainConsumer(source,clock=()=>Date.now()){
  assertContract(object(source)&&typeof source.readProtectedAuthority==='function'&&typeof source.readFoundationBundle==='function'&&typeof source.readRecognitionBundle==='function','HOST_PRIVATE_M1_SOURCE_REQUIRED');pinned(source);
  return Object.freeze({async verify(input){
    const wanted=request(input);let last=-Infinity;const sample=()=>{const value=clock();assertContract(Number.isSafeInteger(value)&&value>=last,'TRUSTED_CLOCK_REGRESSED');last=value;return value;};
    const start=clone(await source.readProtectedAuthority());const a=readAuthority(start,sample());
    const firstFoundation=clone(await source.readFoundationBundle(a));foundation(firstFoundation,a,sample());
    const firstRecognition=clone(await source.readRecognitionBundle(wanted,a));recognitionBundle(firstRecognition,wanted,a,sample());
    const finalFoundation=clone(await source.readFoundationBundle(a));const finalRecognition=clone(await source.readRecognitionBundle(wanted,a));
    const final=clone(await source.readProtectedAuthority());const accepted=sample();const finalA=readAuthority(final,accepted);
    assertContract(equal(a,finalA),'NATIVE_AUTHORITY_CHANGED_DURING_READ');const owners=foundation(finalFoundation,finalA,accepted);recognitionBundle(finalRecognition,wanted,finalA,accepted);
    assertContract(equal(stable(firstFoundation),stable(finalFoundation))&&equal(stable(firstRecognition),stable(finalRecognition)),'FULL_SOURCE_CHANGED_DURING_READ');
    return Object.freeze({status:'FULL_DOMAIN_DEFINITION_RECOGNITION_VERIFIED_ONLY',recognition_record_ref:wanted.recognition_record_ref,recognition_receipt_id:wanted.recognition_receipt_id,...owners,evaluated_at:new Date(accepted).toISOString(),hash_binding:'ORIGINAL_EXACT_SERVER_HASH_GUARD_NO_BODY_HASH_FALLBACK',authority_effect:'NONE',actual_execution:'READ_ONLY',domain_authority_receipt:'NOT_KERNEL_RECEIPT',data_gate:'NOT_ISSUED',m2_verdict:'NOT_ISSUED',training_or_data_use_authorized:false});
  }});
}
export async function prepareBootstrapCandidate(source,input,clock=()=>Date.now()){
  pinned(source);exact(input,['owner_adoption_server_ref','final_recognizer_server_ref','producer_record_id','permission_record_id','recognition_record_id','idempotency_key','immutable_plan_resource'],'BOOTSTRAP_CALLER_AUTHORITY_OR_UNKNOWN_FIELD');
  ref(input.owner_adoption_server_ref);ref(input.final_recognizer_server_ref);assertContract(input.owner_adoption_server_ref.id===P.domain.owner_adoption.canonical_record_id&&input.owner_adoption_server_ref.version===1&&input.final_recognizer_server_ref.id===P.server.owner_final_recognizer.record_ref.id&&input.final_recognizer_server_ref.version===1,'BOOTSTRAP_FIXED_OWNER_ANCHORS');
  const ids=['producer_record_id','permission_record_id','recognition_record_id'];assertContract(ids.every(k=>uuid.test(input[k])&&input[k]!==input.owner_adoption_server_ref.id&&input[k]!==input.final_recognizer_server_ref.id)&&new Set(ids.map(k=>input[k])).size===3&&typeof input.idempotency_key==='string'&&input.idempotency_key.length>=8&&input.idempotency_key.length<=100,'BOOTSTRAP_CREATE_TARGETS_OR_IDEMPOTENCY');
  assertContract(typeof input.immutable_plan_resource==='string'&&/^repo:tdoljyj\/cross-memory-system\/[0-9a-f]{40}\/development\/contracts\/model-program\/stage-admission\/[A-Za-z0-9_.-]+\.json$/.test(input.immutable_plan_resource),'BOOTSTRAP_EXACT_IMMUTABLE_PLAN_REFERENCE');
  let last=-Infinity;const sample=()=>{const now=clock();assertContract(Number.isSafeInteger(now)&&now>=last,'TRUSTED_CLOCK_REGRESSED');last=now;return now;};
  const state=clone(await source.readProtectedAuthority());const resources=[recordResource(input.owner_adoption_server_ref),recordResource(input.final_recognizer_server_ref),...ids.map(k=>'record:'+input[k]),input.immutable_plan_resource];
  const a=protectedGrants(state,sample(),[P.bootstrap_action],()=>resources,true);
  const rows=clone(await source.readOwnerAnchorBundle(a));verifyOwnerBundle(rows,sample());
  const finalRows=clone(await source.readOwnerAnchorBundle(a));const finalState=clone(await source.readProtectedAuthority());
  const accepted=sample();const finalA=protectedGrants(finalState,accepted,[P.bootstrap_action],()=>resources,true);
  assertContract(equal(a,finalA)&&equal(stable(rows),stable(finalRows)),'BOOTSTRAP_SOURCE_OR_AUTHORITY_CHANGED');
  const owners=verifyOwnerBundle(finalRows,accepted);assertContract(equal(owners,{owner_adoption_server_ref:input.owner_adoption_server_ref,final_recognizer_server_ref:input.final_recognizer_server_ref}),'BOOTSTRAP_REAL_SERVER_OWNER_REFS');
  // No dependency on an existing producer/permission/recognition. This solves
  // first-write scope preparation without pretending that read grants can write.
  return Object.freeze({status:'BOOTSTRAP_PREFLIGHT_COMPLETE_WRITE_NOT_READY',preparation_only:true,mutation_permitted:false,reason:P.bootstrap_activation,actual_execution:'NONE',authority_effect:'NONE',native_write_grant_ref:a.grants[0].id,create_targets:ids.map(k=>input[k]),evaluated_at:new Date(accepted).toISOString(),m1_entry:'public.clued_record_mutate(text,jsonb)',domain_authority_receipt:'NOT_ISSUED',m2_verdict:'NOT_ISSUED'});
}
