
-- Canonical cloud-side projection watchdog. The monitor is deterministic:
-- healthy ticks do not enqueue a model event; only incident-set transitions do.
-- pg_cron is enabled/scheduled only on environments where the extension exists,
-- so embedded/local migration tests remain portable.

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
  active_keys text[] not null default '{}'::text[],
  observed_tenants text[] not null default '{}'::text[],
  updated_at timestamptz not null default pg_catalog.clock_timestamp()
);

alter table clued_watchdog.projection_watchdog_state
  add column if not exists active_keys text[] not null default '{}'::text[],
  add column if not exists observed_tenants text[] not null default '{}'::text[];

insert into clued_watchdog.projection_watchdog_state(singleton)
values (true)
on conflict (singleton) do nothing;

revoke all on clued_watchdog.projection_watchdog_events
  from public,anon,authenticated,service_role,clued_projection_watchdog;
revoke all on clued_watchdog.projection_watchdog_state
  from public,anon,authenticated,service_role,clued_projection_watchdog;

drop function if exists clued_watchdog.projection_watchdog_evaluate_snapshot(jsonb,timestamptz);

create or replace function clued_watchdog.projection_watchdog_evaluate_snapshot_v2(
  p_snapshot jsonb,
  p_now timestamptz,
  p_previous_tenants text[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $function$
declare
  v_observed timestamptz;
  v_heartbeat jsonb;
  v_last_started timestamptz;
  v_last_finished timestamptz;
  v_last_result text;
  v_incidents jsonb := '[]'::jsonb;
  v_sorted_incidents jsonb := '[]'::jsonb;
  v_active_keys text[] := '{}'::text[];
  v_seen text[] := '{}'::text[];
  v_current_tenants text[] := '{}'::text[];
  v_row jsonb;
  v_tenant text;
  v_key text;
  v_identity text;
  v_inv bigint;
  v_res bigint;
  v_lag bigint;
  v_digest text;
  v_job_status text;
  v_stale_since timestamptz;
  v_prefix text;
  v_tenant_iter text;
  v_key_iter text;
  v_detail text;
begin
  if p_snapshot is null
     or pg_catalog.jsonb_typeof(p_snapshot) <> 'object'
     or pg_catalog.jsonb_typeof(p_snapshot->'projections') <> 'array'
     or nullif(p_snapshot->>'observed_at','') is null then
    raise exception 'invalid_watchdog_snapshot' using errcode='22023';
  end if;

  begin
    v_observed := (p_snapshot->>'observed_at')::timestamptz;
  exception when others then
    raise exception 'invalid_watchdog_snapshot' using errcode='22023';
  end;

  if pg_catalog.abs(extract(epoch from (p_now-v_observed))) > 120 then
    raise exception 'stale_watchdog_snapshot' using errcode='22023';
  end if;

  v_heartbeat := p_snapshot->'heartbeat';
  if v_heartbeat is null or v_heartbeat = 'null'::jsonb then
    v_incidents := v_incidents || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'key','worker:heartbeat_missing',
        'code','HEARTBEAT_MISSING',
        'detail','No completed refresh tick.'
      )
    );
  else
    v_last_result := v_heartbeat->>'last_result';
    begin
      v_last_finished := nullif(v_heartbeat->>'last_finished_at','')::timestamptz;
    exception when others then
      v_last_finished := null;
    end;
    begin
      v_last_started := nullif(v_heartbeat->>'last_started_at','')::timestamptz;
    exception when others then
      v_last_started := null;
    end;

    if v_last_finished is null then
      v_incidents := v_incidents || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'key','worker:heartbeat_missing',
          'code','HEARTBEAT_MISSING',
          'detail','No completed refresh tick.'
        )
      );
    elsif v_observed-v_last_finished > interval '5 minutes' then
      v_incidents := v_incidents || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'key','worker:heartbeat_stale',
          'code','HEARTBEAT_STALE',
          'detail','Refresh tick has not completed within threshold.'
        )
      );
    end if;

    if v_last_started is not null
       and v_observed-v_last_started > interval '5 minutes'
       and (v_last_finished is null or v_last_finished < v_last_started) then
      v_incidents := v_incidents || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'key','worker:tick_incomplete',
          'code','TICK_INCOMPLETE',
          'detail','Most recent refresh tick did not finish.'
        )
      );
    end if;

    if v_last_result in ('transport_unavailable','builder_protocol_error','exception') then
      v_incidents := v_incidents || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'key','worker:degraded',
          'code','WORKER_DEGRADED',
          'detail','Last refresh result indicates a degraded worker outcome.',
          'last_result',v_last_result
        )
      );
    end if;
  end if;

  if pg_catalog.jsonb_array_length(p_snapshot->'projections') = 0 then
    v_incidents := v_incidents || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'key','projections:none',
        'code','NO_PROJECTIONS',
        'detail','No tracked Global projection heads were returned.'
      )
    );
  end if;

  for v_row in
    select value from pg_catalog.jsonb_array_elements(p_snapshot->'projections')
  loop
    if v_row is null or pg_catalog.jsonb_typeof(v_row) <> 'object' then
      raise exception 'invalid_watchdog_projection' using errcode='22023';
    end if;

    v_tenant := v_row->>'tenant_key';
    v_key := v_row->>'projection_key';
    v_digest := v_row->>'source_digest_status';
    v_job_status := v_row->>'job_status';

    if v_key not in ('global.priority_frontier','global.__aggregate__')
       or v_tenant is null
       or v_tenant !~ '^[0-9a-f]{64}$'
       or nullif(v_row->>'invalidation_revision','') is null
       or nullif(v_row->>'resolved_through_revision','') is null
       or v_digest not in ('match','mismatch','unavailable','not_applicable') then
      raise exception 'invalid_watchdog_projection' using errcode='22023';
    end if;

    begin
      v_inv := (v_row->>'invalidation_revision')::bigint;
      v_res := (v_row->>'resolved_through_revision')::bigint;
    exception when others then
      raise exception 'invalid_watchdog_projection' using errcode='22023';
    end;

    v_identity := v_tenant || ':' || v_key;
    if v_identity = any(v_seen) then
      raise exception 'duplicate_watchdog_projection' using errcode='22023';
    end if;
    v_seen := pg_catalog.array_append(v_seen,v_identity);

    if not (v_tenant = any(v_current_tenants)) then
      v_current_tenants := pg_catalog.array_append(v_current_tenants,v_tenant);
    end if;

    v_lag := v_inv-v_res;
    if (v_lag = 0 and v_digest = 'not_applicable')
       or (v_lag <> 0 and v_digest <> 'not_applicable') then
      raise exception 'invalid_watchdog_digest_status' using errcode='22023';
    end if;

    v_prefix := v_tenant || ':' || v_key;
    v_detail := v_key || ' revision ' || v_res::text || '/' || v_inv::text;

    if v_lag < 0 then
      v_incidents := v_incidents || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'key',v_prefix || ':revision_invariant',
          'code','REVISION_INVARIANT',
          'detail',v_detail
        )
      );
    end if;

    if v_job_status = 'failed' then
      v_incidents := v_incidents || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'key',v_prefix || ':terminal_failure',
          'code','TERMINAL_FAILURE',
          'detail',v_detail || '; diagnostic error recorded in the private queue.'
        )
      );
    end if;

    if v_lag > 0 and v_job_status is null then
      v_incidents := v_incidents || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'key',v_prefix || ':queue_missing',
          'code','QUEUE_MISSING',
          'detail',v_detail
        )
      );
    end if;

    v_stale_since := null;
    if nullif(v_row->>'stale_since','') is not null then
      begin
        v_stale_since := (v_row->>'stale_since')::timestamptz;
      exception when others then
        v_stale_since := null;
      end;
    end if;

    if v_lag > 0
       and (v_stale_since is null or v_observed-v_stale_since > interval '5 minutes') then
      v_incidents := v_incidents || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'key',v_prefix || ':stale_timeout',
          'code','STALE_TIMEOUT',
          'detail',v_detail
        )
      );
    end if;

    if v_lag = 0 and v_digest = 'mismatch' then
      v_incidents := v_incidents || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'key',v_prefix || ':source_mismatch',
          'code','SOURCE_MISMATCH',
          'detail',v_detail || '; stored source digest differs from the latest source vector.'
        )
      );
    end if;

    if v_lag = 0 and v_digest = 'unavailable' then
      v_incidents := v_incidents || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'key',v_prefix || ':audit_gap',
          'code','AUDIT_GAP',
          'detail',v_detail || '; no source digest is available for independent comparison.'
        )
      );
    end if;
  end loop;

  foreach v_tenant_iter in array v_current_tenants
  loop
    foreach v_key_iter in array array['global.priority_frontier','global.__aggregate__']::text[]
    loop
      v_identity := v_tenant_iter || ':' || v_key_iter;
      if not (v_identity = any(v_seen)) then
        v_incidents := v_incidents || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'key',v_identity || ':head_missing',
            'code','HEAD_MISSING',
            'detail',v_key_iter || ' was absent from the bounded status snapshot.'
          )
        );
      end if;
    end loop;
  end loop;

  foreach v_tenant_iter in array coalesce(p_previous_tenants,'{}'::text[])
  loop
    if not (v_tenant_iter = any(v_current_tenants)) then
      v_incidents := v_incidents || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'key',v_tenant_iter || ':tenant_missing',
          'code','TENANT_MISSING',
          'detail','A previously observed tenant has no Global projection heads in the latest snapshot.'
        )
      );
    end if;
  end loop;

  select
    coalesce(pg_catalog.jsonb_agg(value order by value->>'key'),'[]'::jsonb),
    coalesce(pg_catalog.array_agg(value->>'key' order by value->>'key'),'{}'::text[])
  into v_sorted_incidents,v_active_keys
  from pg_catalog.jsonb_array_elements(v_incidents);

  return pg_catalog.jsonb_build_object(
    'schema','clued.projection-watchdog-evaluation/v2',
    'evaluated_at',p_now,
    'status',case when pg_catalog.cardinality(v_active_keys)>0 then 'ANOMALY' else 'OK' end,
    'incidents',v_sorted_incidents,
    'active_keys',pg_catalog.to_jsonb(v_active_keys),
    'current_tenants',pg_catalog.to_jsonb(v_current_tenants),
    'snapshot',p_snapshot
  );
exception when others then
  return pg_catalog.jsonb_build_object(
    'schema','clued.projection-watchdog-evaluation/v2',
    'evaluated_at',p_now,
    'status','UNVERIFIED',
    'incidents',pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'key','monitor:snapshot_invalid',
        'code','MONITOR_SNAPSHOT_INVALID',
        'detail','Projection watchdog status could not be safely evaluated.'
      )
    ),
    'active_keys',pg_catalog.jsonb_build_array('monitor:snapshot_invalid'),
    'current_tenants','[]'::jsonb
  );
end
$function$;

create or replace function clued_watchdog.projection_watchdog_evaluate()
returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $function$
declare
  v_previous_tenants text[];
begin
  select observed_tenants into v_previous_tenants
  from clued_watchdog.projection_watchdog_state
  where singleton;
  return clued_watchdog.projection_watchdog_evaluate_snapshot_v2(
    clued_watchdog.projection_watchdog_snapshot(),
    pg_catalog.clock_timestamp(),
    coalesce(v_previous_tenants,'{}'::text[])
  );
end
$function$;

create or replace function clued_watchdog.projection_watchdog_tick()
returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_eval jsonb;
  v_eval_status text;
  v_prev_status text;
  v_prev_keys text[];
  v_prev_tenants text[];
  v_prev_event_id bigint;
  v_prev_change timestamptz;
  v_prev_incident_started timestamptz;
  v_eval_keys text[];
  v_current_keys text[];
  v_eval_tenants text[];
  v_observed_tenants text[];
  v_opened text[];
  v_recovered text[];
  v_status text;
  v_fingerprint text;
  v_event_id bigint;
  v_notify_model boolean := false;
  v_changed boolean := false;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('clued_watchdog.projection_watchdog_tick',0)
  );

  select status,active_keys,observed_tenants,last_event_id,last_change_at,incident_started_at
  into v_prev_status,v_prev_keys,v_prev_tenants,v_prev_event_id,v_prev_change,v_prev_incident_started
  from clued_watchdog.projection_watchdog_state
  where singleton
  for update;

  v_prev_keys := coalesce(v_prev_keys,'{}'::text[]);
  v_prev_tenants := coalesce(v_prev_tenants,'{}'::text[]);

  v_eval := clued_watchdog.projection_watchdog_evaluate_snapshot_v2(
    clued_watchdog.projection_watchdog_snapshot(),
    v_now,
    v_prev_tenants
  );
  v_eval_status := v_eval->>'status';

  select coalesce(pg_catalog.array_agg(value order by value),'{}'::text[])
  into v_eval_keys
  from pg_catalog.jsonb_array_elements_text(coalesce(v_eval->'active_keys','[]'::jsonb));

  select coalesce(pg_catalog.array_agg(value order by value),'{}'::text[])
  into v_eval_tenants
  from pg_catalog.jsonb_array_elements_text(coalesce(v_eval->'current_tenants','[]'::jsonb));

  if v_eval_status = 'UNVERIFIED' then
    select coalesce(pg_catalog.array_agg(k order by k),'{}'::text[])
    into v_current_keys
    from (
      select unnest(v_prev_keys) as k
      union
      select unnest(v_eval_keys) as k
    ) q;
    v_observed_tenants := v_prev_tenants;
  else
    v_current_keys := v_eval_keys;
    select coalesce(pg_catalog.array_agg(k order by k),'{}'::text[])
    into v_observed_tenants
    from (
      select unnest(v_prev_tenants) as k
      union
      select unnest(v_eval_tenants) as k
    ) q;
  end if;

  select coalesce(pg_catalog.array_agg(k order by k),'{}'::text[])
  into v_opened
  from (
    select unnest(v_current_keys) as k
    except
    select unnest(v_prev_keys) as k
  ) q;

  select coalesce(pg_catalog.array_agg(k order by k),'{}'::text[])
  into v_recovered
  from (
    select unnest(v_prev_keys) as k
    except
    select unnest(v_current_keys) as k
  ) q;

  v_changed := pg_catalog.cardinality(v_opened)>0 or pg_catalog.cardinality(v_recovered)>0;
  v_notify_model := pg_catalog.cardinality(v_opened)>0;
  v_status := case when pg_catalog.cardinality(v_current_keys)>0 then 'ANOMALY' else 'OK' end;
  v_fingerprint := case
    when pg_catalog.cardinality(v_current_keys)=0 then null
    else pg_catalog.encode(
      extensions.digest(pg_catalog.to_jsonb(v_current_keys)::text,'sha256'),'hex'
    )
  end;

  if v_changed then
    insert into clued_watchdog.projection_watchdog_events(
      fingerprint,notify_model,payload
    )
    values(
      coalesce(v_fingerprint,'recovered'),
      v_notify_model,
      pg_catalog.jsonb_build_object(
        'schema','clued.projection-watchdog-event/v2',
        'status',v_status,
        'notify_model',v_notify_model,
        'fingerprint',v_fingerprint,
        'opened',pg_catalog.to_jsonb(v_opened),
        'recovered',pg_catalog.to_jsonb(v_recovered),
        'active',pg_catalog.to_jsonb(v_current_keys),
        'evaluation',v_eval
      )
    )
    returning id into v_event_id;
  end if;

  update clued_watchdog.projection_watchdog_state
  set status=v_status,
      last_fingerprint=v_fingerprint,
      active_keys=v_current_keys,
      observed_tenants=v_observed_tenants,
      incident_started_at=case
        when v_status='OK' then null
        when v_prev_status='ANOMALY' then coalesce(v_prev_incident_started,v_now)
        else v_now
      end,
      last_seen_at=v_now,
      last_change_at=case when v_changed then v_now else coalesce(v_prev_change,v_now) end,
      last_event_id=coalesce(v_event_id,v_prev_event_id),
      last_evaluation=v_eval,
      updated_at=v_now
  where singleton;

  return pg_catalog.jsonb_build_object(
    'schema','clued.projection-watchdog-tick/v2',
    'status',v_status,
    'notify_model',v_notify_model,
    'changed',v_changed,
    'event_id',v_event_id,
    'fingerprint',v_fingerprint,
    'opened',pg_catalog.to_jsonb(v_opened),
    'recovered',pg_catalog.to_jsonb(v_recovered),
    'active',pg_catalog.to_jsonb(v_current_keys),
    'evaluation',v_eval
  );
end
$function$;

revoke all on function clued_watchdog.projection_watchdog_evaluate_snapshot_v2(jsonb,timestamptz,text[])
  from public,anon,authenticated,service_role,clued_projection_watchdog;
revoke all on function clued_watchdog.projection_watchdog_evaluate()
  from public,anon,authenticated,service_role,clued_projection_watchdog;
revoke all on function clued_watchdog.projection_watchdog_tick()
  from public,anon,authenticated,service_role,clued_projection_watchdog;

do $cron$
begin
  if exists(
    select 1 from pg_catalog.pg_available_extensions where name='pg_cron'
  ) then
    execute 'create extension if not exists pg_cron';
    execute $schedule$
      select cron.schedule(
        'clued-projection-watchdog-hourly',
        '0 * * * *',
        'select clued_watchdog.projection_watchdog_tick();'
      )
    $schedule$;
  end if;
end
$cron$;
