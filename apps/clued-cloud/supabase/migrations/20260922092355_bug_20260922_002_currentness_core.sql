-- BUG-20260922-002: additive, database-owned currentness sources.
-- Enforcement is installed by a successor migration after inventory and replay.

-- M1 already accepts extension:*:* at its RPC boundary, but the original
-- Continuity table check still rejected the persisted value. Keep the legacy
-- seven types and admit only the existing M1 extension syntax.
alter table public.clued_context_events
  drop constraint if exists clued_context_events_event_type_check;
alter table public.clued_context_events
  add constraint clued_context_events_event_type_check check (
    event_type in ('decision','correction','action','failure','blocker','retraction','note')
    or (char_length(event_type)<=96 and
      event_type~'^extension:[a-z0-9_.-]+:[a-z0-9_.-]+$')
  );

create table clued_private.scope_currentness_heads (
  user_id uuid not null references auth.users(id) on delete cascade,
  canonical_scope text not null,
  snapshot_revision bigint not null default 0 check (snapshot_revision >= 0),
  next_action_revision bigint not null default 0 check (next_action_revision >= 0),
  authority_revision bigint not null default 0 check (authority_revision >= 0),
  lifecycle_revision bigint not null default 0 check (lifecycle_revision >= 0),
  latest_source_ref jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id,canonical_scope)
);

create table clued_private.projection_invalidation_heads (
  user_id uuid not null references auth.users(id) on delete cascade,
  target_scope text not null,
  projection_key text not null,
  invalidation_revision bigint not null default 0,
  resolved_through_revision bigint not null default 0,
  latest_source_ref jsonb not null default '{}'::jsonb,
  stale_since timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id,target_scope,projection_key),
  check (invalidation_revision >= resolved_through_revision)
);

create table clued_private.event_truth_carriers (
  event_id bigint primary key references public.clued_context_events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  canonical_scope text not null,
  dimensions text[] not null,
  visibility text not null check (visibility in ('work_log','audit_only','hidden')),
  source_kind text not null check (source_kind in ('direct','legacy','typed_extension')),
  carrier_state text not null check (carrier_state in (
    'ACTIVE_UNSTRUCTURED','ACTIVE_TYPED','MATERIALIZED_TO_RECORD',
    'SUPERSEDED','RETRACTED','RESOLVED_CONTINUITY_ONLY','LEGACY_UNBOUND')),
  event_version bigint,
  materialized_record_id uuid references public.clued_memories(id),
  materialized_record_version bigint,
  transition_version bigint not null default 1,
  transition_receipt_id uuid references public.clued_audit_receipts(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((carrier_state='MATERIALIZED_TO_RECORD') = (materialized_record_id is not null))
);
create index event_truth_carriers_current_idx
  on clued_private.event_truth_carriers(user_id,canonical_scope,event_id desc)
  where carrier_state in ('ACTIVE_UNSTRUCTURED','ACTIVE_TYPED','LEGACY_UNBOUND');

-- Typed extensions enter business currentness only through a privileged
-- registration with explicit impact, authorization scope and read surface.
-- An unregistered extension remains audit/continuity evidence.
create table clued_private.typed_event_currentness_registry (
  event_type text primary key check(event_type~'^extension:[a-z0-9_.-]+:[a-z0-9_.-]+$'),
  impact_dimensions text[] not null check(cardinality(impact_dimensions)>0),
  typed_consumer text not null,
  authorization_scope text not null default 'event_scope'
    check(authorization_scope='event_scope'),
  read_surface text not null default 'search_context'
    check(read_surface='search_context'),
  registry_version integer not null check(registry_version>0),
  active boolean not null default true,
  registered_at timestamptz not null default now()
);

alter table clued_private.scope_currentness_heads enable row level security;
alter table clued_private.projection_invalidation_heads enable row level security;
alter table clued_private.event_truth_carriers enable row level security;
alter table clued_private.typed_event_currentness_registry enable row level security;
revoke all on table clued_private.scope_currentness_heads,
  clued_private.projection_invalidation_heads,
  clued_private.event_truth_carriers,
  clued_private.typed_event_currentness_registry
  from public,anon,authenticated,service_role;

create or replace function clued_private.event_currentness_dimensions(p_event_type text)
returns text[] language sql immutable set search_path='' as $$
  select case p_event_type
    when 'decision' then array['decision']::text[]
    when 'correction' then array['state','task','decision']::text[]
    when 'retraction' then array['state','task','decision']::text[]
    when 'action' then array['state','task']::text[]
    when 'failure' then array['state','task']::text[]
    when 'blocker' then array['state','task']::text[]
    else '{}'::text[] end
$$;

create or replace function clued_private.touch_currentness(
  p_user_id uuid,p_scope text,p_kind text,p_source_id text,p_dimensions text[]
) returns void language plpgsql security definer set search_path='' as $$
declare v_source jsonb;
begin
  if p_user_id is null or p_scope is null or p_source_id is null then
    raise exception 'invalid_currentness_source' using errcode='22023';
  end if;
  if cardinality(p_dimensions)=0 then return; end if;
  v_source:=jsonb_build_object('kind',p_kind,'id',p_source_id,'scope',p_scope);
  insert into clued_private.scope_currentness_heads(
    user_id,canonical_scope,snapshot_revision,next_action_revision,
    authority_revision,lifecycle_revision,latest_source_ref)
  values(p_user_id,p_scope,1,
    case when p_dimensions && array['state','task','decision']::text[] then 1 else 0 end,
    case when 'decision'=any(p_dimensions) then 1 else 0 end,
    case when 'lifecycle'=any(p_dimensions) then 1 else 0 end,v_source)
  on conflict(user_id,canonical_scope) do update set
    snapshot_revision=clued_private.scope_currentness_heads.snapshot_revision+1,
    next_action_revision=clued_private.scope_currentness_heads.next_action_revision+
      case when p_dimensions && array['state','task','decision']::text[] then 1 else 0 end,
    authority_revision=clued_private.scope_currentness_heads.authority_revision+
      case when 'decision'=any(p_dimensions) then 1 else 0 end,
    lifecycle_revision=clued_private.scope_currentness_heads.lifecycle_revision+
      case when 'lifecycle'=any(p_dimensions) then 1 else 0 end,
    latest_source_ref=v_source,updated_at=now();
  if p_scope<>'global' then
    insert into clued_private.projection_invalidation_heads(
      user_id,target_scope,projection_key,invalidation_revision,latest_source_ref,stale_since)
    values(p_user_id,'global','global.__aggregate__',1,v_source,now())
    on conflict(user_id,target_scope,projection_key) do update set
      invalidation_revision=clued_private.projection_invalidation_heads.invalidation_revision+1,
      latest_source_ref=v_source,stale_since=coalesce(
        clued_private.projection_invalidation_heads.stale_since,now()),updated_at=now();
  end if;
end $$;

create or replace function clued_private.currentness_event_insert()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_dimensions text[]; v_kind text; v_state text; v_scope text;
begin
  if new.event_schema_version is not null then
    select r.impact_dimensions into v_dimensions
      from clued_private.typed_event_currentness_registry r
      where r.event_type=new.event_type and r.active
        and r.registry_version=new.event_schema_version;
    if not found then return new; end if;
    if new.event_scope is null then
      raise exception 'registered_typed_event_scope_required' using errcode='22023';
    end if;
    v_kind:='typed_extension'; v_state:='ACTIVE_TYPED'; v_scope:=new.event_scope;
  else
    if new.session_id is null then return new; end if;
    v_dimensions:=clued_private.event_currentness_dimensions(new.event_type);
    v_kind:='direct'; v_state:='ACTIVE_UNSTRUCTURED'; v_scope:=new.context_key;
  end if;
  if cardinality(v_dimensions)=0 then return new; end if;
  insert into clued_private.event_truth_carriers(
    event_id,user_id,canonical_scope,dimensions,visibility,source_kind,
    carrier_state,event_version)
  values(new.id,new.user_id,v_scope,v_dimensions,
    case when new.audit_visibility in ('audit_only','hidden') then new.audit_visibility else 'work_log' end,
    v_kind,v_state,new.version);
  -- Audit-only carriers stay private. They cannot invalidate an authorized
  -- projection or advance a revision observable by a lower-permission caller.
  if new.audit_visibility is null or new.audit_visibility='work_log' then
    perform clued_private.touch_currentness(
      new.user_id,v_scope,case when v_kind='direct' then 'direct_event'
        else 'typed_extension_event' end,new.id::text,v_dimensions);
  end if;
  return new;
end $$;
create trigger currentness_direct_event_insert
  after insert on public.clued_context_events
  for each row execute function clued_private.currentness_event_insert();

create or replace function clued_private.currentness_record_change()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_scope text; v_material jsonb; v_event_id bigint; v_expected bigint;
  v_carrier clued_private.event_truth_carriers%rowtype;
  v_new_binding boolean:=false; v_dimensions text[];
begin
  if tg_op='DELETE' then
    if old.record_type not in ('state','task','decision') then return old; end if;
    v_scope:=coalesce(old.canonical_scope,
      case when old.project_id is null then 'global' else 'project:'||old.project_id::text end);
    perform clued_private.touch_currentness(old.user_id,v_scope,'record_delete',old.id::text,
      array[old.record_type,'lifecycle']);
    return old;
  end if;
  if new.record_type not in ('state','task','decision') then return new; end if;
  if tg_op='UPDATE' then
    if row(new.title,new.content,new.status,new.priority,new.version,
        new.lifecycle_status,new.type_fields,new.relations,new.canonical_scope,new.project_id)
      is not distinct from row(old.title,old.content,old.status,old.priority,old.version,
        old.lifecycle_status,old.type_fields,old.relations,old.canonical_scope,old.project_id) then
      return new;
    end if;
    v_new_binding:=new.relations->'materializes_event' is distinct from
      old.relations->'materializes_event';
    v_dimensions:=array[new.record_type]||case when
      new.lifecycle_status is distinct from old.lifecycle_status
      then array['lifecycle']::text[] else '{}'::text[] end;
  else
    v_new_binding:=true;
    v_dimensions:=array[new.record_type];
  end if;
  v_scope:=coalesce(new.canonical_scope,
    case when new.project_id is null then 'global' else 'project:'||new.project_id::text end);
  v_material:=new.relations->'materializes_event';
  if v_material is not null and v_new_binding then
    if new.receipt_id is null or
      (tg_op='UPDATE' and new.receipt_id is not distinct from old.receipt_id) or
      not exists(
      select 1 from public.clued_audit_receipts receipt
      where receipt.id=new.receipt_id and receipt.user_id=new.user_id
        and receipt.operation in ('record_mutation','decision_supersede')
    ) then
      raise exception 'materialization_receipt_required' using errcode='42501';
    end if;
    if jsonb_typeof(v_material)<>'object' or
      coalesce(v_material->>'id','') !~ '^[1-9][0-9]*$' or
      coalesce(v_material->>'version','') !~ '^[1-9][0-9]*$' then
      raise exception 'invalid_materialization_binding' using errcode='22023';
    end if;
    v_event_id:=(v_material->>'id')::bigint;
    v_expected:=(v_material->>'version')::bigint;
    select * into v_carrier from clued_private.event_truth_carriers
      where event_id=v_event_id for update;
    if not found or v_carrier.user_id<>new.user_id or
       v_carrier.canonical_scope<>v_scope or
       v_carrier.visibility<>'work_log' or
       v_carrier.event_version is distinct from v_expected or
       v_carrier.carrier_state not in ('ACTIVE_UNSTRUCTURED','ACTIVE_TYPED') or
       not new.record_type=any(v_carrier.dimensions) or
       coalesce(new.lifecycle_status,'active')<>'active' then
      raise exception 'event_materialization_conflict' using errcode='40001';
    end if;
    update clued_private.event_truth_carriers set
      carrier_state='MATERIALIZED_TO_RECORD',materialized_record_id=new.id,
      materialized_record_version=new.version,transition_version=transition_version+1,
      transition_receipt_id=new.receipt_id,updated_at=now()
    where event_id=v_event_id and transition_version=v_carrier.transition_version;
    if not found then raise exception 'event_materialization_conflict' using errcode='40001'; end if;
  end if;
  perform clued_private.touch_currentness(new.user_id,v_scope,'record_mutation',new.id::text,
    v_dimensions);
  return new;
end $$;
create trigger currentness_record_change
  after insert or update or delete on public.clued_memories
  for each row execute function clued_private.currentness_record_change();

create or replace function clued_private.currentness_project_change()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_dimensions text[]:=array['state','lifecycle']::text[];
begin
  if tg_op='DELETE' then
    perform clued_private.touch_currentness(old.user_id,'project:'||old.id::text,
      'project_delete',old.id::text,v_dimensions);
    return old;
  end if;
  if tg_op='UPDATE' then
    if row(new.name,new.normalized_name,new.aliases,new.certainty_status,
        new.progress_status,new.summary,new.dismissed_at,new.merged_into_project_id,
        new.lifecycle_status,new.version)
      is not distinct from row(old.name,old.normalized_name,old.aliases,
        old.certainty_status,old.progress_status,old.summary,old.dismissed_at,
        old.merged_into_project_id,old.lifecycle_status,old.version) then
      return new;
    end if;
  end if;
  perform clued_private.touch_currentness(new.user_id,'project:'||new.id::text,
    'project_mutation',new.id::text,v_dimensions);
  return new;
end $$;
create trigger currentness_project_change
  after insert or update or delete on public.clued_projects
  for each row execute function clued_private.currentness_project_change();

-- Existing scopes begin at successor revision zero. This is an epoch marker,
-- not a fabricated replay of historical mutations.
insert into clued_private.scope_currentness_heads(user_id,canonical_scope)
select distinct source.user_id,source.canonical_scope from (
  select u.id as user_id,'global'::text as canonical_scope from auth.users u
  union all
  select p.user_id,'project:'||p.id::text from public.clued_projects p
  union all
  select m.user_id,coalesce(m.canonical_scope,
    case when m.project_id is null then 'global'
      else 'project:'||m.project_id::text end)
    from public.clued_memories m
  union all
  select e.user_id,e.context_key from public.clued_context_events e
) source
where source.user_id is not null and source.canonical_scope is not null
on conflict(user_id,canonical_scope) do nothing;

revoke all on function clued_private.event_currentness_dimensions(text),
  clued_private.touch_currentness(uuid,text,text,text,text[]),
  clued_private.currentness_event_insert(),
  clued_private.currentness_record_change(),
  clued_private.currentness_project_change()
  from public,anon,authenticated,service_role;

-- Both Binding and logged-in user list routes call the same record_list_core,
-- which invokes this single fence before ordering and limiting rows.
create or replace function clued_private.record_currentness_fence(
  p_user_id uuid,p_record_id uuid,p_authorized_scopes text[]
) returns text language plpgsql stable security definer set search_path='' as $$
declare v_record public.clued_memories%rowtype; v_scope text; v_projection_key text;
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
  v_projection_key:=nullif(v_record.type_fields->>'projection_key','');
  if v_projection_key is not null and exists(
    select 1 from clued_private.projection_invalidation_heads h
    where h.user_id=p_user_id and h.target_scope=v_scope
      and h.projection_key=v_projection_key
      and h.invalidation_revision>h.resolved_through_revision
  ) then return 'STALE'; end if;
  if exists(
    select 1 from clued_private.event_truth_carriers c
    join public.clued_context_events e on e.id=c.event_id
    where c.user_id=p_user_id and c.canonical_scope=v_scope
      and c.visibility='work_log'
      and (p_authorized_scopes is null or c.canonical_scope=any(p_authorized_scopes))
      and v_record.record_type=any(c.dimensions)
      and (c.carrier_state='LEGACY_UNBOUND' or
        (c.carrier_state in ('ACTIVE_UNSTRUCTURED','ACTIVE_TYPED')
         and e.occurred_at>=v_record.updated_at))
  ) then return 'SHADOWED_BY_ACTIVE_EVENT'; end if;
  return 'CURRENT';
end $$;
revoke all on function clued_private.record_currentness_fence(uuid,uuid,text[])
  from public,anon,authenticated,service_role;

-- Shared record list implementation: filtering occurs before limit.
create or replace function clued_private.record_list_core(p_user_id uuid,p_input jsonb,p_authorized_scopes text[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_level text:=coalesce(p_input->>'level','global');
  v_type text:=coalesce(p_input->>'record_type','state');
  v_project_id uuid;
  v_effective_project_id uuid;
  v_project_scopes text[]:='{}'::text[];
  v_legacy_context_keys text[]:='{}'::text[];
  v_limit integer:=least(greatest(coalesce((p_input->>'limit')::integer,100),1),200);
  v_rows jsonb;
  v_include_history boolean:=coalesce((p_input->>'include_history')::boolean,false);
begin
  if p_user_id is null then raise exception 'account_required' using errcode='28000'; end if;
  if v_level not in ('global','project') then raise exception 'invalid_record_level' using errcode='22023'; end if;
  if v_type not in ('note','state','task','decision','archive','log') then raise exception 'invalid_record_type' using errcode='22023'; end if;
  if v_level='project' then
    v_project_id:=(p_input->>'project_id')::uuid;
    select case when count(distinct r.effective_project_id)=1
                then (array_agg(distinct r.effective_project_id))[1]
                else null end
      into v_effective_project_id
      from public.clued_project_resolution_v2 r
     where r.user_id=p_user_id and r.source_project_id=v_project_id;
    if v_effective_project_id is null then raise exception 'project_not_found' using errcode='P0002'; end if;

    select coalesce(array_agg('project:'||unique_source.source_project_id::text
                              order by unique_source.source_project_id),'{}'::text[])
      into v_project_scopes
      from (
        select r.source_project_id,
               (array_agg(distinct r.effective_project_id))[1] as effective_project_id
          from public.clued_project_resolution_v2 r
         where r.user_id=p_user_id and r.effective_project_id is not null
         group by r.source_project_id
        having count(distinct r.effective_project_id)=1
      ) unique_source
     where unique_source.effective_project_id=v_effective_project_id;

    with candidate_keys as (
      select r.effective_project_id,lower('project:'||p.id::text) as context_key
        from public.clued_project_resolution_v2 r
        join public.clued_projects p on p.user_id=r.user_id and p.id=r.source_project_id
       where r.user_id=p_user_id
      union all
      select r.effective_project_id,lower('project:'||p.normalized_name)
        from public.clued_project_resolution_v2 r
        join public.clued_projects p on p.user_id=r.user_id and p.id=r.source_project_id
       where r.user_id=p_user_id
      union all
      select r.effective_project_id,lower('project:'||p.name)
        from public.clued_project_resolution_v2 r
        join public.clued_projects p on p.user_id=r.user_id and p.id=r.source_project_id
       where r.user_id=p_user_id
      union all
      select r.effective_project_id,lower('project:'||alias_name)
        from public.clued_project_resolution_v2 r
        join public.clued_projects p on p.user_id=r.user_id and p.id=r.source_project_id
        cross join lateral unnest(coalesce(p.aliases,'{}'::text[])) alias_name
       where r.user_id=p_user_id
    ), unique_keys as (
      select context_key,(array_agg(distinct effective_project_id))[1] as effective_project_id
        from candidate_keys
       group by context_key
      having count(distinct effective_project_id)=1
    )
    select coalesce(array_agg(context_key order by context_key),'{}'::text[])
      into v_legacy_context_keys
      from unique_keys
     where effective_project_id=v_effective_project_id;
  end if;
  if v_type='log' then
    select coalesce(jsonb_agg(row_data order by event_id desc),'[]'::jsonb) into v_rows from (
      select e.id as event_id,jsonb_build_object(
        'id',e.id::text,'record_type','log','project_id',e.project_id,'record_id',e.record_id,
        'record_version',e.record_version,'event_type',e.event_type,'payload',e.payload,
        'event_schema_version',e.event_schema_version,
        'committed_canonical_version',e.committed_canonical_version,
        'canonical_event_type',e.canonical_event_type,
        'target_refs',e.target_refs,'event_scope',e.event_scope,'origin_scope',e.origin_scope,
        'change_summary',e.change_summary,'result',e.result,'receipt_id',e.receipt_id,
        'audit_visibility',e.audit_visibility,'evidence_refs',e.evidence_refs,
        'artifact_refs',e.artifact_refs,'error_code',e.error_code,
        'created_at',e.occurred_at,'updated_at',e.occurred_at
      ) as row_data
      from public.clued_context_events e
      where e.user_id=p_user_id
        and (p_authorized_scopes is null or coalesce(e.event_scope,e.context_key)=any(p_authorized_scopes))
        and (
          e.audit_visibility='work_log'
          or (
            e.audit_visibility is null
            and e.event_scope is null
            and e.event_schema_version is null
            and e.binding_id is not null
            and e.session_id is not null
            and e.event_type in ('action','blocker','correction','decision','failure')
          )
        )
        and (
          (v_level='global' and coalesce(e.event_scope,e.context_key)='global')
          or (
            v_level='project'
            and (
              (e.audit_visibility='work_log' and e.event_scope=any(v_project_scopes))
              or (
                e.audit_visibility is null
                and e.event_scope is null
                and e.event_schema_version is null
                and e.binding_id is not null
                and e.session_id is not null
                and e.event_type in ('action','blocker','correction','decision','failure')
                and lower(e.context_key)=any(v_legacy_context_keys)
              )
            )
          )
        )
      order by e.id desc limit v_limit
    ) events;
  else
    select coalesce(jsonb_agg(to_jsonb(record_row)||jsonb_build_object('projection_currentness',
      record_row.record_currentness,'authoritative',
      not v_include_history and v_type in ('state','task','decision') and
      record_row.record_currentness='CURRENT') order by record_row.priority desc,record_row.updated_at desc,record_row.id),'[]'::jsonb)
      into v_rows from (
        select r.*,clued_private.record_currentness_fence(p_user_id,r.id,p_authorized_scopes) as record_currentness from public.clued_records_v2 r
         where r.user_id=p_user_id
           and (p_authorized_scopes is null or exists (
             select 1 from public.clued_memories authorized_source
              where authorized_source.id=r.id and authorized_source.user_id=p_user_id
                and coalesce(authorized_source.canonical_scope,case when authorized_source.project_id is not null then 'project:'||authorized_source.project_id::text else authorized_source.scope end)=any(p_authorized_scopes)
           ))
           and (
             (v_level='global' and r.effective_project_id is null)
             or (v_level='project' and r.effective_project_id=v_effective_project_id)
           )
           and (case when v_type='archive' then r.status='archived' else r.record_type=v_type and (v_include_history or r.status<>'archived') end)
           and (v_include_history or v_type in ('note','archive') or
             clued_private.record_currentness_fence(p_user_id,r.id,p_authorized_scopes)='CURRENT')
         order by r.priority desc,r.updated_at desc,r.id limit v_limit
      ) record_row;
  end if;
  return jsonb_build_object('status','ok','level',v_level,'record_type',v_type,'project_id',v_effective_project_id,'records',v_rows);
end $$;




-- Current Search: checkpoint history is explicit; Event carrier state is independent of absorption.
create or replace function public.clued_mcp_search_context(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_binding public.clued_agent_bindings%rowtype; v_session public.clued_continuity_sessions%rowtype;
  v_context_key text:=coalesce(nullif(btrim(p_input->>'context_key'),''),'global');
  v_query text:=btrim(coalesce(p_input->>'query',''));
  v_include_history boolean:=coalesce((p_input->>'include_history')::boolean,false);
  v_limit integer:=least(greatest(coalesce((p_input->>'limit')::integer,10),1),50);
  v_cursor integer:=greatest(coalesce((p_input->>'cursor')::integer,0),0);
  v_budget integer:=least(greatest(coalesce((p_input->>'max_bytes')::integer,65536),4096),262144);
  v_results jsonb:='[]'::jsonb; v_count integer:=0; v_candidate_count integer:=0;
  v_next_cursor integer; v_truncated boolean:=false; v_oversize boolean:=false;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_context_key);
  v_session:=clued_private.resolve_session(v_binding.user_id,v_binding.id,v_context_key,p_input->>'session_token');
  if char_length(v_query) not between 1 and 500 then raise exception 'invalid_query_length' using errcode='22023'; end if;
  with matches as (
    select jsonb_build_object('kind','record','id',m.id,'version',m.version,'record_type',m.record_type,
      'scope',coalesce(m.canonical_scope,case when m.project_id is not null then 'project:'||m.project_id::text else m.scope end),
      'title',m.title,'content',m.content,'status',m.status,'lifecycle_status',m.lifecycle_status,
      'type_fields',m.type_fields,'updated_at',m.updated_at,'record_currentness',
      clued_private.record_currentness_fence(v_binding.user_id,m.id,array[v_context_key]::text[]),
      'projection_currentness',clued_private.record_currentness_fence(v_binding.user_id,m.id,array[v_context_key]::text[]),
      'authoritative',not v_include_history and clued_private.record_currentness_fence(v_binding.user_id,m.id,array[v_context_key]::text[])='CURRENT') row_data,0 source_order,m.updated_at sort_time,m.id::text sort_id
    from public.clued_memories m where m.user_id=v_binding.user_id
      and coalesce(m.canonical_scope,case when m.project_id is not null then 'project:'||m.project_id::text else m.scope end)=v_context_key
      and (v_include_history or (m.archived_at is null and m.merged_into_record_id is null
        and m.status not in ('archived','superseded','revoked','cancelled')
        and coalesce(m.lifecycle_status,'active') not in ('archived','revoked','cancelled')
        and not exists(select 1 from public.clued_memories successor where successor.user_id=m.user_id and successor.supersedes_id=m.id)
        and clued_private.record_currentness_fence(v_binding.user_id,m.id,array[v_context_key]::text[])='CURRENT'))
      and (strpos(lower(coalesce(m.title,'')),lower(v_query))>0 or strpos(lower(coalesce(m.content,'')),lower(v_query))>0
        or strpos(lower(coalesce(m.type_fields::text,'')),lower(v_query))>0)
    union all
    select jsonb_build_object('kind','checkpoint','id',c.id,'version',c.version,'summary',c.summary,
      'next_action',c.next_action,'snapshot',c.snapshot,'coverage',c.checkpoint_coverage,
      'source_semantics','continuity_history','authoritative',false,'created_at',c.created_at),
      1,c.created_at,c.id::text from public.clued_context_checkpoints c
    where c.user_id=v_binding.user_id and c.context_key=v_context_key
      and (c.summary ilike '%'||v_query||'%' or c.next_action ilike '%'||v_query||'%' or c.snapshot::text ilike '%'||v_query||'%')
      and v_include_history
    union all
    select jsonb_build_object('kind','event','id',e.id,'version',e.version,'type',e.event_type,
      'payload',e.payload,'carrier_state',tc.carrier_state,
      'source_semantics',case when tc.carrier_state in ('ACTIVE_UNSTRUCTURED','ACTIVE_TYPED')
        then 'canonical_material_event' else 'continuity_history' end,
      'structured_action_usable',tc.carrier_state='ACTIVE_TYPED',
      'target_refs',clued_private.k_cont_visible_target_refs_v1(v_binding.user_id,v_binding.id,v_context_key,e.target_refs),'occurred_at',e.occurred_at),
      2,e.occurred_at,e.id::text from public.clued_context_events e
    left join clued_private.event_truth_carriers tc on tc.event_id=e.id and tc.user_id=e.user_id
    where e.user_id=v_binding.user_id and e.context_key=v_context_key and (e.audit_visibility='work_log' or (e.event_schema_version is null and e.audit_visibility is null)) and (v_include_history or (tc.visibility='work_log' and
        tc.carrier_state in ('ACTIVE_UNSTRUCTURED','ACTIVE_TYPED')))
      and e.payload::text ilike '%'||v_query||'%'
  ), ordered as (
    select row_data,source_order,sort_time,sort_id from matches order by source_order,sort_time desc,sort_id
    offset v_cursor limit v_limit+1
  ), sized as (
    select *,row_number() over(order by source_order,sort_time desc,sort_id) page_pos,
      sum(octet_length(row_data::text)) over(order by source_order,sort_time desc,sort_id rows unbounded preceding) running_bytes
    from ordered
  ), selected as (
    select * from sized where page_pos<=v_limit and (page_pos=1 or running_bytes<=v_budget)
  )
  select coalesce(jsonb_agg(row_data order by source_order,sort_time desc,sort_id),'[]'::jsonb),count(*)::integer,
    (select count(*)::integer from ordered),coalesce(bool_or(page_pos=1 and running_bytes>v_budget),false)
    into v_results,v_count,v_candidate_count,v_oversize from selected;
  v_truncated:=v_candidate_count>v_count;
  v_next_cursor:=case when v_truncated then v_cursor+v_count else null end;
  update public.clued_continuity_sessions set last_seen_at=now() where id=v_session.id;
  return jsonb_build_object('status','ok','mode','lexical','context_key',v_context_key,'query',v_query,
    'results',v_results,'page',jsonb_build_object('cursor',v_cursor,'next_cursor',v_next_cursor,
      'limit',v_limit,'max_bytes',v_budget,'returned',v_count,'truncated',v_truncated,'oversize_first_item',v_oversize));
end $$;
