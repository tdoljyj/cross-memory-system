-- ========================================================================================
-- STEP 20 READ-BACK. Read-only. Run immediately after commit_gate_result, including on error.
-- ========================================================================================
-- DO NOT RESUBMIT A GRR. commit_gate_result's duplicate-submission behaviour has not been
-- independently verified in this programme, so this sheet does not assume it is idempotent. If
-- the call errored, read this first and establish whether the receipt landed:
--
--   receipt_id not null and receipt_sha256 matches what was submitted -> committed
--   receipt_id null and gate_attempts unchanged -> nothing landed; read the exception
--   anything else -> STOP and investigate before any further call

select
  clock_timestamp()                                                            as observed_at,
  (select active_ga_id from clued_control.execution_current)                   as active_ga_id,
  (select ga_id from clued_control.gate_attempts order by sequence desc limit 1) as newest_attempt_ga_id,
  (select phase from clued_control.gate_attempts order by sequence desc limit 1) as phase,
  (select receipt_id from clued_control.gate_attempts order by sequence desc limit 1) as receipt_id,
  (select receipt_sha256 from clued_control.gate_attempts order by sequence desc limit 1) as receipt_sha256,
  (select decision from clued_control.gate_attempts order by sequence desc limit 1) as decision,
  (select revoked from clued_control.gate_attempts order by sequence desc limit 1) as revoked,
  (select container_id from clued_control.gate_attempts order by sequence desc limit 1) as container_id,
  (select charged_seconds from clued_control.execution_current)                as charged_seconds,
  (select charged_evidence_bytes from clued_control.execution_current)         as charged_evidence_bytes,
  (select pending_budget_sequence from clued_control.execution_current)        as pending_budget_sequence,
  (select sequence from clued_control.execution_current)                       as execution_sequence,
  (select count(*) from clued_control.execution_events)                        as exec_event_rows,
  (select count(*) from clued_control.gate_attempts)                           as gate_attempts_now,
  (select count(*) from clued_control.control_objects)                         as control_objects_now,
  (select jsonb_agg(jsonb_build_object('object_type',x.object_type,'uri',x.uri,'sha256',x.sha256,
                                       'generation',x.generation,'recorded_at',x.recorded_at)
                    order by x.recorded_at)
     from (select * from clued_control.control_objects order by recorded_at desc limit 3) x)
                                                                               as newest_three_objects,
  (select count(*) from clued_control.events) = 6                              as events_still_6,
  (select generation_id from clued_control.current_head
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878')                      as head_generation;
