-- Work Claim admission re-review 2 (Task 869d2db7), finding A: the role
-- checks failed open. clued_private.binding_role_admits_v1 let every Binding
-- through again as soon as the marked Binding was revoked or expired, so a
-- token rotation or an expiry silently reopened N1, N2 and N5.
--
-- Now a role stays locked from the moment the Owner first marks it until the
-- Owner ends it explicitly on /bindings (the two Native steps), whether or not
-- the Binding holding it is still live. A revoked or expired holder can no
-- longer act (its token is refused), and no other Binding can act for it
-- either. The Owner then marks a new live Binding, or ends the role. Only a
-- role the Owner never marked, or ended for every Binding, keeps the earlier
-- open behaviour.
--
-- To let the Owner end the role of a Binding that is no longer live, the
-- list shows every Binding holding a live role (with live=false when it is
-- revoked or expired), and the two Native steps accept such a Binding for
-- ending a role (enabled=false) only; marking still needs a live Binding.

create or replace function clued_private.binding_role_admits_v1(p_binding public.clued_agent_bindings,p_role text)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from clued_private.binding_roles_v1 r
      where r.binding_id=p_binding.id and r.role=p_role and r.revoked_at is null)
    or not exists(select 1 from clued_private.binding_roles_v1 r
      where r.user_id=p_binding.user_id and r.role=p_role and r.revoked_at is null)
$$;

-- What the Owner confirms; other holders are listed whether live or not.
create or replace function clued_private.binding_role_view_v1(p_binding public.clued_agent_bindings,p_role text,p_enabled boolean)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('binding_id',p_binding.id,'agent_name',p_binding.agent_name,'vendor',p_binding.vendor,
    'scopes',to_jsonb(p_binding.scopes),'created_at',p_binding.created_at,'role',p_role,
    'role_title',clued_private.binding_role_title_v1(p_role),'enabled',p_enabled,
    'others',coalesce((select jsonb_agg(jsonb_build_object('binding_id',b.id,'agent_name',b.agent_name,'vendor',b.vendor,
          'live',clued_private.binding_live_v1(b))
        order by r.granted_at)
      from clued_private.binding_roles_v1 r join public.clued_agent_bindings b on b.id=r.binding_id
      where r.user_id=p_binding.user_id and r.role=p_role and r.revoked_at is null and r.binding_id<>p_binding.id),'[]'::jsonb))
$$;

-- The Owner's live Bindings and every Binding that still holds a role.
create or replace function public.clued_binding_roles_list_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12();
begin
  if jsonb_typeof(p_input) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_input)) then
    raise exception 'binding_role_input_invalid' using errcode='22023'; end if;
  return jsonb_build_object('status','ok',
    'roles',jsonb_build_array(
      jsonb_build_object('role','ci-admission','title',clued_private.binding_role_title_v1('ci-admission'),
        'required_scope','context:read'),
      jsonb_build_object('role','release-door','title',clued_private.binding_role_title_v1('release-door'),
        'required_scope','context:write')),
    'bindings',coalesce((select jsonb_agg(jsonb_build_object('binding_id',b.id,'agent_name',b.agent_name,
        'vendor',b.vendor,'live',clued_private.binding_live_v1(b),'scopes',to_jsonb(b.scopes),'created_at',b.created_at,'last_used_at',b.last_used_at,
        'roles',coalesce((select jsonb_agg(r.role order by r.role) from clued_private.binding_roles_v1 r
          where r.binding_id=b.id and r.revoked_at is null),'[]'::jsonb)) order by b.created_at desc)
      from public.clued_agent_bindings b where b.user_id=v_owner and (clued_private.binding_live_v1(b)
        or exists(select 1 from clued_private.binding_roles_v1 r where r.binding_id=b.id and r.revoked_at is null))),'[]'::jsonb));
end $$;

-- Step 1. Ending a role is allowed for a Binding that is no longer live.
create or replace function public.clued_binding_role_confirmation_issue_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); b public.clued_agent_bindings%rowtype;
  v_role text; v_enabled boolean; v_view jsonb; v_digest text; v_raw text; v_token_id uuid;
  v_expires timestamptz; v_now timestamptz; v_error text; v_subject text;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if clued_private.native_session_id_v1() is null then
    return jsonb_build_object('status','rejected','error_code','confirmation_token_session_id_required','authoritative',false);
  end if;
  begin
    if jsonb_typeof(p_input) is distinct from 'object'
        or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('binding_id','role','enabled')) then
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
    if v_enabled=exists(select 1 from clued_private.binding_roles_v1 r
        where r.binding_id=b.id and r.role=v_role and r.revoked_at is null) then
      raise exception 'binding_role_unchanged' using errcode='22023'; end if;
    v_view:=clued_private.binding_role_view_v1(b,v_role,v_enabled);
    v_digest:=clued_private.m1_sha256(v_view);
    v_subject:=b.id::text||':'||v_role;
    update clued_private.native_confirmation_tokens set revoked_at=clock_timestamp()
      where user_id=v_owner and action='binding_role' and subject_key=v_subject and consumed_at is null and revoked_at is null;
    v_raw:='clued_brl_'||encode(extensions.gen_random_bytes(32),'hex');
    v_now:=clock_timestamp();
    insert into clued_private.native_confirmation_tokens(user_id,action,subject_key,subject_version,native_choices,
      confirmation_view,view_digest,token_hash,session_id,auth_time,issued_at,expires_at)
    values(v_owner,'binding_role',v_subject,0,
      jsonb_build_object('binding_id',b.id,'role',v_role,'enabled',v_enabled),v_view,v_digest,
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

-- Step 2. Same rule as step 1.
create or replace function public.clued_binding_role_set_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_token clued_private.native_confirmation_tokens%rowtype;
  v_token_id uuid; v_hash text; b public.clued_agent_bindings%rowtype; v_receipt uuid; v_now timestamptz;
  v_error text; v_state text; c jsonb; v_role text; v_enabled boolean;
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
        'enabled',(v_token.native_choices->>'enabled')::boolean);
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
    select * into b from public.clued_agent_bindings x where x.id=(c->>'binding_id')::uuid and x.user_id=v_owner for update;
    if not found or (v_enabled and not clued_private.binding_live_v1(b)) then
      raise exception 'binding_role_binding_invalid' using errcode='22023'; end if;
    if clued_private.m1_sha256(clued_private.binding_role_view_v1(b,v_role,v_enabled))<>v_token.view_digest then
      raise exception 'confirmation_view_stale' using errcode='40001'; end if;
    v_now:=clock_timestamp();
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(v_owner,null,'global','binding_role_set','binding_role',b.id::text||':'||v_role,1,
      jsonb_build_object('receipt_kind',case when v_enabled then 'BINDING_ROLE_GRANTED' else 'BINDING_ROLE_ENDED' end,
        'binding_id',b.id,'role',v_role,'token_id',v_token.id,'view_digest',v_token.view_digest,
        'session_id',v_token.session_id,'principal','native_account_session'))
    returning id into v_receipt;
    if v_enabled then
      insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id)
      values(v_owner,b.id,v_role,v_now,v_receipt);
    else
      update clued_private.binding_roles_v1 set revoked_at=v_now,revoked_receipt_id=v_receipt
        where binding_id=b.id and role=v_role and revoked_at is null;
      if not found then raise exception 'binding_role_unchanged' using errcode='22023'; end if;
    end if;
    update clued_private.native_confirmation_tokens set consumed_at=v_now,consumed_receipt_id=v_receipt,
      consume_outcome='committed' where id=v_token.id;
    return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,
      'binding_id',b.id,'role',v_role,'enabled',v_enabled);
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

-- The re-created list is VOLATILE like its predecessor (20261003230000):
-- PostgREST runs a STABLE RPC read-only, and the Native owner check locks.
notify pgrst, 'reload schema';
