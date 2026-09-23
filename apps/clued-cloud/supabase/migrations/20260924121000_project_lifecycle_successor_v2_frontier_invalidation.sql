-- Project Lifecycle Successor v2 Currentness forward fix.
--
-- The cutover changes the effective Project set consumed by the deterministic
-- MTPE Frontier source vector. The initial successor migration invalidated the
-- Project scopes and Global aggregate, but did not advance the dedicated
-- global.priority_frontier revision. Advance it once per affected owner so the
-- existing post-commit pipeline enqueues an audited rebuild.

insert into clued_private.projection_invalidation_heads(
  user_id,target_scope,projection_key,invalidation_revision,
  latest_source_ref,stale_since
)
select distinct d.user_id,'global','global.priority_frontier',1,
  jsonb_build_object(
    'kind','project_lifecycle_v2_cutover',
    'id','migration:20260924121000',
    'scope','global'
  ),now()
from clued_private.project_lifecycle_v2_dispositions d
on conflict(user_id,target_scope,projection_key) do update set
  invalidation_revision=
    clued_private.projection_invalidation_heads.invalidation_revision+1,
  latest_source_ref=excluded.latest_source_ref,
  stale_since=coalesce(
    clued_private.projection_invalidation_heads.stale_since,now()),
  updated_at=now();
