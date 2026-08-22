SELECT 'k3_migration_ledger' AS invariant_name,
       CASE WHEN count(*) = 1 THEN 0 ELSE 1 END::bigint AS violation_count
  FROM clued.schema_migrations
 WHERE migration_id = '0002_memory_write_lifecycle'
UNION ALL
SELECT 'committed_idempotency_has_version_event', count(*)
  FROM clued.idempotency_records i
  LEFT JOIN clued.memory_versions v
    ON v.account_id = i.account_id
   AND v.version_id = i.result_version_id
  LEFT JOIN clued.change_events e
    ON e.account_id = i.account_id
   AND e.version_id = i.result_version_id
   AND e.committed_seq = i.committed_seq
 WHERE i.state = 'COMMITTED'
   AND (v.version_id IS NULL OR e.event_id IS NULL)
UNION ALL
SELECT 'deleted_current_has_matching_tombstone', count(*)
  FROM clued.memory_current c
  LEFT JOIN clued.tombstones t
    ON t.account_id = c.account_id
   AND t.memory_id = c.memory_id
   AND t.tombstone_version_id = c.current_version_id
   AND t.committed_seq = c.committed_seq
 WHERE c.status = 'DELETED' AND t.memory_id IS NULL
UNION ALL
SELECT 'tombstone_points_to_deleted_current', count(*)
  FROM clued.tombstones t
  LEFT JOIN clued.memory_current c
    ON c.account_id = t.account_id
   AND c.memory_id = t.memory_id
   AND c.current_version_id = t.tombstone_version_id
   AND c.status = 'DELETED'
 WHERE c.memory_id IS NULL
UNION ALL
SELECT 'open_conflict_matches_current_projection', count(*)
  FROM clued.conflict_groups g
  LEFT JOIN clued.memory_current c
    ON c.account_id = g.account_id
   AND c.memory_id = g.memory_id
   AND c.status = 'CONFLICT'
  LEFT JOIN clued.memory_versions v
    ON v.account_id = c.account_id
   AND v.version_id = c.current_version_id
   AND v.conflict_group_id = g.conflict_group_id
 WHERE g.status = 'OPEN'
   AND (c.memory_id IS NULL OR v.version_id IS NULL)
UNION ALL
SELECT 'resolved_conflict_winner_belongs_to_memory', count(*)
  FROM clued.conflict_groups g
  LEFT JOIN clued.memory_versions v
    ON v.account_id = g.account_id
   AND v.memory_id = g.memory_id
   AND v.version_id = g.winner_version_id
 WHERE g.status = 'RESOLVED' AND v.version_id IS NULL
UNION ALL
SELECT 'current_active_has_fts_job', count(*)
  FROM clued.memory_current c
  LEFT JOIN clued.index_jobs j
    ON j.account_id = c.account_id
   AND j.version_id = c.current_version_id
   AND j.index_kind = 'FTS'
 WHERE c.status = 'ACTIVE' AND j.job_id IS NULL
UNION ALL
SELECT 'noncurrent_fts_job_is_stale', count(*)
  FROM clued.index_jobs j
  JOIN clued.memory_versions v
    ON v.account_id = j.account_id AND v.version_id = j.version_id
  LEFT JOIN clued.memory_current c
    ON c.account_id = v.account_id
   AND c.memory_id = v.memory_id
   AND c.current_version_id = v.version_id
 WHERE j.index_kind = 'FTS' AND c.memory_id IS NULL AND j.state <> 'STALE'
UNION ALL
SELECT 'service_direct_dml_revoked',
       CASE WHEN has_table_privilege('clued_service', 'clued.memory_versions', 'INSERT')
                  OR has_table_privilege('clued_service', 'clued.memory_current', 'UPDATE')
                  OR has_table_privilege('clued_service', 'clued.change_events', 'INSERT')
            THEN 1 ELSE 0 END::bigint
UNION ALL
SELECT 'mutation_function_acl',
       CASE WHEN has_function_privilege(
                    'clued_service',
                    'clued.apply_memory_mutation(uuid,uuid,text,text,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb,text,text,text,text,numeric,timestamptz,timestamptz,text)',
                    'EXECUTE')
                  AND NOT has_function_privilege(
                    'clued_client',
                    'clued.apply_memory_mutation(uuid,uuid,text,text,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb,text,text,text,text,numeric,timestamptz,timestamptz,text)',
                    'EXECUTE')
                  AND NOT has_function_privilege(
                    'public',
                    'clued.apply_memory_mutation(uuid,uuid,text,text,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb,text,text,text,text,numeric,timestamptz,timestamptz,text)',
                    'EXECUTE')
            THEN 0 ELSE 1 END::bigint
UNION ALL
SELECT 'lifecycle_definer_role_hardened',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_roles
          WHERE rolname = 'clued_lifecycle'
            AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
            AND NOT rolcreaterole AND NOT rolinherit
            AND NOT rolreplication AND rolbypassrls
       ) THEN 0 ELSE 1 END::bigint
ORDER BY invariant_name;
