-- 在锁定的绑定行上判断终态，迟到的关闭消息不能覆盖已合入的事实。
create or replace function clued_private.work_claim_pr_finish_before_lease_pin_v1(b public.clued_agent_bindings,p_scope text,p_pr text,p_status text)
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
        'pr_number',target.pr_number,'task_id',target.task_id,'status',p_status)) returning id into receipt;
  return receipt;
end $$;

-- 只有绑定真正变更时才尝试释放。释放子事务失败仍保留结束事实和回执。
create function clued_private.work_claim_pr_end_v1(
  b public.clued_agent_bindings,p_scope text,p_pr text,p_status text,p_merge_sha text)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare receipt uuid;
begin
  receipt:=clued_private.work_claim_pr_finish_v1(b,p_scope,p_pr,p_status);
  if receipt is not null then
    begin
      perform clued_private.work_claim_pr_end_release_v1(b,p_scope,p_pr,p_merge_sha);
    exception when others then
      raise warning 'work_claim_pr_end_release_skipped: % %',sqlstate,sqlerrm;
    end;
  end if;
  return receipt;
end $$;

revoke all on function clued_private.work_claim_pr_end_v1(public.clued_agent_bindings,text,text,text,text)
  from public,anon,authenticated,service_role,clued_worker_gateway;

create or replace function public.clued_work_merge_slot_return_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb; b public.clued_agent_bindings; receipt uuid;
  scope text:=coalesce(p_input->>'scope','global');
  slot_input jsonb:=p_input;
begin
  if p_input ? 'github_state' then
    if p_input->>'github_state' is distinct from 'closed' then
      raise exception 'work_claim_merge_slot_return_input_invalid' using errcode='22023';
    end if;
    slot_input:=p_input-'github_state';
  end if;
  result:=clued_private.clued_work_merge_slot_return_v1_before_pr_task(p_token_hash,slot_input);
  if result->>'status'='ok' and result->>'reason' is distinct from 'admission_binding_required' then
    if p_input ? 'github_state' then
      b:=clued_private.resolve_binding(p_token_hash,'context:read',scope);
      receipt:=clued_private.work_claim_pr_end_v1(b,scope,p_input->>'pr_ref','closed',null);
    end if;
    return result||jsonb_build_object('binding_receipt_id',receipt);
  end if;
  return result;
end $$;

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
      p_input->>'pr_ref','merged',p_input->>'merge_sha');
    return result||jsonb_build_object('binding_receipt_id',receipt);
  end if;
  return result;
end $$;

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
    continue when clued_private.work_claim_pr_end_v1(b,v_scope,pr,end_status,p_input->>'merge_sha') is null;
    finished := finished + 1;
    select released_ids || coalesce(array_agg(c.claim_id order by c.claim_id),'{}'::uuid[]) into released_ids
      from clued_private.work_claims_v1 c where c.user_id=v_user_id and c.claim_id=any(candidates)
        and c.status='RELEASED' and c.released_by='pr_end';
  end loop;
  return jsonb_build_object('status','ok','finished',finished,'released',released_ids);
end $$;

-- 已从 GitHub 核对这十个 PR。只校正仍为 active 的绑定状态，保留认领与历史回执。
update clued_private.work_claim_pr_task_bindings_v1 t set status=ended.status
from (values (1122,'closed'),(1125,'closed'),(1135,'merged'),(1139,'merged'),(1143,'merged'),
             (1150,'merged'),(1153,'merged'),(1154,'merged'),(1161,'merged'),(1162,'merged')) as ended(pr_number,status)
where t.repo_id='tdoljyj/cross-memory-system' and t.pr_number=ended.pr_number and t.status='active';

notify pgrst,'reload schema';
