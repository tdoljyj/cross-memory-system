-- ========================================================================================
-- STEP 13 PRECONDITIONS. Read-only. Every column must be true / as stated, or step 13 MUST
-- NOT RUN. These reproduce, in advance, each guard inside append_event(jsonb) that can reject
-- this particular request, so that the irreversible call is never the thing that discovers a
-- problem. Measured true at 2026-09-12T23:5xZ.
-- ========================================================================================
-- What this file CANNOT check, and must be confirmed outside it (see the sheet, step 13):
--   * that the Owner merge of the source branch is on main
--   * that the 22 Linux-controller REPOSITORY_SOURCE paths are in the merge tree
--   * that a round-19+ independent review has passed the registration body
--   * that the frozen controller's source-ref ceiling has been resolved (BLOCKER-1)
-- None of those are enforced by append_event. append_event does not validate the body at all.

select
  clock_timestamp()                                                       as observed_at,

  -- append_event:15 accepted_binding_missing
  (select count(*) from clued_control.accepted_binding
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878') = 1             as ab_row_present,

  -- append_event:16 and :22 owner_window_inactive. BOTH must hold, and :22 is re-evaluated
  -- after the current_head row lock, so leave real margin -- do not start at expires_at minus
  -- seconds.
  (select clock_timestamp() >= b.not_before and clock_timestamp() < b.expires_at
     from clued_control.accepted_binding b
    where b.root_id='ctr_414bd3c724264a83894b0c55cf2ab878')               as window_active,
  (select b.expires_at - clock_timestamp() from clued_control.accepted_binding b
    where b.root_id='ctr_414bd3c724264a83894b0c55cf2ab878')               as window_remaining,

  -- append_event:17-18 binding_mismatch. This is the whole reason the registration body had to
  -- be rebuilt after NW-01: the digest is over the accepted_binding ROW as it now stands.
  (select encode(sha256(convert_to(to_jsonb(b)::text,'UTF8')),'hex')
     from clued_control.accepted_binding b
    where b.root_id='ctr_414bd3c724264a83894b0c55cf2ab878')
    = 'ee5d85faebda1878b3c676dfcc13ecd35d896e5f390907bce39e79bda83caba5'  as metadata_binding_matches,

  -- append_event:29 sequence_conflict -- the body carries expected_sequence 5
  (select sequence from clued_control.current_head
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878') = 5             as head_sequence_is_5,

  -- append_event:32 root_revoked
  (select not revoked from clued_control.current_head
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878')                 as root_not_revoked,

  -- append_event:34 generation_predecessor_conflict
  (select generation_id from clued_control.current_head
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878')
    = 'ctrgen_e5df432221344996afc04b5638121d96'                           as predecessor_is_root5,

  -- append_event:36 generation_reuse_or_rollback. If this is FALSE the generation is already
  -- burned; step 13 has effectively already happened or was attempted. STOP and read back.
  not exists (select 1 from clued_control.events
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878'
      and request->>'generation_id'='ctrgen_5e0440a95ac8ee257b9e4236cabd275b'
      and request->>'kind'='GENERATION_REGISTERED')                       as generation_not_yet_used,

  -- append_event:23-25 idempotency. A row already under this key means a previous attempt
  -- reached the insert. DO NOT re-run; go to step13-readback.sql.
  not exists (select 1 from clued_control.events
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878'
      and idempotency_key='register-root6-window11-20260912')             as idempotency_key_free,

  -- Unchanged surroundings. Any false here is drift since preparation: ABORT, do not retry.
  (select count(*) from clued_control.events) = 5                         as events_still_5,
  (select charged_seconds from clued_control.execution_current) = 9906    as allocation_unspent,
  (select sequence from clued_control.execution_current) = 88             as execution_sequence_88,
  (select active_ga_id is null from clued_control.execution_current)      as no_active_ga,
  (select pending_budget_sequence is null from clued_control.execution_current) as no_pending_budget,
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.append_event(jsonb)'::regprocedure)         as append_event_prosrc_now;
