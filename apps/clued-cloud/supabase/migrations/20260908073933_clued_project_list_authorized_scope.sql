-- Enumerate the existing consent, without inventing a system:projects grant.
-- Global/profile and development-context membership do not grant access to
-- Canonical project metadata. Non-migrated raw broad bindings keep their scope.
create or replace function public.clued_project_list(p_token_hash text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 b public.clued_agent_bindings;
 a clued_private.authorizations_v12;
 migrated boolean;
 broad boolean;
 projects jsonb;
 row_limit integer := least(greatest(coalesce((p_input->>'limit')::integer,100),1),200);
begin
 if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
  raise exception 'invalid_binding_or_context' using errcode='28000';
 end if;
 -- Preserve Binding -> Authorization -> Resource lock order and current checks.
 select * into b from public.clued_agent_bindings where token_hash=p_token_hash for share;
 if not found or b.revoked_at is not null
    or (to_jsonb(b)->>'expires_at')::timestamptz<=clock_timestamp()
    or not('context:read'=any(b.scopes)) then
  raise exception 'binding_not_authorized' using errcode='42501';
 end if;
 perform clued_private.authorization_account_v12(b.user_id);
 select * into a from clued_private.authorizations_v12 where binding_id=b.id for share;
 migrated:=found;
 if migrated and (a.owner_id is distinct from b.user_id or a.revoked_at is not null
     or a.expires_at<=clock_timestamp()) then
  raise exception 'authorization_revoked_or_expired' using errcode='42501';
 end if;
 broad:=not migrated and ('*'=any(b.context_keys) or 'system:projects'=any(b.context_keys));
 select coalesce(jsonb_agg(to_jsonb(project_row) order by project_row.updated_at desc,project_row.id),'[]'::jsonb)
 into projects from (
  select p.*,
   (select count(*) from public.clued_project_mentions m where m.project_id=p.id) as mention_count
  from public.clued_projects p
  where p.user_id=b.user_id and p.merged_into_project_id is null
   and (case when migrated then
     'read'=any(clued_private.authorization_effective_actions_v13(b.id,'scope','project:'||p.id,'canonical'))
    else broad or ('project:'||p.id)=any(b.context_keys) end)
   and (coalesce((p_input->>'include_dismissed')::boolean,false) or p.dismissed_at is null)
   and (not (p_input ? 'certainty_status') or p.certainty_status=p_input->>'certainty_status')
   and (not (p_input ? 'progress_status') or p.progress_status=p_input->>'progress_status')
   and (not (p_input ? 'query') or p.name ilike '%'||replace(p_input->>'query','%','\%')||'%' escape '\')
  order by p.updated_at desc,p.id limit row_limit
 ) project_row;
 return jsonb_build_object('status','ok','projects',projects);
end $$;

-- Keep the existing credential-hash RPC boundary; do not grant table access.
revoke all on function public.clued_project_list(text,jsonb) from public,authenticated,service_role;
grant execute on function public.clued_project_list(text,jsonb) to anon;
