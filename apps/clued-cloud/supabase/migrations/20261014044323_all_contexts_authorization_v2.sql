-- AllContextsAuthorization.v0.1-r2, accepted subject SHA256
-- 8f828102c87663c44cd4e9e270fde7fc72c771aaa94cef4bb8f2598f903b67b3.
-- Task d5dee826-27d7-452b-8948-48fe8ae8a961. This file installs the source
-- protocol but leaves new-policy activation closed until its ordered
-- serialization successor qualifies every early entry. No credentials,
-- business Records, memberships or existing Owner consent are widened.

create table clued_private.authorization_protocol_capabilities_v2 (
  singleton boolean primary key default true check(singleton),
  serialization_ready boolean not null default false
);
insert into clued_private.authorization_protocol_capabilities_v2 values(true,false);
create table clued_private.authorization_source_bindings_v2 (
  binding_id uuid primary key references clued_private.authorizations_v12(binding_id) on delete cascade,
  source_protocol boolean not null default false,
  initialized_at timestamptz not null default clock_timestamp()
);
create table clued_private.authorization_sources_v2 (
  id uuid primary key default gen_random_uuid(),
  binding_id uuid not null references clued_private.authorizations_v12(binding_id) on delete cascade,
  owner_id uuid not null references auth.users(id),
  kind text not null check(kind in ('legacy_effective_baseline','direct','legacy_project_policy','contexts_policy')),
  version bigint not null default 1,
  actions text[] not null check(actions <@ array['read','write','close','restore','audit','feedback_submit']::text[]),
  scope_ceiling text[] not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  receipt_id uuid references public.clued_audit_receipts(id),
  consent_ref text not null,
  created_at timestamptz not null default clock_timestamp()
);
create unique index authorization_baseline_v2 on clued_private.authorization_sources_v2(binding_id)
  where kind='legacy_effective_baseline';
create unique index authorization_live_contexts_policy_v2 on clued_private.authorization_sources_v2(binding_id)
  where kind='contexts_policy' and revoked_at is null;
create table clued_private.authorization_contributions_v2 (
  source_id uuid not null references clued_private.authorization_sources_v2(id) on delete cascade,
  resource_kind text not null check(resource_kind in ('scope','context')),
  resource_id text not null,
  environment text not null,
  qualification_id uuid,
  actions text[] not null,
  primary key(source_id,resource_kind,resource_id,environment)
);
create table clued_private.authorization_resource_overrides_v2 (
  id uuid primary key default gen_random_uuid(),
  binding_id uuid not null references clued_private.authorizations_v12(binding_id) on delete cascade,
  resource_kind text not null check(resource_kind in ('scope','context')),
  resource_id text not null,
  environment text not null,
  qualification_id uuid,
  version bigint not null default 1,
  denied_actions text[] not null default '{}',
  allowed_ceiling text[],
  limits jsonb not null default '{}'::jsonb,
  receipt_id uuid references public.clued_audit_receipts(id),
  reason text not null,
  unique(binding_id,resource_kind,resource_id,environment)
);
alter table clued_private.authorization_protocol_capabilities_v2 enable row level security;
alter table clued_private.authorization_source_bindings_v2 enable row level security;
alter table clued_private.authorization_sources_v2 enable row level security;
alter table clued_private.authorization_contributions_v2 enable row level security;
alter table clued_private.authorization_resource_overrides_v2 enable row level security;
revoke all on clued_private.authorization_protocol_capabilities_v2,
  clued_private.authorization_source_bindings_v2,clued_private.authorization_sources_v2,
  clued_private.authorization_contributions_v2,clued_private.authorization_resource_overrides_v2
  from public,anon,authenticated,service_role;

create function clued_private.authorization_serialization_ready_v2() returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce((select serialization_ready from clued_private.authorization_protocol_capabilities_v2 where singleton),false)
$$;
create function clued_private.authorization_writer_key_v2(p_owner uuid) returns bigint
language sql immutable set search_path='' as $$
  select pg_catalog.hashtextextended('clued.all-contexts-writer.v2:'||p_owner::text,0)
$$;
create function clued_private.authorization_writer_guard_v2(p_owner uuid) returns void
language plpgsql volatile security definer set search_path='' as $$
begin
  if p_owner is null then raise exception 'authorization_writer_owner_required' using errcode='42501'; end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'authorization_writer_requires_read_committed' using errcode='40001'; end if;
  perform pg_catalog.pg_advisory_xact_lock(clued_private.authorization_writer_key_v2(p_owner));
end $$;

create function clued_private.authorization_actions_v2(p_actions text[],p_scopes text[],p_kind text)
returns text[] language sql immutable set search_path='' as $$
  select coalesce(array_agg(distinct x order by x),'{}') from unnest(p_actions) x
  where x=any(case when p_kind='context' then array['read','write','close','feedback_submit']
    when p_kind='policy' then array['read','write','close','restore','audit','feedback_submit']
    else array['read','write','close','restore','audit'] end)
    and (case x when 'read' then 'context:read' when 'audit' then 'audit:read' else 'context:write' end)=any(p_scopes)
$$;
create function clued_private.authorization_resources_v2(p_owner uuid,p_scopes text[]) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(item order by item->>'resource_kind',item->>'resource_id'),'[]') from (
  select jsonb_build_object('resource_kind','scope','resource_id',v.id,'environment','canonical','name',v.name,
    'ownership','self','project_id',null,'project_name',null,'context_name',null,
    'actions',to_jsonb(clued_private.authorization_actions_v2(array['read','write','close','restore','audit'],p_scopes,'scope'))) item
    from (values('global','个人记录'),('profile','个人资料')) v(id,name)
  union all
  select jsonb_build_object('resource_kind','scope','resource_id','project:'||p.id,'environment','canonical','name',p.name,
    'ownership','self','project_id',p.id,'project_name',p.name,'context_name',null,
    'actions',to_jsonb(clued_private.authorization_actions_v2(array['read','write','close','restore','audit'],p_scopes,'scope')))
    from public.clued_projects p where p.user_id=p_owner
  union all
  select jsonb_build_object('resource_kind','context','resource_id',c.id,'environment',c.environment,'name',c.name,
    'ownership','self','project_id',p.id,'project_name',p.name,'context_name',c.name,
    'actions',to_jsonb(clued_private.authorization_actions_v2(array['read','write','close','feedback_submit'],p_scopes,'context')))
    from clued_private.development_spaces_v14 c join public.clued_projects p on p.id=c.project_id
    where c.owner_id=p_owner and p.user_id=p_owner
 ) x where jsonb_array_length(item->'actions')>0
$$;

-- Preserve invited qualifications in the eligible list, and add a macro only
-- after the ordered serialization implementation has been qualified.
alter function clued_private.authorization_eligible_v12(uuid,text[]) rename to authorization_eligible_before_contexts_v2;
create function clued_private.authorization_eligible_v12(p_owner uuid,p_scopes text[]) returns jsonb
language sql stable security definer set search_path='' as $$
 select clued_private.authorization_resources_v2(p_owner,p_scopes)
 || coalesce((select jsonb_agg(x||jsonb_build_object('ownership','membership','project_id',c.project_id,
       'project_name',p.name,'context_name',c.name))
   from jsonb_array_elements(clued_private.authorization_eligible_before_contexts_v2(p_owner,p_scopes)) x
   join clued_private.development_spaces_v14 c on c.id::text=x->>'resource_id'
   join public.clued_projects p on p.id=c.project_id where x->>'qualification_id' is not null),'[]')
 || case when clued_private.authorization_serialization_ready_v2() then jsonb_build_array(jsonb_build_object(
      'resource_kind','scope','resource_id','contexts:*','environment','canonical','name','全部上下文（含以后新建的）',
      'ownership','self','actions',to_jsonb(clued_private.authorization_actions_v2(
        array['read','write','close','restore','audit','feedback_submit'],p_scopes,'policy')))) else '[]'::jsonb end
 || coalesce((select jsonb_agg(x) from jsonb_array_elements(
      clued_private.authorization_eligible_before_contexts_v2(p_owner,p_scopes)) x where x->>'resource_id'='project:*'),'[]')
$$;

alter function clued_private.authorization_owner_resource_v12(uuid,text,text,text) rename to authorization_owner_resource_before_contexts_v2;
create function clued_private.authorization_owner_resource_v12(p_owner uuid,p_kind text,p_id text,p_environment text)
returns void language plpgsql security definer set search_path='' as $$
begin
 if p_kind='scope' and p_id='contexts:*' and p_environment='canonical' then
   if not clued_private.authorization_serialization_ready_v2() then raise exception 'all_contexts_serialization_not_ready' using errcode='42501'; end if;
   return;
 end if;
 perform clued_private.authorization_owner_resource_before_contexts_v2(p_owner,p_kind,p_id,p_environment);
end $$;

create function clued_private.authorization_add_selection_v2(p_binding uuid,p_selected jsonb,p_receipt uuid,p_ref text)
returns void language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12; req clued_private.authorization_requests_v12;
 item jsonb; snap jsonb; q uuid; sid uuid; acts text[]; row_item jsonb;
begin
 select * into b from public.clued_agent_bindings where id=p_binding;
 perform clued_private.authorization_writer_require_v2(b.user_id);
 select * into b from public.clued_agent_bindings where id=p_binding for update;
 select * into a from clued_private.authorizations_v12 where binding_id=p_binding for update;
 select * into req from clued_private.authorization_requests_v12 where id=a.request_id;
 if p_receipt is null then
   insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
     values(b.user_id,p_binding,'global','authorization_source_consent','agent_binding',p_binding::text,a.version,
       jsonb_build_object('receipt_kind','AUTHORIZATION_SOURCE_CONSENT','consent_ref',p_ref,'selected',p_selected,
         'request_id',a.request_id,'principal','native_account_session')) returning id into p_receipt;
 end if;
 for item in select value from jsonb_array_elements(p_selected) order by value->>'resource_kind',value->>'resource_id' loop
   acts:=array(select distinct jsonb_array_elements_text(item->'actions'));
   if item->>'resource_id'='contexts:*' then
     if not clued_private.authorization_serialization_ready_v2() then raise exception 'all_contexts_serialization_not_ready' using errcode='42501'; end if;
     update clued_private.authorization_source_bindings_v2 set source_protocol=true where binding_id=p_binding;
     select id into sid from clued_private.authorization_sources_v2 where binding_id=p_binding and kind='contexts_policy' and revoked_at is null;
     if sid is not null and exists(select 1 from clued_private.authorization_sources_v2 where id=sid and expires_at<=clock_timestamp()) then
       -- A new read consent never renews expired write/full consent. Retire
       -- that old identity, then create only the newly requested policy.
       update clued_private.authorization_sources_v2 set revoked_at=clock_timestamp(),version=version+1,receipt_id=p_receipt where id=sid;
       sid:=null;
     end if;
     if sid is not null then
       update clued_private.authorization_sources_v2 set actions=array(select distinct x from unnest(actions||acts) x order by x),
         scope_ceiling=array(select distinct x from unnest(scope_ceiling||clued_private.authorization_scope_union_v12(
           jsonb_build_array(jsonb_build_object('actions',acts)))) x where x=any(b.scopes) order by x),
         expires_at=a.expires_at,version=version+1,receipt_id=p_receipt,consent_ref=p_ref where id=sid;
     else
       insert into clued_private.authorization_sources_v2(binding_id,owner_id,kind,actions,scope_ceiling,expires_at,receipt_id,consent_ref)
         values(p_binding,b.user_id,'contexts_policy',acts,array(select x from unnest(clued_private.authorization_scope_union_v12(
           jsonb_build_array(jsonb_build_object('actions',acts)))) x where x=any(b.scopes)),a.expires_at,p_receipt,p_ref) returning id into sid;
     end if;
     insert into clued_private.authorization_contributions_v2 values(sid,'scope','contexts:*','canonical',null,acts)
       on conflict(source_id,resource_kind,resource_id,environment) do update set actions=excluded.actions;
     for row_item in select value from jsonb_array_elements(clued_private.authorization_resources_v2(b.user_id,b.scopes)) loop
       perform clued_private.authorization_materialize_resource_v2(p_binding,row_item->>'resource_kind',row_item->>'resource_id',row_item->>'environment');
     end loop;
   else
     select x into snap from jsonb_array_elements(req.eligible) x where x->>'resource_kind'=item->>'resource_kind'
       and x->>'resource_id'=item->>'resource_id' and x->>'environment'=item->>'environment';
     q:=nullif(snap->>'qualification_id','')::uuid;
     if q is null then
       select qualification_id into q from clued_private.authorization_entries_v12 where binding_id=p_binding
         and resource_kind=item->>'resource_kind' and resource_id=item->>'resource_id' and environment=item->>'environment';
     end if;
     insert into clued_private.authorization_sources_v2(binding_id,owner_id,kind,actions,scope_ceiling,expires_at,receipt_id,consent_ref)
       values(p_binding,b.user_id,case when item->>'resource_id'='project:*' then 'legacy_project_policy' else 'direct' end,
         acts,b.scopes,a.expires_at,p_receipt,p_ref) returning id into sid;
     insert into clued_private.authorization_contributions_v2 values(sid,item->>'resource_kind',item->>'resource_id',item->>'environment',q,acts);
     if item->>'resource_id'='project:*' then
       for row_item in select value from jsonb_array_elements(clued_private.authorization_resources_v2(b.user_id,b.scopes))
           where value->>'resource_id' like 'project:%' loop
         perform clued_private.authorization_materialize_resource_v2(p_binding,'scope',row_item->>'resource_id','canonical');
       end loop;
     end if;
   end if;
 end loop;
 perform clued_private.authorization_rebuild_projection_v2(p_binding);
end $$;

-- Every entry writer now updates sources first. This old signature is used by
-- new approval and by the legacy flat reduce protocol, never by projection.
create or replace function clued_private.authorization_replace_entries_v12(p_binding uuid,p_selected jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; old_sources boolean; new_binding boolean;
begin
 select * into b from public.clued_agent_bindings where id=p_binding;
 perform clued_private.authorization_writer_require_v2(b.user_id);
 select source_protocol into old_sources from clued_private.authorization_source_bindings_v2 where binding_id=p_binding;
 if old_sources then raise exception 'authorization_source_selection_required' using errcode='22023'; end if;
 -- New Binding is empty. Existing legacy input is an explicit replacement of
 -- that complete legacy boundary, not a capture of derived rows.
 new_binding:=not exists(select 1 from clued_private.authorization_source_bindings_v2 where binding_id=p_binding)
   and not exists(select 1 from clued_private.authorization_entries_v12 where binding_id=p_binding);
 if exists(select 1 from clued_private.authorization_entries_v12 where binding_id=p_binding) then
   perform clued_private.authorization_initialize_sources_v2(p_binding,false);
 end if;
 delete from clued_private.authorization_sources_v2 where binding_id=p_binding;
 insert into clued_private.authorization_source_bindings_v2(binding_id,source_protocol)
   values(p_binding,new_binding) on conflict(binding_id) do nothing;
 perform clued_private.authorization_add_selection_v2(p_binding,p_selected,null,'native-selected');
end $$;

-- The old deferred entry trigger re-entered its writer when projection wrote
-- a macro. Explicit approve/extend/reduce invoke materialization once instead.
drop trigger authorization_all_projects_entry_v1 on clued_private.authorization_entries_v12;
create or replace function clued_private.authorization_all_projects_expand_v1(p_binding uuid,p_project uuid default null)
returns void language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings; p record;
begin
 select * into b from public.clued_agent_bindings where id=p_binding;
 perform clued_private.authorization_writer_require_v2(b.user_id);
 perform clued_private.authorization_initialize_sources_v2(p_binding,false);
 for p in select id from public.clued_projects where user_id=b.user_id and (p_project is null or id=p_project) order by id loop
   perform clued_private.authorization_materialize_resource_v2(p_binding,'scope','project:'||p.id,'canonical');
 end loop;
 perform clued_private.authorization_rebuild_projection_v2(p_binding);
end $$;
drop trigger authorization_all_projects_project_v1 on public.clued_projects;
create function clued_private.authorization_future_project_v2() returns trigger
language plpgsql security definer set search_path='' as $$
declare bid uuid;
begin
 perform clued_private.authorization_writer_require_v2(new.user_id);
 for bid in select distinct b.id from public.clued_agent_bindings b join clued_private.authorizations_v12 a on a.binding_id=b.id
     where b.user_id=new.user_id and b.revoked_at is null and a.revoked_at is null and a.expires_at>clock_timestamp()
       and exists(select 1 from clued_private.authorization_entries_v12 e where e.binding_id=b.id
         and e.resource_kind='scope' and e.resource_id in ('project:*','contexts:*')) order by b.id loop
   perform clued_private.authorization_initialize_sources_v2(bid,false);
   perform clued_private.authorization_materialize_resource_v2(bid,'scope','project:'||new.id,'canonical');
   perform clued_private.authorization_project_resource_v2(bid,'scope','project:'||new.id,'canonical');
 end loop;
 return null;
end $$;
create trigger authorization_future_project_v2 after insert on public.clued_projects
 for each row execute function clued_private.authorization_future_project_v2();
create function clued_private.authorization_future_context_v2() returns trigger
language plpgsql security definer set search_path='' as $$
declare bid uuid;
begin
 perform clued_private.authorization_writer_require_v2(new.owner_id);
 if not exists(select 1 from public.clued_projects p where p.id=new.project_id and p.user_id=new.owner_id) then return null; end if;
 for bid in select s.binding_id from clued_private.authorization_sources_v2 s
     where s.owner_id=new.owner_id and s.kind='contexts_policy' and s.revoked_at is null
       and s.expires_at>clock_timestamp() order by s.binding_id loop
   perform clued_private.authorization_materialize_resource_v2(bid,'context',new.id::text,new.environment);
   perform clued_private.authorization_project_resource_v2(bid,'context',new.id::text,new.environment);
 end loop;
 return null;
end $$;
create trigger authorization_future_context_v2 after insert on clued_private.development_spaces_v14
 for each row execute function clued_private.authorization_future_context_v2();
create function clued_private.authorization_writer_guard_held_v2(p_owner uuid) returns boolean
language sql volatile security definer set search_path='' as $$
  select p_owner is not null and exists(select 1 from pg_catalog.pg_locks l
    where l.locktype='advisory' and l.pid=pg_catalog.pg_backend_pid() and l.granted
      and l.mode='ExclusiveLock' and l.objsubid=1
      and l.database=(select oid from pg_catalog.pg_database where datname=current_database())
      and ((l.classid::bigint<<32)|l.objid::bigint)=clued_private.authorization_writer_key_v2(p_owner))
$$;
create function clued_private.authorization_writer_require_v2(p_owner uuid) returns void
language plpgsql volatile security definer set search_path='' as $$
begin
  if not clued_private.authorization_writer_guard_held_v2(p_owner)
    or current_setting('transaction_isolation')<>'read committed' then
    raise exception 'authorization_early_writer_guard_required' using errcode='42501'; end if;
end $$;
create or replace function clued_private.authorization_actions_v2(p_actions text[],p_scopes text[],p_kind text)
returns text[] language sql immutable set search_path='' as $$
  select coalesce(array_agg(distinct x order by x),'{}') from unnest(p_actions) x
  where x=any(case when p_kind='context' then array['read','write','close','feedback_submit']
    when p_kind='policy' then array['read','write','close','restore','audit','feedback_submit']
    else array['read','write','close','restore','audit'] end)
    and (case x when 'read' then 'context:read' when 'audit' then 'audit:read' else 'context:write' end)=any(p_scopes)
$$;
create function clued_private.authorization_initialize_sources_v2(p_binding uuid,p_activate boolean default false)
returns void language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12; sid uuid; g record; context_row clued_private.development_spaces_v14;
begin
  select * into b from public.clued_agent_bindings where id=p_binding;
  if not found then raise exception 'binding_not_authorized' using errcode='42501'; end if;
  perform clued_private.authorization_writer_require_v2(b.user_id);
  select * into b from public.clued_agent_bindings where id=p_binding for update;
  select * into a from clued_private.authorizations_v12 where binding_id=p_binding for update;
  if not found or a.owner_id<>b.user_id then raise exception 'authorization_not_found' using errcode='42501'; end if;
  if exists(select 1 from clued_private.authorization_source_bindings_v2 where binding_id=p_binding) then
    if p_activate then update clued_private.authorization_source_bindings_v2 set source_protocol=true where binding_id=p_binding; end if;
    return;
  end if;
  insert into clued_private.authorization_source_bindings_v2(binding_id,source_protocol) values(p_binding,p_activate);
  insert into clued_private.authorization_sources_v2(binding_id,owner_id,kind,actions,scope_ceiling,expires_at,consent_ref)
    values(p_binding,b.user_id,'legacy_effective_baseline',
      coalesce((select array_agg(distinct x order by x) from clued_private.authorization_entries_v12 e
        cross join lateral unnest(e.actions) x where e.binding_id=p_binding),'{}'),
      b.scopes,a.expires_at,'legacy-effective-snapshot:'||a.version)
    returning id into sid;
  insert into clued_private.authorization_contributions_v2(source_id,resource_kind,resource_id,environment,qualification_id,actions)
    select sid,resource_kind,resource_id,environment,qualification_id,actions
    from clued_private.authorization_entries_v12 where binding_id=p_binding;
  for g in select z.*,e.qualification_id,e.actions entry_actions from clued_private.development_grants_v14 z
      left join clued_private.authorization_entries_v12 e on e.binding_id=z.binding_id
        and e.resource_kind='context' and e.resource_id=z.context_id::text
      where z.binding_id=p_binding order by z.context_id loop
    select * into context_row from clued_private.development_spaces_v14 where id=g.context_id;
    insert into clued_private.authorization_resource_overrides_v2(binding_id,resource_kind,resource_id,environment,
      qualification_id,denied_actions,allowed_ceiling,limits,reason)
    values(p_binding,'context',g.context_id::text,context_row.environment,g.qualification_id,
      case when g.revoked_at is not null or g.expires_at<=clock_timestamp()
        then array['read','write','close','feedback_submit'] else '{}' end,
      case when g.entry_actions is null or g.history_policy<>'EXISTING_AND_FUTURE' or g.version_policy<>'LATEST' or g.allowed_fields<>array['*']
        or not(array(select distinct case x when 'close' then 'write' else x end from unnest(g.entry_actions) x) <@ g.actions)
        then array(select distinct x from unnest(coalesce(g.entry_actions,g.actions||
          case when 'write'=any(g.actions) then array['close'] else '{}' end)) x
          where (case x when 'close' then 'write' else x end)=any(g.actions) order by x) else null end,
      jsonb_build_object('grant_id',g.id,'grant_version',g.version,'history_policy',g.history_policy,
        'version_policy',g.version_policy,'freeze_cursor',g.freeze_cursor,'since_cursor',g.since_cursor,
        'explicit_record_ids',g.explicit_record_ids,'allowed_fields',g.allowed_fields,
        'expires_at',g.expires_at,'revoked_at',g.revoked_at),'legacy_grant_ceiling');
  end loop;
end $$;

-- This observation helper takes no Binding/Context row locks and never writes.
-- Runtime assertion calls it only after its real locks and qualification checks.
create function clued_private.authorization_effective_no_lock_v2(p_binding uuid,p_kind text,p_id text,p_env text)
returns text[] language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12; o clued_private.authorization_resource_overrides_v2;
  result text[]; q uuid; c clued_private.development_spaces_v14;
begin
  select * into b from public.clued_agent_bindings where id=p_binding;
  select * into a from clued_private.authorizations_v12 where binding_id=p_binding;
  if b.id is null or a.binding_id is null or b.revoked_at is not null or a.revoked_at is not null
    or a.expires_at<=clock_timestamp() or (to_jsonb(b)->>'expires_at')::timestamptz<=clock_timestamp() then return '{}'; end if;
  if p_kind='scope' and p_id in ('contexts:*','project:*') then return '{}'; end if;
  select qualification_id into q from clued_private.authorization_entries_v12
    where binding_id=p_binding and resource_kind=p_kind and resource_id=p_id and environment=p_env;
  if p_kind='context' then
    select * into c from clued_private.development_spaces_v14 where id::text=p_id and environment=p_env;
    if not found then return '{}'; end if;
    if exists(select 1 from clued_private.development_grants_v14 current_grant where current_grant.binding_id=p_binding
      and current_grant.context_id=c.id and (current_grant.revoked_at is not null or current_grant.expires_at<=clock_timestamp())) then return '{}'; end if;
    if q is null then
      if c.owner_id<>b.user_id or not exists(select 1 from public.clued_projects p where p.id=c.project_id and p.user_id=b.user_id) then return '{}'; end if;
    elsif not exists(select 1 from clued_private.project_memberships_v13 m join public.clued_projects p
        on p.id=m.project_id and p.user_id=m.resource_owner_id
        join auth.users resource_owner on resource_owner.id=m.resource_owner_id
        where m.id=q and m.subject_id=b.user_id and m.project_id=c.project_id and m.environment=p_env
          and m.resource_owner_id=c.owner_id and m.revoked_at is null and m.expires_at>clock_timestamp()
          and to_jsonb(resource_owner)->>'deleted_at' is null and (to_jsonb(resource_owner)->>'banned_until' is null
            or (to_jsonb(resource_owner)->>'banned_until')::timestamptz<=clock_timestamp())) then return '{}'; end if;
  elsif p_id not in ('global','profile') and not exists(select 1 from public.clued_projects p
      where 'project:'||p.id=p_id and p.user_id=b.user_id and p_env='canonical') then return '{}'; end if;
  if not exists(select 1 from clued_private.authorization_source_bindings_v2 where binding_id=p_binding) then
    select actions into result from clued_private.authorization_entries_v12 where binding_id=p_binding
      and resource_kind=p_kind and resource_id=p_id and environment=p_env;
    result:=clued_private.authorization_actions_v2(coalesce(result,'{}'),b.scopes,p_kind);
    if p_kind='context' then
      select coalesce(array_agg(x order by x),'{}') into result from unnest(result) x where exists(
        select 1 from clued_private.development_grants_v14 current_grant where current_grant.binding_id=p_binding
          and current_grant.context_id=c.id and current_grant.revoked_at is null and current_grant.expires_at>clock_timestamp()
          and (case x when 'close' then 'write' else x end)=any(current_grant.actions));
    end if;
    if q is not null then
      select coalesce(array_agg(x order by x),'{}') into result from unnest(result) x
        where exists(select 1 from clued_private.project_memberships_v13 m where m.id=q and x=any(m.actions));
    end if;
    return result;
  end if;
  select coalesce(array_agg(distinct x order by x),'{}') into result
    from clued_private.authorization_sources_v2 s join clued_private.authorization_contributions_v2 e on e.source_id=s.id
    cross join lateral unnest(clued_private.authorization_actions_v2(e.actions,b.scopes,p_kind)) x
    where s.binding_id=p_binding and s.owner_id=b.user_id and s.revoked_at is null and s.expires_at>clock_timestamp()
      and x=any(s.actions) and x=any(clued_private.authorization_actions_v2(s.actions,s.scope_ceiling,p_kind))
      and e.resource_kind=p_kind and e.resource_id=p_id and e.environment=p_env
      and e.qualification_id is not distinct from q;
  select * into o from clued_private.authorization_resource_overrides_v2 where binding_id=p_binding
    and resource_kind=p_kind and resource_id=p_id and environment=p_env;
  if found then
    if (o.limits->>'revoked_at') is not null or (o.limits->>'expires_at')::timestamptz<=clock_timestamp() then return '{}'; end if;
    select coalesce(array_agg(x order by x),'{}') into result from unnest(result) x
      where not(x=any(o.denied_actions)) and (o.allowed_ceiling is null or x=any(o.allowed_ceiling));
  end if;
  if q is not null then
    select coalesce(array_agg(x order by x),'{}') into result from unnest(result) x
      where exists(select 1 from clued_private.project_memberships_v13 m where m.id=q and x=any(m.actions));
  end if;
  return result;
end $$;

-- Current Source authority is observed without rebuilding or restoring cached
-- permissions. Policy entries retain only their live, consent-clipped ceiling;
-- they are not exact-resource admission. NULL preserves the pre-Source contract.
create function clued_private.authorization_current_projection_v2(p_binding uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12; e record;
  acts text[]; selection jsonb:='[]'; scopes text[];
begin
 if not exists(select 1 from clued_private.authorization_source_bindings_v2 where binding_id=p_binding) then return null; end if;
 select * into b from public.clued_agent_bindings where id=p_binding;
 select * into a from clued_private.authorizations_v12 where binding_id=p_binding;
 if b.id is not null and a.binding_id is not null and b.revoked_at is null and a.revoked_at is null
   and a.expires_at>clock_timestamp() and ((to_jsonb(b)->>'expires_at') is null
     or (to_jsonb(b)->>'expires_at')::timestamptz>clock_timestamp()) then
   for e in select * from clued_private.authorization_entries_v12 where binding_id=p_binding
     order by resource_kind collate "C",resource_id collate "C",environment collate "C" loop
     if e.resource_kind='scope' and e.resource_id in ('project:*','contexts:*') then
       select coalesce(array_agg(distinct x order by x),'{}') into acts
         from clued_private.authorization_sources_v2 s join clued_private.authorization_contributions_v2 c on c.source_id=s.id
         cross join lateral unnest(clued_private.authorization_actions_v2(c.actions,b.scopes,'policy')) x
         where s.binding_id=p_binding and s.owner_id=b.user_id and s.revoked_at is null and s.expires_at>clock_timestamp()
           and c.resource_kind=e.resource_kind and c.resource_id=e.resource_id and c.environment=e.environment
           and c.qualification_id is null and x=any(s.actions)
           and x=any(clued_private.authorization_actions_v2(s.actions,s.scope_ceiling,'policy'));
     else
       acts:=clued_private.authorization_effective_no_lock_v2(p_binding,e.resource_kind,e.resource_id,e.environment);
     end if;
     if cardinality(acts)>0 then selection:=selection||jsonb_build_array(jsonb_build_object(
       'resource_kind',e.resource_kind,'resource_id',e.resource_id,'environment',e.environment,'actions',acts)); end if;
   end loop;
 end if;
 scopes:=coalesce(clued_private.authorization_scope_union_v12(selection),'{}');
 return jsonb_build_object('scopes',scopes,'entries',selection,'has_permissions',cardinality(scopes)>0);
end $$;

create function clued_private.authorization_current_require_v2(p_binding uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
declare projection jsonb;
begin
 projection:=clued_private.authorization_current_projection_v2(p_binding);
 if projection is not null and not (projection->>'has_permissions')::boolean then
   raise exception 'authorization_no_effective_source_permission' using errcode='42501';
 end if;
end $$;

-- Execution rechecks do not repair Source rows and do not affect Native control
-- actors. Their callers retain the existing Binding/Integration lock order.
create function clued_private.authorization_current_actor_require_v2(p_actor jsonb)
returns void language plpgsql volatile security definer set search_path='' as $$
begin
 if p_actor->>'kind'='binding' then
   perform clued_private.authorization_current_require_v2((p_actor->>'binding_id')::uuid);
 end if;
end $$;

create function clued_private.authorization_materialize_resource_v2(p_binding uuid,p_kind text,p_id text,p_env text)
returns void language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12; s record; acts text[]; c clued_private.development_spaces_v14;
begin
  select * into b from public.clued_agent_bindings where id=p_binding;
  perform clued_private.authorization_writer_require_v2(b.user_id);
  select * into b from public.clued_agent_bindings where id=p_binding for update;
  select * into a from clued_private.authorizations_v12 where binding_id=p_binding for update;
  if not found or b.revoked_at is not null or a.revoked_at is not null or a.expires_at<=clock_timestamp()
    or (to_jsonb(b)->>'expires_at')::timestamptz<=clock_timestamp() then return; end if;
  if p_kind='context' then
    select * into c from clued_private.development_spaces_v14 where id::text=p_id and environment=p_env and owner_id=b.user_id;
    if not found or not exists(select 1 from public.clued_projects p where p.id=c.project_id and p.user_id=b.user_id) then return; end if;
  elsif p_id not in ('global','profile') and not exists(select 1 from public.clued_projects p
      where 'project:'||p.id=p_id and p.user_id=b.user_id and p_env='canonical') then return; end if;
  for s in select z.* from clued_private.authorization_sources_v2 z where z.binding_id=p_binding
      and z.revoked_at is null and z.expires_at>clock_timestamp() order by z.id loop
    if s.kind='contexts_policy' then acts:=clued_private.authorization_actions_v2(s.actions,s.scope_ceiling,p_kind);
    elsif p_kind='scope' and p_id like 'project:%' then
      select actions into acts from clued_private.authorization_contributions_v2 e where e.source_id=s.id
        and e.resource_kind='scope' and e.resource_id='project:*' and e.environment='canonical';
      acts:=clued_private.authorization_actions_v2(coalesce(acts,'{}'),s.scope_ceiling,p_kind);
    else acts:='{}'; end if;
    if cardinality(acts)>0 then
      insert into clued_private.authorization_contributions_v2 values(s.id,p_kind,p_id,p_env,null,acts)
      on conflict(source_id,resource_kind,resource_id,environment) do update set actions=excluded.actions;
    end if;
  end loop;
end $$;

create function clued_private.authorization_project_resource_v2(p_binding uuid,p_kind text,p_id text,p_env text)
returns void language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12; q uuid; acts text[]; inner_acts text[];
  c clued_private.development_spaces_v14; g clued_private.development_grants_v14;
begin
 select * into b from public.clued_agent_bindings where id=p_binding;
 perform clued_private.authorization_writer_require_v2(b.user_id);
 select * into b from public.clued_agent_bindings where id=p_binding for update;
 select * into a from clued_private.authorizations_v12 where binding_id=p_binding for update;
 if not found then raise exception 'authorization_not_found' using errcode='42501'; end if;
 select e.qualification_id into q from clued_private.authorization_contributions_v2 e
   join clued_private.authorization_sources_v2 s on s.id=e.source_id
   where s.binding_id=p_binding and e.resource_kind=p_kind and e.resource_id=p_id and e.environment=p_env
   order by e.qualification_id nulls first,s.id limit 1;
 delete from clued_private.authorization_entries_v12 where binding_id=p_binding and resource_kind=p_kind
   and resource_id=p_id and environment=p_env;
 if p_kind='scope' and p_id in ('contexts:*','project:*') then
   select coalesce(array_agg(distinct x order by x),'{}') into acts from clued_private.authorization_sources_v2 s
     join clued_private.authorization_contributions_v2 e on e.source_id=s.id
     cross join lateral unnest(clued_private.authorization_actions_v2(e.actions,s.scope_ceiling,'policy')) x
     where s.binding_id=p_binding and e.resource_kind=p_kind and e.resource_id=p_id and e.environment=p_env
       and s.revoked_at is null and s.expires_at>clock_timestamp() and x=any(s.actions);
 else
   insert into clued_private.authorization_entries_v12(binding_id,resource_kind,resource_id,environment,qualification_id,actions)
     values(p_binding,p_kind,p_id,p_env,q,array['read']);
   acts:=clued_private.authorization_effective_no_lock_v2(p_binding,p_kind,p_id,p_env);
   delete from clued_private.authorization_entries_v12 where binding_id=p_binding and resource_kind=p_kind
     and resource_id=p_id and environment=p_env;
 end if;
 if p_kind='context' then
   select * into c from clued_private.development_spaces_v14 where id::text=p_id and environment=p_env for update;
   if c.id is null then return; end if;
   perform 1 from public.clued_projects where id=c.project_id for share;
   select * into g from clued_private.development_grants_v14 where context_id=c.id and binding_id=p_binding for update;
   if g.id is not null and (g.revoked_at is not null or g.expires_at<=clock_timestamp()) then
     insert into clued_private.authorization_resource_overrides_v2(binding_id,resource_kind,resource_id,environment,
       qualification_id,denied_actions,limits,reason)
       values(p_binding,'context',p_id,p_env,q,array['read','write','close','feedback_submit'],
         to_jsonb(g),'retained_grant_revocation_or_expiry')
       on conflict(binding_id,resource_kind,resource_id,environment) do update
         set denied_actions=array['read','write','close','feedback_submit'],
           version=clued_private.authorization_resource_overrides_v2.version+1;
     acts:='{}';
   elsif cardinality(acts)>0 then
     select array_agg(distinct case x when 'close' then 'write' else x end order by case x when 'close' then 'write' else x end)
       into inner_acts from unnest(acts) x;
     if g.id is null then
       insert into clued_private.development_grants_v14(context_id,binding_id,grantor,actions,history_policy,version_policy,
         freeze_cursor,allowed_fields,expires_at)
         values(c.id,p_binding,c.owner_id,inner_acts,'EXISTING_AND_FUTURE','LATEST',c.cursor,array['*'],a.expires_at);
     else
       update clued_private.development_grants_v14 set actions=inner_acts,version=version+1
         where id=g.id and actions is distinct from inner_acts;
     end if;
   end if;
 end if;
 if cardinality(acts)>0 then
   insert into clued_private.authorization_entries_v12(binding_id,resource_kind,resource_id,environment,qualification_id,actions)
     values(p_binding,p_kind,p_id,p_env,q,acts);
 end if;
 -- Preserve the consent scope ceiling in sources; cached Binding scopes are
 -- only the current effective union and never an independent grant.
 update public.clued_agent_bindings set context_keys=case when exists(select 1 from clued_private.authorization_sources_v2 source_row
   where source_row.binding_id=p_binding and source_row.kind='contexts_policy' and source_row.revoked_at is null)
   or exists(select 1 from clued_private.authorization_entries_v12 macro_entry where macro_entry.binding_id=p_binding
     and macro_entry.resource_kind='scope' and macro_entry.resource_id='project:*') then array['*'] else b.context_keys end,
   scopes=array(select distinct z from unnest(b.scopes||coalesce(
   clued_private.authorization_scope_union_v12(clued_private.authorization_selection_v12(p_binding)),'{}')) z order by z) where id=p_binding;
end $$;

create or replace function clued_private.authorization_rebuild_projection_v2(p_binding uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12; resource_row record;
 source_scopes text[]; projected_scopes text[];
begin
 select * into b from public.clued_agent_bindings where id=p_binding;
 perform clued_private.authorization_writer_require_v2(b.user_id);
 select * into b from public.clued_agent_bindings where id=p_binding for update;
 select * into a from clued_private.authorizations_v12 where binding_id=p_binding for update;
 select coalesce(array_agg(distinct x order by x),'{}') into source_scopes
   from clued_private.authorization_sources_v2 s cross join lateral unnest(s.scope_ceiling) x
   where s.binding_id=p_binding and s.revoked_at is null and s.expires_at>clock_timestamp();
 if cardinality(source_scopes)=0 then
   raise exception 'authorization_empty_projection_requires_binding_revoke' using errcode='22023',
     detail='本次修改未保存。此连接已无有效授权，请使用“撤销连接”或重新授权。';
 end if;
 update public.clued_agent_bindings set context_keys=case when exists(select 1 from clued_private.authorization_sources_v2 source_row
   where source_row.binding_id=p_binding and source_row.kind='contexts_policy' and source_row.revoked_at is null)
   or exists(select 1 from clued_private.authorization_sources_v2 source_row join clued_private.authorization_contributions_v2 contribution on contribution.source_id=source_row.id
     where source_row.binding_id=p_binding and contribution.resource_kind='scope' and contribution.resource_id='project:*')
   then array['*'] else b.context_keys end,scopes=source_scopes where id=p_binding;
 delete from clued_private.authorization_entries_v12 where binding_id=p_binding;
 for resource_row in select distinct e.resource_kind,e.resource_id,e.environment
   from clued_private.authorization_contributions_v2 e join clued_private.authorization_sources_v2 s on s.id=e.source_id
   where s.binding_id=p_binding order by e.resource_kind,e.resource_id,e.environment loop
   perform clued_private.authorization_project_resource_v2(p_binding,resource_row.resource_kind,resource_row.resource_id,resource_row.environment);
 end loop;
 projected_scopes:=coalesce(clued_private.authorization_scope_union_v12(clued_private.authorization_selection_v12(p_binding)),'{}');
 if cardinality(projected_scopes)=0 then
   raise exception 'authorization_empty_projection_requires_binding_revoke' using errcode='22023',
     detail='本次修改未保存。该操作会移除连接的最后一项有效权限，请使用“撤销连接”。';
 end if;
 update public.clued_agent_bindings set scopes=projected_scopes where id=p_binding;
 insert into clued_private.authorization_audit_v12(owner_id,binding_id,request_id,operation,version,selected)
   values(b.user_id,p_binding,a.request_id,'sources_projection',a.version,clued_private.authorization_selection_v12(p_binding));
end $$;

alter function clued_private.authorization_assert_entry_v12(uuid,text,text,text,text) rename to authorization_assert_entry_before_sources_v2;
create function clued_private.authorization_assert_entry_v12(p_binding uuid,p_kind text,p_id text,p_environment text,p_action text)
returns void language plpgsql security definer set search_path='' as $$
begin
 if p_kind='scope' and p_id in ('contexts:*','project:*') then
   raise exception 'resource_action_not_authorized' using errcode='42501'; end if;
 perform clued_private.authorization_assert_entry_before_sources_v2(p_binding,p_kind,p_id,p_environment,p_action);
 if exists(select 1 from clued_private.authorization_source_bindings_v2 where binding_id=p_binding)
   and not(p_action=any(clued_private.authorization_effective_no_lock_v2(p_binding,p_kind,p_id,p_environment))) then
   raise exception 'resource_action_not_authorized' using errcode='42501'; end if;
end $$;

-- Diagnostic locators may show live names only with actual Native ownership
-- or the exact still-current qualification selected for this Binding.
create function clued_private.authorization_resource_metadata_v2(p_binding uuid,p_kind text,p_id text,p_env text,p_qualification uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a clued_private.authorizations_v12; c clued_private.development_spaces_v14; p public.clued_projects;
 m clued_private.project_memberships_v13; ownership text;
 unavailable jsonb:=jsonb_build_object('availability','unavailable','qualification_status','unavailable','ownership','unavailable',
   'name',null,'project_id',null,'project_name',null,'context_name',null);
begin
 select * into a from clued_private.authorizations_v12 where binding_id=p_binding;
 if not found then return unavailable; end if;
 if p_kind='scope' then
   if p_env<>'canonical' then return unavailable; end if;
   if p_id in ('global','profile','project:*','contexts:*') then
     return jsonb_build_object('availability','available','qualification_status','current','ownership','self','name',case p_id
       when 'global' then '个人记录' when 'profile' then '个人资料' when 'project:*' then '我的全部项目（含以后新建的）'
       else '全部上下文（含以后新建的）' end,'project_id',null,'project_name',null,'context_name',null);
   end if;
   select * into p from public.clued_projects where 'project:'||id=p_id and user_id=a.owner_id;
   if not found then return unavailable; end if;
   return jsonb_build_object('availability','available','qualification_status','current','ownership','self',
     'name',p.name,'project_id',p.id,'project_name',p.name,'context_name',null);
 end if;
 select * into c from clued_private.development_spaces_v14 where id::text=p_id and environment=p_env;
 if not found then return unavailable; end if;
 select * into p from public.clued_projects where id=c.project_id;
 if c.owner_id=a.owner_id and p.user_id=a.owner_id then ownership:='self';
 else
   select * into m from clued_private.project_memberships_v13 where id=p_qualification and subject_id=a.owner_id
     and project_id=c.project_id and environment=c.environment and resource_owner_id=c.owner_id
     and resource_owner_id=p.user_id and revoked_at is null and expires_at>clock_timestamp();
   if not found or not exists(select 1 from auth.users u where u.id=c.owner_id
     and to_jsonb(u)->>'deleted_at' is null and (to_jsonb(u)->>'banned_until' is null
       or (to_jsonb(u)->>'banned_until')::timestamptz<=clock_timestamp())) then return unavailable; end if;
   ownership:='membership';
 end if;
 return jsonb_build_object('availability','available','qualification_status','current','ownership',ownership,
   'name',c.name,'project_id',p.id,'project_name',p.name,'context_name',c.name);
end $$;

create function clued_private.authorization_limits_view_v2(p_binding uuid,p_kind text,p_id text,p_env text) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce((select o.limits from clued_private.authorization_resource_overrides_v2 o
   where o.binding_id=p_binding and o.resource_kind=p_kind and o.resource_id=p_id and o.environment=p_env),'{}')
 ||coalesce((select jsonb_build_object('grant_id',g.id,'grant_version',g.version,'actions',g.actions,
   'history_policy',g.history_policy,'version_policy',g.version_policy,'freeze_cursor',g.freeze_cursor,'since_cursor',g.since_cursor,
   'explicit_record_ids',g.explicit_record_ids,'allowed_fields',g.allowed_fields,'expires_at',g.expires_at,'revoked_at',g.revoked_at)
   from clued_private.development_grants_v14 g join clued_private.development_spaces_v14 c on c.id=g.context_id
   where g.binding_id=p_binding and p_kind='context' and c.id::text=p_id and c.environment=p_env),'{}')
 ||jsonb_build_object('expires_at',least(
   (select a.expires_at from clued_private.authorizations_v12 a where a.binding_id=p_binding),
   (select (o.limits->>'expires_at')::timestamptz from clued_private.authorization_resource_overrides_v2 o
     where o.binding_id=p_binding and o.resource_kind=p_kind and o.resource_id=p_id and o.environment=p_env),
   (select g.expires_at from clued_private.development_grants_v14 g where p_kind='context' and g.binding_id=p_binding and g.context_id::text=p_id)))
$$;
create function clued_private.authorization_precise_capability_v2(p_binding uuid,p_kind text,p_id text,p_env text) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('supported',case when p_kind='context' then exists(
   select 1 from clued_private.development_spaces_v14 c join public.clued_projects p on p.id=c.project_id
     join clued_private.development_grants_v14 g on g.context_id=c.id and g.binding_id=p_binding
     where c.id::text=p_id and c.environment=p_env and c.owner_id=a.owner_id and p.user_id=a.owner_id)
   else p_kind='scope' and p_env='canonical' and p_id not in ('project:*','contexts:*') and exists(
     select 1 from clued_private.authorization_resource_overrides_v2 o where o.binding_id=p_binding
       and o.resource_kind=p_kind and o.resource_id=p_id and o.environment=p_env)
     and (p_id in ('global','profile') or exists(select 1 from public.clued_projects p where 'project:'||p.id=p_id and p.user_id=a.owner_id)) end,
   'authorization_version',a.version,
   'current_expires_at',clued_private.authorization_limits_view_v2(p_binding,p_kind,p_id,p_env)->'expires_at',
   'grant_id',(select g.id from clued_private.development_grants_v14 g where p_kind='context' and g.binding_id=p_binding and g.context_id::text=p_id),
   'grant_version',(select g.version from clued_private.development_grants_v14 g where p_kind='context' and g.binding_id=p_binding and g.context_id::text=p_id),
   'override_id',(select o.id from clued_private.authorization_resource_overrides_v2 o where o.binding_id=p_binding
      and o.resource_kind=p_kind and o.resource_id=p_id and o.environment=p_env),
   'override_version',(select o.version from clued_private.authorization_resource_overrides_v2 o where o.binding_id=p_binding
      and o.resource_kind=p_kind and o.resource_id=p_id and o.environment=p_env),
   'available_actions',coalesce((select array_agg(distinct x order by x) from clued_private.authorization_sources_v2 s
     join clued_private.authorization_contributions_v2 e on e.source_id=s.id
     cross join lateral unnest(clued_private.authorization_actions_v2(e.actions,s.scope_ceiling,p_kind)) x
     where s.binding_id=p_binding and s.owner_id=a.owner_id and s.revoked_at is null and s.expires_at>clock_timestamp()
       and e.resource_kind=p_kind and e.resource_id=p_id and e.environment=p_env and e.qualification_id is null and x=any(s.actions)),'{}'))
 from clued_private.authorizations_v12 a where a.binding_id=p_binding
$$;

create function clued_private.authorization_sources_view_v2(p_binding uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'selection_format',case when exists(select 1 from clued_private.authorization_source_bindings_v2
     where binding_id=p_binding and source_protocol) then 'sources_v1' else 'flat_v12' end,
  'sources',coalesce((select jsonb_agg(jsonb_build_object('source_id',s.id,'version',s.version,'kind',s.kind,
    'actions',s.actions,'expires_at',s.expires_at,'revoked_at',s.revoked_at,'receipt_id',s.receipt_id,'consent_ref',s.consent_ref,
    'contributions',coalesce((select jsonb_agg(jsonb_build_object('resource_kind',e.resource_kind,'resource_id',e.resource_id,
      'environment',e.environment,'qualification_id',e.qualification_id,'actions',e.actions)
      order by e.resource_kind,e.resource_id,e.environment) from clued_private.authorization_contributions_v2 e where e.source_id=s.id),'[]'))
    order by s.id) from clued_private.authorization_sources_v2 s where s.binding_id=p_binding and s.revoked_at is null),'[]'),
  'overrides',coalesce((select jsonb_agg(jsonb_build_object('override_id',o.id,'version',o.version,
    'resource_kind',o.resource_kind,'resource_id',o.resource_id,'environment',o.environment,'qualification_id',o.qualification_id,
    'denied_actions',o.denied_actions,'allowed_ceiling',o.allowed_ceiling,'limits',o.limits,'reason',o.reason) order by o.id)
    from clued_private.authorization_resource_overrides_v2 o where o.binding_id=p_binding),'[]'),
  'grants',coalesce((select jsonb_agg(jsonb_build_object('resource_kind',e.resource_kind,'resource_id',e.resource_id,
    'environment',e.environment,'qualification_id',e.qualification_id,'actions',e.actions,
    'effective_actions',clued_private.authorization_effective_no_lock_v2(p_binding,e.resource_kind,e.resource_id,e.environment),
    'limits',clued_private.authorization_limits_view_v2(p_binding,e.resource_kind,e.resource_id,e.environment),
    'precise_limit_confirmation',clued_private.authorization_precise_capability_v2(p_binding,e.resource_kind,e.resource_id,e.environment),
    'source_refs',coalesce((select jsonb_agg(jsonb_build_object('source_id',s.id,'version',s.version,'kind',s.kind) order by s.id)
       from clued_private.authorization_sources_v2 s join clued_private.authorization_contributions_v2 c on c.source_id=s.id
       where s.binding_id=p_binding and c.resource_kind=e.resource_kind and c.resource_id=e.resource_id and c.environment=e.environment),'[]'))
       ||clued_private.authorization_resource_metadata_v2(p_binding,e.resource_kind,e.resource_id,e.environment,e.qualification_id)
    order by e.resource_kind,e.resource_id,e.environment) from (
      select resource_kind,resource_id,environment,qualification_id,actions from clued_private.authorization_entries_v12 where binding_id=p_binding
      union all
      select o.resource_kind,o.resource_id,o.environment,o.qualification_id,'{}'::text[] from clued_private.authorization_resource_overrides_v2 o
        where o.binding_id=p_binding and not exists(select 1 from clued_private.authorization_entries_v12 projected
          where projected.binding_id=p_binding and projected.resource_kind=o.resource_kind
            and projected.resource_id=o.resource_id and projected.environment=o.environment)
    ) e),'[]'))
$$;
create function clued_private.authorization_coverage_v2(p_binding uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare b public.clued_agent_bindings; s clued_private.authorization_sources_v2; differences jsonb:='[]'; r jsonb; actual text[]; wanted text[];
begin
 select * into b from public.clued_agent_bindings where id=p_binding;
 select * into s from clued_private.authorization_sources_v2 where binding_id=p_binding and kind='contexts_policy'
   and revoked_at is null and expires_at>clock_timestamp();
 if not found then return jsonb_build_object('status','legacy','differences','[]'::jsonb); end if;
 for r in select value from jsonb_array_elements(clued_private.authorization_resources_v2(b.user_id,s.scope_ceiling)) loop
   actual:=clued_private.authorization_effective_no_lock_v2(p_binding,r->>'resource_kind',r->>'resource_id',r->>'environment');
   wanted:=clued_private.authorization_actions_v2(s.actions,s.scope_ceiling,r->>'resource_kind');
   if not(wanted <@ actual) or exists(select 1 from clued_private.authorization_resource_overrides_v2 o
       where o.binding_id=p_binding and o.resource_kind=r->>'resource_kind' and o.resource_id=r->>'resource_id'
         and o.environment=r->>'environment' and (cardinality(o.denied_actions)>0 or o.allowed_ceiling is not null
           or coalesce(o.limits->>'history_policy','EXISTING_AND_FUTURE')<>'EXISTING_AND_FUTURE'
           or coalesce(o.limits->>'version_policy','LATEST')<>'LATEST'
           or coalesce(o.limits->'allowed_fields','["*"]'::jsonb)<>'["*"]'::jsonb)) then
     differences:=differences||jsonb_build_array(r||jsonb_build_object('actual_actions',actual,'requested_actions',wanted,
       'missing_actions',array(select x from unnest(wanted) x where not x=any(actual)),
       'limits',coalesce((select o.limits from clued_private.authorization_resource_overrides_v2 o where o.binding_id=p_binding
         and o.resource_kind=r->>'resource_kind' and o.resource_id=r->>'resource_id' and o.environment=r->>'environment'),'{}')));
   end if;
 end loop;
 return jsonb_build_object('status',case when jsonb_array_length(differences)=0 then 'complete' else 'restricted' end,'differences',differences);
end $$;

create function clued_private.authorization_management_list_v2(p_owner uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('bindings',coalesce((select jsonb_agg(jsonb_build_object('binding_id',b.id,
    'client_id',a.client_id,'client_name',a.client_name,'agent_name',b.agent_name,'vendor',b.vendor,
    'scopes',b.scopes,
    'created_at',b.created_at,'last_used_at',b.last_used_at,'expires_at',a.expires_at,'revoked_at',a.revoked_at,
    'version',a.version,'issuance',a.issuance,'coverage',clued_private.authorization_coverage_v2(b.id))
     ||jsonb_build_object('active',b.revoked_at is null and a.revoked_at is null and a.expires_at>clock_timestamp())
     ||clued_private.authorization_sources_view_v2(b.id) order by b.created_at desc)
   from public.clued_agent_bindings b join clued_private.authorizations_v12 a on a.binding_id=b.id
   where b.user_id=p_owner and a.owner_id=p_owner),'[]'))
$$;

create function clued_private.authorization_reduce_sources_v2(p_owner uuid,p_binding uuid,p_input jsonb,p_receipt uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
declare item jsonb; s clued_private.authorization_sources_v2; o clued_private.authorization_resource_overrides_v2;
 acts text[]; denied text[]; ceiling text[]; q uuid; supported text[];
begin
 perform clued_private.authorization_writer_require_v2(p_owner);
 if jsonb_typeof(p_input->'sources') is distinct from 'array' or jsonb_typeof(p_input->'exceptions') is distinct from 'array'
   or jsonb_array_length(p_input->'sources')+jsonb_array_length(p_input->'exceptions')>100
   or exists(select 1 from jsonb_array_elements(p_input->'sources') x group by x->>'source_id' having count(*)>1)
   or exists(select 1 from jsonb_array_elements(p_input->'exceptions') x
     group by x->>'resource_kind',x->>'resource_id',x->>'environment' having count(*)>1) then
   raise exception 'authorization_sources_input_invalid' using errcode='22023'; end if;
 for item in select value from jsonb_array_elements(p_input->'sources') order by value->>'source_id' loop
   if exists(select 1 from jsonb_object_keys(item) k where k not in ('source_id','base_version','action_cap'))
     or jsonb_typeof(item->'action_cap') is distinct from 'array' then
     raise exception 'authorization_sources_input_invalid' using errcode='22023'; end if;
   select * into s from clued_private.authorization_sources_v2 where id=(item->>'source_id')::uuid
     and binding_id=p_binding and owner_id=p_owner and revoked_at is null for update;
   if not found or s.version is distinct from (item->>'base_version')::bigint then
     raise exception 'authorization_source_version_conflict' using errcode='40001'; end if;
   acts:=array(select distinct jsonb_array_elements_text(item->'action_cap'));
   if not(acts <@ s.actions) then raise exception 'authorization_reduce_cannot_expand' using errcode='42501'; end if;
   update clued_private.authorization_sources_v2 set actions=acts,version=version+1,receipt_id=p_receipt,
     revoked_at=case when cardinality(acts)=0 then clock_timestamp() end where id=s.id;
 end loop;
 for item in select value from jsonb_array_elements(p_input->'exceptions')
   order by value->>'resource_kind',value->>'resource_id',value->>'environment' loop
   if exists(select 1 from jsonb_object_keys(item) k where k not in ('override_id','base_version','resource_kind','resource_id',
      'environment','qualification_id','denied_actions','allowed_ceiling')) or item->>'resource_id' in ('project:*','contexts:*') then
     raise exception 'authorization_exception_invalid' using errcode='22023'; end if;
   select qualification_id into q from clued_private.authorization_entries_v12 where binding_id=p_binding
     and resource_kind=item->>'resource_kind' and resource_id=item->>'resource_id' and environment=item->>'environment';
   if not found and not exists(select 1 from clued_private.authorization_contributions_v2 e
     join clued_private.authorization_sources_v2 contribution_source on contribution_source.id=e.source_id where contribution_source.binding_id=p_binding
       and e.resource_kind=item->>'resource_kind' and e.resource_id=item->>'resource_id' and e.environment=item->>'environment') then
     raise exception 'authorization_exception_resource_invalid' using errcode='42501'; end if;
   if item ? 'qualification_id' and nullif(item->>'qualification_id','')::uuid is distinct from q then
     raise exception 'authorization_exception_qualification_conflict' using errcode='40001'; end if;
   supported:=case when item->>'resource_kind'='context' then array['read','write','close','feedback_submit']
     else array['read','write','close','restore','audit'] end;
   select * into o from clued_private.authorization_resource_overrides_v2 where binding_id=p_binding
     and resource_kind=item->>'resource_kind' and resource_id=item->>'resource_id' and environment=item->>'environment' for update;
   if found then
     if o.id is distinct from (item->>'override_id')::uuid or o.version is distinct from (item->>'base_version')::bigint then
       raise exception 'authorization_override_version_conflict' using errcode='40001'; end if;
   elsif item ? 'override_id' or item ? 'base_version' then
     raise exception 'authorization_override_version_conflict' using errcode='40001';
   end if;
   if item ? 'denied_actions' and jsonb_typeof(item->'denied_actions') is distinct from 'array'
      or item ? 'allowed_ceiling' and jsonb_typeof(item->'allowed_ceiling') not in ('array','null') then
     raise exception 'authorization_exception_invalid' using errcode='22023'; end if;
   denied:=case when item ? 'denied_actions' then array(select distinct jsonb_array_elements_text(item->'denied_actions'))
     else coalesce(o.denied_actions,'{}') end;
   ceiling:=case when item ? 'allowed_ceiling' and jsonb_typeof(item->'allowed_ceiling')='array'
     then array(select distinct jsonb_array_elements_text(item->'allowed_ceiling')) else o.allowed_ceiling end;
   if not(denied <@ supported) or not(coalesce(o.denied_actions,'{}') <@ denied)
     or ceiling is not null and (not(ceiling <@ supported) or o.allowed_ceiling is not null and not(ceiling <@ o.allowed_ceiling))
     or item ? 'allowed_ceiling' and jsonb_typeof(item->'allowed_ceiling')='null' and o.allowed_ceiling is not null then
     raise exception 'authorization_reduce_cannot_expand' using errcode='42501'; end if;
   insert into clued_private.authorization_resource_overrides_v2(binding_id,resource_kind,resource_id,environment,qualification_id,
     denied_actions,allowed_ceiling,limits,receipt_id,reason)
     values(p_binding,item->>'resource_kind',item->>'resource_id',item->>'environment',q,denied,ceiling,
       coalesce(o.limits,'{}'),p_receipt,'native_exact_reduce')
     on conflict(binding_id,resource_kind,resource_id,environment) do update set denied_actions=excluded.denied_actions,
       allowed_ceiling=excluded.allowed_ceiling,version=clued_private.authorization_resource_overrides_v2.version+1,
       receipt_id=p_receipt,reason='native_exact_reduce';
 end loop;
 perform clued_private.authorization_rebuild_projection_v2(p_binding);
end $$;

create or replace function public.clued_authorization_manage_v12(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.authorization_owner_v12(); a clued_private.authorizations_v12;
 b uuid:=nullif(p_input->>'binding_id','')::uuid; op text:=p_input->>'op'; selected jsonb; receipt uuid; source_mode boolean;
begin
 perform clued_private.intake_payload_cap_v1(p_input);
 if op='list' then return clued_private.authorization_management_list_v2(u); end if;
 if op in ('limit_confirmation_issue','limit_confirm') then
   return clued_private.authorization_precise_confirmation_v2(u,p_input); end if;
 if op not in ('revoke','reduce') then raise exception 'invalid_authorization_operation' using errcode='22023'; end if;
 perform clued_private.authorization_writer_require_v2(u);
 perform 1 from public.clued_agent_bindings where id=b and user_id=u for update;
 if not found then raise exception 'owned_binding_required' using errcode='42501'; end if;
 select * into a from clued_private.authorizations_v12 where binding_id=b and owner_id=u for update;
 if not found then raise exception 'authorization_not_found' using errcode='42501'; end if;
 if a.version is distinct from (p_input->>'base_version')::bigint or a.revoked_at is not null then
   raise exception 'authorization_version_conflict' using errcode='40001'; end if;
 insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
   values(u,b,'global','authorization_'||op,'agent_binding',b::text,a.version+1,
     jsonb_build_object('receipt_kind','AUTHORIZATION_SOURCE_CHANGE','principal','native_account_session','input',p_input))
   returning id into receipt;
 if op='revoke' then
   update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=b;
   update clued_private.authorization_sources_v2 set revoked_at=clock_timestamp(),version=version+1,receipt_id=receipt
     where binding_id=b and revoked_at is null;
   update clued_private.authorizations_v12 set revoked_at=clock_timestamp(),version=version+1 where binding_id=b returning * into a;
 else
   select source_protocol into source_mode from clued_private.authorization_source_bindings_v2 where binding_id=b;
   if source_mode then
     if p_input->>'selection_format' is distinct from 'sources_v1' or p_input ? 'selected' then
       raise exception 'authorization_source_selection_required_sources_v1' using errcode='22023'; end if;
     perform clued_private.authorization_reduce_sources_v2(u,b,p_input,receipt);
   else
     if p_input->>'selection_format'='sources_v1' then raise exception 'authorization_legacy_flat_selection_required' using errcode='22023'; end if;
     selected:=p_input->'selected';
     perform clued_private.authorization_validate_selection_v12(selected,clued_private.authorization_selection_v12(b));
     perform clued_private.authorization_replace_entries_v12(b,selected);
   end if;
   update clued_private.authorizations_v12 set version=version+1 where binding_id=b returning * into a;
 end if;
 insert into clued_private.authorization_audit_v12(owner_id,binding_id,request_id,operation,version,selected)
   values(u,b,a.request_id,op,a.version,clued_private.authorization_selection_v12(b));
 return jsonb_build_object('binding_id',b,'version',a.version,'expires_at',a.expires_at,'revoked_at',a.revoked_at,
   'receipt_id',receipt,'selected',clued_private.authorization_selection_v12(b))||clued_private.authorization_sources_view_v2(b);
end $$;

create function clued_private.authorization_grant_changed_v2(p_binding uuid,p_context uuid,p_receipt uuid,p_reason text)
returns void language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings; c clued_private.development_spaces_v14; g clued_private.development_grants_v14;
 q uuid; ceiling text[]; audit_receipt uuid;
begin
 select * into b from public.clued_agent_bindings where id=p_binding;
 perform clued_private.authorization_writer_require_v2(b.user_id);
 if not exists(select 1 from clued_private.authorizations_v12 where binding_id=p_binding) then return; end if;
 perform clued_private.authorization_initialize_sources_v2(p_binding,false);
 select * into c from clued_private.development_spaces_v14 where id=p_context;
 select * into g from clued_private.development_grants_v14 where context_id=p_context and binding_id=p_binding;
 if c.id is null or g.id is null then raise exception 'grant_not_available' using errcode='42501'; end if;
 select qualification_id into q from clued_private.authorization_entries_v12 where binding_id=p_binding
   and resource_kind='context' and resource_id=p_context::text and environment=c.environment;
 select array_agg(distinct x order by x) into ceiling from unnest(g.actions||
   case when 'write'=any(g.actions) then array['close'] else '{}' end) x;
 insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
   values(b.user_id,p_binding,'project:'||c.project_id,'authorization_grant_ceiling','development_grant',g.id::text,g.version,
     jsonb_build_object('receipt_kind','GRANT_CEILING_RECORDED','development_operation_receipt_id',p_receipt,'reason',p_reason))
   returning id into audit_receipt;
 insert into clued_private.authorization_resource_overrides_v2(binding_id,resource_kind,resource_id,environment,qualification_id,
   denied_actions,allowed_ceiling,limits,receipt_id,reason)
   values(p_binding,'context',p_context::text,c.environment,q,
     case when g.revoked_at is not null or g.expires_at<=clock_timestamp() then array['read','write','close','feedback_submit'] else '{}' end,
     ceiling,jsonb_build_object('grant_id',g.id,'grant_version',g.version,'history_policy',g.history_policy,
       'version_policy',g.version_policy,'freeze_cursor',g.freeze_cursor,'since_cursor',g.since_cursor,
       'explicit_record_ids',g.explicit_record_ids,'allowed_fields',g.allowed_fields,'expires_at',g.expires_at,'revoked_at',g.revoked_at),
     audit_receipt,p_reason)
   on conflict(binding_id,resource_kind,resource_id,environment) do update set
     denied_actions=array(select distinct x from unnest(clued_private.authorization_resource_overrides_v2.denied_actions||excluded.denied_actions) x order by x),
     allowed_ceiling=case when clued_private.authorization_resource_overrides_v2.allowed_ceiling is null then excluded.allowed_ceiling
       else array(select x from unnest(excluded.allowed_ceiling) x where x=any(clued_private.authorization_resource_overrides_v2.allowed_ceiling)) end,
     limits=excluded.limits,version=clued_private.authorization_resource_overrides_v2.version+1,receipt_id=audit_receipt,reason=p_reason;
 perform clued_private.authorization_project_resource_v2(p_binding,'context',p_context::text,c.environment);
end $$;

-- Broad canonical reads use the same live-source predicate before LIMIT.
do $patch$
declare definition text:=pg_get_functiondef('public.clued_record_list(text,jsonb)'::regprocedure);
 anchor text:=$a$and e.environment='canonical' and 'read'=any(e.actions)$a$;
begin
 if strpos(definition,anchor)=0 then raise exception 'all_contexts_record_list_anchor_changed'; end if;
 execute replace(definition,anchor,$a$and e.environment='canonical' and 'read'=any(e.actions)
        and 'read'=any(clued_private.authorization_effective_no_lock_v2(b.id,'scope',e.resource_id,'canonical'))$a$);
 definition:=pg_get_functiondef('clued_private.development_execute_authorized_v14(uuid,uuid,jsonb)'::regprocedure);
 anchor:=$a$not(('project:'||c.project_id)=any(b.context_keys))$a$;
 if strpos(definition,anchor)=0 then raise exception 'all_contexts_development_keys_anchor_changed'; end if;
 execute replace(definition,anchor,$a$not('*'=any(b.context_keys) or ('project:'||c.project_id)=any(b.context_keys))$a$);
end $patch$;

create or replace function clued_private.authorization_context_grant_v13(p_actor uuid,p_binding uuid,p_request uuid,p_item jsonb,p_expires_at timestamptz)
returns void language plpgsql security definer set search_path='' as $$
declare c clued_private.development_spaces_v14; e clued_private.authorization_entries_v12; g clued_private.development_grants_v14;
 m clued_private.project_memberships_v13; op_row clued_private.development_operations_v14; payload jsonb; v_result jsonb;
begin
 perform clued_private.authorization_writer_require_v2(p_actor);
 perform 1 from public.clued_agent_bindings where id=p_binding and user_id=p_actor for update;
 if not found then raise exception 'owned_binding_required' using errcode='42501'; end if;
 perform 1 from clued_private.authorizations_v12 where binding_id=p_binding and owner_id=p_actor for update;
 select * into e from clued_private.authorization_entries_v12 where binding_id=p_binding and resource_kind='context'
   and resource_id=p_item->>'resource_id' and environment=p_item->>'environment';
 if not found then raise exception 'explicit_development_authorization_required' using errcode='42501'; end if;
 select * into c from clued_private.development_spaces_v14 where id::text=e.resource_id and environment=e.environment for update;
 perform 1 from public.clued_projects where id=c.project_id for share;
 if e.qualification_id is null then
   if c.owner_id is distinct from p_actor then raise exception 'owner_qualification_required' using errcode='42501'; end if;
 else
   m:=clued_private.project_context_membership_v13(p_actor,c.id,c.environment,e.qualification_id);
 end if;
 perform clued_private.authorization_project_resource_v2(p_binding,'context',c.id::text,c.environment);
 select * into g from clued_private.development_grants_v14 where context_id=c.id and binding_id=p_binding for update;
 if m.id is not null then
   update clued_private.development_grants_v14 set expires_at=least(expires_at,m.expires_at) where id=g.id returning * into g;
 end if;
 payload:=jsonb_build_object('context_id',c.id,'binding_id',p_binding,'membership_id',m.id,'actions',e.actions,
   'source_refs',(clued_private.authorization_sources_view_v2(p_binding)->'sources'));
 insert into clued_private.development_operations_v14(owner_id,actor_user_id,binding_ref,context_id,op,idempotency_key,request_hash,canonical_version,result)
   values(c.owner_id,p_actor,p_binding::text,c.id,'grant_upsert',p_request::text||':'||c.id::text||':grant',
     clued_private.development_hash_v14(payload),nextval('clued_private.canonical_version_seq'),'{}') returning * into op_row;
 v_result:=jsonb_build_object('status','committed','operation_id',op_row.id,'receipt_id',op_row.receipt_id,'event_id',op_row.event_id,
   'canonical_version',op_row.canonical_version,'result',to_jsonb(g),'replayed',false);
 update clued_private.development_operations_v14 set result=v_result where id=op_row.id;
end $$;

create or replace function clued_private.connection_permission_parse_v1(p_resources text[])
returns jsonb language plpgsql immutable set search_path='' as $$
declare r text; m text[]; act text; result jsonb:='[]';
begin
 if p_resources is null or cardinality(p_resources) not between 1 and 20 then
   raise exception 'owner_request_permission_invalid' using errcode='22023'; end if;
 foreach r in array p_resources loop
   m:=regexp_match(r,'^permission:(global|profile|contexts:\*|project:\*|project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/(read|write|close|restore|audit|feedback_submit|reader|developer|full)$');
   if m is null or m[1]<>'contexts:*' and m[2]='feedback_submit' then
     raise exception 'owner_request_permission_invalid' using errcode='22023'; end if;
   foreach act in array case m[2] when 'reader' then array['read']
     when 'developer' then case when m[1]='contexts:*' then array['read','write'] else array['read','write','close','restore'] end
     when 'full' then case when m[1]='contexts:*' then array['read','write','close','restore','audit','feedback_submit']
       else array['read','write','close','restore','audit'] end else array[m[2]] end loop
     result:=result||jsonb_build_array(jsonb_build_object('resource',r,'context',m[1],'action',act,
       'role',case when m[2] in ('reader','developer','full') then m[2] end));
   end loop;
 end loop;
 return result;
end $$;
alter function clued_private.connection_permission_check_v1(uuid,uuid,text[]) rename to connection_permission_check_before_sources_v2;
create function clued_private.connection_permission_check_v1(p_binding uuid,p_owner uuid,p_resources text[])
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare parsed jsonb; item jsonb; result jsonb:='[]'; granted boolean;
begin
 parsed:=clued_private.connection_permission_check_before_sources_v2(p_binding,p_owner,p_resources);
 for item in select value from jsonb_array_elements(parsed) loop
   if item->>'context' in ('contexts:*','project:*') and exists(select 1 from clued_private.authorization_source_bindings_v2 where binding_id=p_binding) then
     granted:=exists(select 1 from clued_private.authorization_sources_v2 source_row
       join clued_private.authorization_contributions_v2 contribution on contribution.source_id=source_row.id
       where source_row.binding_id=p_binding and source_row.owner_id=p_owner and source_row.revoked_at is null
         and source_row.expires_at>clock_timestamp() and contribution.resource_kind='scope'
         and contribution.resource_id=item->>'context' and contribution.environment='canonical'
         and item->>'action'=any(source_row.actions) and item->>'action'=any(contribution.actions)
         and item->>'action'=any(clued_private.authorization_actions_v2(source_row.actions,source_row.scope_ceiling,'policy')));
   elsif item->>'context' not in ('contexts:*','project:*') then
     granted:=item->>'action'=any(clued_private.authorization_effective_no_lock_v2(p_binding,'scope',item->>'context','canonical'));
   else granted:=(item->>'already_granted')::boolean; end if;
   result:=result||jsonb_build_array(item||jsonb_build_object('already_granted',granted));
 end loop;
 return result;
end $$;

create or replace function clued_private.connection_permission_apply_v1(p_owner uuid,p_grant_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare g clued_private.owner_grants_v1; b public.clued_agent_bindings; a clued_private.authorizations_v12;
 parsed jsonb; selected jsonb; grant_use jsonb; added_scopes text[];
begin
 perform clued_private.authorization_writer_require_v2(p_owner);
 select * into g from clued_private.owner_grants_v1 where id=p_grant_id and user_id=p_owner;
 if g.action is distinct from 'connection.permission' or g.grantee_binding_id is null or g.request_id is null then
   raise exception 'owner_grant_choice_invalid' using errcode='22023'; end if;
 select * into b from public.clued_agent_bindings where id=g.grantee_binding_id and user_id=p_owner for update;
 select * into a from clued_private.authorizations_v12 where binding_id=b.id and owner_id=p_owner for update;
 if b.id is null or b.revoked_at is not null or a.binding_id is null or a.revoked_at is not null or a.expires_at<=clock_timestamp() then
   raise exception 'connection_permission_connection_inactive' using errcode='55000'; end if;
 parsed:=clued_private.connection_permission_check_v1(b.id,p_owner,g.resources);
 grant_use:=clued_private.owner_grant_consume_v1(p_owner,b.id,g.action,g.resources,g.task_id);
 if grant_use is null then raise exception 'connection_permission_grant_unavailable' using errcode='55000'; end if;
 perform clued_private.authorization_initialize_sources_v2(b.id,true);
 select jsonb_agg(jsonb_build_object('resource_kind','scope','resource_id',ctx,'environment','canonical','actions',acts) order by ctx)
   into selected from (select x->>'context' ctx,jsonb_agg(distinct x->>'action') acts from jsonb_array_elements(parsed) x group by x->>'context') t;
 added_scopes:=clued_private.authorization_scope_union_v12(selected);
 update public.clued_agent_bindings set scopes=array(select distinct x from unnest(b.scopes||added_scopes) x order by x),
   context_keys=case when '*'=any(b.context_keys) or exists(select 1 from jsonb_array_elements(selected) x
     where x->>'resource_id' in ('contexts:*','project:*')) then array['*']
     else array(select distinct x from unnest(b.context_keys||array(select r->>'resource_id' from jsonb_array_elements(selected) r)) x order by x) end where id=b.id;
 perform clued_private.authorization_add_selection_v2(b.id,selected,g.receipt_id,'owner-request:'||g.request_id);
 update clued_private.authorizations_v12 set version=version+1 where binding_id=b.id returning * into a;
 insert into clued_private.authorization_audit_v12(owner_id,binding_id,request_id,operation,version,selected)
   values(p_owner,b.id,a.request_id,'extend',a.version,clued_private.authorization_selection_v12(b.id));
 return jsonb_build_object('binding_id',b.id,'version',a.version,'grant_use',grant_use,
   'selected',clued_private.authorization_selection_v12(b.id),'coverage',clued_private.authorization_coverage_v2(b.id));
end $$;

create function clued_private.authorization_context_upgrade_view_v2(p_binding uuid,p_actions text[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12; r jsonb; g clued_private.development_grants_v14;
 o clued_private.authorization_resource_overrides_v2; wanted text[]; actual text[]; missing text[]; resources jsonb:='[]'; restricted jsonb:='[]';
 current_entry_actions text[];
begin
 select * into b from public.clued_agent_bindings where id=p_binding;
 select * into a from clued_private.authorizations_v12 where binding_id=p_binding;
 for r in select value from jsonb_array_elements(clued_private.authorization_resources_v2(b.user_id,
    array['context:read','context:write','audit:read'])) loop
   wanted:=clued_private.authorization_actions_v2(p_actions,array['context:read','context:write','audit:read'],r->>'resource_kind');
   actual:=array(select distinct x from unnest(wanted||clued_private.authorization_effective_no_lock_v2(
      p_binding,r->>'resource_kind',r->>'resource_id',r->>'environment')) x order by x);
   select * into o from clued_private.authorization_resource_overrides_v2 where binding_id=p_binding
     and resource_kind=r->>'resource_kind' and resource_id=r->>'resource_id' and environment=r->>'environment';
   g:=null;
   if r->>'resource_kind'='context' then select * into g from clued_private.development_grants_v14
     where binding_id=p_binding and context_id=(r->>'resource_id')::uuid; end if;
   select actions into current_entry_actions from clued_private.authorization_entries_v12 where binding_id=p_binding
     and resource_kind=r->>'resource_kind' and resource_id=r->>'resource_id' and environment=r->>'environment';
   if g.id is not null and (g.revoked_at is not null or g.expires_at<=clock_timestamp()) then actual:='{}';
   elsif g.id is not null and (current_entry_actions is null or g.history_policy<>'EXISTING_AND_FUTURE'
     or g.version_policy<>'LATEST' or g.allowed_fields<>array['*']
     or not(array(select distinct case x when 'close' then 'write' else x end from unnest(current_entry_actions) x) <@ g.actions)) then
     select coalesce(array_agg(x),'{}') into actual from unnest(actual) x
       where (current_entry_actions is null or x=any(current_entry_actions))
         and (case x when 'close' then 'write' else x end)=any(g.actions);
   end if;
   if o.id is not null then
     if o.limits->>'revoked_at' is not null or (o.limits->>'expires_at')::timestamptz<=clock_timestamp() then actual:='{}';
     else select coalesce(array_agg(x),'{}') into actual from unnest(actual) x
       where not x=any(o.denied_actions) and (o.allowed_ceiling is null or x=any(o.allowed_ceiling)); end if;
   end if;
   missing:=array(select x from unnest(wanted) x where not x=any(actual));
   r:=r||jsonb_build_object('actions',wanted,'actual_actions',actual,'missing_actions',missing,
     'limits',case when o.id is not null then o.limits when g.id is not null then to_jsonb(g) else '{}'::jsonb end,
     'source_refs',coalesce((select x->'source_refs' from jsonb_array_elements(clued_private.authorization_sources_view_v2(p_binding)->'grants') x
       where x->>'resource_kind'=r->>'resource_kind' and x->>'resource_id'=r->>'resource_id' and x->>'environment'=r->>'environment'),'[]'));
   resources:=resources||jsonb_build_array(r);
   if cardinality(missing)>0 or g.id is not null and (g.history_policy<>'EXISTING_AND_FUTURE' or g.version_policy<>'LATEST' or g.allowed_fields<>array['*']) then
     restricted:=restricted||jsonb_build_array(r); end if;
 end loop;
 return jsonb_build_object('resources',resources,'future_rule','owned_existing_and_future','authorization_version',a.version,
   'requested_actions',p_actions,'missing_actions',coalesce((select jsonb_agg(distinct x) from jsonb_array_elements(resources) resource_item
      cross join lateral jsonb_array_elements_text(resource_item->'missing_actions') x),'[]'),
   'restricted_resources',restricted,'snapshot_complete',true);
end $$;

alter function clued_private.owner_grant_view_v1(uuid,jsonb) rename to owner_grant_view_before_contexts_v2;
create function clued_private.owner_grant_view_v1(p_user_id uuid,p_choices jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; parsed jsonb; actions text[]; bid uuid; auth_version bigint;
begin
 result:=clued_private.owner_grant_view_before_contexts_v2(p_user_id,p_choices);
 if p_choices->>'action'<>'connection.permission' then return result; end if;
 bid:=(p_choices->>'grantee_binding_id')::uuid;
 select version into auth_version from clued_private.authorizations_v12 where binding_id=bid and owner_id=p_user_id;
 result:=jsonb_set(result,'{connection}',(result->'connection')||jsonb_build_object('version',auth_version,
   'coverage',clued_private.authorization_coverage_v2(bid)));
 parsed:=clued_private.connection_permission_parse_v1(array(select jsonb_array_elements_text(p_choices->'resources')));
 result:=jsonb_set(result,'{permissions}',coalesce((select jsonb_agg(x||jsonb_build_object('context_name',
   case x->>'context' when 'contexts:*' then '全部上下文（含以后新建的）' when 'global' then '个人记录'
   when 'profile' then '个人资料' when 'project:*' then '我的全部项目（含以后新建的）'
   else (select p.name from public.clued_projects p where 'project:'||p.id=x->>'context' and p.user_id=p_user_id) end))
   from jsonb_array_elements(parsed) x),'[]'));
 if exists(select 1 from jsonb_array_elements(parsed) x where x->>'context'='contexts:*') then
   actions:=array(select distinct x->>'action' from jsonb_array_elements(parsed) x where x->>'context'='contexts:*');
   result:=result||jsonb_build_object('context_coverage',clued_private.authorization_context_upgrade_view_v2(bid,actions));
 end if;
 return result;
end $$;

create function clued_private.authorization_source_snapshot_v2(p_binding uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('binding_version',a.version,
   'sources',coalesce((select jsonb_agg(jsonb_build_object('source_id',s.id,'version',s.version,'kind',s.kind,
     'actions',s.actions,'expires_at',s.expires_at,'revoked_at',s.revoked_at) order by s.id)
     from clued_private.authorization_sources_v2 s where s.binding_id=p_binding),'[]'),
   'exceptions',coalesce((select jsonb_agg(jsonb_build_object('override_id',o.id,'version',o.version,
     'resource_kind',o.resource_kind,'resource_id',o.resource_id,'environment',o.environment,'qualification_id',o.qualification_id,
     'denied_actions',o.denied_actions,'allowed_ceiling',o.allowed_ceiling,'limits',o.limits) order by o.id)
     from clued_private.authorization_resource_overrides_v2 o where o.binding_id=p_binding),'[]'),
   'grant_limits',coalesce((select jsonb_agg(jsonb_build_object('grant_id',g.id,'version',g.version,'context_id',g.context_id,
     'actions',g.actions,'history_policy',g.history_policy,'version_policy',g.version_policy,'freeze_cursor',g.freeze_cursor,
     'since_cursor',g.since_cursor,'explicit_record_ids',g.explicit_record_ids,'allowed_fields',g.allowed_fields,
     'expires_at',g.expires_at,'revoked_at',g.revoked_at) order by g.id)
     from clued_private.development_grants_v14 g where g.binding_id=p_binding),'[]'))
 from clued_private.authorizations_v12 a where a.binding_id=p_binding
$$;
create function clued_private.authorization_live_selection_v2(p_binding uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('resource_kind',e.resource_kind,'resource_id',e.resource_id,
   'environment',e.environment,'actions',act) order by e.resource_kind,e.resource_id,e.environment),'[]')
 from clued_private.authorization_entries_v12 e
 cross join lateral (select case when e.resource_kind='scope' and e.resource_id in ('contexts:*','project:*') then
   coalesce((select array_agg(distinct x order by x) from clued_private.authorization_sources_v2 s
     join clued_private.authorization_contributions_v2 c on c.source_id=s.id cross join lateral unnest(c.actions) x
     where s.binding_id=p_binding and s.revoked_at is null and s.expires_at>clock_timestamp()
       and c.resource_kind=e.resource_kind and c.resource_id=e.resource_id and c.environment=e.environment and x=any(s.actions)),'{}')
   else clued_private.authorization_effective_no_lock_v2(p_binding,e.resource_kind,e.resource_id,e.environment) end act) q
 where e.binding_id=p_binding and cardinality(act)>0
$$;
create function clued_private.authorization_rotation_check_v2(p_owner uuid,p_input jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare b public.clued_agent_bindings; expected jsonb; item jsonb; s clued_private.authorization_sources_v2;
 o clued_private.authorization_resource_overrides_v2; acts text[];
begin
 b:=clued_private.headless_binding_replaceable_v1(p_owner,(p_input->>'replaces_binding_id')::uuid);
 if not exists(select 1 from clued_private.authorization_source_bindings_v2 where binding_id=b.id and source_protocol)
   or jsonb_typeof(p_input->'sources') is distinct from 'array' or jsonb_typeof(p_input->'exceptions') is distinct from 'array'
   or jsonb_array_length(p_input->'sources')+jsonb_array_length(p_input->'exceptions')>100 then
   raise exception 'headless_binding_sources_invalid' using errcode='22023'; end if;
 if jsonb_array_length(p_input->'sources')<>(select count(*) from clued_private.authorization_sources_v2 where binding_id=b.id and revoked_at is null)
   or exists(select 1 from jsonb_array_elements(p_input->'sources') x group by x->>'source_id' having count(*)>1)
   or jsonb_array_length(p_input->'exceptions')<>(select count(*) from clued_private.authorization_resource_overrides_v2 where binding_id=b.id)
   or exists(select 1 from jsonb_array_elements(p_input->'exceptions') x group by x->>'override_id' having count(*)>1) then
   raise exception 'headless_binding_sources_complete_required' using errcode='40001'; end if;
 for item in select value from jsonb_array_elements(p_input->'sources') loop
   select * into s from clued_private.authorization_sources_v2 where id=(item->>'source_id')::uuid and binding_id=b.id and revoked_at is null;
   acts:=array(select distinct jsonb_array_elements_text(item->'action_cap'));
   if s.id is null or s.version is distinct from (item->>'base_version')::bigint or not(s.actions <@ acts and acts <@ s.actions) then
     raise exception 'headless_binding_source_version_conflict' using errcode='40001'; end if;
 end loop;
 for item in select value from jsonb_array_elements(p_input->'exceptions') loop
   select * into o from clued_private.authorization_resource_overrides_v2 where id=(item->>'override_id')::uuid and binding_id=b.id;
   if o.id is null or o.version is distinct from (item->>'base_version')::bigint then
     raise exception 'headless_binding_override_version_conflict' using errcode='40001'; end if;
 end loop;
 expected:=clued_private.authorization_source_snapshot_v2(b.id);
 if p_input ? 'source_snapshot' and p_input->'source_snapshot' is distinct from expected then
   raise exception 'headless_binding_source_snapshot_conflict' using errcode='40001'; end if;
 return expected;
end $$;
create function clued_private.authorization_legacy_rotation_snapshot_v2(p_binding uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select clued_private.authorization_source_snapshot_v2(p_binding)||jsonb_build_object('legacy_entries',
   clued_private.authorization_selection_v12(p_binding))
$$;
create function clued_private.authorization_legacy_rotation_check_v2(p_owner uuid,p_binding uuid,p_selected jsonb) returns void
language plpgsql stable security definer set search_path='' as $$
declare actual jsonb; b public.clued_agent_bindings;
begin
 b:=clued_private.headless_binding_replaceable_v1(p_owner,p_binding);
 actual:=clued_private.authorization_selection_v12(p_binding);
 perform clued_private.authorization_validate_selection_v12(p_selected,actual);
 if jsonb_array_length(p_selected)<>jsonb_array_length(actual) or exists(
   select 1 from jsonb_array_elements(actual) e where not exists(select 1 from jsonb_array_elements(p_selected) submitted
     where submitted->>'resource_kind'=e->>'resource_kind' and submitted->>'resource_id'=e->>'resource_id'
       and submitted->>'environment'=e->>'environment' and (e->'actions') <@ (submitted->'actions'))) then
   raise exception 'headless_legacy_rotation_preserve_selection_required' using errcode='22023'; end if;
end $$;

create function clued_private.authorization_clone_sources_v2(p_old uuid,p_new uuid,p_expected jsonb,p_receipt uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
declare old_b public.clued_agent_bindings; new_b public.clued_agent_bindings; a clued_private.authorizations_v12;
 s clued_private.authorization_sources_v2; o clued_private.authorization_resource_overrides_v2; g clued_private.development_grants_v14; sid uuid; receipt uuid;
begin
 select * into old_b from public.clued_agent_bindings where id=p_old;
 select * into new_b from public.clued_agent_bindings where id=p_new;
 perform clued_private.authorization_writer_require_v2(old_b.user_id);
 if old_b.user_id is distinct from new_b.user_id then raise exception 'owned_binding_required' using errcode='42501'; end if;
 if clued_private.authorization_source_snapshot_v2(p_old) is distinct from p_expected then
   raise exception 'headless_binding_source_snapshot_conflict' using errcode='40001'; end if;
 select * into a from clued_private.authorizations_v12 where binding_id=p_new for update;
 insert into clued_private.authorization_source_bindings_v2(binding_id,source_protocol) values(p_new,true);
 receipt:=p_receipt;
 if receipt is null then
   insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
     values(new_b.user_id,p_new,'global','authorization_source_rotation','agent_binding',p_new::text,1,
       jsonb_build_object('receipt_kind','AUTHORIZATION_SOURCE_ROTATION','previous_binding_id',p_old,'source_snapshot',p_expected))
     returning id into receipt;
 end if;
 for s in select * from clued_private.authorization_sources_v2 where binding_id=p_old order by id loop
   insert into clued_private.authorization_sources_v2(binding_id,owner_id,kind,version,actions,scope_ceiling,expires_at,revoked_at,receipt_id,consent_ref)
     values(p_new,new_b.user_id,s.kind,s.version,s.actions,s.scope_ceiling,least(s.expires_at,a.expires_at),s.revoked_at,
       s.receipt_id,'rotation:'||s.id||':'||s.consent_ref) returning id into sid;
   insert into clued_private.authorization_contributions_v2(source_id,resource_kind,resource_id,environment,qualification_id,actions)
     select sid,resource_kind,resource_id,environment,qualification_id,actions from clued_private.authorization_contributions_v2 where source_id=s.id;
 end loop;
 for g in select * from clued_private.development_grants_v14 where binding_id=p_old order by context_id loop
   insert into clued_private.development_grants_v14(context_id,binding_id,grantor,actions,history_policy,version_policy,
     freeze_cursor,since_cursor,explicit_record_ids,allowed_fields,expires_at,revoked_at,version)
     values(g.context_id,p_new,g.grantor,g.actions,g.history_policy,g.version_policy,g.freeze_cursor,g.since_cursor,
       g.explicit_record_ids,g.allowed_fields,least(g.expires_at,a.expires_at),g.revoked_at,g.version);
 end loop;
 for o in select * from clued_private.authorization_resource_overrides_v2 where binding_id=p_old order by id loop
   select * into g from clued_private.development_grants_v14 where binding_id=p_new and context_id::text=o.resource_id;
   insert into clued_private.authorization_resource_overrides_v2(binding_id,resource_kind,resource_id,environment,qualification_id,
      version,denied_actions,allowed_ceiling,limits,receipt_id,reason)
     values(p_new,o.resource_kind,o.resource_id,o.environment,o.qualification_id,o.version,o.denied_actions,o.allowed_ceiling,
       case when g.id is null then o.limits else o.limits||jsonb_build_object('grant_id',g.id,'grant_version',g.version,
         'expires_at',g.expires_at,'revoked_at',g.revoked_at) end,receipt,'rotation:'||o.id||':'||o.reason);
 end loop;
 perform clued_private.authorization_rebuild_projection_v2(p_new);
end $$;

alter function clued_private.headless_binding_view_v1(uuid,jsonb) rename to headless_binding_view_before_sources_v2;
create function clued_private.headless_binding_view_v1(p_owner uuid,p_choices jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; bid uuid; selected jsonb;
begin
 result:=clued_private.headless_binding_view_before_sources_v2(p_owner,p_choices);
 if p_choices->>'selection_format'='sources_v1' then
   bid:=(p_choices->>'replaces_binding_id')::uuid;
   perform clued_private.authorization_rotation_check_v2(p_owner,p_choices);
   selected:=clued_private.authorization_live_selection_v2(bid);
   result:=result||jsonb_build_object('source_snapshot',clued_private.authorization_source_snapshot_v2(bid),
     'selected',selected,'scopes',clued_private.authorization_scope_union_v12(selected),
     'coverage',clued_private.authorization_coverage_v2(bid));
 elsif p_choices->>'replaces_binding_id' is not null and exists(select 1 from clued_private.authorizations_v12
   where binding_id=(p_choices->>'replaces_binding_id')::uuid) then
   bid:=(p_choices->>'replaces_binding_id')::uuid;
   perform clued_private.authorization_legacy_rotation_check_v2(p_owner,bid,p_choices->'selected');
   result:=result||jsonb_build_object('source_snapshot',clued_private.authorization_legacy_rotation_snapshot_v2(bid));
 end if;
 return result;
end $$;

-- Preserve the qualified Native kernels and all token-consumption behavior;
-- only source-aware rotation's selection branch changes.
create function clued_private.authorization_source_patch_v2(p_signature text,p_anchor text,p_replacement text)
returns void language plpgsql set search_path='' as $$
declare definition text:=pg_get_functiondef(p_signature::regprocedure);
begin
 if (length(definition)-length(replace(definition,p_anchor,'')))<>length(p_anchor) then
   raise exception 'authorization_source_anchor_changed: %',p_signature; end if;
 execute replace(definition,p_anchor,p_replacement);
end $$;
select clued_private.authorization_source_patch_v2('public.clued_headless_binding_confirmation_issue_v1(jsonb)',
 $a$k not in ('label','days','selected','replaces_binding_id')$a$,
 $a$k not in ('label','days','selected','replaces_binding_id','selection_format','sources','exceptions')$a$);
select clued_private.authorization_source_patch_v2('public.clued_headless_binding_confirmation_issue_v1(jsonb)',
 $a$    perform clued_private.authorization_validate_selection_v12(v_selected,clued_private.headless_binding_eligible_v1(v_owner));$a$,
 $a$    if p_input->>'selection_format'='sources_v1' then
      if v_selected is distinct from '[]'::jsonb then raise exception 'headless_binding_projection_selection_forbidden' using errcode='22023'; end if;
      perform clued_private.authorization_rotation_check_v2(v_owner,p_input);
      v_selected:=clued_private.authorization_live_selection_v2((p_input->>'replaces_binding_id')::uuid);
    else
      if p_input ? 'selection_format' or p_input ? 'sources' or p_input ? 'exceptions' then
        raise exception 'headless_binding_sources_invalid' using errcode='22023'; end if;
      if exists(select 1 from clued_private.authorization_source_bindings_v2
        where binding_id=(p_input->>'replaces_binding_id')::uuid and source_protocol) then
        raise exception 'headless_binding_sources_required' using errcode='22023'; end if;
      perform clued_private.authorization_validate_selection_v12(v_selected,clued_private.headless_binding_eligible_v1(v_owner));
      if exists(select 1 from clued_private.authorizations_v12 where binding_id=(p_input->>'replaces_binding_id')::uuid) then
        perform clued_private.authorization_legacy_rotation_check_v2(v_owner,(p_input->>'replaces_binding_id')::uuid,v_selected);
      end if;
    end if;$a$);
select clued_private.authorization_source_patch_v2('public.clued_headless_binding_confirmation_issue_v1(jsonb)',
 $a$    v_choices:=jsonb_build_object('label',v_label,'days',v_days,'selected',v_selected,'replaces_binding_id',v_replaces);$a$,
 $a$    v_choices:=jsonb_build_object('label',v_label,'days',v_days,'selected',v_selected,'replaces_binding_id',v_replaces);
    if p_input->>'selection_format'='sources_v1' then
      v_choices:=v_choices||jsonb_build_object('selection_format','sources_v1','sources',p_input->'sources',
        'exceptions',p_input->'exceptions','source_snapshot',clued_private.authorization_source_snapshot_v2(v_replaces));
    elsif exists(select 1 from clued_private.authorizations_v12 where binding_id=v_replaces) then
      v_choices:=v_choices||jsonb_build_object('legacy_rotation_snapshot',clued_private.authorization_legacy_rotation_snapshot_v2(v_replaces));
    end if;$a$);
select clued_private.authorization_source_patch_v2('public.clued_headless_binding_issue_v1(jsonb)',
 $a$    perform clued_private.authorization_validate_selection_v12(v_selected,clued_private.headless_binding_eligible_v1(v_owner));$a$,
 $a$    if c->>'selection_format'='sources_v1' then
      perform clued_private.authorization_rotation_check_v2(v_owner,c);
    else
      perform clued_private.authorization_validate_selection_v12(v_selected,clued_private.headless_binding_eligible_v1(v_owner));
    end if;$a$);
select clued_private.authorization_source_patch_v2('public.clued_headless_binding_issue_v1(jsonb)',
 $a$    perform clued_private.authorization_replace_entries_v12(v_new,v_selected);$a$,
 $a$    if c->>'selection_format'='sources_v1' then
      perform clued_private.authorization_clone_sources_v2(old_b.id,v_new,c->'source_snapshot',null);
    elsif c ? 'legacy_rotation_snapshot' then
      if clued_private.authorization_legacy_rotation_snapshot_v2(old_b.id) is distinct from c->'legacy_rotation_snapshot' then
        raise exception 'headless_binding_source_snapshot_conflict' using errcode='40001'; end if;
      perform clued_private.authorization_initialize_sources_v2(old_b.id,true);
      perform clued_private.authorization_clone_sources_v2(old_b.id,v_new,clued_private.authorization_source_snapshot_v2(old_b.id),null);
    else
      perform clued_private.authorization_replace_entries_v12(v_new,v_selected);
    end if;$a$);
-- The source projector already creates precise grants. Do not re-enter the
-- old grant_upsert without a CAS or overwrite cloned ceilings.
do $patch$
declare definition text:=pg_get_functiondef('public.clued_headless_binding_issue_v1(jsonb)'::regprocedure); start_at integer; end_at integer;
begin
 start_at:=strpos(definition,'    -- Same context grant as an OAuth approval of a development context.');
 end_at:=strpos(definition,'    insert into clued_private.authorization_audit_v12(owner_id,binding_id,request_id,operation,version,selected)');
 if start_at=0 or end_at<=start_at then raise exception 'authorization_headless_grant_adapter_anchor_changed'; end if;
 definition:=substr(definition,1,start_at-1)||substr(definition,end_at);
 execute definition;
end $patch$;
select clued_private.authorization_source_patch_v2('public.clued_headless_binding_list_v1(jsonb)',
 $a$'grants',case when a.binding_id is null then null else clued_private.authorization_selection_v12(b.id) end,$a$,
 $a$'grants',case when a.binding_id is null then null else clued_private.authorization_selection_v12(b.id) end,
        'selection_format',clued_private.authorization_sources_view_v2(b.id)->>'selection_format',
        'sources',clued_private.authorization_sources_view_v2(b.id)->'sources',
        'overrides',clued_private.authorization_sources_view_v2(b.id)->'overrides',
        'coverage',clued_private.authorization_coverage_v2(b.id),$a$);
drop function clued_private.authorization_source_patch_v2(text,text,text);

-- Clearing an exact deny, a revoked/expired grant, or a fixed-history/field
-- ceiling is a separate Native confirmation. It cannot create a new source.
create function clued_private.authorization_precise_view_v2(p_owner uuid,p_choices jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12; c clued_private.development_spaces_v14;
 g clued_private.development_grants_v14; o clued_private.authorization_resource_overrides_v2;
 proposal jsonb:=p_choices->'new'; acts text[]; denied text[]; ceiling text[]; available text[]; fields text[]; records uuid[]; expires timestamptz;
 is_context boolean:=p_choices->>'resource_kind'='context'; project_id uuid; resource_name text; supported text[];
begin
 select * into b from public.clued_agent_bindings where id=(p_choices->>'binding_id')::uuid and user_id=p_owner;
 select * into a from clued_private.authorizations_v12 where binding_id=b.id and owner_id=p_owner;
 if b.id is null or b.revoked_at is not null or a.binding_id is null or a.revoked_at is not null or a.expires_at<=clock_timestamp() then
   raise exception 'connection_permission_connection_inactive' using errcode='42501'; end if;
 if is_context then
   select * into c from clued_private.development_spaces_v14 where id=(p_choices->>'resource_id')::uuid
     and environment=p_choices->>'environment' and owner_id=p_owner;
   if c.id is null or not exists(select 1 from public.clued_projects p where p.id=c.project_id and p.user_id=p_owner) then
     raise exception 'precise_confirmation_owned_resource_required' using errcode='42501'; end if;
   project_id:=c.project_id; resource_name:=c.name;
   select * into g from clued_private.development_grants_v14 where context_id=c.id and binding_id=b.id;
 else
   if p_choices->>'resource_kind' is distinct from 'scope' or p_choices->>'environment' is distinct from 'canonical'
      or p_choices->>'resource_id' in ('contexts:*','project:*') then
     raise exception 'precise_confirmation_owned_resource_required' using errcode='42501'; end if;
   if p_choices->>'resource_id' in ('global','profile') then
     resource_name:=case p_choices->>'resource_id' when 'global' then '个人记录' else '个人资料' end;
   else
     select p.id,p.name into project_id,resource_name from public.clued_projects p
       where 'project:'||p.id=p_choices->>'resource_id' and p.user_id=p_owner;
     if not found then raise exception 'precise_confirmation_owned_resource_required' using errcode='42501'; end if;
   end if;
 end if;
 select * into o from clued_private.authorization_resource_overrides_v2 where binding_id=b.id
   and resource_kind=p_choices->>'resource_kind' and resource_id=p_choices->>'resource_id' and environment=p_choices->>'environment';
 if a.version is distinct from (p_choices->>'base_version')::bigint or is_context and g.id is null or not is_context and o.id is null
   or g.id is distinct from (p_choices->>'grant_id')::uuid or g.version is distinct from (p_choices->>'grant_base_version')::bigint
   or o.id is distinct from nullif(p_choices->>'override_id','')::uuid
   or o.version is distinct from nullif(p_choices->>'override_base_version','')::bigint then
   raise exception 'precise_confirmation_version_conflict' using errcode='40001'; end if;
 if jsonb_typeof(proposal) is distinct from 'object' or exists(select 1 from jsonb_object_keys(proposal) k
   where k not in ('actions','denied_actions','allowed_ceiling','history_policy','version_policy','freeze_cursor','since_cursor',
     'explicit_record_ids','allowed_fields','expires_at'))
   or not(proposal ?& array['actions','denied_actions','allowed_ceiling','expires_at'])
   or is_context and not(proposal ?& array['history_policy','version_policy','freeze_cursor','since_cursor','explicit_record_ids','allowed_fields'])
   or jsonb_typeof(proposal->'actions') is distinct from 'array' or jsonb_typeof(proposal->'denied_actions') is distinct from 'array'
   or jsonb_typeof(proposal->'allowed_ceiling') not in ('array','null') or is_context and (jsonb_typeof(proposal->'allowed_fields') is distinct from 'array'
   or jsonb_typeof(proposal->'explicit_record_ids') is distinct from 'array')
   or not is_context and exists(select 1 from jsonb_object_keys(proposal) k where k not in ('actions','denied_actions','allowed_ceiling','expires_at')) then
   raise exception 'precise_confirmation_limits_invalid' using errcode='22023'; end if;
 acts:=array(select distinct jsonb_array_elements_text(proposal->'actions'));
 denied:=array(select distinct jsonb_array_elements_text(proposal->'denied_actions'));
 ceiling:=case when jsonb_typeof(proposal->'allowed_ceiling')='array' then array(select distinct jsonb_array_elements_text(proposal->'allowed_ceiling')) end;
 if is_context then
   fields:=array(select distinct jsonb_array_elements_text(proposal->'allowed_fields'));
   records:=array(select distinct jsonb_array_elements_text(proposal->'explicit_record_ids')::uuid);
 else fields:='{}'; records:='{}'; end if;
 expires:=(proposal->>'expires_at')::timestamptz;
 select coalesce(array_agg(distinct x order by x),'{}') into available
   from clued_private.authorization_sources_v2 s join clued_private.authorization_contributions_v2 e on e.source_id=s.id
   cross join lateral unnest(clued_private.authorization_actions_v2(e.actions,s.scope_ceiling,p_choices->>'resource_kind')) x
   where s.binding_id=b.id and s.owner_id=p_owner and s.revoked_at is null and s.expires_at>clock_timestamp()
     and e.resource_kind=p_choices->>'resource_kind' and e.resource_id=p_choices->>'resource_id'
     and e.environment=p_choices->>'environment' and e.qualification_id is null and x=any(s.actions);
 supported:=case when is_context then array['read','write','close','feedback_submit'] else array['read','write','close','restore','audit'] end;
 if cardinality(acts)=0 or not(acts <@ available) or not(denied <@ supported)
   or ceiling is not null and not(ceiling <@ available) or not(acts <@ coalesce(ceiling,available)) or acts && denied
   or expires is null or expires<=clock_timestamp() or expires>a.expires_at
   or is_context and (cardinality(fields)=0 or cardinality(fields)>100
   or exists(select 1 from unnest(fields) f where length(f) not between 1 and 120)
   or cardinality(records)>100 or exists(select 1 from unnest(records) rid where not exists(
      select 1 from clued_private.development_records_v14 r where r.id=rid and r.context_id=c.id))
   or coalesce(proposal->>'history_policy','') not in ('EXISTING_ONLY','EXISTING_AND_FUTURE','SINCE_CURSOR','EXPLICIT_SET')
   or coalesce(proposal->>'version_policy','') not in ('LATEST','FIXED_AT_GRANT')
   or (proposal->>'freeze_cursor')::bigint is null or (proposal->>'freeze_cursor')::bigint not between 0 and c.cursor
   or proposal->>'history_policy'='SINCE_CURSOR' and ((proposal->>'since_cursor')::bigint is null or (proposal->>'since_cursor')::bigint not between 0 and c.cursor)
   or proposal->>'history_policy'='EXPLICIT_SET' and cardinality(records)=0) then
   raise exception 'precise_confirmation_exceeds_live_source_or_limits' using errcode='42501'; end if;
 return jsonb_build_object('kind','authorization_precise_limits','binding_id',b.id,'client_name',a.client_name,
   'authorization_version',a.version,'resource_kind',p_choices->>'resource_kind','resource_id',p_choices->>'resource_id','environment',p_choices->>'environment',
   'name',resource_name,'context_name',c.name,'project_id',project_id,'project_name',(select name from public.clued_projects where id=project_id),
   'qualification_id',null,'grant_id',g.id,'grant_version',g.version,'override_id',o.id,'override_version',o.version,
   'old',jsonb_build_object('grant',to_jsonb(g),'override',to_jsonb(o),'binding_scopes',b.scopes),
   'new',proposal||jsonb_build_object('effective_allowed_ceiling',coalesce(ceiling,acts),'binding_scopes',array(select distinct x from unnest(b.scopes||
     clued_private.authorization_scope_union_v12(jsonb_build_array(jsonb_build_object('actions',acts)))) x order by x)),
   'source_snapshot',clued_private.authorization_source_snapshot_v2(b.id));
end $$;

create function clued_private.authorization_precise_confirmation_v2(p_owner uuid,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare choices jsonb; view jsonb; token clued_private.native_confirmation_tokens; token_id uuid; bid uuid;
 raw_token text; digest text; receipt uuid; error_text text; error_state text; now_at timestamptz; actions text[]; inner_actions text[];
 o clued_private.authorization_resource_overrides_v2; g clued_private.development_grants_v14; a clued_private.authorizations_v12;
begin
 perform clued_private.authorization_writer_require_v2(p_owner);
 if clued_private.native_session_id_v1() is null then
   return jsonb_build_object('status','rejected','error_code','confirmation_token_session_id_required','authoritative',false); end if;
 begin
   if p_input->>'op'='limit_confirmation_issue' then
     if exists(select 1 from jsonb_object_keys(p_input) k where k not in ('op','binding_id','base_version','resource_kind','resource_id',
       'environment','grant_id','grant_base_version','override_id','override_base_version','new')) then
       raise exception 'precise_confirmation_input_invalid' using errcode='22023'; end if;
     bid:=(p_input->>'binding_id')::uuid;
     perform 1 from public.clued_agent_bindings where id=bid and user_id=p_owner for update;
     if not found then raise exception 'owned_binding_required' using errcode='42501'; end if;
     perform 1 from clued_private.authorizations_v12 where binding_id=bid and owner_id=p_owner for update;
     perform clued_private.authorization_initialize_sources_v2(bid,true);
     choices:=p_input-'op';
     view:=clued_private.authorization_precise_view_v2(p_owner,choices);
     digest:=clued_private.m1_sha256(view);
     update clued_private.native_confirmation_tokens set revoked_at=clock_timestamp() where user_id=p_owner
       and action='authorization_precise' and subject_key=bid||':'||(choices->>'resource_id') and consumed_at is null and revoked_at is null;
     raw_token:='clued_apc_'||encode(extensions.gen_random_bytes(32),'hex');
     now_at:=clock_timestamp();
     insert into clued_private.native_confirmation_tokens(user_id,action,subject_key,subject_version,native_choices,
       confirmation_view,view_digest,token_hash,session_id,auth_time,issued_at,expires_at)
       values(p_owner,'authorization_precise',bid||':'||(choices->>'resource_id'),(choices->>'base_version')::bigint,
         choices,view,digest,encode(extensions.digest(convert_to(raw_token,'UTF8'),'sha256'),'hex'),
         clued_private.native_session_id_v1(),coalesce(clued_private.native_auth_time_v1(),now_at),now_at,now_at+interval '5 minutes')
       returning id into token_id;
     return jsonb_build_object('status','issued','token_id',token_id,'confirmation_token',raw_token,'view_digest',digest,
       'confirmation_view',view,'expires_at',now_at+interval '5 minutes');
   end if;
   if p_input->>'op'<>'limit_confirm' or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('op','confirmation_token','view_digest'))
     or jsonb_typeof(p_input->'confirmation_token') is distinct from 'string' then
     raise exception 'precise_confirmation_input_invalid' using errcode='22023'; end if;
   select * into token from clued_private.native_confirmation_tokens where user_id=p_owner and action='authorization_precise'
     and token_hash=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex');
   if not found then raise exception 'confirmation_token_invalid' using errcode='42501'; end if;
   bid:=(token.native_choices->>'binding_id')::uuid;
   -- Binding is derived only from server choices and acquired before nonce.
   perform 1 from public.clued_agent_bindings where id=bid and user_id=p_owner for update;
   if not found then raise exception 'owned_binding_required' using errcode='42501'; end if;
   select * into a from clued_private.authorizations_v12 where binding_id=bid and owner_id=p_owner for update;
   select * into token from clued_private.native_confirmation_tokens where id=token.id for update;
   if token.consume_outcome='committed' then return jsonb_build_object('status','committed','replayed',true,'receipt_id',token.consumed_receipt_id); end if;
   if token.consumed_at is not null or token.revoked_at is not null then raise exception 'confirmation_token_reused' using errcode='42501'; end if;
   token_id:=token.id;
   if token.expires_at<=clock_timestamp() then raise exception 'confirmation_token_expired' using errcode='42501'; end if;
   if token.issued_xact=pg_current_xact_id() then raise exception 'confirmation_token_same_request' using errcode='42501'; end if;
   if token.view_digest is distinct from p_input->>'view_digest' or token.session_id is distinct from clued_private.native_session_id_v1() then
     raise exception 'confirmation_token_binding_mismatch' using errcode='42501'; end if;
   choices:=token.native_choices;
   view:=clued_private.authorization_precise_view_v2(p_owner,choices);
   if clued_private.m1_sha256(view)<>token.view_digest then raise exception 'confirmation_view_stale' using errcode='40001'; end if;
   select * into o from clued_private.authorization_resource_overrides_v2 where binding_id=bid and resource_kind=choices->>'resource_kind'
     and resource_id=choices->>'resource_id' and environment=choices->>'environment' for update;
   if choices->>'resource_kind'='context' then
     perform 1 from clued_private.development_spaces_v14 where id=(choices->>'resource_id')::uuid
       and owner_id=p_owner and environment=choices->>'environment' for update;
     perform 1 from public.clued_projects where id=(view->>'project_id')::uuid and user_id=p_owner for share;
     select * into g from clued_private.development_grants_v14 where id=(choices->>'grant_id')::uuid and binding_id=bid
       and context_id=(choices->>'resource_id')::uuid for update;
   elsif view->>'project_id' is not null then
     perform 1 from public.clued_projects where id=(view->>'project_id')::uuid and user_id=p_owner for share;
   end if;
   -- Recheck all exact CAS values after C/grant locks, even for out-of-band
   -- writes that do not take the ordinary Owner materialization barrier.
   if clued_private.authorization_precise_view_v2(p_owner,choices) is distinct from view then
     raise exception 'confirmation_view_stale' using errcode='40001'; end if;
   actions:=array(select distinct jsonb_array_elements_text(choices->'new'->'actions'));
   inner_actions:=array(select distinct case x when 'close' then 'write' else x end from unnest(actions) x);
   now_at:=clock_timestamp();
   insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
     values(p_owner,bid,coalesce('project:'||(view->>'project_id'),choices->>'resource_id'),'authorization_precise_limits',
       case when choices->>'resource_kind'='context' then 'development_grant' else 'authorization_override' end,
       coalesce(g.id::text,o.id::text),coalesce(g.version,o.version,0)+1,
       jsonb_build_object('receipt_kind','PRECISE_LIMITS_NATIVE_CONFIRMED','old_to_new',view,'token_id',token.id,'view_digest',token.view_digest,
         'principal','native_account_session')) returning id into receipt;
   if choices->>'resource_kind'='context' then
   update clued_private.development_grants_v14 set actions=inner_actions,
     history_policy=choices->'new'->>'history_policy',version_policy=choices->'new'->>'version_policy',
     freeze_cursor=(choices->'new'->>'freeze_cursor')::bigint,since_cursor=(choices->'new'->>'since_cursor')::bigint,
     explicit_record_ids=array(select jsonb_array_elements_text(choices->'new'->'explicit_record_ids')::uuid),
     allowed_fields=array(select jsonb_array_elements_text(choices->'new'->'allowed_fields')),
     expires_at=(choices->'new'->>'expires_at')::timestamptz,revoked_at=null,version=version+1
     where id=g.id and version=(choices->>'grant_base_version')::bigint returning * into g;
   if not found then raise exception 'precise_confirmation_version_conflict' using errcode='40001'; end if;
   end if;
   insert into clued_private.authorization_resource_overrides_v2(binding_id,resource_kind,resource_id,environment,qualification_id,
     denied_actions,allowed_ceiling,limits,receipt_id,reason)
     values(bid,choices->>'resource_kind',choices->>'resource_id',choices->>'environment',null,
       array(select jsonb_array_elements_text(choices->'new'->'denied_actions')),
       case when jsonb_typeof(choices->'new'->'allowed_ceiling')='array' then array(select jsonb_array_elements_text(choices->'new'->'allowed_ceiling')) else actions end,
       case when choices->>'resource_kind'='context' then jsonb_build_object('grant_id',g.id,'grant_version',g.version,'history_policy',g.history_policy,'version_policy',g.version_policy,
         'freeze_cursor',g.freeze_cursor,'since_cursor',g.since_cursor,'explicit_record_ids',g.explicit_record_ids,
         'allowed_fields',g.allowed_fields,'expires_at',g.expires_at,'revoked_at',g.revoked_at)
         else jsonb_build_object('expires_at',choices->'new'->>'expires_at','revoked_at',null) end,receipt,'native_precise_confirmed')
     on conflict(binding_id,resource_kind,resource_id,environment) do update set denied_actions=excluded.denied_actions,
       allowed_ceiling=excluded.allowed_ceiling,limits=excluded.limits,version=clued_private.authorization_resource_overrides_v2.version+1,
       receipt_id=receipt,reason=excluded.reason;
   update public.clued_agent_bindings set scopes=array(select jsonb_array_elements_text(view->'new'->'binding_scopes')) where id=bid;
   perform clued_private.authorization_project_resource_v2(bid,choices->>'resource_kind',choices->>'resource_id',choices->>'environment');
   update clued_private.authorizations_v12 set version=version+1 where binding_id=bid returning * into a;
   insert into clued_private.authorization_audit_v12(owner_id,binding_id,request_id,operation,version,selected)
     values(p_owner,bid,a.request_id,'precise_confirm',a.version,view);
   update clued_private.native_confirmation_tokens set consumed_at=now_at,consumed_receipt_id=receipt,consume_outcome='committed' where id=token.id;
   return jsonb_build_object('status','committed','replayed',false,'receipt_id',receipt,'binding_id',bid,'version',a.version);
 exception when others then
   get stacked diagnostics error_text=message_text,error_state=returned_sqlstate;
   if token_id is not null then
     insert into public.clued_audit_receipts(user_id,context_key,operation,object_type,object_id,metadata)
       values(p_owner,'global','authorization_precise_limits','native_confirmation',token_id::text,
         jsonb_build_object('receipt_kind','PRECISE_LIMITS_REJECTED','error_code',error_text)) returning id into receipt;
     update clued_private.native_confirmation_tokens set consumed_at=clock_timestamp(),consumed_receipt_id=receipt,
       consume_outcome='rejected' where id=token_id and consumed_at is null and revoked_at is null;
   end if;
   return jsonb_build_object('status',case when error_state in ('22023','23514','40001','42501','55000') then 'rejected' else 'failed' end,
     'error_code',error_text,'authoritative',false);
 end;
end $$;

-- Integration execution/facts must not treat a cached nonempty Binding ceiling
-- as live authority after Source expiry or an exact-resource revocation. The
-- status and monotonic revoke entrances remain available; raw/pre-Source bodies
-- retain their established behavior. Replacing bodies preserves OIDs and ACLs.
do $integration_sources$
declare definition text; anchor text; signature text; source_gate text;
begin
 select pg_get_functiondef('clued_private.integration_binding_authority_v1(uuid)'::regprocedure) into definition;
 anchor:='declare v_scopes text[]; v_entries jsonb;';
 if strpos(definition,anchor)=0 then raise exception 'integration_source_authority_anchor_changed'; end if;
 definition:=replace(definition,anchor,anchor||' v_source jsonb;');
 anchor:=E'\nbegin';
 if strpos(definition,anchor)=0 then raise exception 'integration_source_authority_begin_anchor_changed'; end if;
 source_gate:=E'\nbegin\n  v_source := clued_private.authorization_current_projection_v2(p_binding_id);\n  if v_source is not null then return v_source - ''has_permissions''; end if;\n';
 definition:=replace(definition,anchor,source_gate);
 execute definition;

 select pg_get_functiondef('clued_private.integration_binding_identity_v1(uuid)'::regprocedure) into definition;
 anchor:='v_expires timestamptz; v_account_ok boolean; v_provider text; v_pcid text;';
 if strpos(definition,anchor)=0 then raise exception 'integration_source_identity_anchor_changed'; end if;
 definition:=replace(definition,anchor,anchor||' v_source jsonb;');
 anchor:='  return pg_catalog.jsonb_build_object(';
 if strpos(definition,anchor)=0 then raise exception 'integration_source_identity_return_anchor_changed'; end if;
 definition:=replace(definition,anchor,E'  v_source := clued_private.authorization_current_projection_v2(b.id);\n'||anchor);
 definition:=replace(definition,'''scopes'', pg_catalog.to_jsonb(b.scopes),',
   '''scopes'', coalesce(v_source->''scopes'',pg_catalog.to_jsonb(b.scopes)),');
 definition:=replace(definition,'''live'', b.revoked_at is null and',
   '''live'', coalesce((v_source->>''has_permissions'')::boolean,true) and b.revoked_at is null and');
 definition:=replace(definition,'''auth_usable'', b.revoked_at is null and',
   '''auth_usable'', coalesce((v_source->>''has_permissions'')::boolean,true) and b.revoked_at is null and');
 execute definition;

 select pg_get_functiondef('clued_private.integration_normalize_detail_v1(uuid,timestamp with time zone)'::regprocedure) into definition;
 anchor:='  -- reported facts (§5.6), current and not past valid_until';
 if strpos(definition,anchor)=0 then raise exception 'integration_source_normalize_anchor_changed'; end if;
 source_gate:=$body$
  -- Source authority is current server truth, independent of the reported-fact
  -- as-of fold below. Capabilities require the action on the same exact entry.
  declare source_view jsonb;
  begin
    if v_has_c and v_has_b then
      source_view := clued_private.authorization_current_projection_v2(b.id);
      if source_view is not null then
        v_scopes := array(select jsonb_array_elements_text(source_view->'scopes'));
        if not (source_view->>'has_permissions')::boolean then
          -- The credential still exists: NONE/NOT_GRANTED is reserved for no
          -- connection. Use the existing failed-authorization vocabulary.
          v_authz := case when not exists(select 1 from clued_private.authorization_sources_v2 s
              where s.binding_id=b.id and s.revoked_at is null and s.expires_at>clock_timestamp())
            and exists(select 1 from clued_private.authorization_sources_v2 s
              where s.binding_id=b.id and s.revoked_at is null and s.expires_at<=clock_timestamp())
            then 'EXPIRED' else 'REVOKED_CONNECTION' end;
        end if;
        v_caps := array(select cap from (values ('audit.read','audit'), ('context.read','read'), ('context.write','write'),
            ('development_history.read','read'), ('evidence.write','write'), ('project.read','read'), ('project.write','write')) m(cap,act)
          where exists(select 1 from jsonb_array_elements(source_view->'entries') e
            where (e->'actions') ? m.act
              and (cap<>'development_history.read' or e->>'resource_kind'='context')
              and (cap not in ('project.read','project.write') or e->>'resource_kind'='scope' and e->>'resource_id' like 'project:%'))
          order by cap collate "C");
        v_resource := jsonb_build_object('mode','ENTRIES','capabilities',v_caps);
      end if;
    end if;
  end;

$body$;
 definition:=replace(definition,anchor,source_gate||anchor);
 execute definition;

 for signature in select x from unnest(array[
   'public.clued_integration_request_open_v1(text,jsonb)',
   'public.clued_integration_create_or_bind_v1(text,jsonb)',
   'public.clued_integration_identity_update_v1(text,jsonb)',
   'public.clued_integration_reconcile_request_v1(text,jsonb)',
   'public.clued_integration_declare_v1(text,jsonb)',
   'public.clued_integration_report_v1(text,jsonb)',
   'public.clued_integration_verify_v1(text,jsonb)']) x loop
   select pg_get_functiondef(signature::regprocedure) into definition;
   anchor:=case when signature like '%request_open%' then
     '  b := clued_private.integration_auth_binding_v1(p_token_hash, ''{}'', false);' else
     '  b := clued_private.integration_auth_binding_v1(p_token_hash, ''{}'', true);' end;
   if strpos(definition,anchor)=0 or length(definition)-length(replace(definition,anchor,''))<>length(anchor) then
     raise exception 'integration_source_execution_anchor_changed: %',signature; end if;
   definition:=replace(definition,anchor,anchor||E'\n  perform clued_private.authorization_current_require_v2(b.id);');
   execute definition;
 end loop;
end $integration_sources$;

-- The entrance check can precede a real Request/claim/Integration/receipt wait.
-- Recheck after those waits before mutation, then once more after the core has
-- returned. The last check is outside the core's receipt-preserving exception
-- block, so a loss of authority rolls back its entire call, including receipts
-- and any mutation that waited internally. Observers and revoke are unchanged.
do $integration_wait_sources$
declare definition text; signature text; anchor text; rec record; point integer; matches integer;
  gate text:=E'    perform clued_private.authorization_current_actor_require_v2(p_actor);\n';
  return_pattern text:='return (clued_private[.]integration_[a-z0-9_]+[(][^;]+);';
begin
 for rec in select * from (values
   ('clued_private.integration_write_open_v1(jsonb,uuid,uuid,bigint,uuid,timestamp with time zone)',
     '  v_revocation := clued_private.integration_materialize_connection_revoke_v1('),
   ('clued_private.integration_bind_core_v1(jsonb,uuid,jsonb,text,uuid,text)',
     '    -- step 7: create'),
   ('clued_private.integration_identity_update_core_v1(jsonb,uuid,jsonb,text)',
     '    v_state := clued_private.integration_claim_core_v1(v_id, v_identity, v_receipt.id);'),
   ('clued_private.integration_reconcile_request_core_v1(jsonb,uuid,jsonb,text)',
     '    update clued_private.integrations_v1 set identity_claim_state = ''PENDING_RECONCILE'' where integration_id = v_id;'),
   ('clued_private.integration_declare_core_v1(jsonb,uuid,jsonb,text)',
     '    insert into clued_private.integration_capability_declarations_v1('),
   ('clued_private.integration_fact_core_v1(jsonb,uuid,jsonb,text,text)',
     '    update clued_private.integration_facts_v1 set fact_status = case v_action when ''set'' then ''SUPERSEDED'' else ''CLEARED'' end'),
   ('clued_private.integration_verify_baseline_core_v1(jsonb,uuid,jsonb,text)',
     '    insert into clued_private.integration_canonical_verifications_v1('),
   ('clued_private.integration_verify_ready_core_v1(jsonb,uuid,jsonb,text)',
     '    insert into clued_private.integration_ready_verifications_v1(')
 ) v(signature,anchor) loop
   select pg_get_functiondef(rec.signature::regprocedure) into definition;
   if strpos(definition,rec.anchor)=0 or length(definition)-length(replace(definition,rec.anchor,''))<>length(rec.anchor) then
     raise exception 'integration_source_prewrite_anchor_changed: %',rec.signature; end if;
   definition:=replace(definition,rec.anchor,gate||rec.anchor);
   -- These cores acquire I themselves rather than using write_open. Preserve
   -- FOUND until its old ownership check, then recheck before any evaluation or
   -- revocation materialization can write. Request/claim waits are checked again
   -- at the dedicated prewrite anchors above.
   if rec.signature like '%identity_update_core%' or rec.signature like '%reconcile_request_core%'
     or rec.signature like '%verify_ready_core%' or rec.signature like '%bind_core%' then
     anchor:='    if not found then raise exception ''integration_not_owned'' using errcode = ''42501''; end if;';
     if strpos(definition,anchor)=0 then raise exception 'integration_source_locked_owner_anchor_changed: %',rec.signature; end if;
     definition:=replace(definition,anchor,anchor||E'\n'||gate);
   end if;
   if rec.signature like '%bind_core%' then
     -- A refreshed live identity supplies current scopes/authority after L3/4/5.
     anchor:='    -- step 6: guards on an existing target';
     if strpos(definition,anchor)=0 then raise exception 'integration_source_bind_guard_anchor_changed'; end if;
     definition:=replace(definition,anchor,gate||E'    if p_connection_binding is not null then\n      v_conn := clued_private.integration_binding_identity_v1(p_connection_binding);\n      v_authority := v_conn->''authority'';\n      if v_conn is null or not (v_conn->>''live'')::boolean then\n        raise exception ''binding_not_adoptable'' using errcode=''42501'';\n      end if;\n    end if;\n'||anchor);
     anchor:='    -- step 7: create';
     definition:=replace(definition,anchor,E'    if p_connection_binding is not null then\n      v_conn := clued_private.integration_binding_identity_v1(p_connection_binding);\n      v_authority := v_conn->''authority'';\n      if v_conn is null or not (v_conn->>''live'')::boolean then\n        raise exception ''binding_not_adoptable'' using errcode=''42501'';\n      end if;\n    end if;\n'||anchor);
   end if;
   if rec.signature like '%identity_update_core%' or rec.signature like '%reconcile_request_core%' then
     anchor:='    v_revocation := clued_private.integration_materialize_connection_revoke_v1(';
     if strpos(definition,anchor)=0 then raise exception 'integration_source_materialization_anchor_changed: %',rec.signature; end if;
     definition:=replace(definition,anchor,gate||anchor);
   end if;
   execute definition;
 end loop;

 select pg_get_functiondef('clued_private.integration_request_open_core_v1(jsonb,uuid,jsonb)'::regprocedure) into definition;
 anchor:='  insert into clued_private.integration_installation_requests_v1(';
 if strpos(definition,anchor)=0 then raise exception 'integration_source_request_prewrite_anchor_changed'; end if;
 definition:=replace(definition,anchor,gate||anchor);
 -- The unique-key INSERT itself can wait. Check in both result branches, without
 -- changing FOUND before the existing branch decision or replay SELECT.
 anchor:='    select * into r from clued_private.integration_installation_requests_v1 where owner_id = p_owner and request_key = v_key;';
 if length(definition)-length(replace(definition,anchor,''))<>length(anchor) then
   raise exception 'integration_source_request_result_anchor_changed'; end if;
 definition:=replace(definition,anchor,gate||anchor);
 anchor:='  return pg_catalog.jsonb_build_object(''request_id'', r.request_id, ''replayed'', false,';
 if strpos(definition,anchor)=0 then raise exception 'integration_source_request_return_anchor_changed'; end if;
 definition:=replace(definition,anchor,gate||anchor);
 execute definition;

 for signature in select x from unnest(array[
   'public.clued_integration_request_open_v1(text,jsonb)',
   'public.clued_integration_create_or_bind_v1(text,jsonb)',
   'public.clued_integration_identity_update_v1(text,jsonb)',
   'public.clued_integration_reconcile_request_v1(text,jsonb)',
   'public.clued_integration_declare_v1(text,jsonb)',
   'public.clued_integration_report_v1(text,jsonb)',
   'public.clued_integration_verify_v1(text,jsonb)']) x loop
   select pg_get_functiondef(signature::regprocedure) into definition;
   point:=strpos(definition,E'\nbegin');
   if point=0 then raise exception 'integration_source_result_declare_anchor_changed: %',signature; end if;
   definition:=substr(definition,1,point-1)||E'\n  v_authorization_result jsonb; v_authorization_before jsonb; v_authorization_after jsonb;'||substr(definition,point);
   anchor:='  perform clued_private.authorization_current_require_v2(b.id);';
   if length(definition)-length(replace(definition,anchor,''))<>length(anchor) then
     raise exception 'integration_source_result_snapshot_anchor_changed: %',signature; end if;
   definition:=replace(definition,anchor,anchor||E'\n  v_authorization_before := clued_private.authorization_current_projection_v2(b.id);');
   select count(*) into matches from regexp_matches(definition,return_pattern,'g');
   if matches<>(case when signature like '%integration_verify_v1%' then 2 else 1 end) then
     raise exception 'integration_source_result_return_anchor_changed: %',signature; end if;
   definition:=regexp_replace(definition,return_pattern,
     E'v_authorization_result := \\1;\n  perform clued_private.authorization_current_require_v2(b.id);\n  v_authorization_after := clued_private.authorization_current_projection_v2(b.id);\n  if v_authorization_before is not null and v_authorization_after is distinct from v_authorization_before then\n    raise exception ''authorization_source_permission_changed_during_call'' using errcode=''42501'';\n  end if;\n  return v_authorization_result;','g');
   execute definition;
 end loop;
end $integration_wait_sources$;

-- Private adapters are never independent consumer entrances. Public RPC OIDs
-- and their existing qualified Native/gateway ACLs above remain unchanged.
do $acl$
declare fn record;
begin
 for fn in select p.oid::regprocedure signature from pg_proc p
   where p.pronamespace='clued_private'::regnamespace and (p.proname like 'authorization_%_v2'
     or p.proname in ('authorization_eligible_v12','authorization_owner_resource_v12','authorization_assert_entry_v12',
       'owner_grant_view_v1','headless_binding_view_v1','owner_grant_view_before_contexts_v2','headless_binding_view_before_sources_v2',
       'connection_permission_check_v1','connection_permission_check_before_sources_v2')) loop
   execute format('revoke all on function %s from public,anon,authenticated,service_role',fn.signature);
 end loop;
end $acl$;
notify pgrst,'reload schema';
