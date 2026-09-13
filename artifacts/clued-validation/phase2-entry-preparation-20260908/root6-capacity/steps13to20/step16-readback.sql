-- ========================================================================================
-- STEP 16 READ-BACK. Read-only. Run IMMEDIATELY after reserve_execution_budget, and run it
-- FIRST if the call errored, returned nothing, or was interrupted. NEVER retry before reading.
-- ========================================================================================
-- Why retrying is forbidden here and not merely discouraged: an exception means one of the
-- series_* guards was unsatisfied, and retrying will simply raise again. But if the call in fact
-- partially took effect, a retry pushes charged_seconds past the 10506 ceiling, and the ceiling
-- equals the post-use value, so there is nothing to absorb it.
--
--   pending_budget_sequence not null and charged_seconds consistent -> reserved
--   pending_budget_sequence null and charged_seconds = 9906         -> nothing happened; the
--       allocation is intact. Read the exception, fix the cause, re-run step16-pre.sql.
--   charged_seconds <> 9906 with no corresponding successful reservation -> STOP THE PROGRAMME.
--       The single allocation has been lost. It cannot be refunded and there is no second one.

select
  clock_timestamp()                                                            as observed_at,
  (select pending_budget_sequence from clued_control.execution_current)        as pending_budget_sequence,
  (select pending_budget_sequence is not null from clued_control.execution_current) as reservation_present,
  (select charged_seconds from clued_control.execution_current)                as charged_seconds,
  (select charged_seconds = 9906 from clued_control.execution_current)         as charged_seconds_still_9906,
  (select charged_evidence_bytes from clued_control.execution_current)         as charged_evidence_bytes,
  (select active_ga_id from clued_control.execution_current)                   as active_ga_id,
  (select sequence from clued_control.execution_current)                       as execution_sequence,
  (select count(*) from clued_control.execution_events)                        as exec_event_rows,

  -- The reserved allocation's own window, read back and compared to the only legal value.
  -- reserve_execution_budget:125 demands exact equality; this is where that is confirmed rather
  -- than trusted.
  -- The reservation event stores its payload as body.raw, a JSON *string* (measured against the
  -- last BUDGET_RESERVED event, sequence 85), so it has to be cast back to jsonb to read a field.
  (select request->>'operation' from clued_control.execution_events
    where sequence=(select pending_budget_sequence from clued_control.execution_current)) as reservation_operation,
  (select (request->'body'->>'raw')::jsonb->>'expires_at' from clued_control.execution_events
    where sequence=(select pending_budget_sequence from clued_control.execution_current))
                                                                               as reserved_expires_at,
  (select (request->'body'->>'raw')::jsonb->>'seconds' from clued_control.execution_events
    where sequence=(select pending_budget_sequence from clued_control.execution_current))
                                                                               as reserved_seconds,
  (select (request->'body'->>'raw')::jsonb->>'root_generation' from clued_control.execution_events
    where sequence=(select pending_budget_sequence from clued_control.execution_current))
                                                                               as reserved_root_generation,
  (select (request->'body'->>'raw')::jsonb->>'controller_digest' from clued_control.execution_events
    where sequence=(select pending_budget_sequence from clued_control.execution_current))
                                                                               as reserved_controller_digest,
  (select request->'body'->>'sha256' from clued_control.execution_events
    where sequence=(select pending_budget_sequence from clued_control.execution_current))
                                                                               as reserved_body_sha256,

  -- Surroundings untouched.
  (select count(*) from clued_control.events) = 6                              as events_still_6,
  (select generation_id from clued_control.current_head
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878')                       as head_generation,
  (select x.controller_sha256 from clued_control.effective_execution_binding() x) as binding_controller_sha256,
  (select count(*) from clued_control.gate_attempts)                           as gate_attempts;

-- Expected after a successful step 16:
--   reservation_present t | reservation_operation BUDGET_RESERVED
--   reserved_expires_at 2026-09-13T07:05:16Z   <- exact equality is required by :125
--   reserved_seconds 600 | reserved_root_generation ctrgen_5e0440a95ac8ee257b9e4236cabd275b
--   reserved_controller_digest 389fee9b7e533041119838df59706cc2166b44497369cca419b1dc125e9a98ec
--   active_ga_id NULL (the GA is step 17) | events_still_6 t
--   binding_controller_sha256 389fee9b...
