-- Resident CI assist: the CI admission Binding may put a pull request's claim
-- into its merge queue and extend that claim's lease (Clued Decision "第 12 代
-- ‘推送后全自动’设计决定": decision 1 = A, decision 2 approved; Owner Decision
-- 207c0cd0 v3 for the door, the epoch-bound admission and the two renewal
-- rules).
--
-- Until now only the claim's holder (its Binding or its private lease_key, with
-- a new progress_ref) could join the merge queue merge:<owner>/<repo>:main or
-- extend the lease, through clued_work_renew. The resident CI runs every stage
-- of a pull request but is not the holder, so a pull request whose stages 1-7
-- passed stalled at stage 8 (RESIDENT_MERGE_QUEUE_NOT_JOINED) until a human
-- renewed, and a lease could run out while the CI batch was still running.
--
-- Two new actions of the existing CI command door (clued_work_verify_v1 ->
-- clued_private.work_claim_ci_command_v1), the way merge_queue_keepalive was
-- added (20261031060000): CI8 and GW80 are unchanged, there is no new anon or
-- Worker RPC. They run behind the door's own checks: the caller is the
-- Owner's CI admission Binding whose ci-admission row has started and is not
-- revoked (a standby node that is not on duty has no such row), and the claim
-- lock is held. As for touch/adopt/return/keepalive the row's purpose must be
-- resident-node or unspecified (merge_slot_admits_v1). Every refusal of the
-- caller is the door's {status: rejected, error_code:
-- admission_binding_required}; malformed input raises
-- work_claim_ci_command_invalid (22023), as for every door action.
--
-- The claim both actions act for: the claim of `scope` bound to exactly
-- pr_ref (bound_pr) that is live (ACTIVE, lease not run out, no handover
-- pending, not superseded by a newer fence of its Task, not a copy out of the
-- race) and holds an execution admission for its CURRENT execution epoch,
-- that head_sha (40 hex), that pr_ref, the repository of pr_ref and target
-- branch main. clued_work_verify_v1 records that admission when it admits a
-- pull request head for the CI admission Binding (with target_branch), and an
-- Owner handover moves the epoch, so a batch revoked by a handover can
-- neither join nor extend. Otherwise the answer names why: claim_not_bound
-- (no claim of the scope is bound to pr_ref), claim_not_live (none of them is
-- live) or head_not_admitted (a live one, but no such admission).
-- There is no Owner Grant condition here (Owner Decision 207c0cd0 v4): the
-- server trusts the admission check. The resident joins only a head that its
-- stage 8 has evaluated again and that passed the Owner review where one is
-- required; joining is not merging, and merging still needs the required
-- checks, which themselves require the Grant where one is needed.
--
-- 1. action merge_queue_join, input {action, scope, pr_ref: "owner/repo#N",
--    head_sha}. The claim joins merge:<owner>/<repo>:main at the back,
--    exactly as a holder renewal that adds or keeps the ref joins:
--    - without the ref, the ref is added to trigger_refs (the stamp triggers
--      join it; a claim that already had another merge ref joins every queue
--      again, as any change of merge refs does); a claim that already holds
--      the 50 trigger refs a claim may hold is refused with trigger_refs_full;
--    - with the ref, while head or waiting: nothing is written
--      (already_queued);
--    - with the ref, while lapsed or out (or not in the queue at all): it
--      joins again at the back. A renewal does that by moving renewals, which
--      the CI must not touch, so the merge refs are dropped and put back in
--      two updates of the same transaction: the first leaves every queue (the
--      stamp triggers record a lapsed entry's leaving, as for a renewal), the
--      second joins again at the back.
--    A merge ref never conflicts (work_claim_conflicts skips it), so nothing
--    else is checked, as for a renewal. expires_at, fence, lease_version,
--    renewals, progress_ref(s), holder, lease_key and execution_epoch do not
--    move. A ref the CI adds is remembered as the CI's
--    (work_claim_ci_merge_refs_v1) so that the holder's renewals keep it
--    (item 3); rejoining a ref already on the claim does not change whose it
--    is (a ref the holder added stays the holder's). One
--    WORK_CLAIM_MERGE_QUEUE_JOINED_BY_CI Receipt per join.
--    Answer {status: ok, joined: true|false, reason?: already_queued |
--    claim_not_bound | claim_not_live | head_not_admitted | trigger_refs_full,
--    claim_id?, pr_ref, head_sha, merge_ref, merge_queue (the claim view's
--    merge_queue, as a renewal answers it, or null), receipt_id?}.
-- 2. action lease_extend, input {action, scope, pr_ref, head_sha, minutes}:
--    minutes an integer 1..180. expires_at := least(greatest(expires_at,
--    now + minutes), hard_deadline_at): the 24 h hard deadline stored on the
--    claim when it was issued (profile hard_deadline_seconds), the bound a
--    renewal and the keepalive use. Never for an expired claim (due claims
--    expire first, as for a renewal). No write when expires_at already
--    reaches the target (already_extended, or hard_deadline once the deadline
--    is reached), and at most one effective extension per claim per 5
--    minutes (a call inside that window is a no-op success,
--    recently_extended). Nothing else of the claim moves. One
--    WORK_CLAIM_LEASE_EXTENDED_BY_CI Receipt per effective extension, with
--    the expiry before and after.
--    Answer {status: ok, extended: true|false, reason?: already_extended |
--    hard_deadline | recently_extended | claim_not_bound | claim_not_live |
--    head_not_admitted, claim_id?, pr_ref, head_sha, minutes, expires_at,
--    previous_expires_at?, hard_deadline_at, receipt_id?}.
-- 3. The holder's renewal (clued_private.work_claim_renew_before_execution_v1,
--    three exact anchors):
--    - a renewal that sends trigger_refs without the merge ref the CI added
--      keeps it (in the claim's own spelling), so the claim keeps its queue
--      place as with a renewal that keeps the ref. A list that already holds
--      the 50 refs a claim may hold cannot take it back: the renewal raises
--      work_claim_trigger_refs_invalid (22023). The CI's ref is the one in
--      work_claim_ci_merge_refs_v1, written only when the CI adds the ref
--      (a CI rejoin of the holder's own ref writes none); the row goes when the ref leaves the
--      claim (merge, close or CI failure: work_claim_merge_slot_return_core_v1
--      deletes it; any other way, the next renewal finds the claim without
--      the ref and deletes it), so a ref the holder puts back itself later is
--      the holder's own and a renewal without it leaves the queue as usual.
--      While the CI's ref is on the claim, the holder leaves that queue by
--      releasing the claim.
--    - the new expiry is least(greatest(expires_at, now + lease_seconds),
--      hard_deadline_at): a renewal never shortens a longer lease the CI gave.
--    - a renewal of a claim whose lease already reached the hard deadline is
--      refused (work_claim_hard_deadline) as before, except when a CI
--      extension put it there (a WORK_CLAIM_LEASE_EXTENDED_BY_CI receipt of
--      this claim with that expiry): the CI may reach the deadline up to 180
--      minutes early, and the holder must still be able to record progress,
--      refs and write set. Such a renewal keeps expires_at at the deadline.
--
-- Why the holder's fields stay: the CI is not the holder. A renewal is a
-- compare-and-set on fence and lease_version, so if the CI moved
-- lease_version (or the fence) the holder's next clued_work_renew would be
-- refused with work_claim_version_conflict. Neither action moves the claim
-- id, fence or execution epoch that the CI's batch claim compares. A join
-- does change trigger_refs, exactly as the holder's renewal with the merge
-- ref does, and the execution admission's resources digest (write_set and
-- trigger_refs) is what work_claim_execution_current_v1 and the CI
-- scheduling job check compare: after a join, a guarded claim reports
-- epoch_current=false for the heads admitted before it until
-- clued_work_verify_v1 admits the head again (which records an admission
-- with the new digest). The CI verifies again after it joins.

-- The CI's merge ref of a claim, kept on the holder's renewals (item 3).
-- No foreign key: a row of a claim that is gone is never read.
create table clued_private.work_claim_ci_merge_refs_v1 (
  claim_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  merge_ref text not null check (merge_ref=lower(merge_ref) and merge_ref like 'merge:%'),
  joined_at timestamptz not null,
  receipt_id uuid not null
);
alter table clued_private.work_claim_ci_merge_refs_v1 enable row level security;
revoke all on table clued_private.work_claim_ci_merge_refs_v1
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- The live claim the CI may act for (header). Returns {reason} or
-- {claim_id}. The caller holds the claim lock and has expired due claims.
create function clued_private.work_claim_ci_assist_target_v1(p_user uuid,p_scope text,p_pr text,p_head text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare c clued_private.work_claims_v1%rowtype; v_now timestamptz:=pg_catalog.clock_timestamp();
  v_live boolean:=false; v_repo text:=lower(split_part(p_pr,'#',1));
begin
  if not exists(select 1 from clued_private.work_claims_v1 w
      where w.user_id=p_user and w.context_key=p_scope and w.bound_pr=p_pr) then
    return jsonb_build_object('reason','claim_not_bound'); end if;
  for c in select * from clued_private.work_claims_v1 w
    where w.user_id=p_user and w.context_key=p_scope and w.bound_pr=p_pr
    order by w.issued_at desc,w.claim_id desc for update loop
    continue when c.status<>'ACTIVE' or c.expires_at<=v_now or c.execution_handover_pending
      or c.outcome is not distinct from 'not_adopted'
      or (c.copy_index is null and exists(select 1 from clued_private.work_claims_v1 newer
        where newer.user_id=c.user_id and newer.task_id=c.task_id and newer.fence>c.fence));
    v_live:=true;
    if exists(select 1 from clued_private.work_claim_execution_admissions_v1 e
        where e.user_id=c.user_id and e.claim_id=c.claim_id and e.execution_epoch=c.execution_epoch
          and e.head_sha=p_head and e.pr_ref=p_pr and e.repository=v_repo and e.target_branch='main') then
      return jsonb_build_object('claim_id',c.claim_id); end if;
  end loop;
  return jsonb_build_object('reason',case when v_live then 'head_not_admitted' else 'claim_not_live' end);
end $$;

-- Input shared by both actions: only p_keys, a string scope if any, a pull
-- request ref and a 40-hex head SHA. Never null: a missing field is invalid.
create function clued_private.work_claim_ci_assist_input_v1(p_input jsonb,p_keys text[]) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p_input)='object'
    and p_input-p_keys='{}'::jsonb
    and (not(p_input ? 'scope') or jsonb_typeof(p_input->'scope')='string')
    and jsonb_typeof(p_input->'pr_ref')='string'
    and p_input->>'pr_ref' ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[0-9]{1,10}$'
    and jsonb_typeof(p_input->'head_sha')='string'
    and lower(p_input->>'head_sha') ~ '^[0-9a-f]{40}$',false)
$$;

-- Item 1, behind the door's checks and the claim lock. b is the CI Binding.
create function clued_private.work_claim_ci_queue_join_v1(b public.clued_agent_bindings,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_scope text:=coalesce(p_input->>'scope','global'); v_pr text:=p_input->>'pr_ref';
  v_head text:=lower(p_input->>'head_sha'); v_ref text; v_prefix text; v_target jsonb;
  c clued_private.work_claims_v1%rowtype; v_refs text[]; v_state text:='none';
  v_receipt uuid; v_rejoin boolean; v_now timestamptz:=pg_catalog.clock_timestamp();
begin
  if not clued_private.work_claim_ci_assist_input_v1(p_input,array['action','scope','pr_ref','head_sha']) then
    raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
  if not clued_private.merge_slot_admits_v1(b) then
    return jsonb_build_object('status','rejected','error_code','admission_binding_required'); end if;
  v_prefix:='merge:'||lower(split_part(v_pr,'#',1))||':';
  v_ref:=v_prefix||'main';
  perform clued_private.work_claim_expire_due(b.user_id);
  -- Every writer of a queue records it first (20261031060000 item 3).
  perform clued_private.work_claim_merge_front_sync_all_v1(b.user_id,v_prefix);
  v_target:=clued_private.work_claim_ci_assist_target_v1(b.user_id,v_scope,v_pr,v_head);
  if v_target ? 'reason' then
    return jsonb_build_object('status','ok','joined',false,'reason',v_target->>'reason',
      'pr_ref',v_pr,'head_sha',v_head,'merge_ref',v_ref,'merge_queue',null);
  end if;
  select * into c from clued_private.work_claims_v1 where claim_id=(v_target->>'claim_id')::uuid;
  if exists(select 1 from unnest(c.trigger_refs) t where lower(t)=v_ref) then
    select x->>'state' into v_state from jsonb_array_elements(
      clued_private.work_claim_merge_queue_current_v1(b.user_id,v_ref)->'entries') x
      where x->>'claim_id'=c.claim_id::text;
    v_state:=coalesce(v_state,'none');
    if v_state in ('head','waiting') then
      return jsonb_build_object('status','ok','joined',false,'reason','already_queued','claim_id',c.claim_id,
        'pr_ref',v_pr,'head_sha',v_head,'merge_ref',v_ref,'merge_queue',clued_private.work_claim_merge_queue_view_v1(c));
    end if;
    -- Lapsed, out or not in the queue: leave every queue of the claim, then
    -- join again at the back with the same refs, as a renewal that keeps the
    -- ref does.
    v_rejoin:=true;
    v_refs:=c.trigger_refs;
    update clued_private.work_claims_v1 set trigger_refs=array(select t from unnest(v_refs) t where t not like 'merge:%' order by t)
      where claim_id=c.claim_id;
    update clued_private.work_claims_v1 set trigger_refs=v_refs,updated_at=v_now
      where claim_id=c.claim_id returning * into c;
  else
    if cardinality(c.trigger_refs)>=50 then
      return jsonb_build_object('status','ok','joined',false,'reason','trigger_refs_full','claim_id',c.claim_id,
        'pr_ref',v_pr,'head_sha',v_head,'merge_ref',v_ref,'merge_queue',clued_private.work_claim_merge_queue_view_v1(c));
    end if;
    v_rejoin:=false;
    update clued_private.work_claims_v1
      set trigger_refs=clued_private.work_claim_normalize_triggers(to_jsonb(c.trigger_refs||v_ref)),updated_at=v_now
      where claim_id=c.claim_id returning * into c;
  end if;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(c.user_id,b.id,c.context_key,'work_claim_merge_queue_join_by_ci','work_claim',c.claim_id::text,c.fence,
    jsonb_build_object('receipt_kind','WORK_CLAIM_MERGE_QUEUE_JOINED_BY_CI','claim_id',c.claim_id,
      'task_id',c.task_id,'fence',c.fence,'lease_version',c.lease_version,'execution_epoch',c.execution_epoch,
      'pr_ref',v_pr,'head_sha',v_head,'ci_binding_id',b.id,'merge_ref',v_ref,
      'rejoined',v_rejoin,'previous_state',v_state,'queued_at',c.merge_queued_at,
      'trigger_refs',to_jsonb(c.trigger_refs)))
  returning id into v_receipt;
  -- Only a ref the CI added is the CI's. Rejoining a ref already on the claim
  -- keeps whatever it was: the holder's own stays the holder's, and a CI row
  -- is left as it is.
  if not v_rejoin then
    insert into clued_private.work_claim_ci_merge_refs_v1(claim_id,user_id,merge_ref,joined_at,receipt_id)
      values(c.claim_id,c.user_id,v_ref,v_now,v_receipt)
      on conflict (claim_id) do update set merge_ref=excluded.merge_ref,joined_at=excluded.joined_at,
        receipt_id=excluded.receipt_id;
  end if;
  return jsonb_build_object('status','ok','joined',true,'claim_id',c.claim_id,'pr_ref',v_pr,'head_sha',v_head,
    'merge_ref',v_ref,'merge_queue',clued_private.work_claim_merge_queue_view_v1(c),'receipt_id',v_receipt);
end $$;

-- Item 2, behind the door's checks and the claim lock. b is the CI Binding.
create function clued_private.work_claim_ci_lease_extend_v1(b public.clued_agent_bindings,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_scope text:=coalesce(p_input->>'scope','global'); v_pr text:=p_input->>'pr_ref';
  v_head text:=lower(p_input->>'head_sha'); v_minutes integer; v_target jsonb;
  c clued_private.work_claims_v1%rowtype; v_now timestamptz:=pg_catalog.clock_timestamp();
  v_expires timestamptz; v_receipt uuid; v_answer jsonb;
begin
  v_minutes:=case when jsonb_typeof(p_input->'minutes')='number' and (p_input->>'minutes') ~ '^[0-9]{1,3}$'
    then (p_input->>'minutes')::integer end;
  if not clued_private.work_claim_ci_assist_input_v1(p_input,array['action','scope','pr_ref','head_sha','minutes'])
      or v_minutes is null or v_minutes not between 1 and 180 then
    raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
  if not clued_private.merge_slot_admits_v1(b) then
    return jsonb_build_object('status','rejected','error_code','admission_binding_required'); end if;
  -- A lease that already ran out expires here first and is never revived.
  perform clued_private.work_claim_expire_due(b.user_id);
  -- The lease bounds the slot, so the queues of the repository are recorded
  -- first, as the keepalive does (20261031060000 item 3).
  perform clued_private.work_claim_merge_front_sync_all_v1(b.user_id,'merge:'||lower(split_part(v_pr,'#',1))||':');
  v_target:=clued_private.work_claim_ci_assist_target_v1(b.user_id,v_scope,v_pr,v_head);
  v_answer:=jsonb_build_object('status','ok','pr_ref',v_pr,'head_sha',v_head,'minutes',v_minutes);
  if v_target ? 'reason' then
    return v_answer||jsonb_build_object('extended',false,'reason',v_target->>'reason',
      'expires_at',null,'hard_deadline_at',null);
  end if;
  select * into c from clued_private.work_claims_v1 where claim_id=(v_target->>'claim_id')::uuid;
  v_answer:=v_answer||jsonb_build_object('claim_id',c.claim_id,'hard_deadline_at',c.hard_deadline_at);
  v_expires:=least(greatest(c.expires_at,v_now+make_interval(mins=>v_minutes)),c.hard_deadline_at);
  if v_expires<=c.expires_at then
    return v_answer||jsonb_build_object('extended',false,'expires_at',c.expires_at,
      'reason',case when c.expires_at>=c.hard_deadline_at then 'hard_deadline' else 'already_extended' end);
  end if;
  -- context_key keeps the lookup on clued_audit_receipts_stream_idx
  -- (user_id, context_key, created_at desc).
  if exists(select 1 from public.clued_audit_receipts r where r.user_id=c.user_id
      and r.context_key=c.context_key and r.created_at>v_now-interval '5 minutes'
      and r.operation='work_claim_lease_extend_by_ci' and r.object_id=c.claim_id::text) then
    return v_answer||jsonb_build_object('extended',false,'expires_at',c.expires_at,'reason','recently_extended');
  end if;
  update clued_private.work_claims_v1 set expires_at=v_expires where claim_id=c.claim_id;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(c.user_id,b.id,c.context_key,'work_claim_lease_extend_by_ci','work_claim',c.claim_id::text,c.fence,
    jsonb_build_object('receipt_kind','WORK_CLAIM_LEASE_EXTENDED_BY_CI','claim_id',c.claim_id,
      'task_id',c.task_id,'fence',c.fence,'lease_version',c.lease_version,'execution_epoch',c.execution_epoch,
      'pr_ref',v_pr,'head_sha',v_head,'ci_binding_id',b.id,'minutes',v_minutes,
      'previous_expires_at',c.expires_at,'expires_at',v_expires,'hard_deadline_at',c.hard_deadline_at))
  returning id into v_receipt;
  return v_answer||jsonb_build_object('extended',true,'expires_at',v_expires,
    'previous_expires_at',c.expires_at,'receipt_id',v_receipt);
end $$;

-- Item 3, first rule: the trigger refs a renewal sets, with the CI's merge
-- ref put back when the renewal's own list drops it while the claim still
-- holds it. A row whose ref has already left the claim is stale and goes, so
-- the ref no longer counts as the CI's. A list that is already full cannot
-- take the ref back.
create function clued_private.work_claim_ci_keep_merge_ref_v1(c clued_private.work_claims_v1,p_triggers text[])
returns text[] language plpgsql volatile security definer set search_path='' as $$
declare v_ref text; v_held text;
begin
  select k.merge_ref into v_ref from clued_private.work_claim_ci_merge_refs_v1 k where k.claim_id=c.claim_id;
  if v_ref is null then return p_triggers; end if;
  select t into v_held from unnest(c.trigger_refs) t where lower(t)=v_ref order by t limit 1;
  if v_held is null then
    delete from clued_private.work_claim_ci_merge_refs_v1 k where k.claim_id=c.claim_id;
    return p_triggers;
  end if;
  if exists(select 1 from unnest(p_triggers) t where lower(t)=v_ref) then
    return p_triggers; end if;
  if cardinality(p_triggers)>=50 then
    raise exception 'work_claim_trigger_refs_invalid' using errcode='22023',
      detail='the CI merge ref '||v_held||' is kept and the list already holds 50 refs'; end if;
  return clued_private.work_claim_normalize_triggers(to_jsonb(p_triggers||v_held));
end $$;

-- Item 3, third rule: the claim's lease reached its expiry through a CI
-- extension (the receipt of an effective extension to exactly that expiry).
create function clued_private.work_claim_ci_extended_to_v1(c clued_private.work_claims_v1) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.clued_audit_receipts r where r.user_id=c.user_id
    and r.context_key=c.context_key and r.operation='work_claim_lease_extend_by_ci'
    and r.object_id=c.claim_id::text and (r.metadata->>'expires_at')::timestamptz=c.expires_at)
$$;

-- Add the two actions to the CI command door right after the keepalive, so
-- they run behind its role check and claim lock. The door is otherwise
-- unchanged; the anchor must occur exactly once.
do $ci_queue_assist$
declare body text; anchor text:=$a$  if op='merge_queue_keepalive' then
    return clued_private.work_claim_merge_queue_keepalive_v1(b,p_input);
  end if;
$a$;
begin
  body:=pg_catalog.pg_get_functiondef('clued_private.work_claim_ci_command_v1(text,jsonb)'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1
      or position('merge_queue_join' in body)>0 or position('lease_extend' in body)>0 then
    raise exception 'work_claim_ci_queue_assist_command_source_unexpected'; end if;
  execute replace(body,anchor,anchor||$a$  if op='merge_queue_join' then
    return clued_private.work_claim_ci_queue_join_v1(b,p_input);
  end if;
  if op='lease_extend' then
    return clued_private.work_claim_ci_lease_extend_v1(b,p_input);
  end if;
$a$);
end $ci_queue_assist$;

-- Item 3 in the holder's renewal (the body 20261011131755 copied from
-- 20261006120000). Each anchor must occur exactly once.
do $renew_keeps_ci$
declare body text;
  a1 text:=$a$  v_triggers:=case when p_input ? 'trigger_refs'
    then clued_private.work_claim_normalize_triggers(p_input->'trigger_refs') else c.trigger_refs end;
$a$;
  r1 text:=$a$  -- The CI's merge ref stays unless it already left the claim (20261105120000).
  if p_input ? 'trigger_refs' then
    v_triggers:=clued_private.work_claim_ci_keep_merge_ref_v1(c,v_triggers);
  end if;
$a$;
  a2 text:=$a$  v_expires:=least(v_now+make_interval(secs=>(v_profile->>'lease_seconds')::integer),c.hard_deadline_at);$a$;
  r2 text:=$a$  -- Never shorter than the lease the claim has (a CI extension), never past the deadline.
  v_expires:=least(greatest(c.expires_at,v_now+make_interval(secs=>(v_profile->>'lease_seconds')::integer)),c.hard_deadline_at);$a$;
  a3 text:=$a$  if c.expires_at>=c.hard_deadline_at then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
      'work_claim_renew','work_claim_hard_deadline',$a$;
  r3 text:=$a$  -- A CI extension may reach the deadline early; the holder still renews (20261105120000).
  if c.expires_at>=c.hard_deadline_at and not clued_private.work_claim_ci_extended_to_v1(c) then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
      'work_claim_renew','work_claim_hard_deadline',$a$;
begin
  body:=pg_catalog.pg_get_functiondef('clued_private.work_claim_renew_before_execution_v1(text,jsonb)'::regprocedure);
  if (length(body)-length(replace(body,a1,'')))/length(a1)<>1
      or (length(body)-length(replace(body,a2,'')))/length(a2)<>1
      or (length(body)-length(replace(body,a3,'')))/length(a3)<>1 then
    raise exception 'work_claim_ci_queue_assist_renew_source_unexpected'; end if;
  execute replace(replace(replace(body,a1,a1||r1),a2,r2),a3,r3);
end $renew_keeps_ci$;

-- The CI's ref leaves with the slot: work_claim_merge_slot_return_core_v1
-- (20261006120000; merge, close, CI failure) deletes the row of every merge
-- ref it drops. The anchor must occur exactly once.
do $return_drops_ci$
declare body text;
  a text:=$a$      where claim_id=c.claim_id;
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,$a$;
  r text:=$a$      where claim_id=c.claim_id;
    delete from clued_private.work_claim_ci_merge_refs_v1 k
      where k.claim_id=c.claim_id and exists(select 1 from unnest(v_refs) x where lower(x)=k.merge_ref);
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,$a$;
begin
  body:=pg_catalog.pg_get_functiondef(
    'clued_private.work_claim_merge_slot_return_core_v1(uuid,uuid,text,text,text,jsonb)'::regprocedure);
  if (length(body)-length(replace(body,a,'')))/length(a)<>1 then
    raise exception 'work_claim_ci_queue_assist_return_source_unexpected'; end if;
  execute replace(body,a,r);
end $return_drops_ci$;

revoke all on function
  clued_private.work_claim_ci_assist_target_v1(uuid,text,text,text),
  clued_private.work_claim_ci_assist_input_v1(jsonb,text[]),
  clued_private.work_claim_ci_queue_join_v1(public.clued_agent_bindings,jsonb),
  clued_private.work_claim_ci_lease_extend_v1(public.clued_agent_bindings,jsonb),
  clued_private.work_claim_ci_keep_merge_ref_v1(clued_private.work_claims_v1,text[]),
  clued_private.work_claim_ci_extended_to_v1(clued_private.work_claims_v1)
  from public,anon,authenticated,service_role,clued_worker_gateway;

notify pgrst,'reload schema';
