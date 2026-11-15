-- The ci-admission failover watchdog no longer keeps a node out for 6 hours
-- after it handed the role over (DESIGN §41.6a, resident ADR 0013).
--
-- 2026-11-15 (production, read only): the Owner handed ci-admission
-- TURING -> DESK at 02:27Z and DESK -> TURING at 02:37Z, both planned and both
-- fine. Afterwards ci_failover_exclusion_v1 answered 'cooldown' for both nodes:
-- for 6 hours, had the holder gone silent, nobody would have taken over. In a
-- two-node fleet every planned handover (an upgrade, maintenance, switching
-- back) switched automatic takeover off for 6 hours.
--
-- What the cooldown was for and what does that job now:
-- - Ping-pong between automatic handovers (ADR 0013: "since the last automatic
--   takeover"): auto_handed_out keeps a node handed out automatically out with
--   no time bound, until the Owner hands over to or from it by hand. A 6-hour
--   cooldown on top of that adds nothing.
-- - A node handed out (or whose role was ended) by the Owner on purpose, for
--   example to upgrade or repair it: while it is not fit it is no candidate
--   anyway (heard within target_heartbeat_minutes, STANDBY, probe not-held,
--   NORMAL, service running, the holder's Source and the fleet's, two
--   heartbeats during the holder's silence; and the handover core refuses an
--   unfit target, 20261114120000). Once it is fit again it is exactly the node
--   automatic takeover is for. The Owner keeps a fit node out by pausing it or
--   taking it off the list of eligible nodes (/bindings/failover).
-- So the 6-hour window only ever withheld a takeover to a fit node, and the
-- cooldown goes, for all three receipt kinds it read (the Owner's handover,
-- an automatic handover, the Owner ending the role). Its rule cooldown_hours
-- goes from ci_failover_rules_v1 with it (the rule was never read: the body
-- said interval '6 hours'). Old receipts that list the reason 'cooldown' keep
-- their wording on /bindings/failover.
--
-- Nothing else changes: auto_handed_out and when it lifts, every candidate
-- condition, the receiver's heartbeats, HALTED/PAUSED/INTAKE_PAUSED holders
-- never handed out, the master switch, alerts and receipts.

set local lock_timeout = '5s';

create or replace function clued_private.ci_failover_exclusion_v1(p_owner uuid,p_binding uuid,p_now timestamptz) returns text
language sql stable security definer set search_path='' as $$
  -- auto_handed_out: an automatic handover took the role from this node and
  -- no manual handover to or from it, nor a hand mark of ci-admission on it,
  -- came after. No time bound on purpose (§41.6a): the node stays out until
  -- the Owner hands over to or from it by hand, however long that takes.
  -- p_now is kept for the callers' signature. The read stays small: the
  -- account's handover and role receipts only
  -- (clued_audit_receipts_ci_failover_v1).
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
      then 'auto_handed_out'
  end
$$;

-- The rule goes with the cooldown. Anchored rewrite of the current definition
-- (20261031090000 with 20261112130500's patch): an anchor that is absent or
-- repeated aborts the migration.
do $migration$
declare body text:=pg_get_functiondef('clued_private.ci_failover_rules_v1()'::regprocedure);
  anchor constant text:='''cooldown_hours'',6,';
begin
  if (length(body)-length(replace(body,anchor,'')))<>length(anchor) then
    raise exception 'ci_failover_no_cooldown_anchor_mismatch: ci_failover_rules_v1'; end if;
  execute replace(body,anchor,'');
end $migration$;
