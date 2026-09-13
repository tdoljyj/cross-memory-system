-- ========================================================================================
-- STEP 14 READ-BACK. Read-only. Run IMMEDIATELY after the forward transaction -- including
-- when it errored or was cut off, BEFORE deciding whether to retry.
-- ========================================================================================
-- The forward is one `do $nf20$ ... $nf20$` block between begin; and commit;, so an exception
-- rolls the whole thing back and leaves no trace. The three outcomes:
--
--   exec_events_89 = false and execution_sequence = 88
--       Nothing landed. Safe to regenerate and retry -- but the 60-second preimage window is
--       long gone, so capture a FRESH preimage first (step14-preimage-capture.sql).
--
--   all of exec_events_89, execution_sequence 89, series_f 16, controller moved  = true
--       The forward succeeded.
--
--   any mixture of the above
--       STOP. A partial forward should be impossible inside one transaction. Its appearance
--       means an assumption about atomicity is wrong; investigate before any further write.
--
--   charged_seconds <> 9906
--       STOP. The forward must not touch the budget. The single allocation is at risk.

select
  clock_timestamp()                                                            as observed_at,
  (select count(*) from clued_control.execution_events) = 89                    as exec_events_89,
  (select sequence from clued_control.execution_current)                        as execution_sequence,
  (select idempotency_key from clued_control.execution_events where sequence=89) as event89_idempotency_key,
  (select request->>'operation' from clued_control.execution_events where sequence=89) as event89_operation,
  (select recorded_at from clued_control.execution_events where sequence=89)     as event89_recorded_at,
  (select count(*) from clued_control.execution_events
     where sequence>44 and request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED') as series_f_now,
  (select count(*) from clued_control.execution_events
     where request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED')          as forwards_now,

  -- The point of the forward: the binding must now carry the frozen Linux controller and the
  -- root6-runtime-v19 qualification/runtime acceptance.
  (select x.controller_sha256 from clued_control.effective_execution_binding() x) as binding_controller_sha256,
  (select x.qualification_sha256 from clued_control.effective_execution_binding() x) as binding_qualification_sha256,
  (select x.runtime_acceptance_sha256 from clued_control.effective_execution_binding() x) as binding_runtime_acceptance_sha256,
  (select x.scope_sha256 from clued_control.effective_execution_binding() x)      as binding_scope_sha256,
  (select x.gate_version from clued_control.effective_execution_binding() x)      as binding_gate_version,
  (select x.controller_sha256 from clued_control.effective_execution_binding() x)
    = '68133f2d617718c8ea964e3cebb6abcdbe98671aa5c630d81f0ea2daa9eed24a'        as controller_moved_to_frozen_linux,

  -- The getter was replaced; its new prosrc must equal the generator's printed prosrc_sha256_after.
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.effective_execution_binding()'::regprocedure)      as getter_prosrc_now,
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.effective_execution_binding()'::regprocedure)
    <> 'c721b056a771a3a019d1f0cee862408ba56afcbd4d683f45802e8f51c0580d16'        as getter_replaced,

  -- Nothing else. The forward must not spend budget, issue a GA, or touch events.
  (select charged_seconds from clued_control.execution_current) = 9906          as allocation_still_unspent,
  (select charged_evidence_bytes from clued_control.execution_current) = 2201594803 as evidence_bytes_unchanged,
  (select active_ga_id is null from clued_control.execution_current)            as no_active_ga,
  (select pending_budget_sequence is null from clued_control.execution_current)  as no_pending_budget,
  (select count(*) from clued_control.events) = 6                              as events_still_6,
  (select count(*) from clued_control.gate_attempts) = 14                      as gate_attempts_still_14,

  -- CP-01's three bodies must not have moved during the forward.
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.reserve_gate(text,text)'::regprocedure)           as reserve_gate_prosrc,
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.reserve_execution_budget(text,text)'::regprocedure) as reserve_budget_prosrc,
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.append_status_manifest(text,text)'::regprocedure)  as append_status_prosrc;

-- Expected after a successful step 14:
--   exec_events_89 t | execution_sequence 89 | event89_operation EXECUTION_BINDING_FORWARD_ACCEPTED
--   series_f_now 16 | forwards_now 20 | controller_moved_to_frozen_linux t | getter_replaced t
--   allocation_still_unspent t | no_active_ga t | no_pending_budget t | events_still_6 t
--   gate_attempts_still_14 t
--   binding_qualification_sha256 = the root6-runtime-v19 qualification's sha256
