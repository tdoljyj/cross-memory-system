-- Owner Decision d4663fa2; Task ed3755b4. Owner-only default-on policy for
-- independent read-only review. This is not an execution or publication grant.
create table clued_private.independent_review_settings_v1 (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null,
  version bigint not null check (version>=1),
  updated_at timestamptz not null,
  receipt_id uuid not null
);
alter table clued_private.independent_review_settings_v1 enable row level security;
revoke all on clued_private.independent_review_settings_v1 from public,anon,authenticated,service_role;

create function clued_private.independent_review_setting_view_v1(p_user_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(
    (select jsonb_build_object('enabled',s.enabled,'version',s.version,'default',false,
        'updated_at',s.updated_at,'receipt_id',s.receipt_id)
      from clued_private.independent_review_settings_v1 s where s.user_id=p_user_id),
    jsonb_build_object('enabled',true,'version',0,'default',true,'updated_at',null,'receipt_id',null))
    ||jsonb_build_object('authority_effect','independent_read_only_review',
      'owner_preconditions_apply',true,'execution_authority',false,'policy_version',1);
$$;

-- VOLATILE: the existing direct-account principal check takes a row lock.
create function public.clued_independent_review_setting_v1(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12();
begin
  if jsonb_typeof(p_input) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_input)) then
    raise exception 'independent_review_setting_input_invalid' using errcode='22023'; end if;
  return jsonb_build_object('status','ok')||clued_private.independent_review_setting_view_v1(v_owner);
end $$;

create function public.clued_independent_review_setting_set_v1(p_input jsonb) returns jsonb
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
    raise exception 'independent_review_setting_input_invalid' using errcode='22023'; end if;
  if v_session is null then
    raise exception 'independent_review_setting_session_required' using errcode='42501'; end if;
  v_enabled:=(p_input->>'enabled')::boolean;
  v_base:=(p_input->>'base_version')::bigint;

  -- Resume already uses this account lock: a switch cannot split its view.
  perform clued_private.currentness_user_lock(v_owner);
  v_current:=clued_private.independent_review_setting_view_v1(v_owner);
  v_version:=(v_current->>'version')::bigint;
  if v_version<>v_base then
    return jsonb_build_object('status','rejected','error_code','independent_review_setting_version_conflict',
      'authoritative',false,'current',v_current);
  end if;
  if (v_current->>'enabled')::boolean=v_enabled then
    return jsonb_build_object('status','committed','changed',false)||v_current;
  end if;
  v_version:=v_version+1;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(v_owner,null,'global','independent_review_setting_set','independent_review_setting',v_owner::text,v_version,
    jsonb_build_object('receipt_kind',case when v_enabled then 'INDEPENDENT_REVIEW_ENABLED' else 'INDEPENDENT_REVIEW_DISABLED' end,
      'enabled',v_enabled,'base_version',v_base,'session_id',v_session,'principal','native_account_session',
      'authority_effect','independent_read_only_review','execution_authority',false))
  returning id into v_receipt;
  insert into clued_private.independent_review_settings_v1(user_id,enabled,version,updated_at,receipt_id)
  values(v_owner,v_enabled,v_version,v_now,v_receipt)
  on conflict (user_id) do update set enabled=excluded.enabled,version=excluded.version,
    updated_at=excluded.updated_at,receipt_id=excluded.receipt_id;
  return jsonb_build_object('status','committed','changed',true)
    ||clued_private.independent_review_setting_view_v1(v_owner);
end $$;

revoke all on function clued_private.independent_review_setting_view_v1(uuid),
  public.clued_independent_review_setting_v1(jsonb),public.clued_independent_review_setting_set_v1(jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.clued_independent_review_setting_v1(jsonb),
  public.clued_independent_review_setting_set_v1(jsonb) to authenticated;

-- Existing protected Binding/OAuth restore resolves the user and scope. Add
-- the policy after its verified read, for both structured and work_log views.
-- Renewal also reads the current policy; no setting or public user ID is
-- accepted from the Agent. Fail closed on source drift, preserving all gates.
do $migration$
declare body text;
  restore_anchor text:=$anchor$  if v_response_view='work_log' then$anchor$;
  scoped_restore_anchor text:=$anchor$ return jsonb_build_object('status','scoped_context_ready','session_resumed',false,'session_checkpoint_supported',false,$anchor$;
  renewal_anchor text:=$anchor$    'session_token',v_token,'version',p_version,'session_expires_in',3600,$anchor$;
begin
  body:=pg_get_functiondef('public.clued_mcp_restore_before_project_access_v13(text,jsonb)'::regprocedure);
  if array_length(string_to_array(body,restore_anchor),1) is distinct from 2
    or strpos(body,'independent_review_setting_view_v1')>0 then
    raise exception 'independent_review_restore_definition_mismatch'; end if;
  execute replace(body,restore_anchor,
    $policy$  v_result:=v_result||jsonb_build_object('independent_review',
    clued_private.independent_review_setting_view_v1(v_binding.user_id));
$policy$||restore_anchor);

  -- Context-only consent has no Canonical session, but its successful restore
  -- still verifies the account and exact development-history read grant. Read
  -- this same account policy only after that existing authorization path; do
  -- not add Canonical access, a session, or checkpoint support.
  body:=pg_get_functiondef('public.clued_mcp_restore_before_currentness(text,jsonb)'::regprocedure);
  if array_length(string_to_array(body,scoped_restore_anchor),1) is distinct from 2
    or strpos(body,'independent_review_setting_view_v1')>0 then
    raise exception 'independent_review_scoped_restore_definition_mismatch'; end if;
  execute replace(body,scoped_restore_anchor,
    $policy$ perform clued_private.currentness_user_lock(b.user_id);
$policy$||scoped_restore_anchor||$policy$
  'independent_review',clued_private.independent_review_setting_view_v1(b.user_id),$policy$);

  body:=pg_get_functiondef('clued_private.renew_checkpoint_session(public.clued_agent_bindings,public.clued_continuity_sessions,bigint,uuid)'::regprocedure);
  if array_length(string_to_array(body,renewal_anchor),1) is distinct from 2
    or strpos(body,'independent_review_setting_view_v1')>0 then
    raise exception 'independent_review_renewal_definition_mismatch'; end if;
  execute replace(body,renewal_anchor,renewal_anchor||$policy$
    'independent_review',clued_private.independent_review_setting_view_v1(p_binding.user_id),$policy$);
end $migration$;

notify pgrst,'reload schema';
