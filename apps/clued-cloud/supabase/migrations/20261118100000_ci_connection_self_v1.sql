-- 准入作用域内的连接自查。resolve_binding 的共享行锁与角色探测相同。
create function public.clued_ci_connection_self_v1(p_token_hash text, p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  b public.clued_agent_bindings;
  scope_key text := p_input->>'scope';
begin
  if jsonb_typeof(p_input) is distinct from 'object'
     or jsonb_typeof(p_input->'scope') is distinct from 'string'
     or p_input - 'scope' <> '{}'::jsonb
     or length(scope_key) not between 1 and 160 then
    raise exception 'ci_connection_self_input_invalid' using errcode = '22023';
  end if;

  b := clued_private.resolve_binding(p_token_hash, 'context:read', scope_key);
  return jsonb_build_object(
    'status', 'ok',
    'contract', 'clued.ci.connection-self/1',
    'binding_id', b.id,
    'connection_expires_at', clued_private.ci_binding_expires_at_v1(b),
    'node', (
      select jsonb_build_object(
        'node_id', n.node_id,
        'name', n.name,
        'identity_fingerprint', n.identity_fingerprint,
        'binding_generation', n.binding_generation,
        'state', n.state,
        'rebind_receipt_id', (
          select r.receipt_id from clued_private.ci_node_binding_rebinds_v1 r
          where r.user_id = n.user_id and r.project_id = n.project_id and r.node_id = n.node_id
            and r.result->>'binding_id' = b.id::text
          order by r.created_at desc, r.receipt_id desc limit 1
        )
      )
      from clued_private.ci_nodes_v1 n
      where n.user_id = b.user_id and n.binding_id = b.id and n.state not in ('retired', 'revoked')
        and (scope_key = 'global' or scope_key = 'project:' || n.project_id)
    )
  );
end $$;

revoke all on function public.clued_ci_connection_self_v1(text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.clued_ci_connection_self_v1(text,jsonb) to anon;
notify pgrst, 'reload schema';
