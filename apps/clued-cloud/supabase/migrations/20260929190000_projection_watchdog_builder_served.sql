-- Mark which tenants the running projection Builder serves in the watchdog snapshot.
--
-- The production release gate required exactly one watchdog row per Global
-- projection key, so it failed as soon as a second account had projection heads.
-- The Information Flow production E2E account first wrote on 2026-09-29; it has
-- no Builder grant, so its projections stay queued and every release was blocked.
--
-- Each snapshot row now carries builder_served: whether the Builder binding named
-- by the refresh heartbeat holds an active grant for that tenant, scope and key
-- (clued_private.projection_builder_authorized, the same check the Builder lease
-- uses). The gate requires every served row to be current and reports the rest.
-- Nothing else in the snapshot changes; grants, heads and jobs are untouched.

create or replace function clued_watchdog.projection_watchdog_snapshot()
returns jsonb language sql stable security definer set search_path='' as $$
  with rows as (
    select encode(extensions.digest(h.user_id::text,'sha256'),'hex') as tenant_key,
      coalesce(clued_private.projection_builder_authorized(
        (select b.builder_binding_id from clued_private.projection_refresh_heartbeat b where b.id),
        h.user_id,h.target_scope,h.projection_key),false) as builder_served,
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
      'tenant_key',r.tenant_key,'builder_served',r.builder_served,
      'projection_key',r.projection_key,
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
