-- Permission simplification step 1 (PermissionSimplification.v0.1 §3.4,
-- Task fb2b0978): "我的授权" shows identifiers the Owner can match against
-- what an Agent says. Same as 20261002220000 plus, for each grant, the
-- request it came from and the title of its Task. Nothing about who may use
-- a grant changes.
create or replace function public.clued_owner_grants_list_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12();
begin
  return jsonb_build_object('status','ok',
    'grants',coalesce((select jsonb_agg(jsonb_build_object('grant_id',g.id,'action',g.action,
        'action_title',a.title,'resources',to_jsonb(g.resources),'task_id',g.task_id,
        'task_title',t.title,'request_id',g.request_id,
        'any_agent',g.grantee_binding_id is null,'agent_name',b.agent_name,'granted_at',g.granted_at,
        'expires_at',g.expires_at,'max_uses',g.max_uses,'uses',g.uses) order by g.expires_at)
      from clued_private.owner_grants_v1 g join clued_private.owner_grant_actions a on a.action=g.action
      left join public.clued_agent_bindings b on b.id=g.grantee_binding_id
      left join public.clued_memories t on t.id=g.task_id and t.user_id=v_owner
      where g.user_id=v_owner and g.revoked_at is null and g.expires_at>clock_timestamp()
        and (g.max_uses is null or g.uses<g.max_uses)),'[]'::jsonb),
    'pending_requests',coalesce((select jsonb_agg(clued_private.owner_request_public_v1(r) order by r.created_at)
      from clued_private.owner_requests_v1 r
      where r.user_id=v_owner and r.status='pending' and r.expires_at>clock_timestamp()),'[]'::jsonb));
end $$;

notify pgrst,'reload schema';
