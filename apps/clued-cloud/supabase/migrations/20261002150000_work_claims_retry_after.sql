-- Work Claim per-Task cap: correct retry_after (Owner Decision 82fac746,
-- Task 87db9389).
--
-- 20261002100000 answered work_claim_budget_exhausted with retry_after = the
-- oldest claim in the window + 24 hours. That only brings claims_last_24h
-- down by one, so a Task that was more than one claim over the cap was still
-- refused at that time (Task 1502fd80 had 22 claims when the cap went live
-- and was told to retry 12 hours before it could). retry_after is now the time
-- the count drops below the cap: the (claims_last_24h - cap + 1)-th oldest
-- claim in the window + 24 hours. Nothing else in work_claim_issue changes.

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
  v_lease_seconds integer; v_active_session integer; v_recent integer; v_retry_after timestamptz;
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
    return clued_private.work_claim_rejected('work_claim_conflict',
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
    return clued_private.work_claim_rejected('work_claim_budget_exhausted',
      jsonb_build_object('limit','max_active_per_session',
        'max_active_per_session',(v_profile->>'max_active_per_session')::integer,
        'max_active_per_binding',(v_profile->>'max_active_per_binding')::integer,
        'active',v_active_session,'active_binding',v_active,'holder_session_ref',v_session));
  end if;
  if v_active>=(v_profile->>'max_active_per_binding')::integer then
    return clued_private.work_claim_rejected('work_claim_budget_exhausted',
      jsonb_build_object('limit','max_active_per_binding',
        'max_active_per_session',(v_profile->>'max_active_per_session')::integer,
        'max_active_per_binding',(v_profile->>'max_active_per_binding')::integer,
        'active',v_active,'active_session',v_active_session));
  end if;

  -- attempts_cap (Owner Decision a264ea02): one Task gets at most
  -- max_claims_per_task_24h new claims or takeovers in any 24 hours, so a
  -- runaway claim/release loop stops instead of spending without end.
  select count(*)::integer into v_recent
    from clued_private.work_claims_v1 w
    where w.user_id=p_binding.user_id and w.task_id=p_task.id
      and w.issued_at>v_now-interval '24 hours';
  if v_recent>=(v_profile->>'max_claims_per_task_24h')::integer then
    -- A new claim is admitted once fewer than the cap remain in the window:
    -- the (claims_last_24h - cap + 1)-th oldest claim has to age out, not
    -- only the oldest one.
    select w.issued_at+interval '24 hours' into v_retry_after
      from clued_private.work_claims_v1 w
      where w.user_id=p_binding.user_id and w.task_id=p_task.id
        and w.issued_at>v_now-interval '24 hours'
      order by w.issued_at
      offset v_recent-(v_profile->>'max_claims_per_task_24h')::integer limit 1;
    return clued_private.work_claim_rejected('work_claim_budget_exhausted',
      jsonb_build_object('limit','max_claims_per_task_24h',
        'max_claims_per_task_24h',(v_profile->>'max_claims_per_task_24h')::integer,
        'claims_last_24h',v_recent,'task_id',p_task.id,
        'retry_after',v_retry_after));
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
      'idempotency_key',p_input->>'idempotency_key','profile',v_profile))
  returning id into v_receipt;
  update clued_private.work_claims_v1 set receipt_id=v_receipt where claim_id=v_claim.claim_id
    returning * into v_claim;
  return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,
    'claim',clued_private.work_claim_view(v_claim));
end $$;

notify pgrst,'reload schema';
