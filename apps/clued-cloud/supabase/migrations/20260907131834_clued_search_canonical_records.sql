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
