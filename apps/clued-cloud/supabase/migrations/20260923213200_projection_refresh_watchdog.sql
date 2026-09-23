-- Operational monitoring for the two approved Global projections only.
-- A separate NOLOGIN role can read bounded status, never Canonical bodies,
-- Builder leases, or the underlying private tables.

do $$
begin
  if not exists(select 1 from pg_catalog.pg_roles where rolname='clued_projection_watchdog') then
    create role clued_projection_watchdog nologin;
  end if;
end $$;

create schema clued_watchdog;
revoke all on schema clued_watchdog from public,anon,authenticated,service_role;

create table clued_private.projection_refresh_heartbeat (
  id boolean primary key default true check (id),
  run_id uuid not null,
  builder_binding_id uuid references public.clued_agent_bindings(id) on delete set null,
  last_started_at timestamptz not null,
  last_finished_at timestamptz,
  last_result text not null check (last_result in (
    'running','idle','waiting','cycle_limit','transport_unavailable',
    'builder_protocol_error','not_configured','exception'))
);
alter table clued_private.projection_refresh_heartbeat enable row level security;
revoke all on clued_private.projection_refresh_heartbeat
  from public,anon,authenticated,service_role;

create function public.clued_mcp_projection_refresh_heartbeat(
  p_token_hash text,p_input jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_builder public.clued_agent_bindings%rowtype;
  v_run_id uuid; v_phase text; v_result text;
begin
  if jsonb_typeof(p_input)<>'object' or
     coalesce(p_input->>'run_id','') !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or
     coalesce(p_input->>'phase','') not in ('start','finish') or
     (p_input->>'phase'='finish' and coalesce(p_input->>'result','') not in
       ('idle','waiting','cycle_limit','transport_unavailable',
        'builder_protocol_error','not_configured','exception')) then
    raise exception 'invalid_projection_heartbeat' using errcode='22023';
  end if;
  v_run_id:=(p_input->>'run_id')::uuid;
  v_phase:=p_input->>'phase';
  v_builder:=clued_private.projection_refresh_builder_binding(
    p_token_hash,'global.priority_frontier');
  if not clued_private.projection_builder_authorized(
      v_builder.id,v_builder.user_id,'global','global.__aggregate__') then
    raise exception 'projection_builder_not_authorized' using errcode='42501';
  end if;
  if v_phase='start' then
    insert into clued_private.projection_refresh_heartbeat(
      id,run_id,builder_binding_id,last_started_at,last_result)
    values(true,v_run_id,v_builder.id,pg_catalog.clock_timestamp(),'running')
    on conflict(id) do update set
      run_id=excluded.run_id,builder_binding_id=excluded.builder_binding_id,
      last_started_at=excluded.last_started_at,last_result='running';
    return jsonb_build_object('status','recorded');
  end if;
  v_result:=p_input->>'result';
  update clued_private.projection_refresh_heartbeat set
    last_finished_at=pg_catalog.clock_timestamp(),last_result=v_result
  where id and run_id=v_run_id and builder_binding_id=v_builder.id;
  return jsonb_build_object('status',case when found then 'recorded' else 'superseded' end);
end $$;
revoke all on function public.clued_mcp_projection_refresh_heartbeat(text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.clued_mcp_projection_refresh_heartbeat(text,jsonb)
  to anon;

create function clued_watchdog.projection_watchdog_snapshot()
returns jsonb language sql stable security definer set search_path='' as $$
  with rows as (
    select encode(extensions.digest(h.user_id::text,'sha256'),'hex') as tenant_key,
      h.projection_key,h.invalidation_revision,h.resolved_through_revision,
      h.stale_since,j.status as job_status,j.attempt_count,j.max_attempts,
      j.updated_at as job_updated_at,
      case when h.projection_key='global.priority_frontier'
        then p.source_vector_digest else receipt.source_vector_digest end
        as stored_source_digest,
      case when h.invalidation_revision=h.resolved_through_revision
        then clued_private.currentness_hash(
          clued_private.projection_source_snapshot(h.user_id))
        else null end as live_source_digest
    from clued_private.projection_invalidation_heads h
    left join clued_private.projection_refresh_jobs j
      on j.user_id=h.user_id and j.target_scope=h.target_scope
      and j.projection_key=h.projection_key
    left join clued_private.projection_heads p
      on p.user_id=h.user_id and p.target_scope=h.target_scope
      and p.projection_key=h.projection_key
    left join lateral (
      select r.metadata->>'source_vector_digest' as source_vector_digest
      from public.clued_audit_receipts r
      where r.user_id=h.user_id and r.context_key='global'
        and r.operation='projection_refresh'
        and r.object_id='global.__aggregate__'
        and r.version=h.resolved_through_revision
      order by r.created_at desc,r.id desc limit 1
    ) receipt on h.projection_key='global.__aggregate__'
    where h.target_scope='global' and h.projection_key in
      ('global.priority_frontier','global.__aggregate__')
  )
  select jsonb_build_object(
    'observed_at',pg_catalog.clock_timestamp(),
    'heartbeat',(select jsonb_build_object(
      'last_started_at',b.last_started_at,'last_finished_at',b.last_finished_at,
      'last_result',b.last_result)
      from clued_private.projection_refresh_heartbeat b where b.id),
    'projections',coalesce((select jsonb_agg(jsonb_build_object(
      'tenant_key',r.tenant_key,'projection_key',r.projection_key,
      'invalidation_revision',r.invalidation_revision,
      'resolved_through_revision',r.resolved_through_revision,
      'stale_since',r.stale_since,'job_status',r.job_status,
      'attempt_count',r.attempt_count,'max_attempts',r.max_attempts,
      'job_updated_at',r.job_updated_at,
      'source_digest_status',case
        when r.invalidation_revision<>r.resolved_through_revision then 'not_applicable'
        when r.stored_source_digest is null then 'unavailable'
        when r.stored_source_digest=r.live_source_digest then 'match'
        else 'mismatch' end)
      order by r.tenant_key,r.projection_key) from rows r),'[]'::jsonb))
$$;
revoke all on function clued_watchdog.projection_watchdog_snapshot()
  from public,anon,authenticated,service_role;
grant usage on schema clued_watchdog to clued_projection_watchdog;
grant execute on function clued_watchdog.projection_watchdog_snapshot()
  to clued_projection_watchdog;
