-- Context v2: current_action is a verified rendering of one canonical Task.
-- Existing projection tables, builder grants and Currentness CAS remain owners.
create function clued_private.frontier_rule_digest_v2()
returns text language sql stable security definer set search_path='' as $$
  select clued_private.currentness_hash(coalesce(jsonb_agg(jsonb_build_object(
    'id',rule_id,'version',rule_schema_version,'digest',rule_digest) order by rule_id),'[]'))
  from clued_private.projection_dependency_registry where status='active'
$$;
revoke all on function clued_private.frontier_rule_digest_v2() from public,anon,authenticated,service_role;

create function clued_private.frontier_task_source_v2(p_user_id uuid,p_fields jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t public.clued_memories%rowtype; source jsonb:=p_fields->'source_task';
  result jsonb:=jsonb_build_object('status','PROJECTION_REQUIRED','action',null,'source_refs','[]'::jsonb);
  action jsonb;
begin
  if jsonb_typeof(source) is distinct from 'object'
    or p_fields->>'render_rule_version' is distinct from 'task-body.v1'
    or p_fields->>'rule_set_digest' is distinct from clued_private.frontier_rule_digest_v2()
    then return result; end if;
  select * into t from public.clued_memories where user_id=p_user_id
    and id::text=source->>'id' and version::text=source->>'version'
    and canonical_scope=source->>'scope' and record_type='task'
    and record_schema_version is not null and lifecycle_status='active'
    and type_fields->>'execution_bucket'='now';
  if not found or t.type_fields ? 'projection_key'
    or exists(select 1 from clued_private.projection_record_bindings where record_id=t.id)
    or clued_private.record_currentness_fence(p_user_id,t.id,null::text[])<>'CURRENT'
    then return result; end if;
  -- The existing project unique-now rule must be resolved before Global can
  -- reference it. Unknown governance-intent relations cannot mint a Task.
  if (select count(*) from public.clued_memories m where m.user_id=p_user_id
      and m.canonical_scope=t.canonical_scope and m.record_type='task'
      and m.lifecycle_status='active' and m.type_fields->>'execution_bucket'='now'
      and clued_private.record_currentness_fence(p_user_id,m.id,null::text[])='CURRENT')<>1
    then return result; end if;
  action:=jsonb_build_object('title',t.title,'content',t.content);
  if p_fields ? 'current_action' and p_fields->'current_action' is distinct from action
    then return result; end if;
  return jsonb_build_object('status','RESOLVED','action',action,
    'source_refs',jsonb_build_array(jsonb_build_object('kind','record','id',t.id,
      'version',t.version,'scope',t.canonical_scope)),
    'render_rule_version','task-body.v1','rule_set_digest',clued_private.frontier_rule_digest_v2());
end $$;
revoke all on function clued_private.frontier_task_source_v2(uuid,jsonb) from public,anon,authenticated,service_role;

-- Keep the existing project resolver; replace only the unsafe Global cache read.
alter function clued_private.authoritative_current_action_v1(uuid,text)
  rename to authoritative_current_action_before_v2;
revoke all on function clued_private.authoritative_current_action_before_v2(uuid,text)
  from public,anon,authenticated,service_role;
create function clued_private.authoritative_current_action_v1(p_user_id uuid,p_context_key text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare m public.clued_memories%rowtype; result jsonb;
begin
  if p_context_key<>'global' then
    return clued_private.authoritative_current_action_before_v2(p_user_id,p_context_key);
  end if;
  select r.* into m from clued_private.projection_record_bindings b
    join public.clued_memories r on r.id=b.record_id and r.user_id=b.user_id
    where b.user_id=p_user_id and b.target_scope='global'
      and b.projection_key='global.priority_frontier'
      and clued_private.record_currentness_fence(p_user_id,r.id,array['global'])='CURRENT'
    order by b.projection_generation desc,r.id limit 1;
  result:=clued_private.frontier_task_source_v2(p_user_id,coalesce(m.type_fields,'{}'));
  return result||jsonb_build_object('resolver','global_frontier',
    'source_vector_digest',clued_private.currentness_hash(jsonb_build_object(
      'source_refs',result->'source_refs','projection',clued_private.projection_source_snapshot(p_user_id),
      'rule_set_digest',clued_private.frontier_rule_digest_v2())));
end $$;
revoke all on function clued_private.authoritative_current_action_v1(uuid,text)
  from public,anon,authenticated,service_role;

-- Bind protected consumers to the live reader. A source reference never grants
-- access to its Scope. Redaction uses one fixed envelope, without hidden IDs.
create function clued_private.authoritative_current_action_v1(p_user_id uuid,p_context_key text,p_binding_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare b public.clued_agent_bindings%rowtype; result jsonb; ref jsonb; scope text;
  unavailable jsonb:=jsonb_build_object('status','PROJECTION_REQUIRED','action',null,
    'source_refs','[]'::jsonb,'resolver','authorized_task','source_vector_digest',null);
begin
  select * into b from public.clued_agent_bindings where id=p_binding_id and user_id=p_user_id;
  if not found then return unavailable; end if;
  -- A restricted Binding cannot establish complete Global arbitration coverage.
  -- This is based on its grant, not the existence/count of hidden sources.
  if p_context_key='global' and (not '*'=any(b.context_keys) or
    exists(select 1 from clued_private.authorizations_v12 where binding_id=b.id))
    then return unavailable; end if;
  result:=clued_private.authoritative_current_action_v1(p_user_id,p_context_key);
  for scope in select p_context_key union select r->>'scope'
    from jsonb_array_elements(coalesce(result->'source_refs','[]')) r
  loop
    if not ('*'=any(b.context_keys) or scope=any(b.context_keys))
      or (exists(select 1 from clued_private.authorizations_v12 where binding_id=b.id)
        and not 'read'=any(clued_private.authorization_effective_actions_v13(b.id,'scope',scope,'canonical')))
      then return unavailable; end if;
  end loop;
  return result||jsonb_build_object('execution_authorization','NOT_GRANTED',
    'execution_eligibility','UNKNOWN','required_action_checks',
    jsonb_build_array('live_binding','exact_target_operation_environment','source_version','phase_gate','dependencies'));
end $$;
revoke all on function clued_private.authoritative_current_action_v1(uuid,text,uuid)
  from public,anon,authenticated,service_role;

do $migration$
declare body text; anchor text;
begin
  body:=pg_get_functiondef('public.clued_mcp_restore(text,jsonb)'::regprocedure);
  anchor:='clued_private.authoritative_current_action_v1(v_binding.user_id,v_scope)';
  if strpos(body,anchor)=0 then raise exception 'frontier_restore_definition_mismatch'; end if;
  execute replace(body,anchor,'clued_private.authoritative_current_action_v1(v_binding.user_id,v_scope,v_binding.id)');
  body:=pg_get_functiondef('public.clued_mcp_currentness_g6_gate(text,jsonb)'::regprocedure);
  body:=replace(body,'v_binding.user_id,v_project_scope);','v_binding.user_id,v_project_scope,v_binding.id);');
  body:=replace(body,$a$v_binding.user_id,'global');$a$,$b$v_binding.user_id,'global',v_binding.id);$b$);
  body:=replace(body,$a$in ('BLOCKED','AMBIGUOUS','PROJECTION_REQUIRED')$a$,$b$not in ('RESOLVED','NONE')$b$);
  execute body;
  body:=pg_get_functiondef('public.clued_mcp_projection_rebuild(text,jsonb)'::regprocedure);
  anchor:='  perform clued_private.currentness_user_lock(v_binding.user_id);';
  if strpos(body,anchor)=0 then raise exception 'frontier_builder_auth_definition_mismatch'; end if;
  body:=replace(body,anchor,$guard$
  if v_key='global.priority_frontier' and (not '*'=any(v_binding.context_keys) or
    exists(select 1 from clued_private.authorizations_v12 where binding_id=v_binding.id))
    then raise exception 'frontier_source_coverage_not_authorized' using errcode='42501'; end if;
$guard$||anchor);
  anchor:='  select coalesce(max(h.projection_generation),0)+1 into v_generation';
  if strpos(body,anchor)=0 then raise exception 'frontier_builder_definition_mismatch'; end if;
  execute replace(body,anchor,$guard$
  if v_key='global.priority_frontier' and
    clued_private.frontier_task_source_v2(v_binding.user_id,v_record.type_fields)->>'status'<>'RESOLVED'
    then raise exception 'frontier_source_contract_required' using errcode='40001'; end if;
$guard$||anchor);
end $migration$;
