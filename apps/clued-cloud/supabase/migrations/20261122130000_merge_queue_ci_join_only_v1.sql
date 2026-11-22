-- The merge queue of a repository the resident CI serves has one way in: the
-- CI door's merge_queue_join (Task 05ff5174; design
-- FABLE-merge-queue-head-20261122, option A).
--
-- Production 2026-11-22 (Beijing): the claim of #1227 was issued with
-- merge:tdoljyj/cross-memory-system:main in trigger_refs, as agent contract
-- A.6 told every agent to do. The stamp trigger
-- (work_claim_merge_slot_stamp_v1, 20261009080000) reads one thing, whether
-- trigger_refs holds a merge ref, and the queues (work_claim_merge_queue_v1
-- and _v2) order by join time: neither reads the pull request binding or the
-- execution admissions. So the claim was queued when it was issued and became
-- head with no bound pull request and no admitted head, and every admitted
-- pull request waited behind it. Its turn has no hard cap (the resident never
-- touches a claim it did not admit) and each renewal restarts the 45-minute
-- renewal clock, so it could stay until the 24-hour lease deadline. A person
-- cleared it by renewing with trigger_refs=[].
--
-- The same queue had two ways in. The CI door (work_claim_ci_queue_join_v1,
-- 20261105120000) joins a claim only when it is bound to the pull request,
-- live, and holds an execution admission of that head for its current
-- execution epoch. The holder's own way checked nothing, and six write paths
-- used it: a claim issued with the ref, a takeover that inherits the refs of
-- the claim it replaces, a renewal that adds the ref or sends it while lapsed
-- or out, a head's renewal that keeps its place, and any change of the set of
-- merge refs.
--
-- Now, for a merge ref of a served repository, a claim keeps the ref in
-- trigger_refs only while work_claim_ci_merge_refs_v1 holds the CI's mark of
-- that ref for that claim. That table (20261105120000) already meant "the CI
-- added this ref"; it becomes what admits the ref.
--
-- 1. work_claim_merge_ref_served_v1(account, ref): the ref is
--    merge:<repository>:<branch> with the branch the repository's pull
--    requests merge into (work_claim_served_target_v1), the account has a
--    resident-node (or unspecified) ci-admission row in force, and the
--    resident has admitted a pull request head of that repository for that
--    branch before (a row of work_claim_execution_admissions_v1). Any other
--    merge ref stays as open as it was: an account without a resident, a
--    repository the resident never admitted, another branch. This is what
--    binding_role_admits_v1 does for an account without a ci-admission row.
-- 2. work_claim_merge_join_gate_v1, a BEFORE INSERT OR UPDATE OF trigger_refs
--    trigger on work_claims_v1 named to run before the stamp trigger
--    (work_claims_v1_merge_join_gate < work_claims_v1_merge_slot_stamp): it
--    takes every served merge ref without the CI's mark out of
--    new.trigger_refs. Nothing is raised: a client that still sends the ref
--    gets its claim or renewal, without the queue place, and the answer shows
--    trigger_refs and merge_queue as stored. One rule at the only place the
--    refs are written covers all six paths and any later one.
--    Leaving is unchanged: a renewal whose list does not hold the ref leaves
--    the queue, and work_claim_ci_refs_cleanup_v1 (20261106093215) deletes
--    the mark, so the ref comes back only through the CI door. The queue's
--    own rejoins (work_claim_merge_rejoin_v1: a merged pull request, the hard
--    cap, a yield) drop and restore the refs inside one transaction with the
--    mark in place, so a claim the CI joined still rejoins; a ref without a
--    mark could not be restored, and after this migration there is none.
-- 3. work_claim_ci_queue_join_v1 writes the mark before it changes
--    trigger_refs (it wrote it afterwards), and also when it joins again a
--    ref the claim already carries (it wrote none then). The receipt id is
--    chosen first so that the mark can name its receipt; the receipt itself
--    is unchanged. Nothing else of the function moves. Its predecessor body
--    is checked by md5 and every anchor must occur exactly once.
-- 4. Rows that exist now: for every live claim (ACTIVE or DRAINING) and each
--    served merge ref it carries without a mark,
--    - when the claim holds an execution admission for its current execution
--      epoch, for a pull request bound to it, of the ref's repository and
--      target main, the mark is written (joined_at = the claim's join time):
--      the claim keeps its place and its join time. One
--      WORK_CLAIM_MERGE_QUEUE_CI_MARK_BACKFILLED receipt.
--    - otherwise the ref is taken out, through the trigger of item 2 (the
--      stamp triggers record the leaving as for a renewal that drops the ref).
--      One WORK_CLAIM_MERGE_QUEUE_UNADMITTED_REMOVED receipt. The claim, its
--      lease and its other refs stay.
--    The mark table holds one ref per claim (its primary key is claim_id), so
--    a claim that already has a mark for another ref cannot get a second one
--    and loses the unmarked ref. A claim that keeps another merge ref after
--    one is taken out joins that other queue again at the back, as any change
--    of the set of merge refs does (20261009080000).
--
-- Not changed here (design 3.4): a claim the CI joined joins again for the
-- Task's next pull request after one merges, whether that head is admitted or
-- not; a claim moved to another execution epoch keeps its queue place.
-- tests/merge-queue-ci-join-only-db.test.mjs records both.
--
-- No node change: the resident already joins through the door only (stage 8,
-- and ADR 0016 for a new head). No new anon or Worker RPC: CI8 and GW80 are
-- unchanged.
--
-- Side effect, as 20261031060000 (header item 3) had: creating a trigger on
-- work_claims_v1 fires the R9 clock-source DDL observer
-- (clock_source_ddl_candidate_v1, 20261011113259): every open clock-source
-- epoch is marked ddl_tainted and its seals are no longer candidate_ready.
-- The stamp trigger and both queue functions are untouched, so the measured
-- source digest of merge measurement (20261011033947) does not change.

do $predecessor$
begin
  if not exists(select 1 from pg_catalog.pg_proc p
      where p.oid=pg_catalog.to_regprocedure('clued_private.work_claim_ci_queue_join_v1(public.clued_agent_bindings,jsonb)')
        and pg_catalog.md5(p.prosrc)='30e56a5ed3a95a110577344cb2ad8f18') then
    raise exception 'merge_queue_ci_join_only_predecessor_mismatch: work_claim_ci_queue_join_v1';
  end if;
end $predecessor$;

-- Item 1. p_ref in any spelling: the queues match merge refs without case.
create function clued_private.work_claim_merge_ref_served_v1(p_user uuid,p_ref text) returns boolean
language sql stable security definer set search_path='' as $$
  select r.repo<>'' and r.ref='merge:'||r.repo||':'||r.branch
    and r.branch=clued_private.work_claim_served_target_v1(r.repo)
    and exists(select 1 from jsonb_array_elements(
        clued_private.binding_role_holders_v1(p_user,'ci-admission','{}'::uuid[])) h
      where h->>'purpose' in ('resident-node','unspecified')
        and clued_private.binding_role_in_force_v1(p_user,(h->>'binding_id')::uuid,'ci-admission'))
    and exists(select 1 from clued_private.work_claim_execution_admissions_v1 e
      where e.user_id=p_user and e.repository=r.repo and e.target_branch=r.branch)
  from (select lower(p_ref) ref,split_part(lower(p_ref),':',2) repo,split_part(lower(p_ref),':',3) branch) r
$$;

-- Item 2. Refs keep their order and spelling; only unmarked served merge
-- refs go.
create function clued_private.work_claim_merge_join_gate_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_kept text[];
begin
  if not exists(select 1 from unnest(new.trigger_refs) t where t like 'merge:%') then return new; end if;
  select coalesce(array_agg(x.t order by x.n),'{}'::text[]) into v_kept
    from unnest(new.trigger_refs) with ordinality x(t,n)
    where x.t not like 'merge:%'
      or exists(select 1 from clued_private.work_claim_ci_merge_refs_v1 k
        where k.claim_id=new.claim_id and k.merge_ref=lower(x.t))
      or not clued_private.work_claim_merge_ref_served_v1(new.user_id,x.t);
  if cardinality(v_kept)<cardinality(new.trigger_refs) then new.trigger_refs:=v_kept; end if;
  return new;
end $$;

-- Item 3, before the trigger exists: the door writes its mark first.
do $ci_join_marks_first$
declare body text;
  v_mark text:=$a$    -- The CI's mark first: the join gate keeps the ref only with it (20261122130000).
    v_receipt:=extensions.gen_random_uuid();
    insert into clued_private.work_claim_ci_merge_refs_v1(claim_id,user_id,merge_ref,joined_at,receipt_id)
      values(c.claim_id,c.user_id,v_ref,v_now,v_receipt)
      on conflict (claim_id) do update set merge_ref=excluded.merge_ref,joined_at=excluded.joined_at,
        receipt_id=excluded.receipt_id;
$a$;
  a1 text:=$a$    v_rejoin:=true;
    v_refs:=c.trigger_refs;
$a$;
  a2 text:=$a$    v_rejoin:=false;
    update clued_private.work_claims_v1
$a$;
  r2 text:=$a$    update clued_private.work_claims_v1
$a$;
  a3 text:=$a$  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(c.user_id,b.id,c.context_key,'work_claim_merge_queue_join_by_ci','work_claim',c.claim_id::text,c.fence,
$a$;
  r3 text:=$a$  insert into public.clued_audit_receipts(id,user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(v_receipt,c.user_id,b.id,c.context_key,'work_claim_merge_queue_join_by_ci','work_claim',c.claim_id::text,c.fence,
$a$;
  a4 text:=$a$  -- Only a ref the CI added is the CI's. Rejoining a ref already on the claim
  -- keeps whatever it was: the holder's own stays the holder's, and a CI row
  -- is left as it is.
  if not v_rejoin then
    insert into clued_private.work_claim_ci_merge_refs_v1(claim_id,user_id,merge_ref,joined_at,receipt_id)
      values(c.claim_id,c.user_id,v_ref,v_now,v_receipt)
      on conflict (claim_id) do update set merge_ref=excluded.merge_ref,joined_at=excluded.joined_at,
        receipt_id=excluded.receipt_id;
  end if;
$a$;
  anchor text;
begin
  body:=pg_catalog.pg_get_functiondef(
    'clued_private.work_claim_ci_queue_join_v1(public.clued_agent_bindings,jsonb)'::regprocedure);
  foreach anchor in array array[a1,a2,a3,a4] loop
    if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
      raise exception 'merge_queue_ci_join_only_join_source_unexpected'; end if;
  end loop;
  execute replace(replace(replace(replace(body,a1,a1||v_mark),a2,$a$    v_rejoin:=false;
$a$||v_mark||r2),a3,r3),a4,'');
end $ci_join_marks_first$;

create trigger work_claims_v1_merge_join_gate
  before insert or update of trigger_refs on clued_private.work_claims_v1
  for each row execute function clued_private.work_claim_merge_join_gate_v1();

-- Item 4.
do $existing_rows$
declare c clued_private.work_claims_v1%rowtype; v_ref text; v_low text; v_receipt uuid;
  v_gone text[]; v_now timestamptz:=pg_catalog.clock_timestamp();
begin
  for c in select w.* from clued_private.work_claims_v1 w
    where w.status in ('ACTIVE','DRAINING')
      and exists(select 1 from unnest(w.trigger_refs) t where t like 'merge:%')
    order by w.user_id,w.merge_queued_at nulls last,w.claim_id loop
    perform clued_private.work_claim_lock(c.user_id);
    select * into c from clued_private.work_claims_v1 w where w.claim_id=c.claim_id for update;
    v_gone:='{}'::text[];
    foreach v_ref in array clued_private.work_claim_merge_refs_v1(c.trigger_refs) loop
      v_low:=lower(v_ref);
      continue when not clued_private.work_claim_merge_ref_served_v1(c.user_id,v_low)
        or exists(select 1 from clued_private.work_claim_ci_merge_refs_v1 k
          where k.claim_id=c.claim_id and k.merge_ref=v_low);
      if not exists(select 1 from clued_private.work_claim_ci_merge_refs_v1 k where k.claim_id=c.claim_id)
        and exists(select 1 from clued_private.work_claim_execution_admissions_v1 e
          where e.user_id=c.user_id and e.claim_id=c.claim_id and e.execution_epoch=c.execution_epoch
            and e.repository=split_part(v_low,':',2) and e.target_branch=split_part(v_low,':',3)
            and e.pr_ref is not null and clued_private.work_claim_pr_matches_v1(c,e.pr_ref)) then
        insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
        values(c.user_id,null,c.context_key,'work_claim_merge_queue_ci_mark_backfill','work_claim',c.claim_id::text,c.fence,
          jsonb_build_object('receipt_kind','WORK_CLAIM_MERGE_QUEUE_CI_MARK_BACKFILLED','claim_id',c.claim_id,
            'task_id',c.task_id,'fence',c.fence,'execution_epoch',c.execution_epoch,'merge_ref',v_low,
            'queued_at',c.merge_queued_at,'migration','20261122130000_merge_queue_ci_join_only_v1'))
        returning id into v_receipt;
        insert into clued_private.work_claim_ci_merge_refs_v1(claim_id,user_id,merge_ref,joined_at,receipt_id)
          values(c.claim_id,c.user_id,v_low,coalesce(c.merge_queued_at,v_now),v_receipt);
      else
        v_gone:=v_gone||v_low;
      end if;
    end loop;
    continue when cardinality(v_gone)=0;
    -- Every writer of a queue records it first (20261031060000 item 3).
    foreach v_low in array v_gone loop
      perform clued_private.work_claim_merge_front_sync_all_v1(c.user_id,'merge:'||split_part(v_low,':',2)||':');
    end loop;
    -- The gate takes the unmarked refs out.
    update clued_private.work_claims_v1 set trigger_refs=trigger_refs,updated_at=v_now where claim_id=c.claim_id;
    foreach v_low in array v_gone loop
      insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values(c.user_id,null,c.context_key,'work_claim_merge_queue_unadmitted_leave','work_claim',c.claim_id::text,c.fence,
        jsonb_build_object('receipt_kind','WORK_CLAIM_MERGE_QUEUE_UNADMITTED_REMOVED','claim_id',c.claim_id,
          'task_id',c.task_id,'fence',c.fence,'execution_epoch',c.execution_epoch,'merge_ref',v_low,
          'queued_at',c.merge_queued_at,'reason','no_ci_join_mark_and_no_current_admission',
          'migration','20261122130000_merge_queue_ci_join_only_v1'));
    end loop;
  end loop;
end $existing_rows$;

-- Self-check: the door marks first in both branches and no longer afterwards;
-- no live claim carries a served merge ref without its mark. The database
-- tests replay every migration, so a later redefinition of the door from
-- older text fails there.
do $join_only_selfcheck$
declare src text;
begin
  select p.prosrc into src from pg_catalog.pg_proc p
    where p.oid='clued_private.work_claim_ci_queue_join_v1(public.clued_agent_bindings,jsonb)'::regprocedure;
  if (length(src)-length(replace(src,'v_receipt:=extensions.gen_random_uuid();','')))/length('v_receipt:=extensions.gen_random_uuid();')<>2
      or position('if not v_rejoin then' in src)>0
      or position('insert into public.clued_audit_receipts(id,user_id' in src)=0 then
    raise exception 'merge_queue_ci_join_only_selfcheck_failed: door';
  end if;
  if exists(select 1 from clued_private.work_claims_v1 w cross join lateral unnest(w.trigger_refs) t
      where w.status in ('ACTIVE','DRAINING') and t like 'merge:%'
        and clued_private.work_claim_merge_ref_served_v1(w.user_id,t)
        and not exists(select 1 from clued_private.work_claim_ci_merge_refs_v1 k
          where k.claim_id=w.claim_id and k.merge_ref=lower(t))) then
    raise exception 'merge_queue_ci_join_only_selfcheck_failed: an unmarked served merge ref is left';
  end if;
end $join_only_selfcheck$;

revoke all on function
  clued_private.work_claim_merge_ref_served_v1(uuid,text),
  clued_private.work_claim_merge_join_gate_v1()
  from public,anon,authenticated,service_role,clued_worker_gateway;

notify pgrst,'reload schema';
