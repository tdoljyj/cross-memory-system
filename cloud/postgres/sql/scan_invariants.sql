WITH tenant_tables(table_name) AS (
  VALUES
    ('accounts'), ('memory_spaces'), ('devices'), ('bindings'),
    ('memory_versions'), ('memory_current'), ('change_events'),
    ('idempotency_records'), ('index_jobs'), ('memory_embeddings'),
    ('conflict_groups'), ('tombstones'), ('sync_acks'), ('export_jobs'),
    ('deletion_ledger'), ('audit_events')
),
immutable_tables(table_name, trigger_name) AS (
  VALUES
    ('memory_versions', 'memory_versions_immutable'),
    ('change_events', 'change_events_immutable'),
    ('tombstones', 'tombstones_immutable'),
    ('deletion_ledger', 'deletion_ledger_immutable'),
    ('audit_events', 'audit_events_immutable')
),
checks(invariant_name, violation_count) AS (
  SELECT 'tenant_table_missing_account_id', count(*)
  FROM tenant_tables expected
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'clued'
   AND c.table_name = expected.table_name
   AND c.column_name = 'account_id'
  WHERE c.column_name IS NULL

  UNION ALL
  SELECT 'rls_not_enabled_or_forced', count(*)
  FROM tenant_tables expected
  LEFT JOIN pg_namespace n ON n.nspname = 'clued'
  LEFT JOIN pg_class c
    ON c.relnamespace = n.oid
   AND c.relname = expected.table_name
  WHERE c.oid IS NULL OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity

  UNION ALL
  SELECT 'tenant_policy_missing', count(*)
  FROM tenant_tables expected
  LEFT JOIN pg_policies p
    ON p.schemaname = 'clued'
   AND p.tablename = expected.table_name
   AND p.policyname = 'tenant_isolation'
  WHERE p.policyname IS NULL

  UNION ALL
  SELECT 'immutable_trigger_missing', count(*)
  FROM immutable_tables expected
  LEFT JOIN pg_namespace n ON n.nspname = 'clued'
  LEFT JOIN pg_class c
    ON c.relnamespace = n.oid
   AND c.relname = expected.table_name
  LEFT JOIN pg_trigger t
    ON t.tgrelid = c.oid
   AND t.tgname = expected.trigger_name
   AND t.tgenabled = 'A'
   AND NOT t.tgisinternal
  WHERE t.oid IS NULL

  UNION ALL
  SELECT 'change_event_sequence_gap', count(*)
  FROM clued.accounts a
  CROSS JOIN LATERAL generate_series(1, a.committed_seq) AS expected(seq)
  LEFT JOIN clued.change_events e
    ON e.account_id = a.account_id AND e.committed_seq = expected.seq
  WHERE e.event_id IS NULL

  UNION ALL
  SELECT 'account_counter_behind_event', count(*)
  FROM clued.change_events e
  JOIN clued.accounts a USING (account_id)
  WHERE e.committed_seq > a.committed_seq

  UNION ALL
  SELECT 'current_projection_orphan_or_mismatch', count(*)
  FROM clued.memory_current c
  LEFT JOIN clued.memory_versions v
    ON v.account_id = c.account_id
   AND v.memory_id = c.memory_id
   AND v.version_id = c.current_version_id
  WHERE v.version_id IS NULL
     OR c.committed_seq <> v.committed_seq
     OR c.status <> v.status
     OR c.space_id <> v.space_id

  UNION ALL
  SELECT 'current_projection_not_latest', count(*)
  FROM clued.memory_current c
  JOIN (
    SELECT account_id, memory_id, max(committed_seq) AS latest_seq
    FROM clued.memory_versions GROUP BY account_id, memory_id
  ) latest USING (account_id, memory_id)
  WHERE c.committed_seq <> latest.latest_seq

  UNION ALL
  SELECT 'memory_missing_current_projection', count(*)
  FROM (SELECT DISTINCT account_id, memory_id FROM clued.memory_versions) v
  LEFT JOIN clued.memory_current c USING (account_id, memory_id)
  WHERE c.memory_id IS NULL

  UNION ALL
  SELECT 'change_event_unresolvable_reference', count(*)
  FROM clued.change_events e
  LEFT JOIN clued.memory_versions v
    ON v.account_id = e.account_id
   AND v.memory_id = e.memory_id
   AND v.version_id = e.version_id
  WHERE v.version_id IS NULL

  UNION ALL
  SELECT 'index_job_orphan_version', count(*)
  FROM clued.index_jobs j
  LEFT JOIN clued.memory_versions v
    ON v.account_id = j.account_id AND v.version_id = j.version_id
  WHERE v.version_id IS NULL

  UNION ALL
  SELECT 'embedding_contract_invalid', count(*)
  FROM clued.memory_embeddings e
  WHERE e.dimension <= 0
     OR array_ndims(e.embedding) <> 1
     OR cardinality(e.embedding) <> e.dimension
     OR e.normalized_content_hash !~ '^[0-9a-f]{64}$'
     OR e.model_id = '' OR e.model_revision = ''

  UNION ALL
  SELECT 'deleted_memory_has_ready_index', count(*)
  FROM clued.memory_current c
  JOIN clued.memory_versions v
    ON v.account_id = c.account_id AND v.memory_id = c.memory_id
  JOIN clued.index_jobs j
    ON j.account_id = v.account_id AND j.version_id = v.version_id
  WHERE c.status = 'DELETED' AND j.state = 'READY'

  UNION ALL
  SELECT 'open_conflict_has_winner', count(*)
  FROM clued.conflict_groups
  WHERE status = 'OPEN' AND winner_version_id IS NOT NULL

  UNION ALL
  SELECT 'resolved_conflict_missing_winner', count(*)
  FROM clued.conflict_groups
  WHERE status = 'RESOLVED' AND winner_version_id IS NULL

  UNION ALL
  SELECT 'tombstone_not_authoritative_current', count(*)
  FROM clued.tombstones t
  LEFT JOIN clued.memory_current c
    ON c.account_id = t.account_id AND c.memory_id = t.memory_id
  WHERE c.memory_id IS NULL
     OR c.status <> 'DELETED'
     OR c.current_version_id <> t.tombstone_version_id
     OR c.committed_seq < t.committed_seq

  UNION ALL
  SELECT 'deletion_ledger_invalid_proof', count(*)
  FROM clued.deletion_ledger
  WHERE proof_hash !~ '^[0-9a-f]{64}$'

  UNION ALL
  SELECT 'unsafe_audit_metadata', count(*)
  FROM clued.audit_events
  WHERE NOT clued.metadata_is_content_free(metadata)
)
SELECT invariant_name, violation_count
FROM checks
ORDER BY invariant_name;
