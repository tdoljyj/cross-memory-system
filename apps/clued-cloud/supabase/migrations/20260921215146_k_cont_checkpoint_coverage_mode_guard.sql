-- Reject a missing or JSON-null coverage mode before any checkpoint writes.
-- Keep already-applied K-CONT migrations immutable; this is a forward-only guard.
create or replace function public.clued_mcp_commit_checkpoint(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_binding public.clued_agent_bindings%rowtype; v_session public.clued_continuity_sessions%rowtype;
  v_context_key text:=coalesce(nullif(btrim(p_input->>'context_key'),''),'global');
  v_base_version bigint; v_current_version bigint; v_new_version bigint;
  v_snapshot jsonb:=p_input->'snapshot'; v_summary text:=btrim(coalesce(p_input->>'summary',''));
  v_next_action text:=btrim(coalesce(p_input->>'next_action',''));
  v_idempotency_key text:=nullif(btrim(p_input->>'idempotency_key'),'');
  v_coverage jsonb:=p_input->'coverage'; v_event_ids bigint[]:='{}';
  v_previous_id uuid; v_checkpoint_id uuid; v_receipt_id uuid;
  v_last_event_id bigint:=0; v_legacy_boundary bigint:=0; v_pending_after bigint:=0;
  v_existing public.clued_context_checkpoints%rowtype; v_original_base bigint; v_original_receipt_count bigint;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',v_context_key);
  v_session:=clued_private.resolve_session(v_binding.user_id,v_binding.id,v_context_key,p_input->>'session_token');
  if not (p_input?'base_version') then raise exception 'base_version_required' using errcode='22023'; end if;
  v_base_version:=(p_input->>'base_version')::bigint;
  if v_base_version is null or v_base_version<0 then raise exception 'invalid_base_version' using errcode='22023'; end if;
  if v_snapshot is null or jsonb_typeof(v_snapshot)<>'object' then raise exception 'snapshot_must_be_object' using errcode='22023'; end if;
  if char_length(v_summary) not between 1 and 4000 then raise exception 'invalid_summary_length' using errcode='22023'; end if;
  if char_length(v_next_action) not between 1 and 1000 then raise exception 'invalid_next_action_length' using errcode='22023'; end if;
  if v_coverage is null or coalesce(jsonb_typeof(v_coverage),'')<>'object' or (v_coverage->>'mode') is distinct from 'explicit'
    or coalesce(jsonb_typeof(v_coverage->'contexts'),'')<>'array'
    or coalesce(jsonb_typeof(v_coverage->'tracks'),'')<>'array'
    or coalesce(jsonb_typeof(v_coverage->'event_ids'),'')<>'array' then
    raise exception 'checkpoint_coverage_required' using errcode='22023';
  end if;
  if jsonb_array_length(v_coverage->'contexts')<>1
    or v_coverage->'contexts'<>jsonb_build_array(v_context_key) then
    raise exception 'checkpoint_context_not_covered' using errcode='22023';
  end if;
  if jsonb_array_length(v_coverage->'tracks')<1 then raise exception 'checkpoint_tracks_required' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements_text(v_coverage->'tracks') t(value)
    where char_length(btrim(value)) not between 1 and 80) then raise exception 'invalid_checkpoint_track' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements_text(v_coverage->'event_ids') t(value)
    where value!~'^[0-9]+$') then raise exception 'invalid_checkpoint_event_id' using errcode='22023'; end if;
  select coalesce(array_agg(value::bigint order by value::bigint),'{}') into v_event_ids
    from jsonb_array_elements_text(v_coverage->'event_ids') t(value);
  if cardinality(v_event_ids)<>cardinality(array(select distinct covered.event_id from unnest(v_event_ids) as covered(event_id))) then
    raise exception 'duplicate_checkpoint_event_id' using errcode='22023';
  end if;
  if v_idempotency_key is not null and char_length(v_idempotency_key) not between 8 and 160 then raise exception 'invalid_idempotency_key' using errcode='22023'; end if;
  if v_idempotency_key is not null then
    perform pg_advisory_xact_lock(hashtextextended('clued-checkpoint:'||v_binding.user_id::text||':'||v_binding.id::text||':'||v_idempotency_key,0));
    select c.* into v_existing from public.clued_context_checkpoints c
      where c.user_id=v_binding.user_id and c.binding_id=v_binding.id and c.idempotency_key=v_idempotency_key;
    if found then
      select count(*),min((r.metadata->>'base_version')::bigint),(array_agg(r.id))[1]
        into v_original_receipt_count,v_original_base,v_receipt_id from public.clued_audit_receipts r
       where r.user_id=v_binding.user_id and r.binding_id=v_binding.id and r.operation='checkpoint'
         and r.object_id=v_existing.id::text and r.version=v_existing.version;
      if v_original_receipt_count<>1 or v_original_base is null or v_existing.context_key is distinct from v_context_key
        or v_original_base is distinct from v_base_version or v_existing.snapshot is distinct from v_snapshot
        or v_existing.summary is distinct from v_summary or v_existing.next_action is distinct from v_next_action
        or v_existing.checkpoint_coverage is distinct from v_coverage then
        return jsonb_build_object('status','conflict','error','idempotency_key_conflict','context_key',v_context_key);
      end if;
      return jsonb_build_object('status','duplicate','checkpoint_id',v_existing.id,'version',v_existing.version,
        'context_key',v_existing.context_key,'receipt_id',v_receipt_id,'checkpoint_coverage',v_existing.checkpoint_coverage);
    end if;
  end if;
  select s.version into v_current_version from public.clued_context_streams s
    where s.user_id=v_binding.user_id and s.context_key=v_context_key for update;
  if not found then raise exception 'resume_required' using errcode='42501'; end if;
  if v_base_version<>v_current_version then return jsonb_build_object('status','conflict','error','stale_base_version',
    'expected_version',v_current_version,'provided_version',v_base_version,'context_key',v_context_key); end if;
  select h.checkpoint_id,c.legacy_absorbed_through_event_id into v_previous_id,v_legacy_boundary
    from public.clued_context_heads h join public.clued_context_checkpoints c on c.id=h.checkpoint_id
   where h.user_id=v_binding.user_id and h.context_key=v_context_key;
  v_legacy_boundary:=coalesce(v_legacy_boundary,0);
  if exists(select 1 from unnest(v_event_ids) as covered(event_id) where not exists(
    select 1 from public.clued_context_events e where e.id=covered.event_id and e.user_id=v_binding.user_id
      and e.context_key=v_context_key and e.id>v_legacy_boundary)) then
    raise exception 'checkpoint_event_not_authorized' using errcode='42501';
  end if;
  if exists(select 1 from unnest(v_event_ids) as covered(event_id) join public.clued_checkpoint_event_absorptions a
    on a.user_id=v_binding.user_id and a.context_key=v_context_key and a.event_id=covered.event_id) then
    raise exception 'checkpoint_event_already_absorbed' using errcode='22023';
  end if;
  v_new_version:=v_current_version+1;
  select coalesce(max(e.id),v_legacy_boundary) into v_last_event_id from public.clued_context_events e
    where e.user_id=v_binding.user_id and e.context_key=v_context_key and e.id=any(v_event_ids);
  insert into public.clued_context_checkpoints(user_id,binding_id,context_key,version,snapshot,summary,next_action,last_event_id,
    previous_checkpoint_id,session_id,idempotency_key,checkpoint_coverage,legacy_absorbed_through_event_id)
  values(v_binding.user_id,v_binding.id,v_context_key,v_new_version,v_snapshot,v_summary,v_next_action,v_last_event_id,
    v_previous_id,v_session.id,v_idempotency_key,v_coverage,v_legacy_boundary) returning id into v_checkpoint_id;
  insert into public.clued_checkpoint_event_absorptions(user_id,context_key,checkpoint_id,event_id)
    select v_binding.user_id,v_context_key,v_checkpoint_id,covered.event_id from unnest(v_event_ids) as covered(event_id);
  insert into public.clued_context_heads(user_id,context_key,checkpoint_id,version,updated_at)
    values(v_binding.user_id,v_context_key,v_checkpoint_id,v_new_version,now())
    on conflict(user_id,context_key) do update set checkpoint_id=excluded.checkpoint_id,version=excluded.version,updated_at=excluded.updated_at;
  update public.clued_context_streams set version=v_new_version,updated_at=now()
    where user_id=v_binding.user_id and context_key=v_context_key;
  update public.clued_continuity_sessions set last_seen_at=now(),ended_at=now() where id=v_session.id;
  select count(*) into v_pending_after from public.clued_context_events e
    where e.user_id=v_binding.user_id and e.context_key=v_context_key and e.id>v_legacy_boundary
      and not exists(select 1 from public.clued_checkpoint_event_absorptions a
        where a.user_id=e.user_id and a.context_key=e.context_key and a.event_id=e.id);
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(v_binding.user_id,v_binding.id,v_context_key,'checkpoint','checkpoint',v_checkpoint_id::text,v_new_version,
    jsonb_build_object('base_version',v_base_version,'last_event_id',v_last_event_id,'session_id',v_session.id,
      'checkpoint_coverage',v_coverage,'absorbed_event_count',cardinality(v_event_ids),'pending_event_count_after',v_pending_after))
  returning id into v_receipt_id;
  return jsonb_build_object('status','committed','context_key',v_context_key,'version',v_new_version,
    'checkpoint_id',v_checkpoint_id,'receipt_id',v_receipt_id,'last_event_id',v_last_event_id,
    'checkpoint_coverage',v_coverage,'absorbed_event_count',cardinality(v_event_ids),
    'pending_event_count_after',v_pending_after);
end $$;

notify pgrst,'reload schema';
