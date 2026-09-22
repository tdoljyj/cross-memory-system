-- Forward repair for an observed production migration gap: Currentness Core
-- exists, but the two-argument owner adapter and Binding entrypoint still use
-- the legacy unfenced list. Reuse the current three-argument core; do not
-- rebuild projections, change records, or change public execution privileges.
create or replace function clued_private.record_list_core(p_user_id uuid,p_input jsonb)
returns jsonb language sql security definer set search_path='' as $$
  select clued_private.record_list_core(p_user_id,p_input,null::text[])
$$;
revoke all on function clued_private.record_list_core(uuid,jsonb)
  from public,anon,authenticated,service_role;

create or replace function public.clued_record_list(
  p_token_hash text,p_input jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; delegated boolean; authorized_scopes text[];
begin
  b:=clued_private.resolve_binding(p_token_hash,'context:read',
    case when p_input->>'level'='project'
      then 'project:'||(p_input->>'project_id') else 'global' end);
  select exists(select 1 from clued_private.authorizations_v12 where binding_id=b.id)
    into delegated;
  if delegated then
    select coalesce(array_agg(distinct e.resource_id),'{}'::text[])
      into authorized_scopes
      from clued_private.authorization_entries_v12 e
      where e.binding_id=b.id and e.resource_kind='scope'
        and e.environment='canonical' and 'read'=any(e.actions)
        and (e.resource_id in ('global','profile') or exists(
          select 1 from public.clued_projects p
          where 'project:'||p.id=e.resource_id and p.user_id=b.user_id));
  end if;
  -- The server determines scopes before filtering and LIMIT. Never accept
  -- caller-supplied scopes; an empty delegated set remains deny-all.
  return clued_private.record_list_core(b.user_id,p_input,authorized_scopes);
end $$;
