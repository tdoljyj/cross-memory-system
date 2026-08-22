BEGIN;

DROP SCHEMA IF EXISTS clued CASCADE;

DO $clued_drop_roles$
DECLARE
  role_name text;
  role_marker text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['clued_client', 'clued_service', 'clued_owner'] LOOP
    SELECT shobj_description(oid, 'pg_authid')
      INTO role_marker
      FROM pg_roles
     WHERE rolname = role_name;
    IF FOUND AND role_marker = 'clued-k2-managed-v1' THEN
      EXECUTE format('DROP ROLE %I', role_name);
    END IF;
  END LOOP;
END
$clued_drop_roles$;

COMMIT;
