-- Reuse the same owner scopes and record-currentness assessment within a page.
-- The inventory fence, complete-source classifier, signed chain and execution
-- rechecks remain intact. New clients may request at most16 sources per page;
-- stop starting additional classifiers after2s, always making one-source progress.
-- Target bodies exist only in this invocation and never leave the private helper.
create function clued_private.imprint_bulk_preview_inventory_v1(p_owner uuid,p_selection jsonb,p_cursor integer,p_classify boolean,p_page_size integer)
returns jsonb language sql stable security definer set search_path='' as $$
  with owner_scopes as materialized (
    select clued_private.imprint_owner_scopes_v1(p_owner) scopes
  ), scoped as materialized (
    select m,clued_private.imprint_record_scope_v1(m) scope,s.scopes
    from public.clued_memories m cross join owner_scopes s where m.user_id=p_owner
  ), current_records as materialized (
    select m,scope,clued_private.imprint_record_currentness_v1(p_owner,m,scopes) currentness
    from scoped where scope=any(scopes)
      and (p_selection->>'scope'='all' or scope=p_selection->>'scope')
  ), assessed as materialized (
    select (m).id,(m).version,(m).title,char_length((m).content) characters,scope,currentness,
      coalesce(o.version,0) organization_version,o.auto_rules_version,
      encode(extensions.digest(convert_to((m).content,'UTF8'),'sha256'),'hex') body_sha256,
      (select p.version from public.clued_projects p where p.id=(m).project_id and p.user_id=p_owner) project_version,(m).content,
      coalesce((m).user_id=p_owner and (m).record_schema_version=1 and (m).lifecycle_status='active'
        and (m).record_type in ('note','state','task','decision') and (m).authority is distinct from 'imported'
        and coalesce((m).type_fields->>'source_kind','')<>'external_material'
        and scope<>'profile'
        and (scope='global' and (m).project_id is null or
          scope='project:'||(m).project_id::text and exists(
            select 1 from public.clued_projects p where p.id=(m).project_id and p.user_id=p_owner
              and p.progress_status in ('not_started','active','paused') and p.dismissed_at is null
              and p.merged_into_project_id is null and clued_private.project_is_recognized_v2(p_owner,p.id)))
        and currentness='CURRENT',false) qualified,o.record_id is not null protected
    from current_records left join clued_private.imprint_organization_v1 o on o.user_id=p_owner and o.record_id=(m).id
  ), scan_targets as materialized (
    select id,version,title,characters,content
      from (select * from assessed where qualified and not protected order by id offset p_cursor
        limit case when p_classify then p_page_size else 0 end) source_rows
  ), summary as (
    select jsonb_build_object('total',count(*),'characters',coalesce(sum(characters),0),
      'ineligible',count(*) filter(where not qualified),'protected',count(*) filter(where qualified and protected),
      'classifiable',count(*) filter(where qualified and not protected),
      'personal',count(*) filter(where scope='global'),'profile',count(*) filter(where scope='profile'),
      'project',count(*) filter(where scope like 'project:%'),
      'current',count(*) filter(where currentness='CURRENT'),'history',count(*) filter(where currentness='HISTORY'),
      'other_currentness',count(*) filter(where currentness is null or currentness not in ('CURRENT','HISTORY')),
      'automatic_marked',count(*) filter(where protected and auto_rules_version is not null),
      'manual_or_unspecified_marked',count(*) filter(where protected and auto_rules_version is null),
      'unmarked',count(*) filter(where not protected)) counts,
      clued_private.m1_sha256(jsonb_build_object('selection',p_selection,'rules',clued_private.imprint_auto_rules_v1(),
        'inventory',coalesce(jsonb_agg(jsonb_build_array(id,version,body_sha256,scope,currentness,qualified,
          project_version,organization_version,auto_rules_version) order by id),'[]'::jsonb))) digest
      from assessed
  ) select jsonb_build_object('metadata',jsonb_build_object('status','ok','selection',p_selection,
    'rules_version',clued_private.imprint_auto_rules_v1()->>'version',
    'inventory_counts',counts,'max_batch_size',100,'authoritative',false,'digest',digest),
    'targets',coalesce((select jsonb_agg(to_jsonb(s) order by s.id) from scan_targets s),'[]'::jsonb)) from summary
$$;
revoke all on function clued_private.imprint_bulk_preview_inventory_v1(uuid,jsonb,integer,boolean,integer)
  from public,anon,authenticated,service_role;

-- Timing belongs only to the volatile opt-in scheduler. The inventory above
-- is one stable read, and classifiers below read only their captured bodies.
create function clued_private.imprint_bulk_preview_page_v1(p_owner uuid,p_selection jsonb,p_cursor integer,p_classify boolean,p_page_size integer)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare deadline timestamptz:=clock_timestamp()+interval '2 seconds'; snapshot jsonb; result jsonb; target_rows jsonb; target jsonb;
  domains text[]; picked jsonb:='[]'; review_rows jsonb:='[]'; scanned integer:=0;
  ready_characters bigint:=0; review_characters bigint:=0;
begin
  if p_page_size is null or p_page_size not between 1 and 16 then
    raise exception 'bulk_selection_invalid' using errcode='22023'; end if;
  select clued_private.imprint_bulk_preview_inventory_v1(p_owner,p_selection,p_cursor,p_classify,p_page_size) into snapshot;
  result:=snapshot->'metadata'; target_rows:=snapshot->'targets';
  for target in select value from jsonb_array_elements(target_rows) loop
    exit when scanned>0 and clock_timestamp()>=deadline;
    domains:=clued_private.imprint_bulk_domains_v1(target->>'content');
    if cardinality(domains)>0 then
      picked:=picked||jsonb_build_array(jsonb_build_object('record_id',target->'id','record_version',target->'version',
        'title',left(target->>'title',120),'domains',to_jsonb(domains)));
      ready_characters:=ready_characters+(target->>'characters')::bigint;
    else
      review_rows:=review_rows||jsonb_build_array(jsonb_build_object('record_id',target->'id','title',left(target->>'title',120)));
      review_characters:=review_characters+(target->>'characters')::bigint;
    end if;
    scanned:=scanned+1;
  end loop;
  return result||jsonb_build_object('items',picked,'review_sample',review_rows,
    'ready_characters',ready_characters,'review_characters',review_characters,
    'page',jsonb_build_object('cursor',p_cursor,'scanned',scanned,
      'next_cursor',case when p_cursor+scanned<(result->'inventory_counts'->>'classifiable')::bigint then p_cursor+scanned end,
      'complete',p_cursor+scanned>=(result->'inventory_counts'->>'classifiable')::bigint));
end $$;
revoke all on function clued_private.imprint_bulk_preview_page_v1(uuid,jsonb,integer,boolean,integer)
  from public,anon,authenticated,service_role;

-- Existing private callers and older deployed clients retain one-source pages.
create or replace function clued_private.imprint_bulk_preview_v1(p_owner uuid,p_selection jsonb,p_cursor integer default 0,p_classify boolean default true)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare snapshot jsonb; result jsonb; target jsonb; domains text[];
  picked jsonb:='[]'; review_rows jsonb:='[]'; scanned integer:=0;
  ready_characters bigint:=0; review_characters bigint:=0;
begin
  -- Preserve the stable caller snapshot and fixed one-source behavior. Never
  -- call the volatile scheduler from this legacy/metadata-only entry point.
  select clued_private.imprint_bulk_preview_inventory_v1(p_owner,p_selection,p_cursor,p_classify,1) into snapshot;
  result:=snapshot->'metadata';
  for target in select value from jsonb_array_elements(snapshot->'targets') loop
    domains:=clued_private.imprint_bulk_domains_v1(target->>'content');
    if cardinality(domains)>0 then
      picked:=picked||jsonb_build_array(jsonb_build_object('record_id',target->'id','record_version',target->'version',
        'title',left(target->>'title',120),'domains',to_jsonb(domains)));
      ready_characters:=ready_characters+(target->>'characters')::bigint;
    else
      review_rows:=review_rows||jsonb_build_array(jsonb_build_object('record_id',target->'id','title',left(target->>'title',120)));
      review_characters:=review_characters+(target->>'characters')::bigint;
    end if;
    scanned:=scanned+1;
  end loop;
  return result||jsonb_build_object('items',picked,'review_sample',review_rows,
    'ready_characters',ready_characters,'review_characters',review_characters,
    'page',jsonb_build_object('cursor',p_cursor,'scanned',scanned,
      'next_cursor',case when p_cursor+scanned<(result->'inventory_counts'->>'classifiable')::bigint then p_cursor+scanned end,
      'complete',p_cursor+scanned>=(result->'inventory_counts'->>'classifiable')::bigint));
end $$;

create or replace function public.clued_imprint_bulk_preview_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare owner_id uuid:=clued_private.authorization_owner_v12(); selection jsonb; result jsonb; cursor_at integer:=0;
  chain jsonb; picked jsonb; v jsonb; page_size integer:=1;
begin
  if pg_column_size(p_input)>131072 then raise exception 'bulk_selection_invalid' using errcode='22023'; end if;
  if p_input ? 'page_size' then
    if jsonb_typeof(p_input->'page_size') is distinct from 'number'
      or coalesce(p_input->>'page_size','') !~ '^([1-9]|1[0-6])$' then
      raise exception 'bulk_selection_invalid' using errcode='22023'; end if;
    page_size:=(p_input->>'page_size')::integer;
  end if;
  selection:=clued_private.imprint_bulk_selection_v1(owner_id,p_input-array['proof','page_size']);
  if p_input ? 'proof' then
    chain:=clued_private.imprint_bulk_unseal_v1(owner_id,p_input->'proof');
    if chain->'selection' is distinct from selection then raise exception 'bulk_preview_changed' using errcode='40001'; end if;
    cursor_at:=(chain->>'cursor')::integer;
    if cursor_at>=(chain->>'classifiable')::integer then raise exception 'bulk_preview_already_complete' using errcode='22023'; end if;
  end if;
  if page_size=1 then result:=clued_private.imprint_bulk_preview_v1(owner_id,selection,cursor_at);
  else result:=clued_private.imprint_bulk_preview_page_v1(owner_id,selection,cursor_at,true,page_size); end if;
  if chain is not null and (result->>'digest' is distinct from chain->>'digest'
    or result->>'rules_version' is distinct from chain->>'rules_version'
    or result->'inventory_counts'->'classifiable' is distinct from chain->'classifiable') then
    raise exception 'bulk_preview_changed' using errcode='40001'; end if;
  chain:=coalesce(chain,jsonb_build_object('owner_id',owner_id,'selection',selection,'digest',result->>'digest',
    'rules_version',result->>'rules_version','classifiable',result->'inventory_counts'->'classifiable',
    'expires_at',statement_timestamp()+interval '2 hours','cursor',0,'ready',0,'needs_review',0,
    'ready_characters',0,'review_characters',0,'items','[]'::jsonb));
  picked:=chain->'items';
  for v in select value from jsonb_array_elements(result->'items') loop
    if jsonb_array_length(picked)<100 then picked:=picked||jsonb_build_array(v-'title'); end if;
  end loop;
  chain:=chain||jsonb_build_object('cursor',cursor_at+(result->'page'->>'scanned')::integer,
    'ready',(chain->>'ready')::bigint+jsonb_array_length(result->'items'),
    'needs_review',(chain->>'needs_review')::bigint+jsonb_array_length(result->'review_sample'),
    'ready_characters',(chain->>'ready_characters')::bigint+(result->>'ready_characters')::bigint,
    'review_characters',(chain->>'review_characters')::bigint+(result->>'review_characters')::bigint,'items',picked);
  return result||jsonb_build_object('proof',clued_private.imprint_bulk_seal_v1(chain));
end $$;
