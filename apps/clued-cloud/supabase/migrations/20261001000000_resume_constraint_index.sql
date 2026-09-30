-- Resume returned every resident constraint in full: on 2026-09-30 the
-- Owner's project resume was 94 KB, 88 KB of it constraint text (57
-- constraints). Owner Decision 6b36662e: resume returns a constraint index,
-- and the Agent reads the full text of the constraints that bear on its work.
--
-- clued_session_resume takes constraint_view: 'index' (the default) or
-- 'full'. An index entry carries id, title, scope, version, updated_at and a
-- one-line summary: the content with whitespace collapsed, cut at 120
-- characters with a trailing ellipsis. summary_is_full_text is true when the
-- summary is the whole content unchanged, so short constraints need no second
-- read. constraint_ids (up to 50 ids) returns those constraints in full inside
-- an index response; ids that are not resident constraints the Binding may
-- read are ignored, so the parameter reveals nothing new. constraint_view
-- 'full' keeps the previous response.
--
-- The work_log view renders the same entries, with the summary as the body.
-- The session records its view; a checkpoint renewal hands changed
-- constraints to an index chain in index form and to a full chain in full.
-- Sessions created before this migration have no view and were given full
-- text, so their renewals stay full. Everything else is unchanged.

alter table public.clued_continuity_sessions
  add column if not exists constraint_view text
    check (constraint_view is null or constraint_view in ('index','full'));

create or replace function clued_private.resume_constraint_index_entry(p_constraint jsonb)
returns jsonb language sql immutable set search_path='' as $$
  with body as (
    select coalesce(p_constraint->>'content','') as content,
      pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_constraint->>'content',''),'\s+',' ','g')) as flat
  )
  select jsonb_build_object(
    'id',p_constraint->'id','title',p_constraint->'title','scope',p_constraint->'scope',
    'version',p_constraint->'version','updated_at',p_constraint->'updated_at',
    'summary',case when pg_catalog.char_length(b.flat)<=120 then b.flat
      else pg_catalog.rtrim(pg_catalog.left(b.flat,120))||'…' end,
    'summary_is_full_text',b.flat=b.content and pg_catalog.char_length(b.flat)<=120)
  from body b
$$;

-- Maps a full constraint list to index entries, keeping the ids in p_full_ids
-- in full and the list order unchanged.
create or replace function clued_private.resume_constraints_as_index(p_constraints jsonb,p_full_ids jsonb)
returns jsonb language sql immutable set search_path='' as $$
  select coalesce(jsonb_agg(case when coalesce(p_full_ids,'[]'::jsonb) @> jsonb_build_array(c.item->>'id')
    then c.item else clued_private.resume_constraint_index_entry(c.item) end order by c.ord),'[]'::jsonb)
  from jsonb_array_elements(coalesce(p_constraints,'[]'::jsonb)) with ordinality c(item,ord)
$$;

-- The work_log renderer prints each entry's content; an index entry prints
-- its summary instead.
create or replace function clued_private.resume_constraints_for_log(p_constraints jsonb)
returns jsonb language sql immutable set search_path='' as $$
  select coalesce(jsonb_agg(case when c.item ? 'content' then c.item
      else c.item||jsonb_build_object('content',c.item->>'summary') end order by c.ord),'[]'::jsonb)
  from jsonb_array_elements(coalesce(p_constraints,'[]'::jsonb)) with ordinality c(item,ord)
$$;

revoke all on function clued_private.resume_constraint_index_entry(jsonb),
  clued_private.resume_constraints_as_index(jsonb,jsonb),
  clued_private.resume_constraints_for_log(jsonb)
  from public,anon,authenticated,service_role;

-- Unchanged from 20260930210000_checkpoint_session_renewal.sql except for the
-- constraint view and constraint_ids.
create or replace function public.clued_mcp_restore_before_project_access_v13(p_token_hash text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_binding public.clued_agent_bindings%rowtype;
  v_context_key text:=coalesce(nullif(btrim(p_input->>'context_key'),''),'global');
  v_client_session_id text:=nullif(btrim(p_input->>'client_session_id'),'');
  v_response_view text:=coalesce(nullif(btrim(p_input->>'response_view'),''),'structured');
  v_constraint_view text:=coalesce(nullif(btrim(p_input->>'constraint_view'),''),'index');
  v_constraint_ids jsonb:=coalesce(p_input->'constraint_ids','[]'::jsonb);
  v_event_cursor bigint:=greatest(coalesce((p_input->>'event_cursor')::bigint,0),0);
  v_event_limit integer:=least(greatest(coalesce((p_input->>'event_limit')::integer,25),1),100);
  v_event_budget integer:=least(greatest(coalesce((p_input->>'event_budget_bytes')::integer,65536),4096),262144);
  v_checkpoint public.clued_context_checkpoints%rowtype;
  v_version bigint:=0; v_legacy_boundary bigint:=0;
  v_events jsonb:='[]'::jsonb; v_constraints jsonb:='[]'::jsonb; v_conflicts jsonb:='[]'::jsonb;
  v_pending_count bigint:=0; v_pending_bytes bigint:=0; v_page_count integer:=0;
  v_next_cursor bigint; v_truncated boolean:=false;
  v_session_id uuid; v_session_token text; v_session_hash text; v_receipt_id uuid;
  v_result jsonb; v_can_read_global boolean:=false;
begin
  if v_response_view not in ('structured','work_log') then raise exception 'invalid_response_view' using errcode='22023'; end if;
  if v_constraint_view not in ('index','full') then raise exception 'invalid_constraint_view' using errcode='22023'; end if;
  if jsonb_typeof(v_constraint_ids)<>'array' or jsonb_array_length(v_constraint_ids)>50
    or exists(select 1 from jsonb_array_elements(v_constraint_ids) i(value)
      where jsonb_typeof(i.value)<>'string'
        or (i.value #>> '{}')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    raise exception 'invalid_constraint_ids' using errcode='22023';
  end if;
  select coalesce(jsonb_agg(pg_catalog.lower(i.value #>> '{}')),'[]'::jsonb) into v_constraint_ids
    from jsonb_array_elements(v_constraint_ids) i(value);
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_context_key);
  -- Fence the complete source read and session admission in the existing user
  -- transaction lock, before a concurrent Event can split their snapshots.
  perform clued_private.currentness_user_lock(v_binding.user_id);
  -- Legacy bindings use context_keys. Consent-backed bindings must also have
  -- a currently effective Global read entry; reduction leaves old keys intact.
  v_can_read_global:=('*'=any(v_binding.context_keys) or 'global'=any(v_binding.context_keys))
    and (not exists(select 1 from clued_private.authorizations_v12 a where a.binding_id=v_binding.id)
      or 'read'=any(clued_private.authorization_effective_actions_v13(
        v_binding.id,'scope','global','canonical')));
  insert into public.clued_context_streams(user_id,context_key) values(v_binding.user_id,v_context_key)
    on conflict(user_id,context_key) do nothing;
  select s.version into v_version from public.clued_context_streams s
   where s.user_id=v_binding.user_id and s.context_key=v_context_key;
  select c.* into v_checkpoint from public.clued_context_heads h
    join public.clued_context_checkpoints c on c.id=h.checkpoint_id
   where h.user_id=v_binding.user_id and h.context_key=v_context_key;
  v_legacy_boundary:=coalesce(v_checkpoint.legacy_absorbed_through_event_id,coalesce(v_checkpoint.last_event_id,0));

  select count(*),coalesce(sum(octet_length(e.payload::text)+256),0) into v_pending_count,v_pending_bytes
  from public.clued_context_events e
  where e.user_id=v_binding.user_id and e.context_key=v_context_key and (e.audit_visibility='work_log' or (e.event_schema_version is null and e.audit_visibility is null)) and e.id>v_legacy_boundary
    and not exists(select 1 from public.clued_checkpoint_event_absorptions a
      where a.user_id=e.user_id and a.context_key=e.context_key and a.event_id=e.id);

  with candidate as (
    select e.id,jsonb_build_object(
      'id',e.id,'version',e.version,'type',e.event_type,'payload',e.payload,
      'canonical_event_type',e.canonical_event_type,'target_refs',clued_private.k_cont_visible_target_refs_v1(v_binding.user_id,v_binding.id,v_context_key,e.target_refs),
      'record_targets',coalesce((select jsonb_agg(jsonb_build_object(
        'id',m.id,'title',m.title,'record_type',m.record_type,'lifecycle_status',m.lifecycle_status))
        from jsonb_array_elements(case when jsonb_typeof(e.target_refs)='array'
          then e.target_refs else '[]'::jsonb end) t
        join public.clued_memories m on (t->>'kind')='record'
          and m.id=(case when (t->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then (t->>'id')::uuid end) and m.user_id=e.user_id
          and m.canonical_scope is not null
          and ('*'=any(v_binding.context_keys) or m.canonical_scope=any(v_binding.context_keys))
          and (m.canonical_scope=v_context_key
            or not exists(select 1 from clued_private.authorizations_v12 a where a.binding_id=v_binding.id)
            or 'read'=any(clued_private.authorization_effective_actions_v13(
              v_binding.id,'scope',m.canonical_scope,'canonical')))),'[]'::jsonb),
      'occurred_at',e.occurred_at
    ) row_data
    from public.clued_context_events e
    where e.user_id=v_binding.user_id and e.context_key=v_context_key and (e.audit_visibility='work_log' or (e.event_schema_version is null and e.audit_visibility is null))
      and e.id>v_legacy_boundary and e.id>v_event_cursor
      and not exists(select 1 from public.clued_checkpoint_event_absorptions a
        where a.user_id=e.user_id and a.context_key=e.context_key and a.event_id=e.id)
    order by e.id limit v_event_limit+1
  ), sized as (
    select *,row_number() over(order by id) page_pos,
      sum(octet_length(row_data::text)) over(order by id) running_bytes from candidate
  ), selected as (
    select * from sized where page_pos<=v_event_limit and (page_pos=1 or running_bytes<=v_event_budget)
  )
  select coalesce(jsonb_agg(row_data order by id),'[]'::jsonb),count(*)::integer,max(id)
    into v_events,v_page_count,v_next_cursor from selected;
  v_truncated:=v_page_count<v_pending_count and exists(
    select 1 from public.clued_context_events e
    where e.user_id=v_binding.user_id and e.context_key=v_context_key and (e.audit_visibility='work_log' or (e.event_schema_version is null and e.audit_visibility is null))
      and e.id>v_legacy_boundary and e.id>coalesce(v_next_cursor,v_event_cursor)
      and not exists(select 1 from public.clued_checkpoint_event_absorptions a
        where a.user_id=e.user_id and a.context_key=e.context_key and a.event_id=e.id));
  if not v_truncated then v_next_cursor:=null; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',m.id,'title',m.title,'scope',m.canonical_scope,'version',m.version,
    'constraint',m.type_fields->'constraint','rationale',m.type_fields->'rationale','content',m.content,'updated_at',m.updated_at)
    order by case when m.canonical_scope='global' then 0 else 1 end,m.updated_at desc,m.id),'[]'::jsonb)
    into v_constraints
  from public.clued_memories m
  where m.user_id=v_binding.user_id and m.record_schema_version is not null
    and m.record_type='decision' and m.lifecycle_status='active'
    and clued_private.record_currentness_fence(v_binding.user_id,m.id,
      clued_private.binding_read_scopes_v2(v_binding.user_id,v_binding.id))='CURRENT'
    and coalesce(m.type_fields->>'constraint','false')='true'
    and (m.canonical_scope=v_context_key or (m.canonical_scope='global' and v_can_read_global));
  if v_constraint_view='index' then
    v_constraints:=clued_private.resume_constraints_as_index(v_constraints,v_constraint_ids);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'status','review_required','reason','decision_newer_than_checkpoint','id',m.id,
    'title',m.title,'scope',m.canonical_scope,'version',m.version,'updated_at',m.updated_at)
    order by m.updated_at desc,m.id),'[]'::jsonb) into v_conflicts
  from public.clued_memories m
  where m.user_id=v_binding.user_id and m.record_schema_version is not null
    and m.record_type='decision' and m.lifecycle_status='active'
    and clued_private.record_currentness_fence(v_binding.user_id,m.id,
      clued_private.binding_read_scopes_v2(v_binding.user_id,v_binding.id))='CURRENT'
    and m.updated_at>coalesce(v_checkpoint.created_at,'epoch'::timestamptz)
    and (m.canonical_scope=v_context_key or (m.canonical_scope='global' and v_can_read_global));

  if v_client_session_id is not null then update public.clued_continuity_sessions set ended_at=now()
    where binding_id=v_binding.id and context_key=v_context_key and client_session_id=v_client_session_id and ended_at is null; end if;
  v_session_token:='clued_ses_'||encode(extensions.gen_random_bytes(32),'hex');
  v_session_hash:=encode(extensions.digest(convert_to(v_session_token,'UTF8'),'sha256'),'hex');
  insert into public.clued_continuity_sessions(user_id,binding_id,context_key,token_hash,restored_version,client_session_id,
    delivered_constraint_refs,event_high_water,constraint_view)
  values(v_binding.user_id,v_binding.id,v_context_key,v_session_hash,v_version,v_client_session_id,
    (select coalesce(jsonb_agg(jsonb_build_object('id',c->'id','version',c->'version')),'[]'::jsonb)
      from jsonb_array_elements(v_constraints) c),
    (select max(e.id) from public.clued_context_events e
      where e.user_id=v_binding.user_id and e.context_key=v_context_key),
    v_constraint_view)
  returning id into v_session_id;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(v_binding.user_id,v_binding.id,v_context_key,'restore','session',v_session_id::text,v_version,
    jsonb_build_object('pending_event_count',v_pending_count,'pending_event_bytes',v_pending_bytes,
      'client_session_id',v_client_session_id,'response_view',v_response_view,'event_cursor',v_event_cursor))
  returning id into v_receipt_id;

  v_result:=jsonb_build_object(
    'status',case when v_checkpoint.id is null then 'empty' else 'restored' end,
    'context_key',v_context_key,'version',v_version,'session_token',v_session_token,'session_expires_in',3600,
    'snapshot',coalesce(v_checkpoint.snapshot,'{}'::jsonb),'summary',v_checkpoint.summary,
    'next_action',v_checkpoint.next_action,'checkpoint_coverage',coalesce(v_checkpoint.checkpoint_coverage,'{}'::jsonb),
    'constraint_view',v_constraint_view,
    'active_constraints',v_constraints,'authority_conflicts',v_conflicts,
    'pending_event_count',v_pending_count,'pending_event_bytes',v_pending_bytes,
    'checkpoint_recommended',(v_pending_count>=20 or v_pending_bytes>=32768),
    'checkpoint_recommendation_reason',case when v_pending_count>=20 or v_pending_bytes>=32768
      then 'pending_event_threshold_reached' else null end,
    'event_page',jsonb_build_object('cursor',v_event_cursor,'next_cursor',v_next_cursor,
      'limit',v_event_limit,'budget_bytes',v_event_budget,'returned',v_page_count,'truncated',v_truncated),
    'session_compliance',jsonb_build_object('state','active','required_next','checkpoint_before_handoff'),
    'provenance',jsonb_build_object('canonical_store','clued-cloud/supabase','checkpoint_id',v_checkpoint.id,
      'checkpoint_created_at',v_checkpoint.created_at,'source_binding_id',v_checkpoint.binding_id),
    'receipt_id',v_receipt_id
  );
  if v_response_view='work_log' then
    return v_result||jsonb_build_object('work_log',clued_private.render_resume_log(
      v_binding.user_id,v_context_key,v_events,
      clued_private.resume_constraints_for_log(v_constraints),v_conflicts,
      jsonb_build_object('cursor',v_event_cursor,'next_cursor',v_next_cursor,
        'limit',v_event_limit,'budget_bytes',v_event_budget,'returned',v_page_count,'truncated',v_truncated),v_binding.id));
  end if;
  return v_result||jsonb_build_object('events_after_checkpoint',v_events);
end $$;


-- Unchanged from 20260930210000_checkpoint_session_renewal.sql except that an
-- index chain receives changed constraints in index form and the successor
-- keeps the view.
create or replace function clued_private.renew_checkpoint_session(
  p_binding public.clued_agent_bindings,
  p_session public.clued_continuity_sessions,
  p_version bigint,
  p_checkpoint_id uuid
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_can_read_global boolean; v_legacy_boundary bigint:=0; v_floor bigint;
  v_constraint_refs jsonb; v_constraints_changed jsonb;
  v_events jsonb; v_event_count bigint; v_foreign_count bigint; v_high_water bigint;
  v_token text; v_token_hash text; v_session_id uuid; v_reconcile boolean;
  v_receipt_id uuid;
begin
  -- The same Global read rule and constraint filter as
  -- clued_mcp_restore_before_project_access_v13.
  v_can_read_global:=('*'=any(p_binding.context_keys) or 'global'=any(p_binding.context_keys))
    and (not exists(select 1 from clued_private.authorizations_v12 a where a.binding_id=p_binding.id)
      or 'read'=any(clued_private.authorization_effective_actions_v13(
        p_binding.id,'scope','global','canonical')));
  with visible as (
    select m.* from public.clued_memories m
    where m.user_id=p_binding.user_id and m.record_schema_version is not null
      and m.record_type='decision' and m.lifecycle_status='active'
      and clued_private.record_currentness_fence(p_binding.user_id,m.id,
        clued_private.binding_read_scopes_v2(p_binding.user_id,p_binding.id))='CURRENT'
      and coalesce(m.type_fields->>'constraint','false')='true'
      and (m.canonical_scope=p_session.context_key
        or (m.canonical_scope='global' and v_can_read_global))
  )
  select
    coalesce(jsonb_agg(jsonb_build_object('id',v.id,'version',v.version)
      order by case when v.canonical_scope='global' then 0 else 1 end,v.updated_at desc,v.id),'[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object(
      'id',v.id,'title',v.title,'scope',v.canonical_scope,'version',v.version,
      'constraint',v.type_fields->'constraint','rationale',v.type_fields->'rationale',
      'content',v.content,'updated_at',v.updated_at)
      order by case when v.canonical_scope='global' then 0 else 1 end,v.updated_at desc,v.id)
      filter(where p_session.delivered_constraint_refs is null
        or not p_session.delivered_constraint_refs @>
          jsonb_build_array(jsonb_build_object('id',v.id,'version',v.version))),'[]'::jsonb)
    into v_constraint_refs,v_constraints_changed
  from visible v;
  -- An index chain keeps receiving the index form; a session created before
  -- constraint views existed (null) received full text and keeps it.
  if p_session.constraint_view='index' then
    v_constraints_changed:=clued_private.resume_constraints_as_index(v_constraints_changed,'[]'::jsonb);
  end if;

  -- The same pending set as resume: work-log events above the head's legacy
  -- boundary that no checkpoint absorbed.
  select coalesce(c.legacy_absorbed_through_event_id,coalesce(c.last_event_id,0)) into v_legacy_boundary
    from public.clued_context_heads h join public.clued_context_checkpoints c on c.id=h.checkpoint_id
   where h.user_id=p_binding.user_id and h.context_key=p_session.context_key;
  v_floor:=greatest(coalesce(v_legacy_boundary,0),coalesce(p_session.event_high_water,0));
  with pending as (
    select e.id,e.event_type,e.occurred_at,e.binding_id is not distinct from p_binding.id own
    from public.clued_context_events e
    where e.user_id=p_binding.user_id and e.context_key=p_session.context_key and e.id>v_floor
      and (e.audit_visibility='work_log' or (e.event_schema_version is null and e.audit_visibility is null))
      and not exists(select 1 from public.clued_checkpoint_event_absorptions a
        where a.user_id=e.user_id and a.context_key=e.context_key and a.event_id=e.id)
  )
  select count(*),count(*) filter(where not own),
    coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'type',p.event_type,
      'occurred_at',p.occurred_at,'from_this_binding',p.own) order by p.own,p.id)
      from (select * from pending order by own,id limit 100) p),'[]'::jsonb)
    into v_event_count,v_foreign_count,v_events
  from pending;
  select max(e.id) into v_high_water from public.clued_context_events e
    where e.user_id=p_binding.user_id and e.context_key=p_session.context_key;

  v_token:='clued_ses_'||encode(extensions.gen_random_bytes(32),'hex');
  v_token_hash:=encode(extensions.digest(convert_to(v_token,'UTF8'),'sha256'),'hex');
  insert into public.clued_continuity_sessions(user_id,binding_id,context_key,token_hash,
    restored_version,client_session_id,delivered_constraint_refs,event_high_water,constraint_view)
  values(p_binding.user_id,p_binding.id,p_session.context_key,v_token_hash,p_version,
    p_session.client_session_id,v_constraint_refs,v_high_water,p_session.constraint_view)
  returning id,reconciliation_required into v_session_id,v_reconcile;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,
    object_id,version,metadata)
  values(p_binding.user_id,p_binding.id,p_session.context_key,'session_renew','session',
    v_session_id::text,p_version,jsonb_build_object('session_id',v_session_id,
      'predecessor_session_id',p_session.id,'checkpoint_id',p_checkpoint_id,
      'client_session_id',p_session.client_session_id,
      'constraints_delivered_count',jsonb_array_length(v_constraints_changed),
      'new_event_count',v_event_count,'foreign_event_count',v_foreign_count))
  returning id into v_receipt_id;

  return jsonb_build_object('session_renewal',jsonb_build_object(
    'session_token',v_token,'version',p_version,'session_expires_in',3600,
    'reconciliation_required',v_reconcile,'receipt_id',v_receipt_id,
    'constraint_view',coalesce(p_session.constraint_view,'full'),
    'active_constraint_refs',v_constraint_refs,
    'active_constraints_delivered',v_constraints_changed,
    'new_unabsorbed_events',v_events,
    'new_unabsorbed_event_count',v_event_count,
    'foreign_event_count',v_foreign_count,
    'new_unabsorbed_events_truncated',v_event_count>jsonb_array_length(v_events)));
end $$;

revoke all on function clued_private.renew_checkpoint_session(
  public.clued_agent_bindings,public.clued_continuity_sessions,bigint,uuid)
  from public,anon,authenticated,service_role;

notify pgrst,'reload schema';
