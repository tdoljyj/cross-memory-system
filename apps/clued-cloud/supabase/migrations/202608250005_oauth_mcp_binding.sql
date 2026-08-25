-- Supabase OAuth 2.1 adapter for Clued MCP.
-- OAuth clients receive normal short-lived user JWTs. This migration maps each
-- user/client pair to one private, revocable Clued Binding without disclosing its
-- long-lived token hash outside Postgres.

alter table public.clued_agent_bindings
  add column if not exists oauth_client_id text;

alter table public.clued_agent_bindings
  drop constraint if exists clued_agent_bindings_oauth_client_id_check;
alter table public.clued_agent_bindings
  add constraint clued_agent_bindings_oauth_client_id_check check (
    oauth_client_id is null or char_length(oauth_client_id) between 1 and 255
  );

create unique index if not exists clued_agent_bindings_oauth_client_uidx
  on public.clued_agent_bindings(user_id, oauth_client_id)
  where oauth_client_id is not null;

create or replace function clued_private.resolve_oauth_binding()
returns public.clued_agent_bindings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_client_id text := nullif(pg_catalog.btrim(auth.jwt()->>'client_id'), '');
  v_binding public.clued_agent_bindings%rowtype;
begin
  if v_user_id is null or v_client_id is null then
    raise exception 'oauth_client_authorization_required' using errcode = '28000';
  end if;
  if char_length(v_client_id) > 255 then
    raise exception 'oauth_client_id_too_long' using errcode = '22023';
  end if;

  select b.* into v_binding
    from public.clued_agent_bindings b
   where b.user_id = v_user_id
     and b.oauth_client_id = v_client_id;

  if found then
    if v_binding.revoked_at is not null then
      raise exception 'oauth_binding_revoked' using errcode = '42501';
    end if;
    return v_binding;
  end if;

  insert into public.clued_agent_bindings (
    user_id,
    vendor,
    agent_name,
    token_hash,
    scopes,
    context_keys,
    oauth_client_id
  ) values (
    v_user_id,
    'OAuth',
    'OAuth client ' || pg_catalog.left(v_client_id, 67),
    pg_catalog.encode(extensions.gen_random_bytes(32), 'hex'),
    array['context:read', 'context:write', 'audit:read']::text[],
    array['*']::text[],
    v_client_id
  )
  on conflict (user_id, oauth_client_id) where oauth_client_id is not null
  do nothing
  returning * into v_binding;

  if v_binding.id is null then
    select b.* into strict v_binding
      from public.clued_agent_bindings b
     where b.user_id = v_user_id
       and b.oauth_client_id = v_client_id
       and b.revoked_at is null;
  end if;

  return v_binding;
end;
$$;

create or replace function public.clued_oauth_call(
  p_tool text,
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_binding public.clued_agent_bindings%rowtype;
  v_input jsonb := coalesce(p_input, '{}'::jsonb);
begin
  v_binding := clued_private.resolve_oauth_binding();

  case p_tool
    when 'clued_session_resume' then
      return public.clued_mcp_restore(v_binding.token_hash, v_input);
    when 'clued_append_event' then
      return public.clued_mcp_append_event(v_binding.token_hash, v_input);
    when 'clued_session_checkpoint' then
      return public.clued_mcp_commit_checkpoint(v_binding.token_hash, v_input);
    when 'clued_search_context' then
      return public.clued_mcp_search_context(v_binding.token_hash, v_input);
    when 'clued_read_log' then
      return public.clued_mcp_read_log(v_binding.token_hash, v_input);
    when 'clued_import_log' then
      return public.clued_mcp_import_log(v_binding.token_hash, v_input);
    when 'clued_audit_receipts' then
      return public.clued_mcp_audit_receipts(v_binding.token_hash, v_input);
    when 'clued_project_observe' then
      return public.clued_project_observe(v_binding.token_hash, v_input);
    when 'clued_project_list' then
      return public.clued_project_list(v_binding.token_hash, v_input);
    when 'clued_project_update' then
      return public.clued_project_update(v_binding.token_hash, v_input);
    when 'clued_record_list' then
      return public.clued_record_list(v_binding.token_hash, v_input);
    when 'clued_record_write' then
      return public.clued_record_write(v_binding.token_hash, v_input);
    else
      raise exception 'unknown_oauth_tool' using errcode = '22023';
  end case;
end;
$$;

revoke all on function clued_private.resolve_oauth_binding() from public, anon, authenticated;
revoke all on function public.clued_oauth_call(text, jsonb) from public, anon;
grant execute on function public.clued_oauth_call(text, jsonb) to authenticated;

comment on function public.clued_oauth_call(text, jsonb) is
  'Dispatches an authenticated Supabase OAuth client to its private, revocable Clued Binding.';
