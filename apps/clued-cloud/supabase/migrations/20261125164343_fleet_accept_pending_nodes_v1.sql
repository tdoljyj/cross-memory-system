-- The one answer for a checked resource of this account: the door and the
-- anonymous read both return it.
create or replace function clued_private.fleet_accept_answer_v1(p_user uuid,p_anchor uuid,p_resource text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_parts text[]:=clued_private.fleet_accept_parts_v1(p_resource); v_base jsonb;
  v_row clued_private.fleet_accepted_v1%rowtype; v_req clued_private.owner_requests_v1%rowtype;
begin
  if v_parts is null then raise exception 'fleet_accept_resource_invalid' using errcode='22023'; end if;
  v_base:=jsonb_build_object('action','fleet.accept','resources',jsonb_build_array(p_resource),
    'repository',v_parts[1],'version',v_parts[2],'archive_sha256',v_parts[3],'request_sha256',v_parts[4]);
  select * into v_row from clued_private.fleet_accepted_v1 a
    where a.user_id=p_user and a.repository=v_parts[1] and a.version=v_parts[2];
  if found and v_row.archive_sha256=v_parts[3] and v_row.request_sha256=v_parts[4] then
    return v_base||jsonb_build_object('status','accepted','grant_id',v_row.grant_id,'receipt_id',v_row.receipt_id,
      'accepted_at',v_row.accepted_at,
      -- 确认时逐台比对上报的 Source。计入 pending 节点后，只有它们也报出目标 Source 才能完成。
      -- Each node exactly what rollout/fleet/accept-door.mjs
      -- readFleet uses: name, reported Source, paused.
      'nodes',coalesce((select jsonb_agg(jsonb_build_object('name',n.name,
          'source_sha256',l.reported_source_sha256,
          'paused',coalesce(l.reported_state in ('PAUSED','INTAKE_PAUSED'),false)) order by n.name,n.created_at,n.node_id)
        from clued_private.ci_nodes_v1 n left join clued_private.ci_node_liveness_v1 l on l.node_id=n.node_id
        where n.user_id=p_user and n.state not in ('retired','revoked')),'[]'::jsonb));
  end if;
  if found then
    -- This version is accepted as another package or request: this one never will be.
    return v_base||jsonb_build_object('status','none','conflict','fleet_accept_version_already_accepted');
  end if;
  select * into v_req from clued_private.owner_requests_v1 r
    where r.user_id=p_user and r.binding_id=p_anchor and r.action='fleet.accept' and r.resources=array[p_resource]
    order by r.created_at desc,r.id desc limit 1;
  if not found then return v_base||jsonb_build_object('status','none'); end if;
  if v_req.status='pending' and v_req.expires_at>clock_timestamp() then
    return v_base||jsonb_build_object('status','pending','request_id',v_req.id,
      'confirm_path','/confirm/'||v_req.id::text,'expires_at',v_req.expires_at);
  end if;
  -- Decided without a row: the Owner said no. A pending one past its time ran out.
  return v_base||jsonb_build_object('status',case when v_req.status='rejected' then 'rejected' else 'expired' end,
    'request_id',v_req.id,'decided_at',v_req.decided_at,'expires_at',v_req.expires_at);
end $$;
