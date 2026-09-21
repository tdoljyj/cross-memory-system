-- K-CONT successor delta after 20260921193000 was already installed on
-- non-production clued-auth-test. Keep the applied predecessor immutable.
-- Bounds resume work-log rendering to the requested event page, carries the
-- same authorized global constraints as the structured view, and prevents a
-- single-context checkpoint from claiming coverage of unrelated contexts.

-- Resume work-log rendering is deliberately page-bound. The full clued_read_log
-- surface keeps its separate explicit-read contract; resume must never expand
-- beyond the caller's event page or lose authorized global constraints.
create or replace function clued_private.render_resume_log(
  p_user_id uuid,
  p_context_key text,
  p_events jsonb,
  p_constraints jsonb,
  p_conflicts jsonb,
  p_event_page jsonb
)
returns text language plpgsql security definer set search_path='' as $
declare
  v_checkpoint public.clued_context_checkpoints%rowtype;
  v_version bigint:=0;
  v_events text:='';
  v_constraints text:='';
  v_conflicts text:='';
  v_imported_markdown text;
  v_imported_version bigint;
begin
  select s.version into v_version from public.clued_context_streams s
   where s.user_id=p_user_id and s.context_key=p_context_key;
  select c.* into v_checkpoint from public.clued_context_heads h
    join public.clued_context_checkpoints c on c.id=h.checkpoint_id
   where h.user_id=p_user_id and h.context_key=p_context_key;

  select coalesce(string_agg(format('- %s · %s · %s',
    coalesce(item->>'occurred_at','unknown-time'),
    coalesce(item->>'type','unknown-type'),
    item::text),E'\n' order by ord),'') into v_events
  from jsonb_array_elements(coalesce(p_events,'[]'::jsonb)) with ordinality page(item,ord);

  select coalesce(string_agg(format('- `%s` — %s [scope=%s]',
    item->>'id',coalesce(item->>'title','Untitled constraint'),coalesce(item->>'scope',p_context_key)),
    E'\n' order by ord),'') into v_constraints
  from jsonb_array_elements(coalesce(p_constraints,'[]'::jsonb)) with ordinality page(item,ord);

  select coalesce(string_agg(format('- `%s` — %s [%s]',
    item->>'id',coalesce(item->>'title','Untitled decision'),coalesce(item->>'reason','review_required')),
    E'\n' order by ord),'') into v_conflicts
  from jsonb_array_elements(coalesce(p_conflicts,'[]'::jsonb)) with ordinality page(item,ord);

  select l.markdown,l.version into v_imported_markdown,v_imported_version
  from public.clued_log_versions l
  where l.user_id=p_user_id and l.context_key=p_context_key
  order by l.version desc limit 1;

  return '# 日志' || E'\n\n'
    || '- Context: `'||p_context_key||'`' || E'\n'
    || '- Version: `'||coalesce(v_version,0)::text||'`' || E'\n'
    || '- Canonical store: `clued-cloud/supabase`' || E'\n\n'
    || '## Latest checkpoint' || E'\n\n'
    || coalesce(v_checkpoint.summary,'No checkpoint yet.') || E'\n\n'
    || '### Next action' || E'\n\n'
    || coalesce(v_checkpoint.next_action,'Create the first checkpoint.') || E'\n\n'
    || '### Checkpoint coverage' || E'\n\n'
    || coalesce(v_checkpoint.checkpoint_coverage,'{}'::jsonb)::text || E'\n\n'
    || '## Active constraints' || E'\n\n'
    || case when v_constraints='' then 'No active constraints in this authorized view.' else v_constraints end || E'\n\n'
    || '## Authority conflicts' || E'\n\n'
    || case when v_conflicts='' then 'No newer active Decisions.' else v_conflicts end || E'\n\n'
    || '## Events not yet absorbed by a checkpoint (current page)' || E'\n\n'
    || '- Page: `'||coalesce(p_event_page,'{}'::jsonb)::text||'`' || E'\n\n'
    || case when v_events='' then 'No pending events on this page.' else v_events end
    || case when coalesce((p_event_page->>'truncated')::boolean,false)
      then E'\n\n> More pending events remain. Resume with the returned next_cursor.'
      else '' end
    || case when v_imported_markdown is null then E'\n'
      else E'\n\n---\n\n## Imported historical baseline\n\n'
        || '> Historical evidence only. The live checkpoint, constraints and authority conflicts above control current work.'
        || E'\n\n- Imported baseline version: `'||v_imported_version::text||'`' || E'\n\n'
        || pg_catalog.rtrim(regexp_replace(regexp_replace(
          v_imported_markdown,
          '(^|\\n)## Latest checkpoint',E'\\1## Imported checkpoint snapshot','g'),
          '(^|\\n)### Next action',E'\\1### Imported next-action snapshot','g')) || E'\n' end;
end $;

create or replace function public.clued_mcp_restore_before_project_access_v13(p_token_hash text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_binding public.clued_agent_bindings%rowtype;
  v_context_key text:=coalesce(nullif(btrim(p_input->>'context_key'),''),'global');
  v_client_session_id text:=nullif(btrim(p_input->>'client_session_id'),'');
  v_response_view text:=coalesce(nullif(btrim(p_input->>'response_view'),''),'structured');
  v_event_cursor bigint:=greatest(coalesce((p_input->>'event_cursor')::bigint,0),0);
  v_event_limit integer:=least(greatest(coalesce((p_input->>'event_limit')::integer,25),1),100);
  v_event_budget integer:=least(greatest(coalesce((p_input->>'event_budget_bytes')::integer,65536),4096),262144);
  v_checkpoint public.clued_context_checkpoints%rowtype;
  v_version bigint:=0; v_legacy_boundary bigint:=0;
  v_events jsonb:='[]'::jsonb; v_constraints jsonb:='[]'::jsonb; v_conflicts jsonb:='[]'::jsonb;
  v_pending_count bigint:=0; v_pending_bytes bigint:=0; v_page_count integer:=0;
  v_next_cursor bigint; v_truncated boolean:=false;
  v_session_id uuid; v_session_token text; v_session_hash text; v_receipt_id uuid;
  v_result jsonb;
begin
  if v_response_view not in ('structured','work_log') then raise exception 'invalid_response_view' using errcode='22023'; end if;
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_context_key);
  insert into public.clued_context_streams(user_id,context_key) values(v_binding.user_id,v_context_key)
    on conflict(user_id,context_key) do nothing;
  select s.version into v_version from public.clued_context_streams s
   where s.user_id=v_binding.user_id and s.context_key=v_context_key;
  select c.* into v_checkpoint from public.clued_context_heads h
    join public.clued_context_checkpoints c on c.id=h.checkpoint_id
   where h.user_id=v_binding.user_id and h.context_key=v_context_key;
  v_legacy_boundary:=coalesce(v_checkpoint.legacy_absorbed_through_event_id,coalesce(v_checkpoint.last_event_id,0));

  select count(*),coalesce(sum(octet_length(e.payload::text)+256),0) into v_pending_count,v_pending_bytes
  from public.clued_context_events e
  where e.user_id=v_binding.user_id and e.context_key=v_context_key and e.id>v_legacy_boundary
    and not exists(select 1 from public.clued_checkpoint_event_absorptions a
      where a.user_id=e.user_id and a.context_key=e.context_key and a.event_id=e.id);

  with candidate as (
    select e.id,jsonb_build_object(
      'id',e.id,'version',e.version,'type',e.event_type,'payload',e.payload,
      'canonical_event_type',e.canonical_event_type,'target_refs',coalesce(e.target_refs,'[]'::jsonb),
      'record_targets',coalesce((select jsonb_agg(jsonb_build_object(
        'id',m.id,'title',m.title,'record_type',m.record_type,'lifecycle_status',m.lifecycle_status))
        from jsonb_array_elements(coalesce(e.target_refs,'[]'::jsonb)) t
        join public.clued_memories m on (t->>'kind')='record' and (t->>'id')~'^[0-9a-f-]{36}$'
          and m.id=(case when (t->>'id')~'^[0-9a-f-]{36}$' then (t->>'id')::uuid else null end)
          and m.user_id=e.user_id),'[]'::jsonb),
      'occurred_at',e.occurred_at
    ) row_data
    from public.clued_context_events e
    where e.user_id=v_binding.user_id and e.context_key=v_context_key
      and e.id>v_legacy_boundary and e.id>v_event_cursor
      and not exists(select 1 from public.clued_checkpoint_event_absorptions a
        where a.user_id=e.user_id and a.context_key=e.context_key and a.event_id=e.id)
    order by e.id limit v_event_limit+1
  ), sized as (
    select *,row_number() over(order by id) page_pos,
      sum(octet_length(row_data::text)) over(order by id) running_bytes from candidate
  ), selected as (
    select * from sized where page_pos<=v_event_limit and (page_pos=1 or running_bytes<=v_event_budget)
  )
  select coalesce(jsonb_agg(row_data order by id),'[]'::jsonb),count(*)::integer,max(id)
    into v_events,v_page_count,v_next_cursor from selected;
  v_truncated:=v_page_count<v_pending_count and exists(
    select 1 from public.clued_context_events e
    where e.user_id=v_binding.user_id and e.context_key=v_context_key
      and e.id>v_legacy_boundary and e.id>coalesce(v_next_cursor,v_event_cursor)
      and not exists(select 1 from public.clued_checkpoint_event_absorptions a
        where a.user_id=e.user_id and a.context_key=e.context_key and a.event_id=e.id));
  if not v_truncated then v_next_cursor:=null; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',m.id,'title',m.title,'scope',m.canonical_scope,'version',m.version,
    'constraint',m.type_fields->'constraint','rationale',m.type_fields->'rationale','updated_at',m.updated_at)
    order by case when m.canonical_scope='global' then 0 else 1 end,m.updated_at desc,m.id),'[]'::jsonb)
    into v_constraints
  from public.clued_memories m
  where m.user_id=v_binding.user_id and m.record_schema_version is not null
    and m.record_type='decision' and m.lifecycle_status='active'
    and coalesce(m.type_fields->>'constraint','false')='true'
    and (m.canonical_scope=v_context_key or (
      m.canonical_scope='global' and ('*'=any(v_binding.context_keys) or 'global'=any(v_binding.context_keys))));

  select coalesce(jsonb_agg(jsonb_build_object(
    'status','review_required','reason','decision_newer_than_checkpoint','id',m.id,
    'title',m.title,'scope',m.canonical_scope,'version',m.version,'updated_at',m.updated_at)
    order by m.updated_at desc,m.id),'[]'::jsonb) into v_conflicts
  from public.clued_memories m
  where m.user_id=v_binding.user_id and m.record_schema_version is not null
    and m.record_type='decision' and m.lifecycle_status='active'
    and m.updated_at>coalesce(v_checkpoint.created_at,'epoch'::timestamptz)
    and (m.canonical_scope=v_context_key or (
      m.canonical_scope='global' and ('*'=any(v_binding.context_keys) or 'global'=any(v_binding.context_keys))));

  if v_client_session_id is not null then update public.clued_continuity_sessions set ended_at=now()
    where binding_id=v_binding.id and context_key=v_context_key and client_session_id=v_client_session_id and ended_at is null; end if;
  v_session_token:='clued_ses_'||encode(extensions.gen_random_bytes(32),'hex');
  v_session_hash:=encode(extensions.digest(convert_to(v_session_token,'UTF8'),'sha256'),'hex');
  insert into public.clued_continuity_sessions(user_id,binding_id,context_key,token_hash,restored_version,client_session_id)
  values(v_binding.user_id,v_binding.id,v_context_key,v_session_hash,v_version,v_client_session_id)
  returning id into v_session_id;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(v_binding.user_id,v_binding.id,v_context_key,'restore','session',v_session_id::text,v_version,
    jsonb_build_object('pending_event_count',v_pending_count,'pending_event_bytes',v_pending_bytes,
      'client_session_id',v_client_session_id,'response_view',v_response_view,'event_cursor',v_event_cursor))
  returning id into v_receipt_id;

  v_result:=jsonb_build_object(
    'status',case when v_checkpoint.id is null then 'empty' else 'restored' end,
    'context_key',v_context_key,'version',v_version,'session_token',v_session_token,'session_expires_in',3600,
    'snapshot',coalesce(v_checkpoint.snapshot,'{}'::jsonb),'summary',v_checkpoint.summary,
    'next_action',v_checkpoint.next_action,'checkpoint_coverage',coalesce(v_checkpoint.checkpoint_coverage,'{}'::jsonb),
    'active_constraints',v_constraints,'authority_conflicts',v_conflicts,
    'pending_event_count',v_pending_count,'pending_event_bytes',v_pending_bytes,
    'checkpoint_recommended',(v_pending_count>=20 or v_pending_bytes>=32768),
    'checkpoint_recommendation_reason',case when v_pending_count>=20 or v_pending_bytes>=32768
      then 'pending_event_threshold_reached' else null end,
    'event_page',jsonb_build_object('cursor',v_event_cursor,'next_cursor',v_next_cursor,
      'limit',v_event_limit,'budget_bytes',v_event_budget,'returned',v_page_count,'truncated',v_truncated),
    'session_compliance',jsonb_build_object('state','active','required_next','checkpoint_before_handoff'),
    'provenance',jsonb_build_object('canonical_store','clued-cloud/supabase','checkpoint_id',v_checkpoint.id,
      'checkpoint_created_at',v_checkpoint.created_at,'source_binding_id',v_checkpoint.binding_id),
    'receipt_id',v_receipt_id
  );
  if v_response_view='work_log' then
    return v_result||jsonb_build_object('work_log',clued_private.render_resume_log(
      v_binding.user_id,v_context_key,v_events,v_constraints,v_conflicts,
      jsonb_build_object('cursor',v_event_cursor,'next_cursor',v_next_cursor,
        'limit',v_event_limit,'budget_bytes',v_event_budget,'returned',v_page_count,'truncated',v_truncated)));
  end if;
  return v_result||jsonb_build_object('events_after_checkpoint',v_events);
end $$;

create or replace function public.clued_mcp_commit_checkpoint(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_binding public.clued_agent_bindings%rowtype; v_session public.clued_continuity_sessions%rowtype;
  v_context_key text:=coalesce(nullif(btrim(p_input->>'context_key'),''),'global');
  v_base_version bigint; v_current_version bigint; v_new_version bigint;
  v_snapshot jsonb:=p_input->'snapshot'; v_summary text:=btrim(coalesce(p_input->>'summary',''));
  v_next_action text:=btrim(coalesce(p_input->>'next_action',''));
  v_idempotency_key text:=nullif(btrim(p_input->>'idempotency_key'),'');
  v_coverage jsonb:=p_input->'coverage'; v_event_ids bigint[]:='{}';
  v_previous_id uuid; v_checkpoint_id uuid; v_receipt_id uuid;
  v_last_event_id bigint:=0; v_legacy_boundary bigint:=0; v_pending_after bigint:=0;
  v_existing public.clued_context_checkpoints%rowtype; v_original_base bigint; v_original_receipt_count bigint;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',v_context_key);
  v_session:=clued_private.resolve_session(v_binding.user_id,v_binding.id,v_context_key,p_input->>'session_token');
  if not (p_input?'base_version') then raise exception 'base_version_required' using errcode='22023'; end if;
  v_base_version:=(p_input->>'base_version')::bigint;
  if v_base_version is null or v_base_version<0 then raise exception 'invalid_base_version' using errcode='22023'; end if;
  if v_snapshot is null or jsonb_typeof(v_snapshot)<>'object' then raise exception 'snapshot_must_be_object' using errcode='22023'; end if;
  if char_length(v_summary) not between 1 and 4000 then raise exception 'invalid_summary_length' using errcode='22023'; end if;
  if char_length(v_next_action) not between 1 and 1000 then raise exception 'invalid_next_action_length' using errcode='22023'; end if;
  if v_coverage is null or coalesce(jsonb_typeof(v_coverage),'')<>'object' or v_coverage->>'mode'<>'explicit'
    or coalesce(jsonb_typeof(v_coverage->'contexts'),'')<>'array'
    or coalesce(jsonb_typeof(v_coverage->'tracks'),'')<>'array'
    or coalesce(jsonb_typeof(v_coverage->'event_ids'),'')<>'array' then
    raise exception 'checkpoint_coverage_required' using errcode='22023';
  end if;
  if jsonb_array_length(v_coverage->'contexts')<>1
    or v_coverage->'contexts'<>jsonb_build_array(v_context_key) then
    raise exception 'checkpoint_context_not_covered' using errcode='22023';
  end if;
  if jsonb_array_length(v_coverage->'tracks')<1 then raise exception 'checkpoint_tracks_required' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements_text(v_coverage->'tracks') t(value)
    where char_length(btrim(value)) not between 1 and 80) then raise exception 'invalid_checkpoint_track' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements_text(v_coverage->'event_ids') t(value)
    where value!~'^[0-9]+$') then raise exception 'invalid_checkpoint_event_id' using errcode='22023'; end if;
  select coalesce(array_agg(value::bigint order by value::bigint),'{}') into v_event_ids
    from jsonb_array_elements_text(v_coverage->'event_ids') t(value);
  if cardinality(v_event_ids)<>cardinality(array(select distinct covered.event_id from unnest(v_event_ids) as covered(event_id))) then
    raise exception 'duplicate_checkpoint_event_id' using errcode='22023';
  end if;
  if v_idempotency_key is not null and char_length(v_idempotency_key) not between 8 and 160 then raise exception 'invalid_idempotency_key' using errcode='22023'; end if;
  if v_idempotency_key is not null then
    perform pg_advisory_xact_lock(hashtextextended('clued-checkpoint:'||v_binding.user_id::text||':'||v_binding.id::text||':'||v_idempotency_key,0));
    select c.* into v_existing from public.clued_context_checkpoints c
      where c.user_id=v_binding.user_id and c.binding_id=v_binding.id and c.idempotency_key=v_idempotency_key;
    if found then
      select count(*),min((r.metadata->>'base_version')::bigint),(array_agg(r.id))[1]
        into v_original_receipt_count,v_original_base,v_receipt_id from public.clued_audit_receipts r
       where r.user_id=v_binding.user_id and r.binding_id=v_binding.id and r.operation='checkpoint'
         and r.object_id=v_existing.id::text and r.version=v_existing.version;
      if v_original_receipt_count<>1 or v_original_base is null or v_existing.context_key is distinct from v_context_key
        or v_original_base is distinct from v_base_version or v_existing.snapshot is distinct from v_snapshot
        or v_existing.summary is distinct from v_summary or v_existing.next_action is distinct from v_next_action
        or v_existing.checkpoint_coverage is distinct from v_coverage then
        return jsonb_build_object('status','conflict','error','idempotency_key_conflict','context_key',v_context_key);
      end if;
      return jsonb_build_object('status','duplicate','checkpoint_id',v_existing.id,'version',v_existing.version,
        'context_key',v_existing.context_key,'receipt_id',v_receipt_id,'checkpoint_coverage',v_existing.checkpoint_coverage);
    end if;
  end if;
  select s.version into v_current_version from public.clued_context_streams s
    where s.user_id=v_binding.user_id and s.context_key=v_context_key for update;
  if not found then raise exception 'resume_required' using errcode='42501'; end if;
  if v_base_version<>v_current_version then return jsonb_build_object('status','conflict','error','stale_base_version',
    'expected_version',v_current_version,'provided_version',v_base_version,'context_key',v_context_key); end if;
  select h.checkpoint_id,c.legacy_absorbed_through_event_id into v_previous_id,v_legacy_boundary
    from public.clued_context_heads h join public.clued_context_checkpoints c on c.id=h.checkpoint_id
   where h.user_id=v_binding.user_id and h.context_key=v_context_key;
  v_legacy_boundary:=coalesce(v_legacy_boundary,0);
  if exists(select 1 from unnest(v_event_ids) as covered(event_id) where not exists(
    select 1 from public.clued_context_events e where e.id=covered.event_id and e.user_id=v_binding.user_id
      and e.context_key=v_context_key and e.id>v_legacy_boundary)) then
    raise exception 'checkpoint_event_not_authorized' using errcode='42501';
  end if;
  if exists(select 1 from unnest(v_event_ids) as covered(event_id) join public.clued_checkpoint_event_absorptions a
    on a.user_id=v_binding.user_id and a.context_key=v_context_key and a.event_id=covered.event_id) then
    raise exception 'checkpoint_event_already_absorbed' using errcode='22023';
  end if;
  v_new_version:=v_current_version+1;
  select coalesce(max(e.id),v_legacy_boundary) into v_last_event_id from public.clued_context_events e
    where e.user_id=v_binding.user_id and e.context_key=v_context_key and e.id=any(v_event_ids);
  insert into public.clued_context_checkpoints(user_id,binding_id,context_key,version,snapshot,summary,next_action,last_event_id,
    previous_checkpoint_id,session_id,idempotency_key,checkpoint_coverage,legacy_absorbed_through_event_id)
  values(v_binding.user_id,v_binding.id,v_context_key,v_new_version,v_snapshot,v_summary,v_next_action,v_last_event_id,
    v_previous_id,v_session.id,v_idempotency_key,v_coverage,v_legacy_boundary) returning id into v_checkpoint_id;
  insert into public.clued_checkpoint_event_absorptions(user_id,context_key,checkpoint_id,event_id)
    select v_binding.user_id,v_context_key,v_checkpoint_id,covered.event_id from unnest(v_event_ids) as covered(event_id);
  insert into public.clued_context_heads(user_id,context_key,checkpoint_id,version,updated_at)
    values(v_binding.user_id,v_context_key,v_checkpoint_id,v_new_version,now())
    on conflict(user_id,context_key) do update set checkpoint_id=excluded.checkpoint_id,version=excluded.version,updated_at=excluded.updated_at;
  update public.clued_context_streams set version=v_new_version,updated_at=now()
    where user_id=v_binding.user_id and context_key=v_context_key;
  update public.clued_continuity_sessions set last_seen_at=now(),ended_at=now() where id=v_session.id;
  select count(*) into v_pending_after from public.clued_context_events e
    where e.user_id=v_binding.user_id and e.context_key=v_context_key and e.id>v_legacy_boundary
      and not exists(select 1 from public.clued_checkpoint_event_absorptions a
        where a.user_id=e.user_id and a.context_key=e.context_key and a.event_id=e.id);
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(v_binding.user_id,v_binding.id,v_context_key,'checkpoint','checkpoint',v_checkpoint_id::text,v_new_version,
    jsonb_build_object('base_version',v_base_version,'last_event_id',v_last_event_id,'session_id',v_session.id,
      'checkpoint_coverage',v_coverage,'absorbed_event_count',cardinality(v_event_ids),'pending_event_count_after',v_pending_after))
  returning id into v_receipt_id;
  return jsonb_build_object('status','committed','context_key',v_context_key,'version',v_new_version,
    'checkpoint_id',v_checkpoint_id,'receipt_id',v_receipt_id,'last_event_id',v_last_event_id,
    'checkpoint_coverage',v_coverage,'absorbed_event_count',cardinality(v_event_ids),
    'pending_event_count_after',v_pending_after);
end $$;

revoke all on function clued_private.render_resume_log(uuid,text,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;

notify pgrst,'reload schema';
