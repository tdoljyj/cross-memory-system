-- Read surfaces consume the same session vector and checkpoint admission as
-- the protected Currentness Core. A legacy or changed checkpoint cannot keep
-- advertising its snapshot/next action as current to metadata-blind clients.

create or replace function clued_private.checkpoint_currentness_for_session(
  p_session_id uuid
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_session public.clued_continuity_sessions%rowtype;
  v_checkpoint public.clued_context_checkpoints%rowtype;
  v_current jsonb; v_digest text; v_status text;
begin
  select * into v_session from public.clued_continuity_sessions where id=p_session_id;
  if not found then raise exception 'session_not_found' using errcode='42501'; end if;
  perform clued_private.currentness_user_lock(v_session.user_id);
  v_current:=clued_private.currentness_vector(
    v_session.user_id,v_session.context_key,v_session.binding_id);
  v_digest:=clued_private.currentness_hash(v_current);
  select c.* into v_checkpoint from public.clued_context_heads h
    join public.clued_context_checkpoints c on c.id=h.checkpoint_id
    where h.user_id=v_session.user_id and h.context_key=v_session.context_key;
  v_status:=case
    when coalesce((v_current->>'legacy_alias_unknown')::boolean,false) then 'UNKNOWN'
    when not clued_private.currentness_vector_eligible(v_current) then 'STALE'
    when v_checkpoint.id is null then 'CURRENT'
    when v_checkpoint.committed_currentness_vector is null then 'UNKNOWN'
    when v_checkpoint.committed_currentness_vector is distinct from v_current then 'STALE'
    else 'CURRENT' end;
  return jsonb_build_object('overall',v_status,
    'authoritative',v_status='CURRENT',
    'checkpoint_id',v_checkpoint.id,
    'currentness_vector_digest',v_digest,
    'reconciliation_required',v_session.reconciliation_required or v_status<>'CURRENT');
end $$;
revoke all on function clued_private.checkpoint_currentness_for_session(uuid)
  from public,anon,authenticated,service_role;

-- Only typed, fenced sources can produce an authoritative next action.
-- Event payload and checkpoint free text remain separate continuity evidence.
create or replace function clued_private.authoritative_current_action_v1(
  p_user_id uuid,p_context_key text
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_count integer:=0; v_record public.clued_memories%rowtype;
  v_action jsonb; v_status text; v_resolver text;
  v_digest text; v_blocked boolean:=false; v_refs jsonb:='[]'::jsonb;
begin
  v_digest:=clued_private.currentness_hash(jsonb_build_object(
    'scope',p_context_key,'source',
    coalesce((select to_jsonb(h) from clued_private.visible_scope_currentness_heads h
      where h.user_id=p_user_id and h.canonical_scope=p_context_key),'{}'::jsonb)));
  if p_context_key='global' then
    v_resolver:='global_frontier';
    select m.* into v_record from clued_private.projection_record_bindings b
      join public.clued_memories m on m.id=b.record_id and m.user_id=b.user_id
      where b.user_id=p_user_id and b.target_scope='global'
        and b.projection_key='global.priority_frontier'
        and clued_private.record_currentness_fence(
          p_user_id,m.id,array['global']::text[])='CURRENT'
      order by b.projection_generation desc,m.id limit 1;
    if not found then v_status:='PROJECTION_REQUIRED';
    elsif jsonb_typeof(v_record.type_fields->'current_action')='object' then
      v_status:='RESOLVED'; v_action:=v_record.type_fields->'current_action';
    else v_status:='NONE'; end if;
  else
    v_resolver:='project_task';
    select exists(select 1 from clued_private.event_truth_carriers c
      where c.user_id=p_user_id and c.canonical_scope=p_context_key
        and c.visibility='work_log'
        and c.carrier_state in ('ACTIVE_UNSTRUCTURED','LEGACY_UNBOUND')
        and c.dimensions && array['state','task','decision']::text[]) into v_blocked;
    if exists(select 1 from clued_private.legacy_event_project_impacts i
      join clued_private.event_truth_carriers c on c.event_id=i.event_id
      where i.user_id=p_user_id and i.project_scope=p_context_key
        and c.carrier_state='LEGACY_UNBOUND' and c.visibility='work_log'
        and c.dimensions && array['state','task','decision']::text[]) then
      v_status:='UNKNOWN';
    elsif v_blocked then v_status:='BLOCKED';
    else
      select count(*)::integer into v_count from public.clued_memories m
        where m.user_id=p_user_id and m.canonical_scope=p_context_key
          and m.record_type='task' and m.type_fields->>'execution_bucket'='now'
          and clued_private.record_currentness_fence(
            p_user_id,m.id,array[p_context_key]::text[])='CURRENT';
      if v_count>1 then
        v_status:='AMBIGUOUS';
        select coalesce(jsonb_agg(jsonb_build_object('kind','record','id',m.id,
          'version',m.version,'scope',p_context_key) order by m.id),'[]'::jsonb)
          into v_refs from public.clued_memories m
         where m.user_id=p_user_id and m.canonical_scope=p_context_key
           and m.record_type='task' and m.type_fields->>'execution_bucket'='now'
           and clued_private.record_currentness_fence(
             p_user_id,m.id,array[p_context_key]::text[])='CURRENT';
      elsif v_count=0 then v_status:='NONE';
      else
        select m.* into v_record from public.clued_memories m
          where m.user_id=p_user_id and m.canonical_scope=p_context_key
            and m.record_type='task' and m.type_fields->>'execution_bucket'='now'
            and clued_private.record_currentness_fence(
              p_user_id,m.id,array[p_context_key]::text[])='CURRENT'
          order by m.id limit 1;
        v_status:='RESOLVED';
        v_action:=jsonb_build_object('title',v_record.title,
          'content',v_record.content);
      end if;
    end if;
  end if;
  return jsonb_build_object('status',v_status,'action',v_action,
    'source_refs',case when v_status='AMBIGUOUS' then v_refs
      when v_record.id is null then '[]'::jsonb else
      jsonb_build_array(jsonb_build_object('kind','record','id',v_record.id,
        'version',v_record.version,'scope',p_context_key)) end,
    'resolver',v_resolver,'source_vector_digest',v_digest);
end $$;
revoke all on function clued_private.authoritative_current_action_v1(uuid,text)
  from public,anon,authenticated,service_role;

alter function public.clued_mcp_restore(text,jsonb)
  rename to clued_mcp_restore_before_currentness;
revoke all on function public.clued_mcp_restore_before_currentness(text,jsonb)
  from public,anon,authenticated,service_role;
create or replace function public.clued_mcp_restore(
  p_token_hash text,p_input jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_binding public.clued_agent_bindings%rowtype;
  v_session public.clued_continuity_sessions%rowtype;
  v_scope text:=coalesce(nullif(btrim(p_input->>'context_key'),''),'global');
  v_eval jsonb; v_action jsonb; v_log text; v_marker text:='## Active constraints';
  v_reverse_position integer; v_section_start integer;
begin
  v_result:=public.clued_mcp_restore_before_currentness(p_token_hash,p_input);
  if v_result->>'session_token' is null then return v_result; end if;
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_scope);
  v_session:=clued_private.resolve_session(
    v_binding.user_id,v_binding.id,v_scope,v_result->>'session_token');
  v_eval:=clued_private.checkpoint_currentness_for_session(v_session.id);
  v_action:=clued_private.authoritative_current_action_v1(v_binding.user_id,v_scope);
  if v_eval->>'overall'<>'CURRENT' then
    update public.clued_continuity_sessions set
      reconciliation_required=true,
      reconciliation_reason_digest=coalesce(reconciliation_reason_digest,
        v_eval->>'currentness_vector_digest')
      where id=v_session.id;
    v_result:=v_result||jsonb_build_object(
      'snapshot','{}'::jsonb,'summary','Currentness unresolved; reconcile the authorized current view.',
      'next_action','RECONCILIATION_REQUIRED',
      'checkpoint_coverage','{}'::jsonb,
      'historical_checkpoint_available',true,
      'session_compliance',jsonb_build_object('state','reconciliation_required',
        'required_next','clued_session_reconcile'));
    if v_result ? 'work_log' then
      v_log:=v_result->>'work_log';
      v_reverse_position:=strpos(reverse(v_log),reverse(v_marker));
      v_section_start:=case when v_reverse_position>0 then
        char_length(v_log)-v_reverse_position-char_length(v_marker)+2 else null end;
      v_result:=v_result||jsonb_build_object('work_log',
        '# 日志'||chr(10)||chr(10)||
        '## Latest checkpoint'||chr(10)||chr(10)||
        'Currentness unresolved. Historical checkpoint withheld from the current view.'||chr(10)||chr(10)||
        case when v_section_start is null then '' else substring(v_log from v_section_start) end);
    end if;
  end if;
  if v_eval->>'overall'='CURRENT' then
    v_result:=v_result||jsonb_build_object('next_action',
      case when v_action->>'status'='RESOLVED' then
        coalesce(v_action->'action'->>'title',v_action->'action'->>'text',
          'ACTION_RESOLUTION_REQUIRED')
        else 'ACTION_RESOLUTION_REQUIRED' end);
  end if;
  return v_result||jsonb_build_object('currentness_evaluation',v_eval,
    'authoritative_current_action',v_action,
    'next_action_authoritative',v_eval->>'overall'='CURRENT' and
      v_action->>'status'='RESOLVED',
    'required_reads',case when v_eval->>'overall'='CURRENT' then '[]'::jsonb
      when v_scope='global' then jsonb_build_array('global.priority_frontier',
        'global.__aggregate__')
      else jsonb_build_array('project.task','project.state','global.authority') end,
    'effective_next_action',case when v_eval->>'overall'='CURRENT' and
      v_action->>'status'='RESOLVED' then v_action->'action' else null end);
end $$;
revoke all on function public.clued_mcp_restore(text,jsonb) from public;
grant execute on function public.clued_mcp_restore(text,jsonb) to anon;

alter function public.clued_mcp_read_log(text,jsonb)
  rename to clued_mcp_read_log_before_currentness;
revoke all on function public.clued_mcp_read_log_before_currentness(text,jsonb)
  from public,anon,authenticated,service_role;
create or replace function public.clued_mcp_read_log(
  p_token_hash text,p_input jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_binding public.clued_agent_bindings%rowtype;
  v_session public.clued_continuity_sessions%rowtype;
  v_scope text:=coalesce(nullif(btrim(p_input->>'context_key'),''),'global');
  v_eval jsonb;
begin
  v_result:=public.clued_mcp_read_log_before_currentness(p_token_hash,p_input);
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_scope);
  v_session:=clued_private.resolve_session(
    v_binding.user_id,v_binding.id,v_scope,p_input->>'session_token');
  v_eval:=clued_private.checkpoint_currentness_for_session(v_session.id);
  if v_eval->>'overall'<>'CURRENT' and
     coalesce((p_input->>'include_history')::boolean,false)=false then
    v_result:=v_result||jsonb_build_object('markdown',
      '> Historical continuity log: currentness unresolved. Checkpoint text below is not an authoritative current action.'||
      chr(10)||chr(10)||(v_result->>'markdown'));
  end if;
  return v_result||jsonb_build_object('currentness_evaluation',v_eval,
    'authoritative_current',v_eval->>'overall'='CURRENT' and
      coalesce((p_input->>'include_history')::boolean,false)=false);
end $$;
revoke all on function public.clued_mcp_read_log(text,jsonb) from public;
grant execute on function public.clued_mcp_read_log(text,jsonb) to anon;
