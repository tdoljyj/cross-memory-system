-- Work Claims: the merge slot gets its own clock and is returned on merge
-- (Task f89eaf0a; Owner Decisions 0edf7889 and 2ea795e4).
--
-- The merge slot (agent contract v33 §1.7) is the trigger ref
-- merge:<owner>/<name>:<branch>: a session takes it by renewing its pull
-- request's claim with the ref, and work_claim_conflicts lets one live claim of
-- the account hold it at a time. Two gaps are closed here:
-- 1. A holder that stops kept the slot until its claim's 2 h lease ended. The
--    slot now lapses on its own clock: merge_slot_seconds (2700, 45 minutes)
--    after the claim last took or refreshed it. A claim takes or refreshes the
--    slot when it is issued with a merge ref, or renewed with one (a renewal
--    needs a new progress_ref, so a slot is refreshed only by a session that
--    is still working). An Owner handover does not refresh it. A lapsed slot
--    is free: work_claim_conflicts no longer counts its merge refs, and a
--    renewal that keeps an unchanged merge ref is checked against the other
--    claims' live slots, so the old holder cannot take back a slot that
--    another session took after it lapsed.
-- 2. The slot is returned at once when its pull request is merged
--    (clued_work_claim_adopt_v1, the merge report) or closed without a merge
--    (clued_work_merge_slot_return_v1), both called only by the CI admission
--    Binding: the merge refs are dropped from the claims bound to that pull
--    request, with a WORK_CLAIM_MERGE_SLOT_RETURNED Receipt.
-- work_claim_view shows merge_slot_until (null when the claim holds no live
-- slot), which the admission check reads to post the clued-merge-slot check:
-- a pull request that contains the base branch's tip can only merge while its
-- claim holds the slot (scripts/ci/clued-work-admission.mjs). The profile
-- carries merge_slot_seconds.

alter table clued_private.work_claims_v1 add column merge_slot_at timestamptz;

-- Profile: 20261003180000 plus merge_slot_seconds.
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
    'merge_slot_seconds',2700)
$$;

-- The merge refs among normalized trigger refs (kind "merge", lower-cased by
-- work_claim_normalize_triggers).
create function clued_private.work_claim_merge_refs_v1(p_refs text[]) returns text[]
language sql immutable set search_path='' as $$
  select coalesce(array_agg(t order by t),'{}'::text[]) from unnest(p_refs) t where t like 'merge:%'
$$;

-- When the claim's slot lapses, or null when it holds none. A slot of a claim
-- that is no longer live has lapsed with it.
create function clued_private.work_claim_merge_slot_until_v1(c clued_private.work_claims_v1) returns timestamptz
language sql stable set search_path='' as $$
  select case when c.merge_slot_at is not null
      and cardinality(clued_private.work_claim_merge_refs_v1(c.trigger_refs))>0
      and c.status in ('ACTIVE','DRAINING')
    then least(c.merge_slot_at+make_interval(secs=>(clued_private.work_claim_profile_v1()->>'merge_slot_seconds')::integer),
      c.expires_at) end
$$;

create function clued_private.work_claim_merge_slot_live_v1(c clued_private.work_claims_v1) returns boolean
language sql stable set search_path='' as $$
  select coalesce(clued_private.work_claim_merge_slot_until_v1(c)>pg_catalog.clock_timestamp(),false)
$$;

-- Stamps the slot clock: issued with a merge ref, renewed with one (renewals
-- moves), or a merge ref newly added. Without merge refs there is no clock.
-- Any other update keeps the value it is given.
create function clued_private.work_claim_merge_slot_stamp_v1() returns trigger
language plpgsql set search_path='' as $$
begin
  if cardinality(clued_private.work_claim_merge_refs_v1(new.trigger_refs))=0 then
    new.merge_slot_at:=null;
  elsif tg_op='INSERT' or new.renewals is distinct from old.renewals
      or cardinality(clued_private.work_claim_merge_refs_v1(old.trigger_refs))=0 then
    new.merge_slot_at:=pg_catalog.clock_timestamp();
  end if;
  return new;
end $$;

create trigger work_claims_v1_merge_slot_stamp
  before insert or update of trigger_refs,renewals,merge_slot_at on clued_private.work_claims_v1
  for each row execute function clued_private.work_claim_merge_slot_stamp_v1();

-- A live claim that took the slot before this migration starts its clock at
-- its last write.
update clued_private.work_claims_v1 set merge_slot_at=updated_at
  where status in ('ACTIVE','DRAINING') and cardinality(clued_private.work_claim_merge_refs_v1(trigger_refs))>0;

-- work_claim_view: 20261005200000 plus merge_slot_until.
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
      then clued_private.work_claim_merge_slot_until_v1(c) end)
$$;

-- work_claim_conflicts: 20261003120000, except that a claim's merge refs
-- count only while its slot is live.
create or replace function clued_private.work_claim_conflicts(
  p_user_id uuid,p_task_id uuid,p_write_set text[],p_triggers text[],p_exclude uuid
) returns jsonb language plpgsql stable set search_path='' as $$
declare v_out jsonb:='[]'::jsonb; c clued_private.work_claims_v1%rowtype;
  v_paths text[]; v_trig text[]; v_slot boolean;
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
    v_slot:=clued_private.work_claim_merge_slot_live_v1(c);
    select coalesce(array_agg(t order by t),'{}'::text[]) into v_trig
      from unnest(c.trigger_refs) t
      where (v_slot or t not like 'merge:%')
        and exists(select 1 from unnest(p_triggers) n where clued_private.work_claim_triggers_match(t,n));
    if c.task_id=p_task_id or cardinality(v_paths)>0 or cardinality(v_trig)>0 then
      v_out:=v_out||jsonb_build_array(jsonb_build_object('claim_id',c.claim_id,'task_id',c.task_id,
        'holder_binding_id',c.holder_binding_id,'holder_session_ref',c.holder_session_ref,
        'status',c.status,'fence',c.fence,'expires_at',c.expires_at,
        'overlap',jsonb_build_object('same_task',c.task_id=p_task_id,
          'paths',to_jsonb(v_paths),'trigger_refs',to_jsonb(v_trig)))
        ||case when v_slot and exists(select 1 from unnest(v_trig) t where t like 'merge:%')
          then jsonb_build_object('merge_slot_until',clued_private.work_claim_merge_slot_until_v1(c)) else '{}'::jsonb end);
    end if;
  end loop;
  return v_out;
end $$;

-- Drops the merge refs of the live claims bound to a pull request, with one
-- Receipt per claim; returns the claim ids. Called under the user lock.
create function clued_private.work_claim_merge_slot_return_core_v1(
  p_user_id uuid,p_binding_id uuid,p_scope text,p_pr text,p_why text,p_ref jsonb
) returns uuid[] language plpgsql volatile security definer set search_path='' as $$
declare c clued_private.work_claims_v1%rowtype; v_out uuid[]:='{}'::uuid[]; v_now timestamptz:=pg_catalog.clock_timestamp();
  v_refs text[];
begin
  for c in select * from clued_private.work_claims_v1 w
    where w.user_id=p_user_id and w.context_key=p_scope and w.bound_pr=p_pr
      and w.status in ('ACTIVE','DRAINING')
      and cardinality(clued_private.work_claim_merge_refs_v1(w.trigger_refs))>0
    order by w.issued_at for update loop
    v_refs:=clued_private.work_claim_merge_refs_v1(c.trigger_refs);
    update clued_private.work_claims_v1
      set trigger_refs=array(select t from unnest(c.trigger_refs) t where t not like 'merge:%' order by t),
        updated_at=v_now
      where claim_id=c.claim_id;
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,
      object_type,object_id,version,metadata)
    values(c.user_id,p_binding_id,c.context_key,'work_claim_merge_slot_return','work_claim',
      c.claim_id::text,c.fence,jsonb_build_object('receipt_kind','WORK_CLAIM_MERGE_SLOT_RETURNED',
        'claim_id',c.claim_id,'task_id',c.task_id,'fence',c.fence,'bound_pr',p_pr,'why',p_why,
        'merge_refs',to_jsonb(v_refs),'ref',coalesce(p_ref,'{}'::jsonb)));
    v_out:=v_out||c.claim_id;
  end loop;
  return v_out;
end $$;

-- clued_work_claim_adopt_v1: 20261003200000; a merged pull request also
-- returns the merge slot of the claims bound to it, copy or not.
create or replace function public.clued_work_claim_adopt_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; c clued_private.work_claims_v1%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global'); v_pr text:=nullif(btrim(coalesce(p_input->>'pr_ref','')),'');
  v_merge text:=lower(nullif(btrim(coalesce(p_input->>'merge_sha','')),'')); v_returned uuid[];
begin
  if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('scope','pr_ref','merge_sha')) then
    raise exception 'work_claim_adopt_input_invalid' using errcode='22023'; end if;
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_scope);
  -- Decision 38ddb8cf: only the CI admission Binding reports a merge.
  if not clued_private.binding_role_admits_v1(v_binding,'ci-admission') then
    return jsonb_build_object('status','ok','adopted',false,'reason','admission_binding_required');
  end if;
  if v_pr is null or v_pr !~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[0-9]{1,10}$' then
    raise exception 'work_claim_pr_ref_invalid' using errcode='22023'; end if;
  if v_merge is null or v_merge !~ '^[0-9a-f]{7,64}$' then
    raise exception 'work_claim_head_sha_invalid' using errcode='22023'; end if;
  perform clued_private.work_claim_lock(v_binding.user_id);
  v_returned:=clued_private.work_claim_merge_slot_return_core_v1(v_binding.user_id,v_binding.id,v_scope,v_pr,
    'merged',jsonb_build_object('merge_sha',v_merge));
  select * into c from clued_private.work_claims_v1 w
    where w.user_id=v_binding.user_id and w.context_key=v_scope and w.bound_pr=v_pr and w.copy_index is not null
    order by w.issued_at desc limit 1;
  -- The answer is as before, with merge_slot_returned only when a slot was returned.
  if not found then return jsonb_build_object('status','ok','adopted',false,'reason','no_copy_for_pr','pr_ref',v_pr)
    ||case when cardinality(v_returned)>0 then jsonb_build_object('merge_slot_returned',to_jsonb(v_returned)) else '{}'::jsonb end; end if;
  return clued_private.work_claim_adopt_core_v1(c,v_binding.id,'github',
    jsonb_build_object('pr_ref',v_pr,'merge_sha',v_merge))||jsonb_build_object('pr_ref',v_pr)
    ||case when cardinality(v_returned)>0 then jsonb_build_object('merge_slot_returned',to_jsonb(v_returned)) else '{}'::jsonb end;
end $$;

-- A pull request closed without a merge returns its merge slot too. Input
-- {scope, pr_ref}; only the CI admission Binding (Decision 38ddb8cf).
create function public.clued_work_merge_slot_return_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global'); v_pr text:=nullif(btrim(coalesce(p_input->>'pr_ref','')),'');
  v_returned uuid[];
begin
  if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('scope','pr_ref')) then
    raise exception 'work_claim_merge_slot_return_input_invalid' using errcode='22023'; end if;
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_scope);
  if not clued_private.binding_role_admits_v1(v_binding,'ci-admission') then
    return jsonb_build_object('status','ok','returned',false,'reason','admission_binding_required');
  end if;
  if v_pr is null or v_pr !~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[0-9]{1,10}$' then
    raise exception 'work_claim_pr_ref_invalid' using errcode='22023'; end if;
  perform clued_private.work_claim_lock(v_binding.user_id);
  v_returned:=clued_private.work_claim_merge_slot_return_core_v1(v_binding.user_id,v_binding.id,v_scope,v_pr,
    'closed',null);
  return jsonb_build_object('status','ok','returned',cardinality(v_returned)>0,'pr_ref',v_pr,
    'merge_slot_returned',to_jsonb(v_returned));
end $$;

-- clued_work_renew_v1: 20261005200000, except that a renewal that keeps an
-- unchanged merge ref is checked against the other claims' live slots: it
-- refreshes the slot, which must not revive a lapsed one that another
-- session has taken since.
create or replace function public.clued_work_renew_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; c clued_private.work_claims_v1%rowtype;
  v_profile jsonb:=clued_private.work_claim_profile_v1(); v_now timestamptz:=pg_catalog.clock_timestamp();
  v_scope text:=coalesce(p_input->>'scope','global'); v_progress text; v_claim_id uuid;
  v_write_set text[]; v_triggers text[]; v_conflicts jsonb; v_receipt uuid; v_expires timestamptz;
  v_access text; v_from uuid; v_session text; v_active integer; v_active_session integer;
  v_label text:=clued_private.work_claim_self_report_v1(p_input,'holder_label',200);
  v_client text:=clued_private.work_claim_self_report_v1(p_input,'holder_client',80);
  v_title text:=clued_private.work_claim_self_report_v1(p_input,'holder_session_title',200);
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
  elsif cardinality(clued_private.work_claim_merge_refs_v1(v_triggers))>0 then
    -- Unchanged, but the renewal refreshes the slot: only the merge refs are checked.
    v_conflicts:=clued_private.work_claim_conflicts(v_binding.user_id,null,'{}'::text[],
      clued_private.work_claim_merge_refs_v1(v_triggers),c.claim_id);
  end if;
  if jsonb_array_length(coalesce(v_conflicts,'[]'::jsonb))>0 then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
      'work_claim_renew','work_claim_conflict',
      jsonb_build_object('conflicts',v_conflicts,'write_set',to_jsonb(v_write_set),
        'trigger_refs',to_jsonb(v_triggers)));
  end if;

  v_session:=nullif(btrim(coalesce(p_input->>'holder_session_ref','')),'');
  if v_access='key' then
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
    -- A new session that holds a handed-over claim's key names itself, on the same Binding too.
    holder_session_ref=case when v_from is not null then v_session
      when c.lease_key_required and p_input ? 'holder_session_ref' then v_session else holder_session_ref end,
    holder_label=case when p_input ? 'holder_label' then v_label else holder_label end,
    holder_client=case when p_input ? 'holder_client' then v_client else holder_client end,
    holder_session_title=case when p_input ? 'holder_session_title' then v_title else holder_session_title end,
    updated_at=v_now where claim_id=c.claim_id returning * into c;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,
    object_type,object_id,version,metadata)
  values(v_binding.user_id,v_binding.id,c.context_key,'work_claim_renew','work_claim',
    c.claim_id::text,c.fence,jsonb_build_object('receipt_kind','WORK_CLAIM_RENEWED',
      'claim_id',c.claim_id,'task_id',c.task_id,'fence',c.fence,'lease_version',c.lease_version,
      'renewals',c.renewals,'progress_ref',c.progress_ref,'expires_at',c.expires_at,
      'write_set',to_jsonb(c.write_set),'trigger_refs',to_jsonb(c.trigger_refs))
      ||case when c.merge_slot_at is null then '{}'::jsonb
        else jsonb_build_object('merge_slot_until',clued_private.work_claim_merge_slot_until_v1(c)) end
      ||case when v_from is null then '{}'::jsonb
        else jsonb_build_object('via_lease_key',true,'transferred_from_binding',v_from) end)
  returning id into v_receipt;
  return jsonb_build_object('status','committed','receipt_id',v_receipt,
    'claim',clued_private.work_claim_view(c))
    ||case when v_from is null then '{}'::jsonb else jsonb_build_object('transferred',true,
      'lease_key',clued_private.work_claim_lease_key_issue_v1(c.claim_id)) end;
end $$;

revoke all on function
  clued_private.work_claim_merge_refs_v1(text[]),
  clued_private.work_claim_merge_slot_until_v1(clued_private.work_claims_v1),
  clued_private.work_claim_merge_slot_live_v1(clued_private.work_claims_v1),
  clued_private.work_claim_merge_slot_stamp_v1(),
  clued_private.work_claim_merge_slot_return_core_v1(uuid,uuid,text,text,text,jsonb)
  from public,anon,authenticated,service_role;
revoke all on function
  public.clued_work_merge_slot_return_v1(text,jsonb),
  public.clued_work_claim_adopt_v1(text,jsonb),
  public.clued_work_renew_v1(text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function
  public.clued_work_merge_slot_return_v1(text,jsonb),
  public.clued_work_claim_adopt_v1(text,jsonb),
  public.clued_work_renew_v1(text,jsonb)
  to anon;

notify pgrst,'reload schema';
