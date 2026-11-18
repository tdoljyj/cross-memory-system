-- Resume and checkpoint share this filter, including pre-schema work-log events.
set local lock_timeout = '5s';

create index clued_context_events_work_log_idx
  on public.clued_context_events (user_id, context_key, id)
  where audit_visibility = 'work_log' or (event_schema_version is null and audit_visibility is null);
