-- Exact CLI-created migration payload candidate; NOT APPLIED.
-- Base d73df0d28cb2a341fcc3ea34b2215454c95e0e13.
-- Source bodies below are raw byte-preserved copies; no Canonical/atomic writer.


-- BEGIN 01-readonly-source raw source
-- UNINSTALLED engineering candidate, main source 412e4954.
-- NOT a numbered migration; use `supabase migration new` at formal integration.
-- No tables, issuer registrations, Owner grants, producer grants or data writes.
-- Private normalization stays inside PostgreSQL; public wrapper returns refs only.
-- resolve_binding / record_currentness_fence / Owner confirmation storage are existing.

create or replace function clued_private.model_domain_source_candidate(
  p_binding public.clued_agent_bindings, p_input jsonb
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  s constant text := 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
  task constant uuid := '1502fd80-8ff8-4adc-b4f5-da6d462f4f8a';
  subject constant jsonb := '{"definition_id":"clued.model-program.DatasetSplit","version":"v0.1","definition_sha256":"f51cefe8eccd0faa75b45e78380e5b389ed266ca4034b511a85f51771f2d4f77","instance_schema_sha256":"062860afd3dc16fa9ee1de27582439701a67b7c5976ad45981a7cca3e515468f"}';
  subject_resource constant text := 'model-subject:clued.model-program.DatasetSplit/v0.1/f51cefe8eccd0faa75b45e78380e5b389ed266ca4034b511a85f51771f2d4f77/062860afd3dc16fa9ee1de27582439701a67b7c5976ad45981a7cca3e515468f';
  refs jsonb[]; r jsonb; a text; required text[]; g clued_private.owner_grants_v1%rowtype;
  protected jsonb := '[]'; rows jsonb := '{}'; m public.clued_memories%rowtype;
  stamp timestamptz := clock_timestamp(); row_key text; i integer; n integer;
  receipt public.clued_audit_receipts%rowtype; e public.clued_context_events%rowtype;
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
    rows := rows || jsonb_build_object(row_key,jsonb_build_object(
      'id',m.id,'version',m.version,'content_hash',m.content_hash,'canonical_scope',m.canonical_scope,
      'record_type',m.record_type,'authority',m.authority,'lifecycle_status',m.lifecycle_status,
      'type_fields',m.type_fields,'receipt_id',m.receipt_id,'record_currentness','CURRENT',
      'evaluated_at',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
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

create or replace function public.clued_model_dataset_split_verify_candidate(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  s constant text := 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
  b public.clued_agent_bindings; after_b public.clued_agent_bindings;
  first jsonb; final jsonb; p jsonb; producer jsonb; recognition jsonb; receipt jsonb; event jsonb;
  principal jsonb; g jsonb; now_at timestamptz; expected_targets jsonb;
  permission_not_before timestamptz; permission_expires_at timestamptz;
begin
  b := clued_private.resolve_binding(p_token_hash,'context:read',s);
  first := clued_private.model_domain_source_candidate(b,p_input);
  p:=first->'private_rows'->'permission'; producer:=first->'private_rows'->'producer';
  recognition:=first->'private_rows'->'recognition'; receipt:=first->'private_rows'->'receipt'; event:=first->'private_rows'->'event';
  principal:=first->'principal'; g:=p->'type_fields'->'domain_permission'; now_at:=clock_timestamp();
  if jsonb_typeof(g) is distinct from 'object' or not (g ?& array['status','revoked_at','action','effect','environment','canonical_scope','subject','principal','producer_registration_ref','not_before','expires_at']) then raise exception 'DOMAIN_BINDING_SHAPE' using errcode='42501'; end if;
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
  if producer->'type_fields'->'domain_producer' is distinct from jsonb_build_object('service','clued-cloud/supabase',
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
  final:=clued_private.model_domain_source_candidate(after_b,p_input);
  if clock_timestamp()<(first->>'started_at')::timestamptz or after_b.id is distinct from b.id or after_b.user_id is distinct from b.user_id or
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
  return jsonb_build_object('status','VERIFIED_EXISTING_SOURCE_REFERENCES_READ_ONLY',
    'recognition_record_ref',p_input->'recognition_record_ref','recognition_receipt_ref',receipt->>'id',
    'recognition_event_ref',event->>'id','source_scope',s,
    'evaluated_at',to_char(now_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'authority_effect','NONE','actual_execution','NONE','m2_qualification','NOT_ISSUED',
    'domain_authority_receipt','NOT_ISSUED_BY_READER','data_gate','NOT_ISSUED','private_actor_fields_exposed',false);
end $$;

-- Explicitly no runtime exposure in this candidate. Registration/read contracts
-- are separate; formal installation must use the existing migration/Owner door.
revoke all on function clued_private.model_domain_source_candidate(public.clued_agent_bindings,jsonb),
  public.clued_model_dataset_split_verify_candidate(text,jsonb) from public,anon,authenticated,service_role;
-- No GRANT EXECUTE here. No INSERT into issuer catalog or Owner grants here.

-- END 01-readonly-source raw source

-- BEGIN 02-neutral-model-projection-refs raw source
-- UNINSTALLED candidate. No numbered migration, DML or actual RPC grant.
-- Projection bootstrap only: this path does NOT call the domain verifier,
-- issue permission, accept a recognition, or satisfy any M2 qualification.
create or replace function public.clued_model_dataset_split_resolve_refs_candidate(
  p_token_hash text,p_input jsonb
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  s constant text := 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
  b public.clued_agent_bindings; final_b public.clued_agent_bindings;
  m public.clued_memories%rowtype; k text; i integer; pass integer;
  keys constant text[] := array['permission_record_id','producer_registration_id','recognition_record_id'];
  ref_keys constant text[] := array['permission_record_ref','producer_registration_ref','recognition_record_ref'];
  row_types constant text[] := array['decision','state','state'];
  row_authorities constant text[] := array['user_explicit','user_explicit','observed'];
  first_refs jsonb := '{}'; refs jsonb; first_rows jsonb; rows jsonb;
  evaluated_at timestamptz;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or
     (select array_agg(x order by x) from jsonb_object_keys(p_input) x) is distinct from keys
  then raise exception 'M2_REF_RESOLVER_INPUT_INVALID' using errcode='22023'; end if;
  foreach k in array keys loop
    if jsonb_typeof(p_input->k) is distinct from 'string' or
       coalesce(p_input->>k,'') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then raise exception 'M2_REF_RESOLVER_INPUT_INVALID' using errcode='22023'; end if;
  end loop;
  b:=clued_private.resolve_binding(p_token_hash,'context:read',s);
  for pass in 1..2 loop
    refs:='{}'; rows:='{}';
    for i in 1..3 loop
      select * into m from public.clued_memories x
        where x.user_id=b.user_id and x.id=(p_input->>keys[i])::uuid;
      if not found or m.record_schema_version is distinct from 1 or
         m.canonical_scope is distinct from s or m.lifecycle_status is distinct from 'active' or
         m.record_type is distinct from row_types[i] or m.authority is distinct from row_authorities[i] or
         m.version is null or m.version<=0 or m.version>9007199254740991 or
         coalesce(m.content_hash,'') !~ '^[0-9a-f]{64}$' or
         clued_private.record_currentness_fence(b.user_id,m.id,array[s]) is distinct from 'CURRENT' or
         (i=1 and jsonb_typeof(m.type_fields->'domain_permission') is distinct from 'object') or
         (i=2 and jsonb_typeof(m.type_fields->'domain_producer') is distinct from 'object') or
         (i=3 and m.type_fields->>'state_kind' is distinct from 'model_dataset_split_domain_recognition')
      then raise exception 'M2_REF_PROJECTION_NOT_CURRENT_OR_NOT_FIXED_KIND' using errcode='42501'; end if;
      refs:=refs||jsonb_build_object(ref_keys[i],jsonb_build_object('id',m.id,'version',m.version,'content_hash',m.content_hash));
      rows:=rows||jsonb_build_object(ref_keys[i],jsonb_build_object('type_fields',m.type_fields,'receipt_id',m.receipt_id));
    end loop;
    if pass=1 then first_refs:=refs; first_rows:=rows;
    elsif refs is distinct from first_refs or rows is distinct from first_rows then
      raise exception 'M2_REF_PROJECTION_CHANGED_DURING_READ' using errcode='42501';
    end if;
    final_b:=clued_private.resolve_binding(p_token_hash,'context:read',s);
    if final_b.id is distinct from b.id or final_b.user_id is distinct from b.user_id then
      raise exception 'M2_REF_BINDING_CHANGED_DURING_READ' using errcode='42501';
    end if;
  end loop;
  evaluated_at:=clock_timestamp();
  return refs||jsonb_build_object('status','RESOLVED_EXISTING_PROJECTION_REFERENCES_READ_ONLY',
    'source_scope',s,'evaluated_at',to_char(evaluated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'projection_only',true,'authority_effect','NONE','actual_execution','NONE','m2_qualification','NOT_ISSUED');
end $$;
revoke all on function public.clued_model_dataset_split_resolve_refs_candidate(text,jsonb)
  from public,anon,authenticated,service_role;

-- END 02-neutral-model-projection-refs raw source

-- BEGIN 03-neutral-fixed-owner-anchor-refs raw source
-- UNINSTALLED neutral projection bootstrap. No public HTTP/MCP registration.
-- Existing Binding context:read + exact fixed Project only; emits two refs,
-- not a domain grant, actor DTO, Owner adoption Receipt or Kernel authority.
create or replace function public.clued_model_dataset_split_owner_anchor_refs_candidate(
 p_token_hash text,p_input jsonb
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
 s constant text:='project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
 ids constant uuid[]:=array['b8c1d482-9eb4-4bc5-8dd1-372b0d55174e','46b0ff1c-f608-4ff9-89b9-dc90a61ce70f']::uuid[];
 receipts constant uuid[]:=array['45a657d9-ba34-437e-b17c-2d792ce5c692','4c9b9066-5146-4bd5-9e5d-8660624fdecb']::uuid[];
 keys constant text[]:=array['owner_adoption_server_ref','final_recognizer_server_ref'];
 b public.clued_agent_bindings; final_b public.clued_agent_bindings;m public.clued_memories;
 rows jsonb; first_rows jsonb; refs jsonb; i integer; pass integer; recomputed text;
begin
 if p_input is distinct from '{"schema":"clued.model-owner-anchor-refs/1"}'::jsonb
 then raise exception 'FIXED_OWNER_REFS_INPUT_REQUIRED' using errcode='22023'; end if;
 b:=clued_private.resolve_binding(p_token_hash,'context:read',s);
 for pass in 1..2 loop
  rows:='{}';refs:='{}';
  for i in 1..2 loop
   select * into m from public.clued_memories x where x.user_id=b.user_id and x.id=ids[i];
   if not found or m.record_schema_version is distinct from 1 or m.version is distinct from 1 or
      m.record_type is distinct from 'decision' or m.authority is distinct from 'user_explicit' or
      m.canonical_scope is distinct from s or m.lifecycle_status is distinct from 'active' or
      m.receipt_id is distinct from receipts[i] or
      clued_private.record_currentness_fence(b.user_id,m.id,array[s]) is distinct from 'CURRENT'
   then raise exception 'FIXED_OWNER_ANCHOR_NOT_CURRENT' using errcode='42501'; end if;
   recomputed:=clued_private.m1_record_content_hash(m.record_type,m.canonical_scope,m.lifecycle_status,m.title,m.content,
     m.type_fields,m.relations,m.source_refs,m.source_unavailable_reason,m.authority,m.observed_at,m.closed_at,m.confidence,m.confidence_reason);
   if m.content_hash is distinct from recomputed or coalesce(recomputed,'') !~ '^[0-9a-f]{64}$'
   then raise exception 'OWNER_SERVER_FULL_RECORD_HASH_INVALID' using errcode='42501'; end if;
   refs:=refs||jsonb_build_object(keys[i],jsonb_build_object('id',m.id,'version',m.version,'content_hash',m.content_hash));
   rows:=rows||jsonb_build_object(keys[i],jsonb_build_object('ref',refs->keys[i],'type_fields',m.type_fields,'receipt_id',m.receipt_id));
  end loop;
  if pass=1 then first_rows:=rows;
  elsif rows is distinct from first_rows then raise exception 'OWNER_ANCHOR_CHANGED_DURING_READ' using errcode='42501'; end if;
  final_b:=clued_private.resolve_binding(p_token_hash,'context:read',s);
  if final_b.id is distinct from b.id or final_b.user_id is distinct from b.user_id then
   raise exception 'OWNER_ANCHOR_BINDING_CHANGED' using errcode='42501'; end if;
 end loop;
 return refs||jsonb_build_object('status','OWNER_ANCHOR_PROJECTION_REFS_ONLY','projection_only',true,
   'source_scope',s,'authority_effect','NONE','domain_permission','NOT_GRANTED','m2_verdict','NOT_ISSUED');
end $$;
revoke all on function public.clued_model_dataset_split_owner_anchor_refs_candidate(text,jsonb)
 from public,anon,authenticated,service_role;

-- END 03-neutral-fixed-owner-anchor-refs raw source

-- BEGIN 04-readonly-action-registration-and-two-anon-RPCs raw source
-- UNINSTALLED registration/transport permission candidate, not a migration.
-- Formal integration: obtain actual CLI migration filename, reviewed exact
-- commit, migration.production and release.production through existing doors.
-- Read-only source functions must be installed from their reviewed bytes first.
-- No Owner grants, producer rows or Canonical records are created here.
-- Plain INSERT intentionally refuses any already-registered action instead
-- of silently widening/replacing its authority or risk classification.
insert into clued_private.owner_grant_actions(action,doors,title,risk) values
 ('model.dataset_split.verify',array['model-domain'],'核验第一方模型 DatasetSplit 的固定非生产来源（精确记录，仅当前连接、≤1小时）','high'),
 ('model.dataset_split.recognize',array['model-domain'],'允许第一方模型 DatasetSplit 的固定非生产认定来源（精确权限记录，仅当前连接、≤1小时）','high'),
 ('model.dataset_split.producer',array['model-domain'],'登记第一方模型 DatasetSplit 固定非生产来源生产者（精确记录，仅当前连接、≤1小时）','high');
-- Existing Worker supabaseRequest Binding RPCs use the anon PostgREST role.
-- Grant only these two minimized functions, never the private source helper
-- or SELECT/DML over protected tables. Each RPC authenticates its own Binding.
grant execute on function public.clued_model_dataset_split_verify_candidate(text,jsonb),
  public.clued_model_dataset_split_resolve_refs_candidate(text,jsonb) to anon;
notify pgrst,'reload schema';

-- END 04-readonly-action-registration-and-two-anon-RPCs raw source

-- 05-minimum neutral fixed-owner reference transport permission only.
-- No action/bootstrap/producer/Owner grant or write function is registered here.
grant execute on function public.clued_model_dataset_split_owner_anchor_refs_candidate(text,jsonb) to anon;
notify pgrst,'reload schema';
