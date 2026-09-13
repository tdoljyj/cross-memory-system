-- ========================================================================================
-- CP-01 PRECONDITIONS. Read-only. CP-01 sits AFTER step 13 and BEFORE step 14
-- (OwnerOrderingAmendment.json new_order items 4 and 5). Expect every column true.
-- ========================================================================================
-- CP-01 must not run while cp01-apply.candidate.sql still carries
-- __MEASURED_ROOT6_ROOT_DIGEST_PENDING__ (4 occurrences at preparation time) or while
-- cp01-substitutions.json has postimage_prosrc_sha256 = null. Those are resolved by step 13a
-- (work/cp01/measure-root6-root-digest.sql) plus a read-only run of work/cp01/cp01-derive.sql,
-- and then cp01-apply.candidate.sql must be REGENERATED, not hand-edited.
--
-- ARCHIVE work/cp01/cp01-derive.sql's output BEFORE running CP-01. After COMMIT the previous
-- function bodies are recoverable only from that archived pre-image.

select
  clock_timestamp()                                                          as observed_at,

  -- Step 13 has happened. CP-01's G1/B1/A3 rewrite the root5 generation literal to root6, and
  -- G8/B9 pin a digest measured from the registration event, so registration must precede this.
  (select generation_id from clued_control.current_head
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878')
    = 'ctrgen_5e0440a95ac8ee257b9e4236cabd275b'                              as head_is_root6,
  (select count(*) from clued_control.events) = 6                            as events_now_6,

  -- The four pre-image prosrc digests CP-01's opening assertions pin. All four must still be
  -- at their pre-CP-01 values, INCLUDING effective_execution_binding(), which CP-01 must NOT
  -- change -- it is asserted precisely so that an unintended change aborts the transaction.
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.reserve_gate(text,text)'::regprocedure)
    = 'a011292416693ef7e44221868669937261c33848a3ff10882d0f4abd97c9ef2e'      as pre_reserve_gate,
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.reserve_execution_budget(text,text)'::regprocedure)
    = 'df6087f9d19d99f023a9c789f0c9b34140e92bb82fc00a5dde1d69d9b1aa7d41'      as pre_reserve_budget,
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.append_status_manifest(text,text)'::regprocedure)
    = '94a444b9174251e8f655ea3a04e160898464caf1f94977cbce1590aff726c615'      as pre_append_status,
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.effective_execution_binding()'::regprocedure)
    = 'c721b056a771a3a019d1f0cee862408ba56afcbd4d683f45802e8f51c0580d16'      as getter_untouched,

  -- The three anchor texts CP-01's G3/B3 and A4 replace must still be present exactly once, at
  -- the lines the substitution table names. If a line moved, the table is stale: STOP and
  -- re-derive it rather than letting the builder fold against a shifted anchor.
  (select count(*) from pg_proc p, unnest(string_to_array(p.prosrc,E'\n')) with ordinality u(t,l)
    where p.oid='clued_control.reserve_gate(text,text)'::regprocedure
      and l=48 and t like '%if series_n>9 or series_f>15 or%') = 1            as g3_anchor_line_48,
  (select count(*) from pg_proc p, unnest(string_to_array(p.prosrc,E'\n')) with ordinality u(t,l)
    where p.oid='clued_control.reserve_execution_budget(text,text)'::regprocedure
      and l=53 and t like '%if series_n>9 or series_f>15 or%') = 1            as b3_anchor_line_53,
  (select count(*) from pg_proc p, unnest(string_to_array(p.prosrc,E'\n')) with ordinality u(t,l)
    where p.oid='clued_control.append_status_manifest(text,text)'::regprocedure
      and l=29 and t like '%2026-09-11T10:21:05Z%') = 1                       as a4_anchor_line_29,

  -- CP-01 has no root-state precondition beyond the above, but nothing else may have moved.
  (select charged_seconds from clued_control.execution_current) = 9906        as allocation_unspent,
  (select sequence from clued_control.execution_current) = 88                 as execution_sequence_88,
  (select count(*) from clued_control.execution_events) = 88                  as exec_events_88,
  (select active_ga_id is null from clued_control.execution_current)          as no_active_ga,
  (select pending_budget_sequence is null from clued_control.execution_current) as no_pending_budget,
  (select expires_at from clued_control.accepted_binding) = '2026-09-13T07:05:16Z'::timestamptz
                                                                             as window_is_this_one,
  (select expires_at - clock_timestamp() from clued_control.accepted_binding) as window_remaining,
  (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='clued_control' and c.relkind in ('r','p')) = 8          as still_eight_tables;
