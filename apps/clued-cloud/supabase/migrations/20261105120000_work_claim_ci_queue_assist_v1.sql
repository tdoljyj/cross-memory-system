-- Resident CI assist: the CI admission Binding may put a pull request's claim
-- into its merge queue and extend that claim's lease (Clued Decision "第 12 代
-- ‘推送后全自动’设计决定": decision 1 = A, decision 2 approved).
--
-- Until now only the claim's holder (its Binding or its private lease_key, with
-- a new progress_ref) could join the merge queue merge:<owner>/<repo>:main or
-- extend the lease, through clued_work_renew. The resident CI runs every stage
-- of a pull request but is not the holder, so a pull request whose stages 1-7
-- passed stalled at stage 8 (RESIDENT_MERGE_QUEUE_NOT_JOINED) until a human
-- renewed, and a lease could run out while the CI batch was still running.
--
-- Two new CI RPCs, called with the CI admission Binding's token like
-- clued_work_merge_slot_touch_v1 (p_token_hash, p_input; anon EXECUTE). The CI
-- signature surface becomes the eight of 20261010161848 plus these two (the
-- database tests pin it); GW80 is unchanged and the Worker reaches neither.
-- They are not actions of the CI command door: the door's body,
-- clued_work_verify_v1 and the verifier behind it are pinned byte for byte by
-- the scan-start test of 20261102151506. The caller must be the Binding
-- itself marked ci-admission, its row started and its purpose resident-node
-- or unspecified (as for touch/adopt/return/keepalive; a standby node that is
-- not on duty has no row). Any other Binding gets touch's answer
-- {status: ok, <verb>: false, reason: admission_binding_required}; unlike
-- touch there is no open behaviour for an account without any ci-admission
-- row. A token that does not resolve is refused by resolve_binding (42501)
-- as everywhere. Input errors are 22023 with touch's codes
-- (work_claim_pr_ref_invalid, work_claim_head_sha_invalid) or
-- work_claim_merge_queue_join_input_invalid / work_claim_lease_extend_input_invalid
-- / work_claim_lease_extend_minutes_invalid. Both take the claim lock.
--
-- 1. clued_work_merge_queue_join_v1, input {scope, pr_ref: "owner/repo#N",
--    head_sha}. The live claim of this scope bound to exactly pr_ref (ACTIVE,
--    lease not run out, not superseded by a newer fence, not a copy out of the
--    race, no handover pending) whose admitted heads hold head_sha (verify
--    records each admitted pull request head in admitted_heads, with a
--    WORK_CLAIM_HEAD_ADMITTED Receipt) joins merge:<owner>/<repo>:main at the
--    back, exactly as a holder renewal that adds or keeps the ref joins:
--    - without the ref, the ref is added to trigger_refs (the stamp triggers
--      join it; a claim that already had another merge ref joins every queue
--      again, as any change of merge refs does);
--    - with the ref, while head or waiting: nothing is written
--      (reason already_queued);
--    - with the ref, while lapsed or out: it joins again at the back. A
--      renewal does that by moving renewals, which the CI must not touch, so
--      the merge refs are dropped and put back in two updates of the same
--      transaction: the stamp triggers record the leaving (head or lapsed)
--      and the new join just as for a renewal.
--    A merge ref never conflicts (work_claim_conflicts skips it), so nothing
--    else is checked, as for a renewal. expires_at, fence, lease_version,
--    renewals, progress_ref(s), holder, lease_key and execution_epoch do not
--    move. One WORK_CLAIM_MERGE_QUEUE_JOINED_BY_CI Receipt per join.
--    Answer {status: ok, joined, reason?: already_queued | claim_not_bound |
--    head_not_admitted | claim_not_live, claim_id, pr_ref, head_sha,
--    merge_ref, merge_queue (the claim view's merge_queue, as a renewal
--    answers it), receipt_id}.
-- 2. clued_work_lease_extend_v1, input {scope, pr_ref, head_sha, minutes 1..180}.
--    Same claim. expires_at := least(greatest(expires_at, now + minutes),
--    hard_deadline_at): the 24 h hard deadline stored on the claim when it was
--    issued (profile hard_deadline_seconds), the same bound a renewal and the
--    keepalive use. Never for an expired claim (due claims expire first, as
--    for a renewal). No write when expires_at already reaches the target
--    (already_extended, or hard_deadline when the deadline is reached), and
--    at most one effective extension per claim per 5 minutes (a call inside
--    that window is a no-op success, recently_extended). Nothing else of the
--    claim moves: no lease_version, fence, holder, progress_ref, renewals,
--    merge slot clock. One WORK_CLAIM_LEASE_EXTENDED_BY_CI Receipt per
--    effective extension, with the expiry before and after.
--    Answer {status: ok, extended, reason?, claim_id, pr_ref, head_sha,
--    minutes, expires_at, previous_expires_at, hard_deadline_at, receipt_id}.
--
-- Why the holder's fields stay: the CI is not the holder. A renewal is a
-- compare-and-set on fence and lease_version, so if the CI moved
-- lease_version (or the fence) the holder's next clued_work_renew would be
-- refused with work_claim_version_conflict. The CI's own batch claim compares
-- only claim id, fence and execution epoch, which neither action changes, so
-- neither voids a running batch. A join does change trigger_refs, exactly as
-- the holder's renewal with the merge ref does, so an execution admission
-- recorded before it (its resources digest covers write_set and
-- trigger_refs) no longer matches the claim, as after that renewal.

-- The live claim the CI may act for: bound to exactly p_pr in p_scope, with
-- p_head admitted. Returns {reason} or {claim_id}. The caller holds the claim
-- lock and has expired due claims.
create function clued_private.work_claim_ci_assist_target_v1(p_user uuid,p_scope text,p_pr text,p_head text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare c clued_private.work_claims_v1%rowtype; v_now timestamptz:=pg_catalog.clock_timestamp();
  v_live boolean:=false;
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
    if p_head=any(c.admitted_heads) then
      return jsonb_build_object('claim_id',c.claim_id); end if;
  end loop;
  return jsonb_build_object('reason',case when v_live then 'head_not_admitted' else 'claim_not_live' end);
end $$;

-- Input shared by both actions: only p_keys, a string scope if any, a pull
-- request ref and a head SHA. Never null: a missing field is invalid.
create function clued_private.work_claim_ci_assist_input_v1(p_input jsonb,p_keys text[]) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p_input)='object'
    and p_input-p_keys='{}'::jsonb
    and (not(p_input ? 'scope') or jsonb_typeof(p_input->'scope')='string')
    and jsonb_typeof(p_input->'pr_ref')='string'
    and p_input->>'pr_ref' ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[0-9]{1,10}$'
    and jsonb_typeof(p_input->'head_sha')='string'
    and lower(p_input->>'head_sha') ~ '^[0-9a-f]{7,64}$',false)
$$;

-- Item 1, behind the RPC's checks and the claim lock. b is the CI Binding.
create function clued_private.work_claim_ci_queue_join_v1(b public.clued_agent_bindings,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_scope text:=coalesce(p_input->>'scope','global'); v_pr text:=p_input->>'pr_ref';
  v_head text:=lower(p_input->>'head_sha'); v_ref text; v_prefix text; v_target jsonb;
  c clued_private.work_claims_v1%rowtype; v_refs text[]; e jsonb; v_state text:='none';
  v_receipt uuid; v_rejoin boolean;
begin
  if not clued_private.work_claim_ci_assist_input_v1(p_input,array['scope','pr_ref','head_sha']) then
    raise exception 'work_claim_merge_queue_join_input_invalid' using errcode='22023'; end if;
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
    -- Lapsed or out: leave every queue of the claim, then join again at the
    -- back with the same refs, as a renewal that keeps the ref does.
    v_rejoin:=true;
    v_refs:=c.trigger_refs;
    update clued_private.work_claims_v1 set trigger_refs=array(select t from unnest(v_refs) t where t not like 'merge:%' order by t)
      where claim_id=c.claim_id;
    update clued_private.work_claims_v1 set trigger_refs=v_refs,updated_at=pg_catalog.clock_timestamp()
      where claim_id=c.claim_id returning * into c;
  else
    v_rejoin:=false;
    update clued_private.work_claims_v1
      set trigger_refs=clued_private.work_claim_normalize_triggers(to_jsonb(c.trigger_refs||v_ref)),
        updated_at=pg_catalog.clock_timestamp()
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
  return jsonb_build_object('status','ok','joined',true,'claim_id',c.claim_id,'pr_ref',v_pr,'head_sha',v_head,
    'merge_ref',v_ref,'merge_queue',clued_private.work_claim_merge_queue_view_v1(c),'receipt_id',v_receipt);
end $$;

-- Item 2, behind the RPC's checks and the claim lock. b is the CI Binding.
create function clued_private.work_claim_ci_lease_extend_v1(b public.clued_agent_bindings,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_scope text:=coalesce(p_input->>'scope','global'); v_pr text:=p_input->>'pr_ref';
  v_head text:=lower(p_input->>'head_sha'); v_minutes integer; v_target jsonb;
  c clued_private.work_claims_v1%rowtype; v_now timestamptz:=pg_catalog.clock_timestamp();
  v_expires timestamptz; v_receipt uuid; v_answer jsonb;
begin
  v_minutes:=case when jsonb_typeof(p_input->'minutes')='number' and (p_input->>'minutes') ~ '^[0-9]{1,3}$'
    then (p_input->>'minutes')::integer end;
  if not clued_private.work_claim_ci_assist_input_v1(p_input,array['scope','pr_ref','head_sha','minutes'])
      or v_minutes is null or v_minutes not between 1 and 180 then
    raise exception 'work_claim_lease_extend_input_invalid' using errcode='22023'; end if;
  -- A lease that already ran out expires here first and is never revived.
  perform clued_private.work_claim_expire_due(b.user_id);
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
  if exists(select 1 from public.clued_audit_receipts r where r.user_id=c.user_id
      and r.operation='work_claim_lease_extend_by_ci' and r.object_id=c.claim_id::text
      and r.created_at>v_now-interval '5 minutes') then
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

-- The CI admission Binding acting for the merge queue: touch's check
-- (merge_slot_admits_v1: a started ci-admission row whose purpose is
-- resident-node or unspecified), except that the account's open behaviour
-- without any ci-admission row does not apply: the Binding itself must hold a
-- started row (read through binding_role_holders_v1, the reviewed reader).
create function clued_private.work_claim_ci_assist_admits_v1(b public.clued_agent_bindings) returns boolean
language sql stable security definer set search_path='' as $$
  select clued_private.merge_slot_admits_v1(b)
    and exists(select 1 from jsonb_array_elements(
        clued_private.binding_role_holders_v1(b.user_id,'ci-admission','{}'::uuid[])) h
      where h->>'binding_id'=b.id::text
        and (h->>'effective_at')::timestamptz<=pg_catalog.clock_timestamp())
$$;

-- clued_work_merge_queue_join_v1(p_token_hash, {scope, pr_ref, head_sha}):
-- item 1, for the CI admission Binding only (touch's caller and answer shape).
create function public.clued_work_merge_queue_join_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; v_scope text:=coalesce(p_input->>'scope','global');
begin
  if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('scope','pr_ref','head_sha'))
      or (p_input ? 'scope' and jsonb_typeof(p_input->'scope') is distinct from 'string') then
    raise exception 'work_claim_merge_queue_join_input_invalid' using errcode='22023'; end if;
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_scope);
  if not clued_private.work_claim_ci_assist_admits_v1(v_binding) then
    return jsonb_build_object('status','ok','joined',false,'reason','admission_binding_required');
  end if;
  if jsonb_typeof(p_input->'pr_ref') is distinct from 'string'
      or p_input->>'pr_ref' !~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[0-9]{1,10}$' then
    raise exception 'work_claim_pr_ref_invalid' using errcode='22023'; end if;
  if jsonb_typeof(p_input->'head_sha') is distinct from 'string'
      or lower(p_input->>'head_sha') !~ '^[0-9a-f]{7,64}$' then
    raise exception 'work_claim_head_sha_invalid' using errcode='22023'; end if;
  perform clued_private.work_claim_lock(v_binding.user_id);
  return clued_private.work_claim_ci_queue_join_v1(v_binding,p_input);
end $$;

-- clued_work_lease_extend_v1(p_token_hash, {scope, pr_ref, head_sha, minutes}):
-- item 2, for the CI admission Binding only (touch's caller and answer shape).
create function public.clued_work_lease_extend_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; v_scope text:=coalesce(p_input->>'scope','global');
  v_minutes integer;
begin
  if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('scope','pr_ref','head_sha','minutes'))
      or (p_input ? 'scope' and jsonb_typeof(p_input->'scope') is distinct from 'string') then
    raise exception 'work_claim_lease_extend_input_invalid' using errcode='22023'; end if;
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_scope);
  if not clued_private.work_claim_ci_assist_admits_v1(v_binding) then
    return jsonb_build_object('status','ok','extended',false,'reason','admission_binding_required');
  end if;
  if jsonb_typeof(p_input->'pr_ref') is distinct from 'string'
      or p_input->>'pr_ref' !~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[0-9]{1,10}$' then
    raise exception 'work_claim_pr_ref_invalid' using errcode='22023'; end if;
  if jsonb_typeof(p_input->'head_sha') is distinct from 'string'
      or lower(p_input->>'head_sha') !~ '^[0-9a-f]{7,64}$' then
    raise exception 'work_claim_head_sha_invalid' using errcode='22023'; end if;
  v_minutes:=case when jsonb_typeof(p_input->'minutes')='number' and (p_input->>'minutes') ~ '^[0-9]{1,3}$'
    then (p_input->>'minutes')::integer end;
  if v_minutes is null or v_minutes not between 1 and 180 then
    raise exception 'work_claim_lease_extend_minutes_invalid' using errcode='22023'; end if;
  perform clued_private.work_claim_lock(v_binding.user_id);
  return clued_private.work_claim_ci_lease_extend_v1(v_binding,p_input);
end $$;

revoke all on function
  clued_private.work_claim_ci_assist_target_v1(uuid,text,text,text),
  clued_private.work_claim_ci_assist_input_v1(jsonb,text[]),
  clued_private.work_claim_ci_assist_admits_v1(public.clued_agent_bindings),
  clued_private.work_claim_ci_queue_join_v1(public.clued_agent_bindings,jsonb),
  clued_private.work_claim_ci_lease_extend_v1(public.clued_agent_bindings,jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;
-- CI signatures: the two RPCs join the CI admission Binding's anon surface
-- (DatabaseCallerAuthentication v0.1: a CI-called RPC enters the list by the
-- same rule as touch and holders), and nothing else does.
revoke all on function
  public.clued_work_merge_queue_join_v1(text,jsonb),
  public.clued_work_lease_extend_v1(text,jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;
grant execute on function
  public.clued_work_merge_queue_join_v1(text,jsonb),
  public.clued_work_lease_extend_v1(text,jsonb)
  to anon;

-- Fail closed on the two new entries' callers: anon (the CI admission
-- Binding's transport) and nobody else, not PUBLIC, authenticated,
-- service_role or the Worker gateway. The whole anon surface (CI8 plus these
-- two once 20261010161848 is in force) is pinned by the database tests
-- (worker-gateway-caller-fixture.mjs); it is not checked here because a chain
-- may apply this file before the closeout.
do $ci_signatures$
declare f text; r text;
begin
  foreach f in array array['public.clued_work_merge_queue_join_v1(text,jsonb)',
      'public.clued_work_lease_extend_v1(text,jsonb)'] loop
    if not pg_catalog.has_function_privilege('anon',f,'EXECUTE')
        or not (select p.prosecdef from pg_catalog.pg_proc p where p.oid=pg_catalog.to_regprocedure(f))
        or exists(select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
          where p.oid=pg_catalog.to_regprocedure(f) and (a.grantee=0 or a.is_grantable)) then
      raise exception 'work_claim_ci_queue_assist_acl_unexpected: %',f using errcode='42501'; end if;
    foreach r in array array['authenticated','service_role','clued_worker_gateway'] loop
      if pg_catalog.to_regrole(r) is not null and pg_catalog.has_function_privilege(r,f,'EXECUTE') then
        raise exception 'work_claim_ci_queue_assist_acl_unexpected: % %',r,f using errcode='42501'; end if;
    end loop;
  end loop;
end $ci_signatures$;

notify pgrst,'reload schema';
