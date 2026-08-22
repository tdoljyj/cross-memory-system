BEGIN;

DO $clued_preflight$
BEGIN
  IF current_setting('server_version_num')::integer < 150000 THEN
    RAISE EXCEPTION 'CLD_K2_POSTGRES_VERSION_UNSUPPORTED';
  END IF;
END
$clued_preflight$;

DO $clued_roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clued_owner') THEN
    CREATE ROLE clued_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clued_client') THEN
    CREATE ROLE clued_client NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clued_service') THEN
    CREATE ROLE clued_service NOLOGIN;
  END IF;
END
$clued_roles$;

ALTER ROLE clued_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE clued_client NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE clued_service NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION BYPASSRLS;

CREATE SCHEMA clued AUTHORIZATION clued_owner;
REVOKE ALL ON SCHEMA clued FROM PUBLIC;

CREATE TABLE clued.schema_migrations (
  migration_id text PRIMARY KEY,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION clued.current_account_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $fn$
  SELECT nullif(current_setting('clued.account_id', true), '')::uuid
$fn$;

CREATE FUNCTION clued.reject_immutable_change()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'CLD_K2_IMMUTABLE_ROW';
END
$fn$;

CREATE FUNCTION clued.metadata_is_content_free(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $fn$
DECLARE
  item_key text;
  item_value jsonb;
  forbidden constant text[] := ARRAY[
    'content', 'summary', 'query', 'prompt', 'secret', 'token',
    'password', 'authorization', 'cookie'
  ];
BEGIN
  IF value IS NULL THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(value) = 'object' THEN
    FOR item_key, item_value IN SELECT key, val FROM jsonb_each(value) AS e(key, val)
    LOOP
      IF lower(item_key) = ANY(forbidden) THEN
        RETURN false;
      END IF;
      IF NOT clued.metadata_is_content_free(item_value) THEN
        RETURN false;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(value) = 'array' THEN
    FOR item_value IN SELECT element FROM jsonb_array_elements(value) AS a(element)
    LOOP
      IF NOT clued.metadata_is_content_free(item_value) THEN
        RETURN false;
      END IF;
    END LOOP;
  END IF;
  RETURN true;
END
$fn$;

CREATE TABLE clued.accounts (
  account_id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETION_PENDING', 'DELETED')),
  committed_seq bigint NOT NULL DEFAULT 0 CHECK (committed_seq >= 0),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE clued.memory_spaces (
  account_id uuid NOT NULL REFERENCES clued.accounts(account_id) ON DELETE RESTRICT,
  space_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'PERSONAL' CHECK (kind IN ('PERSONAL', 'PROJECT')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, space_id)
);

CREATE TABLE clued.devices (
  account_id uuid NOT NULL REFERENCES clued.accounts(account_id) ON DELETE RESTRICT,
  device_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  key_fingerprint text NOT NULL CHECK (length(key_fingerprint) BETWEEN 16 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  PRIMARY KEY (account_id, device_id),
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);

CREATE TABLE clued.bindings (
  account_id uuid NOT NULL REFERENCES clued.accounts(account_id) ON DELETE RESTRICT,
  binding_id uuid NOT NULL,
  device_id uuid NOT NULL,
  agent_type text NOT NULL CHECK (length(agent_type) BETWEEN 1 AND 64),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED', 'REVOKED')),
  scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  PRIMARY KEY (account_id, binding_id),
  FOREIGN KEY (account_id, device_id)
    REFERENCES clued.devices(account_id, device_id) ON DELETE RESTRICT,
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);

CREATE TABLE clued.memory_versions (
  account_id uuid NOT NULL REFERENCES clued.accounts(account_id) ON DELETE RESTRICT,
  memory_id uuid NOT NULL,
  version_id uuid NOT NULL,
  space_id uuid NOT NULL,
  content text NOT NULL CHECK (length(content) > 0),
  summary text,
  memory_type text NOT NULL CHECK (memory_type IN (
    'IDENTITY', 'PREFERENCE', 'PROJECT', 'HISTORY', 'CONSTRAINT', 'PROCEDURAL')),
  scope text NOT NULL CHECK (scope IN ('GLOBAL', 'SPACE', 'BINDING', 'SESSION')),
  scope_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN (
    'ACTIVE', 'CONFLICT', 'SUPERSEDED', 'DELETED', 'QUARANTINED')),
  truth_state text NOT NULL CHECK (truth_state IN (
    'USER_EXPLICIT', 'OBSERVED', 'INFERRED', 'UNVERIFIED')),
  sensitivity text NOT NULL DEFAULT 'NORMAL'
    CHECK (sensitivity IN ('NORMAL', 'SENSITIVE', 'SECRET_BLOCKED')),
  source_type text NOT NULL CHECK (length(source_type) BETWEEN 1 AND 64),
  source_ref text CHECK (source_ref IS NULL OR length(source_ref) <= 512),
  confidence numeric(5,4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  valid_from timestamptz,
  valid_until timestamptz,
  supersedes_version_id uuid,
  conflict_group_id uuid,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by_binding_id uuid NOT NULL,
  committed_seq bigint NOT NULL CHECK (committed_seq > 0),
  PRIMARY KEY (account_id, version_id),
  UNIQUE (account_id, committed_seq),
  UNIQUE (account_id, memory_id, version_id),
  FOREIGN KEY (account_id, space_id)
    REFERENCES clued.memory_spaces(account_id, space_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, created_by_binding_id)
    REFERENCES clued.bindings(account_id, binding_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, supersedes_version_id)
    REFERENCES clued.memory_versions(account_id, version_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from),
  CHECK (jsonb_typeof(scope_refs) = 'object')
);

CREATE TABLE clued.conflict_groups (
  account_id uuid NOT NULL REFERENCES clued.accounts(account_id) ON DELETE RESTRICT,
  conflict_group_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  winner_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  PRIMARY KEY (account_id, conflict_group_id),
  FOREIGN KEY (account_id, winner_version_id)
    REFERENCES clued.memory_versions(account_id, version_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK ((status = 'RESOLVED') = (winner_version_id IS NOT NULL)),
  CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL))
);

ALTER TABLE clued.memory_versions
  ADD CONSTRAINT memory_versions_conflict_group_fk
  FOREIGN KEY (account_id, conflict_group_id)
  REFERENCES clued.conflict_groups(account_id, conflict_group_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE clued.memory_current (
  account_id uuid NOT NULL REFERENCES clued.accounts(account_id) ON DELETE RESTRICT,
  memory_id uuid NOT NULL,
  current_version_id uuid NOT NULL,
  space_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN (
    'ACTIVE', 'CONFLICT', 'SUPERSEDED', 'DELETED', 'QUARANTINED')),
  truth_state text NOT NULL CHECK (truth_state IN (
    'USER_EXPLICIT', 'OBSERVED', 'INFERRED', 'UNVERIFIED')),
  sensitivity text NOT NULL CHECK (sensitivity IN ('NORMAL', 'SENSITIVE', 'SECRET_BLOCKED')),
  scope text NOT NULL CHECK (scope IN ('GLOBAL', 'SPACE', 'BINDING', 'SESSION')),
  scope_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  valid_from timestamptz,
  valid_until timestamptz,
  committed_seq bigint NOT NULL CHECK (committed_seq > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, memory_id),
  FOREIGN KEY (account_id, memory_id, current_version_id)
    REFERENCES clued.memory_versions(account_id, memory_id, version_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (account_id, space_id)
    REFERENCES clued.memory_spaces(account_id, space_id) ON DELETE RESTRICT
);

CREATE TABLE clued.change_events (
  account_id uuid NOT NULL REFERENCES clued.accounts(account_id) ON DELETE RESTRICT,
  event_id uuid NOT NULL,
  committed_seq bigint NOT NULL CHECK (committed_seq > 0),
  event_type text NOT NULL CHECK (event_type IN (
    'CREATED', 'UPDATED', 'SUPERSEDED', 'CONFLICTED', 'RESOLVED',
    'QUARANTINED', 'DELETED')),
  memory_id uuid NOT NULL,
  version_id uuid NOT NULL,
  actor_binding_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (clued.metadata_is_content_free(metadata)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, event_id),
  UNIQUE (account_id, committed_seq),
  FOREIGN KEY (account_id, memory_id, version_id)
    REFERENCES clued.memory_versions(account_id, memory_id, version_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (account_id, actor_binding_id)
    REFERENCES clued.bindings(account_id, binding_id) ON DELETE RESTRICT
);

CREATE TABLE clued.idempotency_records (
  account_id uuid NOT NULL REFERENCES clued.accounts(account_id) ON DELETE RESTRICT,
  idempotency_record_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  client_operation_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'RESERVED'
    CHECK (state IN ('RESERVED', 'COMMITTED', 'REJECTED')),
  result_memory_id uuid,
  result_version_id uuid,
  committed_seq bigint,
  response_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (account_id, idempotency_record_id),
  UNIQUE (account_id, binding_id, idempotency_key),
  UNIQUE (account_id, binding_id, client_operation_id),
  FOREIGN KEY (account_id, binding_id)
    REFERENCES clued.bindings(account_id, binding_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, result_version_id)
    REFERENCES clued.memory_versions(account_id, version_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (committed_seq IS NULL OR committed_seq > 0)
);

CREATE TABLE clued.index_jobs (
  account_id uuid NOT NULL REFERENCES clued.accounts(account_id) ON DELETE RESTRICT,
  job_id uuid NOT NULL,
  version_id uuid NOT NULL,
  index_kind text NOT NULL CHECK (index_kind IN ('FTS', 'EMBEDDING')),
  model_id text,
  model_revision text,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN (
    'PENDING', 'READY', 'FAILED', 'RETRYING', 'DEAD_LETTER', 'STALE')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code text,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, job_id),
  UNIQUE (account_id, version_id, index_kind, model_id, model_revision),
  FOREIGN KEY (account_id, version_id)
    REFERENCES clued.memory_versions(account_id, version_id) ON DELETE RESTRICT,
  CHECK ((index_kind = 'FTS' AND model_id IS NULL AND model_revision IS NULL)
      OR (index_kind = 'EMBEDDING' AND model_id IS NOT NULL AND model_revision IS NOT NULL))
);

CREATE TABLE clued.memory_embeddings (
  account_id uuid NOT NULL REFERENCES clued.accounts(account_id) ON DELETE RESTRICT,
  version_id uuid NOT NULL,
  model_id text NOT NULL,
  model_revision text NOT NULL,
  dimension integer NOT NULL CHECK (dimension > 0),
  normalized_content_hash text NOT NULL
    CHECK (normalized_content_hash ~ '^[0-9a-f]{64}$'),
  embedding real[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, version_id, model_id, model_revision),
  FOREIGN KEY (account_id, version_id)
    REFERENCES clued.memory_versions(account_id, version_id) ON DELETE RESTRICT,
  CHECK (array_ndims(embedding) = 1 AND cardinality(embedding) = dimension)
);

CREATE TABLE clued.tombstones (
  account_id uuid NOT NULL REFERENCES clued.accounts(account_id) ON DELETE RESTRICT,
  memory_id uuid NOT NULL,
  tombstone_version_id uuid NOT NULL,
  committed_seq bigint NOT NULL CHECK (committed_seq > 0),
  reason_code text NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 64),
  deleted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, memory_id),
  UNIQUE (account_id, committed_seq),
  FOREIGN KEY (account_id, memory_id, tombstone_version_id)
    REFERENCES clued.memory_versions(account_id, memory_id, version_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE clued.sync_acks (
  account_id uuid NOT NULL REFERENCES clued.accounts(account_id) ON DELETE RESTRICT,
  device_id uuid NOT NULL,
  acked_seq bigint NOT NULL DEFAULT 0 CHECK (acked_seq >= 0),
  acked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, device_id),
  FOREIGN KEY (account_id, device_id)
    REFERENCES clued.devices(account_id, device_id) ON DELETE RESTRICT
);

CREATE TABLE clued.export_jobs (
  account_id uuid NOT NULL REFERENCES clued.accounts(account_id) ON DELETE RESTRICT,
  export_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN (
    'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'EXPIRED')),
  object_key text CHECK (object_key IS NULL OR length(object_key) <= 512),
  artifact_hash text CHECK (artifact_hash IS NULL OR artifact_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  PRIMARY KEY (account_id, export_id)
);

CREATE TABLE clued.deletion_ledger (
  account_id uuid NOT NULL REFERENCES clued.accounts(account_id) ON DELETE RESTRICT,
  ledger_id uuid NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('MEMORY', 'SPACE', 'ACCOUNT')),
  subject_id uuid NOT NULL,
  committed_seq bigint NOT NULL CHECK (committed_seq > 0),
  state text NOT NULL DEFAULT 'RECORDED' CHECK (state IN (
    'RECORDED', 'PROPAGATING', 'COMPLETE', 'FAILED')),
  proof_hash text NOT NULL CHECK (proof_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (account_id, ledger_id),
  UNIQUE (account_id, committed_seq)
);

CREATE TABLE clued.audit_events (
  account_id uuid NOT NULL REFERENCES clued.accounts(account_id) ON DELETE RESTRICT,
  audit_event_id uuid NOT NULL,
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 96),
  actor_type text NOT NULL CHECK (actor_type IN ('BINDING', 'DEVICE', 'SERVICE', 'USER')),
  actor_id uuid,
  target_type text CHECK (target_type IS NULL OR length(target_type) <= 64),
  target_id uuid,
  request_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (clued.metadata_is_content_free(metadata)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, audit_event_id)
);

CREATE INDEX memory_versions_memory_seq_idx
  ON clued.memory_versions (account_id, memory_id, committed_seq DESC);
CREATE INDEX change_events_cursor_idx
  ON clued.change_events (account_id, committed_seq);
CREATE INDEX index_jobs_claim_idx
  ON clued.index_jobs (state, available_at, account_id);
CREATE INDEX idempotency_lookup_idx
  ON clued.idempotency_records (account_id, binding_id, idempotency_key);
CREATE INDEX tombstones_seq_idx
  ON clued.tombstones (account_id, committed_seq);
CREATE INDEX deletion_ledger_subject_idx
  ON clued.deletion_ledger (account_id, subject_type, subject_id);

CREATE FUNCTION clued.allocate_committed_seq(p_account_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = clued, pg_temp
AS $fn$
DECLARE
  allocated bigint;
BEGIN
  UPDATE clued.accounts
     SET committed_seq = committed_seq + 1
   WHERE account_id = p_account_id
     AND status <> 'DELETED'
  RETURNING committed_seq INTO allocated;
  IF allocated IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'CLD_K2_ACCOUNT_UNAVAILABLE';
  END IF;
  RETURN allocated;
END
$fn$;

CREATE FUNCTION clued.reserve_idempotency(
  p_account_id uuid,
  p_binding_id uuid,
  p_idempotency_key text,
  p_client_operation_id uuid,
  p_request_hash text,
  p_record_id uuid
)
RETURNS TABLE(idempotency_record_id uuid, state text, same_request boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = clued, pg_temp
AS $fn$
DECLARE
  row_record clued.idempotency_records%ROWTYPE;
BEGIN
  INSERT INTO clued.idempotency_records (
    account_id, idempotency_record_id, binding_id, idempotency_key,
    client_operation_id, request_hash)
  VALUES (
    p_account_id, p_record_id, p_binding_id, p_idempotency_key,
    p_client_operation_id, p_request_hash)
  ON CONFLICT (account_id, binding_id, idempotency_key) DO NOTHING;

  SELECT * INTO row_record
    FROM clued.idempotency_records r
   WHERE r.account_id = p_account_id
     AND r.binding_id = p_binding_id
     AND r.idempotency_key = p_idempotency_key;

  IF row_record.request_hash IS DISTINCT FROM p_request_hash THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'CLD_K2_IDEMPOTENCY_CONFLICT';
  END IF;

  RETURN QUERY SELECT row_record.idempotency_record_id,
                      row_record.state,
                      true;
END
$fn$;

CREATE FUNCTION clued.rebuild_memory_current(p_account_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = clued, pg_temp
AS $fn$
DECLARE
  rebuilt bigint;
BEGIN
  DELETE FROM clued.memory_current WHERE account_id = p_account_id;
  INSERT INTO clued.memory_current (
    account_id, memory_id, current_version_id, space_id, status, truth_state,
    sensitivity, scope, scope_refs, valid_from, valid_until, committed_seq,
    updated_at)
  SELECT DISTINCT ON (v.memory_id)
    v.account_id, v.memory_id, v.version_id, v.space_id, v.status,
    v.truth_state, v.sensitivity, v.scope, v.scope_refs, v.valid_from,
    v.valid_until, v.committed_seq, clock_timestamp()
  FROM clued.memory_versions v
  WHERE v.account_id = p_account_id
  ORDER BY v.memory_id, v.committed_seq DESC, v.created_at DESC, v.version_id DESC;
  GET DIAGNOSTICS rebuilt = ROW_COUNT;
  RETURN rebuilt;
END
$fn$;

CREATE TRIGGER memory_versions_immutable
BEFORE UPDATE OR DELETE ON clued.memory_versions
FOR EACH ROW EXECUTE FUNCTION clued.reject_immutable_change();
ALTER TABLE clued.memory_versions ENABLE ALWAYS TRIGGER memory_versions_immutable;

CREATE TRIGGER change_events_immutable
BEFORE UPDATE OR DELETE ON clued.change_events
FOR EACH ROW EXECUTE FUNCTION clued.reject_immutable_change();
ALTER TABLE clued.change_events ENABLE ALWAYS TRIGGER change_events_immutable;

CREATE TRIGGER tombstones_immutable
BEFORE UPDATE OR DELETE ON clued.tombstones
FOR EACH ROW EXECUTE FUNCTION clued.reject_immutable_change();
ALTER TABLE clued.tombstones ENABLE ALWAYS TRIGGER tombstones_immutable;

CREATE TRIGGER deletion_ledger_immutable
BEFORE UPDATE OR DELETE ON clued.deletion_ledger
FOR EACH ROW EXECUTE FUNCTION clued.reject_immutable_change();
ALTER TABLE clued.deletion_ledger ENABLE ALWAYS TRIGGER deletion_ledger_immutable;

CREATE TRIGGER audit_events_immutable
BEFORE UPDATE OR DELETE ON clued.audit_events
FOR EACH ROW EXECUTE FUNCTION clued.reject_immutable_change();
ALTER TABLE clued.audit_events ENABLE ALWAYS TRIGGER audit_events_immutable;

DO $clued_rls$
DECLARE
  table_name text;
  tenant_tables text[] := ARRAY[
    'accounts', 'memory_spaces', 'devices', 'bindings', 'memory_versions',
    'memory_current', 'change_events', 'idempotency_records', 'index_jobs',
    'memory_embeddings', 'conflict_groups', 'tombstones', 'sync_acks',
    'export_jobs', 'deletion_ledger', 'audit_events'
  ];
BEGIN
  FOREACH table_name IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE clued.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE clued.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON clued.%I FOR ALL TO clued_client, clued_owner '
      'USING (account_id = clued.current_account_id()) '
      'WITH CHECK (account_id = clued.current_account_id())', table_name);
  END LOOP;
END
$clued_rls$;

REVOKE ALL ON ALL TABLES IN SCHEMA clued FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA clued FROM PUBLIC;
GRANT USAGE ON SCHEMA clued TO clued_client, clued_service;
GRANT SELECT ON ALL TABLES IN SCHEMA clued TO clued_client;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA clued TO clued_service;
REVOKE UPDATE, DELETE ON clued.memory_versions, clued.change_events,
  clued.tombstones, clued.deletion_ledger, clued.audit_events FROM clued_service;
GRANT EXECUTE ON FUNCTION clued.current_account_id() TO clued_client, clued_service;
GRANT EXECUTE ON FUNCTION clued.metadata_is_content_free(jsonb) TO clued_client, clued_service;
GRANT EXECUTE ON FUNCTION clued.allocate_committed_seq(uuid) TO clued_service;
GRANT EXECUTE ON FUNCTION clued.reserve_idempotency(uuid, uuid, text, uuid, text, uuid)
  TO clued_service;
GRANT EXECUTE ON FUNCTION clued.rebuild_memory_current(uuid) TO clued_service;

ALTER DEFAULT PRIVILEGES FOR ROLE clued_owner IN SCHEMA clued
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE clued_owner IN SCHEMA clued
  REVOKE ALL ON FUNCTIONS FROM PUBLIC;

INSERT INTO clued.schema_migrations (migration_id, schema_version)
VALUES ('0001_cloud_data_foundation', 1);

COMMIT;
