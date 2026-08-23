-- Clued Memory CRUD vertical slice.
-- Signed-in users can manage only their own memories. Audit rows are read-only
-- to clients and retain action metadata plus content digests, never deleted text.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists clued_private;
revoke all on schema clued_private from public, anon, authenticated;

create table public.clued_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  content text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clued_memories_title_length
    check (char_length(btrim(title)) between 1 and 120),
  constraint clued_memories_content_length
    check (char_length(btrim(content)) between 1 and 8000)
);

create index clued_memories_user_updated_idx
  on public.clued_memories (user_id, updated_at desc);

create table public.clued_memory_audit (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  memory_id uuid not null,
  action text not null check (action in ('create', 'update', 'delete')),
  actor_user_id uuid,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index clued_memory_audit_user_occurred_idx
  on public.clued_memory_audit (user_id, occurred_at desc);
create index clued_memory_audit_memory_idx
  on public.clued_memory_audit (memory_id, occurred_at desc);

alter table public.clued_memories enable row level security;
alter table public.clued_memory_audit enable row level security;

create policy clued_memories_select_own
  on public.clued_memories
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy clued_memories_insert_own
  on public.clued_memories
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy clued_memories_update_own
  on public.clued_memories
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy clued_memories_delete_own
  on public.clued_memories
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create policy clued_memory_audit_select_own
  on public.clued_memory_audit
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create or replace function clued_private.audit_memory_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.clued_memories%rowtype;
  v_action text;
  v_details jsonb;
begin
  if tg_op = 'DELETE' then
    v_row := old;
    v_action := 'delete';
  elsif tg_op = 'UPDATE' then
    v_row := new;
    v_action := 'update';
  else
    v_row := new;
    v_action := 'create';
  end if;

  v_details := pg_catalog.jsonb_build_object(
    'title', v_row.title,
    'content_sha256', pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(v_row.content, 'UTF8'), 'sha256'),
      'hex'
    ),
    'content_length', pg_catalog.char_length(v_row.content)
  );

  if tg_op = 'UPDATE' then
    v_details := v_details || pg_catalog.jsonb_build_object(
      'previous_content_sha256', pg_catalog.encode(
        extensions.digest(pg_catalog.convert_to(old.content, 'UTF8'), 'sha256'),
        'hex'
      ),
      'previous_title', old.title
    );
  end if;

  insert into public.clued_memory_audit (
    user_id,
    memory_id,
    action,
    actor_user_id,
    details
  ) values (
    v_row.user_id,
    v_row.id,
    v_action,
    auth.uid(),
    v_details
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function clued_private.audit_memory_change()
  from public, anon, authenticated;

create trigger clued_memories_audit_trigger
after insert or update or delete on public.clued_memories
for each row execute function clued_private.audit_memory_change();

revoke all on table public.clued_memories from anon;
revoke all on table public.clued_memory_audit from anon;
grant select, insert, update, delete on table public.clued_memories to authenticated;
grant select on table public.clued_memory_audit to authenticated;
revoke insert, update, delete on table public.clued_memory_audit from authenticated;
grant select, insert, update, delete on table public.clued_memories to service_role;
grant select, insert, update, delete on table public.clued_memory_audit to service_role;

comment on table public.clued_memories is
  'User-owned Clued memories exposed through authenticated RLS only.';
comment on table public.clued_memory_audit is
  'Read-only user audit trail with metadata and content digests; deleted content is not retained.';

notify pgrst, 'reload schema';
