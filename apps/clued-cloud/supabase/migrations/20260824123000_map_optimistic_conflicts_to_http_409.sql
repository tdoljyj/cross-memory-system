-- Map application-level optimistic version conflicts to PostgREST HTTP 409.
-- The private cores retain SQLSTATE 40001 for direct transactional callers;
-- public Data API wrappers translate only the two known business conflicts.

create or replace function public.clued_record_write(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',case when p_input->>'scope'='project' then 'project:'||(p_input->>'project_id') else 'global' end);
  return clued_private.record_write_core(v_binding.user_id,v_binding.id,p_input);
exception when serialization_failure then
  if sqlerrm='record_version_conflict' then
    raise exception 'record_version_conflict' using errcode='23505';
  end if;
  raise;
end $$;

create or replace function public.clued_user_record_write(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  return clued_private.record_write_core((select auth.uid()),null,p_input);
exception when serialization_failure then
  if sqlerrm='record_version_conflict' then
    raise exception 'record_version_conflict' using errcode='23505';
  end if;
  raise;
end $$;

create or replace function public.clued_project_update(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write','system:projects');
  return clued_private.project_update_core(v_binding.user_id,v_binding.id,p_input);
exception when serialization_failure then
  if sqlerrm='project_version_conflict' then
    raise exception 'project_version_conflict' using errcode='23505';
  end if;
  raise;
end $$;

create or replace function public.clued_user_project_update(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  return clued_private.project_update_core((select auth.uid()),null,p_input);
exception when serialization_failure then
  if sqlerrm='project_version_conflict' then
    raise exception 'project_version_conflict' using errcode='23505';
  end if;
  raise;
end $$;

revoke all on function public.clued_record_write(text,jsonb) from public,authenticated;
grant execute on function public.clued_record_write(text,jsonb) to anon;
revoke all on function public.clued_user_record_write(jsonb) from public,anon;
grant execute on function public.clued_user_record_write(jsonb) to authenticated;

revoke all on function public.clued_project_update(text,jsonb) from public,authenticated;
grant execute on function public.clued_project_update(text,jsonb) to anon;
revoke all on function public.clued_user_project_update(jsonb) from public,anon;
grant execute on function public.clued_user_project_update(jsonb) to authenticated;

notify pgrst,'reload schema';
