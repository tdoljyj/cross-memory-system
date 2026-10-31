-- Heartbeat-only connections: the scope ci:heartbeat (Task f2e9a8c6;
-- work/independent-ci-resident-v1/DESIGN.md §41.6a "专用心跳").
--
-- A resident node's companion sends heartbeats with a token that can do
-- nothing else: it reads no context, writes nothing, sees no audit, and no
-- existing interface accepts it. Only the Owner issues one, on the signed-in
-- headless page (/oauth/connections), in two Native steps; OAuth never offers
-- it (clued_authorization_prepare_v12 keeps refusing any scope outside
-- context:read, context:write, audit:read, and the Worker's SCOPES list is
-- unchanged).
--
-- 1. Scope. ci:heartbeat joins the closed scope list of
--    clued_agent_bindings_scopes_check, and only alone: a connection carrying
--    it carries nothing else, so no later widening (an Owner reduce, a
--    permission request, a rotation) can mix it with a context scope.
-- 2. Authorization model. A heartbeat connection is an ordinary headless v12
--    authorization (expiry, listing, revocation by clued_authorization_manage_v12
--    and the expiry sweep) with no entries at all: ci:heartbeat maps to no
--    context, canonical or audit action, so authorization_assert_entry_v12
--    grants it nothing. authorization_scope_union_v12 is unchanged (it never
--    yields ci:heartbeat).
-- 3. Token. Existing interfaces find a connection by
--    token_hash = credential_verifier_v1(caller's SHA-256 of the token)
--    (20261008210000), and not all of them check a scope. A heartbeat
--    connection's stored verifier is instead
--    'cv1:' || SHA-256(server salt || 'clued.ci-heartbeat.v1:' || proof), with
--    the salt kept in clued_private and never returned. It has the column's
--    verifier form (the normalizing trigger leaves it alone), but no
--    credential_verifier_v1 value can equal it: no existing lookup can match
--    it, whatever scope it checks or omits. Only
--    clued_private.resolve_heartbeat_binding_v1 computes the stored hash; it
--    also requires the scope to be exactly ci:heartbeat, the connection live
--    and its authorization unexpired. clued_private.binding_has_only_heartbeat_scope_v1
--    tells any reader whether a connection is one.
-- 4. Issuance. clued_headless_heartbeat_binding_confirmation_issue_v1 and
--    clued_headless_heartbeat_binding_issue_v1 (authenticated, Native account
--    session only, same token rules as the headless issuance: same session,
--    view digest, single use, receipt). A heartbeat connection cannot be the
--    target of a headless rotation (headless_binding_replaceable_v1 refuses
--    it); the Owner issues a new one and revokes the old.
-- 5. Nothing else changes: no CI command door, Worker, MCP or anon/gateway
--    surface (CI8 and GW80 stay as they are).

-- ---------------------------------------------------------------------------
-- 1. The scope list.

alter table public.clued_agent_bindings drop constraint clued_agent_bindings_scopes_check;
alter table public.clued_agent_bindings add constraint clued_agent_bindings_scopes_check check (
  scopes <@ array[
    'context:read','context:write','audit:read',
    'canonical:read','canonical:write','project:read','project:write',
    'ci:heartbeat'
  ]::text[] and cardinality(scopes) > 0
  and (not ('ci:heartbeat'=any(scopes)) or scopes=array['ci:heartbeat']::text[])
);

-- ---------------------------------------------------------------------------
-- 3. The token salt and the lookup.

create table clued_private.ci_heartbeat_token_salt_v1 (
  singleton boolean primary key default true check (singleton),
  salt bytea not null check (octet_length(salt)=32),
  created_at timestamptz not null default clock_timestamp()
);
insert into clued_private.ci_heartbeat_token_salt_v1(singleton,salt) values(true,extensions.gen_random_bytes(32));
alter table clued_private.ci_heartbeat_token_salt_v1 enable row level security;
revoke all on table clued_private.ci_heartbeat_token_salt_v1 from public,anon,authenticated,service_role;

-- The stored token_hash (verifier form) of a heartbeat connection, from the
-- caller's SHA-256 of its token (lowercase hex); 'cv0:' (matches nothing) for
-- anything else.
create function clued_private.ci_heartbeat_token_hash_v1(p_token_hash text) returns text
language sql stable security definer set search_path='' as $$
  select case when p_token_hash ~ '^[0-9a-f]{64}$' then 'cv1:'||encode(extensions.digest(
      s.salt||convert_to('clued.ci-heartbeat.v1:'||p_token_hash,'UTF8'),'sha256'),'hex') else 'cv0:' end
  from clued_private.ci_heartbeat_token_salt_v1 s where s.singleton
$$;

-- Whether a connection carries only ci:heartbeat.
create function clued_private.binding_has_only_heartbeat_scope_v1(p_binding public.clued_agent_bindings)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(p_binding.scopes=array['ci:heartbeat']::text[],false)
$$;

-- The only way to a heartbeat connection from its token: the caller's
-- SHA-256 of the token. Live, exactly ci:heartbeat, headless authorization not
-- revoked or expired, account usable; anything else is binding_not_authorized.
create function clued_private.resolve_heartbeat_binding_v1(p_token_hash text)
returns public.clued_agent_bindings language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_binding_or_context' using errcode='28000'; end if;
  select * into b from public.clued_agent_bindings x
    where x.token_hash=clued_private.ci_heartbeat_token_hash_v1(p_token_hash) for share;
  if not found or not clued_private.binding_live_v1(b) or not clued_private.binding_has_only_heartbeat_scope_v1(b)
      or not exists(select 1 from clued_private.authorizations_v12 a where a.binding_id=b.id and a.owner_id=b.user_id
        and a.issuance='headless' and a.revoked_at is null and a.expires_at>clock_timestamp()) then
    raise exception 'binding_not_authorized' using errcode='42501'; end if;
  perform clued_private.authorization_account_v12(b.user_id);
  return b;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Issuance.

-- A heartbeat connection is never replaced by a headless rotation (anchored
-- patch of 20261004120000's definition: the anchor must occur exactly once).
do $replaceable$
declare body text; anchor text:='  if not found or not clued_private.binding_live_v1(b)'||chr(10);
begin
  body:=pg_get_functiondef('clued_private.headless_binding_replaceable_v1(uuid,uuid)'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))<>length(anchor) then
    raise exception 'ci_heartbeat_scope_replaceable_anchor_mismatch'; end if;
  execute replace(body,anchor,'  if not found or not clued_private.binding_live_v1(b)'
    ||' or clued_private.binding_has_only_heartbeat_scope_v1(b)'||chr(10));
end $replaceable$;

-- What the Owner confirms. No clock value, so step 2 re-renders the same view.
create function clued_private.headless_heartbeat_binding_view_v1(p_choices jsonb) returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_object('kind','headless_heartbeat_binding_issue','label',p_choices->>'label',
    'days',(p_choices->>'days')::integer,'scopes',jsonb_build_array('ci:heartbeat'),'selected','[]'::jsonb,
    'usage','Resident node heartbeats only: it reads no context, writes nothing and no other interface accepts it.')
$$;

-- Step 1. Input {label, days}.
create function public.clued_headless_heartbeat_binding_confirmation_issue_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_label text; v_days integer; v_choices jsonb;
  v_view jsonb; v_digest text; v_raw text; v_token_id uuid; v_expires timestamptz; v_now timestamptz; v_error text;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if clued_private.native_session_id_v1() is null then
    return jsonb_build_object('status','rejected','error_code','confirmation_token_session_id_required','authoritative',false);
  end if;
  begin
    if jsonb_typeof(p_input) is distinct from 'object'
        or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('label','days')) then
      raise exception 'headless_binding_input_invalid' using errcode='22023'; end if;
    v_label:=btrim(coalesce(p_input->>'label',''));
    if jsonb_typeof(p_input->'label') is distinct from 'string' or char_length(v_label) not between 1 and 80
        or v_label ~ '[[:cntrl:]]' then
      raise exception 'headless_binding_label_invalid' using errcode='22023'; end if;
    if jsonb_typeof(p_input->'days') is distinct from 'number' or (p_input->>'days') !~ '^[0-9]{1,2}$'
        or (p_input->>'days')::integer not between 1 and 90 then
      raise exception 'headless_binding_expiry_invalid' using errcode='22023'; end if;
    v_days:=(p_input->>'days')::integer;
    if (select count(*) from clued_private.authorizations_v12 a
        where a.owner_id=v_owner and a.issuance='headless' and a.revoked_at is null and a.expires_at>clock_timestamp())>=50 then
      raise exception 'headless_binding_limit_reached' using errcode='22023'; end if;
    v_choices:=jsonb_build_object('label',v_label,'days',v_days);
    v_view:=clued_private.headless_heartbeat_binding_view_v1(v_choices);
    v_digest:=clued_private.m1_sha256(v_view);
    update clued_private.native_confirmation_tokens set revoked_at=clock_timestamp()
      where user_id=v_owner and action='headless_heartbeat_binding' and subject_key='headless-heartbeat:new'
        and consumed_at is null and revoked_at is null;
    v_raw:='clued_hbc_'||encode(extensions.gen_random_bytes(32),'hex');
    v_now:=clock_timestamp();
    insert into clued_private.native_confirmation_tokens(user_id,action,subject_key,subject_version,native_choices,
      confirmation_view,view_digest,token_hash,session_id,auth_time,issued_at,expires_at)
    values(v_owner,'headless_heartbeat_binding','headless-heartbeat:new',0,v_choices,v_view,v_digest,
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

-- Step 2. Input {confirmation_token, view_digest}. Creates the connection and
-- returns its token once; only the salted hash is stored.
create function public.clued_headless_heartbeat_binding_issue_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_token clued_private.native_confirmation_tokens%rowtype;
  v_token_id uuid; v_hash text; c jsonb; v_new uuid; v_raw text; v_expires timestamptz; v_receipt uuid;
  v_now timestamptz; v_error text; v_state text;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  begin
    if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('confirmation_token','view_digest')) then
      raise exception 'headless_binding_input_invalid' using errcode='22023'; end if;
    if jsonb_typeof(p_input->'confirmation_token') is distinct from 'string' then
      raise exception 'confirmation_token_required' using errcode='42501'; end if;
    v_hash:=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex');
    select * into v_token from clued_private.native_confirmation_tokens t
      where t.user_id=v_owner and t.action='headless_heartbeat_binding' and t.token_hash=v_hash for update;
    if not found then raise exception 'confirmation_token_invalid' using errcode='42501'; end if;
    if v_token.consume_outcome='committed' then
      return jsonb_build_object('status','committed','replayed',true,'receipt_id',v_token.consumed_receipt_id,
        'token',null,'token_shown_once',true);
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
    if clued_private.m1_sha256(clued_private.headless_heartbeat_binding_view_v1(c))<>v_token.view_digest then
      raise exception 'confirmation_view_stale' using errcode='40001'; end if;
    if (select count(*) from clued_private.authorizations_v12 a
        where a.owner_id=v_owner and a.issuance='headless' and a.revoked_at is null and a.expires_at>clock_timestamp())>=50 then
      raise exception 'headless_binding_limit_reached' using errcode='22023'; end if;
    v_now:=clock_timestamp();
    v_expires:=v_now+make_interval(days=>(c->>'days')::integer);
    v_raw:='clued_hbt_'||rtrim(translate(encode(extensions.gen_random_bytes(32),'base64'),'+/','-_'),'=');
    insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys,oauth_client_id)
      values(v_owner,'Headless',c->>'label',
        clued_private.ci_heartbeat_token_hash_v1(encode(extensions.digest(convert_to(v_raw,'UTF8'),'sha256'),'hex')),
        array['ci:heartbeat']::text[],array['global']::text[],null)
      returning id into v_new;
    insert into clued_private.authorizations_v12(binding_id,request_id,owner_id,client_id,client_name,resource,expires_at,issuance)
      values(v_new,null,v_owner,'clued-headless',c->>'label','clued:ci-heartbeat',v_expires,'headless');
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(v_owner,null,'global','headless_binding_issue','agent_binding',v_new::text,1,
      jsonb_build_object('receipt_kind','HEADLESS_BINDING_ISSUED','binding_id',v_new,'label',c->>'label',
        'expires_at',v_expires,'scopes',jsonb_build_array('ci:heartbeat'),'selected','[]'::jsonb,'heartbeat_only',true,
        'token_id',v_token.id,'view_digest',v_token.view_digest,'session_id',v_token.session_id,
        'principal','native_account_session'))
    returning id into v_receipt;
    insert into clued_private.authorization_audit_v12(owner_id,binding_id,request_id,operation,version,selected)
      values(v_owner,v_new,null,'headless_issue',1,'[]'::jsonb);
    update clued_private.native_confirmation_tokens set consumed_at=v_now,consumed_receipt_id=v_receipt,
      consume_outcome='committed' where id=v_token.id;
    return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,
      'binding_id',v_new,'token',v_raw,'expires_at',v_expires,'scopes',jsonb_build_array('ci:heartbeat'));
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    -- Single use: a presented live token is burned by any failed attempt.
    if v_token_id is not null then
      insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values(v_owner,null,'global','headless_binding_issue','agent_binding',v_token.subject_key,1,
        jsonb_build_object('receipt_kind','HEADLESS_BINDING_REJECTED','token_id',v_token_id,'error_code',v_error,
          'heartbeat_only',true))
      returning id into v_receipt;
      update clued_private.native_confirmation_tokens set consumed_at=clock_timestamp(),consumed_receipt_id=v_receipt,
        consume_outcome='rejected' where id=v_token_id and consumed_at is null and revoked_at is null;
    end if;
    return jsonb_build_object('status',case when v_state in ('22023','23514','40001','42501','55000')
      then 'rejected' else 'failed' end,'error_code',v_error,'authoritative',false);
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Grants: the two Owner RPCs to authenticated; everything else to nobody.

revoke all on function clued_private.ci_heartbeat_token_hash_v1(text),
  clued_private.binding_has_only_heartbeat_scope_v1(public.clued_agent_bindings),
  clued_private.resolve_heartbeat_binding_v1(text),
  clued_private.headless_heartbeat_binding_view_v1(jsonb)
  from public,anon,authenticated,service_role;
revoke all on function public.clued_headless_heartbeat_binding_confirmation_issue_v1(jsonb),
  public.clued_headless_heartbeat_binding_issue_v1(jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.clued_headless_heartbeat_binding_confirmation_issue_v1(jsonb),
  public.clued_headless_heartbeat_binding_issue_v1(jsonb) to authenticated;

notify pgrst,'reload schema';
