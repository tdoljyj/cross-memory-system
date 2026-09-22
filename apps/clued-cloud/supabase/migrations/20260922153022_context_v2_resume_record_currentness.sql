-- M-LIVE-01: resident resume constraints share the live Record Currentness fence.
-- Existing applied migrations remain unchanged. Logs retain historical access, never execution authority.

create or replace function clued_private.render_resume_log(
  p_user_id uuid,
  p_context_key text,
  p_events jsonb,
  p_constraints jsonb,
  p_conflicts jsonb,
  p_event_page jsonb,
  p_binding_id uuid
)
returns text language plpgsql security definer set search_path='' as $$
declare
  v_checkpoint public.clued_context_checkpoints%rowtype;
  v_version bigint:=0;
  v_action jsonb;
  v_events text:='';
  v_constraints text:='';
  v_conflicts text:='';
  v_imported_markdown text;
  v_imported_version bigint;
begin
  v_action:=case when p_binding_id is null then jsonb_build_object('status','ACTION_RESOLUTION_REQUIRED')
    else clued_private.authoritative_current_action_v1(p_user_id,p_context_key,p_binding_id) end;
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

  select coalesce(string_agg(format('- `%s` — %s [scope=%s]' || E'\n  %s',
    item->>'id',coalesce(item->>'title','Untitled constraint'),coalesce(item->>'scope',p_context_key),
    pg_catalog.replace(coalesce(item->>'content',''),E'\n',E'\n  ')),
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
    || case when v_action->>'status'='RESOLVED' then
      coalesce(v_action->'action'->>'title',v_action->'action'->>'text','ACTION_RESOLUTION_REQUIRED')
      else 'ACTION_RESOLUTION_REQUIRED' end || E'\n\n'
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
        || '> Historical evidence only. Current execution requires the fresh session Currentness result and action resolver.'
        || E'\n\n- Imported baseline version: `'||v_imported_version::text||'`'
        || E'\n- Content: available through the explicit `clued_read_log` history surface; omitted from resume to preserve the response budget.'
        || E'\n' end;
end $$;

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
  v_result jsonb; v_can_read_global boolean:=false;
begin
  if v_response_view not in ('structured','work_log') then raise exception 'invalid_response_view' using errcode='22023'; end if;
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_context_key);
  -- Fence the complete source read and session admission in the existing user
  -- transaction lock, before a concurrent Event can split their snapshots.
  perform clued_private.currentness_user_lock(v_binding.user_id);
  -- Legacy bindings use context_keys. Consent-backed bindings must also have
  -- a currently effective Global read entry; reduction leaves old keys intact.
  v_can_read_global:=('*'=any(v_binding.context_keys) or 'global'=any(v_binding.context_keys))
    and (not exists(select 1 from clued_private.authorizations_v12 a where a.binding_id=v_binding.id)
      or 'read'=any(clued_private.authorization_effective_actions_v13(
        v_binding.id,'scope','global','canonical')));
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
  where e.user_id=v_binding.user_id and e.context_key=v_context_key and (e.audit_visibility='work_log' or (e.event_schema_version is null and e.audit_visibility is null)) and e.id>v_legacy_boundary
    and not exists(select 1 from public.clued_checkpoint_event_absorptions a
      where a.user_id=e.user_id and a.context_key=e.context_key and a.event_id=e.id);

  with candidate as (
    select e.id,jsonb_build_object(
      'id',e.id,'version',e.version,'type',e.event_type,'payload',e.payload,
      'canonical_event_type',e.canonical_event_type,'target_refs',clued_private.k_cont_visible_target_refs_v1(v_binding.user_id,v_binding.id,v_context_key,e.target_refs),
      'record_targets',coalesce((select jsonb_agg(jsonb_build_object(
        'id',m.id,'title',m.title,'record_type',m.record_type,'lifecycle_status',m.lifecycle_status))
        from jsonb_array_elements(case when jsonb_typeof(e.target_refs)='array'
          then e.target_refs else '[]'::jsonb end) t
        join public.clued_memories m on (t->>'kind')='record'
          and m.id::text=lower(t->>'id') and m.user_id=e.user_id
          and m.canonical_scope is not null
          and ('*'=any(v_binding.context_keys) or m.canonical_scope=any(v_binding.context_keys))
          and (m.canonical_scope=v_context_key
            or not exists(select 1 from clued_private.authorizations_v12 a where a.binding_id=v_binding.id)
            or 'read'=any(clued_private.authorization_effective_actions_v13(
              v_binding.id,'scope',m.canonical_scope,'canonical')))),'[]'::jsonb),
      'occurred_at',e.occurred_at
    ) row_data
    from public.clued_context_events e
    where e.user_id=v_binding.user_id and e.context_key=v_context_key and (e.audit_visibility='work_log' or (e.event_schema_version is null and e.audit_visibility is null))
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
    where e.user_id=v_binding.user_id and e.context_key=v_context_key and (e.audit_visibility='work_log' or (e.event_schema_version is null and e.audit_visibility is null))
      and e.id>v_legacy_boundary and e.id>coalesce(v_next_cursor,v_event_cursor)
      and not exists(select 1 from public.clued_checkpoint_event_absorptions a
        where a.user_id=e.user_id and a.context_key=e.context_key and a.event_id=e.id));
  if not v_truncated then v_next_cursor:=null; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',m.id,'title',m.title,'scope',m.canonical_scope,'version',m.version,
    'constraint',m.type_fields->'constraint','rationale',m.type_fields->'rationale','content',m.content,'updated_at',m.updated_at)
    order by case when m.canonical_scope='global' then 0 else 1 end,m.updated_at desc,m.id),'[]'::jsonb)
    into v_constraints
  from public.clued_memories m
  where m.user_id=v_binding.user_id and m.record_schema_version is not null
    and m.record_type='decision' and m.lifecycle_status='active'
    and clued_private.record_currentness_fence(v_binding.user_id,m.id,
      clued_private.binding_read_scopes_v2(v_binding.user_id,v_binding.id))='CURRENT'
    and coalesce(m.type_fields->>'constraint','false')='true'
    and (m.canonical_scope=v_context_key or (m.canonical_scope='global' and v_can_read_global));

  select coalesce(jsonb_agg(jsonb_build_object(
    'status','review_required','reason','decision_newer_than_checkpoint','id',m.id,
    'title',m.title,'scope',m.canonical_scope,'version',m.version,'updated_at',m.updated_at)
    order by m.updated_at desc,m.id),'[]'::jsonb) into v_conflicts
  from public.clued_memories m
  where m.user_id=v_binding.user_id and m.record_schema_version is not null
    and m.record_type='decision' and m.lifecycle_status='active'
    and clued_private.record_currentness_fence(v_binding.user_id,m.id,
      clued_private.binding_read_scopes_v2(v_binding.user_id,v_binding.id))='CURRENT'
    and m.updated_at>coalesce(v_checkpoint.created_at,'epoch'::timestamptz)
    and (m.canonical_scope=v_context_key or (m.canonical_scope='global' and v_can_read_global));

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
        'limit',v_event_limit,'budget_bytes',v_event_budget,'returned',v_page_count,'truncated',v_truncated),v_binding.id));
  end if;
  return v_result||jsonb_build_object('events_after_checkpoint',v_events);
end $$;

create or replace function clued_private.render_log(p_user_id uuid,p_context_key text,p_binding_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare
  v_checkpoint public.clued_context_checkpoints%rowtype;
  v_version bigint:=0;
  v_events text:='';
  v_constraints text:='';
  v_authority_updates text:='';
  v_imported_markdown text;
  v_imported_version bigint;
  v_legacy_boundary bigint:=0;
begin
  select s.version into v_version from public.clued_context_streams s
   where s.user_id=p_user_id and s.context_key=p_context_key;
  select c.* into v_checkpoint from public.clued_context_heads h
    join public.clued_context_checkpoints c on c.id=h.checkpoint_id
   where h.user_id=p_user_id and h.context_key=p_context_key;
  v_legacy_boundary:=coalesce(v_checkpoint.legacy_absorbed_through_event_id,coalesce(v_checkpoint.last_event_id,0));

  select coalesce(string_agg(format('- %s · %s · %s',e.occurred_at,e.event_type,
    jsonb_build_object(
      'payload',e.payload,
      'target_refs',clued_private.k_cont_visible_target_refs_v1(p_user_id,p_binding_id,p_context_key,e.target_refs),
      'canonical_event_type',e.canonical_event_type
    )::text),E'\n' order by e.id),'') into v_events
  from public.clued_context_events e
  where e.user_id=p_user_id and e.context_key=p_context_key and (e.audit_visibility='work_log' or (e.event_schema_version is null and e.audit_visibility is null))
    and e.id>v_legacy_boundary
    and not exists(select 1 from public.clued_checkpoint_event_absorptions a
      where a.user_id=e.user_id and a.context_key=e.context_key and a.event_id=e.id);

  select coalesce(string_agg(format('- `%s` — %s',m.id,m.title),E'\n' order by m.updated_at desc,m.id),'')
    into v_constraints
  from public.clued_memories m
  where m.user_id=p_user_id and m.record_schema_version is not null
    and m.record_type='decision' and m.lifecycle_status='active'
    and clued_private.record_currentness_fence(p_user_id,m.id,
      case when p_binding_id is null then array[p_context_key]
        else clued_private.binding_read_scopes_v2(p_user_id,p_binding_id) end)='CURRENT'
    and coalesce(m.type_fields->>'constraint','false')='true'
    and m.canonical_scope=p_context_key;

  select coalesce(string_agg(format('- `%s` — %s [updated_at=%s]',m.id,m.title,m.updated_at),E'\n'
    order by m.updated_at desc,m.id),'') into v_authority_updates
  from public.clued_memories m
  where m.user_id=p_user_id and m.record_schema_version is not null
    and m.record_type='decision' and m.lifecycle_status='active'
    and clued_private.record_currentness_fence(p_user_id,m.id,
      case when p_binding_id is null then array[p_context_key]
        else clued_private.binding_read_scopes_v2(p_user_id,p_binding_id) end)='CURRENT'
    and m.canonical_scope=p_context_key
    and m.updated_at>coalesce(v_checkpoint.created_at,'epoch'::timestamptz);

  select l.markdown,l.version into v_imported_markdown,v_imported_version
  from public.clued_log_versions l
  where l.user_id=p_user_id and l.context_key=p_context_key
  order by l.version desc limit 1;

  return '# 日志' || E'\n\n'
    || '> Historical continuity log. Checkpoint text and Event history do not authorize current execution.' || E'\n\n'
    || '- Context: `'||p_context_key||'`' || E'\n'
    || '- Version: `'||coalesce(v_version,0)::text||'`' || E'\n'
    || '- Canonical store: `clued-cloud/supabase`' || E'\n\n'
    || '## Historical checkpoint' || E'\n\n'
    || coalesce(v_checkpoint.summary,'No checkpoint yet.') || E'\n\n'
    || '### Historical checkpoint action' || E'\n\n'
    || coalesce(v_checkpoint.next_action,'Create the first checkpoint.') || E'\n\n'
    || '### Checkpoint coverage' || E'\n\n'
    || coalesce(v_checkpoint.checkpoint_coverage,'{}'::jsonb)::text || E'\n\n'
    || '## Active constraints' || E'\n\n'
    || case when v_constraints='' then 'No active constraints in this context.' else v_constraints end || E'\n\n'
    || '## Authority updates after checkpoint' || E'\n\n'
    || case when v_authority_updates='' then 'No newer active Decisions.' else v_authority_updates end || E'\n\n'
    || '## Events not yet absorbed by a checkpoint' || E'\n\n'
    || case when v_events='' then 'No pending events.' else v_events end
    || case when v_imported_markdown is null then E'\n'
      else E'\n\n---\n\n## Imported historical baseline\n\n'
        || '> Historical evidence only. Use a fresh session resume and its action resolver for current execution.'
        || E'\n\n- Imported baseline version: `'||v_imported_version::text||'`' || E'\n\n'
        || pg_catalog.rtrim(regexp_replace(regexp_replace(
          v_imported_markdown,
          '(^|\\n)## Latest checkpoint',E'\\1## Imported checkpoint snapshot','g'),
          '(^|\\n)### Next action',E'\\1### Imported next-action snapshot','g')) || E'\n' end;
end $$;


-- Historical callers retain their signatures, with no unbound execution claim.
create or replace function clued_private.render_resume_log(p_user_id uuid,p_context_key text,
  p_events jsonb,p_constraints jsonb,p_conflicts jsonb,p_event_page jsonb)
returns text language sql security definer set search_path='' as $$
  select clued_private.render_resume_log(p_user_id,p_context_key,p_events,p_constraints,p_conflicts,p_event_page,null::uuid);
$$;
create or replace function clued_private.render_log(p_user_id uuid,p_context_key text)
returns text language sql security definer set search_path='' as $$
  select clued_private.render_log(p_user_id,p_context_key,null::uuid);
$$;
revoke all on function clued_private.render_resume_log(uuid,text,jsonb,jsonb,jsonb,jsonb,uuid),
  clued_private.render_resume_log(uuid,text,jsonb,jsonb,jsonb,jsonb),
  clued_private.render_log(uuid,text,uuid),clued_private.render_log(uuid,text)
  from public,anon,authenticated,service_role;

create or replace function public.clued_mcp_read_log(p_token_hash text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_binding public.clued_agent_bindings%rowtype;
  v_session public.clued_continuity_sessions%rowtype;
  v_scope text:=coalesce(nullif(btrim(p_input->>'context_key'),''),'global'); v_eval jsonb;
begin
  -- Retain the protected scope/project/session entry chain and its read receipt behavior.
  v_result:=public.clued_mcp_read_log_before_currentness(p_token_hash,p_input);
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_scope);
  v_session:=clued_private.resolve_session(v_binding.user_id,v_binding.id,v_scope,p_input->>'session_token');
  v_eval:=clued_private.checkpoint_currentness_for_session(v_session.id);
  return v_result||jsonb_build_object('markdown',clued_private.render_log(v_binding.user_id,v_scope,v_binding.id),
    'currentness_evaluation',v_eval,'source_semantics','historical_continuity_log',
    'authoritative_current',false,'next_action_authoritative',false);
end $$;
revoke all on function public.clued_mcp_read_log(text,jsonb) from public;
grant execute on function public.clued_mcp_read_log(text,jsonb) to anon;
