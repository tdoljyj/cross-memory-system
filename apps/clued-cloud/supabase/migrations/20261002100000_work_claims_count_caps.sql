-- Work Claim count caps (Owner Decision a264ea02, Task 80aea04a).
--
-- The design's per-claim CI-minute budget with finalize is replaced by two
-- counts the database enforces without a writable CI credential:
-- * attempts_cap: a Task gets at most 10 new claims or takeovers in any
--   24 hours (work_claim_budget_exhausted, limit max_claims_per_task_24h);
-- * a claim admits at most 20 distinct pull-request heads: each verify with
--   pr_ref and head_sha records the head, and a new head past the cap is
--   REJECTED with claim_head_cap_reached. The same head verified again (a
--   re-run, the hourly reverify) does not count. A verify without pr_ref (a
--   hand dispatch, an Agent's own check) records nothing.

alter table clued_private.work_claims_v1
  add column admitted_heads text[] not null default '{}'::text[]
    check (cardinality(admitted_heads) <= 1000);

create or replace function clued_private.work_claim_profile_v1() returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_object(
    'profile_id','work-claim-v1-default',
    'lease_seconds',7200,
    'hard_deadline_seconds',86400,
    'max_renewals',12,
    'max_active_per_session',3,
    'max_active_per_binding',10,
    'max_claims_per_task_24h',10,
    'max_heads_per_claim',20)
$$;

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
  v_lease_seconds integer; v_active_session integer; v_recent integer; v_oldest timestamptz;
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
  select count(*)::integer,min(w.issued_at) into v_recent,v_oldest
    from clued_private.work_claims_v1 w
    where w.user_id=p_binding.user_id and w.task_id=p_task.id
      and w.issued_at>v_now-interval '24 hours';
  if v_recent>=(v_profile->>'max_claims_per_task_24h')::integer then
    return clued_private.work_claim_rejected('work_claim_budget_exhausted',
      jsonb_build_object('limit','max_claims_per_task_24h',
        'max_claims_per_task_24h',(v_profile->>'max_claims_per_task_24h')::integer,
        'claims_last_24h',v_recent,'task_id',p_task.id,
        'retry_after',v_oldest+interval '24 hours'));
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
  if v_max_fence<>c.fence then v_reasons:=v_reasons||to_jsonb('fence_superseded'::text); end if;
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

revoke all on function public.clued_work_verify_v1(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_work_verify_v1(text,jsonb) to anon;

notify pgrst,'reload schema';
