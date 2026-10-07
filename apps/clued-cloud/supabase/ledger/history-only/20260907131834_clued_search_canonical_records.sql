-- Canonical records must be searchable independently of checkpoints.
create or replace function public.clued_mcp_search_context(p_token_hash text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_binding public.clued_agent_bindings%rowtype;
  v_session public.clued_continuity_sessions%rowtype;
  v_context_key text := coalesce(nullif(pg_catalog.btrim(p_input->>'context_key'), ''), 'global');
  v_query text := pg_catalog.btrim(coalesce(p_input->>'query',''));
  v_include_history boolean := coalesce((p_input->>'include_history')::boolean,false);
  v_limit integer := least(greatest(coalesce((p_input->>'limit')::integer,10),1),50);
  v_results jsonb;
begin
  v_binding := clued_private.resolve_binding(p_token_hash,'context:read',v_context_key);
  v_session := clued_private.resolve_session(v_binding.user_id,v_binding.id,v_context_key,p_input->>'session_token');
  if char_length(v_query) not between 1 and 500 then raise exception 'invalid_query_length'; end if;
  select coalesce(jsonb_agg(row_data order by source_order, sort_time desc, sort_id),'[]'::jsonb)
    into v_results from (
    select jsonb_build_object('kind','record','id',m.id,'version',m.version,
      'record_type',m.record_type,'record_schema_version',m.record_schema_version,
      'scope',coalesce(m.canonical_scope,case when m.project_id is not null then 'project:'||m.project_id::text else m.scope end),
      'title',m.title,'content',m.content,'status',m.status,'lifecycle_status',m.lifecycle_status,
      'type_fields',m.type_fields,'updated_at',m.updated_at) row_data,
      0 source_order,m.updated_at sort_time,m.id::text sort_id
    from public.clued_memories m
    where m.user_id=v_binding.user_id
      and coalesce(m.canonical_scope,case when m.project_id is not null then 'project:'||m.project_id::text else m.scope end)=v_context_key
      and (v_include_history or (
        m.archived_at is null and m.merged_into_record_id is null
        and m.status not in ('archived','superseded','revoked','cancelled')
        and coalesce(m.lifecycle_status,'active') not in ('archived','revoked','cancelled')
        and not exists(select 1 from public.clued_memories successor
          where successor.user_id=m.user_id and successor.supersedes_id=m.id)
      ))
      and (strpos(lower(coalesce(m.title,'')),lower(v_query))>0
        or strpos(lower(coalesce(m.content,'')),lower(v_query))>0
        or strpos(lower(coalesce(m.type_fields::text,'')),lower(v_query))>0)
    union all
    select jsonb_build_object('kind','checkpoint','id',c.id,'version',c.version,'summary',c.summary,
      'next_action',c.next_action,'snapshot',c.snapshot,'created_at',c.created_at),
      1,c.created_at,c.id::text
    from public.clued_context_checkpoints c
    where c.user_id=v_binding.user_id and c.context_key=v_context_key
      and (c.summary ilike '%'||v_query||'%' or c.next_action ilike '%'||v_query||'%'
        or c.snapshot::text ilike '%'||v_query||'%')
      and (v_include_history or c.id=(select h.checkpoint_id from public.clued_context_heads h
        where h.user_id=v_binding.user_id and h.context_key=v_context_key))
    union all
    select jsonb_build_object('kind','event','id',e.id,'version',e.version,'type',e.event_type,
      'payload',e.payload,'occurred_at',e.occurred_at),2,e.occurred_at,e.id::text
    from public.clued_context_events e
    where e.user_id=v_binding.user_id and e.context_key=v_context_key
      and e.payload::text ilike '%'||v_query||'%'
    order by source_order,sort_time desc,sort_id limit v_limit
  ) matches;
  update public.clued_continuity_sessions set last_seen_at=now() where id=v_session.id;
  return jsonb_build_object('status','ok','mode','lexical','context_key',v_context_key,'query',v_query,'results',v_results);
end $$;
-- CREATE OR REPLACE preserves existing grants; no caller privileges are added.

-- All fixtures and service side effects roll back inside the test subtransaction.
do $test$
declare
  owner_id uuid:=gen_random_uuid();
  other_id uuid:=gen_random_uuid();
  clued_binding_id uuid:=gen_random_uuid();
  binding_hash text:=encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex');
  session_data jsonb; result jsonb; input jsonb; record_id uuid;
begin
  begin
    insert into auth.users(id) values(owner_id),(other_id);
    insert into public.clued_agent_bindings(id,user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values(clued_binding_id,owner_id,'test','canonical-search-regression',binding_hash,
        array['context:read','context:write'],array['global']);
    session_data:=public.clued_mcp_restore(binding_hash,'{"context_key":"global"}');
    result:=public.clued_record_mutate(binding_hash,jsonb_build_object(
      'operation','create','record_type','note','record_schema_version',1,'scope','global',
      'lifecycle_status','active','authority','user_explicit','user_confirmed',true,
      'confidence_reason','isolated regression fixture','idempotency_key',gen_random_uuid()::text,
      'source_refs','[]'::jsonb,'source_unavailable_reason',null,
      'mutation',jsonb_build_object('title','search fixture','content','竹-test-unique',
        'type_fields',jsonb_build_object('note_kind','test'),'relations','{}'::jsonb)));
    if result->>'status'<>'committed' then raise exception 'fixture_create_failed: %',result->>'error_code'; end if;
    record_id:=(result->'target_refs'->0->>'id')::uuid;
    input:=jsonb_build_object('context_key','global','session_token',session_data->>'session_token','query','竹-test-unique','limit',1);
    result:=public.clued_mcp_search_context(binding_hash,input);
    if result->'results'->0->>'id' is distinct from record_id::text
      or result->'results'->0->>'kind' is distinct from 'record' then
      raise exception 'canonical_record_missing_from_search';
    end if;
    -- Current ID/version is preserved; literal wildcard does not match all records.
    if result->'results'->0->>'version'<>'1' then raise exception 'version_lost'; end if;
    result:=public.clued_mcp_search_context(binding_hash,input||'{"query":"%"}');
    if exists(select 1 from jsonb_array_elements(result->'results') x where x->>'kind'='record') then
      raise exception 'wildcard_expansion_in_records';
    end if;
    update public.clued_memories set lifecycle_status='archived',status='archived',archived_at=now() where id=record_id;
    result:=public.clued_mcp_search_context(binding_hash,input);
    if exists(select 1 from jsonb_array_elements(result->'results') x where x->>'kind'='record') then raise exception 'archive_leaked'; end if;
    result:=public.clued_mcp_search_context(binding_hash,input||'{"include_history":true}');
    if result->'results'->0->>'id' is distinct from record_id::text then raise exception 'history_unavailable'; end if;
    update public.clued_memories set lifecycle_status='active',status='active',archived_at=null,user_id=other_id where id=record_id;
    result:=public.clued_mcp_search_context(binding_hash,input);
    if exists(select 1 from jsonb_array_elements(result->'results') x where x->>'kind'='record') then raise exception 'tenant_leaked'; end if;
    update public.clued_memories set user_id=owner_id,canonical_scope='profile' where id=record_id;
    result:=public.clued_mcp_search_context(binding_hash,input);
    if exists(select 1 from jsonb_array_elements(result->'results') x where x->>'kind'='record') then raise exception 'scope_leaked'; end if;
    begin
      perform public.clued_mcp_search_context(binding_hash,input||'{"context_key":"profile"}');
      raise exception 'unauthorized_context_accepted';
    exception when insufficient_privilege then null; end;
    update public.clued_continuity_sessions set expires_at=now()-interval '1 second' where clued_continuity_sessions.binding_id=clued_binding_id;
    begin
      perform public.clued_mcp_search_context(binding_hash,input);
      raise exception 'expired_session_accepted';
    exception when insufficient_privilege then null; end;
    raise exception using errcode='ZX001',message='fixtures_rollback';
  exception when sqlstate 'ZX001' then null;
  end;
  if exists(select 1 from auth.users where id in(owner_id,other_id)) then raise exception 'fixture_cleanup_failed'; end if;
end $test$;
