-- ========================================================================================
-- Resolve the (ii) placeholder in CP-01 edits G8/B9. Performs no write of any kind.
-- ========================================================================================
--
-- Round 10 (SuccessorReviewerRound10.md section 8) replaced the already-failing whole-root
-- digest guard with three assertions. Two of them carry values that are known now:
--
--   (i)   the five frozen historical events, byte-for-byte including recorded_at
--         45c6a2cbaf33bb27f6b4c136440d71d767943acfa9772867e219627759ca5bbc
--   (iii) root.events has exactly 6 elements
--
-- The third, (ii), covers every other root key plus the registration event with only
-- recorded_at removed. Its value is determined by two things that are settled before any
-- irreversible step: the accepted_binding row as NW-01 leaves it, and the registration body
-- we author. This query computes it from those, WITHOUT registering anything.
--
-- WHEN TO RUN:  after NW-01 (runbook step 8), before CP-01 (step 9).
-- WHY NOT IN JS: jsonb key order is Postgres's own (shortest key first, then bytewise), not
--                insertion order and not lexicographic. Computing this digest by serialising
--                in JavaScript is exactly the R9-F1 mistake. It must be computed in-database.
--
-- BEFORE RUNNING, fill the two values in the `plan` CTE below. Both are inputs we choose and
-- publish for review; neither is read back from state we produced.
--
-- The query asserts its own preconditions and returns nulls with a stated reason rather than a
-- digest if any of them does not hold, so a value can never be taken from a wrong moment.

with plan(idempotency_key, request) as (values (
  -- (1) the idempotency_key that runbook step 13 will pass to clued_control.append_event
  '__REGISTRATION_IDEMPOTENCY_KEY__',
  -- (2) the exact request jsonb that step 13 will pass. This is the root6 GENERATION_REGISTERED
  --     body produced by work/twentieth-forward/build-root6-registration.mjs, byte for byte.
  $body$__REGISTRATION_REQUEST_JSONB__$body$::jsonb
)),
root as (
  select clued_control.read_root('ctr_414bd3c724264a83894b0c55cf2ab878') as x
),
pre as (
  select
    x,
    -- The state this query is only valid in: NW-01 has run, registration has NOT.
    (x->>'state') = 'STORED_NO_GATE_AUTHORITY'                             as state_ok,
    jsonb_array_length(x->'events') = 5                                    as events_still_five,
    (x->>'sequence')::bigint = 5                                           as sequence_still_five,
    (x->>'generation_id') = 'ctrgen_e5df432221344996afc04b5638121d96'      as still_root5,
    (select expires_at from clued_control.accepted_binding
      where root_id = 'ctr_414bd3c724264a83894b0c55cf2ab878')
      = '2026-09-19T00:00:00Z'::timestamptz                                as nw01_has_run
  from root
),
projected as (
  select
    pre.*,
    -- read_root builds `sequence` from current_head.sequence and `generation_id` from
    -- current_head.generation_id. Registration advances both; nothing else in the non-events
    -- part of root changes, and metadata_binding_sha256 is taken live so it reflects NW-01.
    ((x - 'events') || jsonb_build_object(
        'sequence', 6,
        'generation_id', 'ctrgen_5e0440a95ac8ee257b9e4236cabd275b'))       as root_without_events,
    -- to_jsonb of a clued_control.events row is {root_id, sequence, idempotency_key, request,
    -- recorded_at}; (ii) drops recorded_at, leaving four fields we fully control.
    jsonb_build_object(
        'root_id', 'ctr_414bd3c724264a83894b0c55cf2ab878',
        'sequence', 6,
        'idempotency_key', plan.idempotency_key,
        'request', plan.request)                                           as registration_event
  from pre, plan
)
select
  state_ok and events_still_five and sequence_still_five and still_root5 and nw01_has_run
                                                                           as preconditions_hold,
  jsonb_build_object('state_ok', state_ok, 'events_still_five', events_still_five,
                     'sequence_still_five', sequence_still_five,
                     'still_root5', still_root5, 'nw01_has_run', nw01_has_run)
                                                                           as preconditions,
  -- (i), recomputed here so all three values in G8/B9 come out of one run.
  encode(sha256(convert_to(
    (select jsonb_agg(e order by (e->>'sequence')::bigint)
     from jsonb_array_elements(x->'events') e
     where (e->>'sequence')::bigint <= 5)::text, 'UTF8')), 'hex')          as frozen_prefix_digest,
  '45c6a2cbaf33bb27f6b4c136440d71d767943acfa9772867e219627759ca5bbc'       as frozen_prefix_expected,
  -- (ii), the value that replaces __PROJECTED_ROOT6_ROOT_DIGEST_PENDING__.
  case when state_ok and events_still_five and sequence_still_five and still_root5 and nw01_has_run
    then encode(sha256(convert_to(
           (root_without_events || jsonb_build_object('registration_event', registration_event))::text,
           'UTF8')), 'hex')
    else null end                                                          as projected_root_digest,
  -- Shown so a reviewer can read exactly what was hashed rather than trusting the digest.
  (root_without_events || jsonb_build_object('registration_event', registration_event))::text
                                                                           as hashed_preimage
from projected;

-- After this returns:
--   1. frozen_prefix_digest must equal frozen_prefix_expected. If not, the five historical
--      events changed, which nothing is allowed to do; stop.
--   2. Publish hashed_preimage and projected_root_digest for independent review BEFORE the
--      CP-01 transaction. Round 10 R10-C9 requires the expected values to be auditable in
--      advance; that requirement is the whole reason option (c) was rejected.
--   3. Put projected_root_digest into cp01-substitutions.json in place of
--      __PROJECTED_ROOT6_ROOT_DIGEST_PENDING__, regenerate, then run cp01-derive.sql to pin
--      the three post-image digests.
--   4. Never re-read this value after runbook step 13. R10-C9:
--      expected_values_must_not_be_read_from_the_database_after_runbook_step_13.
