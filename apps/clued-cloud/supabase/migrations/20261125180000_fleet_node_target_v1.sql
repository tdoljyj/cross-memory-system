-- The signed CI connection probe can see the latest Owner-accepted package for
-- this fleet. Retain the old acceptance door and the existing renewal write path.
create function clued_private.fleet_node_target_v1(p_owner uuid, p_node uuid)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('repository', a.repository, 'version', a.version,
    'archive_sha256', a.archive_sha256, 'request_sha256', a.request_sha256,
    'grant_id', a.grant_id, 'receipt_id', a.receipt_id, 'accepted_at', a.accepted_at,
    'other_sources', coalesce((
      -- A null means at least one peer is silent, paused or otherwise not ready.
      -- Two distinct values already disprove readiness for any single Source.
      select jsonb_agg(s.source order by s.source nulls first) from (
        select distinct case when l.reported_state='NORMAL' and l.reported_service_running
          and l.last_heartbeat_at>statement_timestamp()-interval '20 minutes'
          then l.reported_source_sha256 end as source
        from clued_private.ci_nodes_v1 n
        left join clued_private.ci_node_liveness_v1 l on l.node_id=n.node_id and l.user_id=n.user_id
        where n.user_id=p_owner and n.node_id<>p_node and n.revoked_at is null and n.state in ('active','draining')
        order by source nulls first limit 2
      ) s
    ), '[]'::jsonb))
  from clued_private.fleet_accepted_v1 a
  join clued_private.release_identity_v1 r on r.user_id=a.user_id and r.repository=a.repository
  where a.user_id=p_owner
  order by a.accepted_at desc, a.recorded_at desc, a.grant_id desc
  limit 1
$$;
revoke all on function clued_private.fleet_node_target_v1(uuid,uuid) from public,anon,authenticated,service_role,clued_worker_gateway;

do $patch$
declare body text:=pg_get_functiondef('public.clued_ci_connection_renew_v1(jsonb)'::regprocedure);
  anchor text:=$a$'on_duty',k='ci' and exists(select 1 from clued_private.ci_duty_holder_v1(u,p) h where h.node_id=n.node_id and h.binding_id=old.id));$a$;
begin
  if (length(body)-length(replace(body,anchor,'')))<>length(anchor) then
    raise exception 'fleet_node_target_patch_anchor_mismatch'; end if;
  execute replace(body,anchor,$r$'on_duty',k='ci' and exists(select 1 from clued_private.ci_duty_holder_v1(u,p) h where h.node_id=n.node_id and h.binding_id=old.id))
      ||case when k='ci' and n.state in ('active','draining') then
        jsonb_build_object('fleet_target',clued_private.fleet_node_target_v1(u,n.node_id))
      else '{}'::jsonb end;$r$);
end $patch$;
