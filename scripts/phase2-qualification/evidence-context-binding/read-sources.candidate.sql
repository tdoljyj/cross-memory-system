-- LOCAL CANDIDATE: internal adapter, no public MCP wire or Canonical writes.
create schema if not exists clued_source_reader;
revoke all on schema clued_source_reader from public,anon,authenticated;
grant usage on schema clued_source_reader to service_role;
create or replace function clued_source_reader.read_compiler_sources(
  p_token_hash text, p_input jsonb, p_records jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings%rowtype; r public.clued_memories%rowtype;
  result jsonb; wanted jsonb; hit jsonb; evidence jsonb; bindings jsonb:='[]';
begin
  if jsonb_typeof(p_records) is distinct from 'array' or jsonb_array_length(p_records) not between 1 and 50
    or exists(select 1 from jsonb_array_elements(p_records) x where jsonb_typeof(x->'id') is distinct from 'string'
      or jsonb_typeof(x->'version') is distinct from 'number' or (x->>'version') !~ '^[1-9][0-9]*$')
    or (select count(distinct x->>'id') from jsonb_array_elements(p_records) x)<>jsonb_array_length(p_records)
    then raise exception 'invalid_source_selection' using errcode='22023'; end if;
  if coalesce((p_input->>'include_history')::boolean,false) then
    raise exception 'historical_sources_not_allowed' using errcode='22023'; end if;
  -- Reuse actual authorization and exact context/session retrieval, not a supplied user ID.
  result:=public.clued_mcp_search_context(p_token_hash,p_input);
  b:=clued_private.resolve_binding(p_token_hash,'context:read',result->>'context_key');
  for wanted in select value from jsonb_array_elements(p_records) loop
    select value into hit from jsonb_array_elements(result->'results')
      where value->>'kind'='record' and value->>'id'=wanted->>'id';
    if hit is null or hit->'version' is distinct from wanted->'version' then
      raise exception 'source_not_current_or_authorized' using errcode='42501'; end if;
    select * into r from public.clued_memories where id=(wanted->>'id')::uuid and user_id=b.user_id for share;
    if not found or r.version<>(wanted->>'version')::bigint or r.canonical_scope is distinct from result->>'context_key'
      or coalesce(to_jsonb(r.title),'null') is distinct from hit->'title' or coalesce(to_jsonb(r.content),'null') is distinct from hit->'content'
      or to_jsonb(r.lifecycle_status) is distinct from hit->'lifecycle_status' then
      raise exception 'source_changed' using errcode='40001'; end if;
    if coalesce(cardinality(r.source_refs),0)=0 then raise exception 'raw_source_reference_missing' using errcode='22023'; end if;
    if exists(select 1 from unnest(r.source_refs) x where not exists(
      select 1 from public.clued_evidence e where e.id=x and e.user_id=b.user_id)) then
      raise exception 'source_evidence_unavailable' using errcode='42501'; end if;
    select jsonb_agg(jsonb_build_object('evidence_id',e.id,'content_hash',e.content_hash,
      'size_bytes',e.size_bytes,'evidence_schema_version',e.evidence_schema_version) order by e.id)
      into evidence from public.clued_evidence e where e.user_id=b.user_id and e.id=any(r.source_refs);
    bindings:=bindings||jsonb_build_array(jsonb_build_object('record_id',r.id,'record_version',r.version,
      'scope',r.canonical_scope,'evidence',evidence));
  end loop;
  return jsonb_build_object('search_result',result,'source_bindings',bindings);
end $$;
revoke all on function clued_source_reader.read_compiler_sources(text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function clued_source_reader.read_compiler_sources(text,jsonb,jsonb) to service_role;
