
create extension if not exists pg_cron;

create table if not exists clued_watchdog.projection_watchdog_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  fingerprint text not null,
  notify_model boolean not null default true,
  processed_at timestamptz,
  transport text,
  payload jsonb not null
);

create index if not exists projection_watchdog_events_pending_idx
  on clued_watchdog.projection_watchdog_events (id)
  where notify_model and processed_at is null;

create table if not exists clued_watchdog.projection_watchdog_state (
  singleton boolean primary key default true check (singleton),
  status text not null default 'UNKNOWN'
    check (status in ('UNKNOWN','OK','ANOMALY')),
  last_fingerprint text,
  incident_started_at timestamptz,
  last_seen_at timestamptz,
  last_change_at timestamptz,
  last_event_id bigint references clued_watchdog.projection_watchdog_events(id),
  last_evaluation jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default pg_catalog.clock_timestamp()
);

insert into clued_watchdog.projection_watchdog_state(singleton)
values (true)
on conflict (singleton) do nothing;

revoke all on clued_watchdog.projection_watchdog_events from public, anon, authenticated, clued_projection_watchdog;
revoke all on clued_watchdog.projection_watchdog_state from public, anon, authenticated, clued_projection_watchdog;

create or replace function clued_watchdog.projection_watchdog_evaluate_snapshot(
  p_snapshot jsonb,
  p_now timestamptz
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $function$
  with proj as (
    select value as p
    from pg_catalog.jsonb_array_elements(
      coalesce(p_snapshot->'projections', '[]'::jsonb)
    )
  ),
  lagged as (
    select p
    from proj
    where coalesce((p->>'invalidation_revision')::bigint, 0)
            > coalesce((p->>'resolved_through_revision')::bigint, 0)
      and nullif(p->>'stale_since','') is not null
      and (p->>'stale_since')::timestamptz <= p_now - interval '5 minutes'
  ),
  reason_rows as (
    select
      coalesce(p->>'tenant_key','') as tenant_key,
      coalesce(p->>'projection_key','') as projection_key,
      'revision_lag_over_5m'::text as reason_code,
      pg_catalog.jsonb_build_object(
        'reason_code','revision_lag_over_5m',
        'tenant_key',p->>'tenant_key',
        'projection_key',p->>'projection_key',
        'invalidation_revision',(p->>'invalidation_revision')::bigint,
        'resolved_through_revision',(p->>'resolved_through_revision')::bigint,
        'stale_since',p->>'stale_since',
        'job_status',p->>'job_status',
        'attempt_count',p->>'attempt_count',
        'max_attempts',p->>'max_attempts'
      ) as reason
    from lagged

    union all

    select
      coalesce(p->>'tenant_key',''),
      coalesce(p->>'projection_key',''),
      'source_digest_mismatch',
      pg_catalog.jsonb_build_object(
        'reason_code','source_digest_mismatch',
        'tenant_key',p->>'tenant_key',
        'projection_key',p->>'projection_key',
        'source_digest_status',p->>'source_digest_status'
      )
    from proj
    where p->>'source_digest_status' = 'mismatch'

    union all

    select
      coalesce(p->>'tenant_key',''),
      coalesce(p->>'projection_key',''),
      'job_attempts_exhausted',
      pg_catalog.jsonb_build_object(
        'reason_code','job_attempts_exhausted',
        'tenant_key',p->>'tenant_key',
        'projection_key',p->>'projection_key',
        'job_status',p->>'job_status',
        'attempt_count',p->>'attempt_count',
        'max_attempts',p->>'max_attempts',
        'job_updated_at',p->>'job_updated_at'
      )
    from proj
    where nullif(p->>'attempt_count','') is not null
      and nullif(p->>'max_attempts','') is not null
      and (p->>'attempt_count')::integer >= (p->>'max_attempts')::integer
      and coalesce(p->>'job_status','') <> 'completed'

    union all

    select
      '',
      '',
      'worker_cycle_limit',
      pg_catalog.jsonb_build_object(
        'reason_code','worker_cycle_limit',
        'last_result',p_snapshot->'heartbeat'->>'last_result',
        'last_started_at',p_snapshot->'heartbeat'->>'last_started_at',
        'last_finished_at',p_snapshot->'heartbeat'->>'last_finished_at'
      )
    where coalesce(p_snapshot->'heartbeat'->>'last_result','') = 'cycle_limit'
      and exists (select 1 from lagged)

    union all

    select
      '',
      '',
      'worker_heartbeat_stale',
      pg_catalog.jsonb_build_object(
        'reason_code','worker_heartbeat_stale',
        'last_result',p_snapshot->'heartbeat'->>'last_result',
        'last_started_at',p_snapshot->'heartbeat'->>'last_started_at',
        'last_finished_at',p_snapshot->'heartbeat'->>'last_finished_at'
      )
    where exists (select 1 from lagged)
      and (
        nullif(p_snapshot->'heartbeat'->>'last_finished_at','') is null
        or (p_snapshot->'heartbeat'->>'last_finished_at')::timestamptz
             <= p_now - interval '5 minutes'
      )
  ),
  packed as (
    select
      coalesce(
        pg_catalog.jsonb_agg(
          reason order by tenant_key, projection_key, reason_code
        ),
        '[]'::jsonb
      ) as anomalies,
      coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'tenant_key',tenant_key,
            'projection_key',projection_key,
            'reason_code',reason_code
          )
          order by tenant_key, projection_key, reason_code
        ),
        '[]'::jsonb
      ) as fingerprint_material
    from reason_rows
  )
  select pg_catalog.jsonb_build_object(
    'schema','clued.projection-watchdog-evaluation/v1',
    'evaluated_at',p_now,
    'status',case
      when pg_catalog.jsonb_array_length(packed.anomalies) > 0 then 'ANOMALY'
      else 'OK'
    end,
    'notify_model',pg_catalog.jsonb_array_length(packed.anomalies) > 0,
    'fingerprint',case
      when pg_catalog.jsonb_array_length(packed.anomalies) > 0
        then pg_catalog.encode(
          extensions.digest(packed.fingerprint_material::text,'sha256'),
          'hex'
        )
      else null
    end,
    'anomalies',packed.anomalies,
    'snapshot',p_snapshot
  )
  from packed
$function$;

create or replace function clued_watchdog.projection_watchdog_evaluate()
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $function$
  select clued_watchdog.projection_watchdog_evaluate_snapshot(
    clued_watchdog.projection_watchdog_snapshot(),
    pg_catalog.clock_timestamp()
  )
$function$;

create or replace function clued_watchdog.projection_watchdog_tick()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_eval jsonb;
  v_status text;
  v_fingerprint text;
  v_prev_status text;
  v_prev_fingerprint text;
  v_incident_started_at timestamptz;
  v_last_change_at timestamptz;
  v_last_event_id bigint;
  v_event_id bigint;
  v_new_event boolean := false;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('clued_watchdog.projection_watchdog_tick', 0)
  );

  v_eval := clued_watchdog.projection_watchdog_evaluate_snapshot(
    clued_watchdog.projection_watchdog_snapshot(),
    v_now
  );
  v_status := v_eval->>'status';
  v_fingerprint := v_eval->>'fingerprint';

  select status, last_fingerprint, incident_started_at, last_change_at, last_event_id
    into v_prev_status, v_prev_fingerprint, v_incident_started_at, v_last_change_at, v_last_event_id
  from clued_watchdog.projection_watchdog_state
  where singleton
  for update;

  if v_status = 'ANOMALY' then
    if v_prev_status is distinct from 'ANOMALY'
       or v_prev_fingerprint is distinct from v_fingerprint then
      insert into clued_watchdog.projection_watchdog_events(
        fingerprint, notify_model, payload
      )
      values (
        v_fingerprint,
        true,
        pg_catalog.jsonb_build_object(
          'schema','clued.projection-watchdog-event/v1',
          'status','ANOMALY',
          'notify_model',true,
          'fingerprint',v_fingerprint,
          'evaluation',v_eval
        )
      )
      returning id into v_event_id;
      v_new_event := true;
    end if;

    update clued_watchdog.projection_watchdog_state
    set status = 'ANOMALY',
        last_fingerprint = v_fingerprint,
        incident_started_at = case
          when v_prev_status = 'ANOMALY'
            then coalesce(v_incident_started_at, v_now)
          else v_now
        end,
        last_seen_at = v_now,
        last_change_at = case
          when v_new_event then v_now
          else coalesce(v_last_change_at, v_now)
        end,
        last_event_id = coalesce(v_event_id, v_last_event_id),
        last_evaluation = v_eval,
        updated_at = v_now
    where singleton;
  else
    update clued_watchdog.projection_watchdog_state
    set status = 'OK',
        last_fingerprint = null,
        incident_started_at = null,
        last_seen_at = v_now,
        last_change_at = case
          when v_prev_status is distinct from 'OK' then v_now
          else coalesce(v_last_change_at, v_now)
        end,
        last_evaluation = v_eval,
        updated_at = v_now
    where singleton;
  end if;

  return pg_catalog.jsonb_build_object(
    'schema','clued.projection-watchdog-tick/v1',
    'status',v_status,
    'notify_model',v_new_event,
    'event_id',v_event_id,
    'fingerprint',v_fingerprint,
    'evaluation',v_eval
  );
end
$function$;

revoke all on function clued_watchdog.projection_watchdog_evaluate_snapshot(jsonb,timestamptz)
  from public, anon, authenticated, clued_projection_watchdog;
revoke all on function clued_watchdog.projection_watchdog_evaluate()
  from public, anon, authenticated, clued_projection_watchdog;
revoke all on function clued_watchdog.projection_watchdog_tick()
  from public, anon, authenticated, clued_projection_watchdog;

select cron.schedule(
  'clued-projection-watchdog-hourly',
  '0 * * * *',
  $cron$select clued_watchdog.projection_watchdog_tick();$cron$
);
