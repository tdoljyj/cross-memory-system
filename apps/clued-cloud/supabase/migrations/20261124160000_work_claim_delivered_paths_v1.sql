-- Repository paths are exclusive until delivery (PLAN-claim-write-set-granularity-20261124 §4;
-- WorkClaimAdmission v0.1 §4.3 rule 2).
--
-- A live claim that holds a live head authorization of its current execution
-- epoch (authorize_head succeeded: its change is, or is about to be, a pushed
-- pull request head) no longer blocks another claim on its repository paths.
-- From there git judges whether two pull requests collide (the push entrance,
-- GitHub, the train's merge) and the required checks on the merged tree judge
-- the rest; queueing by file name only made the second pull request wait.
--
-- Unchanged: the claim's write set, the admission coverage check, authorize_head,
-- same-Task and trigger conflicts, mechanical-file exemptions, and every
-- non-repository resource (storage:, record:, any kind registered later), which
-- stays exclusive for the claim's whole life. Only the already-live claim is
-- judged: a delivered claim that widens onto a path another claim holds
-- undelivered still conflicts.
--
-- An execution-epoch change revokes the claim's authorizations (the epoch
-- trigger of 20261011131755), so both conditions name the same rows; both are
-- written so neither alone is relied on.

-- The entries of a live claim's write set that still exclude other claims.
create function clued_private.work_claim_exclusive_resources_v1(c clued_private.work_claims_v1)
returns text[] language sql stable set search_path='' as $$
  select case when exists(select 1 from clued_private.work_claim_head_authorizations_v1 a
      where a.user_id=c.user_id and a.claim_id=c.claim_id
        and a.execution_epoch=c.execution_epoch and a.revoked_at is null)
    then coalesce((select array_agg(r order by r) from unnest(c.write_set) r
      -- A bare path (kind null) and a repo: resource are repository paths.
      where coalesce((clued_private.work_claim_resource_split(r))[1],'repo')<>'repo'),'{}'::text[])
    else c.write_set end
$$;
revoke all on function clued_private.work_claim_exclusive_resources_v1(clued_private.work_claims_v1)
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- The loop row is a local copy: narrowing its write_set changes what the
-- overlap below compares and nothing stored. The conflict entry reports the
-- computed overlap, never c.write_set.
do $delivered_paths$
declare body text; anchor text;
begin
  body:=pg_catalog.pg_get_functiondef('clued_private.work_claim_conflicts(uuid,uuid,text[],text[],uuid)'::regprocedure);
  anchor:='v_sibling:=v_open and c.task_id=p_task_id and c.copy_index is not null;';
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
    raise exception 'work_claim_delivered_paths_loop_unexpected'; end if;
  execute replace(body,anchor,
    'c.write_set:=clued_private.work_claim_exclusive_resources_v1(c);'||E'\n    '||anchor);
end $delivered_paths$;

notify pgrst,'reload schema';
