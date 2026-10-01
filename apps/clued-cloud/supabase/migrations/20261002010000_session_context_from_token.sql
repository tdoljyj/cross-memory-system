-- A session token belongs to the one context it was resumed with, but
-- clued_session_checkpoint and clued_session_reconcile treat a missing
-- context_key as "global". A project session that omitted it was looked up as
-- a Global session, was not found, and was told
-- resume_required_or_session_expired, which a fresh resume cannot cure
-- (2026-10-01: five refused checkpoints in one project session).
--
-- Both entry points now resolve the context from the caller's own live
-- session first:
-- * context_key omitted: the session's own context is used;
-- * context_key given and different from the session's context:
--   session_context_mismatch, a request-rule rejection naming the cause;
-- * no live session for this token and Binding (expired, ended, unknown):
--   unchanged, the predecessor raises resume_required_or_session_expired.
--
-- The predecessors move to clued_private unchanged; the public names become
-- thin wrappers. A later migration that replaces either public function must
-- keep calling clued_private.session_context_input first.

create or replace function clued_private.session_context_input(
  p_token_hash text,
  p_required_scope text,
  p_input jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_requested text;
  v_session_token text;
  v_session_context text;
begin
  if p_input is null or pg_catalog.jsonb_typeof(p_input) is distinct from 'object' then
    return p_input;
  end if;
  v_session_token := p_input->>'session_token';
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
     or v_session_token is null or v_session_token !~ '^clued_ses_[0-9a-f]{64}$' then
    return p_input;
  end if;
  select s.context_key into v_session_context
    from public.clued_continuity_sessions s
    join public.clued_agent_bindings b on b.id = s.binding_id and b.user_id = s.user_id
   where b.token_hash = p_token_hash
     and b.revoked_at is null
     and s.token_hash = pg_catalog.encode(
           extensions.digest(pg_catalog.convert_to(v_session_token, 'UTF8'), 'sha256'), 'hex')
     and s.ended_at is null
     and s.expires_at > now();
  if not found then
    -- Expired, ended or unknown: the predecessor keeps its own error.
    return p_input;
  end if;
  v_requested := nullif(pg_catalog.btrim(p_input->>'context_key'), '');
  if v_requested is null then
    return p_input || pg_catalog.jsonb_build_object('context_key', v_session_context);
  end if;
  if v_requested is distinct from v_session_context then
    -- Authorization errors of the Binding for its own session's context come
    -- first, so the mismatch is reported only to an admitted caller.
    perform clued_private.resolve_binding(p_token_hash, p_required_scope, v_session_context);
    raise exception 'session_context_mismatch' using errcode = '42501';
  end if;
  return p_input;
end;
$$;

revoke all on function clued_private.session_context_input(text, text, jsonb)
  from public, anon, authenticated, service_role;

alter function public.clued_mcp_commit_checkpoint(text, jsonb)
  rename to clued_mcp_commit_checkpoint_explicit_context;
alter function public.clued_mcp_commit_checkpoint_explicit_context(text, jsonb)
  set schema clued_private;
revoke all on function clued_private.clued_mcp_commit_checkpoint_explicit_context(text, jsonb)
  from public, anon, authenticated, service_role;

create function public.clued_mcp_commit_checkpoint(p_token_hash text, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return clued_private.clued_mcp_commit_checkpoint_explicit_context(
    p_token_hash,
    clued_private.session_context_input(p_token_hash, 'context:write', p_input));
end;
$$;

revoke all on function public.clued_mcp_commit_checkpoint(text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.clued_mcp_commit_checkpoint(text, jsonb) to anon;

alter function public.clued_mcp_session_reconcile(text, jsonb)
  rename to clued_mcp_session_reconcile_explicit_context;
alter function public.clued_mcp_session_reconcile_explicit_context(text, jsonb)
  set schema clued_private;
revoke all on function clued_private.clued_mcp_session_reconcile_explicit_context(text, jsonb)
  from public, anon, authenticated, service_role;

create function public.clued_mcp_session_reconcile(p_token_hash text, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return clued_private.clued_mcp_session_reconcile_explicit_context(
    p_token_hash,
    clued_private.session_context_input(p_token_hash, 'context:read', p_input));
end;
$$;

revoke all on function public.clued_mcp_session_reconcile(text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.clued_mcp_session_reconcile(text, jsonb) to anon;
