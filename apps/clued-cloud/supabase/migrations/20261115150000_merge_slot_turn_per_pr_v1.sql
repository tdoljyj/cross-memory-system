-- A merged pull request ends its claim's merge-slot turn (Task binding of
-- 20261108161615; Owner 2026-11-15, throughput defect A).
--
-- Until now, when a pull request of a Task merged (adopt) while the Task still
-- had another active pull request, work_claim_merge_slot_return_core_v1 kept
-- the claim's slot exactly as it was: every pull request of the claim shared
-- one turn, whose hard cap (merge_slot_hard_cap_seconds, 2 hours) counts from
-- when the claim became head. Production, 2026-11-15 (UTC): claim 96373a88
-- (#1117-#1126) joined at 10:46:03 (CI join for #1123), #1119 merged at
-- 11:46:55 with 59 minutes of that turn left, too little for the next front
-- batch, so the train refused it (TRAIN_FRONT_BUDGET_SHORT, "请让位子过期后
-- 重新入队") until the turn lapsed at 12:46:03; a lapsed entry is out for good,
-- and nothing joined again until the holder renewed by hand at 13:21:03.
-- Ninety-five minutes with every remaining pull request green and waiting.
--
-- Now the merge ends the turn: each live claim that served the merged pull
-- request and still has another active pull request of its Task leaves every
-- merge queue and joins again at the back, in one transaction, exactly as the
-- CI's merge_queue_join does for a lapsed claim (the merge refs are dropped
-- and put back; the stamp triggers record the leaving and start a new join:
-- merge_queued_at, merge_slot_taken_at and merge_slot_at now, no CI state, no
-- hard cap until the next touch). A claim alone in its queue is head again at
-- once with a whole turn; claims that were waiting go first. So a turn is one
-- landing, never a share of a turn. The slot is still not returned (the answer
-- names no returned claim, as before); a closed pull request and a claim
-- whose Task has no other active pull request are unchanged. One
-- WORK_CLAIM_MERGE_QUEUE_REJOINED receipt per claim.

create or replace function clued_private.work_claim_merge_slot_return_core_v1(
  p_user_id uuid,p_binding_id uuid,p_scope text,p_pr text,p_why text,p_ref jsonb
) returns uuid[] language plpgsql volatile security definer set search_path='' as $$
declare c clued_private.work_claims_v1%rowtype; v_refs text[]; v_now timestamptz:=pg_catalog.clock_timestamp();
begin
  if p_why in ('merged','closed') and exists(
    select 1 from clued_private.work_claim_pr_task_bindings_v1 t
    join public.clued_memories m on m.id=t.task_id and m.user_id=t.user_id
    where t.user_id=p_user_id and t.repo_id=lower(split_part(p_pr,'#',1))
      and t.pr_number=split_part(p_pr,'#',2)::bigint
      and coalesce(nullif(m.canonical_scope,''),case when m.project_id is null then 'global' else 'project:'||m.project_id::text end)=p_scope
      and exists(select 1 from clued_private.work_claim_pr_task_bindings_v1 other
        where other.user_id=t.user_id and other.task_id=t.task_id and other.repo_id=t.repo_id
          and other.pr_number<>t.pr_number and other.status='active')) then
    if p_why='merged' then
      for c in select * from clued_private.work_claims_v1 w
        where w.user_id=p_user_id and w.context_key=p_scope and clued_private.work_claim_pr_matches_v1(w,p_pr,false)
          and w.status in ('ACTIVE','DRAINING') and w.expires_at>v_now and w.merge_queued_at is not null
          and exists(select 1 from unnest(w.trigger_refs) t where lower(t) like 'merge:%')
        order by w.issued_at for update loop
        v_refs:=c.trigger_refs;
        update clued_private.work_claims_v1 set trigger_refs=array(select t from unnest(v_refs) t where lower(t) not like 'merge:%' order by t)
          where claim_id=c.claim_id;
        update clued_private.work_claims_v1 set trigger_refs=v_refs,updated_at=v_now
          where claim_id=c.claim_id returning * into c;
        insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
        values(c.user_id,p_binding_id,c.context_key,'work_claim_merge_queue_rejoin','work_claim',c.claim_id::text,c.fence,
          jsonb_build_object('receipt_kind','WORK_CLAIM_MERGE_QUEUE_REJOINED','claim_id',c.claim_id,'task_id',c.task_id,
            'fence',c.fence,'merged_pr',p_pr,'queued_at',c.merge_queued_at,'ref',coalesce(p_ref,'{}'::jsonb)));
      end loop;
    end if;
    return '{}'::uuid[];
  end if;
  return clued_private.work_claim_merge_slot_return_before_pr_task_v1(p_user_id,p_binding_id,p_scope,p_pr,p_why,p_ref);
end $$;
