-- Forward-only response repair: return the verified original receipt on replay.
-- Existing rows, receipt identities, authorization, namespaces and grants stay intact.
create or replace function public.clued_mcp_commit_checkpoint(p_token_hash text, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_binding public.clued_agent_bindings%rowtype;
  v_session public.clued_continuity_sessions%rowtype;
  v_context_key text := coalesce(nullif(pg_catalog.btrim(p_input->>'context_key'), ''), 'global');
  v_base_version bigint;
  v_current_version bigint;
  v_new_version bigint;
  v_snapshot jsonb := p_input->'snapshot';
  v_summary text := pg_catalog.btrim(coalesce(p_input->>'summary',''));
  v_next_action text := pg_catalog.btrim(coalesce(p_input->>'next_action',''));
  v_idempotency_key text := nullif(pg_catalog.btrim(p_input->>'idempotency_key'), '');
  v_previous_id uuid;
  v_checkpoint_id uuid;
  v_last_event_id bigint := 0;
  v_receipt_id uuid;
  v_existing public.clued_context_checkpoints%rowtype;
  v_original_base bigint;
  v_original_receipt_count bigint;
begin
  v_binding := clued_private.resolve_binding(p_token_hash, 'context:write', v_context_key);
  v_session := clued_private.resolve_session(
    v_binding.user_id, v_binding.id, v_context_key, p_input->>'session_token'
  );
  if not (p_input ? 'base_version') then raise exception 'base_version_required'; end if;
  v_base_version := (p_input->>'base_version')::bigint;
  if v_base_version is null or v_base_version < 0 then
    raise exception 'invalid_base_version' using errcode='22023';
  end if;
  if v_snapshot is null or jsonb_typeof(v_snapshot) <> 'object' then raise exception 'snapshot_must_be_object'; end if;
  if char_length(v_summary) not between 1 and 4000 then raise exception 'invalid_summary_length'; end if;
  if char_length(v_next_action) not between 1 and 1000 then raise exception 'invalid_next_action_length'; end if;
  if v_idempotency_key is not null and char_length(v_idempotency_key) not between 8 and 160 then
    raise exception 'invalid_idempotency_key';
  end if;
  if v_idempotency_key is not null then
    -- Serialize one existing (owner, binding, key) namespace, including requests
    -- for different contexts. A hash collision only serializes unrelated keys.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'clued-checkpoint:'||v_binding.user_id::text||':'||v_binding.id::text||':'||v_idempotency_key,0));
    select c.* into v_existing
      from public.clued_context_checkpoints c
     where c.user_id=v_binding.user_id and c.binding_id=v_binding.id
       and c.idempotency_key=v_idempotency_key;
    if found then
      -- The old function could accept a null base, so version-1 is not evidence
      -- of the original request. Bind replay to its immutable original receipt.
      select count(*),min((r.metadata->>'base_version')::bigint),(array_agg(r.id))[1]
        into v_original_receipt_count,v_original_base,v_receipt_id
        from public.clued_audit_receipts r
       where r.user_id=v_binding.user_id and r.binding_id=v_binding.id
         and r.operation='checkpoint' and r.object_id=v_existing.id::text
         and r.version=v_existing.version;
      -- Compare persisted effective fields, including the original base version.
      -- A fresh session token is allowed; it is authentication, not payload.
      if v_original_receipt_count<>1 or v_original_base is null
        or v_existing.context_key is distinct from v_context_key
        or v_original_base is distinct from v_base_version
        or v_existing.snapshot is distinct from v_snapshot
        or v_existing.summary is distinct from v_summary
        or v_existing.next_action is distinct from v_next_action then
        return jsonb_build_object('status','conflict','error','idempotency_key_conflict','context_key',v_context_key);
      end if;
      return jsonb_build_object('status','duplicate','checkpoint_id',v_existing.id,
        'version',v_existing.version,'context_key',v_existing.context_key,'receipt_id',v_receipt_id);
    end if;
  end if;

  select s.version into v_current_version
    from public.clued_context_streams s
   where s.user_id=v_binding.user_id and s.context_key=v_context_key
   for update;
  if not found then raise exception 'resume_required'; end if;
  if v_base_version <> v_current_version then
    return jsonb_build_object('status','conflict','error','stale_base_version',
      'expected_version',v_current_version,'provided_version',v_base_version,'context_key',v_context_key);
  end if;
  v_new_version := v_current_version + 1;
  select h.checkpoint_id into v_previous_id from public.clued_context_heads h
   where h.user_id=v_binding.user_id and h.context_key=v_context_key;
  select coalesce(max(e.id),0) into v_last_event_id from public.clued_context_events e
   where e.user_id=v_binding.user_id and e.context_key=v_context_key;
  insert into public.clued_context_checkpoints(
    user_id,binding_id,context_key,version,snapshot,summary,next_action,last_event_id,
    previous_checkpoint_id,session_id,idempotency_key
  ) values (
    v_binding.user_id,v_binding.id,v_context_key,v_new_version,v_snapshot,v_summary,v_next_action,
    v_last_event_id,v_previous_id,v_session.id,v_idempotency_key
  ) returning id into v_checkpoint_id;
  insert into public.clued_context_heads(user_id,context_key,checkpoint_id,version,updated_at)
  values(v_binding.user_id,v_context_key,v_checkpoint_id,v_new_version,now())
  on conflict(user_id,context_key) do update set checkpoint_id=excluded.checkpoint_id,
    version=excluded.version,updated_at=excluded.updated_at;
  update public.clued_context_streams set version=v_new_version,updated_at=now()
   where user_id=v_binding.user_id and context_key=v_context_key;
  update public.clued_continuity_sessions set last_seen_at=now(),ended_at=now() where id=v_session.id;
  insert into public.clued_audit_receipts(
    user_id,binding_id,context_key,operation,object_type,object_id,version,metadata
  ) values (
    v_binding.user_id,v_binding.id,v_context_key,'checkpoint','checkpoint',v_checkpoint_id::text,
    v_new_version,jsonb_build_object('base_version',v_base_version,'last_event_id',v_last_event_id,'session_id',v_session.id)
  ) returning id into v_receipt_id;
  return jsonb_build_object('status','committed','context_key',v_context_key,'version',v_new_version,
    'checkpoint_id',v_checkpoint_id,'receipt_id',v_receipt_id,'last_event_id',v_last_event_id,
    'work_log',clued_private.render_log(v_binding.user_id,v_context_key));
end;
$$;
