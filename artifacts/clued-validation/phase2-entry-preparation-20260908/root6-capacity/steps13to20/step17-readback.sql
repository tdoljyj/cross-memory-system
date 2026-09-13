-- ========================================================================================
-- STEP 17 READ-BACK. Read-only. Run immediately after reserve_gate, including on error.
-- RECORD active_ga_id -- steps 18, 19 and 20 all need it and nothing else produces it.
-- ========================================================================================
--   active_ga_id not null                       -> issued. Write it down.
--   active_ga_id null and gate_attempts unchanged -> nothing happened; read the exception.
--   active_ga_id null and gate_attempts +1      -> a refused attempt is on record. Do NOT retry
--       immediately: read the newest gate_attempts row for the refusal reason first. Each attempt
--       is accounted, and reserve_gate:48 caps series_n at 9.

select
  clock_timestamp()                                                            as observed_at,
  (select active_ga_id from clued_control.execution_current)                   as active_ga_id,
  (select active_ga_id is not null from clued_control.execution_current)       as ga_issued,
  (select pending_budget_sequence from clued_control.execution_current)        as pending_budget_sequence,
  (select charged_seconds from clued_control.execution_current)                as charged_seconds,
  (select count(*) from clued_control.gate_attempts)                           as gate_attempts_now,
  -- Summarised, not to_jsonb(*): ga_raw and receipt_raw are large and are not what is being read.
  (select jsonb_agg(jsonb_build_object(
       'sequence',x.sequence,'ga_id',x.ga_id,'phase',x.phase,'revoked',x.revoked,
       'container_id',x.container_id,'expires_at',x.expires_at,'receipt_id',x.receipt_id,
       'budget_sequence',x.budget_sequence,'decision',x.decision) order by x.sequence)
     from (select * from clued_control.gate_attempts order by sequence desc limit 2) x) as newest_two_gate_attempts,
  (select count(*) from clued_control.execution_events)                        as exec_event_rows,
  (select sequence from clued_control.execution_current)                       as execution_sequence,
  (select count(*) from clued_control.events) = 6                              as events_still_6,
  (select x.controller_sha256 from clued_control.effective_execution_binding() x) as binding_controller_sha256;
