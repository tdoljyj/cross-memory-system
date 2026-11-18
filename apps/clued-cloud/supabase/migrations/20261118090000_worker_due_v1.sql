-- Scheduled fallback reads the work queues at one observation time. The private SQL
-- predicates inline into the caller so PostgreSQL can use the sparse queue indexes.
-- The gateway returns only flags. Each sweep still owns its issuer/tenant checks,
-- row locks, rechecks, ordering, lease transitions and batch limits.
create function clued_private.worker_projection_ready_v1(j clued_private.projection_refresh_jobs, p_at timestamptz)
returns boolean language sql immutable as $$
  select j.status in ('queued','retry_wait') and j.next_attempt_at <= p_at
$$;

create function clued_private.worker_projection_lease_expired_v1(j clued_private.projection_refresh_jobs, p_at timestamptz)
returns boolean language sql immutable as $$
  select j.status = 'running' and j.lease_expires_at <= p_at
$$;

create function clued_private.worker_job_queued_v1(j clued_private.storage_jobs_v1)
returns boolean language sql immutable as $$
  select j.intent_id is null and j.dispatch_outcome is null
$$;

create function clued_private.worker_refresh_enabled_v1(d clued_private.storage_refresh_delegations_v1, c clued_private.storage_connections_v1, p_at timestamptz)
returns boolean language sql immutable as $$
  select d.enabled and d.failures < 3 and (d.failures = 0 or d.next_refresh_at <= p_at) and c.state='active' and c.revoked_at is null
$$;

create function clued_private.worker_refresh_wake_v1(c clued_private.storage_connections_v1, a clued_private.storage_refresh_activity_v1, has_job boolean, p_at timestamptz)
returns boolean language sql stable as $$
  select a.connection_id is null or a.credential_version <> c.credential_version
    or (has_job and a.credential_expires_at <= p_at + interval '5 minutes')
    or greatest(a.last_successful_exchange_at,a.keepalive_anchor_at) <= p_at - interval '30 days'
$$;

create function clued_private.worker_refresh_attempt_expired_v1(x clued_private.storage_refresh_attempts_v1, p_at timestamptz)
returns boolean language sql immutable as $$
  select x.state='claimed' and x.expires_at <= p_at
$$;

create function clued_private.worker_recovery_jobs_v1(p_at timestamptz)
returns table(client_id text, connection_id uuid, job_id uuid, attempted_at timestamptz) language sql stable as $$
select c0.oauth_client_id,j0.connection_id,j0.job_id,r0.created_at
  from clued_private.storage_jobs_v1 j0
  join clued_private.storage_connections_v1 c0 on c0.id=j0.connection_id and c0.owner_id=j0.owner_id
  join clued_private.resource_center_mutations_v1 m0 on m0.id=j0.intent_id and m0.user_id=j0.owner_id
  join public.clued_audit_receipts r0 on r0.id=m0.provider_attempt_receipt_id
    and r0.user_id=j0.owner_id and r0.status='committed' and r0.operation='storage_provider_attempt'
  where c0.revoked_at is null
    and c0.auth_mode='account_policy' and c0.state in ('active','reauthorization_required')
    and j0.authority_snapshot_v2 is not null and m0.state in ('started','uncertain')
    and not (j0.mutation->>'operation'='move' and j0.mutation->>'target_kind'='directory')
    and j0.mutation->>'operation' is distinct from 'adopt'
    and m0.provider_attempt is not null and m0.provider_attempt_receipt_id is not null
    and r0.created_at<=p_at-interval '15 seconds'
    and (r0.created_at>p_at-interval '10 minutes'
      or not exists(select 1 from clued_private.storage_recovery_backoff_v1 b0
        where b0.owner_id=j0.owner_id and b0.job_id=j0.job_id and b0.next_at>p_at))
$$;

create function clued_private.worker_release_jobs_v1(p_at timestamptz)
returns table(client_id text, owner_id uuid, job_id uuid, connection_id uuid, expires_at timestamptz) language sql stable as $$
select c0.oauth_client_id,j0.owner_id,j0.job_id,j0.connection_id,m0.expires_at
  from clued_private.storage_jobs_v1 j0
  join clued_private.storage_connections_v1 c0 on c0.id=j0.connection_id and c0.owner_id=j0.owner_id
  join clued_private.resource_center_mutations_v1 m0 on m0.id=j0.intent_id and m0.user_id=j0.owner_id
  where c0.auth_mode='account_policy'
    and j0.authority_snapshot_v2 is not null and m0.state in ('started','uncertain')
    and ((m0.provider_attempt is null and m0.provider_attempt_receipt_id is null and m0.verified_result_v2 is null)
      or j0.mutation->>'operation'='adopt')
    and m0.writer_binding_id is not distinct from j0.cloud_writer_binding_id
    and m0.expires_at<p_at-interval '60 seconds'
$$;

create function clued_private.worker_digest_directories_v1(p_at timestamptz)
returns table(client_id text, connection_id uuid, artifact_id uuid, attempted_at timestamptz, created_at timestamptz) language sql stable as $$
select c0.oauth_client_id,c0.id,a0.id,a0.access_digest_attempted_at,a0.created_at
  from clued_private.resource_center_artifacts_v1 a0
  join clued_private.resource_center_profiles_v1 p0 on p0.id=a0.profile_id and p0.user_id=a0.user_id and p0.state='active'
  join clued_private.storage_connections_v1 c0 on c0.profile_id=p0.id and c0.owner_id=a0.user_id
  left join clued_private.storage_access_digest_recovery_v1 t0 on t0.artifact_id=a0.id
  where a0.state='active' and a0.target_kind='directory' and a0.provider_sharing_digest is null
    and a0.provider_access_digest is null
    and coalesce(a0.access_digest_attempted_at<p_at
      -interval '30 minutes'*power(2,least(case when a0.access_digest_missing_at is null then 0
        else coalesce(t0.attempts,0) end,5)),true)
    and c0.provider='google-drive' and c0.revoked_at is null
    and c0.auth_mode='account_policy' and c0.state='active'
    and clued_private.storage_envelope_valid_v1(c0.credential_envelope)
    and not exists(select 1 from clued_private.resource_center_mutations_v1 m0
      join clued_private.resource_center_profiles_v1 p1 on p1.id=m0.profile_id
      where m0.user_id=a0.user_id and p1.root_folder_id=p0.root_folder_id and m0.state in ('prepared','started','uncertain'))
    and not exists(select 1 from clued_private.storage_root_denies_v2 d0 where d0.owner_id=a0.user_id
      and d0.provider=c0.provider and d0.provider_subject=c0.provider_subject and d0.root_folder_id=p0.root_folder_id
      and d0.lineage_id is null and d0.denied)
$$;

create function clued_private.worker_conflict_due_v1(q clued_private.storage_conflict_isolations_v1, p_at timestamptz)
returns boolean language sql immutable as $$
  select q.state='active' and q.job_id is not null and q.scope_complete and q.next_recovery_at <= p_at
$$;

create function clued_private.worker_refresh_job_v1(c clued_private.storage_connections_v1, p_at timestamptz)
returns table(job_id uuid) language sql stable as $$
  select j.job_id from clued_private.storage_jobs_v1 j
      where j.connection_id=c.id and j.owner_id=c.owner_id and clued_private.worker_job_queued_v1(j)
        and j.created_at>p_at-interval '2 hours' order by j.created_at,j.job_id limit 1
$$;

create function clued_private.worker_binary_job_expired_v1(j clued_private.storage_jobs_v1, p_at timestamptz)
returns boolean language sql stable as $$
  select j.mutation ? 'content_ref' and clued_private.worker_job_queued_v1(j) and j.created_at <= p_at - interval '12 hours'
$$;

create function clued_private.worker_stage_deadline_v1(state text, issued_until timestamptz, ready_until timestamptz, received timestamptz)
returns timestamp language sql immutable as $$
  select case when state='issued' then issued_until at time zone 'UTC'
              when state='ready' then ready_until at time zone 'UTC'
              when state in ('receiving','validating') then (received at time zone 'UTC') + interval '2 hours' end
$$;

create function clued_private.worker_stage_timer_due_v1(s clued_private.storage_staging_v1, p_at timestamptz)
returns boolean language sql stable as $$
  select s.state in ('issued','ready','receiving','validating')
    and clued_private.worker_stage_deadline_v1(s.state,s.expires_at,s.ready_expires_at,s.received_at) <= (p_at at time zone 'UTC')
$$;

create function clued_private.worker_stage_delete_due_v1(s clued_private.storage_staging_v1)
returns boolean language sql stable as $$
  select s.object_deleted_at is null and s.bytes_received and s.state in ('rejected','expired','consumed')
    and clued_private.storage_staging_deletable_v1(s)
$$;

create function clued_private.worker_stage_purge_due_v1(s clued_private.storage_staging_v1, p_at timestamptz)
returns boolean language sql stable as $$
  select s.state in ('rejected','expired','consumed') and s.created_at <= p_at - interval '7 days'
    and clued_private.storage_staging_purgeable_v1(s)
$$;

create function clued_private.worker_onboard_due_v1(o clued_private.storage_onboard_attempts_v1, p_at timestamptz)
returns boolean language sql immutable as $$
  select o.state in ('begun','credential_staged','failed') and o.expires_at <= p_at
$$;

-- Keep existing queue, refresh delegation, pending attempt and staging retention indexes.
create index worker_projection_expired_lease_v1 on clued_private.projection_refresh_jobs(lease_expires_at) where status='running';
create index worker_queued_jobs_v1 on clued_private.storage_jobs_v1(connection_id,created_at)
  where intent_id is null and dispatch_outcome is null;
create index worker_open_mutations_v1 on clued_private.resource_center_mutations_v1(expires_at,id)
  where state in ('started','uncertain');
create index worker_missing_directory_digest_v1 on clued_private.resource_center_artifacts_v1(access_digest_attempted_at,profile_id)
  where state='active' and target_kind='directory' and provider_sharing_digest is null and provider_access_digest is null;
create index worker_conflict_due_v1 on clued_private.storage_conflict_isolations_v1(next_recovery_at)
  where state='active' and job_id is not null and scope_complete;
create index worker_staging_deadline_v1 on clued_private.storage_staging_v1
  (clued_private.worker_stage_deadline_v1(state,expires_at,ready_expires_at,received_at))
  where state in ('issued','ready','receiving','validating');
create index worker_staging_pending_delete_v1 on clued_private.storage_staging_v1(created_at)
  where object_deleted_at is null and bytes_received and state in ('rejected','expired','consumed');
create index worker_onboard_deadline_v1 on clued_private.storage_onboard_attempts_v1(expires_at)
  where state in ('begun','credential_staged','failed');

-- These are the SELECTs explained by the database test. UNION ALL lets EXISTS stop
-- at the first match, including work discovered on a secondary queue.
create function clued_private.worker_due_flags_v1(p_at timestamptz)
returns table(projection_refresh boolean,
              storage_refresh boolean,
              storage_recovery boolean,
              storage_unattempted_release boolean,
              storage_queued_sweep boolean,
              storage_access_digest_backfill boolean,
              storage_staging boolean,
              storage_onboard boolean)
language sql stable as $$
  select exists(
    select from clued_private.projection_refresh_jobs j where clued_private.worker_projection_ready_v1(j,p_at)
    union all select from clued_private.projection_refresh_jobs j where clued_private.worker_projection_lease_expired_v1(j,p_at)) as projection_refresh,
  exists(
    select from clued_private.storage_refresh_delegations_v1 d
      join clued_private.storage_connections_v1 c on c.id=d.connection_id
      left join clued_private.storage_refresh_activity_v1 a on a.connection_id=c.id
      where clued_private.worker_refresh_enabled_v1(d,c,p_at)
        and clued_private.worker_refresh_wake_v1(c,a,exists(select from clued_private.worker_refresh_job_v1(c,p_at)),p_at)
    union all select from clued_private.storage_refresh_attempts_v1 x where clued_private.worker_refresh_attempt_expired_v1(x,p_at)) as storage_refresh,
  exists(
    select from clued_private.worker_recovery_jobs_v1(p_at)
    union all select from clued_private.storage_conflict_isolations_v1 q where clued_private.worker_conflict_due_v1(q,p_at)) as storage_recovery,
  exists(
    select from clued_private.worker_release_jobs_v1(p_at)) as storage_unattempted_release,
  exists(
    select from clued_private.storage_jobs_v1 j where clued_private.worker_job_queued_v1(j)) as storage_queued_sweep,
  exists(
    select from clued_private.worker_digest_directories_v1(p_at)) as storage_access_digest_backfill,
  exists(
    select from clued_private.storage_staging_v1 s where clued_private.worker_stage_timer_due_v1(s,p_at)
    union all select from clued_private.storage_staging_v1 s where clued_private.worker_stage_delete_due_v1(s)
    union all select from clued_private.storage_staging_v1 s where clued_private.worker_stage_purge_due_v1(s,p_at)
    union all select from clued_private.storage_jobs_v1 j where clued_private.worker_binary_job_expired_v1(j,p_at)) as storage_staging,
  exists(
    select from clued_private.storage_onboard_attempts_v1 o where clued_private.worker_onboard_due_v1(o,p_at)) as storage_onboard
$$;
revoke all on function
  clued_private.worker_projection_ready_v1(clued_private.projection_refresh_jobs,timestamptz),
  clued_private.worker_projection_lease_expired_v1(clued_private.projection_refresh_jobs,timestamptz),
  clued_private.worker_job_queued_v1(clued_private.storage_jobs_v1),
  clued_private.worker_refresh_enabled_v1(clued_private.storage_refresh_delegations_v1,clued_private.storage_connections_v1,timestamptz),
  clued_private.worker_refresh_wake_v1(clued_private.storage_connections_v1,clued_private.storage_refresh_activity_v1,boolean,timestamptz),
  clued_private.worker_refresh_attempt_expired_v1(clued_private.storage_refresh_attempts_v1,timestamptz),
  clued_private.worker_recovery_jobs_v1(timestamptz),
  clued_private.worker_release_jobs_v1(timestamptz),
  clued_private.worker_digest_directories_v1(timestamptz),
  clued_private.worker_conflict_due_v1(clued_private.storage_conflict_isolations_v1,timestamptz),
  clued_private.worker_refresh_job_v1(clued_private.storage_connections_v1,timestamptz),
  clued_private.worker_binary_job_expired_v1(clued_private.storage_jobs_v1,timestamptz),
  clued_private.worker_stage_deadline_v1(text,timestamptz,timestamptz,timestamptz),
  clued_private.worker_stage_timer_due_v1(clued_private.storage_staging_v1,timestamptz),
  clued_private.worker_stage_delete_due_v1(clued_private.storage_staging_v1),
  clued_private.worker_stage_purge_due_v1(clued_private.storage_staging_v1,timestamptz),
  clued_private.worker_onboard_due_v1(clued_private.storage_onboard_attempts_v1,timestamptz),
  clued_private.worker_due_flags_v1(timestamptz)
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- Patch each selected overload in place. Exact counts protect against drift in either
-- replay chain and preserve the surrounding mutations, privileges and public signatures.
do $migration$
declare edit record; definition text;
begin
  for edit in select * from (values
    ('public.clued_mcp_projection_refresh_claim(text,jsonb)', 2,
     $old$j.status='running' and j.lease_expires_at<=pg_catalog.clock_timestamp()$old$,
     $new$clued_private.worker_projection_lease_expired_v1(j, statement_timestamp())$new$),
    ('public.clued_mcp_projection_refresh_claim(text,jsonb)', 1,
     $old$j.status in ('queued','retry_wait')
    and j.next_attempt_at<=pg_catalog.clock_timestamp()$old$,
     $new$clued_private.worker_projection_ready_v1(j, statement_timestamp())$new$),
    ('clued_private.storage_queue_before_registration_v1(text,jsonb)', 2,
     $old$j0.intent_id is null and j0.dispatch_outcome is null$old$,
     $new$clued_private.worker_job_queued_v1(j0)$new$),
    ('clued_private.ii_pub_clued_storage_queued_sweep_v1(text,jsonb)', 1,
     $old$j0.intent_id is null and j0.dispatch_outcome is null$old$,
     $new$clued_private.worker_job_queued_v1(j0)$new$),
    ('clued_private.storage_demand_due_v1(text)', 1,
     $old$d.enabled and d.failures<3 and c.state='active' and c.revoked_at is null$old$,
     $new$clued_private.worker_refresh_enabled_v1(d,c,statement_timestamp())$new$),
    ('clued_private.storage_demand_due_v1(text)', 1,
     $old$      and (d.failures=0 or d.next_refresh_at<=clock_timestamp())
$old$,
     $new$$new$),
    ('clued_private.storage_demand_due_v1(text)', 1,
     $old$(a.connection_id is null or a.credential_version<>c.credential_version
        or (job.job_id is not null
          and a.credential_expires_at<=clock_timestamp()+interval '5 minutes')
        or greatest(a.last_successful_exchange_at,a.keepalive_anchor_at)<=clock_timestamp()-interval '30 days')$old$,
     $new$clued_private.worker_refresh_wake_v1(c,a,job.job_id is not null,statement_timestamp())$new$),
    ('clued_private.storage_demand_due_v1(text)', 1,
     $old$from clued_private.storage_refresh_attempts_v1 where issuer_hash=p_identity
      and state='claimed' and expires_at<=clock_timestamp()$old$,
     $new$from clued_private.storage_refresh_attempts_v1 x where issuer_hash=p_identity
      and clued_private.worker_refresh_attempt_expired_v1(x,statement_timestamp())$new$),
    ('clued_private.storage_scheduled_before_conflict_v1(text,jsonb)', 1,
     $old$select j0.connection_id,j0.job_id from clued_private.storage_jobs_v1 j0
      join clued_private.storage_connections_v1 c0 on c0.id=j0.connection_id and c0.owner_id=j0.owner_id
      join clued_private.resource_center_mutations_v1 m0 on m0.id=j0.intent_id and m0.user_id=j0.owner_id
      join public.clued_audit_receipts r0 on r0.id=m0.provider_attempt_receipt_id
        and r0.user_id=j0.owner_id and r0.status='committed' and r0.operation='storage_provider_attempt'
      where c0.oauth_client_id=app.oauth_client_id and c0.revoked_at is null
        and c0.auth_mode='account_policy' and c0.state in ('active','reauthorization_required')
        and j0.authority_snapshot_v2 is not null and m0.state in ('started','uncertain')
        and not (j0.mutation->>'operation'='move' and j0.mutation->>'target_kind'='directory')
        and j0.mutation->>'operation' is distinct from 'adopt'
        and m0.provider_attempt is not null and m0.provider_attempt_receipt_id is not null
        and r0.created_at<=clock_timestamp()-interval '15 seconds'
        and (r0.created_at>clock_timestamp()-interval '10 minutes'
          or not exists(select 1 from clued_private.storage_recovery_backoff_v1 b0
            where b0.owner_id=j0.owner_id and b0.job_id=j0.job_id and b0.next_at>clock_timestamp()))
      order by r0.created_at<=clock_timestamp()-interval '10 minutes',r0.created_at,j0.job_id limit 3$old$,
     $new$select work.connection_id,work.job_id from clued_private.worker_recovery_jobs_v1(statement_timestamp()) work
      where work.client_id=app.oauth_client_id
      order by work.attempted_at<=statement_timestamp()-interval '10 minutes',work.attempted_at,work.job_id limit 3$new$),
    ('clued_private.ii_pub_clued_storage_release_unattempted_v1(text,jsonb)', 1,
     $old$select j0.owner_id,j0.job_id,j0.connection_id from clued_private.storage_jobs_v1 j0
    join clued_private.storage_connections_v1 c0 on c0.id=j0.connection_id and c0.owner_id=j0.owner_id
    join clued_private.resource_center_mutations_v1 m0 on m0.id=j0.intent_id and m0.user_id=j0.owner_id
    where c0.oauth_client_id=app.oauth_client_id and c0.auth_mode='account_policy'
      and j0.authority_snapshot_v2 is not null and m0.state in ('started','uncertain')
      and ((m0.provider_attempt is null and m0.provider_attempt_receipt_id is null and m0.verified_result_v2 is null)
        or j0.mutation->>'operation'='adopt')
      and m0.writer_binding_id is not distinct from j0.cloud_writer_binding_id
      and m0.expires_at<clock_timestamp()-interval '60 seconds'
    order by m0.expires_at,j0.job_id limit 10$old$,
     $new$select work.owner_id,work.job_id,work.connection_id from clued_private.worker_release_jobs_v1(statement_timestamp()) work
      where work.client_id=app.oauth_client_id
      order by work.expires_at,work.job_id limit 10$new$),
    ('clued_private.ii_pub_clued_storage_access_digest_backfill_v1(text,jsonb)', 1,
     $old$select c0.id connection_id,a0.id artifact_id from clued_private.resource_center_artifacts_v1 a0
      join clued_private.resource_center_profiles_v1 p0 on p0.id=a0.profile_id and p0.user_id=a0.user_id and p0.state='active'
      join clued_private.storage_connections_v1 c0 on c0.profile_id=p0.id and c0.owner_id=a0.user_id
      left join clued_private.storage_access_digest_recovery_v1 t0 on t0.artifact_id=a0.id
      where a0.state='active' and a0.target_kind='directory' and a0.provider_sharing_digest is null
        and a0.provider_access_digest is null
        and coalesce(a0.access_digest_attempted_at<clock_timestamp()
          -interval '30 minutes'*power(2,least(case when a0.access_digest_missing_at is null then 0
            else coalesce(t0.attempts,0) end,5)),true)
        and c0.oauth_client_id=app.oauth_client_id and c0.provider='google-drive' and c0.revoked_at is null
        and c0.auth_mode='account_policy' and c0.state='active'
        and clued_private.storage_envelope_valid_v1(c0.credential_envelope)
        and not exists(select 1 from clued_private.resource_center_mutations_v1 m0
          join clued_private.resource_center_profiles_v1 p1 on p1.id=m0.profile_id
          where m0.user_id=a0.user_id and p1.root_folder_id=p0.root_folder_id and m0.state in ('prepared','started','uncertain'))
        and not exists(select 1 from clued_private.storage_root_denies_v2 d0 where d0.owner_id=a0.user_id
          and d0.provider=c0.provider and d0.provider_subject=c0.provider_subject and d0.root_folder_id=p0.root_folder_id
          and d0.lineage_id is null and d0.denied)
      order by a0.access_digest_attempted_at nulls first,a0.created_at,a0.id limit 5$old$,
     $new$select work.connection_id,work.artifact_id from clued_private.worker_digest_directories_v1(statement_timestamp()) work
      where work.client_id=app.oauth_client_id
      order by work.attempted_at nulls first,work.created_at,work.artifact_id limit 5$new$),
    ('clued_private.storage_scheduled_before_automatic_v1(text,jsonb)', 1,
     $old$q.state='active' and q.job_id is not null and q.scope_complete and q.next_recovery_at<=clock_timestamp()$old$,
     $new$clued_private.worker_conflict_due_v1(q,statement_timestamp())$new$),
    ('clued_private.storage_demand_due_v1(text)', 1,
     $old$(select j.job_id from clued_private.storage_jobs_v1 j
      where j.connection_id=c.id and j.owner_id=c.owner_id and j.intent_id is null and j.dispatch_outcome is null
        and j.created_at>clock_timestamp()-interval '2 hours' order by j.created_at,j.job_id limit 1) job$old$,
     $new$clued_private.worker_refresh_job_v1(c,statement_timestamp()) job$new$),
    ('clued_private.ii_pub_clued_storage_staging_v1(text,text,jsonb)', 1,
     $old$j.mutation ? 'content_ref' and j.intent_id is null and j.dispatch_outcome is null
          and j.created_at<=clock_timestamp()-interval '12 hours'$old$,
     $new$clued_private.worker_binary_job_expired_v1(j,statement_timestamp())$new$),
    ('clued_private.ii_pub_clued_storage_staging_v1(text,text,jsonb)', 1,
     $old$s1.state='issued' and s1.expires_at<=clock_timestamp()$old$,
     $new$s1.state='issued' and clued_private.worker_stage_timer_due_v1(s1,statement_timestamp())$new$),
    ('clued_private.ii_pub_clued_storage_staging_v1(text,text,jsonb)', 1,
     $old$s1.state='ready' and s1.ready_expires_at<=clock_timestamp()$old$,
     $new$s1.state='ready' and clued_private.worker_stage_timer_due_v1(s1,statement_timestamp())$new$),
    ('clued_private.ii_pub_clued_storage_staging_v1(text,text,jsonb)', 1,
     $old$s1.state in ('receiving','validating') and s1.received_at<=clock_timestamp()-interval '2 hours'$old$,
     $new$s1.state in ('receiving','validating') and clued_private.worker_stage_timer_due_v1(s1,statement_timestamp())$new$),
    ('clued_private.ii_pub_clued_storage_staging_v1(text,text,jsonb)', 1,
     $old$where clued_private.storage_staging_deletable_v1(s1)$old$,
     $new$where clued_private.worker_stage_delete_due_v1(s1)$new$),
    ('clued_private.ii_pub_clued_storage_staging_v1(text,text,jsonb)', 1,
     $old$s1.state in ('rejected','expired','consumed') and s1.created_at<=clock_timestamp()-interval '7 days'
          and clued_private.storage_staging_purgeable_v1(s1)$old$,
     $new$clued_private.worker_stage_purge_due_v1(s1,statement_timestamp())$new$),
    ('clued_private.storage_onboard_expire_v1(uuid,text)', 1,
     $old$o0.state in ('begun','credential_staged','failed') and o0.expires_at<=clock_timestamp()$old$,
     $new$clued_private.worker_onboard_due_v1(o0,statement_timestamp())$new$),
    ('clued_watchdog.projection_watchdog_snapshot()', 1,
     $old$coalesce(clued_private.projection_builder_authorized(
        (select b.builder_binding_id from clued_private.projection_refresh_heartbeat b where b.id),
        h.user_id,h.target_scope,h.projection_key),false)$old$,
     $new$exists(select from clued_private.projection_builder_grants g
        where g.user_id=h.user_id and g.target_scope=h.target_scope and g.projection_key=h.projection_key
          and clued_private.projection_builder_authorized(g.binding_id,h.user_id,h.target_scope,h.projection_key))$new$)
  ) as changes(signature, hits, original, replacement)
  loop
    definition := pg_get_functiondef(edit.signature::regprocedure);
    if (length(definition)-length(replace(definition,edit.original,'')))/length(edit.original) <> edit.hits then
      raise exception 'worker due selection changed in %',edit.signature;
    end if;
    execute replace(definition,edit.original,edit.replacement);
  end loop;
end $migration$;

-- PostgREST authenticates the existing gateway JWT and selects clued_worker_gateway.
-- Bind the argument to that same request without storing another secret or accepting a Binding.
create function public.clued_worker_due_v1(p_token_hash text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  bearer text := nullif(current_setting('request.headers',true),'')::jsonb->>'authorization';
  observed timestamptz := statement_timestamp();
begin
  if current_setting('role',true) is distinct from 'clued_worker_gateway'
     or bearer is null or bearer !~* '^Bearer [^[:space:]]+$'
     or p_token_hash is distinct from encode(sha256(convert_to(substr(bearer,8),'UTF8')),'hex') then
    raise exception 'worker_gateway_required' using errcode='42501';
  end if;
  return (select jsonb_build_object('status','ok','observed_at',observed,'due',to_jsonb(flags))
    from clued_private.worker_due_flags_v1(observed) flags);
end $$;
revoke all on function public.clued_worker_due_v1(text) from public,anon,authenticated,service_role;
grant execute on function public.clued_worker_due_v1(text) to clued_worker_gateway;
