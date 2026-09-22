-- Context v2 / MTPE M0: minimal post-commit refresh pipeline for the two
-- approved Global projections. Canonical writes only enqueue invalidation;
-- a separately granted read-only Builder claims and CAS-applies generations.

create table clued_private.projection_refresh_jobs (
  user_id uuid not null references auth.users(id) on delete cascade,
  target_scope text not null check (target_scope='global'),
  projection_key text not null check (projection_key in (
    'global.priority_frontier','global.__aggregate__')),
  target_invalidation_revision bigint not null check (target_invalidation_revision>=0),
  status text not null check (status in (
    'queued','running','retry_wait','failed','completed')),
  attempt_count integer not null default 0 check (attempt_count>=0),
  max_attempts integer not null default 4 check (max_attempts between 1 and 10),
  next_attempt_at timestamptz not null default now(),
  lease_id uuid,
  leased_by_binding_id uuid references public.clued_agent_bindings(id) on delete set null,
  leased_invalidation_revision bigint,
  leased_source_vector_digest text,
  leased_at timestamptz,
  lease_expires_at timestamptz,
  last_error_code text,
  last_error_detail jsonb not null default '{}'::jsonb,
  last_receipt_id uuid references public.clued_audit_receipts(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(user_id,target_scope,projection_key),
  check ((status='running')=(lease_id is not null)),
  check (leased_source_vector_digest is null or
    leased_source_vector_digest~'^[0-9a-f]{64}$')
);

create table clued_private.projection_refresh_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  target_scope text not null,
  projection_key text not null,
  target_invalidation_revision bigint not null,
  attempt_number integer not null,
  lease_id uuid not null,
  builder_binding_id uuid references public.clued_agent_bindings(id) on delete set null,
  source_vector_digest text,
  outcome text not null check (outcome in (
    'RUNNING','SUCCEEDED','CAS_CONFLICT','RETRYABLE_FAILURE','TERMINAL_FAILURE')),
  error_code text,
  error_detail jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique(user_id,target_scope,projection_key,lease_id)
);

create index projection_refresh_jobs_due_idx on clued_private.projection_refresh_jobs(
  next_attempt_at,user_id,projection_key) where status in ('queued','retry_wait');
create index projection_refresh_attempts_job_idx on clued_private.projection_refresh_attempts(
  user_id,target_scope,projection_key,id desc);

alter table clued_private.projection_refresh_jobs enable row level security;
alter table clued_private.projection_refresh_attempts enable row level security;
revoke all on clued_private.projection_refresh_jobs,
  clued_private.projection_refresh_attempts from public,anon,authenticated,service_role;

create function clued_private.projection_refresh_retry_delay(p_attempt integer)
returns interval language sql immutable set search_path='' as $$
  select case greatest(p_attempt,1)
    when 1 then interval '1 second'
    when 2 then interval '5 seconds'
    when 3 then interval '30 seconds'
    else interval '2 minutes' end
$$;

create function clued_private.projection_refresh_enqueue(
  p_user_id uuid,p_scope text,p_key text,p_revision bigint
) returns void language plpgsql security definer set search_path='' as $$
begin
  if p_scope<>'global' or p_key not in (
    'global.priority_frontier','global.__aggregate__') then return; end if;
  insert into clued_private.projection_refresh_jobs(
    user_id,target_scope,projection_key,target_invalidation_revision,status,
    attempt_count,next_attempt_at)
  values(p_user_id,p_scope,p_key,p_revision,'queued',0,
    pg_catalog.clock_timestamp()+interval '250 milliseconds')
  on conflict(user_id,target_scope,projection_key) do update set
    target_invalidation_revision=greatest(
      clued_private.projection_refresh_jobs.target_invalidation_revision,
      excluded.target_invalidation_revision),
    status=case when clued_private.projection_refresh_jobs.status='running'
      then 'running' else 'queued' end,
    attempt_count=case when excluded.target_invalidation_revision>
      clued_private.projection_refresh_jobs.target_invalidation_revision
      then 0 else clued_private.projection_refresh_jobs.attempt_count end,
    next_attempt_at=case when clued_private.projection_refresh_jobs.status='running'
      then clued_private.projection_refresh_jobs.next_attempt_at
      else pg_catalog.clock_timestamp()+interval '250 milliseconds' end,
    last_error_code=null,last_error_detail='{}'::jsonb,completed_at=null,
    updated_at=pg_catalog.clock_timestamp();
end $$;

create function clued_private.projection_refresh_enqueue_trigger()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.target_scope='global' and new.projection_key in (
      'global.priority_frontier','global.__aggregate__') and
     new.invalidation_revision>new.resolved_through_revision and
     (tg_op='INSERT' or new.invalidation_revision>old.invalidation_revision) then
    perform clued_private.projection_refresh_enqueue(new.user_id,new.target_scope,
      new.projection_key,new.invalidation_revision);
  end if;
  return new;
end $$;

create trigger zz_projection_refresh_enqueue
after insert or update on clued_private.projection_invalidation_heads
for each row execute function clued_private.projection_refresh_enqueue_trigger();

-- Install-time recovery is also idempotent: unresolved existing heads become
-- one coalesced job per projection, never one job per historical invalidation.
insert into clued_private.projection_refresh_jobs(
  user_id,target_scope,projection_key,target_invalidation_revision,status,
  attempt_count,next_attempt_at)
select h.user_id,h.target_scope,h.projection_key,h.invalidation_revision,
  'queued',0,now()
from clued_private.projection_invalidation_heads h
where h.target_scope='global' and h.projection_key in (
  'global.priority_frontier','global.__aggregate__')
  and h.invalidation_revision>h.resolved_through_revision
on conflict(user_id,target_scope,projection_key) do update set
  target_invalidation_revision=greatest(
    clued_private.projection_refresh_jobs.target_invalidation_revision,
    excluded.target_invalidation_revision),
  status=case when clued_private.projection_refresh_jobs.status='running'
    then 'running' else 'queued' end,
  next_attempt_at=case when clued_private.projection_refresh_jobs.status='running'
    then clued_private.projection_refresh_jobs.next_attempt_at else now() end,
  completed_at=null,updated_at=now();

create function clued_private.projection_refresh_builder_binding(
  p_token_hash text,p_key text
) returns public.clued_agent_bindings language plpgsql stable security definer
set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
begin
  -- Read-only plus the private projection grant is deliberate: this Binding
  -- cannot call normal Canonical mutation RPCs.
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read','global');
  if not clued_private.projection_builder_authorized(v_binding.id,v_binding.user_id,
      'global',p_key) or not '*'=any(v_binding.context_keys) or
     exists(select 1 from clued_private.authorizations_v12 a
       where a.binding_id=v_binding.id) then
    raise exception 'projection_builder_not_authorized' using errcode='42501';
  end if;
  return v_binding;
end $$;

create function clued_private.projection_refresh_clear_lease(p_user_id uuid,p_key text)
returns void language sql security definer set search_path='' as $$
  update clued_private.projection_refresh_jobs set
    lease_id=null,leased_by_binding_id=null,leased_invalidation_revision=null,
    leased_source_vector_digest=null,leased_at=null,lease_expires_at=null,
    updated_at=pg_catalog.clock_timestamp()
  where user_id=p_user_id and target_scope='global' and projection_key=p_key
$$;

create function public.clued_mcp_projection_refresh_claim(
  p_token_hash text,p_input jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
  v_job clued_private.projection_refresh_jobs%rowtype;
  v_head clued_private.projection_invalidation_heads%rowtype;
  v_snapshot jsonb; v_digest text; v_lease uuid; v_wait timestamptz;
begin
  -- Resolve once with either approved key; row selection below rechecks the
  -- exact key grant before exposing a source vector.
  begin
    v_binding:=clued_private.projection_refresh_builder_binding(
      p_token_hash,'global.priority_frontier');
  exception when insufficient_privilege then
    v_binding:=clued_private.projection_refresh_builder_binding(
      p_token_hash,'global.__aggregate__');
  end;
  perform clued_private.currentness_user_lock(v_binding.user_id);

  -- A crashed Worker leaves a lease, never a false CURRENT result. Expiry is
  -- converted into a diagnostic retry and remains bounded by max_attempts.
  insert into clued_private.projection_refresh_attempts(
    user_id,target_scope,projection_key,target_invalidation_revision,
    attempt_number,lease_id,builder_binding_id,source_vector_digest,outcome,
    error_code,error_detail,started_at,finished_at)
  select j.user_id,j.target_scope,j.projection_key,
    coalesce(j.leased_invalidation_revision,j.target_invalidation_revision),
    j.attempt_count,j.lease_id,j.leased_by_binding_id,
    j.leased_source_vector_digest,'RETRYABLE_FAILURE','builder_lease_expired',
    jsonb_build_object('lease_expires_at',j.lease_expires_at),
    coalesce(j.leased_at,j.updated_at),pg_catalog.clock_timestamp()
  from clued_private.projection_refresh_jobs j
  where j.user_id=v_binding.user_id and j.status='running'
    and j.lease_expires_at<=pg_catalog.clock_timestamp()
  on conflict(user_id,target_scope,projection_key,lease_id) do update set
    outcome='RETRYABLE_FAILURE',error_code='builder_lease_expired',
    error_detail=excluded.error_detail,finished_at=excluded.finished_at;

  update clued_private.projection_refresh_jobs j set
    status=case when j.attempt_count>=j.max_attempts then 'failed'
      else 'retry_wait' end,
    next_attempt_at=case when j.attempt_count>=j.max_attempts
      then pg_catalog.clock_timestamp()
      else pg_catalog.clock_timestamp()+
        clued_private.projection_refresh_retry_delay(j.attempt_count) end,
    last_error_code='builder_lease_expired',
    last_error_detail=jsonb_build_object('lease_expires_at',j.lease_expires_at),
    lease_id=null,leased_by_binding_id=null,leased_invalidation_revision=null,
    leased_source_vector_digest=null,leased_at=null,lease_expires_at=null,
    updated_at=pg_catalog.clock_timestamp()
  where j.user_id=v_binding.user_id and j.status='running'
    and j.lease_expires_at<=pg_catalog.clock_timestamp();

  select j.* into v_job
  from clued_private.projection_refresh_jobs j
  where j.user_id=v_binding.user_id and j.target_scope='global'
    and j.status in ('queued','retry_wait')
    and j.next_attempt_at<=pg_catalog.clock_timestamp()
    and clued_private.projection_builder_authorized(v_binding.id,v_binding.user_id,
      'global',j.projection_key)
    and (j.projection_key<>'global.__aggregate__' or not exists(
      select 1 from clued_private.projection_invalidation_heads h
      where h.user_id=j.user_id and h.target_scope='global'
        and h.projection_key<>'global.__aggregate__'
        and h.invalidation_revision>h.resolved_through_revision))
  order by case j.projection_key when 'global.priority_frontier' then 0 else 1 end,
    j.next_attempt_at
  for update skip locked limit 1;

  if not found then
    select min(j.next_attempt_at) into v_wait
    from clued_private.projection_refresh_jobs j
    where j.user_id=v_binding.user_id and j.target_scope='global'
      and j.status in ('queued','retry_wait')
      and clued_private.projection_builder_authorized(v_binding.id,v_binding.user_id,
        'global',j.projection_key);
    return jsonb_build_object('status',case when v_wait is null then 'idle' else 'waiting' end,
      'next_attempt_at',v_wait,'retry_after_ms',case when v_wait is null then null
        else greatest(0,ceil(extract(epoch from
          (v_wait-pg_catalog.clock_timestamp()))*1000)::bigint) end);
  end if;

  v_binding:=clued_private.projection_refresh_builder_binding(
    p_token_hash,v_job.projection_key);
  select * into v_head from clued_private.projection_invalidation_heads h
    where h.user_id=v_job.user_id and h.target_scope='global'
      and h.projection_key=v_job.projection_key for update;
  if not found or v_head.invalidation_revision<=v_head.resolved_through_revision then
    update clued_private.projection_refresh_jobs set status='completed',
      target_invalidation_revision=coalesce(v_head.invalidation_revision,
        target_invalidation_revision),completed_at=pg_catalog.clock_timestamp(),
      updated_at=pg_catalog.clock_timestamp()
    where user_id=v_job.user_id and target_scope='global'
      and projection_key=v_job.projection_key;
    perform clued_private.projection_refresh_clear_lease(
      v_job.user_id,v_job.projection_key);
    return jsonb_build_object('status','superseded','projection_key',v_job.projection_key);
  end if;
  v_snapshot:=clued_private.projection_source_snapshot(v_binding.user_id);
  v_digest:=clued_private.currentness_hash(v_snapshot);
  v_lease:=extensions.gen_random_uuid();
  update clued_private.projection_refresh_jobs set
    target_invalidation_revision=v_head.invalidation_revision,status='running',
    attempt_count=attempt_count+1,lease_id=v_lease,
    leased_by_binding_id=v_binding.id,
    leased_invalidation_revision=v_head.invalidation_revision,
    leased_source_vector_digest=v_digest,leased_at=pg_catalog.clock_timestamp(),
    lease_expires_at=pg_catalog.clock_timestamp()+interval '30 seconds',
    last_error_code=null,last_error_detail='{}'::jsonb,
    updated_at=pg_catalog.clock_timestamp()
  where user_id=v_job.user_id and target_scope='global'
    and projection_key=v_job.projection_key returning * into v_job;
  insert into clued_private.projection_refresh_attempts(
    user_id,target_scope,projection_key,target_invalidation_revision,
    attempt_number,lease_id,builder_binding_id,source_vector_digest,outcome)
  values(v_job.user_id,'global',v_job.projection_key,
    v_head.invalidation_revision,v_job.attempt_count,v_lease,v_binding.id,v_digest,'RUNNING');
  return jsonb_build_object('status','claimed','lease_id',v_lease,
    'projection_key',v_job.projection_key,
    'expected_invalidation_revision',v_head.invalidation_revision,
    'expected_source_vector_digest',v_digest,'attempt',v_job.attempt_count,
    'lease_expires_at',v_job.lease_expires_at);
end $$;

create function clued_private.projection_refresh_frontier_apply(
  p_binding public.clued_agent_bindings,p_revision bigint
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_task public.clued_memories%rowtype; v_count integer; v_record_id uuid;
  v_record public.clued_memories%rowtype; v_receipt_id uuid;
  v_fields jsonb; v_content text; v_snapshot jsonb; v_digest text;
  v_generation bigint; v_source_refs jsonb;
begin
  select count(*),(array_agg(m.id order by m.priority desc,m.updated_at desc,m.id))[1]
    into v_count,v_record_id
  from public.clued_memories m
  where m.user_id=p_binding.user_id and m.record_schema_version=1
    and m.record_type='task' and m.lifecycle_status='active'
    and m.type_fields->>'execution_bucket'='now'
    and not exists(select 1 from clued_private.projection_record_bindings b
      where b.record_id=m.id)
    and clued_private.record_currentness_fence(p_binding.user_id,m.id,null::text[])='CURRENT';
  if v_count<>1 then
    raise exception 'frontier_candidate_not_unique' using errcode='40001',
      detail=jsonb_build_object('candidate_count',v_count)::text;
  end if;
  select * into v_task from public.clued_memories where id=v_record_id for share;
  v_fields:=jsonb_build_object(
    'state_kind','current_frontier_projection',
    'projection_key','global.priority_frontier',
    'source_task',jsonb_build_object('id',v_task.id,'scope',v_task.canonical_scope,
      'version',v_task.version),
    'render_rule_version','task-body.v1',
    'rule_set_digest',clued_private.frontier_rule_digest_v2());
  if clued_private.frontier_task_source_v2(p_binding.user_id,v_fields)->>'status'<>'RESOLVED' then
    raise exception 'frontier_source_contract_required' using errcode='40001';
  end if;
  v_content:='当前 Global 唯一优先工作由 Canonical Task '||v_task.id::text||
    ' v'||v_task.version::text||' 提供。此记录只保存标准工作投影的来源绑定；执行正文、完成标准和排序事实仍由该 Task 拥有。排序及 Currentness 不授予阶段开工、生产、部署、预算或采购权限。';
  select coalesce(h.record_id,b.record_id) into v_record_id
  from (select 1) singleton
  left join clued_private.projection_heads h on h.user_id=p_binding.user_id
    and h.target_scope='global' and h.projection_key='global.priority_frontier'
  left join lateral (select rb.record_id from clued_private.projection_record_bindings rb
    where rb.user_id=p_binding.user_id and rb.target_scope='global'
      and rb.projection_key='global.priority_frontier'
    order by rb.projection_generation desc,rb.record_id limit 1) b on true;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,
    operation,object_type,object_id,version,metadata)
  values(p_binding.user_id,p_binding.id,'global','projection_refresh',
    'projection','global.priority_frontier',p_revision,
    jsonb_build_object('receipt_kind','PROJECTION_REFRESH','projection_key',
      'global.priority_frontier','target_invalidation_revision',p_revision,
      'source_task_id',v_task.id,'source_task_version',v_task.version))
  returning id into v_receipt_id;
  if v_record_id is null then
    insert into public.clued_memories(
      user_id,title,content,scope,project_id,record_type,status,priority,version,
      record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,
      source_refs,source_unavailable_reason,authority,observed_at,confidence,
      confidence_reason,receipt_id,content_hash)
    values(p_binding.user_id,'Global Priority Frontier — '||left(v_task.title,90),
      v_content,'global',null,'state','current',0,1,1,'active','global',v_fields,
      '{}'::jsonb,'{}'::uuid[],
      'Derived from the canonical Task identity in type_fields.','observed',now(),1,
      'System projection from a complete current source-vector.',v_receipt_id,
      repeat('0',64)) returning * into v_record;
  else
    update public.clued_memories set
      title='Global Priority Frontier — '||left(v_task.title,90),content=v_content,
      scope='global',project_id=null,record_type='state',status='current',priority=0,
      record_schema_version=1,lifecycle_status='active',canonical_scope='global',
      type_fields=v_fields,relations='{}'::jsonb,source_refs='{}'::uuid[],
      source_unavailable_reason='Derived from the canonical Task identity in type_fields.',
      authority='observed',observed_at=now(),confidence=1,
      confidence_reason='System projection from a complete current source-vector.',
      receipt_id=v_receipt_id,updated_at=now(),version=version+1
    where id=v_record_id and user_id=p_binding.user_id
      and record_type='state' returning * into v_record;
    if not found then raise exception 'frontier_projection_record_missing' using errcode='40001'; end if;
  end if;
  update public.clued_memories set content_hash=clued_private.m1_record_content_hash(
    record_type,canonical_scope,lifecycle_status,title,content,type_fields,relations,
    source_refs,source_unavailable_reason,authority,observed_at,closed_at,confidence,
    confidence_reason) where id=v_record.id returning * into v_record;
  v_snapshot:=clued_private.projection_source_snapshot(p_binding.user_id);
  v_digest:=clued_private.currentness_hash(v_snapshot);
  v_source_refs:=jsonb_build_array(jsonb_build_object('kind','record','id',v_task.id,
    'scope',v_task.canonical_scope,'version',v_task.version));
  select coalesce(max(h.projection_generation),0)+1 into v_generation
  from clued_private.projection_heads h where h.user_id=p_binding.user_id
    and h.target_scope='global' and h.projection_key='global.priority_frontier';
  update clued_private.projection_invalidation_heads set
    resolved_through_revision=p_revision,stale_since=null,updated_at=now()
  where user_id=p_binding.user_id and target_scope='global'
    and projection_key='global.priority_frontier'
    and invalidation_revision=p_revision;
  if not found then raise exception 'projection_rebuild_cas_conflict' using errcode='40001'; end if;
  insert into clued_private.projection_heads(user_id,target_scope,projection_key,
    projection_generation,resolved_through_invalidation_revision,
    source_vector_digest,source_refs,record_id,projection_owner)
  values(p_binding.user_id,'global','global.priority_frontier',v_generation,
    p_revision,v_digest,v_source_refs,v_record.id,'system_projection_builder')
  on conflict(user_id,target_scope,projection_key) do update set
    projection_generation=excluded.projection_generation,
    resolved_through_invalidation_revision=excluded.resolved_through_invalidation_revision,
    source_vector_digest=excluded.source_vector_digest,source_refs=excluded.source_refs,
    record_id=excluded.record_id,projection_owner=excluded.projection_owner,generated_at=now();
  insert into clued_private.projection_record_bindings(record_id,user_id,target_scope,
    projection_key,projection_generation,source_vector_digest,source_refs,
    resolved_through_invalidation_revision,projection_owner)
  values(v_record.id,p_binding.user_id,'global','global.priority_frontier',v_generation,
    v_digest,v_source_refs,p_revision,'system_projection_builder')
  on conflict(record_id) do update set
    projection_generation=excluded.projection_generation,
    source_vector_digest=excluded.source_vector_digest,source_refs=excluded.source_refs,
    resolved_through_invalidation_revision=excluded.resolved_through_invalidation_revision,
    projection_owner=excluded.projection_owner;
  update public.clued_audit_receipts set metadata=metadata||jsonb_build_object(
    'record_id',v_record.id,'record_version',v_record.version,
    'source_vector_digest',v_digest,'projection_generation',v_generation)
  where id=v_receipt_id;
  return jsonb_build_object('status','rebuilt','projection_key',
    'global.priority_frontier','record_id',v_record.id,'record_version',v_record.version,
    'projection_generation',v_generation,'source_vector_digest',v_digest,
    'receipt_id',v_receipt_id);
end $$;

create function clued_private.projection_refresh_aggregate_apply(
  p_binding public.clued_agent_bindings,p_revision bigint
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_snapshot jsonb; v_digest text; v_receipt_id uuid;
begin
  if exists(select 1 from clued_private.projection_invalidation_heads h
    where h.user_id=p_binding.user_id and h.target_scope='global'
      and h.projection_key<>'global.__aggregate__'
      and h.invalidation_revision>h.resolved_through_revision) then
    raise exception 'required_projection_stale' using errcode='40001';
  end if;
  if exists(select 1 from clued_private.event_truth_carriers c
    where c.user_id=p_binding.user_id and c.carrier_state='LEGACY_UNBOUND'
      and c.visibility='work_log') then
    raise exception 'legacy_currentness_unknown' using errcode='40001';
  end if;
  v_snapshot:=clued_private.projection_source_snapshot(p_binding.user_id);
  v_digest:=clued_private.currentness_hash(v_snapshot);
  update clued_private.projection_invalidation_heads set
    resolved_through_revision=p_revision,stale_since=null,updated_at=now()
  where user_id=p_binding.user_id and target_scope='global'
    and projection_key='global.__aggregate__' and invalidation_revision=p_revision;
  if not found then raise exception 'full_reconcile_cas_conflict' using errcode='40001'; end if;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,
    operation,object_type,object_id,version,metadata)
  values(p_binding.user_id,p_binding.id,'global','projection_refresh',
    'currentness','global.__aggregate__',p_revision,
    jsonb_build_object('receipt_kind','CURRENTNESS_ADMISSION',
      'admission_eligible',true,'projection_key','global.__aggregate__',
      'source_vector_digest',v_digest,'source_vector',v_snapshot,
      'resolved_through_invalidation_revision',p_revision))
  returning id into v_receipt_id;
  return jsonb_build_object('status','reconciled','projection_key','global.__aggregate__',
    'source_vector_digest',v_digest,'receipt_id',v_receipt_id,
    'resolved_through_invalidation_revision',p_revision);
end $$;

create function public.clued_mcp_projection_refresh_apply(
  p_token_hash text,p_input jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_key text:=p_input->>'projection_key';
  v_lease uuid:=(p_input->>'lease_id')::uuid;
  v_expected_revision bigint:=(p_input->>'expected_invalidation_revision')::bigint;
  v_expected_digest text:=p_input->>'expected_source_vector_digest';
  v_binding public.clued_agent_bindings%rowtype;
  v_job clued_private.projection_refresh_jobs%rowtype;
  v_head clued_private.projection_invalidation_heads%rowtype;
  v_snapshot jsonb; v_digest text; v_result jsonb; v_head_found boolean;
  v_error text; v_detail text; v_sqlstate text; v_outcome text;
begin
  if v_key not in ('global.priority_frontier','global.__aggregate__') or
     v_expected_revision is null or v_expected_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_projection_refresh_apply' using errcode='22023';
  end if;
  v_binding:=clued_private.projection_refresh_builder_binding(p_token_hash,v_key);
  perform clued_private.currentness_user_lock(v_binding.user_id);
  select * into v_job from clued_private.projection_refresh_jobs j
    where j.user_id=v_binding.user_id and j.target_scope='global'
      and j.projection_key=v_key and j.status='running'
      and j.lease_id=v_lease and j.leased_by_binding_id=v_binding.id for update;
  if not found or v_job.lease_expires_at<=pg_catalog.clock_timestamp() or
     v_job.leased_invalidation_revision is distinct from v_expected_revision or
     v_job.leased_source_vector_digest is distinct from v_expected_digest then
    raise exception 'projection_refresh_lease_invalid' using errcode='40001';
  end if;
  select * into v_head from clued_private.projection_invalidation_heads h
    where h.user_id=v_binding.user_id and h.target_scope='global'
      and h.projection_key=v_key for update;
  v_head_found:=found;
  v_snapshot:=clued_private.projection_source_snapshot(v_binding.user_id);
  v_digest:=clued_private.currentness_hash(v_snapshot);
  if not v_head_found or v_head.invalidation_revision is distinct from v_expected_revision or
     v_digest is distinct from v_expected_digest then
    update clued_private.projection_refresh_attempts set outcome='CAS_CONFLICT',
      error_code='projection_refresh_cas_conflict',
      error_detail=jsonb_build_object('expected_revision',v_expected_revision,
        'actual_revision',v_head.invalidation_revision,'expected_digest',v_expected_digest,
        'actual_digest',v_digest),finished_at=pg_catalog.clock_timestamp()
    where user_id=v_binding.user_id and projection_key=v_key and lease_id=v_lease;
    update clued_private.projection_refresh_jobs set status='queued',attempt_count=0,
      target_invalidation_revision=v_head.invalidation_revision,
      next_attempt_at=pg_catalog.clock_timestamp()+interval '250 milliseconds',
      last_error_code='projection_refresh_cas_conflict',
      last_error_detail=jsonb_build_object('expected_revision',v_expected_revision,
        'actual_revision',v_head.invalidation_revision),completed_at=null,
      lease_id=null,leased_by_binding_id=null,leased_invalidation_revision=null,
      leased_source_vector_digest=null,leased_at=null,lease_expires_at=null,
      updated_at=pg_catalog.clock_timestamp()
    where user_id=v_binding.user_id and target_scope='global' and projection_key=v_key;
    return jsonb_build_object('status','cas_conflict','projection_key',v_key,
      'discarded_invalidation_revision',v_expected_revision,
      'latest_invalidation_revision',v_head.invalidation_revision);
  end if;

  begin
    if v_key='global.priority_frontier' then
      v_result:=clued_private.projection_refresh_frontier_apply(
        v_binding,v_expected_revision);
    else
      v_result:=clued_private.projection_refresh_aggregate_apply(
        v_binding,v_expected_revision);
    end if;
  exception when others then
    get stacked diagnostics v_error=message_text,v_detail=pg_exception_detail,
      v_sqlstate=returned_sqlstate;
    v_outcome:=case when v_job.attempt_count>=v_job.max_attempts
      then 'TERMINAL_FAILURE' else 'RETRYABLE_FAILURE' end;
    update clued_private.projection_refresh_attempts set outcome=v_outcome,
      error_code=v_error,error_detail=jsonb_build_object('sqlstate',v_sqlstate,
        'detail',v_detail),finished_at=pg_catalog.clock_timestamp()
    where user_id=v_binding.user_id and projection_key=v_key and lease_id=v_lease;
    update clued_private.projection_refresh_jobs set
      status=case when attempt_count>=max_attempts then 'failed' else 'retry_wait' end,
      next_attempt_at=case when attempt_count>=max_attempts
        then pg_catalog.clock_timestamp() else pg_catalog.clock_timestamp()+
          clued_private.projection_refresh_retry_delay(attempt_count) end,
      last_error_code=v_error,last_error_detail=jsonb_build_object(
        'sqlstate',v_sqlstate,'detail',v_detail),
      lease_id=null,leased_by_binding_id=null,leased_invalidation_revision=null,
      leased_source_vector_digest=null,leased_at=null,lease_expires_at=null,
      updated_at=pg_catalog.clock_timestamp()
    where user_id=v_binding.user_id and target_scope='global' and projection_key=v_key;
    return jsonb_build_object('status',case when v_outcome='TERMINAL_FAILURE'
      then 'failed' else 'retry_wait' end,'projection_key',v_key,
      'attempt',v_job.attempt_count,'max_attempts',v_job.max_attempts,
      'error_code',v_error);
  end;

  update clued_private.projection_refresh_attempts set outcome='SUCCEEDED',
    finished_at=pg_catalog.clock_timestamp()
  where user_id=v_binding.user_id and projection_key=v_key and lease_id=v_lease;
  update clued_private.projection_refresh_jobs set status='completed',
    target_invalidation_revision=v_expected_revision,
    last_error_code=null,last_error_detail='{}'::jsonb,
    last_receipt_id=(v_result->>'receipt_id')::uuid,
    completed_at=pg_catalog.clock_timestamp(),
    lease_id=null,leased_by_binding_id=null,leased_invalidation_revision=null,
    leased_source_vector_digest=null,leased_at=null,lease_expires_at=null,
    updated_at=pg_catalog.clock_timestamp()
  where user_id=v_binding.user_id and target_scope='global' and projection_key=v_key
    and lease_id=v_lease;
  return v_result||jsonb_build_object('attempt',v_job.attempt_count,
    'resolved_invalidation_revision',v_expected_revision);
end $$;

revoke all on function clued_private.projection_refresh_retry_delay(integer),
  clued_private.projection_refresh_enqueue(uuid,text,text,bigint),
  clued_private.projection_refresh_enqueue_trigger(),
  clued_private.projection_refresh_builder_binding(text,text),
  clued_private.projection_refresh_clear_lease(uuid,text),
  clued_private.projection_refresh_frontier_apply(public.clued_agent_bindings,bigint),
  clued_private.projection_refresh_aggregate_apply(public.clued_agent_bindings,bigint)
  from public,anon,authenticated,service_role;
revoke all on function public.clued_mcp_projection_refresh_claim(text,jsonb),
  public.clued_mcp_projection_refresh_apply(text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.clued_mcp_projection_refresh_claim(text,jsonb),
  public.clued_mcp_projection_refresh_apply(text,jsonb) to anon;

notify pgrst,'reload schema';
