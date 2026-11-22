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
--    resident-node (or unspecified) ci-admission row that is not revoked,
--    started or not, and the resident has admitted a pull request head of
--    that repository for that branch before (a row of
--    work_claim_execution_admissions_v1). A row that has not started counts,
--    as binding_role_admits_v1 counts it as holding the role: in the five
--    minutes of a handover (binding_role_handover_core_v1, 20261031090000:
--    the old row revoked, the new one not started) the door admits nobody,
--    and nobody else may join either. Any other
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
-- 4. work_claim_merge_unmarked_sweep_v1(account, CI Binding, ref, receipt
--    fields): when the ref is served, every live claim of the account that
--    carries it without the CI's mark loses it (and any other unmarked served
--    merge ref it carries) through the trigger of item 2, with one
--    WORK_CLAIM_MERGE_QUEUE_UNADMITTED_REMOVED receipt per ref taken out.
--    Claims that would lose nothing are not written. The door calls it for
--    its ref on every merge_queue_join, after it has recorded the queue and
--    before it looks for the claim to join, so also when it then answers
--    head_not_admitted. This covers what the gate cannot see, because the
--    gate only looks when trigger_refs is written: an entry that joined
--    itself while the ref was not served yet and is still there after it
--    became served (the repository's first admission; an Owner who revoked
--    every resident row and marked a new one later; the granted branch of
--    phase 4 to 3, 20261105160000). The claim the door is about to join is
--    not exempt: if it joined itself before, it is taken out here and then
--    joined at the back with the mark, instead of answering already_queued
--    and losing its place silently at its next renewal. Its earlier join
--    time is not kept: that place was never the resident's.
-- 5. Rows that exist now: for every live claim (ACTIVE or DRAINING) and each
--    served merge ref it carries without a mark,
--    - when the claim holds an execution admission for its current execution
--      epoch, for a pull request bound to it, of the ref's repository and
--      target main, the mark is written (joined_at = the claim's join time):
--      the claim keeps its place and its join time. One
--      WORK_CLAIM_MERGE_QUEUE_CI_MARK_BACKFILLED receipt.
--    - otherwise the ref is taken out by the sweep of item 4 (the stamp
--      triggers record the leaving as for a renewal that drops the ref). One
--      WORK_CLAIM_MERGE_QUEUE_UNADMITTED_REMOVED receipt, naming this
--      migration. The claim, its lease and its other refs stay.
--    Keeping the place of an admitted entry is for this moment only, so that
--    a train under way is not interrupted; at run time item 4 keeps none.
--    The mark table holds one ref per claim (its primary key is claim_id), so
--    a claim that already has a mark for another ref cannot get a second one
--    and loses the unmarked ref. The same holds at run time: when the door
--    joins a claim for a second served repository, the mark is overwritten
--    and the first repository's ref is taken out by the gate in that same
--    update, without a receipt. A claim that keeps another merge ref after
--    one is taken out joins that other queue again at the back, as any change
--    of the set of merge refs does (20261009080000).
--
-- Not changed here (design 3.4): a claim the CI joined joins again for the
-- Task's next pull request after one merges, whether that head is admitted or
-- not; a claim moved to another execution epoch keeps its queue place.
-- tests/merge-queue-ci-join-only-db.test.mjs records both. Phase 4 (the train
-- lease, dormant: nothing calls it) decides who is on duty by the lease, not
-- by role rows: before it is enabled, item 1 has to move into ci_duty_*.
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
      where h->>'purpose' in ('resident-node','unspecified'))
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

-- Item 4. The caller holds the claim lock of p_user. p_binding: the CI
-- Binding that called the door (null for this migration). p_receipt: fields
-- added to each receipt. Returns how many refs were taken out.
create function clued_private.work_claim_merge_unmarked_sweep_v1(p_user uuid,p_binding uuid,p_ref text,p_receipt jsonb)
returns integer language plpgsql volatile security definer set search_path='' as $$
declare c clued_private.work_claims_v1%rowtype; v_ref text:=lower(p_ref); v_low text; v_after text[];
  v_now timestamptz:=pg_catalog.clock_timestamp(); v_count integer:=0;
begin
  if not clued_private.work_claim_merge_ref_served_v1(p_user,v_ref) then return 0; end if;
  for c in select w.* from clued_private.work_claims_v1 w
    where w.user_id=p_user and w.status in ('ACTIVE','DRAINING')
      and exists(select 1 from unnest(w.trigger_refs) t where lower(t)=v_ref)
      and not exists(select 1 from clued_private.work_claim_ci_merge_refs_v1 k
        where k.claim_id=w.claim_id and k.merge_ref=v_ref)
    order by w.merge_queued_at nulls last,w.claim_id for update loop
    -- Every writer of a queue records it first (20261031060000 item 3): each
    -- queue the gate is about to take this claim out of.
    for v_low in select distinct lower(t) from unnest(c.trigger_refs) t
      where t like 'merge:%' and clued_private.work_claim_merge_ref_served_v1(c.user_id,t)
        and not exists(select 1 from clued_private.work_claim_ci_merge_refs_v1 k
          where k.claim_id=c.claim_id and k.merge_ref=lower(t)) loop
      perform clued_private.work_claim_merge_front_sync_all_v1(c.user_id,'merge:'||split_part(v_low,':',2)||':');
    end loop;
    -- The gate takes the unmarked refs out.
    update clued_private.work_claims_v1 set trigger_refs=trigger_refs,updated_at=v_now
      where claim_id=c.claim_id returning trigger_refs into v_after;
    for v_low in select distinct lower(t) from unnest(c.trigger_refs) t
      where not exists(select 1 from unnest(v_after) a where lower(a)=lower(t)) order by 1 loop
      insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values(c.user_id,p_binding,c.context_key,'work_claim_merge_queue_unadmitted_leave','work_claim',c.claim_id::text,c.fence,
        jsonb_build_object('receipt_kind','WORK_CLAIM_MERGE_QUEUE_UNADMITTED_REMOVED','claim_id',c.claim_id,
          'task_id',c.task_id,'fence',c.fence,'execution_epoch',c.execution_epoch,'merge_ref',v_low,
          'queued_at',c.merge_queued_at)||coalesce(p_receipt,'{}'::jsonb));
      v_count:=v_count+1;
    end loop;
  end loop;
  return v_count;
end $$;

-- Item 3, before the trigger exists: the door writes its mark first. Item 4:
-- and sweeps its queue before it looks for the claim to join.
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
  a5 text:=$a$  perform clued_private.work_claim_merge_front_sync_all_v1(b.user_id,v_prefix);
$a$;
  v_sweep text:=$a$  -- An entry that joined itself before this ref was served leaves here, this call's own claim too (20261122130000 item 4).
  perform clued_private.work_claim_merge_unmarked_sweep_v1(b.user_id,b.id,v_ref,
    jsonb_build_object('reason','no_ci_join_mark','ci_binding_id',b.id));
$a$;
  anchor text;
begin
  body:=pg_catalog.pg_get_functiondef(
    'clued_private.work_claim_ci_queue_join_v1(public.clued_agent_bindings,jsonb)'::regprocedure);
  foreach anchor in array array[a1,a2,a3,a4,a5] loop
    if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
      raise exception 'merge_queue_ci_join_only_join_source_unexpected'; end if;
  end loop;
  execute replace(replace(replace(replace(replace(body,a1,a1||v_mark),a2,$a$    v_rejoin:=false;
$a$||v_mark||r2),a3,r3),a4,''),a5,a5||v_sweep);
end $ci_join_marks_first$;

create trigger work_claims_v1_merge_join_gate
  before insert or update of trigger_refs on clued_private.work_claims_v1
  for each row execute function clued_private.work_claim_merge_join_gate_v1();

-- Item 5.
do $existing_rows$
declare c clued_private.work_claims_v1%rowtype; v_ref text; v_low text; v_receipt uuid; r record;
  v_now timestamptz:=pg_catalog.clock_timestamp();
begin
  for c in select w.* from clued_private.work_claims_v1 w
    where w.status in ('ACTIVE','DRAINING')
      and exists(select 1 from unnest(w.trigger_refs) t where t like 'merge:%')
    order by w.user_id,w.merge_queued_at nulls last,w.claim_id loop
    perform clued_private.work_claim_lock(c.user_id);
    select * into c from clued_private.work_claims_v1 w where w.claim_id=c.claim_id for update;
    foreach v_ref in array clued_private.work_claim_merge_refs_v1(c.trigger_refs) loop
      v_low:=lower(v_ref);
      continue when not clued_private.work_claim_merge_ref_served_v1(c.user_id,v_low)
        or exists(select 1 from clued_private.work_claim_ci_merge_refs_v1 k where k.claim_id=c.claim_id)
        or not exists(select 1 from clued_private.work_claim_execution_admissions_v1 e
          where e.user_id=c.user_id and e.claim_id=c.claim_id and e.execution_epoch=c.execution_epoch
            and e.repository=split_part(v_low,':',2) and e.target_branch=split_part(v_low,':',3)
            and e.pr_ref is not null and clued_private.work_claim_pr_matches_v1(c,e.pr_ref));
      insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values(c.user_id,null,c.context_key,'work_claim_merge_queue_ci_mark_backfill','work_claim',c.claim_id::text,c.fence,
        jsonb_build_object('receipt_kind','WORK_CLAIM_MERGE_QUEUE_CI_MARK_BACKFILLED','claim_id',c.claim_id,
          'task_id',c.task_id,'fence',c.fence,'execution_epoch',c.execution_epoch,'merge_ref',v_low,
          'queued_at',c.merge_queued_at,'migration','20261122130000_merge_queue_ci_join_only_v1'))
      returning id into v_receipt;
      insert into clued_private.work_claim_ci_merge_refs_v1(claim_id,user_id,merge_ref,joined_at,receipt_id)
        values(c.claim_id,c.user_id,v_low,coalesce(c.merge_queued_at,v_now),v_receipt);
    end loop;
  end loop;
  -- What is still unmarked leaves, by the sweep the door uses from now on.
  for r in select distinct w.user_id,lower(t) ref from clued_private.work_claims_v1 w cross join lateral unnest(w.trigger_refs) t
    where w.status in ('ACTIVE','DRAINING') and t like 'merge:%'
      and clued_private.work_claim_merge_ref_served_v1(w.user_id,t) order by 1,2 loop
    perform clued_private.work_claim_lock(r.user_id);
    perform clued_private.work_claim_merge_unmarked_sweep_v1(r.user_id,null,r.ref,
      jsonb_build_object('reason','no_ci_join_mark_and_no_current_admission',
        'migration','20261122130000_merge_queue_ci_join_only_v1'));
  end loop;
end $existing_rows$;

-- Self-check: the door marks first in both branches and no longer afterwards,
-- and sweeps exactly once;
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
      or position('insert into public.clued_audit_receipts(id,user_id' in src)=0
      or (length(src)-length(replace(src,'work_claim_merge_unmarked_sweep_v1(','')))/length('work_claim_merge_unmarked_sweep_v1(')<>1 then
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
  clued_private.work_claim_merge_join_gate_v1(),
  clued_private.work_claim_merge_unmarked_sweep_v1(uuid,uuid,text,jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;

notify pgrst,'reload schema';
