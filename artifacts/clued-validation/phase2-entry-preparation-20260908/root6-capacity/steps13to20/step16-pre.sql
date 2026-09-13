-- ========================================================================================
-- STEP 16 PRECONDITIONS (budget reservation). Read-only. THE MOST IMPORTANT FILE IN THIS SET.
-- Expect every boolean true. If any is false the reservation MUST NOT run.
-- ========================================================================================
-- The command is:  select clued_control.reserve_execution_budget(<raw>, <sha>);
-- <raw> is produced by the controller on the NEXT_ALLOCATION path. It is NOT hand-written JSON.
-- Its expires_at must be EXACTLY 2026-09-13T07:05:16Z -- reserve_execution_budget:125 raises
-- series_exact_new_budget_expiry_required on any other value, and :135 additionally forbids it
-- being later than accepted_binding.expires_at. Those two together leave exactly one legal value.
--
-- ZERO MARGIN. reserve_execution_budget:138 has `c.charged_seconds+600>10506`. With
-- charged_seconds at 9906, 9906+600 = 10506, which is not greater than 10506 and therefore
-- passes -- by nothing. There is no second allocation.
--
-- REAL DEADLINE. reserve_execution_budget:117 is
--     clock_timestamp()+interval '600 seconds' >= <window literal>
-- CP-01's B2/B7/B8 move that literal to this window, so the real cutoff is
--     2026-09-13T07:05:16Z minus 600 seconds = 2026-09-13T06:55:16Z
-- The column seconds_until_reservation_cutoff below is that margin. Do not run this step with a
-- small margin: steps 17 to 20 all have to fit after it, inside the same window.
--
-- WHAT MUST BE TRUE OUTSIDE SQL BEFORE THIS RUNS -- the reservation is the point of no return
-- for the single 600-second allocation, and the 600-second run itself cannot be rehearsed. So
-- everything that CAN be established in advance must be, and none of it is checkable here:
--   1. all four pinned host binaries present with exact bytes, INCLUDING /usr/local/bin/gh
--      (f687dc937534f8aa77ff9d2362163c645b5a8cc78297ef1a642c74c56aa48618) -- trusted-github.mjs
--      re-hashes it before every API call, so without it the controller cannot make one call
--   2. dockerd reachable and a throwaway container demonstrably creatable and removable
--   3. the host manifest verification pass recorded (verify-manifest-against-host.mjs)
--   4. verifySourcePublication demonstrated to run to completion -- this is the one that fails
--      today on the 133-vs-142 source-ref ceiling and on the 22 controller paths not yet on main
--   5. the GA constructed offline and checked field-by-field against context.mjs:70 and :76
--   6. step 19's twenty formal observation commands settled
-- Item 7, the 600-second run, cannot be proven in advance. That is the residual risk the other
-- six exist to isolate. Reserving without them puts avoidable failures on the one allocation.

select
  clock_timestamp()                                                            as observed_at,

  -- The single allocation is untouched and the arithmetic still closes exactly.
  (select charged_seconds from clued_control.execution_current) = 9906         as allocation_unspent,
  (select charged_seconds + 600 <= 10506 from clued_control.execution_current) as plus_600_within_ceiling,
  (select 10506 - (charged_seconds + 600) from clued_control.execution_current) as headroom_after_use,
  (select charged_evidence_bytes from clued_control.execution_current) = 2201594803 as evidence_bytes_unchanged,
  (select pending_budget_sequence is null from clued_control.execution_current) as no_pending_budget,
  (select active_ga_id is null from clued_control.execution_current)           as no_active_ga,

  -- The real deadline, with margin. NEGATIVE OR SMALL MEANS DO NOT RUN.
  (select extract(epoch from (expires_at - interval '600 seconds' - clock_timestamp()))
     from clued_control.accepted_binding
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878')                      as seconds_until_reservation_cutoff,
  (select clock_timestamp() + interval '600 seconds' < expires_at
     from clued_control.accepted_binding
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878')                      as cutoff_not_yet_passed,
  to_char((select expires_at from clued_control.accepted_binding
            where root_id='ctr_414bd3c724264a83894b0c55cf2ab878') at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS"Z"')                                        as required_new_budget_expires_at,

  -- Steps 13, 14 and CP-01 all landed, and the forward cap was raised BEFORE the forward used it.
  (select generation_id from clued_control.current_head
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878')
    = 'ctrgen_5e0440a95ac8ee257b9e4236cabd275b'                                as head_is_root6,
  (select sequence from clued_control.execution_current) = 89                  as execution_sequence_89,
  (select count(*) from clued_control.execution_events
     where sequence>44 and request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED') = 16 as series_f_16,
  (select count(*) from pg_proc p, unnest(string_to_array(p.prosrc,E'\n')) u(t)
     where p.oid='clued_control.reserve_execution_budget(text,text)'::regprocedure
       and t like '%series_f>16%') = 1                                          as cap_raised_in_budget_fn,
  (select count(*) from pg_proc p, unnest(string_to_array(p.prosrc,E'\n')) u(t)
     where p.oid='clued_control.reserve_execution_budget(text,text)'::regprocedure
       and t like '%ctrgen_5e0440a95ac8ee257b9e4236cabd275b%') >= 1             as budget_fn_pins_root6,
  (select count(*) from pg_proc p, unnest(string_to_array(p.prosrc,E'\n')) u(t)
     where p.oid='clued_control.reserve_execution_budget(text,text)'::regprocedure
       and t like '%2026-09-12T13:14:51Z%') = 0                                 as superseded_window_gone,

  -- The binding is the one the GA will have to match.
  (select x.controller_sha256 from clued_control.effective_execution_binding() x)
    = '68133f2d617718c8ea964e3cebb6abcdbe98671aa5c630d81f0ea2daa9eed24a'       as binding_is_frozen_linux,
  (select x.qualification_sha256 from clued_control.effective_execution_binding() x) as binding_qualification_sha256,
  (select x.runtime_acceptance_sha256 from clued_control.effective_execution_binding() x) as binding_runtime_acceptance_sha256,

  -- Nobody touched the three control-plane bodies between CP-01 and now. Compare all three
  -- against the values cp01-readback.sql recorded; equality is the whole point of this row.
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.reserve_execution_budget(text,text)'::regprocedure) as reserve_budget_prosrc_now,
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.reserve_gate(text,text)'::regprocedure)            as reserve_gate_prosrc_now,
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.append_status_manifest(text,text)'::regprocedure)  as append_status_prosrc_now;
