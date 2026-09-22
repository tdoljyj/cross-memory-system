-- Adopt one of the three exact legacy supersession pairs approved by the
-- activated MTPE P1 adjudication. The complete D1 and D2_v3 tables are
-- recomputed under lock; a verdict row alone is never sufficient proof.
create or replace function clued_private.reconcile_approved_legacy_successor_v1(
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
  v_approval_event public.clued_context_events%rowtype;
  v_approval_receipt public.clued_audit_receipts%rowtype;
  v_receipt_ids uuid[];
  v_activation jsonb;
  v_verdict jsonb;
  v_count bigint;
  v_d1 text;
  v_d2 text;
  v_manifest jsonb;
  v_digest text;
  v_transition_id uuid;
  v_existing public.clued_audit_receipts%rowtype;
begin
  if p_execute is null or p_user_id is null or p_source_event_id is null
     or p_successor_event_id is null
     or (p_source_event_id,p_successor_event_id) not in
       ((637::bigint,638::bigint),(652::bigint,653::bigint),(657::bigint,660::bigint)) then
    raise exception 'approved_successor_input_invalid' using errcode='22023';
  end if;
  if p_execute and coalesce(p_expected_manifest_digest,'') !~ '^[0-9a-f]{64}$' then
    raise exception 'approved_successor_manifest_required' using errcode='22023';
  end if;
  perform clued_private.currentness_user_lock(p_user_id);
  if p_execute then
    select * into v_existing from public.clued_audit_receipts r
      where r.user_id=p_user_id and r.operation='carrier_transition'
        and r.object_type='event' and r.object_id=p_source_event_id::text
        and r.metadata->>'proof_contract'='owner-approved-adjudication.v1'
        and r.metadata->>'manifest_digest'=p_expected_manifest_digest
        and r.metadata->>'successor_event_id'=p_successor_event_id::text
      order by r.created_at desc limit 1;
    if found then
      if not exists(select 1 from clued_private.event_truth_carriers c
        where c.event_id=p_source_event_id and c.user_id=p_user_id
          and c.carrier_state='SUPERSEDED'
          and c.successor_event_id=p_successor_event_id
          and c.transition_receipt_id=v_existing.id) then
        raise exception 'approved_successor_replay_conflict' using errcode='40001';
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
     or v_successor.occurred_at is null or v_source.occurred_at is null
     or v_successor.occurred_at<=v_source.occurred_at
     or v_source.version is null or v_successor.version is null
     or v_source.version is distinct from v_source_carrier.event_version
     or v_successor.version is distinct from v_successor_carrier.event_version then
    raise exception 'approved_successor_source_invalid' using errcode='40001';
  end if;
  execute $sql$
    select count(*),
      encode(extensions.digest(convert_to(string_agg(
        object_key||'|'||object_source_kind::text||'|'||object_source_id,
        E'\n' order by object_key collate "C"),'UTF8'),'sha256'),'hex'),
      encode(extensions.digest(convert_to(string_agg(
        object_key||'|'||coalesce(verdict::text,'')||'|'||classification::text||'|'||
        coalesce(governance_category::text,'')||'|'||coalesce(evidence_ref,'')||'|'||
        coalesce(supersedes_object_key,'')||'|'||coalesce(evidence_note,''),
        E'\n' order by object_key collate "C"),'UTF8'),'sha256'),'hex')
    from mtpe_m0.verdict_table
  $sql$ into v_count,v_d1,v_d2;
  execute $sql$
    select to_jsonb(a) from mtpe_m0.inventory_activation a
      join mtpe_m0.verdict_table v on v.activation_id=a.id
    where v.object_key=$1 and v.verdict::text='SUPERSEDED'
      and v.classification::text='GOVERNANCE_OBJECT'
      and v.evidence_ref='canonical_event:'||$2::text
      and v.supersedes_object_key='canonical_event:'||$2::text
      and a.diff_digest=$3
  $sql$ into v_activation using 'canonical_event:'||p_source_event_id::text,
    p_successor_event_id,v_d2;
  execute $sql$
    select to_jsonb(v) from mtpe_m0.verdict_table v
    where v.object_key=$1 and v.activation_id=($2->>'id')::uuid
  $sql$ into v_verdict using 'canonical_event:'||p_source_event_id::text,v_activation;
  if v_activation is null or v_verdict is null
     or v_activation->>'approval_event' !~ '^canonical_event:[1-9][0-9]*$'
     or coalesce(v_activation->>'approval_receipt','') !~ '^[0-9a-f-]{36}$' then
    raise exception 'approved_successor_adjudication_invalid' using errcode='40001';
  end if;
  select * into v_approval_event from public.clued_context_events e
    where e.id=substring(v_activation->>'approval_event' from '[1-9][0-9]*$')::bigint
      and e.user_id=p_user_id and e.event_type='decision';
  select * into v_approval_receipt from public.clued_audit_receipts r
    where r.id=(v_activation->>'approval_receipt')::uuid and r.user_id=p_user_id
      and r.operation='append' and r.object_type='event'
      and r.object_id=v_approval_event.id::text and r.version=v_approval_event.version
      and r.created_at=v_approval_event.occurred_at
      and coalesce(r.status,'committed')='committed' and r.error_code is null;
  if v_approval_event.id is null or v_approval_receipt.id is null
     or v_approval_event.payload#>>'{digest_verification_at_approval,D1_live}'<>v_d1
     or v_approval_event.payload#>>'{digest_verification_at_approval,D2_v3_live}'<>v_d2
     or v_approval_event.payload#>>'{digest_verification_at_approval,rows_total}'<>v_count::text
     or v_approval_event.payload#>>'{digest_verification_at_approval,echo_matches_live}'<>'true'
     or v_approval_event.payload#>>'{ar_section12_compliance,d1_referenced}'<>'true'
     or v_approval_event.payload#>>'{ar_section12_compliance,d2_echoed_by_owner}'<>'true' then
    raise exception 'approved_successor_owner_proof_invalid' using errcode='40001';
  end if;
  select array_agg(r.id) into v_receipt_ids from public.clued_audit_receipts r
    where r.user_id=p_user_id and r.context_key=v_source_carrier.canonical_scope
      and r.operation='append' and r.object_type='event'
      and r.object_id=p_successor_event_id::text and r.version=v_successor.version
      and r.created_at=v_successor.occurred_at
      and r.binding_id is not distinct from v_successor.binding_id
      and coalesce(r.status,'committed')='committed' and r.error_code is null
      and (v_successor.receipt_id is null or r.id=v_successor.receipt_id);
  if coalesce(array_length(v_receipt_ids,1),0)<>1 then
    raise exception 'approved_successor_receipt_invalid' using errcode='40001';
  end if;
  select * into v_successor_receipt from public.clued_audit_receipts
    where id=v_receipt_ids[1];
  v_manifest:=jsonb_build_object(
    'source_event_id',p_source_event_id,'source_event_version',v_source.version,
    'source_event_hash',clued_private.currentness_hash(to_jsonb(v_source)),
    'source_carrier_transition_version',v_source_carrier.transition_version,
    'source_carrier_hash',clued_private.currentness_hash(to_jsonb(v_source_carrier)),
    'successor_event_id',p_successor_event_id,'successor_event_version',v_successor.version,
    'successor_event_hash',clued_private.currentness_hash(to_jsonb(v_successor)),
    'successor_carrier_transition_version',v_successor_carrier.transition_version,
    'successor_carrier_hash',clued_private.currentness_hash(to_jsonb(v_successor_carrier)),
    'successor_append_receipt_id',v_successor_receipt.id,
    'successor_append_receipt_hash',clued_private.currentness_hash(to_jsonb(v_successor_receipt)),
    'activation',v_activation,'verdict',v_verdict,'row_count',v_count,
    'd1',v_d1,'d2_v3',v_d2,'approval_event_id',v_approval_event.id,
    'approval_event_hash',clued_private.currentness_hash(to_jsonb(v_approval_event)),
    'approval_receipt_id',v_approval_receipt.id,
    'approval_receipt_hash',clued_private.currentness_hash(to_jsonb(v_approval_receipt)));
  v_digest:=clued_private.currentness_hash(v_manifest);
  if not p_execute then
    return jsonb_build_object('status','dry_run','manifest_digest',v_digest,
      'manifest',v_manifest,'currentness_claim',false);
  end if;
  if p_expected_manifest_digest is distinct from v_digest then
    raise exception 'approved_successor_manifest_changed' using errcode='40001';
  end if;
  insert into public.clued_audit_receipts(
    user_id,binding_id,context_key,operation,operation_family,object_type,
    object_id,version,metadata,related_receipt_id)
  values(p_user_id,null,v_source_carrier.canonical_scope,'carrier_transition',
    'event_carrier_transition','event',p_source_event_id::text,
    v_source_carrier.transition_version+1,
    jsonb_build_object('target_state','SUPERSEDED',
      'expected_transition_version',v_source_carrier.transition_version::text,
      'transaction_id',txid_current()::text,'successor_event_id',p_successor_event_id,
      'proof_contract','owner-approved-adjudication.v1',
      'manifest_digest',v_digest,'source_manifest',v_manifest,
      'successor_append_receipt_id',v_successor_receipt.id),
    v_approval_receipt.id)
  returning id into v_transition_id;
  update clued_private.event_truth_carriers set carrier_state='SUPERSEDED',
    successor_event_id=p_successor_event_id,
    transition_version=transition_version+1,
    transition_receipt_id=v_transition_id,updated_at=now()
  where event_id=p_source_event_id and user_id=p_user_id
    and transition_version=v_source_carrier.transition_version
    and carrier_state in ('ACTIVE_UNSTRUCTURED','ACTIVE_TYPED');
  if not found then raise exception 'approved_successor_transition_conflict' using errcode='40001'; end if;
  perform clued_private.touch_currentness(p_user_id,v_source_carrier.canonical_scope,
    'event_carrier_transition',p_source_event_id::text,v_source_carrier.dimensions);
  return jsonb_build_object('status','superseded','receipt_id',v_transition_id,
    'source_event_id',p_source_event_id,'successor_event_id',p_successor_event_id,
    'manifest_digest',v_digest,'currentness_claim',false);
end $$;
revoke all on function clued_private.reconcile_approved_legacy_successor_v1(
  uuid,bigint,bigint,text,boolean) from public,anon,authenticated,service_role;
