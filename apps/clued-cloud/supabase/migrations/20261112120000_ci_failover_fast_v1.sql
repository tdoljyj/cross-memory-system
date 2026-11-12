-- Smooth hand-over (resident ADR 0025): the ci-admission failover watchdog
-- judges a holder lost after 3 minutes instead of 30.
--
-- Design: work/independent-ci-resident-v1/docs/adr/0025-smooth-handover.md.
-- The resident companion now sends its heartbeat every minute (it was every 10
-- minutes) and tries a failed one again after 30 seconds, so "three intervals
-- without a heartbeat" (the rule of Decision 199cf3de, §41.6a) is 3 minutes.
-- The same factor applies to the other liveness thresholds:
--   silence (no heartbeat)                      30 -> 3 minutes
--   unhealthy (service not running or snapshot
--   stale, reported continuously)               30 -> 3 minutes
--   snapshot stale (reported snapshot age)      1800 -> 180 seconds
--   target heard recently                       20 -> 3 minutes
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
-- shorter silence only means a holder cut off for 3 minutes is replaced
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
$r$'silence_minutes',3,'unhealthy_minutes',3,'snapshot_stale_minutes',3,
    'target_heartbeat_minutes',3,$r$);

-- The two kinds of lost contact.
select clued_private.ci_failover_fast_patch_v1('clued_private.ci_admission_failover_owner_v1(uuid)',
$a$  -- refused, so it falls silent and the same 30 minutes apply.
  v_silent:=xn.last_heartbeat_at<=v_now-interval '30 minutes';
  v_stuck:=not v_silent and xn.unhealthy_since is not null and xn.unhealthy_since<=v_now-interval '30 minutes';$a$,
$r$  -- refused, so it falls silent and the same 3 minutes apply (ADR 0025).
  v_silent:=xn.last_heartbeat_at<=v_now-interval '3 minutes';
  v_stuck:=not v_silent and xn.unhealthy_since is not null and xn.unhealthy_since<=v_now-interval '3 minutes';$r$);
select clued_private.ci_failover_fast_patch_v1('clued_private.ci_admission_failover_owner_v1(uuid)',
$a$  v_why:=case when v_silent then '失联 30 分钟' else '连续 30 分钟报服务没在运行或状态快照过旧' end$a$,
$r$  v_why:=case when v_silent then '失联 3 分钟' else '连续 3 分钟报服务没在运行或状态快照过旧' end$r$);
select clued_private.ci_failover_fast_patch_v1('clued_private.ci_admission_failover_owner_v1(uuid)',
$a$  -- After 30 minutes of silence a candidate must have reached the server at$a$,
$r$  -- After 3 minutes of silence a candidate must have reached the server at$r$);

-- A target must have been heard within the same 3 minutes.
select clued_private.ci_failover_fast_patch_v1(
  'clued_private.ci_failover_candidates_v1(uuid,uuid,text,timestamp with time zone,timestamp with time zone)',
$a$n.last_heartbeat_at<=p_now-interval '20 minutes' then$a$,
$r$n.last_heartbeat_at<=p_now-interval '3 minutes' then$r$);

-- A reported snapshot older than 3 minutes is unhealthy (the executor rewrites it every 15 seconds).
select clued_private.ci_failover_fast_patch_v1('clued_private.ci_node_heartbeat_v1(public.clued_agent_bindings,jsonb)',
$a$  v_unhealthy:=not v_running or coalesce(v_age>1800,false);
  v_healthy:=v_running and coalesce(v_age<=1800,false);$a$,
$r$  v_unhealthy:=not v_running or coalesce(v_age>180,false);
  v_healthy:=v_running and coalesce(v_age<=180,false);$r$);

drop function clued_private.ci_failover_fast_patch_v1(text,text,text);
