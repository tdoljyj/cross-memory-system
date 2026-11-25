-- A claim is delivered while its Task's PR relation is open (Task e642d087,
-- FABLE-claim-cap-non-front-20261124 §0).
--
-- 20261122130000 freed a session's hand only for a relation the CI admission
-- had made 'active'. Behind the train front no CI run reaches a PR's first
-- stage, so its relation stays 'unknown' (written by the holder's own
-- authorize_head naming the PR) and three PRs waiting in the train still
-- refused a session its fourth claim (11-24). Whether a relation is open has
-- one answer, work_claim_pr_binding_open_v1 (20261122090000): 'unknown' says
-- only that the CI has not seen it yet. work_claim_in_hand_v1 now reads it.
--
-- Nothing is loosened beyond the session's self-reported group: the database
-- already takes the holder's authorize_head of a PR as the delivery
-- (20261112090000 pins the lease to the hard deadline on it); an 'unknown'
-- relation ends on the same GitHub merged/closed facts as an 'active' one
-- (webhook, the resident's reconcile, adopt; 20261119140000); and the Binding
-- cap (max_active_per_binding, 10) still counts every live claim.
--
-- The callers keep their text: work_claim_issue and
-- work_claim_free_handover_v1 call work_claim_in_hand_v1 (20261122130000), and
-- so read the new answer. The lease-key transfer of the renewal
-- (work_claim_renew_before_execution_v1, the key branch of 20261006120000) is
-- still reached through clued_work_renew_v1 and counted the receiving session
-- whole; it now counts the same way and its refusal carries the same
-- delivered and active_binding numbers as a claim's.

do $in_hand_callers$
begin
  if (select count(*) from pg_catalog.pg_proc p
      where p.oid in ('clued_private.work_claim_issue(public.clued_agent_bindings,jsonb,public.clued_memories,clued_private.work_claims_v1,text)'::regprocedure,
                      'clued_private.work_claim_free_handover_v1(text,jsonb)'::regprocedure)
        and position('clued_private.work_claim_in_hand_v1(' in p.prosrc)>0)<>2 then
    raise exception 'work_claim_in_hand_callers_changed' using errcode='22023';
  end if;
end $in_hand_callers$;

-- CREATE OR REPLACE keeps the signature, owner and ACL.
create or replace function clued_private.work_claim_in_hand_v1(p_user uuid,p_task uuid)
returns boolean language sql stable set search_path='' as $$
  select not exists(select 1 from clued_private.work_claim_pr_task_bindings_v1 t
    where t.user_id=p_user and t.task_id=p_task and clued_private.work_claim_pr_binding_open_v1(t.status))
$$;

-- Rewrite exact clauses of the renewal's current text. Each anchor must occur
-- exactly once, so an unknown successor stops the migration instead of being
-- patched blindly.
do $renew_key_in_hand$
declare
  patch record;
  definition text;
begin
  select pg_catalog.pg_get_functiondef(p.oid) into definition from pg_catalog.pg_proc p
    where p.oid='clued_private.work_claim_renew_before_execution_v1(text,jsonb)'::regprocedure
      and p.prosecdef and p.proconfig=array['search_path=""'];
  for patch in select * from (values
    (1,$a$  v_access text; v_from uuid; v_session text; v_active integer; v_active_session integer;$a$,
       $r$  v_access text; v_from uuid; v_session text; v_active integer; v_active_session integer; v_delivered_session integer;$r$),
    (2,$a$    select count(*)::integer,
           count(*) filter (where coalesce(w.holder_session_ref,'')=coalesce(v_session,''))::integer
      into v_active,v_active_session from clued_private.work_claims_v1 w$a$,
       $r$    -- The session counts only claims in hand, as at a new claim (20261124190000).
    select count(*)::integer,
           count(*) filter (where coalesce(w.holder_session_ref,'')=coalesce(v_session,'')
             and clued_private.work_claim_in_hand_v1(w.user_id,w.task_id))::integer,
           count(*) filter (where coalesce(w.holder_session_ref,'')=coalesce(v_session,'')
             and not clued_private.work_claim_in_hand_v1(w.user_id,w.task_id))::integer
      into v_active,v_active_session,v_delivered_session from clued_private.work_claims_v1 w$r$),
    (3,$a$'active',v_active_session,'holder_session_ref',v_session)); end if;$a$,
       $r$'active',v_active_session,'delivered',v_delivered_session,'active_binding',v_active,'holder_session_ref',v_session)); end if;$r$)
  ) p(step,anchor,replacement) order by step loop
    if definition is null
      or length(definition)-length(replace(definition,patch.anchor,'')) <> length(patch.anchor) then
      raise exception 'work_claim_renew_key_in_hand_source_changed: step %',patch.step using errcode='22023';
    end if;
    definition:=replace(definition,patch.anchor,patch.replacement);
  end loop;
  -- CREATE OR REPLACE keeps the owner and ACL; the complete definition keeps
  -- SECURITY DEFINER and the fixed search_path.
  execute definition;
  if (select position('clued_private.work_claim_in_hand_v1(' in p.prosrc) from pg_catalog.pg_proc p
      where p.oid='clued_private.work_claim_renew_before_execution_v1(text,jsonb)'::regprocedure)=0 then
    raise exception 'work_claim_renew_key_in_hand_not_applied' using errcode='22023';
  end if;
end $renew_key_in_hand$;

notify pgrst,'reload schema';
