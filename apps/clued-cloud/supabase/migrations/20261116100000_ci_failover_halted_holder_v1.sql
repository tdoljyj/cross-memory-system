-- A ci-admission holder HALTED for halted_minutes is handed out like a lost one
-- (DESIGN §41.6a, resident ADR 0013).
--
-- 2026-11-14 (production): TURING held ci-admission, HALTed and went on
-- sending heartbeats every minute with its service running and its snapshot
-- fresh (the status timer rewrites it every 15 seconds, HALT or not). The
-- watchdog's two kinds of lost contact are silence and a service reported down
-- (ci_admission_failover_owner_v1: v_silent, v_stuck); neither applied, so it
-- answered 'holder_alive' every minute, and even a silent holder whose latest
-- readable report was HALTED was never handed out ('holder_halted_or_paused').
-- A HALT waits for the Owner's rearm: CI stood still for about 3 hours.
--
-- What the HALT rule of Decision 199cf3de guarded: that two nodes publish at
-- once, and that the watchdog overrides an intended stop. Publishing at once
-- is ruled out by the server for every handover, whatever triggers it: the
-- handover core ends the old holder's row in the same transaction, every stage
-- (1 and 8) takes its admission live (ci_duty_admits_v1, refused once the row
-- has ended), and the new row starts only when the old holder got no positive
-- duty answer within ci_failover_quiet_seconds_v1 (210 s, longer than the
-- ~150 s in which an answer can still land a check), otherwise 5 minutes later
-- (20261112130500). A HALTED executor asks for no admission at all, and when
-- the Owner rearms it its next live admission is refused and it turns STANDBY
-- (§29); its greens not yet merged are revoked by the new holder's takeover
-- sweep (§41.6). The intended stop is PAUSE (the Owner's emergency stop, the
-- upgrader's pause and rollback, the tree-mismatch pause): a PAUSED or
-- unexpired INTAKE_PAUSED holder is still never handed out. A HALT is the
-- executor stopping itself because something on that node is unconfirmed (an
-- archive, a worker unit, a child process tree, the companion): the node is
-- unfit, the fleet is not.
--
-- The rule: the holder's latest readable report is HALTED and has been since
-- at least halted_minutes (a new rule, 5: the silence window of ADR 0026)
-- before now. The time comes from the server alone: the new column
-- ci_node_liveness_v1.halted_since, written by the heartbeat, is the server
-- time of the first HALTED report of the current HALT; UNKNOWN keeps it (looks
-- back, like readable_state), any other readable state clears it. The
-- companion reports a state change at once, so a HALT is seen within about a
-- minute and handed out after halted_minutes; the receipt's trigger is
-- 'halted'. Everything else is unchanged: the candidate conditions (a HALTED
-- node is never a target), the receiver's heartbeats during a silence, the
-- master switch, no automatic hand-back (rejoin_steady_minutes), alerts,
-- Notes and receipts.
--
-- Rows already reporting HALTED start counting from their latest readable
-- report (readable_at), never earlier.

set local lock_timeout = '5s';

alter table clued_private.ci_node_liveness_v1 add column halted_since timestamptz,
  add constraint ci_node_liveness_v1_halted_since_check check (halted_since is null or halted_since<=last_heartbeat_at);
comment on column clued_private.ci_node_liveness_v1.halted_since is
  'Server time of the first HALTED report of the current HALT; UNKNOWN keeps it, any other state clears it (migration 20261116100000).';
update clued_private.ci_node_liveness_v1 set halted_since=readable_at where readable_state='HALTED';

-- Anchored rewrites of the current definitions (20261031090000 with
-- 20261112130500's, 20261115100000's and 20261115120000's patches): a missing
-- function or an anchor that is absent or repeated aborts the whole migration.
do $patch$
declare x record; body text;
begin
  for x in select * from (values
    (1,'clued_private.ci_failover_rules_v1()',
     $a$'rejoin_steady_minutes',30,$a$,
     $r$'rejoin_steady_minutes',30,'halted_minutes',5,$r$),
    (2,'clued_private.ci_node_heartbeat_v1(public.clued_agent_bindings,jsonb)',
     $a$readable_intake_until,readable_at,unhealthy_since,steady_since)$a$,
     $r$readable_intake_until,readable_at,unhealthy_since,steady_since,halted_since)$r$),
    (3,'clued_private.ci_node_heartbeat_v1(public.clued_agent_bindings,jsonb)',
     $a$      case when v_healthy then v_now end
    from clued_private.ci_nodes_v1 n$a$,
     $r$      case when v_healthy then v_now end,case when v_state='HALTED' then v_now end
    from clued_private.ci_nodes_v1 n$r$),
    (4,'clued_private.ci_node_heartbeat_v1(public.clued_agent_bindings,jsonb)',
     $a$        else v_now end
    returning l.node_id)$a$,
     $r$        else v_now end,
      halted_since=case when v_state='UNKNOWN' then l.halted_since
        when v_state='HALTED' then coalesce(l.halted_since,v_now) end
    returning l.node_id)$r$),
    (5,'clued_private.ci_admission_failover_owner_v1(uuid)',
     $a$  v_silent boolean; v_stuck boolean; v_candidates jsonb;$a$,
     $r$  v_silent boolean; v_stuck boolean; v_halted boolean; v_candidates jsonb;$r$),
    (6,'clued_private.ci_admission_failover_owner_v1(uuid)',
     $a$  if not v_silent and not v_stuck then
    return jsonb_build_object('outcome','holder_alive','holder',v_holder);
  end if;
  v_trigger:=case when v_silent then 'silence' else 'service_not_running' end;
  v_why:=case when v_silent then '失联 5 分钟' else '连续 5 分钟报服务没在运行或状态快照过旧' end
    ||case when not v_holder_live then '（它的 CI 连接已失效）' else '' end;
  -- A HALTED, PAUSED or unexpired INTAKE_PAUSED holder is never handed out:
  -- its latest readable report decides (UNKNOWN looks back to it).
  if xn.readable_state in ('HALTED','PAUSED')
      or (xn.readable_state='INTAKE_PAUSED' and xn.readable_intake_until>v_now) then
    return jsonb_build_object('outcome','holder_halted_or_paused','holder',v_holder,'readable_state',xn.readable_state);
  end if;$a$,
     $r$  -- A holder HALTED for halted_minutes is handed out too (migration
  -- 20261116100000): a HALT waits for the Owner's rearm, and the server keeps
  -- two nodes from publishing at once for every handover. halted_since is the
  -- server time of the first HALTED report of this HALT (UNKNOWN looks back).
  v_halted:=xn.readable_state='HALTED' and xn.halted_since<=v_now
    -make_interval(mins=>(clued_private.ci_failover_rules_v1()->>'halted_minutes')::integer);
  if not v_silent and not v_stuck and not v_halted then
    return jsonb_build_object('outcome','holder_alive','holder',v_holder);
  end if;
  v_trigger:=case when v_silent then 'silence' when v_stuck then 'service_not_running' else 'halted' end;
  v_why:=case when v_silent then '失联 5 分钟' when v_stuck then '连续 5 分钟报服务没在运行或状态快照过旧'
      else '停机（HALT '||coalesce(xn.reported_halt->>'code','原因未报出')||'）已满 '
        ||(clued_private.ci_failover_rules_v1()->>'halted_minutes')||' 分钟' end
    ||case when not v_holder_live then '（它的 CI 连接已失效）' else '' end;
  -- A PAUSED or unexpired INTAKE_PAUSED holder is never handed out: a pause is
  -- an intended stop (the Owner's, the upgrader's). Its latest readable report
  -- decides (UNKNOWN looks back to it).
  if xn.readable_state='PAUSED'
      or (xn.readable_state='INTAKE_PAUSED' and xn.readable_intake_until>v_now) then
    return jsonb_build_object('outcome','holder_paused','holder',v_holder,'readable_state',xn.readable_state);
  end if;$r$)
  ) v(n,sig,anchor,replacement) order by n loop
    if to_regprocedure(x.sig) is null then raise exception 'ci_failover_halted_function_missing: %',x.sig; end if;
    body:=pg_get_functiondef(x.sig::regprocedure);
    if (length(body)-length(replace(body,x.anchor,'')))<>length(x.anchor) then
      raise exception 'ci_failover_halted_anchor_mismatch: % (%)',x.sig,x.n; end if;
    execute replace(body,x.anchor,x.replacement);
  end loop;
end $patch$;
