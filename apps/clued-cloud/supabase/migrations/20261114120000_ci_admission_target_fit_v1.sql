-- A ci-admission handover lands only on a node fit to take it over.
--
-- 2026-11-12 the Owner's one-click handover moved ci-admission to a node five
-- Source generations behind the holder and CI stood still: nothing refused a
-- handover to a node off the fleet's Source, halted, paused or unheard.
--
-- One check, clued_private.ci_admission_target_require_v1, at every way a
-- node comes to hold ci-admission:
-- - every handover goes through the handover core (20261031090000), which
--   runs clued_private.binding_role_handover_check_v1 under the role lock: the
--   Owner's one-click handover (its confirmation issue runs the same check
--   first), the failover watchdog and the phase 4 -> 3 rollback;
-- - marking it by hand (clued_binding_role_set_v1, both Native steps, through
--   clued_private.binding_role_change_check_v1) with purpose resident-node, or
--   any purpose but parking on a connection that has a live node (purpose
--   other admits for duty too); so "end the holder's role, then mark a node
--   behind" is refused like the handover;
-- - the phase 4 -> 3 rollback's grant when no resident node holds the role
--   (clued_private.ci_phase_4_to_3_v1).
-- A token rotation (clued_headless_binding_issue_v1) moves a row from a
-- connection to its successor on the same node and is not a new holder.
--
-- The accepted Source. The server keeps no copy of the Owner's acceptance (ADR
-- 0030: the acceptance file on the release is its carrier; no server object).
-- It holds each node's own report of the Source it runs
-- (ci_node_liveness_v1.reported_source_sha256, every heartbeat) and one rule
-- over those reports, the one the merge train and the watchdog already apply
-- (DESIGN §41.6, TRAIN_SOURCE_MISMATCH: every node heard within
-- source_window_hours runs the holder's Source, or the train does not run;
-- the watchdog's source_differs_from_holder and source_differs). So the
-- accepted Source is the one the fleet runs, the holder's included: a target
-- that would stop the train once it holds the role is refused. A node that
-- has never reported a Source is not compared, as in the train.
--
-- Refusals, errcode 22023 (the one-click handover answers status 'rejected'
-- with this error_code; the watchdog writes its handover_refused alert and
-- hands nothing over; its own candidate rules already skip such a node):
--   ci_admission_target_not_heard            no live node, or none heard within
--                                            target_heartbeat_minutes
--   ci_admission_target_halted               its latest report: HALTED
--   ci_admission_target_paused               PAUSED
--   ci_admission_target_intake_paused        INTAKE_PAUSED; a node whose Windows
--                                            and Linux sides run different
--                                            versions holds its own intake
--                                            (holder version-skew) and reports this
--   ci_admission_target_state_unknown        UNKNOWN (service stopped, snapshot
--                                            unreadable or stale)
--   ci_admission_target_source_unknown       no Source reported
--   ci_admission_target_source_not_accepted  its Source differs from another
--                                            live node heard within
--                                            source_window_hours
--
-- Every other rule of these entries stays.

set local lock_timeout = '5s';

create function clued_private.ci_admission_target_require_v1(p_owner uuid,p_to uuid) returns void
language plpgsql stable security definer set search_path='' as $$
declare n clued_private.ci_node_liveness_v1%rowtype; v_now timestamptz:=clock_timestamp();
  v_rules jsonb:=clued_private.ci_failover_rules_v1(); v_code text;
begin
  n:=clued_private.ci_failover_node_v1(p_owner,p_to);
  v_code:=case
    when n.node_id is null
      or n.last_heartbeat_at<=v_now-make_interval(mins=>(v_rules->>'target_heartbeat_minutes')::integer)
      then 'ci_admission_target_not_heard'
    when n.reported_state='HALTED' then 'ci_admission_target_halted'
    when n.reported_state='PAUSED' then 'ci_admission_target_paused'
    when n.reported_state='INTAKE_PAUSED' then 'ci_admission_target_intake_paused'
    when n.reported_state is distinct from 'NORMAL' then 'ci_admission_target_state_unknown'
    when n.reported_source_sha256 is null then 'ci_admission_target_source_unknown'
    when exists(select 1 from clued_private.ci_node_liveness_v1 ol join clued_private.ci_nodes_v1 o on o.node_id=ol.node_id
        where ol.user_id=p_owner and o.binding_id<>p_to and o.state not in ('retired','revoked')
          and ol.last_heartbeat_at>v_now-make_interval(hours=>(v_rules->>'source_window_hours')::integer)
          and ol.reported_source_sha256 is not null and ol.reported_source_sha256<>n.reported_source_sha256)
      then 'ci_admission_target_source_not_accepted'
  end;
  if v_code is not null then raise exception '%',v_code using errcode='22023'; end if;
end $$;

revoke all on function clued_private.ci_admission_target_require_v1(uuid,uuid)
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- The check in each entry, after its existing refusals (whose codes keep
-- their precedence). Anchored: each fails unless its anchor occurs exactly once.
do $patch$
declare x record; body text;
begin
  for x in select * from (values
    ('clued_private.binding_role_handover_check_v1(public.clued_agent_bindings,public.clued_agent_bindings)',
     $a$raise exception 'binding_role_resident_holder_exists' using errcode='22023'; end if;$a$,
     $r$
  perform clued_private.ci_admission_target_require_v1(p_from.user_id,p_to.id);$r$),
    ('clued_private.binding_role_change_check_v1(public.clued_agent_bindings,text,boolean,jsonb)',
     $a$raise exception 'binding_role_resident_holder_exists' using errcode='22023'; end if;$a$,
     $r$
  if p_purpose#>>'{}'='resident-node' or (p_purpose#>>'{}'<>'parking' and exists(select 1 from clued_private.ci_nodes_v1 n
      where n.user_id=p_binding.user_id and n.binding_id=p_binding.id and n.state not in ('retired','revoked'))) then
    perform clued_private.ci_admission_target_require_v1(p_binding.user_id,p_binding.id); end if;$r$),
    ('clued_private.ci_phase_4_to_3_v1(uuid,uuid,integer,boolean)',
     $a$raise exception 'CI_PHASE_ROLLBACK_TARGET_INVALID' using errcode='55000'; end if;$a$,
     $r$
        perform clued_private.ci_admission_target_require_v1(u,tb.id);$r$)
  ) v(sig,anchor,addition) loop
    body:=pg_get_functiondef(x.sig::regprocedure);
    if (length(body)-length(replace(body,x.anchor,'')))<>length(x.anchor) then
      raise exception 'ci_admission_target_fit_anchor_mismatch: %',x.sig; end if;
    execute replace(body,x.anchor,x.anchor||x.addition);
  end loop;
end $patch$;
