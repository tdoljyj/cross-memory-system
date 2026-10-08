-- BUG-20261008-002 (Clued Task 5c18ed64): a binary job's staged object is kept
-- until its job is settled.
--
-- storage_staging_deletable_v1 (20260930180000) let the staging sweep delete a
-- consumed object as soon as its job had an intent. The intent is created when
-- the executor starts, but a binary create streams the staged object to Drive
-- only after it has recorded its provider attempt. When the minute sweep ran in
-- between, the upload lost its source: in production 2 of 5 binary creates
-- failed this way (2026-10-07 09:06, object deleted 2 s before the attempt;
-- 2026-10-08 03:11, job a1f3c2d4-...-20261008b001, deleted 0.3 s after it), and
-- the second stayed started and fenced its storage root.
--
-- A consumed object (and, after 7 days, its row) may now go only once the job
-- is settled: settled before any reservation (dispatch_outcome), or its intent
-- committed or cancelled. While the intent is prepared, started or uncertain
-- the object stays, so the effect can stream it and scheduled recovery never
-- races its deletion. rejected and expired rows are unchanged.

create or replace function clued_private.storage_staging_deletable_v1(s clued_private.storage_staging_v1)
returns boolean language sql stable security definer set search_path='' as $$
  select s.object_deleted_at is null and s.bytes_received and (s.state in ('rejected','expired') or (s.state='consumed' and exists(
    select 1 from clued_private.storage_jobs_v1 j where j.owner_id=s.owner_id and j.job_id=s.job_id
      and (j.dispatch_outcome is not null or exists(select 1 from clued_private.resource_center_mutations_v1 m
        where m.id=j.intent_id and m.user_id=j.owner_id and m.state in ('committed','cancelled'))))))
$$;

create or replace function clued_private.storage_staging_purgeable_v1(s clued_private.storage_staging_v1)
returns boolean language sql stable security definer set search_path='' as $$
  select s.created_at<=clock_timestamp()-interval '7 days' and (s.object_deleted_at is not null or not s.bytes_received)
    and (s.state in ('rejected','expired') or (s.state='consumed' and exists(
      select 1 from clued_private.storage_jobs_v1 j where j.owner_id=s.owner_id and j.job_id=s.job_id
        and (j.dispatch_outcome is not null or exists(select 1 from clued_private.resource_center_mutations_v1 m
          where m.id=j.intent_id and m.user_id=j.owner_id and m.state in ('committed','cancelled'))))))
$$;

revoke all on function clued_private.storage_staging_deletable_v1(clued_private.storage_staging_v1),
  clued_private.storage_staging_purgeable_v1(clued_private.storage_staging_v1)
  from public,anon,authenticated,service_role;
