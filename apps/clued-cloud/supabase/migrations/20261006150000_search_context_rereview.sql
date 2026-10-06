-- Search re-review (Owner Decisions 07f80a00 and 5d61f655, Task f46591b2):
-- clued_search_context against the current authorization, currentness and
-- session rules. The search terms, scores and result shapes are unchanged.
-- * Paging and history inputs are read after authorization; a non-integer or
--   non-boolean value is invalid_page_input, never a raw cast error.
-- * Without a context_key and without a usable session, a Binding whose v12
--   authorization expired, whose account is gone or that cannot read any
--   scope keeps its authorization error; only an admitted one is told to
--   resume.
-- * A context_key other than the session's own context is
--   session_context_mismatch, as for checkpoint and reconcile.
-- * Context mode matches records and events by the effective scope and only
--   within the scopes the Binding may read: a project merged into another no
--   longer shows the other project's records or events to a Binding granted
--   only the merged one, and a context named by project name or alias (a
--   legacy all-scope Binding) finds its records again.
-- * Checkpoint and event candidates are capped like records, each context
--   is resolved once, and target refs are resolved only for the returned
--   page, so an include_history search over a long history stays well under
--   the anon statement timeout.
-- * The record cap keeps the best-scoring rows by an explicit order.
-- * A page that reaches the 10000-result paging limit has no next_cursor and
--   says cursor_limit_reached.

create or replace function clued_private.search_int_input_v1(p_value jsonb, p_default integer)
returns integer language plpgsql immutable set search_path='' as $$
begin
  if p_value is null or pg_catalog.jsonb_typeof(p_value)='null' then return p_default; end if;
  if pg_catalog.jsonb_typeof(p_value) in ('number','string') and (p_value#>>'{}') ~ '^-?[0-9]{1,9}$' then
    return (p_value#>>'{}')::integer;
  end if;
  raise exception 'invalid_page_input' using errcode='22023';
end $$;

create or replace function clued_private.search_bool_input_v1(p_value jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
begin
  if p_value is null or pg_catalog.jsonb_typeof(p_value)='null' then return false; end if;
  if pg_catalog.jsonb_typeof(p_value) in ('boolean','string') and (p_value#>>'{}') in ('true','false') then
    return (p_value#>>'{}')='true';
  end if;
  raise exception 'invalid_page_input' using errcode='22023';
end $$;

-- Context mode: the row's effective scope must be the searched context's
-- effective scope and one the Binding may read (NULL read scopes: a legacy
-- all-scope Binding). All mode: any readable scope except profile.
create or replace function clued_private.search_scope_allowed_v2(
  p_scope text,p_mode text,p_canonical_scope text,p_read_scopes text[])
returns boolean language sql immutable set search_path='' as $$
  select case when p_scope is null then false
    when p_mode='context' then p_scope=p_canonical_scope and (p_read_scopes is null or p_scope=any(p_read_scopes))
    else p_scope<>'profile' and (p_read_scopes is null or p_scope=any(p_read_scopes)) end
$$;

revoke all on function clued_private.search_int_input_v1(jsonb,integer) from public,anon,authenticated,service_role;
revoke all on function clued_private.search_bool_input_v1(jsonb) from public,anon,authenticated,service_role;
revoke all on function clued_private.search_scope_allowed_v2(text,text,text,text[]) from public,anon,authenticated,service_role;

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
  -- Read after authorization (below), so a malformed value never answers
  -- before the caller is admitted.
  v_include_history boolean;
  v_limit integer;
  v_cursor integer;
  v_cap integer;
  v_budget integer;
  v_results jsonb:='[]'::jsonb; v_count integer:=0; v_candidate_count integer:=0;
  v_next_cursor integer; v_truncated boolean:=false; v_oversize boolean:=false;
  v_capped boolean:=false; v_cursor_limit boolean:=false;
begin
  if p_input is null or jsonb_typeof(p_input)<>'object' then
    raise exception 'invalid_page_input' using errcode='22023';
  end if;
  -- A context_key other than the session's own context is refused by name
  -- (after the Binding's own authorization), as checkpoint and reconcile do.
  if v_explicit_context is not null then
    perform clued_private.session_context_input(p_token_hash,'context:read',p_input);
  end if;
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
  if v_context_key is null then
    -- Only an admitted Binding is told to resume: one that is revoked,
    -- expired, without an account, without context:read or without any
    -- readable scope keeps its authorization error.
    select b.* into v_binding from public.clued_agent_bindings b where b.token_hash=p_token_hash
      and b.revoked_at is null
      and coalesce((to_jsonb(b)->>'expires_at')::timestamptz>clock_timestamp(),true);
    if not found then
      perform clued_private.resolve_binding(p_token_hash,'context:read','global');
      raise exception 'binding_not_authorized' using errcode='42501';
    end if;
    v_read_scopes:=clued_private.binding_read_scopes_v2(v_binding.user_id,v_binding.id);
    if v_read_scopes is not null and cardinality(v_read_scopes)=0 then
      raise exception 'binding_not_authorized' using errcode='42501';
    end if;
    perform clued_private.resolve_binding(p_token_hash,'context:read',coalesce(v_read_scopes[1],'global'));
    raise exception 'resume_required' using errcode='42501';
  end if;
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_context_key);
  v_session:=clued_private.resolve_session(v_binding.user_id,v_binding.id,v_context_key,p_input->>'session_token');
  v_canonical_scope:=clued_private.event_canonical_scope(v_binding.user_id,v_context_key);
  if char_length(v_query) not between 1 and 500 then raise exception 'invalid_query_length' using errcode='22023'; end if;
  if v_scope_mode not in ('all','context') then raise exception 'invalid_search_scope' using errcode='22023'; end if;
  v_include_history:=clued_private.search_bool_input_v1(p_input->'include_history');
  v_limit:=least(greatest(clued_private.search_int_input_v1(p_input->'limit',10),1),50);
  v_cursor:=greatest(clued_private.search_int_input_v1(p_input->'cursor',0),0);
  v_budget:=least(greatest(clued_private.search_int_input_v1(p_input->'max_bytes',65536),4096),262144);
  -- Deep paging past 10000 results is refused rather than silently fenced.
  if v_cursor>10000 then raise exception 'search_cursor_too_deep' using errcode='22023'; end if;
  v_cap:=greatest(2000,v_cursor+v_limit+1);
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
      and clued_private.search_scope_allowed_v2(
        coalesce(m.canonical_scope,case when m.project_id is not null then 'project:'||m.project_id::text else m.scope end),
        v_scope_mode,v_canonical_scope,v_read_scopes)
      and (v_include_history or (m.archived_at is null and m.merged_into_record_id is null
        and m.status not in ('archived','superseded','revoked','cancelled')
        and coalesce(m.lifecycle_status,'active') not in ('archived','revoked','cancelled')))
      and sc.score>=v_min_score
  ), record_matches as materialized (
    -- The currentness fence runs once per row, best score first, and stops once
    -- v_cap+1 rows have passed it: the cap counts fenced rows, so a page is
    -- never cut short by rows the fence drops. The outer order keeps the
    -- best-scoring rows whatever plan the lateral join gets.
    select h.*,f.fence from (select * from record_hits order by score desc,updated_at desc,id) h
    cross join lateral (select clued_private.record_currentness_fence(v_binding.user_id,h.id,v_read_scopes) fence offset 0) f
    where v_include_history or (f.fence='CURRENT'
      and not exists(select 1 from public.clued_memories successor where successor.user_id=h.user_id and successor.supersedes_id=h.id))
    order by h.score desc,h.updated_at desc,h.id
    limit v_cap+1
  ), context_scopes as materialized (
    -- Each context is resolved to its effective scope once, not once per row.
    select k.context_key,clued_private.event_canonical_scope(v_binding.user_id,k.context_key) scope
    from (select distinct c.context_key from public.clued_context_checkpoints c
            where v_include_history and c.user_id=v_binding.user_id
          union
          select distinct e.context_key from public.clued_context_events e
            where e.user_id=v_binding.user_id) k
  ), checkpoint_hits as materialized (
    select c.*,sc.score from public.clued_context_checkpoints c
    left join context_scopes cs on cs.context_key=c.context_key
    cross join lateral (select clued_private.search_score_v1(
      coalesce(c.summary,'')||E'\n'||coalesce(c.next_action,'')||E'\n'||coalesce(c.snapshot::text,''),
      v_query_lc,v_terms) score offset 0) sc
    where v_include_history and c.user_id=v_binding.user_id
      and ((v_scope_mode='context' and c.context_key=v_context_key)
        or (v_scope_mode='all' and clued_private.search_scope_allowed_v2(cs.scope,'all',null,v_read_scopes)))
      and sc.score>=v_min_score
    order by sc.score desc,c.created_at desc,c.id
    limit v_cap+1
  ), event_hits as materialized (
    select e.id,e.version,e.event_type,e.payload,e.occurred_at,e.target_refs,tc.carrier_state,sc.score,
      -- Target refs are resolved against the event's own scope in all-scope mode.
      case when v_scope_mode='all' then coalesce(tc.canonical_scope,cs.scope) else v_context_key end ref_scope
    from public.clued_context_events e
    left join clued_private.event_truth_carriers tc on tc.event_id=e.id and tc.user_id=e.user_id
    left join context_scopes cs on cs.context_key=e.context_key
    cross join lateral (select clued_private.search_score_v1(e.payload::text,v_query_lc,v_terms) score offset 0) sc
    where e.user_id=v_binding.user_id
      and ((v_scope_mode='context'
          and (clued_private.search_scope_allowed_v2(tc.canonical_scope,'context',v_canonical_scope,v_read_scopes)
            -- A legacy event without a carrier belongs to the context it was written in.
            or (v_include_history and tc.event_id is null and e.context_key=v_context_key)))
        or (v_scope_mode='all' and clued_private.search_scope_allowed_v2(
          coalesce(tc.canonical_scope,cs.scope),'all',null,v_read_scopes)))
      and (e.audit_visibility='work_log' or (e.event_schema_version is null and e.audit_visibility is null)) and (v_include_history or (tc.visibility='work_log' and
        tc.carrier_state in ('ACTIVE_UNSTRUCTURED','ACTIVE_TYPED')))
      and sc.score>=v_min_score
    order by sc.score desc,e.occurred_at desc,e.id
    limit v_cap+1
  ), matches as (
    select jsonb_build_object('kind','record','id',m.id,'version',m.version,'record_type',m.record_type,
      'scope',m.record_scope,
      'title',m.title,'content',m.content,'status',m.status,'lifecycle_status',m.lifecycle_status,
      'type_fields',m.type_fields,'updated_at',m.updated_at,'record_currentness',m.fence,
      'projection_currentness',m.fence,
      'authoritative',not v_include_history and m.fence='CURRENT',
      'match_score',m.score) row_data,0 source_order,m.score,
      m.updated_at sort_time,m.id::text sort_id,null::text ref_scope,null::jsonb raw_refs
    from (select * from record_matches order by score desc,updated_at desc,id limit v_cap) m
    union all
    select jsonb_build_object('kind','checkpoint','id',c.id,'version',c.version,'summary',c.summary,
      'next_action',c.next_action,'snapshot',c.snapshot,'coverage',c.checkpoint_coverage,
      'source_semantics','continuity_history','authoritative',false,'created_at',c.created_at),
      1,c.score,c.created_at,c.id::text,null::text,null::jsonb
    from (select * from checkpoint_hits order by score desc,created_at desc,id limit v_cap) c
    union all
    select jsonb_build_object('kind','event','id',e.id,'version',e.version,'type',e.event_type,
      'payload',e.payload,'carrier_state',e.carrier_state,
      'source_semantics',case when e.carrier_state in ('ACTIVE_UNSTRUCTURED','ACTIVE_TYPED')
        then 'canonical_material_event' else 'continuity_history' end,
      'structured_action_usable',e.carrier_state='ACTIVE_TYPED',
      'occurred_at',e.occurred_at),
      2,e.score,e.occurred_at,e.id::text,e.ref_scope,e.target_refs
    from (select * from event_hits order by score desc,occurred_at desc,id limit v_cap) e
  ), ordered as (
    -- Target refs need an authorization check per ref, so only the rows of
    -- this page (and the one that tells whether more exist) resolve them.
    select case when p.source_order=2 then p.row_data||jsonb_build_object('target_refs',
        clued_private.k_cont_visible_target_refs_v1(v_binding.user_id,v_binding.id,p.ref_scope,p.raw_refs))
      else p.row_data end row_data,
      p.source_order,p.score,p.sort_time,p.sort_id
    from (select * from matches order by source_order,score desc,sort_time desc,sort_id
      offset v_cursor limit v_limit+1) p
  ), sized as (
    select *,row_number() over(order by source_order,score desc,sort_time desc,sort_id) page_pos,
      sum(octet_length(row_data::text)) over(order by source_order,score desc,sort_time desc,sort_id rows unbounded preceding) running_bytes
    from ordered
  ), selected as (
    select * from sized where page_pos<=v_limit and (page_pos=1 or running_bytes<=v_budget)
  )
  select coalesce(jsonb_agg(row_data order by source_order,score desc,sort_time desc,sort_id),'[]'::jsonb),count(*)::integer,
    (select count(*)::integer from ordered),coalesce(bool_or(page_pos=1 and running_bytes>v_budget),false),
    (select count(*)>v_cap from record_matches) or (select count(*)>v_cap from checkpoint_hits)
      or (select count(*)>v_cap from event_hits)
    into v_results,v_count,v_candidate_count,v_oversize,v_capped from selected;
  v_truncated:=v_candidate_count>v_count;
  -- A cursor past 10000 is refused, so a page that reaches it has no next page.
  v_cursor_limit:=v_truncated and v_cursor+v_count>10000;
  v_next_cursor:=case when v_truncated and not v_cursor_limit then v_cursor+v_count else null end;
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
      'limit',v_limit,'max_bytes',v_budget,'returned',v_count,'truncated',v_truncated,'oversize_first_item',v_oversize,
      'cursor_limit_reached',v_cursor_limit));
end $function$;
