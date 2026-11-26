-- The server refuses manual release while a claim still serves an open pull request, and every claim answer says
-- which pull requests of its Task are open (PLAN-claim-pr-binding-20261125 §3 commit B, aligned with #1360).
--
-- A pull request is bound to its Task (20261108161615). Head authorizations belong to the claim: once it is released
-- and the Task claimed again, they are obsolete and an open pull request that used them answers head_not_authorized
-- (#1320, #1325, #1326 on 11-25). clued_work_release_v1 never looked
-- at the Task's pull requests; only the holder's local ledger did, with one PR per claim and for `abandoned` alone.
--
--   1. clued_work_release_v1 answers work_claim_release_pr_open, with open_prs and the claim, for completed, abandoned
--      and draining alike, while all three hold:
--        * the Task has an open pull request relation ('active' or 'unknown') that this claim served;
--        * the claim is the Task's only live claim (another live copy of a race still serves the pull requests);
--        * the claim's hard deadline is at least two hours away (after that the claim changes anyway).
--      A refused release writes nothing. The pull request's end releases the claim (work_claim_pr_end_release_v1,
--      unchanged); the resident's lifecycle report (20261119140000) already ends 'unknown' relations as well as 'active'
--      ones and lists both as tracked, so a closed pull request the CI never admitted does not hold a claim.
--   2. work_claim_view gains open_prs: [{pr_ref, status, covered, served}], one entry per open relation of the claim's Task.
--      served: this claim authorized with the PR ref or was admitted for it in CI. Manual and PR-end release share
--      work_claim_pr_served_at_v1 from 20261126035400. An authorization without a PR ref and without a CI admission
--      for that PR does not count as service and does not block manual release.
--      covered: the claim is live and its current execution epoch holds an unrevoked pull-request authorization that
--      names this pull request, or one (naming no pull request) of the head last authorized or admitted for it by any
--      claim of the Task. Every answer built from the view carries it: claim, renew, takeover, release,
--      active_work_claims. bound_prs keeps its reading ('active' only).
--   3. authorize_head's committed answer carries the claim view, read after the authorization, its relation and the
--      lease pin are written.
--
-- Each rewritten function is bound by the hash of its current body and one exact anchor (as 20261122090000), so an
-- unknown successor stops the migration instead of being patched blindly.

create function clued_private.work_claim_open_prs_v1(c clued_private.work_claims_v1)
returns jsonb language sql stable set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('pr_ref',o.pr,'status',o.status,'covered',o.covered,'served',o.served)
      order by o.repo_id,o.pr_number),'[]'::jsonb)
  from (
    select t.repo_id,t.pr_number,p.pr,t.status,clued_private.work_claim_pr_served_at_v1(c,p.pr) is not null served,
      (c.status in ('ACTIVE','DRAINING') and c.expires_at>pg_catalog.clock_timestamp()
        and exists(select 1 from clued_private.work_claim_head_authorizations_v1 a
          where a.user_id=c.user_id and a.claim_id=c.claim_id and a.execution_epoch=c.execution_epoch
            and a.revoked_at is null and a.workflow is null and a.repository=t.repo_id
            and (lower(a.pr_ref)=p.pr or (a.pr_ref is null and a.head_sha=(
              select x.head_sha from (
                select h.head_sha,h.issued_at at from clued_private.work_claim_head_authorizations_v1 h
                  join clued_private.work_claims_v1 w on w.user_id=h.user_id and w.claim_id=h.claim_id
                  where w.user_id=c.user_id and w.task_id=c.task_id and lower(h.pr_ref)=p.pr
                union all
                select e.head_sha,e.created_at from clued_private.work_claim_execution_admissions_v1 e
                  join clued_private.work_claims_v1 w on w.user_id=e.user_id and w.claim_id=e.claim_id
                  where w.user_id=c.user_id and w.task_id=c.task_id and lower(e.pr_ref)=p.pr) x
              order by x.at desc,x.head_sha limit 1))))) covered
    from clued_private.work_claim_pr_task_bindings_v1 t
    cross join lateral (select t.repo_id||'#'||t.pr_number::text pr) p
    where t.user_id=c.user_id and t.task_id=c.task_id and clued_private.work_claim_pr_binding_open_v1(t.status)) o
$$;

-- Whether the holder's release of this claim is refused at p_now. The two hours are the window in which a claim that is
-- about to reach its hard deadline may be exchanged for a new one.
create function clued_private.work_claim_release_pr_open_v1(c clued_private.work_claims_v1,p_now timestamptz)
returns boolean language sql stable set search_path='' as $$
  select c.hard_deadline_at-p_now>=interval '2 hours'
    and exists(select 1 from clued_private.work_claim_pr_task_bindings_v1 t
      where t.user_id=c.user_id and t.task_id=c.task_id and clued_private.work_claim_pr_binding_open_v1(t.status)
        and clued_private.work_claim_pr_served_at_v1(c,t.repo_id||'#'||t.pr_number::text) is not null)
    and not exists(select 1 from clued_private.work_claims_v1 w
      where w.user_id=c.user_id and w.task_id=c.task_id and w.claim_id<>c.claim_id
        and w.status='ACTIVE' and w.expires_at>p_now)
$$;

revoke all on function clued_private.work_claim_open_prs_v1(clued_private.work_claims_v1),
  clued_private.work_claim_release_pr_open_v1(clued_private.work_claims_v1,timestamptz)
  from public,anon,authenticated,service_role,clued_worker_gateway;

do $release_pr_open$
declare
  patch record;
  definition text;
begin
  for patch in select * from (values
    -- The refusal sits after the holder, state and fence checks and before either write.
    ('public.clued_work_release_v1(text,jsonb)'::regprocedure,
     'a2895b5d3cacd448ada5b45e2ee67c55f8376cb56ab118401767252ca4b37de0',
     $a$  if v_outcome='draining' then$a$,
     $r$  if clued_private.work_claim_release_pr_open_v1(c,v_now) then
    return clued_private.work_claim_rejected('work_claim_release_pr_open',
      jsonb_build_object('open_prs',clued_private.work_claim_open_prs_v1(c),
        'claim',clued_private.work_claim_view(c))); end if;
  if v_outcome='draining' then$r$,
     'clued_private.work_claim_release_pr_open_v1('),
    ('clued_private.work_claim_view(clued_private.work_claims_v1)'::regprocedure,
     'e444d468bfd4c3ae949ef118dd574bc6074ab3d00c6383912fb6c525ca0eff0a',
     $a$'continued_from',c.continued_from)$a$,
     $r$'continued_from',c.continued_from,'open_prs',clued_private.work_claim_open_prs_v1(c))$r$,
     'clued_private.work_claim_open_prs_v1('),
    ('clued_private.work_claim_authorize_head_before_served_target_v1(text,jsonb)'::regprocedure,
     '3e992c1ae13bb14e84854640816335ef3700490057e844ee724c6fb2fef4d05e',
     $a$return result||jsonb_build_object('expires_at',c.expires_at,'hard_deadline_at',c.hard_deadline_at);$a$,
     $r$return result||jsonb_build_object('expires_at',c.expires_at,'hard_deadline_at',c.hard_deadline_at,'claim',clued_private.work_claim_view(c));$r$,
     'clued_private.work_claim_view(c)')
  ) p(target,body_sha256,anchor,replacement,applied) loop
    definition:=null;
    select pg_catalog.pg_get_functiondef(p.oid) into definition from pg_catalog.pg_proc p
      where p.oid=patch.target
        and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=patch.body_sha256
        and p.proconfig=array['search_path=""']
        and pg_catalog.pg_get_userbyid(p.proowner)='postgres';
    if definition is null
      or length(definition)-length(replace(definition,patch.anchor,'')) <> length(patch.anchor) then
      raise exception 'work_claim_release_pr_open_source_changed: %',patch.target using errcode='22023';
    end if;
    -- CREATE OR REPLACE keeps the owner and ACL; the complete definition keeps
    -- the security mode, volatility and the fixed search_path.
    execute replace(definition,patch.anchor,patch.replacement);
    if position(patch.applied in
        (select p.prosrc from pg_catalog.pg_proc p where p.oid=patch.target))=0 then
      raise exception 'work_claim_release_pr_open_not_applied: %',patch.target using errcode='22023';
    end if;
  end loop;
end $release_pr_open$;

notify pgrst,'reload schema';
