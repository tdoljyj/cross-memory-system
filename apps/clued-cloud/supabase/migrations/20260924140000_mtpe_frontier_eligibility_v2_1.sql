-- MTPE frontier eligibility v2.1 (mtpe-frontier-eligibility.v2.1)
-- Follow-up to mtpe_frontier_eligibility_v2 (production history 20260923093612),
-- from the fresh-context independent review of PR #301:
-- 1. A current explicit empty Frontier (NO_ELIGIBLE_CANDIDATE) resolves as
--    status NONE instead of PROJECTION_REQUIRED, so the G6 gate, restore and the
--    manual builder no longer report a valid "no NOW" as a missing projection.
-- 2. The regression suite's ready control uses the 'next' bucket, so it no longer
--    aborts on clued_now_global_uidx for a user who already has a global 'now' Task.
-- 3. The title keyword marker is a fallback only: it applies to Tasks only, an
--    explicit structured hold_status / recommendation clears it, negated phrases
--    (解除暂缓 / 不再搁置 / 取消暂缓) are not holds, and only the hyphenated or
--    underscored do-not-recommend token counts. Title-only holds are reported by
--    mtpe_validation as an informational title_only_hold count.
-- 4. mtpe_frontier_regression_suite is revoked from service_role as well.
-- 5. An owner-approved, exact-manifest one-shot continuity-only resolution for the
--    three direct work_log Events 1218 / 1231 / 1232 whose ACTIVE_UNSTRUCTURED
--    carriers shadow every global and project 0597aa60 State/Task record. It only
--    defines the function; execution requires a separate Owner approval Decision.

create or replace function clued_private.mtpe_recommendation_hold(p_type_fields jsonb, p_title text)
returns text
language plpgsql
immutable
set search_path to ''
as $function$
declare tf jsonb:=case when jsonb_typeof(p_type_fields)='object' then p_type_fields else '{}'::jsonb end;
  v_bucket text:=lower(btrim(coalesce(tf->>'execution_bucket','')));
  v_rec text:=upper(regexp_replace(btrim(coalesce(tf->>'recommendation',
    tf->>'recommendation_status',tf->>'system_recommendation','')),'[-\s]+','_','g'));
  v_hold text:=upper(regexp_replace(btrim(coalesce(tf->>'hold_status',
    tf->>'owner_hold','')),'[-\s]+','_','g'));
begin
  if clued_private.mtpe_bool(tf->>'do_not_recommend')
    or v_rec in ('DO_NOT_RECOMMEND','NOT_RECOMMENDED','SUPPRESSED') then
    return 'DO_NOT_RECOMMEND';
  end if;
  if v_bucket in ('later','backlog','someday','icebox','parked','deferred',
    'hold','on_hold','paused','frozen') then
    return 'EXECUTION_BUCKET_'||upper(v_bucket);
  end if;
  if clued_private.mtpe_bool(tf->>'on_hold') or clued_private.mtpe_bool(tf->>'deferred')
    or clued_private.mtpe_bool(tf->>'paused')
    or v_hold in ('TRUE','ON_HOLD','HOLD','DEFERRED','PAUSED','FROZEN','暂缓','搁置','冻结') then
    return 'OWNER_HOLD';
  end if;
  -- An explicit structured release wins over the title fallback.
  if v_hold in ('NONE','FALSE','CLEAR','CLEARED','RELEASED','RESUMED','ACTIVE',
      '解除','已解除','恢复','已恢复')
    or v_rec in ('RECOMMEND','RECOMMENDED','ALLOWED') then
    return null;
  end if;
  -- Title fallback (callers pass a title only for Tasks).
  if coalesce(p_title,'') ~ '((?<!解除|不再|取消)(暂缓|搁置)|暂不推进|暂时不考虑|——冻结)'
    or coalesce(p_title,'') ~* 'do[-_]not[-_]recommend' then
    return 'TITLE_HOLD_MARKER';
  end if;
  return null;
end $function$;

create or replace function clued_private.mtpe_sync_record(p_record_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare r public.clued_memories%rowtype; v_kind text; v_track text; v_criticality text;
  v_hard jsonb; v_deps jsonb; v_affected text[]; v_eligible text;
  v_executability text; v_disposition text; v_candidate text;
  v_raw_eligibility text; v_raw_executability text; v_hold text;
  v_score integer; v_inputs jsonb; v_digest text; v_base integer;
  v_risk integer; v_impact integer; v_unlock integer; v_time integer; v_cost integer;
  v_frontier integer; v_explicit integer;
begin
  select * into r from public.clued_memories where id=p_record_id;
  if not found or r.record_schema_version is null then return; end if;
  v_kind:=clued_private.mtpe_intake_kind(r.record_type,coalesce(r.type_fields,'{}'));
  if v_kind='NOT_ACTIONABLE' or upper(coalesce(r.type_fields->>'governance_profile',''))=
    'OUT_OF_GOVERNANCE_PROFILE' then
    delete from clued_private.mtpe_intake_projection
      where user_id=r.user_id and record_id=r.id;
    if r.lifecycle_status<>'active' then
      delete from clued_private.mtpe_owner_focus where user_id=r.user_id and record_id=r.id;
    end if;
    return;
  end if;
  v_track:=clued_private.mtpe_owner_track(v_kind,coalesce(r.type_fields,'{}'));
  v_criticality:=clued_private.mtpe_criticality(v_kind,coalesce(r.type_fields,'{}'));
  v_hard:=clued_private.mtpe_json_array(coalesce(r.type_fields->'hard_gate_blockers','[]'));
  v_deps:=clued_private.mtpe_json_array(coalesce(r.type_fields->'dependency_blockers','[]'));
  if r.type_fields ? 'hard_gate_blockers'
    and jsonb_typeof(r.type_fields->'hard_gate_blockers')<>'array' then
    v_hard:=v_hard||jsonb_build_array(jsonb_build_object(
      'code','INVALID_HARD_GATE_BLOCKERS','source','canonical_record'));
  end if;
  if r.type_fields ? 'dependency_blockers'
    and jsonb_typeof(r.type_fields->'dependency_blockers')<>'array' then
    v_hard:=v_hard||jsonb_build_array(jsonb_build_object(
      'code','INVALID_DEPENDENCY_BLOCKERS','source','canonical_record'));
  end if;
  if r.record_type='task' and r.type_fields->>'execution_bucket'='blocked'
    and jsonb_array_length(v_deps)=0 then
    v_deps:=jsonb_build_array(jsonb_build_object('code','EXECUTION_BUCKET_BLOCKED',
      'source','canonical_task'));
  end if;
  v_affected:=clued_private.mtpe_text_array(coalesce(r.type_fields->'affected_tracks','[]'));
  v_raw_eligibility:=upper(nullif(btrim(coalesce(
    r.type_fields->>'priority_eligibility','')),''));
  v_raw_executability:=upper(nullif(btrim(coalesce(
    r.type_fields->>'executability','')),''));
  -- Legacy writers stored priority_eligibility as a JSON boolean and executability
  -- as a bare BLOCKED. Normalise them deterministically (fail-closed for BLOCKED).
  v_raw_eligibility:=case when v_raw_eligibility in ('TRUE','YES','1') then 'ELIGIBLE'
    when v_raw_eligibility in ('FALSE','NO','0') then 'INELIGIBLE'
    else v_raw_eligibility end;
  v_raw_executability:=case when v_raw_executability='BLOCKED' then 'BLOCKED_HARD_GATE'
    else v_raw_executability end;
  if r.lifecycle_status<>'active' then v_eligible:='TERMINAL';
  elsif v_raw_eligibility is null then v_eligible:='ELIGIBLE';
  elsif v_raw_eligibility in ('ELIGIBLE','INELIGIBLE','DISABLED',
    'OUT_OF_GOVERNANCE_PROFILE','DEFERRED_WITH_TRIGGER') then
    v_eligible:=v_raw_eligibility;
  else
    v_eligible:='UNKNOWN_INVALID';
    v_hard:=v_hard||jsonb_build_array(jsonb_build_object(
      'code','INVALID_PRIORITY_ELIGIBILITY','value',v_raw_eligibility,
      'source','canonical_record'));
  end if;
  if r.lifecycle_status<>'active' then v_executability:='TERMINAL';
  elsif jsonb_array_length(v_hard)>0 then v_executability:='BLOCKED_HARD_GATE';
  elsif jsonb_array_length(v_deps)>0 then v_executability:='BLOCKED_DEPENDENCY';
  elsif v_raw_executability in ('READY','SCHEDULED','DEFERRED')
    then v_executability:=v_raw_executability;
  elsif v_raw_executability='BLOCKED_HARD_GATE' then
    v_executability:='BLOCKED_HARD_GATE';
    v_hard:=jsonb_build_array(jsonb_build_object(
      'code','EXPLICIT_HARD_GATE','source','canonical_record'));
  elsif v_raw_executability='BLOCKED_DEPENDENCY' then
    v_executability:='BLOCKED_DEPENDENCY';
    v_deps:=jsonb_build_array(jsonb_build_object(
      'code','EXPLICIT_DEPENDENCY_BLOCK','source','canonical_record'));
  elsif r.type_fields->>'execution_bucket'='later' and v_eligible='DEFERRED_WITH_TRIGGER'
    then v_executability:='DEFERRED';
  elsif v_raw_executability is null then v_executability:='READY';
  else
    v_executability:='BLOCKED_HARD_GATE';
    v_hard:=jsonb_build_array(jsonb_build_object(
      'code','INVALID_EXECUTABILITY','value',v_raw_executability,
      'source','canonical_record'));
  end if;
  -- backlog / later / 暂缓 / do-not-recommend can never be READY for arbitration.
  v_hold:=case when r.lifecycle_status='active'
    then clued_private.mtpe_recommendation_hold(r.type_fields,
      case when r.record_type='task' then r.title end) end;
  if v_hold is not null and v_executability='READY' then v_executability:='DEFERRED'; end if;
  v_base:=case v_criticality when 'CRITICAL' then 45 when 'HIGH' then 35
    when 'NORMAL' then 22 else 10 end;
  v_frontier:=case when clued_private.mtpe_bool(r.type_fields->>'current_frontier_blocking')
    then 22 else 0 end;
  v_unlock:=clued_private.mtpe_int(r.type_fields->>'downstream_unlock_value',0,0,15);
  v_risk:=least(18,
    (case when clued_private.mtpe_bool(r.type_fields->>'authority_risk') then 4 else 0 end)+
    (case when clued_private.mtpe_bool(r.type_fields->>'data_risk') then 4 else 0 end)+
    (case when clued_private.mtpe_bool(r.type_fields->>'currentness_risk') then 4 else 0 end)+
    (case when clued_private.mtpe_bool(r.type_fields->>'security_risk') then 6 else 0 end));
  v_impact:=clued_private.mtpe_int(r.type_fields->>'user_product_impact',0,0,15);
  v_time:=clued_private.mtpe_int(r.type_fields->>'time_sensitivity',0,0,10);
  v_cost:=clued_private.mtpe_int(r.type_fields->>'resource_cost',0,0,10);
  v_explicit:=least(15,greatest(0,clued_private.mtpe_int(
    r.type_fields->>'priority',coalesce(r.priority,0),0,100)/7));
  v_score:=greatest(0,least(100,v_base+v_frontier+v_unlock+v_risk+v_impact+v_time+
    v_explicit-v_cost));
  v_disposition:=case when r.lifecycle_status='active' then 'ACTIVE'
    else upper(r.lifecycle_status) end;
  v_candidate:=case
    when r.lifecycle_status<>'active' then 'TERMINAL'
    when v_eligible in ('INELIGIBLE','DISABLED','OUT_OF_GOVERNANCE_PROFILE') then 'EXCLUDED'
    when v_executability='READY' then 'ACTIVE_READY'
    when v_executability='SCHEDULED' then 'SCHEDULED'
    when v_executability='DEFERRED' or v_eligible='DEFERRED_WITH_TRIGGER'
      then 'DEFERRED_WITH_TRIGGER'
    else 'ACTIVE_BLOCKED' end;
  v_inputs:=jsonb_build_object('rule_set','mtpe-universal-intake.v1',
    'eligibility_rule','mtpe-frontier-eligibility.v2.1',
    'criticality',v_criticality,'criticality_weight',v_base,
    'current_frontier_blocking',v_frontier,'downstream_unlock_value',v_unlock,
    'authority_data_currentness_security_risk',v_risk,
    'user_product_impact',v_impact,'time_sensitivity',v_time,
    'resource_cost',v_cost,'explicit_priority_signal',v_explicit,
    'executability',v_executability,'priority_eligibility',v_eligible,
    'recommendation_hold',v_hold);
  v_digest:=clued_private.currentness_hash(jsonb_build_object('record_id',r.id,
    'record_version',r.version,'content_hash',r.content_hash,'inputs',v_inputs,
    'owner_track',v_track,'affected_tracks',to_jsonb(v_affected),'kind',v_kind,
    'lifecycle_status',r.lifecycle_status));
  insert into clued_private.mtpe_intake_projection(user_id,record_id,
    source_record_version,canonical_scope,project_id,intake_kind,owner_track,
    affected_tracks,provenance,criticality,algorithm_priority,priority_band,
    priority_eligibility,executability,hard_gate_blockers,dependency_blockers,
    lifecycle_status,disposition,candidate_status,priority_inputs,input_digest,computed_at)
  values(r.user_id,r.id,r.version,r.canonical_scope,r.project_id,v_kind,v_track,
    v_affected,jsonb_build_object('record_id',r.id,'scope',r.canonical_scope,
      'record_type',r.record_type,'authority',r.authority,'source_refs',to_jsonb(r.source_refs),
      'record_version',r.version),v_criticality,v_score,
    case when v_score>=85 then 'CRITICAL' when v_score>=65 then 'HIGH'
      when v_score>=35 then 'NORMAL' else 'LOW' end,
    v_eligible,v_executability,v_hard,v_deps,r.lifecycle_status,v_disposition,
    v_candidate,v_inputs,v_digest,now())
  on conflict(user_id,record_id) do update set
    source_record_version=excluded.source_record_version,
    canonical_scope=excluded.canonical_scope,project_id=excluded.project_id,
    intake_kind=excluded.intake_kind,owner_track=excluded.owner_track,
    affected_tracks=excluded.affected_tracks,provenance=excluded.provenance,
    criticality=excluded.criticality,algorithm_priority=excluded.algorithm_priority,
    priority_band=excluded.priority_band,priority_eligibility=excluded.priority_eligibility,
    executability=excluded.executability,hard_gate_blockers=excluded.hard_gate_blockers,
    dependency_blockers=excluded.dependency_blockers,
    lifecycle_status=excluded.lifecycle_status,disposition=excluded.disposition,
    candidate_status=excluded.candidate_status,priority_inputs=excluded.priority_inputs,
    input_digest=excluded.input_digest,computed_at=excluded.computed_at;
  if r.lifecycle_status<>'active' then
    delete from clued_private.mtpe_owner_focus where user_id=r.user_id and record_id=r.id;
  end if;
end $function$;

create or replace function clued_private.mtpe_snapshot(p_user_id uuid)
returns jsonb
language sql
stable security definer
set search_path to ''
as $function$
  with source_candidates as (
    select p.*,m.title,m.updated_at,
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
    select * from candidates where owner_selected and intake_kind='TASK'
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

create or replace function clued_private.frontier_task_source_v2(p_user_id uuid, p_fields jsonb)
returns jsonb
language plpgsql
stable security definer
set search_path to ''
as $function$
declare t public.clued_memories%rowtype; source jsonb:=p_fields->'source_task';
  result jsonb:=jsonb_build_object('status','PROJECTION_REQUIRED','action',null,
    'source_refs','[]'::jsonb); action jsonb; v_mtpe jsonb; v_selected jsonb;
begin
  -- Explicit empty Frontier: no eligible NOW exists. It is current only while the
  -- live MTPE snapshot still selects nothing under the same candidate universe.
  if p_fields->>'frontier_status'='NO_ELIGIBLE_CANDIDATE' then
    if p_fields->>'render_rule_version' is distinct from 'task-body.v1'
      or p_fields->>'rule_set_digest' is distinct from clued_private.frontier_rule_digest_v2()
      or p_fields->>'mtpe_rule_set' is distinct from 'mtpe-universal-intake.v1'
      then return result; end if;
    v_mtpe:=clued_private.mtpe_snapshot(p_user_id);
    v_selected:=v_mtpe->'selected_frontier';
    if (v_selected is not null and v_selected<>'null'::jsonb)
      or p_fields->>'mtpe_candidate_universe_digest' is distinct from
        v_mtpe->>'candidate_universe_digest'
      then return result; end if;
    -- A verified-current empty Frontier is an explicit NONE, not a missing projection.
    return jsonb_build_object('status','NONE','action',null,'source_refs','[]'::jsonb)
      ||jsonb_build_object('frontier_status','NO_ELIGIBLE_CANDIDATE',
      'reason','NO_ELIGIBLE_FRONTIER_CANDIDATE','render_rule_version','task-body.v1',
      'rule_set_digest',clued_private.frontier_rule_digest_v2(),
      'mtpe_rule_set','mtpe-universal-intake.v1',
      'mtpe_candidate_universe_digest',v_mtpe->>'candidate_universe_digest');
  end if;
  if jsonb_typeof(source) is distinct from 'object'
    or p_fields->>'render_rule_version' is distinct from 'task-body.v1'
    or p_fields->>'rule_set_digest' is distinct from clued_private.frontier_rule_digest_v2()
    then return result; end if;
  -- Existing CURRENT projections remain readable until the first automatic
  -- MTPE rebuild. They retain the former unique-now proof and cannot opt into
  -- Owner Pin or automatic arbitration without the new digest fields.
  if not (p_fields ? 'mtpe_rule_set') then
    select * into t from public.clued_memories where user_id=p_user_id
      and id::text=source->>'id' and version::text=source->>'version'
      and canonical_scope=source->>'scope' and record_type='task'
      and record_schema_version is not null and lifecycle_status='active'
      and type_fields->>'execution_bucket'='now';
    if not found or t.type_fields ? 'projection_key'
      or exists(select 1 from clued_private.projection_record_bindings where record_id=t.id)
      or clued_private.record_currentness_fence(p_user_id,t.id,null::text[])<>'CURRENT'
      or clued_private.mtpe_recommendation_hold(t.type_fields,t.title) is not null
      or (select count(*) from public.clued_memories m where m.user_id=p_user_id
        and m.canonical_scope=t.canonical_scope and m.record_type='task'
        and m.lifecycle_status='active' and m.type_fields->>'execution_bucket'='now'
        and clued_private.record_currentness_fence(p_user_id,m.id,null::text[])='CURRENT')<>1
      then return result; end if;
    action:=jsonb_build_object('title',t.title,'content',t.content);
    if p_fields ? 'current_action' and p_fields->'current_action' is distinct from action
      then return result; end if;
    return jsonb_build_object('status','RESOLVED','action',action,
      'source_refs',jsonb_build_array(jsonb_build_object('kind','record','id',t.id,
        'version',t.version,'scope',t.canonical_scope)),
      'render_rule_version','task-body.v1','rule_set_digest',
        clued_private.frontier_rule_digest_v2());
  end if;
  if p_fields->>'mtpe_rule_set' is distinct from 'mtpe-universal-intake.v1'
    then return result; end if;
  v_mtpe:=clued_private.mtpe_snapshot(p_user_id);
  v_selected:=v_mtpe->'selected_frontier';
  if v_selected is null or v_selected='null'::jsonb
    or p_fields->>'mtpe_candidate_universe_digest' is distinct from
      v_mtpe->>'candidate_universe_digest'
    or source->>'id' is distinct from v_selected->>'record_id'
    or source->>'version' is distinct from v_selected->>'record_version'
    or p_fields->>'selection_source' is distinct from v_selected->>'selection_source'
    then return result; end if;
  select * into t from public.clued_memories where user_id=p_user_id
    and id::text=source->>'id' and version::text=source->>'version'
    and canonical_scope=source->>'scope' and record_type='task'
    and record_schema_version is not null and lifecycle_status='active';
  if not found or t.type_fields ? 'projection_key'
    or exists(select 1 from clued_private.projection_record_bindings where record_id=t.id)
    or clued_private.record_currentness_fence(p_user_id,t.id,null::text[])<>'CURRENT'
    or clued_private.mtpe_recommendation_hold(t.type_fields,t.title) is not null
    then return result; end if;
  action:=jsonb_build_object('title',t.title,'content',t.content);
  if p_fields ? 'current_action' and p_fields->'current_action' is distinct from action
    then return result; end if;
  return jsonb_build_object('status','RESOLVED','action',action,
    'source_refs',jsonb_build_array(jsonb_build_object('kind','record','id',t.id,
      'version',t.version,'scope',t.canonical_scope)),
    'render_rule_version','task-body.v1','rule_set_digest',
      clued_private.frontier_rule_digest_v2(),
    'mtpe_rule_set','mtpe-universal-intake.v1',
    'mtpe_candidate_universe_digest',v_mtpe->>'candidate_universe_digest',
    'selection_source',v_selected->>'selection_source');
end $function$;

create or replace function clued_private.mtpe_validation(p_user_id uuid)
returns jsonb
language sql
stable security definer
set search_path to ''
as $function$
  with actionable as (
    select m.*,clued_private.mtpe_intake_kind(m.record_type,coalesce(m.type_fields,'{}')) kind
    from public.clued_memories m where m.user_id=p_user_id and m.record_schema_version=1
      and upper(coalesce(m.type_fields->>'governance_profile',''))<>'OUT_OF_GOVERNANCE_PROFILE'
  ), governed as (
    select * from actionable where kind<>'NOT_ACTIONABLE'
  ), active_actionable as (
    select * from governed where lifecycle_status='active'
  ), missing_route as (
    select a.id from governed a left join clued_private.mtpe_intake_projection p
      on p.user_id=a.user_id and p.record_id=a.id
    where p.record_id is null or p.owner_track is null or p.intake_kind<>a.kind
  ), missing_priority as (
    select a.id from governed a left join clued_private.mtpe_intake_projection p
      on p.user_id=a.user_id and p.record_id=a.id
    where p.record_id is null or p.algorithm_priority is null
      or p.priority_eligibility is null or p.executability is null
      or p.priority_eligibility not in ('ELIGIBLE','INELIGIBLE','DISABLED',
        'OUT_OF_GOVERNANCE_PROFILE','DEFERRED_WITH_TRIGGER','TERMINAL')
      or p.executability not in ('READY','BLOCKED_HARD_GATE','BLOCKED_DEPENDENCY',
        'SCHEDULED','DEFERRED','TERMINAL')
  ), stale_projection as (
    select a.id from governed a join clued_private.mtpe_intake_projection p
      on p.user_id=a.user_id and p.record_id=a.id
    where p.source_record_version<>a.version
  ), invalid_terminal as (
    select a.id from governed a where
      (a.lifecycle_status='superseded' and not exists(
        select 1 from public.clued_memories successor
        where successor.user_id=a.user_id and successor.id<>a.id and
          (successor.supersedes_id=a.id or exists(
            select 1 from jsonb_array_elements_text(case
              when jsonb_typeof(successor.relations->'supersedes')='array'
                then successor.relations->'supersedes' else '[]'::jsonb end) source(id)
            where source.id=a.id::text))))
      or (a.lifecycle_status='merged' and (a.merged_into_record_id is null or not exists(
        select 1 from public.clued_memories successor
        where successor.user_id=a.user_id and successor.id=a.merged_into_record_id
          and successor.id<>a.id)))
  ), held_ready as (
    -- A held Task must never be projected as READY / ACTIVE_READY.
    select a.id from active_actionable a join clued_private.mtpe_intake_projection p
      on p.user_id=a.user_id and p.record_id=a.id
    where clued_private.mtpe_recommendation_hold(a.type_fields,
      case when a.record_type='task' then a.title end) is not null
      and (p.executability='READY' or p.candidate_status='ACTIVE_READY')
  ), title_only_hold as (
    -- Informational: Tasks held only by the title fallback should get a structured hold_status.
    select a.id from active_actionable a where a.record_type='task'
      and clued_private.mtpe_recommendation_hold(a.type_fields,a.title)='TITLE_HOLD_MARKER'
  ), snap as (
    select clued_private.mtpe_snapshot(p_user_id) s
  ), frontier_violation as (
    select m.id from snap join public.clued_memories m on m.user_id=p_user_id
      and m.id::text=snap.s->'selected_frontier'->>'record_id'
    where m.record_type<>'task' or m.lifecycle_status<>'active'
      or clued_private.mtpe_recommendation_hold(m.type_fields,
        case when m.record_type='task' then m.title end) is not null
      or (snap.s->'selected_frontier'->>'selection_source'='SYSTEM_RECOMMENDED'
        and snap.s->'selected_frontier'->>'executability' is distinct from 'READY')
    union all
    select m.id from snap join public.clued_memories m on m.user_id=p_user_id
      and m.id::text=snap.s->'system_recommended_priority'->>'record_id'
    where clued_private.mtpe_recommendation_hold(m.type_fields,
        case when m.record_type='task' then m.title end) is not null
  ), frontier_projection_drift as (
    -- A resolved (claimed current) Frontier projection must match the live snapshot.
    select h.record_id id from clued_private.projection_heads h
      join clued_private.projection_invalidation_heads i on i.user_id=h.user_id
        and i.target_scope=h.target_scope and i.projection_key=h.projection_key
      join public.clued_memories fr on fr.id=h.record_id
      cross join snap
    where h.user_id=p_user_id and h.target_scope='global'
      and h.projection_key='global.priority_frontier'
      and i.invalidation_revision=i.resolved_through_revision
      and ((fr.type_fields->'source_task'->>'id') is distinct from
          (snap.s->'selected_frontier'->>'record_id')
        or (fr.type_fields->>'mtpe_candidate_universe_digest') is distinct from
          (snap.s->>'candidate_universe_digest'))
  )
  select jsonb_build_object('status',case when
      (select count(*) from missing_route)=0 and
      (select count(*) from missing_priority)=0 and
      (select count(*) from stale_projection)=0 and
      (select count(*) from invalid_terminal)=0 and
      (select count(*) from held_ready)=0 and
      (select count(*) from frontier_violation)=0 and
      (select count(*) from frontier_projection_drift)=0 then 'pass' else 'fail' end,
    'eligibility_rule','mtpe-frontier-eligibility.v2.1',
    'registered',(select count(*) from active_actionable),
    'terminal',(select count(*) from governed where lifecycle_status<>'active'),
    'missing_route',(select count(*) from missing_route),
    'missing_route_ids',(select coalesce(jsonb_agg(id order by id),'[]') from missing_route),
    'missing_priority',(select count(*) from missing_priority),
    'missing_priority_ids',(select coalesce(jsonb_agg(id order by id),'[]') from missing_priority),
    'stale_projection',(select count(*) from stale_projection),
    'stale_projection_ids',(select coalesce(jsonb_agg(id order by id),'[]') from stale_projection),
    'invalid_terminal_successor_binding',(select count(*) from invalid_terminal),
    'invalid_terminal_ids',(select coalesce(jsonb_agg(id order by id),'[]') from invalid_terminal),
    'held_projected_ready',(select count(*) from held_ready),
    'held_projected_ready_ids',(select coalesce(jsonb_agg(id order by id),'[]') from held_ready),
    'frontier_eligibility_violation',(select count(*) from frontier_violation),
    'frontier_eligibility_violation_ids',
      (select coalesce(jsonb_agg(id order by id),'[]') from frontier_violation),
    'frontier_projection_drift',(select count(*) from frontier_projection_drift),
    'title_only_hold',(select count(*) from title_only_hold),
    'title_only_hold_ids',(select coalesce(jsonb_agg(id order by id),'[]') from title_only_hold),
    'frontier_status',(select s->>'frontier_status' from snap))
$function$;

-- Regression suite: deterministic, side-effect free (all fixtures are rolled back).
-- The ready control uses 'next' (still READY, not held) so the suite never collides with
-- clued_now_global_uidx for a user who already has a global 'now' Task.
create or replace function clued_private.mtpe_frontier_regression_suite(p_user_id uuid)
returns jsonb
language plpgsql
volatile security definer
set search_path to ''
as $function$
declare v_cases jsonb:='[]'::jsonb; v_fail integer:=0; c record; v_got text;
  v_msg text; v_e2e jsonb; v_live jsonb;
begin
  -- A. Pure classification table.
  for c in select * from (values
    ('R01 later bucket','{"execution_bucket":"later"}'::jsonb,'任务',true),
    ('R02 backlog bucket','{"execution_bucket":"backlog"}'::jsonb,'任务',true),
    ('R03 bucket case/space','{"execution_bucket":" Backlog "}'::jsonb,'任务',true),
    ('R04 title 暂缓 on now bucket','{"execution_bucket":"now"}'::jsonb,
      '确认「当前最重要的一件事」：原型 / 剧情 / 名字收敛——暂缓：Owner 暂时不考虑推动',true),
    ('R05 do_not_recommend=true','{"execution_bucket":"now","do_not_recommend":true}'::jsonb,'任务',true),
    ('R06 recommendation do-not-recommend','{"execution_bucket":"now","recommendation":"do-not-recommend"}'::jsonb,'任务',true),
    ('R07 hold_status 暂缓','{"execution_bucket":"next","hold_status":"暂缓"}'::jsonb,'任务',true),
    ('R08 on_hold=true','{"execution_bucket":"now","on_hold":"true"}'::jsonb,'任务',true),
    ('R09 title do-not-recommend','{"execution_bucket":"now"}'::jsonb,'X (do-not-recommend)',true),
    ('N01 now plain','{"execution_bucket":"now"}'::jsonb,'实施 MTPE Universal Intake M0',false),
    ('N02 next plain','{"execution_bucket":"next"}'::jsonb,'任务',false),
    ('N03 no bucket','{}'::jsonb,'任务',false),
    ('N04 do_not_recommend=false','{"execution_bucket":"now","do_not_recommend":false}'::jsonb,'任务',false),
    ('N05 null fields','null'::jsonb,'任务',false),
    ('N06 negated title 解除暂缓','{"execution_bucket":"next"}'::jsonb,'解除暂缓：恢复推进原型',false),
    ('N07 negated title 不再搁置','{"execution_bucket":"next"}'::jsonb,'不再搁置名字收敛',false),
    ('N08 hold_status NONE overrides title','{"execution_bucket":"next","hold_status":"NONE"}'::jsonb,'X——暂缓',false),
    ('N09 prose do not recommend','{"execution_bucket":"next"}'::jsonb,'Why we do not recommend X',false),
    ('R10 structured hold beats release','{"execution_bucket":"later","hold_status":"NONE"}'::jsonb,'任务',true)
  ) t(name,tf,title,expect_hold) loop
    v_got:=clued_private.mtpe_recommendation_hold(c.tf,c.title);
    v_cases:=v_cases||jsonb_build_array(jsonb_build_object('case',c.name,
      'pass',(v_got is not null)=c.expect_hold,'got',v_got));
    if (v_got is not null)<>c.expect_hold then v_fail:=v_fail+1; end if;
  end loop;

  -- B. End-to-end fixtures through the real trigger → projection → snapshot path.
  declare v_ready uuid; v_later uuid; v_backlog uuid; v_title uuid; v_dnr uuid;
      v_legacy uuid; s1 jsonb; s2 jsonb; s3 jsonb; v_res jsonb:='[]'::jsonb;
      v_held uuid[]; v_proj record;
      base jsonb:='{"priority":100,"criticality":"CRITICAL","current_frontier_blocking":true,
        "downstream_unlock_value":15,"user_product_impact":15,"time_sensitivity":10}'::jsonb;
  begin
      insert into public.clued_memories(user_id,title,content,record_type,record_schema_version,
        lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,
        confidence_reason,content_hash)
      values(p_user_id,'MTPE-REG ready next','fixture','task',1,'active','global',
          base||'{"execution_bucket":"next"}','{}','{}',
          'observed','regression fixture',repeat('0',64))
      returning id into v_ready;
      insert into public.clued_memories(user_id,title,content,record_type,record_schema_version,
        lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,
        confidence_reason,content_hash)
      values(p_user_id,'MTPE-REG later','fixture','task',1,'active','global',
        base||'{"execution_bucket":"later"}','{}','{}','observed','regression fixture',repeat('0',64))
      returning id into v_later;
      insert into public.clued_memories(user_id,title,content,record_type,record_schema_version,
        lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,
        confidence_reason,content_hash)
      values(p_user_id,'MTPE-REG backlog','fixture','task',1,'active','global',
        base||'{"execution_bucket":"backlog"}','{}','{}','observed','regression fixture',repeat('0',64))
      returning id into v_backlog;
      insert into public.clued_memories(user_id,title,content,record_type,record_schema_version,
        lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,
        confidence_reason,content_hash)
      values(p_user_id,'MTPE-REG 名字收敛——暂缓：Owner 暂时不考虑推动','fixture','task',1,
        'active','global',base||'{"execution_bucket":"next"}','{}','{}','observed',
        'regression fixture',repeat('0',64))
      returning id into v_title;
      insert into public.clued_memories(user_id,title,content,record_type,record_schema_version,
        lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,
        confidence_reason,content_hash)
      values(p_user_id,'MTPE-REG dnr','fixture','task',1,'active','global',
        base||'{"execution_bucket":"next","do_not_recommend":true}','{}','{}','observed',
        'regression fixture',repeat('0',64))
      returning id into v_dnr;
      insert into public.clued_memories(user_id,title,content,record_type,record_schema_version,
        lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,
        confidence_reason,content_hash)
      values(p_user_id,'MTPE-REG legacy flags','fixture','task',1,'active','global',
        '{"execution_bucket":"next","priority_eligibility":true,"executability":"BLOCKED"}',
        '{}','{}','observed','regression fixture',repeat('0',64))
      returning id into v_legacy;
      v_held:=array[v_later,v_backlog,v_title,v_dnr];

      -- E01: every held fixture is projected DEFERRED, never READY.
      for v_proj in select p.record_id,p.executability,p.candidate_status
        from clued_private.mtpe_intake_projection p where p.record_id=any(v_held) loop
        v_res:=v_res||jsonb_build_array(jsonb_build_object('case','E01 held projected deferred',
          'record',v_proj.record_id,'pass',v_proj.executability='DEFERRED'
            and v_proj.candidate_status='DEFERRED_WITH_TRIGGER',
          'got',v_proj.executability||'/'||v_proj.candidate_status));
      end loop;
      if (select count(*) from clued_private.mtpe_intake_projection
          where record_id=any(v_held))<>4 then
        v_res:=v_res||'[{"case":"E01 held fixtures registered","pass":false}]'::jsonb;
      end if;

      -- E02: held fixtures tie the ready control on priority but never become NOW.
      -- Something must be selected unless the global scope itself is not current
      -- (an active work_log carrier shadows every global Task, the ready control included).
      s1:=clued_private.mtpe_snapshot(p_user_id);
      v_res:=v_res||jsonb_build_array(jsonb_build_object('case','E02 held never selected',
        'pass',not coalesce((s1->'selected_frontier'->>'record_id')::uuid = any(v_held),false)
          and ((s1->'selected_frontier'->>'record_id') is not null
            or clued_private.record_currentness_fence(p_user_id,v_ready,null::text[])<>'CURRENT'),
        'got',s1->'selected_frontier'->>'record_id'));
      v_res:=v_res||jsonb_build_array(jsonb_build_object('case','E02b ready control',
        'pass',exists(select 1 from clued_private.mtpe_intake_projection p where p.record_id=v_ready
          and p.candidate_status='ACTIVE_READY' and p.algorithm_priority=100),
        'got',(select p.candidate_status||'/'||p.algorithm_priority from clued_private.mtpe_intake_projection p where p.record_id=v_ready)));
      v_res:=v_res||jsonb_build_array(jsonb_build_object(
        'case','E03 held never system priority',
        'pass',not coalesce((s1->'system_recommended_priority'->>'record_id')::uuid = any(v_held),false),
        'got',s1->'system_recommended_priority'->>'record_id'));

      -- E04: Owner focus on a held Task → OWNER_SELECTED_DEFERRED, not selected.
      insert into clued_private.mtpe_owner_focus(user_id,record_id,source_record_version,
        selected_at,source_receipt_id,reason)
      values(p_user_id,v_later,1,now(),null,'regression fixture')
      on conflict(user_id) do update set record_id=excluded.record_id,
        source_record_version=excluded.source_record_version,selected_at=excluded.selected_at,
        source_receipt_id=excluded.source_receipt_id,reason=excluded.reason;
      s2:=clued_private.mtpe_snapshot(p_user_id);
      v_res:=v_res||jsonb_build_array(jsonb_build_object('case','E04 owner focus on held',
        'pass',s2->'owner_selected_current_focus'->>'status'='OWNER_SELECTED_DEFERRED'
          and (s2->'selected_frontier'->>'record_id') is distinct from v_later::text,
        'got',jsonb_build_object('focus',s2->'owner_selected_current_focus'->>'status',
          'selected',s2->'selected_frontier'->>'record_id')));

      -- E05: remove the eligible control: held Tasks still cannot fill the gap.
      delete from clued_private.mtpe_owner_focus where user_id=p_user_id;
      update public.clued_memories set lifecycle_status='cancelled' where id=v_ready;
      s3:=clued_private.mtpe_snapshot(p_user_id);
      v_res:=v_res||jsonb_build_array(jsonb_build_object('case','E05 only held left',
        'pass',not coalesce((s3->'selected_frontier'->>'record_id')::uuid = any(v_held||v_ready),false)
          and (s3->>'frontier_status') in ('SELECTED','NO_ELIGIBLE_CANDIDATE'),
        'got',s3->'selected_frontier'->>'record_id'));

      -- E06: legacy boolean eligibility / bare BLOCKED normalise without UNKNOWN_INVALID.
      select p.priority_eligibility,p.executability into v_proj
        from clued_private.mtpe_intake_projection p where p.record_id=v_legacy;
      v_res:=v_res||jsonb_build_array(jsonb_build_object('case','E06 legacy flags normalised',
        'pass',v_proj.priority_eligibility='ELIGIBLE' and v_proj.executability='BLOCKED_HARD_GATE',
        'got',v_proj.priority_eligibility||'/'||v_proj.executability));

      raise exception using errcode='MTR01', message=v_res::text;
  exception when sqlstate 'MTR01' then
    get stacked diagnostics v_msg=message_text;
    v_e2e:=v_msg::jsonb;
  end;
  v_fail:=v_fail+(select count(*) from jsonb_array_elements(v_e2e) e
    where coalesce((e->>'pass')::boolean,false)=false);

  -- C. Live invariant on real data.
  v_live:=clued_private.mtpe_validation(p_user_id);
  if coalesce((v_live->>'held_projected_ready')::int,1)<>0
    or coalesce((v_live->>'frontier_eligibility_violation')::int,1)<>0 then
    v_fail:=v_fail+1;
  end if;

  return jsonb_build_object('status',case when v_fail=0 then 'pass' else 'fail' end,
    'failures',v_fail,'classification',v_cases,'end_to_end',v_e2e,
    'live_invariants',jsonb_build_object(
      'held_projected_ready',v_live->'held_projected_ready',
      'frontier_eligibility_violation',v_live->'frontier_eligibility_violation'));
end $function$;

-- The manual builder accepts a verified-current empty Frontier (status NONE) too.
do $migration$
declare body text; anchor text:=$a$clued_private.frontier_task_source_v2(v_binding.user_id,v_record.type_fields)->>'status'<>'RESOLVED'$a$;
begin
  body:=pg_get_functiondef('public.clued_mcp_projection_rebuild(text,jsonb)'::regprocedure);
  if strpos(body,anchor)=0 then raise exception 'frontier_builder_none_definition_mismatch'; end if;
  execute replace(body,anchor,
    $b$clued_private.frontier_task_source_v2(v_binding.user_id,v_record.type_fields)->>'status' not in ('RESOLVED','NONE')$b$);
end $migration$;

revoke all on function clued_private.mtpe_recommendation_hold(jsonb,text) from public, anon, authenticated, service_role;
revoke all on function clued_private.mtpe_frontier_regression_suite(uuid) from public, anon, authenticated, service_role;

-- Owner-approved exact-manifest continuity-only resolution for three direct work_log
-- Events whose ACTIVE_UNSTRUCTURED carriers shadow every State/Task record in their
-- scope. Their durable semantics are carried by Canonical Records and the repository:
--   1218  PR #297 opened (superseded by the production release recorded in 1231);
--   1231  Project Lifecycle v2 production release, cited by Task 6e1f0c2a closure;
--   1232  mtpe_frontier_eligibility_v2 applied, cited by Task 6e1f0c2a and PR #301.
-- The Events remain history. This is a private finite contract, not a general
-- Event retirement API, and it does not claim Global Currentness was rebuilt.
create or replace function clued_private.reconcile_approved_direct_event_continuity_once_v1(
  p_user_id uuid,
  p_expected_manifest_digest text default null,
  p_approval_record_id uuid default null,
  p_approval_receipt_id uuid default null,
  p_execute boolean default false
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_manifest constant jsonb := jsonb_build_object(
    'contract','direct-event-continuity-once.v1',
    'user_id','2ddd1804-b1e5-4916-89fb-3b87fae11ee6',
    'target_state','RESOLVED_CONTINUITY_ONLY',
    'events',jsonb_build_array(
      jsonb_build_object('event_id',1218,
        'scope','project:0597aa60-9b98-4da6-a4ab-63d7705b632f','event_type','action',
        'payload_sha256','a9f3d5595206565ebae0a7a7c121f820067d53f670b72654b5711e540616d18a',
        'reason_code','SUPERSEDED_BY_EVENT_1231'),
      jsonb_build_object('event_id',1231,
        'scope','project:0597aa60-9b98-4da6-a4ab-63d7705b632f','event_type','action',
        'payload_sha256','d0fe270d0ce41cd052d33b37218e3e03be9d96b70e29c4306271480e8401117b',
        'reason_code','CARRIED_BY_TASK_6E1F0C2A_CLOSURE'),
      jsonb_build_object('event_id',1232,
        'scope','global','event_type','action',
        'payload_sha256','ae05705788e7d87b1aee1dfecf8e485d19e368281b714250a383e7f3198ad45d',
        'reason_code','CARRIED_BY_TASK_6E1F0C2A_AND_PR_301')));
  v_digest text:=encode(extensions.digest(convert_to(v_manifest::text,'UTF8'),'sha256'),'hex');
  v_count constant integer := 3;
  v_item jsonb; v_event public.clued_context_events%rowtype;
  v_carrier clued_private.event_truth_carriers%rowtype;
  v_approval public.clued_memories%rowtype;
  v_approval_receipt public.clued_audit_receipts%rowtype;
  v_resolved integer; v_resolution_id uuid; v_transition_id uuid; v_batch_id uuid;
  v_source jsonb;
begin
  if p_execute is null or p_user_id is distinct from (v_manifest->>'user_id')::uuid then
    raise exception 'direct_continuity_owner_invalid' using errcode='22023';
  end if;
  if p_execute and (coalesce(p_expected_manifest_digest,'') !~ '^[0-9a-f]{64}$'
      or p_approval_record_id is null or p_approval_receipt_id is null) then
    raise exception 'direct_continuity_approval_required' using errcode='22023';
  end if;
  if p_execute and p_expected_manifest_digest is distinct from v_digest then
    raise exception 'direct_continuity_manifest_digest_mismatch' using errcode='40001';
  end if;
  perform clued_private.currentness_user_lock(p_user_id);

  select count(*) into v_resolved from clued_private.event_truth_carriers c
    join jsonb_array_elements(v_manifest->'events') x on c.event_id=(x->>'event_id')::bigint
    where c.user_id=p_user_id and c.carrier_state='RESOLVED_CONTINUITY_ONLY'
      and exists(select 1 from public.clued_audit_receipts r
        where r.user_id=p_user_id and r.operation='continuity_only_resolution_authorized'
          and r.object_id=c.event_id::text
          and r.metadata->>'manifest_digest'=v_digest);
  if v_resolved=v_count then
    return jsonb_build_object('status','already_reconciled','manifest_digest',v_digest,
      'count',v_count,'currentness_claim',false);
  end if;

  -- Any change to an Event, its payload, scope or carrier rejects the whole batch.
  for v_item in select value from jsonb_array_elements(v_manifest->'events') loop
    select * into v_event from public.clued_context_events e
      where e.id=(v_item->>'event_id')::bigint and e.user_id=p_user_id;
    select * into v_carrier from clued_private.event_truth_carriers c
      where c.event_id=(v_item->>'event_id')::bigint and c.user_id=p_user_id for update;
    if v_event.id is null or v_carrier.event_id is null
       or v_event.context_key is distinct from v_item->>'scope'
       or v_event.event_type is distinct from v_item->>'event_type'
       or encode(extensions.digest(convert_to(v_event.payload::text,'UTF8'),'sha256'),'hex')
          is distinct from v_item->>'payload_sha256'
       or v_carrier.canonical_scope is distinct from v_item->>'scope'
       or v_carrier.visibility is distinct from 'work_log'
       or v_carrier.carrier_state is distinct from 'ACTIVE_UNSTRUCTURED'
       or v_carrier.transition_version is distinct from 1 then
      raise exception 'direct_continuity_source_changed event=%',v_item->>'event_id'
        using errcode='40001';
    end if;
  end loop;
  if not p_execute then
    return jsonb_build_object('status','dry_run_ok','manifest_digest',v_digest,
      'count',v_count,'currentness_claim',false);
  end if;

  select * into v_approval from public.clued_memories r
    where r.id=p_approval_record_id and r.user_id=p_user_id;
  select * into v_approval_receipt from public.clued_audit_receipts r
    where r.id=p_approval_receipt_id and r.user_id=p_user_id;
  if v_approval.id is null or v_approval_receipt.id is null
     or v_approval.record_type is distinct from 'decision'
     or v_approval.lifecycle_status is distinct from 'active'
     or v_approval.canonical_scope is distinct from 'global'
     or v_approval.authority is distinct from 'user_explicit'
     or v_approval.receipt_id is distinct from p_approval_receipt_id
     or v_approval.relations->>'manifest_digest' is distinct from v_digest
     or v_approval.relations->>'event_count' is distinct from v_count::text
     or v_approval.relations->>'target_state' is distinct from 'RESOLVED_CONTINUITY_ONLY'
     or v_approval_receipt.status is distinct from 'committed'
     or v_approval_receipt.error_code is not null
     or v_approval_receipt.operation_family is distinct from 'record_mutation'
     or v_approval_receipt.binding_id is null
     or v_approval_receipt.committed_versions->>p_approval_record_id::text
        is distinct from v_approval.version::text then
    raise exception 'direct_continuity_approval_invalid' using errcode='40001';
  end if;

  for v_item in select value from jsonb_array_elements(v_manifest->'events') loop
    select * into v_carrier from clued_private.event_truth_carriers c
      where c.event_id=(v_item->>'event_id')::bigint and c.user_id=p_user_id for update;
    insert into public.clued_audit_receipts(
      user_id,binding_id,context_key,operation,object_type,object_id,version,
      metadata,related_receipt_id)
    values(p_user_id,null,v_carrier.canonical_scope,
      'continuity_only_resolution_authorized','event',v_carrier.event_id::text,
      v_carrier.transition_version,jsonb_build_object(
        'proof','owner_approved_exact_manifest',
        'proof_contract','direct-event-continuity-once.v1',
        'manifest_digest',v_digest,
        'approval_record_id',p_approval_record_id,
        'approval_receipt_id',p_approval_receipt_id,
        'reason_code',v_item->>'reason_code',
        'transaction_id',txid_current()::text),p_approval_receipt_id)
    returning id into v_resolution_id;
    insert into public.clued_audit_receipts(
      user_id,binding_id,context_key,operation,operation_family,object_type,
      object_id,version,metadata,related_receipt_id)
    values(p_user_id,null,v_carrier.canonical_scope,'carrier_transition',
      'event_carrier_transition','event',v_carrier.event_id::text,
      v_carrier.transition_version+1,jsonb_build_object(
        'target_state','RESOLVED_CONTINUITY_ONLY',
        'expected_transition_version',v_carrier.transition_version::text,
        'continuity_only_proof','verified',
        'proof_contract','direct-event-continuity-once.v1',
        'manifest_digest',v_digest,
        'proof_receipt_id',v_resolution_id,
        'transaction_id',txid_current()::text),v_resolution_id)
    returning id into v_transition_id;
    perform clued_private.transition_event_carrier(v_carrier.event_id,
      v_carrier.transition_version,'RESOLVED_CONTINUITY_ONLY',null,v_transition_id);
  end loop;

  select count(*) into v_resolved from clued_private.event_truth_carriers c
    join jsonb_array_elements(v_manifest->'events') x on c.event_id=(x->>'event_id')::bigint
    where c.user_id=p_user_id and c.carrier_state='RESOLVED_CONTINUITY_ONLY';
  if v_resolved<>v_count then
    raise exception 'direct_continuity_postcondition_failed' using errcode='40001';
  end if;

  -- Record currentness changed for the shadowed scopes: recompute both Global projections.
  v_source:=jsonb_build_object('kind','continuity_resolution',
    'id','direct-event-continuity-once.v1','manifest_digest',v_digest);
  insert into clued_private.projection_invalidation_heads(user_id,target_scope,
    projection_key,invalidation_revision,latest_source_ref,stale_since)
  values(p_user_id,'global','global.priority_frontier',1,v_source,now()),
        (p_user_id,'global','global.__aggregate__',1,v_source,now())
  on conflict(user_id,target_scope,projection_key) do update set
    invalidation_revision=clued_private.projection_invalidation_heads.invalidation_revision+1,
    latest_source_ref=excluded.latest_source_ref,
    stale_since=coalesce(clued_private.projection_invalidation_heads.stale_since,now()),
    updated_at=now();

  insert into public.clued_audit_receipts(user_id,binding_id,context_key,
    operation,operation_family,object_type,object_id,version,metadata,
    related_receipt_id)
  values(p_user_id,null,'global','approved_direct_event_continuity_reconcile',
    'event_carrier_transition','currentness','global',v_count,
    jsonb_build_object('status','committed','count',v_count,
      'manifest_digest',v_digest,
      'approval_record_id',p_approval_record_id,
      'approval_receipt_id',p_approval_receipt_id,
      'target_state','RESOLVED_CONTINUITY_ONLY',
      'currentness_claim',false),p_approval_receipt_id)
  returning id into v_batch_id;
  return jsonb_build_object('status','reconciled','receipt_id',v_batch_id,
    'count',v_count,'manifest_digest',v_digest,'currentness_claim',false);
end $$;

revoke all on function clued_private.reconcile_approved_direct_event_continuity_once_v1(
  uuid,text,uuid,uuid,boolean) from public,anon,authenticated,service_role;

-- Re-derive every governed record under the new rule, gate on the regression suite,
-- then invalidate both Global projections so the refresh worker recomputes them.
do $$
declare r record; v_user uuid; v_suite jsonb;
begin
  for r in select id from public.clued_memories where record_schema_version is not null loop
    perform clued_private.mtpe_sync_record(r.id);
  end loop;
  for v_user in select distinct user_id from clued_private.mtpe_intake_projection loop
    v_suite:=clued_private.mtpe_frontier_regression_suite(v_user);
    if v_suite->>'status'<>'pass' then
      raise exception 'mtpe_frontier_regression_failed %',v_suite;
    end if;
    insert into clued_private.projection_invalidation_heads(user_id,target_scope,
      projection_key,invalidation_revision,latest_source_ref,stale_since)
    values(v_user,'global','global.priority_frontier',1,
        jsonb_build_object('kind','mtpe_rule_change','id','mtpe-frontier-eligibility.v2.1'),now()),
      (v_user,'global','global.__aggregate__',1,
        jsonb_build_object('kind','mtpe_rule_change','id','mtpe-frontier-eligibility.v2.1'),now())
    on conflict(user_id,target_scope,projection_key) do update set
      invalidation_revision=clued_private.projection_invalidation_heads.invalidation_revision+1,
      latest_source_ref=excluded.latest_source_ref,
      stale_since=coalesce(clued_private.projection_invalidation_heads.stale_since,now()),
      updated_at=now();
  end loop;
end $$;
