-- Task d5dee826: Native Imprint organization over the same Canonical identity.
-- Labels are user organization metadata, never a business assertion or a Task
-- lifecycle operation. No source row, source version or Currentness head changes.
create table clued_private.imprint_organization_v1 (
  user_id uuid not null references auth.users(id) on delete cascade,
  record_id uuid not null references public.clued_memories(id) on delete cascade,
  domains text[] not null default '{}'::text[]
    check (domains <@ array['daily','work','learning','creation','interest']::text[]),
  version bigint not null check (version > 0),
  updated_at timestamptz not null default now(),
  receipt_id uuid not null references public.clued_audit_receipts(id),
  primary key (user_id,record_id), unique(record_id)
);
alter table clued_private.imprint_organization_v1 enable row level security;
create policy imprint_organization_owner_v1 on clued_private.imprint_organization_v1
  for select to authenticated using ((select auth.uid())=user_id);
revoke all on table clued_private.imprint_organization_v1 from public,anon,authenticated,service_role;
create index imprint_organization_domains_v1 on clued_private.imprint_organization_v1 using gin(domains);

create function clued_private.imprint_owner_scopes_v1(p_owner uuid)
returns text[] language sql stable security definer set search_path='' as $$
  select array['global','profile']::text[]||coalesce(array_agg('project:'||p.id::text),'{}'::text[])
    from public.clued_projects p where p.user_id=p_owner
$$;
create function clued_private.imprint_record_scope_v1(p_record public.clued_memories)
returns text language sql immutable set search_path='' as $$
  select coalesce(p_record.canonical_scope,case when p_record.project_id is null
    then 'global' else 'project:'||p_record.project_id::text end)
$$;
create function clued_private.imprint_record_currentness_v1(
  p_owner uuid,p_record public.clued_memories,p_scopes text[]
) returns text language plpgsql stable security definer set search_path='' as $$
declare v_fence text;
begin
  v_fence:=clued_private.record_currentness_fence(p_owner,p_record.id,p_scopes);
  -- A terminal lifecycle cannot override a denial or a new unknown fence code.
  if v_fence not in ('CURRENT','HISTORY','UNKNOWN','STALE','SHADOWED_BY_ACTIVE_EVENT')
    or v_fence is null then return v_fence; end if;
  -- The shared fence returns CURRENT for notes before its lifecycle check.
  -- Imprint must keep terminal notes and profile facts visibly historical too.
  if p_record.archived_at is not null or p_record.merged_into_record_id is not null
    or coalesce(p_record.lifecycle_status,'active')<>'active'
    or p_record.status in ('archived','superseded','revoked','cancelled','done') then
    return 'HISTORY';
  end if;
  return v_fence;
end $$;
create function clued_private.imprint_domains_v1(p_value jsonb)
returns text[] language plpgsql immutable set search_path='' as $$
declare v_domains text[];
begin
  if jsonb_typeof(p_value) is distinct from 'array' or jsonb_array_length(p_value)>5
    or exists(select 1 from jsonb_array_elements(p_value) d
      where jsonb_typeof(d) is distinct from 'string'
        or d#>>'{}' not in ('daily','work','learning','creation','interest')) then
    raise exception 'imprint_domains_invalid' using errcode='22023';
  end if;
  select coalesce(array_agg(distinct d order by d),'{}'::text[]) into v_domains
    from jsonb_array_elements_text(p_value) d;
  return v_domains;
end $$;

create function public.clued_imprint_read_v1(p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12();
  v_view text; v_scope text; v_query text; v_type text; v_history boolean;
  v_limit integer; v_cursor integer; v_id uuid; v_scopes text[]; v_domains text[]; v_browse boolean;
  v_records jsonb; v_total bigint; v_withheld bigint; v_projection jsonb; v_blockers jsonb;
begin
  if p_input is null or jsonb_typeof(p_input) is distinct from 'object'
    or exists(select 1 from jsonb_object_keys(p_input) k where k not in
      ('view','scope','query','include_history','record_type','limit','cursor','id','domains')) then
    raise exception 'imprint_read_input_invalid' using errcode='22023';
  end if;
  if (p_input ? 'view' and jsonb_typeof(p_input->'view') is distinct from 'string')
    or (p_input ? 'scope' and jsonb_typeof(p_input->'scope') is distinct from 'string')
    or (p_input ? 'query' and jsonb_typeof(p_input->'query') is distinct from 'string')
    or (p_input ? 'record_type' and jsonb_typeof(p_input->'record_type') is distinct from 'string')
    or (p_input ? 'include_history' and jsonb_typeof(p_input->'include_history') is distinct from 'boolean')
    or (p_input ? 'limit' and (jsonb_typeof(p_input->'limit') is distinct from 'number'
      or (p_input->>'limit') !~ '^[0-9]{1,3}$'))
    or (p_input ? 'cursor' and (jsonb_typeof(p_input->'cursor') is distinct from 'number'
      or (p_input->>'cursor') !~ '^[0-9]{1,5}$'))
    or (p_input ? 'id' and (jsonb_typeof(p_input->'id') is distinct from 'string'
      or (p_input->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) then
    raise exception 'imprint_read_input_invalid' using errcode='22023';
  end if;
  v_view:=coalesce(p_input->>'view','all'); v_scope:=coalesce(p_input->>'scope','all');
  v_browse:=v_view not in ('task','decision');
  v_query:=coalesce(p_input->>'query',''); v_type:=p_input->>'record_type';
  v_history:=coalesce((p_input->>'include_history')::boolean,false);
  v_limit:=coalesce((p_input->>'limit')::integer,50); v_cursor:=coalesce((p_input->>'cursor')::integer,0);
  v_id:=(p_input->>'id')::uuid;
  if v_view not in ('all','task','decision','daily','work','learning','creation','interest')
    or (v_scope not in ('all','global') and v_scope !~ '^project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    or (v_type is not null and v_type not in ('state','task','decision','note','profile_fact'))
    or char_length(v_query)>500 or v_limit not between 1 and 100 or v_cursor>10000 then
    raise exception 'imprint_read_input_invalid' using errcode='22023';
  end if;
  v_domains:=clued_private.imprint_domains_v1(coalesce(p_input->'domains','[]'::jsonb));
  v_scopes:=clued_private.imprint_owner_scopes_v1(v_owner);
  if v_scope<>'all' then
    if not v_scope=any(v_scopes) then raise exception 'imprint_scope_not_found' using errcode='42501'; end if;
    v_scopes:=array[v_scope]::text[];
  end if;
  with matches as materialized (
    select m,coalesce(o.domains,'{}'::text[]) domains,coalesce(o.version,0) organization_version,
      clued_private.imprint_record_currentness_v1(v_owner,m,v_scopes) fence
    from public.clued_memories m
    left join clued_private.imprint_organization_v1 o on o.record_id=m.id and o.user_id=m.user_id
    where m.user_id=v_owner and m.record_type in ('state','task','decision','note','profile_fact')
      and clued_private.imprint_record_scope_v1(m)=any(v_scopes)
      and (v_id is null or m.id=v_id)
      and (v_type is null or m.record_type=v_type)
      and (v_view not in ('task','decision') or m.record_type=v_view)
      and (v_view not in ('daily','work','learning','creation','interest') or v_view=any(o.domains))
      and v_domains<@coalesce(o.domains,'{}'::text[])
      -- This is literal search over saved titles and full Canonical content.
      and (v_query='' or strpos(lower(coalesce(m.title,'')||E'\n'||coalesce(m.content,'')),lower(v_query))>0)
  ), permitted as materialized (
    -- History admits diagnostic uncertainty; it never overrides isolation or
    -- an authorization denial, and those rows contribute no counts or cursors.
    select * from matches where fence in ('CURRENT','HISTORY','UNKNOWN','STALE','SHADOWED_BY_ACTIVE_EVENT')
  ), readable as materialized (
    select * from permitted where v_history or fence='CURRENT' or (v_browse and fence='HISTORY')
  ), page as (
    select * from readable order by (m).updated_at desc,(m).id offset v_cursor limit v_limit
  )
  select coalesce((select jsonb_agg((to_jsonb(p.m)-'user_id')||jsonb_build_object(
      'scope',clued_private.imprint_record_scope_v1(p.m),'domains',to_jsonb(p.domains),
      'organization_version',p.organization_version,'record_currentness',p.fence,
      'authoritative',not v_history and (p.m).record_schema_version=1 and p.fence='CURRENT',
      'source_semantics',case when (p.m).record_schema_version is null then 'legacy_compatibility' else 'canonical_record' end)
      order by (p.m).updated_at desc,(p.m).id) from page p),'[]'::jsonb),
    (select count(*) from readable),
    (select count(*) from permitted where fence not in ('CURRENT','HISTORY'))
    into v_records,v_total,v_withheld;
  -- Keep the shared unavailable/rebuild and active-carrier explanations.
  v_projection:='{}'::jsonb;
  if not v_browse and not v_history and 'global'=any(v_scopes) then
    v_projection:=clued_private.record_list_core(v_owner,
      jsonb_build_object('level','global','record_type','state','limit',1),v_scopes);
  end if;
  v_blockers:=case when v_history then null else clued_private.blocking_event_carriers_v1(
    v_owner,v_scopes,case when v_type in ('state','task','decision') then array[v_type]
      when v_view in ('task','decision') then array[v_view]
      when v_type in ('note','profile_fact') then '{}'::text[] else array['state','task','decision']::text[] end) end;
  return jsonb_build_object('status','ok','records',v_records,'search_mode','saved_title_content_literal',
    'read_semantics',case when v_browse then 'qualified_saved_latest' else 'strict_current' end,
    'selection_complete',v_history or (v_withheld=0 and
      (v_browse or not coalesce((v_projection->>'current_projection_unavailable')::boolean,false))),
    'coverage',jsonb_build_object('record_types',jsonb_build_array('note','profile_fact','state','task','decision'),
      'source_content','linked_evidence_on_demand','unlinked_intake_included',false,
      'prior_body_revisions_available',false,'latest_saved_objects',true,
      'diagnostic_history_requested',v_history,'current_action_authorization',false),
    'current_projection_unavailable',not v_browse and not v_history and (v_withheld>0 or coalesce((v_projection->>'current_projection_unavailable')::boolean,false)),
    'projection_rebuild_required',not v_browse and not v_history and coalesce((v_projection->>'projection_rebuild_required')::boolean,false),
    'withheld_record_count',case when v_history then 0 else v_withheld end,
    'withheld_by_active_events',v_blockers,
    'page',jsonb_build_object('cursor',v_cursor,'next_cursor',case when v_cursor+jsonb_array_length(v_records)<v_total
      then v_cursor+jsonb_array_length(v_records) end,'complete',v_cursor+jsonb_array_length(v_records)>=v_total));
end $$;

create function public.clued_imprint_organization_set_v1(p_input jsonb,p_received_payload_hash text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12();
  v_record public.clued_memories%rowtype; v_org clued_private.imprint_organization_v1%rowtype;
  v_receipt public.clued_audit_receipts%rowtype; v_id uuid; v_domains text[]; v_base bigint;
  v_ref text; v_refs jsonb; v_event text; v_result jsonb; v_snapshot jsonb; v_error text; v_state text;
begin
  if p_input is null or jsonb_typeof(p_input) is distinct from 'object'
    or exists(select 1 from jsonb_object_keys(p_input) k where k not in
      ('record_id','record_version','base_version','domains','idempotency_key'))
    or jsonb_typeof(p_input->'record_id') is distinct from 'string'
    or (p_input->>'record_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(p_input->'record_version') is distinct from 'number'
    or (p_input->>'record_version') !~ '^[1-9][0-9]{0,17}$'
    or (p_input ? 'base_version' and (jsonb_typeof(p_input->'base_version') is distinct from 'number'
      or (p_input->>'base_version') !~ '^[0-9]{1,18}$'))
    or jsonb_typeof(p_input->'idempotency_key') is distinct from 'string'
    or char_length(p_input->>'idempotency_key') not between 8 and 160
    or coalesce(p_received_payload_hash,'') !~ '^[0-9a-f]{64}$' then
    raise exception 'imprint_organization_input_invalid' using errcode='22023';
  end if;
  v_id:=(p_input->>'record_id')::uuid; v_base:=coalesce((p_input->>'base_version')::bigint,0);
  v_domains:=clued_private.imprint_domains_v1(p_input->'domains');
  -- Serialize the same user/operation/key before m1_begin_receipt; concurrent
  -- retries recover the same settled receipt instead of racing its unique key.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    v_owner::text||':imprint_organization:'||btrim(p_input->>'idempotency_key'),0));
  v_receipt:=clued_private.m1_begin_receipt(v_owner,null,'imprint_organization',p_input,p_received_payload_hash);
  if v_receipt.status<>'pending' then
    return coalesce(v_receipt.canonical_result,clued_private.m1_result_envelope(v_receipt))
      ||jsonb_build_object('replayed',v_receipt.related_receipt_id is null)
      ||case when v_receipt.metadata ? 'organization' then jsonb_build_object('supplemental',
        jsonb_build_object('organization',v_receipt.metadata->'organization')) else '{}'::jsonb end;
  end if;
  begin
    -- Lock the source identity solely to fence a concurrent source edit/delete;
    -- never UPDATE that row, including when it is a terminal Task/Decision.
    select * into v_record from public.clued_memories m
      where m.id=v_id and m.user_id=v_owner
        and clued_private.imprint_record_scope_v1(m)=any(clued_private.imprint_owner_scopes_v1(v_owner)) for update;
    if not found then raise exception 'record_not_found' using errcode='P0002'; end if;
    if coalesce(clued_private.imprint_record_currentness_v1(v_owner,v_record,
      clued_private.imprint_owner_scopes_v1(v_owner)),'UNKNOWN_FENCE_CODE') not in
      ('CURRENT','HISTORY','UNKNOWN','STALE','SHADOWED_BY_ACTIVE_EVENT') then
      raise exception 'record_not_found' using errcode='P0002'; end if;
    if v_record.version<>(p_input->>'record_version')::bigint then
      raise exception 'record_version_conflict' using errcode='40001'; end if;
    select * into v_org from clued_private.imprint_organization_v1
      where user_id=v_owner and record_id=v_id for update;
    if coalesce(v_org.version,0)<>v_base then
      raise exception 'organization_version_conflict' using errcode='40001'; end if;
    insert into clued_private.imprint_organization_v1(user_id,record_id,domains,version,receipt_id)
      values(v_owner,v_id,v_domains,v_base+1,v_receipt.id)
      on conflict(user_id,record_id) do update set domains=excluded.domains,
        version=excluded.version,updated_at=now(),receipt_id=excluded.receipt_id returning * into v_org;
    v_snapshot:=jsonb_build_object('record_id',v_id,'domains',to_jsonb(v_org.domains),'version',v_org.version);
    -- Persist replay data while pending, before finalizing this Receipt.
    update public.clued_audit_receipts set metadata=metadata||jsonb_build_object('organization',v_snapshot)
      where id=v_receipt.id and status='pending';
    v_ref:='imprint_organization:'||v_id::text;
    v_refs:=jsonb_build_array(jsonb_build_object('role','primary','kind','system','id',v_ref),
      jsonb_build_object('role','source','kind','record','id',v_id));
    v_event:=clued_private.m1_append_event_row(v_owner,null,v_receipt.id,v_receipt.canonical_version,
      'extension:imprint:organization_updated',v_refs,clued_private.imprint_record_scope_v1(v_record),null,
      jsonb_build_object('organization',v_snapshot),'imprint-organization:'||v_receipt.id::text,
      v_receipt.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,'committed',v_refs,
      jsonb_build_object(v_ref,v_base),jsonb_build_object(v_ref,v_org.version),array[v_event],'{}'::uuid[],null);
    return v_result||jsonb_build_object('replayed',false,'supplemental',jsonb_build_object('organization',v_snapshot));
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    return clued_private.m1_finish_receipt(v_receipt.id,case when v_state in ('22023','40001','42501','P0002')
      then 'rejected' else 'failed' end,'[]'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::text[],'{}'::uuid[],v_error)
      ||jsonb_build_object('replayed',false);
  end;
end $$;

create function public.clued_imprint_source_v1(p_input jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12();
  v_record public.clued_memories%rowtype; v_evidence public.clued_evidence%rowtype;
  v_submission clued_private.information_intake_submissions%rowtype; v_meta jsonb; v_content text; v_fence text;
  v_history boolean; v_withdrawn boolean; v_invalidated boolean; v_qualification jsonb;
begin
  if p_input is null or jsonb_typeof(p_input) is distinct from 'object'
    or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('record_id','evidence_id','include_history','record_version'))
    or (p_input ? 'include_history' and jsonb_typeof(p_input->'include_history') is distinct from 'boolean')
    or (p_input ? 'record_version' and (jsonb_typeof(p_input->'record_version') is distinct from 'number'
      or (p_input->>'record_version') !~ '^[1-9][0-9]{0,15}$'))
    or jsonb_typeof(p_input->'record_id') is distinct from 'string'
    or jsonb_typeof(p_input->'evidence_id') is distinct from 'string'
    or (p_input->>'record_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or (p_input->>'evidence_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'imprint_source_input_invalid' using errcode='22023';
  end if;
  if p_input ? 'record_version' and (p_input->>'record_version')::bigint>9007199254740991 then
    raise exception 'imprint_source_input_invalid' using errcode='22023'; end if;
  select * into v_record from public.clued_memories m where m.user_id=v_owner
    and m.id=(p_input->>'record_id')::uuid
    and clued_private.imprint_record_scope_v1(m)=any(clued_private.imprint_owner_scopes_v1(v_owner));
  if not found then
    return jsonb_build_object('status','rejected','error_code','source_not_found'); end if;
  v_fence:=clued_private.imprint_record_currentness_v1(v_owner,v_record,
    clued_private.imprint_owner_scopes_v1(v_owner));
  if v_fence not in ('CURRENT','HISTORY','UNKNOWN','STALE','SHADOWED_BY_ACTIVE_EVENT') or v_fence is null then
    return jsonb_build_object('status','rejected','error_code','source_not_found'); end if;
  -- Bind a displayed Record's source read to that exact version. A stale
  -- display must not silently acquire a newer source's access qualification.
  if p_input ? 'record_version' and (p_input->>'record_version')::bigint<>v_record.version then
    return jsonb_build_object('status','ok','available',false,'unavailable_reason','stale_record_version',
      'record_version',v_record.version,'authoritative',false,'current_input_eligible',false);
  end if;
  if not coalesce((p_input->>'evidence_id')::uuid=any(v_record.source_refs),false) then
    return jsonb_build_object('status','rejected','error_code','source_not_found'); end if;
  select * into v_evidence from public.clued_evidence e where e.user_id=v_owner and e.id=(p_input->>'evidence_id')::uuid;
  if not found then return jsonb_build_object('status','rejected','error_code','source_not_found'); end if;
  v_meta:=to_jsonb(v_evidence)-'user_id'-'binding_id';
  v_history:=coalesce((p_input->>'include_history')::boolean,false);
  select exists(select 1 from clued_private.evidence_withdrawals w
    where w.user_id=v_owner and w.evidence_id=v_evidence.id) into v_withdrawn;
  v_invalidated:=clued_private.record_evidence_unflagged_v1(v_owner,v_record.id,v_record.version) is not true
    or exists(select 1 from clued_private.knowledge_lineage l where l.user_id=v_owner
      and l.knowledge_record_id=v_record.id and l.knowledge_version=v_record.version and l.lineage_stale);
  v_qualification:=jsonb_build_object('record_version',v_record.version,'record_currentness',v_fence,'authoritative',false,
    'current_input_eligible',false,'evidence_status',case when v_withdrawn then 'withdrawn'
      when v_invalidated then 'invalidated' else 'retained' end,
    'source_semantics',case when v_history or v_withdrawn or v_invalidated then 'historical_evidence' else 'linked_evidence' end);
  if (v_withdrawn or v_invalidated) and not v_history then
    return jsonb_build_object('status','ok','available',false,'evidence',v_meta,
      'unavailable_reason',case when v_withdrawn then 'evidence_withdrawn' else 'evidence_invalidated' end)||v_qualification;
  end if;
  if v_evidence.storage_ref ~ '^intake:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select * into v_submission from clued_private.information_intake_submissions s
      where s.id=substring(v_evidence.storage_ref from 8)::uuid and s.user_id=v_owner
        and s.evidence_id=v_evidence.id and s.scope=any(clued_private.imprint_owner_scopes_v1(v_owner));
    if not found then return jsonb_build_object('status','ok','available',false,'evidence',v_meta,
      'unavailable_reason','captured_segment_unavailable')||v_qualification; end if;
    if v_submission.segment_sha256<>v_evidence.content_hash
      or clued_private.m1_sha256(v_submission.segment)<>v_evidence.content_hash then
      return jsonb_build_object('status','rejected','error_code','source_hash_mismatch'); end if;
    select string_agg(m->>'content',E'\n\n' order by n) into v_content
      from jsonb_array_elements(v_submission.segment->'messages') with ordinality x(m,n);
    return jsonb_build_object('status','ok','available',true,'evidence',v_meta,
      'segment',v_submission.segment,'content',v_content)||v_qualification;
  end if;
  return jsonb_build_object('status','ok','available',false,'evidence',v_meta,
    'unavailable_reason','external_source_content_not_stored')||v_qualification;
end $$;

revoke all on function clued_private.imprint_owner_scopes_v1(uuid),
  clued_private.imprint_record_scope_v1(public.clued_memories),
  clued_private.imprint_record_currentness_v1(uuid,public.clued_memories,text[]),
  clued_private.imprint_domains_v1(jsonb),public.clued_imprint_read_v1(jsonb),
  public.clued_imprint_organization_set_v1(jsonb,text),public.clued_imprint_source_v1(jsonb)
  from public,anon,authenticated,service_role;
do $gateway_acl$
begin
  if exists(select 1 from pg_catalog.pg_roles where rolname='clued_worker_gateway') then
    revoke all on table clued_private.imprint_organization_v1 from clued_worker_gateway;
    revoke all on function clued_private.imprint_owner_scopes_v1(uuid),
      clued_private.imprint_record_scope_v1(public.clued_memories),
      clued_private.imprint_record_currentness_v1(uuid,public.clued_memories,text[]),
      clued_private.imprint_domains_v1(jsonb),public.clued_imprint_read_v1(jsonb),
      public.clued_imprint_organization_set_v1(jsonb,text),public.clued_imprint_source_v1(jsonb)
      from clued_worker_gateway;
  end if;
end $gateway_acl$;
grant execute on function public.clued_imprint_read_v1(jsonb),
  public.clued_imprint_organization_set_v1(jsonb,text),public.clued_imprint_source_v1(jsonb) to authenticated;
notify pgrst,'reload schema';
