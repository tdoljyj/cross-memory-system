-- The v2 Native dispatcher owns lease, Source and scope authorization and the
-- one-unresolved-effect slot. These private helpers persist the verified outcome
-- of that slot and finish the exact claim generation recorded in it.
create table clued_private.ci_train_landing_receipts_v2 (
  receipt_id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  binding_id uuid not null references public.clued_agent_bindings(id),
  context_key text not null,
  repository text not null,
  effect_id text not null check (effect_id ~ '^[0-9a-f]{64}$'),
  intent jsonb not null,
  result jsonb not null,
  recorded_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (user_id, effect_id)
);

create table clued_private.ci_train_member_receipts_v2 (
  receipt_id uuid primary key default extensions.gen_random_uuid(),
  landing_receipt_id uuid not null references clued_private.ci_train_landing_receipts_v2(receipt_id),
  binding_id uuid not null references public.clued_agent_bindings(id),
  pr_number bigint not null,
  result jsonb not null,
  recorded_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (landing_receipt_id, pr_number)
);

alter table clued_private.ci_train_landing_receipts_v2 enable row level security;
alter table clued_private.ci_train_member_receipts_v2 enable row level security;
revoke all on clued_private.ci_train_landing_receipts_v2, clued_private.ci_train_member_receipts_v2
  from public, anon, authenticated, service_role, clued_worker_gateway;

create index ci_train_adopt_admission_pr_v2 on clued_private.work_claim_execution_admissions_v1
  (user_id, repository, target_branch, lower(pr_ref), created_at desc) where pr_ref is not null;
create index ci_train_adopt_authorized_pr_v2 on clued_private.work_claim_head_authorizations_v1
  (user_id, repository, target_branch, lower(pr_ref), issued_at desc) where revoked_at is null and pr_ref is not null;

-- Call only after trusted GitHub read-back, in the same transaction that
-- settles the authorized effect. An unrecognized marker keeps the slot open.
create function clued_private.ci_train_record_landing_v2(
  b public.clued_agent_bindings, p_scope text, p_repository text, p_intent jsonb, p_result jsonb
) returns uuid language plpgsql volatile set search_path='' as $$
declare
  r clued_private.ci_train_landing_receipts_v2;
  m jsonb;
  state text := p_result->>'state';
  marker text := p_result->>'generationRefOid';
  expected_marker text;
  effect text := p_intent->>'effectId';
begin
  if state = 'landed' then expected_marker := p_intent->>'landedRefOid';
  elsif state = 'revoked' then expected_marker := p_intent->>'invalidatedRefOid';
  else raise exception 'ci_effect_unknown' using errcode='22023';
  end if;
  if b.user_id is null or nullif(p_scope,'') is null
    or coalesce(p_repository,'') !~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$'
    or coalesce(effect,'') !~ '^[0-9a-f]{64}$'
    or coalesce(p_intent->>'batchId','') !~ '^[0-9a-f]{64}$'
    or coalesce(p_intent->>'slotId','') !~ '^[0-9a-f]{64}$'
    or coalesce(p_intent->>'generation','') !~ '^[1-9][0-9]{0,15}$'
    or coalesce(p_intent->>'baseSha','') !~ '^[0-9a-f]{40}$'
    or coalesce(p_intent->>'testSha','') !~ '^[0-9a-f]{40}$'
    or coalesce(p_intent->>'generationRefOid','') !~ '^[0-9a-f]{40}$'
    or coalesce(p_intent->>'landedRefOid','') !~ '^[0-9a-f]{40}$'
    or coalesce(p_result->>'mainSha','') !~ '^[0-9a-f]{40}$'
    or coalesce(marker,'') !~ '^[0-9a-f]{40}$'
    or repeat('0',40) in (p_intent->>'baseSha', p_intent->>'testSha', p_intent->>'generationRefOid', p_intent->>'landedRefOid', p_result->>'mainSha')
    or p_intent->>'baseSha' = p_intent->>'testSha'
    or p_intent->>'generationRefOid' = p_intent->>'landedRefOid'
    or marker is distinct from expected_marker or marker = repeat('0',40) or marker = p_intent->>'generationRefOid'
    or (state = 'revoked' and marker = p_intent->>'landedRefOid')
    or (state = 'landed' and p_result->>'mainSha' = p_intent->>'baseSha')
    or jsonb_typeof(p_intent->'members') is distinct from 'array' then
    raise exception 'ci_landing_ref_mismatch' using errcode='22023';
  end if;
  if jsonb_array_length(p_intent->'members') not between 1 and 4 or
    (select count(distinct x->>'pr') from jsonb_array_elements(p_intent->'members') x) <> jsonb_array_length(p_intent->'members') then
    raise exception 'ci_landing_ref_mismatch' using errcode='22023';
  end if;
  for m in select x from jsonb_array_elements(p_intent->'members') x loop
    if jsonb_typeof(m) is distinct from 'object' then
      raise exception 'ci_landing_ref_mismatch' using errcode='22023';
    end if;
    if m - array['pr','headSha','claimId','fence','epoch'] <> '{}'::jsonb
      or jsonb_typeof(m->'pr') is distinct from 'number'
      or jsonb_typeof(m->'fence') is distinct from 'number'
      or jsonb_typeof(m->'epoch') is distinct from 'number'
      or coalesce(m->>'pr','') !~ '^[1-9][0-9]{0,9}$'
      or coalesce(m->>'headSha','') !~ '^[0-9a-f]{40}$'
      or m->>'headSha'=repeat('0',40)
      or coalesce(m->>'claimId','') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      or coalesce(m->>'fence','') !~ '^[1-9][0-9]{0,15}$'
      or coalesce(m->>'epoch','') !~ '^[1-9][0-9]{0,15}$' then
      raise exception 'ci_landing_ref_mismatch' using errcode='22023';
    end if;
  end loop;

  insert into clued_private.ci_train_landing_receipts_v2
    (user_id, binding_id, context_key, repository, effect_id, intent, result)
    values (b.user_id, b.id, p_scope, p_repository, effect, p_intent, p_result)
    on conflict (user_id, effect_id) do nothing;
  select * into strict r from clued_private.ci_train_landing_receipts_v2
    where user_id=b.user_id and effect_id=effect;
  -- The observed main may advance after the first receipt. Replay preserves that receipt.
  if r.context_key<>p_scope or r.repository<>p_repository or (r.intent-'invalidatedRefOid')<>(p_intent-'invalidatedRefOid')
    or r.result->>'state' is distinct from state or r.result->>'generationRefOid' is distinct from marker then
    raise exception 'ci_landing_ref_mismatch' using errcode='22023';
  end if;
  return r.receipt_id;
end $$;

create function clued_private.ci_train_adopt_member_v2(
  b public.clued_agent_bindings, p_scope text, p_receipt uuid, p_effect text, p_member jsonb, p_observed_head text
) returns jsonb language plpgsql volatile set search_path='' as $$
declare
  r clued_private.ci_train_landing_receipts_v2;
  c clued_private.work_claims_v1;
  t clued_private.work_claim_pr_task_bindings_v1;
  pr bigint;
  claim uuid;
  v_pr_ref text;
  merge_ref text;
  latest_head text;
  latest_claim uuid;
  authorized_head text;
  served_at timestamptz;
  state text := 'claim_changed';
  old_result jsonb;
  copy_result jsonb;
  binding_receipt uuid;
  member_receipt uuid := extensions.gen_random_uuid();
  result jsonb;
begin
  perform clued_private.work_claim_lock(b.user_id);
  select * into r from clued_private.ci_train_landing_receipts_v2
    where receipt_id=p_receipt and user_id=b.user_id and context_key=p_scope and effect_id=p_effect for update;
  if not found or r.result->>'state' is distinct from 'landed'
    or not exists (select 1 from jsonb_array_elements(r.intent->'members') m where m=p_member)
    or coalesce(p_observed_head,'') !~ '^[0-9a-f]{40}$' or p_observed_head=repeat('0',40) then
    raise exception 'ci_landing_ref_mismatch' using errcode='22023';
  end if;
  pr := (p_member->>'pr')::bigint;
  claim := (p_member->>'claimId')::uuid;
  v_pr_ref := r.repository||'#'||pr::text;
  merge_ref := 'merge:'||r.repository||':main';
  select a.result into old_result from clued_private.ci_train_member_receipts_v2 a
    where a.landing_receipt_id=p_receipt and a.pr_number=pr;
  if found then
    if old_result->'member' is distinct from p_member then
      raise exception 'ci_landing_ref_mismatch' using errcode='22023';
    end if;
    return old_result;
  end if;
  if (r.intent->'members'->0->>'pr')::bigint=pr and exists (
    select 1 from jsonb_array_elements(r.intent->'members') m
    where (m->>'pr')::bigint<>pr and not exists (select 1 from clued_private.ci_train_member_receipts_v2 a
      where a.landing_receipt_id=p_receipt and a.pr_number=(m->>'pr')::bigint)
  ) then raise exception 'ci_effect_unknown' using errcode='22023'; end if;

  select * into c from clued_private.work_claims_v1 w
    where w.user_id=b.user_id and w.context_key=p_scope and w.claim_id=claim for update;
  select * into t from clued_private.work_claim_pr_task_bindings_v1 w
    where w.user_id=b.user_id and w.repo_id=r.repository and w.pr_number=pr for update;
  -- Find the newest admission or still-valid authorization for this exact PR, even
  -- when it belongs to another claim. An intervening head must keep its authority.
  select x.head_sha, x.claim_id into latest_head, latest_claim from (
    select a.head_sha, a.claim_id, a.created_at as observed_at from clued_private.work_claim_execution_admissions_v1 a
      where a.user_id=b.user_id and lower(a.pr_ref)=v_pr_ref and a.repository=r.repository and a.target_branch='main'
    union all
    select a.head_sha, a.claim_id, a.issued_at as observed_at from clued_private.work_claim_head_authorizations_v1 a
      where a.user_id=b.user_id and lower(a.pr_ref)=v_pr_ref and a.repository=r.repository and a.target_branch='main' and a.revoked_at is null
  ) x order by x.observed_at desc, (x.claim_id=claim and x.head_sha=p_observed_head) asc limit 1;
  -- A late admission for H1 must not hide the current generation's newer
  -- live head authorization for the same PR. Compare within authorizations.
  select a.head_sha into authorized_head from clued_private.work_claim_head_authorizations_v1 a
    where a.user_id=c.user_id and a.claim_id=claim and a.execution_epoch=c.execution_epoch
      and lower(a.pr_ref)=v_pr_ref and a.repository=r.repository and a.target_branch='main' and a.revoked_at is null
    order by a.issued_at desc, (a.head_sha=p_observed_head) asc limit 1;
  if c.status in ('ACTIVE','DRAINING') and c.fence=(p_member->>'fence')::bigint and c.execution_epoch=(p_member->>'epoch')::bigint
    and c.task_id=t.task_id and latest_claim=claim and latest_head=p_member->>'headSha' and p_observed_head=p_member->>'headSha'
    and (authorized_head is null or authorized_head=p_observed_head)
    and exists (select 1 from clued_private.work_claim_execution_admissions_v1 a
      where a.user_id=b.user_id and a.claim_id=claim and a.execution_epoch=c.execution_epoch
        and a.repository=r.repository and a.target_branch='main' and lower(a.pr_ref)=v_pr_ref and a.head_sha=p_observed_head)
  then
    copy_result := clued_private.work_claim_adopt_core_v1(c,b.id,'github',
      jsonb_build_object('pr_ref',v_pr_ref,'merge_sha',r.intent->>'testSha','landing_receipt_id',p_receipt));
    if copy_result->>'status' is distinct from 'ok' then
      raise exception 'ci_work_lease_stale' using errcode='22023';
    end if;
    binding_receipt := clued_private.work_claim_pr_finish_before_lease_pin_v1(b,p_scope,v_pr_ref,'merged','adopt');
    served_at := clued_private.work_claim_pr_served_at_v1(c,v_pr_ref);
    if not exists (select 1 from clued_private.work_claim_pr_task_bindings_v1 other
      where other.user_id=c.user_id and other.task_id=c.task_id and (other.repo_id,other.pr_number)<>(r.repository,pr)
        and clued_private.work_claim_pr_binding_open_v1(other.status)
        and clued_private.work_claim_pr_served_at_v1(c,other.repo_id||'#'||other.pr_number) is not null)
      and not exists (select 1 from clued_private.work_claim_head_authorizations_v1 a
        where a.user_id=c.user_id and a.claim_id=claim and a.revoked_at is null and a.issued_at>served_at
          and lower(a.pr_ref) is distinct from v_pr_ref) then
      update clued_private.work_claims_v1 w set
        status='RELEASED', released_outcome='completed', lease_key_hash=null, released_by='pr_end',
        released_evidence_ref=v_pr_ref||'@'||(r.intent->>'testSha'), updated_at=pg_catalog.clock_timestamp(),
        trigger_refs=array(select x from unnest(w.trigger_refs) x where lower(x)<>merge_ref order by x)
        where w.claim_id=claim and w.fence=c.fence and w.execution_epoch=c.execution_epoch returning * into strict c;
      insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
        values(c.user_id,c.holder_binding_id,c.context_key,'work_claim_release','work_claim',claim::text,c.fence,
          jsonb_build_object('receipt_kind','WORK_CLAIM_RELEASED','claim_id',claim,'task_id',c.task_id,'fence',c.fence,
            'outcome','completed','evidence_ref',v_pr_ref,'status','RELEASED','released_by_binding_id',b.id,
            'released_by',c.released_by,'released_evidence_ref',c.released_evidence_ref,'released_at',c.released_at,
            'landing_receipt_id',p_receipt));
      perform clued_private.work_claim_merge_front_sync_v1(b.user_id,merge_ref);
    end if;
    state := 'adopted';
  end if;

  result := jsonb_build_object('state',state,'member',p_member,'receiptId',member_receipt,'bindingReceiptId',binding_receipt);
  insert into clued_private.ci_train_member_receipts_v2(receipt_id,landing_receipt_id,binding_id,pr_number,result)
    values (member_receipt,p_receipt,b.id,pr,result);
  return result;
end $$;

revoke all on function clued_private.ci_train_record_landing_v2(public.clued_agent_bindings,text,text,jsonb,jsonb),
  clued_private.ci_train_adopt_member_v2(public.clued_agent_bindings,text,uuid,text,jsonb,text)
  from public, anon, authenticated, service_role, clued_worker_gateway;
