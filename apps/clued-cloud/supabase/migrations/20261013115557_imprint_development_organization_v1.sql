-- Task d5dee826: the eight reading projections in a real development space.
-- This table never bridges development Records into personal Canonical Records.
create table clued_private.imprint_development_organization_v1 (
  user_id uuid not null references auth.users(id) on delete cascade,
  context_id uuid not null references clued_private.development_spaces_v14(id) on delete cascade,
  record_id uuid not null references clued_private.development_records_v14(id) on delete cascade,
  domains text[] not null default '{}'::text[]
    check (domains <@ array['daily','work','learning','creation','interest']::text[]),
  version bigint not null check (version>0), updated_at timestamptz not null default now(),
  receipt_id uuid not null references public.clued_audit_receipts(id),
  primary key(user_id,record_id), unique(record_id)
);
alter table clued_private.imprint_development_organization_v1 enable row level security;
create policy imprint_development_organization_owner_v1 on clued_private.imprint_development_organization_v1
  for select to authenticated using ((select auth.uid())=user_id);
revoke all on table clued_private.imprint_development_organization_v1 from public,anon,authenticated,service_role;
create index imprint_development_organization_domains_v1
  on clued_private.imprint_development_organization_v1 using gin(domains);

create function clued_private.imprint_development_space_v1(p_owner uuid,p_context uuid,p_environment text default null)
returns clued_private.development_spaces_v14 language plpgsql volatile security definer set search_path='' as $$
declare v_space clued_private.development_spaces_v14%rowtype;
begin
  -- Current ownership of both the exact space and its exact project is required.
  -- Invitations and a coarse login never supply this Owner-only read authority.
  select s.* into v_space from clued_private.development_spaces_v14 s
    join public.clued_projects p on p.id=s.project_id and p.user_id=p_owner
    where s.id=p_context and s.owner_id=p_owner for share of s,p;
  if not found then raise exception 'context_access_denied' using errcode='42501'; end if;
  if p_environment is not null and p_environment<>v_space.environment then
    raise exception 'context_environment_denied' using errcode='42501'; end if;
  return v_space;
end $$;

create function clued_private.imprint_development_envelope_v1(
  p_envelope jsonb,p_space clued_private.development_spaces_v14,p_domains text[],p_organization_version bigint,p_history boolean
) returns jsonb language sql stable set search_path='' as $$
  select (p_envelope-'actor_binding_id')||jsonb_build_object(
    'record_type',p_envelope->>'record_type',
    'title',case when jsonb_typeof(p_envelope->'body'->'title')='string' then p_envelope->'body'->>'title' else '' end,
    -- The original development body is JSON. Keep every field, rather than
    -- extracting a conclusion and dropping technical or source information.
    'content',(p_envelope->'body')::text,'body',p_envelope->'body',
    'updated_at',coalesce(p_envelope->'recorded_at',p_envelope->'observed_at'),
    'scope','project:'||p_space.project_id::text,'context_id',p_space.id,'environment',p_space.environment,
    'domains',to_jsonb(p_domains),'organization_version',p_organization_version,
    'source_semantics','development_context','authoritative',false,
    'qualification',case when p_envelope->>'authority'='candidate' then 'candidate' else 'qualification_unavailable' end,
    'record_currentness',case when p_history or p_envelope->>'lifecycle_status'<>'ACTIVE' then 'HISTORY'
      when nullif(p_envelope->>'valid_until','')::timestamptz<clock_timestamp() then 'STALE' else 'UNKNOWN' end,
    'type_fields',case when jsonb_typeof(p_envelope->'body'->'type_fields')='object' then p_envelope->'body'->'type_fields' else '{}'::jsonb end,
    'relations',case when jsonb_typeof(p_envelope->'body'->'relations')='object' then p_envelope->'body'->'relations' else '{}'::jsonb end,
    'source_refs',case when jsonb_typeof(p_envelope->'body'->'source_refs')='array' then p_envelope->'body'->'source_refs' else '[]'::jsonb end,
    'source_status',jsonb_build_object('available',false,'reason','development_source_resolver_unavailable','namespace','development_context'))
$$;

create function public.clued_development_imprint_read_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_space clued_private.development_spaces_v14%rowtype;
  v_view text; v_type text; v_query text; v_scope text; v_kind text; v_history boolean; v_browse boolean; v_limit integer; v_cursor integer;
  v_id uuid; v_domains text[]; v_records jsonb; v_total bigint; v_withheld bigint; v_blockers jsonb; v_scopes text[];
begin
  if p_input is null or jsonb_typeof(p_input) is distinct from 'object'
    or exists(select 1 from jsonb_object_keys(p_input) k where k not in
      ('context_id','environment','scope','source_kind','view','query','domains','record_type','limit','cursor','include_history','id'))
    or jsonb_typeof(p_input->'context_id') is distinct from 'string'
    or (p_input->>'context_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or (p_input ? 'environment' and jsonb_typeof(p_input->'environment') is distinct from 'string')
    or (p_input ? 'scope' and jsonb_typeof(p_input->'scope') is distinct from 'string')
    or (p_input ? 'source_kind' and (jsonb_typeof(p_input->'source_kind') is distinct from 'string'
      or p_input->>'source_kind' not in ('development','canonical')))
    or (p_input ? 'view' and jsonb_typeof(p_input->'view') is distinct from 'string')
    or (p_input ? 'query' and jsonb_typeof(p_input->'query') is distinct from 'string')
    or (p_input ? 'record_type' and jsonb_typeof(p_input->'record_type') is distinct from 'string')
    or (p_input ? 'include_history' and jsonb_typeof(p_input->'include_history') is distinct from 'boolean')
    or (p_input ? 'limit' and (jsonb_typeof(p_input->'limit') is distinct from 'number' or (p_input->>'limit') !~ '^[0-9]{1,3}$'))
    or (p_input ? 'cursor' and (jsonb_typeof(p_input->'cursor') is distinct from 'number' or (p_input->>'cursor') !~ '^[0-9]{1,5}$'))
    or (p_input ? 'id' and (jsonb_typeof(p_input->'id') is distinct from 'string'
      or (p_input->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) then
    raise exception 'development_imprint_read_input_invalid' using errcode='22023';
  end if;
  v_space:=clued_private.imprint_development_space_v1(v_owner,(p_input->>'context_id')::uuid,p_input->>'environment');
  v_scope:=coalesce(p_input->>'scope','all');
  if v_scope not in ('all','project:'||v_space.project_id::text) then
    raise exception 'context_access_denied' using errcode='42501'; end if;
  v_view:=coalesce(p_input->>'view','all'); v_type:=p_input->>'record_type'; v_query:=coalesce(p_input->>'query','');
  v_browse:=v_view not in ('task','decision');
  v_kind:=p_input->>'source_kind';
  v_history:=coalesce((p_input->>'include_history')::boolean,false);
  v_limit:=coalesce((p_input->>'limit')::integer,50); v_cursor:=coalesce((p_input->>'cursor')::integer,0); v_id:=(p_input->>'id')::uuid;
  if v_view not in ('all','task','decision','daily','work','learning','creation','interest')
    or char_length(v_query)>500 or coalesce(char_length(v_type),1) not between 1 and 80
    or v_limit not between 1 and 100 or v_cursor>10000 then
    raise exception 'development_imprint_read_input_invalid' using errcode='22023'; end if;
  v_domains:=clued_private.imprint_domains_v1(coalesce(p_input->'domains','[]'::jsonb));
  v_scopes:=clued_private.imprint_owner_scopes_v1(v_owner);
  with development_candidates as materialized (
    select r,coalesce(o.domains,'{}'::text[]) domains,coalesce(o.version,0) organization_version
    from clued_private.development_records_v14 r
    left join clued_private.imprint_development_organization_v1 o on o.record_id=r.id
      and o.user_id=v_owner and o.context_id=r.context_id
    where r.context_id=v_space.id and (v_id is null or r.id=v_id)
      and (v_kind is null or v_kind='development')
      and (v_type is null or r.record_type=v_type)
      and (v_history or v_browse or r.lifecycle_status='ACTIVE')
      -- v14 only writes candidate Records; no formal acceptance marker exists.
      -- A body key or an arbitrary authority string cannot fabricate one.
      and v_view not in ('task','decision')
      and (v_view not in ('daily','work','learning','creation','interest') or v_view=any(o.domains))
      and v_domains<@coalesce(o.domains,'{}'::text[])
  ), retained_revision_matches as materialized (
    -- Search actual retained bodies only after the exact Owner, context,
    -- namespace, type and organization filters. Never widen a Binding grant.
    select v.record_id,jsonb_agg(clued_private.imprint_development_envelope_v1(
        v.envelope,v_space,d.domains,d.organization_version,true)||jsonb_build_object(
          'source_kind','development','match_source','retained_history','matched_record_version',v.version)
        order by v.version desc) matched_revisions
    from development_candidates d
    join clued_private.development_record_versions_v14 v on v.record_id=(d.r).id and v.context_id=v_space.id
    where v_history and v_query<>'' and v.version<>(d.r).version
      and v.envelope->>'id'=(d.r).id::text and v.envelope->>'context_id'=v_space.id::text
      and v.envelope->'version'=to_jsonb(v.version) and jsonb_typeof(v.envelope->'body')='object'
      and strpos(lower((v.envelope->'body')::text),lower(v_query))>0
    group by v.record_id
  ), development_matches as materialized (
    select d.*,strpos(lower((d.r).body::text),lower(v_query))>0 latest_body_match,
      coalesce(h.matched_revisions,'[]'::jsonb) matched_revisions
    from development_candidates d left join retained_revision_matches h on h.record_id=(d.r).id
    where v_query='' or strpos(lower((d.r).body::text),lower(v_query))>0 or h.record_id is not null
  ), development_rows as (
    select (d.r).id,'development'::text source_kind,(d.r).recorded_at sort_time,
      clued_private.imprint_development_envelope_v1(to_jsonb(d.r),v_space,d.domains,d.organization_version,false)
      ||jsonb_build_object('source_kind','development','matched_revisions',d.matched_revisions,
        'match_source',case when v_query='' then 'browse'
          when d.latest_body_match and jsonb_array_length(d.matched_revisions)>0 then 'latest_and_retained_history'
          when d.latest_body_match then 'latest_body' else 'retained_history' end,
        'history',case when v_history then coalesce((select jsonb_agg(
        clued_private.imprint_development_envelope_v1(v.envelope,v_space,d.domains,d.organization_version,true)
          ||jsonb_build_object('source_kind','development') order by v.version desc)
        from clued_private.development_record_versions_v14 v
        where v.context_id=v_space.id and v.record_id=(d.r).id and v.version<>(d.r).version
          and v.envelope->>'id'=(d.r).id::text and v.envelope->>'context_id'=v_space.id::text
          and v.envelope->'version'=to_jsonb(v.version)
          and jsonb_typeof(v.envelope->'body')='object'),'[]'::jsonb) else '[]'::jsonb end) envelope
      from development_matches d
  ), canonical_matches as materialized (
    select m,coalesce(o.domains,'{}'::text[]) domains,coalesce(o.version,0) organization_version,
      clued_private.imprint_record_currentness_v1(v_owner,m,v_scopes) fence
    from public.clued_memories m
    left join clued_private.imprint_organization_v1 o on o.record_id=m.id and o.user_id=m.user_id
    where m.user_id=v_owner and m.project_id=v_space.project_id
      and (v_kind is null or v_kind='canonical')
      and clued_private.imprint_record_scope_v1(m)='project:'||v_space.project_id::text
      and m.record_type in ('note','profile_fact','state','task','decision')
      and (v_id is null or m.id=v_id) and (v_type is null or m.record_type=v_type)
      and (v_view not in ('task','decision') or (m.record_type=v_view and m.record_schema_version=1))
      and (v_view not in ('daily','work','learning','creation','interest') or v_view=any(o.domains))
      and v_domains<@coalesce(o.domains,'{}'::text[])
      and (v_query='' or strpos(lower(coalesce(m.title,'')||E'\n'||coalesce(m.content,'')),lower(v_query))>0)
  ), canonical_permitted as materialized (
    select * from canonical_matches where fence in ('CURRENT','HISTORY','UNKNOWN','STALE','SHADOWED_BY_ACTIVE_EVENT')
  ), canonical_rows as (
    select (c.m).id,'canonical'::text source_kind,(c.m).updated_at sort_time,
      (to_jsonb(c.m)-'user_id')||jsonb_build_object('source_kind','canonical',
        'source_semantics',case when (c.m).record_schema_version=1 then 'canonical_record' else 'legacy_compatibility' end,
        'scope','project:'||v_space.project_id::text,'context_id',v_space.id,'environment',v_space.environment,
        'domains',to_jsonb(c.domains),'organization_version',c.organization_version,'record_currentness',c.fence,
        'authoritative',not v_history and (c.m).record_schema_version=1 and c.fence='CURRENT',
        'history','[]'::jsonb,'matched_revisions','[]'::jsonb,
        'match_source',case when v_query='' then 'browse' else 'latest_body' end) envelope
      from canonical_permitted c where v_history or c.fence='CURRENT' or (v_browse and c.fence='HISTORY')
  ), combined as materialized (
    select * from development_rows union all select * from canonical_rows
  ), page as (
    -- One shared sort and LIMIT after all namespace, type and label filters.
    select * from combined order by sort_time desc,source_kind,id offset v_cursor limit v_limit
  )
  select coalesce((select jsonb_agg(envelope order by sort_time desc,source_kind,id) from page),'[]'::jsonb),
    (select count(*) from combined),
    (select count(*) from canonical_permitted where fence not in ('CURRENT','HISTORY')) into v_records,v_total,v_withheld;
  v_blockers:=case when v_history then null else clued_private.blocking_event_carriers_v1(v_owner,
    array['project:'||v_space.project_id::text],case when v_view in ('task','decision') then array[v_view]
      when v_type in ('state','task','decision') then array[v_type]
      when v_type is not null then '{}'::text[] else array['state','task','decision']::text[] end) end;
  return jsonb_build_object('status','ok','records',v_records,'context_id',v_space.id,'environment',v_space.environment,
    'search_mode',case when v_history then 'saved_source_and_retained_development_body_literal' else 'saved_source_body_literal' end,
    'read_semantics',case when v_browse then 'qualified_saved_latest' else 'strict_current' end,
    'selection_complete',v_history or v_withheld=0,
    'current_projection_unavailable',not v_browse and not v_history and v_withheld>0,
    'projection_rebuild_required',false,'withheld_record_count',case when v_history then 0 else v_withheld end,
    'withheld_by_active_events',v_blockers,
    'coverage',jsonb_build_object('namespace','development_context_and_owned_project_canonical',
      'formal_task_decision_source','owned_project_canonical_records','development_candidate_promotion',false,
      'records','exact_owner_space_and_project','development_body_history','saved_version_envelopes_only',
      'development_history_search',v_history,'history_matches_authoritative',false,
      'canonical_prior_bodies_available',false,'unlinked_sources_included',false,
      'latest_saved_objects',true,'diagnostic_history_requested',v_history,'current_action_authorization',false,
      'member_access_included',false,'mcp_grants_changed',false),
    'page',jsonb_build_object('cursor',v_cursor,'next_cursor',case when v_cursor+jsonb_array_length(v_records)<v_total
      then v_cursor+jsonb_array_length(v_records) end,'complete',v_cursor+jsonb_array_length(v_records)>=v_total));
end $$;

/* The following write never turns a context candidate into Canonical memory. */
create function public.clued_development_imprint_organization_set_v1(p_input jsonb,p_received_payload_hash text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_space clued_private.development_spaces_v14%rowtype;
  v_record clued_private.development_records_v14%rowtype; v_org clued_private.imprint_development_organization_v1%rowtype;
  v_canonical public.clued_memories%rowtype;
  v_receipt public.clued_audit_receipts%rowtype; v_domains text[]; v_base bigint; v_ref text; v_refs jsonb;
  v_snapshot jsonb; v_event text; v_result jsonb; v_error text; v_state text; v_kind text;
begin
  if p_input is null or jsonb_typeof(p_input) is distinct from 'object'
    or exists(select 1 from jsonb_object_keys(p_input) k where k not in
      ('context_id','environment','source_kind','record_id','record_version','base_version','domains','idempotency_key'))
    or jsonb_typeof(p_input->'context_id') is distinct from 'string'
    or (p_input->>'context_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or (p_input ? 'environment' and jsonb_typeof(p_input->'environment') is distinct from 'string')
    or jsonb_typeof(p_input->'source_kind') is distinct from 'string'
    or p_input->>'source_kind' not in ('development','canonical')
    or jsonb_typeof(p_input->'record_id') is distinct from 'string'
    or (p_input->>'record_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(p_input->'record_version') is distinct from 'number' or (p_input->>'record_version') !~ '^[1-9][0-9]{0,17}$'
    or (p_input ? 'base_version' and (jsonb_typeof(p_input->'base_version') is distinct from 'number' or (p_input->>'base_version') !~ '^[0-9]{1,18}$'))
    or jsonb_typeof(p_input->'idempotency_key') is distinct from 'string' or char_length(p_input->>'idempotency_key') not between 8 and 160
    or coalesce(p_received_payload_hash,'') !~ '^[0-9a-f]{64}$' then
    raise exception 'development_imprint_organization_input_invalid' using errcode='22023'; end if;
  v_space:=clued_private.imprint_development_space_v1(v_owner,(p_input->>'context_id')::uuid,p_input->>'environment');
  v_kind:=p_input->>'source_kind';
  if v_kind='canonical' then
    -- Match the reused writer's lock order, including a cross-tab retry of the
    -- same key: idempotency lock first, then source identity, then metadata.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      v_owner::text||':imprint_organization:'||btrim(p_input->>'idempotency_key'),0));
    select * into v_canonical from public.clued_memories m where m.id=(p_input->>'record_id')::uuid
      and m.user_id=v_owner and m.project_id=v_space.project_id
      and clued_private.imprint_record_scope_v1(m)='project:'||v_space.project_id::text for update;
    if not found then return jsonb_build_object('status','rejected','error_code','record_not_found'); end if;
    -- Reuse the same Canonical organization row, CAS, Event and Receipt writer.
    return public.clued_imprint_organization_set_v1(p_input-'context_id'-'environment'-'source_kind',p_received_payload_hash);
  end if;
  v_domains:=clued_private.imprint_domains_v1(p_input->'domains'); v_base:=coalesce((p_input->>'base_version')::bigint,0);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_owner::text||':development_imprint_organization:'||btrim(p_input->>'idempotency_key'),0));
  v_receipt:=clued_private.m1_begin_receipt(v_owner,null,'development_imprint_organization',p_input,p_received_payload_hash);
  if v_receipt.status<>'pending' then
    return coalesce(v_receipt.canonical_result,clued_private.m1_result_envelope(v_receipt))
      ||jsonb_build_object('replayed',v_receipt.related_receipt_id is null)
      ||case when v_receipt.metadata ? 'organization' then jsonb_build_object('supplemental',jsonb_build_object('organization',v_receipt.metadata->'organization')) else '{}'::jsonb end;
  end if;
  begin
    select * into v_record from clued_private.development_records_v14 r
      where r.id=(p_input->>'record_id')::uuid and r.context_id=v_space.id for update;
    if not found then raise exception 'development_record_not_found' using errcode='P0002'; end if;
    if v_record.version<>(p_input->>'record_version')::bigint then raise exception 'record_version_conflict' using errcode='40001'; end if;
    select * into v_org from clued_private.imprint_development_organization_v1
      where user_id=v_owner and record_id=v_record.id and context_id=v_space.id for update;
    if coalesce(v_org.version,0)<>v_base then raise exception 'organization_version_conflict' using errcode='40001'; end if;
    insert into clued_private.imprint_development_organization_v1(user_id,context_id,record_id,domains,version,receipt_id)
      values(v_owner,v_space.id,v_record.id,v_domains,v_base+1,v_receipt.id)
      on conflict(user_id,record_id) do update set domains=excluded.domains,version=excluded.version,
        updated_at=now(),receipt_id=excluded.receipt_id returning * into v_org;
    v_snapshot:=jsonb_build_object('context_id',v_space.id,'record_id',v_record.id,'domains',to_jsonb(v_org.domains),'version',v_org.version);
    update public.clued_audit_receipts set metadata=metadata||jsonb_build_object('organization',v_snapshot)
      where id=v_receipt.id and status='pending';
    v_ref:='development_imprint_organization:'||v_space.id::text||':'||v_record.id::text;
    -- Development identity is a system namespace, never a personal Record ref.
    v_refs:=jsonb_build_array(jsonb_build_object('role','primary','kind','system','id',v_ref));
    v_event:=clued_private.m1_append_event_row(v_owner,null,v_receipt.id,v_receipt.canonical_version,
      'extension:imprint:development_organization_updated',v_refs,'project:'||v_space.project_id::text,null,
      jsonb_build_object('organization',v_snapshot),'development-imprint:'||v_receipt.id::text,v_receipt.request_sha256,
      'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,'committed',v_refs,jsonb_build_object(v_ref,v_base),
      jsonb_build_object(v_ref,v_org.version),array[v_event],'{}'::uuid[],null);
    return v_result||jsonb_build_object('replayed',false,'supplemental',jsonb_build_object('organization',v_snapshot));
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    return clued_private.m1_finish_receipt(v_receipt.id,case when v_state in ('22023','40001','42501','P0002') then 'rejected' else 'failed' end,
      '[]'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::text[],'{}'::uuid[],v_error)||jsonb_build_object('replayed',false);
  end;
end $$;

revoke all on function clued_private.imprint_development_space_v1(uuid,uuid,text),
  clued_private.imprint_development_envelope_v1(jsonb,clued_private.development_spaces_v14,text[],bigint,boolean),
  public.clued_development_imprint_read_v1(jsonb),public.clued_development_imprint_organization_set_v1(jsonb,text)
  from public,anon,authenticated,service_role;
do $gateway_acl$
begin
  if exists(select 1 from pg_catalog.pg_roles where rolname='clued_worker_gateway') then
    revoke all on table clued_private.imprint_development_organization_v1 from clued_worker_gateway;
    revoke all on function clued_private.imprint_development_space_v1(uuid,uuid,text),
      clued_private.imprint_development_envelope_v1(jsonb,clued_private.development_spaces_v14,text[],bigint,boolean),
      public.clued_development_imprint_read_v1(jsonb),public.clued_development_imprint_organization_set_v1(jsonb,text)
      from clued_worker_gateway;
  end if;
end $gateway_acl$;
grant execute on function public.clued_development_imprint_read_v1(jsonb),
  public.clued_development_imprint_organization_set_v1(jsonb,text) to authenticated;
notify pgrst,'reload schema';
