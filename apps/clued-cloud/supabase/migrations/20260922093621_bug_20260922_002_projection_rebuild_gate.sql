-- Projection registry and CAS rebuild. No semantic priority is guessed here.
create table clued_private.projection_dependency_registry (
  rule_id text primary key,
  rule_schema_version integer not null default 1,
  source_scope_class text not null,
  source_entity_kind text not null,
  changed_fields text[] not null,
  target_projection_keys text[] not null,
  currentness_dimensions text[] not null,
  fallback_projection_key text not null,
  status text not null check(status in ('active','retired')),
  rule_digest text not null check(rule_digest~'^[0-9a-f]{64}$')
);
create table clued_private.projection_heads (
  user_id uuid not null references auth.users(id) on delete cascade,
  target_scope text not null,
  projection_key text not null,
  projection_generation bigint not null default 0,
  resolved_through_invalidation_revision bigint not null default 0,
  source_vector_digest text not null,
  source_refs jsonb not null default '[]'::jsonb,
  record_id uuid references public.clued_memories(id),
  projection_owner text not null,
  generated_at timestamptz not null default now(),
  primary key(user_id,target_scope,projection_key)
);
create table clued_private.projection_record_bindings (
  record_id uuid primary key references public.clued_memories(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  target_scope text not null,
  projection_key text not null,
  projection_schema_version integer not null default 1,
  projection_generation bigint not null default 0,
  source_vector_digest text,
  source_refs jsonb not null default '[]'::jsonb,
  resolved_through_invalidation_revision bigint not null default 0,
  projection_owner text not null,
  unique(user_id,target_scope,projection_key,record_id)
);
create table clued_private.projection_builder_grants (
  binding_id uuid not null references public.clued_agent_bindings(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  target_scope text not null,
  projection_key text not null,
  granted_by text not null,
  active boolean not null default true,
  primary key(binding_id,target_scope,projection_key)
);
alter table clued_private.projection_dependency_registry enable row level security;
alter table clued_private.projection_heads enable row level security;
alter table clued_private.projection_record_bindings enable row level security;
alter table clued_private.projection_builder_grants enable row level security;
revoke all on clued_private.projection_dependency_registry,clued_private.projection_heads,
  clued_private.projection_record_bindings,clued_private.projection_builder_grants
  from public,anon,authenticated,service_role;

create table clued_private.legacy_inventory_epoch (
  id boolean primary key default true check(id),
  cutover_event_id bigint not null,
  created_at timestamptz not null default now()
);
-- Freeze the inventory transaction's source watermark, not the Event maximum
-- at this later migration. Appends in between already have core carriers and
-- must not be retroactively required to have legacy candidate receipts.
do $$
declare v_min bigint; v_max bigint;
begin
  select min(r.scan_completed_revision),max(r.scan_completed_revision)
    into v_min,v_max from clued_private.legacy_carrier_inventory_receipts r;
  if v_min is distinct from v_max then
    raise exception 'legacy_inventory_watermark_inconsistent' using errcode='23514';
  end if;
  insert into clued_private.legacy_inventory_epoch(id,cutover_event_id)
    values(true,coalesce(v_min,0));
end $$;
alter table clued_private.legacy_inventory_epoch enable row level security;
revoke all on clued_private.legacy_inventory_epoch
  from public,anon,authenticated,service_role;

insert into clued_private.projection_dependency_registry(rule_id,source_scope_class,
  source_entity_kind,changed_fields,target_projection_keys,currentness_dimensions,
  fallback_projection_key,status,rule_digest)
select v.rule_id,v.source_scope_class,v.source_entity_kind,v.changed_fields,
  v.target_projection_keys,v.currentness_dimensions,'global.__aggregate__','active',
  clued_private.currentness_hash(jsonb_build_object('rule_id',v.rule_id,
    'source_scope_class',v.source_scope_class,'source_entity_kind',v.source_entity_kind,
    'changed_fields',v.changed_fields,'target_projection_keys',v.target_projection_keys,
    'currentness_dimensions',v.currentness_dimensions,'fallback_projection_key','global.__aggregate__'))
from (values
  ('project.state.frontier','project','state',array['*']::text[],
    array['global.priority_frontier']::text[],array['snapshot']::text[]),
  ('project.task.frontier','project','task',array['execution_bucket','priority','blocker','dependency','lifecycle']::text[],
    array['global.priority_frontier']::text[],array['next_action']::text[]),
  ('project.decision.authority','project','decision',array['*']::text[],
    array['global.priority_frontier']::text[],array['authority','next_action']::text[]),
  ('project.lifecycle.frontier','project','project',array['lifecycle','progress_status']::text[],
    array['global.priority_frontier']::text[],array['snapshot','next_action']::text[])
) v(rule_id,source_scope_class,source_entity_kind,changed_fields,target_projection_keys,currentness_dimensions);

-- The exact production legacy identity remains unchanged. Its private binding
-- marks it stale until a newly authorized projection generation is produced.
insert into clued_private.projection_record_bindings(record_id,user_id,target_scope,
  projection_key,projection_owner)
select m.id,m.user_id,'global','global.priority_frontier','legacy_migration'
  from public.clued_memories m
 where m.id='03ae5782-3a5c-4132-a1af-b93f47f55452'::uuid
   and m.record_type='state' and m.canonical_scope='global';
insert into clued_private.projection_invalidation_heads(user_id,target_scope,
  projection_key,invalidation_revision,resolved_through_revision,latest_source_ref,stale_since)
select b.user_id,'global','global.priority_frontier',
  greatest(1,coalesce(h.invalidation_revision,0)),0,
  jsonb_build_object('kind','legacy_frontier_migration','id',b.record_id),now()
from clued_private.projection_record_bindings b
left join clued_private.projection_invalidation_heads h on h.user_id=b.user_id
  and h.target_scope='global' and h.projection_key='global.__aggregate__'
on conflict(user_id,target_scope,projection_key) do update set
  invalidation_revision=greatest(clued_private.projection_invalidation_heads.invalidation_revision,
    excluded.invalidation_revision),stale_since=coalesce(
      clued_private.projection_invalidation_heads.stale_since,now());

-- The shared list/search fence also recognizes legacy projection bindings.
create or replace function clued_private.record_currentness_fence(
  p_user_id uuid,p_record_id uuid,p_authorized_scopes text[]
) returns text language plpgsql stable security definer set search_path='' as $$
declare v_record public.clued_memories%rowtype; v_scope text; v_projection_key text;
  v_binding clued_private.projection_record_bindings%rowtype;
  v_invalidation clued_private.projection_invalidation_heads%rowtype;
  v_head clued_private.projection_heads%rowtype;
begin
  select * into v_record from public.clued_memories
    where user_id=p_user_id and id=p_record_id;
  if not found then return 'UNKNOWN'; end if;
  if v_record.record_type not in ('state','task','decision') then return 'CURRENT'; end if;
  if v_record.archived_at is not null or v_record.merged_into_record_id is not null or
     coalesce(v_record.lifecycle_status,'active')<>'active' or
     v_record.status in ('archived','superseded','revoked','cancelled','done') or
     exists(select 1 from public.clued_memories successor
       where successor.user_id=p_user_id and successor.supersedes_id=v_record.id) then
    return 'HISTORY';
  end if;
  v_scope:=coalesce(v_record.canonical_scope,
    case when v_record.project_id is null then 'global'
      else 'project:'||v_record.project_id::text end);
  if p_authorized_scopes is not null and not v_scope=any(p_authorized_scopes) then
    return 'NOT_AUTHORIZED';
  end if;
  if exists(select 1 from clued_private.legacy_event_project_impacts i
    join clued_private.event_truth_carriers c on c.event_id=i.event_id
    where i.user_id=p_user_id and i.project_scope=v_scope
      and c.carrier_state='LEGACY_UNBOUND' and c.visibility='work_log'
      and v_record.record_type=any(c.dimensions)) then
    return 'UNKNOWN';
  end if;
  select * into v_binding from clued_private.projection_record_bindings b
    where b.record_id=p_record_id and b.user_id=p_user_id;
  v_projection_key:=coalesce(nullif(v_record.type_fields->>'projection_key',''),
    v_binding.projection_key);
  if v_projection_key is not null then
    -- User-authored metadata cannot grant projection authority.
    if v_binding.record_id is null or v_binding.projection_key<>v_projection_key
      or v_binding.target_scope<>v_scope then return 'UNKNOWN'; end if;
    select * into v_invalidation from clued_private.projection_invalidation_heads h
      where h.user_id=p_user_id and h.target_scope=v_scope
        and h.projection_key=v_projection_key;
    if not found then return 'UNKNOWN'; end if;
    if v_invalidation.invalidation_revision>v_invalidation.resolved_through_revision
      then return 'STALE'; end if;
    select * into v_head from clued_private.projection_heads h
      where h.user_id=p_user_id and h.target_scope=v_scope
        and h.projection_key=v_projection_key;
    if not found or v_head.record_id is distinct from v_record.id or
      v_head.projection_generation is distinct from v_binding.projection_generation or
      v_head.source_vector_digest is distinct from v_binding.source_vector_digest or
      v_head.resolved_through_invalidation_revision is distinct from
        v_invalidation.invalidation_revision or
      v_binding.resolved_through_invalidation_revision is distinct from
        v_invalidation.invalidation_revision or
      v_head.source_vector_digest is distinct from
        clued_private.currentness_hash(clued_private.projection_source_snapshot(p_user_id))
    then return 'UNKNOWN'; end if;
  end if;
  if exists(
    select 1 from clued_private.event_truth_carriers c
    where c.user_id=p_user_id and c.canonical_scope=v_scope
      and c.visibility='work_log'
      and (p_authorized_scopes is null or c.canonical_scope=any(p_authorized_scopes))
      and v_record.record_type=any(c.dimensions)
      and c.carrier_state in ('LEGACY_UNBOUND','ACTIVE_UNSTRUCTURED','ACTIVE_TYPED')
  ) then return 'SHADOWED_BY_ACTIVE_EVENT'; end if;
  return 'CURRENT';
end $$;
revoke all on function clued_private.record_currentness_fence(uuid,uuid,text[])
  from public,anon,authenticated,service_role;

alter function clued_private.record_list_core(uuid,jsonb,text[])
  rename to record_list_core_before_projection_envelope;
revoke all on function clued_private.record_list_core_before_projection_envelope(uuid,jsonb,text[])
  from public,anon,authenticated,service_role;
create or replace function clued_private.record_list_core(
  p_user_id uuid,p_input jsonb,p_authorized_scopes text[]
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_unavailable boolean:=false;
begin
  v_result:=clued_private.record_list_core_before_projection_envelope(
    p_user_id,p_input,p_authorized_scopes);
  if coalesce(p_input->>'level','global')='global' and
     coalesce((p_input->>'include_history')::boolean,false)=false and
     coalesce(p_input->>'record_type','state') in ('state','task','decision') and
     (exists(select 1 from clued_private.projection_record_bindings b
       where b.user_id=p_user_id and b.target_scope='global'
         and b.projection_key='global.priority_frontier') or
      exists(select 1 from clued_private.projection_invalidation_heads h
       where h.user_id=p_user_id and h.target_scope='global'
         and h.projection_key='global.priority_frontier')) then
    select not exists(select 1 from clued_private.projection_record_bindings b
      where b.user_id=p_user_id and b.target_scope='global'
        and b.projection_key='global.priority_frontier'
        and clued_private.record_currentness_fence(p_user_id,b.record_id,
          array['global']::text[])='CURRENT') into v_unavailable;
  end if;
  return v_result||jsonb_build_object('current_projection_unavailable',v_unavailable,
    'projection_rebuild_required',v_unavailable);
end $$;
revoke all on function clued_private.record_list_core(uuid,jsonb,text[])
  from public,anon,authenticated,service_role;

create or replace function clued_private.projection_registry_invalidate()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_kind text; v_rule clued_private.projection_dependency_registry%rowtype;
  v_source jsonb;
begin
  if new.canonical_scope='global' or
     not clued_private.currentness_source_is_visible(new.latest_source_ref) then
    return new;
  end if;
  v_source:=new.latest_source_ref;
  if v_source->>'kind'='record_mutation' and
     coalesce(v_source->>'id','')~'^[0-9a-f-]{36}$' then
    select m.record_type into v_kind from public.clued_memories m
      where m.id=(v_source->>'id')::uuid and m.user_id=new.user_id;
  elsif v_source->>'kind'='project_mutation' then
    v_kind:='project';
  elsif v_source->>'kind'='direct_event' then
    select case e.event_type when 'decision' then 'decision'
      when 'action' then 'task' when 'blocker' then 'task'
      when 'failure' then 'state' when 'correction' then 'state'
      when 'retraction' then 'decision' end into v_kind
      from public.clued_context_events e
      where e.id=(v_source->>'id')::bigint and e.user_id=new.user_id;
  end if;
  select * into v_rule from clued_private.projection_dependency_registry r
    where r.status='active' and r.source_scope_class='project'
      and r.source_entity_kind=v_kind order by r.rule_id limit 1;
  if not found then return new; end if; -- Core already invalidated fallback.
  insert into clued_private.projection_invalidation_heads(user_id,target_scope,
    projection_key,invalidation_revision,latest_source_ref,stale_since)
  select new.user_id,'global',k.projection_key,1,v_source,now()
    from pg_catalog.unnest(v_rule.target_projection_keys) k(projection_key)
  on conflict(user_id,target_scope,projection_key) do update set
    invalidation_revision=clued_private.projection_invalidation_heads.invalidation_revision+1,
    latest_source_ref=excluded.latest_source_ref,
    stale_since=coalesce(clued_private.projection_invalidation_heads.stale_since,now()),
    updated_at=now();
  return new;
end $$;
create trigger zz_projection_registry_invalidate after insert or update
  on clued_private.scope_currentness_heads for each row
  execute function clued_private.projection_registry_invalidate();

-- The current projection source set is a server-side enumeration, independent
-- of caller coverage text or event_ids. Rows are ordered before hashing.
create or replace function clued_private.projection_source_snapshot(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_projects jsonb; v_heads jsonb; v_global jsonb; v_rules jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'version',p.version,
    'lifecycle_status',p.lifecycle_status,'progress_status',p.progress_status)
    order by p.id),'[]'::jsonb) into v_projects
    from public.clued_projects p where p.user_id=p_user_id;
  select coalesce(jsonb_agg(jsonb_build_object('scope',h.canonical_scope,
    'snapshot_revision',h.snapshot_revision,'next_action_revision',h.next_action_revision,
    'authority_revision',h.authority_revision,'lifecycle_revision',h.lifecycle_revision)
    order by h.canonical_scope),'[]'::jsonb) into v_heads
    from clued_private.visible_scope_currentness_heads h
    where h.user_id=p_user_id and h.canonical_scope like 'project:%';
  select jsonb_build_object('snapshot_revision',h.snapshot_revision,
    'next_action_revision',h.next_action_revision,'authority_revision',h.authority_revision)
    into v_global from clued_private.visible_scope_currentness_heads h
    where h.user_id=p_user_id and h.canonical_scope='global';
  select coalesce(jsonb_agg(jsonb_build_object('id',r.rule_id,'digest',r.rule_digest)
    order by r.rule_id),'[]'::jsonb) into v_rules
    from clued_private.projection_dependency_registry r where r.status='active';
  return jsonb_build_object('schema','clued.projection-source-vector.v1',
    'projects',v_projects,'project_heads',v_heads,
    'global_head',coalesce(v_global,'{}'::jsonb),'registry',v_rules);
end $$;

create or replace function clued_private.projection_builder_authorized(
  p_binding_id uuid,p_user_id uuid,p_scope text,p_key text
) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from clued_private.projection_builder_grants g
    join public.clued_agent_bindings b on b.id=g.binding_id and b.user_id=g.user_id
    where g.binding_id=p_binding_id and g.user_id=p_user_id
      and g.target_scope=p_scope and g.projection_key=p_key and g.active
      and b.revoked_at is null)
$$;

create or replace function clued_private.legacy_inventory_complete(p_user_id uuid)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare v_cutover bigint;
begin
  select cutover_event_id into v_cutover from clued_private.legacy_inventory_epoch where id;
  if v_cutover is null then return false; end if;
  if exists(select 1 from public.clued_context_events e
    where e.user_id=p_user_id and e.id<=v_cutover
      and e.event_schema_version is null and e.canonical_event_type is null
      and e.event_type in ('decision','correction','action','failure','blocker','retraction')
      and not exists(select 1 from clued_private.legacy_event_candidates c
        where c.event_id=e.id and c.user_id=e.user_id)) then return false; end if;
  if exists(select 1 from public.clued_context_events e
    where e.user_id=p_user_id and e.event_schema_version is null
      and e.canonical_event_type is null
      and e.event_type in ('decision','correction','action','failure','blocker','retraction')
      and not exists(select 1 from clued_private.event_truth_carriers c
        where c.event_id=e.id and c.user_id=e.user_id)) then return false; end if;
  if exists(select 1 from clued_private.legacy_event_candidates c
    where c.user_id=p_user_id and not exists(
      select 1 from clued_private.legacy_carrier_inventory_receipts r
      where r.batch_id=c.inventory_batch_id and r.user_id=c.user_id
        and r.raw_context_key=c.raw_context_key)) then return false; end if;
  if exists(select 1 from clued_private.legacy_carrier_inventory_receipts r
    where r.user_id=p_user_id and (r.candidate_count is distinct from
      (select count(*) from clued_private.legacy_event_candidates c
        where c.inventory_batch_id=r.batch_id and c.user_id=r.user_id
          and c.raw_context_key=r.raw_context_key)
      or r.inventory_sha256 is distinct from (
        select pg_catalog.encode(extensions.digest(pg_catalog.string_agg(
          jsonb_build_object('event_id',c.event_id,'owner',c.user_id,
            'raw_context',c.raw_context_key,'canonical_scope',c.canonical_scope,
            'event_type',c.event_type,'event_version',c.event_version,
            'source_receipt',c.source_receipt_id,'visibility',c.visibility,
            'dimensions',c.dimensions,'occurred_at',c.occurred_at,
            'disposition',c.disposition,
            'candidate_project_scopes',coalesce((select jsonb_agg(i.project_scope order by i.project_scope)
              from clued_private.legacy_event_project_impacts i
              where i.event_id=c.event_id),'[]'::jsonb))::text,
            ',' order by c.event_id),'sha256'),'hex')
        from clued_private.legacy_event_candidates c
        where c.inventory_batch_id=r.batch_id and c.user_id=r.user_id
          and c.raw_context_key=r.raw_context_key))) then return false; end if;
  return true;
end $$;

-- An authenticated, separately granted builder submits a newly written Record.
-- The service verifies the expected source digest and invalidation CAS; this
-- function cannot rewrite semantic content or claim a stale generation current.
create or replace function public.clued_mcp_projection_rebuild(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
  v_key text:=p_input->>'projection_key'; v_record public.clued_memories%rowtype;
  v_invalidation clued_private.projection_invalidation_heads%rowtype;
  v_snapshot jsonb; v_digest text; v_generation bigint; v_expected bigint;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write','global');
  if not clued_private.projection_builder_authorized(v_binding.id,v_binding.user_id,'global',v_key)
    then raise exception 'projection_builder_not_authorized' using errcode='42501'; end if;
  if v_key='global.__aggregate__' then raise exception 'full_reconcile_required' using errcode='22023'; end if;
  perform clued_private.currentness_user_lock(v_binding.user_id);
  select * into v_invalidation from clued_private.projection_invalidation_heads
    where user_id=v_binding.user_id and target_scope='global' and projection_key=v_key for update;
  if not found then raise exception 'projection_invalidation_missing' using errcode='40001'; end if;
  v_expected:=(p_input->>'expected_invalidation_revision')::bigint;
  if v_expected is distinct from v_invalidation.invalidation_revision then
    raise exception 'projection_rebuild_cas_conflict' using errcode='40001'; end if;
  v_snapshot:=clued_private.projection_source_snapshot(v_binding.user_id);
  v_digest:=clued_private.currentness_hash(v_snapshot);
  if p_input->>'expected_source_vector_digest' is distinct from v_digest then
    raise exception 'projection_source_changed' using errcode='40001'; end if;
  select * into v_record from public.clued_memories m
    where m.user_id=v_binding.user_id and m.id=(p_input->>'record_id')::uuid
      and m.canonical_scope='global' and m.record_type in ('state','task','decision')
      and m.lifecycle_status='active' for update nowait;
  if not found or v_record.updated_at<v_invalidation.stale_since then
    raise exception 'projection_record_not_rebuilt' using errcode='40001'; end if;
  if coalesce(v_record.type_fields->>'projection_key',v_key)<>v_key then
    raise exception 'projection_key_mismatch' using errcode='22023'; end if;
  select coalesce(max(h.projection_generation),0)+1 into v_generation
    from clued_private.projection_heads h where h.user_id=v_binding.user_id
      and h.target_scope='global' and h.projection_key=v_key;
  update clued_private.projection_invalidation_heads set
    resolved_through_revision=v_expected,stale_since=null,updated_at=now()
    where user_id=v_binding.user_id and target_scope='global' and projection_key=v_key
      and invalidation_revision=v_expected;
  if not found then raise exception 'projection_rebuild_cas_conflict' using errcode='40001'; end if;
  insert into clued_private.projection_heads(user_id,target_scope,projection_key,
    projection_generation,resolved_through_invalidation_revision,
    source_vector_digest,source_refs,record_id,projection_owner)
  values(v_binding.user_id,'global',v_key,v_generation,v_expected,v_digest,
    v_snapshot->'project_heads',v_record.id,'authorized_builder')
  on conflict(user_id,target_scope,projection_key) do update set
    projection_generation=excluded.projection_generation,
    resolved_through_invalidation_revision=excluded.resolved_through_invalidation_revision,
    source_vector_digest=excluded.source_vector_digest,source_refs=excluded.source_refs,
    record_id=excluded.record_id,projection_owner=excluded.projection_owner,generated_at=now();
  insert into clued_private.projection_record_bindings(record_id,user_id,target_scope,
    projection_key,projection_generation,source_vector_digest,source_refs,
    resolved_through_invalidation_revision,projection_owner)
  values(v_record.id,v_binding.user_id,'global',v_key,v_generation,v_digest,
    v_snapshot->'project_heads',v_expected,'authorized_builder')
  on conflict(record_id) do update set
    projection_generation=excluded.projection_generation,
    source_vector_digest=excluded.source_vector_digest,source_refs=excluded.source_refs,
    resolved_through_invalidation_revision=excluded.resolved_through_invalidation_revision,
    projection_owner=excluded.projection_owner;
  return jsonb_build_object('status','rebuilt','projection_key',v_key,
    'projection_generation',v_generation,'source_vector_digest',v_digest,
    'resolved_through_invalidation_revision',v_expected);
end $$;

-- Unknown-impact fallback can clear only after every specific projection is
-- rebuilt at its current revision and the complete server-side scan is stable.
create or replace function public.clued_mcp_full_global_reconcile(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
  v_head clued_private.projection_invalidation_heads%rowtype;
  v_snapshot jsonb; v_digest text; v_receipt_id uuid;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write','global');
  if not clued_private.projection_builder_authorized(v_binding.id,v_binding.user_id,
    'global','global.__aggregate__') then
    raise exception 'projection_builder_not_authorized' using errcode='42501'; end if;
  perform clued_private.currentness_user_lock(v_binding.user_id);
  select * into v_head from clued_private.projection_invalidation_heads h
    where h.user_id=v_binding.user_id and h.target_scope='global'
      and h.projection_key='global.__aggregate__' for update;
  if not found then raise exception 'aggregate_invalidation_missing' using errcode='40001'; end if;
  if (p_input->>'expected_invalidation_revision')::bigint is distinct from v_head.invalidation_revision
    then raise exception 'full_reconcile_cas_conflict' using errcode='40001'; end if;
  if exists(select 1 from clued_private.projection_invalidation_heads h
    where h.user_id=v_binding.user_id and h.target_scope='global'
      and h.projection_key<>'global.__aggregate__'
      and h.invalidation_revision>h.resolved_through_revision) then
    raise exception 'required_projection_stale' using errcode='40001'; end if;
  if exists(select 1 from clued_private.event_truth_carriers c
    where c.user_id=v_binding.user_id and c.carrier_state='LEGACY_UNBOUND'
      and c.visibility='work_log') then
    raise exception 'legacy_currentness_unknown' using errcode='40001'; end if;
  v_snapshot:=clued_private.projection_source_snapshot(v_binding.user_id);
  v_digest:=clued_private.currentness_hash(v_snapshot);
  if p_input->>'expected_source_vector_digest' is distinct from v_digest then
    raise exception 'full_reconcile_source_changed' using errcode='40001'; end if;
  update clued_private.projection_invalidation_heads set
    resolved_through_revision=v_head.invalidation_revision,
    stale_since=null,updated_at=now()
    where user_id=v_binding.user_id and target_scope='global'
      and projection_key='global.__aggregate__'
      and invalidation_revision=v_head.invalidation_revision;
  if not found then raise exception 'full_reconcile_cas_conflict' using errcode='40001'; end if;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,
    operation,object_type,object_id,version,metadata)
  values(v_binding.user_id,v_binding.id,'global','full_global_reconcile',
    'currentness','global.__aggregate__',v_head.invalidation_revision,
    jsonb_build_object('receipt_kind','CURRENTNESS_ADMISSION','admission_eligible',true,
      'source_vector_digest',v_digest,'source_vector',v_snapshot,
      'resolved_through_invalidation_revision',v_head.invalidation_revision))
  returning id into v_receipt_id;
  return jsonb_build_object('status','reconciled','receipt_id',v_receipt_id,
    'source_vector_digest',v_digest,
    'resolved_through_invalidation_revision',v_head.invalidation_revision);
end $$;

create or replace function public.clued_mcp_currentness_g6_gate(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; v_snapshot jsonb;
  v_digest text; v_project_id uuid; v_project_scope text;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read','global');
  v_project_id:=(p_input->>'project_id')::uuid;
  v_project_scope:='project:'||v_project_id::text;
  perform clued_private.resolve_binding(p_token_hash,'context:read',v_project_scope);
  perform clued_private.currentness_user_lock(v_binding.user_id);
  if not exists(select 1 from public.clued_projects p
    where p.id=v_project_id and p.user_id=v_binding.user_id) or
    exists(select 1 from clued_private.projection_invalidation_heads h
      where h.user_id=v_binding.user_id and h.invalidation_revision>h.resolved_through_revision) or
    exists(select 1 from clued_private.event_truth_carriers c
      where c.user_id=v_binding.user_id and c.visibility='work_log'
        and c.carrier_state='LEGACY_UNBOUND') then
    return jsonb_build_object('status','not_ready','gate','G6_CURRENTNESS',
      'missing_requirements',jsonb_build_array('projection_currentness_or_legacy_unknown',
        'fresh_project_receipt','fresh_global_receipt','cross_scope_receipt_parity',
        'fresh_resume_parity','current_search_parity','checkpoint_alias_enforcement'));
  end if;
  v_snapshot:=clued_private.projection_source_snapshot(v_binding.user_id);
  v_digest:=clued_private.currentness_hash(v_snapshot);
  return jsonb_build_object('status','precheck_pass','gate','G6_CURRENTNESS',
    'source_vector_digest',v_digest,
    'missing_requirements',jsonb_build_array('fresh_project_receipt',
      'fresh_global_receipt','cross_scope_receipt_parity','fresh_resume_parity',
      'current_search_parity','checkpoint_alias_enforcement'));
end $$;

revoke all on function clued_private.projection_source_snapshot(uuid),
  clued_private.projection_builder_authorized(uuid,uuid,text,text),
  clued_private.projection_registry_invalidate()
  from public,anon,authenticated,service_role;
revoke all on function public.clued_mcp_projection_rebuild(text,jsonb),
  public.clued_mcp_full_global_reconcile(text,jsonb),
  public.clued_mcp_currentness_g6_gate(text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.clued_mcp_projection_rebuild(text,jsonb),
  public.clued_mcp_full_global_reconcile(text,jsonb),
  public.clued_mcp_currentness_g6_gate(text,jsonb) to anon;
notify pgrst,'reload schema';
