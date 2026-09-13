-- ========================================================================================
-- CP-01 READ-BACK. Read-only. Run IMMEDIATELY after CP-01 commits -- and also if it was cut
-- off, before deciding anything. The three post-image digests this returns are step 14's
-- control_plane input, so this file is not only a verification, it is the source of values.
-- ========================================================================================
-- Record all three digests verbatim. Step 16's precondition re-reads them to prove nobody
-- touched these functions between CP-01 and the reservation.
--
-- INTERRUPTED CP-01 -- do NOT re-run it blindly. CP-01 is one transaction of CREATE OR REPLACE
-- statements, so it is all-or-nothing at COMMIT:
--   all four digests at their PRE-image values  -> nothing committed; CP-01 may be re-run
--   all three targets at their POST-image values and the getter unchanged -> it committed
--   any other combination -> STOP. That combination should be impossible inside one
--   transaction; its appearance means an assumption about atomicity is wrong. Investigate
--   before touching anything.

select
  clock_timestamp()                                                          as observed_at,

  -- The three CP-01 changed. Compare against the values cp01-derive.sql predicted, but take
  -- THESE as the inputs to step 14 -- the predicted values are what is being verified, so they
  -- cannot also serve as the input.
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.reserve_gate(text,text)'::regprocedure)         as post_reserve_gate_prosrc,
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.reserve_execution_budget(text,text)'::regprocedure) as post_reserve_budget_prosrc,
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.append_status_manifest(text,text)'::regprocedure) as post_append_status_prosrc,

  -- Must be UNCHANGED. CP-01 does not touch the getter; step 14 does.
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.effective_execution_binding()'::regprocedure)
    = 'c721b056a771a3a019d1f0cee862408ba56afcbd4d683f45802e8f51c0580d16'      as getter_still_untouched,

  -- Each of the 21 edits, checked by its effect rather than by trusting the builder.
  (select count(*) from pg_proc p, unnest(string_to_array(p.prosrc,E'\n')) u(t)
    where p.oid='clued_control.reserve_gate(text,text)'::regprocedure
      and t like '%series_f>16%') = 1                                         as g3_applied,
  (select count(*) from pg_proc p, unnest(string_to_array(p.prosrc,E'\n')) u(t)
    where p.oid='clued_control.reserve_execution_budget(text,text)'::regprocedure
      and t like '%series_f>16%') = 1                                         as b3_applied,
  (select count(*) from pg_proc p, unnest(string_to_array(p.prosrc,E'\n')) u(t)
    where p.oid='clued_control.reserve_gate(text,text)'::regprocedure
      and t like '%series_f>15%') = 0                                         as g3_old_gone,
  (select count(*) from pg_proc p, unnest(string_to_array(p.prosrc,E'\n')) u(t)
    where p.oid='clued_control.reserve_execution_budget(text,text)'::regprocedure
      and t like '%series_f>15%') = 0                                         as b3_old_gone,

  -- G1/B1/A3: the live-generation literal moved from root5 to root6 in all three functions.
  (select count(*) from pg_proc p, unnest(string_to_array(p.prosrc,E'\n')) u(t)
     where p.oid in ('clued_control.reserve_gate(text,text)'::regprocedure,
                     'clued_control.reserve_execution_budget(text,text)'::regprocedure,
                     'clued_control.append_status_manifest(text,text)'::regprocedure)
       and t like '%ctrgen_5e0440a95ac8ee257b9e4236cabd275b%') >= 3           as root6_literal_present,

  -- A4: the Status24 deadlock literal. 2026-09-11T10:21:05Z must be gone from
  -- append_status_manifest, and the window must be this one. Without this, step 15 is
  -- impossible no matter what manifest is offered.
  (select count(*) from pg_proc p, unnest(string_to_array(p.prosrc,E'\n')) u(t)
    where p.oid='clued_control.append_status_manifest(text,text)'::regprocedure
      and t like '%2026-09-11T10:21:05Z%') = 0                                as a4_old_literal_gone,
  (select count(*) from pg_proc p, unnest(string_to_array(p.prosrc,E'\n')) u(t)
    where p.oid='clued_control.append_status_manifest(text,text)'::regprocedure
      and t like '%2026-09-13T07:05:16Z%') >= 1                               as a4_new_literal_present,

  -- A1/A2: the root6 status-manifest schema digest. A2 must run after A1.
  (select count(*) from pg_proc p, unnest(string_to_array(p.prosrc,E'\n')) u(t)
    where p.oid='clued_control.append_status_manifest(text,text)'::regprocedure
      and t like '%510f3b90cdb026c8c4d44ffac2647502ff8003cdd972850dbe042edbd6c310ef%') = 2
                                                                             as a1_a2_applied,

  -- G2/B2/B7/B8/G7: the superseded window literal must be gone from both reserve functions.
  (select count(*) from pg_proc p, unnest(string_to_array(p.prosrc,E'\n')) u(t)
     where p.oid in ('clued_control.reserve_gate(text,text)'::regprocedure,
                     'clued_control.reserve_execution_budget(text,text)'::regprocedure)
       and t like '%2026-09-12T13:14:51Z%') = 0                               as old_window_literal_gone,

  -- Nothing else moved. CP-01 replaces function bodies only.
  (select count(*) from clued_control.events) = 6                             as events_still_6,
  (select charged_seconds from clued_control.execution_current) = 9906        as allocation_still_unspent,
  (select sequence from clued_control.execution_current) = 88                 as execution_sequence_88,
  (select count(*) from clued_control.execution_events) = 88                  as exec_events_88,
  (select count(*) from clued_control.execution_events
    where sequence>44 and request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED') = 15 as series_f_still_15,
  (select active_ga_id is null from clued_control.execution_current)          as no_active_ga,
  (select pending_budget_sequence is null from clued_control.execution_current) as no_pending_budget,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='clued_control') = 15                                    as still_fifteen_functions;
