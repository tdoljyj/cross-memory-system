-- Agent messages switch (development/contracts/agent-messaging/
-- AgentMessaging.v0.1.md §7; Owner Decision 2bacda7a, Task 17a8649b). One
-- switch per account decides whether that account's Agents may write to each
-- other through Clued. Until now only a standing authorization recorded in
-- Clued said so, and a new account has no such record.
--
-- * On by default: an account without a row is on, so a new user needs no
--   setting.
-- * Only the user switches it, signed in to Clued directly. Both RPCs run as
--   that account session (clued_private.authorization_owner_v12): Bindings,
--   delegated OAuth logins and MCP tools cannot read or change it here.
-- * Off is enforced: clued_agent_message_send_v1 refuses new messages and
--   replies with agent_messages_disabled. Reading the inbox is unchanged, and
--   a replay of a message committed before the switch went off still returns
--   that message, so an Agent recovering an uncertain send is not misled.
-- * Every change leaves an audit receipt (AGENT_MESSAGES_ENABLED or
--   AGENT_MESSAGES_DISABLED).
--
-- Adds one table and four functions; patches two functions of 20261006090000
-- in place (the same anchor patch as its clued_oauth_call cases).

create table clued_private.agent_message_settings_v1 (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null,
  version bigint not null check (version>=1),
  updated_at timestamptz not null,
  receipt_id uuid not null
);
revoke all on clued_private.agent_message_settings_v1 from public,anon,authenticated,service_role;

-- No row means on.
create function clued_private.agent_messages_enabled_v1(p_user_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce((select s.enabled from clued_private.agent_message_settings_v1 s
    where s.user_id=p_user_id),true)
$$;

create function clued_private.agent_messages_setting_view_v1(p_user_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(
    (select jsonb_build_object('enabled',s.enabled,'version',s.version,'default',false,
        'updated_at',s.updated_at,'receipt_id',s.receipt_id)
      from clued_private.agent_message_settings_v1 s where s.user_id=p_user_id),
    jsonb_build_object('enabled',true,'version',0,'default',true,'updated_at',null,'receipt_id',null))
$$;

-- clued_agent_messages_setting_v1: {} -> {status: ok, enabled, version,
--   default, updated_at, receipt_id}. version 0 is the default (no change yet).
-- VOLATILE although it only reads: PostgREST runs a STABLE RPC in a read-only
-- transaction, which refuses the owner check's row lock.
create function public.clued_agent_messages_setting_v1(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12();
begin
  if jsonb_typeof(p_input) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_input)) then
    raise exception 'agent_messages_setting_input_invalid' using errcode='22023'; end if;
  return jsonb_build_object('status','ok')||clued_private.agent_messages_setting_view_v1(v_owner);
end $$;

-- clued_agent_messages_setting_set_v1: {enabled: boolean, base_version:
--   integer} -> {status: committed, changed, enabled, version, ...}.
-- base_version is the version the page showed (0 for the default); another
-- change in between answers agent_messages_setting_version_conflict with the
-- current setting. Setting the value it already has changes nothing and
-- leaves no receipt.
create function public.clued_agent_messages_setting_set_v1(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_session text:=clued_private.native_session_id_v1();
  v_current jsonb; v_enabled boolean; v_base bigint; v_version bigint; v_receipt uuid;
  v_now timestamptz:=pg_catalog.clock_timestamp();
begin
  if jsonb_typeof(p_input) is distinct from 'object'
    or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('enabled','base_version'))
    or jsonb_typeof(p_input->'enabled') is distinct from 'boolean'
    or jsonb_typeof(p_input->'base_version') is distinct from 'number'
    or (p_input->>'base_version') !~ '^[0-9]{1,18}$' then
    raise exception 'agent_messages_setting_input_invalid' using errcode='22023'; end if;
  if v_session is null then
    raise exception 'agent_messages_setting_session_required' using errcode='42501'; end if;
  v_enabled:=(p_input->>'enabled')::boolean;
  v_base:=(p_input->>'base_version')::bigint;

  -- The same lock as clued_agent_message_send_v1: a send and a switch of one
  -- account never interleave.
  perform clued_private.agent_message_lock(v_owner);
  v_current:=clued_private.agent_messages_setting_view_v1(v_owner);
  v_version:=(v_current->>'version')::bigint;
  if v_version<>v_base then
    return jsonb_build_object('status','rejected','error_code','agent_messages_setting_version_conflict',
      'authoritative',false,'current',v_current);
  end if;
  if (v_current->>'enabled')::boolean=v_enabled then
    return jsonb_build_object('status','committed','changed',false)||v_current;
  end if;

  v_version:=v_version+1;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(v_owner,null,'global','agent_messages_setting_set','agent_message_setting',v_owner::text,v_version,
    jsonb_build_object('receipt_kind',case when v_enabled then 'AGENT_MESSAGES_ENABLED' else 'AGENT_MESSAGES_DISABLED' end,
      'enabled',v_enabled,'base_version',v_base,'session_id',v_session,'principal','native_account_session'))
  returning id into v_receipt;
  insert into clued_private.agent_message_settings_v1(user_id,enabled,version,updated_at,receipt_id)
  values(v_owner,v_enabled,v_version,v_now,v_receipt)
  on conflict (user_id) do update set enabled=excluded.enabled,version=excluded.version,
    updated_at=excluded.updated_at,receipt_id=excluded.receipt_id;
  return jsonb_build_object('status','committed','changed',true)
    ||clued_private.agent_messages_setting_view_v1(v_owner);
end $$;

revoke all on function clued_private.agent_messages_enabled_v1(uuid),
  clued_private.agent_messages_setting_view_v1(uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.clued_agent_messages_setting_v1(jsonb),
  public.clued_agent_messages_setting_set_v1(jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.clued_agent_messages_setting_v1(jsonb),
  public.clued_agent_messages_setting_set_v1(jsonb) to authenticated;

-- Enforcement and the summary flag, patched into the 20261006090000 bodies.
-- The send check sits after the idempotent replay and under the account lock.
do $migration$
declare body text;
  send_anchor text:=$anchor$  -- Expired messages of this user are removed here; their receipts stay.$anchor$;
  summary_anchor text:=$anchor$    'latest_unread',v_latest);$anchor$;
begin
  body:=pg_get_functiondef('public.clued_agent_message_send_v1(text,jsonb)'::regprocedure);
  if strpos(body,send_anchor)=0 or strpos(body,'agent_messages_disabled')>0
    or array_length(string_to_array(body,send_anchor),1)<>2 then
    raise exception 'agent_message_send_definition_mismatch';
  end if;
  execute replace(body,send_anchor,$check$  -- The account's Agent messages switch (20261008190000): off refuses new
  -- messages and replies; the replay above still answers.
  if not clued_private.agent_messages_enabled_v1(v_binding.user_id) then
    return clued_private.agent_message_reject('agent_messages_disabled',jsonb_build_object(
      'how_to','The Owner has turned off Agent messages for this account. Do not resend or reach the other Agent another way: tell the Owner in one line who you needed and what for.'));
  end if;

$check$||send_anchor);

  body:=pg_get_functiondef('public.clued_agent_inbox_summary_v1(text,jsonb)'::regprocedure);
  if strpos(body,summary_anchor)=0 or strpos(body,'agent_messages_enabled')>0
    or array_length(string_to_array(body,summary_anchor),1)<>2 then
    raise exception 'agent_inbox_summary_definition_mismatch';
  end if;
  execute replace(body,summary_anchor,$summary$    'latest_unread',v_latest,
    'agent_messages_enabled',clued_private.agent_messages_enabled_v1(v_binding.user_id));$summary$);
end $migration$;

notify pgrst,'reload schema';
