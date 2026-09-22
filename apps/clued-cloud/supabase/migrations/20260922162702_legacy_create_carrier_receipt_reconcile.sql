-- Reconcile only legacy create notifications with an exact, immutable record
-- and receipt lineage. This does not classify an arbitrary work Event as old,
-- and it never edits the business Record or the source Event.
create or replace function clued_private.reconcile_legacy_create_notifications_v1(
  p_user_id uuid,
  p_scope text,
  p_expected_count integer default null,
  p_expected_digest text default null,
  p_execute boolean default false
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_event_id bigint;
  v_carrier clued_private.event_truth_carriers%rowtype;
  v_event public.clued_context_events%rowtype;
  v_record public.clued_memories%rowtype;
  v_create public.clued_audit_receipts%rowtype;
  v_current public.clued_audit_receipts%rowtype;
  v_count integer := 0;
  v_proof_ids uuid[];
  v_step_count integer;
  v_step bigint;
  v_manifest jsonb := '[]'::jsonb;
  v_digest text;
  v_chain jsonb;
  v_proof_id uuid;
  v_transition_id uuid;
  v_batch_id uuid;
  v_previous public.clued_audit_receipts%rowtype;
  v_original jsonb;
  v_item jsonb;
begin
  if p_execute is null then
    raise exception 'legacy_create_execute_flag_required' using errcode='22023';
  end if;
  if p_user_id is null or p_scope is null or
    (p_scope <> 'global' and not exists (
      select 1 from public.clued_projects p
      where p.user_id=p_user_id and p_scope='project:'||p.id::text
    )) then
    raise exception 'legacy_create_scope_invalid' using errcode='22023';
  end if;
  if p_execute and (p_expected_count is null or p_expected_count < 1 or
    coalesce(p_expected_digest,'') !~ '^[0-9a-f]{64}$') then
    raise exception 'legacy_create_expected_manifest_required' using errcode='22023';
  end if;
  perform clued_private.currentness_user_lock(p_user_id);
  if p_execute then
    select * into v_previous from public.clued_audit_receipts r
    where r.user_id=p_user_id and r.context_key=p_scope
      and r.operation='legacy_create_carrier_reconcile'
      and r.metadata->>'manifest_digest'=p_expected_digest
      and (r.metadata->>'count')::integer=p_expected_count
      and r.metadata->>'status'='committed'
    order by r.created_at desc limit 1;
    if found then
      return jsonb_build_object('status','duplicate','receipt_id',v_previous.id,
        'count',p_expected_count,'manifest_digest',p_expected_digest,
        'currentness_claim',false);
    end if;
  end if;
  for v_event_id in
    select c.event_id from clued_private.event_truth_carriers c
      join public.clued_context_events e on e.id=c.event_id and e.user_id=c.user_id
    where c.user_id=p_user_id and c.canonical_scope=p_scope
      and c.carrier_state='ACTIVE_UNSTRUCTURED' and c.visibility='work_log'
      and e.record_id is not null
    order by c.event_id
  loop
    select * into v_carrier from clued_private.event_truth_carriers
      where event_id=v_event_id for update;
    select * into v_event from public.clued_context_events
      where id=v_event_id and user_id=p_user_id;
    select * into v_record from public.clued_memories
      where id=v_event.record_id and user_id=p_user_id for update;
    if not found or v_carrier.user_id<>p_user_id or
      v_carrier.canonical_scope<>p_scope or
      v_carrier.carrier_state<>'ACTIVE_UNSTRUCTURED' or
      v_carrier.visibility<>'work_log' or v_carrier.source_kind<>'legacy' or
      v_carrier.dimensions is distinct from array['state','task']::text[] or
      v_carrier.event_version is not null or v_event.version is not null or
      v_event.event_schema_version is not null or
      v_event.canonical_event_type is not null or
      v_event.event_scope is not null or v_event.target_refs is not null or
      v_event.change_summary is not null or v_event.event_type<>'action' or
      coalesce(v_event.audit_visibility,'work_log')<>'work_log' or
      v_event.context_key<>p_scope or v_event.record_version<>1 or
      v_event.payload is distinct from jsonb_build_object(
        'action','create','record_type',v_record.record_type) or
      v_event.record_id<>v_record.id then
      raise exception 'legacy_create_source_not_exact event=%',v_event_id using errcode='40001';
    end if;
    select array_agg(r.id) into v_proof_ids from public.clued_audit_receipts r
      where r.user_id=p_user_id and r.context_key=p_scope and
        r.binding_id is not distinct from v_event.binding_id and
        r.operation='create' and
        r.object_type='record' and r.object_id=v_record.id::text and
        r.version=v_event.record_version and r.created_at=v_event.occurred_at and
        r.idempotency_key is not null and
        v_event.idempotency_key='record-event:'||r.idempotency_key and
        r.metadata->>'status'='committed' and
        r.metadata#>>'{result,status}'='written' and
        r.metadata#>>'{result,action}'='create' and
        r.metadata#>>'{result,event_id}'=v_event_id::text and
        r.metadata#>>'{result,receipt_id}'=r.id::text and
        r.metadata#>>'{result,record,id}'=v_record.id::text and
        r.metadata#>>'{result,record,user_id}'=p_user_id::text and
        r.metadata#>>'{result,record,version}'=v_event.record_version::text and
        r.metadata#>>'{result,record,record_type}'=v_record.record_type and
        r.metadata#>>'{result,record,scope}'=v_record.scope and
        (r.metadata#>>'{result,record,project_id}') is not distinct from
          v_record.project_id::text;
    if coalesce(array_length(v_proof_ids,1),0)<>1 then
      raise exception 'legacy_create_receipt_not_unique event=%',v_event_id using errcode='40001';
    end if;
    select * into v_create from public.clued_audit_receipts r
      where r.id=v_proof_ids[1];
    v_original:=v_create.metadata#>'{result,record}';
    if v_record.record_schema_version=1 then
      if v_record.canonical_scope<>p_scope or
        not exists (
          select 1 from public.clued_audit_receipts r
          where r.user_id=p_user_id and r.operation_family='legacy_record_mapping'
            and r.status='committed' and
            r.metadata->>'mapping_contract'='clued-v1.6-m1-current-legacy-v1' and
            r.base_versions->>v_record.id::text='1' and
            r.committed_versions->>v_record.id::text='2' and
            r.target_refs @> jsonb_build_array(jsonb_build_object(
              'kind','record','id',v_record.id))
        ) then
        raise exception 'legacy_create_mapping_missing event=%',v_event_id using errcode='40001';
      end if;
      for v_step in 2..v_record.version loop
        select count(*) into v_step_count from public.clued_audit_receipts r
          where r.user_id=p_user_id and r.status='committed' and
            r.base_versions->>v_record.id::text=(v_step-1)::text and
            r.committed_versions->>v_record.id::text=v_step::text and
            r.target_refs @> jsonb_build_array(jsonb_build_object(
              'kind','record','id',v_record.id));
        if v_step_count<>1 then
          raise exception 'legacy_create_version_chain_invalid event=% step=%',
            v_event_id,v_step using errcode='40001';
        end if;
      end loop;
      select * into v_current from public.clued_audit_receipts r
        where r.id=v_record.receipt_id and r.user_id=p_user_id and
          r.status='committed' and
          r.committed_versions->>v_record.id::text=v_record.version::text and
          r.target_refs @> jsonb_build_array(jsonb_build_object(
            'kind','record','id',v_record.id));
      if not found then
        raise exception 'legacy_create_current_receipt_invalid event=%',
          v_event_id using errcode='40001';
      end if;
      select jsonb_agg(jsonb_build_object('id',r.id,'hash',
        clued_private.currentness_hash(to_jsonb(r))) order by
        (r.committed_versions->>v_record.id::text)::bigint) into v_chain
        from public.clued_audit_receipts r
        where r.user_id=p_user_id and r.status='committed' and
          r.target_refs @> jsonb_build_array(jsonb_build_object(
            'kind','record','id',v_record.id)) and
          (r.committed_versions->>v_record.id::text)::bigint between 2 and v_record.version;
    elsif v_record.record_schema_version is null then
      if v_record.version<>v_event.record_version or
        v_record.status<>'archived' or
        (case when v_record.project_id is null then 'global'
          else 'project:'||v_record.project_id::text end)<>p_scope or
        exists(select 1 from jsonb_each(v_original) o
          where to_jsonb(v_record)->o.key is distinct from o.value) then
        raise exception 'legacy_create_terminal_record_changed event=%',
          v_event_id using errcode='40001';
      end if;
      v_chain:='[]'::jsonb;
    else
      raise exception 'legacy_create_record_schema_invalid event=%',v_event_id
        using errcode='40001';
    end if;
    v_manifest:=v_manifest||jsonb_build_array(jsonb_build_object(
      'event_id',v_event_id,'event_version',v_event.version,
      'event_hash',clued_private.currentness_hash(to_jsonb(v_event)),
      'carrier_transition_version',v_carrier.transition_version,
      'carrier_hash',clued_private.currentness_hash(to_jsonb(v_carrier)),
      'record_id',v_record.id,'record_version',v_record.version,
      'record_hash',clued_private.currentness_hash(to_jsonb(v_record)),
      'create_receipt_id',v_create.id,
      'create_receipt_hash',clued_private.currentness_hash(to_jsonb(v_create)),
      'chain',coalesce(v_chain,'[]'::jsonb)));
    v_count:=v_count+1;
  end loop;
  v_digest:=clued_private.currentness_hash(v_manifest);
  if not p_execute then
    return jsonb_build_object('status','dry_run','count',v_count,
      'manifest_digest',v_digest,'source_kind','legacy_create_notification',
      'currentness_claim',false);
  end if;
  if v_count is distinct from p_expected_count or
    v_digest is distinct from p_expected_digest then
    raise exception 'legacy_create_manifest_changed' using errcode='40001';
  end if;
  for v_item in select item from jsonb_array_elements(v_manifest) item
  loop
    v_event_id:=(v_item->>'event_id')::bigint;
    select * into v_carrier from clued_private.event_truth_carriers
      where event_id=v_event_id for update;
    insert into public.clued_audit_receipts(
      user_id,binding_id,context_key,operation,object_type,object_id,version,
      metadata,related_receipt_id)
    values(p_user_id,null,p_scope,'continuity_only_resolution_authorized',
      'event',v_event_id::text,v_carrier.transition_version,
      jsonb_build_object('proof','verified',
        'proof_contract','legacy-create-notification.v1',
        'manifest_digest',v_digest,'source_event_id',v_event_id,
        'source_manifest_entry',v_item,
        'transaction_id',txid_current()::text),
      (v_item->>'create_receipt_id')::uuid)
    returning id into v_proof_id;
    insert into public.clued_audit_receipts(
      user_id,binding_id,context_key,operation,operation_family,object_type,
      object_id,version,metadata,related_receipt_id)
    values(p_user_id,null,p_scope,'carrier_transition',
      'event_carrier_transition','event',v_event_id::text,
      v_carrier.transition_version+1,
      jsonb_build_object('target_state','RESOLVED_CONTINUITY_ONLY',
        'expected_transition_version',v_carrier.transition_version::text,
        'transaction_id',txid_current()::text,
        'continuity_only_proof','verified','proof_receipt_id',v_proof_id),
      v_proof_id)
    returning id into v_transition_id;
    perform clued_private.transition_event_carrier(v_event_id,
      v_carrier.transition_version,'RESOLVED_CONTINUITY_ONLY',null,v_transition_id);
  end loop;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,
    operation,object_type,object_id,version,metadata)
  values(p_user_id,null,p_scope,'legacy_create_carrier_reconcile',
    'currentness',p_scope,v_count,jsonb_build_object('status','committed',
      'manifest_digest',v_digest,'count',v_count,
      'source_kind','legacy_create_notification',
      'currentness_claim',false)) returning id into v_batch_id;
  return jsonb_build_object('status','reconciled','receipt_id',v_batch_id,
    'count',v_count,'manifest_digest',v_digest,'currentness_claim',false);
end $$;
revoke all on function clued_private.reconcile_legacy_create_notifications_v1(
  uuid,text,integer,text,boolean) from public,anon,authenticated,service_role;
