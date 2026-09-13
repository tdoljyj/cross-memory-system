-- ========================================================================================
-- STEP 18 READ-BACK. Read-only. Run immediately after the run ends, and FIRST of all if the
-- controller reported state:'UNKNOWN' -- that is precisely the case this file exists for.
-- ========================================================================================
-- On UNKNOWN, this query and step19-ga-id.sql are how the real state is established. Retrying
-- the run is never the right response: the allocation is one-shot, and a second attempt against
-- a dispatch that already happened cannot be undone.

select
  clock_timestamp()                                                            as observed_at,
  (select charged_seconds from clued_control.execution_current)                as charged_seconds,
  (select charged_seconds - 9906 from clued_control.execution_current)         as seconds_consumed_so_far,
  (select charged_evidence_bytes from clued_control.execution_current)         as charged_evidence_bytes,
  (select charged_evidence_bytes - 2201594803 from clued_control.execution_current) as evidence_bytes_added,
  (select active_ga_id from clued_control.execution_current)                   as active_ga_id,
  (select pending_budget_sequence from clued_control.execution_current)        as pending_budget_sequence,
  (select sequence from clued_control.execution_current)                       as execution_sequence,
  (select count(*) from clued_control.execution_events)                        as exec_event_rows,
  (select jsonb_agg(jsonb_build_object('sequence',e.sequence,'operation',e.request->>'operation',
                                       'recorded_at',e.recorded_at) order by e.sequence)
     from clued_control.execution_events e where e.sequence > 89)              as events_after_the_forward,
  (select count(*) from clued_control.gate_attempts)                           as gate_attempts,
  (select jsonb_agg(jsonb_build_object(
       'sequence',x.sequence,'ga_id',x.ga_id,'phase',x.phase,'revoked',x.revoked,
       'container_id',x.container_id,'expires_at',x.expires_at,'receipt_id',x.receipt_id,
       'budget_sequence',x.budget_sequence,'decision',x.decision) order by x.sequence)
     from (select * from clued_control.gate_attempts order by sequence desc limit 3) x) as newest_three_gate_attempts,
  (select count(*) from clued_control.control_objects)                         as control_objects,
  (select count(*) from clued_control.events) = 6                              as events_still_6;
