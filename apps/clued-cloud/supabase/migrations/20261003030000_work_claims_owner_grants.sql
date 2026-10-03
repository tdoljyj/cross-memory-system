-- Owner Credential v0.1, step 3 (development/contracts/owner-authorization/
-- OwnerCredential.v0.1.md §6.2, §11 point 3; Task 13bb5d2c).
--
-- Over the per-Task claim cap, work_claim_issue now consumes an Owner Grant
-- for work_claim.extra_claims on that Task (resource record:<task_id>), one use
-- per claim or takeover, inside the claim's own transaction. A refusal opens
-- (or reuses) the Binding's pending Owner Request for the Task and returns it,
-- with its confirmation path; the Owner approves on /confirm/<id>.
-- Legacy exemptions already granted keep working until they expire (at most
-- 24 hours); new exemptions are retired.
--
-- work_claim_issue: unchanged from 20261002190000 except the cap branch, the
-- refusal detail (owner_request replaces owner_exemption_path) and the claim
-- Receipt, which names the grant use.

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
  v_exemption_id uuid; v_grant jsonb; v_resources text[]; v_request clued_private.owner_requests_v1%rowtype;
  v_request_receipt uuid;
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
    -- A legacy exemption (20261002190000) granted before this migration still
    -- admits up to extra_claims new claims or takeovers while it is valid
    -- (at most 24 hours; OwnerCredential §11 point 3).
    select e.id into v_exemption_id from clued_private.work_claim_exemptions_v1 e
      where e.user_id=p_binding.user_id and e.task_id=p_task.id and e.expires_at>v_now
        and (select count(*) from clued_private.work_claims_v1 w
              where w.user_id=e.user_id and w.task_id=e.task_id and w.issued_at>=e.granted_at)<e.extra_claims
      order by e.granted_at limit 1;
    -- Otherwise an Owner Grant for work_claim.extra_claims on this Task admits
    -- one more claim or takeover per use (OwnerCredential §6.2). Nothing after
    -- this point rejects, so a consumed use always becomes a claim.
    if v_exemption_id is null then
      v_resources:=clued_private.work_claim_normalize_paths(jsonb_build_array('record:'||p_task.id::text));
      v_grant:=clued_private.owner_grant_consume_v1(p_binding.user_id,p_binding.id,'work_claim.extra_claims',
        v_resources,p_task.id);
    end if;
  end if;
  if v_recent>=(v_profile->>'max_claims_per_task_24h')::integer and v_exemption_id is null and v_grant is null then
    -- A new claim is admitted once fewer than the cap remain in the window:
    -- the (claims_last_24h - cap + 1)-th oldest claim has to age out, not
    -- only the oldest one.
    select w.issued_at+interval '24 hours' into v_retry_after
      from clued_private.work_claims_v1 w
      where w.user_id=p_binding.user_id and w.task_id=p_task.id
        and w.issued_at>v_now-interval '24 hours'
      order by w.issued_at
      offset v_recent-(v_profile->>'max_claims_per_task_24h')::integer limit 1;
    -- Ask the Owner: reuse this Binding's pending request for the Task, or
    -- open one. The refusal carries it; only the Owner can approve it, on the
    -- signed-in confirmation page.
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
          'resources',to_jsonb(v_resources),'task_id',p_task.id,'origin','work_claim_budget_exhausted'))
      returning id into v_request_receipt;
      insert into clued_private.owner_requests_v1(user_id,binding_id,idempotency_key,action,resources,task_id,
        suggested_expires_seconds,suggested_max_uses,expires_at,receipt_id)
      values(p_binding.user_id,p_binding.id,'work-claim-cap:'||p_task.id::text||':'||gen_random_uuid()::text,
        'work_claim.extra_claims',v_resources,p_task.id,86400,5,v_now+interval '24 hours',v_request_receipt)
      returning * into v_request;
    end if;
    return clued_private.work_claim_rejected('work_claim_budget_exhausted',
      jsonb_build_object('limit','max_claims_per_task_24h',
        'max_claims_per_task_24h',(v_profile->>'max_claims_per_task_24h')::integer,
        'claims_last_24h',v_recent,'task_id',p_task.id,
        'retry_after',v_retry_after,
        'owner_request',clued_private.owner_request_public_v1(v_request)));
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

-- New exemptions go through Owner Grants: step 1 of the exemption flow is
-- retired. A token issued before this migration can still be confirmed.
create or replace function public.clued_work_claim_exemption_confirmation_issue_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  perform clued_private.authorization_owner_v12();
  return jsonb_build_object('status','rejected','error_code','work_claim_exemption_retired',
    'grants_path','/grants','authoritative',false);
end $$;

notify pgrst,'reload schema';
