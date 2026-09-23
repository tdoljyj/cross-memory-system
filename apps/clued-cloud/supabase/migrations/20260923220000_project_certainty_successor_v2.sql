-- Project certainty successor v2.
-- Retires confirmed/unconfirmed as an active product/business gate without rewriting historical rows.
-- The legacy certainty_status column is retained only for compatibility/audit. New v2 writes never accept it.
-- Existing Project IDs, versions and historical Receipts remain intact until an explicit v2 mutation occurs.

create or replace function clued_private.project_mutation_core(
  p_user_id uuid,p_binding_id uuid,p_input jsonb,p_received_payload_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts%rowtype; v_project public.clued_projects%rowtype;
  v_operation text:=p_input->>'operation'; v_mutation jsonb:=coalesce(p_input->'mutation','{}');
  v_id uuid; v_base bigint; v_event_type text; v_event_id text; v_refs jsonb; v_result jsonb;
  v_error text; v_state text; v_aliases text[]; v_progress text; v_certainty text; v_recognition numeric;
begin
  v_receipt:=clued_private.m1_begin_receipt(p_user_id,p_binding_id,'project_mutation',p_input,p_received_payload_hash);
  if v_receipt.status<>'pending' then return coalesce(v_receipt.canonical_result,clued_private.m1_result_envelope(v_receipt))
    ||jsonb_build_object('replayed',v_receipt.related_receipt_id is null); end if;
  begin
    if v_operation not in ('create','update','complete','archive','restore') then raise exception 'invalid_project_operation' using errcode='22023'; end if;
    if coalesce((p_input->>'project_schema_version')::integer,0)<>2 then raise exception 'invalid_project_schema' using errcode='22023'; end if;
    v_id:=coalesce(nullif(p_input->>'canonical_project_id','')::uuid,gen_random_uuid());
    if v_operation='create' then
      if p_input ? 'base_version' and p_input->'base_version'<>'null'::jsonb then raise exception 'create_base_version_must_be_null' using errcode='22023'; end if;
      if not (p_input ? 'mutation') then raise exception 'incomplete_create' using errcode='22023'; end if;
      if v_mutation ? 'certainty_status' then raise exception 'certainty_status_retired' using errcode='22023'; end if;
      v_progress:=coalesce(v_mutation->>'progress_status','active');
      v_recognition:=nullif(v_mutation->>'recognition_confidence','')::numeric;
      if v_progress not in ('active','paused') then raise exception 'invalid_project_create_status' using errcode='22023'; end if;
      if v_recognition is not null and (v_recognition<0 or v_recognition>1) then raise exception 'invalid_recognition_confidence' using errcode='22023'; end if;
      v_certainty:='confirmed'; -- legacy compatibility storage only; schema v2 has no certainty gate
      if char_length(btrim(coalesce(v_mutation->>'name',''))) not between 1 and 120 then raise exception 'invalid_project_name' using errcode='22023'; end if;
      if exists(select 1 from public.clued_projects where id=v_id) then raise exception 'project_id_exists' using errcode='23505'; end if;
      v_aliases:=clued_private.project_input_aliases(v_mutation);
      insert into public.clued_projects(
        id,user_id,name,normalized_name,aliases,certainty_status,progress_status,summary,confidence,context_key,
        confirmed_at,version,project_schema_version,lifecycle_status,closure_summary,closed_reason,closed_at,merge_generation,receipt_id
      ) values (
        v_id,p_user_id,btrim(v_mutation->>'name'),clued_private.normalize_project_name(v_mutation->>'name'),v_aliases,v_certainty,v_progress,
        null,v_recognition,'project:'||v_id,
        now(),1,2,'active',null,null,null,0,v_receipt.id
      ) returning * into v_project;
      v_event_type:='project_created'; v_base:=null;
    else
      if not (p_input ? 'base_version') or coalesce((p_input->>'base_version')::bigint,0)<=0 then raise exception 'positive_base_version_required' using errcode='22023'; end if;
      v_base:=(p_input->>'base_version')::bigint;
      select * into v_project from public.clued_projects where id=v_id and user_id=p_user_id for update;
      if not found then raise exception 'project_not_found' using errcode='P0002'; end if;
      if v_project.version<>v_base then raise exception 'project_version_conflict' using errcode='40001'; end if;
      if coalesce(v_project.lifecycle_status,'active')='merged' or v_project.merged_into_project_id is not null then raise exception 'merged_project_read_only' using errcode='55000'; end if;
      if v_operation='update' and v_project.progress_status not in ('active','paused') then raise exception 'terminal_project_read_only' using errcode='55000'; end if;
      if v_operation='restore' and v_project.progress_status not in ('completed','archived') then raise exception 'project_not_restorable' using errcode='22023'; end if;
      v_progress:=case v_operation when 'complete' then 'completed' when 'archive' then 'archived' when 'restore' then 'active'
        else coalesce(v_mutation->>'progress_status',v_project.progress_status) end;
      if v_operation='update' and v_progress not in ('active','paused') then raise exception 'project_terminal_command_required' using errcode='22023'; end if;
      if v_mutation ? 'certainty_status' then raise exception 'certainty_status_retired' using errcode='22023'; end if;
      v_certainty:=v_project.certainty_status;
      v_recognition:=case when v_mutation ? 'recognition_confidence'
        then nullif(v_mutation->>'recognition_confidence','')::numeric else v_project.confidence end;
      if v_recognition is not null and (v_recognition<0 or v_recognition>1) then raise exception 'invalid_recognition_confidence' using errcode='22023'; end if;
      v_aliases:=case when v_mutation ? 'aliases' then clued_private.project_input_aliases(v_mutation) else v_project.aliases end;
      update public.clued_projects set
        name=case when v_mutation ? 'name' then btrim(v_mutation->>'name') else name end,
        normalized_name=case when v_mutation ? 'name' then clued_private.normalize_project_name(v_mutation->>'name') else normalized_name end,
        aliases=v_aliases,certainty_status=v_certainty,confirmed_at=confirmed_at,confidence=v_recognition,
        progress_status=v_progress,closure_summary=case when v_mutation ? 'closure_summary' then v_mutation->>'closure_summary' else closure_summary end,
        closed_reason=case when v_mutation ? 'closed_reason' then v_mutation->>'closed_reason' else closed_reason end,
        closed_at=case when v_operation in ('complete','archive') then now() when v_operation='restore' then null else closed_at end,
        updated_at=now(),version=version+1,receipt_id=v_receipt.id,project_schema_version=2,lifecycle_status='active',merge_generation=coalesce(merge_generation,0)
      where id=v_project.id returning * into v_project;
      v_event_type:=case v_operation when 'complete' then 'project_completed' when 'archive' then 'project_archived'
        when 'restore' then 'project_restored' else 'project_updated' end;
    end if;
    v_refs:=jsonb_build_array(jsonb_build_object('role','primary','kind','project','id',v_project.id));
    v_event_id:=clued_private.m1_append_event_row(p_user_id,p_binding_id,v_receipt.id,v_receipt.canonical_version,v_event_type,
      v_refs,'project:'||v_project.id,null,'[]',p_input->>'idempotency_key',v_receipt.request_sha256,'success','work_log','{}','[]',null);
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,'committed',v_refs,jsonb_build_object(v_project.id::text,v_base),
      jsonb_build_object(v_project.id::text,v_project.version),array[v_event_id],'{}',null);
    return v_result||jsonb_build_object('replayed',false,'supplemental',jsonb_build_object('project',to_jsonb(v_project)-'user_id'));
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,case when v_state in ('22023','23505','40001','42501','P0002','55000') then 'rejected' else 'failed' end,
      '[]','{}','{}','{}','{}',v_error);
    return v_result||jsonb_build_object('replayed',false);
  end;
end $$;


create or replace function clued_private.record_mutation_core(
  p_user_id uuid,p_binding_id uuid,p_input jsonb,p_received_payload_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_receipt public.clued_audit_receipts%rowtype;
  v_record public.clued_memories%rowtype;
  v_operation text:=coalesce(p_input->>'operation','');
  v_id uuid; v_project_id uuid; v_effective_project uuid; v_scope text;
  v_record_type text; v_lifecycle text; v_schema integer; v_base bigint;
  v_mutation jsonb; v_type_fields jsonb; v_relations jsonb; v_sources uuid[];
  v_source_reason text; v_authority text; v_confidence numeric; v_confidence_reason text;
  v_event_type text; v_event_id text; v_now_count bigint; v_old_sources uuid[];
  v_target_refs jsonb; v_base_versions jsonb:='{}'; v_committed_versions jsonb:='{}';
  v_error text; v_sqlstate text; v_result jsonb;
begin
  v_receipt:=clued_private.m1_begin_receipt(p_user_id,p_binding_id,'record_mutation',p_input,p_received_payload_hash);
  if v_receipt.status<>'pending' then
    return coalesce(v_receipt.canonical_result,clued_private.m1_result_envelope(v_receipt))
      || jsonb_build_object('replayed',v_receipt.related_receipt_id is null);
  end if;
  begin
    if v_operation not in ('create','update','close','restore','reclassify_scope') then
      raise exception 'invalid_record_operation' using errcode='22023';
    end if;
    v_id:=coalesce(nullif(p_input->>'id','')::uuid,gen_random_uuid());
    v_scope:=p_input->>'scope';
    if v_scope is null or (v_scope not in ('profile','global') and v_scope !~ '^project:[0-9a-f-]{36}$') then
      raise exception 'invalid_scope' using errcode='22023';
    end if;
    v_project_id:=clued_private.m1_scope_project_id(v_scope);
    if v_project_id is not null then
      v_effective_project:=clued_private.m1_effective_project(p_user_id,v_project_id);
      if not exists(select 1 from public.clued_projects where id=v_effective_project and user_id=p_user_id
        and dismissed_at is null and merged_into_project_id is null
        and coalesce(lifecycle_status,'active')='active') then
        raise exception 'project_unavailable' using errcode='42501';
      end if;
    end if;
    v_record_type:=p_input->>'record_type';
    v_schema:=(p_input->>'record_schema_version')::integer;
    v_lifecycle:=coalesce(p_input->>'lifecycle_status','active');
    v_mutation:=coalesce(p_input->'mutation','{}');
    v_authority:=coalesce(p_input->>'authority','');
    v_confidence:=nullif(p_input->>'confidence','')::numeric;
    v_confidence_reason:=coalesce(p_input->>'confidence_reason','');
    if v_authority not in ('user_explicit','observed','inferred','imported') then raise exception 'invalid_authority' using errcode='22023'; end if;
    if p_binding_id is not null and v_authority='user_explicit' and coalesce((p_input->>'user_confirmed')::boolean,false)=false then
      raise exception 'authority_escalation_forbidden' using errcode='42501';
    end if;
    if v_authority='inferred' and (v_confidence is null or v_confidence<0 or v_confidence>1) then
      raise exception 'inferred_confidence_required' using errcode='22023';
    end if;
    if v_confidence_reason='' then raise exception 'confidence_reason_required' using errcode='22023'; end if;

    if v_operation='create' then
      if p_input ? 'base_version' and p_input->'base_version'<>'null'::jsonb then raise exception 'create_base_version_must_be_null' using errcode='22023'; end if;
      if v_lifecycle<>'active' then raise exception 'create_must_be_active' using errcode='22023'; end if;
      if not (p_input ? 'mutation') or not (p_input ? 'source_refs') or not (p_input ? 'source_unavailable_reason') then
        raise exception 'incomplete_create' using errcode='22023';
      end if;
      if exists(select 1 from public.clued_memories where id=v_id) then raise exception 'record_id_exists' using errcode='23505'; end if;
      v_type_fields:=coalesce(v_mutation->'type_fields','{}');
      v_relations:=coalesce(v_mutation->'relations','{}');
      v_sources:=clued_private.m1_sorted_uuid_array(p_input->'source_refs');
      v_source_reason:=nullif(btrim(p_input->>'source_unavailable_reason'),'');
      if v_record_type='decision' and jsonb_array_length(coalesce(v_relations->'supersedes','[]'))>0 then
        raise exception 'decision_supersede_command_required' using errcode='22023';
      end if;
      perform clued_private.m1_validate_record_shape(v_record_type,v_schema,v_type_fields,v_relations);
      if v_authority in ('observed','inferred','imported') and cardinality(v_sources)=0 and v_source_reason is null then
        raise exception 'source_required' using errcode='22023';
      end if;
      if exists(select 1 from unnest(v_sources) s(id) where not exists(
        select 1 from public.clued_evidence e where e.id=s.id and e.user_id=p_user_id)) then
        raise exception 'evidence_not_authorized' using errcode='42501';
      end if;
      if v_record_type='task' and v_type_fields->>'execution_bucket'='now' then
        select count(*) into v_now_count from public.clued_memories m
        where m.user_id=p_user_id and m.record_schema_version is not null and m.record_type='task'
          and m.lifecycle_status='active' and m.type_fields->>'execution_bucket'='now'
          and ((v_effective_project is null and m.canonical_scope=v_scope) or
            (v_effective_project is not null and clued_private.m1_effective_project(p_user_id,m.project_id)=v_effective_project));
        if v_now_count>0 then raise exception 'NOW_CONFLICT' using errcode='23505'; end if;
      end if;
      insert into public.clued_memories(
        id,user_id,title,content,scope,project_id,record_type,status,priority,version,
        record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,
        source_unavailable_reason,authority,observed_at,confidence,confidence_reason,receipt_id,content_hash
      ) values (
        v_id,p_user_id,nullif(btrim(v_mutation->>'title'),''),v_mutation->>'content',
        case when v_project_id is null then 'global' else 'project' end,v_project_id,v_record_type,
        case v_record_type when 'state' then 'current' when 'task' then 'backlog' else 'active' end,
        coalesce((v_type_fields->>'priority')::smallint,0),1,
        v_schema,'active',v_scope,v_type_fields,v_relations,v_sources,v_source_reason,v_authority,
        nullif(p_input->>'observed_at','')::timestamptz,v_confidence,v_confidence_reason,v_receipt.id,
        clued_private.m1_record_content_hash(v_record_type,v_scope,'active',nullif(btrim(v_mutation->>'title'),''),v_mutation->>'content',
          v_type_fields,v_relations,v_sources,v_source_reason,v_authority,nullif(p_input->>'observed_at','')::timestamptz,null,v_confidence,v_confidence_reason)
      ) returning * into v_record;
      v_event_type:='record_created';
      v_base_versions:=jsonb_build_object(v_record.id::text,null);
    else
      if not (p_input ? 'base_version') or coalesce((p_input->>'base_version')::bigint,0)<=0 then raise exception 'positive_base_version_required' using errcode='22023'; end if;
      v_base:=(p_input->>'base_version')::bigint;
      select * into v_record from public.clued_memories where id=v_id and user_id=p_user_id and record_schema_version is not null for update;
      if not found then raise exception 'record_not_found' using errcode='P0002'; end if;
      if v_record.version<>v_base then raise exception 'record_version_conflict' using errcode='40001'; end if;
      if v_record.record_type<>v_record_type then raise exception 'record_type_mismatch' using errcode='22023'; end if;
      if v_operation<>'reclassify_scope' and v_record.canonical_scope<>v_scope then raise exception 'scope_change_requires_reclassify' using errcode='22023'; end if;
      if v_operation in ('update','reclassify_scope') and v_record.lifecycle_status<>'active' then raise exception 'terminal_record_read_only' using errcode='55000'; end if;
      if v_operation='close' and v_record.lifecycle_status<>'active' then raise exception 'close_requires_active' using errcode='22023'; end if;
      if v_operation='restore' and (v_record.lifecycle_status not in ('completed','cancelled','archived','revoked') or
        (v_record.record_type='decision' and v_record.lifecycle_status='superseded')) then raise exception 'record_not_restorable' using errcode='22023'; end if;
      if v_operation='reclassify_scope' and btrim(coalesce(p_input->>'reclassification_reason',''))='' then
        raise exception 'reclassification_reason_required' using errcode='22023';
      end if;
      v_old_sources:=coalesce(v_record.source_refs,'{}');
      v_type_fields:=case when v_mutation ? 'type_fields' then v_mutation->'type_fields' else v_record.type_fields end;
      v_relations:=case when v_mutation ? 'relations' then v_mutation->'relations' else v_record.relations end;
      v_sources:=case when p_input ? 'source_refs' then clued_private.m1_sorted_uuid_array(p_input->'source_refs') else v_record.source_refs end;
      v_source_reason:=case when p_input ? 'source_unavailable_reason' then nullif(btrim(p_input->>'source_unavailable_reason'),'') else v_record.source_unavailable_reason end;
      if v_record_type='decision' and jsonb_array_length(coalesce(v_relations->'supersedes','[]'))>0 and v_relations is distinct from v_record.relations then
        raise exception 'decision_supersede_command_required' using errcode='22023';
      end if;
      perform clued_private.m1_validate_record_shape(v_record_type,v_schema,v_type_fields,v_relations);
      if exists(select 1 from unnest(v_sources) s(id) where not exists(
        select 1 from public.clued_evidence e where e.id=s.id and e.user_id=p_user_id)) then raise exception 'evidence_not_authorized' using errcode='42501'; end if;
      if v_operation='close' then
        if v_lifecycle not in ('completed','cancelled','archived','revoked') then raise exception 'invalid_close_status' using errcode='22023'; end if;
      elsif v_operation='restore' then v_lifecycle:='active';
      else v_lifecycle:=v_record.lifecycle_status;
      end if;
      if v_record_type='task' and v_lifecycle='active' and v_type_fields->>'execution_bucket'='now' then
        select count(*) into v_now_count from public.clued_memories m where m.user_id=p_user_id and m.id<>v_record.id
          and m.record_schema_version is not null and m.record_type='task' and m.lifecycle_status='active'
          and m.type_fields->>'execution_bucket'='now' and
          ((v_effective_project is null and m.canonical_scope=v_scope) or
           (v_effective_project is not null and clued_private.m1_effective_project(p_user_id,m.project_id)=v_effective_project));
        if v_now_count>0 then raise exception 'NOW_CONFLICT' using errcode='23505'; end if;
      end if;
      update public.clued_memories set
        title=case when v_mutation ? 'title' then nullif(btrim(v_mutation->>'title'),'') else title end,
        content=case when v_mutation ? 'content' then v_mutation->>'content' else content end,
        type_fields=v_type_fields,relations=v_relations,source_refs=v_sources,source_unavailable_reason=v_source_reason,
        canonical_scope=v_scope,scope=case when v_project_id is null then 'global' else 'project' end,project_id=v_project_id,
        lifecycle_status=v_lifecycle,status=case when v_lifecycle='active' then case record_type when 'state' then 'current' when 'task' then 'backlog' else 'active' end
          when v_lifecycle='completed' then case when record_type='task' then 'done' else 'archived' end
          when v_lifecycle='cancelled' then 'cancelled' when v_lifecycle='superseded' then 'superseded' else 'archived' end,
        closure_summary=case when v_mutation ? 'closure_summary' then v_mutation->>'closure_summary' else closure_summary end,
        closed_reason=case when v_mutation ? 'closed_reason' then v_mutation->>'closed_reason' else closed_reason end,
        closed_at=case when v_operation='close' then now() when v_operation='restore' then null else closed_at end,
        archived_at=case when v_lifecycle='archived' then now() else null end,
        observed_at=case when p_input ? 'observed_at' then nullif(p_input->>'observed_at','')::timestamptz else observed_at end,
        confidence=case when p_input ? 'confidence' then nullif(p_input->>'confidence','')::numeric else confidence end,
        confidence_reason=case when p_input ? 'confidence_reason' then p_input->>'confidence_reason' else confidence_reason end,
        updated_at=now(),version=version+1,receipt_id=v_receipt.id
      where id=v_record.id returning * into v_record;
      update public.clued_memories set content_hash=clued_private.m1_record_content_hash(
        record_type,canonical_scope,lifecycle_status,title,content,type_fields,relations,source_refs,source_unavailable_reason,
        authority,observed_at,closed_at,confidence,confidence_reason) where id=v_record.id returning * into v_record;
      v_event_type:=case v_operation when 'close' then 'record_closed' when 'restore' then 'record_restored'
        when 'reclassify_scope' then 'scope_changed'
        else case when v_old_sources<@v_sources and v_old_sources<>v_sources then 'evidence_linked'
                  when v_sources<@v_old_sources and v_old_sources<>v_sources then 'evidence_unlinked' else 'record_updated' end end;
      v_base_versions:=jsonb_build_object(v_record.id::text,v_base);
    end if;
    v_target_refs:=jsonb_build_array(jsonb_build_object('role','primary','kind','record','id',v_record.id));
    v_committed_versions:=jsonb_build_object(v_record.id::text,v_record.version);
    v_event_id:=clued_private.m1_append_event_row(p_user_id,p_binding_id,v_receipt.id,v_receipt.canonical_version,
      v_event_type,v_target_refs,v_record.canonical_scope,null,'[]',p_input->>'idempotency_key',v_receipt.request_sha256,
      'success','work_log',v_record.source_refs,'[]',null);
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,'committed',v_target_refs,v_base_versions,
      v_committed_versions,array[v_event_id],v_record.source_refs,null);
    return v_result||jsonb_build_object('replayed',false,'supplemental',jsonb_build_object('record',to_jsonb(v_record)-'user_id'));
  exception when others then
    get stacked diagnostics v_error=message_text,v_sqlstate=returned_sqlstate;
    v_error:=case when v_error in ('record_version_conflict','NOW_CONFLICT','record_not_found','project_unavailable',
      'evidence_not_authorized','authority_escalation_forbidden') then upper(v_error) else v_error end;
    if v_record.id is not null and v_error in ('RECORD_VERSION_CONFLICT','NOW_CONFLICT') then
      v_target_refs:=jsonb_build_array(jsonb_build_object('role','primary','kind','record','id',v_record.id));
      v_event_id:=clued_private.m1_append_event_row(p_user_id,p_binding_id,v_receipt.id,v_receipt.canonical_version,
        'operation_failed',v_target_refs,v_record.canonical_scope,null,'[]',p_input->>'idempotency_key',v_receipt.request_sha256,
        'failure','audit_only','{}','[]',v_error);
    end if;
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,
      case when v_sqlstate in ('22023','23505','40001','42501','P0002','55000') then 'rejected' else 'failed' end,
      coalesce(v_target_refs,'[]'),'{}','{}',case when v_event_id is null then '{}' else array[v_event_id] end,'{}',v_error);
    return v_result||jsonb_build_object('replayed',false);
  end;
end $$;



comment on column public.clued_projects.certainty_status is
  'LEGACY COMPATIBILITY ONLY after project schema v2; not a Project eligibility/currentness gate.';
comment on column public.clued_projects.confidence is
  'Project schema v2 recognition confidence metadata (0..1 when present); never a Project eligibility gate.';

create or replace view public.clued_projects_m1 with (security_invoker=true) as
select id as canonical_project_id,user_id,coalesce(project_schema_version,1) as project_schema_version,name,certainty_status,
  case when progress_status='not_started' then 'paused' else progress_status end as progress_status,
  coalesce(lifecycle_status,case when merged_into_project_id is null then 'active' else 'merged' end) as lifecycle_status,
  merged_into_project_id,aliases,closure_summary,closed_reason,closed_at,coalesce(merge_generation,0) as merge_generation,
  version,created_at as recorded_at,updated_at,receipt_id,
  confidence as recognition_confidence
from public.clued_projects;

notify pgrst,'reload schema';
