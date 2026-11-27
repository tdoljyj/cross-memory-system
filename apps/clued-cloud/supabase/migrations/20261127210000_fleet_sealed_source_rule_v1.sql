-- d398d049：封存、撤销、摘牌和角色交接使用同一账号的角色锁。
set local lock_timeout = '5s';

alter table clued_private.fleet_accepted_v1
  add column source_sha256 text check (source_sha256 ~ '^[0-9a-f]{64}$'),
  add column source_commit text check (source_commit ~ '^[0-9a-f]{40}$'),
  add column promotion_paused_at timestamptz;

alter table clued_private.fleet_node_delivery_evidence_v1 add column runtime jsonb;

create table clued_private.fleet_maintenance_v1 (
  node_id uuid primary key references clued_private.ci_nodes_v1 on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  binding_generation bigint not null,
  operation_id uuid not null,
  grant_id uuid references clued_private.fleet_accepted_v1(grant_id),
  state text not null check (state in ('reserve','delisted','repair','returned')),
  method text not null check (method in ('in_place','reinstall','handover','failure')),
  successor uuid references clued_private.ci_nodes_v1,
  started_at timestamptz not null default clock_timestamp(),
  verify_started_at timestamptz,
  initial_receipt text,
  delist_receipt_id uuid references public.clued_audit_receipts,
  verify_receipt_id uuid references public.clued_audit_receipts,
  restore_train_generation bigint,
  receipt_id uuid references public.clued_audit_receipts,
  alerted_at timestamptz,
  verify_alerted_at timestamptz,
  reinstall_peers jsonb,
  reinstall_pause_until timestamptz,
  reinstall_pause_receipt_id uuid references public.clued_audit_receipts,
  reinstall_resume_receipt_id uuid references public.clued_audit_receipts,
  reinstall_pause_alerted_at timestamptz,
  owner_repair_required boolean not null default false
);
alter table clued_private.fleet_maintenance_v1 enable row level security;
revoke all on clued_private.fleet_maintenance_v1 from public,anon,authenticated,service_role,clued_worker_gateway;

-- 续期或重新绑定改变登记代次。继续隔离同一节点，旧凭据、旧自检均不能解除维护。
create function clued_private.fleet_maintenance_rebind_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  update clued_private.fleet_maintenance_v1 set binding_generation=new.binding_generation,verify_started_at=null,
    verify_alerted_at=null where node_id=old.node_id and user_id=old.user_id
    and binding_generation=old.binding_generation and state<>'returned';
  return new;
end $$;
create trigger fleet_maintenance_rebind after update of binding_generation on clued_private.ci_nodes_v1
  for each row when (old.binding_generation is distinct from new.binding_generation)
  execute function clued_private.fleet_maintenance_rebind_v1();

-- 保留封存序列的相邻关系，撤销夹在中间的一包时不得越过它借用更老的一包。
create function clued_private.fleet_seals_v1(u uuid,preview_revoke uuid default null)
returns table(grant_id uuid, version text, source text, source_commit text, classification text)
language sql stable set search_path='' as $$
  with ordered as (
    select a.*, g.revoked_at, i.repository is not null as trusted,
      row_number() over(partition by (i.repository is not null) order by clued_private.fleet_package_generation_v1(a.version) desc,
      a.sealed_at desc,a.grant_id desc) as seq
    from clued_private.fleet_accepted_v1 a
    left join clued_private.release_identity_v1 i using(user_id,repository)
    join clued_private.owner_grants_v1 g on g.id=a.grant_id and g.user_id=a.user_id
    where a.user_id=u and a.sealed_at is not null and a.source_sha256 is not null
  ), ranked as (select *,min(seq) filter(where trusted and revoked_at is null and grant_id is distinct from preview_revoke) over() as first_live from ordered)
  select grant_id,version,source_sha256,source_commit,case when not trusted then 'outside' when revoked_at is not null or grant_id=preview_revoke then 'revoked'
    when seq=first_live then 'current' when seq=first_live+1 then 'previous' else 'outside' end from ranked
$$;

create function clued_private.fleet_node_package_v1(u uuid,node uuid)
returns jsonb language sql stable set search_path='' as $$
  with seals as materialized (select * from clued_private.fleet_seals_v1(u)),
  live as (
    select n.node_id,l.reported_source_sha256 as source,l.last_heartbeat_at,
      e.evidence->>'packageGeneration' as generation,
      e.evidence->>'linuxSourceSha256'=l.reported_source_sha256 as linux_matches,
      coalesce(m.state,'available') as maintenance
    from clued_private.ci_nodes_v1 n
    left join clued_private.ci_node_liveness_v1 l using(node_id,user_id)
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
  select jsonb_build_object('classification',case when not exists(table seals) then 'legacy'
    when l.source is null then 'unknown' else coalesce((select classification from unique_match),'outside') end,
    'grantId',(select grant_id from unique_match),'source',l.source,'maintenance',coalesce(l.maintenance,'available'),
    'heartbeatAt',l.last_heartbeat_at)
  from (values (1)) d(i) left join live l on true
$$;

create function clued_private.fleet_source_reason_v1(u uuid,node uuid,purpose text)
returns text language plpgsql stable set search_path='' as $$
declare info jsonb:=clued_private.fleet_node_package_v1(u,node); c text:=info->>'classification';
begin
  if info->>'maintenance'<>'available' and not (purpose='failover' and info->>'maintenance'='reserve') then
    return 'ci_admission_target_in_maintenance'; end if;
  if info->>'source' is null then return 'ci_admission_target_source_unknown'; end if;
  if c='legacy' then
    if exists(select 1 from clued_private.ci_node_liveness_v1 l join clued_private.ci_nodes_v1 n using(node_id,user_id)
      where n.user_id=u and n.node_id<>node and n.state not in ('retired','revoked') and n.revoked_at is null
        and not exists(select 1 from clued_private.fleet_maintenance_v1 m where m.node_id=n.node_id
          and m.binding_generation=n.binding_generation and m.state in ('delisted','repair'))
        and l.last_heartbeat_at>statement_timestamp()-make_interval(hours=>(clued_private.ci_failover_rules_v1()->>'source_window_hours')::int)
        and l.reported_source_sha256<>info->>'source') then return 'ci_admission_target_source_not_accepted'; end if;
  elsif c<>'current' and not (c='previous' and purpose in ('holder','failover')) then
    return 'ci_admission_target_source_not_accepted';
  end if;
  return null;
end $$;

create function clued_private.fleet_role_lock_v1(u uuid) returns void
language sql volatile set search_path='' as $$
  select pg_advisory_xact_lock(hashtextextended('clued-binding-role:'||u||':ci-admission',0))
$$;

-- 仅在本事务内改写既有入口，锚点缺失或不唯一即回滚整次迁移。
create function clued_private.fleet_patch_v1(sig regprocedure,anchor text,replacement text) returns void
language plpgsql set search_path='' as $$
declare body text:=pg_get_functiondef(sig);
begin
  if length(body)-length(replace(body,anchor,''))<>length(anchor) then
    raise exception 'fleet_source_patch_anchor_mismatch: % (%)',sig,left(anchor,96); end if;
  execute replace(body,anchor,replacement);
end $$;

-- 先选封存序列的紧邻前代，再判断它是否缺证；不跨过已补证的包去找更老的一行。
create function clued_private.fleet_previous_seal_v1(u uuid,repo text,v text)
returns setof clued_private.fleet_accepted_v1 language sql stable set search_path='' as $$
  select p.* from (select a.* from clued_private.fleet_accepted_v1 a
    where a.user_id=u and a.repository=repo and a.sealed_at is not null
      and clued_private.fleet_package_generation_v1(a.version)<clued_private.fleet_package_generation_v1(v)
    order by clued_private.fleet_package_generation_v1(a.version) desc,a.sealed_at desc,a.grant_id desc limit 1) p
  where p.source_sha256 is null
$$;

select clued_private.fleet_patch_v1('clued_private.fleet_delivery_registry_v1(jsonb)',
$a$  return result;$a$,
$r$  return result||jsonb_build_object('previousSeal',(select jsonb_build_object('version',p.version,'requestSha256',p.request_sha256)
    from clued_private.fleet_previous_seal_v1(identity.user_id,identity.repository,c->>'version') p));$r$);

-- 发布端传回原请求的逐字节副本。封存事务用旧账本的摘要验明它，Source 和 commit 均取自同一份请求。
create function clued_private.fleet_backfill_previous_v1(a clued_private.fleet_accepted_v1,encoded text)
returns void language plpgsql volatile set search_path='' as $$
declare p clued_private.fleet_accepted_v1; bytes bytea; request jsonb;
begin
  select * into p from clued_private.fleet_previous_seal_v1(a.user_id,a.repository,a.version);
  if not found then return; end if;
  if encoded is null or length(encoded)>1398104 then raise exception 'fleet_previous_seal_request_required'; end if;
  bytes:=decode(encoded,'base64');
  if encode(extensions.digest(bytes,'sha256'),'hex')<>p.request_sha256 then raise exception 'fleet_previous_seal_digest_changed'; end if;
  request:=convert_from(bytes,'UTF8')::jsonb;
  if request->>'contract' is distinct from 'clued.independent-ci.fleet-node-acceptance-request/1'
    or request->>'repository' is distinct from p.repository or request->>'version' is distinct from p.version
    or request->>'archive_sha256' is distinct from p.archive_sha256
    or coalesce(request->>'ciSourceManifestSha256','') !~ '^[0-9a-f]{64}$'
    or coalesce(request->>'commit','') !~ '^[0-9a-f]{40}$' then raise exception 'fleet_previous_seal_identity_invalid'; end if;
  update clued_private.fleet_accepted_v1 set source_sha256=request->>'ciSourceManifestSha256',source_commit=request->>'commit'
    where grant_id=p.grant_id and source_sha256 is null;
end $$;

select clued_private.fleet_patch_v1('clued_private.fleet_delivery_seal_v1(jsonb)',
$a$  select accepted.* into a$a$,
$r$  perform clued_private.fleet_role_lock_v1((select r.user_id from clued_private.release_identity_v1 r
    where r.repository=candidate->>'repository'));
  select accepted.* into a$r$);

select clued_private.fleet_patch_v1('clued_private.fleet_delivery_seal_v1(jsonb)',
$a$set sealed_at=at_time,acceptance_sha256=d$a$,
$r$set sealed_at=at_time,acceptance_sha256=d,
      source_sha256=candidate->>'sourceSha256',source_commit=candidate->>'commit'$r$);

select clued_private.fleet_patch_v1('clued_private.fleet_delivery_seal_v1(jsonb)',
$a$    at_time:=a.sealed_at;$a$,
$r$    if a.source_sha256 is not null and (a.source_sha256 is distinct from candidate->>'sourceSha256'
      or a.source_commit is distinct from candidate->>'commit') then
      raise exception 'fleet_delivery_seal_conflict' using errcode='22023'; end if;
    if a.source_sha256 is null then
      -- 旧行的补证与正式封存使用相同发布身份、资产摘要和候选字段校验。
      perform clued_private.fleet_delivery_require_snapshot_v1(candidate,p_input->>'snapshotToken');
      update clued_private.fleet_accepted_v1 set source_sha256=candidate->>'sourceSha256',source_commit=candidate->>'commit' where grant_id=a.grant_id;
    end if;
    at_time:=a.sealed_at;$r$);

select clued_private.fleet_patch_v1('public.clued_owner_grant_revoke_v1(jsonb)',
$a$  select * into g$a$,
$r$  perform clued_private.fleet_role_lock_v1(v_owner);
  select * into g$r$);

select clued_private.fleet_patch_v1('public.clued_owner_grant_revoke_v1(jsonb)',
$a$  if g.revoked_at is not null then$a$,
$r$  if exists(select 1 from clued_private.fleet_accepted_v1 a where a.grant_id=g.id and a.sealed_at is not null) then
    if not exists(select 1 from clued_private.fleet_accepted_v1 a where a.grant_id=g.id
      and a.acceptance_sha256=p_input->>'acceptance_sha256') then
      raise exception 'fleet_revoke_subject_changed' using errcode='40001'; end if;
    if g.revoked_at is not null then
      return jsonb_build_object('status','committed','replayed',true,'current_package',(select to_jsonb(s) from clued_private.fleet_seals_v1(v_owner) s where s.classification='current'),
        'receipt_id',(select r.id from public.clued_audit_receipts r
        where r.user_id=v_owner and r.operation='owner_grant_revoke' and r.object_id=g.id::text order by created_at desc limit 1)); end if;
    if not exists(select 1 from clued_private.fleet_seals_v1(v_owner) s where s.grant_id=g.id and s.classification='current') then
      raise exception 'fleet_revoke_subject_changed' using errcode='40001'; end if;
  end if;
  if g.revoked_at is not null then$r$);

select clued_private.fleet_patch_v1('public.clued_owner_grant_revoke_v1(jsonb)',
$a$  return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,'grant_id',g.id);$a$,
$r$  return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,'grant_id',g.id)
    ||case when exists(select 1 from clued_private.fleet_accepted_v1 a where a.grant_id=g.id and a.sealed_at is not null)
      then jsonb_build_object('current_package',(select to_jsonb(s) from clued_private.fleet_seals_v1(v_owner) s where s.classification='current'))
      else '{}'::jsonb end;$r$);

select clued_private.fleet_patch_v1('public.clued_owner_grants_list_v1(jsonb)',
$a$'pending_requests',$a$,
$r$'sealed_packages',coalesce((select jsonb_agg(jsonb_build_object('version',s.version,'grant_id',s.grant_id,
      'acceptance_sha256',a.acceptance_sha256,'classification',s.classification,'after_revoke_version',
      case when s.classification='current' then (select next.version from clued_private.fleet_seals_v1(v_owner,s.grant_id) next where next.classification='current') end) order by s.classification)
      from clued_private.fleet_seals_v1(v_owner) s join clued_private.fleet_accepted_v1 a using(grant_id)
      where s.classification in ('current','previous')),'[]'::jsonb),
    'pending_requests',$r$);

-- 接班资格的故障参数只由已核定触发原因的私有看门狗传入。
create function clued_private.fleet_target_require_v1(u uuid,destination uuid,purpose text) returns void
language plpgsql stable set search_path='' as $$
declare n clued_private.ci_node_liveness_v1:=clued_private.ci_failover_node_v1(u,destination);
  code text;
begin
  code:=case when n.last_heartbeat_at is null or n.last_heartbeat_at<=clock_timestamp()
    -make_interval(mins=>(clued_private.ci_failover_rules_v1()->>'target_heartbeat_minutes')::int)
    then 'ci_admission_target_not_heard'
    when n.reported_state in ('HALTED','PAUSED','INTAKE_PAUSED') then 'ci_admission_target_'||lower(n.reported_state)
    when n.reported_state is distinct from 'NORMAL' then 'ci_admission_target_state_unknown'
    else clued_private.fleet_source_reason_v1(u,n.node_id,purpose) end;
  if code is not null then raise exception '%',code using errcode='22023'; end if;
end $$;
create or replace function clued_private.ci_admission_target_require_v1(p_owner uuid,p_to uuid) returns void
language sql stable security definer set search_path='' as $$
  select clued_private.fleet_target_require_v1(p_owner,p_to,'handover')
$$;

-- 保留包括后续加固在内的全部非版本准入检查。
do $$
declare body text; anchor constant text:='ci_admission_target_require_v1(p_from.user_id,p_to.id)';
begin
  select prosrc into strict body from pg_proc where oid=
    'clued_private.binding_role_handover_check_v1(public.clued_agent_bindings,public.clued_agent_bindings)'::regprocedure;
  if length(body)-length(replace(body,anchor,''))<>length(anchor) then raise exception 'fleet_handover_signature'; end if;
  execute format('create function clued_private.fleet_handover_check_v1(p_from public.clued_agent_bindings,
    p_to public.clued_agent_bindings,purpose text) returns void language plpgsql stable security definer set search_path=%L as %L',
    '',replace(body,anchor,'fleet_target_require_v1(p_from.user_id,p_to.id,purpose)'));
end $$;
create or replace function clued_private.binding_role_handover_check_v1(p_from public.clued_agent_bindings,p_to public.clued_agent_bindings)
returns void language sql stable security definer set search_path='' as $$
  select clued_private.fleet_handover_check_v1(p_from,p_to,'handover')
$$;

select clued_private.fleet_patch_v1('clued_private.binding_role_handover_core_v1(uuid,uuid,uuid,text,jsonb)',
$a$perform clued_private.binding_role_handover_check_v1(f,t);$a$,
$r$perform clued_private.fleet_handover_check_v1(f,t,case when p_receipt->>'principal'='server_watchdog'
    and p_receipt->>'receipt_kind'='CI_ADMISSION_AUTO_HANDOVER' and p_receipt->>'trigger' is not null
    then 'failover' else 'handover' end);$r$);

select clued_private.fleet_patch_v1('clued_private.ci_failover_candidates_v1(uuid,uuid,text,timestamptz,timestamptz)',
$a$      elsif p_holder_source is not null$a$,
$r$      elsif (clued_private.fleet_node_package_v1(p_owner,n.node_id)->>'classification')<>'legacy'
        or exists(select 1 from clued_private.fleet_maintenance_v1 x where x.user_id=p_owner and x.state<>'returned') then
        if clued_private.fleet_source_reason_v1(p_owner,n.node_id,'failover') is not null then
          v_reasons:=array_append(v_reasons,clued_private.fleet_source_reason_v1(p_owner,n.node_id,'failover')); end if;
      elsif p_holder_source is not null$r$);

select clued_private.fleet_patch_v1('clued_private.ci_renewal_handover_v1(clued_private.ci_nodes_v1,public.clued_agent_bindings,clued_private.authorizations_v12,timestamptz,timestamptz)',
$a$where (c->>'eligible')::boolean order by$a$,
$r$where (c->>'eligible')::boolean and clued_private.fleet_source_reason_v1(n.user_id,
      (clued_private.ci_failover_node_v1(n.user_id,(c->>'binding_id')::uuid)).node_id,'handover') is null order by$r$);

create function clued_private.fleet_other_healthy_v1(u uuid,node uuid) returns boolean
language sql stable set search_path='' as $$
  select exists(select 1 from clued_private.ci_nodes_v1 n
    join public.clued_agent_bindings b on b.id=n.binding_id and b.user_id=n.user_id
    join clued_private.ci_node_liveness_v1 l using(node_id)
    where n.user_id=u and n.node_id<>node and n.revoked_at is null and n.state in ('active','draining','pending')
      and clued_private.binding_live_v1(b) and l.user_id=u and l.reported_state='NORMAL' and l.reported_service_running
      and l.last_heartbeat_at between statement_timestamp()-interval '5 minutes' and statement_timestamp()
      and clued_private.fleet_node_package_v1(u,n.node_id)->>'maintenance'='available'
      and clued_private.fleet_source_reason_v1(u,n.node_id,'holder') is null)
$$;

create table clued_private.fleet_landing_v1 (
  user_id uuid not null references auth.users on delete cascade,
  effect_key text not null, node_id uuid not null references clued_private.ci_nodes_v1,
  grant_id uuid not null references clued_private.fleet_accepted_v1(grant_id),
  binding_generation bigint not null, base_sha text not null, test_sha text not null,
  started_at timestamptz not null default clock_timestamp(), settled_at timestamptz,
  primary key(user_id,effect_key)
);
alter table clued_private.fleet_landing_v1 enable row level security;
revoke all on clued_private.fleet_landing_v1 from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.fleet_node_busy_v1(node uuid) returns boolean
language sql stable set search_path='' as $$
  select exists(select 1 from clued_private.fleet_landing_v1 where node_id=node and settled_at is null
    and started_at>statement_timestamp()-interval '5 minutes')
    or exists(select 1 from clued_private.ci_job_leases_v1 where holder_node_id=node
    and state='current' and expires_at>statement_timestamp())
    or exists(select 1 from clued_private.ci_train_work_v2 where node_id=node and state='leased' and expires_at>statement_timestamp())
    or exists(select 1 from clued_private.ci_train_batches_v2 where node_id=node and state not in ('completed','invalidated'))
$$;

create function clued_private.fleet_time_v1(value text) returns timestamptz
language plpgsql stable strict set search_path='' as $$
begin
  if value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9:]+)$' then return null; end if;
  return value::timestamptz;
exception when data_exception then return null;
end $$;

create function clued_private.fleet_selfcheck_v1(u uuid,node uuid,since_at timestamptz) returns boolean
language sql stable set search_path='' as $$
  select exists(select 1 from clued_private.ci_nodes_v1 n
    join clued_private.ci_node_liveness_v1 l using(user_id,node_id)
    join clued_private.fleet_node_delivery_evidence_v1 e using(user_id,node_id)
    left join clued_private.ci_node_queue_view_v1 q using(user_id,node_id)
    where n.user_id=u and n.node_id=node and e.binding_generation=n.binding_generation and e.registration_version=n.version
      and e.heartbeat_sequence=l.heartbeat_sequence and e.observed_at=l.last_heartbeat_at
      and e.observed_at between greatest(since_at,statement_timestamp()-interval '5 minutes') and statement_timestamp()
      and clued_private.fleet_time_v1(e.evidence->>'brokerObservedAt') between greatest(since_at,statement_timestamp()-interval '5 minutes') and statement_timestamp()
      and clued_private.fleet_time_v1(e.evidence->>'linuxObservedAt') between greatest(since_at,statement_timestamp()-interval '5 minutes') and statement_timestamp()
      and l.reported_state='NORMAL' and l.reported_service_running and e.evidence->>'windowsSourceSha256'=l.reported_source_sha256
      and e.evidence->>'linuxSourceSha256'=l.reported_source_sha256
      and e.evidence @> '{"linuxReady":true,"linuxConsistent":true,"acl":true,"connectionCarry":true,"operations":true,"processClearance":true}'
      and (case when e.runtime->>'selfcheckAt' ~ '^[0-9T:.Z+-]{20,40}$'
        then clued_private.fleet_time_v1(e.runtime->>'selfcheckAt') between greatest(since_at,statement_timestamp()-interval '5 minutes') and statement_timestamp()
        else false end or (q.reported_at between greatest(since_at,statement_timestamp()-interval '5 minutes') and statement_timestamp()
      and q.view#>>'{node,selfcheck,result}'='PASS'
      and case when q.view#>>'{node,selfcheck,observedAt}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$'
        then clued_private.fleet_time_v1(q.view#>>'{node,selfcheck,observedAt}') between greatest(since_at,statement_timestamp()-interval '5 minutes') and statement_timestamp()
        else false end)))
$$;

create function clued_private.fleet_install_ready_v1(u uuid,node uuid,target uuid) returns boolean
language sql stable set search_path='' as $$
  select exists(select 1 from clued_private.ci_nodes_v1 n join clued_private.fleet_maintenance_v1 m using(user_id,node_id,binding_generation)
    where n.user_id=u and n.node_id=node and n.revoked_at is null and m.state='delisted' and m.grant_id=target
      and m.verify_started_at is null and m.verify_receipt_id is null
      and not clued_private.fleet_node_busy_v1(node) and not exists(select 1 from clued_private.ci_duty_answers_v1 d
        where d.user_id=u and d.binding_id=n.binding_id
          and d.at>statement_timestamp()-make_interval(secs=>clued_private.ci_failover_quiet_seconds_v1())))
$$;

-- The last holder stops taking new work as soon as it delists. Keep its signed
-- in-flight work reconcilable until the existing drain and quiet checks pass.
create function clued_private.fleet_reinstall_pause_v1(u uuid,node uuid,target uuid) returns void
language plpgsql volatile set search_path='' as $$
declare m clued_private.fleet_maintenance_v1; n clued_private.ci_nodes_v1; r uuid;
begin
  select * into m from clued_private.fleet_maintenance_v1 x where x.user_id=u and x.node_id=node
    and x.grant_id=target and x.reinstall_peers is not null and x.reinstall_pause_receipt_id is null;
  if not found or not clued_private.fleet_install_ready_v1(u,node,target) then return; end if;
  select * into strict n from clued_private.ci_nodes_v1 where node_id=node and user_id=u;
  r:=clued_private.ci_receipt_v1(u,n.project_id,'fleet_reinstall_train_paused',node::text,
    jsonb_build_object('operation_id',m.operation_id,'grant_id',target,'reason','no_healthy_handover_target',
      'deadline',m.reinstall_pause_until,'recovery','verify_reinstalled_nodes_as_standby_then_restore_duty','peers',m.reinstall_peers));
  perform clued_private.ci_train_release_v1(u,n.project_id,node,l.generation)
    from clued_private.ci_train_lease_v1 l where l.user_id=u and l.project_id=n.project_id
    and l.holder_node_id=node and l.state in ('active','sweep_required');
  update clued_private.binding_roles_v1 set revoked_at=clock_timestamp(),revoked_receipt_id=r
    where user_id=u and binding_id=n.binding_id and role='ci-admission' and purpose in ('resident-node','unspecified') and revoked_at is null;
  update clued_private.fleet_maintenance_v1 set reinstall_pause_receipt_id=r where node_id=node;
end $$;

-- status、delist、verify_started 都绑定登记代次；install_ready 才允许停写本机。
create function clued_private.fleet_maintenance_request_v1(u uuid,caller uuid,input jsonb)
returns jsonb language plpgsql volatile set search_path='' as $$
declare n clued_private.ci_nodes_v1; m clued_private.fleet_maintenance_v1; op uuid; target uuid;
  action text:=input->>'action'; method text:=input->>'method'; others boolean; info jsonb; r uuid;
  repeat_drain boolean; ready boolean; peers jsonb;
begin
  if jsonb_typeof(input) is distinct from 'object'
    or input-array['action','scope','node_id','binding_generation','grant_id','operation_id','method','sole_node_agreed']<>'{}'::jsonb then
    raise exception 'fleet_maintenance_input_invalid' using errcode='22023'; end if;
  perform clued_private.work_claim_lock(u);
  perform clued_private.fleet_role_lock_v1(u);
  select * into n from clued_private.ci_nodes_v1 where user_id=u and node_id=(input->>'node_id')::uuid
    and revoked_at is null and state not in ('retired','revoked') for update;
  if not found or (caller is not null and caller<>n.binding_id) then
    raise exception 'fleet_maintenance_identity_refused' using errcode='42501'; end if;
  if n.binding_generation::text is distinct from input->>'binding_generation' then
    raise exception 'fleet_maintenance_generation_changed' using errcode='40001'; end if;
  select * into m from clued_private.fleet_maintenance_v1 where node_id=n.node_id and binding_generation=n.binding_generation;
  select grant_id into target from clued_private.fleet_seals_v1(u) where classification='current';
  others:=clued_private.fleet_other_healthy_v1(u,n.node_id);
  info:=clued_private.fleet_node_package_v1(u,n.node_id);
  if action not in ('status','delist','cancel','verify_started','repair_complete') or action is null then
    raise exception 'fleet_maintenance_action_invalid' using errcode='22023'; end if;
  if action<>'status' then
    op:=(input->>'operation_id')::uuid;
    if op is null or target is null or target::text is distinct from input->>'grant_id' then
      raise exception 'fleet_maintenance_target_changed' using errcode='40001'; end if;
    if action='cancel' then
      if m.operation_id is distinct from op or m.grant_id is distinct from target then
        raise exception 'fleet_maintenance_operation_conflict'; end if;
      if m.state='returned' and exists(select 1 from public.clued_audit_receipts where id=m.receipt_id and operation='fleet_delist_cancel') then
        null;
      else
        -- 一项摘牌前已有且仍有效的发送意图、工作租约或准入安静期证明从未给出清理许可。
        if m.state<>'delisted' or m.method not in ('in_place','reinstall') or m.owner_repair_required
          or m.verify_started_at is not null or info->>'classification' not in ('current','previous')
          or m.initial_receipt is null or not clued_private.fleet_selfcheck_v1(u,n.node_id,m.started_at)
          or not exists(select 1 from clued_private.fleet_node_delivery_evidence_v1 e where e.node_id=n.node_id
            and e.evidence->>'installReceiptSha256'=m.initial_receipt)
          or not (exists(select 1 from clued_private.fleet_landing_v1 l where l.node_id=n.node_id and l.settled_at is null
            and l.started_at<=m.started_at and l.started_at>statement_timestamp()-interval '5 minutes')
            or exists(select 1 from clued_private.ci_job_leases_v1 l where l.holder_node_id=n.node_id and l.state='current'
              and l.issued_at<=m.started_at and l.expires_at>statement_timestamp())
            or exists(select 1 from clued_private.ci_duty_answers_v1 d where d.user_id=u and d.binding_id=n.binding_id
              and d.at<=m.started_at and d.at>statement_timestamp()-make_interval(secs=>clued_private.ci_failover_quiet_seconds_v1()))) then
          raise exception 'fleet_maintenance_cancel_not_verified' using errcode='55000'; end if;
        r:=clued_private.ci_receipt_v1(u,n.project_id,'fleet_delist_cancel',n.node_id::text,input);
        update clued_private.fleet_maintenance_v1 set state='returned',receipt_id=r where node_id=n.node_id;
      end if;
    elsif action='repair_complete' then
      if caller is not null or m.operation_id is distinct from op or m.grant_id is distinct from target then
        raise exception 'fleet_maintenance_repair_owner_required' using errcode='42501'; end if;
      if m.state<>'returned' then
        if not m.owner_repair_required or info->>'classification'<>'current'
          or not clued_private.fleet_selfcheck_v1(u,n.node_id,m.started_at)
          or not exists(select 1 from clued_private.ci_node_liveness_v1 l where l.node_id=n.node_id
            and l.reported_mode='STANDBY' and l.reported_probe='not-held') then raise exception 'fleet_repair_not_verified'; end if;
        r:=clued_private.ci_receipt_v1(u,n.project_id,'fleet_repair_complete',n.node_id::text,input);
        update clued_private.fleet_maintenance_v1 set state='returned',receipt_id=r,owner_repair_required=false where node_id=n.node_id;
        if not exists(select 1 from clued_private.fleet_maintenance_v1 x where x.user_id=u and x.grant_id=target
          and x.owner_repair_required) then
          update clued_private.fleet_accepted_v1 set promotion_paused_at=null where grant_id=target; end if;
      end if;
    elsif action='delist' then
      if method is null or method not in ('in_place','reinstall') then raise exception 'fleet_maintenance_method_invalid'; end if;
      if others and exists(select 1 from clued_private.ci_duty_holder_v1(u,n.project_id) h where h.binding_id=n.binding_id) then
        raise exception 'fleet_maintenance_handover_first' using errcode='55000'; end if;
      if m.operation_id=op and (m.grant_id<>target or m.method<>method) then raise exception 'fleet_maintenance_operation_conflict'; end if;
      repeat_drain:=m.operation_id=op and (m.verify_started_at is not null or m.verify_receipt_id is not null);
      if m.operation_id is distinct from op or repeat_drain then
        if m.operation_id is distinct from op and exists(select 1 from public.clued_audit_receipts a where a.user_id=u and a.object_id=n.node_id::text
          and a.operation='fleet_delist' and a.metadata->>'operation_id'=op::text) then
          raise exception 'fleet_maintenance_operation_conflict' using errcode='40001'; end if;
        if m.state='reserve' or (m.state='delisted' and m.grant_id=target and m.method<>'handover' and not repeat_drain)
          or (m.owner_repair_required and caller is not null) then raise exception 'fleet_maintenance_operation_conflict'; end if;
        if not others and method='reinstall' and input->'sole_node_agreed' is distinct from 'true'::jsonb then
          raise exception 'fleet_maintenance_last_node' using errcode='55000'; end if;
        -- 单机原地升级例外不能让并发摘牌的第二台也自称唯一一台。
        if not others and method='in_place' and coalesce(m.state,'available')<>'delisted' and exists(select 1 from clued_private.fleet_maintenance_v1 x
          join clued_private.ci_nodes_v1 peer on peer.node_id=x.node_id and peer.binding_generation=x.binding_generation
          where x.user_id=u and x.node_id<>n.node_id and x.state='delisted' and peer.revoked_at is null) then
          raise exception 'fleet_maintenance_last_node' using errcode='55000'; end if;
        if not others and method='in_place' and not exists(select 1 from clued_private.fleet_node_delivery_evidence_v1 e
          join clued_private.ci_node_liveness_v1 l using(user_id,node_id)
          where e.node_id=n.node_id and e.registration_version=n.version and e.binding_generation=n.binding_generation
            and e.heartbeat_sequence=l.heartbeat_sequence and e.observed_at=l.last_heartbeat_at
            and e.observed_at between statement_timestamp()-interval '5 minutes' and statement_timestamp()
            and e.evidence->>'upgraderSha256' is not null and e.evidence->>'linuxToolSha256' is not null
            and e.evidence @> '{"acl":true,"operations":true,"connectionCarry":true,"processClearance":true}') then
          raise exception 'fleet_in_place_capability_unverified' using errcode='55000'; end if;
        if not others and method='reinstall' and exists(select 1 from clued_private.ci_duty_holder_v1(u,n.project_id) h
          where h.binding_id=n.binding_id) then
          select jsonb_agg(jsonb_build_object('node_id',x.node_id,'operation_id',x.operation_id,
            'binding_generation',x.binding_generation) order by x.node_id) into peers
            from clued_private.fleet_maintenance_v1 x join clued_private.ci_nodes_v1 peer using(node_id,user_id,binding_generation)
            where x.user_id=u and x.node_id<>n.node_id and x.grant_id=target and x.state='delisted'
              and x.method='reinstall' and peer.revoked_at is null and peer.state not in ('revoked','retired');
        end if;
        r:=clued_private.ci_receipt_v1(u,n.project_id,'fleet_delist',n.node_id::text,input-'sole_node_agreed');
        insert into clued_private.fleet_maintenance_v1(node_id,user_id,binding_generation,operation_id,grant_id,state,method,receipt_id,delist_receipt_id)
          values(n.node_id,u,n.binding_generation,op,target,'delisted',method,r,r)
          on conflict(node_id) do update set binding_generation=excluded.binding_generation,operation_id=op,grant_id=target,
            state='delisted',method=excluded.method,started_at=clock_timestamp(),verify_started_at=null,successor=null,
            alerted_at=null,verify_alerted_at=null,receipt_id=r,delist_receipt_id=r,verify_receipt_id=null,restore_train_generation=null;
        update clued_private.fleet_maintenance_v1 set initial_receipt=(select evidence->>'installReceiptSha256'
          from clued_private.fleet_node_delivery_evidence_v1 where node_id=n.node_id),
          reinstall_peers=case when repeat_drain then m.reinstall_peers else peers end,
          reinstall_pause_until=case when repeat_drain then m.reinstall_pause_until
            when peers is not null then clock_timestamp()+interval '2 hours' end,
          reinstall_pause_receipt_id=case when repeat_drain then m.reinstall_pause_receipt_id end,
          reinstall_resume_receipt_id=null,reinstall_pause_alerted_at=case when repeat_drain then m.reinstall_pause_alerted_at end
          where node_id=n.node_id;
        if peers is null and (not repeat_drain or m.reinstall_peers is null) then
          perform clued_private.ci_train_release_v1(u,n.project_id,n.node_id,l.generation)
            from clued_private.ci_train_lease_v1 l where l.user_id=u and l.project_id=n.project_id
            and l.holder_node_id=n.node_id and l.state in ('active','sweep_required');
          update clued_private.binding_roles_v1 set revoked_at=clock_timestamp(),revoked_receipt_id=r
            where user_id=u and binding_id=n.binding_id and role='ci-admission' and purpose in ('resident-node','unspecified') and revoked_at is null;
        end if;
      end if;
    else
      if m.operation_id is distinct from op or m.state not in ('delisted','returned') or m.grant_id<>target then raise exception 'fleet_maintenance_operation_conflict'; end if;
      if m.state='delisted' and m.verify_started_at is null then
        r:=clued_private.ci_receipt_v1(u,n.project_id,'fleet_verify_started',n.node_id::text,input);
        update clued_private.fleet_maintenance_v1 set verify_started_at=clock_timestamp(),receipt_id=r,verify_receipt_id=r where node_id=n.node_id;
      end if;
    end if;
    select * into strict m from clued_private.fleet_maintenance_v1 where node_id=n.node_id;
    if action='delist' then r:=m.delist_receipt_id;
    elsif action='verify_started' then r:=m.verify_receipt_id; end if;
  end if;
  perform clued_private.fleet_reinstall_pause_v1(u,n.node_id,target);
  ready:=clued_private.fleet_install_ready_v1(u,n.node_id,target);
  return jsonb_build_object('status','ok','node_id',n.node_id,'binding_generation',n.binding_generation,'has_other_healthy',others,
    'state',coalesce(m.state,'available'),'operation_id',m.operation_id,'receipt_id',coalesce(r,m.receipt_id),'grant_id',target,
    'install_ready',ready,'drain_confirmed_at',case when ready then clock_timestamp() end);
end $$;

-- Owner 使用已有 Native 账号会话，节点通过原 CI 命令门并复核自身 Binding。
create function public.clued_fleet_maintenance_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  return clued_private.fleet_maintenance_request_v1(clued_private.authorization_owner_v12(),null,p_input);
end $$;
revoke all on function public.clued_fleet_maintenance_v1(jsonb) from public,anon,authenticated,service_role,clued_worker_gateway;
grant execute on function public.clued_fleet_maintenance_v1(jsonb) to authenticated;

select clued_private.fleet_patch_v1('clued_private.work_claim_ci_command_v1(text,jsonb)',
$a$  if op='ci_queue_report' then
    return clued_private.ci_queue_report_v1(b,p_input);$a$,
$r$  if op='fleet_landing' then return clued_private.fleet_landing_command_v1(b,p_input); end if;
  if op='fleet_maintenance' then
    return clued_private.fleet_maintenance_request_v1(b.user_id,b.id,(p_input-'command')||jsonb_build_object('action',p_input->>'command'));
  end if;
  if op='ci_queue_report' then
    return clued_private.ci_queue_report_v1(b,p_input);$r$);

select clued_private.fleet_patch_v1('clued_private.ci_job_lease_v1(uuid,uuid,uuid,uuid,bigint)',
$a$  perform clued_private.work_claim_lock(u);$a$,
$r$  perform clued_private.work_claim_lock(u);
  perform clued_private.fleet_role_lock_v1(u);
  if clued_private.fleet_node_package_v1(u,node)->>'maintenance'<>'available' then
    raise exception 'CI_NODE_IN_MAINTENANCE' using errcode='55000'; end if;$r$);

select clued_private.fleet_patch_v1('clued_private.ci_job_lease_next_v1(uuid,uuid,uuid)',
$a$  perform clued_private.work_claim_lock(u);$a$,
$r$  perform clued_private.work_claim_lock(u);
  perform clued_private.fleet_role_lock_v1(u);
  if clued_private.fleet_node_package_v1(u,node)->>'maintenance'<>'available' then
    raise exception 'CI_NODE_IN_MAINTENANCE' using errcode='55000'; end if;$r$);

select clued_private.fleet_patch_v1('clued_private.ci_duty_admits_v1(uuid,uuid,text,uuid)',
$a$  if u is not null and p_binding is not null then$a$,
$r$  if u is not null and p_binding is not null then
    if exists(select 1 from clued_private.fleet_seals_v1(u)) then
      perform pg_advisory_xact_lock_shared(hashtextextended('clued-binding-role:'||u||':ci-admission',0));
    end if;
    if exists(select 1 from clued_private.fleet_maintenance_v1 w where w.user_id=u
      and w.reinstall_pause_receipt_id is not null and w.reinstall_resume_receipt_id is null)
      or exists(select 1 from clued_private.fleet_maintenance_v1 m join clued_private.ci_nodes_v1 n using(node_id,user_id)
      where m.user_id=u and n.binding_id=p_binding and n.revoked_at is null and n.binding_generation=m.binding_generation
        and m.state<>'returned') then return false; end if;$r$);

create function clued_private.fleet_idle_v1(u uuid,node uuid) returns boolean
language sql stable set search_path='' as $$
  select not clued_private.fleet_node_busy_v1(node) and coalesce((
    select (e.runtime->>'idle')::boolean from clued_private.fleet_node_delivery_evidence_v1 e
    join clued_private.ci_nodes_v1 n using(node_id,user_id) join clued_private.ci_node_liveness_v1 l using(node_id,user_id)
    where e.node_id=node and e.user_id=u and e.registration_version=n.version and e.binding_generation=n.binding_generation
      and e.heartbeat_sequence=l.heartbeat_sequence and e.observed_at=l.last_heartbeat_at
      and e.observed_at between statement_timestamp()-interval '5 minutes' and statement_timestamp()),
    exists(select 1 from clued_private.ci_node_queue_view_v1 q
      where q.user_id=u and q.node_id=node and q.reported_at between statement_timestamp()-interval '5 minutes' and statement_timestamp()
        and upper(q.view#>>'{executor,state}')='IDLE' and q.view->'current'='null'::jsonb and q.view->'pending'='[]'::jsonb))
$$;

create function clued_private.fleet_promotion_target_v1(u uuid,holder uuid)
returns table(destination uuid,receiver uuid,package_id uuid)
language plpgsql stable set search_path='' as $$
declare h clued_private.ci_node_liveness_v1:=clued_private.ci_failover_node_v1(u,holder);
  info jsonb:=clued_private.fleet_node_package_v1(u,h.node_id); g uuid;
begin
  if info->>'classification' in ('legacy','current') or info->>'maintenance'<>'available'
    or h.reported_state is distinct from 'NORMAL' or h.reported_mode is distinct from 'ACTIVE'
    or h.reported_service_running is not true or h.last_heartbeat_at<statement_timestamp()-interval '5 minutes'
    or not exists(select 1 from clued_private.ci_failover_settings_v1 s where s.user_id=u and s.enabled)
    then return; end if;
  select s.grant_id into g from clued_private.fleet_seals_v1(u) s join clued_private.fleet_accepted_v1 a using(grant_id)
    where s.classification='current' and a.promotion_paused_at is null;
  if g is null or not exists(select 1 from clued_private.ci_duty_holder_v1(u) x where x.binding_id=holder and x.source='ci-admission') then return; end if;
  return query select n.binding_id,n.node_id,g
    from jsonb_array_elements(clued_private.ci_failover_candidates_v1(u,holder,h.reported_source_sha256,null,clock_timestamp())) c
    join clued_private.ci_nodes_v1 n on n.binding_id=(c->>'binding_id')::uuid and n.user_id=u and n.revoked_at is null
    where (c->>'eligible')::boolean and clued_private.fleet_source_reason_v1(u,n.node_id,'handover') is null
      and clued_private.fleet_idle_v1(u,n.node_id) order by (c->>'rank')::int limit 1;
end $$;

create function clued_private.fleet_promote_v1(u uuid,holder uuid) returns jsonb
language plpgsql volatile set search_path='' as $$
declare h clued_private.ci_node_liveness_v1:=clued_private.ci_failover_node_v1(u,holder);
  info jsonb:=clued_private.fleet_node_package_v1(u,h.node_id); g uuid; dest uuid; next_node uuid; done jsonb;
begin
  if info->>'classification' in ('legacy','current') or info->>'maintenance'<>'available' or h.reported_state<>'NORMAL'
    or h.reported_mode<>'ACTIVE' or not clued_private.fleet_idle_v1(u,h.node_id) then return null; end if;
  select destination,receiver,package_id into dest,next_node,g from clued_private.fleet_promotion_target_v1(u,holder);
  if dest is null then return null; end if;
  done:=clued_private.binding_role_handover_core_v1(u,holder,dest,null,jsonb_build_object(
    'receipt_kind','FLEET_SEALED_HANDOVER','principal','server_watchdog','grant_id',g));
  insert into clued_private.fleet_maintenance_v1(node_id,user_id,binding_generation,operation_id,grant_id,state,method,successor,receipt_id)
    select n.node_id,u,n.binding_generation,extensions.gen_random_uuid(),g,'reserve','handover',next_node,(done->>'receipt_id')::uuid
    from clued_private.ci_nodes_v1 n where n.node_id=h.node_id
    on conflict(node_id) do update set binding_generation=excluded.binding_generation,operation_id=excluded.operation_id,
      grant_id=g,state='reserve',method='handover',successor=next_node,started_at=clock_timestamp(),alerted_at=null,
      verify_started_at=null,receipt_id=excluded.receipt_id;
  return done||jsonb_build_object('outcome','fleet_promoted');
end $$;

-- 只消费节点故障信号；PR 检查、冲突及准入按规则拒绝均不在此集合。
create function clued_private.fleet_node_fault_v1(reason text) returns boolean
language sql immutable set search_path='' as $$
  select reason in ('RUNNER_SPAWN_FAILED','ADMISSION_CREDENTIAL_FAILED','EXECUTOR_RESTARTED_UNPUBLISHED',
    'LANDING_STEP_FAILED','PROCESS_CRASH','TRAIN_LANDING_STATE_UNREADABLE','TRAIN_LANDING_STATE_UNWRITTEN')
$$;

create function clued_private.fleet_fail_holder_v1(u uuid,node uuid,reason text,handover_receipt uuid) returns void
language plpgsql volatile set search_path='' as $$
declare info jsonb:=clued_private.fleet_node_package_v1(u,node); r uuid; g uuid:=(info->>'grantId')::uuid;
begin
  if info->>'classification'<>'current' or info->>'maintenance'<>'available' or not exists(
    select 1 from clued_private.binding_roles_v1 old join clued_private.ci_nodes_v1 n using(user_id,binding_id)
      where n.node_id=node and old.user_id=u and old.role='ci-admission' and old.revoked_receipt_id=handover_receipt
        and old.effective_at<=old.revoked_at) then return; end if;
  update clued_private.fleet_accepted_v1 set promotion_paused_at=coalesce(promotion_paused_at,clock_timestamp()) where grant_id=g;
  r:=clued_private.ci_failover_alert_v1(u,'FLEET_PROMOTION_PAUSED',node::text||':'||g,jsonb_build_object('failure',reason));
  insert into clued_private.fleet_maintenance_v1(node_id,user_id,binding_generation,operation_id,grant_id,state,method,receipt_id)
    select n.node_id,u,n.binding_generation,extensions.gen_random_uuid(),g,'repair','failure',r from clued_private.ci_nodes_v1 n where n.node_id=node
    on conflict(node_id) do update set state='repair',method='failure',binding_generation=excluded.binding_generation,
      operation_id=excluded.operation_id,grant_id=g,receipt_id=r,started_at=clock_timestamp(),verify_started_at=null,alerted_at=null;
  update clued_private.fleet_maintenance_v1 set owner_repair_required=true,verify_alerted_at=null where node_id=node;
  if r is not null then perform clued_private.ci_failover_note_v1(u,r,'FLEET_PROMOTION_PAUSED','封存包自动推进已暂停',
    '当班节点 '||node||' 发生 '||reason||'，已摘牌待修。请修复该节点或撤销当前包。'); end if;
end $$;

create function clued_private.fleet_release_reserve_v1(u uuid,node uuid,g uuid,since_at timestamptz)
returns void language sql volatile set search_path='' as $$
  update clued_private.fleet_maintenance_v1 m set state='delisted',started_at=clock_timestamp(),alerted_at=null,
    initial_receipt=(select evidence->>'installReceiptSha256' from clued_private.fleet_node_delivery_evidence_v1 e where e.node_id=m.node_id),
    receipt_id=clued_private.ci_receipt_v1(u,(select project_id from clued_private.ci_nodes_v1 where node_id=m.node_id),
      'fleet_reserve_released',m.node_id::text,jsonb_build_object('operation_id',m.operation_id,'successor',node,'grant_id',g))
    where m.user_id=u and m.successor=node and m.state='reserve' and m.grant_id=g and m.started_at<=since_at
      and exists(select 1 from clued_private.ci_nodes_v1 n cross join lateral clued_private.ci_duty_holder_v1(u,n.project_id) h
        where n.node_id=node and n.user_id=u and h.binding_id=n.binding_id)
      and clued_private.fleet_source_reason_v1(u,node,'handover') is null
$$;

create table clued_private.fleet_mixed_v1 (
  user_id uuid primary key references auth.users on delete cascade,
  grant_id uuid not null references clued_private.fleet_accepted_v1(grant_id),
  since_at timestamptz not null default clock_timestamp(), alerted_at timestamptz
);
alter table clued_private.fleet_mixed_v1 enable row level security;
revoke all on clued_private.fleet_mixed_v1 from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.fleet_restore_resident_duty_v1(u uuid,node uuid,op uuid,g uuid,t timestamptz) returns uuid
language plpgsql volatile set search_path='' as $$
declare b public.clued_agent_bindings; pr uuid; r uuid; activation timestamptz;
begin
  select binding.* into b from public.clued_agent_bindings binding join clued_private.ci_nodes_v1 n
    on n.user_id=binding.user_id and n.binding_id=binding.id
    where n.node_id=node and n.user_id=u and n.state in ('active','pending','draining')
      and n.revoked_at is null and clued_private.binding_live_v1(binding) and 'context:read'=any(binding.scopes)
      and not exists(select 1 from clued_private.binding_roles_v1 x where x.user_id=u
        and x.role='ci-admission' and x.revoked_at is null
        and (x.binding_id=binding.id or x.purpose in ('resident-node','unspecified'))) for update of binding;
  if not found then return null; end if;
  select project_id into pr from clued_private.ci_nodes_v1 where node_id=node;
  perform clued_private.binding_role_change_check_v1(b,'ci-admission',true,'"resident-node"');
  activation:=clued_private.binding_role_start_v1('ci-admission','resident-node',t);
  r:=clued_private.ci_receipt_v1(u,pr,'fleet_sole_duty_restored',node::text,jsonb_build_object('binding_id',b.id,'operation_id',op,
    'grant_id',g,'effective_at',activation,'principal','server_watchdog'));
  insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
    values(u,b.id,'ci-admission',t,r,activation,'resident-node');
  return r;
end $$;

create function clued_private.fleet_reinstall_window_tick_v1(u uuid,g uuid,t timestamptz) returns void
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
      '列车仍停接新工作。请核对同一封存包的两台节点的安装回执、备班状态和健康自检。'); end if;
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
  if cardinality(ready_nodes) is distinct from jsonb_array_length(peers) then return; end if;
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

create function clued_private.fleet_maintenance_tick_v1(u uuid) returns void
language plpgsql volatile set search_path='' as $$
declare m clued_private.fleet_maintenance_v1; h uuid; g uuid; r uuid; t timestamptz; -- 告警按授权与维护操作去重。
  train_pending boolean; reinstall_pending boolean;
  pr uuid;
begin
  -- 领取租约与摘牌使用相同的加锁顺序；刚恢复的节点在下次看门狗检查时才申请。
  perform clued_private.work_claim_lock(u);
  perform clued_private.fleet_role_lock_v1(u);
  train_pending:=exists(select 1 from clued_private.fleet_maintenance_v1 x where x.user_id=u and x.restore_train_generation is not null);
  reinstall_pending:=exists(select 1 from clued_private.fleet_maintenance_v1 x where x.user_id=u
    and x.reinstall_peers is not null and x.reinstall_resume_receipt_id is null);
  t:=clock_timestamp();
  select n.node_id into h from clued_private.ci_duty_holder_v1(u) d join clued_private.ci_nodes_v1 n
    on n.user_id=u and n.binding_id=d.binding_id and n.revoked_at is null and n.state not in ('revoked','retired');
  select grant_id into g from clued_private.fleet_seals_v1(u) where classification='current';
  for m in select x.* from clued_private.fleet_maintenance_v1 x join clued_private.ci_nodes_v1 n using(node_id,user_id)
      where x.user_id=u and (x.state<>'returned' or (train_pending and x.restore_train_generation is not null))
        and x.binding_generation=n.binding_generation and n.revoked_at is null loop
    if m.state='returned' and m.restore_train_generation is not null then
      select project_id into pr from clued_private.ci_nodes_v1 where node_id=m.node_id;
      if m.method in ('in_place','reinstall') and clued_private.ci_duty_phase_v1(u,pr)>=4 and g=m.grant_id
        and coalesce((select generation from clued_private.ci_train_lease_v1 where user_id=u and project_id=pr),0)=m.restore_train_generation
        and not exists(select 1 from clued_private.ci_duty_holder_v1(u,pr))
        and not clued_private.fleet_other_healthy_v1(u,m.node_id)
        and exists(select 1 from clued_private.fleet_accepted_v1 a where a.grant_id=g and a.promotion_paused_at is null) then
        if not clued_private.fleet_selfcheck_v1(u,m.node_id,m.verify_started_at)
          or clued_private.fleet_node_package_v1(u,m.node_id)->>'classification'<>'current'
          or not exists(select 1 from clued_private.ci_node_liveness_v1 l where l.node_id=m.node_id
            and l.reported_mode='STANDBY' and l.reported_probe='not-held') then continue; end if;
        begin
          -- 原领取入口重验已授权的维护工作、节点资格、静默期和防抖，并签发新代次。
          perform clued_private.ci_train_acquire_v1(u,pr,m.node_id);
        exception when insufficient_privilege or object_not_in_prerequisite_state or invalid_parameter_value then
          continue;
        end;
      end if;
      update clued_private.fleet_maintenance_v1 set restore_train_generation=null where node_id=m.node_id;
    elsif m.state='reserve' and m.successor=h and m.grant_id=g and t-m.started_at>=interval '12 hours'
      and clued_private.fleet_idle_v1(u,h) and clued_private.fleet_selfcheck_v1(u,h,m.started_at) then
      perform clued_private.fleet_release_reserve_v1(u,h,g,t);
    elsif m.state='delisted' and m.verify_started_at is null and exists(select 1
      from clued_private.fleet_node_delivery_evidence_v1 e where e.node_id=m.node_id and e.observed_at>m.started_at
        and e.binding_generation=m.binding_generation and e.evidence->>'installReceiptSha256' is distinct from m.initial_receipt
        and clued_private.fleet_node_package_v1(u,m.node_id)->>'classification'='current') then
      r:=clued_private.ci_receipt_v1(u,(select project_id from clued_private.ci_nodes_v1 where node_id=m.node_id),
        'fleet_verify_started',m.node_id::text,jsonb_build_object('operation_id',m.operation_id,'grant_id',g,'principal','server_watchdog'));
      update clued_private.fleet_maintenance_v1 set verify_started_at=t,verify_receipt_id=r,receipt_id=r where node_id=m.node_id;
    elsif m.state='delisted' and not m.owner_repair_required and m.verify_started_at is not null
      and clued_private.fleet_node_package_v1(u,m.node_id)->>'classification'='current'
      and exists(select 1 from clued_private.fleet_node_delivery_evidence_v1 e where e.node_id=m.node_id
        and e.binding_generation=m.binding_generation and e.evidence->>'installReceiptSha256' is not null
        and e.evidence->>'installReceiptSha256' is distinct from m.initial_receipt)
      and clued_private.fleet_selfcheck_v1(u,m.node_id,m.verify_started_at)
      and exists(select 1 from clued_private.ci_node_liveness_v1 l where l.node_id=m.node_id
        and l.reported_mode='STANDBY' and l.reported_probe='not-held') then
      select project_id into pr from clued_private.ci_nodes_v1 where node_id=m.node_id;
      update clued_private.fleet_maintenance_v1 set state='returned',
        restore_train_generation=case when not reinstall_pending and m.method in ('in_place','reinstall') and not clued_private.fleet_other_healthy_v1(u,m.node_id)
          and clued_private.ci_duty_phase_v1(u,pr)>=4
          then coalesce((select l.generation from clued_private.ci_train_lease_v1 l where l.user_id=u and l.project_id=pr),0) end,
        receipt_id=clued_private.ci_receipt_v1(u,pr,'fleet_maintenance_returned',m.node_id::text,
        jsonb_build_object('operation_id',m.operation_id,'grant_id',g)) where node_id=m.node_id;
      -- 只在本次安装通过验证时授职。已有授职（含尚未生效的交班）优先，阶段四沿用列车租约。
      if not reinstall_pending and m.method in ('in_place','reinstall') and clued_private.ci_duty_account_phase_v1(u)<4
        and not clued_private.fleet_other_healthy_v1(u,m.node_id)
        and exists(select 1 from clued_private.fleet_accepted_v1 a where a.grant_id=g and a.promotion_paused_at is null) then
        perform clued_private.fleet_restore_resident_duty_v1(u,m.node_id,m.operation_id,g,t);
      end if;
    end if;
    if m.state in ('delisted','repair') and m.verify_alerted_at is null and t-m.verify_started_at>=interval '45 minutes'
      and exists(select 1 from clued_private.fleet_maintenance_v1 x where x.node_id=m.node_id and x.state<>'returned') then
      r:=clued_private.ci_failover_alert_v1(u,'FLEET_VERIFY_TIMEOUT',m.operation_id::text,jsonb_build_object('node',m.node_id));
      if r is not null then perform clued_private.ci_failover_note_v1(u,r,'FLEET_VERIFY_TIMEOUT','启动验证等待已满 45 分钟',
        '节点 '||m.node_id||' 的操作 '||m.operation_id||' 仍在等待健康证据。'); end if;
      update clued_private.fleet_maintenance_v1 set verify_alerted_at=t where node_id=m.node_id;
    end if;
    if m.state in ('delisted','repair') and m.alerted_at is null and t-m.started_at>=interval '24 hours'
      and exists(select 1 from clued_private.fleet_maintenance_v1 x where x.node_id=m.node_id and x.state<>'returned') then
      r:=clued_private.ci_failover_alert_v1(u,'FLEET_MAINTENANCE_TIMEOUT',m.operation_id::text,jsonb_build_object('node',m.node_id));
      if r is not null then perform clued_private.ci_failover_note_v1(u,r,'FLEET_MAINTENANCE_TIMEOUT','摘牌已满 24 小时',
        '节点 '||m.node_id||' 的操作 '||m.operation_id||' 仍在等待恢复。'); end if;
      update clued_private.fleet_maintenance_v1 set alerted_at=t where node_id=m.node_id;
    end if;
  end loop;
  if reinstall_pending then perform clued_private.fleet_reinstall_window_tick_v1(u,g,t); end if;
  if g is not null and exists(select 1 from clued_private.ci_nodes_v1 n join clued_private.ci_node_liveness_v1 l using(node_id,user_id)
    cross join lateral (select clued_private.fleet_node_package_v1(u,n.node_id) info) v
    where n.user_id=u and n.revoked_at is null and n.state not in ('retired','revoked')
      and v.info->>'maintenance'='available' and v.info->>'classification'<>'current'
      and (n.node_id=h or l.last_heartbeat_at>t-interval '20 minutes')) then
    insert into clued_private.fleet_mixed_v1 as old(user_id,grant_id) values(u,g)
      on conflict(user_id) do update set grant_id=g,since_at=t,alerted_at=null where old.grant_id<>g;
    update clued_private.fleet_mixed_v1 set alerted_at=t where user_id=u and t-since_at>=interval '12 hours' and alerted_at is null;
    if found then
      r:=clued_private.ci_failover_alert_v1(u,'FLEET_MIXED_TIMEOUT',g::text,'{}');
      if r is not null then perform clued_private.ci_failover_note_v1(u,r,'FLEET_MIXED_TIMEOUT','舰队混版已满 12 小时',
        '节点尚未全部升级至当前封存包，授权编号 '||g||'。'); end if;
    end if;
  else delete from clued_private.fleet_mixed_v1 where user_id=u; end if;
end $$;

select clued_private.fleet_patch_v1('clued_private.ci_admission_failover_tick_v1()',
$a$select distinct m.user_id from clued_private.ci_failover_members_v1 m order by 1$a$,
$r$select user_id from clued_private.ci_failover_members_v1 union select user_id from clued_private.release_identity_v1
      union select user_id from clued_private.fleet_maintenance_v1 order by 1$r$);

select clued_private.fleet_patch_v1('clued_private.ci_admission_failover_tick_v1()',
$a$      v_result:=clued_private.ci_admission_failover_owner_v1(v_owner);$a$,
$r$      perform clued_private.fleet_maintenance_tick_v1(v_owner);
      v_result:=clued_private.ci_admission_failover_owner_v1(v_owner);$r$);

select clued_private.fleet_patch_v1('clued_private.ci_admission_failover_owner_v1(uuid)',
$a$  if v_trigger is null then$a$,
$r$  if v_trigger is null then
    if s.enabled then
      v_done:=clued_private.fleet_promote_v1(p_owner,v_holder);
      if v_done is not null then return v_done; end if;
    end if;$r$);

select clued_private.fleet_patch_v1('clued_private.ci_admission_failover_owner_v1(uuid)',
$a$when v_halted then 'halted' end;$a$,
$r$when v_halted then 'halted' else (
      select f->>'code' from clued_private.fleet_node_delivery_evidence_v1 e
      join clued_private.ci_nodes_v1 n using(user_id,node_id)
      cross join lateral jsonb_array_elements(clued_private.binding_role_holders_v1(p_owner,'ci-admission','{}'::uuid[])) role
      cross join lateral jsonb_array_elements(e.runtime->'failures') f
      where e.user_id=p_owner and e.node_id=xn.node_id and n.binding_id=v_holder
        and e.binding_generation=n.binding_generation and e.registration_version=n.version
        and e.heartbeat_sequence=xn.heartbeat_sequence and e.observed_at=xn.last_heartbeat_at
        and xn.reported_mode='ACTIVE' and xn.reported_state='NORMAL'
        and clued_private.fleet_node_package_v1(p_owner,n.node_id)->>'classification' in ('current','previous')
        and role->>'binding_id'=v_holder::text and role->>'purpose' in ('resident-node','unspecified')
        and clued_private.fleet_node_fault_v1(f->>'code')
        and clued_private.fleet_time_v1(f->>'at') between greatest((role->>'effective_at')::timestamptz,v_now-interval '5 minutes') and e.observed_at
      order by clued_private.fleet_time_v1(f->>'at') desc,f->>'code' limit 1) end;$r$);

select clued_private.fleet_patch_v1('clued_private.ci_admission_failover_owner_v1(uuid)',
$a$||' 分钟' end$a$,
$r$||' 分钟' else '自报节点故障 '||v_trigger end$r$);

select clued_private.fleet_patch_v1('clued_private.ci_admission_failover_owner_v1(uuid)',
$a$  v_note:=clued_private.ci_failover_note_v1(p_owner,(v_done->>'receipt_id')::uuid,'CI_ADMISSION_AUTO_HANDOVER',$a$,
$r$  perform clued_private.fleet_fail_holder_v1(p_owner,xn.node_id,v_trigger,(v_done->>'receipt_id')::uuid);
  v_note:=clued_private.ci_failover_note_v1(p_owner,(v_done->>'receipt_id')::uuid,'CI_ADMISSION_AUTO_HANDOVER',$r$);

select clued_private.fleet_patch_v1('clued_private.binding_role_handover_core_v1(uuid,uuid,uuid,text,jsonb)',
$a$  return jsonb_build_object('receipt_id',v_receipt$a$,
$r$  if p_receipt->>'principal'='server_watchdog' and p_receipt->>'receipt_kind'='CI_ADMISSION_AUTO_HANDOVER' then
    update clued_private.fleet_maintenance_v1 m set state='returned',receipt_id=v_receipt from clued_private.ci_nodes_v1 n
      where n.binding_id=t.id and n.user_id=p_owner and m.node_id=n.node_id and m.binding_generation=n.binding_generation and m.state='reserve';
  end if;
  return jsonb_build_object('receipt_id',v_receipt$r$);

create function clued_private.fleet_holder_reason_v1(u uuid,node uuid) returns text
language sql stable set search_path='' as $$
  select case when not exists(select 1 from clued_private.ci_nodes_v1 n
      cross join lateral clued_private.ci_duty_holder_v1(u,n.project_id) h
      where n.node_id=node and n.user_id=u and h.binding_id=n.binding_id)
    then 'admission_binding_required'
    when not exists(select 1 from clued_private.ci_node_liveness_v1 l where l.node_id=node and l.user_id=u
      and l.last_heartbeat_at between statement_timestamp()-interval '24 hours' and statement_timestamp())
    then 'ci_admission_target_source_unknown' else clued_private.fleet_source_reason_v1(u,node,'holder') end
$$;

create function clued_private.fleet_execution_view_v1(u uuid,holder uuid) returns jsonb
language plpgsql stable set search_path='' as $$
declare all_nodes jsonb:=clued_private.ci_failover_nodes_v1(u); info jsonb;
  n clued_private.ci_node_liveness_v1:=clued_private.ci_failover_node_v1(u,holder);
begin
  info:=clued_private.fleet_node_package_v1(u,n.node_id);
  if info->>'classification'='legacy' then
    return jsonb_build_object('nodes',coalesce((select jsonb_agg(x) from jsonb_array_elements(all_nodes) x
      where coalesce(x#>>'{node,package,maintenance}','available') not in ('delisted','repair')),'[]'::jsonb)); end if;
  info:=info||jsonb_build_object('refusal',clued_private.fleet_holder_reason_v1(u,n.node_id),
    'drainNewBatch',exists(select 1 from clued_private.fleet_promotion_target_v1(u,holder)));
  -- 旧客户端只能比较 nodes。当班不合格时给旧解析器明确的不可读，新客户端读全量投影。
  return jsonb_build_object('holder_package',info,'fleet_nodes',all_nodes,'nodes',
    case when info->>'refusal' is null
      then (select jsonb_agg(x) from jsonb_array_elements(all_nodes) x where x->>'binding_id'=holder::text) end);
end $$;

select clued_private.fleet_patch_v1('clued_private.ci_failover_node_view_v1(uuid,uuid)',
$a$'stage1_state',n.state,$a$,
$r$'stage1_state',n.state,'package',clued_private.fleet_node_package_v1(p_owner,n.node_id),$r$);

select clued_private.fleet_patch_v1('clued_private.ci_failover_nodes_status_v1(public.clued_agent_bindings,jsonb)',
$a$'nodes',clued_private.ci_failover_nodes_v1(b.user_id),$a$,
$r$$r$);

select clued_private.fleet_patch_v1('clued_private.ci_failover_nodes_status_v1(public.clued_agent_bindings,jsonb)',
$a$clued_private.ci_failover_watermarks_v1(b.user_id));$a$,
$r$clued_private.ci_failover_watermarks_v1(b.user_id))||clued_private.fleet_execution_view_v1(b.user_id,b.id);$r$);

select clued_private.fleet_patch_v1('clued_private.fleet_node_target_v1(uuid,uuid)',
$a$  where a.user_id=p_owner$a$,
$r$  where a.user_id=p_owner and (not exists(select 1 from clued_private.fleet_seals_v1(p_owner))
    or a.grant_id=(select grant_id from clued_private.fleet_seals_v1(p_owner) where classification='current'))$r$);

select clued_private.fleet_patch_v1('clued_private.fleet_node_target_v1(uuid,uuid)',
$a$        order by source nulls first limit 2$a$,
$r$          and clued_private.fleet_node_package_v1(p_owner,n.node_id)->>'maintenance' not in ('delisted','repair')
        order by source nulls first limit 2$r$);

create function clued_private.fleet_probe_targets_v1(u uuid,node uuid) returns jsonb
language plpgsql stable set search_path='' as $$
declare target jsonb:=clued_private.fleet_node_target_v1(u,node); info jsonb:=clued_private.fleet_node_package_v1(u,node);
  m clued_private.fleet_maintenance_v1; others boolean; ready boolean;
begin
  if info->>'classification'='legacy' then return jsonb_build_object('fleet_target',target); end if;
  select x.* into m from clued_private.fleet_maintenance_v1 x join clued_private.ci_nodes_v1 n using(node_id,user_id)
    where n.node_id=node and n.user_id=u and x.binding_generation=n.binding_generation;
  others:=clued_private.fleet_other_healthy_v1(u,node);
  ready:=clued_private.fleet_install_ready_v1(u,node,(target->>'grant_id')::uuid);
  target:=target||jsonb_build_object('holder_package',info,'has_other_healthy',others,'install_ready',coalesce(ready,false),
    'operation_id',m.operation_id);
  return jsonb_build_object('fleet_update',target,'fleet_target',case when ready or
    (info->>'classification'='current' and info->>'maintenance'='available' and target->>'grant_id'=info->>'grantId')
      then target||jsonb_build_object('other_sources','[]'::jsonb) end);
end $$;

select clued_private.fleet_patch_v1('public.clued_ci_connection_renew_v1(jsonb)',
$a$jsonb_build_object('fleet_target',clued_private.fleet_node_target_v1(u,n.node_id))$a$,
$r$case when exists(select 1 from clued_private.fleet_seals_v1(u))
          then clued_private.fleet_probe_targets_v1(u,n.node_id)
          else jsonb_build_object('fleet_target',clued_private.fleet_node_target_v1(u,n.node_id)) end$r$);

select clued_private.fleet_patch_v1('clued_private.ci_train_acquire_v1(uuid,uuid,uuid)',
$a$  perform clued_private.work_claim_lock(u);$a$,
$r$  perform clued_private.work_claim_lock(u);
  perform clued_private.fleet_role_lock_v1(u);
  if clued_private.fleet_node_package_v1(u,node)->>'classification'<>'legacy' then
    perform clued_private.fleet_target_require_v1(u,(select binding_id from clued_private.ci_nodes_v1 where node_id=node),'holder');
  elsif clued_private.fleet_node_package_v1(u,node)->>'maintenance'<>'available' then raise exception 'CI_NODE_IN_MAINTENANCE'; end if;$r$);

select clued_private.fleet_patch_v1('clued_private.ci_train_command_v2(clued_private.ci_nodes_v1,text,jsonb)',
$a$  if n.qualification_source is distinct from cfg$a$,
$r$  perform clued_private.fleet_role_lock_v1(n.user_id);
  projection:=clued_private.fleet_node_package_v1(n.user_id,n.node_id);
  if projection->>'classification'<>'legacy' then
    if op='batch_reserve' and exists(select 1 from clued_private.fleet_promotion_target_v1(n.user_id,n.binding_id)) then
      return clued_private.ci_train_reject_v2('ci_node_in_maintenance'); end if;
    if op in ('batch_reserve','landing_prepare','landing_send') and
      clued_private.fleet_holder_reason_v1(n.user_id,n.node_id) is not null then
      return clued_private.ci_train_reject_v2('ci_source_mismatch'); end if;
    if projection->>'classification' in ('current','previous') then
      select s.source,cfg||jsonb_build_object('source_manifest_sha256',s.source,'source_commit',s.source_commit)
        into source,cfg from clued_private.fleet_seals_v1(n.user_id) s where s.grant_id::text=projection->>'grantId';
    end if;
  end if;
  if projection->>'maintenance'<>'available' and op in ('batch_reserve','batch_acquire','landing_prepare','landing_send',
    'head_acquire','queue_acquire','queue_action_acquire','scan_start_begin','publication_begin_independent','publication_send',
    'auxiliary_dispatch_reserve','auxiliary_dispatch_send') then
    return clued_private.ci_train_reject_v2('ci_node_in_maintenance'); end if;
  if n.qualification_source is distinct from cfg$r$);
alter table clued_private.ci_train_landing_v2 add column sending_node uuid, add column sending_grant uuid, add column sent_at timestamptz;

select clued_private.fleet_patch_v1('clued_private.ci_train_batch_command_v2(clued_private.ci_nodes_v1,text,bigint,text,jsonb,jsonb)',
$a$update clued_private.ci_train_landing_v2 set state='sent',receipt_id=r$a$,
$r$update clued_private.ci_train_landing_v2 set state='sent',receipt_id=r,sending_node=n.node_id,sent_at=clock_timestamp(),
        sending_grant=(clued_private.fleet_node_package_v1(n.user_id,n.node_id)->>'grantId')::uuid$r$);

select clued_private.fleet_patch_v1('clued_private.ci_train_batch_command_v2(clued_private.ci_nodes_v1,text,bigint,text,jsonb,jsonb)',
$a$      update clued_private.ci_train_batches_v2 set
        state=case when op='landing_reconcile'$a$,
$r$      if op='landing_reconcile' and landing.sending_node=n.node_id and observation->>'mainSha'<>batch.base_sha then
        perform clued_private.fleet_release_reserve_v1(n.user_id,n.node_id,landing.sending_grant,landing.sent_at);
      end if;
      update clued_private.ci_train_batches_v2 set
        state=case when op='landing_reconcile'$r$);


-- 同一节点的同次心跳把健康证据与空闲、自检、节点故障观测关联起来。此输入不含维护操作。

select clued_private.fleet_patch_v1('clued_private.ci_node_heartbeat_v1(public.clued_agent_bindings,jsonb)',
$a$v_delivery jsonb:=p_input->'fleet_delivery';$a$,
$r$v_delivery jsonb:=p_input->'fleet_delivery'; v_runtime jsonb:=p_input->'fleet_runtime';$r$);

select clued_private.fleet_patch_v1('clued_private.ci_node_heartbeat_v1(public.clued_agent_bindings,jsonb)',
$a$  p_input:=p_input-'fleet_delivery';$a$,
$r$  if exists(select 1 from clued_private.fleet_seals_v1(b.user_id)) then perform clued_private.fleet_role_lock_v1(b.user_id); end if;
  if v_runtime is not null and (jsonb_typeof(v_runtime) is distinct from 'object' or octet_length(v_runtime::text)>1024
      or v_runtime-array['idle','selfcheckAt','failures']<>'{}'::jsonb
      or jsonb_typeof(v_runtime->'idle') is distinct from 'boolean'
      or (v_runtime->>'selfcheckAt' is not null and clued_private.fleet_time_v1(v_runtime->>'selfcheckAt') is null)
      or (v_runtime ? 'failures' and (jsonb_typeof(v_runtime->'failures')<>'array'
        or jsonb_array_length(v_runtime->'failures')>6))) then raise exception 'fleet_runtime_invalid' using errcode='22023'; end if;
  p_input:=p_input-'fleet_delivery'-'fleet_runtime';$r$);

select clued_private.fleet_patch_v1('clued_private.ci_node_heartbeat_v1(public.clued_agent_bindings,jsonb)',
$a$  return jsonb_build_object('status','ok','received_at',v_now,'node_ids',to_jsonb(v_nodes),$a$,
$r$  if cardinality(v_nodes)=1 then
    update clued_private.fleet_node_delivery_evidence_v1 e set runtime=v_runtime
      from clued_private.ci_node_liveness_v1 l where e.node_id=v_nodes[1] and l.node_id=e.node_id
        and e.user_id=b.user_id and e.heartbeat_sequence=l.heartbeat_sequence and e.observed_at=v_now;
  end if;
  return jsonb_build_object('status','ok','received_at',v_now,'node_ids',to_jsonb(v_nodes),$r$);


select clued_private.fleet_patch_v1('clued_private.ci_node_heartbeat_v1(public.clued_agent_bindings,jsonb)',
$a$reported_source_sha256=coalesce(v_source,l.reported_source_sha256)$a$,
$r$reported_source_sha256=case when exists(select 1 from clued_private.fleet_seals_v1(b.user_id)) then v_source else coalesce(v_source,l.reported_source_sha256) end$r$);


select clued_private.fleet_patch_v1('clued_private.fleet_delivery_seal_v1(jsonb)',
$a$  if a.sealed_at is not null then$a$,
$r$  if exists(select 1 from clued_private.owner_grants_v1 g where g.id=a.grant_id and g.revoked_at is not null) then
    raise exception 'fleet_grant_revoked' using errcode='22023'; end if;
  perform clued_private.fleet_backfill_previous_v1(a,p_input->>'previousRequest');
  if a.sealed_at is not null then$r$);

select clued_private.fleet_patch_v1('clued_private.fleet_accept_answer_v1(uuid,uuid,text)',
$a$    return v_base||jsonb_strip_nulls$a$,
$r$    if v_row.sealed_at is not null and exists(select 1 from clued_private.owner_grants_v1 g where g.id=v_row.grant_id and g.revoked_at is not null) then
      return v_base||jsonb_build_object('status','rejected'); end if;
    return v_base||jsonb_strip_nulls$r$);

select clued_private.fleet_patch_v1('clued_private.fleet_accept_answer_v1(uuid,uuid,text)',
$a$'paused',coalesce(l.reported_state in ('PAUSED','INTAKE_PAUSED'),false)) order by$a$,
$r$'paused',coalesce(l.reported_state in ('PAUSED','INTAKE_PAUSED'),false)) ||
          case when v_row.sealed_at is not null then jsonb_build_object('at_sealed_target',coalesce(
            v_row.grant_id::text=clued_private.fleet_node_package_v1(p_user,n.node_id)->>'grantId'
            and clued_private.fleet_source_reason_v1(p_user,n.node_id,'handover') is null
            and l.reported_state='NORMAL' and l.reported_service_running
            and l.last_heartbeat_at between statement_timestamp()-interval '5 minutes' and statement_timestamp(),false))
          else '{}'::jsonb end order by$r$);


select clued_private.fleet_patch_v1('clued_private.ci_train_command_v2(clued_private.ci_nodes_v1,text,jsonb)',
$a$  if op='work_pending' then
    return jsonb_build_object$a$,
$r$  if op='work_pending' then
    projection:=case when not exists(select 1 from clued_private.fleet_seals_v1(n.user_id)) then '{}'::jsonb
      when exists(select 1 from clued_private.ci_duty_holder_v1(n.user_id,n.project_id) h where h.binding_id=n.binding_id)
        then clued_private.fleet_execution_view_v1(n.user_id,n.binding_id)-'nodes'
      else jsonb_build_object('holder_package',clued_private.fleet_node_package_v1(n.user_id,n.node_id)||
        jsonb_build_object('refusal','admission_binding_required'),'fleet_nodes','[]'::jsonb) end;
    return projection||jsonb_build_object$r$);

-- 旧列车的发送意图和读回绑定到同一持锁节点、包、代次及主线提交。
create function clued_private.fleet_landing_command_v1(b public.clued_agent_bindings,input jsonb)
returns jsonb language plpgsql volatile set search_path='' as $$
declare l clued_private.fleet_landing_v1; n clued_private.ci_nodes_v1; g uuid; refusal text;
begin
  if input-array['scope','action','command','effect_key','grant_id','source','repository','base_sha','test_sha','main_sha']<>'{}'::jsonb
    or coalesce(input->>'command','') not in ('begin','settle') or coalesce(input->>'effect_key','') !~ '^[0-9a-f]{64}$'
    or coalesce(input->>'base_sha','') !~ '^[0-9a-f]{40}$' or coalesce(input->>'test_sha','') !~ '^[0-9a-f]{40}$'
    or input->>'base_sha'=input->>'test_sha' then raise exception 'fleet_landing_invalid' using errcode='22023'; end if;
  perform clued_private.fleet_role_lock_v1(b.user_id);
  select * into strict n from clued_private.ci_nodes_v1 where binding_id=b.id and user_id=b.user_id and revoked_at is null
    and state not in ('retired','revoked');
  g:=(clued_private.fleet_node_package_v1(b.user_id,n.node_id)->>'grantId')::uuid;
  refusal:=clued_private.fleet_holder_reason_v1(b.user_id,n.node_id);
  if g::text is distinct from input->>'grant_id' or not exists(
    select 1 from clued_private.fleet_accepted_v1 a where a.grant_id=g and a.repository=input->>'repository' and a.source_sha256=input->>'source')
    then raise exception 'fleet_landing_holder_changed' using errcode='40001'; end if;
  if input->>'command'='begin' then
    if refusal is not null then raise exception 'fleet_landing_holder_changed' using errcode='40001'; end if;
    if input->>'main_sha' is distinct from input->>'base_sha' then raise exception 'fleet_landing_main_changed'; end if;
    insert into clued_private.fleet_landing_v1(user_id,effect_key,node_id,grant_id,binding_generation,base_sha,test_sha)
      values(b.user_id,input->>'effect_key',n.node_id,g,n.binding_generation,input->>'base_sha',input->>'test_sha')
      on conflict do nothing;
    return jsonb_build_object('status','ok','authorized',found);
  end if;
  select * into l from clued_private.fleet_landing_v1 where user_id=b.user_id and effect_key=input->>'effect_key' for update;
  if not found or (l.node_id,l.grant_id,l.binding_generation) is distinct from (n.node_id,g,n.binding_generation)
    or l.base_sha is distinct from input->>'base_sha' or l.test_sha is distinct from input->>'test_sha'
    or l.test_sha is distinct from input->>'main_sha' then raise exception 'fleet_landing_readback_refused'; end if;
  if refusal is not null and not exists(select 1 from clued_private.fleet_maintenance_v1 m
    where m.user_id=b.user_id and m.node_id=n.node_id and m.binding_generation=n.binding_generation and m.grant_id=g
      and m.state='delisted' and m.reinstall_peers is not null and m.verify_started_at is null and l.started_at<=m.started_at) then
    raise exception 'fleet_landing_holder_changed' using errcode='40001';
  end if;
  if l.settled_at is null then
    update clued_private.fleet_landing_v1 set settled_at=clock_timestamp() where user_id=l.user_id and effect_key=l.effect_key;
    perform clued_private.fleet_release_reserve_v1(b.user_id,n.node_id,g,l.started_at);
  end if;
  return jsonb_build_object('status','ok','settled',true);
end $$;

drop function clued_private.fleet_patch_v1(regprocedure,text,text);
do $$
declare sig regprocedure;
begin
  for sig in select oid::regprocedure from pg_proc where pronamespace='clued_private'::regnamespace
    and proname in ('fleet_seals_v1','fleet_source_reason_v1','fleet_node_package_v1','fleet_role_lock_v1','fleet_target_require_v1',
    'fleet_handover_check_v1','fleet_other_healthy_v1','fleet_node_busy_v1','fleet_selfcheck_v1','fleet_maintenance_request_v1',
    'fleet_maintenance_rebind_v1','fleet_install_ready_v1','fleet_idle_v1','fleet_time_v1','fleet_promotion_target_v1','fleet_promote_v1','fleet_node_fault_v1','fleet_fail_holder_v1','fleet_release_reserve_v1',
    'fleet_landing_command_v1','fleet_maintenance_tick_v1','fleet_reinstall_pause_v1','fleet_reinstall_window_tick_v1',
    'fleet_restore_resident_duty_v1','fleet_holder_reason_v1','fleet_execution_view_v1','fleet_probe_targets_v1',
    'fleet_previous_seal_v1','fleet_backfill_previous_v1') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role,clued_worker_gateway',sig);
  end loop;
end $$;
