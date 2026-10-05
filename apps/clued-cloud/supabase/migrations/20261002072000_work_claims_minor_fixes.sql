-- Work Claim MINOR fixes from the step 7 review (Task 27b4f5e8; development/
-- contracts/execution-admission/WorkClaimAdmission.v0.1.md §4.3, §4.4).
--
-- 1. Trigger refs compare case-insensitively, and a commit SHA after "@"
--    matches its own prefix: ghsa:GHSA-x and ghsa:ghsa-x conflict, and so do
--    ci:trivy@f7ba6ff and ci:trivy@f7ba6ff3129... Stored refs keep the case
--    they were declared with (only the kind is lower-cased, as before); the
--    comparison lower-cases both sides.
-- 2. An idempotency key names one piece of work. clued_work_claim_v1 and
--    clued_work_takeover_v1 store a hash of the operation, scope, task (or
--    claim taken over) and normalized write set; a replay naming other work
--    under the same key is rejected with work_claim_idempotency_conflict
--    instead of returning the unrelated claim. A replay whose claim is no longer live (released, expired,
--    superseded) is rejected with work_claim_idempotency_spent, so a caller
--    never reads "committed" for a claim it no longer holds. Rows from
--    before this migration have no hash and replay as before.
-- 3. Renewal progress cannot repeat: a progress_ref used by any earlier
--    renewal of the claim is refused (alternating x,y,x,y used to pass).
-- 4. "**/" also matches zero directories, so "**/package-lock.json" covers
--    the root package-lock.json, as the CI path filters already read it.

alter table clued_private.work_claims_v1
  add column request_hash text check (request_hash is null or request_hash ~ '^[0-9a-f]{64}$'),
  add column progress_refs text[] not null default '{}'::text[] check (cardinality(progress_refs) <= 64);

-- Two trigger refs name the same trigger when they are equal ignoring case,
-- or equal up to "@" and the parts after it are hex of at least 7 characters
-- where one is a prefix of the other (short and full commit SHA).
create function clued_private.work_claim_triggers_match(p_a text,p_b text) returns boolean
language sql immutable set search_path='' as $$
  select lower(p_a)=lower(p_b) or (
    strpos(p_a,'@')>0 and strpos(p_b,'@')>0
    and lower(split_part(p_a,'@',1))=lower(split_part(p_b,'@',1))
    and lower(substr(p_a,strpos(p_a,'@')+1)) ~ '^[0-9a-f]{7,64}$'
    and lower(substr(p_b,strpos(p_b,'@')+1)) ~ '^[0-9a-f]{7,64}$'
    and (starts_with(lower(substr(p_a,strpos(p_a,'@')+1)),lower(substr(p_b,strpos(p_b,'@')+1)))
      or starts_with(lower(substr(p_b,strpos(p_b,'@')+1)),lower(substr(p_a,strpos(p_a,'@')+1)))))
$$;

create or replace function clued_private.work_claim_glob_regex(p_glob text) returns text
language plpgsql immutable set search_path='' as $$
declare v text; v_dir boolean:=right(p_glob,3)='/**';
begin
  v:=case when v_dir then left(p_glob,length(p_glob)-3) else p_glob end;
  v:=regexp_replace(v,'([.+?^${}()|\[\]\\])','\\\1','g');
  v:=replace(v,'**/',chr(2));
  v:=replace(v,'**',chr(1));
  v:=replace(v,'*','[^/]*');
  v:=replace(v,chr(1),'.*');
  v:=replace(v,chr(2),'(.*/)?');
  if v_dir then return '^'||v||'(/.*)?$'; end if;
  return '^'||v||'$';
end $$;

create or replace function clued_private.work_claim_conflicts(
  p_user_id uuid,p_task_id uuid,p_write_set text[],p_triggers text[],p_exclude uuid
) returns jsonb language plpgsql stable set search_path='' as $$
declare v_out jsonb:='[]'::jsonb; c clued_private.work_claims_v1%rowtype;
  v_paths text[]; v_trig text[];
begin
  for c in select * from clued_private.work_claims_v1 w
    where w.user_id=p_user_id and w.status in ('ACTIVE','DRAINING')
      and w.expires_at>pg_catalog.clock_timestamp()
      and (p_exclude is null or w.claim_id<>p_exclude)
    order by w.issued_at loop
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

-- The work an idempotency key stands for: the operation, scope, the task (or
-- the claim taken over) and the normalized write set. Optional fields a retry
-- may leave out (trigger refs, base commit, session, lease, budget) are not
-- part of it.
create function clued_private.work_claim_request_hash(p_operation text,p_input jsonb) returns text
language plpgsql immutable set search_path='' as $$
begin
  return encode(pg_catalog.sha256(convert_to(jsonb_build_object(
    'operation',p_operation,
    'scope',coalesce(p_input->>'scope','global'),
    'task_id',lower(p_input->>'task_id'),
    'claim_id',lower(p_input->>'claim_id'),
    'write_set',case when p_input ? 'write_set'
      then to_jsonb(clued_private.work_claim_normalize_paths(p_input->'write_set')) end)::text,'UTF8')),'hex');
end $$;

-- Replay of a stored request under the same key. Returns null when the key is
-- new; otherwise the replay result or a rejection.
create function clued_private.work_claim_replay(p_existing clued_private.work_claims_v1,p_hash text)
returns jsonb language plpgsql stable set search_path='' as $$
begin
  if p_existing.request_hash is not null and p_existing.request_hash<>p_hash then
    return clued_private.work_claim_rejected('work_claim_idempotency_conflict',
      jsonb_build_object('claim_id',p_existing.claim_id));
  end if;
  if p_existing.status not in ('ACTIVE','DRAINING') or p_existing.expires_at<=pg_catalog.clock_timestamp() then
    return clued_private.work_claim_rejected('work_claim_idempotency_spent',
      jsonb_build_object('claim',clued_private.work_claim_view(p_existing)));
  end if;
  return jsonb_build_object('status','committed','replayed',true,'receipt_id',p_existing.receipt_id,
    'claim',clued_private.work_claim_view(p_existing));
end $$;

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
  if found then return clued_private.work_claim_replay(v_existing,v_hash); end if;
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
  if found then return clued_private.work_claim_replay(v_existing,v_hash); end if;
  perform clued_private.work_claim_expire_due(v_binding.user_id);
  if coalesce(p_input->>'claim_id','') !~* '^[0-9a-f-]{36}$' then
    raise exception 'work_claim_id_invalid' using errcode='22023'; end if;
  select * into v_old from clued_private.work_claims_v1 w where w.user_id=v_binding.user_id
    and w.claim_id=(p_input->>'claim_id')::uuid and w.context_key=v_scope for update;
  if not found then return clued_private.work_claim_rejected('work_claim_not_found',null); end if;
  if v_old.status in ('RELEASED','SUPERSEDED') then
    return clued_private.work_claim_rejected('work_claim_not_takeover_eligible',
      jsonb_build_object('claim',clued_private.work_claim_view(v_old))); end if;
  if v_old.status in ('ACTIVE','DRAINING') and v_old.expires_at>pg_catalog.clock_timestamp() then
    return clued_private.work_claim_rejected('work_claim_still_active',
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
  v_scope text:=coalesce(p_input->>'scope','global'); v_progress text;
  v_write_set text[]; v_triggers text[]; v_conflicts jsonb; v_receipt uuid; v_expires timestamptz;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',v_scope);
  perform clued_private.work_claim_lock(v_binding.user_id);
  perform clued_private.work_claim_expire_due(v_binding.user_id);
  if coalesce(p_input->>'claim_id','') !~* '^[0-9a-f-]{36}$' then
    raise exception 'work_claim_id_invalid' using errcode='22023'; end if;
  select * into c from clued_private.work_claims_v1 w where w.user_id=v_binding.user_id
    and w.claim_id=(p_input->>'claim_id')::uuid and w.context_key=v_scope for update;
  if not found then return clued_private.work_claim_rejected('work_claim_not_found',null); end if;
  if c.holder_binding_id<>v_binding.id then
    return clued_private.work_claim_rejected('work_claim_not_holder',
      jsonb_build_object('claim',clued_private.work_claim_view(c))); end if;
  if c.status='EXPIRED' then
    return clued_private.work_claim_rejected('work_claim_expired',
      jsonb_build_object('claim',clued_private.work_claim_view(c))); end if;
  if c.status<>'ACTIVE' then
    return clued_private.work_claim_rejected('work_claim_not_active',
      jsonb_build_object('claim',clued_private.work_claim_view(c))); end if;
  if (p_input->>'fence')::bigint is distinct from c.fence then
    return clued_private.work_claim_rejected('work_claim_fence_mismatch',
      jsonb_build_object('expected_fence',c.fence)); end if;
  if (p_input->>'lease_version')::bigint is distinct from c.lease_version then
    return clued_private.work_claim_rejected('work_claim_version_conflict',
      jsonb_build_object('expected_lease_version',c.lease_version)); end if;
  v_progress:=nullif(btrim(coalesce(p_input->>'progress_ref','')),'');
  if v_progress is null or v_progress is not distinct from c.progress_ref
      or v_progress=any(c.progress_refs) then
    return clued_private.work_claim_rejected('work_claim_no_progress',
      jsonb_build_object('last_progress_ref',c.progress_ref,'used_progress_refs',to_jsonb(c.progress_refs))); end if;
  if c.renewals>=(v_profile->>'max_renewals')::integer then
    return clued_private.work_claim_rejected('work_claim_renewal_budget_exhausted',
      jsonb_build_object('max_renewals',(v_profile->>'max_renewals')::integer,'renewals',c.renewals)); end if;
  if c.expires_at>=c.hard_deadline_at then
    return clued_private.work_claim_rejected('work_claim_hard_deadline',
      jsonb_build_object('hard_deadline_at',c.hard_deadline_at)); end if;

  v_write_set:=case when p_input ? 'write_set'
    then clued_private.work_claim_normalize_paths(p_input->'write_set') else c.write_set end;
  v_triggers:=case when p_input ? 'trigger_refs'
    then clued_private.work_claim_normalize_triggers(p_input->'trigger_refs') else c.trigger_refs end;
  if v_write_set<>c.write_set or v_triggers<>c.trigger_refs then
    v_conflicts:=clued_private.work_claim_conflicts(v_binding.user_id,c.task_id,v_write_set,v_triggers,c.claim_id);
    if jsonb_array_length(v_conflicts)>0 then
      return clued_private.work_claim_rejected('work_claim_conflict',
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
  clued_private.work_claim_triggers_match(text,text),
  clued_private.work_claim_request_hash(text,jsonb),
  clued_private.work_claim_replay(clued_private.work_claims_v1,text)
  from public,anon,authenticated,service_role;
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
