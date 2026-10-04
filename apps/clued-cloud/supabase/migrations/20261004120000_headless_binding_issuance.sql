-- Headless Binding issuance (Task 364212a1, Owner Decision 6e0371e3).
--
-- Clients that cannot complete OAuth (CI, runners, scripts) get their own
-- Binding token from the signed-in Clued page, in two Native steps
-- (clued_headless_binding_confirmation_issue_v1, then
-- clued_headless_binding_issue_v1). No MCP tool, OAuth case or Binding can
-- call them: both start with authorization_owner_v12(), which requires a
-- direct human account session.
--
-- A headless Binding is an ordinary v12 authorization without an OAuth
-- request: least-privilege entries chosen by the Owner, a mandatory expiry,
-- only the token hash stored, the raw token returned once by step 2, and a
-- Receipt for every issue. It is listed, reduced and revoked by the existing
-- clued_authorization_manage_v12 on /oauth/connections. Step 1 may name a
-- Binding the new one replaces (rotation): the old one then expires one hour
-- after the new token is issued and its Binding roles move to the new one.
--
-- The OAuth path (prepare, approve, deny, manage and the resolvers) is not
-- changed. Existing Bindings keep working as before: none gets an expiry here.

-- Expiry on the Binding itself. resolve_binding and binding_live_v1 already
-- read it (to_jsonb(b)->>'expires_at'); it is set only for headless Bindings
-- and for a Binding replaced by rotation. Token paths that check revoked_at
-- alone are covered by the expiry sweep below. The P5 candidate migration
-- (20260827031728) declares the same column; production never applied it.
alter table public.clued_agent_bindings add column if not exists expires_at timestamptz;

-- OAuth authorizations keep their request; headless ones have none.
alter table clued_private.authorizations_v12
  add column issuance text not null default 'oauth' check (issuance in ('oauth','headless'));
alter table clued_private.authorizations_v12 alter column request_id drop not null;
alter table clued_private.authorizations_v12
  add constraint authorizations_v12_issuance_request check ((issuance='oauth')=(request_id is not null));

create index authorizations_v12_owner_headless on clued_private.authorizations_v12(owner_id)
  where issuance='headless' and revoked_at is null;

-- Everything a headless Binding may be given: the Owner's own resources, every
-- action. The Owner chooses the subset; there is no client request to bound it.
create function clued_private.headless_binding_eligible_v1(p_owner uuid)
returns jsonb language sql security definer set search_path='' as $$
  select coalesce(jsonb_agg(item),'[]'::jsonb)
  from jsonb_array_elements(clued_private.authorization_eligible_v12(
    p_owner,array['context:read','context:write','audit:read'])) item
  where item->>'resource_kind'='scope'
    or exists(select 1 from clued_private.development_spaces_v14 c
      where c.id::text=item->>'resource_id' and c.owner_id=p_owner)
$$;

-- A live Binding the Owner may replace: owned, not revoked, not expired, and
-- not an OAuth connection (those are renewed by reconnecting the client).
create function clued_private.headless_binding_replaceable_v1(p_owner uuid,p_binding uuid)
returns public.clued_agent_bindings language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12;
begin
  select * into b from public.clued_agent_bindings where id=p_binding and user_id=p_owner;
  if not found or not clued_private.binding_live_v1(b) then
    raise exception 'headless_binding_replace_target_invalid' using errcode='22023'; end if;
  select * into a from clued_private.authorizations_v12 where binding_id=b.id;
  if found and (a.issuance<>'headless' or a.revoked_at is not null or a.expires_at<=clock_timestamp()) then
    raise exception 'headless_binding_replace_target_invalid' using errcode='22023'; end if;
  return b;
end $$;

-- What the Owner confirms, rendered by Clued from the stored choices and the
-- current rows. No clock value is part of it, so step 2 re-renders the same
-- view while nothing changed.
create function clued_private.headless_binding_view_v1(p_owner uuid,p_choices jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_eligible jsonb:=clued_private.headless_binding_eligible_v1(p_owner);
  v_selected jsonb; b public.clued_agent_bindings; v_replaces jsonb:=null; v_roles jsonb:='[]'::jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('resource_kind',s->>'resource_kind','resource_id',s->>'resource_id',
      'environment',s->>'environment','name',e->>'name',
      'actions',(select jsonb_agg(a order by a) from (select distinct a from jsonb_array_elements_text(s->'actions') a) x))
      order by s->>'resource_kind',s->>'resource_id',s->>'environment'),'[]'::jsonb)
    into v_selected
    from jsonb_array_elements(p_choices->'selected') s
    left join lateral (select x from jsonb_array_elements(v_eligible) x
      where x->>'resource_kind'=s->>'resource_kind' and x->>'resource_id'=s->>'resource_id'
        and x->>'environment'=s->>'environment' limit 1) l(e) on true;
  if p_choices->>'replaces_binding_id' is not null then
    select * into b from public.clued_agent_bindings where id=(p_choices->>'replaces_binding_id')::uuid and user_id=p_owner;
    select coalesce(jsonb_agg(r.role order by r.role),'[]'::jsonb) into v_roles
      from clued_private.binding_roles_v1 r where r.binding_id=b.id and r.revoked_at is null;
    v_replaces:=jsonb_build_object('binding_id',b.id,'agent_name',b.agent_name,'vendor',b.vendor,
      'created_at',b.created_at,'roles',v_roles,'grace_minutes',60);
  end if;
  return jsonb_build_object('kind','headless_binding_issue',
    'label',p_choices->>'label','days',(p_choices->>'days')::integer,
    'selected',v_selected,
    'scopes',to_jsonb(coalesce(clued_private.authorization_scope_union_v12(p_choices->'selected'),array[]::text[])),
    'replaces',v_replaces,
    'usage','REST /v1 and PostgREST RPC (token hash). MCP clients connect through OAuth instead.');
end $$;

-- The Owner's headless and legacy (pre-v12, no authorization row) live
-- Bindings, with roles. OAuth connections are listed by manage_v12 already.
create function public.clued_headless_binding_list_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12();
begin
  if jsonb_typeof(p_input) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_input)) then
    raise exception 'headless_binding_input_invalid' using errcode='22023'; end if;
  return jsonb_build_object('status','ok',
    'eligible',clued_private.headless_binding_eligible_v1(v_owner),
    'bindings',coalesce((select jsonb_agg(jsonb_build_object('binding_id',b.id,'agent_name',b.agent_name,
        'vendor',b.vendor,'scopes',to_jsonb(b.scopes),'created_at',b.created_at,'last_used_at',b.last_used_at,
        'expires_at',coalesce(a.expires_at,b.expires_at),
        'kind',case when a.binding_id is null then 'legacy' else 'headless' end,
        'version',a.version,
        'grants',case when a.binding_id is null then null else clued_private.authorization_selection_v12(b.id) end,
        'roles',coalesce((select jsonb_agg(r.role order by r.role) from clued_private.binding_roles_v1 r
          where r.binding_id=b.id and r.revoked_at is null),'[]'::jsonb)) order by b.created_at desc)
      from public.clued_agent_bindings b
      left join clued_private.authorizations_v12 a on a.binding_id=b.id
      where b.user_id=v_owner and clued_private.binding_live_v1(b)
        and (a.binding_id is null or (a.issuance='headless' and a.revoked_at is null
          and a.expires_at>clock_timestamp()))),'[]'::jsonb));
end $$;

-- Step 1. Input {label, days, selected, replaces_binding_id?}. The returned
-- confirmation token covers exactly the returned view.
create function public.clued_headless_binding_confirmation_issue_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_label text; v_days integer;
  v_selected jsonb; v_replaces uuid; b public.clued_agent_bindings; v_scopes text[]; v_choices jsonb;
  v_view jsonb; v_digest text; v_raw text; v_token_id uuid; v_expires timestamptz; v_now timestamptz;
  v_error text; v_subject text; v_role text;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if clued_private.native_session_id_v1() is null then
    return jsonb_build_object('status','rejected','error_code','confirmation_token_session_id_required','authoritative',false);
  end if;
  begin
    if jsonb_typeof(p_input) is distinct from 'object'
        or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('label','days','selected','replaces_binding_id')) then
      raise exception 'headless_binding_input_invalid' using errcode='22023'; end if;
    v_label:=btrim(coalesce(p_input->>'label',''));
    if jsonb_typeof(p_input->'label') is distinct from 'string' or char_length(v_label) not between 1 and 80
        or v_label ~ '[[:cntrl:]]' then
      raise exception 'headless_binding_label_invalid' using errcode='22023'; end if;
    if jsonb_typeof(p_input->'days') is distinct from 'number' or (p_input->>'days') !~ '^[0-9]{1,2}$'
        or (p_input->>'days')::integer not between 1 and 90 then
      raise exception 'headless_binding_expiry_invalid' using errcode='22023'; end if;
    v_days:=(p_input->>'days')::integer;
    v_selected:=p_input->'selected';
    perform clued_private.authorization_validate_selection_v12(v_selected,clued_private.headless_binding_eligible_v1(v_owner));
    v_scopes:=clued_private.authorization_scope_union_v12(v_selected);
    if p_input ? 'replaces_binding_id' and jsonb_typeof(p_input->'replaces_binding_id') is distinct from 'null' then
      if coalesce(p_input->>'replaces_binding_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'headless_binding_replace_target_invalid' using errcode='22023'; end if;
      b:=clued_private.headless_binding_replaceable_v1(v_owner,(p_input->>'replaces_binding_id')::uuid);
      v_replaces:=b.id;
      -- Roles move to the new Binding, which must hold each role's scope.
      for v_role in select r.role from clued_private.binding_roles_v1 r where r.binding_id=b.id and r.revoked_at is null loop
        if not ((case v_role when 'ci-admission' then 'context:read' else 'context:write' end)=any(v_scopes)) then
          raise exception 'headless_binding_role_scope_missing' using errcode='22023'; end if;
      end loop;
    elsif (select count(*) from clued_private.authorizations_v12 a
        where a.owner_id=v_owner and a.issuance='headless' and a.revoked_at is null and a.expires_at>clock_timestamp())>=50 then
      raise exception 'headless_binding_limit_reached' using errcode='22023';
    end if;
    v_choices:=jsonb_build_object('label',v_label,'days',v_days,'selected',v_selected,'replaces_binding_id',v_replaces);
    v_view:=clued_private.headless_binding_view_v1(v_owner,v_choices);
    v_digest:=clued_private.m1_sha256(v_view);
    v_subject:='headless:'||coalesce(v_replaces::text,'new');
    update clued_private.native_confirmation_tokens set revoked_at=clock_timestamp()
      where user_id=v_owner and action='headless_binding' and subject_key=v_subject and consumed_at is null and revoked_at is null;
    v_raw:='clued_hbc_'||encode(extensions.gen_random_bytes(32),'hex');
    v_now:=clock_timestamp();
    insert into clued_private.native_confirmation_tokens(user_id,action,subject_key,subject_version,native_choices,
      confirmation_view,view_digest,token_hash,session_id,auth_time,issued_at,expires_at)
    values(v_owner,'headless_binding',v_subject,0,v_choices,v_view,v_digest,
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

-- Step 2. Input {confirmation_token, view_digest}. Consumes the token,
-- re-renders the view, creates the Binding and returns its token once.
create function public.clued_headless_binding_issue_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_token clued_private.native_confirmation_tokens%rowtype;
  v_token_id uuid; v_hash text; c jsonb; v_selected jsonb; v_scopes text[]; v_keys text[]; item jsonb;
  s clued_private.development_spaces_v14; old_b public.clued_agent_bindings; v_new uuid; v_raw text;
  v_expires timestamptz; v_grace timestamptz; v_receipt uuid; v_now timestamptz; v_error text; v_state text;
  v_roles text[]:=array[]::text[];
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
      where t.user_id=v_owner and t.action='headless_binding' and t.token_hash=v_hash for update;
    if not found then raise exception 'confirmation_token_invalid' using errcode='42501'; end if;
    if v_token.consume_outcome='committed' then
      -- The token was shown once, in the committed response; it is not stored.
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
    v_selected:=c->'selected';
    -- Lock order as manage_v12: Binding, then Authorization, then Context.
    if c->>'replaces_binding_id' is not null then
      perform 1 from public.clued_agent_bindings where id=(c->>'replaces_binding_id')::uuid and user_id=v_owner for update;
      perform 1 from clued_private.authorizations_v12 where binding_id=(c->>'replaces_binding_id')::uuid for update;
      old_b:=clued_private.headless_binding_replaceable_v1(v_owner,(c->>'replaces_binding_id')::uuid);
    end if;
    perform clued_private.authorization_validate_selection_v12(v_selected,clued_private.headless_binding_eligible_v1(v_owner));
    if clued_private.m1_sha256(clued_private.headless_binding_view_v1(v_owner,c))<>v_token.view_digest then
      raise exception 'confirmation_view_stale' using errcode='40001'; end if;
    for item in select value from jsonb_array_elements(v_selected) order by value->>'resource_kind',value->>'resource_id' loop
      perform clued_private.authorization_resource_v12(v_owner,item->>'resource_kind',item->>'resource_id',item->>'environment');
    end loop;
    v_scopes:=clued_private.authorization_scope_union_v12(v_selected);
    select coalesce(array_agg(distinct k order by k),array[]::text[]) into v_keys from (
      select j->>'resource_id' k from jsonb_array_elements(v_selected) j where j->>'resource_kind'='scope'
      union all select 'project:'||sp.project_id from jsonb_array_elements(v_selected) j
        join clued_private.development_spaces_v14 sp on sp.id::text=j->>'resource_id' and sp.owner_id=v_owner
        where j->>'resource_kind'='context') entries;
    v_now:=clock_timestamp();
    v_expires:=v_now+make_interval(days=>(c->>'days')::integer);
    v_raw:='clued_bnd_'||rtrim(translate(encode(extensions.gen_random_bytes(32),'base64'),'+/','-_'),'=');
    insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys,oauth_client_id,expires_at)
      values(v_owner,'Headless',c->>'label',encode(extensions.digest(convert_to(v_raw,'UTF8'),'sha256'),'hex'),
        v_scopes,v_keys,null,v_expires)
      returning id into v_new;
    insert into clued_private.authorizations_v12(binding_id,request_id,owner_id,client_id,client_name,resource,expires_at,issuance)
      values(v_new,null,v_owner,'clued-headless',c->>'label','clued:headless',v_expires,'headless');
    perform clued_private.authorization_replace_entries_v12(v_new,v_selected);
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(v_owner,null,'global','headless_binding_issue','agent_binding',v_new::text,1,
      jsonb_build_object('receipt_kind','HEADLESS_BINDING_ISSUED','binding_id',v_new,'label',c->>'label',
        'expires_at',v_expires,'scopes',to_jsonb(v_scopes),'selected',clued_private.authorization_selection_v12(v_new),
        'replaces_binding_id',c->>'replaces_binding_id','token_id',v_token.id,'view_digest',v_token.view_digest,
        'session_id',v_token.session_id,'principal','native_account_session'))
    returning id into v_receipt;
    -- Same context grant as an OAuth approval of a development context.
    for item in select value from jsonb_array_elements(v_selected) where value->>'resource_kind'='context' loop
      select * into s from clued_private.development_spaces_v14 where id=(item->>'resource_id')::uuid and owner_id=v_owner;
      perform public.clued_development_owner_v14(jsonb_build_object('op','grant_upsert','context_id',s.id,'binding_id',v_new,
        'actions',(select jsonb_agg(distinct case v when 'close' then 'write' else v end) from jsonb_array_elements_text(item->'actions') v),
        'history_policy','EXISTING_AND_FUTURE','version_policy','LATEST',
        'allowed_fields',jsonb_build_array('*'),'expires_at',v_expires,'idempotency_key',v_new::text||':'||s.id::text||':grant'));
    end loop;
    insert into clued_private.authorization_audit_v12(owner_id,binding_id,request_id,operation,version,selected)
      values(v_owner,v_new,null,'headless_issue',1,clued_private.authorization_selection_v12(v_new));
    if old_b.id is not null then
      v_grace:=v_now+interval '1 hour';
      update public.clued_agent_bindings set expires_at=least(coalesce(expires_at,v_grace),v_grace) where id=old_b.id;
      update clued_private.authorizations_v12 set expires_at=least(expires_at,v_grace),version=version+1
        where binding_id=old_b.id;
      insert into clued_private.authorization_audit_v12(owner_id,binding_id,request_id,operation,version,selected)
        values(v_owner,old_b.id,null,'headless_replaced',null,jsonb_build_object('replaced_by',v_new,'expires_at',v_grace));
      with ended as (
        update clued_private.binding_roles_v1 set revoked_at=v_now,revoked_receipt_id=v_receipt
          where binding_id=old_b.id and revoked_at is null returning role)
      select coalesce(array_agg(role order by role),array[]::text[]) into v_roles from ended;
      insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id)
        select v_owner,v_new,r,v_now,v_receipt from unnest(v_roles) r;
    end if;
    update clued_private.native_confirmation_tokens set consumed_at=v_now,consumed_receipt_id=v_receipt,
      consume_outcome='committed' where id=v_token.id;
    return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,
      'binding_id',v_new,'token',v_raw,'expires_at',v_expires,'scopes',to_jsonb(v_scopes),
      'selected',clued_private.authorization_selection_v12(v_new),
      'replaced',case when old_b.id is null then null else jsonb_build_object('binding_id',old_b.id,
        'expires_at',v_grace,'roles_moved',to_jsonb(v_roles)) end);
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    -- Single use: a presented live token is burned by any failed attempt.
    if v_token_id is not null then
      insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values(v_owner,null,'global','headless_binding_issue','agent_binding',v_token.subject_key,1,
        jsonb_build_object('receipt_kind','HEADLESS_BINDING_REJECTED','token_id',v_token_id,'error_code',v_error))
      returning id into v_receipt;
      update clued_private.native_confirmation_tokens set consumed_at=clock_timestamp(),consumed_receipt_id=v_receipt,
        consume_outcome='rejected' where id=v_token_id and consumed_at is null and revoked_at is null;
    end if;
    return jsonb_build_object('status',case when v_state in ('22023','23514','40001','42501','55000')
      then 'rejected' else 'failed' end,'error_code',v_error,'authoritative',false);
  end;
end $$;

-- Revokes every Binding whose own expiry has passed, so token paths that check
-- revoked_at alone stop accepting it too. Only rows given an expiry by this
-- migration's functions are touched. Runs every five minutes where pg_cron is
-- installed; safe to call at any time.
create function clued_private.binding_expiry_sweep_v1()
returns integer language plpgsql volatile security definer set search_path='' as $$
declare v_now timestamptz:=clock_timestamp(); v_count integer:=0; b record;
begin
  for b in select x.id,x.user_id from public.clued_agent_bindings x
      where x.expires_at is not null and x.expires_at<=v_now and x.revoked_at is null
      order by x.id for update skip locked loop
    update public.clued_agent_bindings set revoked_at=v_now where id=b.id;
    update clued_private.authorizations_v12 set revoked_at=v_now,version=version+1
      where binding_id=b.id and revoked_at is null;
    insert into clued_private.authorization_audit_v12(owner_id,binding_id,operation)
      values(b.user_id,b.id,'expired');
    v_count:=v_count+1;
  end loop;
  return v_count;
end $$;

revoke all on function clued_private.headless_binding_eligible_v1(uuid),
  clued_private.headless_binding_replaceable_v1(uuid,uuid),
  clued_private.headless_binding_view_v1(uuid,jsonb),
  clued_private.binding_expiry_sweep_v1()
from public,anon,authenticated,service_role;
revoke all on function public.clued_headless_binding_list_v1(jsonb),
  public.clued_headless_binding_confirmation_issue_v1(jsonb),
  public.clued_headless_binding_issue_v1(jsonb)
from public,anon,authenticated,service_role;
grant execute on function public.clued_headless_binding_list_v1(jsonb),
  public.clued_headless_binding_confirmation_issue_v1(jsonb),
  public.clued_headless_binding_issue_v1(jsonb) to authenticated;

do $cron$
begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    perform cron.schedule('clued-binding-expiry-sweep','*/5 * * * *','select clued_private.binding_expiry_sweep_v1()');
  end if;
end $cron$;
