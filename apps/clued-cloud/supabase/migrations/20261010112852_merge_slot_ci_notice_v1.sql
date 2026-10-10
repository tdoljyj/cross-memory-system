-- CI failure notices for the merge slot (Task 58c083f5; Owner Decisions
-- 6678e107 and 5d7d3913). No timeout, waiting-PR or review notices.
-- Ordinary messages keep their hourly budget; only this private helper can
-- insert an exempt notice. Receipts omit the body, as agent_message_send does.
alter table clued_private.agent_messages_v1
  add column rate_limit_exempt boolean not null default false;

-- Preserve the current send function (including the account switch) and
-- fail closed if the exact budget-count anchor changed.
do $patch$ declare v_definition text; v_patched text;
begin
  v_definition:=pg_get_functiondef('public.clued_agent_message_send_v1(text,jsonb)'::regprocedure);
  v_patched:=replace(v_definition,
    'and m.created_at>v_now-interval ''1 hour'';',
    'and m.created_at>v_now-interval ''1 hour'' and not m.rate_limit_exempt;');
  if v_patched=v_definition then raise exception 'ci_notice_message_budget_anchor_missing'; end if;
  execute v_patched;
end $patch$;

create function clued_private.work_claim_ci_notice_v1(
  p_binding public.clued_agent_bindings,p_claim clued_private.work_claims_v1,
  p_pr text,p_head text,p_reason text
) returns boolean language plpgsql volatile security definer set search_path='' as $$
declare v_target public.clued_agent_bindings%rowtype;
  v_id uuid:=extensions.gen_random_uuid(); v_receipt uuid;
  v_now timestamptz:=pg_catalog.clock_timestamp();
  v_key text:='ci-failed:'||p_claim.claim_id::text||':'||lower(p_head);
  v_subject text:=left('CI 失败：'||p_pr||' 合并位已退回',200);
  v_body text:='提交：'||lower(p_head)||E'\n原因：'||coalesce(p_reason,'CI required check failed')
    ||E'\n下一步：修好后 push，用新 head 续期认领，并带 merge 引用重新入队。';
  v_refs text[]; v_hash text;
begin
  -- A same-account, readable recipient; a missing or denied recipient must
  -- never prevent returning the slot. Respect the Owner's message switch.
  if p_claim.user_id is distinct from p_binding.user_id
      or not clued_private.agent_messages_enabled_v1(p_binding.user_id) then return false; end if;
  select * into v_target from public.clued_agent_bindings b
    where b.id=p_claim.holder_binding_id and b.user_id=p_binding.user_id for share;
  if not found or v_target.revoked_at is not null
      or (to_jsonb(v_target)->>'expires_at')::timestamptz<=v_now
      or not('context:read'=any(v_target.scopes))
      or not('*'=any(v_target.context_keys) or p_claim.context_key=any(v_target.context_keys)) then
    return false;
  end if;
  begin
    perform clued_private.authorization_account_v12(v_target.user_id);
    perform clued_private.authorization_assert_entry_v12(v_target.id,'scope',p_claim.context_key,'canonical','read');
  exception when insufficient_privilege then return false;
  end;
  perform clued_private.agent_message_lock(p_binding.user_id);
  -- Claim/head idempotency also survives a replacement CI Binding.
  if exists(select 1 from clued_private.agent_messages_v1 m
      where m.user_id=p_binding.user_id and m.idempotency_key=v_key and m.rate_limit_exempt) then
    return false;
  end if;
  v_refs:=clued_private.agent_message_normalize_refs(
    jsonb_build_array('pr:'||split_part(p_pr,'#',2),'task:'||p_claim.task_id::text));
  v_hash:=encode(pg_catalog.sha256(convert_to(jsonb_build_object('operation','work_claim_ci_notice',
    'scope',p_claim.context_key,'claim_id',p_claim.claim_id,'head_sha',lower(p_head),
    'subject',v_subject,'body',v_body,'refs',to_jsonb(v_refs))::text,'UTF8')),'hex');
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,
    object_type,object_id,version,metadata)
  values(p_binding.user_id,p_binding.id,p_claim.context_key,'agent_message_send','agent_message',
    v_id::text,1,jsonb_build_object('receipt_kind','AGENT_MESSAGE_SENT',
      'message_id',v_id,'thread_id',v_id,'reply_to',null,'kind','info',
      'sender_session_ref',null,'to_claim_id',p_claim.claim_id,'to_binding_id',v_target.id,
      'to_session_ref',p_claim.holder_session_ref,'refs',to_jsonb(v_refs),'answers',false,'close_thread',false,
      'subject_chars',char_length(v_subject),'body_chars',char_length(v_body),'source','merge_slot_ci'))
  returning id into v_receipt;
  insert into clued_private.agent_messages_v1(message_id,user_id,context_key,thread_id,kind,
    sender_binding_id,to_claim_id,to_binding_id,to_session_ref,subject,body,refs,
    idempotency_key,request_hash,created_at,expires_at,receipt_id,rate_limit_exempt)
  values(v_id,p_binding.user_id,p_claim.context_key,v_id,'info',p_binding.id,
    p_claim.claim_id,v_target.id,p_claim.holder_session_ref,v_subject,v_body,v_refs,v_key,v_hash,v_now,
    v_now+make_interval(secs=>(clued_private.agent_message_profile_v1()->>'retention_seconds')::integer),v_receipt,true);
  return true;
end $$;

create or replace function public.clued_work_merge_slot_touch_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; c clued_private.work_claims_v1%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global'); v_pr text:=nullif(btrim(coalesce(p_input->>'pr_ref','')),'');
  v_head text:=lower(nullif(btrim(coalesce(p_input->>'head_sha','')),'')); v_state text:=p_input->>'ci_state';
  v_cap integer; v_now timestamptz:=pg_catalog.clock_timestamp(); v_touched uuid[]:='{}'::uuid[];
  v_returned uuid[]; v_notified uuid[]:='{}'::uuid[]; v_reason text; v_until timestamptz; v_prefix text;
begin
  if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k
        where k not in ('scope','pr_ref','head_sha','ci_state','hard_cap_minutes','reason')) then
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
  if p_input ? 'reason' then
    if jsonb_typeof(p_input->'reason') is distinct from 'string'
        or char_length(p_input->>'reason') not between 1 and 300
        or (p_input->>'reason') ~ '[[:cntrl:]]' then
      raise exception 'work_claim_merge_slot_reason_invalid' using errcode='22023'; end if;
    v_reason:=p_input->>'reason';
  end if;
  perform clued_private.work_claim_lock(v_binding.user_id);
  if v_state='failed' then
    v_returned:=clued_private.work_claim_merge_slot_return_core_v1(v_binding.user_id,v_binding.id,v_scope,v_pr,
      'ci_failed',jsonb_build_object('head_sha',v_head));
    for c in select * from clued_private.work_claims_v1 w where w.claim_id=any(v_returned) loop
      if clued_private.work_claim_ci_notice_v1(v_binding,c,v_pr,v_head,v_reason) then
        v_notified:=v_notified||c.claim_id;
      end if;
    end loop;
    return jsonb_build_object('status','ok','ci_state',v_state,'pr_ref',v_pr,'head_sha',v_head,
      'notified',to_jsonb(v_notified),'returned',cardinality(v_returned)>0,'merge_slot_returned',to_jsonb(v_returned));
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
create or replace function public.clued_work_merge_slot_holders_v1(p_token_hash text,p_input jsonb) returns jsonb
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
    select jsonb_agg(jsonb_build_object('claim_id',w.claim_id,'bound_pr',w.bound_pr,'progress_ref',w.progress_ref,
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


revoke all on function clued_private.work_claim_ci_notice_v1(
  public.clued_agent_bindings,clued_private.work_claims_v1,text,text,text)
  from public,anon,authenticated,service_role;
revoke all on function public.clued_work_merge_slot_touch_v1(text,jsonb),
  public.clued_work_merge_slot_holders_v1(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_work_merge_slot_touch_v1(text,jsonb),
  public.clued_work_merge_slot_holders_v1(text,jsonb) to anon;
notify pgrst,'reload schema';
