-- 788c2598：登记节点第一次报到才切换列车规则。心跳变旧不改变已到位的事实。
set local lock_timeout = '5s';

create function clued_private.fleet_sealed_rule_active_v1(u uuid, preview_revoke uuid default null)
returns boolean language sql stable set search_path='' as $$
  select exists (
    select 1 from clued_private.ci_nodes_v1 n
    join clued_private.ci_node_liveness_v1 l using(user_id,node_id)
    left join clued_private.fleet_node_delivery_evidence_v1 e on e.user_id=n.user_id and e.node_id=n.node_id
      and e.registration_version=n.version and e.binding_generation=n.binding_generation
    join clued_private.fleet_accepted_v1 a on a.user_id=u
      and a.source_sha256=coalesce(l.reported_source_sha256,e.evidence->>'windowsSourceSha256')
    join clued_private.release_identity_v1 i on i.user_id=u and i.repository=a.repository
    join clued_private.owner_grants_v1 g on g.user_id=u and g.id=a.grant_id
    where n.user_id=u and n.state not in ('retired','revoked') and n.revoked_at is null
      and a.sealed_at is not null and g.revoked_at is null and g.id is distinct from preview_revoke)
$$;

-- 包身份仍按 SQL210 的双端 Source、登记代次和唯一匹配取证。预演与实际读取共用此函数。
create function clued_private.fleet_node_package_at_v1(u uuid,node uuid,preview_revoke uuid)
returns jsonb language sql stable set search_path='' as $$
  with seals as materialized (select * from clued_private.fleet_seals_v1(u,preview_revoke)),
  live as (
    select l.reported_source_sha256 as source,l.last_heartbeat_at,
      e.evidence->>'packageGeneration' as generation,
      e.evidence->>'linuxSourceSha256'=l.reported_source_sha256 as linux_matches,
      coalesce(m.state,'available') as maintenance
    from clued_private.ci_nodes_v1 n
    left join clued_private.ci_node_liveness_v1 l using(user_id,node_id)
    left join clued_private.fleet_node_delivery_evidence_v1 e on e.node_id=n.node_id and e.user_id=u
      and e.registration_version=n.version and e.binding_generation=n.binding_generation
      and e.heartbeat_sequence=l.heartbeat_sequence and e.observed_at=l.last_heartbeat_at
      and e.evidence->>'windowsSourceSha256'=l.reported_source_sha256
    left join clued_private.fleet_maintenance_v1 m on m.node_id=n.node_id and m.user_id=u
      and m.binding_generation=n.binding_generation and m.state<>'returned'
    where n.node_id=node and n.user_id=u and n.revoked_at is null and n.state not in ('retired','revoked')
  ), matched as (
    select s.* from seals s,live l where s.source=l.source and l.linux_matches is not false and
      (case when l.generation is not null then l.linux_matches and clued_private.fleet_package_generation_v1(s.version)::text=l.generation
       else (select count(*) from seals a where a.source=l.source)=1 end)
  ), unique_match as (select * from matched where (select count(*) from matched)=1)
  select jsonb_build_object('classification',case when not clued_private.fleet_sealed_rule_active_v1(u,preview_revoke) then 'legacy'
    when l.source is null then 'unknown' else coalesce(s.classification,'outside') end,
    'grantId',s.grant_id,'source',l.source,'maintenance',coalesce(l.maintenance,'available'),'heartbeatAt',l.last_heartbeat_at,
    'revoked',coalesce(s.classification='revoked',case when l.generation is null and l.linux_matches is not false
      then (select bool_and(a.classification='revoked') from seals a where a.source=l.source) end,false),
    'version',coalesce(s.version,case when l.linux_matches and l.generation ~ '^[0-9]{1,6}$' then 'g'||lpad(l.generation,6,'0') end))
  from (values (1)) d(i) left join live l on true left join unique_match s on true
$$;

create or replace function clued_private.fleet_node_package_v1(u uuid,node uuid)
returns jsonb language sql stable set search_path='' as $$
  select clued_private.fleet_node_package_at_v1(u,node,null)
$$;

create function clued_private.fleet_source_reason_at_v1(u uuid,node uuid,purpose text,preview_revoke uuid)
returns text language plpgsql stable set search_path='' as $$
declare info jsonb:=clued_private.fleet_node_package_at_v1(u,node,preview_revoke); c text:=info->>'classification';
begin
  if info->>'maintenance'<>'available' and not (purpose='failover' and info->>'maintenance'='reserve') then
    return 'ci_admission_target_in_maintenance'; end if;
  if info->>'source' is null then return 'ci_admission_target_source_unknown'; end if;
  if c='legacy' then
    if exists(select 1 from clued_private.ci_node_liveness_v1 l join clued_private.ci_nodes_v1 n using(node_id,user_id)
      cross join lateral (select clued_private.fleet_node_package_at_v1(u,n.node_id,preview_revoke) p) peer
      where n.user_id=u and n.node_id<>node and n.state not in ('retired','revoked') and n.revoked_at is null
        and peer.p->>'maintenance' not in ('delisted','repair') and l.reported_source_sha256 is not null
        and l.last_heartbeat_at>statement_timestamp()-make_interval(hours=>(clued_private.ci_failover_rules_v1()->>'source_window_hours')::int)
        and (case when (peer.p->>'revoked')::boolean=(info->>'revoked')::boolean then l.reported_source_sha256<>info->>'source'
             else (info->>'revoked')::boolean end)) then return 'ci_admission_target_source_not_accepted'; end if;
  elsif c<>'current' and not (c='previous' and purpose in ('holder','failover')) then
    return 'ci_admission_target_source_not_accepted';
  end if;
  return null;
end $$;

create or replace function clued_private.fleet_source_reason_v1(u uuid,node uuid,purpose text)
returns text language sql stable set search_path='' as $$
  select clued_private.fleet_source_reason_at_v1(u,node,purpose,null)
$$;

-- 只交还本次交班留下的后备。预演沿用看门狗的成员、排名及健康门，只重算模拟撤销后的 Source。
create function clued_private.fleet_rollback_target_v1(u uuid,holder uuid,preview_revoke uuid)
returns uuid language sql stable set search_path='' as $$
  select n.binding_id
  from clued_private.ci_failover_node_v1(u,holder) h
  cross join lateral (select clued_private.fleet_node_package_at_v1(u,h.node_id,preview_revoke) info) p
  join clued_private.fleet_maintenance_v1 m on m.user_id=u and m.successor=h.node_id and m.state='reserve'
    and m.grant_id=(p.info->>'grantId')::uuid
  join clued_private.ci_nodes_v1 n on n.user_id=u and n.node_id=m.node_id and n.binding_generation=m.binding_generation
    and n.revoked_at is null and n.state not in ('retired','revoked')
  cross join lateral jsonb_array_elements(clued_private.ci_failover_candidates_v1(u,holder,h.reported_source_sha256,null,statement_timestamp())) c
  where (p.info->>'revoked')::boolean and p.info->>'maintenance'='available' and c->>'binding_id'=n.binding_id::text
    and (c->'reasons')-array['ci_admission_target_source_not_accepted','source_differs','source_differs_from_holder']='[]'::jsonb
    and clued_private.fleet_source_reason_at_v1(u,n.node_id,'failover',preview_revoke) is null
    and not (clued_private.fleet_node_package_at_v1(u,n.node_id,preview_revoke)->>'revoked')::boolean
  order by (c->>'rank')::int limit 1
$$;

create function clued_private.fleet_revoke_preview_v1(u uuid,preview_revoke uuid)
returns text language plpgsql stable set search_path='' as $$
declare holder uuid; target uuid; label text; info jsonb;
begin
  if exists(select 1 from clued_private.ci_nodes_v1 n where n.user_id=u and n.revoked_at is null and n.state not in ('retired','revoked'))
    and not exists(select 1 from clued_private.ci_nodes_v1 n where n.user_id=u and n.revoked_at is null and n.state not in ('retired','revoked')
      and (clued_private.fleet_node_package_at_v1(u,n.node_id,preview_revoke)->>'grantId')::uuid is distinct from preview_revoke) then
    return '撤销后全部节点仍在此包上，列车继续，需出新包修复。';
  end if;
  select h.binding_id into holder from clued_private.ci_duty_holder_v1(u) h;
  if exists(select 1 from clued_private.ci_failover_settings_v1 s join clued_private.ci_failover_members_v1 m using(user_id)
      join clued_private.ci_failover_node_v1(u,holder) h on h.last_heartbeat_at>greatest(s.enabled_at,m.marked_at)
      where s.user_id=u and s.enabled and m.binding_id=holder) then
    target:=clued_private.fleet_rollback_target_v1(u,holder,preview_revoke);
  end if;
  select n.name,clued_private.fleet_node_package_at_v1(u,n.node_id,preview_revoke) into label,info
    from clued_private.ci_nodes_v1 n
    where n.binding_id=coalesce(target,holder) and n.user_id=u and n.revoked_at is null and n.state not in ('retired','revoked')
      and clued_private.fleet_source_reason_at_v1(u,n.node_id,case when target is null then 'holder' else 'failover' end,preview_revoke) is null;
  if label is null then return '撤销后暂时没有可确认的当班节点。'; end if;
  return format('撤销后由 %s（%s）当班。',label,coalesce(info->>'version','Source '||(info->>'source')));
end $$;

-- 只有未发出落地的旧批才能作废。已发送或结果未知的外部写入先由原有读回路径收口。
create function clued_private.fleet_requeue_unlandable_v1(u uuid,node uuid,g uuid)
returns void language plpgsql volatile set search_path='' as $$
declare b clued_private.ci_train_batches_v2; member record; r uuid;
begin
  for b in select x.* from clued_private.ci_train_batches_v2 x where x.user_id=u and x.node_id=node
    and x.state in ('forming','sealed','waiting_checks') order by x.batch_id for update loop
    if b.staging_state in ('sent','unknown') or exists(select 1 from clued_private.ci_train_landing_v2 l
        where l.batch_id=b.batch_id and l.state in ('sent','unknown','settled')) then continue; end if;
    r:=clued_private.ci_receipt_v1(u,b.project_id,'fleet_batch_requeued',b.batch_id,
      jsonb_build_object('node_id',node,'grant_id',g,'generation',b.generation,'members',b.members));
    update clued_private.ci_train_landing_v2 set state='revoked',receipt_id=r where batch_id=b.batch_id and state='reserved';
    update clued_private.ci_train_batches_v2 set state='invalidated',receipt_id=r,expires_at=clock_timestamp() where batch_id=b.batch_id;
    -- 只把仍在本队列、且认领与执行代次仍有效的成员放回队尾，保留其相对顺序。
    for member in select w.claim_id,min(j.pos) as pos from jsonb_array_elements(b.members) with ordinality j(m,pos)
      join clued_private.work_claims_v1 w on w.claim_id=(j.m->>'claimId')::uuid and w.user_id=u
        and w.fence=(j.m->>'fence')::bigint and w.execution_epoch=(j.m->>'epoch')::bigint
      where w.status in ('ACTIVE','DRAINING') and w.expires_at>clock_timestamp() and w.merge_queued_at is not null
        and exists(select 1 from jsonb_array_elements(clued_private.work_claim_merge_queue_current_v1(u,
          'merge:'||lower((clued_private.ci_repo_v1(u,b.project_id,b.repository_id)).repository_name)||':'||b.target_branch)->'entries') entry
          where entry->>'claim_id'=w.claim_id::text and entry->>'state' in ('head','waiting'))
      group by w.claim_id order by min(j.pos) loop
      perform clued_private.work_claim_merge_rejoin_v1(member.claim_id,b.binding_id,'fleet_sealed_handover',
        jsonb_build_object('batch_id',b.batch_id,'batch_receipt_id',r));
    end loop;
  end loop;
end $$;

-- 保留原入口的签名、权限与其余检查；版本锚点必须恰好匹配一次。
create function pg_temp.fleet_patch(sig regprocedure,anchor text,replacement text) returns void
language plpgsql set search_path='' as $$
declare body text:=pg_get_functiondef(sig);
begin
  if length(body)-length(replace(body,anchor,''))<>length(anchor) then
    raise exception 'fleet_arrival_patch_anchor_mismatch: % (%)',sig,left(anchor,96); end if;
  execute replace(body,anchor,replacement);
end $$;

select pg_temp.fleet_patch('clued_private.fleet_node_target_v1(uuid,uuid)',
  'not exists(select 1 from clued_private.fleet_seals_v1(p_owner))',
  $r$not clued_private.fleet_sealed_rule_active_v1(p_owner) and exists(select 1 from clued_private.owner_grants_v1 g
      where g.id=a.grant_id and g.user_id=p_owner and g.revoked_at is null)$r$);
-- 尚未封存的新候选不能挤掉已有的可安装目标。
select pg_temp.fleet_patch('clued_private.fleet_node_target_v1(uuid,uuid)',
  'order by case when clued_private.fleet_package_generation_v1(a.version)>=25',
  'order by (a.sealed_at is not null and a.source_sha256 is not null) desc,
    case when clued_private.fleet_package_generation_v1(a.version)>=25');
select pg_temp.fleet_patch('clued_private.fleet_node_target_v1(uuid,uuid)',
  'order by source nulls first limit 2',
  $r$and (clued_private.fleet_sealed_rule_active_v1(p_owner)
            or not (clued_private.fleet_node_package_v1(p_owner,n.node_id)->>'revoked')::boolean
            or (clued_private.fleet_node_package_v1(p_owner,p_node)->>'revoked')::boolean)
        order by source nulls first limit 2$r$);
select pg_temp.fleet_patch('public.clued_ci_connection_renew_v1(jsonb)',
  'case when exists(select 1 from clued_private.fleet_seals_v1(u))',
  'case when clued_private.fleet_sealed_rule_active_v1(u)');
select pg_temp.fleet_patch('clued_private.ci_train_command_v2(clued_private.ci_nodes_v1,text,jsonb)',
  'not exists(select 1 from clued_private.fleet_seals_v1(n.user_id))',
  'not clued_private.fleet_sealed_rule_active_v1(n.user_id)');

-- 全员在已撤销包上时，签名列车仍核验该包自己的 Source/commit；有合格对端时拒绝已撤销当班。
select pg_temp.fleet_patch('clued_private.ci_train_command_v2(clued_private.ci_nodes_v1,text,jsonb)',
  $a$if projection->>'classification'<>'legacy' then$a$,
  $r$if projection->>'classification'<>'legacy' or (projection->>'revoked')::boolean
    or (op in ('batch_reserve','landing_prepare','landing_send') and
      clued_private.fleet_source_reason_v1(n.user_id,n.node_id,'holder')='ci_admission_target_source_not_accepted') then$r$);
select pg_temp.fleet_patch('clued_private.ci_train_command_v2(clued_private.ci_nodes_v1,text,jsonb)',
  $a$if projection->>'classification' in ('current','previous') then$a$,
  $r$if projection->>'classification' in ('current','previous')
      or (projection->>'classification'='legacy' and (projection->>'revoked')::boolean and projection->>'grantId' is not null) then$r$);
select pg_temp.fleet_patch('clued_private.ci_train_acquire_v1(uuid,uuid,uuid)',
  $a$if clued_private.fleet_node_package_v1(u,node)->>'classification'<>'legacy' then$a$,
  $r$if clued_private.fleet_node_package_v1(u,node)->>'classification'<>'legacy'
    or clued_private.fleet_source_reason_v1(u,node,'holder')='ci_admission_target_source_not_accepted' then$r$);

-- 旧客户端自己比较 nodes。已撤销节点须让位，但全员仍在撤销包时保留原同源比较。
select pg_temp.fleet_patch('clued_private.fleet_execution_view_v1(uuid,uuid)',
  $a$where coalesce(x#>>'{node,package,maintenance}','available') not in ('delisted','repair')$a$,
  $r$where coalesce(x#>>'{node,package,maintenance}','available') not in ('delisted','repair')
        and (not coalesce((x#>>'{node,package,revoked}')::boolean,false)
          or (info->>'revoked')::boolean)$r$);
select pg_temp.fleet_patch('clued_private.ci_failover_candidates_v1(uuid,uuid,text,timestamptz,timestamptz)',
  $a$or exists(select 1 from clued_private.fleet_maintenance_v1 x where x.user_id=p_owner and x.state<>'returned')$a$,
  $r$or exists(select 1 from clued_private.fleet_maintenance_v1 x where x.user_id=p_owner and x.state<>'returned')
        or exists(select 1 from clued_private.fleet_seals_v1(p_owner) s where s.classification='revoked')$r$);

select pg_temp.fleet_patch('clued_private.fleet_promote_v1(uuid,uuid)',
  $a$or h.reported_mode<>'ACTIVE' or not clued_private.fleet_idle_v1(u,h.node_id)$a$,
  $r$or h.reported_mode<>'ACTIVE'$r$);
select pg_temp.fleet_patch('clued_private.fleet_promote_v1(uuid,uuid)',
  $a$  done:=clued_private.binding_role_handover_core_v1$a$,
  $r$  if info->>'classification' not in ('current','previous') then
    perform clued_private.fleet_requeue_unlandable_v1(u,h.node_id,g);
  end if;
  if not clued_private.fleet_idle_v1(u,h.node_id) then return null; end if;
  done:=clued_private.binding_role_handover_core_v1$r$);

select pg_temp.fleet_patch('clued_private.ci_admission_failover_owner_v1(uuid)',
  $a$  perform pg_advisory_xact_lock($a$,
  $r$  perform clued_private.work_claim_lock(p_owner);
  perform pg_advisory_xact_lock($r$);
select pg_temp.fleet_patch('clued_private.ci_admission_failover_owner_v1(uuid)',
  $a$  if v_trigger is null then$a$,
  $r$  if v_trigger is null and clued_private.fleet_rollback_target_v1(p_owner,v_holder,null) is not null then
    if s.enabled then
      perform clued_private.fleet_requeue_unlandable_v1(p_owner,xn.node_id,
        (clued_private.fleet_node_package_v1(p_owner,xn.node_id)->>'grantId')::uuid);
      if clued_private.fleet_node_busy_v1(xn.node_id) then
        return jsonb_build_object('outcome','holder_alive','holder',v_holder,'reason','draining_revoked_package');
      end if;
    end if;
    v_trigger:='fleet_holder_package_revoked';
  end if;
  if v_trigger is null then$r$);
select pg_temp.fleet_patch('clued_private.ci_admission_failover_owner_v1(uuid)',
  $a$where (c->>'eligible')::boolean
    order by$a$,
  $r$where (c->>'eligible')::boolean and (v_trigger<>'fleet_holder_package_revoked'
      or (c->>'binding_id')::uuid=clued_private.fleet_rollback_target_v1(p_owner,v_holder,null))
    order by$r$);
select pg_temp.fleet_patch('clued_private.ci_admission_failover_owner_v1(uuid)',
  $a$else '自报节点故障 '||v_trigger end$a$,
  $r$when 'fleet_holder_package_revoked' then '在跑的包已被撤销'
      else '自报节点故障 '||v_trigger end$r$);

select pg_temp.fleet_patch('public.clued_owner_grants_list_v1(jsonb)',
  $a$(select next.version from clued_private.fleet_seals_v1(v_owner,s.grant_id) next where next.classification='current')$a$,
  $r$clued_private.fleet_revoke_preview_v1(v_owner,s.grant_id)$r$);

drop function pg_temp.fleet_patch(regprocedure,text,text);
revoke all on function clued_private.fleet_sealed_rule_active_v1(uuid,uuid),
  clued_private.fleet_node_package_at_v1(uuid,uuid,uuid),clued_private.fleet_source_reason_at_v1(uuid,uuid,text,uuid),
  clued_private.fleet_rollback_target_v1(uuid,uuid,uuid),clued_private.fleet_revoke_preview_v1(uuid,uuid),
  clued_private.fleet_requeue_unlandable_v1(uuid,uuid,uuid) from public,anon,authenticated,service_role,clued_worker_gateway;
