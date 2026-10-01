-- A task's relations.depends_on is read by clued_private.currentness_vector:
-- every entry must name a task of the same user that the reading binding can
-- see, otherwise the vector sets dependency_unknown and the whole context is
-- STALE for every session until someone edits the record by hand. Writes used
-- to accept any value there (2026-10-01: a task depending on a Decision
-- blocked every checkpoint in its project).
--
-- record_mutation_core now refuses a task write that introduces or changes
-- depends_on unless each entry is a uuid string naming another task of the
-- same user, readable by the writing binding. Writes that leave depends_on
-- untouched are not checked, so existing records (all terminal in production
-- when this shipped) can still be updated, closed and restored.

create or replace function clued_private.task_dependency_error_v1(
  p_user_id uuid,p_binding_id uuid,p_record_id uuid,p_relations jsonb
) returns text language plpgsql stable security definer set search_path='' as $$
declare v_entry jsonb; v_target public.clued_memories%rowtype;
  v_binding public.clued_agent_bindings%rowtype;
begin
  if p_relations is null or not (p_relations ? 'depends_on') then return null; end if;
  if jsonb_typeof(p_relations->'depends_on')<>'array' then
    return 'invalid_dependency_target';
  end if;
  if p_binding_id is not null then
    select * into v_binding from public.clued_agent_bindings
      where id=p_binding_id and user_id=p_user_id;
    if not found then return 'invalid_dependency_target'; end if;
  end if;
  for v_entry in select e from jsonb_array_elements(p_relations->'depends_on') e loop
    if jsonb_typeof(v_entry)<>'string' or v_entry#>>'{}' !~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return 'invalid_dependency_target';
    end if;
    select * into v_target from public.clued_memories m
      where m.user_id=p_user_id and m.id::text=lower(v_entry#>>'{}')
        and m.record_type='task';
    -- Missing, not a task, or the record itself: all read as unknown by the
    -- currentness vector. One code, so the result does not reveal which.
    if not found or v_target.id=p_record_id then return 'invalid_dependency_target'; end if;
    -- Same readability rule as currentness_vector; an unreadable target is
    -- reported like a missing one so writes cannot probe other scopes.
    if p_binding_id is not null and not (
      ('*'=any(v_binding.context_keys) or v_target.canonical_scope=any(v_binding.context_keys))
      and (not exists(select 1 from clued_private.authorizations_v12 a
        where a.binding_id=p_binding_id)
        or 'read'=any(clued_private.authorization_effective_actions_v13(
          p_binding_id,'scope',v_target.canonical_scope,'canonical')))) then
      return 'invalid_dependency_target';
    end if;
  end loop;
  return null;
end $$;
revoke all on function clued_private.task_dependency_error_v1(uuid,uuid,uuid,jsonb)
  from public,anon,authenticated,service_role;

-- Patch both the create and the update branch right after shape validation,
-- as 20260922143312 did for execution intents. On create v_record is still
-- null, so any depends_on counts as introduced.
do $migration$
declare body text;
  anchor text:='perform clued_private.m1_validate_record_shape(v_record_type,v_schema,v_type_fields,v_relations);';
  guard text:=$guard$
      if v_record_type='task' and v_relations->'depends_on' is distinct from v_record.relations->'depends_on' then
        v_error:=clued_private.task_dependency_error_v1(p_user_id,p_binding_id,v_id,v_relations);
        if v_error is not null then raise exception '%',v_error using errcode='22023'; end if;
      end if;
$guard$;
begin
  body:=pg_get_functiondef('clued_private.record_mutation_core(uuid,uuid,jsonb,text)'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>2
    or strpos(body,'task_dependency_error_v1')>0
    then raise exception 'task_dependency_core_definition_mismatch'; end if;
  execute replace(body,anchor,anchor||guard);
end $migration$;
