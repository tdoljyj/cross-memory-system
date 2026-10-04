-- Connection permission requests (Owner Decision 43ba00e2, Task e86eb58d).
--
-- An Agent whose connection lacks a context or an action asks for it with
-- clued_owner_request, action connection.permission, one resource per
-- context and action: permission:<context>/<action>, where <context> is
-- global, profile or project:<id> and <action> is read, write, close, restore
-- or audit. A connection that can only read, or cannot read the context it
-- needs, can still ask. The Owner approves on the signed-in /confirm/<id>
-- page; in the same transaction Clued adds exactly the requested entries to
-- the requesting connection (authorization entries, the Binding's scopes and
-- context keys) and consumes the one-use grant. Nothing changes until the
-- Owner approves, the connection keeps its expiry, and the Owner can still
-- reduce or revoke it on /oauth/connections.
--
-- Bounds:
-- - Only connections with a live v12 authorization (OAuth or headless) can
--   ask or be widened; raw legacy Bindings cannot.
-- - Only Clued scopes the Owner could have ticked when connecting
--   (authorization_eligible_v12): Global, profile and the Owner's own
--   projects. Development contexts and shared projects are not offered here.
-- - Approval is "once" for the requester only: no time-limited grant, no
--   "any Agent", no wider resource, and the Owner cannot start one without a
--   request.
-- The rest of the Owner Request and grant kernels is kept byte for byte;
-- each patch below replaces one anchored statement and fails if the anchor
-- is not found exactly once.

insert into clued_private.work_claim_resource_kinds(kind,doors,note) values
  ('permission',array['connection-permission'],
   'permission:<global|profile|project:<id>>/<read|write|close|restore|audit>; a connection permission an Agent asks the Owner for');
insert into clued_private.owner_grant_actions(action,doors,title,risk) values
  ('connection.permission',array['connection-permission'],'给发起请求的连接加权限','high');

-- The requesting connection: a live Binding with a live v12 authorization.
-- No scope or context is required; asking is all it can do with this.
create function clued_private.connection_permission_binding_v1(p_token_hash text)
returns public.clued_agent_bindings language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'binding_not_authorized' using errcode='42501'; end if;
  select * into b from public.clued_agent_bindings where token_hash=p_token_hash for share;
  if not found or b.revoked_at is not null or (to_jsonb(b)->>'expires_at')::timestamptz<=clock_timestamp() then
    raise exception 'binding_not_authorized' using errcode='42501'; end if;
  select * into a from clued_private.authorizations_v12 where binding_id=b.id for share;
  if not found or a.revoked_at is not null or a.expires_at<=clock_timestamp() or a.owner_id<>b.user_id then
    raise exception 'binding_not_authorized' using errcode='42501'; end if;
  perform clued_private.authorization_account_v12(b.user_id);
  return b;
end $$;

-- permission:<context>/<action> entries to [{resource, context, action}].
create function clued_private.connection_permission_parse_v1(p_resources text[])
returns jsonb language plpgsql immutable set search_path='' as $$
declare r text; m text[]; v_out jsonb:='[]'::jsonb;
begin
  if p_resources is null or cardinality(p_resources) not between 1 and 20 then
    raise exception 'owner_request_permission_invalid' using errcode='22023'; end if;
  foreach r in array p_resources loop
    m:=regexp_match(r,'^permission:(global|profile|project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/(read|write|close|restore|audit)$');
    if m is null then raise exception 'owner_request_permission_invalid' using errcode='22023'; end if;
    v_out:=v_out||jsonb_build_object('resource',r,'context',m[1],'action',m[2]);
  end loop;
  return v_out;
end $$;

-- Each requested permission must be one the Owner could tick for this
-- connection when connecting. Returns the parsed list with already_granted.
create function clued_private.connection_permission_check_v1(p_binding uuid,p_owner uuid,p_resources text[])
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_parsed jsonb:=clued_private.connection_permission_parse_v1(p_resources);
  v_eligible jsonb:=clued_private.authorization_eligible_v12(p_owner,array['context:read','context:write','audit:read']);
  item jsonb; v_out jsonb:='[]'::jsonb;
begin
  for item in select value from jsonb_array_elements(v_parsed) loop
    if not exists(select 1 from jsonb_array_elements(v_eligible) e
        where e->>'resource_kind'='scope' and e->>'resource_id'=item->>'context' and e->>'environment'='canonical'
          and (e->'actions') ? (item->>'action')) then
      raise exception 'owner_request_permission_not_eligible' using errcode='22023'; end if;
    v_out:=v_out||(item||jsonb_build_object('already_granted',exists(
      select 1 from clued_private.authorization_entries_v12 x
      where x.binding_id=p_binding and x.resource_kind='scope' and x.resource_id=item->>'context'
        and x.environment='canonical' and (item->>'action')=any(x.actions))));
  end loop;
  return v_out;
end $$;

-- Create-time rules for connection.permission requests.
create function clued_private.connection_permission_request_check_v1(
  p_binding public.clued_agent_bindings,p_resources text[],p_input jsonb
) returns void language plpgsql stable security definer set search_path='' as $$
begin
  if p_input ? 'task_id' or p_input ? 'suggested_grant' then
    raise exception 'owner_request_permission_fields_invalid' using errcode='22023'; end if;
  if not exists(select 1 from jsonb_array_elements(
      clued_private.connection_permission_check_v1(p_binding.id,p_binding.user_id,p_resources)) x
      where not (x->>'already_granted')::boolean) then
    raise exception 'owner_request_permission_already_granted' using errcode='22023'; end if;
end $$;

-- The Agent's own connection.permission request may be read by that
-- connection without any scope; every other read keeps resolve_binding.
create function clued_private.owner_request_status_binding_v1(p_token_hash text,p_input jsonb)
returns public.clued_agent_bindings language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings;
begin
  if p_token_hash ~ '^[0-9a-f]{64}$' and coalesce(p_input->>'request_id','') ~* '^[0-9a-f-]{36}$' and exists(
      select 1 from clued_private.owner_requests_v1 r join public.clued_agent_bindings x on x.id=r.binding_id
      where r.id=(p_input->>'request_id')::uuid and r.action='connection.permission'
        and x.token_hash=p_token_hash) then
    return clued_private.connection_permission_binding_v1(p_token_hash);
  end if;
  return clued_private.resolve_binding(p_token_hash,'context:read',coalesce(p_input->>'scope','global'));
end $$;

-- The door: runs inside clued_owner_grant_v1's transaction after the grant
-- row is written. Lock order Binding -> Authorization, as approval and
-- connection management use. Any failure rolls the grant back with it.
create function clued_private.connection_permission_apply_v1(p_owner uuid,p_grant_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare g clued_private.owner_grants_v1; b public.clued_agent_bindings; a clued_private.authorizations_v12;
  v_items jsonb; item jsonb; v_use jsonb; v_keys text[];
begin
  select * into g from clued_private.owner_grants_v1 where id=p_grant_id and user_id=p_owner;
  if not found or g.action<>'connection.permission' or g.grantee_binding_id is null or g.request_id is null then
    raise exception 'owner_grant_choice_invalid' using errcode='22023'; end if;
  select * into b from public.clued_agent_bindings where id=g.grantee_binding_id and user_id=p_owner for update;
  if not found or b.revoked_at is not null or (to_jsonb(b)->>'expires_at')::timestamptz<=clock_timestamp() then
    raise exception 'connection_permission_connection_inactive' using errcode='55000'; end if;
  select * into a from clued_private.authorizations_v12 where binding_id=b.id and owner_id=p_owner for update;
  if not found or a.revoked_at is not null or a.expires_at<=clock_timestamp() then
    raise exception 'connection_permission_connection_inactive' using errcode='55000'; end if;
  v_items:=clued_private.connection_permission_check_v1(b.id,p_owner,g.resources);
  v_use:=clued_private.owner_grant_consume_v1(p_owner,b.id,g.action,g.resources,g.task_id);
  if v_use is null then raise exception 'connection_permission_grant_unavailable' using errcode='55000'; end if;
  for item in select value from jsonb_array_elements(v_items) loop
    perform clued_private.authorization_resource_v12(p_owner,'scope',item->>'context','canonical');
    insert into clued_private.authorization_entries_v12(binding_id,resource_kind,resource_id,environment,actions)
      values(b.id,'scope',item->>'context','canonical',array[item->>'action'])
    on conflict(binding_id,resource_kind,resource_id,environment) do update
      set actions=array(select distinct x from unnest(clued_private.authorization_entries_v12.actions||excluded.actions) x order by x);
  end loop;
  select array_agg(distinct k order by k) into v_keys
    from unnest(b.context_keys||array(select x->>'context' from jsonb_array_elements(v_items) x)) k;
  update public.clued_agent_bindings
    set scopes=clued_private.authorization_scope_union_v12(clued_private.authorization_selection_v12(b.id)),
      context_keys=case when '*'=any(b.context_keys) then b.context_keys else v_keys end
    where id=b.id;
  update clued_private.authorizations_v12 set version=version+1 where binding_id=b.id returning * into a;
  insert into clued_private.authorization_audit_v12(owner_id,binding_id,request_id,operation,version,selected)
    values(p_owner,b.id,a.request_id,'extend',a.version,clued_private.authorization_selection_v12(b.id));
  return jsonb_build_object('binding_id',b.id,'version',a.version,'grant_use',v_use,
    'selected',clued_private.authorization_selection_v12(b.id));
end $$;

-- Same as 20261002220000 plus permissions and connection for
-- connection.permission: what the Owner approves names each context and
-- action, and the connection it goes to.
create or replace function clued_private.owner_grant_view_v1(p_user_id uuid,p_choices jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_action clued_private.owner_grant_actions%rowtype; v_task public.clued_memories%rowtype;
  v_req clued_private.owner_requests_v1%rowtype; v_grantee public.clued_agent_bindings%rowtype;
  v_view jsonb; v_auth clued_private.authorizations_v12%rowtype;
begin
  select * into v_action from clued_private.owner_grant_actions where action=p_choices->>'action';
  if p_choices->>'task_id' is not null then
    select * into v_task from public.clued_memories where id=(p_choices->>'task_id')::uuid and user_id=p_user_id;
  end if;
  if p_choices->>'request_id' is not null then
    select * into v_req from clued_private.owner_requests_v1 where id=(p_choices->>'request_id')::uuid;
  end if;
  if p_choices->>'grantee_binding_id' is not null then
    select * into v_grantee from public.clued_agent_bindings where id=(p_choices->>'grantee_binding_id')::uuid;
  end if;
  v_view:=jsonb_build_object('action',v_action.action,'action_title',v_action.title,
    'resources',p_choices->'resources',
    'task',case when v_task.id is null then null
      else jsonb_build_object('task_id',v_task.id,'title',v_task.title) end,
    'grantee',case when v_grantee.id is null then jsonb_build_object('any_agent',true)
      else jsonb_build_object('any_agent',false,'binding_id',v_grantee.id,'agent_name',v_grantee.agent_name,
        'vendor',v_grantee.vendor) end,
    'choice',p_choices->>'choice','expires_seconds',(p_choices->>'expires_seconds')::integer,
    'max_uses',(p_choices->>'max_uses')::integer,
    'request',case when v_req.id is null then null
      else jsonb_build_object('request_id',v_req.id,'status',v_req.status,'created_at',v_req.created_at,
        'agent_note_unverified',v_req.agent_note) end);
  if v_action.action='connection.permission' and v_grantee.id is not null then
    select * into v_auth from clued_private.authorizations_v12 where binding_id=v_grantee.id;
    v_view:=v_view||jsonb_build_object(
      'connection',jsonb_build_object('binding_id',v_grantee.id,'client_name',coalesce(v_auth.client_name,v_grantee.agent_name),
        'expires_at',v_auth.expires_at,'current',clued_private.authorization_selection_v12(v_grantee.id)),
      'permissions',(select coalesce(jsonb_agg(jsonb_build_object('resource',r,'context',m[1],
          'context_name',case when m[1]='global' then '个人记忆' when m[1]='profile' then '个人资料'
            else (select p.name from public.clued_projects p where 'project:'||p.id=m[1] and p.user_id=p_user_id) end,
          'action',m[2]) order by n),'[]'::jsonb)
        from jsonb_array_elements_text(p_choices->'resources') with ordinality as t(r,n)
        cross join lateral regexp_match(r,'^permission:([^/]+)/([a-z]+)$') m));
  end if;
  return v_view;
end $$;

-- Patches. Each replaces one statement of the installed body.
create function clued_private.connection_permission_patch_v1(p_signature text,p_anchor text,p_replacement text)
returns void language plpgsql set search_path='' as $$
declare body text:=pg_get_functiondef(p_signature::regprocedure);
begin
  if (length(body)-length(replace(body,p_anchor,'')))<>length(p_anchor) then
    raise exception 'connection_permission_patch_anchor_mismatch: %',p_signature;
  end if;
  execute replace(body,p_anchor,p_replacement);
end $$;

-- Create: a connection.permission request needs only a live v12 connection.
select clued_private.connection_permission_patch_v1('public.clued_owner_request_v1(text,jsonb)',
  $a$  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',v_scope);$a$,
  $a$  v_binding:=case when p_input->>'action'='connection.permission'
    then clued_private.connection_permission_binding_v1(p_token_hash)
    else clued_private.resolve_binding(p_token_hash,'context:write',v_scope) end;$a$);
select clued_private.connection_permission_patch_v1('public.clued_owner_request_v1(text,jsonb)',
  $a$  if cardinality(v_resources)>50 then raise exception 'owner_request_resources_invalid' using errcode='22023'; end if;$a$,
  $a$  if cardinality(v_resources)>50 then raise exception 'owner_request_resources_invalid' using errcode='22023'; end if;
  if p_input->>'action'='connection.permission' then
    perform clued_private.connection_permission_request_check_v1(v_binding,v_resources,p_input); end if;$a$);

-- Status: the requesting connection reads its own permission request.
select clued_private.connection_permission_patch_v1('public.clued_owner_request_status_v1(text,jsonb)',
  $a$  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',coalesce(p_input->>'scope','global'));$a$,
  $a$  v_binding:=clued_private.owner_request_status_binding_v1(p_token_hash,p_input);$a$);

-- Confirmation: connection.permission is approved once, for the requester,
-- with the requested resources, and only from a request.
select clued_private.connection_permission_patch_v1('public.clued_owner_grant_confirmation_issue_v1(jsonb)',
  $a$      if v_choice not in ('once','grant') then raise exception 'owner_grant_choice_invalid' using errcode='22023'; end if;$a$,
  $a$      if v_choice not in ('once','grant') then raise exception 'owner_grant_choice_invalid' using errcode='22023'; end if;
      if v_req.action='connection.permission'
          and (v_choice<>'once' or coalesce(p_input->>'grantee','requester')<>'requester') then
        raise exception 'owner_grant_choice_invalid' using errcode='22023'; end if;$a$);
select clued_private.connection_permission_patch_v1('public.clued_owner_grant_confirmation_issue_v1(jsonb)',
  $a$      v_subject:='direct:'||(p_input->>'action');$a$,
  $a$      if p_input->>'action'='connection.permission' then
        raise exception 'owner_grant_action_request_only' using errcode='22023'; end if;
      v_subject:='direct:'||(p_input->>'action');$a$);

-- Grant: apply the permission in the same transaction as the grant.
select clued_private.connection_permission_patch_v1('public.clued_owner_grant_v1(jsonb)',
  $a$        grant_id=v_grant.id,decided_at=v_now where id=v_req.id;
    end if;$a$,
  $a$        grant_id=v_grant.id,decided_at=v_now where id=v_req.id;
    end if;
    if v_grant.action='connection.permission' then
      perform clued_private.connection_permission_apply_v1(v_owner,v_grant.id);
    end if;$a$);

-- Connection status reports the live scopes, so the OAuth gateway checks
-- the Binding as it is now rather than the scopes fixed in the client token.
select clued_private.connection_permission_patch_v1('public.clued_authorization_status_v12(text)',
  $a$'binding_id',b.id,'expires_at',a.expires_at,'version',a.version);$a$,
  $a$'binding_id',b.id,'expires_at',a.expires_at,'version',a.version,'scopes',to_jsonb(b.scopes));$a$);

drop function clued_private.connection_permission_patch_v1(text,text,text);

revoke all on function
  clued_private.connection_permission_binding_v1(text),
  clued_private.connection_permission_parse_v1(text[]),
  clued_private.connection_permission_check_v1(uuid,uuid,text[]),
  clued_private.connection_permission_request_check_v1(public.clued_agent_bindings,text[],jsonb),
  clued_private.owner_request_status_binding_v1(text,jsonb),
  clued_private.connection_permission_apply_v1(uuid,uuid),
  clued_private.owner_grant_view_v1(uuid,jsonb)
from public,anon,authenticated,service_role;

notify pgrst,'reload schema';
