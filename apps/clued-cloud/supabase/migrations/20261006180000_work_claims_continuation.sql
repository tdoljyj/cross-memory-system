-- Work Claim continuation (Owner Decision 754dff5d, Task a881f82b;
-- GenericWorkClaim §10.8).
--
-- The rate buckets (20261003050000, Decision 136a000e) were meant to fit both
-- ways of working, claim per step and one renewed claim, but at one Task
-- token an hour they fit a stepwise Agent only at one step an hour: Task
-- 1502fd80 claimed 22 times in six hours and every refusal needed an Owner
-- Grant. A continuation makes a step boundary cost what a renewal costs.
--
-- A new claim (not a takeover, not a race copy) continues the Task's last
-- claim when all of these hold:
--   1. that claim is the Task's latest (no other claim of the Task since),
--      held by this Binding, and both name the same holder_session_ref (a
--      claim without one never continues);
--   2. it was released as completed, by its holder, without the lease key,
--      not handed over by the Owner, not a race copy, with an evidence_ref
--      that no earlier claim of the chain released with;
--   3. the new claim comes within continuation_window_seconds (900) of that
--      release, and at least a minute before the chain's hard deadline;
--   4. no claim conflict refusal named it while it was live (contested_at),
--      and no Agent message request from another session was addressed to it.
-- A continuation takes no Task or Binding token and no Owner Grant use. It
-- keeps the first claim's hard deadline (the chain is bounded by 24 hours as
-- one renewed claim is), starts at renewals 0, and its lease ends at the
-- earlier of the usual lease and that deadline. The claim, its Receipt and
-- the answer name continued_from. Otherwise the start goes to the buckets as
-- before; a rate refusal then carries continuation.reason.

alter table clued_private.work_claims_v1
  add column continued_from uuid references clued_private.work_claims_v1(claim_id) on delete set null,
  add column chain_evidence_refs text[] not null default '{}'::text[],
  add column contested_at timestamptz;

-- Profile: 20261006120000 plus continuation_window_seconds.
create or replace function clued_private.work_claim_profile_v1() returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_object(
    'profile_id','work-claim-v1-default',
    'lease_seconds',7200,
    'hard_deadline_seconds',86400,
    'max_renewals',12,
    'max_active_per_session',3,
    'max_active_per_binding',10,
    'task_claim_bucket_capacity',8,
    'task_claim_bucket_refill_seconds',3600,
    'binding_claim_bucket_capacity',30,
    'binding_claim_bucket_refill_seconds',900,
    'github_ci_heads_per_task_24h',40,
    'merge_slot_seconds',2700,
    'continuation_window_seconds',900)
$$;

-- work_claim_view: 20261006120000 plus continued_from.
create or replace function clued_private.work_claim_view(c clued_private.work_claims_v1) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('claim_id',c.claim_id,'task_id',c.task_id,'context_key',c.context_key,
    'holder_binding_id',c.holder_binding_id,'holder_session_ref',c.holder_session_ref,
    'holder_label',c.holder_label,'holder_client',c.holder_client,'holder_session_title',c.holder_session_title,
    'base_commit',c.base_commit,'write_set',to_jsonb(c.write_set),'trigger_refs',to_jsonb(c.trigger_refs),
    'fence',c.fence,'lease_version',c.lease_version,'issued_at',c.issued_at,
    'expires_at',c.expires_at,'hard_deadline_at',c.hard_deadline_at,'renewals',c.renewals,
    'progress_ref',c.progress_ref,'budget',c.budget,'status',c.status,
    'released_outcome',c.released_outcome,'superseded_by',c.superseded_by,'receipt_id',c.receipt_id,
    'bound_pr',c.bound_pr,'copy_index',c.copy_index,'outcome',c.outcome,
    'lease_key_required',c.lease_key_required,
    'merge_slot_until',case when clued_private.work_claim_merge_slot_live_v1(c)
      then clued_private.work_claim_merge_slot_until_v1(c) end,
    'continued_from',c.continued_from)
$$;

-- work_claim_reject_log_v1: 20261003070000, plus every refusal that names
-- conflicting claims marks them contested_at, whether or not the rate-limited
-- Receipt is written. A contested claim is never continued.
create or replace function clued_private.work_claim_reject_log_v1(p_binding public.clued_agent_bindings,
  p_context_key text,p_task_id uuid,p_claim_id uuid,p_operation text,p_code text,p_detail jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_limit text:=p_detail->>'limit'; v_object text:=coalesce(p_task_id,p_claim_id)::text;
begin
  update clued_private.work_claims_v1 w set contested_at=pg_catalog.clock_timestamp()
    where w.user_id=p_binding.user_id and w.contested_at is null
      and w.claim_id in (select (c->>'claim_id')::uuid
        from jsonb_array_elements(coalesce(p_detail->'conflicts','[]'::jsonb)) c
        where c->>'claim_id' ~* '^[0-9a-f-]{36}$');
  if v_object is not null and not exists(select 1 from public.clued_audit_receipts r
      where r.user_id=p_binding.user_id and r.context_key=p_context_key
        and r.created_at>pg_catalog.clock_timestamp()-interval '1 minute'
        and r.operation='work_claim_reject' and r.binding_id=p_binding.id and r.object_id=v_object
        and r.metadata->>'error_code'=p_code and r.metadata->>'limit' is not distinct from v_limit) then
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(p_binding.user_id,p_binding.id,p_context_key,'work_claim_reject','work_claim_rejection',
      v_object,1,jsonb_build_object('receipt_kind','WORK_CLAIM_REJECTED','attempted_operation',p_operation,
        'error_code',p_code,'limit',v_limit,'task_id',p_task_id,'retry_after',p_detail->'retry_after',
        'conflicting_claim_ids',(select jsonb_agg(c->'claim_id')
          from jsonb_array_elements(coalesce(p_detail->'conflicts','[]'::jsonb)) c))
        ||case when p_claim_id is null then '{}'::jsonb else jsonb_build_object('claim_id',p_claim_id) end);
  end if;
  return clued_private.work_claim_rejected(p_code,p_detail);
end $$;

-- Whether a new claim of p_task by this Binding and session continues the
-- Task's last claim. Returns null when the Task has no claim yet;
-- {continued_from, hard_deadline_at, chain_evidence_refs} when it continues;
-- otherwise {reason, prior_claim_id}. Called under work_claim_lock.
create function clued_private.work_claim_continuation_v1(p_binding public.clued_agent_bindings,
  p_task public.clued_memories,p_session text,p_now timestamptz) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare p clued_private.work_claims_v1%rowtype; r public.clued_audit_receipts%rowtype;
  v_evidence text; v_reason text;
  v_window integer:=(clued_private.work_claim_profile_v1()->>'continuation_window_seconds')::integer;
begin
  select * into p from clued_private.work_claims_v1 w
    where w.user_id=p_binding.user_id and w.task_id=p_task.id
    order by w.fence desc,w.issued_at desc limit 1;
  if not found then return null; end if;
  if p.status='RELEASED' then
    select * into r from public.clued_audit_receipts x
      where x.user_id=p.user_id and x.context_key=p.context_key and x.created_at>=p.issued_at
        and x.operation='work_claim_release' and x.object_id=p.claim_id::text
        and x.metadata->>'receipt_kind'='WORK_CLAIM_RELEASED'
      order by x.created_at desc limit 1;
    v_evidence:=nullif(btrim(coalesce(r.metadata->>'evidence_ref','')),'');
  end if;
  v_reason:=case
    when p_session is null then 'no_session_ref'
    when p.holder_binding_id<>p_binding.id or p.holder_session_ref is distinct from p_session
      then 'prior_other_holder'
    when p.status<>'RELEASED' or p.released_outcome is distinct from 'completed' then 'prior_not_completed'
    when p.copy_index is not null then 'prior_race_copy'
    when p.lease_key_required then 'prior_handed_over'
    when r.id is null or r.binding_id<>p_binding.id
      or coalesce((r.metadata->>'via_lease_key')::boolean,false) then 'prior_released_by_other'
    when p_now>r.created_at+make_interval(secs=>v_window) then 'window_passed'
    when p_now+interval '1 minute'>p.hard_deadline_at then 'chain_deadline_reached'
    when v_evidence is null or v_evidence=any(p.chain_evidence_refs) then 'no_new_evidence'
    when p.contested_at is not null then 'prior_contested'
    when exists(select 1 from clued_private.agent_messages_v1 m
        where m.user_id=p.user_id and m.to_claim_id=p.claim_id and m.kind='request'
          and not (m.sender_binding_id=p_binding.id and m.sender_session_ref is not distinct from p_session))
      then 'prior_requested'
  end;
  if v_reason is not null then
    return jsonb_build_object('reason',v_reason,'prior_claim_id',p.claim_id);
  end if;
  return jsonb_build_object('continued_from',p.claim_id,'hard_deadline_at',p.hard_deadline_at,
    'chain_evidence_refs',to_jsonb(p.chain_evidence_refs||v_evidence));
end $$;

-- work_claim_issue: 20261003120000 except the continuation, which skips the
-- rate buckets and the exemption and Owner Grant they fall back to.
create or replace function clued_private.work_claim_issue(
  p_binding public.clued_agent_bindings,p_input jsonb,p_task public.clued_memories,
  p_supersedes clued_private.work_claims_v1,p_operation text
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_profile jsonb:=clued_private.work_claim_profile_v1();
  v_write_set text[]; v_triggers text[]; v_conflicts jsonb; v_active integer;
  v_fence bigint; v_lease interval; v_now timestamptz:=pg_catalog.clock_timestamp();
  v_claim clued_private.work_claims_v1%rowtype; v_receipt uuid; v_budget jsonb;
  v_session text:=nullif(btrim(coalesce(p_input->>'holder_session_ref','')),'');
  v_base text:=nullif(btrim(coalesce(p_input->>'base_commit','')),'');
  v_lease_seconds integer; v_active_session integer; v_retry_after timestamptz;
  v_exemption_id uuid; v_grant jsonb; v_resources text[]; v_request clued_private.owner_requests_v1%rowtype;
  v_request_receipt uuid; v_task_tokens numeric; v_binding_tokens numeric; v_short text;
  v_task_capacity integer:=(v_profile->>'task_claim_bucket_capacity')::integer;
  v_task_refill integer:=(v_profile->>'task_claim_bucket_refill_seconds')::integer;
  v_binding_capacity integer:=(v_profile->>'binding_claim_bucket_capacity')::integer;
  v_binding_refill integer:=(v_profile->>'binding_claim_bucket_refill_seconds')::integer;
  v_race clued_private.work_claim_task_modes_v1%rowtype; v_copy integer;
  v_cont jsonb; v_hard timestamptz;
begin
  if p_input ? 'write_set' then
    v_write_set:=clued_private.work_claim_normalize_paths(p_input->'write_set');
  elsif p_supersedes.claim_id is not null then
    v_write_set:=p_supersedes.write_set;
  else
    raise exception 'work_claim_write_set_invalid' using errcode='22023';
  end if;
  if p_input ? 'trigger_refs' then
    v_triggers:=clued_private.work_claim_normalize_triggers(p_input->'trigger_refs');
  elsif p_supersedes.claim_id is not null then
    v_triggers:=p_supersedes.trigger_refs;
  else
    v_triggers:='{}'::text[];
  end if;
  if v_base is not null and v_base !~ '^[0-9a-f]{7,64}$' then
    raise exception 'work_claim_base_commit_invalid' using errcode='22023'; end if;
  v_lease_seconds:=coalesce((p_input->>'lease_seconds')::integer,(v_profile->>'lease_seconds')::integer);
  if v_lease_seconds<60 or v_lease_seconds>(v_profile->>'lease_seconds')::integer then
    raise exception 'work_claim_lease_seconds_invalid' using errcode='22023'; end if;
  v_lease:=make_interval(secs=>v_lease_seconds);
  v_budget:=coalesce(p_input->'budget','{}'::jsonb);
  if jsonb_typeof(v_budget)<>'object' then
    raise exception 'work_claim_budget_invalid' using errcode='22023'; end if;

  v_conflicts:=clued_private.work_claim_conflicts(p_binding.user_id,p_task.id,v_write_set,
    v_triggers,p_supersedes.claim_id);
  if jsonb_array_length(v_conflicts)>0 then
    return clued_private.work_claim_reject_logged_v1(p_binding,p_task,p_operation,'work_claim_conflict',
      jsonb_build_object('conflicts',v_conflicts,'task_id',p_task.id,
        'write_set',to_jsonb(v_write_set),'trigger_refs',to_jsonb(v_triggers)));
  end if;
  -- One session (holder_session_ref, as the Agent declares it; claims without
  -- one share a group) holds at most max_active_per_session live claims, and
  -- all sessions of one Binding together at most max_active_per_binding.
  select count(*)::integer,
         count(*) filter (where coalesce(w.holder_session_ref,'')=coalesce(v_session,''))::integer
    into v_active,v_active_session from clued_private.work_claims_v1 w
    where w.user_id=p_binding.user_id and w.holder_binding_id=p_binding.id
      and w.status in ('ACTIVE','DRAINING') and w.expires_at>v_now;
  if v_active_session>=(v_profile->>'max_active_per_session')::integer then
    return clued_private.work_claim_reject_logged_v1(p_binding,p_task,p_operation,'work_claim_budget_exhausted',
      jsonb_build_object('limit','max_active_per_session',
        'max_active_per_session',(v_profile->>'max_active_per_session')::integer,
        'max_active_per_binding',(v_profile->>'max_active_per_binding')::integer,
        'active',v_active_session,'active_binding',v_active,'holder_session_ref',v_session));
  end if;
  if v_active>=(v_profile->>'max_active_per_binding')::integer then
    return clued_private.work_claim_reject_logged_v1(p_binding,p_task,p_operation,'work_claim_budget_exhausted',
      jsonb_build_object('limit','max_active_per_binding',
        'max_active_per_session',(v_profile->>'max_active_per_session')::integer,
        'max_active_per_binding',(v_profile->>'max_active_per_binding')::integer,
        'active',v_active,'active_session',v_active_session));
  end if;

  -- Multi-copy (GenericWorkClaim §5.3): while the Owner's race on this Task is
  -- open, each claim takes the lowest free copy slot (a takeover keeps the
  -- slot of the copy it replaces). A full race refuses here, before any
  -- token or grant use is spent.
  v_race:=clued_private.work_claim_open_race_v1(p_binding.user_id,p_task.id);
  if v_race.task_id is not null then
    if p_supersedes.copy_index is not null then
      v_copy:=p_supersedes.copy_index;
    else
      select min(k) into v_copy from generate_series(1,v_race.copies) k
        where not exists(select 1 from clued_private.work_claims_v1 w
          where w.user_id=p_binding.user_id and w.task_id=p_task.id and w.copy_index=k
            and w.status in ('ACTIVE','DRAINING'));
    end if;
    if v_copy is null then
      return clued_private.work_claim_reject_logged_v1(p_binding,p_task,p_operation,'work_claim_copies_full',
        jsonb_build_object('task_id',p_task.id,'copies',v_race.copies,
          'live_copies',coalesce((select jsonb_agg(jsonb_build_object('claim_id',w.claim_id,
              'copy_index',w.copy_index,'holder_binding_id',w.holder_binding_id,
              'holder_session_ref',w.holder_session_ref,'expires_at',w.expires_at) order by w.copy_index)
            from clued_private.work_claims_v1 w where w.user_id=p_binding.user_id and w.task_id=p_task.id
              and w.copy_index is not null and w.status in ('ACTIVE','DRAINING')),'[]'::jsonb)));
    end if;
  end if;

  -- Continuation (Decision 754dff5d): a new claim that picks up, in the same
  -- session, the work its own claim of this Task released as completed a
  -- moment ago is not a start. It takes no token and no Owner Grant use,
  -- keeps the first claim's hard deadline and names the claim it continues.
  -- Not for a takeover or a race copy. When it does not qualify, the reason
  -- rides on a rate refusal.
  if p_operation='work_claim' and p_supersedes.claim_id is null and v_race.task_id is null then
    v_cont:=clued_private.work_claim_continuation_v1(p_binding,p_task,v_session,v_now);
  end if;
  if v_cont ? 'continued_from' then
    v_hard:=(v_cont->>'hard_deadline_at')::timestamptz;
  else
    -- Rate buckets (GenericWorkClaim §10.3, Decision 136a000e) replace the
    -- per-Task 24-hour count. A start (new claim or takeover) needs a token in
    -- both the Task bucket and the Binding bucket and takes one from each;
    -- buckets refill continuously up to capacity. How the work is split into
    -- claims, and how a claim ended, do not matter.
    v_task_tokens:=clued_private.work_claim_bucket_level_v1(p_binding.user_id,'task',p_task.id,
      v_task_capacity,v_task_refill,v_now);
    v_binding_tokens:=clued_private.work_claim_bucket_level_v1(p_binding.user_id,'binding',p_binding.id,
      v_binding_capacity,v_binding_refill,v_now);
    v_short:=case when v_task_tokens<1 then 'task_claim_rate'
      when v_binding_tokens<1 then 'binding_claim_rate' end;
    if v_short is not null then
      -- The exemption stays (Decision 00b6dcf4), wired as before (Decision
      -- d3d0bbe8): a legacy exemption still valid with allowance left, else one
      -- use of an Owner Grant for work_claim.extra_claims on this Task, admits
      -- this start without taking a token. Nothing after this point rejects,
      -- so a consumed use always becomes a claim.
      select e.id into v_exemption_id from clued_private.work_claim_exemptions_v1 e
        where e.user_id=p_binding.user_id and e.task_id=p_task.id and e.expires_at>v_now
          and (select count(*) from clued_private.work_claims_v1 w
                where w.user_id=e.user_id and w.task_id=e.task_id and w.issued_at>=e.granted_at)<e.extra_claims
        order by e.granted_at limit 1;
      if v_exemption_id is null then
        v_resources:=clued_private.work_claim_normalize_paths(jsonb_build_array('record:'||p_task.id::text));
        v_grant:=clued_private.owner_grant_consume_v1(p_binding.user_id,p_binding.id,'work_claim.extra_claims',
          v_resources,p_task.id);
      end if;
      if v_exemption_id is null and v_grant is null then
        -- The next token arrives when every short bucket is back to one.
        v_retry_after:=v_now+make_interval(secs=>greatest(
          case when v_task_tokens<1 then (1-v_task_tokens)*v_task_refill else 0 end,
          case when v_binding_tokens<1 then (1-v_binding_tokens)*v_binding_refill else 0 end)::double precision);
        -- Ask the Owner: reuse this Binding's pending request for the Task, or
        -- open one. The refusal carries it; only the Owner can approve it, on
        -- the signed-in confirmation page.
        perform clued_private.owner_grant_lock_v1(p_binding.user_id);
        select * into v_request from clued_private.owner_requests_v1 r
          where r.user_id=p_binding.user_id and r.binding_id=p_binding.id and r.action='work_claim.extra_claims'
            and r.task_id=p_task.id and r.status='pending' and r.expires_at>v_now
          order by r.created_at desc limit 1;
        if not found then
          v_resources:=clued_private.work_claim_normalize_paths(jsonb_build_array('record:'||p_task.id::text));
          insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
          values(p_binding.user_id,p_binding.id,p_task.canonical_scope,'owner_request_create','owner_request',p_task.id::text,1,
            jsonb_build_object('receipt_kind','OWNER_REQUEST_CREATED','action','work_claim.extra_claims',
              'resources',to_jsonb(v_resources),'task_id',p_task.id,'origin','work_claim_budget_exhausted','limit',v_short))
          returning id into v_request_receipt;
          insert into clued_private.owner_requests_v1(user_id,binding_id,idempotency_key,action,resources,task_id,
            suggested_expires_seconds,suggested_max_uses,expires_at,receipt_id)
          values(p_binding.user_id,p_binding.id,'work-claim-cap:'||p_task.id::text||':'||gen_random_uuid()::text,
            'work_claim.extra_claims',v_resources,p_task.id,86400,5,v_now+interval '24 hours',v_request_receipt)
          returning * into v_request;
        end if;
        return clued_private.work_claim_reject_logged_v1(p_binding,p_task,p_operation,'work_claim_budget_exhausted',
          jsonb_build_object('limit',v_short,'task_id',p_task.id,'retry_after',v_retry_after,
            'task_bucket',jsonb_build_object('tokens',round(v_task_tokens,2),'capacity',v_task_capacity,
              'refill_seconds',v_task_refill),
            'binding_bucket',jsonb_build_object('tokens',round(v_binding_tokens,2),'capacity',v_binding_capacity,
              'refill_seconds',v_binding_refill),
            'owner_request',clued_private.owner_request_public_v1(v_request))
            ||case when v_cont is null then '{}'::jsonb else jsonb_build_object('continuation',v_cont) end);
      end if;
    else
      perform clued_private.work_claim_bucket_take_v1(p_binding.user_id,'task',p_task.id,v_task_tokens,v_now);
      perform clued_private.work_claim_bucket_take_v1(p_binding.user_id,'binding',p_binding.id,v_binding_tokens,v_now);
    end if;
  end if;

  select coalesce(max(w.fence),0)+1 into v_fence from clued_private.work_claims_v1 w
    where w.user_id=p_binding.user_id and w.task_id=p_task.id;
  insert into clued_private.work_claims_v1(user_id,task_id,context_key,holder_binding_id,
    holder_session_ref,base_commit,write_set,trigger_refs,fence,lease_version,issued_at,
    expires_at,hard_deadline_at,budget,status,idempotency_key,copy_index,continued_from,chain_evidence_refs)
  values(p_binding.user_id,p_task.id,p_task.canonical_scope,p_binding.id,v_session,v_base,
    v_write_set,v_triggers,v_fence,1,v_now,least(v_now+v_lease,coalesce(v_hard,'infinity'::timestamptz)),
    coalesce(v_hard,v_now+make_interval(secs=>(v_profile->>'hard_deadline_seconds')::integer)),
    v_budget||jsonb_build_object('profile_id',v_profile->>'profile_id'),'ACTIVE',
    p_input->>'idempotency_key',v_copy,(v_cont->>'continued_from')::uuid,
    coalesce((select array_agg(e) from jsonb_array_elements_text(v_cont->'chain_evidence_refs') e),'{}'::text[]))
  returning * into v_claim;
  if p_supersedes.claim_id is not null then
    update clued_private.work_claims_v1 set status='SUPERSEDED',superseded_by=v_claim.claim_id,
      updated_at=v_now where claim_id=p_supersedes.claim_id;
  end if;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,
    object_type,object_id,version,metadata)
  values(p_binding.user_id,p_binding.id,p_task.canonical_scope,p_operation,'work_claim',
    v_claim.claim_id::text,v_claim.fence,jsonb_build_object(
      'receipt_kind',case p_operation when 'work_claim' then 'WORK_CLAIM_ISSUED'
        else 'WORK_CLAIM_TAKEOVER' end,
      'claim_id',v_claim.claim_id,'task_id',v_claim.task_id,'fence',v_claim.fence,
      'lease_version',v_claim.lease_version,'write_set',to_jsonb(v_claim.write_set),
      'trigger_refs',to_jsonb(v_claim.trigger_refs),'base_commit',v_claim.base_commit,
      'expires_at',v_claim.expires_at,'hard_deadline_at',v_claim.hard_deadline_at,
      'supersedes',p_supersedes.claim_id,'superseded_fence',p_supersedes.fence,
      'idempotency_key',p_input->>'idempotency_key','profile',v_profile)
      ||case when v_exemption_id is null then '{}'::jsonb
        else jsonb_build_object('exemption_id',v_exemption_id) end
      ||case when v_grant is null then '{}'::jsonb
        else jsonb_build_object('owner_grant_id',v_grant->>'grant_id','owner_grant_receipt_id',v_grant->>'receipt_id',
          'owner_grant_use',(v_grant->>'use')::integer) end
      ||case when v_copy is null then '{}'::jsonb
        else jsonb_build_object('copy_index',v_copy,'copies',v_race.copies) end
      ||case when v_claim.continued_from is null then '{}'::jsonb
        else jsonb_build_object('continued_from',v_claim.continued_from) end)
  returning id into v_receipt;
  update clued_private.work_claims_v1 set receipt_id=v_receipt where claim_id=v_claim.claim_id
    returning * into v_claim;
  return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,
    'claim',clued_private.work_claim_view(v_claim))
    ||case when v_claim.continued_from is null then '{}'::jsonb
      else jsonb_build_object('continued_from',v_claim.continued_from) end
    ||case when v_copy is null then '{}'::jsonb
      else jsonb_build_object('claim_mode',jsonb_build_object('mode','multi','copies',v_race.copies,
        'copy_index',v_copy,'shared_resources',to_jsonb(v_race.shared_resources))) end;
end $$;

revoke all on function
  clued_private.work_claim_continuation_v1(public.clued_agent_bindings,public.clued_memories,text,timestamptz),
  clued_private.work_claim_reject_log_v1(public.clued_agent_bindings,text,uuid,uuid,text,text,jsonb),
  clued_private.work_claim_issue(public.clued_agent_bindings,jsonb,public.clued_memories,clued_private.work_claims_v1,text)
  from public,anon,authenticated,service_role;
