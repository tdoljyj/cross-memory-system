-- Security closeout: a Builder granted one Global projection may recover only
-- that projection's expired leases. The base migration remains immutable.
create or replace function public.clued_mcp_projection_refresh_claim(
  p_token_hash text,p_input jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
  v_job clued_private.projection_refresh_jobs%rowtype;
  v_head clued_private.projection_invalidation_heads%rowtype;
  v_snapshot jsonb; v_digest text; v_lease uuid; v_wait timestamptz;
begin
  -- Resolve once with either approved key; row selection below rechecks the
  -- exact key grant before exposing a source vector.
  begin
    v_binding:=clued_private.projection_refresh_builder_binding(
      p_token_hash,'global.priority_frontier');
  exception when insufficient_privilege then
    v_binding:=clued_private.projection_refresh_builder_binding(
      p_token_hash,'global.__aggregate__');
  end;
  perform clued_private.currentness_user_lock(v_binding.user_id);

  -- A crashed Worker leaves a lease, never a false CURRENT result. Expiry is
  -- converted into a diagnostic retry and remains bounded by max_attempts.
  insert into clued_private.projection_refresh_attempts(
    user_id,target_scope,projection_key,target_invalidation_revision,
    attempt_number,lease_id,builder_binding_id,source_vector_digest,outcome,
    error_code,error_detail,started_at,finished_at)
  select j.user_id,j.target_scope,j.projection_key,
    coalesce(j.leased_invalidation_revision,j.target_invalidation_revision),
    j.attempt_count,j.lease_id,j.leased_by_binding_id,
    j.leased_source_vector_digest,'RETRYABLE_FAILURE','builder_lease_expired',
    jsonb_build_object('lease_expires_at',j.lease_expires_at),
    coalesce(j.leased_at,j.updated_at),pg_catalog.clock_timestamp()
  from clued_private.projection_refresh_jobs j
  where j.user_id=v_binding.user_id and j.target_scope='global'
    and j.status='running' and j.lease_expires_at<=pg_catalog.clock_timestamp()
    and clued_private.projection_builder_authorized(v_binding.id,v_binding.user_id,
      'global',j.projection_key)
  on conflict(user_id,target_scope,projection_key,lease_id) do update set
    outcome='RETRYABLE_FAILURE',error_code='builder_lease_expired',
    error_detail=excluded.error_detail,finished_at=excluded.finished_at;

  update clued_private.projection_refresh_jobs j set
    status=case when j.attempt_count>=j.max_attempts then 'failed'
      else 'retry_wait' end,
    next_attempt_at=case when j.attempt_count>=j.max_attempts
      then pg_catalog.clock_timestamp()
      else pg_catalog.clock_timestamp()+
        clued_private.projection_refresh_retry_delay(j.attempt_count) end,
    last_error_code='builder_lease_expired',
    last_error_detail=jsonb_build_object('lease_expires_at',j.lease_expires_at),
    lease_id=null,leased_by_binding_id=null,leased_invalidation_revision=null,
    leased_source_vector_digest=null,leased_at=null,lease_expires_at=null,
    updated_at=pg_catalog.clock_timestamp()
  where j.user_id=v_binding.user_id and j.target_scope='global'
    and j.status='running' and j.lease_expires_at<=pg_catalog.clock_timestamp()
    and clued_private.projection_builder_authorized(v_binding.id,v_binding.user_id,
      'global',j.projection_key);

  select j.* into v_job
  from clued_private.projection_refresh_jobs j
  where j.user_id=v_binding.user_id and j.target_scope='global'
    and j.status in ('queued','retry_wait')
    and j.next_attempt_at<=pg_catalog.clock_timestamp()
    and clued_private.projection_builder_authorized(v_binding.id,v_binding.user_id,
      'global',j.projection_key)
    and (j.projection_key<>'global.__aggregate__' or not exists(
      select 1 from clued_private.projection_invalidation_heads h
      where h.user_id=j.user_id and h.target_scope='global'
        and h.projection_key<>'global.__aggregate__'
        and h.invalidation_revision>h.resolved_through_revision))
  order by case j.projection_key when 'global.priority_frontier' then 0 else 1 end,
    j.next_attempt_at
  for update skip locked limit 1;

  if not found then
    select min(j.next_attempt_at) into v_wait
    from clued_private.projection_refresh_jobs j
    where j.user_id=v_binding.user_id and j.target_scope='global'
      and j.status in ('queued','retry_wait')
      and clued_private.projection_builder_authorized(v_binding.id,v_binding.user_id,
        'global',j.projection_key);
    return jsonb_build_object('status',case when v_wait is null then 'idle' else 'waiting' end,
      'next_attempt_at',v_wait,'retry_after_ms',case when v_wait is null then null
        else greatest(0,ceil(extract(epoch from
          (v_wait-pg_catalog.clock_timestamp()))*1000)::bigint) end);
  end if;

  v_binding:=clued_private.projection_refresh_builder_binding(
    p_token_hash,v_job.projection_key);
  select * into v_head from clued_private.projection_invalidation_heads h
    where h.user_id=v_job.user_id and h.target_scope='global'
      and h.projection_key=v_job.projection_key for update;
  if not found or v_head.invalidation_revision<=v_head.resolved_through_revision then
    update clued_private.projection_refresh_jobs set status='completed',
      target_invalidation_revision=coalesce(v_head.invalidation_revision,
        target_invalidation_revision),completed_at=pg_catalog.clock_timestamp(),
      updated_at=pg_catalog.clock_timestamp()
    where user_id=v_job.user_id and target_scope='global'
      and projection_key=v_job.projection_key;
    perform clued_private.projection_refresh_clear_lease(
      v_job.user_id,v_job.projection_key);
    return jsonb_build_object('status','superseded','projection_key',v_job.projection_key);
  end if;
  v_snapshot:=clued_private.projection_source_snapshot(v_binding.user_id);
  v_digest:=clued_private.currentness_hash(v_snapshot);
  v_lease:=extensions.gen_random_uuid();
  update clued_private.projection_refresh_jobs set
    target_invalidation_revision=v_head.invalidation_revision,status='running',
    attempt_count=attempt_count+1,lease_id=v_lease,
    leased_by_binding_id=v_binding.id,
    leased_invalidation_revision=v_head.invalidation_revision,
    leased_source_vector_digest=v_digest,leased_at=pg_catalog.clock_timestamp(),
    lease_expires_at=pg_catalog.clock_timestamp()+interval '30 seconds',
    last_error_code=null,last_error_detail='{}'::jsonb,
    updated_at=pg_catalog.clock_timestamp()
  where user_id=v_job.user_id and target_scope='global'
    and projection_key=v_job.projection_key returning * into v_job;
  insert into clued_private.projection_refresh_attempts(
    user_id,target_scope,projection_key,target_invalidation_revision,
    attempt_number,lease_id,builder_binding_id,source_vector_digest,outcome)
  values(v_job.user_id,'global',v_job.projection_key,
    v_head.invalidation_revision,v_job.attempt_count,v_lease,v_binding.id,v_digest,'RUNNING');
  return jsonb_build_object('status','claimed','lease_id',v_lease,
    'projection_key',v_job.projection_key,
    'expected_invalidation_revision',v_head.invalidation_revision,
    'expected_source_vector_digest',v_digest,'attempt',v_job.attempt_count,
    'lease_expires_at',v_job.lease_expires_at);
end $$;

notify pgrst,'reload schema';
