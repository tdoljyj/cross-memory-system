-- Task 32dbbd35 follow-up: let clued_private.reconcile_event_continuity_manifest_v1
-- run on a database that does not have Information Flow S5 yet (production is at
-- IF S2). The withdrawn-Evidence check now runs only when
-- clued_private.record_evidence_status exists, through dynamic SQL so the plan
-- never references a missing table. Everything else is unchanged from
-- 20260924235000_event_continuity_manifest_v1.sql.
create or replace function clued_private.reconcile_event_continuity_manifest_v1(
  p_user_id uuid,
  p_manifest jsonb,
  p_expected_manifest_digest text default null,
  p_approval_record_id uuid default null,
  p_approval_receipt_id uuid default null,
  p_execute boolean default false
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_contract constant text := 'event-continuity-manifest.v1';
  v_target constant text := 'RESOLVED_CONTINUITY_ONLY';
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_id constant text := '^[1-9][0-9]{0,17}$';
  v_digest text;
  v_count integer; v_distinct integer;
  v_scopes text[];
  v_item jsonb; v_pin jsonb;
  v_event public.clued_context_events%rowtype;
  v_carrier clued_private.event_truth_carriers%rowtype;
  v_record public.clued_memories%rowtype;
  v_approval public.clued_memories%rowtype;
  v_approval_receipt public.clued_audit_receipts%rowtype;
  v_resolved integer; v_proof_id uuid; v_transition_id uuid; v_batch_id uuid;
  v_source jsonb;
  v_withdrawn boolean;
begin
  if p_user_id is null or p_execute is null or jsonb_typeof(p_manifest) is distinct from 'object' then
    raise exception 'continuity_manifest_invalid' using errcode='22023';
  end if;
  -- Exact shape: fixed keys, fixed contract and target, 1..100 unique Events. Every
  -- value is pattern-checked before any cast, so malformed input never raises a raw
  -- cast error.
  if (select array_agg(k order by k) from jsonb_object_keys(p_manifest) k)
       is distinct from array['contract','events','target_state','user_id']
     or p_manifest->>'contract' is distinct from v_contract
     or p_manifest->>'target_state' is distinct from v_target
     or jsonb_typeof(p_manifest->'user_id') is distinct from 'string'
     or coalesce(p_manifest->>'user_id','') !~ v_uuid
     or jsonb_typeof(p_manifest->'events') is distinct from 'array'
     or jsonb_array_length(p_manifest->'events') not between 1 and 100 then
    raise exception 'continuity_manifest_invalid' using errcode='22023';
  end if;
  if (p_manifest->>'user_id')::uuid is distinct from p_user_id then
    raise exception 'continuity_manifest_invalid' using errcode='22023';
  end if;
  for v_item in select value from jsonb_array_elements(p_manifest->'events') loop
    if jsonb_typeof(v_item) is distinct from 'object'
       or (select array_agg(k order by k) from jsonb_object_keys(v_item) k)
          is distinct from array['carried_by_records','carrier_dimensions','carrier_source_kind',
            'event_id','event_type','expected_carrier_state','expected_transition_version',
            'payload_sha256','reason_code','scope']
       or jsonb_typeof(v_item->'event_id') is distinct from 'number'
       or coalesce(v_item->>'event_id','') !~ v_id
       or jsonb_typeof(v_item->'expected_transition_version') is distinct from 'number'
       or coalesce(v_item->>'expected_transition_version','') !~ v_id
       or jsonb_typeof(v_item->'expected_carrier_state') is distinct from 'string'
       or v_item->>'expected_carrier_state' not in ('ACTIVE_UNSTRUCTURED','ACTIVE_TYPED')
       or coalesce(v_item->>'scope','') !~ '^(global|project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
       or coalesce(v_item->>'payload_sha256','') !~ '^[0-9a-f]{64}$'
       or jsonb_typeof(v_item->'event_type') is distinct from 'string'
       or char_length(coalesce(v_item->>'event_type','')) not between 1 and 80
       or jsonb_typeof(v_item->'carrier_source_kind') is distinct from 'string'
       or char_length(coalesce(v_item->>'carrier_source_kind','')) not between 1 and 80
       or jsonb_typeof(v_item->'carrier_dimensions') is distinct from 'array'
       or exists(select 1 from jsonb_array_elements(v_item->'carrier_dimensions') d
          where jsonb_typeof(d) is distinct from 'string')
       or jsonb_typeof(v_item->'reason_code') is distinct from 'string'
       or char_length(btrim(coalesce(v_item->>'reason_code',''))) not between 1 and 200
       or jsonb_typeof(v_item->'carried_by_records') is distinct from 'array'
       or jsonb_array_length(v_item->'carried_by_records') not between 1 and 20
       or exists(select 1 from jsonb_array_elements(v_item->'carried_by_records') r
          where jsonb_typeof(r) is distinct from 'object'
             or (select array_agg(k order by k) from jsonb_object_keys(r) k)
                is distinct from array['content_hash','id','version']
             or jsonb_typeof(r->'id') is distinct from 'string' or r->>'id' !~ v_uuid
             or jsonb_typeof(r->'version') is distinct from 'number' or r->>'version' !~ v_id
             or jsonb_typeof(r->'content_hash') is distinct from 'string'
             or r->>'content_hash' !~ '^[0-9a-f]{64}$')
       or (select count(*) from jsonb_array_elements(v_item->'carried_by_records'))
          <>(select count(distinct r->>'id') from jsonb_array_elements(v_item->'carried_by_records') r) then
      raise exception 'continuity_manifest_invalid' using errcode='22023';
    end if;
  end loop;
  select count(*),count(distinct (x->>'event_id')::bigint),array_agg(distinct x->>'scope')
    into v_count,v_distinct,v_scopes
    from jsonb_array_elements(p_manifest->'events') x;
  if v_distinct<>v_count then
    raise exception 'continuity_manifest_invalid' using errcode='22023';
  end if;
  v_digest:=encode(extensions.digest(convert_to(p_manifest::text,'UTF8'),'sha256'),'hex');
  if p_execute and (coalesce(p_expected_manifest_digest,'') !~ '^[0-9a-f]{64}$'
      or p_approval_record_id is null or p_approval_receipt_id is null) then
    raise exception 'continuity_manifest_approval_required' using errcode='22023';
  end if;
  if p_execute and p_expected_manifest_digest is distinct from v_digest then
    raise exception 'continuity_manifest_digest_mismatch' using errcode='P0001';
  end if;
  perform clued_private.currentness_user_lock(p_user_id);

  -- Replay of an already applied manifest is a no-op; a half-applied one is a conflict.
  select count(*) into v_resolved from clued_private.event_truth_carriers c
    join jsonb_array_elements(p_manifest->'events') x on c.event_id=(x->>'event_id')::bigint
    where c.user_id=p_user_id and c.carrier_state=v_target
      and exists(select 1 from public.clued_audit_receipts r
        where r.user_id=p_user_id and r.operation='continuity_only_resolution_authorized'
          and r.object_type='event' and r.object_id=c.event_id::text
          and r.metadata->>'proof'='owner_approved_exact_manifest'
          and r.metadata->>'proof_contract'=v_contract
          and r.metadata->>'manifest_digest'=v_digest);
  if v_resolved=v_count then
    return jsonb_build_object('status','already_reconciled','manifest_digest',v_digest,
      'count',v_count,'currentness_claim',false);
  end if;
  if v_resolved>0 then
    raise exception 'continuity_manifest_partially_applied' using errcode='P0001';
  end if;

  -- Any change to an Event, its payload, scope or carrier, or to a pinned carrying
  -- Record, rejects the whole batch. Rows are locked before they are checked.
  -- Events and Records of another owner are simply absent.
  for v_item in select value from jsonb_array_elements(p_manifest->'events') loop
    v_event:=null; v_carrier:=null;
    select * into v_event from public.clued_context_events e
      where e.id=(v_item->>'event_id')::bigint and e.user_id=p_user_id for share;
    select * into v_carrier from clued_private.event_truth_carriers c
      where c.event_id=(v_item->>'event_id')::bigint and c.user_id=p_user_id for update;
    if v_event.id is null or v_carrier.event_id is null
       or v_event.context_key is distinct from v_item->>'scope'
       or v_event.event_type is distinct from v_item->>'event_type'
       or encode(extensions.digest(convert_to(v_event.payload::text,'UTF8'),'sha256'),'hex')
          is distinct from v_item->>'payload_sha256'
       or v_carrier.canonical_scope is distinct from v_item->>'scope'
       or v_carrier.visibility is distinct from 'work_log'
       or v_carrier.carrier_state is distinct from v_item->>'expected_carrier_state'
       or v_carrier.source_kind is distinct from v_item->>'carrier_source_kind'
       or v_carrier.dimensions is distinct from
          array(select jsonb_array_elements_text(v_item->'carrier_dimensions'))
       or v_carrier.transition_version is distinct from (v_item->>'expected_transition_version')::bigint then
      raise exception 'continuity_manifest_source_changed event=%',v_item->>'event_id'
        using errcode='P0001';
    end if;
    for v_pin in select value from jsonb_array_elements(v_item->'carried_by_records') loop
      v_record:=null;
      select * into v_record from public.clued_memories m
        where m.id=(v_pin->>'id')::uuid and m.user_id=p_user_id for share;
      if v_record.id is null or v_record.record_schema_version is null
         or v_record.lifecycle_status is distinct from 'active'
         or v_record.archived_at is not null
         or v_record.merged_into_record_id is not null
         or v_record.version is distinct from (v_pin->>'version')::bigint
         or v_record.content_hash is distinct from v_pin->>'content_hash' then
        raise exception 'continuity_manifest_carrying_record_changed event=% record=%',
          v_item->>'event_id',v_pin->>'id' using errcode='P0001';
      end if;
      -- A version whose Evidence was withdrawn no longer carries meaning. The
      -- flag table comes with Information Flow S5; where it is not installed yet
      -- no Evidence can have been withdrawn, so there is nothing to check. The
      -- read is dynamic so the function also runs on such a database.
      if to_regclass('clued_private.record_evidence_status') is not null then
        execute 'select exists(select 1 from clued_private.record_evidence_status s
            where s.record_id=$1 and s.record_version=$2)'
          into v_withdrawn using v_record.id,v_record.version;
        if v_withdrawn then
          raise exception 'continuity_manifest_carrying_record_changed event=% record=%',
            v_item->>'event_id',v_pin->>'id' using errcode='P0001';
        end if;
      end if;
    end loop;
  end loop;
  if not p_execute then
    return jsonb_build_object('status','dry_run_ok','manifest_digest',v_digest,
      'count',v_count,'currentness_claim',false);
  end if;

  -- The approval is an Owner Decision written through one of the owner's Bindings,
  -- whose current committed version names this exact digest. It lives in global
  -- scope, or in the single scope every Event belongs to.
  select * into v_approval from public.clued_memories r
    where r.id=p_approval_record_id and r.user_id=p_user_id for share;
  select * into v_approval_receipt from public.clued_audit_receipts r
    where r.id=p_approval_receipt_id and r.user_id=p_user_id;
  if v_approval.id is null or v_approval_receipt.id is null
     or v_approval.record_type is distinct from 'decision'
     or v_approval.lifecycle_status is distinct from 'active'
     or v_approval.authority is distinct from 'user_explicit'
     or not (v_approval.canonical_scope='global'
       or (cardinality(v_scopes)=1 and v_approval.canonical_scope=v_scopes[1]))
     or v_approval.receipt_id is distinct from p_approval_receipt_id
     or v_approval.relations->>'manifest_digest' is distinct from v_digest
     or v_approval.relations->>'event_count' is distinct from v_count::text
     or v_approval.relations->>'target_state' is distinct from v_target
     or v_approval_receipt.status is distinct from 'committed'
     or v_approval_receipt.error_code is not null
     or v_approval_receipt.operation_family is distinct from 'record_mutation'
     or v_approval_receipt.binding_id is null
     or not exists(select 1 from public.clued_agent_bindings b
        where b.id=v_approval_receipt.binding_id and b.user_id=p_user_id)
     or v_approval_receipt.committed_versions->>p_approval_record_id::text
        is distinct from v_approval.version::text then
    raise exception 'continuity_manifest_approval_invalid' using errcode='P0001';
  end if;

  for v_item in select value from jsonb_array_elements(p_manifest->'events') loop
    select * into v_carrier from clued_private.event_truth_carriers c
      where c.event_id=(v_item->>'event_id')::bigint and c.user_id=p_user_id for update;
    insert into public.clued_audit_receipts(
      user_id,binding_id,context_key,operation,object_type,object_id,version,
      metadata,related_receipt_id)
    values(p_user_id,null,v_carrier.canonical_scope,
      'continuity_only_resolution_authorized','event',v_carrier.event_id::text,
      v_carrier.transition_version,jsonb_build_object(
        'proof','owner_approved_exact_manifest',
        'proof_contract',v_contract,
        'target_state',v_target,
        'expected_transition_version',v_carrier.transition_version::text,
        'expected_carrier_state',v_item->>'expected_carrier_state',
        'event_type',v_item->>'event_type',
        'payload_sha256',v_item->>'payload_sha256',
        'manifest_digest',v_digest,
        'approval_record_id',p_approval_record_id,
        'approval_receipt_id',p_approval_receipt_id,
        'carried_by_records',v_item->'carried_by_records',
        'reason_code',v_item->>'reason_code',
        'transaction_id',txid_current()::text),p_approval_receipt_id)
    returning id into v_proof_id;
    insert into public.clued_audit_receipts(
      user_id,binding_id,context_key,operation,operation_family,object_type,
      object_id,version,metadata,related_receipt_id)
    values(p_user_id,null,v_carrier.canonical_scope,'carrier_transition',
      'event_carrier_transition','event',v_carrier.event_id::text,
      v_carrier.transition_version+1,jsonb_build_object(
        'target_state',v_target,
        'expected_transition_version',v_carrier.transition_version::text,
        'continuity_only_proof','verified',
        'proof_contract',v_contract,
        'manifest_digest',v_digest,
        'proof_receipt_id',v_proof_id,
        'transaction_id',txid_current()::text),v_proof_id)
    returning id into v_transition_id;
    perform clued_private.transition_event_carrier(v_carrier.event_id,
      v_carrier.transition_version,v_target,null,v_transition_id);
  end loop;

  select count(*) into v_resolved from clued_private.event_truth_carriers c
    join jsonb_array_elements(p_manifest->'events') x on c.event_id=(x->>'event_id')::bigint
    where c.user_id=p_user_id and c.carrier_state=v_target;
  if v_resolved<>v_count then
    raise exception 'continuity_manifest_postcondition_failed' using errcode='P0001';
  end if;

  -- Carrier shadowing changed for these scopes: recompute both Global projections.
  v_source:=jsonb_build_object('kind','continuity_resolution','id',v_contract,
    'manifest_digest',v_digest);
  insert into clued_private.projection_invalidation_heads(user_id,target_scope,
    projection_key,invalidation_revision,latest_source_ref,stale_since)
  values(p_user_id,'global','global.priority_frontier',1,v_source,now()),
        (p_user_id,'global','global.__aggregate__',1,v_source,now())
  on conflict(user_id,target_scope,projection_key) do update set
    invalidation_revision=clued_private.projection_invalidation_heads.invalidation_revision+1,
    latest_source_ref=excluded.latest_source_ref,
    stale_since=coalesce(clued_private.projection_invalidation_heads.stale_since,now()),
    updated_at=now();

  -- The batch Receipt keeps the exact approved manifest, so its digest can be
  -- recomputed from the database alone.
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,
    operation,operation_family,object_type,object_id,version,metadata,
    related_receipt_id)
  values(p_user_id,null,'global','event_continuity_manifest_reconcile',
    'event_carrier_transition','currentness','global',v_count,
    jsonb_build_object('status','committed','count',v_count,
      'contract',v_contract,'manifest_digest',v_digest,'manifest',p_manifest,
      'approval_record_id',p_approval_record_id,
      'approval_receipt_id',p_approval_receipt_id,
      'target_state',v_target,'currentness_claim',false),p_approval_receipt_id)
  returning id into v_batch_id;
  return jsonb_build_object('status','reconciled','receipt_id',v_batch_id,
    'count',v_count,'manifest_digest',v_digest,'currentness_claim',false);
end $$;

revoke all on function clued_private.reconcile_event_continuity_manifest_v1(
  uuid,jsonb,text,uuid,uuid,boolean) from public,anon,authenticated,service_role;
