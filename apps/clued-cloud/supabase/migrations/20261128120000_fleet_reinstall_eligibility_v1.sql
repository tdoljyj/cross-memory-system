-- Eligibility is a read-only hint for starting the local reinstall flow.
-- The actual delist still requires the existing operation and drain gates.
create function clued_private.fleet_reinstall_eligible_v1(m clued_private.fleet_maintenance_v1, target uuid)
returns boolean language sql immutable set search_path='' as $$
  select target is not null and not coalesce((m).owner_repair_required,false) and
    (coalesce((m).state,'available') in ('available','returned') or
      coalesce((m).state='delisted' and (m).method='handover' and (m).grant_id=target,false))
$$;

revoke all on function clued_private.fleet_reinstall_eligible_v1(clued_private.fleet_maintenance_v1,uuid)
  from public,anon,authenticated,service_role,clued_worker_gateway;

do $$
declare
  probe text:=pg_get_functiondef('clued_private.fleet_probe_targets_v1(uuid,uuid)'::regprocedure);
  maintenance text:=pg_get_functiondef('clued_private.fleet_maintenance_request_v1(uuid,uuid,jsonb)'::regprocedure);
  probe_anchor text:=$a$'operation_id',m.operation_id);$a$;
  maintenance_anchor text:=$a$'install_ready',ready,'drain_confirmed_at'$a$;
begin
  if strpos(probe,probe_anchor)=0 or strpos(maintenance,maintenance_anchor)=0 then
    raise exception 'fleet_reinstall_eligibility_anchor_missing';
  end if;
  execute replace(probe,probe_anchor,$r$'operation_id',m.operation_id,
    'reinstall_eligible',clued_private.fleet_reinstall_eligible_v1(m,(target->>'grant_id')::uuid),
    'reinstall_busy',clued_private.fleet_node_busy_v1(node));$r$);
  execute replace(maintenance,maintenance_anchor,$r$'reinstall_eligible',clued_private.fleet_reinstall_eligible_v1(m,target),
    'install_ready',ready,'drain_confirmed_at'$r$);
end $$;
