-- Event carrier blocks: reject decision-class legacy Events and explain blocks.
--
-- Incident (2026-10-03): an Owner decision written through the legacy
-- clued_append_event adapter as event_type='decision' became an
-- ACTIVE_UNSTRUCTURED work_log carrier. record_currentness_fence_before_intent_v2
-- then shadowed every global Decision, clued_record_list returned an empty
-- current view with no reason, and dependent project work (M2) stopped until an
-- Agent found the Event and materialized it into a Decision by hand.
--
-- 1. The public adapter rejects decision, correction and retraction Events
--    (the types whose carrier dimensions include 'decision') with the request
--    rule decision_event_requires_record. Their record-shaped replacements are
--    clued_record_mutate / clued_decision_supersede, which commit the Record,
--    Event and Receipt in one transaction. The original adapter body moves to
--    clued_private unchanged; clued_mcp_event_carrier_transition keeps calling
--    it for its supersede/retract successor Events. An idempotent replay of an
--    Event this Binding already appended still returns 'duplicate'.
-- 2. clued_private.blocking_event_carriers_v1 lists the active carriers that
--    withhold State/Task/Decision records of one scope, with the exact
--    arguments that clear each one. clued_record_list (Binding and owner) adds
--    it as withheld_by_active_events; clued_session_resume adds it as
--    blocking_event_carriers for the session scope and, for a project session
--    whose Binding may read Global, for Global. Both keys are omitted when
--    nothing blocks, so unblocked responses are unchanged.
--
-- Currentness, fences, carrier state and the existing shadow rules are
-- unchanged: this migration never clears a block by itself.

-- ---------------------------------------------------------------------------
-- 1. Decision-class guard on the legacy append adapter
-- ---------------------------------------------------------------------------

alter function public.clued_mcp_append_event(text,jsonb)
  rename to clued_mcp_append_event_unguarded;
alter function public.clued_mcp_append_event_unguarded(text,jsonb)
  set schema clued_private;
revoke all on function clued_private.clued_mcp_append_event_unguarded(text,jsonb)
  from public,anon,authenticated,service_role;

create function public.clued_mcp_append_event(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
  v_key text:=nullif(pg_catalog.btrim(p_input->>'idempotency_key'),'');
begin
  if p_input->>'event_type' in ('decision','correction','retraction') then
    v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',
      coalesce(nullif(pg_catalog.btrim(p_input->>'context_key'),''),'global'));
    -- A retry of an Event appended before this guard keeps its original
    -- outcome instead of turning into a rejection.
    if v_key is null or not exists(select 1 from public.clued_context_events e
        where e.user_id=v_binding.user_id and e.binding_id=v_binding.id
          and e.idempotency_key=v_key) then
      raise exception 'decision_event_requires_record' using errcode='42501';
    end if;
  end if;
  return clued_private.clued_mcp_append_event_unguarded(p_token_hash,p_input);
end $$;
revoke all on function public.clued_mcp_append_event(text,jsonb) from public;
grant execute on function public.clued_mcp_append_event(text,jsonb) to anon;

-- Carrier transitions append their successor Event through the unguarded body:
-- supersede may legitimately carry a decision successor and retract always
-- appends a 'retraction'.
do $migration$
declare body text;
  anchor constant text:='public.clued_mcp_append_event(p_token_hash,';
  replacement constant text:='clued_private.clued_mcp_append_event_unguarded(p_token_hash,';
begin
  body:=pg_get_functiondef(
    'public.clued_mcp_event_carrier_transition(text,jsonb)'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1
    or strpos(body,replacement)>0 then
    raise exception 'event_carrier_transition_definition_mismatch';
  end if;
  execute replace(body,anchor,replacement);
end $migration$;

-- ---------------------------------------------------------------------------
-- 2. Blocking carriers with their resolutions
-- ---------------------------------------------------------------------------

create or replace function clued_private.event_carrier_summary_v1(p_payload jsonb)
returns text language sql immutable set search_path='' as $$
  select left(regexp_replace(coalesce(
    nullif(btrim(p_payload->>'title'),''),nullif(btrim(p_payload->>'summary'),''),
    nullif(btrim(p_payload->>'decision'),''),nullif(btrim(p_payload->>'text'),''),
    nullif(btrim(p_payload->>'content'),''),nullif(btrim(p_payload->>'note'),''),
    nullif(btrim(p_payload->>'marker'),''),p_payload::text),'\s+',' ','g'),200)
$$;

-- Lists the active work_log carriers that withhold records of p_record_types in
-- any of p_scopes: carriers stored in those scopes, plus legacy unbound
-- carriers that the legacy inventory maps onto those project scopes. Returns
-- null when nothing blocks. Callers pass only scopes the caller may read.
create or replace function clued_private.blocking_event_carriers_v1(
  p_user_id uuid,p_scopes text[],p_record_types text[]
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_limit constant integer:=20; v_total integer; v_carriers jsonb;
begin
  if p_user_id is null or coalesce(cardinality(p_scopes),0)=0
    or coalesce(cardinality(p_record_types),0)=0 then return null; end if;
  with blocking as (
    select c.*,e.event_type,e.payload,e.occurred_at,
      case when c.canonical_scope=any(p_scopes) then c.canonical_scope
        else (select min(i.project_scope) from clued_private.legacy_event_project_impacts i
          where i.event_id=c.event_id and i.user_id=p_user_id
            and i.project_scope=any(p_scopes)) end as withheld_scope
      from clued_private.event_truth_carriers c
      join public.clued_context_events e on e.id=c.event_id and e.user_id=c.user_id
     where c.user_id=p_user_id and c.visibility='work_log'
       and c.dimensions && p_record_types
       and (
         (c.carrier_state in ('ACTIVE_UNSTRUCTURED','ACTIVE_TYPED','LEGACY_UNBOUND')
           and c.canonical_scope=any(p_scopes))
         or (c.carrier_state='LEGACY_UNBOUND' and exists(
           select 1 from clued_private.legacy_event_project_impacts i
            where i.event_id=c.event_id and i.user_id=p_user_id
              and i.project_scope=any(p_scopes))))
  ), ranked as (
    select b.*,count(*) over () as total,
      row_number() over (order by b.event_id desc) as position
      from blocking b
  )
  select max(r.total)::integer,coalesce(jsonb_agg(jsonb_build_object(
      'event_id',r.event_id,
      'event_type',r.event_type,
      'scope',r.withheld_scope,
      'event_scope',r.canonical_scope,
      'dimensions',to_jsonb(r.dimensions),
      'withholds',to_jsonb(array(select d from unnest(r.dimensions) d
        where d=any(p_record_types) order by d)),
      'carrier_state',r.carrier_state,
      'event_version',r.event_version,
      'transition_version',r.transition_version,
      'occurred_at',r.occurred_at,
      'summary',clued_private.event_carrier_summary_v1(r.payload),
      'resolutions',case when r.carrier_state='LEGACY_UNBOUND' then jsonb_build_array(
          jsonb_build_object('action','owner_legacy_reconcile',
            'when','always',
            'detail','A legacy carrier without a typed binding clears only through an Owner-approved legacy continuity reconcile; an Agent write cannot clear it.'))
        else
          case when r.event_version is null then '[]'::jsonb else jsonb_build_array(
            jsonb_build_object('action','materialize',
              'when','the Event''s claim is still valid',
              'tool','clued_record_mutate',
              'arguments',jsonb_build_object(
                'operation','create',
                'record_type',case when 'decision'=any(r.dimensions) then 'decision'
                  else (select min(d) from unnest(r.dimensions) d) end,
                'scope',r.canonical_scope,
                'lifecycle_status','active',
                'mutation',jsonb_build_object('relations',jsonb_build_object(
                  'materializes_event',jsonb_build_object(
                    'id',r.event_id,'version',r.event_version)))),
              'detail','Send the usual create fields (title, content, the type field, source_refs, source_unavailable_reason, authority) with the Event''s original meaning; the Record, Event binding and Receipt commit together and the carrier becomes MATERIALIZED_TO_RECORD.'))
          end||jsonb_build_array(
            jsonb_build_object('action','owner_continuity_resolution',
              'when','the Event''s claim is wrong or obsolete',
              'tool','clued_event_carrier_transition',
              'arguments',jsonb_build_object(
                'context_key',r.canonical_scope,
                'source_event_id',r.event_id,
                'expected_transition_version',r.transition_version,
                'transition','resolve'),
              'detail','Requires proof_receipt_id of an Owner-authorized continuity_only_resolution_authorized Receipt for this Event. supersede and retract leave an active successor carrier and do not clear the block.'))
        end)
      order by r.event_id desc) filter (where r.position<=v_limit),'[]'::jsonb)
    into v_total,v_carriers
    from ranked r;
  if coalesce(v_total,0)=0 then return null; end if;
  return jsonb_build_object(
    'schema','clued.blocking-event-carriers.v1',
    'scopes',to_jsonb(p_scopes),
    'record_types',to_jsonb(p_record_types),
    'carrier_count',v_total,
    'carriers',v_carriers,
    'carriers_truncated',v_total>v_limit,
    'effect','While any listed carrier is active, current reads withhold every State/Task/Decision record of the listed types in its scope. Clear each carrier with one of its resolutions; the withheld records then return unchanged.');
end $$;
revoke all on function clued_private.event_carrier_summary_v1(jsonb),
  clued_private.blocking_event_carriers_v1(uuid,text[],text[])
  from public,anon,authenticated,service_role;

-- clued_record_list (Binding and owner): explain an empty or partial current view.
alter function clued_private.record_list_core(uuid,jsonb,text[])
  rename to record_list_core_before_carrier_reasons;
revoke all on function clued_private.record_list_core_before_carrier_reasons(uuid,jsonb,text[])
  from public,anon,authenticated,service_role;
create or replace function clued_private.record_list_core(
  p_user_id uuid,p_input jsonb,p_authorized_scopes text[]
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_type text:=coalesce(p_input->>'record_type','state');
  v_scopes text[]; v_block jsonb; v_withheld integer;
begin
  v_result:=clued_private.record_list_core_before_carrier_reasons(
    p_user_id,p_input,p_authorized_scopes);
  if coalesce((p_input->>'include_history')::boolean,false)
    or v_type not in ('state','task','decision') then
    return v_result;
  end if;
  if coalesce(p_input->>'level','global')='global' then
    v_scopes:=array['global']::text[];
  else
    -- The inner list already validated project_id and resolved it to exactly
    -- one effective Project; its records live under that Project's aliases.
    select coalesce(array_agg(distinct 'project:'||r.source_project_id::text),'{}'::text[])
      into v_scopes
      from public.clued_project_resolution_v2 r
     where r.user_id=p_user_id and r.effective_project_id=(
       select r2.effective_project_id from public.clued_project_resolution_v2 r2
        where r2.user_id=p_user_id
          and r2.source_project_id=(p_input->>'project_id')::uuid
          and r2.effective_project_id is not null
        limit 1);
  end if;
  if p_authorized_scopes is not null then
    select coalesce(array_agg(s),'{}'::text[]) into v_scopes
      from unnest(v_scopes) s where s=any(p_authorized_scopes);
  end if;
  v_block:=clued_private.blocking_event_carriers_v1(
    p_user_id,v_scopes,array[v_type]::text[]);
  if v_block is null then return v_result; end if;
  select count(*)::integer into v_withheld
    from public.clued_memories m
   where m.user_id=p_user_id and m.record_type=v_type
     and coalesce(m.canonical_scope,case when m.project_id is null then 'global'
       else 'project:'||m.project_id::text end)=any(v_scopes)
     and coalesce(m.lifecycle_status,'active')='active' and m.archived_at is null
     and clued_private.record_currentness_fence(p_user_id,m.id,v_scopes)
       in ('SHADOWED_BY_ACTIVE_EVENT','UNKNOWN');
  return v_result||jsonb_build_object('withheld_by_active_events',
    v_block||jsonb_build_object('withheld_record_count',v_withheld));
end $$;
revoke all on function clued_private.record_list_core(uuid,jsonb,text[])
  from public,anon,authenticated,service_role;

-- clued_session_resume: name the carriers behind an unresolved or blocked view.
alter function public.clued_mcp_restore(text,jsonb)
  rename to clued_mcp_restore_before_carrier_reasons;
alter function public.clued_mcp_restore_before_carrier_reasons(text,jsonb)
  set schema clued_private;
revoke all on function clued_private.clued_mcp_restore_before_carrier_reasons(text,jsonb)
  from public,anon,authenticated,service_role;
create function public.clued_mcp_restore(
  p_token_hash text,p_input jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_binding public.clued_agent_bindings%rowtype;
  v_scope text; v_blocks jsonb:='[]'::jsonb; v_block jsonb;
  v_types constant text[]:=array['state','task','decision']::text[];
begin
  v_result:=clued_private.clued_mcp_restore_before_carrier_reasons(p_token_hash,p_input);
  if v_result->>'session_token' is null then return v_result; end if;
  v_scope:=coalesce(nullif(v_result->>'context_key',''),
    nullif(btrim(p_input->>'context_key'),''),'global');
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_scope);
  v_block:=clued_private.blocking_event_carriers_v1(
    v_binding.user_id,array[v_scope]::text[],v_types);
  if v_block is not null then v_blocks:=v_blocks||jsonb_build_array(v_block); end if;
  -- Project work depends on Global authority. Name Global carriers only when
  -- this Binding may read Global (the same test as the currentness vector).
  if v_scope<>'global' and
     ('*'=any(v_binding.context_keys) or 'global'=any(v_binding.context_keys)) and
     (not exists(select 1 from clued_private.authorizations_v12 a
        where a.binding_id=v_binding.id)
      or 'read'=any(clued_private.authorization_effective_actions_v13(
        v_binding.id,'scope','global','canonical'))) then
    v_block:=clued_private.blocking_event_carriers_v1(
      v_binding.user_id,array['global']::text[],v_types);
    if v_block is not null then v_blocks:=v_blocks||jsonb_build_array(v_block); end if;
  end if;
  if jsonb_array_length(v_blocks)=0 then return v_result; end if;
  return v_result||jsonb_build_object('blocking_event_carriers',v_blocks);
end $$;
revoke all on function public.clued_mcp_restore(text,jsonb) from public;
grant execute on function public.clued_mcp_restore(text,jsonb) to anon;
