-- ========================================================================================
-- STEP 14 INPUT: the three post-CP-01 prosrc digests. Read-only.
-- ========================================================================================
-- These are the only genuinely unknowable values in the twentieth forward's input. Run this
-- AFTER CP-01 has committed and been read back, and paste the three columns into
-- input.json .control_plane as:
--     reserve_gate_prosrc_sha256              <- reserve_gate_prosrc
--     reserve_execution_budget_prosrc_sha256  <- reserve_execution_budget_prosrc
--     append_status_manifest_prosrc_sha256    <- append_status_manifest_prosrc
--
-- The other two control_plane fields are NOT unknowable and must not be treated as such:
--     accepted_binding_expires_at = 2026-09-13T07:05:16Z   (NW-01 already applied it; measured
--                                   live; the column below re-reads it so it is not transcribed)
--     guard_exception_name        = an implementer-chosen label matching ^[a-z0-9_]{1,80}$.
--                                   The nineteenth used accepted_root5_window9_capacity_repair_required.
--                                   CP-01 does not dictate it. It is the name raised when the two
--                                   execution_current CHECK definitions do not match.
--
-- Take the values from HERE, not from cp01-derive.sql's predicted post-image. The predicted
-- values are the thing CP-01's read-back verifies; using them as input would make the forward
-- assert its own prediction instead of the live state.

select
  clock_timestamp()                                                            as observed_at,
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.reserve_gate(text,text)'::regprocedure)           as reserve_gate_prosrc,
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.reserve_execution_budget(text,text)'::regprocedure) as reserve_execution_budget_prosrc,
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.append_status_manifest(text,text)'::regprocedure) as append_status_manifest_prosrc,
  to_char((select expires_at from clued_control.accepted_binding
            where root_id='ctr_414bd3c724264a83894b0c55cf2ab878') at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS"Z"')                                        as accepted_binding_expires_at,

  -- Sanity: all three MUST differ from their pre-CP-01 values, or CP-01 did not take effect and
  -- the forward would pin the old bodies.
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.reserve_gate(text,text)'::regprocedure)
    <> 'a011292416693ef7e44221868669937261c33848a3ff10882d0f4abd97c9ef2e'       as reserve_gate_moved,
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.reserve_execution_budget(text,text)'::regprocedure)
    <> 'df6087f9d19d99f023a9c789f0c9b34140e92bb82fc00a5dde1d69d9b1aa7d41'       as reserve_budget_moved,
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.append_status_manifest(text,text)'::regprocedure)
    <> '94a444b9174251e8f655ea3a04e160898464caf1f94977cbce1590aff726c615'       as append_status_moved;
