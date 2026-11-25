-- The watchdog hands a ci-admission holder out only for a trigger it can name
-- (DESIGN §41.6a, Task aeefed92).
--
-- 20261116100000 decided with `if not v_silent and not v_stuck and not
-- v_halted` and then named the trigger with `case ... else 'halted'`. v_halted
-- is `readable_state='HALTED' and ...`: for a holder whose liveness row has no
-- readable state (it has only ever reported UNKNOWN, e.g. a new row whose
-- first heartbeats are UNKNOWN) it is NULL, `not NULL` is NULL, the `if` does
-- not return 'holder_alive', and the holder was handed out at the next minute's
-- tick with the trigger 'halted' and a Note saying it had HALTed, though it
-- never reported a HALT. Test: merge-train-failover-db, "service not running
-- or stale snapshot" (a single run of 4.9 minutes and UNKNOWN alone) and the
-- "UNKNOWN only" scenarios.
--
-- The rule now: the trigger is computed first, as the one named reason that
-- holds (`case when` matches only a true condition, so NULL and false go the
-- same way, and there is no `else`); no trigger, no handover ('holder_alive').
-- Whether to hand over, the receipt's trigger and the Note's wording all come
-- from that one value. UNKNOWN starts no clock of its own: a holder that only
-- ever reported UNKNOWN is still judged by the two server clocks (silence;
-- service reported down or snapshot stale, unhealthy_since). v_halted is kept
-- non-NULL (coalesce ... false) for anything that reads it later.
--
-- Only clued_private.ci_admission_failover_owner_v1(uuid) changes; no data,
-- no switch. Anchored rewrite of the current definition (20261031090000 with
-- the patches of 20261105160000, 20261112130500 and 20261116100000): a missing
-- function or an anchor that is absent or repeated aborts the whole migration.

set local lock_timeout = '5s';

do $patch$
declare x record; body text;
begin
  for x in select * from (values
    (1,'clued_private.ci_admission_failover_owner_v1(uuid)',
     $a$  v_halted:=xn.readable_state='HALTED' and xn.halted_since<=v_now
    -make_interval(mins=>(clued_private.ci_failover_rules_v1()->>'halted_minutes')::integer);
  if not v_silent and not v_stuck and not v_halted then
    return jsonb_build_object('outcome','holder_alive','holder',v_holder);
  end if;
  v_trigger:=case when v_silent then 'silence' when v_stuck then 'service_not_running' else 'halted' end;
  v_why:=case when v_silent then '失联 5 分钟' when v_stuck then '连续 5 分钟报服务没在运行或状态快照过旧'
      else '停机（HALT '||coalesce(xn.reported_halt->>'code','原因未报出')||'）已满 '
        ||(clued_private.ci_failover_rules_v1()->>'halted_minutes')||' 分钟' end
    ||case when not v_holder_live then '（它的 CI 连接已失效）' else '' end;$a$,
     $r$  v_halted:=coalesce(xn.readable_state='HALTED' and xn.halted_since<=v_now
    -make_interval(mins=>(clued_private.ci_failover_rules_v1()->>'halted_minutes')::integer),false);
  -- The one named trigger that holds (migration 20261122120000): no else, so a
  -- condition that is NULL or false names nothing and nothing is handed out.
  v_trigger:=case when v_silent then 'silence' when v_stuck then 'service_not_running'
    when v_halted then 'halted' end;
  if v_trigger is null then
    return jsonb_build_object('outcome','holder_alive','holder',v_holder);
  end if;
  v_why:=case v_trigger when 'silence' then '失联 5 分钟'
      when 'service_not_running' then '连续 5 分钟报服务没在运行或状态快照过旧'
      when 'halted' then '停机（HALT '||coalesce(xn.reported_halt->>'code','原因未报出')||'）已满 '
        ||(clued_private.ci_failover_rules_v1()->>'halted_minutes')||' 分钟' end
    ||case when not v_holder_live then '（它的 CI 连接已失效）' else '' end;$r$)
  ) v(n,sig,anchor,replacement) order by n loop
    if to_regprocedure(x.sig) is null then raise exception 'ci_failover_trigger_function_missing: %',x.sig; end if;
    body:=pg_get_functiondef(x.sig::regprocedure);
    if (length(body)-length(replace(body,x.anchor,'')))<>length(x.anchor) then
      raise exception 'ci_failover_trigger_anchor_mismatch: % (%)',x.sig,x.n; end if;
    execute replace(body,x.anchor,x.replacement);
  end loop;
end $patch$;
