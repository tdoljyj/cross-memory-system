-- MTPE Owner Pin read/write consistency (BUG Task 2ee990e4, Owner Decision a82aa0e8)
-- clued_mcp_mtpe_owner_pin accepted any active, eligible Canonical Task, but
-- mtpe_snapshot only selected an owner focus whose derived intake_kind was 'TASK'.
-- A Task carrying a backfilled type_fields.intake_kind (e.g. legacy_residual_scope)
-- was pinned and reported committed while owner_selected_current_focus stayed null.
-- 1. mtpe_snapshot selects the owner focus by Canonical record_type='task', the
--    predicate the Pin write already enforces. system_frontier is unchanged.
-- 2. clued_mcp_mtpe_owner_pin reads the Pin back through mtpe_snapshot after a set
--    and rejects it with owner_pin_not_effective when it is not selected.

create or replace function clued_private.mtpe_snapshot(p_user_id uuid)
returns jsonb
language sql
stable security definer
set search_path to ''
as $function$
  with source_candidates as (
    select p.*,m.title,m.updated_at,m.record_type,
      (f.record_id=p.record_id) as owner_selected,
      clued_private.record_currentness_fence(
        p.user_id,p.record_id,null::text[]) as record_currentness,
      -- Re-derived from the Canonical record, independent of projection freshness.
      case when m.lifecycle_status='active' then
        clued_private.mtpe_recommendation_hold(m.type_fields,
          case when m.record_type='task' then m.title end) end as recommendation_hold
    from clued_private.mtpe_intake_projection p
    join public.clued_memories m on m.id=p.record_id and m.user_id=p.user_id
    left join clued_private.mtpe_owner_focus f on f.user_id=p.user_id
    where p.user_id=p_user_id and p.candidate_status<>'TERMINAL'
      and p.priority_eligibility not in ('INELIGIBLE','DISABLED','OUT_OF_GOVERNANCE_PROFILE')
  ), candidates as (
    select s.*,
      case when s.record_currentness<>'CURRENT' then 'BLOCKED_HARD_GATE'
        when s.recommendation_hold is not null and s.executability='READY' then 'DEFERRED'
        else s.executability end as effective_executability,
      case when s.record_currentness<>'CURRENT' then 'ACTIVE_BLOCKED'
        when s.recommendation_hold is not null and s.candidate_status='ACTIVE_READY'
          then 'DEFERRED_WITH_TRIGGER'
        else s.candidate_status end as effective_candidate_status,
      case when s.record_currentness='CURRENT' then s.hard_gate_blockers
        else s.hard_gate_blockers||jsonb_build_array(jsonb_build_object(
          'code','RECORD_CURRENTNESS_'||s.record_currentness,
          'source','record_currentness_fence')) end as effective_hard_gate_blockers
    from source_candidates s
  ), system_priority as (
    select * from candidates where recommendation_hold is null
      order by algorithm_priority desc,source_record_version desc,record_id limit 1
  ), system_frontier as (
    -- The executable Context v2 Frontier is Task-only and never contains a
    -- backlog / later / 暂缓 / do-not-recommend Task.
    select * from candidates where intake_kind='TASK' and effective_executability='READY'
      and effective_candidate_status='ACTIVE_READY' and recommendation_hold is null
      order by algorithm_priority desc,source_record_version desc,record_id limit 1
  ), owner_focus as (
    -- Same target predicate as clued_mcp_mtpe_owner_pin: a Canonical Task. A
    -- backfilled type_fields.intake_kind label must not hide an accepted Pin.
    select * from candidates where owner_selected and record_type='task'
      order by record_id limit 1
  ), owner_focus_selectable as (
    select * from owner_focus where recommendation_hold is null
  ), selected as (
    select * from owner_focus_selectable union all
    select * from system_frontier where not exists(select 1 from owner_focus_selectable) limit 1
  ), universe as (
    select coalesce(jsonb_agg(jsonb_build_object('record_id',record_id,
      'record_version',source_record_version,'scope',canonical_scope,'intake_kind',intake_kind,
      'owner_track',owner_track,'affected_tracks',affected_tracks,
      'criticality',criticality,'algorithm_priority',algorithm_priority,
      'priority_band',priority_band,'priority_eligibility',priority_eligibility,
      'executability',effective_executability,'record_currentness',record_currentness,
      'candidate_status',effective_candidate_status,
      'recommendation_hold',recommendation_hold,
      'input_digest',input_digest) order by record_id),'[]'::jsonb) value
    from candidates
  )
  select jsonb_build_object('status','ok','rule_set','mtpe-universal-intake.v1',
    'eligibility_rule','mtpe-frontier-eligibility.v2.1',
    'frontier_status',case when exists(select 1 from selected) then 'SELECTED'
      else 'NO_ELIGIBLE_CANDIDATE' end,
    'candidate_universe',universe.value,
    'candidate_universe_digest',clued_private.currentness_hash(universe.value),
    'system_recommended_priority',(select jsonb_build_object('record_id',record_id,
      'record_version',source_record_version,'algorithm_priority',algorithm_priority,
      'priority_band',priority_band,'executability',effective_executability,
      'record_currentness',record_currentness) from system_priority),
    'system_recommended_frontier',(select jsonb_build_object('record_id',record_id,
      'record_version',source_record_version,'algorithm_priority',algorithm_priority,
      'priority_band',priority_band,'executability',effective_executability,
      'record_currentness',record_currentness) from system_frontier),
    'owner_selected_current_focus',(select jsonb_build_object('record_id',record_id,
      'record_version',source_record_version,'algorithm_priority',algorithm_priority,
      'priority_band',priority_band,'executability',effective_executability,
      'record_currentness',record_currentness,'recommendation_hold',recommendation_hold,
      'status',case when recommendation_hold is not null then 'OWNER_SELECTED_DEFERRED'
        when effective_executability='READY' then 'OWNER_SELECTED_READY'
        else 'OWNER_SELECTED_BLOCKED' end,
      'hard_gate_blockers',effective_hard_gate_blockers,
      'dependency_blockers',dependency_blockers) from owner_focus),
    'selected_frontier',(select jsonb_build_object('record_id',record_id,
      'record_version',source_record_version,'algorithm_priority',algorithm_priority,
      'priority_band',priority_band,'executability',effective_executability,
      'record_currentness',record_currentness,
      'selection_source',case when owner_selected then 'OWNER_PIN' else 'SYSTEM_RECOMMENDED' end)
      from selected)) from universe
$function$;

create or replace function public.clued_mcp_mtpe_owner_pin(p_token_hash text, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare pre public.clued_agent_bindings%rowtype; b public.clued_agent_bindings%rowtype;
  r public.clued_memories%rowtype; receipt public.clued_audit_receipts%rowtype;
  v_operation text:=lower(coalesce(p_input->>'operation',''));
  v_record_id uuid; v_base bigint; v_event_id text; v_error text; v_state text;
  v_refs jsonb; v_result jsonb; v_source jsonb;
begin
  begin v_record_id:=(p_input->>'record_id')::uuid;
    v_base:=(p_input->>'base_version')::bigint;
  exception when others then
    raise exception 'invalid_mtpe_owner_pin_target' using errcode='22023';
  end;
  select * into pre from public.clued_agent_bindings where token_hash=p_token_hash;
  if not found then raise exception 'binding_not_authorized' using errcode='42501'; end if;
  select * into r from public.clued_memories
    where id=v_record_id and user_id=pre.user_id and record_schema_version=1;
  if not found then raise exception 'record_not_found' using errcode='P0002'; end if;
  b:=clued_private.resolve_binding_action_v12(p_token_hash,'context:write',
    r.canonical_scope,'write');
  receipt:=clued_private.m1_begin_receipt(b.user_id,b.id,'mtpe_owner_pin',p_input,
    clued_private.m1_sha256(p_input));
  if receipt.status<>'pending' then
    return coalesce(receipt.canonical_result,clued_private.m1_result_envelope(receipt))
      ||jsonb_build_object('replayed',receipt.related_receipt_id is null);
  end if;
  v_refs:=jsonb_build_array(jsonb_build_object('role','primary','kind','record','id',r.id));
  begin
    if v_operation not in ('set','cancel') or v_base is null or v_base<=0
      or coalesce((p_input->>'user_confirmed')::boolean,false)=false then
      raise exception 'invalid_mtpe_owner_pin_request' using errcode='22023';
    end if;
    perform clued_private.currentness_user_lock(b.user_id);
    select * into r from public.clued_memories
      where id=v_record_id and user_id=b.user_id and record_schema_version=1 for update;
    if not found then raise exception 'record_not_found' using errcode='P0002'; end if;
    if r.version<>v_base then raise exception 'record_version_conflict' using errcode='40001'; end if;
    if r.record_type<>'task' or r.lifecycle_status<>'active' or not exists(select 1
      from clued_private.mtpe_intake_projection p
      where p.user_id=b.user_id and p.record_id=r.id and p.candidate_status<>'TERMINAL'
        and p.priority_eligibility not in ('INELIGIBLE','DISABLED','OUT_OF_GOVERNANCE_PROFILE'))
      then raise exception 'owner_pin_target_not_eligible' using errcode='22023'; end if;
    -- A backlog / later / 暂缓 / do-not-recommend Task can never be pinned as NOW.
    if v_operation='set'
      and clued_private.mtpe_recommendation_hold(r.type_fields,r.title) is not null then
      raise exception 'owner_pin_target_deferred' using errcode='22023';
    end if;
    if v_operation='set' then
      insert into clued_private.mtpe_owner_focus(user_id,record_id,source_record_version,
        selected_at,source_receipt_id,reason)
      values(b.user_id,r.id,r.version,now(),receipt.id,nullif(btrim(p_input->>'reason'),''))
      on conflict(user_id) do update set record_id=excluded.record_id,
        source_record_version=excluded.source_record_version,selected_at=excluded.selected_at,
        source_receipt_id=excluded.source_receipt_id,reason=excluded.reason;
      -- Read the Pin back through the same snapshot every reader uses; a Pin the
      -- snapshot does not select is rejected (and rolled back), never committed.
      if clued_private.mtpe_snapshot(b.user_id)->'owner_selected_current_focus'->>'record_id'
        is distinct from r.id::text then
        raise exception 'owner_pin_not_effective' using errcode='22023';
      end if;
    else
      delete from clued_private.mtpe_owner_focus
        where user_id=b.user_id and record_id=r.id;
      if not found then raise exception 'owner_pin_not_current' using errcode='40001'; end if;
    end if;
    v_source:=jsonb_build_object('kind','owner_pin','id',r.id,'scope',r.canonical_scope,
      'record_version',r.version,'operation',v_operation);
    insert into clued_private.projection_invalidation_heads(user_id,target_scope,
      projection_key,invalidation_revision,latest_source_ref,stale_since)
    values(b.user_id,'global','global.priority_frontier',1,v_source,now()),
          (b.user_id,'global','global.__aggregate__',1,v_source,now())
    on conflict(user_id,target_scope,projection_key) do update set
      invalidation_revision=clued_private.projection_invalidation_heads.invalidation_revision+1,
      latest_source_ref=excluded.latest_source_ref,
      stale_since=coalesce(clued_private.projection_invalidation_heads.stale_since,now()),
      updated_at=now();
    v_event_id:=clued_private.m1_append_event_row(b.user_id,b.id,receipt.id,
      receipt.canonical_version,'extension:mtpe:owner_pin',v_refs,r.canonical_scope,null,
      jsonb_build_array('owner_pin_'||v_operation),p_input->>'idempotency_key',
      receipt.request_sha256,'success','work_log','{}','[]',null);
    v_result:=clued_private.m1_finish_receipt(receipt.id,'committed',v_refs,
      jsonb_build_object(r.id::text,r.version),jsonb_build_object(r.id::text,r.version),
      array[v_event_id],'{}',null);
    return v_result||jsonb_build_object('replayed',false,'supplemental',
      jsonb_build_object('owner_focus',clued_private.mtpe_snapshot(b.user_id)
        ->'owner_selected_current_focus'));
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    v_result:=clued_private.m1_finish_receipt(receipt.id,
      case when v_state in ('22023','40001','42501','P0002') then 'rejected' else 'failed' end,
      v_refs,jsonb_build_object(r.id::text,v_base),'{}','{}','{}',v_error);
    return v_result||jsonb_build_object('replayed',false);
  end;
end $function$;
