-- Smooth hand-over (resident ADR 0026): the ci-admission failover watchdog
-- judges a holder lost after 5 minutes instead of 30.
--
-- Design: work/independent-ci-resident-v1/docs/adr/0026-smooth-handover.md.
-- The resident companion now sends its heartbeat every minute (it was every 10
-- minutes) and tries a failed one again after 30 seconds. The Owner set the
-- silence rule to 5 minutes on 2026-11-12 (Decision b2e25a57 v3), replacing
-- only that duration of Decision 199cf3de (§41.6a). The other liveness
-- thresholds follow it:
--   silence (no heartbeat)                      30 -> 5 minutes
--   unhealthy (service not running or snapshot
--   stale, reported continuously)               30 -> 5 minutes
--   snapshot stale (reported snapshot age)      1800 -> 300 seconds
--   target heard recently                       20 -> 5 minutes
-- Nothing else changes: the 5-minute activation delay of the new holder
-- (binding_role_activation_delay_v1), at most one resident-node holder, the
-- receiver's two heartbeats during the silence, HALTED/PAUSED/INTAKE_PAUSED
-- holders never handed out, the 6-hour cooldown, no automatic hand-back, the
-- master switch (still the Owner's), the alerts and the receipts. The grace
-- for a holder that never sent a heartbeat (alert only) stays 30 minutes.
--
-- Why this is safe: two nodes never publish at once because the server ends
-- the old holder's role at once and starts the new one 5 minutes later, and
-- every stage revalidates the role live (an admission granted just before the
-- hand-over can land a check within about 150 seconds). That holds for any
-- hand-over at any time, however short the silence that triggered it. A
-- shorter silence only means a holder cut off for 5 minutes is replaced
-- sooner; its batch in flight then ends at its next live admission.
--
-- Anchored rewrites of the current definitions (20261031090000, with
-- 20261105160000's patch of ci_admission_failover_owner_v1): a missing function
-- or an anchor that is absent or repeated aborts the whole migration.

create function clued_private.ci_failover_fast_patch_v1(p_signature text,p_anchor text,p_replacement text) returns void
language plpgsql set search_path='' as $$
declare target regprocedure:=to_regprocedure(p_signature); body text;
begin
  if target is null then raise exception 'ci_failover_fast_patch_function_missing: %',p_signature; end if;
  body:=pg_get_functiondef(target);
  if (length(body)-length(replace(body,p_anchor,'')))<>length(p_anchor) then
    raise exception 'ci_failover_fast_patch_anchor_mismatch: %',p_signature; end if;
  execute replace(body,p_anchor,p_replacement);
end $$;

-- The rules as the /bindings/failover page and the receipts show them.
select clued_private.ci_failover_fast_patch_v1('clued_private.ci_failover_rules_v1()',
$a$'silence_minutes',30,'unhealthy_minutes',30,'snapshot_stale_minutes',30,
    'target_heartbeat_minutes',20,$a$,
$r$'silence_minutes',5,'unhealthy_minutes',5,'snapshot_stale_minutes',5,
    'target_heartbeat_minutes',5,$r$);

-- The two kinds of lost contact.
select clued_private.ci_failover_fast_patch_v1('clued_private.ci_admission_failover_owner_v1(uuid)',
$a$  -- refused, so it falls silent and the same 30 minutes apply.
  v_silent:=xn.last_heartbeat_at<=v_now-interval '30 minutes';
  v_stuck:=not v_silent and xn.unhealthy_since is not null and xn.unhealthy_since<=v_now-interval '30 minutes';$a$,
$r$  -- refused, so it falls silent and the same 5 minutes apply (ADR 0026).
  v_silent:=xn.last_heartbeat_at<=v_now-interval '5 minutes';
  v_stuck:=not v_silent and xn.unhealthy_since is not null and xn.unhealthy_since<=v_now-interval '5 minutes';$r$);
select clued_private.ci_failover_fast_patch_v1('clued_private.ci_admission_failover_owner_v1(uuid)',
$a$  v_why:=case when v_silent then '失联 30 分钟' else '连续 30 分钟报服务没在运行或状态快照过旧' end$a$,
$r$  v_why:=case when v_silent then '失联 5 分钟' else '连续 5 分钟报服务没在运行或状态快照过旧' end$r$);
select clued_private.ci_failover_fast_patch_v1('clued_private.ci_admission_failover_owner_v1(uuid)',
$a$  -- After 30 minutes of silence a candidate must have reached the server at$a$,
$r$  -- After 5 minutes of silence a candidate must have reached the server at$r$);

-- A target must have been heard within the same 5 minutes.
select clued_private.ci_failover_fast_patch_v1(
  'clued_private.ci_failover_candidates_v1(uuid,uuid,text,timestamp with time zone,timestamp with time zone)',
$a$n.last_heartbeat_at<=p_now-interval '20 minutes' then$a$,
$r$n.last_heartbeat_at<=p_now-interval '5 minutes' then$r$);

-- A reported snapshot older than 5 minutes is unhealthy (the executor rewrites it every 15 seconds).
select clued_private.ci_failover_fast_patch_v1('clued_private.ci_node_heartbeat_v1(public.clued_agent_bindings,jsonb)',
$a$  v_unhealthy:=not v_running or coalesce(v_age>1800,false);
  v_healthy:=v_running and coalesce(v_age<=1800,false);$a$,
$r$  v_unhealthy:=not v_running or coalesce(v_age>300,false);
  v_healthy:=v_running and coalesce(v_age<=300,false);$r$);

-- ---------------------------------------------------------------------------
-- Quiet holder: an automatic take-over starts at once (ADR 0026, Owner 2026-11-12).
--
-- The new holder waits 5 minutes (binding_role_activation_delay_v1) so that
-- an answer the old holder got just before the hand-over (it can still land a
-- check within about 150 seconds) has expired. When the watchdog hands over,
-- the holder has been silent for 5 minutes already; the wait is needed only if
-- the server answered it within the last 150 + 60 seconds (its heartbeat may
-- fail while its executor still works). So the server keeps, for every
-- Binding, the time of each positive ci-admission duty answer it gives, and the
-- watchdog's hand-over starts the new row at once when the old holder's latest
-- one is older than CI_FAILOVER_QUIET_SECONDS; otherwise, or with no record at
-- all, the 5 minutes stay. The one-click hand-over (Owner) is unchanged.
-- Server records and the server clock only; no node clock is read.
--
-- Where the answers are taken: clued_private.ci_duty_admits_v1, the one place
-- every ci-admission duty determination goes through (20261105160000, 2A).
-- It becomes volatile: before deciding it takes FOR SHARE on the Binding's
-- live ci-admission rows, and after a positive answer it appends a row here.
-- The hand-over core takes FOR UPDATE on the old holder's live rows before it
-- reads this table, so an answer being given while the watchdog acts is either
-- committed (and read: the 5 minutes stay) or decided after the revocation
-- (refused). Lock order stays Binding row -> role rows on both sides.

create table clued_private.ci_duty_answers_v1(
  binding_id uuid not null,
  user_id uuid not null,
  at timestamptz not null default clock_timestamp());
create index ci_duty_answers_v1_binding_at on clued_private.ci_duty_answers_v1(binding_id,at desc);
alter table clued_private.ci_duty_answers_v1 enable row level security;
revoke all on table clued_private.ci_duty_answers_v1 from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.ci_failover_quiet_seconds_v1() returns integer
language sql immutable set search_path='' as $$ select 210 $$;

-- The decision itself, unchanged: the current ci_duty_admits_v1 under a new name.
do $ci_duty_decide_copy$
declare definition text;
begin
  definition:=pg_catalog.pg_get_functiondef('clued_private.ci_duty_admits_v1(uuid,uuid,text,uuid)'::regprocedure);
  if position('FUNCTION clued_private.ci_duty_admits_v1(' in definition)=0 then
    raise exception 'ci_failover_fast_duty_definition_unexpected'; end if;
  execute replace(definition,'FUNCTION clued_private.ci_duty_admits_v1(','FUNCTION clued_private.ci_duty_admits_decide_v1(');
end $ci_duty_decide_copy$;

create or replace function clued_private.ci_duty_admits_v1(u uuid,p_binding uuid,p_mode text,p uuid default null) returns boolean
language plpgsql volatile security definer set search_path='' as $$
declare v boolean;
begin
  if u is not null and p_binding is not null then
    perform 1 from clued_private.binding_roles_v1 r where r.user_id=u and r.binding_id=p_binding
      and r.role='ci-admission' and r.revoked_at is null for share;
  end if;
  v:=clued_private.ci_duty_admits_decide_v1(u,p_binding,p_mode,p);
  if v then
    insert into clued_private.ci_duty_answers_v1(binding_id,user_id,at) values(p_binding,u,clock_timestamp());
  end if;
  return v;
end $$;

-- True when the server gave this Binding no positive duty answer within the
-- quiet seconds before p_now, and did give it one at some time (no record at
-- all is not quiet: the 5 minutes stay).
create function clued_private.ci_failover_holder_quiet_v1(p_binding uuid,p_now timestamptz) returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce((select max(a.at) from clued_private.ci_duty_answers_v1 a where a.binding_id=p_binding)
    <=p_now-make_interval(secs=>clued_private.ci_failover_quiet_seconds_v1()),false)
$$;

revoke all on function clued_private.ci_duty_admits_decide_v1(uuid,uuid,text,uuid),clued_private.ci_duty_admits_v1(uuid,uuid,text,uuid),
  clued_private.ci_failover_quiet_seconds_v1(),clued_private.ci_failover_holder_quiet_v1(uuid,timestamptz)
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- The hand-over core: lock the old holder's live rows (waiting for answers
-- being given), then, for the watchdog only (p_receipt start=quiet_holder), a
-- quiet old holder lets the new row start now.
select clued_private.ci_failover_fast_patch_v1(
  'clued_private.binding_role_handover_core_v1(uuid,uuid,uuid,text,jsonb)',
$a$  v_now:=clock_timestamp();
  v_start:=clued_private.binding_role_start_v1('ci-admission','resident-node',v_now);$a$,
$r$  perform 1 from clued_private.binding_roles_v1 r where r.binding_id=f.id and r.role='ci-admission'
    and r.revoked_at is null for update;
  v_now:=clock_timestamp();
  v_start:=clued_private.binding_role_start_v1('ci-admission','resident-node',v_now);
  if p_receipt->>'start'='quiet_holder' and clued_private.ci_failover_holder_quiet_v1(f.id,v_now) then
    v_start:=v_now; end if;$r$);

-- The watchdog asks for it (and only the watchdog).
select clued_private.ci_failover_fast_patch_v1('clued_private.ci_admission_failover_owner_v1(uuid)',
$a$      jsonb_build_object('receipt_kind','CI_ADMISSION_AUTO_HANDOVER','principal','server_watchdog',$a$,
$r$      jsonb_build_object('receipt_kind','CI_ADMISSION_AUTO_HANDOVER','principal','server_watchdog','start','quiet_holder',$r$);
select clued_private.ci_failover_fast_patch_v1('clued_private.ci_admission_failover_owner_v1(uuid)',
$a$||'（按你在 /bindings 排的次序选出），新持有从 '
      ||(v_done->>'effective_at')||' 起生效（5 分钟后）。$a$,
$r$||'（按你在 /bindings 排的次序选出），新持有从 '
      ||(v_done->>'effective_at')||' 起生效（原持有者 '||clued_private.ci_failover_quiet_seconds_v1()::text
      ||' 秒内没有拿到准入时立即生效，否则 5 分钟后）。$r$);

-- Answers older than a day go, except each Binding's latest (which decides).
select clued_private.ci_failover_fast_patch_v1('clued_private.ci_admission_failover_tick_v1()',
$a$  insert into clued_private.ci_failover_watchdog_v1(singleton,last_tick_at,ticks) values(true,v_tick,1)$a$,
$r$  delete from clued_private.ci_duty_answers_v1 a where a.at<v_tick-interval '1 day'
    and exists(select 1 from clued_private.ci_duty_answers_v1 n where n.binding_id=a.binding_id and n.at>a.at);
  insert into clued_private.ci_failover_watchdog_v1(singleton,last_tick_at,ticks) values(true,v_tick,1)$r$);

drop function clued_private.ci_failover_fast_patch_v1(text,text,text);
