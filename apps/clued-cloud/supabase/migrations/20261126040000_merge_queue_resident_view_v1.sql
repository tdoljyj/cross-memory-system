-- 常驻节点队列视图（Task d4bd8faa）。上报只写本表，心跳、接班、准入和合并位各走原有路径。
create table clued_private.ci_node_queue_view_v1 (
  node_id uuid primary key references clued_private.ci_nodes_v1(node_id) on delete cascade,
  user_id uuid not null,
  reported_at timestamptz not null,
  changed_at timestamptz not null,
  view_digest text not null,
  view jsonb not null check (octet_length(view::text)<=32768),
  check (changed_at<=reported_at)
);
alter table clued_private.ci_node_queue_view_v1 enable row level security;
revoke all on table clued_private.ci_node_queue_view_v1 from public,anon,authenticated,service_role,clued_worker_gateway;

-- 节点未观测到的字段可省略或填 null。入库前逐个校验对象和数组元素。
create function clued_private.ci_node_queue_view_valid_v1(v jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare item record; field record; value_type text;
begin
  if jsonb_typeof(v) is distinct from 'object'
     or v->>'contract' is distinct from 'clued.merge-queue-node-view/1'
     or octet_length(v::text)>32768 then
    return false;
  end if;

  for item in
    select * from (values
      (v->'pending',30), (v->'unqueued',30), (v->'alerts',10), (v#>'{intakePause,holders}',8)
    ) as arrays(data,max_items)
  loop
    if item.data is null or item.data='null'::jsonb then continue; end if;
    if jsonb_typeof(item.data)<>'array' then return false; end if;
    if jsonb_array_length(item.data)>item.max_items then return false; end if;
  end loop;

  if exists (
    select 1 from jsonb_array_elements(coalesce(nullif(v->'alerts','null'::jsonb),'[]'::jsonb)) as alert(value)
    where jsonb_typeof(alert.value)<>'string' or char_length(alert.value#>>'{}')>200
  ) then
    return false;
  end if;

  for item in
    select data,shape,false as array_entry from (values
      (v, '{"contract":"string","node":"object","executor":"object","halt":"object","paused":"boolean",
        "intakePause":"object","breaker":"object","queueHold":"string","current":"object","pending":"array",
        "unqueued":"array","train":"object","alerts":"array","stall":"object"}'::jsonb),
      (v->'node', '{"name":"string","mode":"string","source":"source","generation":"uint","consistent":"boolean",
        "upgrade":"object","selfcheck":"object"}'),
      (v#>'{node,upgrade}', '{"state":"string","phase":"string","since":"time","code":"string"}'),
      (v#>'{node,selfcheck}', '{"result":"string","observedAt":"time"}'),
      (v->'executor', '{"state":"string","reason":"string","since":"time"}'),
      (v->'halt', '{"code":"string","at":"time"}'),
      (v->'intakePause', '{"until":"time","holders":"array"}'),
      (v->'breaker', '{"state":"string","nextTrialAt":"time"}'),
      (v->'current', '{"pr":"uint","headSha":"sha","stage":"uint","stageName":"string","since":"time","stageSince":"time"}'),
      (v->'train', '{"enabled":"string","last":"object"}'),
      (v#>'{train,last}', '{"at":"time","mode":"string","front":"object","wouldDo":"string","decision":"string","onDuty":"boolean"}'),
      (v#>'{train,last,front}', '{"pr":"uint"}'),
      (v->'stall', '{"code":"string","level":"string","since":"time","text":"string"}')
    ) as objects(data,shape)
    union all
      select value, '{"pr":"uint","headSha":"sha","state":"string","position":"uint","deferred":"string",
        "since":"time","nextAt":"time","holdText":"string"}'::jsonb,true
      from jsonb_array_elements(coalesce(nullif(v->'pending','null'::jsonb),'[]'::jsonb))
    union all
      select value, '{"pr":"uint","headSha":"sha"}'::jsonb,true
      from jsonb_array_elements(coalesce(nullif(v->'unqueued','null'::jsonb),'[]'::jsonb))
    union all
      select value, '{"holder":"string","since":"time","until":"time"}'::jsonb,true
      from jsonb_array_elements(coalesce(nullif(v#>'{intakePause,holders}','null'::jsonb),'[]'::jsonb))
  loop
    if not item.array_entry and (item.data is null or item.data='null'::jsonb) then continue; end if;
    if jsonb_typeof(item.data) is distinct from 'object' then return false; end if;
    for field in
      select key, value, item.shape->>key as expected from jsonb_each(item.data)
    loop
      if field.expected is null then return false; end if;
      value_type:=jsonb_typeof(field.value);
      if value_type='null' then continue; end if;
      if value_type='string' and char_length(field.value#>>'{}')>200 then return false; end if;
      if not (case field.expected
        when 'time' then value_type in ('string','number')
        when 'uint' then value_type='number' and field.value::text ~ '^(0|[1-9][0-9]*)$'
        when 'sha' then value_type='string' and (field.value#>>'{}') ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
        when 'source' then value_type='string' and (field.value#>>'{}') ~ '^([0-9a-f]{12}|[0-9a-f]{64})$'
        else value_type=field.expected
      end) then
        return false;
      end if;
    end loop;
  end loop;
  return true;
end $$;

create function clued_private.ci_queue_report_v1(b public.clued_agent_bindings,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare
  v_view jsonb:=p_input->'view';
  v_digest text;
  v_now timestamptz;
  v_node_binding uuid;
  v_reported_at timestamptz;
  v_changed_at timestamptz;
  v_changed boolean;
begin
  if jsonb_typeof(p_input) is distinct from 'object' then
    return jsonb_build_object('status','rejected','error_code','ci_queue_report_invalid');
  end if;
  if p_input-array['action','scope','view']<>'{}'::jsonb
     or (p_input ? 'scope' and jsonb_typeof(p_input->'scope')<>'string')
     or not clued_private.ci_node_queue_view_valid_v1(v_view) then
    return jsonb_build_object('status','rejected','error_code','ci_queue_report_invalid');
  end if;

  -- 沿用 ci_node_heartbeat_v1 的节点归属条件。
  if exists(select 1 from clued_private.ci_nodes_v1 n where n.user_id=b.user_id and n.binding_id=b.id
      and n.state not in ('retired','revoked')) then
    v_node_binding:=b.id;
  else
    select k.node_binding_id into v_node_binding from clued_private.ci_node_heartbeat_link_v1 k
      join public.clued_agent_bindings nb on nb.id=k.node_binding_id and nb.user_id=k.user_id
      where k.user_id=b.user_id and k.heartbeat_binding_id=b.id and k.revoked_at is null
        and clued_private.binding_live_v1(nb);
  end if;
  if v_node_binding is null then
    return jsonb_build_object('status','rejected','error_code','ci_node_not_registered');
  end if;

  v_digest:=encode(sha256(convert_to(v_view::text,'UTF8')),'hex');
  v_now:=clock_timestamp();
  with reported as (
    insert into clued_private.ci_node_queue_view_v1 as q(node_id,user_id,reported_at,changed_at,view_digest,view)
    select n.node_id,n.user_id,v_now,v_now,v_digest,v_view
    from clued_private.ci_nodes_v1 n
    where n.user_id=b.user_id and n.binding_id=v_node_binding and n.state not in ('retired','revoked')
    order by n.node_id
    on conflict (node_id) do update set
      -- 同一时钟刻度或等待同行锁的上报也要推进时间。
      reported_at=greatest(excluded.reported_at,q.reported_at+interval '1 microsecond'),
      changed_at=case when q.view_digest=excluded.view_digest then q.changed_at
        else greatest(excluded.reported_at,q.reported_at+interval '1 microsecond') end,
      view_digest=excluded.view_digest,
      view=case when q.view_digest=excluded.view_digest then q.view else excluded.view end
    returning q.reported_at,q.changed_at
  )
  select max(reported_at),max(changed_at),bool_or(reported_at=changed_at)
    into v_reported_at,v_changed_at,v_changed from reported;
  if v_reported_at is null then
    return jsonb_build_object('status','rejected','error_code','ci_node_not_registered');
  end if;
  return jsonb_build_object('status','ok','reported_at',v_reported_at,'changed_at',v_changed_at,'changed',v_changed);
end $$;

revoke all on function clued_private.ci_node_queue_view_valid_v1(jsonb),
  clued_private.ci_queue_report_v1(public.clued_agent_bindings,jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- 生产定义与迁移重放的长度 19637 和 MD5 均一致。仅插入两处分发路由，保留其余字节及原授权。
do $ci_queue_report_dispatch$
declare body text;
  heartbeat_only text:=$anchor$    return jsonb_build_object('status','rejected','error_code','heartbeat_connection_only');
$anchor$;
  after_heartbeat text:=$anchor$  if op='ci_node_heartbeat' then
    return clued_private.ci_node_heartbeat_v1(b,p_input);
  end if;
$anchor$;
begin
  body:=pg_get_functiondef('clued_private.work_claim_ci_command_v1(text,jsonb)'::regprocedure);
  if length(body)<>19637 or md5(body)<>'68068841f7ffb1c177c8cabc0516f536' then
    raise exception 'ci_queue_report_command_source_unexpected' using errcode='55000';
  end if;
  body:=replace(body,heartbeat_only,$route$    if op='ci_queue_report' then
      return clued_private.ci_queue_report_v1(hb,p_input);
    end if;
$route$||heartbeat_only);
  execute replace(body,after_heartbeat,after_heartbeat||$route$  if op='ci_queue_report' then
    return clued_private.ci_queue_report_v1(b,p_input);
  end if;
$route$);
end $ci_queue_report_dispatch$;

create function public.clued_merge_queue_resident_v1(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare
  v_owner uuid:=clued_private.authorization_owner_v12();
  v_now timestamptz:=clock_timestamp();
  v_silence_minutes integer:=(clued_private.ci_failover_rules_v1()->>'silence_minutes')::integer;
  v_holders jsonb;
  v_nodes jsonb;
begin
  if p_input is distinct from '{}'::jsonb then
    raise exception 'merge_queue_resident_input_invalid' using errcode='22023';
  end if;
  v_holders:=clued_private.binding_role_holders_v1(v_owner,'ci-admission','{}'::uuid[]);
  select coalesce(jsonb_agg(jsonb_build_object(
      'name',n.name,
      'holder',exists(select 1 from jsonb_array_elements(v_holders) as h(value)
        where h.value->>'binding_id'=n.binding_id::text and h.value->'live'='true'::jsonb
          and clued_private.binding_role_in_force_v1(v_owner,n.binding_id,'ci-admission')),
      'last_heartbeat_at',l.last_heartbeat_at,
      'reported_state',l.reported_state,
      'reported_mode',l.reported_mode,
      'reported_snapshot_age_seconds',l.reported_snapshot_age_seconds,
      'reported_source_sha256',l.reported_source_sha256,
      'silent',coalesce(v_now-l.last_heartbeat_at>make_interval(mins=>v_silence_minutes),false),
      'view_reported_at',q.reported_at,
      'view',q.view
    ) order by n.name,n.node_id),'[]'::jsonb)
    into v_nodes
    from clued_private.ci_nodes_v1 n
    left join clued_private.ci_node_liveness_v1 l on l.node_id=n.node_id and l.user_id=n.user_id
    left join clued_private.ci_node_queue_view_v1 q on q.node_id=n.node_id and q.user_id=n.user_id
    where n.user_id=v_owner and n.state not in ('retired','revoked');
  return jsonb_build_object('status','ok','observed_at',v_now,
    'rules',jsonb_build_object('silence_minutes',v_silence_minutes),'nodes',v_nodes);
end $$;

revoke all on function public.clued_merge_queue_resident_v1(jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;
grant execute on function public.clued_merge_queue_resident_v1(jsonb) to authenticated;
notify pgrst,'reload schema';
