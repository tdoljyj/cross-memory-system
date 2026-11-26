-- Resume checks both standing constraints and decisions newer than the checkpoint.
set local lock_timeout = '5s';

create index clued_memories_active_decision_scope_idx
  on public.clued_memories (user_id, canonical_scope, updated_at desc)
  where record_schema_version is not null and record_type = 'decision' and lifecycle_status = 'active';
