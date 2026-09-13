-- ========================================================================================
-- STEP 15 READ-BACK. Read-only. Run immediately after append_status_manifest -- including on
-- error or interruption, before deciding anything.
-- ========================================================================================
-- Compare control_objects_now against the control_objects_before recorded by step15-pre.sql:
--   difference of exactly 1  -> appended
--   difference of 0          -> nothing appended; the call raised and rolled back. Re-read the
--                               exception. Do NOT retry until the reason is understood; a
--                               series_* or generation/window exception means CP-01's A3/A4 are
--                               not actually in effect, so go back to cp01-readback.sql rather
--                               than retrying the append.
--   any other difference     -> STOP and investigate.

select
  clock_timestamp()                                                            as observed_at,
  (select count(*) from clued_control.control_objects)                         as control_objects_now,
  -- Summarised: control_objects.raw holds whole signed documents.
  (select jsonb_agg(jsonb_build_object('object_type',x.object_type,'uri',x.uri,'sha256',x.sha256,
                                       'generation',x.generation,'recorded_at',x.recorded_at)
                    order by x.recorded_at)
     from (select * from clued_control.control_objects order by recorded_at desc limit 3) x)
                                                                               as newest_three_objects,

  -- Nothing else may have moved. Appending a status manifest must not spend budget or issue a GA.
  (select charged_seconds from clued_control.execution_current) = 9906         as allocation_still_unspent,
  (select charged_evidence_bytes from clued_control.execution_current) = 2201594803 as evidence_bytes_unchanged,
  (select sequence from clued_control.execution_current) = 89                  as execution_sequence_89,
  (select count(*) from clued_control.execution_events) = 89                   as exec_events_89,
  (select count(*) from clued_control.events) = 6                              as events_still_6,
  (select active_ga_id is null from clued_control.execution_current)           as no_active_ga,
  (select pending_budget_sequence is null from clued_control.execution_current) as no_pending_budget,
  (select count(*) from clued_control.gate_attempts) = 14                      as gate_attempts_still_14,
  (select x.controller_sha256 from clued_control.effective_execution_binding() x) as binding_controller_sha256;
