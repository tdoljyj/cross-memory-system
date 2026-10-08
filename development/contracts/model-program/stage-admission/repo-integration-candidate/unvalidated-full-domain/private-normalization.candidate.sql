-- UNINSTALLED server-private normalization candidate. Not an authorizer or
-- standalone reader. Only the guarded M2 source may call AFTER its real
-- Native grants and exact resource checks, before emitting any public DTO.
-- It returns private identities to private guard code, never to MCP/HTTP.
create or replace function clued_private.model_domain_normalize_row_candidate(
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
   principal:=jsonb_build_object('subject_id',r.user_id,'binding_id',r.binding_id);
   if p_record.record_type='decision' and jsonb_typeof(fields->'domain_permission')='object' then
     if fields->'domain_permission' ? 'principal' then raise exception 'PRIVATE_IDENTITY_MUST_NOT_BE_PERSISTED' using errcode='42501'; end if;
     fields:=jsonb_set(fields,'{domain_permission,principal}',principal,true);
   elsif p_record.record_type='state' and fields->>'state_kind'='model_dataset_split_domain_producer' then
     if fields->'domain_producer' ? 'principal' then raise exception 'PRIVATE_IDENTITY_MUST_NOT_BE_PERSISTED' using errcode='42501'; end if;
     fields:=jsonb_set(fields,'{domain_producer,principal}',principal,true);
   elsif p_record.record_type='state' and fields->>'state_kind'='model_dataset_split_domain_recognition' then
     if fields->'domain_recognition'->'producer' ?| array['subject_id','binding_id'] then
       raise exception 'PRIVATE_IDENTITY_MUST_NOT_BE_PERSISTED' using errcode='42501'; end if;
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
revoke all on function clued_private.model_domain_normalize_row_candidate(public.clued_agent_bindings,public.clued_memories)
 from public,anon,authenticated,service_role;
-- No GRANT, routes, Native permission, M1 mutation or public Actor projection.
