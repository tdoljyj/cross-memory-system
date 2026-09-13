-- ========================================================================================
-- STEP 15 PRECONDITIONS (Status24 append). Read-only. Expect every boolean true.
-- ========================================================================================
-- The command is:  select clued_control.append_status_manifest(<raw>, <sha>);
-- <raw> DOES NOT EXIST in this branch. It needs the Status24 signing subject (deliverable F)
-- with its five pending pins filled and re-checked, pinned to the post-CP-01 schema digest and
-- this window. That is why no step15-exec.sql is provided -- see the sheet, section 6.
--
-- Step 15 was IMPOSSIBLE before CP-01, and this file is where that is verified rather than
-- assumed: append_status_manifest:29 required expires_at to equal 2026-09-11T10:21:05Z, a moment
-- already past, while another check required it to be in the future. CP-01's A4 moves that
-- literal. If a4_deadlock_resolved is false, no manifest can be appended no matter what it says.

select
  clock_timestamp()                                                            as observed_at,

  -- CP-01's A3/A4/A1/A2 are in effect.
  (select count(*) from pg_proc p, unnest(string_to_array(p.prosrc,E'\n')) u(t)
    where p.oid='clued_control.append_status_manifest(text,text)'::regprocedure
      and t like '%2026-09-11T10:21:05Z%') = 0                                  as a4_deadlock_resolved,
  (select count(*) from pg_proc p, unnest(string_to_array(p.prosrc,E'\n')) u(t)
    where p.oid='clued_control.append_status_manifest(text,text)'::regprocedure
      and t like '%2026-09-13T07:05:16Z%') >= 1                                 as a4_this_window_pinned,
  (select count(*) from pg_proc p, unnest(string_to_array(p.prosrc,E'\n')) u(t)
    where p.oid='clued_control.append_status_manifest(text,text)'::regprocedure
      and t like '%ctrgen_5e0440a95ac8ee257b9e4236cabd275b%') >= 1              as a3_root6_pinned,
  (select count(*) from pg_proc p, unnest(string_to_array(p.prosrc,E'\n')) u(t)
    where p.oid='clued_control.append_status_manifest(text,text)'::regprocedure
      and t like '%510f3b90cdb026c8c4d44ffac2647502ff8003cdd972850dbe042edbd6c310ef%') = 2
                                                                               as a1_a2_schema_digest_allowed,

  -- Steps 13 and 14 landed; the allocation is still unspent.
  (select generation_id from clued_control.current_head
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878')
    = 'ctrgen_5e0440a95ac8ee257b9e4236cabd275b'                                as head_is_root6,
  (select sequence from clued_control.execution_current) = 89                  as execution_sequence_89,
  (select x.controller_sha256 from clued_control.effective_execution_binding() x)
    = '68133f2d617718c8ea964e3cebb6abcdbe98671aa5c630d81f0ea2daa9eed24a'       as binding_is_frozen_linux,
  (select charged_seconds from clued_control.execution_current) = 9906         as allocation_unspent,
  (select active_ga_id is null from clued_control.execution_current)           as no_active_ga,

  -- The window must still be open; the manifest's own expires_at must equal it exactly.
  (select expires_at from clued_control.accepted_binding) = '2026-09-13T07:05:16Z'::timestamptz as window_is_this_one,
  (select expires_at > clock_timestamp() from clued_control.accepted_binding)   as window_still_open,
  (select expires_at - clock_timestamp() from clued_control.accepted_binding)   as window_remaining,

  -- Baseline for the read-back's delta.
  (select count(*) from clued_control.control_objects)                         as control_objects_before;
