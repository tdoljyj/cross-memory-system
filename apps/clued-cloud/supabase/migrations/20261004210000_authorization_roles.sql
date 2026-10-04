-- Permission simplification step 4 (PermissionSimplification.v0.1 §3.1 and
-- §3.2 second half, Decision b32fc5b9, Task 0756c748).
--
-- 1. "我的全部项目（含以后新建的）": the Owner can tick one scope row,
--    project:*, when connecting (or approve it through connection.permission).
--    It is stored as an ordinary authorization entry and never admits a call
--    by itself: Clued materializes it as one project:<id> entry per project
--    the Owner owns, with the same actions, now and whenever the Owner creates
--    a project. Every existing check keeps matching exact project entries.
--    The connection's context keys become '*' (a coarse gate only; delegated
--    calls are still checked against the entries).
--    Only the Owner's own projects are covered, never projects shared with
--    them. Nothing defaults to it: the Owner must pick it.
-- 2. Roles in connection.permission requests: permission:<context>/<role>,
--    role reader (read), developer (read, write, close, restore) or full
--    (read, write, close, restore, audit). The request is expanded into the
--    same per-action entries; the confirmation page lists each of them.
--
-- Presets on the consent page (只读 / 项目开发者 / 全部) are packaged
-- selections of the same entries; they need no database change.

-- ---------------------------------------------------------------------------
-- Anchored patches: each replaces one statement and fails unless the anchor
-- occurs exactly once.
create function clued_private.authorization_roles_patch_v1(p_signature text,p_anchor text,p_replacement text)
returns void language plpgsql set search_path='' as $$
declare body text:=pg_get_functiondef(p_signature::regprocedure);
begin
  if (length(body)-length(replace(body,p_anchor,'')))<>length(p_anchor) then
    raise exception 'authorization_roles_patch_anchor_mismatch: %',p_signature;
  end if;
  execute replace(body,p_anchor,p_replacement);
end $$;

-- The eligible list offers project:* after the Owner's projects.
select clued_private.authorization_roles_patch_v1('clued_private.authorization_owner_eligible_v12(uuid,text[])',
$a$      from public.clued_projects p where p.user_id=p_owner
$a$,
$r$      from public.clued_projects p where p.user_id=p_owner
    union all
    select jsonb_build_object('resource_kind','scope','resource_id','project:*',
      'environment','canonical','name','我的全部项目（含以后新建的）',
      'actions',to_jsonb(array_remove(array[
        case when 'context:read'=any(p_scopes) then 'read' end,
        case when 'context:write'=any(p_scopes) then 'write' end,
        case when 'context:write'=any(p_scopes) then 'close' end,
        case when 'context:write'=any(p_scopes) then 'restore' end,
        case when 'audit:read'=any(p_scopes) then 'audit' end],null)))
$r$);

-- project:* is a resource the Owner always owns ...
select clued_private.authorization_roles_patch_v1('clued_private.authorization_owner_resource_v12(uuid,text,text,text)',
$a$ if p_kind='scope' and p_id in ('global','profile') and p_environment='canonical' then return; end if;$a$,
$r$ if p_kind='scope' and p_id in ('global','profile','project:*') and p_environment='canonical' then return; end if;$r$);

-- ... but no call acts on it: calls name a real context.
select clued_private.authorization_roles_patch_v1('clued_private.authorization_assert_entry_v12(uuid,text,text,text,text)',
$a$ select * into a from clued_private.authorizations_v12 where binding_id=p_binding for share;$a$,
$r$ if p_kind='scope' and p_id='project:*' then raise exception 'resource_action_not_authorized' using errcode='42501'; end if;
 select * into a from clued_private.authorizations_v12 where binding_id=p_binding for share;$r$);

drop function clued_private.authorization_roles_patch_v1(text,text,text);

-- ---------------------------------------------------------------------------
-- Materialization of project:*.

-- Gives one live connection an entry for each of its Owner's projects with
-- the project:* actions (merged into any entry it already has), sets its
-- context keys to '*' and its scopes to the union of its entries.
create function clued_private.authorization_all_projects_expand_v1(p_binding uuid,p_project uuid default null)
returns void language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12; w clued_private.authorization_entries_v12;
begin
  select * into b from public.clued_agent_bindings where id=p_binding for update;
  if not found or b.revoked_at is not null or (to_jsonb(b)->>'expires_at')::timestamptz<=clock_timestamp() then return; end if;
  select * into a from clued_private.authorizations_v12 where binding_id=b.id for update;
  if not found or a.revoked_at is not null or a.expires_at<=clock_timestamp() or a.owner_id<>b.user_id then return; end if;
  select * into w from clued_private.authorization_entries_v12
    where binding_id=b.id and resource_kind='scope' and resource_id='project:*' and environment='canonical';
  if not found then return; end if;
  insert into clued_private.authorization_entries_v12(binding_id,resource_kind,resource_id,environment,actions)
    select b.id,'scope','project:'||p.id,'canonical',w.actions
      from public.clued_projects p where p.user_id=a.owner_id and (p_project is null or p.id=p_project)
  on conflict(binding_id,resource_kind,resource_id,environment) do update
    set actions=array(select distinct x from unnest(clued_private.authorization_entries_v12.actions||excluded.actions) x order by x);
  update public.clued_agent_bindings
    set context_keys=case when '*'=any(b.context_keys) then b.context_keys else array['*'] end,
      scopes=clued_private.authorization_scope_union_v12(clued_private.authorization_selection_v12(b.id))
    where id=b.id;
  insert into clued_private.authorization_audit_v12(owner_id,binding_id,request_id,operation,version,selected)
    values(a.owner_id,b.id,a.request_id,'all_projects_expand',a.version,clued_private.authorization_selection_v12(b.id));
end $$;

-- Whenever a project:* entry is written (approval, headless issuance, a
-- reduction that keeps it, or a connection.permission approval), at the end
-- of that transaction, after every other entry of the same write.
create function clued_private.authorization_all_projects_entry_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  perform clued_private.authorization_all_projects_expand_v1(new.binding_id);
  return null;
end $$;
create constraint trigger authorization_all_projects_entry_v1
  after insert or update on clued_private.authorization_entries_v12
  deferrable initially deferred for each row
  when (new.resource_kind='scope' and new.resource_id='project:*' and new.environment='canonical')
  execute function clued_private.authorization_all_projects_entry_v1();

-- A project the Owner creates later joins every live connection that has project:*.
create function clued_private.authorization_all_projects_project_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_binding uuid;
begin
  for v_binding in select e.binding_id from clued_private.authorization_entries_v12 e
      join clued_private.authorizations_v12 a on a.binding_id=e.binding_id
      where a.owner_id=new.user_id and a.revoked_at is null and a.expires_at>clock_timestamp()
        and e.resource_kind='scope' and e.resource_id='project:*' and e.environment='canonical'
      order by e.binding_id loop
    perform clued_private.authorization_all_projects_expand_v1(v_binding,new.id);
  end loop;
  return null;
end $$;
create trigger authorization_all_projects_project_v1
  after insert on public.clued_projects
  for each row execute function clued_private.authorization_all_projects_project_v1();

-- ---------------------------------------------------------------------------
-- connection.permission: project:* and roles.

create or replace function clued_private.connection_permission_parse_v1(p_resources text[])
returns jsonb language plpgsql immutable set search_path='' as $$
declare r text; m text[]; a text; v_out jsonb:='[]'::jsonb;
begin
  if p_resources is null or cardinality(p_resources) not between 1 and 20 then
    raise exception 'owner_request_permission_invalid' using errcode='22023'; end if;
  foreach r in array p_resources loop
    m:=regexp_match(r,'^permission:(global|profile|project:\*|project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/(read|write|close|restore|audit|reader|developer|full)$');
    if m is null then raise exception 'owner_request_permission_invalid' using errcode='22023'; end if;
    foreach a in array case m[2]
        when 'reader' then array['read']
        when 'developer' then array['read','write','close','restore']
        when 'full' then array['read','write','close','restore','audit']
        else array[m[2]] end loop
      v_out:=v_out||jsonb_build_object('resource',r,'context',m[1],'action',a,
        'role',case when m[2] in ('reader','developer','full') then m[2] end);
    end loop;
  end loop;
  return v_out;
end $$;

-- Same as 20261004150000 except permissions: one row per context and action,
-- roles expanded, and project:* named.
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
      'permissions',(select coalesce(jsonb_agg(jsonb_build_object('resource',x->>'resource','context',x->>'context',
          'context_name',case x->>'context' when 'global' then '个人记忆' when 'profile' then '个人资料'
            when 'project:*' then '我的全部项目（含以后新建的）'
            else (select p.name from public.clued_projects p where 'project:'||p.id=x->>'context' and p.user_id=p_user_id) end,
          'action',x->>'action','role',x->>'role') order by n),'[]'::jsonb)
        from jsonb_array_elements(clued_private.connection_permission_parse_v1(
          array(select jsonb_array_elements_text(p_choices->'resources')))) with ordinality as t(x,n)));
  end if;
  return v_view;
end $$;

revoke all on function clued_private.authorization_all_projects_expand_v1(uuid,uuid),
  clued_private.authorization_all_projects_entry_v1(),
  clued_private.authorization_all_projects_project_v1(),
  clued_private.connection_permission_parse_v1(text[]),
  clued_private.owner_grant_view_v1(uuid,jsonb)
  from public,anon,authenticated,service_role;

notify pgrst,'reload schema';
