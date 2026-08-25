BEGIN;

DO $clued_roles$
DECLARE
  role_name text;
  role_marker text;
  managed_marker constant text := 'clued-k2-managed-v1';
BEGIN
  FOREACH role_name IN ARRAY ARRAY['clued_owner', 'clued_client', 'clued_service'] LOOP
    SELECT shobj_description(oid, 'pg_authid')
      INTO role_marker
      FROM pg_roles
     WHERE rolname = role_name;
    IF FOUND AND role_marker IS DISTINCT FROM managed_marker THEN
      RAISE EXCEPTION 'CLD_K2_RESERVED_ROLE_EXISTS:%', role_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clued_owner') THEN
    CREATE ROLE clued_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clued_client') THEN
    CREATE ROLE clued_client NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clued_service') THEN
    CREATE ROLE clued_service NOLOGIN;
  END IF;

  COMMENT ON ROLE clued_owner IS 'clued-k2-managed-v1';
  COMMENT ON ROLE clued_client IS 'clued-k2-managed-v1';
  COMMENT ON ROLE clued_service IS 'clued-k2-managed-v1';
END
$clued_roles$;

ALTER ROLE clued_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE clued_client NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE clued_service NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION BYPASSRLS;

COMMIT;
