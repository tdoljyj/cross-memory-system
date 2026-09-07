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
