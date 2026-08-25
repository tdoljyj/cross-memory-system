-- Clued v1.6 M1 runtime contracts.
-- Additive: legacy rows remain readable; only rows with a non-null schema version
-- participate in the canonical M1 projection. Event stream ordering remains disabled.

create sequence if not exists clued_private.canonical_version_seq as bigint start with 1;

alter table public.clued_memories
  add column if not exists record_schema_version integer,
  add column if not exists lifecycle_status text,
  add column if not exists canonical_scope text,
  add column if not exists type_fields jsonb,
  add column if not exists relations jsonb,
  add column if not exists source_refs uuid[],
  add column if not exists source_unavailable_reason text,
  add column if not exists closure_summary text,
  add column if not exists closed_reason text,
  add column if not exists closed_at timestamptz,
  add column if not exists authority text,
  add column if not exists observed_at timestamptz,
  add column if not exists confidence numeric,
  add column if not exists confidence_reason text,
  add column if not exists receipt_id uuid,
  add column if not exists content_hash text,
  add column if not exists merged_into_record_id uuid;

alter table public.clued_projects
  add column if not exists project_schema_version integer,
  add column if not exists lifecycle_status text,
  add column if not exists closure_summary text,
  add column if not exists closed_reason text,
  add column if not exists closed_at timestamptz,
  add column if not exists merge_generation bigint,
  add column if not exists receipt_id uuid;

alter table public.clued_context_events
  add column if not exists event_schema_version integer,
  add column if not exists event_stream_id text,
  add column if not exists stream_generation bigint,
  add column if not exists event_sequence bigint,
  add column if not exists committed_canonical_version bigint,
  add column if not exists canonical_event_type text,
  add column if not exists target_refs jsonb,
  add column if not exists event_scope text,
  add column if not exists origin_scope text,
  add column if not exists change_summary jsonb,
  add column if not exists request_hash text,
  add column if not exists actor_binding_ref text,
  add column if not exists actor_user_id uuid,
  add column if not exists result text,
  add column if not exists receipt_id uuid,
  add column if not exists audit_visibility text,
  add column if not exists evidence_refs uuid[],
  add column if not exists artifact_refs jsonb,
  add column if not exists error_code text,
  add column if not exists content_hash text;

alter table public.clued_audit_receipts
  add column if not exists receipt_schema_version integer,
  add column if not exists operation_family text,
  add column if not exists status text,
  add column if not exists received_payload_hash text,
  add column if not exists target_refs jsonb,
  add column if not exists base_versions jsonb,
  add column if not exists committed_versions jsonb,
  add column if not exists canonical_version bigint,
  add column if not exists event_ids text[],
  add column if not exists evidence_ids uuid[],
  add column if not exists artifact_refs jsonb,
  add column if not exists related_receipt_id uuid,
  add column if not exists error_code text,
  add column if not exists response_hash text,
  add column if not exists canonical_result jsonb,
  add column if not exists owns_idempotency_key boolean not null default false;

create table if not exists public.clued_evidence (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  binding_id uuid references public.clued_agent_bindings(id) on delete set null,
  evidence_schema_version integer not null check (evidence_schema_version > 0),
  evidence_type text not null check (evidence_type in ('user_quote','file','image','web_ref','test_output','legacy_document')),
  storage_ref text not null check (char_length(storage_ref) between 1 and 1000),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  mime_type text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  captured_at timestamptz,
  recorded_at timestamptz not null default now(),
  receipt_id uuid not null,
  unique (user_id, id)
);

alter table public.clued_evidence enable row level security;
drop policy if exists clued_evidence_select_own on public.clued_evidence;
create policy clued_evidence_select_own on public.clued_evidence
  for select to authenticated using ((select auth.uid()) = user_id);
revoke all on table public.clued_evidence from public, anon, authenticated;
grant select on table public.clued_evidence to authenticated;

create unique index if not exists clued_receipts_m1_idempotency_owner_uidx
  on public.clued_audit_receipts(user_id, operation_family, idempotency_key)
  where owns_idempotency_key and operation_family is not null and idempotency_key is not null;
create index if not exists clued_events_m1_owner_scope_idx
  on public.clued_context_events(user_id,event_scope,id)
  where event_schema_version is not null;
create index if not exists clued_evidence_owner_recorded_idx
  on public.clued_evidence(user_id,recorded_at,id);
create unique index if not exists clued_now_global_uidx
  on public.clued_memories(user_id)
  where record_schema_version is not null and lifecycle_status='active'
    and record_type='task' and canonical_scope='global' and type_fields->>'execution_bucket'='now';
create unique index if not exists clued_now_project_uidx
  on public.clued_memories(user_id,project_id)
  where record_schema_version is not null and lifecycle_status='active'
    and record_type='task' and canonical_scope like 'project:%' and type_fields->>'execution_bucket'='now';

create or replace function clued_private.m1_sha256(p_value jsonb)
returns text language sql immutable strict set search_path='' as $$
  select encode(extensions.digest(convert_to(p_value::text,'UTF8'),'sha256'),'hex')
$$;

create or replace function clued_private.m1_sorted_uuid_array(p_value jsonb)
returns uuid[] language sql immutable set search_path='' as $$
  select coalesce(array_agg(distinct value::uuid order by value::uuid),'{}'::uuid[])
    from jsonb_array_elements_text(coalesce(p_value,'[]'::jsonb)) items(value)
$$;

create or replace function clued_private.m1_scope_project_id(p_scope text)
returns uuid language plpgsql immutable set search_path='' as $$
begin
  if p_scope like 'project:%' then return substring(p_scope from 9)::uuid; end if;
  return null;
exception when invalid_text_representation then
  raise exception 'invalid_scope' using errcode='22023';
end $$;

create or replace function clued_private.project_mutation_core(
  p_user_id uuid,p_binding_id uuid,p_input jsonb,p_received_payload_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts%rowtype; v_project public.clued_projects%rowtype;
  v_operation text:=p_input->>'operation'; v_mutation jsonb:=coalesce(p_input->'mutation','{}');
  v_id uuid; v_base bigint; v_event_type text; v_event_id text; v_refs jsonb; v_result jsonb;
  v_error text; v_state text; v_aliases text[]; v_progress text; v_certainty text;
begin
  v_receipt:=clued_private.m1_begin_receipt(p_user_id,p_binding_id,'project_mutation',p_input,p_received_payload_hash);
  if v_receipt.status<>'pending' then return coalesce(v_receipt.canonical_result,clued_private.m1_result_envelope(v_receipt))
    ||jsonb_build_object('replayed',v_receipt.related_receipt_id is null); end if;
  begin
    if v_operation not in ('create','update','complete','archive','restore') then raise exception 'invalid_project_operation' using errcode='22023'; end if;
    if coalesce((p_input->>'project_schema_version')::integer,0)<>1 then raise exception 'invalid_project_schema' using errcode='22023'; end if;
    v_id:=coalesce(nullif(p_input->>'canonical_project_id','')::uuid,gen_random_uuid());
    if v_operation='create' then
      if p_input ? 'base_version' and p_input->'base_version'<>'null'::jsonb then raise exception 'create_base_version_must_be_null' using errcode='22023'; end if;
      if not (p_input ? 'mutation') then raise exception 'incomplete_create' using errcode='22023'; end if;
      v_progress:=coalesce(v_mutation->>'progress_status','active'); v_certainty:=coalesce(v_mutation->>'certainty_status','unconfirmed');
      if v_progress not in ('active','paused') or v_certainty not in ('unconfirmed','confirmed') then raise exception 'invalid_project_create_status' using errcode='22023'; end if;
      if char_length(btrim(coalesce(v_mutation->>'name',''))) not between 1 and 120 then raise exception 'invalid_project_name' using errcode='22023'; end if;
      if exists(select 1 from public.clued_projects where id=v_id) then raise exception 'project_id_exists' using errcode='23505'; end if;
      v_aliases:=clued_private.project_input_aliases(v_mutation);
      insert into public.clued_projects(
        id,user_id,name,normalized_name,aliases,certainty_status,progress_status,summary,confidence,context_key,
        confirmed_at,version,project_schema_version,lifecycle_status,closure_summary,closed_reason,closed_at,merge_generation,receipt_id
      ) values (
        v_id,p_user_id,btrim(v_mutation->>'name'),clued_private.normalize_project_name(v_mutation->>'name'),v_aliases,v_certainty,v_progress,
        null,case when v_certainty='confirmed' then 1 else 0.5 end,'project:'||v_id,
        case when v_certainty='confirmed' then now() end,1,1,'active',null,null,null,0,v_receipt.id
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
      v_certainty:=coalesce(v_mutation->>'certainty_status',v_project.certainty_status);
      if v_certainty not in ('unconfirmed','confirmed') then raise exception 'invalid_project_certainty' using errcode='22023'; end if;
      v_aliases:=case when v_mutation ? 'aliases' then clued_private.project_input_aliases(v_mutation) else v_project.aliases end;
      update public.clued_projects set
        name=case when v_mutation ? 'name' then btrim(v_mutation->>'name') else name end,
        normalized_name=case when v_mutation ? 'name' then clued_private.normalize_project_name(v_mutation->>'name') else normalized_name end,
        aliases=v_aliases,certainty_status=v_certainty,confirmed_at=case when v_certainty='confirmed' then coalesce(confirmed_at,now()) else confirmed_at end,
        progress_status=v_progress,closure_summary=case when v_mutation ? 'closure_summary' then v_mutation->>'closure_summary' else closure_summary end,
        closed_reason=case when v_mutation ? 'closed_reason' then v_mutation->>'closed_reason' else closed_reason end,
        closed_at=case when v_operation in ('complete','archive') then now() when v_operation='restore' then null else closed_at end,
        updated_at=now(),version=version+1,receipt_id=v_receipt.id,project_schema_version=1,lifecycle_status='active',merge_generation=coalesce(merge_generation,0)
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

create or replace function clued_private.decision_supersede_core(
  p_user_id uuid,p_binding_id uuid,p_input jsonb,p_received_payload_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts%rowtype; v_source jsonb; v_row public.clued_memories%rowtype;
  v_replacement public.clued_memories%rowtype; v_repl jsonb:=p_input->'replacement';
  v_ids uuid[]:='{}'; v_versions jsonb:='{}'; v_committed jsonb:='{}'; v_scope text;
  v_replacement_id uuid; v_sources uuid[]; v_source_id uuid; v_event_id text; v_refs jsonb:='[]'; v_result jsonb;
  v_error text; v_state text; v_type_fields jsonb; v_relations jsonb; v_authority text; v_source_reason text;
begin
  v_receipt:=clued_private.m1_begin_receipt(p_user_id,p_binding_id,'decision_supersede',p_input,p_received_payload_hash);
  if v_receipt.status<>'pending' then return coalesce(v_receipt.canonical_result,clued_private.m1_result_envelope(v_receipt))
    ||jsonb_build_object('replayed',v_receipt.related_receipt_id is null); end if;
  begin
    if jsonb_typeof(p_input->'source_decisions')<>'array' or jsonb_array_length(p_input->'source_decisions')<1 then
      raise exception 'source_decisions_required' using errcode='22023';
    end if;
    if btrim(coalesce(p_input->>'supersede_reason',''))='' then raise exception 'supersede_reason_required' using errcode='22023'; end if;
    select array_agg((item->>'id')::uuid order by (item->>'id')::uuid),
           jsonb_object_agg(item->>'id',(item->>'base_version')::bigint)
      into v_ids,v_versions from jsonb_array_elements(p_input->'source_decisions') items(item);
    if cardinality(v_ids)<>(select count(distinct id) from unnest(v_ids) ids(id)) or
       exists(select 1 from jsonb_array_elements(p_input->'source_decisions') x where coalesce((x->>'base_version')::bigint,0)<=0) then
      raise exception 'invalid_source_decisions' using errcode='22023';
    end if;
    perform 1 from public.clued_memories where user_id=p_user_id and id=any(v_ids) order by id for update;
    foreach v_source_id in array v_ids loop
      select * into v_row from public.clued_memories where id=v_source_id and user_id=p_user_id and record_schema_version is not null;
      if not found or v_row.record_type<>'decision' or v_row.lifecycle_status<>'active' then raise exception 'active_decision_required' using errcode='22023'; end if;
      if v_row.version<>(v_versions->>v_row.id::text)::bigint then raise exception 'record_version_conflict' using errcode='40001'; end if;
      if v_scope is null then v_scope:=v_row.canonical_scope; elsif v_scope<>v_row.canonical_scope then raise exception 'decision_scope_mismatch' using errcode='22023'; end if;
    end loop;
    if v_repl->>'scope'<>v_scope then raise exception 'decision_scope_mismatch' using errcode='22023'; end if;
    v_replacement_id:=coalesce(nullif(v_repl->>'id','')::uuid,gen_random_uuid());
    if exists(select 1 from public.clued_memories where id=v_replacement_id) then raise exception 'record_id_exists' using errcode='23505'; end if;
    v_type_fields:=coalesce(v_repl->'type_fields','{}'); v_relations:=coalesce(v_repl->'relations','{}');
    perform clued_private.m1_validate_record_shape('decision',(v_repl->>'record_schema_version')::integer,v_type_fields,v_relations);
    if clued_private.m1_sorted_uuid_array(v_relations->'supersedes')<>v_ids then raise exception 'supersedes_set_mismatch' using errcode='22023'; end if;
    v_authority:=v_repl->>'authority';
    if p_binding_id is not null and v_authority='user_explicit' and coalesce((p_input->>'user_confirmed')::boolean,false)=false then raise exception 'authority_escalation_forbidden' using errcode='42501'; end if;
    v_sources:=clued_private.m1_sorted_uuid_array(v_repl->'source_refs');
    v_source_reason:=nullif(btrim(v_repl->>'source_unavailable_reason'),'');
    if v_authority in ('observed','inferred','imported') and cardinality(v_sources)=0 and v_source_reason is null then raise exception 'source_required' using errcode='22023'; end if;
    if exists(select 1 from unnest(v_sources) s(id) where not exists(select 1 from public.clued_evidence where id=s.id and user_id=p_user_id)) then raise exception 'evidence_not_authorized' using errcode='42501'; end if;
    update public.clued_memories set lifecycle_status='superseded',status='superseded',closed_at=now(),closed_reason=p_input->>'supersede_reason',
      updated_at=now(),version=version+1,receipt_id=v_receipt.id where user_id=p_user_id and id=any(v_ids);
    select jsonb_object_agg(id::text,version) into v_committed from public.clued_memories where user_id=p_user_id and id=any(v_ids);
    insert into public.clued_memories(
      id,user_id,title,content,scope,project_id,record_type,status,priority,version,record_schema_version,lifecycle_status,
      canonical_scope,type_fields,relations,source_refs,source_unavailable_reason,authority,observed_at,confidence,
      confidence_reason,receipt_id,content_hash
    ) values (
      v_replacement_id,p_user_id,v_repl->>'title',v_repl->>'content',case when v_scope='global' then 'global' else 'project' end,
      clued_private.m1_scope_project_id(v_scope),'decision','active',0,1,(v_repl->>'record_schema_version')::integer,'active',
      v_scope,v_type_fields,v_relations,v_sources,v_source_reason,v_authority,nullif(v_repl->>'observed_at','')::timestamptz,
      nullif(v_repl->>'confidence','')::numeric,coalesce(v_repl->>'confidence_reason',''),v_receipt.id,
      clued_private.m1_record_content_hash('decision',v_scope,'active',v_repl->>'title',v_repl->>'content',v_type_fields,v_relations,
        v_sources,v_source_reason,v_authority,nullif(v_repl->>'observed_at','')::timestamptz,null,
        nullif(v_repl->>'confidence','')::numeric,coalesce(v_repl->>'confidence_reason',''))
    ) returning * into v_replacement;
    v_committed:=v_committed||jsonb_build_object(v_replacement.id::text,1);
    select coalesce(jsonb_agg(jsonb_build_object('role','source','kind','record','id',id) order by id),'[]') into v_refs from unnest(v_ids) ids(id);
    v_refs:=v_refs||jsonb_build_array(jsonb_build_object('role','target','kind','record','id',v_replacement.id));
    v_event_id:=clued_private.m1_append_event_row(p_user_id,p_binding_id,v_receipt.id,v_receipt.canonical_version,'decision_superseded',
      v_refs,v_scope,null,'[]',p_input->>'idempotency_key',v_receipt.request_sha256,'success','work_log',v_sources,'[]',null);
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,'committed',v_refs,v_versions,v_committed,array[v_event_id],v_sources,null);
    return v_result||jsonb_build_object('replayed',false,'supplemental',jsonb_build_object('replacement',to_jsonb(v_replacement)-'user_id'));
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,case when v_state in ('22023','23505','40001','42501','P0002') then 'rejected' else 'failed' end,
      '[]',coalesce(v_versions,'{}'),'{}','{}','{}',v_error);
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
        and certainty_status='confirmed' and dismissed_at is null and merged_into_project_id is null) then
        raise exception 'project_not_confirmed' using errcode='42501';
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
    v_error:=case when v_error in ('record_version_conflict','NOW_CONFLICT','record_not_found','project_not_confirmed',
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

create or replace function clued_private.m1_finish_receipt(
  p_receipt_id uuid,p_status text,p_target_refs jsonb,p_base_versions jsonb,
  p_committed_versions jsonb,p_event_ids text[],p_evidence_ids uuid[],p_error_code text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts%rowtype; v_result jsonb;
begin
  update public.clued_audit_receipts set
    status=p_status,target_refs=coalesce(p_target_refs,'[]'),base_versions=coalesce(p_base_versions,'{}'),
    committed_versions=coalesce(p_committed_versions,'{}'),event_ids=coalesce(p_event_ids,'{}'),
    evidence_ids=coalesce(p_evidence_ids,'{}'),error_code=p_error_code
  where id=p_receipt_id returning * into v_receipt;
  v_result:=clued_private.m1_result_envelope(v_receipt);
  update public.clued_audit_receipts set canonical_result=v_result,response_hash=clued_private.m1_sha256(v_result)
    where id=p_receipt_id;
  return v_result;
end $$;

create or replace function clued_private.m1_append_event_row(
  p_user_id uuid,p_binding_id uuid,p_receipt_id uuid,p_canonical_version bigint,
  p_event_type text,p_target_refs jsonb,p_event_scope text,p_origin_scope text,
  p_change_summary jsonb,p_idempotency_key text,p_request_hash text,p_result text,
  p_audit_visibility text,p_evidence_refs uuid[],p_artifact_refs jsonb,p_error_code text
) returns text language plpgsql security definer set search_path='' as $$
declare v_id bigint; v_hash text; v_material jsonb;
begin
  if p_event_type not in ('record_created','record_updated','record_closed','record_restored','decision_superseded',
    'project_created','project_updated','project_completed','project_archived','project_restored','scope_changed',
    'evidence_linked','evidence_unlinked','operation_failed','system_operation_failed')
    and p_event_type !~ '^extension:[a-z0-9_.-]+:[a-z0-9_.-]+$' then
    raise exception 'invalid_event_type' using errcode='22023';
  end if;
  if p_event_scope<>'profile' and p_event_scope<>'global' and p_event_scope !~ '^project:[0-9a-f-]{36}$' then
    raise exception 'invalid_event_scope' using errcode='22023';
  end if;
  v_material:=jsonb_build_object(
    'event_schema_version',1,'event_stream_id',null,'stream_generation',null,'event_sequence',null,
    'committed_canonical_version',p_canonical_version,'event_type',p_event_type,
    'target_refs',coalesce(p_target_refs,'[]'),'event_scope',p_event_scope,'origin_scope',p_origin_scope,
    'change_summary',p_change_summary,'idempotency_key',p_idempotency_key,'request_hash',p_request_hash,
    'actor_binding_id',coalesce(p_binding_id::text,'user_session'),'actor_user_id',p_user_id,
    'result',p_result,'receipt_id',p_receipt_id,'audit_visibility',p_audit_visibility,
    'evidence_refs',coalesce(to_jsonb(p_evidence_refs),'[]'),'artifact_refs',coalesce(p_artifact_refs,'[]'),
    'error_code',p_error_code
  );
  v_hash:=clued_private.m1_sha256(v_material);
  insert into public.clued_context_events(
    user_id,binding_id,context_key,event_type,payload,idempotency_key,
    event_schema_version,event_stream_id,stream_generation,event_sequence,committed_canonical_version,
    canonical_event_type,target_refs,event_scope,origin_scope,change_summary,request_hash,
    actor_binding_ref,actor_user_id,result,receipt_id,audit_visibility,evidence_refs,artifact_refs,error_code,content_hash
  ) values (
    p_user_id,p_binding_id,p_event_scope,case when p_result='failure' then 'failure' else 'action' end,
    jsonb_build_object('canonical_event_type',p_event_type),p_idempotency_key,
    1,null,null,null,p_canonical_version,p_event_type,coalesce(p_target_refs,'[]'),p_event_scope,p_origin_scope,
    p_change_summary,p_request_hash,coalesce(p_binding_id::text,'user_session'),p_user_id,p_result,p_receipt_id,
    p_audit_visibility,coalesce(p_evidence_refs,'{}'),coalesce(p_artifact_refs,'[]'),p_error_code,v_hash
  ) returning id into v_id;
  return v_id::text;
end $$;

create or replace function clued_private.m1_validate_record_shape(
  p_record_type text,p_schema_version integer,p_type_fields jsonb,p_relations jsonb
) returns void language plpgsql immutable set search_path='' as $$
begin
  if p_schema_version<>1 or p_record_type not in ('state','task','decision','profile_fact','note') then
    raise exception 'invalid_record_schema' using errcode='22023';
  end if;
  if jsonb_typeof(coalesce(p_type_fields,'{}'))<>'object' or jsonb_typeof(coalesce(p_relations,'{}'))<>'object' then
    raise exception 'invalid_record_shape' using errcode='22023';
  end if;
  if p_record_type='task' and coalesce(p_type_fields->>'execution_bucket','') not in ('now','next','blocked','later') then
    raise exception 'invalid_task_execution_bucket' using errcode='22023';
  elsif p_record_type='decision' and not (p_type_fields ? 'rationale') then
    raise exception 'decision_rationale_required' using errcode='22023';
  elsif p_record_type='state' and not (p_type_fields ? 'state_kind') then
    raise exception 'state_kind_required' using errcode='22023';
  elsif p_record_type='profile_fact' and not (p_type_fields ? 'fact_kind') then
    raise exception 'fact_kind_required' using errcode='22023';
  elsif p_record_type='note' and not (p_type_fields ? 'note_kind') then
    raise exception 'note_kind_required' using errcode='22023';
  end if;
end $$;

create or replace function clued_private.m1_record_content_hash(
  p_record_type text,p_scope text,p_lifecycle text,p_title text,p_content text,p_type_fields jsonb,
  p_relations jsonb,p_source_refs uuid[],p_source_unavailable_reason text,p_authority text,
  p_observed_at timestamptz,p_closed_at timestamptz,p_confidence numeric,p_confidence_reason text
) returns text language sql stable set search_path='' as $$
  select clued_private.m1_sha256(jsonb_build_object(
    'record_type',p_record_type,'scope',p_scope,'lifecycle_status',p_lifecycle,'title',p_title,'content',p_content,
    'type_fields',coalesce(p_type_fields,'{}'),'relations',coalesce(p_relations,'{}'),
    'source_refs',coalesce(to_jsonb(p_source_refs),'[]'),'source_unavailable_reason',p_source_unavailable_reason,
    'authority',p_authority,'observed_at',p_observed_at,'closed_at',p_closed_at,
    'confidence',p_confidence,'confidence_reason',p_confidence_reason
  ))
$$;

create or replace function clued_private.m1_effective_project(p_user_id uuid,p_project_id uuid)
returns uuid language plpgsql stable security definer set search_path='' as $$
declare v_current uuid:=p_project_id; v_next uuid; v_seen uuid[]:='{}';
begin
  loop
    if v_current is null or v_current=any(v_seen) then raise exception 'project_redirect_cycle' using errcode='23514'; end if;
    v_seen:=array_append(v_seen,v_current);
    select merged_into_project_id into v_next from public.clued_projects
      where id=v_current and user_id=p_user_id;
    if not found then raise exception 'project_not_found' using errcode='P0002'; end if;
    if v_next is null then return v_current; end if;
    v_current:=v_next;
  end loop;
end $$;

create or replace function clued_private.m1_result_envelope(p_receipt public.clued_audit_receipts)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object(
    'status',p_receipt.status,'target_refs',coalesce(p_receipt.target_refs,'[]'::jsonb),
    'committed_versions',coalesce(p_receipt.committed_versions,'{}'::jsonb),
    'canonical_version',p_receipt.canonical_version,'event_ids',coalesce(to_jsonb(p_receipt.event_ids),'[]'::jsonb),
    'evidence_ids',coalesce(to_jsonb(p_receipt.evidence_ids),'[]'::jsonb),
    'artifact_refs',coalesce(p_receipt.artifact_refs,'[]'::jsonb),'error_code',p_receipt.error_code,
    'receipt_id',p_receipt.id
  )
$$;

create or replace function clued_private.m1_begin_receipt(
  p_user_id uuid,p_binding_id uuid,p_operation text,p_input jsonb,p_received_payload_hash text
) returns public.clued_audit_receipts
language plpgsql security definer set search_path='' as $$
declare v_key text:=btrim(coalesce(p_input->>'idempotency_key','')); v_hash text;
  v_existing public.clued_audit_receipts%rowtype; v_receipt public.clued_audit_receipts%rowtype;
begin
  if p_user_id is null then raise exception 'account_required' using errcode='28000'; end if;
  if char_length(v_key) not between 8 and 160 then raise exception 'invalid_idempotency_key' using errcode='22023'; end if;
  if coalesce(p_received_payload_hash,'') !~ '^[0-9a-f]{64}$' then raise exception 'invalid_received_payload_hash' using errcode='22023'; end if;
  v_hash:=clued_private.m1_sha256(jsonb_build_object('operation',p_operation,'payload',(p_input-'idempotency_key'-'request_hash')));
  if p_input ? 'request_hash' and p_input->>'request_hash' is distinct from v_hash then
    select * into v_existing from public.clued_audit_receipts
      where user_id=p_user_id and operation_family=p_operation and idempotency_key=v_key and owns_idempotency_key;
    insert into public.clued_audit_receipts(
      user_id,binding_id,context_key,operation,object_type,idempotency_key,request_sha256,
      receipt_schema_version,operation_family,status,received_payload_hash,target_refs,base_versions,
      committed_versions,canonical_version,event_ids,evidence_ids,artifact_refs,related_receipt_id,
      error_code,owns_idempotency_key
    ) values (
      p_user_id,p_binding_id,'m1:'||p_operation||case when found then ':hash-mismatch:'||gen_random_uuid() else '' end,
      p_operation,'request',v_key,v_hash,1,p_operation,'rejected',p_received_payload_hash,'[]','{}','{}',
      nextval('clued_private.canonical_version_seq'),'{}','{}','[]',v_existing.id,'REQUEST_HASH_MISMATCH',not found
    ) returning * into v_receipt;
    v_receipt.canonical_result:=clued_private.m1_result_envelope(v_receipt);
    v_receipt.response_hash:=clued_private.m1_sha256(v_receipt.canonical_result);
    update public.clued_audit_receipts set canonical_result=v_receipt.canonical_result,response_hash=v_receipt.response_hash where id=v_receipt.id;
    return v_receipt;
  end if;
  select * into v_existing from public.clued_audit_receipts
    where user_id=p_user_id and operation_family=p_operation and idempotency_key=v_key and owns_idempotency_key;
  if found then
    if v_existing.request_sha256=v_hash then return v_existing; end if;
    insert into public.clued_audit_receipts(
      user_id,binding_id,context_key,operation,object_type,idempotency_key,request_sha256,
      receipt_schema_version,operation_family,status,received_payload_hash,target_refs,base_versions,
      committed_versions,canonical_version,event_ids,evidence_ids,artifact_refs,related_receipt_id,
      error_code,owns_idempotency_key
    ) values (
      p_user_id,p_binding_id,'m1:'||p_operation||':conflict:'||gen_random_uuid(),p_operation,'request',v_key,v_hash,
      1,p_operation,'rejected',p_received_payload_hash,'[]','{}','{}',nextval('clued_private.canonical_version_seq'),'{}','{}','[]',v_existing.id,
      'IDEMPOTENCY_KEY_CONFLICT',false
    ) returning * into v_receipt;
    v_receipt.canonical_result:=clued_private.m1_result_envelope(v_receipt);
    v_receipt.response_hash:=clued_private.m1_sha256(v_receipt.canonical_result);
    update public.clued_audit_receipts set canonical_result=v_receipt.canonical_result,response_hash=v_receipt.response_hash where id=v_receipt.id;
    return v_receipt;
  end if;
  insert into public.clued_audit_receipts(
    user_id,binding_id,context_key,operation,object_type,idempotency_key,request_sha256,
    receipt_schema_version,operation_family,status,received_payload_hash,target_refs,base_versions,
    committed_versions,canonical_version,event_ids,evidence_ids,artifact_refs,owns_idempotency_key
  ) values (
    p_user_id,p_binding_id,'m1:'||p_operation,p_operation,'request',v_key,v_hash,
    1,p_operation,'pending',p_received_payload_hash,'[]','{}','{}',nextval('clued_private.canonical_version_seq'),'{}','{}','[]',true
  ) returning * into v_receipt;
  return v_receipt;
end $$;

-- Forward declarations keep privilege statements deterministic; full bodies
-- replace these declarations later in this migration.
create or replace function clued_private.canonical_export_core(uuid,uuid,jsonb,text)
returns jsonb language plpgsql security definer set search_path='' as $$ begin raise exception 'm1_not_ready'; end $$;
create or replace function clued_private.evidence_ingest_core(uuid,uuid,jsonb,text)
returns jsonb language plpgsql security definer set search_path='' as $$ begin raise exception 'm1_not_ready'; end $$;
create or replace function clued_private.append_event_core(uuid,uuid,jsonb,text)
returns jsonb language plpgsql security definer set search_path='' as $$ begin raise exception 'm1_not_ready'; end $$;

create or replace function public.clued_record_mutate(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',coalesce(p_input->>'scope','global'));
  return clued_private.record_mutation_core(v_binding.user_id,v_binding.id,p_input,
    clued_private.m1_sha256(jsonb_build_object('operation','record_mutation','payload',p_input)));
end $$;
create or replace function public.clued_decision_supersede(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',coalesce(p_input->'replacement'->>'scope','global'));
  return clued_private.decision_supersede_core(v_binding.user_id,v_binding.id,p_input,
    clued_private.m1_sha256(jsonb_build_object('operation','decision_supersede','payload',p_input)));
end $$;
create or replace function public.clued_evidence_ingest(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write','global');
  return clued_private.evidence_ingest_core(v_binding.user_id,v_binding.id,p_input,
    clued_private.m1_sha256(jsonb_build_object('operation','evidence_ingest','payload',p_input)));
end $$;
create or replace function public.clued_event_append(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',coalesce(p_input->>'event_scope','global'));
  return clued_private.append_event_core(v_binding.user_id,v_binding.id,p_input,
    clued_private.m1_sha256(jsonb_build_object('operation','append_event','payload',p_input)));
end $$;
create or replace function public.clued_project_mutate(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write','system:projects');
  return clued_private.project_mutation_core(v_binding.user_id,v_binding.id,p_input,
    clued_private.m1_sha256(jsonb_build_object('operation','project_mutation','payload',p_input)));
end $$;
create or replace function public.clued_canonical_export(p_token_hash text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read','global');
  return clued_private.canonical_export_core(v_binding.user_id,v_binding.id,p_input,
    clued_private.m1_sha256(jsonb_build_object('operation','export','payload',p_input)));
end $$;

create or replace function public.clued_user_record_mutate(p_input jsonb,p_received_payload_hash text)
returns jsonb language sql security definer set search_path='' as $$
  select clued_private.record_mutation_core((select auth.uid()),null,p_input,p_received_payload_hash)
$$;
create or replace function public.clued_user_decision_supersede(p_input jsonb,p_received_payload_hash text)
returns jsonb language sql security definer set search_path='' as $$
  select clued_private.decision_supersede_core((select auth.uid()),null,p_input,p_received_payload_hash)
$$;
create or replace function public.clued_user_evidence_ingest(p_input jsonb,p_received_payload_hash text)
returns jsonb language sql security definer set search_path='' as $$
  select clued_private.evidence_ingest_core((select auth.uid()),null,p_input,p_received_payload_hash)
$$;
create or replace function public.clued_user_event_append(p_input jsonb,p_received_payload_hash text)
returns jsonb language sql security definer set search_path='' as $$
  select clued_private.append_event_core((select auth.uid()),null,p_input,p_received_payload_hash)
$$;
create or replace function public.clued_user_project_mutate(p_input jsonb,p_received_payload_hash text)
returns jsonb language sql security definer set search_path='' as $$
  select clued_private.project_mutation_core((select auth.uid()),null,p_input,p_received_payload_hash)
$$;
create or replace function public.clued_user_canonical_export(p_input jsonb,p_received_payload_hash text)
returns jsonb language sql security definer set search_path='' as $$
  select clued_private.canonical_export_core((select auth.uid()),null,p_input,p_received_payload_hash)
$$;

create or replace function public.clued_oauth_call(p_tool text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; v_input jsonb:=coalesce(p_input,'{}');
begin
  v_binding:=clued_private.resolve_oauth_binding();
  case p_tool
    when 'clued_session_resume' then return public.clued_mcp_restore(v_binding.token_hash,v_input);
    when 'clued_append_event' then return public.clued_mcp_append_event(v_binding.token_hash,v_input);
    when 'clued_session_checkpoint' then return public.clued_mcp_commit_checkpoint(v_binding.token_hash,v_input);
    when 'clued_search_context' then return public.clued_mcp_search_context(v_binding.token_hash,v_input);
    when 'clued_read_log' then return public.clued_mcp_read_log(v_binding.token_hash,v_input);
    when 'clued_import_log' then return public.clued_mcp_import_log(v_binding.token_hash,v_input);
    when 'clued_audit_receipts' then return public.clued_mcp_audit_receipts(v_binding.token_hash,v_input);
    when 'clued_project_list' then return public.clued_project_list(v_binding.token_hash,v_input);
    when 'clued_record_list' then return public.clued_record_list(v_binding.token_hash,v_input);
    when 'clued_record_mutate' then return public.clued_record_mutate(v_binding.token_hash,v_input);
    when 'clued_decision_supersede' then return public.clued_decision_supersede(v_binding.token_hash,v_input);
    when 'clued_evidence_ingest' then return public.clued_evidence_ingest(v_binding.token_hash,v_input);
    when 'clued_event_append' then return public.clued_event_append(v_binding.token_hash,v_input);
    when 'clued_project_mutate' then return public.clued_project_mutate(v_binding.token_hash,v_input);
    when 'clued_canonical_export' then return public.clued_canonical_export(v_binding.token_hash,v_input);
    else raise exception 'unknown_oauth_tool' using errcode='22023';
  end case;
end $$;

revoke all on function public.clued_record_write(text,jsonb) from anon;
revoke all on function public.clued_user_record_write(jsonb) from authenticated;
revoke all on function public.clued_project_observe(text,jsonb),public.clued_project_update(text,jsonb) from anon;
revoke all on function public.clued_user_project_observe(jsonb),public.clued_user_project_update(jsonb) from authenticated;

revoke all on function clued_private.m1_sha256(jsonb),clued_private.m1_sorted_uuid_array(jsonb),
  clued_private.m1_scope_project_id(text),clued_private.m1_effective_project(uuid,uuid),
  clued_private.m1_result_envelope(public.clued_audit_receipts),
  clued_private.m1_begin_receipt(uuid,uuid,text,jsonb,text),
  clued_private.m1_finish_receipt(uuid,text,jsonb,jsonb,jsonb,text[],uuid[],text),
  clued_private.m1_append_event_row(uuid,uuid,uuid,bigint,text,jsonb,text,text,jsonb,text,text,text,text,uuid[],jsonb,text),
  clued_private.m1_validate_record_shape(text,integer,jsonb,jsonb),
  clued_private.m1_record_content_hash(text,text,text,text,text,jsonb,jsonb,uuid[],text,text,timestamptz,timestamptz,numeric,text),
  clued_private.record_mutation_core(uuid,uuid,jsonb,text),clued_private.decision_supersede_core(uuid,uuid,jsonb,text),
  clued_private.evidence_ingest_core(uuid,uuid,jsonb,text),clued_private.append_event_core(uuid,uuid,jsonb,text),
  clued_private.project_mutation_core(uuid,uuid,jsonb,text),clued_private.canonical_export_core(uuid,uuid,jsonb,text)
from public,anon,authenticated;

revoke all on function public.clued_record_mutate(text,jsonb),public.clued_decision_supersede(text,jsonb),
  public.clued_evidence_ingest(text,jsonb),public.clued_event_append(text,jsonb),public.clued_project_mutate(text,jsonb),
  public.clued_canonical_export(text,jsonb) from public,authenticated;
grant execute on function public.clued_record_mutate(text,jsonb),public.clued_decision_supersede(text,jsonb),
  public.clued_evidence_ingest(text,jsonb),public.clued_event_append(text,jsonb),public.clued_project_mutate(text,jsonb),
  public.clued_canonical_export(text,jsonb) to anon;
revoke all on function public.clued_user_record_mutate(jsonb,text),public.clued_user_decision_supersede(jsonb,text),
  public.clued_user_evidence_ingest(jsonb,text),public.clued_user_event_append(jsonb,text),public.clued_user_project_mutate(jsonb,text),
  public.clued_user_canonical_export(jsonb,text) from public,anon;
grant execute on function public.clued_user_record_mutate(jsonb,text),public.clued_user_decision_supersede(jsonb,text),
  public.clued_user_evidence_ingest(jsonb,text),public.clued_user_event_append(jsonb,text),public.clued_user_project_mutate(jsonb,text),
  public.clued_user_canonical_export(jsonb,text) to authenticated;

notify pgrst,'reload schema';

create or replace function clued_private.canonical_export_core(
  p_user_id uuid,p_binding_id uuid,p_input jsonb,p_received_payload_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts%rowtype; v_result jsonb; v_snapshot jsonb;
  v_projects jsonb; v_records jsonb; v_events jsonb; v_evidence jsonb;
  v_legacy_records jsonb; v_legacy_events jsonb; v_receipt_refs jsonb; v_views_complete boolean;
begin
  v_receipt:=clued_private.m1_begin_receipt(p_user_id,p_binding_id,'export',p_input,p_received_payload_hash);
  if v_receipt.status<>'pending' then return jsonb_build_object('replayed',true,'receipt',coalesce(v_receipt.canonical_result,clued_private.m1_result_envelope(v_receipt)));
  end if;
  select coalesce(jsonb_agg(to_jsonb(p)-'user_id' order by p.canonical_project_id),'[]') into v_projects
    from public.clued_projects_m1 p where p.user_id=p_user_id;
  select coalesce(jsonb_agg(to_jsonb(r)-'user_id' order by r.id),'[]') into v_records
    from public.clued_records_m1 r where r.user_id=p_user_id;
  select coalesce(jsonb_agg((to_jsonb(e)-'user_id'-'actor_user_id')||jsonb_build_object(
    'actor_kind',case when e.actor_binding_id='user_session' then 'user' else 'agent_binding' end) order by e.event_id),'[]') into v_events
    from public.clued_events_m1 e where e.user_id=p_user_id;
  select coalesce(jsonb_agg((to_jsonb(e)-'user_id'-'binding_id')||jsonb_build_object(
    'evidence_id',e.id,'referenced_by',coalesce((select jsonb_agg(r.id order by r.id) from public.clued_records_m1 r where r.user_id=p_user_id and e.id=any(r.source_refs)),'[]'),
    'derived_scopes',coalesce((select jsonb_agg(distinct r.scope order by r.scope) from public.clued_records_m1 r where r.user_id=p_user_id and e.id=any(r.source_refs)),'[]'),
    'export_disposition','omitted','omitted_reason','protected evidence payload') order by e.id),'[]') into v_evidence
    from public.clued_evidence e where e.user_id=p_user_id and exists(
      select 1 from public.clued_records_m1 r where r.user_id=p_user_id and e.id=any(r.source_refs));
  select coalesce(jsonb_agg(jsonb_build_object(
    'kind','legacy_record','legacy_id',m.id,'legacy_schema_version',null,'legacy_record_type',m.record_type,
    'inline_payload',jsonb_build_object('id',m.id,'title',m.title,'content',m.content,'scope',m.scope,'project_id',m.project_id,
      'record_type',m.record_type,'record_key',m.record_key,'status',m.status,'priority',m.priority,'version',m.version,
      'source_ref',m.source_ref,'created_at',m.created_at,'updated_at',m.updated_at,'archived_at',m.archived_at),
    'protected_payload_ref',null,'content_hash',clued_private.m1_sha256(to_jsonb(m)-'user_id'),
    'missing_required_fields',jsonb_build_array('record_schema_version','lifecycle_status','receipt_id'),
    'migration_status','pending_review','omitted_reason',null) order by m.id),'[]') into v_legacy_records
    from public.clued_memories m where m.user_id=p_user_id and m.record_schema_version is null;
  select coalesce(jsonb_agg(jsonb_build_object(
    'kind','legacy_event','legacy_id',e.id::text,'legacy_schema_version',null,'legacy_record_type',null,
    'inline_payload',jsonb_build_object('event_type',e.event_type,'context_key',e.context_key,'payload',e.payload,
      'base_version',e.base_version,'occurred_at',e.occurred_at,'project_id',e.project_id,'record_id',e.record_id,'record_version',e.record_version),
    'protected_payload_ref',null,'content_hash',clued_private.m1_sha256(to_jsonb(e)-'user_id'-'binding_id'),
    'missing_required_fields',jsonb_build_array('event_schema_version','committed_canonical_version','audit_visibility','receipt_id'),
    'migration_status','preserved_audit_only','omitted_reason',null) order by e.id),'[]') into v_legacy_events
    from public.clued_context_events e where e.user_id=p_user_id and e.event_schema_version is null;
  select not exists(select 1 from public.clued_memories m where m.user_id=p_user_id and m.record_schema_version is null
    and m.record_type<>'archive_snapshot' and m.status not in ('done','cancelled','superseded','archived')) into v_views_complete;
  select coalesce(jsonb_agg(distinct id::text order by id::text),'[]') into v_receipt_refs from (
    select receipt_id as id from public.clued_records_m1 where user_id=p_user_id and receipt_id is not null
    union all select receipt_id from public.clued_projects_m1 where user_id=p_user_id and receipt_id is not null
    union all select receipt_id from public.clued_events_m1 where user_id=p_user_id and receipt_id is not null
    union all select receipt_id from public.clued_evidence where user_id=p_user_id
    union all select v_receipt.id
  ) refs;
  v_snapshot:=jsonb_build_object(
    'schema_version',1,'canonical_version','cv_'||v_receipt.canonical_version,'source_verification','live_rechecked',
    'views_complete',v_views_complete,'owner_ref','owner_'||left(encode(extensions.digest(convert_to(p_user_id::text,'UTF8'),'sha256'),'hex'),24),
    'export_receipt_id',v_receipt.id,'projects',v_projects,'records',v_records,'events',v_events,'evidence',v_evidence,
    'referenced_receipts',v_receipt_refs,'legacy_projects','[]'::jsonb,'legacy_records',v_legacy_records,
    'legacy_events',v_legacy_events,'legacy_evidence','[]'::jsonb,'excluded_evidence_counts',jsonb_build_object(
      'unlinked',(select count(*) from public.clued_evidence e where e.user_id=p_user_id and not exists(
        select 1 from public.clued_records_m1 r where r.user_id=p_user_id and e.id=any(r.source_refs))))
  );
  v_result:=clued_private.m1_finish_receipt(v_receipt.id,'committed','[]','{}','{}','{}','{}',null);
  update public.clued_audit_receipts set artifact_refs=jsonb_build_array(jsonb_build_object(
    'kind','export','id','cv_'||v_receipt.canonical_version,'content_hash',clued_private.m1_sha256(v_snapshot))) where id=v_receipt.id;
  return jsonb_build_object('replayed',false,'receipt',v_result,'snapshot',v_snapshot);
end $$;

alter table public.clued_memories drop constraint if exists clued_memories_v2_shape_check;
alter table public.clued_memories add constraint clued_memories_m1_shape_check check (
  (record_schema_version is null and record_type in ('note','state','task','decision','archive_snapshot')) or
  (record_schema_version=1 and record_type in ('state','task','decision','profile_fact','note')
    and lifecycle_status in ('active','completed','cancelled','superseded','archived','revoked','merged')
    and (canonical_scope in ('profile','global') or canonical_scope ~ '^project:[0-9a-f-]{36}$')
    and jsonb_typeof(type_fields)='object' and jsonb_typeof(relations)='object'
    and source_refs is not null and authority in ('user_explicit','observed','inferred','imported')
    and confidence_reason is not null and content_hash ~ '^[0-9a-f]{64}$')
) not valid;
alter table public.clued_memories validate constraint clued_memories_m1_shape_check;

create or replace view public.clued_records_m1 with (security_invoker=true) as
select id,user_id,record_schema_version,record_type,lifecycle_status,canonical_scope as scope,title,content,
  type_fields,relations,source_refs,source_unavailable_reason,closure_summary,closed_reason,closed_at,authority,
  observed_at,created_at as recorded_at,updated_at,confidence,confidence_reason,version,receipt_id,content_hash,
  merged_into_record_id
from public.clued_memories where record_schema_version is not null;

create or replace view public.clued_projects_m1 with (security_invoker=true) as
select id as canonical_project_id,user_id,coalesce(project_schema_version,1) as project_schema_version,name,certainty_status,
  case when progress_status='not_started' then 'paused' else progress_status end as progress_status,
  coalesce(lifecycle_status,case when merged_into_project_id is null then 'active' else 'merged' end) as lifecycle_status,
  merged_into_project_id,aliases,closure_summary,closed_reason,closed_at,coalesce(merge_generation,0) as merge_generation,
  version,created_at as recorded_at,updated_at,receipt_id
from public.clued_projects;

create or replace view public.clued_events_m1 with (security_invoker=true) as
select id::text as event_id,user_id,event_schema_version,event_stream_id,stream_generation,event_sequence,
  committed_canonical_version,canonical_event_type as event_type,target_refs,event_scope,origin_scope,change_summary,
  idempotency_key,request_hash,actor_binding_ref as actor_binding_id,actor_user_id,occurred_at,result,receipt_id,
  audit_visibility,evidence_refs,artifact_refs,error_code,content_hash
from public.clued_context_events where event_schema_version is not null;

revoke all on table public.clued_records_m1,public.clued_projects_m1,public.clued_events_m1 from public,anon,authenticated;
grant select on table public.clued_records_m1,public.clued_projects_m1,public.clued_events_m1 to authenticated;

create or replace function clued_private.evidence_ingest_core(
  p_user_id uuid,p_binding_id uuid,p_input jsonb,p_received_payload_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts%rowtype; v_evidence public.clued_evidence%rowtype;
  v_id uuid; v_result jsonb; v_error text; v_state text; v_refs jsonb;
begin
  v_receipt:=clued_private.m1_begin_receipt(p_user_id,p_binding_id,'evidence_ingest',p_input,p_received_payload_hash);
  if v_receipt.status<>'pending' then return coalesce(v_receipt.canonical_result,clued_private.m1_result_envelope(v_receipt))
    ||jsonb_build_object('replayed',v_receipt.related_receipt_id is null); end if;
  begin
    if coalesce((p_input->>'evidence_schema_version')::integer,0)<>1 then raise exception 'invalid_evidence_schema' using errcode='22023'; end if;
    if p_input->>'evidence_type' not in ('user_quote','file','image','web_ref','test_output','legacy_document') then raise exception 'invalid_evidence_type' using errcode='22023'; end if;
    if coalesce(p_input->>'storage_ref','')='' or coalesce(p_input->>'content_hash','') !~ '^[0-9a-f]{64}$' then raise exception 'invalid_evidence_payload' using errcode='22023'; end if;
    v_id:=coalesce(nullif(p_input->>'evidence_id','')::uuid,gen_random_uuid());
    if exists(select 1 from public.clued_evidence where id=v_id) then raise exception 'evidence_id_exists' using errcode='23505'; end if;
    insert into public.clued_evidence(
      id,user_id,binding_id,evidence_schema_version,evidence_type,storage_ref,content_hash,mime_type,size_bytes,captured_at,receipt_id
    ) values (
      v_id,p_user_id,p_binding_id,1,p_input->>'evidence_type',p_input->>'storage_ref',p_input->>'content_hash',
      nullif(p_input->>'mime_type',''),nullif(p_input->>'size_bytes','')::bigint,nullif(p_input->>'captured_at','')::timestamptz,v_receipt.id
    ) returning * into v_evidence;
    v_refs:=jsonb_build_array(jsonb_build_object('role','primary','kind','evidence','id',v_evidence.id));
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,'committed',v_refs,jsonb_build_object(v_evidence.id::text,null),
      jsonb_build_object(v_evidence.id::text,1),'{}',array[v_evidence.id],null);
    return v_result||jsonb_build_object('replayed',false,'supplemental',jsonb_build_object('evidence',to_jsonb(v_evidence)-'user_id'-'binding_id'));
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,case when v_state in ('22023','23505','42501') then 'rejected' else 'failed' end,
      '[]','{}','{}','{}','{}',v_error);
    return v_result||jsonb_build_object('replayed',false);
  end;
end $$;

create or replace function clued_private.append_event_core(
  p_user_id uuid,p_binding_id uuid,p_input jsonb,p_received_payload_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts%rowtype; v_event_id text; v_result jsonb;
  v_error text; v_state text; v_scope text:=p_input->>'event_scope';
begin
  v_receipt:=clued_private.m1_begin_receipt(p_user_id,p_binding_id,'append_event',p_input,p_received_payload_hash);
  if v_receipt.status<>'pending' then return coalesce(v_receipt.canonical_result,clued_private.m1_result_envelope(v_receipt))
    ||jsonb_build_object('replayed',v_receipt.related_receipt_id is null); end if;
  begin
    if coalesce((p_input->>'event_schema_version')::integer,0)<>1 then raise exception 'invalid_event_schema' using errcode='22023'; end if;
    if p_input->>'event_type' !~ '^extension:[a-z0-9_.-]+:[a-z0-9_.-]+$' then raise exception 'external_event_type_requires_extension' using errcode='22023'; end if;
    if v_scope like 'project:%' then perform clued_private.m1_effective_project(p_user_id,clued_private.m1_scope_project_id(v_scope)); end if;
    v_event_id:=clued_private.m1_append_event_row(p_user_id,p_binding_id,v_receipt.id,v_receipt.canonical_version,
      p_input->>'event_type',coalesce(p_input->'target_refs','[]'),v_scope,null,p_input->'change_summary',
      p_input->>'idempotency_key',v_receipt.request_sha256,'success',coalesce(p_input->>'audit_visibility','audit_only'),
      clued_private.m1_sorted_uuid_array(p_input->'evidence_refs'),coalesce(p_input->'artifact_refs','[]'),null);
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,'committed',coalesce(p_input->'target_refs','[]'),'{}','{}',array[v_event_id],
      clued_private.m1_sorted_uuid_array(p_input->'evidence_refs'),null);
    return v_result||jsonb_build_object('replayed',false);
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,case when v_state in ('22023','23505','42501','P0002') then 'rejected' else 'failed' end,
      '[]','{}','{}','{}','{}',v_error);
    return v_result||jsonb_build_object('replayed',false);
  end;
end $$;
