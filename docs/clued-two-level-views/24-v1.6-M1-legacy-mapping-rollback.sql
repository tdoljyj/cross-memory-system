-- Clued v1.6 M1 non-destructive rollback for batch
-- m1-current-legacy-20260826-v1.
--
-- Run only if the post-mapping gate fails. The script restores the 126 source
-- rows to their exact legacy version/timestamp and null M1 envelope. Original
-- mapping Receipts and Events remain immutable audit evidence; one additional
-- rollback Receipt + Event records the reversal. No row is deleted.

begin;

do $$
declare
  v_batch constant text := 'm1-current-legacy-20260826-v1';
  v_user_id uuid;
  v_count bigint;
  v_receipt public.clued_audit_receipts%rowtype;
  v_input jsonb;
  v_targets jsonb;
  v_base_versions jsonb;
  v_committed_versions jsonb;
  v_event_id text;
begin
  select count(*), min(user_id)
  into v_count, v_user_id
  from public.clued_memories
  where record_schema_version = 1
    and type_fields->>'migration_batch' = v_batch;

  if v_count <> 126
    or (select count(distinct user_id) from public.clued_memories where record_schema_version=1 and type_fields->>'migration_batch'=v_batch) <> 1
    or exists (
      select 1
      from public.clued_memories m
      join public.clued_audit_receipts r on r.id=m.receipt_id
      where m.record_schema_version=1
        and m.type_fields->>'migration_batch'=v_batch
        and (
          m.version<>2
          or r.operation_family<>'legacy_record_mapping'
          or r.status<>'committed'
          or r.metadata->>'migration_batch'<>v_batch
          or (r.metadata->>'legacy_version')::bigint<>1
        )
    ) then
    raise exception 'legacy_mapping_rollback_guard_failed' using errcode='40001';
  end if;

  select
    jsonb_agg(jsonb_build_object('role','primary','kind','record','id',m.id) order by m.id),
    jsonb_object_agg(m.id::text,m.version),
    jsonb_object_agg(m.id::text,(r.metadata->>'legacy_version')::bigint)
  into v_targets,v_base_versions,v_committed_versions
  from public.clued_memories m
  join public.clued_audit_receipts r on r.id=m.receipt_id
  where m.record_schema_version=1
    and m.type_fields->>'migration_batch'=v_batch;

  v_input:=jsonb_build_object(
    'idempotency_key','m1-map-rollback-20260826-v1',
    'mapping_batch',v_batch,
    'target_count',v_count
  );
  v_receipt:=clued_private.m1_begin_receipt(
    v_user_id,null,'legacy_record_mapping_rollback',v_input,
    clued_private.m1_sha256(jsonb_build_object(
      'operation','legacy_record_mapping_rollback','payload',v_input
    ))
  );
  if v_receipt.status<>'pending' then
    raise exception 'legacy_mapping_rollback_receipt_not_pending' using errcode='40001';
  end if;

  update public.clued_memories m
  set record_schema_version=null,
      lifecycle_status=null,
      canonical_scope=null,
      type_fields=null,
      relations=null,
      source_refs=null,
      source_unavailable_reason=null,
      closure_summary=null,
      closed_reason=null,
      closed_at=null,
      authority=null,
      observed_at=null,
      confidence=null,
      confidence_reason=null,
      receipt_id=null,
      content_hash=null,
      merged_into_record_id=null,
      version=(r.metadata->>'legacy_version')::bigint,
      updated_at=(r.metadata->>'legacy_updated_at')::timestamptz
  from public.clued_audit_receipts r
  where m.receipt_id=r.id
    and m.record_schema_version=1
    and m.type_fields->>'migration_batch'=v_batch;

  if (select count(*) from public.clued_memories where record_schema_version is null and status in ('active','backlog','current') and record_type in ('decision','note','state','task'))<>126 then
    raise exception 'legacy_mapping_rollback_count_mismatch' using errcode='40001';
  end if;

  v_event_id:=clued_private.m1_append_event_row(
    v_user_id,null,v_receipt.id,v_receipt.canonical_version,
    'extension:clued:rollback_legacy_mapping',v_targets,'global',null,
    jsonb_build_array(jsonb_build_object(
      'change','m1_canonical_to_legacy_envelope',
      'mapping_batch',v_batch,
      'target_count',v_count
    )),
    v_input->>'idempotency_key',v_receipt.request_sha256,'success','audit_only',
    '{}'::uuid[],'[]'::jsonb,null
  );
  perform clued_private.m1_finish_receipt(
    v_receipt.id,'committed',v_targets,v_base_versions,v_committed_versions,
    array[v_event_id],'{}'::uuid[],null
  );
end
$$;

commit;
