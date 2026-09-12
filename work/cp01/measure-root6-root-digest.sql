-- ========================================================================================
-- Resolve the (ii) placeholder in CP-01 edits G8/B9 BY MEASUREMENT. Performs no write.
-- ========================================================================================
--
-- This replaces derive-projected-root-digest.sql, which computed the same value as a
-- PROJECTION before root6 was registered. The Owner amended the approval's sequencing clause
-- (OwnerOrderingAmendment.json) so that CP-01 is applied AFTER registration, and that turns
-- the projection into a measurement: the registration event is already in the store, so the
-- value the guard will evaluate can simply be read rather than predicted.
--
-- WHY THAT IS BETTER, precisely: under the old order the pinned value was correct only if the
-- body actually appended matched the body the projection was built from, byte for byte. That
-- obligation was carried by a written requirement, i.e. by discipline. Here the value comes
-- from the appended event itself, so the projection-does-not-equal-actual failure class does
-- not exist. It is not mitigated; there is nothing left to mitigate.
--
-- WHEN TO RUN: after runbook step 13 (root6 registered), before CP-01 is finalised.
--
-- WHAT IT EVALUATES: exactly the expression CP-01's guard will evaluate at runtime. The guard
-- is inside reserve_gate and reserve_execution_budget, whose local `series_view` is assigned
-- `clued_control.read_execution()` -- measured from pg_proc, not assumed. So this query calls
-- read_execution() too, rather than read_root(), even though the two were measured to be
-- byte-identical at 2026-09-12T10:0xZ. Using the guard's own expression means the question of
-- whether they can ever diverge does not have to be answered.
--
-- WHY NOT IN JS: jsonb key order is Postgres's own (shortest key first, then bytewise), not
-- insertion order and not lexicographic. Serialising this in JavaScript is exactly the R9-F1
-- mistake. It must be computed in-database.
--
-- The query asserts its own preconditions and returns nulls with a stated reason rather than a
-- digest if any of them does not hold, so a value can never be taken from a wrong moment.

with v as (
  select clued_control.read_execution() as x
),
root as (
  select x, x->'root' as r from v
),
pre as (
  select
    r,
    -- The state this query is only valid in: registration HAS happened.
    jsonb_array_length(r->'events') = 6                                          as events_now_six,
    (r->>'generation_id') = 'ctrgen_5e0440a95ac8ee257b9e4236cabd275b'            as head_is_root6,
    (r->>'root_set_id')   = 'ctr_414bd3c724264a83894b0c55cf2ab878'               as root_set_expected,
    (r->>'sequence')::bigint = 6                                                 as sequence_now_six,
    exists (select 1 from jsonb_array_elements(r->'events') e
             where (e->>'sequence')::bigint = 6
               and e->'request'->>'kind' = 'GENERATION_REGISTERED'
               and e->'request'->'body'->>'control_trust_root_generation'
                     = 'ctrgen_5e0440a95ac8ee257b9e4236cabd275b')                as event_six_is_the_registration,
    -- The five historical events must not have moved. This is guard (i)'s own value, so if it
    -- has changed the whole edit is wrong, not just this placeholder.
    encode(sha256(convert_to(
      (select jsonb_agg(e order by (e->>'sequence')::bigint)
         from jsonb_array_elements(r->'events') e
        where (e->>'sequence')::bigint <= 5)::text,'UTF8')),'hex')
      = '45c6a2cbaf33bb27f6b4c136440d71d767943acfa9772867e219627759ca5bbc'       as five_frozen_events_unchanged
  from root
),
ok as (
  select *, (events_now_six and head_is_root6 and root_set_expected and sequence_now_six
             and event_six_is_the_registration and five_frozen_events_unchanged) as all_ok
  from pre
)
select
  all_ok                                                                          as safe_to_pin,
  case when not all_ok then
    concat_ws('; ',
      case when not events_now_six                 then 'root.events is not 6 -- registration has not happened, or something else was appended' end,
      case when not head_is_root6                  then 'root generation is not root6' end,
      case when not root_set_expected              then 'unexpected root_set_id' end,
      case when not sequence_now_six               then 'root sequence is not 6' end,
      case when not event_six_is_the_registration  then 'event 6 is not the root6 GENERATION_REGISTERED body' end,
      case when not five_frozen_events_unchanged   then 'the five historical events no longer digest to 45c6a2cb...' end)
  end                                                                             as refused_because,

  -- (ii) THE VALUE TO PIN into CP-01 edits G8 and B9, when safe_to_pin is true.
  case when all_ok then
    encode(sha256(convert_to(
      ((r - 'events')
       || jsonb_build_object('registration_event',
            (select e - 'recorded_at' from jsonb_array_elements(r->'events') e
              where (e->>'sequence')::bigint = 6)))::text,'UTF8')),'hex')
  end                                                                             as pin_this_value,

  -- Reported for the record, not for pinning.
  encode(sha256(convert_to(r::text,'UTF8')),'hex')                                as whole_root_digest,
  jsonb_array_length(r->'events')                                                 as events_len,
  r->>'generation_id'                                                             as generation_id,
  r->>'sequence'                                                                  as root_sequence,
  r->>'metadata_binding_sha256'                                                   as metadata_binding_sha256,
  clock_timestamp()                                                               as measured_at
from ok;
