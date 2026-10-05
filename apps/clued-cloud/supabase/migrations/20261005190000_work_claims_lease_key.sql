-- Work Claim private lease key (Task f165eb56, Owner Decision 22b9bd9e, design Note 3ad61f76), PR 1.
--
-- A claim is held by the Binding that took it. When a Host reconnects with a
-- new Binding, the running work loses its claim: renew and release answer
-- work_claim_not_holder and only a takeover after expiry helps. Every field of
-- a claim is visible to every Binding of the user (active list, resume,
-- conflicts, Receipts), so none of them can prove who holds it.
--
-- Each claim now gets a private lease key, returned once:
--   * clued_work_claim and clued_work_takeover return lease_key at the top
--     level of a committed answer. The key is 'clued_lk_' and 64 hex digits
--     from 32 random bytes; only its sha256 is stored. A replay by the holder
--     returns a fresh key and the earlier one stops working.
--   * clued_work_renew and clued_work_release take an optional lease_key.
--     The holder Binding acts as before; a wrong key from it is refused with
--     work_claim_lease_key_invalid. Another Binding of the same user that
--     presents the key may act too: a renewal moves the claim to that Binding
--     (fence unchanged, the Receipt names the Binding it came from) and returns
--     a new key, so the one presented works once; a release ends it. Without
--     the right key it is still work_claim_not_holder. A wrong key from the
--     holder on a live claim is work_claim_lease_key_invalid; on an ended
--     claim the status refusal answers.
--   * A claim remembers the Binding that issued it. A replay of its
--     idempotency key by that Binding after the claim moved away is refused
--     with work_claim_idempotency_spent instead of starting a new claim.
-- The key never appears in work_claim_view, refusals, Receipts or events; the
-- Receipts say only that a key was used. Hashes are compared, not keys, so a
-- comparison's timing says nothing about the key. Claims issued before this
-- migration have no key and behave as before.

alter table clued_private.work_claims_v1
  add column lease_key_hash text check (lease_key_hash is null or lease_key_hash ~ '^[0-9a-f]{64}$'),
  add column issued_binding_id uuid references public.clued_agent_bindings(id) on delete set null;

create function clued_private.work_claim_lease_key_hash_v1(p_key text) returns text
language sql immutable set search_path='' as $$
  select pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p_key,'UTF8'),'sha256'),'hex')
$$;

-- A fresh key for a claim; its hash replaces any earlier one.
create function clued_private.work_claim_lease_key_issue_v1(p_claim_id uuid) returns text
language plpgsql volatile security definer set search_path='' as $$
declare v_key text:='clued_lk_'||pg_catalog.encode(extensions.gen_random_bytes(32),'hex');
begin
  update clued_private.work_claims_v1 set lease_key_hash=clued_private.work_claim_lease_key_hash_v1(v_key)
    where claim_id=p_claim_id;
  if not found then raise exception 'work_claim_not_found' using errcode='P0002'; end if;
  return v_key;
end $$;

-- A committed claim or takeover answer, with the claim's new key added.
create function clued_private.work_claim_with_lease_key_v1(p_result jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
begin
  if p_result->>'status' is distinct from 'committed' or p_result#>>'{claim,claim_id}' is null then
    return p_result; end if;
  return p_result||jsonb_build_object('lease_key',
    clued_private.work_claim_lease_key_issue_v1((p_result#>>'{claim,claim_id}')::uuid));
end $$;

-- How the calling Binding may act on claim c: 'holder', 'key' (another
-- Binding of the same user with the claim's key), or the refusal code. The
-- holder's key is checked only on a live claim that has one, so an ended claim
-- answers with its status refusal.
create function clued_private.work_claim_lease_access_v1(c clued_private.work_claims_v1,
  p_binding_id uuid,p_input jsonb) returns text
language sql stable set search_path='' as $$
  with k as (select case when p_input ? 'lease_key' and p_input->>'lease_key' is not null
    then clued_private.work_claim_lease_key_hash_v1(p_input->>'lease_key') end h)
  select case
    when c.holder_binding_id=p_binding_id then
      case when k.h is not null and c.lease_key_hash is not null and c.status in ('ACTIVE','DRAINING')
          and k.h<>c.lease_key_hash
        then 'work_claim_lease_key_invalid' else 'holder' end
    when k.h is not null and k.h=c.lease_key_hash then 'key'
    else 'work_claim_not_holder' end
  from k
$$;

revoke all on function
  clued_private.work_claim_lease_key_hash_v1(text),
  clued_private.work_claim_lease_key_issue_v1(uuid),
  clued_private.work_claim_with_lease_key_v1(jsonb),
  clued_private.work_claim_lease_access_v1(clued_private.work_claims_v1,uuid,jsonb)
  from public,anon,authenticated,service_role;

-- clued_work_claim_v1 and clued_work_takeover_v1: 20261003070000 with the key
-- added to every committed answer, replays included.
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
    where w.user_id=v_binding.user_id and w.idempotency_key=p_input->>'idempotency_key'
      and (w.holder_binding_id=v_binding.id or w.issued_binding_id=v_binding.id)
    order by (w.holder_binding_id=v_binding.id) desc,w.issued_at desc limit 1;
  if found and v_existing.holder_binding_id<>v_binding.id then
    -- Issued here, since moved to another Binding with its key.
    return clued_private.work_claim_reject_log_v1(v_binding,v_existing.context_key,v_existing.task_id,
      v_existing.claim_id,'work_claim','work_claim_idempotency_spent',
      jsonb_build_object('claim',clued_private.work_claim_view(v_existing),'transferred',true)); end if;
  if found then
    return clued_private.work_claim_with_lease_key_v1(
      clued_private.work_claim_replay_logged_v1(v_binding,v_existing,v_hash,'work_claim')); end if;
  perform clued_private.work_claim_expire_due(v_binding.user_id);
  v_task:=clued_private.work_claim_task(v_binding.user_id,v_scope,p_input->>'task_id');
  v_result:=clued_private.work_claim_issue(v_binding,p_input,v_task,v_none,'work_claim');
  if v_result->>'status'='committed' then
    update clued_private.work_claims_v1 set request_hash=v_hash,issued_binding_id=v_binding.id
      where claim_id=(v_result#>>'{claim,claim_id}')::uuid;
  end if;
  return clued_private.work_claim_with_lease_key_v1(v_result);
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
    where w.user_id=v_binding.user_id and w.idempotency_key=p_input->>'idempotency_key'
      and (w.holder_binding_id=v_binding.id or w.issued_binding_id=v_binding.id)
    order by (w.holder_binding_id=v_binding.id) desc,w.issued_at desc limit 1;
  if found and v_existing.holder_binding_id<>v_binding.id then
    -- Issued here, since moved to another Binding with its key.
    return clued_private.work_claim_reject_log_v1(v_binding,v_existing.context_key,v_existing.task_id,
      v_existing.claim_id,'work_claim_takeover','work_claim_idempotency_spent',
      jsonb_build_object('claim',clued_private.work_claim_view(v_existing),'transferred',true)); end if;
  if found then
    return clued_private.work_claim_with_lease_key_v1(
      clued_private.work_claim_replay_logged_v1(v_binding,v_existing,v_hash,'work_claim_takeover')); end if;
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
    update clued_private.work_claims_v1 set request_hash=v_hash,issued_binding_id=v_binding.id
      where claim_id=(v_result#>>'{claim,claim_id}')::uuid;
    -- The replaced claim's key is spent.
    update clued_private.work_claims_v1 set lease_key_hash=null where claim_id=v_old.claim_id;
  end if;
  return clued_private.work_claim_with_lease_key_v1(v_result);
end $$;

-- clued_work_renew_v1: 20261003070000 with the holder check replaced by
-- work_claim_lease_access_v1. A renewal with the key from another Binding
-- moves the claim to it once every other check has passed, within that
-- Binding's live-claim caps; holder_session_ref then names the new session,
-- and the answer carries a new key (the presented one stops working).
create or replace function public.clued_work_renew_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; c clued_private.work_claims_v1%rowtype;
  v_profile jsonb:=clued_private.work_claim_profile_v1(); v_now timestamptz:=pg_catalog.clock_timestamp();
  v_scope text:=coalesce(p_input->>'scope','global'); v_progress text; v_claim_id uuid;
  v_write_set text[]; v_triggers text[]; v_conflicts jsonb; v_receipt uuid; v_expires timestamptz;
  v_access text; v_from uuid; v_session text; v_active integer; v_active_session integer;
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
  v_access:=clued_private.work_claim_lease_access_v1(c,v_binding.id,p_input);
  if v_access not in ('holder','key') then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
      'work_claim_renew',v_access,
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

  if v_access='key' then
    v_session:=nullif(btrim(coalesce(p_input->>'holder_session_ref','')),'');
    -- The receiving Binding's caps apply as at a new claim.
    select count(*)::integer,
           count(*) filter (where coalesce(w.holder_session_ref,'')=coalesce(v_session,''))::integer
      into v_active,v_active_session from clued_private.work_claims_v1 w
      where w.user_id=v_binding.user_id and w.holder_binding_id=v_binding.id
        and w.status in ('ACTIVE','DRAINING') and w.expires_at>v_now;
    if v_active_session>=(v_profile->>'max_active_per_session')::integer then
      return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
        'work_claim_renew','work_claim_budget_exhausted',
        jsonb_build_object('limit','max_active_per_session',
          'max_active_per_session',(v_profile->>'max_active_per_session')::integer,
          'active',v_active_session,'holder_session_ref',v_session)); end if;
    if v_active>=(v_profile->>'max_active_per_binding')::integer then
      return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
        'work_claim_renew','work_claim_budget_exhausted',
        jsonb_build_object('limit','max_active_per_binding',
          'max_active_per_binding',(v_profile->>'max_active_per_binding')::integer,'active',v_active)); end if;
    -- Idempotency keys are unique per holder Binding.
    if exists(select 1 from clued_private.work_claims_v1 w where w.user_id=v_binding.user_id
        and w.holder_binding_id=v_binding.id and w.idempotency_key=c.idempotency_key) then
      return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
        'work_claim_renew','work_claim_idempotency_conflict',
        jsonb_build_object('claim_id',c.claim_id)); end if;
    v_from:=c.holder_binding_id;
  end if;

  v_expires:=least(v_now+make_interval(secs=>(v_profile->>'lease_seconds')::integer),c.hard_deadline_at);
  update clued_private.work_claims_v1 set lease_version=lease_version+1,renewals=renewals+1,
    expires_at=v_expires,progress_ref=v_progress,
    progress_refs=progress_refs||case when c.progress_ref is null or c.progress_ref=any(progress_refs)
      then array[v_progress] else array[c.progress_ref,v_progress] end,
    write_set=v_write_set,trigger_refs=v_triggers,
    holder_binding_id=v_binding.id,
    holder_session_ref=case when v_from is null then holder_session_ref else v_session end,
    updated_at=v_now where claim_id=c.claim_id returning * into c;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,
    object_type,object_id,version,metadata)
  values(v_binding.user_id,v_binding.id,c.context_key,'work_claim_renew','work_claim',
    c.claim_id::text,c.fence,jsonb_build_object('receipt_kind','WORK_CLAIM_RENEWED',
      'claim_id',c.claim_id,'task_id',c.task_id,'fence',c.fence,'lease_version',c.lease_version,
      'renewals',c.renewals,'progress_ref',c.progress_ref,'expires_at',c.expires_at,
      'write_set',to_jsonb(c.write_set),'trigger_refs',to_jsonb(c.trigger_refs))
      ||case when v_from is null then '{}'::jsonb
        else jsonb_build_object('via_lease_key',true,'transferred_from_binding',v_from) end)
  returning id into v_receipt;
  return jsonb_build_object('status','committed','receipt_id',v_receipt,
    'claim',clued_private.work_claim_view(c))
    ||case when v_from is null then '{}'::jsonb else jsonb_build_object('transferred',true,
      'lease_key',clued_private.work_claim_lease_key_issue_v1(c.claim_id)) end;
end $$;

-- clued_work_release_v1: 20261001060000 with the holder check replaced by
-- work_claim_lease_access_v1. A release with the key does not move the claim;
-- the Receipt says a key was used. An ended claim's key is cleared.
create or replace function public.clued_work_release_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; c clued_private.work_claims_v1%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global'); v_outcome text:=p_input->>'outcome';
  v_receipt uuid; v_now timestamptz:=pg_catalog.clock_timestamp(); v_access text;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',v_scope);
  perform clued_private.work_claim_lock(v_binding.user_id);
  perform clued_private.work_claim_expire_due(v_binding.user_id);
  if coalesce(v_outcome,'') not in ('completed','abandoned','draining') then
    raise exception 'work_claim_outcome_invalid' using errcode='22023'; end if;
  if coalesce(p_input->>'claim_id','') !~* '^[0-9a-f-]{36}$' then
    raise exception 'work_claim_id_invalid' using errcode='22023'; end if;
  select * into c from clued_private.work_claims_v1 w where w.user_id=v_binding.user_id
    and w.claim_id=(p_input->>'claim_id')::uuid and w.context_key=v_scope for update;
  if not found then return clued_private.work_claim_rejected('work_claim_not_found',null); end if;
  v_access:=clued_private.work_claim_lease_access_v1(c,v_binding.id,p_input);
  if v_access not in ('holder','key') then
    return clued_private.work_claim_rejected(v_access,
      jsonb_build_object('claim',clued_private.work_claim_view(c))); end if;
  if c.status not in ('ACTIVE','DRAINING') then
    return clued_private.work_claim_rejected('work_claim_not_active',
      jsonb_build_object('claim',clued_private.work_claim_view(c))); end if;
  if (p_input->>'fence')::bigint is distinct from c.fence then
    return clued_private.work_claim_rejected('work_claim_fence_mismatch',
      jsonb_build_object('expected_fence',c.fence)); end if;
  if v_outcome='draining' then
    update clued_private.work_claims_v1 set status='DRAINING',updated_at=v_now
      where claim_id=c.claim_id returning * into c;
  else
    update clued_private.work_claims_v1 set status='RELEASED',released_outcome=v_outcome,
      lease_key_hash=null,updated_at=v_now where claim_id=c.claim_id returning * into c;
  end if;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,
    object_type,object_id,version,metadata)
  values(v_binding.user_id,v_binding.id,c.context_key,'work_claim_release','work_claim',
    c.claim_id::text,c.fence,jsonb_build_object('receipt_kind',
      case v_outcome when 'draining' then 'WORK_CLAIM_DRAINING' else 'WORK_CLAIM_RELEASED' end,
      'claim_id',c.claim_id,'task_id',c.task_id,'fence',c.fence,'outcome',v_outcome,
      'evidence_ref',p_input->>'evidence_ref','status',c.status)
      ||case when v_access='key' then jsonb_build_object('via_lease_key',true) else '{}'::jsonb end)
  returning id into v_receipt;
  return jsonb_build_object('status','committed','receipt_id',v_receipt,
    'claim',clued_private.work_claim_view(c));
end $$;

revoke all on function
  public.clued_work_claim_v1(text,jsonb),
  public.clued_work_renew_v1(text,jsonb),
  public.clued_work_takeover_v1(text,jsonb),
  public.clued_work_release_v1(text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function
  public.clued_work_claim_v1(text,jsonb),
  public.clued_work_renew_v1(text,jsonb),
  public.clued_work_takeover_v1(text,jsonb),
  public.clued_work_release_v1(text,jsonb)
  to anon;

notify pgrst,'reload schema';
