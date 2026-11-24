set local lock_timeout='5s';
-- Context archive, structure step (C1a). Old checkpoints will leave the online database once an archive of them
-- has been verified (the functions and the Worker task come in later files). This file only prepares the
-- structure, so that deleting an old checkpoint takes nothing else with it:
--   * the index of archive batches, kept permanently;
--   * the record of which events a checkpoint absorbed outlives the checkpoint;
--   * a later checkpoint outlives the one before it;
--   * the checkpoint a context currently points to cannot be deleted at all.
-- No row is changed. A lock this file cannot take within five seconds fails it with 55P03 and nothing is changed.

-- Archive index: one row per batch of archived rows of one context. status goes pending (the batch is defined,
-- its object is not yet stored) -> verified (the stored object was read back and its hash matched) -> archived
-- (the member rows are deleted). member_ids names the member rows until then.
create table clued_private.context_archive_batches_v1 (
  batch_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  context_key text not null check (char_length(context_key) between 1 and 160),
  kind text not null check (kind in ('checkpoint')),
  row_count integer not null check (row_count > 0),
  min_version bigint not null check (min_version > 0),
  max_version bigint not null,
  earliest_at timestamptz not null,
  latest_at timestamptz not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  byte_count bigint not null check (byte_count > 0),
  object_key text not null check (char_length(object_key) between 1 and 512),
  status text not null default 'pending' check (status in ('pending', 'verified', 'archived')),
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  archived_at timestamptz,
  member_ids uuid[],
  check (max_version >= min_version),
  check (latest_at >= earliest_at),
  check ((verified_at is not null) = (status in ('verified', 'archived'))),
  check ((archived_at is not null) = (status = 'archived')),
  check ((member_ids is null) = (status = 'archived')),
  check (member_ids is null or cardinality(member_ids) = row_count)
);
comment on table clued_private.context_archive_batches_v1 is
  'Index of context archive batches (format clued.context-archive/1). Kept permanently; member_ids is emptied once the batch is archived.';
alter table clued_private.context_archive_batches_v1 enable row level security;
revoke all on table clued_private.context_archive_batches_v1 from public, anon, authenticated, service_role;

-- A context has at most one unfinished batch of a kind, so a row is never a member of two batches.
create unique index context_archive_batches_v1_unfinished_idx
  on clued_private.context_archive_batches_v1 (user_id, context_key, kind)
  where status in ('pending', 'verified');

-- The constraints below are found in the catalog by table and column, never by a guessed name; anything other
-- than exactly one match stops the file.
do $c1a$
declare
  v_heads constant regclass := 'public.clued_context_heads';
  v_checkpoints constant regclass := 'public.clued_context_checkpoints';
  v_absorptions constant regclass := 'public.clued_checkpoint_event_absorptions';
  v_name text;
begin
  -- Head -> checkpoint: was ON DELETE CASCADE, so deleting the current checkpoint silently deleted the pointer.
  -- Now the default (no action): the database refuses to delete a checkpoint a head points to.
  select c.conname into strict v_name from pg_catalog.pg_constraint c
   where c.conrelid = v_heads and c.contype = 'f' and c.confrelid = v_checkpoints
     and c.conkey = array(select a.attnum from pg_catalog.pg_attribute a
                           where a.attrelid = c.conrelid and a.attname = 'checkpoint_id');
  execute format('alter table %s drop constraint %I', v_heads, v_name);
  execute format('alter table %s add constraint %I foreign key (checkpoint_id) references %s(id)',
    v_heads, v_name, v_checkpoints);

  -- Checkpoint -> the one before it: had no delete action, so a row another row points back at could not be
  -- deleted. Now ON DELETE SET NULL. The column is written and never read.
  select c.conname into strict v_name from pg_catalog.pg_constraint c
   where c.conrelid = v_checkpoints and c.contype = 'f' and c.confrelid = v_checkpoints
     and c.conkey = array(select a.attnum from pg_catalog.pg_attribute a
                           where a.attrelid = c.conrelid and a.attname = 'previous_checkpoint_id');
  execute format('alter table %s drop constraint %I', v_checkpoints, v_name);
  execute format('alter table %s add constraint %I foreign key (previous_checkpoint_id) references %s(id) on delete set null',
    v_checkpoints, v_name, v_checkpoints);

  -- Absorption record -> checkpoint: was ON DELETE CASCADE and part of the primary key, so deleting a checkpoint
  -- deleted the record that its events were absorbed and they counted as pending again. The record is one row
  -- per event of a context: that existing unique constraint becomes the primary key, the checkpoint becomes
  -- optional and is set to null when it is deleted.
  select c.conname into strict v_name from pg_catalog.pg_constraint c
   where c.conrelid = v_absorptions and c.contype = 'p';
  execute format('alter table %s drop constraint %I', v_absorptions, v_name);
  select c.conname into strict v_name from pg_catalog.pg_constraint c
   where c.conrelid = v_absorptions and c.contype = 'u'
     and c.conkey = array(select a.attnum from unnest(array['user_id', 'context_key', 'event_id']) with ordinality k(name, pos)
                            join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attname = k.name
                           order by k.pos);
  execute format('alter table %s drop constraint %I', v_absorptions, v_name);
  execute format('alter table %s add primary key (user_id, context_key, event_id)', v_absorptions);
  execute format('alter table %s alter column checkpoint_id drop not null', v_absorptions);
  select c.conname into strict v_name from pg_catalog.pg_constraint c
   where c.conrelid = v_absorptions and c.contype = 'f' and c.confrelid = v_checkpoints
     and c.conkey = array(select a.attnum from pg_catalog.pg_attribute a
                           where a.attrelid = c.conrelid and a.attname = 'checkpoint_id');
  execute format('alter table %s drop constraint %I', v_absorptions, v_name);
  execute format('alter table %s add constraint %I foreign key (checkpoint_id) references %s(id) on delete set null',
    v_absorptions, v_name, v_checkpoints);
end
$c1a$;

-- Deleting a checkpoint looks up the rows that point to it. The old primary key led with checkpoint_id; these
-- two indexes take over, over the rows that still name a checkpoint.
create index clued_checkpoint_absorptions_checkpoint_idx
  on public.clued_checkpoint_event_absorptions (checkpoint_id)
  where checkpoint_id is not null;
create index clued_context_checkpoints_previous_idx
  on public.clued_context_checkpoints (previous_checkpoint_id)
  where previous_checkpoint_id is not null;
