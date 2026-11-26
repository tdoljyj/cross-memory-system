-- GitHub 投递没有发送者绑定。保留 CI 绑定的通知逻辑及原有授权。
do $event_notify$
declare
  body text := pg_catalog.pg_get_functiondef(
    'clued_private.work_claim_pr_end_notify_v1(public.clued_agent_bindings,clued_private.work_claims_v1,text,text,text)'::regprocedure);
  anchor text := E'begin\n  perform clued_private.agent_message_lock(c.user_id);';
begin
  if (length(body)-length(replace(body,anchor,'')))/length(anchor) <> 1 then
    raise exception 'work_claim_pr_end_notify_source_unexpected';
  end if;
  execute replace(body,anchor,replace(anchor,E'begin\n',E'begin\n  if b.id is null then return; end if;\n'));
end $event_notify$;

create function public.clued_work_pr_merged_event_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  v_repo text := lower(p_input->>'repository');
  v_number bigint;
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
      or p_input - array['repository','pr_number','merge_sha'] <> '{}'::jsonb
      or jsonb_typeof(p_input->'repository') <> 'string'
      or v_repo !~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$'
      or jsonb_typeof(p_input->'pr_number') <> 'number'
      or (p_input->>'pr_number') !~ '^[1-9][0-9]{0,9}$'
      or (p_input->'merge_sha' <> 'null'::jsonb and
        (jsonb_typeof(p_input->'merge_sha') <> 'string' or (p_input->>'merge_sha') !~ '^[0-9A-Fa-f]{40}$')) then
    raise exception 'work_pr_merged_event_input_invalid' using errcode='22023';
  end if;
  v_number := (p_input->>'pr_number')::bigint;
  pr := v_repo || '#' || v_number::text;

  -- 多个用户可能跟踪同一 PR。按用户 ID 排序取现有认领锁，取锁后重读绑定和 Task 的范围。
  for v_user_id in select t.user_id from clued_private.work_claim_pr_task_bindings_v1 t
    where t.repo_id=v_repo and t.pr_number=v_number and t.status in ('active','unknown') order by t.user_id
  loop
    perform clued_private.work_claim_lock(v_user_id);
    select t.task_id,coalesce(nullif(m.canonical_scope,''),case when m.project_id is null then 'global' else 'project:'||m.project_id::text end)
      into v_task_id,v_scope from clued_private.work_claim_pr_task_bindings_v1 t
      join public.clued_memories m on m.id=t.task_id and m.user_id=t.user_id
      where t.user_id=v_user_id and t.repo_id=v_repo and t.pr_number=v_number and t.status in ('active','unknown');
    continue when not found;
    b.user_id := v_user_id;
    continue when clued_private.work_claim_pr_finish_v1(b,v_scope,pr,'merged') is null;
    finished := finished + 1;
    begin
      -- 既有释放函数返回 void。只报告本次持锁期间从 ACTIVE 变成 RELEASED 的认领。
      select array_agg(c.claim_id) into candidates from clued_private.work_claims_v1 c
        where c.user_id=v_user_id and c.task_id=v_task_id and c.context_key=v_scope and c.status='ACTIVE';
      perform clued_private.work_claim_pr_end_release_v1(b,v_scope,pr,p_input->>'merge_sha');
      select released_ids || coalesce(array_agg(c.claim_id order by c.claim_id),'{}'::uuid[]) into released_ids
        from clued_private.work_claims_v1 c where c.user_id=v_user_id and c.claim_id=any(candidates)
          and c.status='RELEASED' and c.released_by='pr_end';
    exception when others then
      raise warning 'work_claim_pr_end_release_skipped: % %',sqlstate,sqlerrm;
    end;
  end loop;
  return jsonb_build_object('status','ok','finished',finished,'released',released_ids);
end $$;

revoke all on function public.clued_work_pr_merged_event_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_work_pr_merged_event_v1(jsonb) to clued_worker_gateway;
notify pgrst,'reload schema';
