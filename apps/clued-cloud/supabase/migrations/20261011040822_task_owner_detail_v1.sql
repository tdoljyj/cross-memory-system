-- Task 16e1539d: Native Owner read-only Task/Decision/Note drill-down.
-- This is not an Agent/MCP/Worker Gateway surface. Body references provide
-- navigation only; all target rows are independently fenced to the Owner.

create function clued_private.task_owner_reference_ids_v1(
  p_owner uuid,p_record public.clued_memories,p_types text[],p_scopes text[]
) returns uuid[] language plpgsql stable set search_path='' as $$
declare v_ids uuid[]:='{}'::uuid[]; v_value text; v_match text[]; v_id uuid;
  v_type text; v_count integer; v_document text;
begin
  -- Exact UUIDs in canonical relations/type_fields precede short, typed refs.
  for v_value in select value #>> '{}' from jsonb_path_query(
      jsonb_build_array(p_record.relations,p_record.type_fields),
      '$.** ? (@.type() == "string")') value loop
    if v_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select m.id into v_id from public.clued_memories m
        where m.id=v_value::uuid and m.user_id=p_owner and m.record_schema_version=1
          and m.record_type=any(p_types) and m.canonical_scope=any(p_scopes);
      if found and not v_id=any(v_ids) then v_ids:=array_append(v_ids,v_id); end if;
    end if;
  end loop;
  v_document:=p_record.title||E'\n'||p_record.content||E'\n'||
    coalesce(p_record.relations::text,'')||E'\n'||coalesce(p_record.type_fields::text,'');
  for v_match in select regexp_matches(v_document,
      '\m(Decision|Note|Task)[[:space:]:#：]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8})(?![0-9a-f-])',
      'gi') loop
    v_type:=lower(v_match[1]);
    if not v_type=any(p_types) then continue; end if;
    select count(*),min(m.id::text)::uuid into v_count,v_id from public.clued_memories m
      where m.user_id=p_owner and m.record_schema_version=1 and m.record_type=v_type
        and m.canonical_scope=any(p_scopes)
        and (case when char_length(v_match[2])=36 then m.id=lower(v_match[2])::uuid
          else left(m.id::text,8)=lower(v_match[2]) end);
    if v_count=1 and not v_id=any(v_ids) then v_ids:=array_append(v_ids,v_id); end if;
  end loop;
  return v_ids;
end $$;

create function clued_private.task_owner_currentness_v1(
  p_owner uuid,p_record public.clued_memories,p_scopes text[]
) returns text language plpgsql stable set search_path='' as $$
declare v_fence text;
begin
  v_fence:=clued_private.record_currentness_fence(p_owner,p_record.id,p_scopes);
  -- The core fence treats notes as CURRENT before checking their lifecycle.
  -- Keep terminal notes visibly historical on this read surface as well.
  if p_record.archived_at is not null or p_record.merged_into_record_id is not null
    or p_record.lifecycle_status<>'active'
    or p_record.status in ('archived','superseded','revoked','cancelled','done')
    or exists(select 1 from public.clued_memories m
      where m.user_id=p_owner and m.supersedes_id=p_record.id) then return 'HISTORY'; end if;
  return v_fence;
end $$;

create function public.clued_task_owner_detail_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12();
  v_now timestamptz:=pg_catalog.clock_timestamp(); v_record public.clued_memories%rowtype;
  v_scopes text[]; v_refs uuid[]; v_related jsonb; v_claims jsonb:='[]'::jsonb; v_ended jsonb:='[]'::jsonb;
begin
  if jsonb_typeof(p_input) is distinct from 'object' then
    return jsonb_build_object('status','rejected','error_code','record_detail_input_invalid'); end if;
  if exists(select 1 from jsonb_object_keys(p_input) k where k<>'id')
    or jsonb_typeof(p_input->'id') is distinct from 'string'
    or (p_input->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return jsonb_build_object('status','rejected','error_code','record_detail_input_invalid'); end if;
  select array['global']::text[]||coalesce(array_agg('project:'||p.id::text),'{}'::text[])
    into v_scopes from public.clued_projects p where p.user_id=v_owner;
  select * into v_record from public.clued_memories m
    where m.id=(p_input->>'id')::uuid and m.user_id=v_owner and m.record_schema_version=1
      and m.record_type in ('task','decision','note') and m.canonical_scope=any(v_scopes);
  if not found then
    return jsonb_build_object('status','rejected','error_code','record_not_found'); end if;

  v_refs:=clued_private.task_owner_reference_ids_v1(v_owner,v_record,array['decision','note'],v_scopes);
  select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'record_type',m.record_type,
      'title',m.title,'scope',m.canonical_scope,
      'currentness',clued_private.task_owner_currentness_v1(v_owner,m,v_scopes))
      order by m.record_type,m.updated_at desc,m.id),'[]'::jsonb) into v_related
    from public.clued_memories m
    where m.user_id=v_owner and m.record_schema_version=1 and m.record_type in ('decision','note')
      and m.id<>v_record.id and m.canonical_scope=any(v_scopes)
      and (m.id=any(v_refs) or (v_record.record_type='task' and v_record.id=any(
        clued_private.task_owner_reference_ids_v1(v_owner,m,array['task'],v_scopes))));

  if v_record.record_type='task' then
    select coalesce(jsonb_agg(clued_private.work_claim_owner_row_v1(c::clued_private.work_claims_v1) order by c.expires_at,c.claim_id),'[]'::jsonb)
      into v_claims from (select w.* from clued_private.work_claims_v1 w
        where w.user_id=v_owner and w.task_id=v_record.id
          and w.status in ('ACTIVE','DRAINING') and w.expires_at>v_now
        order by w.expires_at,w.claim_id limit 100) c;
    select coalesce(jsonb_agg(clued_private.work_claim_owner_row_v1(c::clued_private.work_claims_v1) order by
      case when c.status in ('ACTIVE','DRAINING','EXPIRED') then c.expires_at else c.updated_at end desc,c.claim_id),'[]'::jsonb)
      into v_ended from (select w.* from clued_private.work_claims_v1 w
        where w.user_id=v_owner and w.task_id=v_record.id
          and not (w.status in ('ACTIVE','DRAINING') and w.expires_at>v_now)
          and (case when w.status in ('ACTIVE','DRAINING','EXPIRED') then w.expires_at else w.updated_at end)
            >v_now-interval '24 hours'
        order by case when w.status in ('ACTIVE','DRAINING','EXPIRED') then w.expires_at else w.updated_at end desc,w.claim_id
        limit 100) c;
  end if;
  return jsonb_build_object('status','ok','observed_at',v_now,
    'record',jsonb_build_object('id',v_record.id,'record_type',v_record.record_type,
      'title',v_record.title,'content',v_record.content,'scope',v_record.canonical_scope,
      'lifecycle_status',v_record.lifecycle_status,'execution_bucket',
        case when v_record.record_type='task' then v_record.type_fields->>'execution_bucket' end,
      'version',v_record.version,'updated_at',v_record.updated_at,
      'currentness',clued_private.task_owner_currentness_v1(v_owner,v_record,v_scopes),
      'status',v_record.status,'closure_summary',v_record.closure_summary),
    'related',v_related,'claims',v_claims,'ended',v_ended);
end $$;

revoke all on function clued_private.task_owner_reference_ids_v1(uuid,public.clued_memories,text[],text[]),
  clued_private.task_owner_currentness_v1(uuid,public.clued_memories,text[]),
  public.clued_task_owner_detail_v1(jsonb) from public,anon,authenticated,service_role;
-- Historical cutover fixtures can defer the Gateway migration/role. PUBLIC
-- stays revoked in either order; revoke the Gateway explicitly when present.
do $gateway_acl$
begin
  if exists(select 1 from pg_catalog.pg_roles where rolname='clued_worker_gateway') then
    revoke all on function clued_private.task_owner_reference_ids_v1(uuid,public.clued_memories,text[],text[]),
      clued_private.task_owner_currentness_v1(uuid,public.clued_memories,text[]),
      public.clued_task_owner_detail_v1(jsonb) from clued_worker_gateway;
  end if;
end $gateway_acl$;
grant execute on function public.clued_task_owner_detail_v1(jsonb) to authenticated;
