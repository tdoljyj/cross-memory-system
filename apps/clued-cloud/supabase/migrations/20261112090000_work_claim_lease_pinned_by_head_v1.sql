-- A claim whose holder authorized a pull-request head does not lapse while it
-- waits (defect 2026-11-12, Task 0ee7142e / PR #1067: claim 925cf115 was
-- authorized at 19:41Z, waited for the Owner's acceptance, and its 2 h lease
-- ran out before the PR was pushed; the resident then answered
-- CLAIM_NOT_CURRENT every 10 minutes until a human claimed, authorized and
-- edited the PR again. A PR queued longer than 2 h lapsed the same way).
--
-- Rule: authorize_head for a pull-request target (workflow null) is the
-- holder's own statement that this head is the delivery. From then on the
-- claim's liveness is the PR's, not a 2 h lease: expires_at is set to the
-- claim's hard_deadline_at (issued_at + 24 h, unchanged). It ends as before
-- by release, terminal release, Owner handover or the hard deadline, and in
-- addition when the PR stops: when the Task's last active PR binding becomes
-- closed or merged, the lease goes back to at most now + lease_seconds (2 h),
-- so a holder that is gone lapses as an unbound claim does.
--
-- Nothing polls. The CI no longer needs to extend the lease while it queues,
-- waits or runs: on a pinned claim its lease_extend answers already_extended
-- or hard_deadline and writes nothing (the action can be removed once no
-- resident calls it).
--
-- Who can pin: only the claim's current holder with the current private
-- lease key (authorize_head already checks holder, key, fence, version, Task,
-- account and scope). The CI admission Binding, readers and other holders
-- cannot. A workflow dispatch authorization does not pin. The hard deadline
-- is not moved. A head change needs a new authorize_head for admission, as
-- before.
--
-- The holder's renewal of a pinned claim stays accepted (expiry stays at the
-- deadline), as for a claim a CI extension brought to the deadline: the
-- exception of 20261105120000 item 3 also covers a claim with a live
-- pull-request authorization of its current epoch.

do $copy_pin_authorizer$
declare definition text;
begin
  definition:=pg_catalog.pg_get_functiondef('clued_private.work_claim_authorize_head_v1(text,jsonb)'::regprocedure);
  execute replace(definition,'FUNCTION clued_private.work_claim_authorize_head_v1(',
    'FUNCTION clued_private.work_claim_authorize_head_before_lease_pin_v1(');
end $copy_pin_authorizer$;
create or replace function clued_private.work_claim_authorize_head_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb; c clued_private.work_claims_v1;
begin
  result:=clued_private.work_claim_authorize_head_before_lease_pin_v1(p_token_hash,p_input);
  if result->>'status' is distinct from 'committed' then return result; end if;
  -- The predecessor checked the holder and its key; the authorization row it
  -- names is the proof the pin rests on.
  update clued_private.work_claims_v1 w set expires_at=w.hard_deadline_at
    where w.claim_id=(p_input->>'claim_id')::uuid and w.status='ACTIVE'
      and w.expires_at>pg_catalog.clock_timestamp() and w.expires_at<w.hard_deadline_at
      and exists(select 1 from clued_private.work_claim_head_authorizations_v1 a
        where a.authorization_id=(result->>'authorization_id')::uuid and a.claim_id=w.claim_id
          and a.execution_epoch=w.execution_epoch and a.binding_id=w.holder_binding_id
          and a.workflow is null and a.revoked_at is null);
  select * into c from clued_private.work_claims_v1 where claim_id=(p_input->>'claim_id')::uuid;
  return result||jsonb_build_object('expires_at',c.expires_at,'hard_deadline_at',c.hard_deadline_at);
end $$;

-- A claim pinned by a live pull-request authorization of its current epoch
-- may be renewed at the deadline, like one a CI extension put there.
create or replace function clued_private.work_claim_ci_extended_to_v1(c clued_private.work_claims_v1) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.clued_audit_receipts r where r.user_id=c.user_id
    and r.context_key=c.context_key and r.created_at>=c.issued_at
    and r.operation='work_claim_lease_extend_by_ci'
    and r.object_id=c.claim_id::text and (r.metadata->>'expires_at')::timestamptz=c.expires_at)
  or (c.expires_at=c.hard_deadline_at and exists(select 1 from clued_private.work_claim_head_authorizations_v1 a
    where a.claim_id=c.claim_id and a.execution_epoch=c.execution_epoch and a.binding_id=c.holder_binding_id
      and a.workflow is null and a.revoked_at is null))
$$;

-- The PR stops (closed or merged): when the Task has no other active PR, its
-- live claims go back to the ordinary lease from now, never longer than they
-- have.
do $copy_pin_finish$
declare definition text;
begin
  definition:=pg_catalog.pg_get_functiondef(
    'clued_private.work_claim_pr_finish_v1(public.clued_agent_bindings,text,text,text)'::regprocedure);
  execute replace(definition,'FUNCTION clued_private.work_claim_pr_finish_v1(',
    'FUNCTION clued_private.work_claim_pr_finish_before_lease_pin_v1(');
end $copy_pin_finish$;
create or replace function clued_private.work_claim_pr_finish_v1(b public.clued_agent_bindings,p_scope text,p_pr text,p_status text)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare receipt uuid; target clued_private.work_claim_pr_task_bindings_v1; v_now timestamptz:=pg_catalog.clock_timestamp();
begin
  receipt:=clued_private.work_claim_pr_finish_before_lease_pin_v1(b,p_scope,p_pr,p_status);
  if receipt is null or p_status not in ('closed','merged') then return receipt; end if;
  select * into target from clued_private.work_claim_pr_task_bindings_v1
    where user_id=b.user_id and repo_id=lower(split_part(p_pr,'#',1)) and pr_number=split_part(p_pr,'#',2)::bigint;
  if not exists(select 1 from clued_private.work_claim_pr_task_bindings_v1 o
      where o.user_id=target.user_id and o.task_id=target.task_id and o.status='active') then
    update clued_private.work_claims_v1 w
      set expires_at=v_now+make_interval(secs=>(clued_private.work_claim_profile_v1()->>'lease_seconds')::integer)
      where w.user_id=target.user_id and w.task_id=target.task_id and w.status='ACTIVE'
        and w.expires_at>v_now+make_interval(secs=>(clued_private.work_claim_profile_v1()->>'lease_seconds')::integer);
  end if;
  return receipt;
end $$;

revoke all on function
  clued_private.work_claim_authorize_head_before_lease_pin_v1(text,jsonb),
  clued_private.work_claim_authorize_head_v1(text,jsonb),
  clued_private.work_claim_ci_extended_to_v1(clued_private.work_claims_v1),
  clued_private.work_claim_pr_finish_before_lease_pin_v1(public.clued_agent_bindings,text,text,text),
  clued_private.work_claim_pr_finish_v1(public.clued_agent_bindings,text,text,text)
  from public,anon,authenticated,service_role,clued_worker_gateway;

notify pgrst,'reload schema';
