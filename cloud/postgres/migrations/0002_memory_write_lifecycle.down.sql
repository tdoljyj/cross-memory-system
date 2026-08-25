BEGIN;

DELETE FROM clued.schema_migrations
 WHERE migration_id = '0002_memory_write_lifecycle';

GRANT SELECT, INSERT, UPDATE, DELETE ON clued.memory_versions,
  clued.memory_current, clued.conflict_groups, clued.change_events,
  clued.idempotency_records, clued.index_jobs, clued.tombstones,
  clued.audit_events TO clued_service;
REVOKE UPDATE, DELETE ON clued.memory_versions, clued.change_events,
  clued.tombstones, clued.audit_events FROM clued_service;

DROP FUNCTION IF EXISTS clued.resolve_memory_conflict(
  uuid, uuid, text, uuid, text, uuid, uuid, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS clued.apply_memory_mutation(
  uuid, uuid, text, text, uuid, text, uuid, uuid, uuid, uuid, uuid, uuid,
  text, text, text, jsonb, text, text, text, text, numeric, timestamptz,
  timestamptz, text);

DO $clued_k3_role_cleanup$
DECLARE
  role_marker text;
BEGIN
  SELECT shobj_description(oid, 'pg_authid')
    INTO role_marker FROM pg_roles WHERE rolname = 'clued_lifecycle';
  IF FOUND AND role_marker = 'clued-k3-managed-v1' THEN
    DROP OWNED BY clued_lifecycle;
    DROP ROLE clued_lifecycle;
  ELSIF FOUND THEN
    RAISE EXCEPTION 'CLD_K3_RESERVED_ROLE_CHANGED:clued_lifecycle';
  END IF;
END
$clued_k3_role_cleanup$;

COMMIT;
