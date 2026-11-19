-- PR 在 GitHub 上的真实生命周期是 PR 绑定结束的唯一来源（FABLE 11-19 L1）。
-- 结束绑定只接受 GitHub 的两个事实：merged、closed。送事实的只有三处，都写同一个内部函数 work_claim_pr_end_v1：
--   webhook   clued_work_pr_merged_event_v1（Worker 网关）
--   reconcile clued_work_pr_lifecycle_report_v1（本迁移新增，常驻每轮对账，ci-admission）
--   adopt     clued_work_claim_adopt_v1（列车落地）
-- 交还合并位（clued_work_merge_slot_return_v1）只交还合并位，不再接受任何结束参数。
-- 每条 WORK_CLAIM_PR_TASK_FINISHED 回执记下送来事实的一方（metadata.source）。对账送来的每一条都说明 webhook 漏了一次。

-- 1. 结束回执带来源。锁定绑定行后判断：已合入的不被迟到的关闭覆盖，状态未变不写。
create function clued_private.work_claim_pr_finish_before_lease_pin_v1(
  b public.clued_agent_bindings,p_scope text,p_pr text,p_status text,p_source text)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare target clued_private.work_claim_pr_task_bindings_v1; receipt uuid;
begin
  select t.* into target from clued_private.work_claim_pr_task_bindings_v1 t
    join public.clued_memories m on m.id=t.task_id and m.user_id=t.user_id
    where t.user_id=b.user_id and t.repo_id=lower(split_part(p_pr,'#',1)) and t.pr_number=split_part(p_pr,'#',2)::bigint
      and coalesce(nullif(m.canonical_scope,''),case when m.project_id is null then 'global' else 'project:'||m.project_id::text end)=p_scope for update of t;
  if not found or target.status=p_status or target.status='merged' then return null; end if;
  update clued_private.work_claim_pr_task_bindings_v1 set status=p_status
    where user_id=target.user_id and repo_id=target.repo_id and pr_number=target.pr_number;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(b.user_id,b.id,p_scope,'work_claim_pr_task_finish','task',target.task_id::text,1,
      jsonb_build_object('receipt_kind','WORK_CLAIM_PR_TASK_FINISHED','repository',target.repo_id,
        'pr_number',target.pr_number,'task_id',target.task_id,'status',p_status)
      ||case when p_source is null then '{}'::jsonb else jsonb_build_object('source',p_source) end) returning id into receipt;
  return receipt;
end $$;

create or replace function clued_private.work_claim_pr_finish_before_lease_pin_v1(
  b public.clued_agent_bindings,p_scope text,p_pr text,p_status text)
returns uuid language sql volatile security definer set search_path='' as $$
  select clued_private.work_claim_pr_finish_before_lease_pin_v1(b,p_scope,p_pr,p_status,null)
$$;

-- PR 结束后 Task 没有别的 active PR 时，它的认领从现在起回到普通租约，不超过原有期限（20261112090000）。
create function clued_private.work_claim_pr_finish_v1(
  b public.clued_agent_bindings,p_scope text,p_pr text,p_status text,p_source text)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare receipt uuid; target clued_private.work_claim_pr_task_bindings_v1; v_now timestamptz:=pg_catalog.clock_timestamp();
begin
  receipt:=clued_private.work_claim_pr_finish_before_lease_pin_v1(b,p_scope,p_pr,p_status,p_source);
  if receipt is null or p_status not in ('closed','merged') then return receipt; end if;
  select * into target from clued_private.work_claim_pr_task_bindings_v1
    where user_id=b.user_id and repo_id=lower(split_part(p_pr,'#',1)) and pr_number=split_part(p_pr,'#',2)::bigint;
  if not exists(select 1 from clued_private.work_claim_pr_task_bindings_v1 o
      where o.user_id=target.user_id and o.task_id=target.task_id and o.status='active') then
    update clued_private.work_claims_v1 w
      set expires_at=v_now+make_interval(secs=>(clued_private.work_claim_profile_v1()->>'lease_seconds')::integer)
      where w.user_id=target.user_id and w.task_id=target.task_id and w.status='ACTIVE'
        and w.expires_at>v_now+make_interval(secs=>(clued_private.work_claim_profile_v1()->>'lease_seconds')::integer);
  end if;
  return receipt;
end $$;

create or replace function clued_private.work_claim_pr_finish_v1(
  b public.clued_agent_bindings,p_scope text,p_pr text,p_status text)
returns uuid language sql volatile security definer set search_path='' as $$
  select clued_private.work_claim_pr_finish_v1(b,p_scope,p_pr,p_status,null)
$$;

-- 2. 唯一的结束入口：只收 merged/closed 和三个来源之一。只有绑定真正变更时才尝试释放；释放子事务失败仍保留结束事实和回执。
create function clued_private.work_claim_pr_end_v1(
  b public.clued_agent_bindings,p_scope text,p_pr text,p_status text,p_merge_sha text,p_source text)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare receipt uuid;
begin
  if p_status is null or p_status not in ('merged','closed') or p_source is null or p_source not in ('webhook','reconcile','adopt') then
    raise exception 'work_claim_pr_end_input_invalid' using errcode='22023';
  end if;
  receipt:=clued_private.work_claim_pr_finish_v1(b,p_scope,p_pr,p_status,p_source);
  if receipt is not null then
    begin
      perform clued_private.work_claim_pr_end_release_v1(b,p_scope,p_pr,p_merge_sha);
    exception when others then
      raise warning 'work_claim_pr_end_release_skipped: % %',sqlstate,sqlerrm;
    end;
  end if;
  return receipt;
end $$;

-- 3. 交还合并位只是交还合并位：函数体里没有任何结束绑定的调用，旧的结束参数一律是输入错误。
create or replace function public.clued_work_merge_slot_return_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  if jsonb_typeof(p_input)='object' and p_input ? 'github_state' then
    raise exception 'work_claim_merge_slot_return_input_invalid' using errcode='22023';
  end if;
  return clued_private.clued_work_merge_slot_return_v1_before_pr_task(p_token_hash,p_input);
end $$;

-- 4. 列车 adopt：已合入的事实，来源 adopt（多副本判定同 20261119001000）。
create or replace function public.clued_work_claim_adopt_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb; b public.clued_agent_bindings; receipt uuid; candidates integer;
begin
  b:=clued_private.resolve_binding(p_token_hash,'context:read',coalesce(p_input->>'scope','global'));
  if clued_private.merge_slot_admits_v1(b) then
    perform clued_private.work_claim_lock(b.user_id);
    select count(*) into candidates from clued_private.work_claims_v1 c
      where c.user_id=b.user_id and c.context_key=coalesce(p_input->>'scope','global') and c.copy_index is not null
        and clued_private.work_claim_pr_matches_v1(c,p_input->>'pr_ref')
        and exists(select 1 from clued_private.work_claim_execution_admissions_v1 e
          where e.claim_id=c.claim_id and e.execution_epoch=c.execution_epoch and e.pr_ref=p_input->>'pr_ref');
    if candidates>1 then return jsonb_build_object('status','rejected','error_code','pr_task_current_claim_ambiguous'); end if;
  end if;
  result:=clued_private.clued_work_claim_adopt_v1_before_pr_task(p_token_hash,p_input);
  if result->>'status'='ok' and result->>'reason' is distinct from 'admission_binding_required' then
    receipt:=clued_private.work_claim_pr_end_v1(b,coalesce(p_input->>'scope','global'),
      p_input->>'pr_ref','merged',p_input->>'merge_sha','adopt');
    return result||jsonb_build_object('binding_receipt_id',receipt);
  end if;
  return result;
end $$;

-- 5. webhook：GitHub pull_request closed 事件，来源 webhook（输入与多用户处理同 20261119001000）。
create or replace function public.clued_work_pr_merged_event_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  v_repo text := lower(p_input->>'repository');
  v_number bigint;
  end_status text;
  pr text;
  v_user_id uuid;
  b public.clued_agent_bindings;
  v_scope text;
  v_task_id uuid;
  candidates uuid[];
  released_ids uuid[] := '{}';
  finished integer := 0;
begin
  if jsonb_typeof(p_input) is distinct from 'object' then
    raise exception 'work_pr_merged_event_input_invalid' using errcode='22023';
  end if;
  if not (p_input ?& array['repository','pr_number','merge_sha'])
      or p_input - array['repository','pr_number','merge_sha','merged'] <> '{}'::jsonb
      or (p_input ? 'merged' and jsonb_typeof(p_input->'merged') <> 'boolean')
      or jsonb_typeof(p_input->'repository') <> 'string'
      or v_repo !~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$'
      or jsonb_typeof(p_input->'pr_number') <> 'number'
      or (p_input->>'pr_number') !~ '^[1-9][0-9]{0,9}$'
      or (p_input->'merge_sha' <> 'null'::jsonb and
        (jsonb_typeof(p_input->'merge_sha') <> 'string' or (p_input->>'merge_sha') !~ '^[0-9A-Fa-f]{40}$')) then
    raise exception 'work_pr_merged_event_input_invalid' using errcode='22023';
  end if;
  -- 旧 Worker 的三字段投递只来自合入事件。
  end_status := case when p_input->'merged' = 'false'::jsonb then 'closed' else 'merged' end;
  v_number := (p_input->>'pr_number')::bigint;
  pr := v_repo || '#' || v_number::text;

  -- 多个用户可能跟踪同一 PR。按用户 ID 排序取现有认领锁，取锁后重读绑定和 Task 的范围。
  for v_user_id in select t.user_id from clued_private.work_claim_pr_task_bindings_v1 t
    where t.repo_id=v_repo and t.pr_number=v_number and t.status not in ('merged',end_status) order by t.user_id
  loop
    perform clued_private.work_claim_lock(v_user_id);
    select t.task_id,coalesce(nullif(m.canonical_scope,''),case when m.project_id is null then 'global' else 'project:'||m.project_id::text end)
      into v_task_id,v_scope from clued_private.work_claim_pr_task_bindings_v1 t
      join public.clued_memories m on m.id=t.task_id and m.user_id=t.user_id
      where t.user_id=v_user_id and t.repo_id=v_repo and t.pr_number=v_number and t.status not in ('merged',end_status);
    continue when not found;
    b.user_id := v_user_id;
    -- 同一把用户锁下，只报告本次投递释放的认领。
    select array_agg(c.claim_id) into candidates from clued_private.work_claims_v1 c
      where c.user_id=v_user_id and c.task_id=v_task_id and c.context_key=v_scope and c.status='ACTIVE';
    continue when clued_private.work_claim_pr_end_v1(b,v_scope,pr,end_status,p_input->>'merge_sha','webhook') is null;
    finished := finished + 1;
    select released_ids || coalesce(array_agg(c.claim_id order by c.claim_id),'{}'::uuid[]) into released_ids
      from clued_private.work_claims_v1 c where c.user_id=v_user_id and c.claim_id=any(candidates)
        and c.status='RELEASED' and c.released_by='pr_end';
  end loop;
  return jsonb_build_object('status','ok','finished',finished,'released',released_ids);
end $$;

-- 6. 常驻对账报告。只有 ci-admission 连接能用（与 adopt、交还合并位同一信任级别）。
--   输入 {scope?, repository, prs:[{pr_number, state:'merged'|'closed', merge_sha?}]}，prs 可为空，至多 50 条、PR 不重复；
--   state 只收这两个值，closed 不带合并提交，merged 的合并提交为 40 位十六进制或空。
--   对该账号在这个仓库里仍未结束的每条绑定，按它自己 Task 的范围调用 work_claim_pr_end_v1（来源 reconcile）。
--   返回处理之后仍未结束（active/unknown）的绑定 PR 号 tracked：常驻据此决定下一轮问 GitHub 哪些 PR。
create function public.clued_work_pr_lifecycle_report_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  b public.clued_agent_bindings;
  bad boolean := false;
  v_repo text;
  item jsonb;
  seen bigint[] := '{}';
  v_number bigint;
  v_state text;
  v_sha text;
  pr text;
  v_task_id uuid;
  v_scope text;
  candidates uuid[];
  released_ids uuid[] := '{}';
  finished integer := 0;
  tracked jsonb;
begin
  -- 逐条判断（SQL 的 or 不保证求值顺序，类型转换只在前面的判断都通过后才做）。
  if jsonb_typeof(p_input) is distinct from 'object' then bad := true;
  elsif not (p_input ?& array['repository','prs']) or p_input - array['scope','repository','prs'] <> '{}'::jsonb then bad := true;
  elsif p_input ? 'scope' and jsonb_typeof(p_input->'scope') <> 'string' then bad := true;
  elsif jsonb_typeof(p_input->'repository') <> 'string' or lower(p_input->>'repository') !~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$' then bad := true;
  elsif jsonb_typeof(p_input->'prs') <> 'array' then bad := true;
  elsif jsonb_array_length(p_input->'prs') > 50 then bad := true;
  end if;
  if bad then raise exception 'work_pr_lifecycle_report_input_invalid' using errcode='22023'; end if;
  for item in select x from jsonb_array_elements(p_input->'prs') x loop
    if jsonb_typeof(item) is distinct from 'object' then bad := true;
    elsif not (item ?& array['pr_number','state']) or item - array['pr_number','state','merge_sha'] <> '{}'::jsonb then bad := true;
    elsif jsonb_typeof(item->'pr_number') <> 'number' or (item->>'pr_number') !~ '^[1-9][0-9]{0,9}$' then bad := true;
    elsif jsonb_typeof(item->'state') <> 'string' or (item->>'state') not in ('merged','closed') then bad := true;
    elsif item ? 'merge_sha' and item->'merge_sha' <> 'null'::jsonb
        and (item->>'state' = 'closed' or jsonb_typeof(item->'merge_sha') <> 'string' or (item->>'merge_sha') !~ '^[0-9A-Fa-f]{40}$') then bad := true;
    elsif (item->>'pr_number')::bigint = any(seen) then bad := true;
    end if;
    if bad then raise exception 'work_pr_lifecycle_report_input_invalid' using errcode='22023'; end if;
    seen := seen || (item->>'pr_number')::bigint;
  end loop;

  b := clued_private.resolve_binding(p_token_hash,'context:read',coalesce(p_input->>'scope','global'));
  if not clued_private.merge_slot_admits_v1(b) then
    return jsonb_build_object('status','rejected','error_code','admission_binding_required');
  end if;
  v_repo := lower(p_input->>'repository');
  perform clued_private.work_claim_lock(b.user_id);
  for item in select x from jsonb_array_elements(p_input->'prs') x loop
    v_number := (item->>'pr_number')::bigint;
    v_state := item->>'state';
    v_sha := case when v_state = 'merged' then lower(nullif(item->>'merge_sha','')) end;
    pr := v_repo || '#' || v_number::text;
    select t.task_id,coalesce(nullif(m.canonical_scope,''),case when m.project_id is null then 'global' else 'project:'||m.project_id::text end)
      into v_task_id,v_scope from clued_private.work_claim_pr_task_bindings_v1 t
      join public.clued_memories m on m.id=t.task_id and m.user_id=t.user_id
      where t.user_id=b.user_id and t.repo_id=v_repo and t.pr_number=v_number and t.status not in ('merged',v_state);
    continue when not found;
    select array_agg(c.claim_id) into candidates from clued_private.work_claims_v1 c
      where c.user_id=b.user_id and c.task_id=v_task_id and c.context_key=v_scope and c.status='ACTIVE';
    continue when clued_private.work_claim_pr_end_v1(b,v_scope,pr,v_state,v_sha,'reconcile') is null;
    finished := finished + 1;
    select released_ids || coalesce(array_agg(c.claim_id order by c.claim_id),'{}'::uuid[]) into released_ids
      from clued_private.work_claims_v1 c where c.user_id=b.user_id and c.claim_id=any(candidates)
        and c.status='RELEASED' and c.released_by='pr_end';
  end loop;
  select coalesce(jsonb_agg(t.pr_number order by t.pr_number),'[]'::jsonb) into tracked
    from clued_private.work_claim_pr_task_bindings_v1 t
    where t.user_id=b.user_id and t.repo_id=v_repo and t.status in ('active','unknown');
  return jsonb_build_object('status','ok','repository',v_repo,'finished',finished,'released',to_jsonb(released_ids),'tracked',tracked);
end $$;

-- 旧的五参数结束入口不再有调用方。签名保留（迁移不删上一版仍可能引用的签名），但不带来源的结束一律拒绝。
create or replace function clued_private.work_claim_pr_end_v1(
  b public.clued_agent_bindings,p_scope text,p_pr text,p_status text,p_merge_sha text)
returns uuid language plpgsql volatile security definer set search_path='' as $$
begin
  raise exception 'work_claim_pr_end_source_required' using errcode='22023';
end $$;

revoke all on function
  clued_private.work_claim_pr_finish_before_lease_pin_v1(public.clued_agent_bindings,text,text,text,text),
  clued_private.work_claim_pr_finish_before_lease_pin_v1(public.clued_agent_bindings,text,text,text),
  clued_private.work_claim_pr_finish_v1(public.clued_agent_bindings,text,text,text,text),
  clued_private.work_claim_pr_finish_v1(public.clued_agent_bindings,text,text,text),
  clued_private.work_claim_pr_end_v1(public.clued_agent_bindings,text,text,text,text),
  clued_private.work_claim_pr_end_v1(public.clued_agent_bindings,text,text,text,text,text)
  from public,anon,authenticated,service_role,clued_worker_gateway;
revoke all on function public.clued_work_pr_lifecycle_report_v1(text,jsonb) from public,anon,authenticated,service_role,clued_worker_gateway;
grant execute on function public.clued_work_pr_lifecycle_report_v1(text,jsonb) to anon;

notify pgrst,'reload schema';
