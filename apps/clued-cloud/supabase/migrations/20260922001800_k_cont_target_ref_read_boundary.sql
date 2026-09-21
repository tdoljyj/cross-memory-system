-- Only publish typed, currently readable canonical references. For evidence,
-- require an owner-held Evidence object and a record target in this context.
-- System and unknown targets lack a verifiable context scope and stay redacted.
create or replace function clued_private.k_cont_visible_target_refs_v1(
  p_user_id uuid,p_binding_id uuid,p_context_key text,p_refs jsonb
) returns jsonb language sql security definer set search_path='' as $$
  select coalesce(jsonb_agg(
    jsonb_build_object('kind',ref->>'kind','id',ref->>'id') ||
      case when ref ? 'role' then jsonb_build_object('role',ref->>'role') else '{}'::jsonb end
    order by ord),'[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(p_refs)='array'
    then p_refs else '[]'::jsonb end) with ordinality as refs(ref,ord)
  where jsonb_typeof(ref)='object'
    and jsonb_typeof(ref->'kind')='string'
    and jsonb_typeof(ref->'id')='string'
    and char_length(btrim(ref->>'id')) between 1 and 160
    and (not (ref ? 'role') or
      (jsonb_typeof(ref->'role')='string' and ref->>'role' in ('primary','source','target','evidence')))
    and case ref->>'kind'
      when 'record' then exists(
        select 1 from public.clued_memories m
        where m.user_id=p_user_id and m.id::text=lower(ref->>'id')
          and m.canonical_scope is not null
          and (m.canonical_scope=p_context_key or
            (p_binding_id is not null and exists(
              select 1 from public.clued_agent_bindings b
              where b.id=p_binding_id and b.user_id=p_user_id
                and ('*'=any(b.context_keys) or m.canonical_scope=any(b.context_keys))
                and (not exists(select 1 from clued_private.authorizations_v12 a
                     where a.binding_id=b.id)
                  or 'read'=any(clued_private.authorization_effective_actions_v13(
                    b.id,'scope',m.canonical_scope,'canonical'))))))
      )
      when 'project' then exists(
        select 1 from public.clued_projects p
        where p.user_id=p_user_id
          and (p.id::text=lower(ref->>'id') or p.context_key=lower(ref->>'id'))
          and (p.context_key=p_context_key or
            (p_binding_id is not null and exists(
              select 1 from public.clued_agent_bindings b
              where b.id=p_binding_id and b.user_id=p_user_id
                and ('*'=any(b.context_keys) or p.context_key=any(b.context_keys))
                and (not exists(select 1 from clued_private.authorizations_v12 a
                     where a.binding_id=b.id)
                  or 'read'=any(clued_private.authorization_effective_actions_v13(
                    b.id,'scope',p.context_key,'canonical'))))))
      )
      when 'evidence' then exists(
        select 1 from public.clued_evidence e
        where e.user_id=p_user_id and e.id::text=lower(ref->>'id')
      ) and exists(
        select 1 from jsonb_array_elements(p_refs) r
        join public.clued_memories m on jsonb_typeof(r)='object'
          and r->>'kind'='record' and m.id::text=lower(r->>'id')
          and m.user_id=p_user_id and m.canonical_scope=p_context_key
      )
      else false
    end;
$$;
revoke all on function clued_private.k_cont_visible_target_refs_v1(uuid,uuid,text,jsonb)
  from public,anon,authenticated;

create or replace function public.clued_mcp_search_context(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_binding public.clued_agent_bindings%rowtype; v_session public.clued_continuity_sessions%rowtype;
  v_context_key text:=coalesce(nullif(btrim(p_input->>'context_key'),''),'global');
  v_query text:=btrim(coalesce(p_input->>'query',''));
  v_include_history boolean:=coalesce((p_input->>'include_history')::boolean,false);
  v_limit integer:=least(greatest(coalesce((p_input->>'limit')::integer,10),1),50);
  v_cursor integer:=greatest(coalesce((p_input->>'cursor')::integer,0),0);
  v_budget integer:=least(greatest(coalesce((p_input->>'max_bytes')::integer,65536),4096),262144);
  v_results jsonb:='[]'::jsonb; v_count integer:=0; v_candidate_count integer:=0;
  v_next_cursor integer; v_truncated boolean:=false; v_oversize boolean:=false;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_context_key);
  v_session:=clued_private.resolve_session(v_binding.user_id,v_binding.id,v_context_key,p_input->>'session_token');
  if char_length(v_query) not between 1 and 500 then raise exception 'invalid_query_length' using errcode='22023'; end if;
  with matches as (
    select jsonb_build_object('kind','record','id',m.id,'version',m.version,'record_type',m.record_type,
      'scope',coalesce(m.canonical_scope,case when m.project_id is not null then 'project:'||m.project_id::text else m.scope end),
      'title',m.title,'content',m.content,'status',m.status,'lifecycle_status',m.lifecycle_status,
      'type_fields',m.type_fields,'updated_at',m.updated_at) row_data,0 source_order,m.updated_at sort_time,m.id::text sort_id
    from public.clued_memories m where m.user_id=v_binding.user_id
      and coalesce(m.canonical_scope,case when m.project_id is not null then 'project:'||m.project_id::text else m.scope end)=v_context_key
      and (v_include_history or (m.archived_at is null and m.merged_into_record_id is null
        and m.status not in ('archived','superseded','revoked','cancelled')
        and coalesce(m.lifecycle_status,'active') not in ('archived','revoked','cancelled')
        and not exists(select 1 from public.clued_memories successor where successor.user_id=m.user_id and successor.supersedes_id=m.id)))
      and (strpos(lower(coalesce(m.title,'')),lower(v_query))>0 or strpos(lower(coalesce(m.content,'')),lower(v_query))>0
        or strpos(lower(coalesce(m.type_fields::text,'')),lower(v_query))>0)
    union all
    select jsonb_build_object('kind','checkpoint','id',c.id,'version',c.version,'summary',c.summary,
      'next_action',c.next_action,'snapshot',c.snapshot,'coverage',c.checkpoint_coverage,'created_at',c.created_at),
      1,c.created_at,c.id::text from public.clued_context_checkpoints c
    where c.user_id=v_binding.user_id and c.context_key=v_context_key
      and (c.summary ilike '%'||v_query||'%' or c.next_action ilike '%'||v_query||'%' or c.snapshot::text ilike '%'||v_query||'%')
      and (v_include_history or c.id=(select h.checkpoint_id from public.clued_context_heads h
        where h.user_id=v_binding.user_id and h.context_key=v_context_key))
    union all
    select jsonb_build_object('kind','event','id',e.id,'version',e.version,'type',e.event_type,
      'payload',e.payload,'target_refs',clued_private.k_cont_visible_target_refs_v1(v_binding.user_id,v_binding.id,v_context_key,e.target_refs),'occurred_at',e.occurred_at),
      2,e.occurred_at,e.id::text from public.clued_context_events e
    where e.user_id=v_binding.user_id and e.context_key=v_context_key and e.payload::text ilike '%'||v_query||'%'
  ), ordered as (
    select row_data,source_order,sort_time,sort_id from matches order by source_order,sort_time desc,sort_id
    offset v_cursor limit v_limit+1
  ), sized as (
    select *,row_number() over(order by source_order,sort_time desc,sort_id) page_pos,
      sum(octet_length(row_data::text)) over(order by source_order,sort_time desc,sort_id rows unbounded preceding) running_bytes
    from ordered
  ), selected as (
    select * from sized where page_pos<=v_limit and (page_pos=1 or running_bytes<=v_budget)
  )
  select coalesce(jsonb_agg(row_data order by source_order,sort_time desc,sort_id),'[]'::jsonb),count(*)::integer,
    (select count(*)::integer from ordered),coalesce(bool_or(page_pos=1 and running_bytes>v_budget),false)
    into v_results,v_count,v_candidate_count,v_oversize from selected;
  v_truncated:=v_candidate_count>v_count;
  v_next_cursor:=case when v_truncated then v_cursor+v_count else null end;
  update public.clued_continuity_sessions set last_seen_at=now() where id=v_session.id;
  return jsonb_build_object('status','ok','mode','lexical','context_key',v_context_key,'query',v_query,
    'results',v_results,'page',jsonb_build_object('cursor',v_cursor,'next_cursor',v_next_cursor,
      'limit',v_limit,'max_bytes',v_budget,'returned',v_count,'truncated',v_truncated,'oversize_first_item',v_oversize));
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
  if jsonb_typeof(coalesce(p_target_refs,'[]'::jsonb))<>'array' then
    raise exception 'invalid_target_refs' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(coalesce(p_target_refs,'[]'::jsonb)) ref(value)
    where case when jsonb_typeof(value)<>'object' then true else
      coalesce(jsonb_typeof(value->'kind'),'')<>'string'
      or coalesce(value->>'kind','') not in ('record','project','evidence','system')
      or coalesce(jsonb_typeof(value->'id'),'')<>'string'
      or char_length(btrim(coalesce(value->>'id',''))) not between 1 and 160
      or ((value ? 'role') and (coalesce(jsonb_typeof(value->'role'),'')<>'string'
        or coalesce(value->>'role','') not in ('primary','source','target','evidence')))
      or exists(select 1 from jsonb_object_keys(value) key where key not in ('kind','id','role'))
    end) then
    raise exception 'invalid_target_ref_item' using errcode='22023';
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

notify pgrst,'reload schema';
