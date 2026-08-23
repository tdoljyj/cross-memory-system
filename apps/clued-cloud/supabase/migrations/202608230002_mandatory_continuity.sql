-- Clued mandatory continuity lifecycle and canonical 日志.md projection.
-- This migration strengthens 001 without touching the legacy flat binding.

create schema if not exists clued_private;
revoke all on schema clued_private from public, anon, authenticated;

alter table public.clued_agent_bindings
  add column if not exists context_keys text[] not null default array['*']::text[];

alter table public.clued_agent_bindings
  drop constraint if exists clued_agent_bindings_context_keys_check;
alter table public.clued_agent_bindings
  add constraint clued_agent_bindings_context_keys_check check (
    cardinality(context_keys) between 1 and 20
    and array_position(context_keys, null) is null
  );

create table if not exists public.clued_context_streams (
  user_id uuid not null references auth.users(id) on delete cascade,
  context_key text not null check (char_length(context_key) between 1 and 160),
  version bigint not null default 0 check (version >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, context_key)
);

create table if not exists public.clued_continuity_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  binding_id uuid not null references public.clued_agent_bindings(id) on delete cascade,
  context_key text not null check (char_length(context_key) between 1 and 160),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  restored_version bigint not null check (restored_version >= 0),
  client_session_id text check (client_session_id is null or char_length(client_session_id) between 1 and 160),
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '1 hour'),
  ended_at timestamptz
);

create table if not exists public.clued_log_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  binding_id uuid not null references public.clued_agent_bindings(id) on delete restrict,
  context_key text not null check (char_length(context_key) between 1 and 160),
  version bigint not null check (version >= 1),
  markdown text not null check (char_length(markdown) between 1 and 1048576),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  source text not null default 'authorized-import' check (char_length(source) between 1 and 80),
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) between 8 and 160),
  created_at timestamptz not null default now(),
  unique (user_id, context_key, version)
);

create unique index if not exists clued_log_versions_idempotency_uidx
  on public.clued_log_versions(user_id, binding_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists clued_continuity_sessions_active_idx
  on public.clued_continuity_sessions(binding_id, context_key, expires_at)
  where ended_at is null;

alter table public.clued_context_events
  add column if not exists version bigint,
  add column if not exists session_id uuid references public.clued_continuity_sessions(id) on delete set null,
  add column if not exists idempotency_key text;

alter table public.clued_context_checkpoints
  add column if not exists session_id uuid references public.clued_continuity_sessions(id) on delete set null,
  add column if not exists idempotency_key text;

create unique index if not exists clued_events_stream_version_uidx
  on public.clued_context_events(user_id, context_key, version)
  where version is not null;
create unique index if not exists clued_events_idempotency_uidx
  on public.clued_context_events(user_id, binding_id, idempotency_key)
  where idempotency_key is not null;
create unique index if not exists clued_checkpoints_idempotency_uidx
  on public.clued_context_checkpoints(user_id, binding_id, idempotency_key)
  where idempotency_key is not null;

alter table public.clued_context_streams enable row level security;
alter table public.clued_continuity_sessions enable row level security;
alter table public.clued_log_versions enable row level security;

drop policy if exists clued_streams_owner_select on public.clued_context_streams;
create policy clued_streams_owner_select on public.clued_context_streams
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists clued_sessions_owner_select on public.clued_continuity_sessions;
create policy clued_sessions_owner_select on public.clued_continuity_sessions
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists clued_log_versions_owner_select on public.clued_log_versions;
create policy clued_log_versions_owner_select on public.clued_log_versions
  for select to authenticated using ((select auth.uid()) = user_id);

create or replace function clued_private.resolve_binding(
  p_token_hash text,
  p_required_scope text,
  p_context_key text
)
returns public.clued_agent_bindings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_binding public.clued_agent_bindings%rowtype;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_binding' using errcode = '28000';
  end if;
  if char_length(p_context_key) not between 1 and 160 then
    raise exception 'invalid_context_key' using errcode = '22023';
  end if;

  select b.* into v_binding
    from public.clued_agent_bindings b
   where b.token_hash = p_token_hash
     and b.revoked_at is null
     and p_required_scope = any(b.scopes)
     and ('*' = any(b.context_keys) or p_context_key = any(b.context_keys));

  if not found then
    raise exception 'binding_not_authorized' using errcode = '42501';
  end if;

  update public.clued_agent_bindings
     set last_used_at = now()
   where id = v_binding.id;
  return v_binding;
end;
$$;

create or replace function clued_private.resolve_session(
  p_user_id uuid,
  p_binding_id uuid,
  p_context_key text,
  p_session_token text
)
returns public.clued_continuity_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.clued_continuity_sessions%rowtype;
  v_session_hash text;
begin
  if p_session_token is null or p_session_token !~ '^clued_ses_[0-9a-f]{64}$' then
    raise exception 'resume_required' using errcode = '42501';
  end if;
  v_session_hash := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_session_token, 'UTF8'), 'sha256'),
    'hex'
  );
  select s.* into v_session
    from public.clued_continuity_sessions s
   where s.token_hash = v_session_hash
     and s.user_id = p_user_id
     and s.binding_id = p_binding_id
     and s.context_key = p_context_key
     and s.ended_at is null
     and s.expires_at > now();
  if not found then
    raise exception 'resume_required_or_session_expired' using errcode = '42501';
  end if;
  return v_session;
end;
$$;

create or replace function clued_private.render_log(p_user_id uuid, p_context_key text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_checkpoint public.clued_context_checkpoints%rowtype;
  v_version bigint := 0;
  v_events text := '';
  v_imported_markdown text;
  v_imported_version bigint;
begin
  select s.version into v_version
    from public.clued_context_streams s
   where s.user_id = p_user_id and s.context_key = p_context_key;
  select c.* into v_checkpoint
    from public.clued_context_heads h
    join public.clued_context_checkpoints c on c.id = h.checkpoint_id
   where h.user_id = p_user_id and h.context_key = p_context_key;
  select coalesce(pg_catalog.string_agg(
    pg_catalog.format('- %s · %s · %s', e.occurred_at, e.event_type, e.payload::text),
    E'\n' order by e.id
  ), '') into v_events
    from public.clued_context_events e
   where e.user_id = p_user_id
     and e.context_key = p_context_key
     and e.id > coalesce(v_checkpoint.last_event_id, 0);

  select l.markdown, l.version into v_imported_markdown, v_imported_version
    from public.clued_log_versions l
   where l.user_id = p_user_id and l.context_key = p_context_key
   order by l.version desc
   limit 1;

  return case when v_imported_markdown is null then '# 日志'
    else pg_catalog.rtrim(v_imported_markdown) || E'\n\n---\n\n## Clued live continuity state'
    end || E'\n\n'
    || case when v_imported_version is null then ''
      else '- Imported baseline version: `' || v_imported_version::text || '`' || E'\n'
      end
    || '- Context: `' || p_context_key || '`' || E'\n'
    || '- Version: `' || coalesce(v_version, 0)::text || '`' || E'\n'
    || '- Canonical store: `clued-cloud/supabase`' || E'\n\n'
    || '## Latest checkpoint' || E'\n\n'
    || coalesce(v_checkpoint.summary, 'No checkpoint yet.') || E'\n\n'
    || '### Next action' || E'\n\n'
    || coalesce(v_checkpoint.next_action, 'Create the first checkpoint.') || E'\n\n'
    || '## Events after checkpoint' || E'\n\n'
    || case when v_events = '' then 'No pending events.' else v_events end || E'\n';
end;
$$;

create or replace function public.clued_mcp_import_log(p_token_hash text, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_binding public.clued_agent_bindings%rowtype;
  v_session public.clued_continuity_sessions%rowtype;
  v_context_key text := coalesce(nullif(pg_catalog.btrim(p_input->>'context_key'), ''), 'global');
  v_markdown text := p_input->>'markdown';
  v_source text := coalesce(nullif(pg_catalog.btrim(p_input->>'source'), ''), 'authorized-import');
  v_idempotency_key text := nullif(pg_catalog.btrim(p_input->>'idempotency_key'), '');
  v_base_version bigint;
  v_current_version bigint;
  v_new_version bigint;
  v_log_id uuid;
  v_event_id bigint;
  v_content_sha256 text;
  v_receipt_id uuid;
begin
  v_binding := clued_private.resolve_binding(p_token_hash, 'context:write', v_context_key);
  v_session := clued_private.resolve_session(
    v_binding.user_id, v_binding.id, v_context_key, p_input->>'session_token'
  );
  if not (p_input ? 'base_version') then raise exception 'base_version_required'; end if;
  v_base_version := (p_input->>'base_version')::bigint;
  if v_markdown is null or char_length(v_markdown) not between 1 and 1048576 then
    raise exception 'invalid_log_length';
  end if;
  if pg_catalog.left(pg_catalog.ltrim(v_markdown), 4) <> '# 日志' then
    raise exception 'canonical_log_heading_required';
  end if;
  if char_length(v_source) not between 1 and 80 then raise exception 'invalid_log_source'; end if;
  if v_idempotency_key is null or char_length(v_idempotency_key) not between 8 and 140 then
    raise exception 'idempotency_key_required';
  end if;

  select l.id, l.version, l.content_sha256 into v_log_id, v_new_version, v_content_sha256
    from public.clued_log_versions l
   where l.user_id = v_binding.user_id and l.binding_id = v_binding.id
     and l.idempotency_key = v_idempotency_key;
  if found then
    return jsonb_build_object('status','duplicate','log_id',v_log_id,'file_name','日志.md',
      'version',v_new_version,'content_sha256',v_content_sha256,'context_key',v_context_key);
  end if;

  select s.version into v_current_version
    from public.clued_context_streams s
   where s.user_id = v_binding.user_id and s.context_key = v_context_key
   for update;
  if not found then raise exception 'resume_required'; end if;
  if v_base_version <> v_current_version then
    return jsonb_build_object('status','conflict','error','stale_base_version',
      'expected_version',v_current_version,'provided_version',v_base_version,'context_key',v_context_key);
  end if;

  v_new_version := v_current_version + 1;
  v_content_sha256 := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(v_markdown, 'UTF8'), 'sha256'), 'hex'
  );
  insert into public.clued_log_versions(
    user_id,binding_id,context_key,version,markdown,content_sha256,source,idempotency_key
  ) values (
    v_binding.user_id,v_binding.id,v_context_key,v_new_version,v_markdown,
    v_content_sha256,v_source,v_idempotency_key
  ) returning id into v_log_id;
  insert into public.clued_context_events(
    user_id,binding_id,context_key,event_type,payload,base_version,version,session_id,idempotency_key
  ) values (
    v_binding.user_id,v_binding.id,v_context_key,'note',
    jsonb_build_object('kind','canonical_log_import','file_name','日志.md',
      'content_sha256',v_content_sha256,'characters',char_length(v_markdown),'source',v_source),
    v_base_version,v_new_version,v_session.id,'log-event:' || v_idempotency_key
  ) returning id into v_event_id;
  update public.clued_context_streams set version=v_new_version,updated_at=now()
   where user_id=v_binding.user_id and context_key=v_context_key;
  update public.clued_continuity_sessions set last_seen_at=now() where id=v_session.id;
  insert into public.clued_audit_receipts(
    user_id,binding_id,context_key,operation,object_type,object_id,version,metadata
  ) values (
    v_binding.user_id,v_binding.id,v_context_key,'import-log','log',v_log_id::text,v_new_version,
    jsonb_build_object('file_name','日志.md','content_sha256',v_content_sha256,
      'characters',char_length(v_markdown),'source',v_source,'event_id',v_event_id,'session_id',v_session.id)
  ) returning id into v_receipt_id;
  return jsonb_build_object('status','imported','log_id',v_log_id,'file_name','日志.md',
    'context_key',v_context_key,'version',v_new_version,'content_sha256',v_content_sha256,
    'receipt_id',v_receipt_id,'work_log',clued_private.render_log(v_binding.user_id,v_context_key));
end;
$$;

create or replace function public.clued_mcp_restore(
  p_token_hash text,
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_binding public.clued_agent_bindings%rowtype;
  v_context_key text := coalesce(nullif(pg_catalog.btrim(p_input->>'context_key'), ''), 'global');
  v_client_session_id text := nullif(pg_catalog.btrim(p_input->>'client_session_id'), '');
  v_checkpoint public.clued_context_checkpoints%rowtype;
  v_version bigint := 0;
  v_events jsonb := '[]'::jsonb;
  v_session_id uuid;
  v_session_token text;
  v_session_hash text;
  v_receipt_id uuid;
begin
  v_binding := clued_private.resolve_binding(p_token_hash, 'context:read', v_context_key);
  insert into public.clued_context_streams(user_id, context_key)
  values (v_binding.user_id, v_context_key)
  on conflict (user_id, context_key) do nothing;
  select s.version into v_version from public.clued_context_streams s
   where s.user_id = v_binding.user_id and s.context_key = v_context_key;

  select c.* into v_checkpoint
    from public.clued_context_heads h
    join public.clued_context_checkpoints c on c.id = h.checkpoint_id
   where h.user_id = v_binding.user_id and h.context_key = v_context_key;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id, 'version', e.version, 'type', e.event_type,
    'payload', e.payload, 'occurred_at', e.occurred_at, 'binding_id', e.binding_id
  ) order by e.id), '[]'::jsonb) into v_events
    from public.clued_context_events e
   where e.user_id = v_binding.user_id
     and e.context_key = v_context_key
     and e.id > coalesce(v_checkpoint.last_event_id, 0);

  if v_client_session_id is not null then
    update public.clued_continuity_sessions
       set ended_at = now()
     where binding_id = v_binding.id
       and context_key = v_context_key
       and client_session_id = v_client_session_id
       and ended_at is null;
  end if;
  v_session_token := 'clued_ses_' || pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  v_session_hash := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(v_session_token, 'UTF8'), 'sha256'), 'hex'
  );
  insert into public.clued_continuity_sessions(
    user_id, binding_id, context_key, token_hash, restored_version, client_session_id
  ) values (
    v_binding.user_id, v_binding.id, v_context_key, v_session_hash, v_version, v_client_session_id
  ) returning id into v_session_id;

  insert into public.clued_audit_receipts(
    user_id, binding_id, context_key, operation, object_type, object_id, version, metadata
  ) values (
    v_binding.user_id, v_binding.id, v_context_key, 'restore', 'session',
    v_session_id::text, v_version,
    jsonb_build_object('pending_event_count', jsonb_array_length(v_events), 'client_session_id', v_client_session_id)
  ) returning id into v_receipt_id;

  return jsonb_build_object(
    'status', case when v_checkpoint.id is null then 'empty' else 'restored' end,
    'context_key', v_context_key,
    'version', v_version,
    'session_token', v_session_token,
    'session_expires_in', 3600,
    'snapshot', coalesce(v_checkpoint.snapshot, '{}'::jsonb),
    'summary', v_checkpoint.summary,
    'next_action', v_checkpoint.next_action,
    'events_after_checkpoint', v_events,
    'work_log', clued_private.render_log(v_binding.user_id, v_context_key),
    'provenance', jsonb_build_object(
      'canonical_store', 'clued-cloud/supabase', 'checkpoint_id', v_checkpoint.id,
      'checkpoint_created_at', v_checkpoint.created_at, 'source_binding_id', v_checkpoint.binding_id
    ),
    'receipt_id', v_receipt_id
  );
end;
$$;

create or replace function public.clued_mcp_append_event(p_token_hash text, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_binding public.clued_agent_bindings%rowtype;
  v_session public.clued_continuity_sessions%rowtype;
  v_context_key text := coalesce(nullif(pg_catalog.btrim(p_input->>'context_key'), ''), 'global');
  v_event_type text := p_input->>'event_type';
  v_payload jsonb := p_input->'payload';
  v_base_version bigint;
  v_current_version bigint;
  v_new_version bigint;
  v_event_id bigint;
  v_idempotency_key text := nullif(pg_catalog.btrim(p_input->>'idempotency_key'), '');
  v_receipt_id uuid;
begin
  v_binding := clued_private.resolve_binding(p_token_hash, 'context:write', v_context_key);
  v_session := clued_private.resolve_session(
    v_binding.user_id, v_binding.id, v_context_key, p_input->>'session_token'
  );
  if not (p_input ? 'base_version') then raise exception 'base_version_required'; end if;
  v_base_version := (p_input->>'base_version')::bigint;
  if v_event_type not in ('decision','correction','action','failure','blocker','retraction','note') then
    raise exception 'invalid_event_type';
  end if;
  if v_payload is null or jsonb_typeof(v_payload) <> 'object' then raise exception 'payload_must_be_object'; end if;
  if v_idempotency_key is not null and char_length(v_idempotency_key) not between 8 and 160 then
    raise exception 'invalid_idempotency_key';
  end if;
  if v_idempotency_key is not null then
    select e.id, e.version into v_event_id, v_new_version
      from public.clued_context_events e
     where e.user_id = v_binding.user_id and e.binding_id = v_binding.id
       and e.idempotency_key = v_idempotency_key;
    if found then
      return jsonb_build_object('status','duplicate','event_id',v_event_id,'version',v_new_version,'context_key',v_context_key);
    end if;
  end if;

  select s.version into v_current_version
    from public.clued_context_streams s
   where s.user_id = v_binding.user_id and s.context_key = v_context_key
   for update;
  if not found then raise exception 'resume_required'; end if;
  if v_base_version <> v_current_version then
    return jsonb_build_object('status','conflict','error','stale_base_version',
      'expected_version',v_current_version,'provided_version',v_base_version,'context_key',v_context_key);
  end if;
  v_new_version := v_current_version + 1;
  insert into public.clued_context_events(
    user_id,binding_id,context_key,event_type,payload,base_version,version,session_id,idempotency_key
  ) values (
    v_binding.user_id,v_binding.id,v_context_key,v_event_type,v_payload,v_base_version,
    v_new_version,v_session.id,v_idempotency_key
  ) returning id into v_event_id;
  update public.clued_context_streams set version=v_new_version,updated_at=now()
   where user_id=v_binding.user_id and context_key=v_context_key;
  update public.clued_continuity_sessions set last_seen_at=now() where id=v_session.id;
  insert into public.clued_audit_receipts(
    user_id,binding_id,context_key,operation,object_type,object_id,version,metadata
  ) values (
    v_binding.user_id,v_binding.id,v_context_key,'append','event',v_event_id::text,v_new_version,
    jsonb_build_object('base_version',v_base_version,'session_id',v_session.id)
  ) returning id into v_receipt_id;
  return jsonb_build_object('status','appended','event_id',v_event_id,'version',v_new_version,
    'receipt_id',v_receipt_id,'context_key',v_context_key);
end;
$$;

create or replace function public.clued_mcp_commit_checkpoint(p_token_hash text, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_binding public.clued_agent_bindings%rowtype;
  v_session public.clued_continuity_sessions%rowtype;
  v_context_key text := coalesce(nullif(pg_catalog.btrim(p_input->>'context_key'), ''), 'global');
  v_base_version bigint;
  v_current_version bigint;
  v_new_version bigint;
  v_snapshot jsonb := p_input->'snapshot';
  v_summary text := pg_catalog.btrim(coalesce(p_input->>'summary',''));
  v_next_action text := pg_catalog.btrim(coalesce(p_input->>'next_action',''));
  v_idempotency_key text := nullif(pg_catalog.btrim(p_input->>'idempotency_key'), '');
  v_previous_id uuid;
  v_checkpoint_id uuid;
  v_last_event_id bigint := 0;
  v_receipt_id uuid;
begin
  v_binding := clued_private.resolve_binding(p_token_hash, 'context:write', v_context_key);
  v_session := clued_private.resolve_session(
    v_binding.user_id, v_binding.id, v_context_key, p_input->>'session_token'
  );
  if not (p_input ? 'base_version') then raise exception 'base_version_required'; end if;
  v_base_version := (p_input->>'base_version')::bigint;
  if v_snapshot is null or jsonb_typeof(v_snapshot) <> 'object' then raise exception 'snapshot_must_be_object'; end if;
  if char_length(v_summary) not between 1 and 4000 then raise exception 'invalid_summary_length'; end if;
  if char_length(v_next_action) not between 1 and 1000 then raise exception 'invalid_next_action_length'; end if;
  if v_idempotency_key is not null and char_length(v_idempotency_key) not between 8 and 160 then
    raise exception 'invalid_idempotency_key';
  end if;
  if v_idempotency_key is not null then
    select c.id, c.version into v_checkpoint_id, v_new_version
      from public.clued_context_checkpoints c
     where c.user_id=v_binding.user_id and c.binding_id=v_binding.id
       and c.idempotency_key=v_idempotency_key;
    if found then
      return jsonb_build_object('status','duplicate','checkpoint_id',v_checkpoint_id,
        'version',v_new_version,'context_key',v_context_key);
    end if;
  end if;

  select s.version into v_current_version
    from public.clued_context_streams s
   where s.user_id=v_binding.user_id and s.context_key=v_context_key
   for update;
  if not found then raise exception 'resume_required'; end if;
  if v_base_version <> v_current_version then
    return jsonb_build_object('status','conflict','error','stale_base_version',
      'expected_version',v_current_version,'provided_version',v_base_version,'context_key',v_context_key);
  end if;
  v_new_version := v_current_version + 1;
  select h.checkpoint_id into v_previous_id from public.clued_context_heads h
   where h.user_id=v_binding.user_id and h.context_key=v_context_key;
  select coalesce(max(e.id),0) into v_last_event_id from public.clued_context_events e
   where e.user_id=v_binding.user_id and e.context_key=v_context_key;
  insert into public.clued_context_checkpoints(
    user_id,binding_id,context_key,version,snapshot,summary,next_action,last_event_id,
    previous_checkpoint_id,session_id,idempotency_key
  ) values (
    v_binding.user_id,v_binding.id,v_context_key,v_new_version,v_snapshot,v_summary,v_next_action,
    v_last_event_id,v_previous_id,v_session.id,v_idempotency_key
  ) returning id into v_checkpoint_id;
  insert into public.clued_context_heads(user_id,context_key,checkpoint_id,version,updated_at)
  values(v_binding.user_id,v_context_key,v_checkpoint_id,v_new_version,now())
  on conflict(user_id,context_key) do update set checkpoint_id=excluded.checkpoint_id,
    version=excluded.version,updated_at=excluded.updated_at;
  update public.clued_context_streams set version=v_new_version,updated_at=now()
   where user_id=v_binding.user_id and context_key=v_context_key;
  update public.clued_continuity_sessions set last_seen_at=now(),ended_at=now() where id=v_session.id;
  insert into public.clued_audit_receipts(
    user_id,binding_id,context_key,operation,object_type,object_id,version,metadata
  ) values (
    v_binding.user_id,v_binding.id,v_context_key,'checkpoint','checkpoint',v_checkpoint_id::text,
    v_new_version,jsonb_build_object('base_version',v_base_version,'last_event_id',v_last_event_id,'session_id',v_session.id)
  ) returning id into v_receipt_id;
  return jsonb_build_object('status','committed','context_key',v_context_key,'version',v_new_version,
    'checkpoint_id',v_checkpoint_id,'receipt_id',v_receipt_id,'last_event_id',v_last_event_id,
    'work_log',clued_private.render_log(v_binding.user_id,v_context_key));
end;
$$;

create or replace function public.clued_mcp_search_context(p_token_hash text, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_binding public.clued_agent_bindings%rowtype;
  v_session public.clued_continuity_sessions%rowtype;
  v_context_key text := coalesce(nullif(pg_catalog.btrim(p_input->>'context_key'), ''), 'global');
  v_query text := pg_catalog.btrim(coalesce(p_input->>'query',''));
  v_include_history boolean := coalesce((p_input->>'include_history')::boolean,false);
  v_limit integer := least(greatest(coalesce((p_input->>'limit')::integer,10),1),50);
  v_results jsonb;
begin
  v_binding := clued_private.resolve_binding(p_token_hash,'context:read',v_context_key);
  v_session := clued_private.resolve_session(v_binding.user_id,v_binding.id,v_context_key,p_input->>'session_token');
  if char_length(v_query) not between 1 and 500 then raise exception 'invalid_query_length'; end if;
  select coalesce(jsonb_agg(row_data order by sort_version desc),'[]'::jsonb) into v_results from (
    select jsonb_build_object('kind','checkpoint','id',c.id,'version',c.version,'summary',c.summary,
      'next_action',c.next_action,'snapshot',c.snapshot,'created_at',c.created_at) row_data,
      c.version sort_version
      from public.clued_context_checkpoints c
     where c.user_id=v_binding.user_id and c.context_key=v_context_key
       and (c.summary ilike '%'||v_query||'%' or c.next_action ilike '%'||v_query||'%'
         or c.snapshot::text ilike '%'||v_query||'%')
       and (v_include_history or c.id=(select h.checkpoint_id from public.clued_context_heads h
         where h.user_id=v_binding.user_id and h.context_key=v_context_key))
    union all
    select jsonb_build_object('kind','event','id',e.id,'version',e.version,'type',e.event_type,
      'payload',e.payload,'occurred_at',e.occurred_at),coalesce(e.version,0)
      from public.clued_context_events e
     where e.user_id=v_binding.user_id and e.context_key=v_context_key
       and e.payload::text ilike '%'||v_query||'%'
    order by sort_version desc limit v_limit
  ) matches;
  update public.clued_continuity_sessions set last_seen_at=now() where id=v_session.id;
  return jsonb_build_object('status','ok','mode','lexical','context_key',v_context_key,'query',v_query,'results',v_results);
end;
$$;

create or replace function public.clued_mcp_read_log(p_token_hash text, p_input jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_binding public.clued_agent_bindings%rowtype;
  v_session public.clued_continuity_sessions%rowtype;
  v_context_key text := coalesce(nullif(pg_catalog.btrim(p_input->>'context_key'), ''), 'global');
  v_version bigint := 0;
begin
  v_binding := clued_private.resolve_binding(p_token_hash,'context:read',v_context_key);
  v_session := clued_private.resolve_session(v_binding.user_id,v_binding.id,v_context_key,p_input->>'session_token');
  select s.version into v_version from public.clued_context_streams s
   where s.user_id=v_binding.user_id and s.context_key=v_context_key;
  update public.clued_continuity_sessions set last_seen_at=now() where id=v_session.id;
  return jsonb_build_object('status','ok','file_name','日志.md','context_key',v_context_key,
    'version',coalesce(v_version,0),'markdown',clued_private.render_log(v_binding.user_id,v_context_key));
end;
$$;

create or replace function public.clued_mcp_audit_receipts(p_token_hash text, p_input jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_binding public.clued_agent_bindings%rowtype;
  v_context_key text := coalesce(nullif(pg_catalog.btrim(p_input->>'context_key'), ''), 'global');
  v_limit integer := least(greatest(coalesce((p_input->>'limit')::integer,20),1),100);
  v_receipts jsonb;
begin
  v_binding := clued_private.resolve_binding(p_token_hash,'audit:read',v_context_key);
  select coalesce(jsonb_agg(row_data order by created_at desc),'[]'::jsonb) into v_receipts from (
    select jsonb_build_object('id',r.id,'operation',r.operation,'object_type',r.object_type,
      'object_id',r.object_id,'version',r.version,'binding_id',r.binding_id,
      'metadata',r.metadata,'created_at',r.created_at) row_data,r.created_at
      from public.clued_audit_receipts r
     where r.user_id=v_binding.user_id and r.context_key=v_context_key
     order by r.created_at desc limit v_limit
  ) matches;
  return jsonb_build_object('status','ok','context_key',v_context_key,'receipts',v_receipts);
end;
$$;

revoke all on function public.clued_resolve_binding(text,text) from anon, authenticated;
revoke all on function clued_private.resolve_binding(text,text,text) from public, anon, authenticated;
revoke all on function clued_private.resolve_session(uuid,uuid,text,text) from public, anon, authenticated;
revoke all on function clued_private.render_log(uuid,text) from public, anon, authenticated;

revoke all on function public.clued_mcp_restore(text,jsonb) from public;
revoke all on function public.clued_mcp_append_event(text,jsonb) from public;
revoke all on function public.clued_mcp_commit_checkpoint(text,jsonb) from public;
revoke all on function public.clued_mcp_search_context(text,jsonb) from public;
revoke all on function public.clued_mcp_read_log(text,jsonb) from public;
revoke all on function public.clued_mcp_import_log(text,jsonb) from public;
revoke all on function public.clued_mcp_audit_receipts(text,jsonb) from public;
grant execute on function public.clued_mcp_restore(text,jsonb) to anon;
grant execute on function public.clued_mcp_append_event(text,jsonb) to anon;
grant execute on function public.clued_mcp_commit_checkpoint(text,jsonb) to anon;
grant execute on function public.clued_mcp_search_context(text,jsonb) to anon;
grant execute on function public.clued_mcp_read_log(text,jsonb) to anon;
grant execute on function public.clued_mcp_import_log(text,jsonb) to anon;
grant execute on function public.clued_mcp_audit_receipts(text,jsonb) to anon;

revoke all on public.clued_context_streams from anon, authenticated;
revoke all on public.clued_continuity_sessions from anon, authenticated;
revoke all on public.clued_log_versions from anon, authenticated;
grant select on public.clued_context_streams to authenticated;
grant select on public.clued_continuity_sessions to authenticated;
grant select on public.clued_log_versions to authenticated;

