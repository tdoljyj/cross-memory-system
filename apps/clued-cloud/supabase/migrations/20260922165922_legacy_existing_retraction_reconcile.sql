-- Adopt an already committed, explicit legacy retraction without appending
-- a duplicate business Event. Only an administrator may invoke this private
-- consistency migration; it does not make the successor historical.
create or replace function clued_private.reconcile_existing_retraction_v1(
  p_user_id uuid,
  p_source_event_id bigint,
  p_successor_event_id bigint,
  p_expected_manifest_digest text default null,
  p_execute boolean default false
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_source public.clued_context_events%rowtype;
  v_successor public.clued_context_events%rowtype;
  v_source_carrier clued_private.event_truth_carriers%rowtype;
  v_successor_carrier clued_private.event_truth_carriers%rowtype;
  v_successor_receipt public.clued_audit_receipts%rowtype;
  v_receipt_ids uuid[];
  v_manifest jsonb;
  v_digest text;
  v_transition_id uuid;
  v_existing public.clued_audit_receipts%rowtype;
begin
  if p_execute is null or p_user_id is null or p_source_event_id is null
     or p_successor_event_id is null or p_successor_event_id<=p_source_event_id then
    raise exception 'existing_retraction_input_invalid' using errcode='22023';
  end if;
  if p_execute and coalesce(p_expected_manifest_digest,'') !~ '^[0-9a-f]{64}$' then
    raise exception 'existing_retraction_manifest_required' using errcode='22023';
  end if;
  perform clued_private.currentness_user_lock(p_user_id);
  if p_execute then
    select * into v_existing from public.clued_audit_receipts r
      where r.user_id=p_user_id and r.operation='carrier_transition'
        and r.object_type='event' and r.object_id=p_source_event_id::text
        and r.metadata->>'proof_contract'='existing-explicit-retraction.v1'
        and r.metadata->>'manifest_digest'=p_expected_manifest_digest
        and r.metadata->>'successor_event_id'=p_successor_event_id::text
      order by r.created_at desc limit 1;
    if found then
      if not exists(select 1 from clued_private.event_truth_carriers c
        where c.event_id=p_source_event_id and c.user_id=p_user_id
          and c.carrier_state='RETRACTED'
          and c.successor_event_id=p_successor_event_id
          and c.transition_receipt_id=v_existing.id) then
        raise exception 'existing_retraction_replay_conflict' using errcode='40001';
      end if;
      return jsonb_build_object('status','duplicate','receipt_id',v_existing.id,
        'manifest_digest',p_expected_manifest_digest,'currentness_claim',false);
    end if;
  end if;
  select * into v_source from public.clued_context_events e
    where e.id=p_source_event_id and e.user_id=p_user_id;
  select * into v_successor from public.clued_context_events e
    where e.id=p_successor_event_id and e.user_id=p_user_id;
  select * into v_source_carrier from clued_private.event_truth_carriers c
    where c.event_id=p_source_event_id and c.user_id=p_user_id for update;
  select * into v_successor_carrier from clued_private.event_truth_carriers c
    where c.event_id=p_successor_event_id and c.user_id=p_user_id for update;
  if v_source.id is null or v_successor.id is null
     or v_source_carrier.event_id is null or v_successor_carrier.event_id is null
     or v_source_carrier.carrier_state not in ('ACTIVE_UNSTRUCTURED','ACTIVE_TYPED')
     or v_successor_carrier.carrier_state not in ('ACTIVE_UNSTRUCTURED','ACTIVE_TYPED')
     or v_source_carrier.source_kind<>'legacy'
     or v_successor_carrier.source_kind<>'legacy'
     or v_source_carrier.visibility<>'work_log'
     or v_successor_carrier.visibility<>'work_log'
     or v_source_carrier.canonical_scope<>v_successor_carrier.canonical_scope
     or v_source.context_key<>v_source_carrier.canonical_scope
     or v_successor.context_key<>v_source_carrier.canonical_scope
     or v_successor.event_type<>'retraction'
     or (v_successor.payload->>'retracts_event_id') is distinct from p_source_event_id::text
     or v_successor.occurred_at is null or v_source.occurred_at is null
     or v_successor.occurred_at<=v_source.occurred_at
     or v_source.version is null or v_successor.version is null
     or v_source.version is distinct from v_source_carrier.event_version
     or v_successor.version is distinct from v_successor_carrier.event_version then
    raise exception 'existing_retraction_source_invalid' using errcode='40001';
  end if;
  select array_agg(r.id) into v_receipt_ids
    from public.clued_audit_receipts r
    where r.user_id=p_user_id and r.context_key=v_source_carrier.canonical_scope
      and r.operation='append' and r.object_type='event'
      and r.object_id=p_successor_event_id::text
      and r.version=v_successor.version
      and r.created_at=v_successor.occurred_at
      and r.binding_id is not distinct from v_successor.binding_id;
  if coalesce(array_length(v_receipt_ids,1),0)<>1 then
    raise exception 'existing_retraction_successor_receipt_invalid' using errcode='40001';
  end if;
  select * into v_successor_receipt from public.clued_audit_receipts
    where id=v_receipt_ids[1];
  v_manifest:=jsonb_build_object(
    'source_event_id',p_source_event_id,'source_event_version',v_source.version,
    'source_event_hash',clued_private.currentness_hash(to_jsonb(v_source)),
    'source_carrier_transition_version',v_source_carrier.transition_version,
    'source_carrier_hash',clued_private.currentness_hash(to_jsonb(v_source_carrier)),
    'successor_event_id',p_successor_event_id,
    'successor_event_version',v_successor.version,
    'successor_event_hash',clued_private.currentness_hash(to_jsonb(v_successor)),
    'successor_carrier_transition_version',v_successor_carrier.transition_version,
    'successor_carrier_hash',clued_private.currentness_hash(to_jsonb(v_successor_carrier)),
    'successor_append_receipt_id',v_successor_receipt.id,
    'successor_append_receipt_hash',
      clued_private.currentness_hash(to_jsonb(v_successor_receipt)));
  v_digest:=clued_private.currentness_hash(v_manifest);
  if not p_execute then
    return jsonb_build_object('status','dry_run','manifest_digest',v_digest,
      'manifest',v_manifest,'currentness_claim',false);
  end if;
  if p_expected_manifest_digest is distinct from v_digest then
    raise exception 'existing_retraction_manifest_changed' using errcode='40001';
  end if;
  insert into public.clued_audit_receipts(
    user_id,binding_id,context_key,operation,operation_family,object_type,
    object_id,version,metadata,related_receipt_id)
  values(p_user_id,null,v_source_carrier.canonical_scope,'carrier_transition',
    'event_carrier_transition','event',p_source_event_id::text,
    v_source_carrier.transition_version+1,
    jsonb_build_object('target_state','RETRACTED',
      'expected_transition_version',v_source_carrier.transition_version::text,
      'transaction_id',txid_current()::text,
      'successor_event_id',p_successor_event_id,
      'proof_contract','existing-explicit-retraction.v1',
      'manifest_digest',v_digest,'source_manifest',v_manifest),
    v_successor_receipt.id)
  returning id into v_transition_id;
  perform clued_private.transition_event_carrier(p_source_event_id,
    v_source_carrier.transition_version,'RETRACTED',p_successor_event_id,
    v_transition_id);
  return jsonb_build_object('status','retracted','receipt_id',v_transition_id,
    'source_event_id',p_source_event_id,'successor_event_id',p_successor_event_id,
    'manifest_digest',v_digest,'currentness_claim',false);
end $$;
revoke all on function clued_private.reconcile_existing_retraction_v1(
  uuid,bigint,bigint,text,boolean) from public,anon,authenticated,service_role;
