-- ========================================================================================
-- STEP 14 PRECONDITIONS (the twentieth binding forward). Read-only. Expect every boolean true.
-- Run immediately before the REAL generation, and separately before the --dry-run rehearsal.
-- ========================================================================================
-- Not checkable here, and required (see the sheet, section 5):
--   * build-twentieth-input.mjs has been given a way to accept control_plane outside
--     --rehearsal. As committed, control_plane is null unless --rehearsal is passed and the
--     next assert then fails, so a real input cannot be produced at all.
--   * build-twentieth-input.mjs also replaces source_materials.qualification and
--     .runtime_acceptance with the root6-runtime-v19 documents. As committed it clones the
--     nineteenth's materials and replaces controller_manifest ONLY, which yields a binding
--     carrying the root6 controller with the root5 v16 qualification -- rejected by
--     context.mjs:76 and reserve_gate:126.
--   * the --dry-run rehearsal has been generated, executed and rolled back.

select
  clock_timestamp()                                                            as observed_at,

  -- Step 13 landed.
  (select generation_id from clued_control.current_head
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878')
    = 'ctrgen_5e0440a95ac8ee257b9e4236cabd275b'                                as head_is_root6,
  (select count(*) from clued_control.events) = 6                              as events_now_6,

  -- CP-01 landed: all three moved off their pre-image values. THIS ORDER MATTERS. If CP-01 has
  -- not run, series_f>15 is still live and the forward -- which takes series_f to 16 -- would
  -- permanently poison steps 16 and 17. The forward itself does not check this.
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.reserve_gate(text,text)'::regprocedure)
    <> 'a011292416693ef7e44221868669937261c33848a3ff10882d0f4abd97c9ef2e'       as cp01_reserve_gate_moved,
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.reserve_execution_budget(text,text)'::regprocedure)
    <> 'df6087f9d19d99f023a9c789f0c9b34140e92bb82fc00a5dde1d69d9b1aa7d41'       as cp01_reserve_budget_moved,
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.append_status_manifest(text,text)'::regprocedure)
    <> '94a444b9174251e8f655ea3a04e160898464caf1f94977cbce1590aff726c615'       as cp01_append_status_moved,
  (select count(*) from pg_proc p, unnest(string_to_array(p.prosrc,E'\n')) u(t)
     where p.oid in ('clued_control.reserve_gate(text,text)'::regprocedure,
                     'clued_control.reserve_execution_budget(text,text)'::regprocedure)
       and t like '%series_f>16%') = 2                                          as forward_cap_now_16,

  -- The getter is still the nineteenth forward's output. twentieth-forward-compact.mjs:138
  -- asserts the normalised live getter digests to f97d8585; its prosrc is c721b056.
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.effective_execution_binding()'::regprocedure)
    = 'c721b056a771a3a019d1f0cee862408ba56afcbd4d683f45802e8f51c0580d16'        as getter_is_nineteenth_output,

  -- The forward has not already happened, and the allocation is untouched.
  (select sequence from clued_control.execution_current) = 88                   as execution_sequence_88,
  (select count(*) from clued_control.execution_events) = 88                    as exec_events_88,
  (select count(*) from clued_control.execution_events
     where request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED') = 19     as existing_forwards_19,
  (select count(*) from clued_control.execution_events
     where sequence>44 and request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED') = 15 as series_f_15,
  (select charged_seconds from clued_control.execution_current) = 9906          as allocation_unspent,
  (select charged_evidence_bytes from clued_control.execution_current) = 2201594803 as evidence_bytes_unchanged,
  (select active_ga_id is null from clued_control.execution_current)            as no_active_ga,
  (select pending_budget_sequence is null from clued_control.execution_current)  as no_pending_budget,

  -- The forward has not yet moved the controller.
  (select x.controller_sha256 from clued_control.effective_execution_binding() x)
    = 'ac7bdd53b7fe5705ee70f4fbb08ce6a5889ccf6d6574a3575e51f16bb09c2daa'        as binding_still_root5_controller,

  -- The two CHECK definitions the forward's own guard compares against template literals that
  -- are NOT in the generator's replacement rules, so they must still match byte for byte or the
  -- transaction raises guard_exception_name and rolls back. Measured true before CP-01; re-check
  -- here because CP-01 runs in between.
  (select pg_get_constraintdef(oid,true) from pg_constraint
     where conrelid='clued_control.execution_current'::regclass
       and conname='execution_current_charged_seconds_check')
    = 'CHECK (charged_seconds >= 1410 AND charged_seconds <= 10506)'            as check_seconds_matches_template,
  (select pg_get_constraintdef(oid,true) from pg_constraint
     where conrelid='clued_control.execution_current'::regclass
       and conname='execution_current_charged_evidence_bytes_check')
    = 'CHECK (charged_evidence_bytes >= 19264968 AND charged_evidence_bytes <= ''2335812531''::bigint)'
                                                                               as check_evbytes_matches_template,

  -- Environment guards the forward's own opening assertions repeat.
  current_database() = 'postgres'                                              as db_is_postgres,
  (select project_ref from clued_control.accepted_binding
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878') = 'uscrdifznmlvczcekqpw' as project_ref_ok,
  (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='clued_control' and c.relkind in ('r','p')) = 8            as still_eight_tables,
  current_setting('TimeZone') = 'UTC'                                          as server_tz_utc,
  (select expires_at from clued_control.accepted_binding) = '2026-09-13T07:05:16Z'::timestamptz as window_is_this_one,
  (select expires_at - clock_timestamp() from clued_control.accepted_binding)   as window_remaining;
