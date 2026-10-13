-- Owner automatic approval is now a persistent boolean, default On. The
-- Native account session changes it with one CAS-protected click; durations
-- remain properties of individual grants, never of this preference.
-- Historical timed periods, tokens, receipts and grant FKs stay intact.

alter table clued_private.owner_auto_approve_v1
  alter column expires_at drop not null,
  alter column token_id drop not null,
  add column policy_source text,
  add column setting_version integer,
  add constraint owner_auto_approve_v1_policy_source_check check (
    (policy_source is null and token_id is not null and expires_at is not null and setting_version is null)
    or (policy_source is not null and policy_source in ('default_on','native_account_session','legacy_migration')
      and token_id is null and expires_at is null and setting_version is not null and setting_version>=0)
  );

create table clued_private.owner_auto_approve_settings_v1 (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null,
  version integer not null check (version>=0),
  auto_approve_id uuid references clued_private.owner_auto_approve_v1(id),
  receipt_id uuid not null references public.clued_audit_receipts(id),
  updated_at timestamptz not null default clock_timestamp(),
  check (enabled=(auto_approve_id is not null))
);
alter table clued_private.owner_auto_approve_settings_v1 enable row level security;
revoke all on clued_private.owner_auto_approve_settings_v1 from public,anon,authenticated,service_role;

-- Record the successor policy without rewriting old periods. A replacement
-- period's off_receipt is an ON receipt, so only an actual latest manual OFF
-- remains Off. An expired timed On becomes persistent On. No previous switch
-- row means default On and is materialized only when needed for a grant.
do $migration$
declare s clued_private.owner_auto_approve_v1%rowtype; v_on boolean; v_receipt uuid; v_switch uuid;
begin
  for s in select distinct on (user_id) * from clued_private.owner_auto_approve_v1
      order by user_id,turned_on_at desc,id desc loop
    perform clued_private.owner_grant_lock_v1(s.user_id);
    v_on:=not (s.turned_off_at is not null and exists (
      select 1 from public.clued_audit_receipts r where r.id=s.off_receipt_id
        and r.operation='owner_auto_approve_off'));
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(s.user_id,null,'global','owner_auto_approve_migrate','owner_auto_approve',s.user_id::text,1,
      jsonb_build_object('receipt_kind','OWNER_AUTO_APPROVE_MIGRATED','principal','system_migration',
        'policy','owner_auto_approve_persistent_v1','enabled',v_on,'persistent',true,
        'previous_switch_id',s.id,'previous_receipt_id',s.receipt_id,'previous_off_receipt_id',s.off_receipt_id))
    returning id into v_receipt;
    v_switch:=null;
    if v_on then
      insert into clued_private.owner_auto_approve_v1(user_id,turned_on_at,receipt_id,session_id,policy_source,setting_version)
      values(s.user_id,clock_timestamp(),v_receipt,'owner_auto_approve_migration','legacy_migration',1)
      returning id into v_switch;
    end if;
    insert into clued_private.owner_auto_approve_settings_v1(user_id,enabled,version,auto_approve_id,receipt_id)
    values(s.user_id,v_on,1,v_switch,v_receipt);
  end loop;
end $migration$;

-- Read helpers never materialize or mutate a default preference.
create or replace function clued_private.owner_auto_approve_live_v1(p_user_id uuid)
returns clued_private.owner_auto_approve_v1 language sql stable security definer set search_path='' as $$
  select s.* from clued_private.owner_auto_approve_settings_v1 p
    join clued_private.owner_auto_approve_v1 s on s.id=p.auto_approve_id and s.user_id=p.user_id
    where p.user_id=p_user_id and p.enabled
$$;

create or replace function clued_private.owner_auto_approve_public_v1(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare p clued_private.owner_auto_approve_settings_v1%rowtype; s clued_private.owner_auto_approve_v1%rowtype;
begin
  select * into p from clued_private.owner_auto_approve_settings_v1 where user_id=p_user_id;
  s:=clued_private.owner_auto_approve_live_v1(p_user_id);
  return jsonb_build_object('on',coalesce(p.enabled,true),'version',coalesce(p.version,0),'persistent',true,
    'source',coalesce(s.policy_source,case when p.user_id is null then 'default_on' else 'native_account_session' end),
    'switch_id',s.id,'turned_on_at',s.turned_on_at,'expires_at',null,'receipt_id',p.receipt_id,
    'covers',coalesce((select jsonb_agg(a.action order by a.action)
      from clued_private.owner_grant_actions a where a.auto_approvable),'[]'::jsonb),
    'excluded',coalesce((select jsonb_agg(jsonb_build_object('action',a.action,'title',a.title) order by a.action)
      from clued_private.owner_grant_actions a where not a.auto_approvable),'[]'::jsonb));
end $$;

-- A default grant still needs a real auditable policy carrier. Initialization
-- and every caller share the same lock as the Native setter; initializing the
-- default preserves effective version 0 and never overrides an explicit Off.
create function clued_private.owner_auto_approve_materialize_v1(p_user_id uuid)
returns clued_private.owner_auto_approve_v1 language plpgsql volatile security definer set search_path='' as $$
declare s clued_private.owner_auto_approve_v1%rowtype; v_receipt uuid;
begin
  perform clued_private.owner_grant_lock_v1(p_user_id);
  if exists(select 1 from clued_private.owner_auto_approve_settings_v1 where user_id=p_user_id) then
    return clued_private.owner_auto_approve_live_v1(p_user_id);
  end if;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(p_user_id,null,'global','owner_auto_approve_default','owner_auto_approve',p_user_id::text,0,
    jsonb_build_object('receipt_kind','OWNER_AUTO_APPROVE_DEFAULT','principal','system_default_policy',
      'policy','owner_auto_approve_persistent_v1','enabled',true,'persistent',true,'setting_version',0))
  returning id into v_receipt;
  insert into clued_private.owner_auto_approve_v1(user_id,turned_on_at,receipt_id,session_id,policy_source,setting_version)
  values(p_user_id,clock_timestamp(),v_receipt,'owner_auto_approve_default_policy','default_on',0)
  returning * into s;
  insert into clued_private.owner_auto_approve_settings_v1(user_id,enabled,version,auto_approve_id,receipt_id)
  values(p_user_id,true,0,s.id,v_receipt);
  return s;
end $$;

-- Native-only successor. Neither Bindings nor delegated OAuth can use it.
create function public.clued_owner_auto_approve_set_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); p clued_private.owner_auto_approve_settings_v1%rowtype;
  v_enabled boolean; v_base integer; v_version integer; v_receipt uuid; v_switch uuid; v_error text;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  begin
    if clued_private.native_session_id_v1() is null then
      raise exception 'owner_auto_approve_session_id_required' using errcode='42501'; end if;
    if jsonb_typeof(p_input) is distinct from 'object'
        or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('enabled','base_version')) then
      raise exception 'owner_auto_approve_unknown_field' using errcode='22023'; end if;
    if jsonb_typeof(p_input->'enabled') is distinct from 'boolean' then
      raise exception 'owner_auto_approve_enabled_invalid' using errcode='22023'; end if;
    if jsonb_typeof(p_input->'base_version') is distinct from 'number'
        or (p_input->>'base_version') !~ '^(0|[1-9][0-9]{0,9})$' then
      raise exception 'owner_auto_approve_base_version_invalid' using errcode='22023'; end if;
    begin v_base:=(p_input->>'base_version')::integer;
    exception when numeric_value_out_of_range then
      raise exception 'owner_auto_approve_base_version_invalid' using errcode='22023'; end;
    v_enabled:=(p_input->>'enabled')::boolean;
    perform clued_private.owner_grant_lock_v1(v_owner);
    select * into p from clued_private.owner_auto_approve_settings_v1 where user_id=v_owner for update;
    if v_base<>coalesce(p.version,0) then
      return jsonb_build_object('status','rejected','error_code','owner_auto_approve_version_conflict','authoritative',false,
        'auto_approve',clued_private.owner_auto_approve_public_v1(v_owner));
    end if;
    if p.user_id is not null and p.enabled=v_enabled then
      return jsonb_build_object('status','committed','replayed',true,'receipt_id',p.receipt_id,
        'auto_approve',clued_private.owner_auto_approve_public_v1(v_owner));
    end if;
    v_version:=coalesce(p.version,0)+1;
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(v_owner,null,'global','owner_auto_approve_set','owner_auto_approve',v_owner::text,v_version,
      jsonb_build_object('receipt_kind','OWNER_AUTO_APPROVE_SET','principal','native_account_session',
        'policy','owner_auto_approve_persistent_v1','enabled',v_enabled,'persistent',true,'base_version',v_base,
        'setting_version',v_version,'previous_enabled',coalesce(p.enabled,true),'previous_receipt_id',p.receipt_id,
        'session_id',clued_private.native_session_id_v1())) returning id into v_receipt;
    if v_enabled then
      insert into clued_private.owner_auto_approve_v1(user_id,turned_on_at,receipt_id,session_id,policy_source,setting_version)
      values(v_owner,clock_timestamp(),v_receipt,clued_private.native_session_id_v1(),'native_account_session',v_version)
      returning id into v_switch;
    end if;
    insert into clued_private.owner_auto_approve_settings_v1(user_id,enabled,version,auto_approve_id,receipt_id)
    values(v_owner,v_enabled,v_version,v_switch,v_receipt)
    on conflict(user_id) do update set enabled=excluded.enabled,version=excluded.version,
      auto_approve_id=excluded.auto_approve_id,receipt_id=excluded.receipt_id,updated_at=clock_timestamp();
    return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,
      'auto_approve',clued_private.owner_auto_approve_public_v1(v_owner));
  exception when sqlstate '22023' or sqlstate '42501' then
    get stacked diagnostics v_error=message_text;
    return jsonb_build_object('status','rejected','error_code',v_error,'authoritative',false);
  end;
end $$;

-- Only individual grants expire: high-risk once/24h; routine suggestions or
-- 4h, up to their existing 7-day limit. Exact Binding/resources/Task, use caps,
-- action allowlist and downstream consume/revocation rules remain unchanged.
create or replace function clued_private.owner_auto_approve_request_v1(p_req clued_private.owner_requests_v1)
returns clued_private.owner_requests_v1 language plpgsql volatile security definer set search_path='' as $$
declare s clued_private.owner_auto_approve_v1%rowtype; a clued_private.owner_grant_actions%rowtype;
  v_req clued_private.owner_requests_v1%rowtype; v_grant clued_private.owner_grants_v1%rowtype;
  v_now timestamptz; v_choice text; v_seconds integer; v_max integer; v_receipt uuid;
begin
  if p_req.id is null or p_req.status<>'pending' then return p_req; end if;
  perform clued_private.owner_grant_lock_v1(p_req.user_id);
  select * into v_req from clued_private.owner_requests_v1 where id=p_req.id and user_id=p_req.user_id for update;
  v_now:=clock_timestamp();
  if v_req.id is null or v_req.status<>'pending' or v_req.expires_at<=v_now then return v_req; end if;
  select * into a from clued_private.owner_grant_actions where action=v_req.action;
  if not coalesce(a.auto_approvable,false) then return v_req; end if;
  s:=clued_private.owner_auto_approve_materialize_v1(v_req.user_id);
  if s.id is null then return v_req; end if;
  if a.risk='routine' then
    v_choice:='grant'; v_seconds:=coalesce(v_req.suggested_expires_seconds,14400); v_max:=v_req.suggested_max_uses;
  else
    v_choice:='once'; v_seconds:=86400; v_max:=1;
  end if;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(v_req.user_id,null,'global','owner_grant','owner_grant',v_req.id::text,1,
    jsonb_build_object('receipt_kind','OWNER_GRANT_GIVEN','principal','owner_auto_approve',
      'policy','owner_auto_approve_persistent_v1','setting_version',s.setting_version,'policy_source',s.policy_source,
      'auto_approve_id',s.id,'switch_receipt_id',s.receipt_id,
      'choices',jsonb_build_object('request_id',v_req.id,'action',v_req.action,'resources',to_jsonb(v_req.resources),
        'task_id',v_req.task_id,'choice',v_choice,'expires_seconds',v_seconds,'max_uses',v_max,
        'grantee_binding_id',v_req.binding_id))) returning id into v_receipt;
  insert into clued_private.owner_grants_v1(user_id,grantee_binding_id,action,resources,task_id,max_uses,
    granted_at,expires_at,request_id,token_id,auto_approve_id,receipt_id,granted_session_id)
  values(v_req.user_id,v_req.binding_id,v_req.action,v_req.resources,v_req.task_id,v_max,
    v_now,v_now+make_interval(secs=>v_seconds),v_req.id,null,s.id,v_receipt,s.session_id) returning * into v_grant;
  update clued_private.owner_requests_v1
    set status=case when v_choice='once' then 'approved_once' else 'granted' end,grant_id=v_grant.id,decided_at=v_now
    where id=v_req.id returning * into v_req;
  return v_req;
end $$;

-- Retired timed endpoints fail closed. A stale browser/token cannot silently
-- turn a time-limited confirmation into forever, undo Off, or bypass CAS.
create or replace function public.clued_owner_auto_approve_confirmation_issue_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  perform clued_private.authorization_owner_v12();
  return jsonb_build_object('status','rejected','error_code','owner_auto_approve_successor_required','authoritative',false);
end $$;
create or replace function public.clued_owner_auto_approve_on_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  perform clued_private.authorization_owner_v12();
  return jsonb_build_object('status','rejected','error_code','owner_auto_approve_successor_required','authoritative',false);
end $$;
create or replace function public.clued_owner_auto_approve_off_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  perform clued_private.authorization_owner_v12();
  return jsonb_build_object('status','rejected','error_code','owner_auto_approve_successor_required','authoritative',false);
end $$;

revoke all on function
  clued_private.owner_auto_approve_live_v1(uuid),
  clued_private.owner_auto_approve_public_v1(uuid),
  clued_private.owner_auto_approve_materialize_v1(uuid),
  clued_private.owner_auto_approve_request_v1(clued_private.owner_requests_v1),
  public.clued_owner_auto_approve_set_v1(jsonb),
  public.clued_owner_auto_approve_confirmation_issue_v1(jsonb),
  public.clued_owner_auto_approve_on_v1(jsonb),
  public.clued_owner_auto_approve_off_v1(jsonb)
from public,anon,authenticated,service_role;
grant execute on function public.clued_owner_auto_approve_set_v1(jsonb),
  public.clued_owner_auto_approve_confirmation_issue_v1(jsonb),
  public.clued_owner_auto_approve_on_v1(jsonb),public.clued_owner_auto_approve_off_v1(jsonb) to authenticated;

notify pgrst,'reload schema';
