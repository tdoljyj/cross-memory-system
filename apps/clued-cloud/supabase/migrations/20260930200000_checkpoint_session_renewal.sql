-- A committed checkpoint ends its session token, so an Agent that keeps
-- working in the same conversation had to call clued_session_resume again
-- before every later checkpoint. Resume returns every resident constraint in
-- full (about 53 KB for the Owner on 2026-09-30), so each extra checkpoint
-- re-read the same text.
--
-- A committed checkpoint now also issues a successor session for the same
-- user, Binding and context, provided the Binding still has read admission to
-- that context (the resume rule). It is bound to the post-checkpoint
-- currentness vector by the existing bind_currentness_session trigger and
-- expires after the usual hour.
--
-- Each session records what its chain has delivered: the id and version of
-- every resident constraint (resume stores the set it returned) and the
-- highest context event id at that moment. The renewal returns the id and
-- version of every resident constraint the Binding may read now, the full
-- text of each one whose id and version the ended session had not delivered
-- (new, changed, or newly visible), and the unabsorbed work-log events above
-- the ended session's event high-water mark, other clients' events first,
-- with counts and a truncation flag. Sessions created before this migration
-- have no delivered set and receive every constraint in full.
--
-- The renewal's high-water read runs under the stream row lock and the user
-- currentness lock the checkpoint holds, which every event append and record
-- write also takes. Resume holds only the user lock, so a note append that
-- already allocated its id may commit after a resume whose high-water mark
-- passed it (for example behind a later record Event); such a note is missing
-- from renewals until the next full resume shows it. Resume does not take the
-- stream lock because appends take stream then user, and resume takes user
-- first. Duplicate and conflicting checkpoints issue nothing. Reconcile and
-- the checkpoint currentness gate are unchanged.

alter table public.clued_continuity_sessions
  add column if not exists delivered_constraint_refs jsonb,
  add column if not exists event_high_water bigint;

-- Unchanged from 20260929133000_resume_record_targets_primary_key_lookup.sql
-- except that the session row records the constraint set and event high-water
-- mark this resume delivered.
create or replace function public.clued_mcp_restore_before_project_access_v13(p_token_hash text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_binding public.clued_agent_bindings%rowtype;
  v_context_key text:=coalesce(nullif(btrim(p_input->>'context_key'),''),'global');
  v_client_session_id text:=nullif(btrim(p_input->>'client_session_id'),'');
  v_response_view text:=coalesce(nullif(btrim(p_input->>'response_view'),''),'structured');
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
    delivered_constraint_refs,event_high_water)
  values(v_binding.user_id,v_binding.id,v_context_key,v_session_hash,v_version,v_client_session_id,
    (select coalesce(jsonb_agg(jsonb_build_object('id',c->'id','version',c->'version')),'[]'::jsonb)
      from jsonb_array_elements(v_constraints) c),
    (select max(e.id) from public.clued_context_events e
      where e.user_id=v_binding.user_id and e.context_key=v_context_key))
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
      v_binding.user_id,v_context_key,v_events,v_constraints,v_conflicts,
      jsonb_build_object('cursor',v_event_cursor,'next_cursor',v_next_cursor,
        'limit',v_event_limit,'budget_bytes',v_event_budget,'returned',v_page_count,'truncated',v_truncated),v_binding.id));
  end if;
  return v_result||jsonb_build_object('events_after_checkpoint',v_events);
end $$;

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
    restored_version,client_session_id,delivered_constraint_refs,event_high_water)
  values(p_binding.user_id,p_binding.id,p_session.context_key,v_token_hash,p_version,
    p_session.client_session_id,v_constraint_refs,v_high_water)
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

-- Unchanged from 20260922092932_bug_20260922_002_admission_reconcile.sql
-- except for the read admission and session renewal on the committed path.
create or replace function public.clued_mcp_commit_checkpoint(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
  v_session public.clued_continuity_sessions%rowtype;
  v_context_key text:=coalesce(nullif(pg_catalog.btrim(p_input->>'context_key'),''),'global');
  v_vector jsonb; v_digest text; v_idempotency_key text; v_result jsonb;
  v_can_read boolean:=true;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',v_context_key);
  v_session:=clued_private.resolve_session(v_binding.user_id,v_binding.id,v_context_key,
    p_input->>'session_token');
  -- Preserve predecessor validation precedence for malformed requests.
  if not (p_input?'base_version') or
     pg_catalog.jsonb_typeof(p_input->'snapshot') is distinct from 'object' or
     pg_catalog.jsonb_typeof(p_input->'coverage') is distinct from 'object' or
     p_input->'coverage'->>'mode' is distinct from 'explicit' or
     pg_catalog.jsonb_typeof(p_input->'coverage'->'contexts') is distinct from 'array' or
     pg_catalog.jsonb_typeof(p_input->'coverage'->'tracks') is distinct from 'array' or
     pg_catalog.jsonb_typeof(p_input->'coverage'->'event_ids') is distinct from 'array' then
    return public.clued_mcp_commit_checkpoint_pre_currentness(p_token_hash,p_input);
  end if;
  if p_input->'coverage'->'contexts'<>jsonb_build_array(v_context_key)
    or jsonb_array_length(p_input->'coverage'->'tracks')<1
    or exists(select 1 from jsonb_array_elements(p_input->'coverage'->'tracks') t(value)
      where jsonb_typeof(t.value)<>'string' or
        char_length(pg_catalog.btrim(t.value #>> '{}')) not between 1 and 80)
    or (select count(*) from jsonb_array_elements_text(p_input->'coverage'->'tracks'))<>
       (select count(distinct t.value) from jsonb_array_elements_text(p_input->'coverage'->'tracks') t(value))
    or exists(select 1 from jsonb_array_elements(p_input->'coverage'->'event_ids') t(value)
      where jsonb_typeof(t.value)<>'number' or t.value::text!~'^[1-9][0-9]*$')
    or char_length(pg_catalog.btrim(coalesce(p_input->>'summary',''))) not between 1 and 4000
    or char_length(pg_catalog.btrim(coalesce(p_input->>'next_action',''))) not between 1 and 1000 then
    return public.clued_mcp_commit_checkpoint_pre_currentness(p_token_hash,p_input);
  end if;
  v_idempotency_key:=nullif(pg_catalog.btrim(p_input->>'idempotency_key'),'');
  if v_idempotency_key is not null and exists(
    select 1 from public.clued_context_checkpoints c
      where c.user_id=v_binding.user_id and c.binding_id=v_binding.id
        and c.idempotency_key=v_idempotency_key) then
    return public.clued_mcp_commit_checkpoint_pre_currentness(p_token_hash,p_input);
  end if;
  perform 1 from public.clued_context_streams s
   where s.user_id=v_binding.user_id and s.context_key=v_context_key for update;
  perform clued_private.currentness_user_lock(v_binding.user_id);
  select * into v_session from public.clued_continuity_sessions
   where id=v_session.id for update;
  v_vector:=clued_private.currentness_vector(v_binding.user_id,v_context_key,v_binding.id);
  v_digest:=clued_private.currentness_hash(v_vector);
  if v_session.restored_currentness_digest is distinct from v_digest then
    update public.clued_continuity_sessions set reconciliation_required=true,
      reconciliation_reason_digest=v_digest where id=v_session.id;
    return jsonb_build_object('status','conflict','error','current_truth_changed_since_resume',
      'context_key',v_context_key);
  end if;
  v_result:=public.clued_mcp_commit_checkpoint_pre_currentness(p_token_hash,p_input);
  if v_result->>'status'='committed' then
    v_result:=v_result||jsonb_build_object('currentness_admission_status',
      case when v_session.reconciliation_required or
        not clued_private.currentness_vector_eligible(v_vector)
      then 'CONTINUITY_COMMITTED_NOT_CURRENT' else 'CURRENT' end);
    -- Renewal hands back what a resume would, so it requires the same read
    -- admission as resume; a Binding reduced to write-only gets no renewal.
    begin
      perform clued_private.resolve_binding(p_token_hash,'context:read',v_context_key);
    exception when others then
      v_can_read:=false;
    end;
    if not v_can_read then
      return v_result||jsonb_build_object('session_renewal',null,
        'session_renewal_unavailable','context_read_not_authorized');
    end if;
    return v_result||clued_private.renew_checkpoint_session(v_binding,v_session,
      (v_result->>'version')::bigint,(v_result->>'checkpoint_id')::uuid);
  end if;
  return v_result;
end $$;
revoke all on function public.clued_mcp_commit_checkpoint(text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.clued_mcp_commit_checkpoint(text,jsonb) to anon;

notify pgrst,'reload schema';
