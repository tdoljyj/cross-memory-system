-- REVIEW PROPOSAL ONLY; NOT EXECUTED. Defaults to ROLLBACK.
-- Sole target: production Supabase project ccxsikzwxlolxqlosril.
-- Root must verify the selected provider project/connection before execution.
-- PostgreSQL current_database() alone does not prove the Supabase project ID.
-- Exact source: 21ec7475d3b42de63dc14c612688ec04fc4941da, unchanged v4 release.
-- Fixed new dedicated LOGIN: clued_release_turing. Never adopt an existing name.
-- No password value, URL or token belongs in this file or SQL-editor history.
-- After actual review/COMMIT, Owner sets the password through a protected masked
-- credential-management entry; PASSWORD NULL below leaves password auth unusable.
BEGIN;

DO $preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='clued_release_turing') THEN
    RAISE EXCEPTION 'clued_release_turing already exists: inspect, do not reuse or overwrite';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class
    WHERE oid='clued_private.currentness_transport_attestations'::regclass
      AND relkind='r' AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'existing attestation table with enabled RLS required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
    WHERE oid='clued_watchdog.projection_watchdog_snapshot()'::regprocedure
      AND prosecdef
  ) THEN
    RAISE EXCEPTION 'existing SECURITY DEFINER watchdog required';
  END IF;
END;
$preflight$;

CREATE ROLE clued_release_turing
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  PASSWORD NULL;

-- Connect only to the actual database in the verified production connection.
DO $connect$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO clued_release_turing',current_database());
END;
$connect$;

GRANT USAGE ON SCHEMA public,supabase_migrations,clued_watchdog,clued_private
  TO clued_release_turing;
GRANT SELECT (version,name,statements)
  ON supabase_migrations.schema_migrations TO clued_release_turing;
GRANT EXECUTE ON FUNCTION clued_watchdog.projection_watchdog_snapshot()
  TO clued_release_turing;

-- The original INSERT/ON CONFLICT UPDATE and consumer read use exactly these
-- seven columns. No DELETE/TRUNCATE, environment UPDATE or future-column grant.
GRANT SELECT (environment,source_commit,test_digest,all_paths_enforced,evidence,verified_at,verified_by),
      INSERT (environment,source_commit,test_digest,all_paths_enforced,evidence,verified_at,verified_by),
      UPDATE (source_commit,test_digest,all_paths_enforced,evidence,verified_at,verified_by)
  ON clued_private.currentness_transport_attestations TO clued_release_turing;

-- Three policies apply solely to the new role and production row. Existing RLS,
-- constraints, restrictive policies, ownership and every other role stay intact.
CREATE POLICY clued_release_turing_select_v1
  ON clued_private.currentness_transport_attestations FOR SELECT TO clued_release_turing
  USING (environment='production');
CREATE POLICY clued_release_turing_insert_v1
  ON clued_private.currentness_transport_attestations FOR INSERT TO clued_release_turing
  WITH CHECK (environment='production');
CREATE POLICY clued_release_turing_update_v1
  ON clued_private.currentness_transport_attestations FOR UPDATE TO clued_release_turing
  USING (environment='production') WITH CHECK (environment='production');

-- Original gate/G6 metadata reads normally use existing PUBLIC catalog rights.
-- Verify those rights, without attempting to change system-catalog ACLs.
DO $catalog$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('pg_catalog.pg_proc','oid'),('pg_catalog.pg_proc','pronamespace'),
      ('pg_catalog.pg_proc','proname'),('pg_catalog.pg_namespace','oid'),
      ('pg_catalog.pg_namespace','nspname'),('pg_catalog.pg_trigger','tgrelid'),
      ('pg_catalog.pg_trigger','tgname'),('pg_catalog.pg_trigger','tgenabled')
    ) AS needed(relation_name,column_name)
    WHERE NOT pg_catalog.has_column_privilege(
      'clued_release_turing',relation_name,column_name,'SELECT')
  ) OR NOT pg_catalog.has_function_privilege(
      'clued_release_turing','pg_catalog.pg_get_functiondef(oid)','EXECUTE') THEN
    RAISE EXCEPTION 'required existing catalog access missing: inspect without broad grants';
  END IF;
END;
$catalog$;

-- No grants of role membership, ownership, CREATE/DDL, ALL, database migration, Canonical
-- table access or alteration of PUBLIC grants. Like every role this LOGIN still
-- receives existing PUBLIC privileges; NOINHERIT does not remove PUBLIC access.
-- Therefore these statements prove the narrow added grants, not a full database
-- isolation audit. Existing PUBLIC exposure is not silently broadened/revoked.
-- Keep ROLLBACK for review. Root's reviewed execution must deliberately COMMIT;
-- password provisioning is a separate masked action, never an SQL literal here.
COMMIT;
