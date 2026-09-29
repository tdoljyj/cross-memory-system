-- MTPE Universal Intake & Auto-Priority M0.
--
-- Canonical Records remain the business authority.  This migration adds a
-- deterministic, rebuildable routing/priority projection keyed by the stable
-- Record id. Owner focus is changed only through the explicit MTPE Owner Pin
-- M1 mutation, so an Event + immutable Receipt remains the authority carrier;
-- the tables below never become a second editable work backlog.

create table if not exists clued_private.mtpe_intake_projection (
  user_id uuid not null references auth.users(id) on delete cascade,
  record_id uuid not null references public.clued_memories(id) on delete cascade,
  source_record_version bigint not null,
  canonical_scope text not null,
  project_id uuid,
  intake_kind text not null,
  owner_track text not null check (owner_track in
    ('ENGINEERING_PLATFORM','PRODUCT_EXPERIENCE','FOUNDATIONAL_RESEARCH','BUSINESS_GROWTH')),
  affected_tracks text[] not null default '{}',
  provenance jsonb not null,
  criticality text not null check (criticality in ('CRITICAL','HIGH','NORMAL','LOW')),
  algorithm_priority integer not null check (algorithm_priority between 0 and 100),
  priority_band text not null check (priority_band in ('CRITICAL','HIGH','NORMAL','LOW')),
  priority_eligibility text not null,
  executability text not null,
  hard_gate_blockers jsonb not null default '[]',
  dependency_blockers jsonb not null default '[]',
  lifecycle_status text not null,
  disposition text not null,
  candidate_status text not null,
  priority_inputs jsonb not null,
  input_digest text not null check (input_digest ~ '^[0-9a-f]{64}$'),
  computed_at timestamptz not null default now(),
  primary key (user_id,record_id)
);

create index if not exists mtpe_intake_candidate_idx
  on clued_private.mtpe_intake_projection(
    user_id,candidate_status,priority_eligibility,algorithm_priority desc,record_id);

create table if not exists clued_private.mtpe_owner_focus (
  user_id uuid primary key references auth.users(id) on delete cascade,
  record_id uuid not null references public.clued_memories(id) on delete cascade,
  source_record_version bigint not null,
  selected_at timestamptz not null default now(),
  source_receipt_id uuid,
  reason text,
  unique(user_id,record_id)
);

create or replace function clued_private.mtpe_text_array(p_value jsonb)
returns text[] language sql immutable set search_path='' as $$
  select coalesce(array_agg(distinct upper(btrim(value)) order by upper(btrim(value))),
    '{}'::text[])
  from jsonb_array_elements_text(case when jsonb_typeof(p_value)='array'
    then p_value else '[]'::jsonb end) item(value)
  where btrim(value)<>''
$$;

create or replace function clued_private.mtpe_json_array(p_value jsonb)
returns jsonb language sql immutable set search_path='' as $$
  select case when jsonb_typeof(p_value)='array' then p_value else '[]'::jsonb end
$$;

create or replace function clued_private.mtpe_int(p_value text,p_default integer,
  p_min integer,p_max integer)
returns integer language plpgsql immutable set search_path='' as $$
declare v integer;
begin
  begin v:=p_value::integer; exception when others then v:=p_default; end;
  return greatest(p_min,least(p_max,coalesce(v,p_default)));
end $$;

create or replace function clued_private.mtpe_bool(p_value text)
returns boolean language sql immutable set search_path='' as $$
  select lower(coalesce(btrim(p_value),'')) in ('true','1','yes','on')
$$;

create or replace function clued_private.mtpe_intake_kind(
  p_record_type text,p_type_fields jsonb
) returns text language plpgsql immutable set search_path='' as $$
declare v text:=upper(coalesce(nullif(p_type_fields->>'intake_kind',''),''));
  v_note text:=upper(coalesce(p_type_fields->>'note_kind',''));
  v_state text:=upper(coalesce(p_type_fields->>'state_kind',''));
begin
  if v<>'' then return v; end if;
  if p_record_type='task' then return 'TASK'; end if;
  if p_record_type='decision' and clued_private.mtpe_bool(p_type_fields->>'decision_follow_up')
    then return 'DECISION_FOLLOW_UP'; end if;
  if p_record_type='note' and v_note in ('PROPOSAL','BUG','DEFECT','BLOCKER','RISK',
    'INCIDENT','TECHNICAL_DEBT','LEGACY_RESIDUAL_SCOPE','RESEARCH_QUESTION',
    'PRODUCT_ISSUE','BRAND_ISSUE','COMMERCIAL_ISSUE','DECISION_FOLLOW_UP') then
    return v_note;
  end if;
  if p_record_type='state' and v_state in ('BLOCKER','RISK','INCIDENT','TECHNICAL_DEBT')
    then return v_state; end if;
  return 'NOT_ACTIONABLE';
exception when invalid_text_representation then
  return case when p_record_type='task' then 'TASK' else 'NOT_ACTIONABLE' end;
end $$;

create or replace function clued_private.mtpe_owner_track(
  p_kind text,p_type_fields jsonb
) returns text language plpgsql immutable set search_path='' as $$
declare v text:=upper(replace(replace(coalesce(p_type_fields->>'owner_track',''),'与','_'),' ','_'));
begin
  v:=case v
    when '工程_平台' then 'ENGINEERING_PLATFORM'
    when '工程与平台' then 'ENGINEERING_PLATFORM'
    when '产品_体验' then 'PRODUCT_EXPERIENCE'
    when '产品与体验' then 'PRODUCT_EXPERIENCE'
    when '基础研究' then 'FOUNDATIONAL_RESEARCH'
    when '商业_增长' then 'BUSINESS_GROWTH'
    when '商业与增长' then 'BUSINESS_GROWTH'
    else v end;
  if v in ('ENGINEERING_PLATFORM','PRODUCT_EXPERIENCE',
    'FOUNDATIONAL_RESEARCH','BUSINESS_GROWTH') then return v; end if;
  if p_kind='RESEARCH_QUESTION' then return 'FOUNDATIONAL_RESEARCH'; end if;
  if p_kind in ('PRODUCT_ISSUE','BRAND_ISSUE') then return 'PRODUCT_EXPERIENCE'; end if;
  if p_kind='COMMERCIAL_ISSUE' then return 'BUSINESS_GROWTH'; end if;
  return 'ENGINEERING_PLATFORM';
end $$;

create or replace function clued_private.mtpe_criticality(
  p_kind text,p_type_fields jsonb
) returns text language plpgsql immutable set search_path='' as $$
declare v text:=upper(coalesce(nullif(p_type_fields->>'criticality',''),
  nullif(p_type_fields->>'severity',''),''));
begin
  if v in ('CRITICAL','HIGH','NORMAL','LOW') then return v; end if;
  if p_kind in ('INCIDENT','BLOCKER') then return 'HIGH'; end if;
  if p_kind in ('BUG','DEFECT','RISK') then return 'NORMAL'; end if;
  return 'NORMAL';
end $$;

create or replace function clued_private.mtpe_sync_record(p_record_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare r public.clued_memories%rowtype; v_kind text; v_track text; v_criticality text;
  v_hard jsonb; v_deps jsonb; v_affected text[]; v_eligible text;
  v_executability text; v_disposition text; v_candidate text;
  v_raw_eligibility text; v_raw_executability text;
  v_score integer; v_inputs jsonb; v_digest text; v_base integer;
  v_risk integer; v_impact integer; v_unlock integer; v_time integer; v_cost integer;
  v_frontier integer; v_explicit integer;
begin
  select * into r from public.clued_memories where id=p_record_id;
  if not found or r.record_schema_version is null then return; end if;
  v_kind:=clued_private.mtpe_intake_kind(r.record_type,coalesce(r.type_fields,'{}'));
  if v_kind='NOT_ACTIONABLE' or upper(coalesce(r.type_fields->>'governance_profile',''))=
    'OUT_OF_GOVERNANCE_PROFILE' then
    delete from clued_private.mtpe_intake_projection
      where user_id=r.user_id and record_id=r.id;
    if r.lifecycle_status<>'active' then
      delete from clued_private.mtpe_owner_focus where user_id=r.user_id and record_id=r.id;
    end if;
    return;
  end if;
  v_track:=clued_private.mtpe_owner_track(v_kind,coalesce(r.type_fields,'{}'));
  v_criticality:=clued_private.mtpe_criticality(v_kind,coalesce(r.type_fields,'{}'));
  v_hard:=clued_private.mtpe_json_array(coalesce(r.type_fields->'hard_gate_blockers','[]'));
  v_deps:=clued_private.mtpe_json_array(coalesce(r.type_fields->'dependency_blockers','[]'));
  if r.type_fields ? 'hard_gate_blockers'
    and jsonb_typeof(r.type_fields->'hard_gate_blockers')<>'array' then
    v_hard:=v_hard||jsonb_build_array(jsonb_build_object(
      'code','INVALID_HARD_GATE_BLOCKERS','source','canonical_record'));
  end if;
  if r.type_fields ? 'dependency_blockers'
    and jsonb_typeof(r.type_fields->'dependency_blockers')<>'array' then
    v_hard:=v_hard||jsonb_build_array(jsonb_build_object(
      'code','INVALID_DEPENDENCY_BLOCKERS','source','canonical_record'));
  end if;
  if r.record_type='task' and r.type_fields->>'execution_bucket'='blocked'
    and jsonb_array_length(v_deps)=0 then
    v_deps:=jsonb_build_array(jsonb_build_object('code','EXECUTION_BUCKET_BLOCKED',
      'source','canonical_task'));
  end if;
  v_affected:=clued_private.mtpe_text_array(coalesce(r.type_fields->'affected_tracks','[]'));
  v_raw_eligibility:=upper(nullif(btrim(coalesce(
    r.type_fields->>'priority_eligibility','')),''));
  v_raw_executability:=upper(nullif(btrim(coalesce(
    r.type_fields->>'executability','')),''));
  if r.lifecycle_status<>'active' then v_eligible:='TERMINAL';
  elsif v_raw_eligibility is null then v_eligible:='ELIGIBLE';
  elsif v_raw_eligibility in ('ELIGIBLE','INELIGIBLE','DISABLED',
    'OUT_OF_GOVERNANCE_PROFILE','DEFERRED_WITH_TRIGGER') then
    v_eligible:=v_raw_eligibility;
  else
    v_eligible:='UNKNOWN_INVALID';
    v_hard:=v_hard||jsonb_build_array(jsonb_build_object(
      'code','INVALID_PRIORITY_ELIGIBILITY','value',v_raw_eligibility,
      'source','canonical_record'));
  end if;
  if r.lifecycle_status<>'active' then v_executability:='TERMINAL';
  elsif jsonb_array_length(v_hard)>0 then v_executability:='BLOCKED_HARD_GATE';
  elsif jsonb_array_length(v_deps)>0 then v_executability:='BLOCKED_DEPENDENCY';
  elsif v_raw_executability in ('READY','SCHEDULED','DEFERRED')
    then v_executability:=v_raw_executability;
  elsif v_raw_executability='BLOCKED_HARD_GATE' then
    v_executability:='BLOCKED_HARD_GATE';
    v_hard:=jsonb_build_array(jsonb_build_object(
      'code','EXPLICIT_HARD_GATE','source','canonical_record'));
  elsif v_raw_executability='BLOCKED_DEPENDENCY' then
    v_executability:='BLOCKED_DEPENDENCY';
    v_deps:=jsonb_build_array(jsonb_build_object(
      'code','EXPLICIT_DEPENDENCY_BLOCK','source','canonical_record'));
  elsif r.type_fields->>'execution_bucket'='later' and v_eligible='DEFERRED_WITH_TRIGGER'
    then v_executability:='DEFERRED';
  elsif v_raw_executability is null then v_executability:='READY';
  else
    v_executability:='BLOCKED_HARD_GATE';
    v_hard:=jsonb_build_array(jsonb_build_object(
      'code','INVALID_EXECUTABILITY','value',v_raw_executability,
      'source','canonical_record'));
  end if;
  v_base:=case v_criticality when 'CRITICAL' then 45 when 'HIGH' then 35
    when 'NORMAL' then 22 else 10 end;
  v_frontier:=case when clued_private.mtpe_bool(r.type_fields->>'current_frontier_blocking')
    then 22 else 0 end;
  v_unlock:=clued_private.mtpe_int(r.type_fields->>'downstream_unlock_value',0,0,15);
  v_risk:=least(18,
    (case when clued_private.mtpe_bool(r.type_fields->>'authority_risk') then 4 else 0 end)+
    (case when clued_private.mtpe_bool(r.type_fields->>'data_risk') then 4 else 0 end)+
    (case when clued_private.mtpe_bool(r.type_fields->>'currentness_risk') then 4 else 0 end)+
    (case when clued_private.mtpe_bool(r.type_fields->>'security_risk') then 6 else 0 end));
  v_impact:=clued_private.mtpe_int(r.type_fields->>'user_product_impact',0,0,15);
  v_time:=clued_private.mtpe_int(r.type_fields->>'time_sensitivity',0,0,10);
  v_cost:=clued_private.mtpe_int(r.type_fields->>'resource_cost',0,0,10);
  v_explicit:=least(15,greatest(0,clued_private.mtpe_int(
    r.type_fields->>'priority',coalesce(r.priority,0),0,100)/7));
  v_score:=greatest(0,least(100,v_base+v_frontier+v_unlock+v_risk+v_impact+v_time+
    v_explicit-v_cost));
  v_disposition:=case when r.lifecycle_status='active' then 'ACTIVE'
    else upper(r.lifecycle_status) end;
  v_candidate:=case
    when r.lifecycle_status<>'active' then 'TERMINAL'
    when v_eligible in ('INELIGIBLE','DISABLED','OUT_OF_GOVERNANCE_PROFILE') then 'EXCLUDED'
    when v_executability='READY' then 'ACTIVE_READY'
    when v_executability='SCHEDULED' then 'SCHEDULED'
    when v_executability='DEFERRED' or v_eligible='DEFERRED_WITH_TRIGGER'
      then 'DEFERRED_WITH_TRIGGER'
    else 'ACTIVE_BLOCKED' end;
  v_inputs:=jsonb_build_object('rule_set','mtpe-universal-intake.v1',
    'criticality',v_criticality,'criticality_weight',v_base,
    'current_frontier_blocking',v_frontier,'downstream_unlock_value',v_unlock,
    'authority_data_currentness_security_risk',v_risk,
    'user_product_impact',v_impact,'time_sensitivity',v_time,
    'resource_cost',v_cost,'explicit_priority_signal',v_explicit,
    'executability',v_executability,'priority_eligibility',v_eligible);
  v_digest:=clued_private.currentness_hash(jsonb_build_object('record_id',r.id,
    'record_version',r.version,'content_hash',r.content_hash,'inputs',v_inputs,
    'owner_track',v_track,'affected_tracks',to_jsonb(v_affected),'kind',v_kind,
    'lifecycle_status',r.lifecycle_status));
  insert into clued_private.mtpe_intake_projection(user_id,record_id,
    source_record_version,canonical_scope,project_id,intake_kind,owner_track,
    affected_tracks,provenance,criticality,algorithm_priority,priority_band,
    priority_eligibility,executability,hard_gate_blockers,dependency_blockers,
    lifecycle_status,disposition,candidate_status,priority_inputs,input_digest,computed_at)
  values(r.user_id,r.id,r.version,r.canonical_scope,r.project_id,v_kind,v_track,
    v_affected,jsonb_build_object('record_id',r.id,'scope',r.canonical_scope,
      'record_type',r.record_type,'authority',r.authority,'source_refs',to_jsonb(r.source_refs),
      'record_version',r.version),v_criticality,v_score,
    case when v_score>=85 then 'CRITICAL' when v_score>=65 then 'HIGH'
      when v_score>=35 then 'NORMAL' else 'LOW' end,
    v_eligible,v_executability,v_hard,v_deps,r.lifecycle_status,v_disposition,
    v_candidate,v_inputs,v_digest,now())
  on conflict(user_id,record_id) do update set
    source_record_version=excluded.source_record_version,
    canonical_scope=excluded.canonical_scope,project_id=excluded.project_id,
    intake_kind=excluded.intake_kind,owner_track=excluded.owner_track,
    affected_tracks=excluded.affected_tracks,provenance=excluded.provenance,
    criticality=excluded.criticality,algorithm_priority=excluded.algorithm_priority,
    priority_band=excluded.priority_band,priority_eligibility=excluded.priority_eligibility,
    executability=excluded.executability,hard_gate_blockers=excluded.hard_gate_blockers,
    dependency_blockers=excluded.dependency_blockers,
    lifecycle_status=excluded.lifecycle_status,disposition=excluded.disposition,
    candidate_status=excluded.candidate_status,priority_inputs=excluded.priority_inputs,
    input_digest=excluded.input_digest,computed_at=excluded.computed_at;

  if r.lifecycle_status<>'active' then
    delete from clued_private.mtpe_owner_focus where user_id=r.user_id and record_id=r.id;
  end if;
end $$;

create or replace function clued_private.mtpe_record_trigger()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform clued_private.mtpe_sync_record(new.id);
  return new;
end $$;

drop trigger if exists clued_mtpe_intake_sync on public.clued_memories;
create trigger clued_mtpe_intake_sync after insert or update of title,content,
  record_type,lifecycle_status,canonical_scope,type_fields,relations,source_refs,
  authority,receipt_id,content_hash,version on public.clued_memories
  for each row execute function clued_private.mtpe_record_trigger();

do $$ declare r record; begin
  for r in select id from public.clued_memories where record_schema_version=1 loop
    perform clued_private.mtpe_sync_record(r.id);
  end loop;
end $$;

create or replace function clued_private.mtpe_snapshot(p_user_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  with source_candidates as (
    select p.*,m.title,m.updated_at,
      (f.record_id=p.record_id) as owner_selected,
      clued_private.record_currentness_fence(
        p.user_id,p.record_id,null::text[]) as record_currentness
    from clued_private.mtpe_intake_projection p
    join public.clued_memories m on m.id=p.record_id and m.user_id=p.user_id
    left join clued_private.mtpe_owner_focus f on f.user_id=p.user_id
    where p.user_id=p_user_id and p.candidate_status<>'TERMINAL'
      and p.priority_eligibility not in ('INELIGIBLE','DISABLED','OUT_OF_GOVERNANCE_PROFILE')
  ), candidates as (
    select s.*,
      case when s.record_currentness='CURRENT' then s.executability
        else 'BLOCKED_HARD_GATE' end as effective_executability,
      case when s.record_currentness='CURRENT' then s.hard_gate_blockers
        else s.hard_gate_blockers||jsonb_build_array(jsonb_build_object(
          'code','RECORD_CURRENTNESS_'||s.record_currentness,
          'source','record_currentness_fence')) end as effective_hard_gate_blockers
    from source_candidates s
  ), system_priority as (
    select * from candidates order by algorithm_priority desc,source_record_version desc,record_id limit 1
  ), system_frontier as (
    -- The Candidate Universe and system priority include every governed work
    -- object. The executable Context v2 Frontier is deliberately Task-only,
    -- because its exact source binding is a Canonical Task contract.
    select * from candidates where intake_kind='TASK' and effective_executability='READY'
      order by algorithm_priority desc,source_record_version desc,record_id limit 1
  ), owner_focus as (
    select * from candidates where owner_selected and intake_kind='TASK'
      order by record_id limit 1
  ), selected as (
    select * from owner_focus union all
    select * from system_frontier where not exists(select 1 from owner_focus) limit 1
  ), universe as (
    select coalesce(jsonb_agg(jsonb_build_object('record_id',record_id,
      'record_version',source_record_version,'scope',canonical_scope,'intake_kind',intake_kind,
      'owner_track',owner_track,'affected_tracks',affected_tracks,
      'criticality',criticality,'algorithm_priority',algorithm_priority,
      'priority_band',priority_band,'priority_eligibility',priority_eligibility,
      'executability',effective_executability,'record_currentness',record_currentness,
      'candidate_status',case when record_currentness='CURRENT' then candidate_status
        else 'ACTIVE_BLOCKED' end,
      'input_digest',input_digest) order by record_id),'[]'::jsonb) value
    from candidates
  )
  select jsonb_build_object('status','ok','rule_set','mtpe-universal-intake.v1',
    'candidate_universe',universe.value,
    'candidate_universe_digest',clued_private.currentness_hash(universe.value),
    'system_recommended_priority',(select jsonb_build_object('record_id',record_id,
      'record_version',source_record_version,'algorithm_priority',algorithm_priority,
      'priority_band',priority_band,'executability',effective_executability,
      'record_currentness',record_currentness) from system_priority),
    'system_recommended_frontier',(select jsonb_build_object('record_id',record_id,
      'record_version',source_record_version,'algorithm_priority',algorithm_priority,
      'priority_band',priority_band,'executability',effective_executability,
      'record_currentness',record_currentness) from system_frontier),
    'owner_selected_current_focus',(select jsonb_build_object('record_id',record_id,
      'record_version',source_record_version,'algorithm_priority',algorithm_priority,
      'priority_band',priority_band,'executability',effective_executability,
      'record_currentness',record_currentness,
      'status',case when effective_executability='READY' then 'OWNER_SELECTED_READY'
        else 'OWNER_SELECTED_BLOCKED' end,
      'hard_gate_blockers',effective_hard_gate_blockers,
      'dependency_blockers',dependency_blockers) from owner_focus),
    'selected_frontier',(select jsonb_build_object('record_id',record_id,
      'record_version',source_record_version,'algorithm_priority',algorithm_priority,
      'priority_band',priority_band,'executability',effective_executability,
      'record_currentness',record_currentness,
      'selection_source',case when owner_selected then 'OWNER_PIN' else 'SYSTEM_RECOMMENDED' end)
      from selected)) from universe
$$;

create or replace function clued_private.mtpe_validation(p_user_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  with actionable as (
    select m.*,clued_private.mtpe_intake_kind(m.record_type,coalesce(m.type_fields,'{}')) kind
    from public.clued_memories m where m.user_id=p_user_id and m.record_schema_version=1
      and upper(coalesce(m.type_fields->>'governance_profile',''))<>'OUT_OF_GOVERNANCE_PROFILE'
  ), governed as (
    select * from actionable where kind<>'NOT_ACTIONABLE'
  ), active_actionable as (
    select * from governed where lifecycle_status='active'
  ), missing_route as (
    select a.id from governed a left join clued_private.mtpe_intake_projection p
      on p.user_id=a.user_id and p.record_id=a.id
    where p.record_id is null or p.owner_track is null or p.intake_kind<>a.kind
  ), missing_priority as (
    select a.id from governed a left join clued_private.mtpe_intake_projection p
      on p.user_id=a.user_id and p.record_id=a.id
    where p.record_id is null or p.algorithm_priority is null
      or p.priority_eligibility is null or p.executability is null
      or p.priority_eligibility not in ('ELIGIBLE','INELIGIBLE','DISABLED',
        'OUT_OF_GOVERNANCE_PROFILE','DEFERRED_WITH_TRIGGER','TERMINAL')
      or p.executability not in ('READY','BLOCKED_HARD_GATE','BLOCKED_DEPENDENCY',
        'SCHEDULED','DEFERRED','TERMINAL')
  ), stale_projection as (
    select a.id from governed a join clued_private.mtpe_intake_projection p
      on p.user_id=a.user_id and p.record_id=a.id
    where p.source_record_version<>a.version
  ), invalid_terminal as (
    select a.id from governed a where
      (a.lifecycle_status='superseded' and not exists(
        select 1 from public.clued_memories successor
        where successor.user_id=a.user_id and successor.id<>a.id and
          (successor.supersedes_id=a.id or exists(
            select 1 from jsonb_array_elements_text(case
              when jsonb_typeof(successor.relations->'supersedes')='array'
                then successor.relations->'supersedes' else '[]'::jsonb end) source(id)
            where source.id=a.id::text))))
      or (a.lifecycle_status='merged' and (a.merged_into_record_id is null or not exists(
        select 1 from public.clued_memories successor
        where successor.user_id=a.user_id and successor.id=a.merged_into_record_id
          and successor.id<>a.id)))
  )
  select jsonb_build_object('status',case when
      (select count(*) from missing_route)=0 and
      (select count(*) from missing_priority)=0 and
      (select count(*) from stale_projection)=0 and
      (select count(*) from invalid_terminal)=0 then 'pass' else 'fail' end,
    'registered',(select count(*) from active_actionable),
    'terminal',(select count(*) from governed where lifecycle_status<>'active'),
    'missing_route',(select count(*) from missing_route),
    'missing_route_ids',(select coalesce(jsonb_agg(id order by id),'[]') from missing_route),
    'missing_priority',(select count(*) from missing_priority),
    'missing_priority_ids',(select coalesce(jsonb_agg(id order by id),'[]') from missing_priority),
    'stale_projection',(select count(*) from stale_projection),
    'stale_projection_ids',(select coalesce(jsonb_agg(id order by id),'[]') from stale_projection),
    'invalid_terminal_successor_binding',(select count(*) from invalid_terminal),
    'invalid_terminal_ids',(select coalesce(jsonb_agg(id order by id),'[]') from invalid_terminal))
$$;

create or replace function public.clued_mcp_mtpe_snapshot(
  p_token_hash text,p_input jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings%rowtype;
begin
  b:=clued_private.resolve_binding(p_token_hash,'context:read','global');
  if not ('*'=any(b.context_keys)) then
    raise exception 'mtpe_complete_source_scope_required' using errcode='42501';
  end if;
  return clued_private.mtpe_snapshot(b.user_id);
end $$;

create or replace function public.clued_mcp_mtpe_validate(
  p_token_hash text,p_input jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings%rowtype;
begin
  b:=clued_private.resolve_binding(p_token_hash,'context:read','global');
  if not ('*'=any(b.context_keys)) then
    raise exception 'mtpe_complete_source_scope_required' using errcode='42501';
  end if;
  return clued_private.mtpe_validation(b.user_id);
end $$;

create or replace function public.clued_mcp_mtpe_owner_pin(
  p_token_hash text,p_input jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare pre public.clued_agent_bindings%rowtype; b public.clued_agent_bindings%rowtype;
  r public.clued_memories%rowtype; receipt public.clued_audit_receipts%rowtype;
  v_operation text:=lower(coalesce(p_input->>'operation',''));
  v_record_id uuid; v_base bigint; v_event_id text; v_error text; v_state text;
  v_refs jsonb; v_result jsonb; v_source jsonb;
begin
  begin v_record_id:=(p_input->>'record_id')::uuid;
    v_base:=(p_input->>'base_version')::bigint;
  exception when others then
    raise exception 'invalid_mtpe_owner_pin_target' using errcode='22023';
  end;
  select * into pre from public.clued_agent_bindings where token_hash=p_token_hash;
  if not found then raise exception 'binding_not_authorized' using errcode='42501'; end if;
  select * into r from public.clued_memories
    where id=v_record_id and user_id=pre.user_id and record_schema_version=1;
  if not found then raise exception 'record_not_found' using errcode='P0002'; end if;
  b:=clued_private.resolve_binding_action_v12(p_token_hash,'context:write',
    r.canonical_scope,'write');
  receipt:=clued_private.m1_begin_receipt(b.user_id,b.id,'mtpe_owner_pin',p_input,
    clued_private.m1_sha256(p_input));
  if receipt.status<>'pending' then
    return coalesce(receipt.canonical_result,clued_private.m1_result_envelope(receipt))
      ||jsonb_build_object('replayed',receipt.related_receipt_id is null);
  end if;
  v_refs:=jsonb_build_array(jsonb_build_object('role','primary','kind','record','id',r.id));
  begin
    if v_operation not in ('set','cancel') or v_base is null or v_base<=0
      or coalesce((p_input->>'user_confirmed')::boolean,false)=false then
      raise exception 'invalid_mtpe_owner_pin_request' using errcode='22023';
    end if;
    perform clued_private.currentness_user_lock(b.user_id);
    select * into r from public.clued_memories
      where id=v_record_id and user_id=b.user_id and record_schema_version=1 for update;
    if not found then raise exception 'record_not_found' using errcode='P0002'; end if;
    if r.version<>v_base then raise exception 'record_version_conflict' using errcode='40001'; end if;
    if r.record_type<>'task' or r.lifecycle_status<>'active' or not exists(select 1
      from clued_private.mtpe_intake_projection p
      where p.user_id=b.user_id and p.record_id=r.id and p.candidate_status<>'TERMINAL'
        and p.priority_eligibility not in ('INELIGIBLE','DISABLED','OUT_OF_GOVERNANCE_PROFILE'))
      then raise exception 'owner_pin_target_not_eligible' using errcode='22023'; end if;
    if v_operation='set' then
      insert into clued_private.mtpe_owner_focus(user_id,record_id,source_record_version,
        selected_at,source_receipt_id,reason)
      values(b.user_id,r.id,r.version,now(),receipt.id,nullif(btrim(p_input->>'reason'),''))
      on conflict(user_id) do update set record_id=excluded.record_id,
        source_record_version=excluded.source_record_version,selected_at=excluded.selected_at,
        source_receipt_id=excluded.source_receipt_id,reason=excluded.reason;
    else
      delete from clued_private.mtpe_owner_focus
        where user_id=b.user_id and record_id=r.id;
      if not found then raise exception 'owner_pin_not_current' using errcode='40001'; end if;
    end if;
    v_source:=jsonb_build_object('kind','owner_pin','id',r.id,'scope',r.canonical_scope,
      'record_version',r.version,'operation',v_operation);
    insert into clued_private.projection_invalidation_heads(user_id,target_scope,
      projection_key,invalidation_revision,latest_source_ref,stale_since)
    values(b.user_id,'global','global.priority_frontier',1,v_source,now()),
          (b.user_id,'global','global.__aggregate__',1,v_source,now())
    on conflict(user_id,target_scope,projection_key) do update set
      invalidation_revision=clued_private.projection_invalidation_heads.invalidation_revision+1,
      latest_source_ref=excluded.latest_source_ref,
      stale_since=coalesce(clued_private.projection_invalidation_heads.stale_since,now()),
      updated_at=now();
    v_event_id:=clued_private.m1_append_event_row(b.user_id,b.id,receipt.id,
      receipt.canonical_version,'extension:mtpe:owner_pin',v_refs,r.canonical_scope,null,
      jsonb_build_array('owner_pin_'||v_operation),p_input->>'idempotency_key',
      receipt.request_sha256,'success','work_log','{}','[]',null);
    v_result:=clued_private.m1_finish_receipt(receipt.id,'committed',v_refs,
      jsonb_build_object(r.id::text,r.version),jsonb_build_object(r.id::text,r.version),
      array[v_event_id],'{}',null);
    return v_result||jsonb_build_object('replayed',false,'supplemental',
      jsonb_build_object('owner_focus',clued_private.mtpe_snapshot(b.user_id)
        ->'owner_selected_current_focus'));
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    v_result:=clued_private.m1_finish_receipt(receipt.id,
      case when v_state in ('22023','40001','42501','P0002') then 'rejected' else 'failed' end,
      v_refs,jsonb_build_object(r.id::text,v_base),'{}','{}','{}',v_error);
    return v_result||jsonb_build_object('replayed',false);
  end;
end $$;

-- Context v2 originally treated `execution_bucket=now` as the only legal
-- Frontier source. Universal Intake replaces that hand-maintained selector
-- with a deterministic MTPE selection while retaining exact Task/version,
-- Currentness, rule digest, and candidate-universe binding.
create or replace function clued_private.frontier_task_source_v2(
  p_user_id uuid,p_fields jsonb
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t public.clued_memories%rowtype; source jsonb:=p_fields->'source_task';
  result jsonb:=jsonb_build_object('status','PROJECTION_REQUIRED','action',null,
    'source_refs','[]'::jsonb); action jsonb; v_mtpe jsonb; v_selected jsonb;
begin
  if jsonb_typeof(source) is distinct from 'object'
    or p_fields->>'render_rule_version' is distinct from 'task-body.v1'
    or p_fields->>'rule_set_digest' is distinct from clued_private.frontier_rule_digest_v2()
    then return result; end if;
  -- Existing CURRENT projections remain readable until the first automatic
  -- MTPE rebuild. They retain the former unique-now proof and cannot opt into
  -- Owner Pin or automatic arbitration without the new digest fields.
  if not (p_fields ? 'mtpe_rule_set') then
    select * into t from public.clued_memories where user_id=p_user_id
      and id::text=source->>'id' and version::text=source->>'version'
      and canonical_scope=source->>'scope' and record_type='task'
      and record_schema_version is not null and lifecycle_status='active'
      and type_fields->>'execution_bucket'='now';
    if not found or t.type_fields ? 'projection_key'
      or exists(select 1 from clued_private.projection_record_bindings where record_id=t.id)
      or clued_private.record_currentness_fence(p_user_id,t.id,null::text[])<>'CURRENT'
      or (select count(*) from public.clued_memories m where m.user_id=p_user_id
        and m.canonical_scope=t.canonical_scope and m.record_type='task'
        and m.lifecycle_status='active' and m.type_fields->>'execution_bucket'='now'
        and clued_private.record_currentness_fence(p_user_id,m.id,null::text[])='CURRENT')<>1
      then return result; end if;
    action:=jsonb_build_object('title',t.title,'content',t.content);
    if p_fields ? 'current_action' and p_fields->'current_action' is distinct from action
      then return result; end if;
    return jsonb_build_object('status','RESOLVED','action',action,
      'source_refs',jsonb_build_array(jsonb_build_object('kind','record','id',t.id,
        'version',t.version,'scope',t.canonical_scope)),
      'render_rule_version','task-body.v1','rule_set_digest',
        clued_private.frontier_rule_digest_v2());
  end if;
  if p_fields->>'mtpe_rule_set' is distinct from 'mtpe-universal-intake.v1'
    then return result; end if;
  v_mtpe:=clued_private.mtpe_snapshot(p_user_id);
  v_selected:=v_mtpe->'selected_frontier';
  if v_selected is null or v_selected='null'::jsonb
    or p_fields->>'mtpe_candidate_universe_digest' is distinct from
      v_mtpe->>'candidate_universe_digest'
    or source->>'id' is distinct from v_selected->>'record_id'
    or source->>'version' is distinct from v_selected->>'record_version'
    or p_fields->>'selection_source' is distinct from v_selected->>'selection_source'
    then return result; end if;
  select * into t from public.clued_memories where user_id=p_user_id
    and id::text=source->>'id' and version::text=source->>'version'
    and canonical_scope=source->>'scope' and record_type='task'
    and record_schema_version is not null and lifecycle_status='active';
  if not found or t.type_fields ? 'projection_key'
    or exists(select 1 from clued_private.projection_record_bindings where record_id=t.id)
    or clued_private.record_currentness_fence(p_user_id,t.id,null::text[])<>'CURRENT'
    then return result; end if;
  action:=jsonb_build_object('title',t.title,'content',t.content);
  if p_fields ? 'current_action' and p_fields->'current_action' is distinct from action
    then return result; end if;
  return jsonb_build_object('status','RESOLVED','action',action,
    'source_refs',jsonb_build_array(jsonb_build_object('kind','record','id',t.id,
      'version',t.version,'scope',t.canonical_scope)),
    'render_rule_version','task-body.v1','rule_set_digest',
      clued_private.frontier_rule_digest_v2(),
    'mtpe_rule_set','mtpe-universal-intake.v1',
    'mtpe_candidate_universe_digest',v_mtpe->>'candidate_universe_digest',
    'selection_source',v_selected->>'selection_source');
end $$;

-- Rebind the Frontier Builder to the deterministic MTPE snapshot. An Owner Pin
-- selects the focus even while blocked; absent a Pin, the highest-scored READY
-- candidate is used. Priority and executability remain separate in type_fields.
create or replace function clued_private.projection_refresh_frontier_apply(
  p_binding public.clued_agent_bindings,p_revision bigint
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_task public.clued_memories%rowtype; v_record_id uuid;
  v_record public.clued_memories%rowtype; v_receipt_id uuid;
  v_fields jsonb; v_content text; v_snapshot jsonb; v_digest text;
  v_generation bigint; v_source_refs jsonb; v_mtpe jsonb; v_selected jsonb;
begin
  v_mtpe:=clued_private.mtpe_snapshot(p_binding.user_id);
  v_selected:=v_mtpe->'selected_frontier';
  if v_selected is null or v_selected='null'::jsonb then
    raise exception 'frontier_candidate_not_available' using errcode='40001';
  end if;
  v_record_id:=(v_selected->>'record_id')::uuid;
  select * into v_task from public.clued_memories
    where id=v_record_id and user_id=p_binding.user_id for share;
  if not found or clued_private.record_currentness_fence(
    p_binding.user_id,v_task.id,null::text[])<>'CURRENT' then
    raise exception 'frontier_source_not_current' using errcode='40001';
  end if;
  v_fields:=jsonb_build_object('state_kind','current_frontier_projection',
    'projection_key','global.priority_frontier',
    'source_task',jsonb_build_object('id',v_task.id,'scope',v_task.canonical_scope,
      'version',v_task.version),'render_rule_version','task-body.v1',
    'rule_set_digest',clued_private.frontier_rule_digest_v2(),
    'mtpe_rule_set','mtpe-universal-intake.v1',
    'mtpe_candidate_universe_digest',v_mtpe->>'candidate_universe_digest',
    'selection_source',v_selected->>'selection_source',
    'system_recommended_priority',v_mtpe->'system_recommended_priority',
    'system_recommended_frontier',v_mtpe->'system_recommended_frontier',
    'owner_selected_current_focus',v_mtpe->'owner_selected_current_focus',
    'algorithm_priority',(v_selected->>'algorithm_priority')::integer,
    'priority_band',v_selected->>'priority_band',
    'executability',v_selected->>'executability');
  if clued_private.frontier_task_source_v2(p_binding.user_id,v_fields)->>'status'<>'RESOLVED'
    then raise exception 'frontier_source_contract_required' using errcode='40001'; end if;
  v_content:='当前 Global 执行焦点由 Canonical Task '||v_task.id::text||' v'||
    v_task.version::text||' 提供；选择来源='||(v_selected->>'selection_source')||
    '，Priority='||(v_selected->>'priority_band')||'/'||
    (v_selected->>'algorithm_priority')||'，Executability='||
    (v_selected->>'executability')||'。Priority、Owner 选择与可执行性彼此独立；排序或 Pin 不授予阶段开工、生产、部署、预算或采购权限。';
  select coalesce(h.record_id,b.record_id) into v_record_id from (select 1) singleton
  left join clued_private.projection_heads h on h.user_id=p_binding.user_id
    and h.target_scope='global' and h.projection_key='global.priority_frontier'
  left join lateral (select rb.record_id from clued_private.projection_record_bindings rb
    where rb.user_id=p_binding.user_id and rb.target_scope='global'
      and rb.projection_key='global.priority_frontier'
    order by rb.projection_generation desc,rb.record_id limit 1) b on true;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,
    object_type,object_id,version,metadata)
  values(p_binding.user_id,p_binding.id,'global','projection_refresh','projection',
    'global.priority_frontier',p_revision,jsonb_build_object(
      'receipt_kind','PROJECTION_REFRESH','projection_key','global.priority_frontier',
      'target_invalidation_revision',p_revision,'source_task_id',v_task.id,
      'source_task_version',v_task.version,'selection_source',v_selected->>'selection_source',
      'mtpe_candidate_universe_digest',v_mtpe->>'candidate_universe_digest'))
  returning id into v_receipt_id;
  if v_record_id is null then
    insert into public.clued_memories(user_id,title,content,scope,project_id,
      record_type,status,priority,version,record_schema_version,lifecycle_status,
      canonical_scope,type_fields,relations,source_refs,source_unavailable_reason,
      authority,observed_at,confidence,confidence_reason,receipt_id,content_hash)
    values(p_binding.user_id,'Global Priority Frontier — '||left(v_task.title,90),
      v_content,'global',null,'state','current',0,1,1,'active','global',v_fields,
      '{}'::jsonb,'{}'::uuid[],'Derived from the deterministic MTPE snapshot.',
      'observed',now(),1,'System projection from a complete current source-vector.',
      v_receipt_id,repeat('0',64)) returning * into v_record;
  else
    update public.clued_memories set title='Global Priority Frontier — '||left(v_task.title,90),
      content=v_content,scope='global',project_id=null,record_type='state',status='current',
      priority=0,record_schema_version=1,lifecycle_status='active',canonical_scope='global',
      type_fields=v_fields,relations='{}'::jsonb,source_refs='{}'::uuid[],
      source_unavailable_reason='Derived from the deterministic MTPE snapshot.',
      authority='observed',observed_at=now(),confidence=1,
      confidence_reason='System projection from a complete current source-vector.',
      receipt_id=v_receipt_id,updated_at=now(),version=version+1
    where id=v_record_id and user_id=p_binding.user_id and record_type='state'
    returning * into v_record;
    if not found then raise exception 'frontier_projection_record_missing' using errcode='40001'; end if;
  end if;
  update public.clued_memories set content_hash=clued_private.m1_record_content_hash(
    record_type,canonical_scope,lifecycle_status,title,content,type_fields,relations,
    source_refs,source_unavailable_reason,authority,observed_at,closed_at,confidence,
    confidence_reason) where id=v_record.id returning * into v_record;
  v_snapshot:=clued_private.projection_source_snapshot(p_binding.user_id);
  v_digest:=clued_private.currentness_hash(v_snapshot);
  v_source_refs:=jsonb_build_array(jsonb_build_object('kind','record','id',v_task.id,
    'scope',v_task.canonical_scope,'version',v_task.version));
  select coalesce(max(h.projection_generation),0)+1 into v_generation
    from clued_private.projection_heads h where h.user_id=p_binding.user_id
      and h.target_scope='global' and h.projection_key='global.priority_frontier';
  update clued_private.projection_invalidation_heads set
    resolved_through_revision=p_revision,stale_since=null,updated_at=now()
  where user_id=p_binding.user_id and target_scope='global'
    and projection_key='global.priority_frontier' and invalidation_revision=p_revision;
  if not found then raise exception 'projection_rebuild_cas_conflict' using errcode='40001'; end if;
  insert into clued_private.projection_heads(user_id,target_scope,projection_key,
    projection_generation,resolved_through_invalidation_revision,source_vector_digest,
    source_refs,record_id,projection_owner)
  values(p_binding.user_id,'global','global.priority_frontier',v_generation,p_revision,
    v_digest,v_source_refs,v_record.id,'system_projection_builder')
  on conflict(user_id,target_scope,projection_key) do update set
    projection_generation=excluded.projection_generation,
    resolved_through_invalidation_revision=excluded.resolved_through_invalidation_revision,
    source_vector_digest=excluded.source_vector_digest,source_refs=excluded.source_refs,
    record_id=excluded.record_id,projection_owner=excluded.projection_owner,generated_at=now();
  insert into clued_private.projection_record_bindings(record_id,user_id,target_scope,
    projection_key,projection_generation,source_vector_digest,source_refs,
    resolved_through_invalidation_revision,projection_owner)
  values(v_record.id,p_binding.user_id,'global','global.priority_frontier',v_generation,
    v_digest,v_source_refs,p_revision,'system_projection_builder')
  on conflict(record_id) do update set projection_generation=excluded.projection_generation,
    source_vector_digest=excluded.source_vector_digest,source_refs=excluded.source_refs,
    resolved_through_invalidation_revision=excluded.resolved_through_invalidation_revision,
    projection_owner=excluded.projection_owner;
  update public.clued_audit_receipts set metadata=metadata||jsonb_build_object(
    'record_id',v_record.id,'record_version',v_record.version,
    'source_vector_digest',v_digest,'projection_generation',v_generation)
  where id=v_receipt_id;
  return jsonb_build_object('status','rebuilt','projection_key','global.priority_frontier',
    'record_id',v_record.id,'record_version',v_record.version,
    'projection_generation',v_generation,'source_vector_digest',v_digest,
    'selection_source',v_selected->>'selection_source','receipt_id',v_receipt_id);
end $$;

-- Preserve the OAuth allowlist and add the read-only MTPE inspection tools.
create or replace function public.clued_oauth_call(
  p_tool text,p_input jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
  v_input jsonb:=coalesce(p_input,'{}'::jsonb);
begin
  v_binding:=clued_private.resolve_oauth_binding();
  case p_tool
    when 'clued_session_resume' then return public.clued_mcp_restore(v_binding.token_hash,v_input);
    when 'clued_append_event' then return public.clued_mcp_append_event(v_binding.token_hash,v_input);
    when 'clued_event_carrier_transition' then return public.clued_mcp_event_carrier_transition(v_binding.token_hash,v_input);
    when 'clued_session_reconcile' then return public.clued_mcp_session_reconcile(v_binding.token_hash,v_input);
    when 'clued_projection_rebuild' then return public.clued_mcp_projection_rebuild(v_binding.token_hash,v_input);
    when 'clued_full_global_reconcile' then return public.clued_mcp_full_global_reconcile(v_binding.token_hash,v_input);
    when 'clued_currentness_g6_gate' then return public.clued_mcp_currentness_g6_gate(v_binding.token_hash,v_input);
    when 'clued_session_checkpoint' then return public.clued_mcp_commit_checkpoint(v_binding.token_hash,v_input);
    when 'clued_search_context' then return public.clued_mcp_search_context(v_binding.token_hash,v_input);
    when 'clued_read_log' then return public.clued_mcp_read_log(v_binding.token_hash,v_input);
    when 'clued_import_log' then return public.clued_mcp_import_log(v_binding.token_hash,v_input);
    when 'clued_audit_receipts' then return public.clued_mcp_audit_receipts(v_binding.token_hash,v_input);
    when 'clued_project_list' then return public.clued_project_list(v_binding.token_hash,v_input);
    when 'clued_record_list' then return public.clued_record_list(v_binding.token_hash,v_input);
    when 'clued_record_mutate' then return public.clued_record_mutate(v_binding.token_hash,v_input);
    when 'clued_decision_supersede' then return public.clued_decision_supersede(v_binding.token_hash,v_input);
    when 'clued_evidence_ingest' then return public.clued_evidence_ingest(v_binding.token_hash,v_input);
    when 'clued_event_append' then return public.clued_event_append(v_binding.token_hash,v_input);
    when 'clued_project_mutate' then return public.clued_project_mutate(v_binding.token_hash,v_input);
    when 'clued_canonical_export' then return public.clued_canonical_export(v_binding.token_hash,v_input);
    when 'clued_mtpe_snapshot' then return public.clued_mcp_mtpe_snapshot(v_binding.token_hash,v_input);
    when 'clued_mtpe_validate' then return public.clued_mcp_mtpe_validate(v_binding.token_hash,v_input);
    when 'clued_mtpe_owner_pin' then return public.clued_mcp_mtpe_owner_pin(v_binding.token_hash,v_input);
    else raise exception 'unknown_oauth_tool' using errcode='22023';
  end case;
end $$;

revoke all on table clued_private.mtpe_intake_projection,
  clued_private.mtpe_owner_focus from public,anon,authenticated;
revoke all on function clued_private.mtpe_text_array(jsonb),
  clued_private.mtpe_json_array(jsonb),clued_private.mtpe_int(text,integer,integer,integer),
  clued_private.mtpe_bool(text),
  clued_private.mtpe_intake_kind(text,jsonb),clued_private.mtpe_owner_track(text,jsonb),
  clued_private.mtpe_criticality(text,jsonb),clued_private.mtpe_sync_record(uuid),
  clued_private.mtpe_record_trigger(),clued_private.mtpe_snapshot(uuid),
  clued_private.mtpe_validation(uuid),
  clued_private.frontier_task_source_v2(uuid,jsonb),
  clued_private.projection_refresh_frontier_apply(public.clued_agent_bindings,bigint)
  from public,anon,authenticated;
revoke all on function public.clued_mcp_mtpe_snapshot(text,jsonb),
  public.clued_mcp_mtpe_validate(text,jsonb),
  public.clued_mcp_mtpe_owner_pin(text,jsonb) from public,authenticated;
grant execute on function public.clued_mcp_mtpe_snapshot(text,jsonb),
  public.clued_mcp_mtpe_validate(text,jsonb),
  public.clued_mcp_mtpe_owner_pin(text,jsonb) to anon;
revoke all on function public.clued_oauth_call(text,jsonb) from public,anon;
grant execute on function public.clued_oauth_call(text,jsonb) to authenticated;

