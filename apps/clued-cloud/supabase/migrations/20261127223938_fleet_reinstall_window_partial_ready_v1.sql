set local lock_timeout = '5s';

create or replace function clued_private.fleet_reinstall_window_tick_v1(u uuid,g uuid,t timestamptz) returns void
language plpgsql volatile set search_path='' as $$
declare w clued_private.fleet_maintenance_v1; n clued_private.ci_nodes_v1; ready_nodes uuid[]; peers jsonb; r uuid; pr uuid;
begin
  select * into w from clued_private.fleet_maintenance_v1 m where m.user_id=u
    and m.reinstall_peers is not null and m.reinstall_resume_receipt_id is null
    order by m.started_at,m.node_id limit 1;
  if not found then return; end if;
  select project_id into pr from clued_private.ci_nodes_v1 where node_id=w.node_id;
  if t>=w.reinstall_pause_until and w.reinstall_pause_alerted_at is null then
    r:=clued_private.ci_failover_alert_v1(u,'FLEET_REINSTALL_WINDOW_EXPIRED',w.operation_id::text,
      jsonb_build_object('grant_id',w.grant_id,'deadline',w.reinstall_pause_until,'recovery','verify_reinstalled_nodes_as_standby_then_restore_duty'));
    if r is not null then perform clued_private.ci_failover_note_v1(u,r,'FLEET_REINSTALL_WINDOW_EXPIRED','双节点重装窗口已到期',
      '已通过安装和备班健康验证的节点可接班。请核对仍在维护的节点。'); end if;
    update clued_private.fleet_maintenance_v1 set reinstall_pause_alerted_at=t where node_id=w.node_id;
  end if;
  if w.grant_id is distinct from g then return; end if;
  if w.reinstall_pause_receipt_id is null then
    perform clued_private.fleet_reinstall_pause_v1(u,w.node_id,g);
    return;
  end if;
  if exists(select 1 from clued_private.fleet_accepted_v1 where grant_id=g and promotion_paused_at is not null) then return; end if;
  peers:=w.reinstall_peers||jsonb_build_array(jsonb_build_object('node_id',w.node_id,'operation_id',w.operation_id,
    'binding_generation',w.binding_generation));
  select array_agg(c.node_id order by member.rank nulls last,c.node_id) into ready_nodes
    from jsonb_to_recordset(peers) as expected(node_id uuid,operation_id uuid,binding_generation bigint)
    join clued_private.fleet_maintenance_v1 m using(node_id,operation_id,binding_generation)
    join clued_private.ci_nodes_v1 c using(node_id,user_id,binding_generation)
    join public.clued_agent_bindings b on b.id=c.binding_id and b.user_id=c.user_id
    join clued_private.ci_node_liveness_v1 l on l.node_id=c.node_id and l.user_id=c.user_id
    left join clued_private.ci_failover_members_v1 member on member.user_id=u and member.binding_id=c.binding_id
    where m.user_id=u and m.grant_id=g and m.state='returned' and m.verify_started_at is not null
      and c.revoked_at is null and c.state in ('active','pending','draining') and clued_private.binding_live_v1(b)
      and l.reported_mode='STANDBY' and l.reported_probe='not-held'
      and clued_private.fleet_source_reason_v1(u,c.node_id,'handover') is null
      and clued_private.fleet_selfcheck_v1(u,c.node_id,m.verify_started_at);
  if ready_nodes is null then return; end if;
  -- 窗口内等全员回归。待修有自己的操作号，按窗口记录的节点与绑定代次识别。
  if cardinality(ready_nodes) <> jsonb_array_length(peers)
    and (t >= w.reinstall_pause_until) is not true
    and not exists (
      select 1 from jsonb_to_recordset(peers) as expected(node_id uuid,binding_generation bigint)
      join clued_private.fleet_maintenance_v1 m using(node_id,binding_generation)
      where m.user_id=u and m.grant_id=g and m.state='repair'
    ) then return; end if;
  for n in select c.* from unnest(ready_nodes) with ordinality as x(node_id,ord)
    join clued_private.ci_nodes_v1 c using(node_id) order by x.ord loop
    begin
      if clued_private.ci_duty_phase_v1(u,n.project_id)>=4 then
        r:=(clued_private.ci_train_acquire_v1(u,n.project_id,n.node_id)->>'receipt_id')::uuid;
      else
        r:=clued_private.fleet_restore_resident_duty_v1(u,n.node_id,w.operation_id,g,t);
      end if;
    exception when insufficient_privilege or object_not_in_prerequisite_state or invalid_parameter_value then
      continue;
    end;
    if r is not null then
      r:=clued_private.ci_receipt_v1(u,pr,'fleet_reinstall_train_resumed',w.node_id::text,
        jsonb_build_object('operation_id',w.operation_id,'grant_id',g,'pause_receipt_id',w.reinstall_pause_receipt_id,
          'duty_receipt_id',r,'node_id',n.node_id));
      update clued_private.fleet_maintenance_v1 set reinstall_resume_receipt_id=r where node_id=w.node_id;
      return;
    end if;
  end loop;
end $$;
