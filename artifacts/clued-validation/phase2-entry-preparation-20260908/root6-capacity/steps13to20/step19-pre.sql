-- ========================================================================================
-- STEP 19 PRECONDITIONS (twenty PQUAL observations). Read-only. Run before EACH observation --
-- the GA's own lifetime is capped at 600 seconds, so "still valid" is not a once-per-step fact.
-- ========================================================================================
-- It is TWENTY observations, not nineteen. QualificationCases.json has
-- source_specification_count 20 and twenty cases, PQUAL-01 through PQUAL-20, from
-- work/slice-a-contracts/QualificationRegressionSpecifications.json at source_commit f3d00661.
-- ExecutionRunbook.md and OwnerOrderingAmendment.json both say nineteen; both are wrong.
--
-- EXPECT series_first_pass_stops. reserve_gate:90 and reserve_execution_budget:95 both carry
--     if series_a->>'phase'='PASS' then raise exception 'series_first_pass_stops'
-- so the first PASS closes the path behind it. That is the design, not a fault, and it must not
-- be treated as an error to retry around.

select
  clock_timestamp()                                                            as observed_at,
  (select active_ga_id from clued_control.execution_current)                   as active_ga_id,
  (select active_ga_id is not null from clued_control.execution_current)       as ga_still_active,
  (select not revoked from clued_control.gate_attempts
    where ga_id=(select active_ga_id from clued_control.execution_current)
    order by sequence desc limit 1)     as ga_not_revoked,
  (select expires_at > clock_timestamp() from clued_control.gate_attempts
    where ga_id=(select active_ga_id from clued_control.execution_current)
    order by sequence desc limit 1)     as ga_not_expired,
  (select expires_at - clock_timestamp() from clued_control.gate_attempts
    where ga_id=(select active_ga_id from clued_control.execution_current)
    order by sequence desc limit 1)     as ga_time_remaining,
  (select phase from clued_control.gate_attempts
    where ga_id=(select active_ga_id from clued_control.execution_current)
    order by sequence desc limit 1)     as phase,
  (select expires_at > clock_timestamp() from clued_control.accepted_binding
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878')                      as owner_window_open,
  (select expires_at - clock_timestamp() from clued_control.accepted_binding
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878')                      as window_remaining,
  (select x.controller_sha256 from clued_control.effective_execution_binding() x)
    = '68133f2d617718c8ea964e3cebb6abcdbe98671aa5c630d81f0ea2daa9eed24a'       as binding_is_frozen_linux,
  -- Baselines for this observation's delta.
  (select charged_seconds from clued_control.execution_current)                as charged_seconds_before,
  (select charged_evidence_bytes from clued_control.execution_current)         as charged_evidence_bytes_before,
  (select count(*) from clued_control.execution_events)                        as exec_event_rows_before,
  (select count(*) from clued_control.gate_attempts)                           as gate_attempts_before;
