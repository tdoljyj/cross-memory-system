-- The session cap counts only claims in hand (Task e642d087,
-- FABLE-claim-cap-train-20261122 §1).
--
-- max_active_per_session (20261002060001) keeps one runaway host from taking
-- every Task. A claim in hand is moved on by its Agent; that is what the cap
-- limits. A claim whose Task has a PR the CI admission has seen open
-- (work_claim_pr_task_bindings_v1.status='active', written only by the CI's
-- write resolve, 20261108161615) waits on the CI, and it ends only on
-- GitHub's merged/closed fact (20261119140000), so no host can make one up.
-- Counting it made a session with three PRs in the train unable to start a
-- fourth piece of work (10-02 and 11-22).
--
-- Only 'active' frees a hand: 'unknown' comes from the holder's own
-- authorize_head. No current head authorization is asked for on top: the
-- database does not know a PR's present head, and the 'active' relation is
-- the CI's fact already. The Binding cap (max_active_per_binding, 10) still
-- counts every live claim, so delivered claims stay bounded per Binding.
-- Nothing else changes: the same two counts at issue (work_claim_issue) and
-- at accepting a handover (work_claim_free_handover_v1), the same limits, the same
-- order. The session refusal also says how many of the session's live claims
-- are delivered.

create function clued_private.work_claim_in_hand_v1(p_user uuid,p_task uuid)
returns boolean language sql stable set search_path='' as $$
  select not exists(select 1 from clued_private.work_claim_pr_task_bindings_v1 t
    where t.user_id=p_user and t.task_id=p_task and t.status='active')
$$;
revoke all on function clued_private.work_claim_in_hand_v1(uuid,uuid)
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- Rewrite exact clauses of each function's current text. Each anchor must
-- occur exactly once, so an unknown successor stops the migration instead of
-- being patched blindly.
do $session_cap_in_hand$
declare
  patch record;
  definition text;
begin
  for patch in select * from (values
    (1,'clued_private.work_claim_issue(public.clued_agent_bindings,jsonb,public.clued_memories,clued_private.work_claims_v1,text)'::regprocedure,
     $a$  v_cont jsonb; v_hard timestamptz;$a$,
     $r$  v_cont jsonb; v_hard timestamptz; v_delivered_session integer;$r$),
    (2,'clued_private.work_claim_issue(public.clued_agent_bindings,jsonb,public.clued_memories,clued_private.work_claims_v1,text)'::regprocedure,
     $a$  -- all sessions of one Binding together at most max_active_per_binding.
  select count(*)::integer,
         count(*) filter (where coalesce(w.holder_session_ref,'')=coalesce(v_session,''))::integer
    into v_active,v_active_session from clued_private.work_claims_v1 w$a$,
     $r$  -- all sessions of one Binding together at most max_active_per_binding.
  -- The session counts only claims in hand: one whose Task has a PR the CI
  -- has seen open is delivered (20261122130000). The Binding counts all.
  select count(*)::integer,
         count(*) filter (where coalesce(w.holder_session_ref,'')=coalesce(v_session,'')
           and clued_private.work_claim_in_hand_v1(w.user_id,w.task_id))::integer,
         count(*) filter (where coalesce(w.holder_session_ref,'')=coalesce(v_session,'')
           and not clued_private.work_claim_in_hand_v1(w.user_id,w.task_id))::integer
    into v_active,v_active_session,v_delivered_session from clued_private.work_claims_v1 w$r$),
    (3,'clued_private.work_claim_issue(public.clued_agent_bindings,jsonb,public.clued_memories,clued_private.work_claims_v1,text)'::regprocedure,
     $a$'active',v_active_session,'active_binding',v_active,'holder_session_ref',v_session));$a$,
     $r$'active',v_active_session,'delivered',v_delivered_session,'active_binding',v_active,'holder_session_ref',v_session));$r$),
    (4,'clued_private.work_claim_free_handover_v1(text,jsonb)'::regprocedure,
     $a$count(*) filter(where holder_session_ref is not distinct from r.receiver_session_ref)::integer$a$,
     $r$count(*) filter(where holder_session_ref is not distinct from r.receiver_session_ref
      and clued_private.work_claim_in_hand_v1(work_claims_v1.user_id,work_claims_v1.task_id))::integer$r$)
  ) p(step,target,anchor,replacement) order by step loop
    select pg_catalog.pg_get_functiondef(p.oid) into definition from pg_catalog.pg_proc p
      where p.oid=patch.target and p.prosecdef and p.proconfig=array['search_path=""'];
    if definition is null
      or length(definition)-length(replace(definition,patch.anchor,'')) <> length(patch.anchor) then
      raise exception 'work_claim_session_cap_in_hand_source_changed: % step %',patch.target,patch.step using errcode='22023';
    end if;
    -- CREATE OR REPLACE keeps the owner and ACL; the complete definition keeps
    -- SECURITY DEFINER and the fixed search_path.
    execute replace(definition,patch.anchor,patch.replacement);
  end loop;
  if (select count(*) from pg_catalog.pg_proc p
      where p.oid in ('clued_private.work_claim_issue(public.clued_agent_bindings,jsonb,public.clued_memories,clued_private.work_claims_v1,text)'::regprocedure,
                      'clued_private.work_claim_free_handover_v1(text,jsonb)'::regprocedure)
        and position('clued_private.work_claim_in_hand_v1(' in p.prosrc)>0)<>2 then
    raise exception 'work_claim_session_cap_in_hand_not_applied' using errcode='22023';
  end if;
end $session_cap_in_hand$;

notify pgrst,'reload schema';
