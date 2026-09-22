-- BUG-20260922-002 F2: inventory every raw direct material Event before enforcement.
-- This migration deliberately does not infer non-current status from checkpoint absorption.
create table clued_private.legacy_event_candidates (
  event_id bigint primary key references public.clued_context_events(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  raw_context_key text not null,
  canonical_scope text not null,
  event_type text not null,
  event_version bigint,
  source_receipt_id uuid references public.clued_audit_receipts(id),
  visibility text not null,
  dimensions text[] not null,
  occurred_at timestamptz not null,
  disposition text not null check (disposition in (
    'LEGACY_ACTIVE_TYPED','LEGACY_ACTIVE_UNSTRUCTURED','LEGACY_MATERIALIZED',
    'LEGACY_SUPERSEDED','LEGACY_RETRACTED','LEGACY_RESOLVED_CONTINUITY_ONLY',
    'LEGACY_UNBOUND')),
  disposition_evidence jsonb not null,
  inventory_batch_id uuid not null,
  inventoried_at timestamptz not null default now()
);
create index legacy_event_candidates_scope_idx on clued_private.legacy_event_candidates
  (user_id,canonical_scope,event_id);
alter table clued_private.legacy_event_candidates enable row level security;
revoke all on clued_private.legacy_event_candidates from public,anon,authenticated,service_role;

-- Preserve every concrete Project that an ambiguous pre-cutover alias could
-- mean. The sentinel remains the Event identity; this relation is an impact
-- boundary, never an authorization to expose the Event in another scope.
create table clued_private.legacy_event_project_impacts (
  event_id bigint not null references clued_private.legacy_event_candidates(event_id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  project_scope text not null,
  primary key(event_id,project_scope)
);
create index legacy_event_project_impacts_scope_idx on
  clued_private.legacy_event_project_impacts(user_id,project_scope,event_id);
alter table clued_private.legacy_event_project_impacts enable row level security;
revoke all on clued_private.legacy_event_project_impacts
  from public,anon,authenticated,service_role;

create or replace function clued_private.legacy_event_project_matches(
  p_user_id uuid,p_context_key text
) returns table(project_scope text) language sql stable security definer set search_path='' as $$
  select distinct 'project:'||r.effective_project_id::text
    from public.clued_project_resolution_v2 r
    join public.clued_projects p on p.id=r.source_project_id and p.user_id=r.user_id
   where r.user_id=p_user_id and r.effective_project_id is not null
     and p_context_key ~ '^project:.+$' and (
     lower('project:'||p.id::text)=lower(p_context_key) or
     lower('project:'||p.name)=lower(p_context_key) or
     lower('project:'||p.normalized_name)=lower(p_context_key) or
     exists (select 1 from pg_catalog.unnest(coalesce(p.aliases,'{}'::text[])) a
              where lower('project:'||a)=lower(p_context_key)))
$$;
revoke all on function clued_private.legacy_event_project_matches(uuid,text)
  from public,anon,authenticated,service_role;

create table clued_private.legacy_carrier_inventory_receipts (
  batch_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  raw_context_key text not null,
  source_baseline text not null,
  migration_schema_version text not null,
  candidate_count bigint not null,
  lower_event_id bigint,
  upper_event_id bigint,
  disposition_counts jsonb not null,
  unbound_impacts jsonb not null,
  inventory_sha256 text not null,
  scan_completed_revision bigint not null,
  append_cutover_revision bigint not null,
  generated_at timestamptz not null default now(),
  primary key (batch_id,user_id,raw_context_key),
  check (candidate_count >= 0 and scan_completed_revision >= 0)
);
alter table clued_private.legacy_carrier_inventory_receipts enable row level security;
revoke all on clued_private.legacy_carrier_inventory_receipts
  from public,anon,authenticated,service_role;

-- An alias is safe only if it resolves to exactly one owner project. Otherwise it
-- fails closed at global aggregate, never at an invented project identity.
create or replace function clued_private.legacy_event_scope(
  p_user_id uuid,p_context_key text
) returns text language plpgsql stable security definer set search_path='' as $$
begin
  if p_context_key='global' then return 'global'; end if;
  if p_context_key !~ '^project:.+$' then return null; end if;
  return clued_private.event_canonical_scope(p_user_id,p_context_key);
end $$;
revoke all on function clued_private.legacy_event_scope(uuid,text)
  from public,anon,authenticated,service_role;

-- The source scan is bounded by the largest original Event ID seen under this
-- transaction's table lock. New append traffic waits, then uses the core trigger.
do $$
declare v_batch uuid:=gen_random_uuid(); v_watermark bigint;
  v_source_baseline text;
begin
  lock table public.clued_context_events in share row exclusive mode;
  select coalesce(max(id),0) into v_watermark from public.clued_context_events;
  v_source_baseline:='BUG-20260922-002/v0.2.8/raw-direct-events-through-id:'||v_watermark::text;
  insert into clued_private.legacy_event_candidates (
    event_id,user_id,raw_context_key,canonical_scope,event_type,event_version,
    source_receipt_id,visibility,dimensions,occurred_at,disposition,
    disposition_evidence,inventory_batch_id)
  select e.id,e.user_id,e.context_key,
    coalesce(scope.canonical_scope,'legacy-unbound:'||e.id::text),
    e.event_type,e.version,r.id,
    case when e.audit_visibility='audit_only' then 'audit_only'
      when e.audit_visibility is null or e.audit_visibility='work_log' then 'work_log'
      else 'hidden' end,
    case when scope.canonical_scope is null
      then array['state','task','decision']::text[]
      else clued_private.event_currentness_dimensions(e.event_type) end,
    e.occurred_at,
    case when scope.canonical_scope is null or e.user_id is null or
      e.audit_visibility not in ('work_log','audit_only','hidden')
      or (e.event_type='retraction' and
        coalesce(e.payload->>'retracts_event_id','') !~ '^[1-9][0-9]*$')
      then 'LEGACY_UNBOUND'
      when existing.carrier_state='ACTIVE_TYPED' then 'LEGACY_ACTIVE_TYPED'
      when existing.carrier_state='MATERIALIZED_TO_RECORD' then 'LEGACY_MATERIALIZED'
      when existing.carrier_state='SUPERSEDED' then 'LEGACY_SUPERSEDED'
      when existing.carrier_state='RETRACTED' then 'LEGACY_RETRACTED'
      when existing.carrier_state='RESOLVED_CONTINUITY_ONLY' then 'LEGACY_RESOLVED_CONTINUITY_ONLY'
      when existing.carrier_state='LEGACY_UNBOUND' then 'LEGACY_UNBOUND'
      else 'LEGACY_ACTIVE_UNSTRUCTURED' end,
    jsonb_build_object('source','raw_direct_event','context_resolved',scope.canonical_scope is not null,
      'termination_proof','none','checkpoint_absorption_ignored',true),v_batch
  from public.clued_context_events e
  left join clued_private.event_truth_carriers existing on existing.event_id=e.id
  cross join lateral (select clued_private.legacy_event_scope(e.user_id,e.context_key)
    as canonical_scope) scope
  left join lateral (
    select ar.id from public.clued_audit_receipts ar
    where ar.user_id=e.user_id and ar.operation='append'
      and ar.object_type='event' and ar.object_id=e.id::text
    order by ar.created_at,ar.id limit 1
  ) r on true
  where e.id<=v_watermark and e.event_schema_version is null
    and e.canonical_event_type is null
    and e.event_type in ('decision','correction','action','failure','blocker','retraction');

  insert into clued_private.legacy_event_project_impacts(event_id,user_id,project_scope)
  select c.event_id,c.user_id,m.project_scope
    from clued_private.legacy_event_candidates c
    cross join lateral clued_private.legacy_event_project_matches(
      c.user_id,c.raw_context_key) m
   where c.inventory_batch_id=v_batch
     and c.canonical_scope like 'legacy-unbound:%';

  insert into clued_private.event_truth_carriers (
    event_id,user_id,canonical_scope,dimensions,visibility,source_kind,
    carrier_state,event_version)
  select c.event_id,c.user_id,c.canonical_scope,c.dimensions,c.visibility,
    'legacy',case when c.disposition='LEGACY_UNBOUND'
      then 'LEGACY_UNBOUND' else 'ACTIVE_UNSTRUCTURED' end,c.event_version
  from clued_private.legacy_event_candidates c where c.inventory_batch_id=v_batch
  on conflict (event_id) do nothing;

  -- Core may have seen direct append traffic before this inventory migration.
  -- Reconcile its raw context with the now verified scope; never revive a
  -- carrier that already has a valid terminal transition.
  update clued_private.event_truth_carriers t set
    canonical_scope=c.canonical_scope,dimensions=c.dimensions,
    carrier_state=case when c.disposition='LEGACY_UNBOUND'
      then 'LEGACY_UNBOUND' else t.carrier_state end,updated_at=now()
  from clued_private.legacy_event_candidates c
  where c.inventory_batch_id=v_batch and t.event_id=c.event_id
    and t.carrier_state in ('ACTIVE_UNSTRUCTURED','ACTIVE_TYPED','LEGACY_UNBOUND')
    and (t.canonical_scope is distinct from c.canonical_scope
      or t.dimensions is distinct from c.dimensions
      or (c.disposition='LEGACY_UNBOUND' and t.carrier_state<>'LEGACY_UNBOUND'));

  -- Unresolved project aliases are not global Canonical Record sources.
  -- Their work-log visibility may affect a Global aggregate, so invalidate
  -- that projection. The verified candidate mapping above fences each
  -- plausible Project, while unrelated Projects remain independent.
  insert into clued_private.projection_invalidation_heads (
    user_id,target_scope,projection_key,invalidation_revision,
    latest_source_ref,stale_since)
  select c.user_id,'global','global.__aggregate__',count(*),
    jsonb_build_object('kind','direct_event','id',max(c.event_id)::text,
      'scope','global','impact','unresolved_legacy_project_alias'),now()
  from clued_private.legacy_event_candidates c
  where c.inventory_batch_id=v_batch
    and c.canonical_scope like 'legacy-unbound:%'
    and c.visibility='work_log'
  group by c.user_id
  on conflict(user_id,target_scope,projection_key) do update set
    invalidation_revision=clued_private.projection_invalidation_heads.invalidation_revision+
      excluded.invalidation_revision,
    latest_source_ref=excluded.latest_source_ref,
    stale_since=coalesce(clued_private.projection_invalidation_heads.stale_since,now()),
    updated_at=now();

  insert into clued_private.legacy_carrier_inventory_receipts (
    batch_id,user_id,raw_context_key,source_baseline,migration_schema_version,
    candidate_count,lower_event_id,upper_event_id,disposition_counts,
    unbound_impacts,inventory_sha256,scan_completed_revision,append_cutover_revision)
  select v_batch,c.user_id,c.raw_context_key,v_source_baseline,
    '20260922092810',count(*),min(c.event_id),max(c.event_id),
    jsonb_object_agg(c.disposition,c.disposition_count),
    coalesce(jsonb_agg(distinct jsonb_build_object('scope',c.canonical_scope,
      'dimensions',c.dimensions,
      'aggregate_projection',case when c.canonical_scope like 'legacy-unbound:%'
        then 'global.__aggregate__' else null end,
      'candidate_project_scopes',coalesce((select jsonb_agg(i.project_scope order by i.project_scope)
        from clued_private.legacy_event_project_impacts i
        where i.event_id=c.event_id),'[]'::jsonb)))
      filter(where c.disposition='LEGACY_UNBOUND'),'[]'::jsonb),
    encode(extensions.digest(string_agg(jsonb_build_object(
      'event_id',c.event_id,'owner',c.user_id,'raw_context',c.raw_context_key,
      'canonical_scope',c.canonical_scope,'event_type',c.event_type,
      'event_version',c.event_version,'source_receipt',c.source_receipt_id,
      'visibility',c.visibility,'dimensions',c.dimensions,
      'occurred_at',c.occurred_at,'disposition',c.disposition,
      'candidate_project_scopes',coalesce((select jsonb_agg(i.project_scope order by i.project_scope)
        from clued_private.legacy_event_project_impacts i
        where i.event_id=c.event_id),'[]'::jsonb))::text,
      ',' order by c.event_id),'sha256'),'hex'),
    v_watermark,v_watermark
  from (
    select base.*,count(*) over(partition by user_id,raw_context_key,disposition) disposition_count
    from clued_private.legacy_event_candidates base where inventory_batch_id=v_batch
  ) c
  group by c.user_id,c.raw_context_key;

  if exists (
    select 1 from public.clued_context_events e
    where e.id<=v_watermark and e.event_schema_version is null
      and e.canonical_event_type is null
      and e.event_type in ('decision','correction','action','failure','blocker','retraction')
      and not exists(select 1 from clued_private.event_truth_carriers t where t.event_id=e.id)
  ) then raise exception 'legacy_candidate_inventory_incomplete' using errcode='23514'; end if;
end $$;

-- A transition may only be invoked by a privileged canonical mutation, after it
-- has created a receipt in the same transaction. CAS and source validation are
-- under the carrier row lock; failures roll back both receipt and mutation.
alter table clued_private.event_truth_carriers
  add column successor_event_id bigint references public.clued_context_events(id);
create or replace function clued_private.transition_event_carrier(
  p_event_id bigint,p_expected_transition_version bigint,p_to_state text,
  p_successor_event_id bigint,p_receipt_id uuid
) returns bigint language plpgsql security definer set search_path='' as $$
declare v_carrier clued_private.event_truth_carriers%rowtype;
  v_successor clued_private.event_truth_carriers%rowtype;
  v_receipt public.clued_audit_receipts%rowtype;
  v_relation text;
begin
  if p_to_state not in ('SUPERSEDED','RETRACTED','RESOLVED_CONTINUITY_ONLY')
     or p_expected_transition_version is null or p_receipt_id is null then
    raise exception 'invalid_carrier_transition' using errcode='22023';
  end if;
  select * into v_carrier from clued_private.event_truth_carriers
    where event_id=p_event_id for update;
  if not found or v_carrier.transition_version<>p_expected_transition_version
     or v_carrier.carrier_state not in
       ('ACTIVE_UNSTRUCTURED','ACTIVE_TYPED','LEGACY_UNBOUND') then
    raise exception 'carrier_transition_conflict' using errcode='40001';
  end if;
  select * into v_receipt from public.clued_audit_receipts where id=p_receipt_id;
  if not found or v_receipt.user_id<>v_carrier.user_id
    or v_receipt.object_type<>'event' or v_receipt.object_id<>p_event_id::text
    or v_receipt.operation<>'carrier_transition'
    or v_receipt.metadata->>'target_state'<>p_to_state
    or v_receipt.metadata->>'transaction_id'<>txid_current()::text
    or v_receipt.metadata->>'expected_transition_version'<>
      p_expected_transition_version::text then
    raise exception 'carrier_transition_receipt_invalid' using errcode='42501';
  end if;
  if p_to_state in ('SUPERSEDED','RETRACTED') then
    select * into v_successor from clued_private.event_truth_carriers
      where event_id=p_successor_event_id for update;
    if not found or v_successor.user_id<>v_carrier.user_id
      or v_successor.canonical_scope<>v_carrier.canonical_scope
      or v_successor.event_id<=v_carrier.event_id
      or v_successor.carrier_state not in ('ACTIVE_UNSTRUCTURED','ACTIVE_TYPED') then
      raise exception 'carrier_successor_invalid' using errcode='40001';
    end if;
    v_relation:=case when p_to_state='SUPERSEDED' then 'supersedes_event_id'
      else 'retracts_event_id' end;
    if not exists(select 1 from public.clued_context_events e
      where e.id=p_successor_event_id
        and (p_to_state<>'RETRACTED' or e.event_type='retraction')
        and e.payload->>v_relation=p_event_id::text) then
      raise exception 'carrier_successor_relation_missing' using errcode='40001';
    end if;
  else
    if p_successor_event_id is not null or
      v_receipt.metadata->>'continuity_only_proof'<>'verified' then
      raise exception 'continuity_only_proof_required' using errcode='42501';
    end if;
  end if;
  update clued_private.event_truth_carriers set carrier_state=p_to_state,
    successor_event_id=p_successor_event_id,
    transition_version=transition_version+1,transition_receipt_id=p_receipt_id,
    updated_at=now()
  where event_id=p_event_id and transition_version=p_expected_transition_version;
  if not found then raise exception 'carrier_transition_conflict' using errcode='40001'; end if;
  -- A hidden/audit-only source cannot change a lower-permission revision.
  -- Any authorized projection into that caller's truth is a separate mutation.
  if v_carrier.visibility='work_log' then
    perform clued_private.touch_currentness(v_carrier.user_id,v_carrier.canonical_scope,
      'event_carrier_transition',p_event_id::text,v_carrier.dimensions);
  end if;
  return p_expected_transition_version+1;
end $$;
revoke all on function clued_private.transition_event_carrier(bigint,bigint,text,bigint,uuid)
  from public,anon,authenticated,service_role;

-- The only Binding-facing transition entry. For replacement/retraction the
-- existing append RPC creates the successor Event and its active carrier, then
-- this call creates a transition receipt and switches the old carrier before
-- the SQL statement can commit. A failed CAS rolls back the append as well.
create or replace function public.clued_mcp_event_carrier_transition(
  p_token_hash text,p_input jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_scope text:=nullif(btrim(p_input->>'context_key'),'');
  v_binding public.clued_agent_bindings%rowtype;
  v_source clued_private.event_truth_carriers%rowtype;
  v_mode text:=p_input->>'transition'; v_target text;
  v_event_type text:=p_input->>'event_type'; v_relation text;
  v_event public.clued_context_events%rowtype;
  v_payload jsonb:=p_input->'payload'; v_append jsonb;
  v_receipt_id uuid; v_proof public.clued_audit_receipts%rowtype;
  v_expected bigint; v_source_id bigint; v_successor_id bigint;
  v_idempotency text:=nullif(btrim(p_input->>'idempotency_key'),'');
  v_request_hash text:=encode(extensions.digest(convert_to(p_input::text,'UTF8'),'sha256'),'hex');
  v_existing public.clued_audit_receipts%rowtype;
  v_version bigint;
begin
  if v_scope is null or v_mode not in ('supersede','retract','resolve')
    or v_idempotency is null or length(v_idempotency) not between 8 and 160
    or coalesce(p_input->>'source_event_id','') !~ '^[1-9][0-9]*$'
    or coalesce(p_input->>'expected_transition_version','') !~ '^[1-9][0-9]*$' then
    raise exception 'invalid_carrier_transition_input' using errcode='22023';
  end if;
  v_source_id:=(p_input->>'source_event_id')::bigint;
  v_expected:=(p_input->>'expected_transition_version')::bigint;
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',v_scope);
  select * into v_source from clued_private.event_truth_carriers
    where event_id=v_source_id and user_id=v_binding.user_id;
  if not found or v_source.canonical_scope<>v_scope
    or v_source.visibility<>'work_log'
    or v_source.carrier_state='LEGACY_UNBOUND'
    or not exists(select 1 from public.clued_context_events e
      where e.id=v_source_id and e.user_id=v_binding.user_id) then
    raise exception 'carrier_source_not_authorized' using errcode='42501';
  end if;
  select * into v_existing from public.clued_audit_receipts r
    where r.user_id=v_binding.user_id and r.binding_id=v_binding.id
      and r.operation_family='event_carrier_transition'
      and r.idempotency_key=v_idempotency and r.owns_idempotency_key;
  if found then
    if v_existing.received_payload_hash<>v_request_hash then
      raise exception 'carrier_transition_idempotency_conflict' using errcode='23505';
    end if;
    return jsonb_build_object('status','duplicate','receipt_id',v_existing.id,
      'source_event_id',v_source_id,
      'successor_event_id',v_existing.metadata->>'successor_event_id',
      'transition_version',v_existing.version);
  end if;
  v_target:=case v_mode when 'supersede' then 'SUPERSEDED'
    when 'retract' then 'RETRACTED' else 'RESOLVED_CONTINUITY_ONLY' end;
  if v_mode in ('supersede','retract') then
    if jsonb_typeof(v_payload)<>'object' then
      raise exception 'transition_payload_required' using errcode='22023';
    end if;
    if v_mode='retract' then
      v_event_type:='retraction'; v_relation:='retracts_event_id';
    else
      v_relation:='supersedes_event_id';
      if v_event_type not in ('decision','correction','action','failure','blocker') then
        raise exception 'invalid_successor_event_type' using errcode='22023';
      end if;
    end if;
    if v_payload ? v_relation and v_payload->>v_relation<>v_source_id::text then
      raise exception 'successor_relation_conflict' using errcode='22023';
    end if;
    v_payload:=v_payload||jsonb_build_object(v_relation,v_source_id::text);
    v_append:=public.clued_mcp_append_event(p_token_hash,
      p_input||jsonb_build_object('context_key',v_scope,'event_type',v_event_type,
        'payload',v_payload));
    if v_append->>'status'='conflict' then return v_append; end if;
    if v_append->>'status'<>'appended' then
      raise exception 'successor_event_append_conflict' using errcode='40001';
    end if;
    v_successor_id:=(v_append->>'event_id')::bigint;
    select * into v_event from public.clued_context_events
      where id=v_successor_id and user_id=v_binding.user_id;
    if not found or v_event.context_key<>v_scope then
      raise exception 'successor_event_not_owned' using errcode='40001';
    end if;
  else
    if p_input ? 'payload' or p_input ? 'event_type' then
      raise exception 'resolve_has_no_successor_event' using errcode='22023';
    end if;
    select * into v_proof from public.clued_audit_receipts r
      where r.id=(p_input->>'proof_receipt_id')::uuid
        and r.user_id=v_binding.user_id and r.object_type='event'
        and r.object_id=v_source_id::text
        and r.operation='continuity_only_resolution_authorized'
        and r.metadata->>'proof'='verified'
        and r.version=v_expected and r.created_at>=v_source.updated_at;
    if not found then
      raise exception 'continuity_only_proof_required' using errcode='42501';
    end if;
  end if;
  insert into public.clued_audit_receipts (
    user_id,binding_id,context_key,operation,operation_family,object_type,
    object_id,version,metadata,idempotency_key,owns_idempotency_key,
    received_payload_hash,related_receipt_id)
  values (v_binding.user_id,v_binding.id,v_scope,'carrier_transition',
    'event_carrier_transition','event',v_source_id::text,v_expected+1,
    jsonb_build_object('target_state',v_target,
      'expected_transition_version',v_expected::text,
      'transaction_id',txid_current()::text,
      'successor_event_id',v_successor_id,
      'continuity_only_proof',case when v_mode='resolve' then 'verified' else null end),
    v_idempotency,true,v_request_hash,
    case when v_mode='resolve' then v_proof.id else (v_append->>'receipt_id')::uuid end)
  returning id into v_receipt_id;
  v_version:=clued_private.transition_event_carrier(v_source_id,v_expected,v_target,
    v_successor_id,v_receipt_id);
  return jsonb_build_object('status','transitioned','source_event_id',v_source_id,
    'successor_event_id',v_successor_id,'transition_version',v_version,
    'receipt_id',v_receipt_id);
end $$;
revoke all on function public.clued_mcp_event_carrier_transition(text,jsonb) from public;
grant execute on function public.clued_mcp_event_carrier_transition(text,jsonb) to anon;

-- Preserve the exact OAuth tool allowlist while adding the new transition.
-- resolve_oauth_binding remains the authority gate (and currently rejects the
-- retired legacy OAuth route); this mapping cannot resurrect that route.
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
    when 'clued_event_carrier_transition' then
      return public.clued_mcp_event_carrier_transition(v_binding.token_hash,v_input);
    when 'clued_session_reconcile' then
      return public.clued_mcp_session_reconcile(v_binding.token_hash,v_input);
    when 'clued_projection_rebuild' then
      return public.clued_mcp_projection_rebuild(v_binding.token_hash,v_input);
    when 'clued_full_global_reconcile' then
      return public.clued_mcp_full_global_reconcile(v_binding.token_hash,v_input);
    when 'clued_currentness_g6_gate' then
      return public.clued_mcp_currentness_g6_gate(v_binding.token_hash,v_input);
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
    else raise exception 'unknown_oauth_tool' using errcode='22023';
  end case;
end $$;
revoke all on function public.clued_oauth_call(text,jsonb) from public,anon;
grant execute on function public.clued_oauth_call(text,jsonb) to authenticated;
