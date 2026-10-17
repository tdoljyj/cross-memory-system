-- Task d5dee826, Step 5. Native reading only; no MCP grant or canonical rewrite.
-- Store observed prior bodies; the current body always remains clued_memories.
create table clued_private.imprint_record_history_v1 (
  user_id uuid not null references auth.users(id) on delete cascade,
  record_id uuid not null references public.clued_memories(id) on delete cascade,
  version bigint not null check(version>0),
  scope text not null,
  envelope jsonb not null check(jsonb_typeof(envelope)='object'),
  envelope_sha256 text not null check(envelope_sha256 ~ '^[0-9a-f]{64}$'),
  retained_at timestamptz not null default clock_timestamp(),
  primary key(user_id,record_id,version),
  check(envelope->>'id'=record_id::text and envelope->'version'=to_jsonb(version))
);
alter table clued_private.imprint_record_history_v1 enable row level security;
revoke all on clued_private.imprint_record_history_v1 from public,anon,authenticated,service_role;

create function clued_private.imprint_history_immutable_v1() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'imprint_history_immutable' using errcode='55000'; end $$;
create trigger imprint_history_immutable_v1 before update on clued_private.imprint_record_history_v1
  for each row execute function clued_private.imprint_history_immutable_v1();

create function clued_private.imprint_history_capture_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare body jsonb; digest text; prior clued_private.imprint_record_history_v1%rowtype;
begin
  -- No insert/NEW snapshot: M1 refreshes content_hash in a second same-version
  -- UPDATE. OLD on the next version advance is the final prior row.
  if new.version<=old.version or old.record_schema_version is distinct from 1
    or old.record_type not in ('note','profile_fact','task','decision','state')
    or exists(select 1 from clued_private.projection_record_bindings b
      where b.user_id=old.user_id and b.record_id=old.id and b.target_scope='global'
        and b.projection_key in ('global.priority_frontier','global.__aggregate__')) then
    return new;
  end if;
  body:=to_jsonb(old)-'user_id';
  digest:=clued_private.m1_sha256(body);
  insert into clued_private.imprint_record_history_v1(user_id,record_id,version,scope,envelope,envelope_sha256)
    values(old.user_id,old.id,old.version,clued_private.imprint_record_scope_v1(old),body,digest)
    on conflict(user_id,record_id,version) do nothing;
  if not found then
    select * into prior from clued_private.imprint_record_history_v1
      where user_id=old.user_id and record_id=old.id and version=old.version;
    if prior.envelope is distinct from body or prior.envelope_sha256 is distinct from digest
      or prior.scope is distinct from clued_private.imprint_record_scope_v1(old) then
      raise exception 'imprint_history_identity_conflict' using errcode='55000';
    end if;
  end if;
  return new;
end $$;
-- A column-specific trigger would miss a version changed by a BEFORE trigger.
create trigger imprint_history_capture_v1 after update on public.clued_memories
  for each row when(new.version>old.version) execute function clued_private.imprint_history_capture_v1();

create function clued_private.imprint_history_record_v1(
  p_owner uuid,p_latest public.clued_memories,p_version bigint
) returns public.clued_memories language plpgsql stable security definer set search_path='' as $$
declare h clued_private.imprint_record_history_v1%rowtype; r public.clued_memories%rowtype;
begin
  if p_latest.user_id is distinct from p_owner or p_version is null or p_version>=p_latest.version
    or not clued_private.imprint_record_scope_v1(p_latest)=any(clued_private.imprint_owner_scopes_v1(p_owner)) then return null; end if;
  select * into h from clued_private.imprint_record_history_v1
    where user_id=p_owner and record_id=p_latest.id and version=p_version
      and scope=clued_private.imprint_record_scope_v1(p_latest);
  if not found then return null; end if;
  if h.envelope_sha256 is distinct from clued_private.m1_sha256(h.envelope) then
    raise exception 'imprint_history_integrity_unavailable' using errcode='55000'; end if;
  r:=jsonb_populate_record(null::public.clued_memories,h.envelope||jsonb_build_object('user_id',p_owner));
  if r.id is distinct from p_latest.id or r.version is distinct from p_version
    or r.record_type is distinct from p_latest.record_type
    or clued_private.imprint_record_scope_v1(r) is distinct from h.scope then
    raise exception 'imprint_history_integrity_unavailable' using errcode='55000'; end if;
  return r;
end $$;

-- Same intake resolver and qualification checks as the existing Native source
-- reader. Both search and clicks use it, with a freshly qualified current row.
create function clued_private.imprint_qualified_source_v1(
  p_owner uuid,p_latest public.clued_memories,p_record public.clued_memories,p_evidence uuid,p_history boolean
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare e public.clued_evidence%rowtype; s clued_private.information_intake_submissions%rowtype;
  meta jsonb; content text; fence text; withdrawn boolean; invalidated boolean; qualification jsonb;
begin
  if p_latest.user_id is distinct from p_owner or p_record.user_id is distinct from p_owner
    or p_record.id is distinct from p_latest.id
    or clued_private.imprint_record_scope_v1(p_record) is distinct from clued_private.imprint_record_scope_v1(p_latest)
    or not clued_private.imprint_record_scope_v1(p_latest)=any(clued_private.imprint_owner_scopes_v1(p_owner)) then
    return jsonb_build_object('status','rejected','error_code','source_not_found'); end if;
  fence:=clued_private.imprint_record_currentness_v1(p_owner,p_latest,clued_private.imprint_owner_scopes_v1(p_owner));
  if fence is null or fence not in ('CURRENT','HISTORY','UNKNOWN','STALE','SHADOWED_BY_ACTIVE_EVENT')
    or not coalesce(p_evidence=any(p_record.source_refs),false) then
    return jsonb_build_object('status','rejected','error_code','source_not_found'); end if;
  select * into e from public.clued_evidence where id=p_evidence and user_id=p_owner;
  if not found then return jsonb_build_object('status','rejected','error_code','source_not_found'); end if;
  meta:=to_jsonb(e)-'user_id'-'binding_id';
  select exists(select 1 from clued_private.evidence_withdrawals w
    where w.user_id=p_owner and w.evidence_id=e.id) into withdrawn;
  invalidated:=clued_private.record_evidence_unflagged_v1(p_owner,p_record.id,p_record.version) is not true
    or exists(select 1 from clued_private.knowledge_lineage l where l.user_id=p_owner
      and l.knowledge_record_id=p_record.id and l.knowledge_version=p_record.version and l.lineage_stale);
  qualification:=jsonb_build_object('record_id',p_latest.id,'record_version',p_latest.version,'source_record_version',p_record.version,
    'record_currentness',case when p_record.version<p_latest.version then 'HISTORY' else fence end,
    'authoritative',false,'current_input_eligible',false,
    'evidence_status',case when withdrawn then 'withdrawn' when invalidated then 'invalidated' else 'retained' end,
    'source_semantics',case when p_history or withdrawn or invalidated or p_record.version<p_latest.version
      then 'historical_evidence' else 'linked_evidence' end);
  if p_record.version<p_latest.version then
    qualification:=qualification||jsonb_build_object('historical_record_version',p_record.version);
  end if;
  if (withdrawn or invalidated) and not p_history then
    return jsonb_build_object('status','ok','available',false,'evidence',meta,
      'unavailable_reason',case when withdrawn then 'evidence_withdrawn' else 'evidence_invalidated' end)||qualification;
  end if;
  if e.storage_ref ~ '^intake:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select * into s from clued_private.information_intake_submissions i
      where i.id=substring(e.storage_ref from 8)::uuid and i.user_id=p_owner
        and i.evidence_id=e.id and i.scope=any(clued_private.imprint_owner_scopes_v1(p_owner));
    if not found then return jsonb_build_object('status','ok','available',false,'evidence',meta,
      'unavailable_reason','captured_segment_unavailable')||qualification; end if;
    if s.segment_sha256<>e.content_hash or clued_private.m1_sha256(s.segment)<>e.content_hash then
      return jsonb_build_object('status','rejected','error_code','source_hash_mismatch'); end if;
    select string_agg(m->>'content',E'\n\n' order by n) into content
      from jsonb_array_elements(s.segment->'messages') with ordinality x(m,n);
    return jsonb_build_object('status','ok','available',true,'complete',true,'evidence',meta,'segment',s.segment,'content',content)||qualification;
  end if;
  return jsonb_build_object('status','ok','available',false,'evidence',meta,
    'unavailable_reason','external_source_content_not_stored')||qualification;
end $$;

create or replace function public.clued_imprint_source_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare owner_id uuid:=clued_private.authorization_owner_v12(); latest public.clued_memories%rowtype;
  target public.clued_memories%rowtype; historical boolean; result jsonb; n text;
begin
  if p_input is null or jsonb_typeof(p_input) is distinct from 'object'
    or exists(select 1 from jsonb_object_keys(p_input) k where k not in
      ('record_id','evidence_id','include_history','record_version','historical_record_version'))
    or (p_input ? 'include_history' and jsonb_typeof(p_input->'include_history') is distinct from 'boolean')
    or jsonb_typeof(p_input->'record_id') is distinct from 'string'
    or jsonb_typeof(p_input->'evidence_id') is distinct from 'string'
    or (p_input->>'record_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or (p_input->>'evidence_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'imprint_source_input_invalid' using errcode='22023'; end if;
  foreach n in array array['record_version','historical_record_version'] loop
    if p_input ? n and (jsonb_typeof(p_input->n) is distinct from 'number'
      or (p_input->>n) !~ '^[1-9][0-9]{0,15}$' or (p_input->>n)::numeric>9007199254740991) then
      raise exception 'imprint_source_input_invalid' using errcode='22023'; end if;
  end loop;
  historical:=coalesce((p_input->>'include_history')::boolean,false);
  if p_input ? 'historical_record_version' and (not historical or not p_input ? 'record_version'
    or (p_input->>'historical_record_version')::bigint>=(p_input->>'record_version')::bigint) then
    raise exception 'imprint_source_input_invalid' using errcode='22023'; end if;
  select * into latest from public.clued_memories m where m.user_id=owner_id
    and m.id=(p_input->>'record_id')::uuid
    and clued_private.imprint_record_scope_v1(m)=any(clued_private.imprint_owner_scopes_v1(owner_id));
  if not found or coalesce(clued_private.imprint_record_currentness_v1(owner_id,latest,
    clued_private.imprint_owner_scopes_v1(owner_id)),'') not in ('CURRENT','HISTORY','UNKNOWN','STALE','SHADOWED_BY_ACTIVE_EVENT') then
    return jsonb_build_object('status','rejected','error_code','source_not_found'); end if;
  -- Existing record_version is ALWAYS the current-card fence, even in history.
  if p_input ? 'record_version' and latest.version<>(p_input->>'record_version')::bigint then
    return jsonb_build_object('status','ok','available',false,'unavailable_reason','stale_record_version',
      'record_version',latest.version,'authoritative',false,'current_input_eligible',false); end if;
  target:=latest;
  if p_input ? 'historical_record_version' then
    target:=clued_private.imprint_history_record_v1(owner_id,latest,(p_input->>'historical_record_version')::bigint);
    if target.id is null then return jsonb_build_object('status','ok','available',false,
      'unavailable_reason','retained_version_unavailable','authoritative',false,'current_input_eligible',false); end if;
  end if;
  result:=clued_private.imprint_qualified_source_v1(owner_id,latest,target,(p_input->>'evidence_id')::uuid,historical);
  if result->>'available'='true' and octet_length(result::text)>131072 then
    result:=(result-'content'-'segment')||jsonb_build_object('available',false,'complete',false,
      'unavailable_reason','source_content_exceeds_read_limit','read_limit_bytes',131072);
  end if;
  return result;
end $$;

create function public.clued_imprint_revision_read_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare owner_id uuid:=clued_private.authorization_owner_v12(); latest public.clued_memories%rowtype;
  target public.clued_memories%rowtype; space clued_private.development_spaces_v14%rowtype; n text; result jsonb;
begin
  if p_input is null or jsonb_typeof(p_input) is distinct from 'object'
    or exists(select 1 from jsonb_object_keys(p_input) k where k not in
      ('record_id','record_version','historical_record_version','scope','context_id'))
    or jsonb_typeof(p_input->'record_id') is distinct from 'string'
    or (p_input->>'record_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(p_input->'scope') is distinct from 'string' then
    raise exception 'imprint_revision_input_invalid' using errcode='22023'; end if;
  foreach n in array array['record_version','historical_record_version'] loop
    if jsonb_typeof(p_input->n) is distinct from 'number' or (p_input->>n) !~ '^[1-9][0-9]{0,15}$'
      or (p_input->>n)::numeric>9007199254740991 then
      raise exception 'imprint_revision_input_invalid' using errcode='22023'; end if;
  end loop;
  if (p_input->>'historical_record_version')::bigint>=(p_input->>'record_version')::bigint then
    raise exception 'imprint_revision_input_invalid' using errcode='22023'; end if;
  if p_input ? 'context_id' then
    if jsonb_typeof(p_input->'context_id') is distinct from 'string'
      or (p_input->>'context_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'imprint_revision_input_invalid' using errcode='22023'; end if;
    space:=clued_private.imprint_development_space_v1(owner_id,(p_input->>'context_id')::uuid);
  end if;
  select * into latest from public.clued_memories m where m.id=(p_input->>'record_id')::uuid and m.user_id=owner_id
    and clued_private.imprint_record_scope_v1(m)=p_input->>'scope'
    and clued_private.imprint_record_scope_v1(m)=any(clued_private.imprint_owner_scopes_v1(owner_id))
    and (not p_input ? 'context_id' or m.project_id=space.project_id);
  if not found or coalesce(clued_private.imprint_record_currentness_v1(owner_id,latest,
    clued_private.imprint_owner_scopes_v1(owner_id)),'') not in ('CURRENT','HISTORY','UNKNOWN','STALE','SHADOWED_BY_ACTIVE_EVENT') then
    return jsonb_build_object('status','ok','available',false,'unavailable_reason','retained_version_unavailable'); end if;
  if latest.version<>(p_input->>'record_version')::bigint then
    return jsonb_build_object('status','ok','available',false,'unavailable_reason','stale_record_version'); end if;
  target:=clued_private.imprint_history_record_v1(owner_id,latest,(p_input->>'historical_record_version')::bigint);
  if target.id is null then return jsonb_build_object('status','ok','available',false,
    'unavailable_reason','retained_version_unavailable'); end if;
  result:=jsonb_build_object('status','ok','available',true,'complete',true,'record_id',latest.id,
    'record_version',latest.version,'historical_record_version',target.version,'scope',p_input->>'scope',
    'authoritative',false,'current_input_eligible',false,'source_kind','canonical','context_id',p_input->>'context_id',
    'record',(to_jsonb(target)-'user_id')||jsonb_build_object('scope',p_input->>'scope',
      'record_currentness','HISTORY','authoritative',false,'current_input_eligible',false));
  if octet_length(result::text)>131072 then
    return jsonb_build_object('status','ok','available',false,'complete',false,
      'unavailable_reason','revision_content_exceeds_read_limit','read_limit_bytes',131072); end if;
  return result;
end $$;

create function clued_private.imprint_match_snippet_v1(p_content text,p_query text) returns text
language sql immutable set search_path='' as $$
  select substring(p_content from greatest(1,strpos(lower(p_content),lower(p_query))-80) for 240)
$$;

create function clued_private.imprint_search_details_v1(
  p_owner uuid,p_latest public.clued_memories,p_query text,p_history boolean,p_context uuid default null,p_environment text default null
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare revisions jsonb:='[]'; sources jsonb:='[]'; revision_count integer:=0; source_count integer:=0;
  latest_match boolean; prior public.clued_memories%rowtype; h record; e uuid; source jsonb;
  old_version boolean; flags integer; match_kind text;
begin
  latest_match:=p_query='' or strpos(lower(coalesce(p_latest.title,'')||E'\n'||coalesce(p_latest.content,'')),lower(p_query))>0;
  if p_latest.user_id is distinct from p_owner
    or not clued_private.imprint_record_scope_v1(p_latest)=any(clued_private.imprint_owner_scopes_v1(p_owner))
    or coalesce(clued_private.imprint_record_currentness_v1(p_owner,p_latest,clued_private.imprint_owner_scopes_v1(p_owner)),'')
      not in ('CURRENT','HISTORY','UNKNOWN','STALE','SHADOWED_BY_ACTIVE_EVENT') then
    return jsonb_build_object('matches',false); end if;
  if p_query<>'' then
    -- Stream each complete version once. Accumulating full envelopes with JSONB
    -- concatenation copies the growing history on every iteration.
    for h in select p_latest.version version union all
      select version from clued_private.imprint_record_history_v1
      where p_history and user_id=p_owner and record_id=p_latest.id and version<p_latest.version
        and scope=clued_private.imprint_record_scope_v1(p_latest) order by version desc loop
      old_version:=h.version<p_latest.version;
      if old_version then
        prior:=clued_private.imprint_history_record_v1(p_owner,p_latest,h.version);
        if prior.id is null then continue; end if;
      else prior:=p_latest;
      end if;
      if old_version and strpos(lower(coalesce(prior.title,'')||E'\n'||coalesce(prior.content,'')),lower(p_query))>0 then
        revision_count:=revision_count+1;
        if jsonb_array_length(revisions)<20 then
          revisions:=revisions||jsonb_build_array(jsonb_build_object('id',prior.id,'scope',clued_private.imprint_record_scope_v1(prior),
            'source_kind','canonical','context_id',p_context,'environment',p_environment,'version',prior.version,
            'matched_record_version',prior.version,'title',prior.title,'updated_at',prior.updated_at,
            'snippet',clued_private.imprint_match_snippet_v1(coalesce(prior.title,'')||E'\n'||coalesce(prior.content,''),p_query),
            'record_currentness','HISTORY','authoritative',false,'current_input_eligible',false,'full_body_included',false));
        end if;
      end if;
      foreach e in array coalesce(prior.source_refs,'{}'::uuid[]) loop
        source:=clued_private.imprint_qualified_source_v1(p_owner,p_latest,prior,e,p_history);
        if source->>'error_code'='source_hash_mismatch' then
          raise exception 'imprint_source_integrity_unavailable' using errcode='55000'; end if;
        if source->>'available'='true' and jsonb_typeof(source->'content')='string'
          and strpos(lower(source->>'content'),lower(p_query))>0 then
          source_count:=source_count+1;
          if jsonb_array_length(sources)<20 then
            sources:=sources||jsonb_build_array(jsonb_build_object('evidence_id',e,'record_id',p_latest.id,
              'record_version',p_latest.version,'source_record_version',prior.version,
              'historical_record_version',case when old_version then prior.version end,
              'scope',clued_private.imprint_record_scope_v1(p_latest),'context_id',p_context,
              'record_updated_at',prior.updated_at,'source_created_at',source->'evidence'->'created_at',
              'snippet',clued_private.imprint_match_snippet_v1(source->>'content',p_query),
              'source_semantics',source->>'source_semantics','evidence_status',source->>'evidence_status',
              'authoritative',false,'current_input_eligible',false,'full_body_included',false));
          end if;
        end if;
      end loop;
    end loop;
  end if;
  flags:=(case when latest_match then 1 else 0 end)+(case when revision_count>0 then 1 else 0 end)
    +(case when source_count>0 then 1 else 0 end);
  match_kind:=case when p_query='' then 'browse' when flags>1 then 'multiple'
    when latest_match then 'latest_body' when revision_count>0 then 'retained_history' else 'linked_source' end;
  return jsonb_build_object('matches',flags>0,'match_source',match_kind,'matched_revisions',revisions,'matched_sources',sources,
    'matched_revision_count',revision_count,'matched_source_count',source_count,
    'matched_revisions_truncated',revision_count>jsonb_array_length(revisions),
    'matched_sources_truncated',source_count>jsonb_array_length(sources),
    'canonical_history_retention','observed_prior_versions_after_feature_install');
end $$;

-- The two qualified core readers are patched below; their association wrappers,
-- filtering, Currentness, sorting, and pagination remain the existing path.

do $reader_patch$
declare target regprocedure:=to_regprocedure('public.clued_imprint_read_before_associations_v1(jsonb)');
  original text; successor text; definition text; expected text; before_metadata jsonb; after_metadata jsonb;
begin
  if target is null then raise exception 'imprint_search_reader_missing'; end if;
  select prosrc,pg_get_functiondef(oid),to_jsonb(p)-'prosrc' into original,definition,before_metadata from pg_proc p where oid=target;
  successor:=replace(original,E'\r\n',E'\n');
  if encode(sha256(convert_to(successor,'UTF8')),'hex')='51f738cbd506be32ec192fe6dba402d4c589d158729415149868f9539e5558a5' then return; end if;
  if encode(sha256(convert_to(successor,'UTF8')),'hex')<>'ad5f12483f8d0fba1dab6f28703526c99c6343bfa06d954d4b0824addb703ff7' then
    raise exception 'imprint_search_reader_source_changed'; end if;
  if (length(successor)-length(replace(successor,$old$clued_private.imprint_record_currentness_v1(v_owner,m,v_owner_scopes) fence
    from$old$,'')))/length($old$clued_private.imprint_record_currentness_v1(v_owner,m,v_owner_scopes) fence
    from$old$)<>1 then
    raise exception 'imprint_search_reader_anchor_changed'; end if;
  successor:=replace(successor,$old$clued_private.imprint_record_currentness_v1(v_owner,m,v_owner_scopes) fence
    from$old$,$new$clued_private.imprint_record_currentness_v1(v_owner,m,v_owner_scopes) fence,
      clued_private.imprint_search_details_v1(v_owner,m,v_query,v_history) search_details
    from$new$);
  if (length(successor)-length(replace(successor,$old$and (v_query='' or strpos(lower(coalesce(m.title,'')||E'\n'||coalesce(m.content,'')),lower(v_query))>0)$old$,'')))/length($old$and (v_query='' or strpos(lower(coalesce(m.title,'')||E'\n'||coalesce(m.content,'')),lower(v_query))>0)$old$)<>1 then
    raise exception 'imprint_search_reader_anchor_changed'; end if;
  successor:=replace(successor,$old$and (v_query='' or strpos(lower(coalesce(m.title,'')||E'\n'||coalesce(m.content,'')),lower(v_query))>0)$old$,$new$-- Full qualified body/source/history matching is applied below.$new$);
  if (length(successor)-length(replace(successor,$old$select * from matches where fence in ('CURRENT','HISTORY','UNKNOWN','STALE','SHADOWED_BY_ACTIVE_EVENT')$old$,'')))/length($old$select * from matches where fence in ('CURRENT','HISTORY','UNKNOWN','STALE','SHADOWED_BY_ACTIVE_EVENT')$old$)<>1 then
    raise exception 'imprint_search_reader_anchor_changed'; end if;
  successor:=replace(successor,$old$select * from matches where fence in ('CURRENT','HISTORY','UNKNOWN','STALE','SHADOWED_BY_ACTIVE_EVENT')$old$,$new$select * from matches where fence in ('CURRENT','HISTORY','UNKNOWN','STALE','SHADOWED_BY_ACTIVE_EVENT')
      and coalesce((search_details->>'matches')::boolean,false)$new$);
  if (length(successor)-length(replace(successor,$old$'source_semantics',case when (p.m).record_schema_version is null then 'legacy_compatibility' else 'canonical_record' end)$old$,'')))/length($old$'source_semantics',case when (p.m).record_schema_version is null then 'legacy_compatibility' else 'canonical_record' end)$old$)<>1 then
    raise exception 'imprint_search_reader_anchor_changed'; end if;
  successor:=replace(successor,$old$'source_semantics',case when (p.m).record_schema_version is null then 'legacy_compatibility' else 'canonical_record' end)$old$,$new$'source_semantics',case when (p.m).record_schema_version is null then 'legacy_compatibility' else 'canonical_record' end)||(p.search_details-'matches')$new$);
  if (length(successor)-length(replace(successor,$old$'search_mode','saved_title_content_literal'$old$,'')))/length($old$'search_mode','saved_title_content_literal'$old$)<>1 then
    raise exception 'imprint_search_reader_anchor_changed'; end if;
  successor:=replace(successor,$old$'search_mode','saved_title_content_literal'$old$,$new$'search_mode','qualified_saved_source_and_retained_body_literal'$new$);
  if (length(successor)-length(replace(successor,$old$'source_content','linked_evidence_on_demand'$old$,'')))/length($old$'source_content','linked_evidence_on_demand'$old$)<>1 then
    raise exception 'imprint_search_reader_anchor_changed'; end if;
  successor:=replace(successor,$old$'source_content','linked_evidence_on_demand'$old$,$new$'source_content','qualified_saved_intake_text'$new$);
  if (length(successor)-length(replace(successor,$old$'prior_body_revisions_available',false$old$,'')))/length($old$'prior_body_revisions_available',false$old$)<>1 then
    raise exception 'imprint_search_reader_anchor_changed'; end if;
  successor:=replace(successor,$old$'prior_body_revisions_available',false$old$,$new$'prior_body_revisions_available',true,'canonical_history_retention','observed_prior_versions_after_feature_install'$new$);
  if encode(sha256(convert_to(successor,'UTF8')),'hex')<>'51f738cbd506be32ec192fe6dba402d4c589d158729415149868f9539e5558a5' then
    raise exception 'imprint_search_reader_successor_changed'; end if;
  expected:=replace(definition,original,successor);
  execute expected;
  select to_jsonb(p)-'prosrc' into after_metadata from pg_proc p where oid=target;
  if before_metadata is distinct from after_metadata or pg_get_functiondef(target) is distinct from expected then
    raise exception 'imprint_search_reader_metadata_changed'; end if;
end $reader_patch$;

do $reader_patch$
declare target regprocedure:=to_regprocedure('public.clued_development_imprint_read_before_associations_v1(jsonb)');
  original text; successor text; definition text; expected text; before_metadata jsonb; after_metadata jsonb;
begin
  if target is null then raise exception 'imprint_search_reader_missing'; end if;
  select prosrc,pg_get_functiondef(oid),to_jsonb(p)-'prosrc' into original,definition,before_metadata from pg_proc p where oid=target;
  successor:=replace(original,E'\r\n',E'\n');
  if encode(sha256(convert_to(successor,'UTF8')),'hex')='d57b3b08a6effd0b911c12cd94f656d631a473b39a1c36f85785afc04a354f6c' then return; end if;
  if encode(sha256(convert_to(successor,'UTF8')),'hex')<>'85625cd627363a274935efac20df20ea0683791b20f606c2f993cc2a4e80a880' then
    raise exception 'imprint_search_reader_source_changed'; end if;
  if (length(successor)-length(replace(successor,$old$clued_private.imprint_record_currentness_v1(v_owner,m,v_scopes) fence
    from$old$,'')))/length($old$clued_private.imprint_record_currentness_v1(v_owner,m,v_scopes) fence
    from$old$)<>1 then
    raise exception 'imprint_search_reader_anchor_changed'; end if;
  successor:=replace(successor,$old$clued_private.imprint_record_currentness_v1(v_owner,m,v_scopes) fence
    from$old$,$new$clued_private.imprint_record_currentness_v1(v_owner,m,v_scopes) fence,
      clued_private.imprint_search_details_v1(v_owner,m,v_query,v_history,v_space.id,v_space.environment) search_details
    from$new$);
  if (length(successor)-length(replace(successor,$old$and (v_query='' or strpos(lower(coalesce(m.title,'')||E'\n'||coalesce(m.content,'')),lower(v_query))>0)$old$,'')))/length($old$and (v_query='' or strpos(lower(coalesce(m.title,'')||E'\n'||coalesce(m.content,'')),lower(v_query))>0)$old$)<>1 then
    raise exception 'imprint_search_reader_anchor_changed'; end if;
  successor:=replace(successor,$old$and (v_query='' or strpos(lower(coalesce(m.title,'')||E'\n'||coalesce(m.content,'')),lower(v_query))>0)$old$,$new$-- Full qualified Canonical source/history matching is applied below.$new$);
  if (length(successor)-length(replace(successor,$old$select * from canonical_matches where fence in ('CURRENT','HISTORY','UNKNOWN','STALE','SHADOWED_BY_ACTIVE_EVENT')$old$,'')))/length($old$select * from canonical_matches where fence in ('CURRENT','HISTORY','UNKNOWN','STALE','SHADOWED_BY_ACTIVE_EVENT')$old$)<>1 then
    raise exception 'imprint_search_reader_anchor_changed'; end if;
  successor:=replace(successor,$old$select * from canonical_matches where fence in ('CURRENT','HISTORY','UNKNOWN','STALE','SHADOWED_BY_ACTIVE_EVENT')$old$,$new$select * from canonical_matches where fence in ('CURRENT','HISTORY','UNKNOWN','STALE','SHADOWED_BY_ACTIVE_EVENT')
      and coalesce((search_details->>'matches')::boolean,false)$new$);
  if (length(successor)-length(replace(successor,$old$'match_source',case when v_query='' then 'browse' else 'latest_body' end) envelope$old$,'')))/length($old$'match_source',case when v_query='' then 'browse' else 'latest_body' end) envelope$old$)<>1 then
    raise exception 'imprint_search_reader_anchor_changed'; end if;
  successor:=replace(successor,$old$'match_source',case when v_query='' then 'browse' else 'latest_body' end) envelope$old$,$new$'match_source',case when v_query='' then 'browse' else 'latest_body' end)||(c.search_details-'matches') envelope$new$);
  if (length(successor)-length(replace(successor,$old$'canonical_prior_bodies_available',false$old$,'')))/length($old$'canonical_prior_bodies_available',false$old$)<>1 then
    raise exception 'imprint_search_reader_anchor_changed'; end if;
  successor:=replace(successor,$old$'canonical_prior_bodies_available',false$old$,$new$'canonical_prior_bodies_available',true,'canonical_source_content','qualified_saved_intake_text',
      'canonical_history_retention','observed_prior_versions_after_feature_install'$new$);
  if encode(sha256(convert_to(successor,'UTF8')),'hex')<>'d57b3b08a6effd0b911c12cd94f656d631a473b39a1c36f85785afc04a354f6c' then
    raise exception 'imprint_search_reader_successor_changed'; end if;
  expected:=replace(definition,original,successor);
  execute expected;
  select to_jsonb(p)-'prosrc' into after_metadata from pg_proc p where oid=target;
  if before_metadata is distinct from after_metadata or pg_get_functiondef(target) is distinct from expected then
    raise exception 'imprint_search_reader_metadata_changed'; end if;
end $reader_patch$;


revoke all on function clued_private.imprint_history_immutable_v1(),
  clued_private.imprint_history_capture_v1(),
  clued_private.imprint_history_record_v1(uuid,public.clued_memories,bigint),
  clued_private.imprint_qualified_source_v1(uuid,public.clued_memories,public.clued_memories,uuid,boolean),
  clued_private.imprint_match_snippet_v1(text,text),
  clued_private.imprint_search_details_v1(uuid,public.clued_memories,text,boolean,uuid,text),
  public.clued_imprint_revision_read_v1(jsonb),public.clued_imprint_source_v1(jsonb)
  from public,anon,authenticated,service_role;
do $acl$
begin
  if exists(select 1 from pg_roles where rolname='clued_worker_gateway') then
    revoke all on clued_private.imprint_record_history_v1 from clued_worker_gateway;
    revoke all on function clued_private.imprint_history_immutable_v1(),clued_private.imprint_history_capture_v1(),
      clued_private.imprint_history_record_v1(uuid,public.clued_memories,bigint),
      clued_private.imprint_qualified_source_v1(uuid,public.clued_memories,public.clued_memories,uuid,boolean),
      clued_private.imprint_match_snippet_v1(text,text),
      clued_private.imprint_search_details_v1(uuid,public.clued_memories,text,boolean,uuid,text),
      public.clued_imprint_revision_read_v1(jsonb),public.clued_imprint_source_v1(jsonb)
      from clued_worker_gateway;
  end if;
end $acl$;
grant execute on function public.clued_imprint_revision_read_v1(jsonb),public.clued_imprint_source_v1(jsonb) to authenticated;
notify pgrst,'reload schema';
