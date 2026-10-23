-- Resident CI active/standby, C10 (Task bb13efb5; design v0.4 §5.9, Owner
-- Decisions bd86149e and 1c5d34fd): Z1, the Owner hands ci-admission from one
-- Binding to another in one step, and the server keeps the order "end the old
-- holder, wait at least 5 minutes, then the new one" for every path.
--
-- 1. Each role row has a start time (effective_at) and, for ci-admission, a
--    purpose the Owner declares when marking it:
--      resident-node  the connection of a resident executor node;
--      parking        the parking spot: it keeps the role marked and never
--                     admits anyone (effective_at = infinity);
--      other          any other holder, such as the GitHub environment
--                     clued-admission connection;
--      unspecified    rows from before this migration, and release-door rows.
--    Existing rows keep effective_at = granted_at, so nothing changes today.
-- 2. A row admits its Binding only from effective_at on. A row that has not
--    started still marks the role: binding_role_admits_v1 opens a role to every
--    Binding only when it has no row at all, started or not. Every reader that
--    asks "is this Binding the exact holder" (the protected-change Grant door,
--    the guarded verify path, the execution observation and the CI command
--    door) now also asks "has its row started".
-- 3. Handover (two Native steps on /bindings): one transaction ends X's
--    ci-admission row and gives Y a resident-node row that starts 5 minutes
--    later. Parking spots and other holders stay as they are. X must hold the
--    role (live or not) and must not be a parking spot; Y must be live, have
--    context:read and hold no ci-admission row.
-- 4. Marking ci-admission by hand needs a purpose. A resident-node mark is
--    refused while a live Binding already holds a resident-node or unspecified
--    row (review round 4, N4): the conservative reading of an unspecified row
--    keeps the one live holder from before this migration a resident node,
--    and a clued-admission environment connection marked "other" never blocks
--    a resident node. Resident-node and other marks start 5 minutes later.
-- 5. A parking spot's role cannot be ended by hand unless another parking spot
--    holds the role; handover never starts from a parking spot.
-- 6. Rotating a connection moves its rows with their start time and purpose,
--    so a rotation cannot shorten the wait.
--
-- The small role functions are re-created whole. The exact-holder reads (in
-- four functions) and the rotation are anchored patches of the current
-- definitions: each fails unless its anchor occurs exactly once. release-door
-- keeps its behaviour.

alter table clued_private.binding_roles_v1 add column effective_at timestamptz, add column purpose text;
update clued_private.binding_roles_v1 set effective_at=granted_at,purpose='unspecified';
alter table clued_private.binding_roles_v1
  alter column effective_at set not null,
  alter column effective_at set default clock_timestamp(),
  alter column purpose set not null,
  alter column purpose set default 'unspecified',
  add constraint binding_roles_v1_purpose_check
    check (purpose in ('unspecified','resident-node','parking','other')),
  add constraint binding_roles_v1_purpose_role_check check (role='ci-admission' or purpose='unspecified'),
  add constraint binding_roles_v1_parking_check check ((purpose='parking')=(effective_at='infinity')),
  add constraint binding_roles_v1_effective_check check (effective_at>=granted_at);

create function clued_private.binding_role_activation_delay_v1() returns interval
language sql immutable set search_path='' as $$ select interval '5 minutes' $$;

-- True when this Binding holds the role and its row has started, or when the
-- Owner has no row for the role at all (a row that has not started counts).
create or replace function clued_private.binding_role_admits_v1(p_binding public.clued_agent_bindings,p_role text)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from clued_private.binding_roles_v1 r
      where r.binding_id=p_binding.id and r.role=p_role and r.revoked_at is null
        and r.effective_at<=clock_timestamp())
    or not exists(select 1 from clued_private.binding_roles_v1 r
      where r.user_id=p_binding.user_id and r.role=p_role and r.revoked_at is null)
$$;

create function clued_private.binding_role_purpose_title_v1(p_role text,p_purpose text) returns text
language sql immutable set search_path='' as $$
  select case when p_role<>'ci-admission' then null else case p_purpose
    when 'resident-node' then '常驻节点'
    when 'parking' then '停车位（只占住这个用途，永不放行）'
    when 'other' then '其他（例如 GitHub 环境 clued-admission 的连接）'
    when 'unspecified' then '用途未标明（按常驻节点对待）' end end
$$;

-- The Owner's other holders of a role, live or not, started or not.
create function clued_private.binding_role_holders_v1(p_owner uuid,p_role text,p_except uuid[])
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('binding_id',b.id,'agent_name',b.agent_name,'vendor',b.vendor,
      'live',clued_private.binding_live_v1(b),'purpose',r.purpose,
      'purpose_title',clued_private.binding_role_purpose_title_v1(r.role,r.purpose),'effective_at',r.effective_at)
    order by r.granted_at,r.id),'[]'::jsonb)
  from clued_private.binding_roles_v1 r join public.clued_agent_bindings b on b.id=r.binding_id
  where r.user_id=p_owner and r.role=p_role and r.revoked_at is null and not (r.binding_id=any(p_except))
$$;

-- N4: a live Binding other than p_except holds a resident-node or unspecified
-- ci-admission row, started or not.
create function clued_private.binding_role_resident_held_v1(p_owner uuid,p_except uuid[])
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from clued_private.binding_roles_v1 r join public.clued_agent_bindings b on b.id=r.binding_id
    where r.user_id=p_owner and r.role='ci-admission' and r.revoked_at is null
      and r.purpose in ('resident-node','unspecified') and not (r.binding_id=any(p_except))
      and clued_private.binding_live_v1(b))
$$;

-- The rules of a hand change, for both Native steps. Returns the purpose of
-- the row that is marked or ended.
create function clued_private.binding_role_change_check_v1(p_binding public.clued_agent_bindings,p_role text,
  p_enabled boolean,p_purpose jsonb) returns text
language plpgsql stable security definer set search_path='' as $$
declare r clued_private.binding_roles_v1%rowtype;
begin
  select * into r from clued_private.binding_roles_v1 x
    where x.binding_id=p_binding.id and x.role=p_role and x.revoked_at is null;
  if p_enabled=found then raise exception 'binding_role_unchanged' using errcode='22023'; end if;
  if not p_enabled then
    if p_purpose is not null then raise exception 'binding_role_purpose_invalid' using errcode='22023'; end if;
    if r.purpose='parking' and not exists(select 1 from clued_private.binding_roles_v1 x
        where x.user_id=p_binding.user_id and x.role=p_role and x.revoked_at is null
          and x.purpose='parking' and x.id<>r.id) then
      raise exception 'binding_role_parking_protected' using errcode='22023'; end if;
    return r.purpose;
  end if;
  if p_role<>'ci-admission' then
    if p_purpose is not null then raise exception 'binding_role_purpose_invalid' using errcode='22023'; end if;
    return 'unspecified';
  end if;
  if p_purpose is null then raise exception 'binding_role_purpose_required' using errcode='22023'; end if;
  if jsonb_typeof(p_purpose) is distinct from 'string'
      or p_purpose#>>'{}' not in ('resident-node','parking','other') then
    raise exception 'binding_role_purpose_invalid' using errcode='22023'; end if;
  if p_purpose#>>'{}'='resident-node'
      and clued_private.binding_role_resident_held_v1(p_binding.user_id,array[p_binding.id]) then
    raise exception 'binding_role_resident_holder_exists' using errcode='22023'; end if;
  return p_purpose#>>'{}';
end $$;

-- What the Owner confirms for a hand change.
create function clued_private.binding_role_view_v2(p_binding public.clued_agent_bindings,p_role text,
  p_enabled boolean,p_purpose text)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('binding_id',p_binding.id,'agent_name',p_binding.agent_name,'vendor',p_binding.vendor,
    'scopes',to_jsonb(p_binding.scopes),'created_at',p_binding.created_at,'role',p_role,
    'role_title',clued_private.binding_role_title_v1(p_role),'enabled',p_enabled,
    'purpose',p_purpose,'purpose_title',clued_private.binding_role_purpose_title_v1(p_role,p_purpose),
    'activation',case when not p_enabled then 'ends_now' when p_role<>'ci-admission' then 'immediate'
      when p_purpose='parking' then 'never' else 'delayed' end,
    'delay_minutes',case when p_enabled and p_role='ci-admission' and p_purpose<>'parking'
      then (extract(epoch from clued_private.binding_role_activation_delay_v1())/60)::integer end,
    'others',clued_private.binding_role_holders_v1(p_binding.user_id,p_role,array[p_binding.id]))
$$;

-- When a hand change or a handover row starts.
create function clued_private.binding_role_start_v1(p_role text,p_purpose text,p_now timestamptz)
returns timestamptz language sql immutable set search_path='' as $$
  select case when p_role<>'ci-admission' then p_now when p_purpose='parking' then 'infinity'::timestamptz
    else p_now+clued_private.binding_role_activation_delay_v1() end
$$;

-- The Owner's live Bindings and every Binding that still holds a role, with
-- each row's purpose and start.
create or replace function public.clued_binding_roles_list_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12();
begin
  if jsonb_typeof(p_input) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_input)) then
    raise exception 'binding_role_input_invalid' using errcode='22023'; end if;
  return jsonb_build_object('status','ok','observed_at',clock_timestamp(),
    'activation_delay_minutes',(extract(epoch from clued_private.binding_role_activation_delay_v1())/60)::integer,
    'roles',jsonb_build_array(
      jsonb_build_object('role','ci-admission','title',clued_private.binding_role_title_v1('ci-admission'),
        'required_scope','context:read',
        'marked',exists(select 1 from clued_private.binding_roles_v1 r
          where r.user_id=v_owner and r.role='ci-admission' and r.revoked_at is null),
        'parking_count',(select count(*) from clued_private.binding_roles_v1 r
          where r.user_id=v_owner and r.role='ci-admission' and r.revoked_at is null and r.purpose='parking')),
      jsonb_build_object('role','release-door','title',clued_private.binding_role_title_v1('release-door'),
        'required_scope','context:write',
        'marked',exists(select 1 from clued_private.binding_roles_v1 r
          where r.user_id=v_owner and r.role='release-door' and r.revoked_at is null))),
    'purposes',jsonb_build_array(
      jsonb_build_object('purpose','resident-node','title',clued_private.binding_role_purpose_title_v1('ci-admission','resident-node')),
      jsonb_build_object('purpose','parking','title',clued_private.binding_role_purpose_title_v1('ci-admission','parking')),
      jsonb_build_object('purpose','other','title',clued_private.binding_role_purpose_title_v1('ci-admission','other'))),
    'bindings',coalesce((select jsonb_agg(jsonb_build_object('binding_id',b.id,'agent_name',b.agent_name,
        'vendor',b.vendor,'live',clued_private.binding_live_v1(b),'scopes',to_jsonb(b.scopes),'created_at',b.created_at,'last_used_at',b.last_used_at,
        'roles',coalesce((select jsonb_agg(r.role order by r.role) from clued_private.binding_roles_v1 r
          where r.binding_id=b.id and r.revoked_at is null),'[]'::jsonb),
        'role_details',coalesce((select jsonb_agg(jsonb_build_object('role',r.role,'purpose',r.purpose,
            'purpose_title',clued_private.binding_role_purpose_title_v1(r.role,r.purpose),
            'granted_at',r.granted_at,'effective_at',r.effective_at,'in_force',r.effective_at<=clock_timestamp())
            order by r.role)
          from clued_private.binding_roles_v1 r where r.binding_id=b.id and r.revoked_at is null),'[]'::jsonb))
        order by b.created_at desc)
      from public.clued_agent_bindings b where b.user_id=v_owner and (clued_private.binding_live_v1(b)
        or exists(select 1 from clued_private.binding_roles_v1 r where r.binding_id=b.id and r.revoked_at is null))),'[]'::jsonb));
end $$;

-- Step 1 of a hand change. Input {binding_id, role, enabled, purpose}; purpose
-- is required when marking ci-admission and refused otherwise.
create or replace function public.clued_binding_role_confirmation_issue_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); b public.clued_agent_bindings%rowtype;
  v_role text; v_enabled boolean; v_purpose text; v_view jsonb; v_digest text; v_raw text; v_token_id uuid;
  v_expires timestamptz; v_now timestamptz; v_error text; v_subject text;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if clued_private.native_session_id_v1() is null then
    return jsonb_build_object('status','rejected','error_code','confirmation_token_session_id_required','authoritative',false);
  end if;
  begin
    if jsonb_typeof(p_input) is distinct from 'object'
        or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('binding_id','role','enabled','purpose')) then
      raise exception 'binding_role_input_invalid' using errcode='22023'; end if;
    if coalesce(p_input->>'binding_id','') !~* '^[0-9a-f-]{36}$' then
      raise exception 'binding_role_binding_invalid' using errcode='22023'; end if;
    v_role:=p_input->>'role';
    if v_role is null or v_role not in ('ci-admission','release-door') then
      raise exception 'binding_role_invalid' using errcode='22023'; end if;
    if jsonb_typeof(p_input->'enabled') is distinct from 'boolean' then
      raise exception 'binding_role_input_invalid' using errcode='22023'; end if;
    v_enabled:=(p_input->>'enabled')::boolean;
    select * into b from public.clued_agent_bindings x where x.id=(p_input->>'binding_id')::uuid and x.user_id=v_owner;
    if not found or (v_enabled and not clued_private.binding_live_v1(b)) then
      raise exception 'binding_role_binding_invalid' using errcode='22023'; end if;
    if v_enabled and not ((case v_role when 'ci-admission' then 'context:read' else 'context:write' end)=any(b.scopes)) then
      raise exception 'binding_role_scope_missing' using errcode='22023'; end if;
    v_purpose:=clued_private.binding_role_change_check_v1(b,v_role,v_enabled,p_input->'purpose');
    v_view:=clued_private.binding_role_view_v2(b,v_role,v_enabled,v_purpose);
    v_digest:=clued_private.m1_sha256(v_view);
    v_subject:=b.id::text||':'||v_role;
    update clued_private.native_confirmation_tokens set revoked_at=clock_timestamp()
      where user_id=v_owner and action='binding_role' and subject_key=v_subject and consumed_at is null and revoked_at is null;
    v_raw:='clued_brl_'||encode(extensions.gen_random_bytes(32),'hex');
    v_now:=clock_timestamp();
    insert into clued_private.native_confirmation_tokens(user_id,action,subject_key,subject_version,native_choices,
      confirmation_view,view_digest,token_hash,session_id,auth_time,issued_at,expires_at)
    values(v_owner,'binding_role',v_subject,0,
      jsonb_build_object('binding_id',b.id,'role',v_role,'enabled',v_enabled)
        ||case when p_input ? 'purpose' then jsonb_build_object('purpose',p_input->'purpose') else '{}'::jsonb end,
      v_view,v_digest,
      encode(extensions.digest(convert_to(v_raw,'UTF8'),'sha256'),'hex'),clued_private.native_session_id_v1(),
      coalesce(clued_private.native_auth_time_v1(),v_now),v_now,v_now+interval '5 minutes')
    returning id,expires_at into v_token_id,v_expires;
    return jsonb_build_object('status','issued','confirmation_token',v_raw,'token_id',v_token_id,'expires_at',v_expires,
      'confirmation_view',v_view,'view_digest',v_digest,'authoritative',false);
  exception when sqlstate '22023' or sqlstate '23514' or sqlstate '42501' or sqlstate '55000' then
    get stacked diagnostics v_error=message_text;
    return jsonb_build_object('status','rejected','error_code',v_error,'authoritative',false);
  end;
end $$;

-- Step 2 of a hand change: consume the token, re-check the rules under the
-- role's lock, re-render the view, then mark or end the role.
create or replace function public.clued_binding_role_set_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_token clued_private.native_confirmation_tokens%rowtype;
  v_token_id uuid; v_hash text; b public.clued_agent_bindings%rowtype; v_receipt uuid; v_now timestamptz;
  v_error text; v_state text; c jsonb; v_role text; v_enabled boolean; v_purpose text; v_start timestamptz;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  begin
    if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('confirmation_token','view_digest')) then
      raise exception 'binding_role_input_invalid' using errcode='22023'; end if;
    if jsonb_typeof(p_input->'confirmation_token') is distinct from 'string' then
      raise exception 'confirmation_token_required' using errcode='42501'; end if;
    v_hash:=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex');
    select * into v_token from clued_private.native_confirmation_tokens t
      where t.user_id=v_owner and t.action='binding_role' and t.token_hash=v_hash for update;
    if not found then raise exception 'confirmation_token_invalid' using errcode='42501'; end if;
    if v_token.consume_outcome='committed' then
      return jsonb_build_object('status','committed','replayed',true,'receipt_id',v_token.consumed_receipt_id,
        'binding_id',v_token.native_choices->>'binding_id','role',v_token.native_choices->>'role',
        'enabled',(v_token.native_choices->>'enabled')::boolean)
        ||coalesce((select jsonb_build_object('purpose',r.metadata->'purpose','effective_at',r.metadata->'effective_at')
          from public.clued_audit_receipts r where r.id=v_token.consumed_receipt_id),'{}'::jsonb);
    end if;
    if v_token.consumed_at is not null then raise exception 'confirmation_token_reused' using errcode='42501'; end if;
    if v_token.revoked_at is not null then raise exception 'confirmation_token_revoked' using errcode='42501'; end if;
    v_token_id:=v_token.id;
    if v_token.expires_at<=clock_timestamp() then raise exception 'confirmation_token_expired' using errcode='42501'; end if;
    if v_token.issued_xact=pg_current_xact_id() then raise exception 'confirmation_token_same_request' using errcode='42501'; end if;
    if coalesce(p_input->>'view_digest','')<>v_token.view_digest
      or v_token.session_id is null or clued_private.native_session_id_v1() is null
      or v_token.session_id<>clued_private.native_session_id_v1() then
      raise exception 'confirmation_token_binding_mismatch' using errcode='42501'; end if;
    c:=v_token.native_choices;
    v_role:=c->>'role'; v_enabled:=(c->>'enabled')::boolean;
    -- One change of a role at a time, so two resident-node marks or a mark and
    -- a handover cannot both pass the N4 check.
    perform pg_advisory_xact_lock(hashtextextended('clued-binding-role:'||v_owner::text||':'||v_role,0));
    select * into b from public.clued_agent_bindings x where x.id=(c->>'binding_id')::uuid and x.user_id=v_owner for update;
    if not found or (v_enabled and not clued_private.binding_live_v1(b)) then
      raise exception 'binding_role_binding_invalid' using errcode='22023'; end if;
    v_purpose:=clued_private.binding_role_change_check_v1(b,v_role,v_enabled,c->'purpose');
    if clued_private.m1_sha256(clued_private.binding_role_view_v2(b,v_role,v_enabled,v_purpose))<>v_token.view_digest then
      raise exception 'confirmation_view_stale' using errcode='40001'; end if;
    v_now:=clock_timestamp();
    v_start:=case when v_enabled then clued_private.binding_role_start_v1(v_role,v_purpose,v_now) end;
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(v_owner,null,'global','binding_role_set','binding_role',b.id::text||':'||v_role,1,
      jsonb_build_object('receipt_kind',case when v_enabled then 'BINDING_ROLE_GRANTED' else 'BINDING_ROLE_ENDED' end,
        'binding_id',b.id,'role',v_role,'purpose',v_purpose,'effective_at',v_start,
        'token_id',v_token.id,'view_digest',v_token.view_digest,
        'session_id',v_token.session_id,'principal','native_account_session'))
    returning id into v_receipt;
    if v_enabled then
      insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
      values(v_owner,b.id,v_role,v_now,v_receipt,v_start,v_purpose);
    else
      update clued_private.binding_roles_v1 set revoked_at=v_now,revoked_receipt_id=v_receipt
        where binding_id=b.id and role=v_role and revoked_at is null;
      if not found then raise exception 'binding_role_unchanged' using errcode='22023'; end if;
    end if;
    update clued_private.native_confirmation_tokens set consumed_at=v_now,consumed_receipt_id=v_receipt,
      consume_outcome='committed' where id=v_token.id;
    return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,
      'binding_id',b.id,'role',v_role,'enabled',v_enabled,'purpose',v_purpose,'effective_at',v_start);
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    -- Single use: a presented live token is burned by any failed attempt.
    if v_token_id is not null then
      insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values(v_owner,null,'global','binding_role_set','binding_role',v_token.subject_key,1,
        jsonb_build_object('receipt_kind','BINDING_ROLE_REJECTED','token_id',v_token_id,'error_code',v_error))
      returning id into v_receipt;
      update clued_private.native_confirmation_tokens set consumed_at=clock_timestamp(),consumed_receipt_id=v_receipt,
        consume_outcome='rejected' where id=v_token_id and consumed_at is null and revoked_at is null;
    end if;
    return jsonb_build_object('status',case when v_state in ('22023','23514','40001','42501','55000')
      then 'rejected' else 'failed' end,'error_code',v_error,'authoritative',false);
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Handover of ci-admission from X to Y.

create function clued_private.binding_role_handover_check_v1(p_from public.clued_agent_bindings,
  p_to public.clued_agent_bindings) returns void
language plpgsql stable security definer set search_path='' as $$
declare v_purpose text;
begin
  select r.purpose into v_purpose from clued_private.binding_roles_v1 r
    where r.binding_id=p_from.id and r.role='ci-admission' and r.revoked_at is null;
  if not found then raise exception 'binding_role_handover_source_invalid' using errcode='22023'; end if;
  if v_purpose='parking' then raise exception 'binding_role_parking_protected' using errcode='22023'; end if;
  if p_to.id=p_from.id or not clued_private.binding_live_v1(p_to) then
    raise exception 'binding_role_handover_target_invalid' using errcode='22023'; end if;
  if not ('context:read'=any(p_to.scopes)) then raise exception 'binding_role_scope_missing' using errcode='22023'; end if;
  if exists(select 1 from clued_private.binding_roles_v1 r
      where r.binding_id=p_to.id and r.role='ci-admission' and r.revoked_at is null) then
    raise exception 'binding_role_handover_target_holds_role' using errcode='22023'; end if;
  if clued_private.binding_role_resident_held_v1(p_from.user_id,array[p_from.id,p_to.id]) then
    raise exception 'binding_role_resident_holder_exists' using errcode='22023'; end if;
end $$;

create function clued_private.binding_role_handover_view_v1(p_from public.clued_agent_bindings,
  p_to public.clued_agent_bindings) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('kind','binding_role_handover','role','ci-admission',
    'role_title',clued_private.binding_role_title_v1('ci-admission'),
    'from',(select jsonb_build_object('binding_id',p_from.id,'agent_name',p_from.agent_name,'vendor',p_from.vendor,
        'live',clued_private.binding_live_v1(p_from),'purpose',r.purpose,
        'purpose_title',clued_private.binding_role_purpose_title_v1(r.role,r.purpose),'effective_at',r.effective_at)
      from clued_private.binding_roles_v1 r
      where r.binding_id=p_from.id and r.role='ci-admission' and r.revoked_at is null),
    'to',jsonb_build_object('binding_id',p_to.id,'agent_name',p_to.agent_name,'vendor',p_to.vendor,
      'scopes',to_jsonb(p_to.scopes),'created_at',p_to.created_at,'purpose','resident-node',
      'purpose_title',clued_private.binding_role_purpose_title_v1('ci-admission','resident-node')),
    'delay_minutes',(extract(epoch from clued_private.binding_role_activation_delay_v1())/60)::integer,
    'others',clued_private.binding_role_holders_v1(p_from.user_id,'ci-admission',array[p_from.id,p_to.id]))
$$;

-- Step 1. Input {from_binding_id, to_binding_id}. A newer issue revokes the
-- older outstanding handover token.
create function public.clued_binding_role_handover_confirmation_issue_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); f public.clued_agent_bindings%rowtype;
  t public.clued_agent_bindings%rowtype; v_view jsonb; v_digest text; v_raw text; v_token_id uuid;
  v_expires timestamptz; v_now timestamptz; v_error text;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if clued_private.native_session_id_v1() is null then
    return jsonb_build_object('status','rejected','error_code','confirmation_token_session_id_required','authoritative',false);
  end if;
  begin
    if jsonb_typeof(p_input) is distinct from 'object'
        or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('from_binding_id','to_binding_id')) then
      raise exception 'binding_role_handover_input_invalid' using errcode='22023'; end if;
    if jsonb_typeof(p_input->'from_binding_id') is distinct from 'string'
        or p_input->>'from_binding_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'binding_role_handover_source_invalid' using errcode='22023'; end if;
    if jsonb_typeof(p_input->'to_binding_id') is distinct from 'string'
        or p_input->>'to_binding_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'binding_role_handover_target_invalid' using errcode='22023'; end if;
    select * into f from public.clued_agent_bindings x where x.id=(p_input->>'from_binding_id')::uuid and x.user_id=v_owner;
    if not found then raise exception 'binding_role_handover_source_invalid' using errcode='22023'; end if;
    select * into t from public.clued_agent_bindings x where x.id=(p_input->>'to_binding_id')::uuid and x.user_id=v_owner;
    if not found then raise exception 'binding_role_handover_target_invalid' using errcode='22023'; end if;
    perform clued_private.binding_role_handover_check_v1(f,t);
    v_view:=clued_private.binding_role_handover_view_v1(f,t);
    v_digest:=clued_private.m1_sha256(v_view);
    update clued_private.native_confirmation_tokens set revoked_at=clock_timestamp()
      where user_id=v_owner and action='binding_role_handover' and subject_key='handover:ci-admission'
        and consumed_at is null and revoked_at is null;
    v_raw:='clued_brh_'||encode(extensions.gen_random_bytes(32),'hex');
    v_now:=clock_timestamp();
    insert into clued_private.native_confirmation_tokens(user_id,action,subject_key,subject_version,native_choices,
      confirmation_view,view_digest,token_hash,session_id,auth_time,issued_at,expires_at)
    values(v_owner,'binding_role_handover','handover:ci-admission',0,
      jsonb_build_object('from_binding_id',f.id,'to_binding_id',t.id,'role','ci-admission'),v_view,v_digest,
      encode(extensions.digest(convert_to(v_raw,'UTF8'),'sha256'),'hex'),clued_private.native_session_id_v1(),
      coalesce(clued_private.native_auth_time_v1(),v_now),v_now,v_now+interval '5 minutes')
    returning id,expires_at into v_token_id,v_expires;
    return jsonb_build_object('status','issued','confirmation_token',v_raw,'token_id',v_token_id,'expires_at',v_expires,
      'confirmation_view',v_view,'view_digest',v_digest,'authoritative',false);
  exception when sqlstate '22023' or sqlstate '23514' or sqlstate '42501' or sqlstate '55000' then
    get stacked diagnostics v_error=message_text;
    return jsonb_build_object('status','rejected','error_code',v_error,'authoritative',false);
  end;
end $$;

-- Step 2. In one transaction: end X's row, give Y a resident-node row that
-- starts after the activation delay. Nothing else changes.
create function public.clued_binding_role_handover_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_token clued_private.native_confirmation_tokens%rowtype;
  v_token_id uuid; v_hash text; f public.clued_agent_bindings%rowtype; t public.clued_agent_bindings%rowtype;
  v_receipt uuid; v_now timestamptz; v_start timestamptz; v_error text; v_state text; c jsonb;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  begin
    if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('confirmation_token','view_digest')) then
      raise exception 'binding_role_handover_input_invalid' using errcode='22023'; end if;
    if jsonb_typeof(p_input->'confirmation_token') is distinct from 'string' then
      raise exception 'confirmation_token_required' using errcode='42501'; end if;
    v_hash:=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex');
    select * into v_token from clued_private.native_confirmation_tokens x
      where x.user_id=v_owner and x.action='binding_role_handover' and x.token_hash=v_hash for update;
    if not found then raise exception 'confirmation_token_invalid' using errcode='42501'; end if;
    if v_token.consume_outcome='committed' then
      return jsonb_build_object('status','committed','replayed',true,'receipt_id',v_token.consumed_receipt_id,
        'from_binding_id',v_token.native_choices->>'from_binding_id','to_binding_id',v_token.native_choices->>'to_binding_id',
        'role','ci-admission','effective_at',(select r.metadata->'effective_at' from public.clued_audit_receipts r
          where r.id=v_token.consumed_receipt_id));
    end if;
    if v_token.consumed_at is not null then raise exception 'confirmation_token_reused' using errcode='42501'; end if;
    if v_token.revoked_at is not null then raise exception 'confirmation_token_revoked' using errcode='42501'; end if;
    v_token_id:=v_token.id;
    if v_token.expires_at<=clock_timestamp() then raise exception 'confirmation_token_expired' using errcode='42501'; end if;
    if v_token.issued_xact=pg_current_xact_id() then raise exception 'confirmation_token_same_request' using errcode='42501'; end if;
    if coalesce(p_input->>'view_digest','')<>v_token.view_digest
      or v_token.session_id is null or clued_private.native_session_id_v1() is null
      or v_token.session_id<>clued_private.native_session_id_v1() then
      raise exception 'confirmation_token_binding_mismatch' using errcode='42501'; end if;
    c:=v_token.native_choices;
    perform pg_advisory_xact_lock(hashtextextended('clued-binding-role:'||v_owner::text||':ci-admission',0));
    perform 1 from public.clued_agent_bindings x where x.user_id=v_owner
      and x.id in ((c->>'from_binding_id')::uuid,(c->>'to_binding_id')::uuid) order by x.id for update;
    select * into f from public.clued_agent_bindings x where x.id=(c->>'from_binding_id')::uuid and x.user_id=v_owner;
    if not found then raise exception 'binding_role_handover_source_invalid' using errcode='22023'; end if;
    select * into t from public.clued_agent_bindings x where x.id=(c->>'to_binding_id')::uuid and x.user_id=v_owner;
    if not found then raise exception 'binding_role_handover_target_invalid' using errcode='22023'; end if;
    perform clued_private.binding_role_handover_check_v1(f,t);
    if clued_private.m1_sha256(clued_private.binding_role_handover_view_v1(f,t))<>v_token.view_digest then
      raise exception 'confirmation_view_stale' using errcode='40001'; end if;
    v_now:=clock_timestamp();
    v_start:=clued_private.binding_role_start_v1('ci-admission','resident-node',v_now);
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(v_owner,null,'global','binding_role_handover','binding_role',t.id::text||':ci-admission',1,
      jsonb_build_object('receipt_kind','BINDING_ROLE_HANDED_OVER','role','ci-admission',
        'from_binding_id',f.id,'to_binding_id',t.id,'purpose','resident-node','effective_at',v_start,
        'token_id',v_token.id,'view_digest',v_token.view_digest,
        'session_id',v_token.session_id,'principal','native_account_session'))
    returning id into v_receipt;
    update clued_private.binding_roles_v1 set revoked_at=v_now,revoked_receipt_id=v_receipt
      where binding_id=f.id and role='ci-admission' and revoked_at is null;
    if not found then raise exception 'binding_role_handover_source_invalid' using errcode='22023'; end if;
    insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
    values(v_owner,t.id,'ci-admission',v_now,v_receipt,v_start,'resident-node');
    update clued_private.native_confirmation_tokens set consumed_at=v_now,consumed_receipt_id=v_receipt,
      consume_outcome='committed' where id=v_token.id;
    return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,'role','ci-admission',
      'from_binding_id',f.id,'to_binding_id',t.id,'effective_at',v_start);
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    -- Single use: a presented live token is burned by any failed attempt.
    if v_token_id is not null then
      insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values(v_owner,null,'global','binding_role_handover','binding_role',v_token.subject_key,1,
        jsonb_build_object('receipt_kind','BINDING_ROLE_HANDOVER_REJECTED','token_id',v_token_id,'error_code',v_error))
      returning id into v_receipt;
      update clued_private.native_confirmation_tokens set consumed_at=clock_timestamp(),consumed_receipt_id=v_receipt,
        consume_outcome='rejected' where id=v_token_id and consumed_at is null and revoked_at is null;
    end if;
    return jsonb_build_object('status',case when v_state in ('22023','23514','40001','42501','55000')
      then 'rejected' else 'failed' end,'error_code',v_error,'authoritative',false);
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Exact-holder reads and rotation: anchored patches of the current definitions.

-- A function that is absent, or that has no direct read of the table (an
-- earlier body that asks binding_role_admits_v1 instead), has nothing to
-- patch; some database tests install such earlier bodies on purpose. A
-- function that reads the table directly must contain the anchor exactly once.
create function clued_private.ci_admission_handover_patch_v1(p_signature text,p_anchor text,p_replacement text)
returns void language plpgsql set search_path='' as $$
declare target regprocedure:=to_regprocedure(p_signature); body text;
begin
  if target is null then
    raise notice 'ci_admission_handover_patch_skipped: % (absent)',p_signature; return; end if;
  body:=pg_get_functiondef(target);
  if position('clued_private.binding_roles_v1' in body)=0 then
    raise notice 'ci_admission_handover_patch_skipped: % (no direct read)',p_signature; return; end if;
  if (length(body)-length(replace(body,p_anchor,'')))<>length(p_anchor) then
    raise exception 'ci_admission_handover_patch_anchor_mismatch: %',p_signature;
  end if;
  execute replace(body,p_anchor,p_replacement);
end $$;

-- The protected-change Grant door (20261005140000 item 4).
select clued_private.ci_admission_handover_patch_v1('public.clued_owner_grant_admission_door_v1(text,jsonb)',
$a$  if not exists(select 1 from clued_private.binding_roles_v1 r
      where r.binding_id=v_binding.id and r.role='ci-admission' and r.revoked_at is null) then$a$,
$r$  if not exists(select 1 from clued_private.binding_roles_v1 r
      where r.binding_id=v_binding.id and r.role='ci-admission' and r.revoked_at is null
        and r.effective_at<=clock_timestamp()) then$r$);

-- The guarded verify path (20261011131755): admission and its footprint.
select clued_private.ci_admission_handover_patch_v1('public.clued_work_verify_v1(text,jsonb)',
$a$    if not exists(select 1 from clued_private.binding_roles_v1 where binding_id=b.id
        and user_id=b.user_id and role='ci-admission' and revoked_at is null) then$a$,
$r$    if not exists(select 1 from clued_private.binding_roles_v1 where binding_id=b.id
        and user_id=b.user_id and role='ci-admission' and revoked_at is null
        and effective_at<=clock_timestamp()) then$r$);
select clued_private.ci_admission_handover_patch_v1('public.clued_work_verify_v1(text,jsonb)',
$a$    and exists(select 1 from clued_private.binding_roles_v1 where user_id=b.user_id and binding_id=b.id
      and role='ci-admission' and revoked_at is null) then$a$,
$r$    and exists(select 1 from clued_private.binding_roles_v1 where user_id=b.user_id and binding_id=b.id
      and role='ci-admission' and revoked_at is null and effective_at<=clock_timestamp()) then$r$);

-- The execution observation (20261012114500, which replaced 20261011131755's).
select clued_private.ci_admission_handover_patch_v1('clued_private.work_claim_execution_current_v1(jsonb)',
$a$      if not exists(select 1 from clued_private.binding_roles_v1 r where r.user_id=c.user_id
          and r.binding_id=ci.id and r.role='ci-admission' and r.revoked_at is null) then continue; end if;$a$,
$r$      if not exists(select 1 from clued_private.binding_roles_v1 r where r.user_id=c.user_id
          and r.binding_id=ci.id and r.role='ci-admission' and r.revoked_at is null
          and r.effective_at<=clock_timestamp()) then continue; end if;$r$);

-- The CI command door (20261011131755).
select clued_private.ci_admission_handover_patch_v1('clued_private.work_claim_ci_command_v1(text,jsonb)',
$a$  if not exists(select 1 from clued_private.binding_roles_v1 r where r.user_id=b.user_id
      and r.binding_id=b.id and r.role='ci-admission' and r.revoked_at is null) then$a$,
$r$  if not exists(select 1 from clued_private.binding_roles_v1 r where r.user_id=b.user_id
      and r.binding_id=b.id and r.role='ci-admission' and r.revoked_at is null
      and r.effective_at<=clock_timestamp()) then$r$);

-- Rotation (20261004120000): a moved row keeps its start and purpose.
select clued_private.ci_admission_handover_patch_v1('public.clued_headless_binding_issue_v1(jsonb)',
$a$      with ended as (
        update clued_private.binding_roles_v1 set revoked_at=v_now,revoked_receipt_id=v_receipt
          where binding_id=old_b.id and revoked_at is null returning role)
      select coalesce(array_agg(role order by role),array[]::text[]) into v_roles from ended;
      insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id)
        select v_owner,v_new,r,v_now,v_receipt from unnest(v_roles) r;$a$,
$r$      with ended as (
        update clued_private.binding_roles_v1 set revoked_at=v_now,revoked_receipt_id=v_receipt
          where binding_id=old_b.id and revoked_at is null returning role,effective_at,purpose),
      moved as (
        insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
          select v_owner,v_new,e.role,v_now,v_receipt,greatest(e.effective_at,v_now),e.purpose from ended e
          returning role)
      select coalesce(array_agg(role order by role),array[]::text[]) into v_roles from moved;$r$);

drop function clued_private.ci_admission_handover_patch_v1(text,text,text);

-- Fail closed on drift: in each exact-holder reader, every direct read of the
-- table must now ask whether the row has started. An extra read that the
-- anchors did not cover stops the migration.
do $started$
declare s text; body text; reads integer; started integer;
begin
  foreach s in array array['public.clued_owner_grant_admission_door_v1(text,jsonb)',
      'public.clued_work_verify_v1(text,jsonb)','clued_private.work_claim_execution_current_v1(jsonb)',
      'clued_private.work_claim_ci_command_v1(text,jsonb)'] loop
    select p.prosrc into body from pg_proc p where p.oid=to_regprocedure(s);
    if body is null then continue; end if;
    reads:=(length(body)-length(replace(body,'clued_private.binding_roles_v1','')))/length('clued_private.binding_roles_v1');
    started:=(length(body)-length(replace(body,'effective_at<=clock_timestamp()','')))/length('effective_at<=clock_timestamp()');
    if reads<>started then raise exception 'ci_admission_handover_unpatched_role_read: % (% reads, % started)',s,reads,started; end if;
  end loop;
end $started$;

-- The view of the earlier hand change; nothing calls it any more.
drop function clued_private.binding_role_view_v1(public.clued_agent_bindings,text,boolean);

revoke all on function clued_private.binding_role_activation_delay_v1(),
  clued_private.binding_role_purpose_title_v1(text,text),
  clued_private.binding_role_holders_v1(uuid,text,uuid[]),
  clued_private.binding_role_resident_held_v1(uuid,uuid[]),
  clued_private.binding_role_change_check_v1(public.clued_agent_bindings,text,boolean,jsonb),
  clued_private.binding_role_view_v2(public.clued_agent_bindings,text,boolean,text),
  clued_private.binding_role_start_v1(text,text,timestamptz),
  clued_private.binding_role_handover_check_v1(public.clued_agent_bindings,public.clued_agent_bindings),
  clued_private.binding_role_handover_view_v1(public.clued_agent_bindings,public.clued_agent_bindings)
from public,anon,authenticated,service_role;
revoke all on function public.clued_binding_role_handover_confirmation_issue_v1(jsonb),
  public.clued_binding_role_handover_v1(jsonb)
from public,anon,authenticated,service_role;
grant execute on function public.clued_binding_role_handover_confirmation_issue_v1(jsonb),
  public.clued_binding_role_handover_v1(jsonb) to authenticated;

notify pgrst,'reload schema';
