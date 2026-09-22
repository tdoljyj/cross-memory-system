-- Stable execution identity lives on the existing Canonical Task; no second
-- queue or intent store. The intent must first be named by its governance source.
create unique index clued_task_execution_intent_v2 on public.clued_memories
  (user_id,((type_fields->'execution_intent')->>'id'))
  where record_type='task' and record_schema_version is not null
    and type_fields->'execution_intent'->>'id' is not null;

create function clued_private.execution_intent_error_v2(
  p_user_id uuid,p_binding_id uuid,p_record_id uuid,p_fields jsonb
) returns text language plpgsql stable security definer set search_path='' as $$
declare intent jsonb:=p_fields->'execution_intent'; source public.clued_memories%rowtype;
  b public.clued_agent_bindings%rowtype; old_intent text;
begin
  select type_fields->'execution_intent'->>'id' into old_intent
    from public.clued_memories where user_id=p_user_id and id=p_record_id;
  if old_intent is not null and old_intent is distinct from intent->>'id'
    then return 'execution_intent_identity_immutable'; end if;
  if intent is null then return null; end if;
  if jsonb_typeof(intent) is distinct from 'object'
    or coalesce(intent->>'id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(intent->>'source_version','') !~ '^[1-9][0-9]*$'
    then return 'execution_intent_contract_required'; end if;
  select * into source from public.clued_memories where user_id=p_user_id
    and id::text=intent->>'source_id' and version::text=intent->>'source_version'
    and canonical_scope=intent->>'source_scope' and lifecycle_status='active';
  if not found then return 'execution_intent_source_unavailable'; end if;
  if p_binding_id is not null then
    select * into b from public.clued_agent_bindings where user_id=p_user_id and id=p_binding_id;
    if not found or not ('*'=any(b.context_keys) or source.canonical_scope=any(b.context_keys))
      or (exists(select 1 from clued_private.authorizations_v12 where binding_id=b.id)
        and not 'read'=any(clued_private.authorization_effective_actions_v13(
          b.id,'scope',source.canonical_scope,'canonical')))
      then return 'execution_intent_source_unavailable'; end if;
  end if;
  if source.record_type='task' then return 'execution_intent_reuse_existing_task'; end if;
  if clued_private.record_currentness_fence(p_user_id,source.id,array[source.canonical_scope])<>'CURRENT'
    then return 'execution_intent_source_unavailable'; end if;
  if source.authority<>'user_explicit'
    or jsonb_typeof(source.type_fields->'execution_intents') is distinct from 'array'
    or not exists(select 1 from jsonb_array_elements(source.type_fields->'execution_intents') i
      where i->>'id'=intent->>'id' and nullif(btrim(i->>'completion_criteria'),'') is not null)
    then return 'execution_intent_not_registered'; end if;
  if exists(select 1 from public.clued_memories where user_id=p_user_id and id<>p_record_id
    and record_type='task' and record_schema_version is not null
    and type_fields->'execution_intent'->>'id'=intent->>'id')
    then return 'execution_intent_identity_conflict'; end if;
  return null;
end $$;
revoke all on function clued_private.execution_intent_error_v2(uuid,uuid,uuid,jsonb)
  from public,anon,authenticated,service_role;

do $migration$
declare body text; anchor text:='      perform clued_private.m1_validate_record_shape(v_record_type,v_schema,v_type_fields,v_relations);';
  guard text:=$guard$
      if v_record_type='task' and v_operation<>'close' then
        v_error:=clued_private.execution_intent_error_v2(p_user_id,p_binding_id,v_id,v_type_fields);
        if v_error is not null then raise exception '%',v_error using errcode='22023'; end if;
      end if;
$guard$;
begin
  body:=pg_get_functiondef('clued_private.record_mutation_core(uuid,uuid,jsonb,text)'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>2
    then raise exception 'execution_intent_core_definition_mismatch'; end if;
  execute replace(body,anchor,anchor||guard);
end $migration$;

create function clued_private.execution_intent_identity_immutable_v2()
returns trigger language plpgsql set search_path='' as $$
begin
  if old.record_type='task' and old.type_fields->'execution_intent'->>'id' is not null
    and old.type_fields->'execution_intent'->>'id' is distinct from new.type_fields->'execution_intent'->>'id'
    then raise exception 'execution_intent_identity_immutable' using errcode='22023'; end if;
  return new;
end $$;
revoke all on function clued_private.execution_intent_identity_immutable_v2()
  from public,anon,authenticated,service_role;
create trigger execution_intent_identity_immutable_v2 before update on public.clued_memories
  for each row execute function clued_private.execution_intent_identity_immutable_v2();

do $migration$
declare body text; anchor text;
begin
  body:=pg_get_functiondef('clued_private.frontier_task_source_v2(uuid,jsonb)'::regprocedure);
  anchor:='  action:=jsonb_build_object(''title'',t.title,''content'',t.content);';
  if strpos(body,anchor)=0 then raise exception 'execution_intent_frontier_definition_mismatch'; end if;
  execute replace(body,anchor,$guard$
  if clued_private.execution_intent_error_v2(p_user_id,null,t.id,t.type_fields) is not null
    then return result; end if;
$guard$||anchor);
  body:=pg_get_functiondef('clued_private.authoritative_current_action_v1(uuid,text,uuid)'::regprocedure);
  anchor:='  return result||jsonb_build_object(''execution_authorization'',''NOT_GRANTED'',';
  if strpos(body,anchor)=0 then raise exception 'execution_intent_reader_definition_mismatch'; end if;
  execute replace(body,anchor,$guard$
  for ref in select r from jsonb_array_elements(coalesce(result->'source_refs','[]')) r loop
    if exists(select 1 from public.clued_memories t where t.user_id=p_user_id and t.id::text=ref->>'id'
      and clued_private.execution_intent_error_v2(p_user_id,b.id,t.id,t.type_fields) is not null)
      then return unavailable; end if;
  end loop;
$guard$||anchor);
end $migration$;

-- All current consumers, including metadata-blind list/search, share this fence.
alter function clued_private.record_currentness_fence(uuid,uuid,text[])
  rename to record_currentness_fence_before_intent_v2;
revoke all on function clued_private.record_currentness_fence_before_intent_v2(uuid,uuid,text[])
  from public,anon,authenticated,service_role;
create function clued_private.record_currentness_fence(p_user_id uuid,p_record_id uuid,p_authorized_scopes text[])
returns text language plpgsql stable security definer set search_path='' as $$
declare status text; t public.clued_memories%rowtype;
begin
  status:=clued_private.record_currentness_fence_before_intent_v2(p_user_id,p_record_id,p_authorized_scopes);
  if status<>'CURRENT' then return status; end if;
  select * into t from public.clued_memories where user_id=p_user_id and id=p_record_id and record_type='task';
  if found and t.type_fields ? 'execution_intent' then
    if p_authorized_scopes is not null and not (t.type_fields->'execution_intent'->>'source_scope')=any(p_authorized_scopes)
      then return 'UNKNOWN'; end if;
    if clued_private.execution_intent_error_v2(p_user_id,null,t.id,t.type_fields) is not null
      then return 'UNKNOWN'; end if;
  end if;
  return status;
end $$;
revoke all on function clued_private.record_currentness_fence(uuid,uuid,text[])
  from public,anon,authenticated,service_role;

do $migration$
declare body text; anchor text:=$anchor$  return jsonb_build_object('schema','clued.currentness-vector.v1',$anchor$;
begin
  body:=pg_get_functiondef('clued_private.currentness_vector(uuid,text,uuid)'::regprocedure);
  if strpos(body,anchor)=0 then raise exception 'execution_intent_vector_definition_mismatch'; end if;
  execute replace(body,anchor,$guard$
  if exists(select 1 from public.clued_memories t where t.user_id=p_user_id
    and t.canonical_scope=p_context_key and t.record_type='task' and t.lifecycle_status='active'
    and t.type_fields ? 'execution_intent'
    and clued_private.execution_intent_error_v2(p_user_id,p_binding_id,t.id,t.type_fields) is not null)
    then v_dependency_unknown:=true; end if;
$guard$||anchor);
end $migration$;

do $migration$
declare body text;
begin
  body:=pg_get_functiondef('clued_private.authoritative_current_action_before_v2(uuid,text)'::regprocedure);
  -- This private owner resolver computes candidates; its protected caller
  -- validates every Task and intent source against the actual Binding.
  execute replace(body,'array[p_context_key]::text[]','null::text[]');
end $migration$;

do $migration$
declare body text; anchor text:='  result:=clued_private.authoritative_current_action_v1(p_user_id,p_context_key);';
begin
  body:=pg_get_functiondef('clued_private.authoritative_current_action_v1(uuid,text,uuid)'::regprocedure);
  if strpos(body,anchor)=0 then raise exception 'execution_intent_omission_definition_mismatch'; end if;
  execute replace(body,anchor,$guard$
  if not ('*'=any(b.context_keys) or p_context_key=any(b.context_keys))
    or (exists(select 1 from clued_private.authorizations_v12 where binding_id=b.id)
      and not 'read'=any(clued_private.authorization_effective_actions_v13(b.id,'scope',p_context_key,'canonical')))
    then return unavailable; end if;
  if p_context_key<>'global' and exists(select 1 from public.clued_memories t
    where t.user_id=p_user_id and t.canonical_scope=p_context_key and t.record_type='task'
      and t.lifecycle_status='active' and t.type_fields->>'execution_bucket'='now'
      and t.type_fields ? 'execution_intent'
      and clued_private.execution_intent_error_v2(p_user_id,b.id,t.id,t.type_fields) is not null)
    then return unavailable; end if;
$guard$||anchor);
end $migration$;
