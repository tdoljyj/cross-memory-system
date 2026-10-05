-- Work Claim rejection Receipts for renew, takeover pre-checks and replays
-- (Task 91272c5d, Decision bd4243b6; completes Decision 01d5a0c9 item 3).
--
-- 20261003050000 logs the refusals issued inside work_claim_issue (conflict,
-- live-claim caps, rate buckets). The refusals returned before it are not
-- logged yet; this migration logs them too:
--   * clued_work_renew_v1: every refusal (not found, not holder, expired, not
--     active, fence or lease version mismatch, no progress, renewal budget,
--     hard deadline, write_set/trigger_refs conflict);
--   * clued_work_takeover_v1: not found, not eligible, still active;
--   * clued_work_claim_v1 and clued_work_takeover_v1: a replay refused as
--     idempotency_conflict or idempotency_spent.
-- Each leaves a WORK_CLAIM_REJECTED Receipt with the same rate limit as
-- before: at most one per Binding, context, Task, error and limit a minute.
-- A refusal with no Task (a claim id that does not exist in this scope) is
-- keyed by the claim id instead. Responses are unchanged.
--
-- The three RPC bodies are 20261002072000 with each refusal routed through
-- the logger; nothing else changes. Release refusals stay unlogged.

-- A refusal with its Receipt. The Receipt's object is the Task, or the
-- requested claim id when no Task is known.
create function clued_private.work_claim_reject_log_v1(p_binding public.clued_agent_bindings,
  p_context_key text,p_task_id uuid,p_claim_id uuid,p_operation text,p_code text,p_detail jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_limit text:=p_detail->>'limit'; v_object text:=coalesce(p_task_id,p_claim_id)::text;
begin
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

-- The work_claim_issue logger now delegates, so both paths share one rate
-- limit and one Receipt shape.
create or replace function clued_private.work_claim_reject_logged_v1(p_binding public.clued_agent_bindings,
  p_task public.clued_memories,p_operation text,p_code text,p_detail jsonb) returns jsonb
language sql volatile security definer set search_path='' as $$
  select clued_private.work_claim_reject_log_v1(p_binding,p_task.canonical_scope,p_task.id,null,
    p_operation,p_code,p_detail)
$$;

-- A replay answer, logged when it is a refusal.
create function clued_private.work_claim_replay_logged_v1(p_binding public.clued_agent_bindings,
  p_existing clued_private.work_claims_v1,p_hash text,p_operation text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_result jsonb:=clued_private.work_claim_replay(p_existing,p_hash);
begin
  if v_result->>'status'='rejected' then
    perform clued_private.work_claim_reject_log_v1(p_binding,p_existing.context_key,p_existing.task_id,
      p_existing.claim_id,p_operation,v_result->>'error_code',v_result);
  end if;
  return v_result;
end $$;

revoke all on function
  clued_private.work_claim_reject_log_v1(public.clued_agent_bindings,text,uuid,uuid,text,text,jsonb),
  clued_private.work_claim_reject_logged_v1(public.clued_agent_bindings,public.clued_memories,text,text,jsonb),
  clued_private.work_claim_replay_logged_v1(public.clued_agent_bindings,clued_private.work_claims_v1,text,text)
  from public,anon,authenticated,service_role;

create or replace function public.clued_work_claim_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; v_task public.clued_memories%rowtype;
  v_existing clued_private.work_claims_v1%rowtype; v_none clued_private.work_claims_v1%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global'); v_hash text; v_result jsonb;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',v_scope);
  perform clued_private.work_claim_idempotency(p_input->>'idempotency_key');
  v_hash:=clued_private.work_claim_request_hash('work_claim',p_input);
  perform clued_private.work_claim_lock(v_binding.user_id);
  select * into v_existing from clued_private.work_claims_v1 w
    where w.user_id=v_binding.user_id and w.holder_binding_id=v_binding.id
      and w.idempotency_key=p_input->>'idempotency_key';
  if found then
    return clued_private.work_claim_replay_logged_v1(v_binding,v_existing,v_hash,'work_claim'); end if;
  perform clued_private.work_claim_expire_due(v_binding.user_id);
  v_task:=clued_private.work_claim_task(v_binding.user_id,v_scope,p_input->>'task_id');
  v_result:=clued_private.work_claim_issue(v_binding,p_input,v_task,v_none,'work_claim');
  if v_result->>'status'='committed' then
    update clued_private.work_claims_v1 set request_hash=v_hash
      where claim_id=(v_result#>>'{claim,claim_id}')::uuid;
  end if;
  return v_result;
end $$;

create or replace function public.clued_work_takeover_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; v_old clued_private.work_claims_v1%rowtype;
  v_existing clued_private.work_claims_v1%rowtype; v_task public.clued_memories%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global'); v_hash text; v_result jsonb;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',v_scope);
  perform clued_private.work_claim_idempotency(p_input->>'idempotency_key');
  v_hash:=clued_private.work_claim_request_hash('work_claim_takeover',p_input);
  perform clued_private.work_claim_lock(v_binding.user_id);
  select * into v_existing from clued_private.work_claims_v1 w
    where w.user_id=v_binding.user_id and w.holder_binding_id=v_binding.id
      and w.idempotency_key=p_input->>'idempotency_key';
  if found then
    return clued_private.work_claim_replay_logged_v1(v_binding,v_existing,v_hash,'work_claim_takeover'); end if;
  perform clued_private.work_claim_expire_due(v_binding.user_id);
  if coalesce(p_input->>'claim_id','') !~* '^[0-9a-f-]{36}$' then
    raise exception 'work_claim_id_invalid' using errcode='22023'; end if;
  select * into v_old from clued_private.work_claims_v1 w where w.user_id=v_binding.user_id
    and w.claim_id=(p_input->>'claim_id')::uuid and w.context_key=v_scope for update;
  if not found then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,null,(p_input->>'claim_id')::uuid,
      'work_claim_takeover','work_claim_not_found',null); end if;
  if v_old.status in ('RELEASED','SUPERSEDED') then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,v_old.task_id,v_old.claim_id,
      'work_claim_takeover','work_claim_not_takeover_eligible',
      jsonb_build_object('claim',clued_private.work_claim_view(v_old))); end if;
  if v_old.status in ('ACTIVE','DRAINING') and v_old.expires_at>pg_catalog.clock_timestamp() then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,v_old.task_id,v_old.claim_id,
      'work_claim_takeover','work_claim_still_active',
      jsonb_build_object('claim',clued_private.work_claim_view(v_old))); end if;
  v_task:=clued_private.work_claim_task(v_binding.user_id,v_scope,v_old.task_id::text);
  v_result:=clued_private.work_claim_issue(v_binding,p_input,v_task,v_old,'work_claim_takeover');
  if v_result->>'status'='committed' then
    update clued_private.work_claims_v1 set request_hash=v_hash
      where claim_id=(v_result#>>'{claim,claim_id}')::uuid;
  end if;
  return v_result;
end $$;

create or replace function public.clued_work_renew_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; c clued_private.work_claims_v1%rowtype;
  v_profile jsonb:=clued_private.work_claim_profile_v1(); v_now timestamptz:=pg_catalog.clock_timestamp();
  v_scope text:=coalesce(p_input->>'scope','global'); v_progress text; v_claim_id uuid;
  v_write_set text[]; v_triggers text[]; v_conflicts jsonb; v_receipt uuid; v_expires timestamptz;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',v_scope);
  perform clued_private.work_claim_lock(v_binding.user_id);
  perform clued_private.work_claim_expire_due(v_binding.user_id);
  if coalesce(p_input->>'claim_id','') !~* '^[0-9a-f-]{36}$' then
    raise exception 'work_claim_id_invalid' using errcode='22023'; end if;
  v_claim_id:=(p_input->>'claim_id')::uuid;
  select * into c from clued_private.work_claims_v1 w where w.user_id=v_binding.user_id
    and w.claim_id=v_claim_id and w.context_key=v_scope for update;
  if not found then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,null,v_claim_id,
      'work_claim_renew','work_claim_not_found',null); end if;
  if c.holder_binding_id<>v_binding.id then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
      'work_claim_renew','work_claim_not_holder',
      jsonb_build_object('claim',clued_private.work_claim_view(c))); end if;
  if c.status='EXPIRED' then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
      'work_claim_renew','work_claim_expired',
      jsonb_build_object('claim',clued_private.work_claim_view(c))); end if;
  if c.status<>'ACTIVE' then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
      'work_claim_renew','work_claim_not_active',
      jsonb_build_object('claim',clued_private.work_claim_view(c))); end if;
  if (p_input->>'fence')::bigint is distinct from c.fence then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
      'work_claim_renew','work_claim_fence_mismatch',
      jsonb_build_object('expected_fence',c.fence)); end if;
  if (p_input->>'lease_version')::bigint is distinct from c.lease_version then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
      'work_claim_renew','work_claim_version_conflict',
      jsonb_build_object('expected_lease_version',c.lease_version)); end if;
  v_progress:=nullif(btrim(coalesce(p_input->>'progress_ref','')),'');
  if v_progress is null or v_progress is not distinct from c.progress_ref
      or v_progress=any(c.progress_refs) then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
      'work_claim_renew','work_claim_no_progress',
      jsonb_build_object('last_progress_ref',c.progress_ref,'used_progress_refs',to_jsonb(c.progress_refs))); end if;
  if c.renewals>=(v_profile->>'max_renewals')::integer then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
      'work_claim_renew','work_claim_renewal_budget_exhausted',
      jsonb_build_object('max_renewals',(v_profile->>'max_renewals')::integer,'renewals',c.renewals)); end if;
  if c.expires_at>=c.hard_deadline_at then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
      'work_claim_renew','work_claim_hard_deadline',
      jsonb_build_object('hard_deadline_at',c.hard_deadline_at)); end if;

  v_write_set:=case when p_input ? 'write_set'
    then clued_private.work_claim_normalize_paths(p_input->'write_set') else c.write_set end;
  v_triggers:=case when p_input ? 'trigger_refs'
    then clued_private.work_claim_normalize_triggers(p_input->'trigger_refs') else c.trigger_refs end;
  if v_write_set<>c.write_set or v_triggers<>c.trigger_refs then
    v_conflicts:=clued_private.work_claim_conflicts(v_binding.user_id,c.task_id,v_write_set,v_triggers,c.claim_id);
    if jsonb_array_length(v_conflicts)>0 then
      return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
        'work_claim_renew','work_claim_conflict',
        jsonb_build_object('conflicts',v_conflicts,'write_set',to_jsonb(v_write_set),
          'trigger_refs',to_jsonb(v_triggers)));
    end if;
  end if;
  v_expires:=least(v_now+make_interval(secs=>(v_profile->>'lease_seconds')::integer),c.hard_deadline_at);
  update clued_private.work_claims_v1 set lease_version=lease_version+1,renewals=renewals+1,
    expires_at=v_expires,progress_ref=v_progress,
    progress_refs=progress_refs||case when c.progress_ref is null or c.progress_ref=any(progress_refs)
      then array[v_progress] else array[c.progress_ref,v_progress] end,
    write_set=v_write_set,trigger_refs=v_triggers,
    updated_at=v_now where claim_id=c.claim_id returning * into c;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,
    object_type,object_id,version,metadata)
  values(v_binding.user_id,v_binding.id,c.context_key,'work_claim_renew','work_claim',
    c.claim_id::text,c.fence,jsonb_build_object('receipt_kind','WORK_CLAIM_RENEWED',
      'claim_id',c.claim_id,'task_id',c.task_id,'fence',c.fence,'lease_version',c.lease_version,
      'renewals',c.renewals,'progress_ref',c.progress_ref,'expires_at',c.expires_at,
      'write_set',to_jsonb(c.write_set),'trigger_refs',to_jsonb(c.trigger_refs)))
  returning id into v_receipt;
  return jsonb_build_object('status','committed','receipt_id',v_receipt,
    'claim',clued_private.work_claim_view(c));
end $$;

revoke all on function
  public.clued_work_claim_v1(text,jsonb),
  public.clued_work_renew_v1(text,jsonb),
  public.clued_work_takeover_v1(text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function
  public.clued_work_claim_v1(text,jsonb),
  public.clued_work_renew_v1(text,jsonb),
  public.clued_work_takeover_v1(text,jsonb)
  to anon;

notify pgrst,'reload schema';
