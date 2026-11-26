-- Merge train protocol 2 (slice 1). No policy is enabled by this migration.
-- Reuse the node command's signature, nonce ledger, account/pool locks and ACL.
-- The narrow leases below are for control work that has no executable CI job yet.

create table clued_private.ci_train_work_v2 (
  work_key text primary key check (work_key ~ '^[0-9a-f]{64}$'),
  user_id uuid not null,
  project_id uuid not null,
  repository_id bigint not null,
  target_branch text not null,
  action text not null,
  pr bigint not null check (pr>0),
  head_sha text not null check (head_sha ~ '^[0-9a-f]{40}$'),
  claim_id uuid not null,
  claim_fence bigint not null,
  execution_epoch bigint not null,
  source_manifest_sha256 text not null,
  policy_version text not null,
  node_id uuid not null,
  binding_id uuid not null,
  binding_generation bigint not null,
  key_version bigint not null,
  generation bigint not null default 1 check (generation>0),
  lease_version bigint not null default 1 check (lease_version>0),
  expires_at timestamptz not null,
  deadline_at timestamptz not null,
  renewed_at timestamptz,
  state text not null default 'leased' check (state in ('leased','released','completed')),
  admission jsonb,
  progress_version bigint not null default 0,
  renewed_progress_version bigint not null default 0 check (renewed_progress_version<=progress_version),
  receipt_id uuid not null references public.clued_audit_receipts(id),
  unique (user_id,project_id,repository_id,target_branch,pr,head_sha,action),
  foreign key (user_id,project_id,node_id) references clued_private.ci_nodes_v1(user_id,project_id,node_id),
  check (expires_at<=deadline_at)
);
create index ci_train_work_v2_capacity on clued_private.ci_train_work_v2(node_id,expires_at)
  where state='leased';

create table clued_private.ci_train_check_effects_v2 (
  effect_key text primary key check (effect_key ~ '^[0-9a-f]{64}$'),
  work_key text not null references clued_private.ci_train_work_v2(work_key),
  generation bigint not null,
  claim_id uuid not null,
  claim_fence bigint not null,
  execution_epoch bigint not null,
  state text not null check (state in ('reserved','sent','unknown','settled','revoked')),
  check_target jsonb not null,
  observation jsonb,
  receipt_id uuid not null references public.clued_audit_receipts(id)
);
create unique index ci_train_check_effects_v2_work on clued_private.ci_train_check_effects_v2(work_key);

-- Only the checked dispatcher opens this row, within the same transaction.
-- Old RPC callers cannot supply it, and the row is removed before returning.
create table clued_private.ci_train_call_v2 (
  transaction_id xid8 primary key,
  user_id uuid not null,
  binding_id uuid not null,
  project_id uuid not null,
  action text not null
);

alter table clued_private.ci_train_work_v2 enable row level security;
alter table clued_private.ci_train_check_effects_v2 enable row level security;
alter table clued_private.ci_train_call_v2 enable row level security;
revoke all on clued_private.ci_train_work_v2,clued_private.ci_train_check_effects_v2,clued_private.ci_train_call_v2
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- The key contract hashes compact JSON arrays. Scalars here are strings and
-- integers, with no object key ordering or caller-supplied serialization.
create function clued_private.ci_train_key_json_v2(v jsonb) returns text
language sql immutable set search_path='' as $$
  select case when jsonb_typeof(v)='array' then
    '['||coalesce((select string_agg(clued_private.ci_train_key_json_v2(x),',' order by i)
      from jsonb_array_elements(v) with ordinality a(x,i)),'')||']'
    else v::text end
$$;
create function clued_private.ci_train_key_v2(parts jsonb) returns text
language sql immutable set search_path='' as $$
  select encode(sha256(convert_to(clued_private.ci_train_key_json_v2(
    jsonb_build_array('clued.merge-train/2')||parts),'UTF8')),'hex')
$$;

create function clued_private.ci_train_reject_v2(code text) returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_object('status','rejected','error_code',code)
$$;

create function clued_private.ci_train_work_view_v2(w clued_private.ci_train_work_v2) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('status',w.state,'work_key',w.work_key,'generation',w.generation,
    'lease_version',w.lease_version,'expires_at',w.expires_at,'receipt_id',w.receipt_id)
$$;

create function clued_private.ci_train_call_is_v2(u uuid,b uuid,actions text[]) returns boolean
language sql stable set search_path='' as $$
  select exists(select 1 from clued_private.ci_train_call_v2 c where c.transaction_id=pg_current_xact_id_if_assigned()
    and c.user_id=u and c.binding_id=b and c.action=any(actions))
$$;

create function clued_private.ci_train_route_v2(u uuid,scope text) returns boolean
language sql stable set search_path='' as $$
  select exists(select 1 from clued_private.ci_quota_counters_v1 q where q.user_id=u
    and q.row_kind='pool_policy' and 'project:'||q.project_id=scope and q.policy ? 'merge_train_v2')
$$;

-- Revalidate the holder and exact authorization on every control write.
create function clued_private.ci_train_head_claim_v2(w clued_private.ci_train_work_v2,repo text)
returns timestamptz language plpgsql volatile set search_path='' as $$
declare c clued_private.work_claims_v1; b public.clued_agent_bindings; newest text;
begin
  select * into c from clued_private.work_claims_v1 q where q.user_id=w.user_id
    and q.context_key='project:'||w.project_id and q.claim_id=w.claim_id for share;
  if c.claim_id is null or c.fence<>w.claim_fence or c.execution_epoch<>w.execution_epoch or c.execution_handover_pending
    or not exists(select 1 from clued_private.work_claim_pr_current_v1(w.user_id,c.task_id) q where q.claim_id=c.claim_id)
    or clued_private.work_claim_pr_authorization_v1(c,repo,repo||'#'||w.pr,w.head_sha,w.target_branch) is null
    or exists(select 1 from clued_private.work_claim_pr_task_bindings_v1 q
      where q.user_id=w.user_id and q.repo_id=repo and q.pr_number=w.pr
        and (q.task_id<>c.task_id or q.status in ('closed','merged'))) then return null; end if;
  select * into b from public.clued_agent_bindings where id=c.holder_binding_id and user_id=w.user_id for share;
  if b.id is null or not clued_private.binding_live_v1(b) then return null; end if;
  select a.head_sha into newest from clued_private.work_claim_head_authorizations_v1 a
    where a.user_id=w.user_id and a.claim_id=c.claim_id and a.execution_epoch=c.execution_epoch
      and a.repository=repo and a.target_branch=w.target_branch and lower(a.pr_ref)=repo||'#'||w.pr
      and a.workflow is null and a.revoked_at is null order by a.issued_at desc,a.authorization_id desc limit 1;
  if newest is not null and newest<>w.head_sha then return null; end if;
  perform clued_private.work_claim_task(w.user_id,c.context_key,c.task_id::text);
  return c.expires_at;
end $$;

-- The batch is authoritative across nodes. Its control lease never spans a
-- GitHub CI wait. The partially unique row covers both a forming and a sealed
-- batch until its writes are adjudicated and its members settled.
create table clued_private.ci_train_batches_v2 (
  batch_id text primary key check (batch_id ~ '^[0-9a-f]{64}$'),
  user_id uuid not null,
  project_id uuid not null,
  repository_id bigint not null,
  target_branch text not null,
  base_sha text not null check (base_sha ~ '^[0-9a-f]{40}$'),
  source_manifest_sha256 text not null,
  policy_version text not null,
  members jsonb not null check (jsonb_typeof(members)='array' and jsonb_array_length(members) between 1 and 4),
  state text not null check (state in ('forming','sealed','waiting_checks','landed','completed','invalidated')),
  test_sha text,
  tree_sha text,
  steps jsonb,
  checks_policy_version text,
  parent_batch_id text references clued_private.ci_train_batches_v2(batch_id),
  adoption_receipts jsonb not null default '{}'::jsonb,
  staging_state text check (staging_state in ('reserved','sent','unknown','settled')),
  staging_intent jsonb,
  staging_observation jsonb,
  node_id uuid not null,
  binding_id uuid not null,
  binding_generation bigint not null,
  key_version bigint not null,
  generation bigint not null default 1,
  expires_at timestamptz not null,
  receipt_id uuid not null references public.clued_audit_receipts(id),
  foreign key (user_id,project_id,node_id) references clued_private.ci_nodes_v1(user_id,project_id,node_id)
);
create unique index ci_train_batches_v2_open_target on clued_private.ci_train_batches_v2(user_id,project_id,repository_id,target_branch)
  where state not in ('completed','invalidated');
create index ci_train_batches_v2_capacity on clued_private.ci_train_batches_v2(node_id,expires_at)
  where state not in ('completed','invalidated');

create table clued_private.ci_train_landing_v2 (
  effect_key text primary key check (effect_key ~ '^[0-9a-f]{64}$'),
  landing_slot_key text not null,
  batch_id text not null references clued_private.ci_train_batches_v2(batch_id),
  generation bigint not null,
  state text not null check (state in ('reserved','sent','unknown','settled','revoked')),
  intent jsonb not null,
  successor_ref_oid text not null check (successor_ref_oid ~ '^[0-9a-f]{40}$'),
  evidence_digest text not null check (evidence_digest ~ '^[0-9a-f]{64}$'),
  observation jsonb,
  receipt_id uuid not null references public.clued_audit_receipts(id),
  unique (batch_id,generation),
  unique (landing_slot_key,successor_ref_oid)
);
create unique index ci_train_landing_v2_generation_ref
  on clued_private.ci_train_landing_v2(landing_slot_key,(intent->>'generationRefOid'));
create unique index ci_train_landing_v2_unresolved on clued_private.ci_train_landing_v2(landing_slot_key)
  where state in ('reserved','sent','unknown');
alter table clued_private.ci_train_batches_v2 enable row level security;
alter table clued_private.ci_train_landing_v2 enable row level security;
revoke all on clued_private.ci_train_batches_v2,clued_private.ci_train_landing_v2
  from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.ci_train_batch_view_v2(batch clued_private.ci_train_batches_v2) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('batchId',batch.batch_id,'generation',batch.generation,'baseSha',batch.base_sha,
    'testSha',batch.test_sha,'treeSha',batch.tree_sha,'members',batch.members,'steps',batch.steps,
    'checksPolicyVersion',batch.checks_policy_version,'parentBatchId',batch.parent_batch_id,'state',batch.state,
    'adoptionReceipts',batch.adoption_receipts,
    'stagingState',batch.staging_state,'stagingIntent',batch.staging_intent,
    'stagingObservation',batch.staging_observation,'expiresAt',batch.expires_at,'receipt_id',batch.receipt_id,
    'landingState',(select d.state from clued_private.ci_train_landing_v2 d
      where d.batch_id=batch.batch_id and d.state in ('reserved','sent','unknown','settled')
      order by d.generation desc limit 1))
$$;

create function clued_private.ci_train_batch_key_v2(batch clued_private.ci_train_batches_v2) returns text
language sql immutable set search_path='' as $$
  select clued_private.ci_train_key_v2(jsonb_build_array('batch',batch.user_id,batch.project_id,batch.repository_id,
    batch.target_branch,batch.base_sha,(
      select jsonb_agg(jsonb_build_array(x->'pr',x->'headSha',x->'claimId',x->'fence',x->'epoch') order by i)
      from jsonb_array_elements(batch.members) with ordinality m(x,i)
    ),batch.source_manifest_sha256,batch.policy_version))
$$;

create function clued_private.ci_train_batch_members_v2(batch clued_private.ci_train_batches_v2,repo text,require_queue boolean)
returns timestamptz language plpgsql volatile set search_path='' as $$
declare member jsonb; w clued_private.ci_train_work_v2; expiry timestamptz:='infinity'; next_expiry timestamptz;
  rank bigint; prior_rank bigint:=0; queue jsonb;
begin
  if require_queue then
    queue:=clued_private.work_claim_merge_queue_current_v1(batch.user_id,'merge:'||repo||':'||batch.target_branch)->'entries';
  end if;
  for member in select value from jsonb_array_elements(batch.members) loop
    perform clued_private.ci_input_v1(member,array['pr','headSha','claimId','fence','epoch'],
      array['pr','headSha','claimId','fence','epoch'],2048);
    if coalesce(member->>'headSha','') !~ '^[0-9a-f]{40}$'
      or coalesce(member->>'claimId','') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      or exists(select 1 from unnest(array['pr','fence','epoch']) f where jsonb_typeof(member->f) is distinct from 'number'
        or member->>f !~ '^[1-9][0-9]{0,14}$') then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
    select * into w from clued_private.ci_train_work_v2 q where q.user_id=batch.user_id and q.project_id=batch.project_id
      and q.repository_id=batch.repository_id and q.target_branch=batch.target_branch and q.pr=(member->>'pr')::bigint
      and q.head_sha=member->>'headSha' and q.action='merge_queue_join' and q.state='completed'
      and q.claim_id=(member->>'claimId')::uuid and q.claim_fence=(member->>'fence')::bigint
      and q.execution_epoch=(member->>'epoch')::bigint and q.source_manifest_sha256=batch.source_manifest_sha256
      and q.policy_version=batch.policy_version;
    if w.work_key is null then return null; end if;
    next_expiry:=clued_private.ci_train_head_claim_v2(w,repo);
    if next_expiry is null then return null; end if;
    expiry:=least(expiry,next_expiry);
    if require_queue then
      select i into rank from jsonb_array_elements(queue) with ordinality as entry(e,i)
        where e->>'claim_id'=member->>'claimId' and e->>'state' in ('head','waiting');
      if rank is null or rank<prior_rank or prior_rank=0 and rank<>1 then return null; end if;
      prior_rank:=rank;
    end if;
  end loop;
  return expiry;
end $$;

create function clued_private.ci_train_batch_adopt_v2(n clued_private.ci_nodes_v1,proof text,repo text,
  batch clued_private.ci_train_batches_v2,payload jsonb) returns jsonb language plpgsql volatile set search_path='' as $$
declare
  member jsonb:=payload->'member'; target_pr text; c clued_private.work_claims_v1; current_head text; member_merge_sha text;
  scope text:='project:'||n.project_id; r uuid; pos bigint; answer jsonb; all_receipts jsonb; landed_receipt uuid;
begin
  select i into pos from jsonb_array_elements(batch.members) with ordinality m(x,i) where x=member;
  if not n.publisher_approved or not n.hardening_observed or pos is null or batch.state not in ('landed','completed')
    or coalesce(payload->>'evidence_digest','') !~ '^[0-9a-f]{64}$'
    then return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
  member_merge_sha:=batch.steps->((pos-1)::integer)->>'sha';
  if coalesce(member_merge_sha,'') !~ '^[0-9a-f]{40}$' then
    return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
  select receipt_id into landed_receipt from clued_private.ci_train_landing_v2
    where batch_id=batch.batch_id and state='settled' and effect_key=payload->>'effect_key';
  if landed_receipt is null then return clued_private.ci_train_reject_v2('ci_effect_unknown'); end if;
  if batch.adoption_receipts ? (member->>'pr') then
    return jsonb_build_object('status','committed','replayed',true,'receipt_id',batch.adoption_receipts->(member->>'pr')); end if;
  if pos=1 and jsonb_array_length(batch.members)-1<>(select count(*) from jsonb_object_keys(batch.adoption_receipts)) then
    return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
  target_pr:=repo||'#'||(member->>'pr');
  select * into c from clued_private.work_claims_v1 q where q.user_id=n.user_id and q.context_key=scope
    and q.claim_id=(member->>'claimId')::uuid and q.fence=(member->>'fence')::bigint
    and q.execution_epoch=(member->>'epoch')::bigint for update;
  if c.claim_id is null then return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
  select a.head_sha into current_head from clued_private.work_claim_head_authorizations_v1 a
    where a.user_id=n.user_id and a.claim_id=c.claim_id and a.repository=repo and a.target_branch=batch.target_branch
      and lower(a.pr_ref)=target_pr and a.execution_epoch=c.execution_epoch and a.revoked_at is null
    order by a.issued_at desc,a.authorization_id desc limit 1;
  if current_head is distinct from member->>'headSha' or exists(
    select 1 from clued_private.work_claim_pr_current_v1(n.user_id,c.task_id) q where q.claim_id<>c.claim_id
  ) then return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
  if c.status='ACTIVE' and c.expires_at>clock_timestamp() and not c.execution_handover_pending then
    insert into clued_private.ci_train_call_v2 values (pg_current_xact_id(),n.user_id,n.binding_id,n.project_id,'claim_adopt');
    answer:=public.clued_work_claim_adopt_v1(proof,
      jsonb_build_object('scope',scope,'pr_ref',target_pr,'merge_sha',member_merge_sha));
    delete from clued_private.ci_train_call_v2 where transaction_id=pg_current_xact_id();
    if answer->>'status' is distinct from 'ok' or answer->>'reason'='admission_binding_required' then return answer; end if;
  elsif c.status<>'RELEASED' or c.released_outcome is distinct from 'completed'
    or c.released_evidence_ref is distinct from target_pr||'@'||member_merge_sha then
    return clued_private.ci_train_reject_v2('ci_work_lease_stale');
  end if;
  r:=clued_private.ci_receipt_v1(n.user_id,n.project_id,'ci_train_claim_adopt',batch.batch_id,
    jsonb_build_object('generation',batch.generation,'member',member,'merge_sha',member_merge_sha,'landing_receipt_id',landed_receipt,
      'native',answer,'evidence_digest',payload->>'evidence_digest'));
  all_receipts:=batch.adoption_receipts||jsonb_build_object(member->>'pr',r);
  update clued_private.ci_train_batches_v2 set adoption_receipts=all_receipts,receipt_id=r,
    state=case when pos=1 then 'completed' else batch.state end where batch_id=batch.batch_id;
  return jsonb_build_object('status','committed','receipt_id',r,'replayed',false,'completed',pos=1);
end $$;

create function clued_private.ci_train_batch_command_v2(n clued_private.ci_nodes_v1,proof text,repo_id bigint,repo text,
  cfg jsonb,payload jsonb) returns jsonb language plpgsql volatile set search_path='' as $$
declare
  op text:=payload->>'action'; t timestamptz:=clock_timestamp(); expiry timestamptz;
  batch clued_private.ci_train_batches_v2; candidate clued_private.ci_train_batches_v2;
  landing clued_private.ci_train_landing_v2; r uuid; keys text[];
  subject jsonb; steps jsonb; step jsonb; observation jsonb; member jsonb; i integer;
  prev_sha text; signaled_sha text; k text; slot text; dest text:=payload->>'target_branch';
  reason text:=payload->>'reason'; subject_proof jsonb;
  fields constant text[]:=array['protocol_version','action','repository_id','target_branch','source_manifest_sha256'];
  handle constant text[]:=array['batchId','generation'];
begin
  keys:=case op
    when 'batch_reserve' then array['baseSha','members']
    when 'batch_read' then array['batchId']
    when 'batch_acquire' then array['batchId']
    when 'batch_release' then handle
    when 'batch_seal' then handle||array['testSha','treeSha','steps','checksPolicyVersion']
    when 'batch_bisect' then handle||array['testSha','evidence_digest']
    when 'batch_cleanup' then handle
    when 'staging_prepare' then handle||array['generationRefOid']
    when 'staging_send' then handle
    when 'staging_publish' then handle||array['observation']
    when 'landing_prepare' then handle||array['generationRefOid','successorRefOid','evidence_digest']
    when 'landing_send' then handle||array['effect_key']
    when 'landing_reconcile' then handle||array['effect_key','observation']
    when 'landing_invalidate' then handle||array['effect_key','observation']
    when 'claim_adopt' then handle||array['effect_key','member','evidence_digest']
  end;
  if keys is null then raise exception 'CI_OPERATION_NOT_SERVED' using errcode='42501'; end if;
  perform clued_private.ci_input_v1(payload,fields||keys||
    case when op='batch_cleanup' then array['reason','observedBaseSha','blockedMember','testSha','evidence_digest','hard_cap_minutes']
      else array[]::text[] end,
    fields||case when op='landing_reconcile' then array_remove(keys,'observation') else keys end,32768);
  if op='batch_reserve' then
    candidate.members:=payload->'members'; candidate.base_sha:=payload->>'baseSha';
    if coalesce(candidate.base_sha,'') !~ '^[0-9a-f]{40}$'
      or jsonb_typeof(candidate.members) is distinct from 'array'
      then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
    if jsonb_array_length(candidate.members) not between 1 and coalesce((cfg->>'batch_max')::integer,1)
      or (select count(distinct x->>'pr') from jsonb_array_elements(candidate.members) x)<>jsonb_array_length(candidate.members)
      then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
    candidate.user_id:=n.user_id; candidate.project_id:=n.project_id; candidate.repository_id:=repo_id;
    candidate.target_branch:=dest; candidate.source_manifest_sha256:=cfg->>'source_manifest_sha256';
    candidate.policy_version:=cfg->>'policy_version';
    expiry:=clued_private.ci_train_batch_members_v2(candidate,repo,true);
    if expiry is null then return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
    k:=clued_private.ci_train_batch_key_v2(candidate);
    select * into batch from clued_private.ci_train_batches_v2 d where d.user_id=n.user_id and d.project_id=n.project_id
      and d.repository_id=repo_id and d.target_branch=dest and d.state not in ('completed','invalidated') for update;
    if batch.batch_id is not null then
      return clued_private.ci_train_reject_v2('ci_head_lease_held')||jsonb_build_object('batchId',batch.batch_id,'ci_retry_after',batch.expires_at);
    end if;
    if exists(select 1 from clued_private.ci_train_batches_v2 d where d.batch_id=k) then
      return clued_private.ci_train_reject_v2('ci_head_lease_completed'); end if;
  else
    select * into batch from clued_private.ci_train_batches_v2 d where d.batch_id=payload->>'batchId'
      and d.user_id=n.user_id and d.project_id=n.project_id and d.repository_id=repo_id and d.target_branch=dest
      and d.source_manifest_sha256=cfg->>'source_manifest_sha256' and d.policy_version=cfg->>'policy_version' for update;
    if batch.batch_id is null then return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
    k:=batch.batch_id;
    if op='batch_read' then return clued_private.ci_train_batch_view_v2(batch); end if;
    if batch.state in ('completed','invalidated') and op<>'claim_adopt' then
      return clued_private.ci_train_reject_v2('ci_head_lease_completed'); end if;
    if op='batch_acquire' and batch.expires_at>t then
      return clued_private.ci_train_reject_v2('ci_head_lease_held')||jsonb_build_object('batchId',k,'ci_retry_after',batch.expires_at);
    end if;
    if op<>'batch_acquire' and (payload->'generation' is distinct from to_jsonb(batch.generation)
      or batch.node_id<>n.node_id or batch.binding_id<>n.binding_id or batch.binding_generation<>n.binding_generation
      or batch.key_version<>n.key_version or batch.expires_at<=t) then
      return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
    if op='claim_adopt' then return clued_private.ci_train_batch_adopt_v2(n,proof,repo,batch,payload); end if;
    -- Once sent, reconcile even if the underlying PR has since changed.
    expiry:=clued_private.ci_train_batch_members_v2(batch,repo,op not in ('landing_reconcile','landing_invalidate'));
    if expiry is null and op not in ('batch_acquire','landing_reconcile','landing_invalidate','batch_release','batch_cleanup') then
      return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
  end if;
  if op in ('batch_reserve','batch_acquire') then
    if exists(select 1 from clued_private.ci_train_batches_v2 d where d.node_id=n.node_id and d.batch_id<>k
        and d.state not in ('completed','invalidated') and d.expires_at>t)
      or exists(select 1 from clued_private.ci_train_work_v2 w where w.node_id=n.node_id and w.state='leased' and w.expires_at>t)
      or exists(select 1 from clued_private.ci_job_leases_v1 l where l.holder_node_id=n.node_id and l.state='current' and l.expires_at>t)
      then raise exception 'CI_NODE_CAPACITY_UNAVAILABLE' using errcode='55000'; end if;
    r:=clued_private.ci_receipt_v1(n.user_id,n.project_id,'ci_train_batch_acquire',k,
      jsonb_build_object('generation',coalesce(batch.generation,0)+1,'node_id',n.node_id));
    if op='batch_reserve' then
      insert into clued_private.ci_train_batches_v2(batch_id,user_id,project_id,repository_id,target_branch,base_sha,
        source_manifest_sha256,policy_version,members,state,node_id,binding_id,binding_generation,key_version,expires_at,receipt_id)
      values(k,n.user_id,n.project_id,repo_id,dest,candidate.base_sha,candidate.source_manifest_sha256,candidate.policy_version,
        candidate.members,'forming',n.node_id,n.binding_id,n.binding_generation,n.key_version,
        least(t+interval '90 seconds',expiry,n.qualification_expires_at,n.eligible_until),r) returning * into batch;
    else
      update clued_private.ci_train_batches_v2 set generation=batch.generation+1,node_id=n.node_id,binding_id=n.binding_id,
        binding_generation=n.binding_generation,key_version=n.key_version,
        expires_at=least(t+interval '90 seconds',n.qualification_expires_at,n.eligible_until),receipt_id=r,
        staging_state=case when batch.staging_state='sent' then 'unknown' else batch.staging_state end
        where batch_id=k returning * into batch;
      update clued_private.ci_train_landing_v2 set state='unknown' where batch_id=k and state='sent';
    end if;
  elsif op='batch_release' then
    update clued_private.ci_train_batches_v2 set expires_at=t,
      staging_state=case when batch.staging_state='sent' then 'unknown' else batch.staging_state end
      where batch_id=k returning * into batch;
    update clued_private.ci_train_landing_v2 set state='unknown' where batch_id=k and state='sent';
  elsif op='batch_cleanup' then
    if batch.staging_state in ('sent','unknown') or batch.state not in ('forming','sealed','waiting_checks')
      or exists(select 1 from clued_private.ci_train_landing_v2 d where d.batch_id=k and d.state in ('reserved','sent','unknown','settled'))
      or batch.state='waiting_checks' and (batch.staging_state is distinct from 'settled'
        or coalesce(reason,'') not in ('PR_NOT_OPEN_OR_CHANGED','FRONT_NEEDS_MAIN_MERGE','OWNER_REVIEW_REQUIRED',
          'RESIDENT_BASE_MOVED','TRAIN_LANDING_CHECK_FAILED'))
      or reason='RESIDENT_BASE_MOVED' and (coalesce(payload->>'observedBaseSha','') !~ '^[0-9a-f]{40}$'
        or payload->>'observedBaseSha'=batch.base_sha) then
      return clued_private.ci_train_reject_v2('ci_effect_unknown'); end if;
    if reason in ('FRONT_NEEDS_MAIN_MERGE','OWNER_REVIEW_REQUIRED') then
      member:=payload->'blockedMember';
      if member is null or not batch.members @> jsonb_build_array(member) or expiry is null
        or payload->>'observedBaseSha' is distinct from batch.base_sha
        then return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
      insert into clued_private.ci_train_call_v2 values (pg_current_xact_id(),n.user_id,n.binding_id,n.project_id,'merge_slot_return');
      subject_proof:=public.clued_work_merge_slot_return_v1(proof,jsonb_build_object('scope','project:'||n.project_id,
        'pr_ref',repo||'#'||(member->>'pr')));
      delete from clued_private.ci_train_call_v2 where transaction_id=pg_current_xact_id();
      if subject_proof->>'status' is distinct from 'ok' or subject_proof->>'reason'='admission_binding_required' then
        return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
    elsif reason='TRAIN_LANDING_CHECK_FAILED' then
      member:=batch.members->0;
      if batch.state<>'waiting_checks' or jsonb_array_length(batch.members)<>1 or expiry is null
        or not n.publisher_approved or not n.hardening_observed
        or payload->>'testSha' is distinct from batch.test_sha or payload->>'observedBaseSha' is distinct from batch.base_sha
        or coalesce(payload->>'evidence_digest','') !~ '^[0-9a-f]{64}$'
        or coalesce(payload->>'hard_cap_minutes','') !~ '^[0-9]{2,3}$'
        then return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
      insert into clued_private.ci_train_call_v2 values (pg_current_xact_id(),n.user_id,n.binding_id,n.project_id,'merge_slot_touch');
      subject_proof:=public.clued_work_merge_slot_touch_v1(proof,jsonb_build_object(
        'scope','project:'||n.project_id,'pr_ref',repo||'#'||(member->>'pr'),'head_sha',member->>'headSha',
        'ci_state','failed','hard_cap_minutes',payload->'hard_cap_minutes'));
      delete from clued_private.ci_train_call_v2 where transaction_id=pg_current_xact_id();
      if subject_proof->'touched' is distinct from 'true'::jsonb then
        return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
    end if;
    r:=clued_private.ci_receipt_v1(n.user_id,n.project_id,'ci_train_batch_cleanup',k,
      jsonb_build_object('generation',batch.generation,'state',batch.state,'reason',reason,'testSha',batch.test_sha,
        'blockedMember',payload->'blockedMember','evidence_digest',payload->>'evidence_digest'));
    update clued_private.ci_train_batches_v2 set state='invalidated',expires_at=t,receipt_id=r
      where batch_id=k returning * into batch;
  elsif op='batch_bisect' then
    if batch.state<>'waiting_checks' or batch.staging_state is distinct from 'settled' or not n.publisher_approved or not n.hardening_observed
      or jsonb_array_length(batch.members)<2 or payload->>'testSha' is distinct from batch.test_sha
      or coalesce(payload->>'evidence_digest','') !~ '^[0-9a-f]{64}$'
      or exists(select 1 from clued_private.ci_train_landing_v2 d where d.batch_id=k and d.state in ('reserved','sent','unknown')) then
      return clued_private.ci_train_reject_v2('ci_effect_unknown'); end if;
    candidate:=batch;
    select jsonb_agg(m.member_value order by m.ordinal) into candidate.members
      from jsonb_array_elements(batch.members) with ordinality m(member_value,ordinal)
      where m.ordinal<=(jsonb_array_length(batch.members)+1)/2;
    candidate.batch_id:=clued_private.ci_train_batch_key_v2(candidate);
    if exists(select 1 from clued_private.ci_train_batches_v2 d where d.batch_id=candidate.batch_id)
      then return clued_private.ci_train_reject_v2('ci_head_lease_completed'); end if;
    r:=clued_private.ci_receipt_v1(n.user_id,n.project_id,'ci_train_batch_bisect',k,
      jsonb_build_object('generation',batch.generation,'testSha',batch.test_sha,'prefixBatchId',candidate.batch_id,
        'terminal_failure_evidence_digest',payload->>'evidence_digest'));
    update clued_private.ci_train_batches_v2 set state='invalidated',expires_at=t,receipt_id=r where batch_id=k;
    insert into clued_private.ci_train_batches_v2(batch_id,user_id,project_id,repository_id,target_branch,base_sha,
      source_manifest_sha256,policy_version,members,state,node_id,binding_id,binding_generation,key_version,expires_at,
      parent_batch_id,receipt_id)
    values(candidate.batch_id,n.user_id,n.project_id,repo_id,dest,batch.base_sha,batch.source_manifest_sha256,batch.policy_version,
      candidate.members,'forming',n.node_id,n.binding_id,n.binding_generation,n.key_version,
      least(t+interval '90 seconds',expiry,n.qualification_expires_at,n.eligible_until),k,r) returning * into batch;
  elsif op='batch_seal' then
    steps:=payload->'steps'; signaled_sha:=payload->>'testSha'; prev_sha:=batch.base_sha;
    if batch.state<>'forming' or jsonb_typeof(steps) is distinct from 'array'
      or coalesce(signaled_sha,'') !~ '^[0-9a-f]{40}$' or coalesce(payload->>'treeSha','') !~ '^[0-9a-f]{40}$'
      or payload->>'checksPolicyVersion' is distinct from batch.policy_version
      then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
    if jsonb_array_length(steps)<>jsonb_array_length(batch.members) then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
    for i in 0..jsonb_array_length(steps)-1 loop
      step:=steps->i; member:=batch.members->i;
      perform clued_private.ci_input_v1(step,array['sha','firstParent','secondParent'],array['sha','firstParent','secondParent'],2048);
      if step->>'firstParent' is distinct from prev_sha or step->>'secondParent' is distinct from member->>'headSha'
        or coalesce(step->>'sha','') !~ '^[0-9a-f]{40}$' or step->>'sha' in (prev_sha,member->>'headSha')
        then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
      prev_sha:=step->>'sha';
    end loop;
    if prev_sha<>signaled_sha then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
    r:=clued_private.ci_receipt_v1(n.user_id,n.project_id,'ci_train_batch_seal',k,
      jsonb_build_object('generation',batch.generation,'testSha',signaled_sha,'treeSha',payload->>'treeSha','steps',steps));
    update clued_private.ci_train_batches_v2 set state='sealed',steps=payload->'steps',test_sha=signaled_sha,
      tree_sha=payload->>'treeSha',checks_policy_version=payload->>'checksPolicyVersion',receipt_id=r
      where batch_id=k returning * into batch;
  elsif op in ('staging_prepare','staging_send','staging_publish') then
    if batch.state<>'sealed' or not n.publisher_approved or not n.hardening_observed then
      raise exception 'CI_NODE_NOT_ELIGIBLE' using errcode='42501'; end if;
    if op='staging_prepare' then
      if batch.staging_state in ('sent','unknown','settled') then return clued_private.ci_train_reject_v2('ci_effect_unknown'); end if;
      if coalesce(payload->>'generationRefOid','') !~ '^[0-9a-f]{40}$'
        then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
      subject:=jsonb_build_object('batchId',k,'generation',batch.generation,'baseSha',batch.base_sha,'testSha',batch.test_sha,
        'generationRefOid',payload->>'generationRefOid','members',batch.members,'expiresAt',least(batch.expires_at,expiry));
      r:=clued_private.ci_receipt_v1(n.user_id,n.project_id,'ci_train_staging_prepare',k,subject);
      update clued_private.ci_train_batches_v2 set staging_state='reserved',staging_intent=subject,receipt_id=r
        where batch_id=k returning * into batch;
      return clued_private.ci_train_batch_view_v2(batch);
    elsif op='staging_send' then
      if batch.staging_state is distinct from 'reserved'
        or batch.staging_intent->'generation' is distinct from to_jsonb(batch.generation)
        or (batch.staging_intent->>'expiresAt')::timestamptz<=t then
        return clued_private.ci_train_reject_v2('ci_effect_unknown'); end if;
      r:=clued_private.ci_receipt_v1(n.user_id,n.project_id,'ci_train_staging_send',k,batch.staging_intent);
      update clued_private.ci_train_batches_v2 set staging_state='sent',receipt_id=r where batch_id=k returning * into batch;
      return clued_private.ci_train_batch_view_v2(batch);
    end if;
    observation:=payload->'observation';
    perform clued_private.ci_input_v1(observation,array['testSha','generationRefOid','evidence_digest'],
      array['testSha','generationRefOid','evidence_digest'],4096);
    if batch.staging_state is null or batch.staging_state not in ('sent','unknown')
      or observation->>'testSha' is distinct from batch.test_sha
      or coalesce(observation->>'generationRefOid','') !~ '^[0-9a-f]{40}$'
      or coalesce(observation->>'evidence_digest','') !~ '^[0-9a-f]{64}$'
      then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
    r:=clued_private.ci_receipt_v1(n.user_id,n.project_id,'ci_train_staging_observed',k,
      jsonb_build_object('generation',batch.generation,'observation',observation));
    update clued_private.ci_train_batches_v2 set state='waiting_checks',staging_state='settled',staging_observation=observation,
      expires_at=t,receipt_id=r where batch_id=k returning * into batch;
  else
    if not n.publisher_approved or not n.hardening_observed then raise exception 'CI_NODE_NOT_ELIGIBLE' using errcode='42501'; end if;
    slot:=clued_private.ci_train_key_v2(jsonb_build_array('landing-slot',n.user_id,n.project_id,repo_id,dest));
    select * into landing from clued_private.ci_train_landing_v2 l where l.landing_slot_key=slot and l.batch_id=k
      and (op='landing_prepare' and l.state in ('reserved','sent','unknown')
        or op<>'landing_prepare' and l.effect_key=payload->>'effect_key') for update;
    if op='landing_prepare' then
      if landing.effect_key is not null then return clued_private.ci_train_reject_v2('ci_effect_unknown'); end if;
      if batch.state<>'waiting_checks' or coalesce(payload->>'generationRefOid','') !~ '^[0-9a-f]{40}$'
        or coalesce(payload->>'successorRefOid','') !~ '^[0-9a-f]{40}$'
        or payload->>'generationRefOid'=payload->>'successorRefOid'
        or coalesce(payload->>'evidence_digest','') !~ '^[0-9a-f]{64}$'
        then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
      subject:=jsonb_build_object('batchId',k,'generation',batch.generation,'baseSha',batch.base_sha,'testSha',batch.test_sha,
        'generationRefOid',payload->>'generationRefOid','members',batch.members,'expiresAt',least(batch.expires_at,expiry));
      r:=clued_private.ci_receipt_v1(n.user_id,n.project_id,'ci_train_landing_prepare',k,
        subject||jsonb_build_object('successorRefOid',payload->>'successorRefOid'));
      insert into clued_private.ci_train_landing_v2(effect_key,landing_slot_key,batch_id,generation,state,intent,
        successor_ref_oid,evidence_digest,receipt_id)
      values(clued_private.ci_train_key_v2(jsonb_build_array('effect',n.user_id,n.project_id,repo_id,dest,'landing_prepare',
        jsonb_build_array(k,batch.base_sha,batch.test_sha,payload->>'generationRefOid'))),slot,k,batch.generation,'reserved',subject,
        payload->>'successorRefOid',payload->>'evidence_digest',r) returning * into landing;
    elsif landing.effect_key is null or landing.effect_key is distinct from payload->>'effect_key' then
      return clued_private.ci_train_reject_v2('ci_effect_unknown');
    elsif op='landing_send' then
      if landing.state<>'reserved' or landing.generation<>batch.generation
        or (landing.intent->>'expiresAt')::timestamptz<=t then return clued_private.ci_train_reject_v2('ci_effect_unknown'); end if;
      r:=clued_private.ci_receipt_v1(n.user_id,n.project_id,'ci_train_landing_send',landing.effect_key,landing.intent);
      update clued_private.ci_train_landing_v2 set state='sent',receipt_id=r where effect_key=landing.effect_key returning * into landing;
    elsif landing.state in ('settled','revoked') then
      if payload->'observation' not in ('null'::jsonb,landing.observation) then
        return clued_private.ci_train_reject_v2('ci_landing_ref_mismatch'); end if;
    elsif payload->'observation'<>'null'::jsonb then
      observation:=payload->'observation';
      perform clued_private.ci_input_v1(observation,array['generationRefOid','mainSha','containsTestSha','evidence_digest'],
        array['generationRefOid','mainSha','containsTestSha','evidence_digest'],4096);
      if coalesce(observation->>'generationRefOid','') !~ '^[0-9a-f]{40}$'
        or observation->>'generationRefOid'=landing.intent->>'generationRefOid'
        or coalesce(observation->>'mainSha','') !~ '^[0-9a-f]{40}$'
        or coalesce(observation->>'evidence_digest','') !~ '^[0-9a-f]{64}$'
        or op='landing_reconcile' and (observation->'containsTestSha' is distinct from 'true'::jsonb or landing.state='reserved'
          or observation->>'generationRefOid' is distinct from landing.successor_ref_oid)
        or op='landing_invalidate' and (observation->'containsTestSha' is distinct from 'false'::jsonb
          or observation->>'generationRefOid'=landing.successor_ref_oid)
        then return clued_private.ci_train_reject_v2('ci_landing_ref_mismatch'); end if;
      r:=clued_private.ci_receipt_v1(n.user_id,n.project_id,'ci_train_'||op,landing.effect_key,
        jsonb_build_object('generation',batch.generation,'intent',landing.intent,'observation',observation));
      update clued_private.ci_train_landing_v2 set state=case op when 'landing_reconcile' then 'settled' else 'revoked' end,
        receipt_id=r,observation=payload->'observation' where effect_key=landing.effect_key returning * into landing;
      update clued_private.ci_train_batches_v2 set
        state=case when op='landing_reconcile' then 'landed'
          when observation->>'mainSha'=batch.base_sha and expiry is not null then 'waiting_checks'
          else 'invalidated' end,
        expires_at=case when op='landing_invalidate' then t else batch.expires_at end,
        receipt_id=r where batch_id=k;
    end if;
    return jsonb_build_object('effect_key',landing.effect_key,'state',landing.state,'intent',landing.intent,
      'successorRefOid',landing.successor_ref_oid,
      'observation',landing.observation,'receipt_id',landing.receipt_id);
  end if;
  return clued_private.ci_train_batch_view_v2(batch);
end $$;
-- A scheduled scan already has a Stage 1 job lease. Never mint a second lease
-- for it. Pin the job's exact scope, role, head, source, and current generation.
create function clued_private.ci_train_job_command_v2(n clued_private.ci_nodes_v1,proof text,repo_id bigint,
  repo text,source text,payload jsonb) returns jsonb language plpgsql volatile set search_path='' as $$
declare
  op text:=payload->>'action'; j clued_private.ci_jobs_v1; l clued_private.ci_job_leases_v1;
  request jsonb; answer jsonb; fields text[]; id uuid; g bigint;
  common constant text[]:=array['protocol_version','action','repository_id','target_branch','source_manifest_sha256','job_id','job_generation'];
begin
  fields:=case op when 'publisher_current' then array[]::text[]
    when 'scan_start_verify' then array['changed_paths']
    when 'scan_start_begin' then array['changed_paths','registry_sha256'] end;
  perform clued_private.ci_input_v1(payload,common||fields,common||fields,32768);
  if coalesce(payload->>'job_id','') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    or jsonb_typeof(payload->'job_generation') is distinct from 'number'
    or coalesce(payload->>'job_generation','') !~ '^[1-9][0-9]{0,14}$'
    then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
  id:=(payload->>'job_id')::uuid; g:=(payload->>'job_generation')::bigint;
  select * into j from clued_private.ci_jobs_v1 q where q.user_id=n.user_id and q.project_id=n.project_id
    and q.repository_id=repo_id and lower(q.repository_name)=repo and q.target_branch=payload->>'target_branch'
    and q.job_id=id and q.current_generation=g and q.source_sha=n.qualification_source for share;
  if j.job_id is null then return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
  l:=clued_private.ci_lease_current_v1(n.user_id,n.project_id,id,g,n.node_id);
  if l.holder_binding_id<>n.binding_id then return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
  perform clued_private.ci_claim_current_v1(n.user_id,j);
  if op='publisher_current' then
    return jsonb_build_object('status','ok','current',n.publisher_approved,'job_id',id,'generation',g);
  end if;
  if j.kind<>'delegated_scan' or j.role not in ('gitleaks','trivy','contract-placement')
    or not n.scan_signing_approved or not n.hardening_observed or j.pr_ref is null
    or jsonb_typeof(payload->'changed_paths') is distinct from 'array'
    then raise exception 'CI_SCAN_NODE_NOT_APPROVED' using errcode='42501'; end if;
  request:=jsonb_build_object('scope','project:'||n.project_id,'claim_id',j.claim_id,'head_sha',j.head_sha,
    'base_sha',j.base_sha,'changed_paths',payload->'changed_paths');
  insert into clued_private.ci_train_call_v2 values (pg_current_xact_id(),n.user_id,n.binding_id,n.project_id,op);
  if op='scan_start_verify' then
    answer:=public.clued_work_verify_v1(proof,request||jsonb_build_object('pr_ref',j.pr_ref,'target_branch',j.target_branch));
  else
    answer:=clued_private.ci_scan_start_local_v1(proof,request||jsonb_build_object('action','scan_start_independent',
      'repository_id',repo_id,'repository',repo,'execution_id',id,'role',j.role,'pr',split_part(j.pr_ref,'#',2)::bigint,
      'fence',j.claim_fence,'epoch',j.execution_epoch,'source_manifest_sha256',source,'registry_sha256',payload->'registry_sha256'));
  end if;
  delete from clued_private.ci_train_call_v2 where transaction_id=pg_current_xact_id();
  return answer;
end $$;
create function clued_private.ci_train_command_v2(n clued_private.ci_nodes_v1,proof text,payload jsonb)
returns jsonb language plpgsql volatile set search_path='' as $$
declare
  op text:=payload->>'action';
  t timestamptz:=clock_timestamp(); policy jsonb; repo text; repo_id bigint;
  cfg jsonb; source text; branch text:=payload->>'target_branch'; stop text;
  b public.clued_agent_bindings; expires timestamptz;
  w clued_private.ci_train_work_v2; wanted clued_private.ci_train_work_v2;
  e clued_private.ci_train_check_effects_v2;
  target jsonb; projection jsonb; verification jsonb; r uuid; k text; action_keys text[];
  disposition text:=coalesce(payload->>'disposition','join');
  common constant text[]:=array['protocol_version','action','repository_id','target_branch','source_manifest_sha256'];
  lease_keys constant text[]:=array['work_key','generation','lease_version'];
  queue_actions constant text[]:=array['claim_lease_extend','merge_slot_touch','merge_slot_return',
    'merge_queue_yield','merge_queue_keepalive','pr_lifecycle_report'];
  prefix jsonb;
begin
  if jsonb_typeof(payload) is distinct from 'object' or octet_length(payload::text)>32768
    or payload->'protocol_version' is distinct from '2'::jsonb or payload->'target_branch' is distinct from '"main"'::jsonb
    or jsonb_typeof(payload->'repository_id') is distinct from 'number'
    or coalesce(payload->>'repository_id','') !~ '^[1-9][0-9]{0,14}$'
    or coalesce(payload->>'source_manifest_sha256','') !~ '^[0-9a-f]{64}$'
    then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
  action_keys:=case op
    when 'role_probe' then array[]::text[]
    when 'work_pending' then array[]::text[]
    when 'head_acquire' then array['pr','head_sha','claim_id','claim_fence','execution_epoch']
    when 'queue_acquire' then array['pr','head_sha','claim_id','claim_fence','execution_epoch']
    when 'queue_action_acquire' then array['pr','head_sha','claim_id','claim_fence','execution_epoch','purpose']
    when 'verify_head' then lease_keys||array['base_sha','changed_paths']
    when 'resolve_pr_claim' then lease_keys||array['base_sha']
    when 'carry_main_merge' then lease_keys||array['new_head_sha','main_sha','evidence_digest']
    when 'owner_grant_admission' then lease_keys
    when 'work_renew' then lease_keys
    when 'work_release' then lease_keys
    when 'publication_begin_independent' then lease_keys||array['check']
    when 'publication_send' then lease_keys||array['effect_key']
    when 'publication_reconcile' then lease_keys||array['effect_key']
    when 'publication_abort' then lease_keys||array['effect_key']
    when 'publication_finish' then lease_keys||array['effect_key','observation']
    when 'revoke_check' then lease_keys||array['effect_key','observation']
    when 'merge_queue_join' then lease_keys||array['inventory_digest','check_run_id']
    when 'claim_lease_extend' then lease_keys||array['minutes']
    when 'merge_slot_touch' then lease_keys||array['ci_state','hard_cap_minutes','evidence_digest']
    when 'merge_slot_return' then lease_keys||array['evidence_digest']
    when 'merge_queue_yield' then lease_keys
    when 'merge_queue_keepalive' then lease_keys
    when 'pr_lifecycle_report' then lease_keys||array['evidence_digest']
  end;
  repo_id:=(payload->>'repository_id')::bigint;
  repo:=lower((clued_private.ci_repo_v1(n.user_id,n.project_id,repo_id)).repository_name);
  policy:=(clued_private.ci_policy_v1(n.user_id,n.project_id)).policy;
  cfg:=policy->'merge_train_v2'; source:=cfg->>'source_manifest_sha256'; stop:=cfg->>'stop_scope';
  if coalesce(source,'') !~ '^[0-9a-f]{64}$' or coalesce(cfg->>'source_commit','') !~ '^[0-9a-f]{40}$'
    or coalesce(cfg->>'policy_version','') !~ '^[A-Za-z0-9._/-]{1,100}$'
    or coalesce(stop,'') not in ('none','fleet','frozen','strict_disabled')
    or (cfg ? 'batch_max' and (jsonb_typeof(cfg->'batch_max') is distinct from 'number'
      or coalesce(cfg->>'batch_max','') !~ '^[1-3]$'))
    or policy->>'mode' is distinct from 'resident_mirror'
    then raise exception 'CI_TRAIN_V2_NOT_CONFIGURED' using errcode='42501'; end if;
  -- The original gateway took the account, pool and node locks. Lock and recheck
  -- the live Binding and the signed registration after waiting on those locks.
  b:=clued_private.resolve_binding(proof,'context:read','project:'||n.project_id);
  if b.id<>n.binding_id or b.user_id<>n.user_id
    or exists(select 1 from clued_private.ci_nodes_v1 q where q.user_id=n.user_id
      and q.binding_id=n.binding_id and q.node_id<>n.node_id and q.state not in ('retired','revoked'))
    then raise exception 'CI_BINDING_UNAVAILABLE' using errcode='42501'; end if;
  n:=clued_private.ci_node_current_v1(n.user_id,n.project_id,n.node_id,false);
  if n.qualification_source is distinct from cfg->>'source_commit' or payload->>'source_manifest_sha256' is distinct from source then
    return clued_private.ci_train_reject_v2('ci_source_mismatch'); end if;
  if stop='none' and (not clued_private.ci_node_ready_v1(n) or exists(
    select 1 from clued_private.ci_node_liveness_v1 l where l.node_id=n.node_id
      and (l.reported_service_running is distinct from true
        or l.reported_state<>'NORMAL' and not (l.reported_state='INTAKE_PAUSED' and l.reported_intake_until<=t))
  )) then stop:='node'; end if;
  if not clued_private.work_claim_execution_enabled_v1() then
    if op<>'role_probe' then raise exception 'CI_TRAIN_V2_NOT_CONFIGURED' using errcode='42501'; end if;
    stop:='fleet';
  end if;
  if op in ('publisher_current','scan_start_verify','scan_start_begin') then
    if stop<>'none' then raise exception 'CI_NODE_NOT_ELIGIBLE' using errcode='42501'; end if;
    return clued_private.ci_train_job_command_v2(n,proof,repo_id,repo,source,payload);
  end if;
  if op in ('batch_reserve','batch_read','batch_acquire','batch_release','batch_seal','batch_bisect','batch_cleanup',
      'staging_prepare','staging_send','staging_publish',
      'landing_prepare','landing_send','landing_reconcile','landing_invalidate','claim_adopt') then
    if stop<>'none' and op<>'batch_read' then raise exception 'CI_NODE_NOT_ELIGIBLE' using errcode='42501'; end if;
    return clued_private.ci_train_batch_command_v2(n,proof,repo_id,repo,cfg,payload);
  end if;
  if action_keys is null then raise exception 'CI_OPERATION_NOT_SERVED' using errcode='42501'; end if;
  perform clued_private.ci_input_v1(payload,common||action_keys||
    case when op='verify_head' then array['mechanical_paths_proven']
      when op='merge_queue_join' then array['disposition','reason'] else array[]::text[] end,common||action_keys,32768);
  if op='role_probe' then
    return jsonb_build_object('protocol_version',2,'on_duty',stop='none','node_id',n.node_id,
      'binding_generation',n.binding_generation,'source_manifest_sha256',source,'stop_scope',stop);
  end if;
  if stop<>'none' then raise exception 'CI_NODE_NOT_ELIGIBLE' using errcode='42501'; end if;
  prefix:=jsonb_build_array(n.user_id,n.project_id,repo_id,branch);
  if op='work_pending' then
    return jsonb_build_object('status','ok','policy_version',cfg->>'policy_version',
      'batch_max',coalesce((cfg->>'batch_max')::integer,1),
      'more_work',exists(select 1 from clued_private.ci_train_work_v2 q where q.user_id=n.user_id
        and q.project_id=n.project_id and q.repository_id=repo_id and q.target_branch=branch
        and q.source_manifest_sha256=source and q.policy_version=cfg->>'policy_version'
        and q.action='merge_queue_join' and q.state<>'completed'),
      'active_batch',exists(select 1 from clued_private.ci_train_batches_v2 d where d.user_id=n.user_id
        and d.project_id=n.project_id and d.repository_id=repo_id and d.target_branch=branch
        and d.state not in ('completed','invalidated')),
      'queue',coalesce((
        select jsonb_agg(member order by rank,pr) from (
          select jsonb_build_object('pr',q.pr,'headSha',q.head_sha,'claimId',q.claim_id,'fence',q.claim_fence,
            'epoch',q.execution_epoch,'position',rank,'sequence',q.pr,'solo',exists(
              select 1 from clued_private.ci_train_batches_v2 p join clued_private.ci_train_batches_v2 c on c.parent_batch_id=p.batch_id
              where p.user_id=q.user_id and p.project_id=q.project_id and p.repository_id=q.repository_id
                and p.target_branch=q.target_branch and p.source_manifest_sha256=q.source_manifest_sha256
                and p.policy_version=q.policy_version and c.state='completed'
                and jsonb_array_length(p.members)=jsonb_array_length(c.members)+1
                and p.members->(-1)=jsonb_build_object('pr',q.pr,'headSha',q.head_sha,'claimId',q.claim_id,
                  'fence',q.claim_fence,'epoch',q.execution_epoch))) member,rank,q.pr
          from jsonb_array_elements(clued_private.work_claim_merge_queue_current_v1(n.user_id,'merge:'||repo||':'||branch)->'entries')
            with ordinality as native(entry,rank)
          join clued_private.ci_train_work_v2 q on q.claim_id::text=entry->>'claim_id'
          where entry->>'state' in ('head','waiting') and q.user_id=n.user_id and q.project_id=n.project_id
            and q.repository_id=repo_id and q.target_branch=branch and q.source_manifest_sha256=source
            and q.policy_version=cfg->>'policy_version' and q.action='merge_queue_join' and q.state='completed'
            and q.admission->>'disposition' is distinct from 'discard'
            and clued_private.ci_train_head_claim_v2(q,repo) is not null
          order by rank,q.pr limit 10
        ) ready_queue
      ),'[]'::jsonb),'work',coalesce((
      select jsonb_agg(todo order by urgency,due,stable_key) from (
        select jsonb_build_object('action',q.action,'work_key',q.work_key,'pr',q.pr,'head_sha',q.head_sha,
          'claim_id',q.claim_id,'claim_fence',q.claim_fence,'execution_epoch',q.execution_epoch,
          'reconcile',coalesce(effect.state in ('sent','unknown'),false)) todo,
          case when effect.state in ('sent','unknown') then 0 else 2 end urgency,q.expires_at due,q.work_key stable_key
        from clued_private.ci_train_work_v2 q left join clued_private.ci_train_check_effects_v2 effect using(work_key)
        where q.user_id=n.user_id and q.project_id=n.project_id and q.repository_id=repo_id and q.target_branch=branch
          and q.source_manifest_sha256=source and q.policy_version=cfg->>'policy_version' and q.state<>'completed'
          and (q.state='released' and q.action<>'merge_queue_join' or q.expires_at<=t)
        union all
        select jsonb_build_object('action','batch_acquire','batchId',d.batch_id,'state',d.state,
          'member_count',jsonb_array_length(d.members)),
          case when d.state='landed' or d.staging_state in ('sent','unknown') or exists(
            select 1 from clued_private.ci_train_landing_v2 l where l.batch_id=d.batch_id
              and l.state in ('sent','unknown','settled')) then 0 else 1 end,d.expires_at,d.batch_id
        from clued_private.ci_train_batches_v2 d where d.user_id=n.user_id and d.project_id=n.project_id
          and d.repository_id=repo_id and d.target_branch=branch and d.source_manifest_sha256=source
          and d.policy_version=cfg->>'policy_version' and d.state not in ('completed','invalidated') and d.expires_at<=t
        order by urgency,due,stable_key limit 32
      ) due_work
    ),'[]'::jsonb));
  end if;

  if op in ('head_acquire','queue_acquire','queue_action_acquire') then
    if coalesce(payload->>'head_sha','') !~ '^[0-9a-f]{40}$'
      or coalesce(payload->>'claim_id','') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      or exists(select 1 from unnest(array['pr','claim_fence','execution_epoch']) f
        where jsonb_typeof(payload->f) is distinct from 'number' or payload->>f !~ '^[1-9][0-9]{0,14}$')
      then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
    wanted.user_id:=n.user_id; wanted.project_id:=n.project_id; wanted.repository_id:=repo_id;
    wanted.target_branch:=branch; wanted.pr:=(payload->>'pr')::bigint; wanted.head_sha:=payload->>'head_sha';
    wanted.claim_id:=(payload->>'claim_id')::uuid; wanted.claim_fence:=(payload->>'claim_fence')::bigint;
    wanted.execution_epoch:=(payload->>'execution_epoch')::bigint;
    wanted.action:=case op when 'head_acquire' then 'verify_head' when 'queue_acquire' then 'merge_queue_join'
      else payload->>'purpose' end;
    if op='queue_action_acquire' and not coalesce(wanted.action=any(queue_actions),false)
      then raise exception 'CI_OPERATION_NOT_SERVED' using errcode='42501'; end if;
    k:=clued_private.ci_train_key_v2(jsonb_build_array('head')||prefix||
      jsonb_build_array(wanted.pr,wanted.head_sha,wanted.action));
    expires:=clued_private.ci_train_head_claim_v2(wanted,repo);
    if expires is null then return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
    select * into w from clued_private.ci_train_work_v2 q where q.work_key=k for update;
    if op='queue_acquire' and (w.work_key is null or w.claim_id<>wanted.claim_id
      or w.claim_fence<>wanted.claim_fence or w.execution_epoch<>wanted.execution_epoch
      or w.source_manifest_sha256<>source or w.policy_version<>cfg->>'policy_version') then
      return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
    if w.state='completed' then return clued_private.ci_train_reject_v2('ci_head_lease_completed'); end if;
    if w.state='leased' and w.expires_at>t and w.claim_id=wanted.claim_id
      and w.claim_fence=wanted.claim_fence and w.execution_epoch=wanted.execution_epoch
      and w.source_manifest_sha256=source and w.policy_version=cfg->>'policy_version' then
      return clued_private.ci_train_reject_v2('ci_head_lease_held')||jsonb_build_object('ci_retry_after',w.expires_at);
    end if;
    if exists(select 1 from clued_private.ci_train_work_v2 q where q.node_id=n.node_id and q.work_key<>k
        and q.state='leased' and q.expires_at>t)
      or exists(select 1 from clued_private.ci_train_batches_v2 q where q.node_id=n.node_id
        and q.state not in ('completed','invalidated') and q.expires_at>t)
      or exists(select 1 from clued_private.ci_job_leases_v1 q where q.holder_node_id=n.node_id
        and q.state='current' and q.expires_at>t)
      or exists(select 1 from clued_private.ci_job_leases_v1 q
        join clued_private.ci_jobs_v1 j on j.job_id=q.job_id and j.current_generation=q.generation
        where j.user_id=n.user_id and j.project_id=n.project_id and j.repository_id=repo_id and j.target_branch=branch
          and j.pr_ref=repo||'#'||wanted.pr and j.head_sha=wanted.head_sha and q.state='current' and q.expires_at>t
          and j.kind in ('control','publication'))
      then raise exception 'CI_NODE_CAPACITY_UNAVAILABLE' using errcode='55000'; end if;
    r:=clued_private.ci_receipt_v1(n.user_id,n.project_id,'ci_train_work_acquire',k,
      jsonb_build_object('node_id',n.node_id,'generation',coalesce(w.generation,0)+1,'claim_id',wanted.claim_id,
        'claim_fence',wanted.claim_fence,'execution_epoch',wanted.execution_epoch));
    insert into clued_private.ci_train_work_v2(work_key,user_id,project_id,repository_id,target_branch,action,pr,head_sha,
      claim_id,claim_fence,execution_epoch,source_manifest_sha256,policy_version,node_id,binding_id,binding_generation,key_version,
      expires_at,deadline_at,receipt_id)
    values(k,n.user_id,n.project_id,repo_id,branch,wanted.action,wanted.pr,wanted.head_sha,wanted.claim_id,wanted.claim_fence,
      wanted.execution_epoch,source,cfg->>'policy_version',n.node_id,n.binding_id,n.binding_generation,n.key_version,
      least(t+interval '90 seconds',expires,n.qualification_expires_at,n.eligible_until),t+interval '5 minutes',r)
    on conflict (work_key) do update set
      node_id=excluded.node_id,binding_id=excluded.binding_id,binding_generation=excluded.binding_generation,
      key_version=excluded.key_version,claim_id=excluded.claim_id,claim_fence=excluded.claim_fence,execution_epoch=excluded.execution_epoch,
      source_manifest_sha256=excluded.source_manifest_sha256,policy_version=excluded.policy_version,
      generation=ci_train_work_v2.generation+1,lease_version=1,expires_at=excluded.expires_at,deadline_at=excluded.deadline_at,
      state='leased',admission=null,progress_version=0,renewed_progress_version=0,renewed_at=null,receipt_id=r returning * into w;
    update clued_private.ci_train_check_effects_v2 q set state='unknown' where q.work_key=k and q.state='sent';
    if op='queue_acquire' then
      select * into e from clued_private.ci_train_check_effects_v2 q
        where q.work_key=clued_private.ci_train_key_v2(jsonb_build_array('head')||prefix||
          jsonb_build_array(w.pr,w.head_sha,'verify_head')) and q.state='settled'
          and (q.claim_id,q.claim_fence,q.execution_epoch)=(w.claim_id,w.claim_fence,w.execution_epoch);
      select h.admission->>'base_sha' into k from clued_private.ci_train_work_v2 h where h.work_key=e.work_key;
      return clued_private.ci_train_work_view_v2(w)||jsonb_build_object('effect_key',e.effect_key,
        'check',e.observation-array['checkName','state','must_revoke'],'base_sha',k,'entered',exists(
          select 1 from jsonb_array_elements(clued_private.work_claim_merge_queue_current_v1(n.user_id,'merge:'||repo||':'||branch)->'entries') as q(entry)
          where entry->>'claim_id'=w.claim_id::text and entry->>'state' in ('head','waiting')));
    end if;
    return clued_private.ci_train_work_view_v2(w);
  end if;

  if coalesce(payload->>'work_key','') !~ '^[0-9a-f]{64}$'
    or exists(select 1 from unnest(array['generation','lease_version']) f
      where jsonb_typeof(payload->f) is distinct from 'number' or payload->>f !~ '^[1-9][0-9]{0,14}$')
    then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
  k:=payload->>'work_key';
  select * into w from clued_private.ci_train_work_v2 q where q.work_key=k
    and q.user_id=n.user_id and q.project_id=n.project_id and q.repository_id=repo_id and q.target_branch=branch for update;
  if w.work_key is null or w.generation<>(payload->>'generation')::bigint
    or w.lease_version<>(payload->>'lease_version')::bigint or w.node_id<>n.node_id
    or w.binding_id<>n.binding_id or w.binding_generation<>n.binding_generation or w.key_version<>n.key_version
    or w.source_manifest_sha256<>source or w.policy_version<>cfg->>'policy_version'
    then return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
  -- A settled receipt can be read after completion, but conveys no send authority.
  if w.state='completed' and op in ('publication_finish','publication_reconcile') then
    select * into e from clued_private.ci_train_check_effects_v2 q where q.work_key=k
      and q.effect_key=payload->>'effect_key' and q.state='settled';
    if e.effect_key is not null and (op='publication_reconcile' or payload->'observation'=e.observation) then
      return jsonb_build_object('state',e.state,'effect_key',e.effect_key,'check',e.check_target,
        'observation',e.observation,'receipt_id',e.receipt_id,'replayed',true);
    end if;
  end if;
  if w.state<>'leased' or w.expires_at<=t then return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
  expires:=clued_private.ci_train_head_claim_v2(w,repo);
  if expires is null and not (op='merge_queue_join' and w.action=op and disposition='discard') then
    return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
  if op=any(queue_actions) then
    if w.action<>op or (payload ? 'evidence_digest' and coalesce(payload->>'evidence_digest','') !~ '^[0-9a-f]{64}$')
      then return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
    target:=jsonb_build_object('scope','project:'||n.project_id,'pr_ref',repo||'#'||w.pr,'head_sha',w.head_sha);
    insert into clued_private.ci_train_call_v2 values (pg_current_xact_id(),n.user_id,n.binding_id,n.project_id,op);
    case op
      when 'claim_lease_extend','merge_queue_keepalive' then
        verification:=clued_private.work_claim_ci_lease_extend_v1(b,target||jsonb_build_object(
          'action','claim_lease_extend','minutes',coalesce(payload->'minutes','120'::jsonb)));
      when 'merge_queue_yield' then
        verification:=clued_private.work_claim_merge_queue_yield_v1(b,target||jsonb_build_object('action',op));
      when 'merge_slot_touch' then
        verification:=public.clued_work_merge_slot_touch_v1(proof,target||jsonb_build_object(
          'ci_state',payload->'ci_state','hard_cap_minutes',payload->'hard_cap_minutes'));
      when 'merge_slot_return' then
        verification:=public.clued_work_merge_slot_return_v1(proof,target-'head_sha');
      when 'pr_lifecycle_report' then
        -- A v2 merge is settled against a landed batch, through claim_adopt.
        verification:=public.clued_work_pr_lifecycle_report_v1(proof,jsonb_build_object('scope',target->'scope',
          'repository',repo,'prs',jsonb_build_array(jsonb_build_object('pr_number',w.pr,'state','closed'))));
    end case;
    delete from clued_private.ci_train_call_v2 where transaction_id=pg_current_xact_id();
    if verification->>'status'='ok' then
      r:=clued_private.ci_receipt_v1(n.user_id,n.project_id,'ci_train_'||op,k,
        jsonb_build_object('generation',w.generation,'evidence_digest',payload->'evidence_digest'));
      update clued_private.ci_train_work_v2 set state='released',receipt_id=r where work_key=k;
    end if;
    return verification;
  end if;
  if op in ('owner_grant_admission','resolve_pr_claim','carry_main_merge') then
    if w.action<>'verify_head' then return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
    insert into clued_private.ci_train_call_v2 values (pg_current_xact_id(),n.user_id,n.binding_id,n.project_id,op);
    target:=jsonb_build_object('action',op,'scope','project:'||n.project_id,
      'pr_ref',repo||'#'||w.pr,'target_branch',branch);
    case op
      when 'owner_grant_admission' then
        verification:=public.clued_owner_grant_admission_door_v1(proof,jsonb_build_object(
          'action','repo.protected_change','resources',jsonb_build_array('repo:'||repo||'/'||w.head_sha)));
      when 'resolve_pr_claim' then
        verification:=clued_private.work_claim_resolve_pr_v1(proof,target||jsonb_build_object(
          'head_sha',w.head_sha,'base_sha',payload->'base_sha','read_only',true));
      when 'carry_main_merge' then
        if coalesce(payload->>'evidence_digest','') !~ '^[0-9a-f]{64}$'
          then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
        verification:=clued_private.work_claim_carry_main_merge_v1(proof,target||jsonb_build_object(
          'from_head_sha',w.head_sha,'head_sha',payload->'new_head_sha','main_sha',payload->'main_sha'));
        if verification->>'status'='committed' and verification->'replayed' is distinct from 'true'::jsonb then
          perform clued_private.ci_receipt_v1(n.user_id,n.project_id,'ci_train_carry_main_merge',k,
            jsonb_build_object('generation',w.generation,'authorization_id',verification->'authorization_id',
              'evidence_digest',payload->'evidence_digest'));
        end if;
    end case;
    delete from clued_private.ci_train_call_v2 where transaction_id=pg_current_xact_id();
    return verification;
  end if;
  if op='work_renew' then
    if w.progress_version<=w.renewed_progress_version
      or w.renewed_at is not null and w.renewed_at>t-interval '30 seconds'
      then return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
    r:=clued_private.ci_receipt_v1(n.user_id,n.project_id,'ci_train_work_renew',k,
      jsonb_build_object('generation',w.generation,'lease_version',w.lease_version+1,'progress_version',w.progress_version));
    update clued_private.ci_train_work_v2 set lease_version=w.lease_version+1,renewed_at=t,
      renewed_progress_version=w.progress_version,expires_at=least(t+interval '90 seconds',expires,w.deadline_at,
        n.qualification_expires_at,n.eligible_until),receipt_id=r where work_key=k returning * into w;
    return clued_private.ci_train_work_view_v2(w);
  elsif op='work_release' then
    r:=clued_private.ci_receipt_v1(n.user_id,n.project_id,'ci_train_work_release',k,jsonb_build_object('generation',w.generation));
    update clued_private.ci_train_work_v2 set state='released',receipt_id=r where work_key=k returning * into w;
    update clued_private.ci_train_check_effects_v2 set state='unknown' where work_key=k and state='sent';
    return clued_private.ci_train_work_view_v2(w);
  elsif op='merge_queue_join' then
    if w.action<>'merge_queue_join' or coalesce(payload->>'inventory_digest','') !~ '^[0-9a-f]{64}$'
      or disposition not in ('join','wait','return','discard')
      then return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
    select * into e from clued_private.ci_train_check_effects_v2 q
      where q.work_key=clued_private.ci_train_key_v2(jsonb_build_array('head')||prefix||
        jsonb_build_array(w.pr,w.head_sha,'verify_head')) and q.state='settled';
    if e.effect_key is null or e.observation->'checkRunId' is distinct from payload->'check_run_id'
      or (e.claim_id,e.claim_fence,e.execution_epoch) is distinct from (w.claim_id,w.claim_fence,w.execution_epoch) then
      return clued_private.ci_train_reject_v2('ci_effect_unknown'); end if;
    target:=jsonb_build_object('action',op,'scope','project:'||n.project_id,'pr_ref',repo||'#'||w.pr,'head_sha',w.head_sha);
    if disposition<>'join' then
      if disposition='return' then
        insert into clued_private.ci_train_call_v2 values (pg_current_xact_id(),n.user_id,n.binding_id,n.project_id,'merge_slot_return');
        verification:=public.clued_work_merge_slot_return_v1(proof,target-array['action','head_sha']);
        delete from clued_private.ci_train_call_v2 where transaction_id=pg_current_xact_id();
        if verification->>'status' is distinct from 'ok' or verification->>'reason'='admission_binding_required' then
          return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
      end if;
      r:=clued_private.ci_receipt_v1(n.user_id,n.project_id,'ci_train_queue_settle',k,
        jsonb_build_object('generation',w.generation,'inventory_digest',payload->>'inventory_digest',
          'publication_receipt_id',e.receipt_id,'disposition',disposition,'reason',payload->>'reason'));
      update clued_private.ci_train_work_v2 set state=case disposition when 'discard' then 'completed' else 'released' end,
        expires_at=t+interval '15 seconds',admission=jsonb_build_object('disposition',disposition),receipt_id=r where work_key=k;
      return jsonb_build_object('status','ok','disposition',disposition,'receipt_id',r);
    end if;
    insert into clued_private.ci_train_call_v2 values (pg_current_xact_id(),n.user_id,n.binding_id,n.project_id,op);
    verification:=clued_private.work_claim_ci_queue_join_v1(b,target);
    delete from clued_private.ci_train_call_v2 where transaction_id=pg_current_xact_id();
    if verification->'joined'='true'::jsonb or verification->>'reason'='already_queued' then
      r:=clued_private.ci_receipt_v1(n.user_id,n.project_id,'ci_train_queue_settle',k,
        jsonb_build_object('generation',w.generation,'inventory_digest',payload->>'inventory_digest',
          'publication_receipt_id',e.receipt_id,'native_receipt_id',verification->'receipt_id'));
      update clued_private.ci_train_work_v2 set state='completed',receipt_id=r where work_key=k;
    end if;
    return verification;
  elsif op='verify_head' then
    if w.action<>'verify_head' then return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
    if coalesce(payload->>'base_sha','') !~ '^[0-9a-f]{40}$'
      or jsonb_typeof(payload->'changed_paths') is distinct from 'array'
      then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
    target:=jsonb_build_object('scope','project:'||n.project_id,'claim_id',w.claim_id,
      'pr_ref',repo||'#'||w.pr,'head_sha',w.head_sha,'target_branch',branch,'base_sha',payload->>'base_sha',
      'changed_paths',payload->'changed_paths');
    insert into clued_private.ci_train_call_v2 values (pg_current_xact_id(),n.user_id,n.binding_id,n.project_id,op);
    -- Discovery is an exact-head, qualified write. It must activate an
    -- existing unknown relation (or discover a new one) before full verify.
    projection:=clued_private.work_claim_resolve_pr_v1(proof,
      target-array['claim_id','changed_paths']||jsonb_build_object('action','resolve_pr_claim','read_only',false));
    if projection->>'binding_status'<>'bound' or projection#>>'{claim,claim_id}' is distinct from w.claim_id::text then
      raise exception 'CI_TRAIN_PR_SUBJECT_MISMATCH' using errcode='42501'; end if;
    verification:=public.clued_work_verify_v1(proof,target||
      case when payload ? 'mechanical_paths_proven'
        then jsonb_build_object('mechanical_paths_proven',payload->'mechanical_paths_proven') else '{}'::jsonb end);
    delete from clued_private.ci_train_call_v2 where transaction_id=pg_current_xact_id();
    if verification->>'verdict'='ADMITTED' and verification->'execution_authorized'='true'::jsonb and w.admission is null then
      update clued_private.ci_train_work_v2 set admission=target,progress_version=w.progress_version+1 where work_key=k;
    end if;
    return verification;
  end if;

  if w.action<>'verify_head' or not n.publisher_approved or not n.hardening_observed
    then raise exception 'CI_NODE_NOT_ELIGIBLE' using errcode='42501'; end if;
  select * into e from clued_private.ci_train_check_effects_v2 q where q.work_key=k for update;
  if op='publication_begin_independent' then
    if e.state in ('sent','unknown') then return clued_private.ci_train_reject_v2('ci_effect_unknown'); end if;
    if w.admission is null then return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
    target:=payload->'check';
    perform clued_private.ci_input_v1(target,array['appId','headSha','externalId'],array['appId','headSha','externalId'],2048);
    if target->'appId' is distinct from '5368905'::jsonb or target->>'headSha' is distinct from w.head_sha
      or coalesce(target->>'externalId','') !~ '^[A-Za-z0-9:._/-]{1,200}$'
      then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
    target:=target||jsonb_build_object('checkName','kooyumi-work-admission');
    if e.effect_key is not null and (e.check_target<>target
      or (e.state<>'reserved' and not (e.state='revoked' and e.observation is null and e.generation<>w.generation))) then
      return clued_private.ci_train_reject_v2('ci_effect_unknown'); end if;
    if e.effect_key is null or e.generation<>w.generation then
      -- No node, binding, attempt, claim, or lease generation enters the effect key.
      r:=clued_private.ci_receipt_v1(n.user_id,n.project_id,'ci_train_publication_reserve',k,
        jsonb_build_object('check',target,'generation',w.generation,'role','work-admission'));
      insert into clued_private.ci_train_check_effects_v2(effect_key,work_key,generation,claim_id,claim_fence,execution_epoch,state,
        check_target,receipt_id)
      values(clued_private.ci_train_key_v2(jsonb_build_array('effect')||prefix||
        jsonb_build_array('publication_begin_independent',jsonb_build_array(w.pr,w.head_sha,'work-admission'))),
        k,w.generation,w.claim_id,w.claim_fence,w.execution_epoch,'reserved',target,r)
      on conflict (work_key) do update set generation=excluded.generation,state='reserved',claim_id=excluded.claim_id,
        claim_fence=excluded.claim_fence,execution_epoch=excluded.execution_epoch,receipt_id=r returning * into e;
    end if;
  else
    if e.effect_key is null or e.effect_key is distinct from payload->>'effect_key' then
      return clued_private.ci_train_reject_v2('ci_effect_unknown'); end if;
    if op='publication_send' then
      if e.state<>'reserved' then return clued_private.ci_train_reject_v2('ci_effect_unknown'); end if;
      if e.generation<>w.generation then return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
      r:=clued_private.ci_receipt_v1(n.user_id,n.project_id,'ci_train_publication_send',e.effect_key,
        jsonb_build_object('generation',w.generation,'check',e.check_target));
      update clued_private.ci_train_check_effects_v2 set state='sent',receipt_id=r where effect_key=e.effect_key returning * into e;
    elsif op='publication_abort' then
      if e.state<>'reserved' then return clued_private.ci_train_reject_v2('ci_effect_unknown'); end if;
      if e.generation<>w.generation then return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
      r:=clued_private.ci_receipt_v1(n.user_id,n.project_id,'ci_train_publication_abort',e.effect_key,
        jsonb_build_object('generation',w.generation));
      update clued_private.ci_train_check_effects_v2 set state='revoked',receipt_id=r where effect_key=e.effect_key returning * into e;
    elsif op='publication_finish' then
      target:=payload->'observation';
      perform clued_private.ci_input_v1(target,array['appId','headSha','externalId','checkName','checkRunId','state','must_revoke'],
        array['appId','headSha','externalId','checkName','checkRunId','state','must_revoke'],4096);
      if target-array['checkRunId','state','must_revoke'] is distinct from e.check_target
        or target->'state' is distinct from '"published"'::jsonb
        or jsonb_typeof(target->'checkRunId') is distinct from 'number'
        or coalesce(target->>'checkRunId','') !~ '^[1-9][0-9]{0,14}$'
        or jsonb_typeof(target->'must_revoke') is distinct from 'boolean'
        or e.state not in ('sent','unknown')
        then return clued_private.ci_train_reject_v2('ci_effect_unknown'); end if;
      if target->'must_revoke'='true'::jsonb then
        r:=clued_private.ci_receipt_v1(n.user_id,n.project_id,'ci_train_publication_needs_revoke',e.effect_key,
          jsonb_build_object('generation',w.generation,'observation',target));
        update clued_private.ci_train_check_effects_v2 set state='unknown',observation=target,receipt_id=r
          where effect_key=e.effect_key;
        return clued_private.ci_train_reject_v2('ci_effect_unknown')||jsonb_build_object('receipt_id',r,'must_revoke',true);
      end if;
      if e.observation->'must_revoke'='true'::jsonb then
        return clued_private.ci_train_reject_v2('ci_effect_unknown')||jsonb_build_object('receipt_id',e.receipt_id,'must_revoke',true);
      end if;
      if (e.claim_id,e.claim_fence,e.execution_epoch) is distinct from (w.claim_id,w.claim_fence,w.execution_epoch) then
        return clued_private.ci_train_reject_v2('ci_effect_unknown'); end if;
      r:=clued_private.ci_receipt_v1(n.user_id,n.project_id,'ci_train_publication_finish',e.effect_key,
        jsonb_build_object('generation',w.generation,'sent_generation',e.generation,'observation',target));
      update clued_private.ci_train_check_effects_v2 set state='settled',observation=target,receipt_id=r
        where effect_key=e.effect_key returning * into e;
      update clued_private.ci_train_work_v2 set state='completed',receipt_id=r where work_key=k;
      -- Persist the queue evaluation before acknowledging the publication.
      insert into clued_private.ci_train_work_v2(work_key,user_id,project_id,repository_id,target_branch,action,pr,head_sha,
        claim_id,claim_fence,execution_epoch,source_manifest_sha256,policy_version,node_id,binding_id,binding_generation,
        key_version,expires_at,deadline_at,state,receipt_id)
      values(clued_private.ci_train_key_v2(jsonb_build_array('head')||prefix||
        jsonb_build_array(w.pr,w.head_sha,'merge_queue_join')),w.user_id,w.project_id,w.repository_id,w.target_branch,
        'merge_queue_join',w.pr,w.head_sha,w.claim_id,w.claim_fence,w.execution_epoch,w.source_manifest_sha256,w.policy_version,
        w.node_id,w.binding_id,w.binding_generation,w.key_version,t,t,'released',r)
      on conflict (work_key) do nothing;
    elsif op='revoke_check' then
      target:=payload->'observation';
      perform clued_private.ci_input_v1(target,array['appId','headSha','externalId','checkName','checkRunId','state'],
        array['appId','headSha','externalId','checkName','checkRunId','state'],4096);
      if e.state<>'unknown' or e.observation->'must_revoke' is distinct from 'true'::jsonb
        or target-array['checkRunId','state'] is distinct from e.check_target
        or target->'checkRunId' is distinct from e.observation->'checkRunId'
        or target->'state' is distinct from '"revoked"'::jsonb then
        return clued_private.ci_train_reject_v2('ci_effect_unknown'); end if;
      r:=clued_private.ci_receipt_v1(n.user_id,n.project_id,'ci_train_check_revoked',e.effect_key,
        jsonb_build_object('generation',w.generation,'observation',target));
      update clued_private.ci_train_check_effects_v2 set state='revoked',observation=target,receipt_id=r
        where effect_key=e.effect_key returning * into e;
      update clued_private.ci_train_work_v2 set state='completed',receipt_id=r where work_key=k;
    end if;
  end if;
  return jsonb_build_object('state',e.state,'effect_key',e.effect_key,'check',e.check_target,
    'observation',e.observation,'receipt_id',e.receipt_id);
end $$;

-- Forward-only rewrites of the exact current definitions. Legacy callers keep
-- their old role checks. Only the scoped verify action can satisfy these paths.
create function clued_private.ci_train_patch_v2(signature regprocedure,anchor text,replacement text) returns void
language plpgsql set search_path='' as $$
declare body text:=pg_get_functiondef(signature);
begin
  if (length(body)-length(replace(body,anchor,'')))<>length(anchor) then
    raise exception 'ci_train_v2_patch_anchor_mismatch: % [%]',signature,anchor; end if;
  execute replace(body,anchor,replacement);
end $$;

select clued_private.ci_train_patch_v2('public.clued_ci_node_command_v1(text,jsonb,jsonb,jsonb)',
  $a$'green_mirror_append','job_lease_next')$a$,$r$'green_mirror_append','job_lease_next','merge_train_v2')$r$);
select clued_private.ci_train_patch_v2('public.clued_ci_node_command_v1(text,jsonb,jsonb,jsonb)',
  $a$    if op='qualification_report' then$a$,
  $r$    if op='merge_train_v2' then
      if g<>0 or tg<>0 then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
      -- Bindings can rotate while the command is waiting for the locks.
      n:=clued_private.ci_gateway_node_v1(p_token_hash,n.node_id);
      if (p_command->>'binding_id')::uuid is distinct from n.binding_id
        or (p_command->>'binding_generation')::bigint is distinct from n.binding_generation
        or (p_command->>'node_version')::bigint is distinct from n.version
        or (p_command->>'key_version')::bigint is distinct from n.key_version
        or p_command->>'key_fingerprint' is distinct from n.identity_fingerprint then
        raise exception 'CI_COMMAND_STALE_VERSION' using errcode='42501'; end if;
      res:=clued_private.ci_train_command_v2(n,p_token_hash,p_payload);
    elsif op='qualification_report' then$r$);
select clued_private.ci_train_patch_v2('public.clued_ci_node_command_v1(text,jsonb,jsonb,jsonb)',
  $a$if prior.command=p_command and prior.node_id=n.node_id then$a$,
  $r$if op<>'merge_train_v2' and prior.command=p_command and prior.node_id=n.node_id then$r$);

select clued_private.ci_train_patch_v2('clued_private.ci_duty_admits_v1(uuid,uuid,text,uuid)',
  $a$  v:=clued_private.ci_duty_admits_decide_v1(u,p_binding,p_mode,p);$a$,
  $r$  if p is null and (
    p_mode in ('issuer_role','issuer_admits') and clued_private.ci_train_call_is_v2(u,p_binding,
      array['verify_head','scan_start_verify','scan_start_begin','owner_grant_admission','resolve_pr_claim','carry_main_merge'])
    or p_mode='duty_merge_slot' and clued_private.ci_train_call_is_v2(u,p_binding,array['merge_queue_join','claim_adopt',
      'claim_lease_extend','merge_slot_touch','merge_slot_return','merge_queue_yield','merge_queue_keepalive','pr_lifecycle_report'])
    or p_mode='duty_role' and clued_private.ci_train_call_is_v2(u,p_binding,array['scan_start_begin'])
  ) then return true; end if;
  v:=clued_private.ci_duty_admits_decide_v1(u,p_binding,p_mode,p);$r$);

select clued_private.ci_train_patch_v2(
  'clued_private.ci_scan_start_begin_v1(public.clued_agent_bindings,clued_private.ci_scan_start_policies_v1,jsonb,text,text,text)',
  $a$  if consumer.activated_at is null or consumer.activated_at>clock_timestamp()
    or consumer.ci_principal_binding_id is distinct from b.id
    or consumer.source_manifest_sha256 is distinct from p.source_manifest_sha256 then$a$,
  $r$  if provider_name='independent-controller' and clued_private.ci_train_route_v2(b.user_id,p.scope)
    and not clued_private.ci_train_call_is_v2(b.user_id,b.id,array['scan_start_begin']) then
    return jsonb_build_object('status','rejected','error_code','ci_work_lease_stale','launch_allowed',false); end if;
  if not (provider_name='independent-controller'
    and clued_private.ci_train_call_is_v2(b.user_id,b.id,array['scan_start_begin']))
    and (consumer.activated_at is null or consumer.activated_at>clock_timestamp()
      or consumer.ci_principal_binding_id is distinct from b.id
      or consumer.source_manifest_sha256 is distinct from p.source_manifest_sha256) then$r$);

select clued_private.ci_train_patch_v2('clued_private.work_claim_independent_begin_v1(text,jsonb)',
  $a$  select * into policy from clued_private.work_claim_independent_consumer_v1 where singleton;$a$,
  $r$  if clued_private.ci_train_route_v2(b.user_id,scope) then
    return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
  select * into policy from clued_private.work_claim_independent_consumer_v1 where singleton;$r$);

select clued_private.ci_train_patch_v2('clued_private.work_claim_ci_queue_join_v1(public.clued_agent_bindings,jsonb)',
  $a$  if not clued_private.merge_slot_admits_v1(b) then$a$,
  $r$  if clued_private.ci_train_route_v2(b.user_id,v_scope)
    and not clued_private.ci_train_call_is_v2(b.user_id,b.id,array['merge_queue_join']) then
    return clued_private.ci_train_reject_v2('ci_work_lease_stale'); end if;
  if not clued_private.merge_slot_admits_v1(b) then$r$);

-- A Stage 1 job and a narrow pre-job control lease share the resident slot.
-- Also fence job-backed publication/control for the same precise head while
-- the narrow work owns it, regardless of which node asks for the job.
select clued_private.ci_train_patch_v2('clued_private.ci_job_lease_v1(uuid,uuid,uuid,uuid,bigint)',
  $a$  n:=clued_private.ci_node_current_v1(u,p,node);$a$,
  $r$  n:=clued_private.ci_node_current_v1(u,p,node);
  if exists(select 1 from clued_private.ci_train_work_v2 w where w.user_id=u and w.project_id=p
      and w.state='leased' and w.expires_at>clock_timestamp() and (
        w.node_id=node or (j.kind in ('control','publication') and w.repository_id=j.repository_id
          and w.target_branch=j.target_branch and w.head_sha=j.head_sha and lower(j.pr_ref)=lower(j.repository_name)||'#'||w.pr)))
    or exists(select 1 from clued_private.ci_train_batches_v2 d where d.node_id=node
      and d.state not in ('completed','invalidated') and d.expires_at>clock_timestamp()) then
    raise exception 'CI_NODE_CAPACITY_UNAVAILABLE' using errcode='55000'; end if;$r$);

drop function clued_private.ci_train_patch_v2(regprocedure,text,text);
revoke all on function
  clued_private.ci_train_key_json_v2(jsonb),clued_private.ci_train_key_v2(jsonb),clued_private.ci_train_reject_v2(text),
  clued_private.ci_train_work_view_v2(clued_private.ci_train_work_v2),
  clued_private.ci_train_call_is_v2(uuid,uuid,text[]),
  clued_private.ci_train_route_v2(uuid,text),
  clued_private.ci_train_head_claim_v2(clued_private.ci_train_work_v2,text),
  clued_private.ci_train_batch_view_v2(clued_private.ci_train_batches_v2),
  clued_private.ci_train_batch_key_v2(clued_private.ci_train_batches_v2),
  clued_private.ci_train_batch_members_v2(clued_private.ci_train_batches_v2,text,boolean),
  clued_private.ci_train_batch_adopt_v2(clued_private.ci_nodes_v1,text,text,clued_private.ci_train_batches_v2,jsonb),
  clued_private.ci_train_batch_command_v2(clued_private.ci_nodes_v1,text,bigint,text,jsonb,jsonb),
  clued_private.ci_train_job_command_v2(clued_private.ci_nodes_v1,text,bigint,text,text,jsonb),
  clued_private.ci_train_command_v2(clued_private.ci_nodes_v1,text,jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;
