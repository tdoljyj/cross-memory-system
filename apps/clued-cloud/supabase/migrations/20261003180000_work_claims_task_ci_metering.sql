-- Generic Work Claim v0.1, §10.4 and §10.7 step 2: GitHub CI metered per Task
-- (Task bb9f1e36, Decision 136a000e item 2).
--
-- The GitHub door (clued_work_verify_v1 with pr_ref and head_sha) admits at
-- most github_ci_heads_per_task_24h distinct pull-request heads per Task in
-- any 24 hours, across all of the Task's claims and race copies. This
-- replaces the per-claim cap max_heads_per_claim (20): splitting work into
-- more claims no longer buys more CI. Verifying a head again (a re-run, the
-- hourly re-verify) is not counted again. Each admitted head is one row of
-- work_claim_door_usage_v1, with its time, so the window slides.
-- A refusal names task_ci_head_cap_reached and when the oldest counted head
-- leaves the window (ci_retry_after).
--
-- Also (Task 6414f530): the legacy exemption status no longer reads
-- max_claims_per_task_24h, which the token-bucket migration removed from the
-- profile. Every legacy exemption has expired; no new one can be issued.

create table clued_private.work_claim_door_usage_v1 (
  user_id uuid not null references auth.users(id) on delete cascade,
  door text not null check (door ~ '^[a-z][a-z0-9-]{1,31}$'),
  task_id uuid not null,
  binding_id uuid not null,
  claim_id uuid not null,
  unit_key text not null check (length(unit_key) between 1 and 200),
  used_at timestamptz not null,
  primary key (user_id,door,task_id,unit_key)
);
create index work_claim_door_usage_v1_window
  on clued_private.work_claim_door_usage_v1(user_id,door,task_id,used_at);
alter table clued_private.work_claim_door_usage_v1 enable row level security;
revoke all on table clued_private.work_claim_door_usage_v1 from public,anon,authenticated,service_role;

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
    'github_ci_heads_per_task_24h',40)
$$;

-- Same as 20261003120000 except the head cap, now per Task in 24 hours.
create or replace function public.clued_work_verify_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; c clued_private.work_claims_v1%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global'); v_reasons jsonb:='[]'::jsonb;
  v_now timestamptz:=pg_catalog.clock_timestamp(); v_max_fence bigint; v_paths text[];
  v_outside text[]:='{}'::text[]; v_p text; v_pr text:=nullif(btrim(coalesce(p_input->>'pr_ref','')),'');
  v_head text:=lower(nullif(btrim(coalesce(p_input->>'head_sha','')),''));
  v_cap integer:=(clued_private.work_claim_profile_v1()->>'github_ci_heads_per_task_24h')::integer;
  v_used integer; v_retry timestamptz;
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
  -- GitHub CI per Task (§10.4): a head is counted once, the first time any
  -- claim of the Task admits it; the count is the Task's heads in the last
  -- 24 hours. A per-Task lock keeps two verifies from both taking the last
  -- place; nothing else takes it, so it cannot deadlock with the row lock.
  if v_pr is not null and v_head is not null and jsonb_array_length(v_reasons)=0 then
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
    if jsonb_array_length(v_reasons)=0 and not (v_head=any(c.admitted_heads)) then
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
  select count(*) into v_used from clued_private.work_claim_door_usage_v1 u
    where u.user_id=c.user_id and u.door='github-ci' and u.task_id=c.task_id
      and u.used_at>v_now-interval '24 hours';
  return jsonb_build_object('status','ok',
    'verdict',case when jsonb_array_length(v_reasons)=0 then 'ADMITTED' else 'REJECTED' end,
    'verified_at',v_now,'reasons',v_reasons,'paths_outside_write_set',to_jsonb(v_outside),
    'current_fence',v_max_fence,'head_sha',p_input->>'head_sha','base_sha',p_input->>'base_sha',
    'pr_ref',v_pr,'bound_pr',c.bound_pr,'admitted_heads',cardinality(c.admitted_heads),
    'task_ci_heads_24h',v_used,'task_ci_head_cap',v_cap,'ci_retry_after',v_retry,
    'claim',clued_private.work_claim_view(c));
end $$;

-- Task 6414f530: without the removed max_claims_per_task_24h.
create or replace function clued_private.work_claim_exemption_status_v1(p_user_id uuid,p_task_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'claims_last_24h',(select count(*) from clued_private.work_claims_v1 w
      where w.user_id=p_user_id and w.task_id=p_task_id and w.issued_at>clock_timestamp()-interval '24 hours'),
    'active_exemptions',coalesce((select jsonb_agg(jsonb_build_object('exemption_id',e.id,
        'granted_at',e.granted_at,'expires_at',e.expires_at,'extra_claims',e.extra_claims,
        'used',(select count(*) from clued_private.work_claims_v1 w
          where w.user_id=e.user_id and w.task_id=e.task_id and w.issued_at>=e.granted_at))
      order by e.granted_at)
      from clued_private.work_claim_exemptions_v1 e
      where e.user_id=p_user_id and e.task_id=p_task_id and e.expires_at>clock_timestamp()),'[]'::jsonb))
$$;

notify pgrst,'reload schema';
