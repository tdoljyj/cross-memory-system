-- ========================================================================================
-- STEP 19 READ-BACK. Read-only. Run after EACH of the twenty observations.
-- ========================================================================================
-- Compare each *_now against the *_before that step19-pre.sql recorded for the SAME observation.
-- PQUAL-01's expectation is the template for all of them: "only the exact test action happens;
-- Evidence is produced; ACTIVE/default/Entry/Slice A state is unchanged." So the deltas are the
-- finding, not the absolute numbers.
--
-- Abort rather than continue if:
--   * charged_seconds grew by more than the observation should cost
--   * execution_events gained a row whose operation is not the one this observation dispatches
--   * the GA became revoked, or its phase moved unexpectedly
--   * events (the root's own table) changed at all -- observations must not touch it

select
  clock_timestamp()                                                            as observed_at,
  (select charged_seconds from clued_control.execution_current)                as charged_seconds_now,
  (select charged_evidence_bytes from clued_control.execution_current)         as charged_evidence_bytes_now,
  (select active_ga_id from clued_control.execution_current)                   as active_ga_id,
  (select phase from clued_control.gate_attempts
    where ga_id=(select active_ga_id from clued_control.execution_current)
    order by sequence desc limit 1)     as phase,
  (select revoked from clued_control.gate_attempts
    where ga_id=(select active_ga_id from clued_control.execution_current)
    order by sequence desc limit 1)     as revoked,
  (select count(*) from clued_control.execution_events)                        as exec_event_rows_now,
  (select jsonb_agg(jsonb_build_object('sequence',e.sequence,'operation',e.request->>'operation',
                                       'recorded_at',e.recorded_at) order by e.sequence)
     from clued_control.execution_events e where e.sequence > 89)              as events_after_the_forward,
  (select count(*) from clued_control.gate_attempts)                           as gate_attempts_now,
  (select count(*) from clued_control.control_objects)                         as control_objects_now,
  (select count(*) from clued_control.events) = 6                              as events_still_6,
  (select generation_id from clued_control.current_head
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878')                      as head_generation,
  (select x.controller_sha256 from clued_control.effective_execution_binding() x) as binding_controller_sha256;
