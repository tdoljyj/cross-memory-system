BEGIN;

DROP SCHEMA IF EXISTS clued CASCADE;

DO $clued_drop_roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clued_client') THEN
    DROP ROLE clued_client;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clued_service') THEN
    DROP ROLE clued_service;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clued_owner') THEN
    DROP ROLE clued_owner;
  END IF;
END
$clued_drop_roles$;

COMMIT;
