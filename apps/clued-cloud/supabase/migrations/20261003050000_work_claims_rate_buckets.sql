-- Work Claim rate buckets (GenericWorkClaim.v0.1.md §10.3, §10.7 step 1;
-- Decisions 136a000e, d3d0bbe8; Task 00af11e4).
--
-- The per-Task count (max_claims_per_task_24h: 10 new claims or takeovers in
-- any 24 hours) is replaced by two token buckets on starts, so stepwise
-- claim-and-release and one long renewed claim both fit and a refusal waits
-- at most one refill interval:
--   * per Task: capacity 8, one token back every hour;
--   * per Binding: capacity 30, one token back every 15 minutes.
-- A new claim or takeover takes one token from each. Renew, release, verify,
-- an idempotent replay and a refused attempt take none. A bucket without a
-- row is full.
--
-- The exemption is kept (Decision 00b6dcf4) and wired as before (Decision
-- d3d0bbe8): when a bucket is short, a legacy exemption with allowance left,
-- else one use of an Owner Grant for work_claim.extra_claims on the Task,
-- admits the start without taking a token. Otherwise the refusal is still
-- work_claim_budget_exhausted, now with limit task_claim_rate or
-- binding_claim_rate, the buckets' state, retry_after and the Owner Request,
-- so the served contract and existing Agents handle it unchanged.
--
-- Refusals issued here (conflict, live-claim caps, rate) now leave a
-- WORK_CLAIM_REJECTED Receipt (Task 91272c5d), at most one per Binding, Task,
-- error and limit a minute, so a retry loop cannot flood the Receipt stream.

create table clued_private.work_claim_rate_buckets_v1 (
  user_id uuid not null references auth.users(id) on delete cascade,
  bucket_kind text not null check (bucket_kind in ('task','binding')),
  key_id uuid not null,
  tokens numeric not null check (tokens>=0),
  updated_at timestamptz not null,
  primary key (user_id,bucket_kind,key_id)
);
alter table clued_private.work_claim_rate_buckets_v1 enable row level security;
revoke all on table clued_private.work_claim_rate_buckets_v1 from public,anon,authenticated,service_role;

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
    'max_heads_per_claim',20)
$$;

-- Tokens a bucket holds at p_now: its stored level plus what refilled since,
-- capped at capacity; full when it has no row yet.
create function clued_private.work_claim_bucket_level_v1(p_user_id uuid,p_kind text,p_key uuid,
  p_capacity integer,p_refill_seconds integer,p_now timestamptz) returns numeric
language sql stable set search_path='' as $$
  select coalesce((select least(p_capacity::numeric,
      b.tokens+greatest(extract(epoch from (p_now-b.updated_at)),0)::numeric/p_refill_seconds)
    from clued_private.work_claim_rate_buckets_v1 b
    where b.user_id=p_user_id and b.bucket_kind=p_kind and b.key_id=p_key),p_capacity::numeric)
$$;

-- Takes one token from a level read under the same work_claim_lock.
create function clued_private.work_claim_bucket_take_v1(p_user_id uuid,p_kind text,p_key uuid,
  p_level numeric,p_now timestamptz) returns void
language sql volatile set search_path='' as $$
  insert into clued_private.work_claim_rate_buckets_v1(user_id,bucket_kind,key_id,tokens,updated_at)
  values(p_user_id,p_kind,p_key,greatest(p_level-1,0),p_now)
  on conflict (user_id,bucket_kind,key_id) do update set tokens=excluded.tokens,updated_at=excluded.updated_at
$$;

-- A refusal from work_claim_issue, with its Receipt.
create function clued_private.work_claim_reject_logged_v1(p_binding public.clued_agent_bindings,
  p_task public.clued_memories,p_operation text,p_code text,p_detail jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_limit text:=p_detail->>'limit';
begin
  if not exists(select 1 from public.clued_audit_receipts r
      where r.user_id=p_binding.user_id and r.context_key=p_task.canonical_scope
        and r.created_at>pg_catalog.clock_timestamp()-interval '1 minute'
        and r.operation='work_claim_reject' and r.binding_id=p_binding.id and r.object_id=p_task.id::text
        and r.metadata->>'error_code'=p_code and r.metadata->>'limit' is not distinct from v_limit) then
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(p_binding.user_id,p_binding.id,p_task.canonical_scope,'work_claim_reject','work_claim_rejection',
      p_task.id::text,1,jsonb_build_object('receipt_kind','WORK_CLAIM_REJECTED','attempted_operation',p_operation,
        'error_code',p_code,'limit',v_limit,'task_id',p_task.id,'retry_after',p_detail->'retry_after',
        'conflicting_claim_ids',(select jsonb_agg(c->'claim_id')
          from jsonb_array_elements(coalesce(p_detail->'conflicts','[]'::jsonb)) c)));
  end if;
  return clued_private.work_claim_rejected(p_code,p_detail);
end $$;

revoke all on function clued_private.work_claim_bucket_level_v1(uuid,text,uuid,integer,integer,timestamptz),
  clued_private.work_claim_bucket_take_v1(uuid,text,uuid,numeric,timestamptz),
  clued_private.work_claim_reject_logged_v1(public.clued_agent_bindings,public.clued_memories,text,text,jsonb)
  from public,anon,authenticated,service_role;

-- work_claim_issue: unchanged from 20261003030000 except the cap branch, which
-- uses the rate buckets, and refusals, which go through
-- work_claim_reject_logged_v1.
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
          'owner_request',clued_private.owner_request_public_v1(v_request)));
    end if;
  else
    perform clued_private.work_claim_bucket_take_v1(p_binding.user_id,'task',p_task.id,v_task_tokens,v_now);
    perform clued_private.work_claim_bucket_take_v1(p_binding.user_id,'binding',p_binding.id,v_binding_tokens,v_now);
  end if;

  select coalesce(max(w.fence),0)+1 into v_fence from clued_private.work_claims_v1 w
    where w.user_id=p_binding.user_id and w.task_id=p_task.id;
  insert into clued_private.work_claims_v1(user_id,task_id,context_key,holder_binding_id,
    holder_session_ref,base_commit,write_set,trigger_refs,fence,lease_version,issued_at,
    expires_at,hard_deadline_at,budget,status,idempotency_key)
  values(p_binding.user_id,p_task.id,p_task.canonical_scope,p_binding.id,v_session,v_base,
    v_write_set,v_triggers,v_fence,1,v_now,v_now+v_lease,
    v_now+make_interval(secs=>(v_profile->>'hard_deadline_seconds')::integer),
    v_budget||jsonb_build_object('profile_id',v_profile->>'profile_id'),'ACTIVE',
    p_input->>'idempotency_key')
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
          'owner_grant_use',(v_grant->>'use')::integer) end)
  returning id into v_receipt;
  update clued_private.work_claims_v1 set receipt_id=v_receipt where claim_id=v_claim.claim_id
    returning * into v_claim;
  return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,
    'claim',clued_private.work_claim_view(v_claim));
end $$;

notify pgrst,'reload schema';
