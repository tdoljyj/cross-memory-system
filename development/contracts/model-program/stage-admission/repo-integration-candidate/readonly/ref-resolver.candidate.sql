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
