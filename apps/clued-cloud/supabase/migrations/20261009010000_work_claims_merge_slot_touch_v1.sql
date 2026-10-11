-- Work Claims: the merge slot follows CI (Merge Admission v0.1 §7.3 and §10,
-- step 3 of §13; Task 3576d10d; Owner Decisions 4f576896 and 1fb7f6b3).
--
-- Until now the slot lapsed 45 minutes after its holder last took it or
-- renewed its claim (20261006120000), so a session waiting for CI had to renew
-- every half hour to keep it. Now the CI admission Binding reports the CI state
-- of the pull request that holds the slot (clued_work_merge_slot_touch_v1, from
-- the clued-merge-slot-ci workflow, which runs default-branch code):
-- - running: a CI run is queued or in progress on the head; the slot stays for
--   merge_slot_running_seconds (90 minutes) after the report. Reports come
--   when a CI run completes and at least hourly, and a run's start sends none,
--   so the window covers an hour between reports with room for a late
--   scheduled run (independent review MAJOR-1). The hard cap bounds it.
-- - green: the four CI required checks passed; the slot stays for
--   merge_slot_green_seconds (30 minutes) after the first green report for
--   the head, for the merge; later green reports for the same head do not
--   move it (review MINOR-3).
-- - failed: one of them finally failed; the slot is returned at once with a
--   WORK_CLAIM_MERGE_SLOT_RETURNED Receipt (why ci_failed), like a merge or a
--   close.
-- A renewal still refreshes the slot as before; the slot lapses at the later
-- of the two clocks. Whatever the reports, it lapses merge_slot_hard_cap
-- (the policy file's merge_slot_hard_cap_minutes, sent with each report,
-- 60 to 180 minutes) after it was taken, so a long CI run cannot keep it for
-- ever while others wait. A report never revives a slot that has lapsed, and a
-- renewal that takes a lapsed slot again starts a new slot (new taken time, no
-- CI state). So the cap frees the slot for a session that waits for it; a
-- holder that renews after the cap with nobody waiting takes it again (review
-- MINOR-2, accepted). The lease of the claim still bounds the slot.
--
-- clued_work_merge_slot_holders_v1 lists the live slots of a repository, so
-- the workflow looks only at the pull requests that hold one.
--
-- clued_work_verify_v1 also takes admission_mode {state, layer,
-- reruns_per_head}, the mode the admission check judged the head in (§10). It
-- is written into the WORK_CLAIM_BOUND_TO_PR Receipt and into a new
-- WORK_CLAIM_HEAD_ADMITTED Receipt each time a pull request head is admitted
-- for the first time, so Clued shows in what mode each head was let through.
-- A verify without it answers as before.

alter table clued_private.work_claims_v1
  add column merge_slot_taken_at timestamptz,
  add column merge_slot_ci_state text,
  add column merge_slot_ci_head text,
  add column merge_slot_ci_at timestamptz,
  add column merge_slot_hard_cap_seconds integer,
  add constraint work_claims_v1_merge_slot_ci_state_check
    check (merge_slot_ci_state is null or merge_slot_ci_state in ('running','green')),
  add constraint work_claims_v1_merge_slot_hard_cap_check
    check (merge_slot_hard_cap_seconds is null or merge_slot_hard_cap_seconds between 3600 and 10800);

-- Profile: 20261006180000 plus merge_slot_running_seconds and merge_slot_green_seconds.
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
    'merge_slot_running_seconds',5400,
    'merge_slot_green_seconds',1800,
    'continuation_window_seconds',900)
$$;

-- When the claim's slot lapses, or null when it holds none: the later of the
-- renewal clock and the CI clock, but never after the hard cap or the lease.
-- greatest and least skip nulls, so a slot without CI reports is as before.
create or replace function clued_private.work_claim_merge_slot_until_v1(c clued_private.work_claims_v1) returns timestamptz
language sql stable set search_path='' as $$
  select case when c.merge_slot_at is not null
      and cardinality(clued_private.work_claim_merge_refs_v1(c.trigger_refs))>0
      and c.status in ('ACTIVE','DRAINING')
    then least(
      greatest(c.merge_slot_at+make_interval(secs=>(clued_private.work_claim_profile_v1()->>'merge_slot_seconds')::integer),
        case c.merge_slot_ci_state
          when 'running' then c.merge_slot_ci_at+make_interval(secs=>(clued_private.work_claim_profile_v1()->>'merge_slot_running_seconds')::integer)
          when 'green' then c.merge_slot_ci_at+make_interval(secs=>(clued_private.work_claim_profile_v1()->>'merge_slot_green_seconds')::integer)
        end),
      c.merge_slot_taken_at+make_interval(secs=>c.merge_slot_hard_cap_seconds),
      c.expires_at) end
$$;

-- Stamps the slot clocks. Taken: issued with a merge ref, a merge ref newly
-- added, or renewed with one while the slot had lapsed; that starts a new
-- slot without CI state. Refreshed: renewed with a live slot. Without merge
-- refs there is no slot. Any other update keeps the values it is given.
create or replace function clued_private.work_claim_merge_slot_stamp_v1() returns trigger
language plpgsql set search_path='' as $$
begin
  if cardinality(clued_private.work_claim_merge_refs_v1(new.trigger_refs))=0 then
    new.merge_slot_at:=null;
    new.merge_slot_taken_at:=null;
    new.merge_slot_ci_state:=null;
    new.merge_slot_ci_head:=null;
    new.merge_slot_ci_at:=null;
    new.merge_slot_hard_cap_seconds:=null;
  elsif tg_op='INSERT'
      or cardinality(clued_private.work_claim_merge_refs_v1(old.trigger_refs))=0
      or (new.renewals is distinct from old.renewals and not clued_private.work_claim_merge_slot_live_v1(old)) then
    new.merge_slot_at:=pg_catalog.clock_timestamp();
    new.merge_slot_taken_at:=new.merge_slot_at;
    new.merge_slot_ci_state:=null;
    new.merge_slot_ci_head:=null;
    new.merge_slot_ci_at:=null;
    new.merge_slot_hard_cap_seconds:=null;
  elsif new.renewals is distinct from old.renewals then
    new.merge_slot_at:=pg_catalog.clock_timestamp();
  end if;
  return new;
end $$;

-- A live slot taken before this migration counts from its last stamp.
update clued_private.work_claims_v1 set merge_slot_taken_at=merge_slot_at
  where merge_slot_at is not null and status in ('ACTIVE','DRAINING');

-- What a live slot's CI reports say, or null.
create function clued_private.work_claim_merge_slot_ci_view_v1(c clued_private.work_claims_v1) returns jsonb
language sql stable set search_path='' as $$
  select case when clued_private.work_claim_merge_slot_live_v1(c) then jsonb_build_object(
    'taken_at',c.merge_slot_taken_at,
    'hard_cap_until',c.merge_slot_taken_at+make_interval(secs=>c.merge_slot_hard_cap_seconds),
    'ci_state',c.merge_slot_ci_state,'ci_head_sha',c.merge_slot_ci_head,'ci_at',c.merge_slot_ci_at) end
$$;

-- work_claim_view: 20261006180000 plus merge_slot_ci.
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
    'merge_slot_ci',clued_private.work_claim_merge_slot_ci_view_v1(c),
    'continued_from',c.continued_from)
$$;

-- The CI report for the pull request holding a slot. Input {scope, pr_ref,
-- head_sha, ci_state, hard_cap_minutes}; only the CI admission Binding
-- (Decision 38ddb8cf). running and green refresh the live slots of the claims
-- bound to the pull request (one Receipt when the state or head changes);
-- failed returns them. A lapsed slot is not revived.
create function public.clued_work_merge_slot_touch_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; c clued_private.work_claims_v1%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global'); v_pr text:=nullif(btrim(coalesce(p_input->>'pr_ref','')),'');
  v_head text:=lower(nullif(btrim(coalesce(p_input->>'head_sha','')),'')); v_state text:=p_input->>'ci_state';
  v_cap integer; v_now timestamptz:=pg_catalog.clock_timestamp(); v_touched uuid[]:='{}'::uuid[];
  v_returned uuid[]; v_until timestamptz; v_prefix text;
begin
  if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k
        where k not in ('scope','pr_ref','head_sha','ci_state','hard_cap_minutes')) then
    raise exception 'work_claim_merge_slot_touch_input_invalid' using errcode='22023'; end if;
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_scope);
  if not clued_private.binding_role_admits_v1(v_binding,'ci-admission') then
    return jsonb_build_object('status','ok','touched',false,'reason','admission_binding_required');
  end if;
  if v_pr is null or v_pr !~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[0-9]{1,10}$' then
    raise exception 'work_claim_pr_ref_invalid' using errcode='22023'; end if;
  if v_head is null or v_head !~ '^[0-9a-f]{7,64}$' then
    raise exception 'work_claim_head_sha_invalid' using errcode='22023'; end if;
  if v_state is null or v_state not in ('running','green','failed') then
    raise exception 'work_claim_merge_slot_ci_state_invalid' using errcode='22023'; end if;
  if v_state<>'failed' or p_input ? 'hard_cap_minutes' then
    if jsonb_typeof(p_input->'hard_cap_minutes') is distinct from 'number'
        or (p_input->>'hard_cap_minutes') !~ '^[0-9]{2,3}$'
        or (p_input->>'hard_cap_minutes')::integer not between 60 and 180 then
      raise exception 'work_claim_merge_slot_hard_cap_invalid' using errcode='22023'; end if;
    v_cap:=(p_input->>'hard_cap_minutes')::integer*60;
  end if;
  perform clued_private.work_claim_lock(v_binding.user_id);
  if v_state='failed' then
    v_returned:=clued_private.work_claim_merge_slot_return_core_v1(v_binding.user_id,v_binding.id,v_scope,v_pr,
      'ci_failed',jsonb_build_object('head_sha',v_head));
    return jsonb_build_object('status','ok','ci_state',v_state,'pr_ref',v_pr,'head_sha',v_head,
      'returned',cardinality(v_returned)>0,'merge_slot_returned',to_jsonb(v_returned));
  end if;
  -- Only the slots of the pull request's own repository: merge:<owner>/<name>:<branch>.
  v_prefix:='merge:'||lower(split_part(v_pr,'#',1))||':';
  for c in select * from clued_private.work_claims_v1 w
    where w.user_id=v_binding.user_id and w.context_key=v_scope and w.bound_pr=v_pr
      and w.status in ('ACTIVE','DRAINING')
      and exists(select 1 from unnest(w.trigger_refs) t where left(lower(t),length(v_prefix))=v_prefix)
    order by w.issued_at for update loop
    continue when not clued_private.work_claim_merge_slot_live_v1(c);
    if c.merge_slot_ci_state is distinct from v_state or c.merge_slot_ci_head is distinct from v_head
        or c.merge_slot_hard_cap_seconds is distinct from v_cap then
      insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,
        object_type,object_id,version,metadata)
      values(c.user_id,v_binding.id,c.context_key,'work_claim_merge_slot_touch','work_claim',
        c.claim_id::text,c.fence,jsonb_build_object('receipt_kind','WORK_CLAIM_MERGE_SLOT_TOUCHED',
          'claim_id',c.claim_id,'task_id',c.task_id,'fence',c.fence,'bound_pr',v_pr,
          'ci_state',v_state,'head_sha',v_head,'hard_cap_seconds',v_cap,
          'previous_ci_state',c.merge_slot_ci_state));
    end if;
    -- A green head's 30 minutes count from its first green report.
    update clued_private.work_claims_v1
      set merge_slot_ci_state=v_state,merge_slot_ci_head=v_head,
        merge_slot_ci_at=case when c.merge_slot_ci_state='green' and v_state='green' and c.merge_slot_ci_head=v_head
          then c.merge_slot_ci_at else v_now end,
        merge_slot_hard_cap_seconds=v_cap,updated_at=v_now
      where claim_id=c.claim_id returning * into c;
    v_touched:=v_touched||c.claim_id;
    v_until:=greatest(v_until,clued_private.work_claim_merge_slot_until_v1(c));
  end loop;
  return jsonb_build_object('status','ok','ci_state',v_state,'pr_ref',v_pr,'head_sha',v_head,
    'touched',cardinality(v_touched)>0,'claims',to_jsonb(v_touched),'merge_slot_until',v_until)
    ||case when cardinality(v_touched)=0 then jsonb_build_object('reason','no_live_slot_for_pr') else '{}'::jsonb end;
end $$;

-- The live merge slots of one repository in one scope. Input {scope,
-- repository}; only the CI admission Binding. Read-only.
create function public.clued_work_merge_slot_holders_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global'); v_repo text:=nullif(btrim(coalesce(p_input->>'repository','')),'');
  v_prefix text;
begin
  if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('scope','repository')) then
    raise exception 'work_claim_merge_slot_holders_input_invalid' using errcode='22023'; end if;
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_scope);
  if not clued_private.binding_role_admits_v1(v_binding,'ci-admission') then
    return jsonb_build_object('status','ok','holders','[]'::jsonb,'reason','admission_binding_required');
  end if;
  if v_repo is null or v_repo !~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$' then
    raise exception 'work_claim_repository_invalid' using errcode='22023'; end if;
  v_prefix:='merge:'||lower(v_repo)||':';
  return jsonb_build_object('status','ok','repository',v_repo,'holders',coalesce((
    select jsonb_agg(jsonb_build_object('claim_id',w.claim_id,'bound_pr',w.bound_pr,
        'merge_refs',(select to_jsonb(coalesce(array_agg(t order by t),'{}'::text[])) from unnest(w.trigger_refs) t
          where left(lower(t),length(v_prefix))=v_prefix),
        'merge_slot_until',clued_private.work_claim_merge_slot_until_v1(w),
        'merge_slot_ci',clued_private.work_claim_merge_slot_ci_view_v1(w))
      order by w.issued_at)
    from clued_private.work_claims_v1 w
    where w.user_id=v_binding.user_id and w.context_key=v_scope and w.status in ('ACTIVE','DRAINING')
      and exists(select 1 from unnest(w.trigger_refs) t where left(lower(t),length(v_prefix))=v_prefix)
      and clued_private.work_claim_merge_slot_live_v1(w)),'[]'::jsonb));
end $$;

-- clued_work_verify_v1: 20261003200000 plus admission_mode (§10).
create or replace function public.clued_work_verify_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; c clued_private.work_claims_v1%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global'); v_reasons jsonb:='[]'::jsonb;
  v_now timestamptz:=pg_catalog.clock_timestamp(); v_max_fence bigint; v_paths text[];
  v_outside text[]:='{}'::text[]; v_p text; v_pr text:=nullif(btrim(coalesce(p_input->>'pr_ref','')),'');
  v_head text:=lower(nullif(btrim(coalesce(p_input->>'head_sha','')),''));
  v_cap integer:=(clued_private.work_claim_profile_v1()->>'github_ci_heads_per_task_24h')::integer;
  v_used integer; v_retry timestamptz; v_dispatch boolean:=false; v_mode jsonb;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_scope);
  if p_input ? 'ci_dispatch' then
    if jsonb_typeof(p_input->'ci_dispatch') is distinct from 'boolean' then
      raise exception 'work_claim_ci_dispatch_invalid' using errcode='22023'; end if;
    v_dispatch:=(p_input->>'ci_dispatch')::boolean;
  end if;
  if v_dispatch and (p_input ? 'pr_ref' or v_head is null) then
    raise exception 'work_claim_ci_dispatch_invalid' using errcode='22023'; end if;
  -- Merge Admission v0.1 §10: the mode the admission check judged the head in.
  if p_input ? 'admission_mode' then
    v_mode:=p_input->'admission_mode';
    if jsonb_typeof(v_mode) is distinct from 'object'
        or exists(select 1 from jsonb_object_keys(v_mode) k where k not in ('state','layer','reruns_per_head'))
        or coalesce(v_mode->>'state','') not in ('normal','efficiency','frozen')
        or coalesce(v_mode->>'layer','') not in ('protected','code','docs')
        or (v_mode ? 'reruns_per_head' and (jsonb_typeof(v_mode->'reruns_per_head') is distinct from 'number'
          or (v_mode->>'reruns_per_head') !~ '^[0-3]$')) then
      raise exception 'work_claim_admission_mode_invalid' using errcode='22023'; end if;
  end if;
  -- Decision 38ddb8cf: binding a claim to a pull request, metering a head and
  -- admitting a hand dispatch are the GitHub door's acts, so only the Owner's
  -- CI admission Binding may do them once the Owner has marked one
  -- (binding_roles_v1). Any Binding may still verify read-only.
  if (v_pr is not null or v_dispatch)
      and not clued_private.binding_role_admits_v1(v_binding,'ci-admission') then
    return jsonb_build_object('status','ok','verdict','REJECTED','verified_at',v_now,
      'reasons',jsonb_build_array('admission_binding_required'));
  end if;
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
  -- GitHub CI per Task (§10.4): a head is counted once, the first time any
  -- claim of the Task admits it; the count is the Task's heads in the last
  -- 24 hours. A per-Task lock keeps two verifies from both taking the last
  -- place; nothing else takes it, so it cannot deadlock with the row lock.
  if (v_pr is not null or v_dispatch) and v_head is not null and jsonb_array_length(v_reasons)=0 then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'clued-work-claim-ci:'||c.user_id::text||':'||c.task_id::text,0));
    if not exists(select 1 from clued_private.work_claim_door_usage_v1 u
        where u.user_id=c.user_id and u.door='github-ci' and u.task_id=c.task_id and u.unit_key=v_head) then
      select count(*),min(u.used_at) into v_used,v_retry from clued_private.work_claim_door_usage_v1 u
        where u.user_id=c.user_id and u.door='github-ci' and u.task_id=c.task_id
          and u.used_at>v_now-interval '24 hours';
      if v_used>=v_cap then
        v_reasons:=v_reasons||to_jsonb('task_ci_head_cap_reached'::text);
        v_retry:=v_retry+interval '24 hours';
      else
        insert into clued_private.work_claim_door_usage_v1(user_id,door,task_id,binding_id,claim_id,unit_key,used_at)
        values(c.user_id,'github-ci',c.task_id,v_binding.id,c.claim_id,v_head,v_now);
        v_retry:=null;
      end if;
    else
      v_retry:=null;
    end if;
    if v_pr is not null and jsonb_array_length(v_reasons)=0 and not (v_head=any(c.admitted_heads)) then
      update clued_private.work_claims_v1 set admitted_heads=admitted_heads||v_head,updated_at=v_now
        where claim_id=c.claim_id returning * into c;
      -- §10: each pull request head is admitted once; its Receipt names the mode.
      insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,
        object_type,object_id,version,metadata)
      values(c.user_id,v_binding.id,c.context_key,'work_claim_admit_head','work_claim',
        c.claim_id::text,c.fence,jsonb_build_object('receipt_kind','WORK_CLAIM_HEAD_ADMITTED',
          'claim_id',c.claim_id,'task_id',c.task_id,'fence',c.fence,'pr_ref',v_pr,
          'head_sha',v_head,'base_sha',p_input->>'base_sha','admission_mode',v_mode));
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
        'head_sha',p_input->>'head_sha','base_sha',p_input->>'base_sha')
        ||case when v_mode is null then '{}'::jsonb else jsonb_build_object('admission_mode',v_mode) end);
  end if;
  select count(*) into v_used from clued_private.work_claim_door_usage_v1 u
    where u.user_id=c.user_id and u.door='github-ci' and u.task_id=c.task_id
      and u.used_at>v_now-interval '24 hours';
  return jsonb_build_object('status','ok',
    'verdict',case when jsonb_array_length(v_reasons)=0 then 'ADMITTED' else 'REJECTED' end,
    'verified_at',v_now,'reasons',v_reasons,'paths_outside_write_set',to_jsonb(v_outside),
    'current_fence',v_max_fence,'head_sha',p_input->>'head_sha','base_sha',p_input->>'base_sha',
    'pr_ref',v_pr,'bound_pr',c.bound_pr,'admitted_heads',cardinality(c.admitted_heads),
    'task_ci_heads_24h',v_used,'task_ci_head_cap',v_cap,'ci_retry_after',v_retry,
    'claim',clued_private.work_claim_view(c))
    ||case when v_mode is null then '{}'::jsonb else jsonb_build_object('admission_mode',v_mode) end;
end $$;

revoke all on function
  clued_private.work_claim_merge_slot_ci_view_v1(clued_private.work_claims_v1)
  from public,anon,authenticated,service_role;
revoke all on function
  public.clued_work_merge_slot_touch_v1(text,jsonb),
  public.clued_work_merge_slot_holders_v1(text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function
  public.clued_work_merge_slot_touch_v1(text,jsonb),
  public.clued_work_merge_slot_holders_v1(text,jsonb)
  to anon;

notify pgrst,'reload schema';
