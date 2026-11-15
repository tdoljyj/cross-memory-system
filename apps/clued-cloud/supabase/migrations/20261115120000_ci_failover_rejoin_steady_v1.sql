-- A node handed out automatically can take over again once it has been
-- steadily healthy for 30 minutes (DESIGN §41.6a, resident ADR 0013).
--
-- 2026-11-15 (production, read only): TURING lost its network at 03:51Z, the
-- watchdog handed ci-admission TURING -> DESK at 03:57Z
-- (CI_ADMISSION_AUTO_HANDOVER), TURING was back at 04:00Z and STANDBY,
-- not-held, NORMAL on DESK's Source from 04:05Z. ci_failover_exclusion_v1 kept
-- answering 'auto_handed_out' for it with no time bound, until the Owner hands
-- over to or from it by hand: in a two-node fleet nobody would have taken over
-- had DESK gone silent in the meantime.
--
-- What auto_handed_out is for: no ping-pong. A node the watchdog judged lost
-- (silent, or reporting its service down, for silence_minutes /
-- unhealthy_minutes) may be unstable; handing the role back to it the moment it
-- is heard again would let a flapping node bounce the role around, each
-- handover costing minutes without a holder. That needs proof of stability
-- before a hand-back, not the Owner: the exclusion now lifts once the node has
-- been steadily healthy for rejoin_steady_minutes (a new rule, 30) and is
-- still heard. A manual handover to or from it, or marking it by hand, lifts
-- it at once as before.
--
-- Steadily healthy, from the server's own facts: the new column
-- ci_node_liveness_v1.steady_since is the start of the current run of
-- heartbeats in which neither kind of lost contact occurred, the mirror of the
-- watchdog's two judgements:
-- - every heartbeat in the run reported the service running with a fresh
--   snapshot (the heartbeat's v_healthy, which ends unhealthy_since), and
-- - each arrived less than silence_minutes after the one before (a gap the
--   watchdog would judge as silence starts a new run).
-- A heartbeat that is not healthy (service down, stale or unknown snapshot)
-- clears it. The heartbeat writes it under the server's clock, like every
-- other liveness column. The existing columns cannot tell it: they keep the
-- last two heartbeats and the start of the current unhealthy run, so a gap
-- longer than silence_minutes twenty minutes ago is no longer visible.
--
-- Why ping-pong stays prevented: a node that falls silent for silence_minutes
-- or reports its service down once more often than every 30 minutes never
-- completes a run and stays out; a node that does is no more likely to fail
-- than any other candidate, and a hand-back to it still needs every other
-- candidate condition and a holder lost for silence_minutes. So the role can
-- return to a node at most once per 30 minutes of its proven stability.
-- 30 minutes is 6 silence windows (5 minutes, ADR 0026), the watchdog's
-- original silence window (Decision 199cf3de) and long against the 1-minute
-- heartbeat with its 30-second retry; short against "until the Owner acts".
--
-- Why not drop auto_handed_out: the candidate rules read only the latest
-- report and the last two heartbeats, so a node that just came back after
-- dropping out every few minutes would look as fit as a steady one; without the
-- exclusion the watchdog could hand the role straight back to it.
--
-- Rows heard before this migration start with steady_since null; their next
-- healthy heartbeat starts a run. Nothing else changes: every candidate
-- condition, the receiver's heartbeats, HALTED/PAUSED/INTAKE_PAUSED holders
-- never handed out, the master switch, alerts and receipts.

set local lock_timeout = '5s';

alter table clued_private.ci_node_liveness_v1 add column steady_since timestamptz,
  add constraint ci_node_liveness_v1_steady_since_check check (steady_since is null or steady_since<=last_heartbeat_at);
comment on column clued_private.ci_node_liveness_v1.steady_since is
  'Start of the current run of healthy heartbeats each less than silence_minutes after the one before (migration 20261115120000).';

-- Anchored rewrites of the current definitions (20261031090000 with
-- 20261112130500's and 20261115100000's patches): a missing function or an
-- anchor that is absent or repeated aborts the whole migration.
do $patch$
declare x record; body text;
begin
  for x in select * from (values
    (1,'clued_private.ci_failover_rules_v1()',
     $a$'receiver_heartbeats',2,$a$,
     $r$'receiver_heartbeats',2,'rejoin_steady_minutes',30,$r$),
    (2,'clued_private.ci_node_heartbeat_v1(public.clued_agent_bindings,jsonb)',
     $a$readable_intake_until,readable_at,unhealthy_since)$a$,
     $r$readable_intake_until,readable_at,unhealthy_since,steady_since)$r$),
    (3,'clued_private.ci_node_heartbeat_v1(public.clued_agent_bindings,jsonb)',
     $a$case when v_state<>'UNKNOWN' then v_now end,case when v_unhealthy then v_now end$a$,
     $r$case when v_state<>'UNKNOWN' then v_now end,case when v_unhealthy then v_now end,
      case when v_healthy then v_now end$r$),
    (4,'clued_private.ci_node_heartbeat_v1(public.clued_agent_bindings,jsonb)',
     $a$when v_healthy then null else l.unhealthy_since end$a$,
     $r$when v_healthy then null else l.unhealthy_since end,
      steady_since=case when not v_healthy then null
        when l.last_heartbeat_at>v_now-make_interval(mins=>(clued_private.ci_failover_rules_v1()->>'silence_minutes')::integer)
          then coalesce(l.steady_since,v_now)
        else v_now end$r$)
  ) v(n,sig,anchor,replacement) order by n loop
    if to_regprocedure(x.sig) is null then raise exception 'ci_failover_rejoin_function_missing: %',x.sig; end if;
    body:=pg_get_functiondef(x.sig::regprocedure);
    if (length(body)-length(replace(body,x.anchor,'')))<>length(x.anchor) then
      raise exception 'ci_failover_rejoin_anchor_mismatch: % (%)',x.sig,x.n; end if;
    execute replace(body,x.anchor,x.replacement);
  end loop;
end $patch$;

create or replace function clued_private.ci_failover_exclusion_v1(p_owner uuid,p_binding uuid,p_now timestamptz) returns text
language sql stable security definer set search_path='' as $$
  -- auto_handed_out: an automatic handover took the role from this node, no
  -- manual handover to or from it nor a hand mark of ci-admission on it came
  -- after, and it has not yet proven itself steady again: heard within
  -- silence_minutes and steadily healthy (steady_since) for
  -- rejoin_steady_minutes (§41.6a, migration 20261115120000). The read stays
  -- small: the account's handover and role receipts only
  -- (clued_audit_receipts_ci_failover_v1) and the node's liveness row.
  select case
    when exists(select 1 from public.clued_audit_receipts r where r.user_id=p_owner and r.context_key='global'
        and r.operation='binding_role_handover' and r.metadata->>'receipt_kind'='CI_ADMISSION_AUTO_HANDOVER'
        and r.metadata->>'from_binding_id'=p_binding::text
        and not exists(select 1 from public.clued_audit_receipts m where m.user_id=p_owner and m.context_key='global'
          and m.operation in ('binding_role_handover','binding_role_set') and m.created_at>r.created_at
          and ((m.operation='binding_role_handover' and m.metadata->>'receipt_kind'='BINDING_ROLE_HANDED_OVER'
              and p_binding::text in (m.metadata->>'from_binding_id',m.metadata->>'to_binding_id'))
            or (m.operation='binding_role_set' and m.metadata->>'receipt_kind'='BINDING_ROLE_GRANTED'
              and m.metadata->>'role'='ci-admission' and m.metadata->>'binding_id'=p_binding::text))))
      and not exists(select 1 from clued_private.ci_failover_node_v1(p_owner,p_binding) n
        where n.last_heartbeat_at>p_now-make_interval(mins=>(clued_private.ci_failover_rules_v1()->>'silence_minutes')::integer)
          and n.steady_since<=p_now-make_interval(mins=>(clued_private.ci_failover_rules_v1()->>'rejoin_steady_minutes')::integer))
      then 'auto_handed_out'
  end
$$;
