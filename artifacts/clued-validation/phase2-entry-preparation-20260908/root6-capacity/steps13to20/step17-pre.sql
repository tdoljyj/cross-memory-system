-- ========================================================================================
-- STEP 17 PRECONDITIONS (GA issuance). Read-only. Expect every boolean true.
-- ========================================================================================
-- The command is:  select clued_control.reserve_gate(<ga_raw>, <sha>);
-- <ga_raw> is produced by the controller, not hand-written.
--
-- PARAMETERISED: the GA id. It does not exist before this step. reserve_gate creates it and
-- writes it into clued_control.execution_current.active_ga_id; step19-ga-id.sql reads it back.
-- Do not take a GA id from any document -- there is no document that can legitimately contain it.
--
-- What reserve_gate checks that this file mirrors (measured line numbers, pre-CP-01 bodies):
--   :48  series_n>9 or series_f>16 (after CP-01's G3) or charged_seconds <> 5106+600*series_n
--   :112 clock_timestamp()+600s >= <window literal>          -- the same real cutoff as step 16
--   :126 g->>'controller_digest' = b.controller_sha256 and g->>'scope_digest' = b.scope_sha256
--   :138 (g->>'expires_at') - start_time <= interval '600 seconds'
--   :152 allocation->>'profile_digest' = g->>'profile_digest' and the same for controller_digest
-- and, on the controller side, context.mjs:70 and :76, which additionally require the GA's
-- controller_qualification_ref.sha256 to equal the binding's qualification_sha256 AND that
-- document's own controller_digest to equal the binding's controller_sha256.

select
  clock_timestamp()                                                            as observed_at,

  -- Step 16 reserved; step 17 has not yet issued.
  (select pending_budget_sequence is not null from clued_control.execution_current) as reservation_present,
  (select pending_budget_sequence from clued_control.execution_current)        as pending_budget_sequence,
  (select active_ga_id is null from clued_control.execution_current)           as no_ga_yet,

  -- Caps.
  (select count(*) from clued_control.execution_events
     where sequence>44 and request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED') <= 16 as series_f_within_cap,
  (select count(*) from pg_proc p, unnest(string_to_array(p.prosrc,E'\n')) u(t)
     where p.oid='clued_control.reserve_gate(text,text)'::regprocedure
       and t like '%series_f>16%') = 1                                          as cap_raised_in_gate_fn,
  (select count(*) from pg_proc p, unnest(string_to_array(p.prosrc,E'\n')) u(t)
     where p.oid='clued_control.reserve_gate(text,text)'::regprocedure
       and t like '%ctrgen_5e0440a95ac8ee257b9e4236cabd275b%') >= 1             as gate_fn_pins_root6,
  (select count(*) from pg_proc p, unnest(string_to_array(p.prosrc,E'\n')) u(t)
     where p.oid='clued_control.reserve_gate(text,text)'::regprocedure
       and t like '%2026-09-12T13:14:51Z%') = 0                                 as superseded_window_gone,

  -- The binding the GA must match field for field. Build the GA against THESE values.
  (select x.controller_sha256 from clued_control.effective_execution_binding() x) as binding_controller_sha256,
  (select x.scope_sha256 from clued_control.effective_execution_binding() x)      as binding_scope_sha256,
  (select x.profile_sha256 from clued_control.effective_execution_binding() x)    as binding_profile_sha256,
  (select x.qualification_sha256 from clued_control.effective_execution_binding() x) as binding_qualification_sha256,
  (select x.runtime_acceptance_sha256 from clued_control.effective_execution_binding() x) as binding_runtime_acceptance_sha256,
  (select x.gate_sha256 from clued_control.effective_execution_binding() x)       as binding_gate_sha256,
  (select x.gate_version from clued_control.effective_execution_binding() x)      as binding_gate_version,
  (select x.controller_sha256 from clued_control.effective_execution_binding() x)
    = '68133f2d617718c8ea964e3cebb6abcdbe98671aa5c630d81f0ea2daa9eed24a'        as binding_is_frozen_linux,

  -- Time. The GA's own lifetime is capped at 600 seconds (:138), and the window must still hold
  -- the whole run plus the observations plus the GRR.
  (select extract(epoch from (expires_at - interval '600 seconds' - clock_timestamp()))
     from clued_control.accepted_binding
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878')                      as seconds_until_600s_cutoff,
  (select clock_timestamp() + interval '600 seconds' < expires_at
     from clued_control.accepted_binding
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878')                      as cutoff_not_yet_passed,

  -- Surroundings.
  (select generation_id from clued_control.current_head
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878')
    = 'ctrgen_5e0440a95ac8ee257b9e4236cabd275b'                                as head_is_root6,
  (select count(*) from clued_control.gate_attempts)                           as gate_attempts_before,
  (select count(*) from clued_control.execution_events)                        as exec_event_rows_before;
