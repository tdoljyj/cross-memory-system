-- ========================================================================================
-- STEP 19 INPUT: the issued GA id. Read-only. The ONLY legitimate source of this value.
-- ========================================================================================
-- The GA id does not exist before step 17. reserve_gate creates it and writes it to
-- clued_control.execution_current.active_ga_id. Every one of the twenty observations, and the
-- GRR, carries it. Do not copy a GA id out of any document: no document can legitimately hold
-- one, because the value is minted by the reservation.
--
-- This is also the file to run first if step 18 reported state:'UNKNOWN'.

select
  clock_timestamp()                                                            as observed_at,
  (select active_ga_id from clued_control.execution_current)                   as ga_id,
  (select ga_id from clued_control.gate_attempts
    order by sequence desc limit 1)                                            as newest_attempt_ga_id,
  (select active_ga_id = (select ga_id from clued_control.gate_attempts order by sequence desc limit 1)
     from clued_control.execution_current)                                     as current_matches_newest_attempt,
  (select phase from clued_control.gate_attempts
    where ga_id=(select active_ga_id from clued_control.execution_current)
    order by sequence desc limit 1)     as phase,
  (select expires_at from clued_control.gate_attempts
    where ga_id=(select active_ga_id from clued_control.execution_current)
    order by sequence desc limit 1)     as ga_expires_at,
  (select expires_at - clock_timestamp() from clued_control.gate_attempts
    where ga_id=(select active_ga_id from clued_control.execution_current)
    order by sequence desc limit 1)     as ga_time_remaining,
  (select revoked from clued_control.gate_attempts
    where ga_id=(select active_ga_id from clued_control.execution_current)
    order by sequence desc limit 1)     as revoked,
  (select container_id from clued_control.gate_attempts
    where ga_id=(select active_ga_id from clued_control.execution_current)
    order by sequence desc limit 1)     as container_id,
  (select budget_sequence from clued_control.gate_attempts
    where ga_id=(select active_ga_id from clued_control.execution_current)
    order by sequence desc limit 1)     as budget_sequence;
