-- Clued v1.6 M1: deterministic promotion of current legacy Records.
--
-- The migration is intentionally narrow:
--   * only non-terminal decision/note/state/task rows are promoted;
--   * canonical UUIDs and legacy payload columns are preserved;
--   * every promotion receives one committed Receipt and one canonical Event;
--   * archived legacy rows, archive_snapshot rows, M2 sequencing and merge writes
--     remain untouched.

create or replace function clued_private.m1_migrate_current_legacy_records(
  p_expected_count bigint,
  p_batch text
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.clued_memories%rowtype;
  v_receipt public.clued_audit_receipts%rowtype;
  v_input jsonb;
  v_type_fields jsonb;
  v_relations jsonb := '{}'::jsonb;
  v_target_refs jsonb;
  v_scope text;
  v_source_reason text;
  v_confidence_reason text := 'legacy_authenticated_import_no_confidence_reestimation';
  v_content_hash text;
  v_event_id text;
  v_count bigint;
begin
  if p_expected_count < 0 then
    raise exception 'invalid_expected_count' using errcode = '22023';
  end if;
  if p_batch !~ '^[a-z0-9][a-z0-9._-]{7,119}$' then
    raise exception 'invalid_mapping_batch' using errcode = '22023';
  end if;

  select count(*) into v_count
  from public.clued_memories
  where record_schema_version is null
    and status in ('active', 'backlog', 'current')
    and record_type in ('decision', 'note', 'state', 'task');

  if v_count <> p_expected_count then
    raise exception 'legacy_mapping_count_mismatch expected=% actual=%', p_expected_count, v_count
      using errcode = '40001';
  end if;

  for v_row in
    select *
    from public.clued_memories
    where record_schema_version is null
      and status in ('active', 'backlog', 'current')
      and record_type in ('decision', 'note', 'state', 'task')
    order by id
    for update
  loop
    if v_row.version < 1
      or v_row.source_ref is null
      or btrim(v_row.source_ref) = ''
      or v_row.supersedes_id is not null
      or v_row.restored_from_id is not null
      or v_row.next_task_id is not null then
      raise exception 'legacy_mapping_precondition_failed record=%', v_row.id
        using errcode = '40001';
    end if;

    v_scope := case
      when v_row.scope = 'global' and v_row.project_id is null then 'global'
      when v_row.scope = 'project' and v_row.project_id is not null then 'project:' || v_row.project_id::text
      else null
    end;
    if v_scope is null then
      raise exception 'legacy_mapping_scope_invalid record=%', v_row.id
        using errcode = '40001';
    end if;
    if v_row.project_id is not null and not exists (
      select 1 from public.clued_projects p
      where p.id = v_row.project_id
        and p.user_id = v_row.user_id
        and p.certainty_status = 'confirmed'
        and p.dismissed_at is null
        and p.merged_into_project_id is null
    ) then
      raise exception 'legacy_mapping_project_invalid record=%', v_row.id
        using errcode = '40001';
    end if;

    v_type_fields := case v_row.record_type
      when 'decision' then jsonb_build_object(
        'rationale', 'legacy_import_preserved_content',
        'migration_batch', p_batch,
        'legacy_status', v_row.status,
        'legacy_priority', v_row.priority
      )
      when 'note' then jsonb_build_object(
        'note_kind', 'legacy_import',
        'migration_batch', p_batch,
        'legacy_status', v_row.status,
        'legacy_priority', v_row.priority
      )
      when 'state' then jsonb_build_object(
        'state_kind', 'legacy_import',
        'migration_batch', p_batch,
        'legacy_status', v_row.status,
        'legacy_priority', v_row.priority
      )
      when 'task' then jsonb_build_object(
        'execution_bucket', 'later',
        'migration_batch', p_batch,
        'legacy_status', v_row.status,
        'legacy_priority', v_row.priority
      )
    end;
    perform clued_private.m1_validate_record_shape(
      v_row.record_type, 1, v_type_fields, v_relations
    );

    v_source_reason := 'legacy_source_ref:' || v_row.source_ref;
    v_input := jsonb_build_object(
      'idempotency_key', 'm1-map-v1:' || v_row.id::text,
      'record_id', v_row.id,
      'mapping_contract', 'clued-v1.6-m1-current-legacy-v1',
      'mapping_batch', p_batch,
      'legacy_fingerprint', clued_private.m1_sha256(jsonb_build_object(
        'id', v_row.id,
        'record_type', v_row.record_type,
        'status', v_row.status,
        'scope', v_row.scope,
        'project_id', v_row.project_id,
        'record_key', v_row.record_key,
        'version', v_row.version,
        'priority', v_row.priority,
        'title', v_row.title,
        'content', v_row.content,
        'source_ref', v_row.source_ref,
        'created_at', v_row.created_at,
        'updated_at', v_row.updated_at
      ))
    );
    v_receipt := clued_private.m1_begin_receipt(
      v_row.user_id,
      null,
      'legacy_record_mapping',
      v_input,
      clued_private.m1_sha256(jsonb_build_object(
        'operation', 'legacy_record_mapping',
        'payload', v_input
      ))
    );
    if v_receipt.status <> 'pending' then
      raise exception 'legacy_mapping_receipt_not_pending record=% status=%', v_row.id, v_receipt.status
        using errcode = '40001';
    end if;

    update public.clued_audit_receipts
    set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'mapping_contract', 'clued-v1.6-m1-current-legacy-v1',
      'migration_batch', p_batch,
      'legacy_version', v_row.version,
      'legacy_updated_at', v_row.updated_at,
      'legacy_status', v_row.status
    )
    where id = v_receipt.id;

    v_content_hash := clued_private.m1_record_content_hash(
      v_row.record_type,
      v_scope,
      'active',
      v_row.title,
      v_row.content,
      v_type_fields,
      v_relations,
      '{}'::uuid[],
      v_source_reason,
      'imported',
      null,
      null,
      null,
      v_confidence_reason
    );

    update public.clued_memories
    set record_schema_version = 1,
        lifecycle_status = 'active',
        canonical_scope = v_scope,
        type_fields = v_type_fields,
        relations = v_relations,
        source_refs = '{}'::uuid[],
        source_unavailable_reason = v_source_reason,
        closure_summary = null,
        closed_reason = null,
        closed_at = null,
        authority = 'imported',
        observed_at = null,
        confidence = null,
        confidence_reason = v_confidence_reason,
        receipt_id = v_receipt.id,
        content_hash = v_content_hash,
        merged_into_record_id = null,
        version = version + 1,
        updated_at = now()
    where id = v_row.id
      and user_id = v_row.user_id
      and record_schema_version is null;
    if not found then
      raise exception 'legacy_mapping_concurrent_change record=%', v_row.id
        using errcode = '40001';
    end if;

    v_target_refs := jsonb_build_array(jsonb_build_object(
      'role', 'primary', 'kind', 'record', 'id', v_row.id
    ));
    v_event_id := clued_private.m1_append_event_row(
      v_row.user_id,
      null,
      v_receipt.id,
      v_receipt.canonical_version,
      'extension:clued:migrate_legacy_record',
      v_target_refs,
      v_scope,
      v_scope,
      jsonb_build_array(jsonb_build_object(
        'change', 'legacy_to_m1_canonical',
        'mapping_contract', 'clued-v1.6-m1-current-legacy-v1',
        'migration_batch', p_batch,
        'legacy_version', v_row.version,
        'committed_version', v_row.version + 1
      )),
      v_input->>'idempotency_key',
      v_receipt.request_sha256,
      'success',
      'work_log',
      '{}'::uuid[],
      '[]'::jsonb,
      null
    );
    perform clued_private.m1_finish_receipt(
      v_receipt.id,
      'committed',
      v_target_refs,
      jsonb_build_object(v_row.id::text, v_row.version),
      jsonb_build_object(v_row.id::text, v_row.version + 1),
      array[v_event_id],
      '{}'::uuid[],
      null
    );
  end loop;

  return v_count;
end
$$;

revoke all on function clued_private.m1_migrate_current_legacy_records(bigint, text)
from public, anon, authenticated;

-- Fresh installations have no legacy data. Existing production is allowed to
-- proceed only when the frozen, user-authorized 126-row shape is still exact.
do $$
declare
  v_count bigint;
  v_owners bigint;
begin
  select count(*) into v_count
  from public.clued_memories
  where record_schema_version is null
    and status in ('active', 'backlog', 'current')
    and record_type in ('decision', 'note', 'state', 'task');

  if v_count = 0 then
    return;
  end if;

  select count(distinct user_id) into v_owners
  from public.clued_memories
  where record_schema_version is null
    and status in ('active', 'backlog', 'current')
    and record_type in ('decision', 'note', 'state', 'task');

  if v_count <> 126
    or v_owners <> 1
    or (select count(*) from public.clued_memories where record_schema_version is null and record_type = 'decision' and status = 'active' and scope = 'global') <> 41
    or (select count(*) from public.clued_memories where record_schema_version is null and record_type = 'note' and status = 'active' and scope = 'global') <> 53
    or (select count(*) from public.clued_memories where record_schema_version is null and record_type = 'state' and status = 'current' and scope = 'global') <> 4
    or (select count(*) from public.clued_memories where record_schema_version is null and record_type = 'state' and status = 'current' and scope = 'project') <> 14
    or (select count(*) from public.clued_memories where record_schema_version is null and record_type = 'task' and status = 'backlog' and scope = 'global') <> 14
    or exists (
      select 1 from public.clued_memories m
      where m.record_schema_version is null
        and m.status in ('active', 'backlog', 'current')
        and m.record_type in ('decision', 'note', 'state', 'task')
        and (
          m.version <> 1
          or m.source_ref is null
          or btrim(m.source_ref) = ''
          or m.supersedes_id is not null
          or m.restored_from_id is not null
          or m.next_task_id is not null
          or (m.scope = 'global' and m.project_id is not null)
          or (m.scope = 'project' and m.project_id is null)
        )
    )
    or exists (
      select 1
      from public.clued_memories m
      left join public.clued_projects p
        on p.id = m.project_id and p.user_id = m.user_id
      where m.record_schema_version is null
        and m.status in ('active', 'backlog', 'current')
        and m.record_type in ('decision', 'note', 'state', 'task')
        and m.project_id is not null
        and (
          p.id is null
          or p.certainty_status <> 'confirmed'
          or p.dismissed_at is not null
          or p.merged_into_project_id is not null
        )
    ) then
    raise exception 'production_legacy_mapping_freeze_mismatch'
      using errcode = '40001';
  end if;

  perform clued_private.m1_migrate_current_legacy_records(
    126,
    'm1-current-legacy-20260826-v1'
  );
end
$$;
