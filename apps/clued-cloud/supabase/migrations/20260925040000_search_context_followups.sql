-- S2a-2 follow-up (review of PR #334, Task f46591b2): search_context fixes.
-- * The record candidate cap is max(2000, cursor+limit+1), so paging past 2000
--   matches is exact (record_candidates_capped still says when more exist).
-- * At most 24 query terms, and search_score_v1 stops early once the row can no
--   longer reach the minimum score, so long queries stay well under the anon
--   statement timeout.
-- * Without a context_key the session is looked up only among the calling
--   Binding's sessions, and a missing or unknown session is resume_required.
-- * An all-scope search no longer fails when the session's project is gone.
-- * Term rules: a Latin/digit run joined by . - _ (v1.6, s2a-2) is a term
--   together with its parts; single digits are kept; the Japanese particles をのはがにで separate terms;
--   a lone CJK character is only a term when the query has no other term.

create or replace function clued_private.search_terms_v1(p_query text)
returns text[] language plpgsql immutable set search_path='' as $$
declare v_part text; v_terms text[]:='{}'; v_run text; i integer; v_single text[]:='{}';
begin
  for v_part in select t from regexp_split_to_table(lower(coalesce(p_query,'')),
      '[[:space:]，。、；：！？（）【】《》「」『』〔〕“”‘’·…—的了吗呢吧啊呀をのはがにで]+') t where t<>'' loop
    for v_run in select (regexp_matches(v_part,
        '([一-鿿㐀-䶿぀-ヿ]+|[^[:punct:][:space:]一-鿿㐀-䶿぀-ヿ]+(?:[._-][^[:punct:][:space:]一-鿿㐀-䶿぀-ヿ]+)*)','g'))[1] loop
      if v_run ~ '^[一-鿿㐀-䶿぀-ヿ]+$' then
        if char_length(v_run)=1 then v_single:=v_single||v_run; end if;
        for i in 1..char_length(v_run)-1 loop
          v_terms:=v_terms||substr(v_run,i,2);
        end loop;
      else
        -- A joined run (v1.6, s2a-2) is a term, and so is each of its parts.
        if v_run ~ '[._-]' then v_terms:=v_terms||v_run; end if;
        v_terms:=v_terms||array(select p from regexp_split_to_table(v_run,'[._-]') p
          where char_length(p)>1 or p ~ '^[0-9]$');
      end if;
    end loop;
  end loop;
  -- A lone CJK character is too common to be a term next to real ones.
  if cardinality(v_terms)=0 then v_terms:=v_single; end if;
  -- Keep the first 24 distinct terms in query order, returned sorted.
  return coalesce((select array_agg(t order by t) from (
    select t from (select t,min(ord) first_pos from unnest(v_terms) with ordinality u(t,ord) group by t) f
    order by first_pos limit 24) d),'{}');
end $$;

-- p_query must already be lower-cased and trimmed. Returns 0 as soon as the
-- row cannot reach the minimum score for this term count.
create or replace function clued_private.search_score_v1(p_haystack text,p_query text,p_terms text[])
returns numeric language plpgsql immutable set search_path='' as $$
declare v_hay text:=lower(coalesce(p_haystack,'')); v_hit integer:=0; v_miss integer:=0;
  v_term text; v_n integer:=coalesce(cardinality(p_terms),0); v_max_miss integer;
begin
  if strpos(v_hay,p_query)>0 then return 1; end if;
  if v_n=0 then return 0; end if;
  v_max_miss:=v_n-ceil(v_n*clued_private.search_min_score_v1(p_terms))::integer;
  foreach v_term in array p_terms loop
    if strpos(v_hay,v_term)>0 then v_hit:=v_hit+1;
    else
      v_miss:=v_miss+1;
      if v_miss>v_max_miss then return 0; end if;
    end if;
  end loop;
  -- A partial match never ties with a whole-query match.
  return least(round(v_hit::numeric/v_n,4),0.9999);
end $$;

revoke all on function clued_private.search_terms_v1(text) from public,anon,authenticated,service_role;
revoke all on function clued_private.search_score_v1(text,text,text[]) from public,anon,authenticated,service_role;

create or replace function public.clued_mcp_search_context(p_token_hash text, p_input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_binding public.clued_agent_bindings%rowtype; v_session public.clued_continuity_sessions%rowtype;
  v_explicit_context text:=nullif(btrim(p_input->>'context_key'),'');
  v_context_key text;
  v_canonical_scope text;
  -- S2a-2: without an explicit context_key (or with scope='all') the search
  -- covers every scope this Binding may read; a context_key alone keeps the
  -- single-scope search.
  v_scope_mode text:=coalesce(nullif(p_input->>'scope',''),
    case when nullif(btrim(p_input->>'context_key'),'') is null then 'all' else 'context' end);
  v_read_scopes text[]; v_terms text[]; v_min_score numeric;
  v_query text:=btrim(coalesce(p_input->>'query',''));
  v_query_lc text;
  v_include_history boolean:=coalesce((p_input->>'include_history')::boolean,false);
  v_limit integer:=least(greatest(coalesce((p_input->>'limit')::integer,10),1),50);
  v_cursor integer:=greatest(coalesce((p_input->>'cursor')::integer,0),0);
  v_budget integer:=least(greatest(coalesce((p_input->>'max_bytes')::integer,65536),4096),262144);
  v_results jsonb:='[]'::jsonb; v_count integer:=0; v_candidate_count integer:=0;
  v_next_cursor integer; v_truncated boolean:=false; v_oversize boolean:=false;
  v_capped boolean:=false;
begin
  -- Without a context_key, authorize against the context the session was
  -- resumed in; the Binding and session checks below still decide access.
  -- The session is looked up only among the calling Binding's own sessions;
  -- without one there is nothing to authorize against, so resume first.
  v_context_key:=coalesce(v_explicit_context,
    (select s.context_key from public.clued_continuity_sessions s
      join public.clued_agent_bindings b on b.id=s.binding_id and b.user_id=s.user_id
      where b.token_hash=p_token_hash
        and p_input->>'session_token' ~ '^clued_ses_[0-9a-f]{64}$'
        and s.token_hash=pg_catalog.encode(extensions.digest(
          pg_catalog.convert_to(p_input->>'session_token','UTF8'),'sha256'),'hex')));
  if v_context_key is null then raise exception 'resume_required' using errcode='42501'; end if;
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_context_key);
  v_session:=clued_private.resolve_session(v_binding.user_id,v_binding.id,v_context_key,p_input->>'session_token');
  v_canonical_scope:=clued_private.event_canonical_scope(v_binding.user_id,v_context_key);
  if char_length(v_query) not between 1 and 500 then raise exception 'invalid_query_length' using errcode='22023'; end if;
  if v_scope_mode not in ('all','context') then raise exception 'invalid_search_scope' using errcode='22023'; end if;
  if v_canonical_scope is null and v_scope_mode='context' then
    raise exception 'project_scope_unresolved' using errcode='22023';
  end if;
  v_read_scopes:=clued_private.binding_read_scopes_v2(v_binding.user_id,v_binding.id);
  v_query_lc:=lower(v_query);
  v_terms:=clued_private.search_terms_v1(v_query);
  v_min_score:=clued_private.search_min_score_v1(v_terms);
  with record_hits as materialized (
    -- Score once per row (offset 0 keeps the planner from inlining it).
    select m.*,sc.score,
      coalesce(m.canonical_scope,case when m.project_id is not null then 'project:'||m.project_id::text else m.scope end) record_scope
    from public.clued_memories m
    cross join lateral (select clued_private.search_score_v1(
      coalesce(m.title,'')||E'\n'||coalesce(m.content,'')||E'\n'||coalesce(m.type_fields::text,''),
      v_query_lc,v_terms) score offset 0) sc
    where m.user_id=v_binding.user_id
      and clued_private.search_scope_allowed_v1(
        coalesce(m.canonical_scope,case when m.project_id is not null then 'project:'||m.project_id::text else m.scope end),
        v_scope_mode,v_context_key,v_read_scopes)
      and (v_include_history or (m.archived_at is null and m.merged_into_record_id is null
        and m.status not in ('archived','superseded','revoked','cancelled')
        and coalesce(m.lifecycle_status,'active') not in ('archived','revoked','cancelled')))
      and sc.score>=v_min_score
    -- At most max(2000, the end of the requested page) best-scoring records
    -- reach the fence, so a page is never cut short; the response flags the cap.
    order by sc.score desc,m.updated_at desc,m.id limit greatest(2000,v_cursor+v_limit+1)+1
  ), record_matches as materialized (
    -- The currentness fence runs once, and only on rows whose score passed.
    select h.*,f.fence from (select * from record_hits order by score desc,updated_at desc,id
      limit greatest(2000,v_cursor+v_limit+1)) h
    cross join lateral (select clued_private.record_currentness_fence(v_binding.user_id,h.id,v_read_scopes) fence offset 0) f
    where v_include_history or (f.fence='CURRENT'
      and not exists(select 1 from public.clued_memories successor where successor.user_id=h.user_id and successor.supersedes_id=h.id))
  ), matches as (
    select jsonb_build_object('kind','record','id',m.id,'version',m.version,'record_type',m.record_type,
      'scope',m.record_scope,
      'title',m.title,'content',m.content,'status',m.status,'lifecycle_status',m.lifecycle_status,
      'type_fields',m.type_fields,'updated_at',m.updated_at,'record_currentness',m.fence,
      'projection_currentness',m.fence,
      'authoritative',not v_include_history and m.fence='CURRENT',
      'match_score',m.score) row_data,0 source_order,m.score,
      m.updated_at sort_time,m.id::text sort_id
    from record_matches m
    union all
    select jsonb_build_object('kind','checkpoint','id',c.id,'version',c.version,'summary',c.summary,
      'next_action',c.next_action,'snapshot',c.snapshot,'coverage',c.checkpoint_coverage,
      'source_semantics','continuity_history','authoritative',false,'created_at',c.created_at),
      1,sc.score,c.created_at,c.id::text from public.clued_context_checkpoints c
    cross join lateral (select clued_private.search_score_v1(
      coalesce(c.summary,'')||E'\n'||coalesce(c.next_action,'')||E'\n'||coalesce(c.snapshot::text,''),
      v_query_lc,v_terms) score offset 0) sc
    where v_include_history and c.user_id=v_binding.user_id
      and ((v_scope_mode='context' and c.context_key=v_context_key)
        or (v_scope_mode='all' and clued_private.search_scope_allowed_v1(
          clued_private.event_canonical_scope(v_binding.user_id,c.context_key),'all',v_context_key,v_read_scopes)))
      and sc.score>=v_min_score
    union all
    select jsonb_build_object('kind','event','id',e.id,'version',e.version,'type',e.event_type,
      'payload',e.payload,'carrier_state',tc.carrier_state,
      'source_semantics',case when tc.carrier_state in ('ACTIVE_UNSTRUCTURED','ACTIVE_TYPED')
        then 'canonical_material_event' else 'continuity_history' end,
      'structured_action_usable',tc.carrier_state='ACTIVE_TYPED',
      -- Target refs are resolved against the event's own scope in all-scope mode.
      'target_refs',clued_private.k_cont_visible_target_refs_v1(v_binding.user_id,v_binding.id,
        case when v_scope_mode='all' then coalesce(tc.canonical_scope,
          clued_private.event_canonical_scope(v_binding.user_id,e.context_key)) else v_context_key end,
        e.target_refs),'occurred_at',e.occurred_at),
      2,sc.score,e.occurred_at,e.id::text from public.clued_context_events e
    left join clued_private.event_truth_carriers tc on tc.event_id=e.id and tc.user_id=e.user_id
    cross join lateral (select clued_private.search_score_v1(e.payload::text,v_query_lc,v_terms) score offset 0) sc
    where e.user_id=v_binding.user_id
      and ((v_scope_mode='context' and ((v_include_history and (e.context_key=v_context_key or tc.canonical_scope=v_canonical_scope))
          or (not v_include_history and tc.canonical_scope=v_canonical_scope)))
        or (v_scope_mode='all' and clued_private.search_scope_allowed_v1(
          coalesce(tc.canonical_scope,clued_private.event_canonical_scope(v_binding.user_id,e.context_key)),
          'all',v_context_key,v_read_scopes)))
      and (e.audit_visibility='work_log' or (e.event_schema_version is null and e.audit_visibility is null)) and (v_include_history or (tc.visibility='work_log' and
        tc.carrier_state in ('ACTIVE_UNSTRUCTURED','ACTIVE_TYPED')))
      and sc.score>=v_min_score
  ), ordered as (
    select row_data,source_order,score,sort_time,sort_id from matches order by source_order,score desc,sort_time desc,sort_id
    offset v_cursor limit v_limit+1
  ), sized as (
    select *,row_number() over(order by source_order,score desc,sort_time desc,sort_id) page_pos,
      sum(octet_length(row_data::text)) over(order by source_order,score desc,sort_time desc,sort_id rows unbounded preceding) running_bytes
    from ordered
  ), selected as (
    select * from sized where page_pos<=v_limit and (page_pos=1 or running_bytes<=v_budget)
  )
  select coalesce(jsonb_agg(row_data order by source_order,score desc,sort_time desc,sort_id),'[]'::jsonb),count(*)::integer,
    (select count(*)::integer from ordered),coalesce(bool_or(page_pos=1 and running_bytes>v_budget),false),
    (select count(*)>greatest(2000,v_cursor+v_limit+1) from record_hits)
    into v_results,v_count,v_candidate_count,v_oversize,v_capped from selected;
  v_truncated:=v_candidate_count>v_count;
  v_next_cursor:=case when v_truncated then v_cursor+v_count else null end;
  update public.clued_continuity_sessions set last_seen_at=now() where id=v_session.id;
  return jsonb_build_object('status','ok','mode','lexical_terms','scope',v_scope_mode,
    'scopes_searched',case when v_scope_mode='context' then to_jsonb(array[v_canonical_scope])
      when v_read_scopes is null then to_jsonb('all_owned_except_profile'::text)
      else to_jsonb(array_remove(v_read_scopes,'profile')) end,
    'absence_claim',false,
    'record_candidates_capped',v_capped,
    'empty_result_hint',case when v_count=0 then 'No match is not evidence that no such record exists; try other terms, scope=all, or include_history.' end,
    'context_key',v_context_key,'query',v_query,
    'results',v_results,'page',jsonb_build_object('cursor',v_cursor,'next_cursor',v_next_cursor,
      'limit',v_limit,'max_bytes',v_budget,'returned',v_count,'truncated',v_truncated,'oversize_first_item',v_oversize));
end $function$;
