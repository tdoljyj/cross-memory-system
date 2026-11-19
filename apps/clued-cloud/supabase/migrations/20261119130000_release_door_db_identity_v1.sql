-- Release identity, PR-A (design FABLE-release-identity-autonomous-20261119
-- §1-§3; OwnerCredential.v0.1.md §6.1; DatabaseCallerAuthentication.v0.1.md
-- §2.1): the production release workflow is identified by its database login,
-- not by a Binding token.
--
-- The workflow already holds the production database login of the
-- clued-release environment (CLUED_MIGRATION_DATABASE_URL); migrations run
-- with it. The release door becomes a private function only that login can
-- call, so the release identity has nothing to issue, rotate or expire and no
-- token anyone handles. The Owner's consent is unchanged: the door consumes a
-- grant by action and resources (Owner choice 2026-10-03), opens a pending
-- request otherwise, and the Owner's automatic approval approves it as before.
--
-- 1. clued_private.release_identity_v1: one row, a registration and not a
--    credential (no secret, no expiry): the account (user_id, read from the
--    live release-door role row, not written in), the repository, and the
--    anchor Binding the door's requests hang on (owner_requests_v1.binding_id
--    is not null). The anchor is revoked when it is created and its verifier
--    is random with no known preimage, so no token path ever resolves it.
-- 2. clued_private.release_door_v1(p_input): security definer, executable by
--    its owner only (the migration login); not on PostgREST. Input: action,
--    resources, with (as the old door), run_id and run_attempt (recorded in
--    the use receipt as the caller's own, unverified claim), and two modes:
--    probe (the door is usable: identity row, anchor, both actions; it raises
--    otherwise and writes nothing) and request_only (reuse or open the pending
--    request, never consume, never approve). Each resource names the
--    registered repository: repo:<repository>/<40-hex sha> for
--    release.production, that commit's
--    apps/clued-cloud/supabase/migrations/<file> for migration.production.
-- 3. The public clued_owner_grant_door_consume_v1 refuses release.production
--    and migration.production to every token (owner_grant_door_release_token_retired);
--    ci.resident_upgrade still goes to its own door, unchanged.
-- 4. The install, in this transaction: register the identity of the account
--    holding the live release-door role, create its anchor, revoke every
--    release-door role row and the Bindings holding them (production:
--    9f1788d9), one receipt. A database with no live release-door role (a
--    fresh test database) gets no identity, so its door fails the probe.
--
-- Every function here is written whole; nothing is patched by text.

-- 1. Identity ----------------------------------------------------------------------

create table clued_private.release_identity_v1 (
  singleton boolean primary key default true check (singleton),
  user_id uuid not null references auth.users(id) on delete cascade,
  repository text not null check (repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  anchor_binding_id uuid not null unique references public.clued_agent_bindings(id),
  installed_at timestamptz not null default clock_timestamp(),
  receipt_id uuid not null unique references public.clued_audit_receipts(id)
);
alter table clued_private.release_identity_v1 enable row level security;
revoke all on clued_private.release_identity_v1 from public,anon,authenticated,service_role,clued_worker_gateway;

-- Whether one resource is this action's shape under the registered repository.
create function clued_private.release_door_resource_ok_v1(p_repository text,p_action text,p_resource text)
returns boolean language sql immutable set search_path='' as $$
  select p_resource is not null
    and left(p_resource,char_length('repo:'||p_repository||'/'))='repo:'||p_repository||'/'
    and case p_action
      when 'release.production' then
        substr(p_resource,char_length('repo:'||p_repository||'/')+1) ~ '^[0-9a-f]{40}$'
      when 'migration.production' then
        substr(p_resource,char_length('repo:'||p_repository||'/')+1)
          ~ '^[0-9a-f]{40}/apps/clued-cloud/supabase/migrations/[0-9]{14}_[a-z0-9_]+\.sql$'
      else false end
$$;

-- The checked resources of one {action, resources} item, normalized as every
-- door stores them (sorted, distinct).
create function clued_private.release_door_resources_v1(p_repository text,p_action text,p_resources jsonb)
returns text[] language plpgsql stable set search_path='' as $$
begin
  if jsonb_typeof(p_resources) is distinct from 'array' or jsonb_array_length(p_resources) not between 1 and 50
      or exists(select 1 from jsonb_array_elements(p_resources) r
        where jsonb_typeof(r) is distinct from 'string'
          or not clued_private.release_door_resource_ok_v1(p_repository,p_action,r#>>'{}')) then
    raise exception 'release_door_resources_invalid' using errcode='22023'; end if;
  return clued_private.work_claim_normalize_paths(p_resources);
end $$;

-- 2. The door ----------------------------------------------------------------------

create function clued_private.release_door_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_identity clued_private.release_identity_v1%rowtype; v_anchor public.clued_agent_bindings;
  v_action clued_private.owner_grant_actions%rowtype; v_other clued_private.owner_grant_actions%rowtype;
  v_resources text[]; v_other_resources text[]; v_with jsonb:='[]'::jsonb; v_item jsonb;
  v_caller jsonb; v_grant clued_private.owner_grants_v1%rowtype; v_receipt uuid;
  v_req clued_private.owner_requests_v1%rowtype; v_member clued_private.owner_requests_v1%rowtype;
  v_ids uuid[]; v_auto boolean:=false;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k
        where k not in ('action','resources','with','probe','request_only','run_id','run_attempt'))
      or (p_input ? 'probe' and p_input->'probe' is distinct from 'true'::jsonb)
      or (p_input ? 'request_only' and p_input->'request_only' is distinct from 'true'::jsonb)
      or (p_input ? 'run_id' and (jsonb_typeof(p_input->'run_id') is distinct from 'string'
        or p_input->>'run_id' !~ '^[1-9][0-9]{0,19}$'))
      or (p_input ? 'run_attempt' and (jsonb_typeof(p_input->'run_attempt') is distinct from 'string'
        or p_input->>'run_attempt' !~ '^[1-9][0-9]{0,5}$'))
      or (p_input ? 'probe' and exists(select 1 from jsonb_object_keys(p_input) k
        where k not in ('probe','run_id','run_attempt'))) then
    raise exception 'release_door_input_invalid' using errcode='22023'; end if;
  -- The door itself: the registered identity, its unresolvable anchor, both actions at this door.
  select * into v_identity from clued_private.release_identity_v1;
  if not found then raise exception 'release_door_identity_missing' using errcode='55000'; end if;
  select * into v_anchor from public.clued_agent_bindings b
    where b.id=v_identity.anchor_binding_id and b.user_id=v_identity.user_id;
  if not found or v_anchor.revoked_at is null then
    raise exception 'release_door_identity_invalid' using errcode='55000'; end if;
  if (select count(*) from clued_private.owner_grant_actions a
      where a.action in ('release.production','migration.production') and 'release-workflow'=any(a.doors))<>2 then
    raise exception 'release_door_actions_missing' using errcode='55000'; end if;
  if p_input ? 'probe' then
    return jsonb_build_object('status','ok','probe',true,'door','release-workflow',
      'repository',v_identity.repository,'identity','database_login');
  end if;
  select * into v_action from clued_private.owner_grant_actions a
    where a.action=p_input->>'action' and 'release-workflow'=any(a.doors);
  if not found then raise exception 'release_door_action_invalid' using errcode='22023'; end if;
  v_resources:=clued_private.release_door_resources_v1(v_identity.repository,v_action.action,p_input->'resources');
  if p_input ? 'with' then
    if jsonb_typeof(p_input->'with') is distinct from 'array' or jsonb_array_length(p_input->'with') not between 1 and 4 then
      raise exception 'release_door_input_invalid' using errcode='22023'; end if;
    for v_item in select value from jsonb_array_elements(p_input->'with') loop
      if jsonb_typeof(v_item) is distinct from 'object'
          or exists(select 1 from jsonb_object_keys(v_item) k where k not in ('action','resources')) then
        raise exception 'release_door_input_invalid' using errcode='22023'; end if;
      select * into v_other from clued_private.owner_grant_actions a
        where a.action=v_item->>'action' and 'release-workflow'=any(a.doors);
      if not found or v_other.action=v_action.action
          or v_with @> jsonb_build_array(jsonb_build_object('action',v_other.action)) then
        raise exception 'release_door_action_invalid' using errcode='22023'; end if;
      v_other_resources:=clued_private.release_door_resources_v1(v_identity.repository,v_other.action,v_item->'resources');
      v_with:=v_with||jsonb_build_array(jsonb_build_object('action',v_other.action,'resources',to_jsonb(v_other_resources)));
    end loop;
  end if;
  v_caller:=jsonb_build_object('run_id',p_input->>'run_id','run_attempt',p_input->>'run_attempt','verified',false);
  perform clued_private.owner_grant_lock_v1(v_identity.user_id);
  if p_input ? 'request_only' then
    -- Never consumes and never approves: a run whose transaction rolled back
    -- leaves this request (and its link) behind. A live grant needs none.
    if clued_private.owner_grant_door_admits_v1(v_identity.user_id,v_action.action,v_resources) then
      return jsonb_build_object('status','ok','consumed',false,'admitted',true,'action',v_action.action,
        'resources',to_jsonb(v_resources));
    end if;
    v_req:=clued_private.owner_grant_door_request_v1(v_anchor,v_action.action,v_resources);
  else
    -- A live grant of this account for the action that covers every resource,
    -- whoever asked for it; else this door's request, approved at once when
    -- the Owner's automatic approval is on, and its grant.
    for i in 1..2 loop
      select * into v_grant from clued_private.owner_grants_v1 x
        where x.user_id=v_identity.user_id and x.action=v_action.action and x.revoked_at is null
          and x.expires_at>clock_timestamp() and (x.max_uses is null or x.uses<x.max_uses)
          and not exists(select 1 from unnest(v_resources) r where not clued_private.owner_grant_covers_v1(x.resources,r))
        order by x.expires_at,x.granted_at limit 1 for update;
      if found then
        update clued_private.owner_grants_v1 set uses=uses+1 where id=v_grant.id;
        insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
        values(v_identity.user_id,v_anchor.id,'global','owner_grant_use','owner_grant',v_grant.id::text,v_grant.uses+1,
          jsonb_build_object('receipt_kind','OWNER_GRANT_USED','grant_id',v_grant.id,'action',v_action.action,
            'resources',to_jsonb(v_resources),'door','release-workflow','use',v_grant.uses+1,'max_uses',v_grant.max_uses,
            'identity','database_login','database_login',session_user::text,'caller',v_caller))
        returning id into v_receipt;
        return jsonb_build_object('status','ok','consumed',true,'action',v_action.action,
          'resources',to_jsonb(v_resources),'auto_approved',v_auto,
          'grant',jsonb_build_object('grant_id',v_grant.id,'receipt_id',v_receipt,'use',v_grant.uses+1,
            'max_uses',v_grant.max_uses,'expires_at',v_grant.expires_at));
      end if;
      exit when i=2;
      v_req:=clued_private.owner_grant_door_request_v1(v_anchor,v_action.action,v_resources);
      v_req:=clued_private.owner_auto_approve_request_v1(v_req);
      exit when v_req.status='pending';
      v_auto:=true;
    end loop;
  end if;
  -- No grant: the pending request, with one for each other action of the run
  -- that no live grant admits yet, as one bundle.
  v_ids:=array[v_req.id];
  for v_item in select value from jsonb_array_elements(v_with) loop
    select array_agg(value order by ordinality) into v_other_resources
      from jsonb_array_elements_text(v_item->'resources') with ordinality;
    continue when clued_private.owner_grant_door_admits_v1(v_identity.user_id,v_item->>'action',v_other_resources);
    v_member:=clued_private.owner_grant_door_request_v1(v_anchor,v_item->>'action',v_other_resources);
    v_ids:=v_ids||v_member.id;
  end loop;
  if cardinality(v_ids)>1 then
    perform clued_private.owner_request_bundle_join_v1(v_identity.user_id,v_ids);
    select * into v_req from clued_private.owner_requests_v1 where id=v_req.id;
  end if;
  return jsonb_build_object('status','ok','consumed',false,'action',v_action.action,
    'resources',to_jsonb(v_resources),'owner_request',clued_private.owner_request_public_v1(v_req));
end $$;

-- 4. The install ---------------------------------------------------------------------

-- Registers the identity of the account holding the live release-door role and
-- retires the token path: that role's rows and the Bindings holding them are
-- revoked under one receipt. Once only.
create function clued_private.release_door_install_v1(p_repository text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_users uuid[]; v_user uuid; v_bindings uuid[]; v_roles uuid[]; v_anchor uuid; v_receipt uuid;
  v_now timestamptz:=clock_timestamp();
begin
  lock table clued_private.release_identity_v1 in exclusive mode;
  if exists(select 1 from clued_private.release_identity_v1) then
    raise exception 'release_door_already_installed' using errcode='55000'; end if;
  select coalesce(array_agg(distinct r.user_id),'{}') into v_users
    from clued_private.binding_roles_v1 r where r.role='release-door' and r.revoked_at is null;
  if cardinality(v_users)=0 then
    return jsonb_build_object('status','ok','installed',false,'reason','no live release-door role');
  end if;
  if cardinality(v_users)>1 then
    raise exception 'release_door_install_ambiguous' using errcode='55000'; end if;
  v_user:=v_users[1];
  perform clued_private.owner_grant_lock_v1(v_user);
  select array_agg(r.id order by r.id),array_agg(distinct r.binding_id) into v_roles,v_bindings
    from clued_private.binding_roles_v1 r where r.role='release-door' and r.revoked_at is null;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(v_user,null,'global','release_door_install','release_identity',p_repository,1,
    jsonb_build_object('receipt_kind','RELEASE_DOOR_DB_IDENTITY_INSTALLED','principal','release_migration',
      'database_login',session_user::text,'repository',p_repository,
      'retired_bindings',to_jsonb(v_bindings),'retired_role_rows',to_jsonb(v_roles)))
  returning id into v_receipt;
  -- The anchor: revoked from birth, a verifier nobody holds the token of.
  insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys,revoked_at)
  values(v_user,'Clued','clued-release-workflow','cv1:'||encode(extensions.gen_random_bytes(32),'hex'),
    array['context:read'],array['global'],v_now)
  returning id into v_anchor;
  insert into clued_private.release_identity_v1(user_id,repository,anchor_binding_id,installed_at,receipt_id)
  values(v_user,p_repository,v_anchor,v_now,v_receipt);
  update clued_private.binding_roles_v1 set revoked_at=v_now,revoked_receipt_id=v_receipt where id=any(v_roles);
  update public.clued_agent_bindings set revoked_at=v_now where id=any(v_bindings) and revoked_at is null;
  return jsonb_build_object('status','ok','installed',true,'user_id',v_user,'anchor_binding_id',v_anchor,
    'receipt_id',v_receipt,'retired_bindings',to_jsonb(v_bindings),'retired_role_rows',to_jsonb(v_roles));
end $$;

-- 3. The public door: the release actions are no longer a token's ----------------------

create or replace function public.clued_owner_grant_door_consume_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  -- Task 018da927: the resident-upgrader door (its own Binding role and rules).
  if p_input->>'action'='ci.resident_upgrade' then
    return clued_private.owner_grant_resident_upgrade_door_v1(p_token_hash,p_input); end if;
  if jsonb_typeof(p_input) is distinct from 'object' then
    raise exception 'owner_grant_door_input_invalid' using errcode='22023'; end if;
  -- The release workflow is its database login (clued_private.release_door_v1).
  if exists(select 1 from clued_private.owner_grant_actions a
      where a.action=p_input->>'action' and 'release-workflow'=any(a.doors)) then
    raise exception 'owner_grant_door_release_token_retired' using errcode='42501'; end if;
  raise exception 'owner_grant_door_action_invalid' using errcode='22023';
end $$;

revoke all on function clued_private.release_door_resource_ok_v1(text,text,text),
  clued_private.release_door_resources_v1(text,text,jsonb),
  clued_private.release_door_v1(jsonb),
  clued_private.release_door_install_v1(text)
  from public,anon,authenticated,service_role,clued_worker_gateway;

select clued_private.release_door_install_v1('tdoljyj/cross-memory-system');

notify pgrst,'reload schema';
