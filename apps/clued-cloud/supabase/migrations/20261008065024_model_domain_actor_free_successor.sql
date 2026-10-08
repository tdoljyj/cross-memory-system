-- Actor-free M1 source successor. No writers, grants or model/Gate issuance.
-- Legacy source functions remain byte-identical and independent.
-- General private M1 chain verifier, reachable publicly only after the fixed
-- Owner selector/currentness/full-hash guards in model_domain_source_successor.
-- Historical receipt Binding is the writer's Binding, not the current reader.
create or replace function clued_private.model_domain_owner_chain_successor(
 p_binding public.clued_agent_bindings,p_record public.clued_memories
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
 s constant text:='project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
 r public.clued_audit_receipts; e public.clued_context_events;
 recomputed text; expected_targets jsonb;
begin
 if p_record.user_id is distinct from p_binding.user_id or p_record.record_schema_version is distinct from 1 or
    p_record.record_type is distinct from 'decision' or p_record.authority is distinct from 'user_explicit' or
    p_record.canonical_scope is distinct from s or p_record.lifecycle_status is distinct from 'active' or
    clued_private.record_currentness_fence(p_binding.user_id,p_record.id,array[s]) is distinct from 'CURRENT'
 then raise exception 'OWNER_M1_RECORD_NOT_CURRENT_OR_OWNER' using errcode='42501'; end if;
 recomputed:=clued_private.m1_record_content_hash(p_record.record_type,p_record.canonical_scope,p_record.lifecycle_status,
   p_record.title,p_record.content,p_record.type_fields,p_record.relations,p_record.source_refs,p_record.source_unavailable_reason,
   p_record.authority,p_record.observed_at,p_record.closed_at,p_record.confidence,p_record.confidence_reason);
 if p_record.content_hash is distinct from recomputed or coalesce(recomputed,'') !~ '^[0-9a-f]{64}$'
 then raise exception 'OWNER_M1_RECORD_FULL_HASH_INVALID' using errcode='42501'; end if;
 select * into r from public.clued_audit_receipts x where x.user_id=p_binding.user_id and x.id=p_record.receipt_id;
 expected_targets:=jsonb_build_array(jsonb_build_object('id',p_record.id,'kind','record','role','primary'));
 if not found or r.status is distinct from 'committed' or r.operation_family is distinct from 'record_mutation' or
    r.binding_id is null or r.target_refs is distinct from expected_targets or
    r.committed_versions is distinct from jsonb_build_object(p_record.id::text,p_record.version) or
    cardinality(r.event_ids) is distinct from 1 or r.canonical_version is null or r.canonical_version<=0
 then raise exception 'OWNER_M1_RECEIPT_TARGET_VERSION_INVALID' using errcode='42501'; end if;
 select * into e from public.clued_context_events x where x.user_id=p_binding.user_id and x.id::text=r.event_ids[1];
 if not found or e.receipt_id is distinct from r.id or e.event_scope is distinct from s or
    e.target_refs is distinct from expected_targets or e.result is distinct from 'success' or
    coalesce(e.canonical_event_type,'') not in ('record_created','record_updated') or
    e.committed_canonical_version is distinct from r.canonical_version or
    e.actor_user_id is distinct from p_binding.user_id or e.actor_binding_ref is distinct from r.binding_id::text
 then raise exception 'OWNER_M1_EVENT_ACTOR_TRANSACTION_INVALID' using errcode='42501'; end if;
 -- Entire verified Receipt/Event rows join the double-read private snapshot;
 -- none is emitted by the public wrapper. No current reader Binding equality.
 return jsonb_build_object('receipt',to_jsonb(r),'event',to_jsonb(e));
end $$;
revoke all on function clued_private.model_domain_owner_chain_successor(public.clued_agent_bindings,public.clued_memories)
 from public,anon,authenticated,service_role;

-- UNINSTALLED server-private normalization candidate. Not an authorizer or
-- standalone reader. Only the guarded M2 source may call AFTER its real
-- Native grants and exact resource checks, before emitting any public DTO.
-- It returns private identities to private guard code, never to MCP/HTTP.
create or replace function clued_private.model_domain_normalize_row_successor(
 p_binding public.clued_agent_bindings,p_record public.clued_memories
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
 s constant text:='project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
 r public.clued_audit_receipts; e public.clued_context_events;
 recomputed text; fields jsonb:=p_record.type_fields; principal jsonb;
 expected_targets jsonb; identity constant jsonb:='{"source":"NATIVE_GRANTEE_AND_M1_RECEIPT_EVENT_ACTOR","identity_not_persisted":true}';
begin
 if p_record.user_id is distinct from p_binding.user_id or
    p_record.record_schema_version is distinct from 1 or p_record.canonical_scope is distinct from s or
    p_record.lifecycle_status is distinct from 'active' or
    clued_private.record_currentness_fence(p_binding.user_id,p_record.id,array[s]) is distinct from 'CURRENT'
 then raise exception 'PRIVATE_MODEL_ROW_NOT_CURRENT_OR_NOT_OWNER' using errcode='42501'; end if;
 recomputed:=clued_private.m1_record_content_hash(p_record.record_type,p_record.canonical_scope,
   p_record.lifecycle_status,p_record.title,p_record.content,p_record.type_fields,p_record.relations,
   p_record.source_refs,p_record.source_unavailable_reason,p_record.authority,p_record.observed_at,
   p_record.closed_at,p_record.confidence,p_record.confidence_reason);
 if p_record.content_hash is distinct from recomputed or coalesce(recomputed,'') !~ '^[0-9a-f]{64}$'
 then raise exception 'PRIVATE_MODEL_SERVER_CONTENT_HASH_INVALID' using errcode='42501'; end if;
 if p_record.type_fields->'identity_binding' is distinct from identity then
   raise exception 'ACTOR_FREE_DOMAIN_IDENTITY_BINDING_REQUIRED' using errcode='42501';
 end if;
 if p_record.type_fields->'identity_binding'=identity then
   -- The fixed producer keeps actual Actor IDs out of public persistent
   -- content/type_fields. This private view derives the exact old principal
   -- bindings from real committed Receipt/Event columns, not metadata flags.
   select * into r from public.clued_audit_receipts x
    where x.user_id=p_binding.user_id and x.id=p_record.receipt_id;
   expected_targets:=jsonb_build_array(jsonb_build_object('id',p_record.id,'kind','record','role','primary'));
   if not found or r.status is distinct from 'committed' or r.operation_family is distinct from 'record_mutation' or
      r.binding_id is distinct from p_binding.id or r.target_refs is distinct from expected_targets or
      r.committed_versions is distinct from jsonb_build_object(p_record.id::text,p_record.version) or
      cardinality(r.event_ids) is distinct from 1 or r.canonical_version is null or r.canonical_version<=0
   then raise exception 'PRIVATE_MODEL_M1_TRANSACTION_NOT_BOUND' using errcode='42501'; end if;
   select * into e from public.clued_context_events x where x.user_id=p_binding.user_id and x.id::text=r.event_ids[1];
   if not found or e.receipt_id is distinct from r.id or e.event_scope is distinct from s or
      e.target_refs is distinct from expected_targets or e.result is distinct from 'success' or
      coalesce(e.canonical_event_type,'') not in ('record_created','record_updated') or
      e.committed_canonical_version is distinct from r.canonical_version or
      e.actor_user_id is distinct from p_binding.user_id or e.actor_binding_ref is distinct from p_binding.id::text
   then raise exception 'PRIVATE_MODEL_M1_EVENT_ACTOR_NOT_BOUND' using errcode='42501'; end if;
   if jsonb_typeof(fields) is distinct from 'object' or
      (select array_agg(k order by k) from jsonb_object_keys(fields) k) is distinct from
        (case when p_record.record_type='decision' then array['domain_permission','identity_binding','rationale']::text[]
             when fields->>'state_kind'='model_dataset_split_domain_producer' then array['domain_producer','identity_binding','state_kind']::text[]
             else array['domain_recognition','identity_binding','owner_source_bindings','state_kind']::text[] end)
   then raise exception 'ACTOR_FREE_DOMAIN_TEMPLATE_SHAPE_REQUIRED' using errcode='42501'; end if;
   principal:=jsonb_build_object('subject_id',r.user_id,'binding_id',r.binding_id);
   if p_record.record_type='decision' and p_record.authority='user_explicit' and jsonb_typeof(fields->'domain_permission')='object' then
     if fields->'domain_permission' ? 'principal' then raise exception 'PRIVATE_IDENTITY_MUST_NOT_BE_PERSISTED' using errcode='42501'; end if;
     fields:=jsonb_set(fields,'{domain_permission,principal}',principal,true);
   elsif p_record.record_type='state' and p_record.authority='user_explicit' and fields->>'state_kind'='model_dataset_split_domain_producer' then
     if fields->'domain_producer' ? 'principal' then raise exception 'PRIVATE_IDENTITY_MUST_NOT_BE_PERSISTED' using errcode='42501'; end if;
     fields:=jsonb_set(fields,'{domain_producer,principal}',principal,true);
   elsif p_record.record_type='state' and p_record.authority='observed' and fields->>'state_kind'='model_dataset_split_domain_recognition' then
     if fields->'domain_recognition'->'producer' ?| array['subject_id','binding_id'] then
       raise exception 'PRIVATE_IDENTITY_MUST_NOT_BE_PERSISTED' using errcode='42501'; end if;
     if fields->'domain_recognition'->'producer' is distinct from '{"service":"clued-cloud/supabase"}'::jsonb then
       raise exception 'ACTOR_FREE_RECOGNITION_PRODUCER_SHAPE_REQUIRED' using errcode='42501'; end if;
     fields:=jsonb_set(fields,'{domain_recognition,producer}',jsonb_build_object('service','clued-cloud/supabase')||principal,true);
   else raise exception 'PRIVATE_IDENTITY_FIXED_MODEL_KIND_REQUIRED' using errcode='42501'; end if;
 end if;
 return jsonb_build_object('id',p_record.id,'version',p_record.version,'content_hash',p_record.content_hash,
   'canonical_hash_algorithm','clued_private.m1_record_content_hash','recomputed_server_content_hash',recomputed,
   'body_utf8_sha256',encode(extensions.digest(convert_to(p_record.content,'UTF8'),'sha256'),'hex'),
   'canonical_scope',p_record.canonical_scope,'record_currentness','CURRENT','lifecycle_status',p_record.lifecycle_status,
   'record_type',p_record.record_type,'authority',p_record.authority,'receipt_id',p_record.receipt_id,'type_fields',fields,
   'evaluated_at',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
end $$;
revoke all on function clued_private.model_domain_normalize_row_successor(public.clued_agent_bindings,public.clued_memories)
 from public,anon,authenticated,service_role;
-- No GRANT, routes, Native permission, M1 mutation or public Actor projection.

-- UNINSTALLED engineering candidate, main source 412e4954.
-- Distinct successor migration; no replacement of legacy installed functions.
-- No tables, issuer registrations, Owner grants, producer grants or data writes.
-- Private normalization stays inside PostgreSQL; public wrapper returns refs only.
-- resolve_binding / record_currentness_fence / Owner confirmation storage are existing.

create or replace function clued_private.model_domain_source_successor(
  p_binding public.clued_agent_bindings, p_input jsonb
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  s constant text := 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
  task constant uuid := '1502fd80-8ff8-4adc-b4f5-da6d462f4f8a';
  subject constant jsonb := '{"definition_id":"clued.model-program.DatasetSplit","version":"v0.1","definition_sha256":"f51cefe8eccd0faa75b45e78380e5b389ed266ca4034b511a85f51771f2d4f77","instance_schema_sha256":"062860afd3dc16fa9ee1de27582439701a67b7c5976ad45981a7cca3e515468f"}';
  refs jsonb[]; r jsonb; a text; required text[]; g clued_private.owner_grants_v1%rowtype;
  protected jsonb := '[]'; rows jsonb := '{}'; m public.clued_memories%rowtype;
  stamp timestamptz := clock_timestamp(); row_key text; i integer; n integer;
  receipt public.clued_audit_receipts%rowtype; e public.clued_context_events%rowtype;
  nt clued_private.native_confirmation_tokens; nr public.clued_audit_receipts;
  granted_resources text[]; normal jsonb; recomputed text;
  owner_ids constant uuid[]:=array['b8c1d482-9eb4-4bc5-8dd1-372b0d55174e','46b0ff1c-f608-4ff9-89b9-dc90a61ce70f']::uuid[];
  owner_receipts constant uuid[]:=array['45a657d9-ba34-437e-b17c-2d792ce5c692','4c9b9066-5146-4bd5-9e5d-8660624fdecb']::uuid[];
  owner_hashes constant text[]:=array['b58db4fe2cc81c123f078aeff789fcc9fe971902321ffd36a9e3ebaa1af477eb','74fb324321a23eaa4dbc7194b9ec9964a9e1d59d1ef12e6c6f3c7dfce6b91329'];
begin
  if jsonb_typeof(p_input) is distinct from 'object' or
     (select array_agg(k order by k) from jsonb_object_keys(p_input) k) is distinct from
     array['permission_record_ref','producer_registration_ref','recognition_receipt_id','recognition_record_ref']::text[]
  then raise exception 'CALLER_CONTEXT_OR_UNKNOWN_FIELD' using errcode='22023'; end if;
  refs := array[p_input->'permission_record_ref',p_input->'producer_registration_ref',p_input->'recognition_record_ref'];
  foreach r in array refs loop
    if jsonb_typeof(r) is distinct from 'object' or
       (select array_agg(k order by k) from jsonb_object_keys(r) k) is distinct from array['content_hash','id','version']::text[] or
       coalesce(r->>'id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or
       jsonb_typeof(r->'version') is distinct from 'number' or coalesce(r->>'version','') !~ '^[1-9][0-9]*$' or
       (r->>'version')::numeric>9007199254740991 or
       coalesce(r->>'content_hash','') !~ '^[0-9a-f]{64}$'
    then raise exception 'REFERENCE_INVALID' using errcode='22023'; end if;
  end loop;
  if coalesce(p_input->>'recognition_receipt_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then raise exception 'RECEIPT_REFERENCE_INVALID' using errcode='22023'; end if;

  -- Protected catalog, not user-editable Canonical Record flags. Missing issuer
  -- fails BEFORE any canonical target/receipt/event SELECT below.
  foreach a in array array['model.dataset_split.verify','model.dataset_split.recognize','model.dataset_split.producer'] loop
    if not exists(select 1 from clued_private.owner_grant_actions c
       where c.action=a and 'model-domain'=any(c.doors))
    then raise exception 'DOMAIN_ISSUER_NOT_REGISTERED' using errcode='42501'; end if;
    r := case when a='model.dataset_split.producer' then refs[2] else refs[1] end;
    -- Existing Native Owner request normalization accepts registered record:
    -- resources. Do not invent scope:/model-subject: resource kinds.
    required := array['record:'||(r->>'id')||'@'||(r->>'version')||'#'||(r->>'content_hash')];
    select count(*) into n from clued_private.owner_grants_v1 x
      where x.user_id=p_binding.user_id and x.grantee_binding_id=p_binding.id and x.action=a
      and x.task_id=task and x.revoked_at is null and x.granted_at<=stamp and stamp<x.expires_at
      and x.expires_at-x.granted_at<=interval '1 hour' and x.max_uses is null
      and (select array_agg(z order by z) from unnest(x.resources) z)=
          (select array_agg(z order by z) from unnest(required) z);
    if n is distinct from 1 then raise exception 'INDEPENDENT_NATIVE_GRANT_MISSING_OR_AMBIGUOUS' using errcode='42501'; end if;
    select * into strict g from clued_private.owner_grants_v1 x
      where x.user_id=p_binding.user_id and x.grantee_binding_id=p_binding.id and x.action=a
      and x.task_id=task and x.revoked_at is null and x.granted_at<=stamp and stamp<x.expires_at
      and x.expires_at-x.granted_at<=interval '1 hour' and x.max_uses is null
      and (select array_agg(z order by z) from unnest(x.resources) z)=
          (select array_agg(z order by z) from unnest(required) z);
    -- Independently verify the existing real Native confirmation/Receipt.
    -- A row/foreign key, caller verified flag or another action's approval is insufficient.
    select * into nt from clued_private.native_confirmation_tokens x where x.id=g.token_id and x.user_id=p_binding.user_id;
    if not found then raise exception 'SOURCE_NATIVE_CONFIRMATION_REQUIRED' using errcode='42501'; end if;
    select * into nr from public.clued_audit_receipts x where x.id=g.receipt_id and x.user_id=p_binding.user_id;
    if not found then raise exception 'SOURCE_NATIVE_RECEIPT_REQUIRED' using errcode='42501'; end if;
    select array_agg(v order by v) into granted_resources from jsonb_array_elements_text(nt.native_choices->'resources') v;
    if nt.action is distinct from 'owner_grant' or nt.consume_outcome is distinct from 'committed' or nt.consumed_at is null or
       nt.consumed_receipt_id is distinct from g.receipt_id or nt.session_id is null or nt.session_id is distinct from g.granted_session_id or
       nt.consumed_at>nt.expires_at or nt.native_choices->>'action' is distinct from a or
       nt.native_choices->>'task_id' is distinct from task::text or nt.native_choices->>'grantee_binding_id' is distinct from p_binding.id::text or
       nt.native_choices->'max_uses' is distinct from 'null'::jsonb or
       clued_private.m1_sha256(nt.confirmation_view) is distinct from nt.view_digest or
       extract(epoch from (g.expires_at-g.granted_at)) is distinct from (nt.native_choices->>'expires_seconds')::numeric or
       granted_resources is distinct from required or nr.operation is distinct from 'owner_grant' or nr.binding_id is not null or
       nr.metadata->>'receipt_kind' is distinct from 'OWNER_GRANT_GIVEN' or nr.metadata->>'principal' is distinct from 'native_account_session' or
       nr.metadata->>'token_id' is distinct from nt.id::text or nr.metadata->>'view_digest' is distinct from nt.view_digest or
       nr.metadata->>'session_id' is distinct from nt.session_id or nr.metadata->'choices' is distinct from nt.native_choices
    then raise exception 'SOURCE_NATIVE_CONFIRMATION_NOT_EXACT' using errcode='42501'; end if;
    -- token_id / receipt_id FKs and private ACL are the existing Native Owner
    -- provenance. This function never creates/consumes/mutates a grant.
    protected := protected || jsonb_build_array(jsonb_build_object(
      'storage_source','clued_private.owner_grants_v1','id',g.id,'user_id',g.user_id,
      'grantee_binding_id',g.grantee_binding_id,'action',g.action,'resources',g.resources,
      'task_id',g.task_id,'token_id',g.token_id,'receipt_id',g.receipt_id,'max_uses',g.max_uses,
      'uses',g.uses,'granted_at',g.granted_at,'expires_at',g.expires_at,'revoked_at',g.revoked_at));
  end loop;

  for i in 1..3 loop
    r := refs[i]; row_key := (array['permission','producer','recognition'])[i];
    select * into m from public.clued_memories x
      where x.user_id=p_binding.user_id and x.id=(r->>'id')::uuid;
    if not found or m.record_schema_version is distinct from 1 or m.canonical_scope is distinct from s or
       m.lifecycle_status is distinct from 'active' or m.version::text is distinct from r->>'version' or
       m.content_hash is distinct from r->>'content_hash' or
       clued_private.record_currentness_fence(p_binding.user_id,m.id,array[s]) is distinct from 'CURRENT'
    then raise exception 'SERVER_RECORD_VERSION_HASH_OR_CURRENTNESS' using errcode='42501'; end if;
    normal:=clued_private.model_domain_normalize_row_successor(p_binding,m);
    rows:=rows||jsonb_build_object(row_key,normal);
  end loop;
  -- Full fixed Owner checks, independent of domain grant/projection flags.
  for i in 1..2 loop
    select * into m from public.clued_memories x where x.user_id=p_binding.user_id and x.id=owner_ids[i];
    if not found or m.version is distinct from 1 or m.record_schema_version is distinct from 1 or
       m.record_type is distinct from 'decision' or m.authority is distinct from 'user_explicit' or
       m.canonical_scope is distinct from s or m.lifecycle_status is distinct from 'active' or
       m.receipt_id is distinct from owner_receipts[i] or m.content_hash is distinct from owner_hashes[i] or
       clued_private.record_currentness_fence(p_binding.user_id,m.id,array[s]) is distinct from 'CURRENT'
    then raise exception 'SUCCESSOR_FIXED_OWNER_SOURCE_NOT_CURRENT' using errcode='42501'; end if;
    recomputed:=clued_private.m1_record_content_hash(m.record_type,m.canonical_scope,m.lifecycle_status,m.title,m.content,
      m.type_fields,m.relations,m.source_refs,m.source_unavailable_reason,m.authority,m.observed_at,m.closed_at,m.confidence,m.confidence_reason);
    if m.content_hash is distinct from recomputed then raise exception 'SUCCESSOR_OWNER_FULL_HASH_INVALID' using errcode='42501'; end if;
    rows:=rows||jsonb_build_object((array['adoption','recognizer'])[i],jsonb_build_object('id',m.id,'version',m.version,
      'content_hash',m.content_hash,'receipt_id',m.receipt_id,'type_fields',m.type_fields,
      'owner_transaction',clued_private.model_domain_owner_chain_successor(p_binding,m)));
  end loop;
  select * into receipt from public.clued_audit_receipts x
    where x.id=(p_input->>'recognition_receipt_id')::uuid and x.user_id=p_binding.user_id;
  if not found or receipt.status is distinct from 'committed' or receipt.operation_family is distinct from 'record_mutation' or
     cardinality(receipt.event_ids) is distinct from 1
  then raise exception 'RECEIPT_SOURCE_UNAVAILABLE_OR_NOT_COMMITTED' using errcode='42501'; end if;
  select * into e from public.clued_context_events x
    where x.user_id=p_binding.user_id and x.id::text=receipt.event_ids[1];
  if not found then raise exception 'EVENT_SOURCE_UNAVAILABLE' using errcode='42501'; end if;
  rows := rows || jsonb_build_object('receipt',jsonb_build_object(
    'id',receipt.id,'status',receipt.status,'operation_family',receipt.operation_family,
    'user_id',receipt.user_id,'binding_id',receipt.binding_id,'target_refs',receipt.target_refs,
    'committed_versions',receipt.committed_versions,'event_ids',receipt.event_ids,
    'canonical_version',receipt.canonical_version,'evaluated_at',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
    'event',jsonb_build_object('id',e.id::text,'canonical_event_type',e.canonical_event_type,
    'result',e.result,'receipt_id',e.receipt_id,'event_scope',e.event_scope,'target_refs',e.target_refs,
    'committed_canonical_version',e.committed_canonical_version,'actor_user_id',e.actor_user_id,
    'actor_binding_id',e.actor_binding_ref,'evaluated_at',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
  return jsonb_build_object('private_rows',rows,'native_grants',protected,
    'principal',jsonb_build_object('subject_id',p_binding.user_id,'binding_id',p_binding.id),
    'started_at',stamp,'subject',subject);
end $$;

create or replace function public.clued_model_dataset_split_verify_successor_candidate(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  s constant text := 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
  b public.clued_agent_bindings; after_b public.clued_agent_bindings;
  first jsonb; final jsonb; p jsonb; producer jsonb; recognition jsonb; receipt jsonb; event jsonb;
  principal jsonb; g jsonb; now_at timestamptz; expected_targets jsonb;
  permission_not_before timestamptz; permission_expires_at timestamptz;
begin
  b := clued_private.resolve_binding(p_token_hash,'context:read',s);
  first := clued_private.model_domain_source_successor(b,p_input);
  p:=first->'private_rows'->'permission'; producer:=first->'private_rows'->'producer';
  recognition:=first->'private_rows'->'recognition'; receipt:=first->'private_rows'->'receipt'; event:=first->'private_rows'->'event';
  principal:=first->'principal'; g:=p->'type_fields'->'domain_permission'; now_at:=clock_timestamp();
  if jsonb_typeof(g) is distinct from 'object' or (select array_agg(k order by k) from jsonb_object_keys(g) k) is distinct from array['action','canonical_scope','effect','environment','expires_at','not_before','principal','producer_registration_ref','revoked_at','status','subject']::text[] then raise exception 'DOMAIN_BINDING_SHAPE' using errcode='42501'; end if;
  -- JSON null becomes SQL NULL on ->> and casts: it must never turn a denial
  -- IF into NULL. Parse only present UTC strings and reject infinite instants.
  if jsonb_typeof(g->'not_before') is distinct from 'string' or
     jsonb_typeof(g->'expires_at') is distinct from 'string' or
     coalesce(g->>'not_before','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|\+00:00)$' or
     coalesce(g->>'expires_at','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|\+00:00)$'
  then raise exception 'DOMAIN_BINDING_TIME_INVALID' using errcode='42501'; end if;
  begin
    permission_not_before:=(g->>'not_before')::timestamptz;
    permission_expires_at:=(g->>'expires_at')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'DOMAIN_BINDING_TIME_INVALID' using errcode='42501';
  end;
  if permission_not_before is null or permission_expires_at is null or
     not isfinite(permission_not_before) or not isfinite(permission_expires_at) or
     to_char(permission_not_before at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS') is distinct from left(g->>'not_before',19) or
     to_char(permission_expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS') is distinct from left(g->>'expires_at',19) or
     permission_expires_at<=permission_not_before or
     permission_expires_at-permission_not_before>interval '1 hour'
  then raise exception 'DOMAIN_BINDING_TIME_INVALID' using errcode='42501'; end if;
  if p->>'record_type' is distinct from 'decision' or p->>'authority' is distinct from 'user_explicit' or
     producer->>'record_type' is distinct from 'state' or producer->>'authority' is distinct from 'user_explicit' or
     recognition->>'record_type' is distinct from 'state' or recognition->>'authority' is distinct from 'observed' or
     g->>'status' is distinct from 'active' or g->'revoked_at' is distinct from 'null'::jsonb or
     g->>'action' is distinct from 'DatasetSplit.definition.recognize' or g->>'effect' is distinct from 'NON_PRODUCTION_DEFINITION_RECOGNITION_ONLY' or
     g->>'environment' is distinct from 'NON_PRODUCTION' or g->>'canonical_scope' is distinct from s or g->'subject' is distinct from first->'subject' or
     g->'principal' is distinct from principal or g->'producer_registration_ref' is distinct from p_input->'producer_registration_ref' or
     permission_not_before>now_at or now_at>=permission_expires_at
  then raise exception 'DOMAIN_BINDING_INVALID' using errcode='42501'; end if;
  if producer->'type_fields'->>'state_kind' is distinct from 'model_dataset_split_domain_producer' or
     producer->'type_fields'->'domain_producer' is distinct from jsonb_build_object('service','clued-cloud/supabase',
     'role','EXISTING_MODEL_DOMAIN_AUTHORITY_DELEGATE','domain_owner','MODEL PROGRAM',
     'environment','NON_PRODUCTION','principal',principal,
     'authority_registry_sha256','b89bb15a047cd59390428e86d33e8e2fc59d3a83954c68c2393d0e5b3dc4f3cc')
  then raise exception 'PRODUCER_BINDING_INVALID' using errcode='42501'; end if;
  g:=recognition->'type_fields'->'domain_recognition';
  if recognition->'type_fields'->>'state_kind' is distinct from 'model_dataset_split_domain_recognition' or
     g->>'contract_sha256' is distinct from 'd8599ca8148f63a7893133ad3b13426edab25f3f48bc5291b1fb7c038a04754f' or
     g->'subject' is distinct from first->'subject' or g->'permission_record_ref' is distinct from p_input->'permission_record_ref' or
     g->'producer_registration_ref' is distinct from p_input->'producer_registration_ref' or
     g->'producer' is distinct from jsonb_build_object('service','clued-cloud/supabase','subject_id',b.user_id,'binding_id',b.id) or
     g->>'effect' is distinct from 'NON_PRODUCTION_DEFINITION_RECOGNITION_ONLY' or
     recognition->>'receipt_id' is distinct from receipt->>'id'
  then raise exception 'RECOGNITION_BINDING_INVALID' using errcode='42501'; end if;
  -- Complete nine-field recognition, original Owner adoption object and
  -- actor-free writer's separate exact server-source bindings are mandatory.
  if (select array_agg(k order by k) from jsonb_object_keys(g) k) is distinct from
       array['contract_id','contract_sha256','contract_version','effect','owner_adoption','permission_record_ref','producer','producer_registration_ref','subject']::text[] or
     g->>'contract_id' is distinct from 'clued.model-program.DatasetSplitDomainRecognition' or
     g->>'contract_version' is distinct from 'v0.1-candidate' or
     g->'owner_adoption' is distinct from $ADOPTION${"canonical_record_id":"b8c1d482-9eb4-4bc5-8dd1-372b0d55174e","record_version":1,"canonical_scope":"project:0597aa60-9b98-4da6-a4ab-63d7705b632f","record_content_sha256":"b58db4fe2cc81c123f078aeff789fcc9fe971902321ffd36a9e3ebaa1af477eb","canonical_receipt_id":"45a657d9-ba34-437e-b17c-2d792ce5c692","quote_evidence_id":"1257e89f-d6b6-4015-8712-0bab340cc1b4","quote_sha256":"905819e2e3a059a02087855e9f326d05c877c1767ec31dc012c5c44652840230","quote_size_bytes":6,"effect":"OWNER_BASELINE_ADOPTION_ONLY"}$ADOPTION$::jsonb or
     first->'private_rows'->'recognizer'->'type_fields'->'model_final_recognizer' is distinct from $DESIGNATION${"role":"OWNER","effect":"FINAL_RECOGNIZER_DESIGNATION_AND_NON_PRODUCTION_PREPARATION_ONLY","subject":{"version":"v0.1","definition_id":"clued.model-program.DatasetSplit","definition_sha256":"f51cefe8eccd0faa75b45e78380e5b389ed266ca4034b511a85f51771f2d4f77","instance_schema_sha256":"062860afd3dc16fa9ee1de27582439701a67b7c5976ad45981a7cca3e515468f"},"owner_subject_id":null,"production_enabled":false,"domain_permission_granted":false,"authenticated_identity_status":"NOT_EXPOSED_BY_CURRENT_MCP"}$DESIGNATION$::jsonb or
     recognition->'type_fields'->'owner_source_bindings' is distinct from jsonb_build_object(
       'owner_adoption_server_ref',jsonb_build_object('id',first->'private_rows'->'adoption'->>'id','version',1,'content_hash',first->'private_rows'->'adoption'->>'content_hash'),
       'final_recognizer_server_ref',jsonb_build_object('id',first->'private_rows'->'recognizer'->>'id','version',1,'content_hash',first->'private_rows'->'recognizer'->>'content_hash'),
       'hash_binding','ORIGINAL_EXACT_SERVER_HASH_GUARD_NO_BODY_HASH_FALLBACK')
  then raise exception 'SUCCESSOR_COMPLETE_OWNER_RECOGNITION_BINDING_REQUIRED' using errcode='42501'; end if;
  expected_targets:=jsonb_build_array(jsonb_build_object('id',recognition->>'id','kind','record','role','primary'));
  if receipt->>'user_id' is distinct from b.user_id::text or receipt->>'binding_id' is distinct from b.id::text or
     receipt->'target_refs' is distinct from expected_targets or
     receipt->'committed_versions' is distinct from jsonb_build_object(recognition->>'id',(recognition->>'version')::bigint) or
     event->>'receipt_id' is distinct from receipt->>'id' or event->>'event_scope' is distinct from s or
     event->'target_refs' is distinct from expected_targets or event->>'result' is distinct from 'success' or
     coalesce(event->>'canonical_event_type','') not in ('record_created','record_updated') or
     event->>'actor_user_id' is distinct from b.user_id::text or event->>'actor_binding_id' is distinct from b.id::text or
     jsonb_typeof(receipt->'canonical_version') is distinct from 'number' or
     (receipt->>'canonical_version')::bigint<=0 or
     event->'committed_canonical_version' is distinct from receipt->'canonical_version'
  then raise exception 'TRANSACTION_ACTOR_TARGET_OR_VERSION_INVALID' using errcode='42501'; end if;
  after_b:=clued_private.resolve_binding(p_token_hash,'context:read',s);
  final:=clued_private.model_domain_source_successor(after_b,p_input);
  if clock_timestamp()<(first->>'started_at')::timestamptz or
     clock_timestamp()-(first->>'started_at')::timestamptz>interval '5 minutes' or after_b.id is distinct from b.id or after_b.user_id is distinct from b.user_id or
     final->'native_grants' is distinct from first->'native_grants' or
     (select jsonb_object_agg(k,v-'evaluated_at') from jsonb_each(final->'private_rows') x(k,v))
       is distinct from (select jsonb_object_agg(k,v-'evaluated_at') from jsonb_each(first->'private_rows') x(k,v))
  then raise exception 'SOURCE_OR_AUTHORITY_CHANGED_DURING_READ' using errcode='42501'; end if;
  -- Sample after the last read, not entry time. Native window and original
  -- typed domain window must remain valid at acceptance.
  perform clued_private.resolve_binding(p_token_hash,'context:read',s);
  now_at:=clock_timestamp();
  if exists(select 1 from jsonb_array_elements(final->'native_grants') x
     where now_at<(x->>'granted_at')::timestamptz or now_at>=(x->>'expires_at')::timestamptz) or
     permission_not_before is null or permission_expires_at is null or
     now_at<permission_not_before or now_at>=permission_expires_at
  then raise exception 'AUTHORITY_EXPIRED_AFTER_FINAL_READ' using errcode='42501'; end if;
  -- Private IDs/actors/token hashes never leave the database.
  return jsonb_build_object('status','ACTOR_FREE_EXISTING_SOURCE_REFERENCES_READ_ONLY',
    'recognition_record_ref',p_input->'recognition_record_ref','recognition_receipt_ref',receipt->>'id',
    'recognition_event_ref',event->>'id','source_scope',s,
    'evaluated_at',to_char(now_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'authority_effect','NONE','actual_execution','NONE','m2_qualification','NOT_ISSUED',
    'domain_authority_receipt','NOT_ISSUED_BY_READER','data_gate','NOT_ISSUED','private_actor_fields_exposed',false);
end $$;

-- Keep both private helpers inaccessible. Only the distinct authenticated
-- public successor wrapper receives the minimal existing anon RPC privilege.
revoke all on function clued_private.model_domain_source_successor(public.clued_agent_bindings,jsonb),
  public.clued_model_dataset_split_verify_successor_candidate(text,jsonb) from public,anon,authenticated,service_role;
-- No catalog insertion, Owner grant, Canonical mutation or legacy redirection.


grant execute on function public.clued_model_dataset_split_verify_successor_candidate(text,jsonb) to anon;

