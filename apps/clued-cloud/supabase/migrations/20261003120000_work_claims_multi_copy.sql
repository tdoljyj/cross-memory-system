-- Generic Work Claim v0.1, §7.2 step 3: multi-copy mode (a "race"), §5.3
-- (Task 5d379c50, Decisions 2a7391ff and 357fce4f).
--
-- Only the Owner turns a Task into a race, from the signed-in Clued page in
-- two Native steps (clued_work_claim_multi_confirmation_issue_v1, then
-- clued_work_claim_multi_enable_v1); no MCP tool, OAuth case or Binding can.
-- The race names its copies (2 .. the Task token-bucket capacity) and the
-- shared resources a copy writes back to.
-- While the race is open:
--   - each claim of the Task takes the lowest free copy slot (copy_index);
--     copies never conflict with each other, for the Task or for resources,
--     and still conflict with other Tasks' claims as before;
--   - each copy is a start: it takes Task and Binding tokens as any claim;
--   - verify (GitHub door) admits every live copy on its own pull request.
-- The first copy to write back is adopted (work_claim_adopt_core_v1):
--   - Clued storage: a copy whose write touches the shared resources, in the
--     storage write's own transaction (work_claim_gate_v1);
--   - GitHub: clued_work_claim_adopt_v1, called by the admission workflow
--     when a copy's pull request is merged.
-- The other copies are then out (outcome not_adopted, live ones SUPERSEDED)
-- and every door refuses them with copy_not_adopted. After adoption the Task
-- is exclusive again.

create table clued_private.work_claim_task_modes_v1 (
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.clued_memories(id) on delete cascade,
  mode text not null check (mode='multi'),
  copies integer not null check (copies between 2 and 50),
  shared_resources text[] not null check (cardinality(shared_resources) between 1 and 50),
  enabled_at timestamptz not null default clock_timestamp(),
  enabled_session_id text not null,
  token_id uuid not null unique references clued_private.native_confirmation_tokens(id),
  receipt_id uuid not null unique references public.clued_audit_receipts(id),
  adopted_claim_id uuid references clued_private.work_claims_v1(claim_id),
  adopted_at timestamptz,
  adopted_receipt_id uuid references public.clued_audit_receipts(id),
  primary key (user_id,task_id),
  check ((adopted_claim_id is null)=(adopted_at is null) and (adopted_at is null)=(adopted_receipt_id is null))
);
alter table clued_private.work_claim_task_modes_v1 enable row level security;
revoke all on table clued_private.work_claim_task_modes_v1 from public,anon,authenticated,service_role;

alter table clued_private.work_claims_v1
  add column copy_index integer check (copy_index between 1 and 50),
  add column outcome text check (outcome in ('adopted','not_adopted'));
-- One live claim per exclusive Task; one live claim per copy slot.
drop index clued_private.work_claims_v1_one_live_per_task;
create unique index work_claims_v1_one_live_per_task
  on clued_private.work_claims_v1(user_id,task_id) where status in ('ACTIVE','DRAINING') and copy_index is null;
create unique index work_claims_v1_one_live_per_copy
  on clued_private.work_claims_v1(user_id,task_id,copy_index)
  where status in ('ACTIVE','DRAINING') and copy_index is not null;

-- The Owner's race on a Task while no copy has been adopted; a null row otherwise.
create function clued_private.work_claim_open_race_v1(p_user uuid,p_task uuid)
returns clued_private.work_claim_task_modes_v1
language sql stable security definer set search_path='' as $$
  select * from clued_private.work_claim_task_modes_v1 m
    where m.user_id=p_user and m.task_id=p_task and m.adopted_claim_id is null
$$;

create or replace function clued_private.work_claim_view(c clued_private.work_claims_v1) returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_object('claim_id',c.claim_id,'task_id',c.task_id,'context_key',c.context_key,
    'holder_binding_id',c.holder_binding_id,'holder_session_ref',c.holder_session_ref,
    'base_commit',c.base_commit,'write_set',to_jsonb(c.write_set),'trigger_refs',to_jsonb(c.trigger_refs),
    'fence',c.fence,'lease_version',c.lease_version,'issued_at',c.issued_at,
    'expires_at',c.expires_at,'hard_deadline_at',c.hard_deadline_at,'renewals',c.renewals,
    'progress_ref',c.progress_ref,'budget',c.budget,'status',c.status,
    'released_outcome',c.released_outcome,'superseded_by',c.superseded_by,'receipt_id',c.receipt_id,
    'bound_pr',c.bound_pr,'copy_index',c.copy_index,'outcome',c.outcome)
$$;

-- work_claim_conflicts: unchanged from 20261002072000 except that the copies
-- of a Task in an open race are skipped for that Task.
create or replace function clued_private.work_claim_conflicts(
  p_user_id uuid,p_task_id uuid,p_write_set text[],p_triggers text[],p_exclude uuid
) returns jsonb language plpgsql stable set search_path='' as $$
declare v_out jsonb:='[]'::jsonb; c clued_private.work_claims_v1%rowtype;
  v_paths text[]; v_trig text[];
  -- Copies of a Task in an open race never conflict with each other.
  v_open boolean:=p_task_id is not null
    and (clued_private.work_claim_open_race_v1(p_user_id,p_task_id)).task_id is not null;
begin
  for c in select * from clued_private.work_claims_v1 w
    where w.user_id=p_user_id and w.status in ('ACTIVE','DRAINING')
      and w.expires_at>pg_catalog.clock_timestamp()
      and (p_exclude is null or w.claim_id<>p_exclude)
    order by w.issued_at loop
    continue when v_open and c.task_id=p_task_id and c.copy_index is not null;
    v_paths:=clued_private.work_claim_paths_overlap(c.write_set,p_write_set);
    select coalesce(array_agg(t order by t),'{}'::text[]) into v_trig
      from unnest(c.trigger_refs) t
      where exists(select 1 from unnest(p_triggers) n where clued_private.work_claim_triggers_match(t,n));
    if c.task_id=p_task_id or cardinality(v_paths)>0 or cardinality(v_trig)>0 then
      v_out:=v_out||jsonb_build_object('claim_id',c.claim_id,'task_id',c.task_id,
        'holder_binding_id',c.holder_binding_id,'holder_session_ref',c.holder_session_ref,
        'status',c.status,'fence',c.fence,'expires_at',c.expires_at,
        'overlap',jsonb_build_object('same_task',c.task_id=p_task_id,
          'paths',to_jsonb(v_paths),'trigger_refs',to_jsonb(v_trig)));
    end if;
  end loop;
  return v_out;
end $$;

-- Adoption: the first copy written back wins. Serialized on the race row, so
-- two copies writing back at once cannot both be adopted.
create function clued_private.work_claim_adopt_core_v1(
  p_claim clued_private.work_claims_v1,p_binding_id uuid,p_door text,p_ref jsonb
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare m clued_private.work_claim_task_modes_v1%rowtype; c clued_private.work_claims_v1%rowtype;
  v_now timestamptz:=pg_catalog.clock_timestamp(); v_receipt uuid; v_out uuid[];
begin
  if p_claim.claim_id is null or p_claim.copy_index is null then
    return jsonb_build_object('status','ok','adopted',false,'reason','not_a_copy'); end if;
  select * into m from clued_private.work_claim_task_modes_v1 x
    where x.user_id=p_claim.user_id and x.task_id=p_claim.task_id for update;
  if not found then return jsonb_build_object('status','ok','adopted',false,'reason','not_a_copy'); end if;
  if m.adopted_claim_id=p_claim.claim_id then
    return jsonb_build_object('status','ok','adopted',true,'replayed',true,'claim_id',p_claim.claim_id,
      'task_id',m.task_id,'receipt_id',m.adopted_receipt_id);
  end if;
  select * into c from clued_private.work_claims_v1 w where w.claim_id=p_claim.claim_id for update;
  if m.adopted_claim_id is not null or c.outcome='not_adopted' or c.status='SUPERSEDED' then
    return jsonb_build_object('status','rejected','error_code','copy_not_adopted',
      'task_id',m.task_id,'adopted_claim_id',m.adopted_claim_id);
  end if;
  select coalesce(array_agg(w.claim_id order by w.copy_index,w.issued_at),'{}'::uuid[]) into v_out
    from clued_private.work_claims_v1 w
    where w.user_id=c.user_id and w.task_id=c.task_id and w.copy_index is not null
      and w.claim_id<>c.claim_id and w.outcome is null;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(c.user_id,p_binding_id,c.context_key,'work_claim_adopt','work_claim',c.claim_id::text,c.fence,
    jsonb_build_object('receipt_kind','WORK_CLAIM_COPY_ADOPTED','claim_id',c.claim_id,'task_id',c.task_id,
      'copy_index',c.copy_index,'door',p_door,'ref',coalesce(p_ref,'{}'::jsonb),'not_adopted',to_jsonb(v_out)))
  returning id into v_receipt;
  update clued_private.work_claims_v1 set outcome='adopted',updated_at=v_now where claim_id=c.claim_id;
  -- The other copies are out; the live ones stop being current at once.
  update clued_private.work_claims_v1 set outcome='not_adopted',updated_at=v_now,
      status=case when status in ('ACTIVE','DRAINING') then 'SUPERSEDED' else status end,
      superseded_by=case when status in ('ACTIVE','DRAINING') then c.claim_id else superseded_by end
    where claim_id=any(v_out);
  update clued_private.work_claim_task_modes_v1 set adopted_claim_id=c.claim_id,adopted_at=v_now,
      adopted_receipt_id=v_receipt
    where user_id=m.user_id and task_id=m.task_id;
  return jsonb_build_object('status','ok','adopted',true,'replayed',false,'claim_id',c.claim_id,
    'task_id',c.task_id,'copy_index',c.copy_index,'receipt_id',v_receipt,'not_adopted',to_jsonb(v_out));
end $$;

-- work_claim_issue: unchanged from 20261003050000 except the copy slot, which
-- is decided after the live caps and before any token or grant is spent.
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
    expires_at,hard_deadline_at,budget,status,idempotency_key,copy_index)
  values(p_binding.user_id,p_task.id,p_task.canonical_scope,p_binding.id,v_session,v_base,
    v_write_set,v_triggers,v_fence,1,v_now,v_now+v_lease,
    v_now+make_interval(secs=>(v_profile->>'hard_deadline_seconds')::integer),
    v_budget||jsonb_build_object('profile_id',v_profile->>'profile_id'),'ACTIVE',
    p_input->>'idempotency_key',v_copy)
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
        else jsonb_build_object('copy_index',v_copy,'copies',v_race.copies) end)
  returning id into v_receipt;
  update clued_private.work_claims_v1 set receipt_id=v_receipt where claim_id=v_claim.claim_id
    returning * into v_claim;
  return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,
    'claim',clued_private.work_claim_view(v_claim))
    ||case when v_copy is null then '{}'::jsonb
      else jsonb_build_object('claim_mode',jsonb_build_object('mode','multi','copies',v_race.copies,
        'copy_index',v_copy,'shared_resources',to_jsonb(v_race.shared_resources))) end;
end $$;

-- clued_work_verify_v1 (GitHub door): unchanged from 20261002100000 except
-- the fence check for copies and the copy_not_adopted reason.
create or replace function public.clued_work_verify_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; c clued_private.work_claims_v1%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global'); v_reasons jsonb:='[]'::jsonb;
  v_now timestamptz:=pg_catalog.clock_timestamp(); v_max_fence bigint; v_paths text[];
  v_outside text[]:='{}'::text[]; v_p text; v_pr text:=nullif(btrim(coalesce(p_input->>'pr_ref','')),'');
  v_head text:=lower(nullif(btrim(coalesce(p_input->>'head_sha','')),''));
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_scope);
  if coalesce(p_input->>'claim_id','') !~* '^[0-9a-f-]{36}$' then
    raise exception 'work_claim_id_invalid' using errcode='22023'; end if;
  if p_input ? 'pr_ref' and (v_pr is null
      or v_pr !~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[0-9]{1,10}$') then
    raise exception 'work_claim_pr_ref_invalid' using errcode='22023'; end if;
  if v_head is not null and v_head !~ '^[0-9a-f]{7,64}$' then
    raise exception 'work_claim_head_sha_invalid' using errcode='22023'; end if;
  -- With a pr_ref the row is locked: two pull requests verified at once
  -- cannot both bind the same claim.
  if v_pr is null then
    select * into c from clued_private.work_claims_v1 w where w.user_id=v_binding.user_id
      and w.claim_id=(p_input->>'claim_id')::uuid and w.context_key=v_scope;
  else
    select * into c from clued_private.work_claims_v1 w where w.user_id=v_binding.user_id
      and w.claim_id=(p_input->>'claim_id')::uuid and w.context_key=v_scope for update;
  end if;
  if not found then
    return jsonb_build_object('status','ok','verdict','REJECTED','verified_at',v_now,
      'reasons',jsonb_build_array('claim_not_found'));
  end if;
  if c.status not in ('ACTIVE','DRAINING') or c.expires_at<=v_now then
    v_reasons:=v_reasons||to_jsonb('claim_not_current'::text); end if;
  select max(w.fence) into v_max_fence from clued_private.work_claims_v1 w
    where w.user_id=c.user_id and w.task_id=c.task_id;
  -- Copies of a race share the Task's fence sequence; a copy is current while
  -- it is live and not out of the race, whatever later copies took.
  if c.copy_index is null and v_max_fence<>c.fence then
    v_reasons:=v_reasons||to_jsonb('fence_superseded'::text); end if;
  if c.outcome='not_adopted' then v_reasons:=v_reasons||to_jsonb('copy_not_adopted'::text); end if;
  if p_input ? 'changed_paths' then
    v_paths:=clued_private.work_claim_normalize_paths(p_input->'changed_paths');
    foreach v_p in array v_paths loop
      if not clued_private.work_claim_path_covered(v_p,c.write_set) then v_outside:=v_outside||v_p; end if;
    end loop;
    if cardinality(v_outside)>0 then v_reasons:=v_reasons||to_jsonb('paths_outside_write_set'::text); end if;
  end if;
  if v_pr is not null and c.bound_pr is not null and c.bound_pr<>v_pr then
    v_reasons:=v_reasons||to_jsonb('claim_bound_to_other_pr'::text);
  end if;
  -- Per-claim head cap (Owner Decision a264ea02): a pull request's admission
  -- records each distinct head it admits; a claim admits at most
  -- max_heads_per_claim heads, so each push past that is REJECTED and the
  -- heavy jobs do not run. Verifying the same head again does not count.
  if v_pr is not null and v_head is not null and jsonb_array_length(v_reasons)=0
      and not (v_head=any(c.admitted_heads)) then
    if cardinality(c.admitted_heads)>=(clued_private.work_claim_profile_v1()->>'max_heads_per_claim')::integer then
      v_reasons:=v_reasons||to_jsonb('claim_head_cap_reached'::text);
    else
      update clued_private.work_claims_v1 set admitted_heads=admitted_heads||v_head,updated_at=v_now
        where claim_id=c.claim_id returning * into c;
    end if;
  end if;
  if v_pr is not null and c.bound_pr is null and jsonb_array_length(v_reasons)=0 then
    update clued_private.work_claims_v1 set bound_pr=v_pr,updated_at=v_now
      where claim_id=c.claim_id returning * into c;
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,
      object_type,object_id,version,metadata)
    values(c.user_id,v_binding.id,c.context_key,'work_claim_bind_pr','work_claim',
      c.claim_id::text,c.fence,jsonb_build_object('receipt_kind','WORK_CLAIM_BOUND_TO_PR',
        'claim_id',c.claim_id,'task_id',c.task_id,'fence',c.fence,'bound_pr',v_pr,
        'head_sha',p_input->>'head_sha','base_sha',p_input->>'base_sha'));
  end if;
  return jsonb_build_object('status','ok',
    'verdict',case when jsonb_array_length(v_reasons)=0 then 'ADMITTED' else 'REJECTED' end,
    'verified_at',v_now,'reasons',v_reasons,'paths_outside_write_set',to_jsonb(v_outside),
    'current_fence',v_max_fence,'head_sha',p_input->>'head_sha','base_sha',p_input->>'base_sha',
    'pr_ref',v_pr,'bound_pr',c.bound_pr,'admitted_heads',cardinality(c.admitted_heads),
    'max_heads_per_claim',(clued_private.work_claim_profile_v1()->>'max_heads_per_claim')::integer,
    'claim',clued_private.work_claim_view(c));
end $$;

-- work_claim_gate_v1 (Clued storage door): unchanged from 20261003080000
-- except copy_not_adopted, sibling copies, and write-back adoption.
create or replace function clued_private.work_claim_gate_v1(p_user uuid,p_binding uuid,p_door text,p_operation text,
  p_mode text,p_resources text[],p_claim jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare c clued_private.work_claims_v1%rowtype; b public.clued_agent_bindings%rowtype;
  v_code text; v_detail jsonb:='{}'::jsonb; v_conflicts jsonb:='[]'::jsonb; v_uncovered text[];
  v_first clued_private.work_claims_v1%rowtype; v_now timestamptz:=pg_catalog.clock_timestamp();
  v_race clued_private.work_claim_task_modes_v1%rowtype; v_adopt jsonb;
begin
  if p_mode not in ('collision_only','require_claim') or p_door is null or p_operation is null then
    raise exception 'work_claim_gate_invalid' using errcode='22023'; end if;
  if p_claim is not null and not clued_private.work_claim_ref_valid_v1(p_claim) then
    raise exception 'work_claim_gate_invalid' using errcode='22023'; end if;
  if coalesce(cardinality(p_resources),0)=0 then return null; end if;
  if p_claim is not null then
    select * into c from clued_private.work_claims_v1 w
      where w.user_id=p_user and w.claim_id=(p_claim->>'claim_id')::uuid;
    if not found then v_code:='work_claim_not_found';
    elsif c.holder_binding_id<>p_binding then v_code:='work_claim_not_holder';
    elsif c.outcome='not_adopted' then
      v_code:='copy_not_adopted'; v_detail:=jsonb_build_object('task_id',c.task_id,'copy_index',c.copy_index);
    elsif c.fence<>(p_claim->>'fence')::bigint then
      v_code:='work_claim_fence_mismatch'; v_detail:=jsonb_build_object('expected_fence',c.fence);
    elsif c.status<>'ACTIVE' or c.expires_at<=v_now then
      v_code:='work_claim_not_active'; v_detail:=jsonb_build_object('claim_status',
        case when c.status='ACTIVE' then 'EXPIRED' else c.status end);
    else
      select coalesce(array_agg(r order by r),'{}'::text[]) into v_uncovered from unnest(p_resources) r
        where not clued_private.work_claim_resource_covered_v1(r,c.write_set);
      if cardinality(v_uncovered)>0 then
        v_code:='work_claim_not_covered'; v_detail:=jsonb_build_object('uncovered',to_jsonb(v_uncovered));
      end if;
    end if;
  elsif p_mode='require_claim' then v_code:='work_claim_required';
  end if;
  if c.copy_index is not null then
    v_race:=clued_private.work_claim_open_race_v1(p_user,c.task_id);
  end if;
  if v_code is null then
    -- Every live claim but the presented one. Only resources count, except
    -- that the other copies of a presented copy's open race never do.
    v_conflicts:=clued_private.work_claim_conflicts(p_user,
      case when v_race.task_id is not null then c.task_id end,p_resources,'{}'::text[],c.claim_id);
    if jsonb_array_length(v_conflicts)>0 then
      v_code:='work_claim_conflict'; v_detail:=jsonb_build_object('conflicts',v_conflicts);
    end if;
  end if;
  -- Write-back (§5.3): a copy writing to its race's shared resources is the
  -- adopted copy, in this same transaction; a race already won refuses it.
  if v_code is null and v_race.task_id is not null
      and cardinality(clued_private.work_claim_paths_overlap(v_race.shared_resources,p_resources))>0 then
    v_adopt:=clued_private.work_claim_adopt_core_v1(c,p_binding,p_door,
      jsonb_build_object('operation',p_operation,'resources',to_jsonb(p_resources)));
    if v_adopt->>'status'='rejected' then
      v_code:='copy_not_adopted'; v_detail:=jsonb_build_object('task_id',c.task_id,'copy_index',c.copy_index,
        'adopted_claim_id',v_adopt->'adopted_claim_id');
    end if;
  end if;
  if v_code is null then return null; end if;
  -- The Receipt is keyed by the presented claim's Task, else the first
  -- conflicting claim's, else the presented claim id.
  if c.claim_id is null and jsonb_array_length(v_conflicts)>0 then
    select * into v_first from clued_private.work_claims_v1 w
      where w.user_id=p_user and w.claim_id=(v_conflicts->0->>'claim_id')::uuid;
  end if;
  select * into b from public.clued_agent_bindings x where x.id=p_binding and x.user_id=p_user;
  if b.id is null then raise exception 'work_claim_gate_invalid' using errcode='22023'; end if;
  return clued_private.work_claim_reject_log_v1(b,coalesce(c.context_key,v_first.context_key,'global'),
    coalesce(c.task_id,v_first.task_id),coalesce(c.claim_id,v_first.claim_id,(p_claim->>'claim_id')::uuid),
    p_door||':'||p_operation,v_code,
    v_detail||jsonb_build_object('door',p_door,'resources',to_jsonb(p_resources)));
end $$;

-- GitHub write-back: the admission workflow reports a merged pull request.
-- The copy bound to it (by verify) is adopted. Called with the admission
-- environment's read-only Binding, like verify's pull request binding.
create function public.clued_work_claim_adopt_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; c clued_private.work_claims_v1%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global'); v_pr text:=nullif(btrim(coalesce(p_input->>'pr_ref','')),'');
  v_merge text:=lower(nullif(btrim(coalesce(p_input->>'merge_sha','')),''));
begin
  if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('scope','pr_ref','merge_sha')) then
    raise exception 'work_claim_adopt_input_invalid' using errcode='22023'; end if;
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_scope);
  if v_pr is null or v_pr !~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[0-9]{1,10}$' then
    raise exception 'work_claim_pr_ref_invalid' using errcode='22023'; end if;
  if v_merge is null or v_merge !~ '^[0-9a-f]{7,64}$' then
    raise exception 'work_claim_head_sha_invalid' using errcode='22023'; end if;
  perform clued_private.work_claim_lock(v_binding.user_id);
  select * into c from clued_private.work_claims_v1 w
    where w.user_id=v_binding.user_id and w.context_key=v_scope and w.bound_pr=v_pr and w.copy_index is not null
    order by w.issued_at desc limit 1;
  if not found then return jsonb_build_object('status','ok','adopted',false,'reason','no_copy_for_pr','pr_ref',v_pr); end if;
  return clued_private.work_claim_adopt_core_v1(c,v_binding.id,'github',
    jsonb_build_object('pr_ref',v_pr,'merge_sha',v_merge))||jsonb_build_object('pr_ref',v_pr);
end $$;

-- ---------------------------------------------------------------------------
-- Owner: turn a Task into a race (Native account session, two steps).

-- Refuses a Task that already had a race or has a live claim.
create function clued_private.work_claim_multi_check_v1(p_user uuid,p_task uuid) returns void
language plpgsql stable security definer set search_path='' as $$
begin
  if exists(select 1 from clued_private.work_claim_task_modes_v1 m where m.user_id=p_user and m.task_id=p_task) then
    raise exception 'work_claim_multi_already_set' using errcode='55000'; end if;
  if exists(select 1 from clued_private.work_claims_v1 w where w.user_id=p_user and w.task_id=p_task
      and w.status in ('ACTIVE','DRAINING') and w.expires_at>pg_catalog.clock_timestamp()) then
    raise exception 'work_claim_multi_task_busy' using errcode='55000'; end if;
end $$;

create function clued_private.work_claim_multi_view_v1(p_task public.clued_memories,p_copies integer,p_shared text[])
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('action','work_claim_multi','task_id',p_task.id,'task_title',p_task.title,
    'scope',p_task.canonical_scope,'copies',p_copies,'shared_resources',to_jsonb(p_shared))
$$;

-- Suggested copies: distinct Agent hosts (client registration, else vendor and
-- name) that reached Clued in the last 7 days, at least 2, at most the cap.
create function clued_private.work_claim_multi_suggested_v1(p_user uuid,p_cap integer) returns integer
language sql stable security definer set search_path='' as $$
  select least(p_cap,greatest(2,coalesce((select count(distinct coalesce(b.oauth_client_id,b.vendor||'/'||b.agent_name))::integer
    from public.clued_audit_receipts r join public.clued_agent_bindings b on b.id=r.binding_id
    where r.user_id=p_user and r.created_at>pg_catalog.clock_timestamp()-interval '7 days'
      and b.revoked_at is null),0)))
$$;

-- Step 1. Input {task_id, scope?, copies, shared_resources}.
create function public.clued_work_claim_multi_confirmation_issue_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_task public.clued_memories%rowtype;
  v_cap integer:=(clued_private.work_claim_profile_v1()->>'task_claim_bucket_capacity')::integer;
  v_copies integer; v_shared text[]; v_scope text; v_view jsonb; v_digest text; v_raw text;
  v_token_id uuid; v_expires timestamptz; v_now timestamptz; v_error text;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if clued_private.native_session_id_v1() is null then
    return jsonb_build_object('status','rejected','error_code','confirmation_token_session_id_required','authoritative',false);
  end if;
  begin
    if jsonb_typeof(p_input) is distinct from 'object' then
      raise exception 'work_claim_multi_input_invalid' using errcode='22023'; end if;
    if exists(select 1 from jsonb_object_keys(p_input) k where k not in ('task_id','scope','copies','shared_resources')) then
      raise exception 'work_claim_multi_unknown_field' using errcode='22023'; end if;
    v_scope:=coalesce(p_input->>'scope','global');
    perform clued_private.work_claim_lock(v_owner);
    v_task:=clued_private.work_claim_task(v_owner,v_scope,p_input->>'task_id');
    begin v_copies:=(p_input->>'copies')::integer;
    exception when others then raise exception 'work_claim_multi_copies_invalid' using errcode='22023'; end;
    if v_copies is null or v_copies<2 or v_copies>v_cap then
      raise exception 'work_claim_multi_copies_invalid' using errcode='22023'; end if;
    if jsonb_typeof(p_input->'shared_resources') is distinct from 'array'
        or jsonb_array_length(p_input->'shared_resources') not between 1 and 50 then
      raise exception 'work_claim_multi_shared_invalid' using errcode='22023'; end if;
    v_shared:=clued_private.work_claim_normalize_paths(p_input->'shared_resources');
    if cardinality(v_shared) not between 1 and 50 then
      raise exception 'work_claim_multi_shared_invalid' using errcode='22023'; end if;
    perform clued_private.work_claim_multi_check_v1(v_owner,v_task.id);
    v_view:=clued_private.work_claim_multi_view_v1(v_task,v_copies,v_shared);
    v_digest:=clued_private.m1_sha256(v_view);
    update clued_private.native_confirmation_tokens set revoked_at=clock_timestamp()
      where user_id=v_owner and action='work_claim_multi' and subject_key=v_task.id::text
        and consumed_at is null and revoked_at is null;
    v_raw:='clued_wcm_'||encode(extensions.gen_random_bytes(32),'hex');
    v_now:=clock_timestamp();
    insert into clued_private.native_confirmation_tokens(user_id,action,subject_key,subject_version,native_choices,
      confirmation_view,view_digest,token_hash,session_id,auth_time,issued_at,expires_at)
    values(v_owner,'work_claim_multi',v_task.id::text,0,
      jsonb_build_object('task_id',v_task.id,'scope',v_scope,'copies',v_copies,'shared_resources',to_jsonb(v_shared)),
      v_view,v_digest,encode(extensions.digest(convert_to(v_raw,'UTF8'),'sha256'),'hex'),
      clued_private.native_session_id_v1(),coalesce(clued_private.native_auth_time_v1(),v_now),v_now,v_now+interval '5 minutes')
    returning id,expires_at into v_token_id,v_expires;
    return jsonb_build_object('status','issued','confirmation_token',v_raw,'token_id',v_token_id,'expires_at',v_expires,
      'confirmation_view',v_view,'view_digest',v_digest,
      'suggested_copies',clued_private.work_claim_multi_suggested_v1(v_owner,v_cap),'max_copies',v_cap,
      'authoritative',false);
  exception when sqlstate '22023' or sqlstate '23514' or sqlstate '42501' or sqlstate '55000' then
    get stacked diagnostics v_error=message_text;
    return jsonb_build_object('status','rejected','error_code',v_error,'authoritative',false);
  end;
end $$;

-- Step 2: consume the token, re-render the view, record the race.
create function public.clued_work_claim_multi_enable_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_token clued_private.native_confirmation_tokens%rowtype;
  v_token_id uuid; v_hash text; v_task public.clued_memories%rowtype; m clued_private.work_claim_task_modes_v1%rowtype;
  v_receipt uuid; v_now timestamptz; v_error text; v_state text; c jsonb; v_shared text[];
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  begin
    if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('confirmation_token','view_digest')) then
      raise exception 'work_claim_multi_unknown_field' using errcode='22023'; end if;
    if jsonb_typeof(p_input->'confirmation_token') is distinct from 'string' then
      raise exception 'confirmation_token_required' using errcode='42501'; end if;
    perform clued_private.work_claim_lock(v_owner);
    v_hash:=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex');
    select * into v_token from clued_private.native_confirmation_tokens t
      where t.user_id=v_owner and t.action='work_claim_multi' and t.token_hash=v_hash for update;
    if not found then raise exception 'confirmation_token_invalid' using errcode='42501'; end if;
    if v_token.consume_outcome='committed' then
      select * into m from clued_private.work_claim_task_modes_v1 where token_id=v_token.id;
      return jsonb_build_object('status','committed','replayed',true,'receipt_id',m.receipt_id,
        'race',jsonb_build_object('task_id',m.task_id,'copies',m.copies,'shared_resources',to_jsonb(m.shared_resources),
          'enabled_at',m.enabled_at));
    end if;
    if v_token.consumed_at is not null then raise exception 'confirmation_token_reused' using errcode='42501'; end if;
    if v_token.revoked_at is not null then raise exception 'confirmation_token_revoked' using errcode='42501'; end if;
    v_token_id:=v_token.id;
    if v_token.expires_at<=clock_timestamp() then raise exception 'confirmation_token_expired' using errcode='42501'; end if;
    if v_token.issued_xact=pg_current_xact_id() then raise exception 'confirmation_token_same_request' using errcode='42501'; end if;
    if coalesce(p_input->>'view_digest','')<>v_token.view_digest
      or v_token.session_id is null or clued_private.native_session_id_v1() is null
      or v_token.session_id<>clued_private.native_session_id_v1() then
      raise exception 'confirmation_token_binding_mismatch' using errcode='42501'; end if;
    c:=v_token.native_choices;
    v_task:=clued_private.work_claim_task(v_owner,c->>'scope',c->>'task_id');
    perform clued_private.work_claim_multi_check_v1(v_owner,v_task.id);
    v_shared:=array(select jsonb_array_elements_text(c->'shared_resources'));
    if clued_private.m1_sha256(clued_private.work_claim_multi_view_v1(v_task,(c->>'copies')::integer,v_shared))
        <>v_token.view_digest then
      raise exception 'confirmation_view_stale' using errcode='40001'; end if;
    v_now:=clock_timestamp();
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(v_owner,null,v_task.canonical_scope,'work_claim_multi_enable','work_claim_task_mode',v_task.id::text,1,
      jsonb_build_object('receipt_kind','WORK_CLAIM_MULTI_ENABLED','task_id',v_task.id,'copies',(c->>'copies')::integer,
        'shared_resources',c->'shared_resources','token_id',v_token.id,'view_digest',v_token.view_digest,
        'session_id',v_token.session_id,'principal','native_account_session'))
    returning id into v_receipt;
    insert into clued_private.work_claim_task_modes_v1(user_id,task_id,mode,copies,shared_resources,enabled_at,
      enabled_session_id,token_id,receipt_id)
    values(v_owner,v_task.id,'multi',(c->>'copies')::integer,v_shared,v_now,v_token.session_id,v_token.id,v_receipt)
    returning * into m;
    update clued_private.native_confirmation_tokens set consumed_at=v_now,consumed_receipt_id=v_receipt,
      consume_outcome='committed' where id=v_token.id;
    return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,
      'race',jsonb_build_object('task_id',m.task_id,'copies',m.copies,'shared_resources',to_jsonb(m.shared_resources),
        'enabled_at',m.enabled_at));
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    -- Single use: a presented live token is burned by any failed attempt.
    if v_token_id is not null then
      insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values(v_owner,null,'global','work_claim_multi_enable','work_claim_task_mode',v_token.subject_key,1,
        jsonb_build_object('receipt_kind','WORK_CLAIM_MULTI_REJECTED','token_id',v_token_id,'error_code',v_error))
      returning id into v_receipt;
      update clued_private.native_confirmation_tokens set consumed_at=clock_timestamp(),consumed_receipt_id=v_receipt,
        consume_outcome='rejected' where id=v_token_id and consumed_at is null and revoked_at is null;
    end if;
    return jsonb_build_object('status',case when v_state in ('22023','23514','40001','42501','55000')
      then 'rejected' else 'failed' end,'error_code',v_error,'authoritative',false);
  end;
end $$;

revoke all on function
  clued_private.work_claim_open_race_v1(uuid,uuid),
  clued_private.work_claim_adopt_core_v1(clued_private.work_claims_v1,uuid,text,jsonb),
  clued_private.work_claim_multi_check_v1(uuid,uuid),
  clued_private.work_claim_multi_view_v1(public.clued_memories,integer,text[]),
  clued_private.work_claim_multi_suggested_v1(uuid,integer)
from public,anon,authenticated,service_role;
revoke all on function
  public.clued_work_claim_adopt_v1(text,jsonb),
  public.clued_work_claim_multi_confirmation_issue_v1(jsonb),
  public.clued_work_claim_multi_enable_v1(jsonb)
from public,anon,authenticated,service_role;
grant execute on function public.clued_work_claim_adopt_v1(text,jsonb) to anon;
grant execute on function public.clued_work_claim_multi_confirmation_issue_v1(jsonb),
  public.clued_work_claim_multi_enable_v1(jsonb) to authenticated;

notify pgrst,'reload schema';
