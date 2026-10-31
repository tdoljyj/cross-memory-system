-- Priority custom v1 (Task a72ecb24; Owner Decision be5d5b6c, superseding
-- 53dba2b1): the record priority field carries only the Owner's custom
-- priority, and the automatic MTPE score reads it.
--
-- Until now any writer could put a number in type_fields.priority (0-100);
-- 20260922030001 copied it into clued_memories.priority, record lists sorted
-- on it and mtpe_sync_record added priority/7 to the automatic score. The
-- number had no defined meaning, so:
--
-- 1. Ordinary record writes no longer set it. clued_record_mutate,
--    clued_user_record_mutate (record_mutation_core) and
--    clued_decision_supersede drop type_fields.priority (and the history key
--    legacy_priority) from what they are sent; a sent priority is named in the
--    result (notices: priority_not_writable). On the next write of a record
--    that still stores type_fields.priority (update, close, restore,
--    reclassify), that value moves to type_fields.legacy_priority;
--    legacy_priority is kept as stored, also under field_mode=replace. The
--    Native candidate confirmation no longer accepts a priority choice.
-- 2. The column clued_memories.priority changes only through the custom
--    priority channel below. The trigger of 20260922030001 is replaced: any
--    other insert writes 0 and any other update keeps the stored value.
-- 3. Existing values are kept in clued_private.record_priority_legacy_v1
--    (column value and type_fields.priority of every record that had one) and
--    the column is reset to 0. Rows are otherwise untouched: type_fields,
--    version, updated_at and content_hash stay as they were (several pinned
--    Owner anchors bind content_hash), so the stored type_fields.priority of a
--    record stays until its next update moves it (item 1).
-- 4. The custom priority channel: one value per record (0 = none, 1-100),
--    with a per-record version, its source and a history. Two sources count:
--    * the Owner on the BeamingFace page /priority, signed in directly
--      (clued_private.authorization_owner_v12, native session id required):
--      clued_priority_custom_set_v1 and clued_priority_custom_undo_v1, with a
--      base_version CAS; a change that changes nothing leaves no receipt;
--    * an Agent on the Owner's explicit request, through its Binding:
--      clued_mtpe_owner_pin operation custom_priority_set, carrying the
--      Owner's words in owner_instruction (source agent_on_owner_request).
--      It is an existing Worker RPC; no anonymous or gateway signature is
--      added.
--    Every change leaves a receipt naming the new and previous value and
--    the custom priority version (agent: an M1 receipt and Event
--    extension:mtpe:custom_priority; page: CUSTOM_PRIORITY_SET /
--    CUSTOM_PRIORITY_UNDONE) and a history row. The Owner undoes the latest
--    change of a record in one step, whoever made it. A non-zero value needs
--    an active record; 0 (clear) is always allowed, so a closed record never
--    keeps a value nobody can remove. Setting the column
--    does not bump the record's version or updated_at: priority is not record
--    content, and other writers' CAS stays valid.
-- 5. MTPE: the explicit term of mtpe_sync_record reads the custom priority,
--    weight 0.3 (custom 100 adds 30 points, rounded; the old term added at
--    most 14 from the Agent-written number). Every governed record is
--    re-derived, the regression suite gates the result, and both Global
--    projections are invalidated, as 20260924140000 did.
--
-- Orderings that use priority (checked against the live definitions):
-- * record lists (record_list_core_before_projection_envelope, through
--   clued_record_list / clued_user_record_list) and view clued_global_work_v2
--   order by priority desc, updated_at desc: custom priority first, then most
--   recent. No definition changes.
-- * the projection-refresh pick of 20260923213000:296 no longer orders by
--   priority: 20260924110000 (then 20260924130000) replaced
--   projection_refresh_frontier_apply with the MTPE snapshot selection, which orders by algorithm_priority and so
--   sees the custom priority through item 5.
-- * mtpe_snapshot (system priority, frontier) and the merge train order by
--   algorithm_priority: item 5.

-- 1. Tables ---------------------------------------------------------------

create table clued_private.record_custom_priority_v1 (
  record_id uuid primary key references public.clued_memories(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  priority smallint not null check (priority between 0 and 100),
  version bigint not null check (version>=1),
  source text not null check (source in ('owner_page','owner_undo','agent_on_owner_request')),
  owner_instruction text check (owner_instruction is null or char_length(owner_instruction) between 1 and 2000),
  binding_id uuid,
  updated_at timestamptz not null,
  receipt_id uuid not null,
  check ((source='agent_on_owner_request')=(owner_instruction is not null and binding_id is not null))
);
create index record_custom_priority_v1_user on clued_private.record_custom_priority_v1(user_id,priority desc);

create table clued_private.record_custom_priority_history_v1 (
  id bigint generated always as identity primary key,
  record_id uuid not null references public.clued_memories(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  version bigint not null check (version>=1),
  priority smallint not null check (priority between 0 and 100),
  previous_priority smallint not null check (previous_priority between 0 and 100),
  source text not null check (source in ('owner_page','owner_undo','agent_on_owner_request')),
  owner_instruction text,
  binding_id uuid,
  session_id text,
  receipt_id uuid not null,
  undo_of bigint references clued_private.record_custom_priority_history_v1(id),
  created_at timestamptz not null,
  unique (record_id,version),
  check ((source='owner_undo')=(undo_of is not null))
);
create index record_custom_priority_history_v1_user on clued_private.record_custom_priority_history_v1(user_id,id desc);

create table clued_private.record_priority_legacy_v1 (
  record_id uuid primary key references public.clued_memories(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  column_priority smallint not null,
  type_fields_priority jsonb,
  moved_at timestamptz not null
);

revoke all on clued_private.record_custom_priority_v1,clued_private.record_custom_priority_history_v1,
  clued_private.record_priority_legacy_v1 from public,anon,authenticated,service_role;

-- 2. The column belongs to the channel --------------------------------------

-- custom_priority_apply_v1 marks the one row it writes (transaction-local);
-- everything else writes 0 on insert and keeps the stored value on update.
create or replace function clued_private.m1_sync_record_priority()
returns trigger language plpgsql set search_path='' as $$
begin
  if pg_catalog.current_setting('clued.custom_priority_writer',true) is distinct from 'record:'||new.id::text then
    new.priority:=case when tg_op='UPDATE' then old.priority else 0 end;
  end if;
  return new;
end $$;
revoke all on function clued_private.m1_sync_record_priority() from public,anon,authenticated,service_role;

drop trigger clued_m1_record_priority_sync on public.clued_memories;
create trigger clued_m1_record_priority_sync
  before insert or update of priority on public.clued_memories
  for each row execute function clued_private.m1_sync_record_priority();

-- 3. Existing values move to history ----------------------------------------

insert into clued_private.record_priority_legacy_v1(record_id,user_id,column_priority,type_fields_priority,moved_at)
select m.id,m.user_id,m.priority,case when m.type_fields ? 'priority' then m.type_fields->'priority' end,now()
  from public.clued_memories m
 where m.priority<>0 or coalesce(m.type_fields ? 'priority',false);

select pg_catalog.set_config('clued.custom_priority_writer','',true);
do $$
declare r record;
begin
  for r in select id from public.clued_memories where priority<>0 loop
    perform pg_catalog.set_config('clued.custom_priority_writer','record:'||r.id::text,true);
    update public.clued_memories set priority=0 where id=r.id;
  end loop;
  perform pg_catalog.set_config('clued.custom_priority_writer','',true);
end $$;

-- 4. Record writes drop priority ------------------------------------------------

create function clued_private.priority_strip_type_fields_v1(p_type_fields jsonb) returns jsonb
language sql immutable set search_path='' as $$
  select case when jsonb_typeof(p_type_fields)='object' then p_type_fields-'priority'-'legacy_priority'
    else p_type_fields end
$$;

create function clued_private.priority_strip_mutation_v1(p_mutation jsonb) returns jsonb
language sql immutable set search_path='' as $$
  select case when jsonb_typeof(p_mutation)='object' and jsonb_typeof(p_mutation->'type_fields')='object'
    then jsonb_set(p_mutation,'{type_fields}',clued_private.priority_strip_type_fields_v1(p_mutation->'type_fields'))
    else p_mutation end
$$;

-- p_next is the type_fields an update stores (a merge keeps stored keys). It
-- loses priority; a stored legacy_priority is kept, otherwise a stored
-- (Agent-written) priority becomes legacy_priority.
create function clued_private.priority_legacy_carry_v1(p_stored jsonb,p_next jsonb) returns jsonb
language sql immutable set search_path='' as $$
  select case when jsonb_typeof(p_next)<>'object' then p_next
    else clued_private.priority_strip_type_fields_v1(p_next)||case
      when jsonb_typeof(p_stored)<>'object' then '{}'::jsonb
      when p_stored ? 'legacy_priority' then jsonb_build_object('legacy_priority',p_stored->'legacy_priority')
      when p_stored ? 'priority' and p_stored->'priority'<>'null'::jsonb
        then jsonb_build_object('legacy_priority',p_stored->'priority')
      else '{}'::jsonb end end
$$;

create function clued_private.priority_ignored_notice_v1(p_input jsonb) returns jsonb
language sql immutable set search_path='' as $$
  select case when jsonb_typeof(p_input)='object' and exists(
      select 1 from (values (p_input#>'{mutation,type_fields}'),(p_input#>'{replacement,type_fields}')) t(fields)
      where jsonb_typeof(t.fields)='object' and t.fields ? 'priority')
    then jsonb_build_object('notices',jsonb_build_array(jsonb_build_object('code','priority_not_writable',
      'message','type_fields.priority was ignored and not stored: record priority now holds only the Owner''s custom priority. '||
        'Do not set it yourself. Only when the Owner explicitly asks, call clued_mtpe_owner_pin with operation custom_priority_set '||
        'and the Owner''s own words in owner_instruction.')))
    else '{}'::jsonb end
$$;

revoke all on function clued_private.priority_strip_type_fields_v1(jsonb),
  clued_private.priority_strip_mutation_v1(jsonb),clued_private.priority_legacy_carry_v1(jsonb,jsonb),
  clued_private.priority_ignored_notice_v1(jsonb) from public,anon,authenticated,service_role;

-- Anchored patches: each replaces one statement and fails unless the anchor
-- occurs exactly once.
create function clued_private.priority_custom_patch_v1(p_function regprocedure,p_anchor text,p_replacement text)
returns void language plpgsql set search_path='' as $$
declare body text:=pg_catalog.pg_get_functiondef(p_function);
begin
  if array_length(string_to_array(body,p_anchor),1) is distinct from 2 then
    raise exception 'priority_custom_patch_anchor_mismatch: % / %',p_function,left(p_anchor,80);
  end if;
  execute replace(body,p_anchor,p_replacement);
end $$;

select clued_private.priority_custom_patch_v1('clued_private.record_mutation_core(uuid,uuid,jsonb,text)',
$a$    v_mutation:=coalesce(p_input->'mutation','{}');$a$,
$r$    -- 20261031070000: type_fields.priority holds only the Owner's custom
    -- priority, set through its own channel; a record write drops it.
    v_mutation:=clued_private.priority_strip_mutation_v1(coalesce(p_input->'mutation','{}'));$r$);
select clued_private.priority_custom_patch_v1('clued_private.record_mutation_core(uuid,uuid,jsonb,text)',
$a$        coalesce((v_type_fields->>'priority')::smallint,0),1,$a$,
$r$        0,1,$r$);
select clued_private.priority_custom_patch_v1('clued_private.record_mutation_core(uuid,uuid,jsonb,text)',
$a$      v_sources:=case when p_input ? 'source_refs' then clued_private.m1_sorted_uuid_array(p_input->'source_refs') else v_record.source_refs end;$a$,
$r$      v_type_fields:=clued_private.priority_legacy_carry_v1(v_record.type_fields,v_type_fields);
      v_sources:=case when p_input ? 'source_refs' then clued_private.m1_sorted_uuid_array(p_input->'source_refs') else v_record.source_refs end;$r$);
select clued_private.priority_custom_patch_v1('clued_private.record_mutation_core(uuid,uuid,jsonb,text)',
$a$      || jsonb_build_object('replayed',v_receipt.related_receipt_id is null);$a$,
$r$      || clued_private.priority_ignored_notice_v1(p_input)
      || jsonb_build_object('replayed',v_receipt.related_receipt_id is null);$r$);
select clued_private.priority_custom_patch_v1('clued_private.record_mutation_core(uuid,uuid,jsonb,text)',
$a$    return v_result||jsonb_build_object('replayed',false,'supplemental',jsonb_build_object('record',$a$,
$r$    return v_result||clued_private.priority_ignored_notice_v1(p_input)||jsonb_build_object('replayed',false,'supplemental',jsonb_build_object('record',$r$);
select clued_private.priority_custom_patch_v1('clued_private.record_mutation_core(uuid,uuid,jsonb,text)',
$a$    return v_result||jsonb_build_object('replayed',false);$a$,
$r$    return v_result||clued_private.priority_ignored_notice_v1(p_input)||jsonb_build_object('replayed',false);$r$);

select clued_private.priority_custom_patch_v1('clued_private.decision_supersede_core(uuid,uuid,jsonb,text)',
$a$    v_type_fields:=coalesce(v_repl->'type_fields','{}'); v_relations:=coalesce(v_repl->'relations','{}');$a$,
$r$    v_type_fields:=clued_private.priority_strip_type_fields_v1(coalesce(v_repl->'type_fields','{}')); v_relations:=coalesce(v_repl->'relations','{}');$r$);
select clued_private.priority_custom_patch_v1('clued_private.decision_supersede_core(uuid,uuid,jsonb,text)',
$a$    return v_result||jsonb_build_object('replayed',false,'supplemental',jsonb_build_object('replacement',$a$,
$r$    return v_result||clued_private.priority_ignored_notice_v1(p_input)||jsonb_build_object('replayed',false,'supplemental',jsonb_build_object('replacement',$r$);

-- The Native candidate confirmation no longer offers a priority choice: it
-- would be dropped at promotion. The Owner sets it on /priority instead.
select clued_private.priority_custom_patch_v1('clued_private.candidate_record_body_v1(uuid,text,uuid,jsonb,uuid)',
$a$    elsif v_key='priority' then
      if v_type<>'task' then raise exception 'native_type_field_not_allowed:%',v_key using errcode='22023'; end if;
      if jsonb_typeof(v_val)<>'number' or (v_val#>>'{}') !~ '^(0|[1-9][0-9]?|100)$' then
        raise exception 'native_type_field_invalid:%',v_key using errcode='22023'; end if;$a$,
$r$    elsif v_key='priority' then
      -- 20261031070000: the Owner's custom priority is set on /priority.
      raise exception 'native_type_field_not_allowed:%',v_key using errcode='22023';$r$);

-- 5. The custom priority channel ----------------------------------------------

create function clued_private.custom_priority_view_v1(p_user_id uuid,p_record_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(
    (select jsonb_build_object('record_id',c.record_id,'priority',c.priority,'version',c.version,
        'source',c.source,'owner_instruction',c.owner_instruction,'binding_id',c.binding_id,
        'agent_name',(select b.agent_name from public.clued_agent_bindings b where b.id=c.binding_id and b.user_id=c.user_id),
        'updated_at',c.updated_at,'receipt_id',c.receipt_id,
        'undo_available',exists(select 1 from clued_private.record_custom_priority_history_v1 h
          where h.record_id=c.record_id and h.version=c.version))
      from clued_private.record_custom_priority_v1 c where c.user_id=p_user_id and c.record_id=p_record_id),
    jsonb_build_object('record_id',p_record_id,'priority',0,'version',0,'source',null,'owner_instruction',null,
      'binding_id',null,'agent_name',null,'updated_at',null,'receipt_id',null,'undo_available',false))
$$;

-- The one writer of clued_memories.priority. The caller holds the user's
-- currentness lock and the record row, has checked the CAS and made the receipt.
create function clued_private.custom_priority_apply_v1(p_record public.clued_memories,p_priority integer,
  p_source text,p_instruction text,p_binding_id uuid,p_session_id text,p_receipt_id uuid,p_undo_of bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_previous integer; v_version bigint; v_now timestamptz:=pg_catalog.clock_timestamp(); v_source jsonb;
begin
  select c.priority,c.version into v_previous,v_version from clued_private.record_custom_priority_v1 c
    where c.record_id=p_record.id and c.user_id=p_record.user_id for update;
  v_previous:=coalesce(v_previous,0); v_version:=coalesce(v_version,0)+1;
  insert into clued_private.record_custom_priority_v1(record_id,user_id,priority,version,source,
    owner_instruction,binding_id,updated_at,receipt_id)
  values(p_record.id,p_record.user_id,p_priority,v_version,p_source,p_instruction,p_binding_id,v_now,p_receipt_id)
  on conflict (record_id) do update set priority=excluded.priority,version=excluded.version,
    source=excluded.source,owner_instruction=excluded.owner_instruction,binding_id=excluded.binding_id,
    updated_at=excluded.updated_at,receipt_id=excluded.receipt_id;
  insert into clued_private.record_custom_priority_history_v1(record_id,user_id,version,priority,
    previous_priority,source,owner_instruction,binding_id,session_id,receipt_id,undo_of,created_at)
  values(p_record.id,p_record.user_id,v_version,p_priority,v_previous,p_source,p_instruction,
    p_binding_id,p_session_id,p_receipt_id,p_undo_of,v_now);
  perform pg_catalog.set_config('clued.custom_priority_writer','record:'||p_record.id::text,true);
  update public.clued_memories set priority=p_priority where id=p_record.id and user_id=p_record.user_id;
  perform pg_catalog.set_config('clued.custom_priority_writer','',true);
  perform clued_private.mtpe_sync_record(p_record.id);
  -- The same Global invalidation as an Owner Pin: the frontier is recomputed.
  v_source:=jsonb_build_object('kind','custom_priority','id',p_record.id,'scope',p_record.canonical_scope,
    'custom_priority_version',v_version);
  insert into clued_private.projection_invalidation_heads(user_id,target_scope,
    projection_key,invalidation_revision,latest_source_ref,stale_since)
  values(p_record.user_id,'global','global.priority_frontier',1,v_source,now()),
        (p_record.user_id,'global','global.__aggregate__',1,v_source,now())
  on conflict(user_id,target_scope,projection_key) do update set
    invalidation_revision=clued_private.projection_invalidation_heads.invalidation_revision+1,
    latest_source_ref=excluded.latest_source_ref,
    stale_since=coalesce(clued_private.projection_invalidation_heads.stale_since,now()),
    updated_at=now();
  return clued_private.custom_priority_view_v1(p_record.user_id,p_record.id);
end $$;

-- Agent on the Owner's request: clued_mtpe_owner_pin operation
-- custom_priority_set {record_id, priority 0-100 (0 clears), base_version (the
-- record's custom priority version, 0 when it has none), owner_instruction
-- (the Owner's own words asking for it), idempotency_key, user_confirmed:
-- true}. The Binding needs write on the record's scope. A version conflict
-- returns the current value.
create function clued_private.custom_priority_agent_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare pre public.clued_agent_bindings%rowtype; b public.clued_agent_bindings%rowtype;
  r public.clued_memories%rowtype; receipt public.clued_audit_receipts%rowtype;
  v_record_id uuid; v_priority integer; v_base bigint; v_instruction text; v_current jsonb;
  v_refs jsonb; v_event_id text; v_result jsonb; v_error text; v_state text;
begin
  if jsonb_typeof(p_input) is distinct from 'object'
    or coalesce(p_input->>'record_id','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    raise exception 'invalid_custom_priority_request' using errcode='22023';
  end if;
  v_record_id:=(p_input->>'record_id')::uuid;
  select * into pre from public.clued_agent_bindings where token_hash=clued_private.credential_verifier_v1(p_token_hash);
  if not found then raise exception 'binding_not_authorized' using errcode='42501'; end if;
  select * into r from public.clued_memories
    where id=v_record_id and user_id=pre.user_id and record_schema_version=1;
  if not found then raise exception 'record_not_found' using errcode='P0002'; end if;
  b:=clued_private.resolve_binding_action_v12(p_token_hash,'context:write',r.canonical_scope,'write');
  receipt:=clued_private.m1_begin_receipt(b.user_id,b.id,'custom_priority_set',p_input,
    clued_private.m1_sha256(p_input));
  if receipt.status<>'pending' then
    return coalesce(receipt.canonical_result,clued_private.m1_result_envelope(receipt))
      ||jsonb_build_object('replayed',receipt.related_receipt_id is null);
  end if;
  v_refs:=jsonb_build_array(jsonb_build_object('role','primary','kind','record','id',r.id));
  begin
    -- The tool also lists the Pin's reason and expected_current_focus_id, and
    -- some Hosts add _meta: accepted and unused (a focus id must be null).
    if exists(select 1 from jsonb_object_keys(p_input) k where k not in ('operation','record_id','priority',
        'base_version','owner_instruction','idempotency_key','user_confirmed','request_hash',
        'reason','expected_current_focus_id','_meta'))
      or coalesce(p_input->'expected_current_focus_id','null'::jsonb)<>'null'::jsonb
      or jsonb_typeof(p_input->'priority') is distinct from 'number' or (p_input->>'priority') !~ '^(0|[1-9][0-9]?|100)$'
      or jsonb_typeof(p_input->'base_version') is distinct from 'number' or (p_input->>'base_version') !~ '^[0-9]{1,18}$'
      or jsonb_typeof(p_input->'owner_instruction') is distinct from 'string'
      or char_length(btrim(p_input->>'owner_instruction')) not between 1 and 2000
      or p_input->'user_confirmed' is distinct from 'true'::jsonb then
      raise exception 'invalid_custom_priority_request' using errcode='22023';
    end if;
    v_priority:=(p_input->>'priority')::integer;
    v_base:=(p_input->>'base_version')::bigint;
    v_instruction:=btrim(p_input->>'owner_instruction');
    perform clued_private.currentness_user_lock(b.user_id);
    select * into r from public.clued_memories
      where id=v_record_id and user_id=b.user_id and record_schema_version=1 for update;
    if not found then raise exception 'record_not_found' using errcode='P0002'; end if;
    -- A closed record keeps no custom priority it cannot shed: 0 is always allowed.
    if r.lifecycle_status<>'active' and v_priority<>0 then
      raise exception 'custom_priority_record_not_active' using errcode='22023'; end if;
    v_current:=clued_private.custom_priority_view_v1(b.user_id,r.id);
    if (v_current->>'version')::bigint<>v_base then
      raise exception 'custom_priority_version_conflict' using errcode='40001';
    end if;
    update public.clued_audit_receipts set metadata=jsonb_build_object('receipt_kind','CUSTOM_PRIORITY_SET',
      'record_id',r.id,'priority',v_priority,'previous_priority',(v_current->>'priority')::integer,
      'base_version',v_base,'changed',(v_current->>'priority')::integer<>v_priority,
      'custom_priority_version',v_base+case when (v_current->>'priority')::integer<>v_priority then 1 else 0 end,
      'source','agent_on_owner_request','owner_instruction',v_instruction,'principal','binding')
    where id=receipt.id;
    if (v_current->>'priority')::integer<>v_priority then
      v_current:=clued_private.custom_priority_apply_v1(r,v_priority,'agent_on_owner_request',v_instruction,
        b.id,null,receipt.id,null);
      v_event_id:=clued_private.m1_append_event_row(b.user_id,b.id,receipt.id,
        receipt.canonical_version,'extension:mtpe:custom_priority',v_refs,r.canonical_scope,null,
        jsonb_build_array('custom_priority_set'),p_input->>'idempotency_key',
        receipt.request_sha256,'success','work_log','{}','[]',null);
    end if;
    v_result:=clued_private.m1_finish_receipt(receipt.id,'committed',v_refs,
      jsonb_build_object(r.id::text,r.version),jsonb_build_object(r.id::text,r.version),
      case when v_event_id is null then '{}'::text[] else array[v_event_id] end,'{}',null);
    return v_result||jsonb_build_object('replayed',false,'changed',v_event_id is not null,
      'supplemental',jsonb_build_object('custom_priority',v_current));
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    v_result:=clued_private.m1_finish_receipt(receipt.id,
      case when v_state in ('22023','40001','42501','P0002') then 'rejected' else 'failed' end,
      v_refs,jsonb_build_object(r.id::text,r.version),'{}','{}','{}',v_error);
    if v_error='custom_priority_version_conflict' then
      return v_result||jsonb_build_object('replayed',false,'supplemental',
        jsonb_build_object('custom_priority',clued_private.custom_priority_view_v1(b.user_id,r.id)));
    end if;
    return v_result||jsonb_build_object('replayed',false);
  end;
end $$;

select clued_private.priority_custom_patch_v1('public.clued_mcp_mtpe_owner_pin(text,jsonb)',
$a$  begin v_record_id:=(p_input->>'record_id')::uuid;$a$,
$r$  -- 20261031070000: the Owner's custom priority, set on the Owner's request.
  if v_operation='custom_priority_set' then
    return clued_private.custom_priority_agent_v1(p_token_hash,p_input);
  end if;
  begin v_record_id:=(p_input->>'record_id')::uuid;$r$);

-- The Owner on /priority. Same rules as the Agent messages switch: the signed-in
-- account session only, a native session id, base_version CAS.
create function clued_private.custom_priority_native_input_v1(p_input jsonb,p_with_priority boolean) returns void
language plpgsql immutable set search_path='' as $$
begin
  if jsonb_typeof(p_input) is distinct from 'object'
    or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('record_id','priority','base_version'))
    or (p_input ? 'priority') is distinct from p_with_priority
    or coalesce(p_input->>'record_id','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    or jsonb_typeof(p_input->'base_version') is distinct from 'number' or (p_input->>'base_version') !~ '^[0-9]{1,18}$'
    or (p_with_priority and (jsonb_typeof(p_input->'priority') is distinct from 'number'
      or (p_input->>'priority') !~ '^(0|[1-9][0-9]?|100)$')) then
    raise exception 'custom_priority_input_invalid' using errcode='22023';
  end if;
end $$;

-- clued_priority_custom_set_v1: {record_id, priority 0-100, base_version} ->
--   {status: committed, changed, custom_priority} or {status: rejected,
--   error_code: custom_priority_version_conflict, current}.
create function public.clued_priority_custom_set_v1(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_session text:=clued_private.native_session_id_v1();
  r public.clued_memories%rowtype; v_current jsonb; v_priority integer; v_receipt uuid;
begin
  perform clued_private.custom_priority_native_input_v1(p_input,true);
  if v_session is null then raise exception 'custom_priority_session_required' using errcode='42501'; end if;
  v_priority:=(p_input->>'priority')::integer;
  perform clued_private.currentness_user_lock(v_owner);
  select * into r from public.clued_memories where id=(p_input->>'record_id')::uuid and user_id=v_owner
    and record_schema_version=1 for update;
  if not found then raise exception 'custom_priority_record_not_found' using errcode='22023'; end if;
  if r.lifecycle_status<>'active' and v_priority<>0 then
    raise exception 'custom_priority_record_not_active' using errcode='22023'; end if;
  v_current:=clued_private.custom_priority_view_v1(v_owner,r.id);
  if (v_current->>'version')::bigint<>(p_input->>'base_version')::bigint then
    return jsonb_build_object('status','rejected','error_code','custom_priority_version_conflict',
      'authoritative',false,'current',v_current);
  end if;
  if (v_current->>'priority')::integer=v_priority then
    return jsonb_build_object('status','committed','changed',false,'custom_priority',v_current);
  end if;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(v_owner,null,r.canonical_scope,'custom_priority_set','record_custom_priority',r.id::text,
    (v_current->>'version')::bigint+1,jsonb_build_object('receipt_kind','CUSTOM_PRIORITY_SET','record_id',r.id,
      'priority',v_priority,'previous_priority',(v_current->>'priority')::integer,
      'base_version',(p_input->>'base_version')::bigint,'session_id',v_session,'principal','native_account_session'))
  returning id into v_receipt;
  v_current:=clued_private.custom_priority_apply_v1(r,v_priority,'owner_page',null,null,v_session,v_receipt,null);
  return jsonb_build_object('status','committed','changed',true,'custom_priority',v_current);
end $$;

-- clued_priority_custom_undo_v1: {record_id, base_version} -> undoes the
--   latest change of that record (whoever made it): the value goes back to
--   what it was before. Undoing an undo restores the undone change.
create function public.clued_priority_custom_undo_v1(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_session text:=clued_private.native_session_id_v1();
  r public.clued_memories%rowtype; v_current jsonb; v_last clued_private.record_custom_priority_history_v1%rowtype;
  v_receipt uuid;
begin
  perform clued_private.custom_priority_native_input_v1(p_input,false);
  if v_session is null then raise exception 'custom_priority_session_required' using errcode='42501'; end if;
  perform clued_private.currentness_user_lock(v_owner);
  select * into r from public.clued_memories where id=(p_input->>'record_id')::uuid and user_id=v_owner
    and record_schema_version=1 for update;
  if not found then raise exception 'custom_priority_record_not_found' using errcode='22023'; end if;
  v_current:=clued_private.custom_priority_view_v1(v_owner,r.id);
  if (v_current->>'version')::bigint<>(p_input->>'base_version')::bigint then
    return jsonb_build_object('status','rejected','error_code','custom_priority_version_conflict',
      'authoritative',false,'current',v_current);
  end if;
  select * into v_last from clued_private.record_custom_priority_history_v1 h
    where h.record_id=r.id and h.user_id=v_owner and h.version=(v_current->>'version')::bigint;
  if not found then
    return jsonb_build_object('status','rejected','error_code','custom_priority_nothing_to_undo',
      'authoritative',false,'current',v_current);
  end if;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(v_owner,null,r.canonical_scope,'custom_priority_set','record_custom_priority',r.id::text,
    v_last.version+1,jsonb_build_object('receipt_kind','CUSTOM_PRIORITY_UNDONE','record_id',r.id,
      'priority',v_last.previous_priority,'previous_priority',v_last.priority,'undo_of',v_last.id,
      'undone_source',v_last.source,'undone_receipt_id',v_last.receipt_id,
      'base_version',(p_input->>'base_version')::bigint,'session_id',v_session,'principal','native_account_session'))
  returning id into v_receipt;
  v_current:=clued_private.custom_priority_apply_v1(r,v_last.previous_priority,'owner_undo',null,null,
    v_session,v_receipt,v_last.id);
  return jsonb_build_object('status','committed','changed',true,'custom_priority',v_current);
end $$;

-- clued_priority_overview_v1: {} -> the Owner's page. records: active Tasks and
-- every active record with a custom priority, highest automatic total first;
-- history: the latest 50 changes. VOLATILE although it only reads, like the
-- switch: PostgREST runs a STABLE RPC read-only and the owner check locks.
create function public.clued_priority_overview_v1(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_records jsonb; v_history jsonb; v_count bigint;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_input)) then
    raise exception 'custom_priority_input_invalid' using errcode='22023';
  end if;
  -- Active Tasks, and every record (closed ones too, so it can be cleared)
  -- that holds a custom priority.
  select count(*) into v_count from public.clued_memories m
    where m.user_id=v_owner and m.record_schema_version=1
      and ((m.record_type='task' and m.lifecycle_status='active') or exists(select 1
        from clued_private.record_custom_priority_v1 c where c.record_id=m.id and c.priority>0));
  select coalesce(jsonb_agg(row_data order by total desc nulls last,updated_at desc,record_id),'[]'::jsonb)
    into v_records from (
      select m.id as record_id,m.updated_at,p.algorithm_priority as total,
        jsonb_build_object('record_id',m.id,'title',m.title,'record_type',m.record_type,
          'lifecycle_status',m.lifecycle_status,
          'scope',m.canonical_scope,'project_name',pr.name,'execution_bucket',m.type_fields->>'execution_bucket',
          'updated_at',m.updated_at,
          'legacy_priority',(select l.column_priority from clued_private.record_priority_legacy_v1 l
            where l.record_id=m.id and l.user_id=m.user_id),
          'automatic',case when p.record_id is null then null else jsonb_build_object(
            'total',p.algorithm_priority,'band',p.priority_band,
            'custom_points',coalesce((p.priority_inputs->>'explicit_priority_signal')::integer,0),
            'candidate_status',p.candidate_status) end,
          'custom',clued_private.custom_priority_view_v1(v_owner,m.id)) as row_data
      from public.clued_memories m
      left join clued_private.mtpe_intake_projection p on p.user_id=m.user_id and p.record_id=m.id
      left join public.clued_projects pr on pr.id=m.project_id and pr.user_id=m.user_id
      where m.user_id=v_owner and m.record_schema_version=1
        and ((m.record_type='task' and m.lifecycle_status='active') or exists(select 1
          from clued_private.record_custom_priority_v1 c where c.record_id=m.id and c.priority>0))
      order by p.algorithm_priority desc nulls last,m.updated_at desc,m.id limit 300) t;
  select coalesce(jsonb_agg(jsonb_build_object('id',h.id,'record_id',h.record_id,'title',m.title,
      'priority',h.priority,'previous_priority',h.previous_priority,'source',h.source,
      'owner_instruction',h.owner_instruction,
      'agent_name',(select b.agent_name from public.clued_agent_bindings b where b.id=h.binding_id and b.user_id=h.user_id),
      'undo_of',h.undo_of,'receipt_id',h.receipt_id,'created_at',h.created_at) order by h.id desc),'[]'::jsonb)
    into v_history from (select * from clued_private.record_custom_priority_history_v1 x
      where x.user_id=v_owner order by x.id desc limit 50) h
    join public.clued_memories m on m.id=h.record_id;
  return jsonb_build_object('status','ok','weight',0.3,'records',v_records,'total_records',v_count,
    'history',v_history);
end $$;

revoke all on function clued_private.custom_priority_view_v1(uuid,uuid),
  clued_private.custom_priority_apply_v1(public.clued_memories,integer,text,text,uuid,text,uuid,bigint),
  clued_private.custom_priority_agent_v1(text,jsonb),
  clued_private.custom_priority_native_input_v1(jsonb,boolean)
  from public,anon,authenticated,service_role;
revoke all on function public.clued_priority_custom_set_v1(jsonb),public.clued_priority_custom_undo_v1(jsonb),
  public.clued_priority_overview_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_priority_custom_set_v1(jsonb),public.clued_priority_custom_undo_v1(jsonb),
  public.clued_priority_overview_v1(jsonb) to authenticated;

-- 6. MTPE reads the custom priority --------------------------------------------

select clued_private.priority_custom_patch_v1('clued_private.mtpe_sync_record(uuid)',
$a$  v_explicit:=least(15,greatest(0,clued_private.mtpe_int(
    r.type_fields->>'priority',coalesce(r.priority,0),0,100)/7));$a$,
$r$  -- 20261031070000: the Owner's custom priority (the column, written only by
  -- the custom priority channel), weight 0.3.
  v_explicit:=(greatest(0,least(100,coalesce(r.priority,0)))*3+5)/10;$r$);
select clued_private.priority_custom_patch_v1('clued_private.mtpe_sync_record(uuid)',
$a$    'resource_cost',v_cost,'explicit_priority_signal',v_explicit,$a$,
$r$    'resource_cost',v_cost,'explicit_priority_signal',v_explicit,
    'explicit_priority_rule','owner-custom-priority.v1','owner_custom_priority',coalesce(r.priority,0),$r$);

drop function clued_private.priority_custom_patch_v1(regprocedure,text,text);

do $$
declare r record; v_user uuid; v_suite jsonb;
begin
  for r in select id from public.clued_memories where record_schema_version is not null loop
    perform clued_private.mtpe_sync_record(r.id);
  end loop;
  for v_user in select distinct user_id from clued_private.mtpe_intake_projection loop
    v_suite:=clued_private.mtpe_frontier_regression_suite(v_user);
    if v_suite->>'status'<>'pass' then
      raise exception 'mtpe_frontier_regression_failed %',v_suite;
    end if;
    insert into clued_private.projection_invalidation_heads(user_id,target_scope,
      projection_key,invalidation_revision,latest_source_ref,stale_since)
    values(v_user,'global','global.priority_frontier',1,
        jsonb_build_object('kind','mtpe_rule_change','id','owner-custom-priority.v1'),now()),
      (v_user,'global','global.__aggregate__',1,
        jsonb_build_object('kind','mtpe_rule_change','id','owner-custom-priority.v1'),now())
    on conflict(user_id,target_scope,projection_key) do update set
      invalidation_revision=clued_private.projection_invalidation_heads.invalidation_revision+1,
      latest_source_ref=excluded.latest_source_ref,
      stale_since=coalesce(clued_private.projection_invalidation_heads.stale_since,now()),
      updated_at=now();
  end loop;
end $$;

notify pgrst,'reload schema';
