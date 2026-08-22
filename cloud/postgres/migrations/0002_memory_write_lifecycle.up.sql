BEGIN;

DO $clued_k3_preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM clued.schema_migrations
     WHERE migration_id = '0001_cloud_data_foundation'
       AND schema_version = 1
  ) THEN
    RAISE EXCEPTION 'CLD_K3_FOUNDATION_REQUIRED';
  END IF;
END
$clued_k3_preflight$;

DO $clued_k3_role$
DECLARE
  role_marker text;
BEGIN
  SELECT shobj_description(oid, 'pg_authid')
    INTO role_marker
    FROM pg_roles
   WHERE rolname = 'clued_lifecycle';
  IF FOUND AND role_marker IS DISTINCT FROM 'clued-k3-managed-v1' THEN
    RAISE EXCEPTION 'CLD_K3_RESERVED_ROLE_EXISTS:clued_lifecycle';
  END IF;
  IF NOT FOUND THEN
    CREATE ROLE clued_lifecycle NOLOGIN;
  END IF;
  COMMENT ON ROLE clued_lifecycle IS 'clued-k3-managed-v1';
END
$clued_k3_role$;

ALTER ROLE clued_lifecycle NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION BYPASSRLS;

GRANT USAGE ON SCHEMA clued TO clued_lifecycle;
GRANT SELECT ON clued.accounts, clued.bindings, clued.memory_spaces,
  clued.memory_versions, clued.memory_current, clued.conflict_groups,
  clued.idempotency_records, clued.index_jobs, clued.tombstones
  TO clued_lifecycle;
GRANT UPDATE ON clued.accounts, clued.memory_current, clued.conflict_groups,
  clued.idempotency_records, clued.index_jobs TO clued_lifecycle;
GRANT INSERT ON clued.memory_versions, clued.memory_current,
  clued.conflict_groups, clued.change_events, clued.idempotency_records,
  clued.index_jobs, clued.tombstones, clued.audit_events TO clued_lifecycle;
GRANT EXECUTE ON FUNCTION clued.allocate_committed_seq(uuid),
  clued.reserve_idempotency(uuid, uuid, text, uuid, text, uuid),
  clued.metadata_is_content_free(jsonb) TO clued_lifecycle;

CREATE FUNCTION clued.apply_memory_mutation(
  p_account_id uuid,
  p_binding_id uuid,
  p_operation text,
  p_idempotency_key text,
  p_client_operation_id uuid,
  p_request_hash text,
  p_memory_id uuid,
  p_base_version_id uuid,
  p_new_version_id uuid,
  p_event_id uuid,
  p_conflict_group_id uuid,
  p_space_id uuid,
  p_content text,
  p_memory_type text,
  p_scope text,
  p_scope_refs jsonb,
  p_truth_state text,
  p_sensitivity text,
  p_source_type text,
  p_source_ref text,
  p_confidence numeric,
  p_valid_from timestamptz,
  p_valid_until timestamptz,
  p_reason_code text
)
RETURNS TABLE(
  result_code text,
  result_memory_id uuid,
  result_version_id uuid,
  result_committed_seq bigint,
  result_conflict_group_id uuid,
  replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = clued, pg_temp
AS $fn$
DECLARE
  idem clued.idempotency_records%ROWTYPE;
  current_row clued.memory_current%ROWTYPE;
  current_version clued.memory_versions%ROWTYPE;
  allocated bigint;
  event_kind text;
  next_status text := 'ACTIVE';
  next_content text;
  next_space_id uuid;
  next_memory_type text;
  next_scope text;
  next_scope_refs jsonb;
  next_truth_state text;
  next_sensitivity text;
  next_source_type text;
  next_source_ref text;
  next_confidence numeric;
  next_valid_from timestamptz;
  next_valid_until timestamptz;
  conflict_id uuid;
BEGIN
  IF p_operation NOT IN ('CREATE', 'UPDATE', 'SUPERSEDE', 'DELETE') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'CLD-K3-OPERATION-INVALID';
  END IF;
  IF p_request_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'CLD-K3-REQUEST-HASH-INVALID';
  END IF;
  IF length(p_idempotency_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'CLD-K3-IDEMPOTENCY-KEY-INVALID';
  END IF;

  PERFORM 1
    FROM clued.bindings b
   WHERE b.account_id = p_account_id
     AND b.binding_id = p_binding_id
     AND b.status = 'ACTIVE'
     AND 'memory:write' = ANY(b.scopes);
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'CLD-K3-WRITE-DENIED';
  END IF;

  BEGIN
    PERFORM * FROM clued.reserve_idempotency(
      p_account_id, p_binding_id, p_idempotency_key,
      p_client_operation_id, p_request_hash,
      p_event_id);
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'CLD-K3-OPERATION-ID-REUSED';
    WHEN raise_exception THEN
      IF SQLERRM = 'CLD_K2_IDEMPOTENCY_CONFLICT' THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
          MESSAGE = 'CLD-K3-IDEMPOTENCY-CONFLICT';
      END IF;
      RAISE;
  END;

  SELECT * INTO idem
    FROM clued.idempotency_records r
   WHERE r.account_id = p_account_id
     AND r.binding_id = p_binding_id
     AND r.idempotency_key = p_idempotency_key
   FOR UPDATE;

  IF idem.state = 'COMMITTED' THEN
    RETURN QUERY
    SELECT idem.response_code, idem.result_memory_id, idem.result_version_id,
           idem.committed_seq,
           (SELECT v.conflict_group_id
              FROM clued.memory_versions v
             WHERE v.account_id = p_account_id
               AND v.version_id = idem.result_version_id),
           true;
    RETURN;
  END IF;

  PERFORM 1 FROM clued.accounts a
   WHERE a.account_id = p_account_id AND a.status = 'ACTIVE'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'CLD-K3-ACCOUNT-UNAVAILABLE';
  END IF;

  SELECT * INTO current_row
    FROM clued.memory_current c
   WHERE c.account_id = p_account_id AND c.memory_id = p_memory_id
   FOR UPDATE;

  IF p_operation = 'CREATE' THEN
    IF FOUND OR EXISTS (
      SELECT 1 FROM clued.tombstones t
       WHERE t.account_id = p_account_id AND t.memory_id = p_memory_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'CLD-K3-MEMORY-EXISTS';
    END IF;
    IF p_base_version_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'CLD-K3-BASE-FORBIDDEN';
    END IF;
    next_content := p_content;
    next_space_id := p_space_id;
    next_memory_type := p_memory_type;
    next_scope := p_scope;
    next_scope_refs := COALESCE(p_scope_refs, '{}'::jsonb);
    next_truth_state := p_truth_state;
    next_sensitivity := p_sensitivity;
    next_source_type := p_source_type;
    next_source_ref := p_source_ref;
    next_confidence := p_confidence;
    next_valid_from := p_valid_from;
    next_valid_until := COALESCE(p_valid_until, current_version.valid_until);
    event_kind := 'CREATED';
  ELSE
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'CLD-K3-MEMORY-NOT-FOUND';
    END IF;

    SELECT * INTO current_version
      FROM clued.memory_versions v
     WHERE v.account_id = p_account_id
       AND v.version_id = current_row.current_version_id;

    IF current_row.status = 'DELETED' THEN
      UPDATE clued.idempotency_records
         SET state = 'COMMITTED', result_memory_id = p_memory_id,
             result_version_id = current_row.current_version_id,
             committed_seq = current_row.committed_seq,
             response_code = 'ALREADY_DELETED', completed_at = clock_timestamp()
       WHERE account_id = p_account_id
         AND idempotency_record_id = idem.idempotency_record_id;
      RETURN QUERY SELECT 'ALREADY_DELETED'::text, p_memory_id,
                          current_row.current_version_id,
                          current_row.committed_seq, NULL::uuid, false;
      RETURN;
    END IF;
    IF current_row.status = 'CONFLICT' THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'CLD-K3-CONFLICT-OPEN';
    END IF;
    IF p_base_version_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'CLD-K3-BASE-REQUIRED';
    END IF;
    PERFORM 1 FROM clued.memory_versions v
     WHERE v.account_id = p_account_id
       AND v.memory_id = p_memory_id
       AND v.version_id = p_base_version_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'CLD-K3-BASE-INVALID';
    END IF;

    next_space_id := current_version.space_id;
    next_memory_type := current_version.memory_type;
    next_scope := current_version.scope;
    next_scope_refs := current_version.scope_refs;
    next_truth_state := current_version.truth_state;
    next_sensitivity := current_version.sensitivity;
    next_source_type := COALESCE(p_source_type, current_version.source_type);
    next_source_ref := COALESCE(p_source_ref, current_version.source_ref);
    next_confidence := COALESCE(p_confidence, current_version.confidence);
    next_valid_from := COALESCE(p_valid_from, current_version.valid_from);
    next_valid_until := p_valid_until;

    IF p_base_version_id IS DISTINCT FROM current_row.current_version_id THEN
      IF p_conflict_group_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'CLD-K3-CONFLICT-ID-REQUIRED';
      END IF;
      allocated := clued.allocate_committed_seq(p_account_id);
      conflict_id := p_conflict_group_id;
      INSERT INTO clued.conflict_groups(
        account_id, conflict_group_id, memory_id)
      VALUES (p_account_id, conflict_id, p_memory_id);

      next_content := CASE WHEN p_operation = 'DELETE'
                           THEN current_version.content ELSE p_content END;
      INSERT INTO clued.memory_versions(
        account_id, memory_id, version_id, space_id, content, summary,
        memory_type, scope, scope_refs, status, truth_state, sensitivity,
        source_type, source_ref, confidence, valid_from, valid_until,
        supersedes_version_id, conflict_group_id, created_by_binding_id,
        committed_seq)
      VALUES (
        p_account_id, p_memory_id, p_new_version_id, next_space_id,
        next_content, NULL, next_memory_type, next_scope, next_scope_refs,
        'CONFLICT', next_truth_state, next_sensitivity, next_source_type,
        next_source_ref, next_confidence, next_valid_from, next_valid_until,
        p_base_version_id, conflict_id, p_binding_id, allocated);

      UPDATE clued.index_jobs
         SET state = 'STALE', updated_at = clock_timestamp()
       WHERE account_id = p_account_id
         AND version_id = current_row.current_version_id
         AND state <> 'STALE';
      UPDATE clued.memory_current
         SET current_version_id = p_new_version_id, status = 'CONFLICT',
             committed_seq = allocated, updated_at = clock_timestamp()
       WHERE account_id = p_account_id AND memory_id = p_memory_id;
      INSERT INTO clued.change_events(
        account_id, event_id, committed_seq, event_type, memory_id,
        version_id, actor_binding_id, metadata)
      VALUES (p_account_id, p_event_id, allocated, 'CONFLICTED', p_memory_id,
              p_new_version_id, p_binding_id,
              jsonb_build_object('operation', p_operation));
      INSERT INTO clued.audit_events(
        account_id, audit_event_id, event_type, actor_type, actor_id,
        target_type, target_id, request_id, metadata)
      VALUES (p_account_id, p_event_id, 'MEMORY_CONFLICTED', 'BINDING',
              p_binding_id, 'MEMORY', p_memory_id, p_client_operation_id,
              jsonb_build_object('operation', p_operation));
      UPDATE clued.idempotency_records
         SET state = 'COMMITTED', result_memory_id = p_memory_id,
             result_version_id = p_new_version_id, committed_seq = allocated,
             response_code = 'CONFLICT_REVIEW', completed_at = clock_timestamp()
       WHERE account_id = p_account_id
         AND idempotency_record_id = idem.idempotency_record_id;
      RETURN QUERY SELECT 'CONFLICT_REVIEW'::text, p_memory_id,
                          p_new_version_id, allocated, conflict_id, false;
      RETURN;
    END IF;

    IF p_operation = 'DELETE' THEN
      next_status := 'DELETED';
      next_content := '[deleted]';
      event_kind := 'DELETED';
      next_valid_until := COALESCE(p_valid_until, clock_timestamp());
    ELSE
      next_content := p_content;
      event_kind := CASE WHEN p_operation = 'SUPERSEDE'
                         THEN 'SUPERSEDED' ELSE 'UPDATED' END;
    END IF;
  END IF;

  IF next_content IS NULL OR length(next_content) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'CLD-K3-CONTENT-REQUIRED';
  END IF;

  allocated := clued.allocate_committed_seq(p_account_id);
  INSERT INTO clued.memory_versions(
    account_id, memory_id, version_id, space_id, content, summary,
    memory_type, scope, scope_refs, status, truth_state, sensitivity,
    source_type, source_ref, confidence, valid_from, valid_until,
    supersedes_version_id, created_by_binding_id, committed_seq)
  VALUES (
    p_account_id, p_memory_id, p_new_version_id, next_space_id, next_content,
    NULL, next_memory_type, next_scope, next_scope_refs, next_status,
    next_truth_state, next_sensitivity, next_source_type, next_source_ref,
    next_confidence, next_valid_from, next_valid_until,
    CASE WHEN p_operation = 'CREATE' THEN NULL ELSE p_base_version_id END,
    p_binding_id, allocated);

  IF p_operation = 'CREATE' THEN
    INSERT INTO clued.memory_current(
      account_id, memory_id, current_version_id, space_id, status,
      truth_state, sensitivity, scope, scope_refs, valid_from, valid_until,
      committed_seq)
    VALUES (
      p_account_id, p_memory_id, p_new_version_id, next_space_id, next_status,
      next_truth_state, next_sensitivity, next_scope, next_scope_refs,
      next_valid_from, next_valid_until, allocated);
  ELSE
    UPDATE clued.memory_current
       SET current_version_id = p_new_version_id, status = next_status,
           truth_state = next_truth_state, sensitivity = next_sensitivity,
           scope = next_scope, scope_refs = next_scope_refs,
           valid_from = next_valid_from, valid_until = next_valid_until,
           committed_seq = allocated, updated_at = clock_timestamp()
     WHERE account_id = p_account_id AND memory_id = p_memory_id;
    UPDATE clued.index_jobs
       SET state = 'STALE', updated_at = clock_timestamp()
     WHERE account_id = p_account_id
       AND version_id = current_row.current_version_id
       AND state <> 'STALE';
  END IF;

  INSERT INTO clued.change_events(
    account_id, event_id, committed_seq, event_type, memory_id, version_id,
    actor_binding_id, metadata)
  VALUES (
    p_account_id, p_event_id, allocated, event_kind, p_memory_id,
    p_new_version_id, p_binding_id,
    jsonb_build_object('operation', p_operation));

  INSERT INTO clued.audit_events(
    account_id, audit_event_id, event_type, actor_type, actor_id,
    target_type, target_id, request_id, metadata)
  VALUES (
    p_account_id, p_event_id, 'MEMORY_' || event_kind, 'BINDING',
    p_binding_id, 'MEMORY', p_memory_id, p_client_operation_id,
    jsonb_build_object('operation', p_operation));

  IF p_operation = 'DELETE' THEN
    INSERT INTO clued.tombstones(
      account_id, memory_id, tombstone_version_id, committed_seq, reason_code)
    VALUES (p_account_id, p_memory_id, p_new_version_id, allocated,
            COALESCE(NULLIF(p_reason_code, ''), 'USER_REQUEST'));
  ELSE
    INSERT INTO clued.index_jobs(
      account_id, job_id, version_id, index_kind, state)
    VALUES (p_account_id, p_event_id,
            p_new_version_id, 'FTS', 'PENDING');
  END IF;

  UPDATE clued.idempotency_records
     SET state = 'COMMITTED', result_memory_id = p_memory_id,
         result_version_id = p_new_version_id, committed_seq = allocated,
         response_code = event_kind, completed_at = clock_timestamp()
   WHERE account_id = p_account_id
     AND idempotency_record_id = idem.idempotency_record_id;

  RETURN QUERY SELECT event_kind, p_memory_id, p_new_version_id,
                      allocated, NULL::uuid, false;
END
$fn$;

CREATE FUNCTION clued.resolve_memory_conflict(
  p_account_id uuid,
  p_binding_id uuid,
  p_idempotency_key text,
  p_client_operation_id uuid,
  p_request_hash text,
  p_memory_id uuid,
  p_conflict_group_id uuid,
  p_winner_version_id uuid,
  p_resolution_version_id uuid,
  p_event_id uuid
)
RETURNS TABLE(
  result_code text,
  result_memory_id uuid,
  result_version_id uuid,
  result_committed_seq bigint,
  result_conflict_group_id uuid,
  replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = clued, pg_temp
AS $fn$
DECLARE
  idem clued.idempotency_records%ROWTYPE;
  group_row clued.conflict_groups%ROWTYPE;
  current_row clued.memory_current%ROWTYPE;
  winner clued.memory_versions%ROWTYPE;
  allocated bigint;
BEGIN
  PERFORM 1 FROM clued.bindings b
   WHERE b.account_id = p_account_id AND b.binding_id = p_binding_id
     AND b.status = 'ACTIVE' AND 'memory:write' = ANY(b.scopes);
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'CLD-K3-WRITE-DENIED';
  END IF;
  IF p_request_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'CLD-K3-REQUEST-HASH-INVALID';
  END IF;

  BEGIN
    PERFORM * FROM clued.reserve_idempotency(
      p_account_id, p_binding_id, p_idempotency_key,
      p_client_operation_id, p_request_hash,
      p_event_id);
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'CLD-K3-OPERATION-ID-REUSED';
    WHEN raise_exception THEN
      IF SQLERRM = 'CLD_K2_IDEMPOTENCY_CONFLICT' THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
          MESSAGE = 'CLD-K3-IDEMPOTENCY-CONFLICT';
      END IF;
      RAISE;
  END;
  SELECT * INTO idem FROM clued.idempotency_records r
   WHERE r.account_id = p_account_id AND r.binding_id = p_binding_id
     AND r.idempotency_key = p_idempotency_key FOR UPDATE;
  IF idem.state = 'COMMITTED' THEN
    RETURN QUERY SELECT idem.response_code, idem.result_memory_id,
      idem.result_version_id, idem.committed_seq, p_conflict_group_id, true;
    RETURN;
  END IF;

  PERFORM 1 FROM clued.accounts a
   WHERE a.account_id = p_account_id AND a.status = 'ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'CLD-K3-ACCOUNT-UNAVAILABLE';
  END IF;
  SELECT * INTO group_row FROM clued.conflict_groups g
   WHERE g.account_id = p_account_id
     AND g.conflict_group_id = p_conflict_group_id FOR UPDATE;
  IF NOT FOUND OR group_row.memory_id IS DISTINCT FROM p_memory_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'CLD-K3-CONFLICT-NOT-FOUND';
  END IF;
  IF group_row.status <> 'OPEN' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'CLD-K3-CONFLICT-RESOLVED';
  END IF;
  SELECT * INTO current_row FROM clued.memory_current c
   WHERE c.account_id = p_account_id AND c.memory_id = p_memory_id FOR UPDATE;
  IF NOT FOUND OR current_row.status <> 'CONFLICT' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'CLD-K3-CONFLICT-STATE';
  END IF;
  SELECT * INTO winner FROM clued.memory_versions v
   WHERE v.account_id = p_account_id AND v.memory_id = p_memory_id
     AND v.version_id = p_winner_version_id;
  IF NOT FOUND OR winner.status = 'DELETED' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'CLD-K3-WINNER-INVALID';
  END IF;

  allocated := clued.allocate_committed_seq(p_account_id);
  INSERT INTO clued.memory_versions(
    account_id, memory_id, version_id, space_id, content, summary,
    memory_type, scope, scope_refs, status, truth_state, sensitivity,
    source_type, source_ref, confidence, valid_from, valid_until,
    supersedes_version_id, conflict_group_id, created_by_binding_id,
    committed_seq)
  VALUES (
    p_account_id, p_memory_id, p_resolution_version_id, winner.space_id,
    winner.content, winner.summary, winner.memory_type, winner.scope,
    winner.scope_refs, 'ACTIVE', winner.truth_state, winner.sensitivity,
    'K3_CONFLICT_RESOLUTION', winner.source_ref, winner.confidence,
    winner.valid_from, winner.valid_until, current_row.current_version_id,
    p_conflict_group_id, p_binding_id, allocated);
  UPDATE clued.index_jobs
     SET state = 'STALE', updated_at = clock_timestamp()
   WHERE account_id = p_account_id
     AND version_id = current_row.current_version_id
     AND state <> 'STALE';
  UPDATE clued.memory_current
     SET current_version_id = p_resolution_version_id, status = 'ACTIVE',
         truth_state = winner.truth_state, sensitivity = winner.sensitivity,
         scope = winner.scope, scope_refs = winner.scope_refs,
         valid_from = winner.valid_from, valid_until = winner.valid_until,
         committed_seq = allocated, updated_at = clock_timestamp()
   WHERE account_id = p_account_id AND memory_id = p_memory_id;
  UPDATE clued.conflict_groups
     SET status = 'RESOLVED', winner_version_id = p_winner_version_id,
         resolved_at = clock_timestamp()
   WHERE account_id = p_account_id AND conflict_group_id = p_conflict_group_id;
  INSERT INTO clued.change_events(
    account_id, event_id, committed_seq, event_type, memory_id, version_id,
    actor_binding_id, metadata)
  VALUES (p_account_id, p_event_id, allocated, 'RESOLVED', p_memory_id,
          p_resolution_version_id, p_binding_id,
          jsonb_build_object('conflict_group_id', p_conflict_group_id));
  INSERT INTO clued.audit_events(
    account_id, audit_event_id, event_type, actor_type, actor_id,
    target_type, target_id, request_id, metadata)
  VALUES (p_account_id, p_event_id, 'MEMORY_RESOLVED', 'BINDING',
          p_binding_id, 'MEMORY', p_memory_id, p_client_operation_id,
          jsonb_build_object('conflict_group_id', p_conflict_group_id));
  INSERT INTO clued.index_jobs(account_id, job_id, version_id, index_kind, state)
  VALUES (p_account_id, p_event_id,
          p_resolution_version_id, 'FTS', 'PENDING');
  UPDATE clued.idempotency_records
     SET state = 'COMMITTED', result_memory_id = p_memory_id,
         result_version_id = p_resolution_version_id,
         committed_seq = allocated, response_code = 'RESOLVED',
         completed_at = clock_timestamp()
   WHERE account_id = p_account_id
     AND idempotency_record_id = idem.idempotency_record_id;
  RETURN QUERY SELECT 'RESOLVED'::text, p_memory_id,
                      p_resolution_version_id, allocated,
                      p_conflict_group_id, false;
END
$fn$;

ALTER FUNCTION clued.apply_memory_mutation(
  uuid, uuid, text, text, uuid, text, uuid, uuid, uuid, uuid, uuid, uuid,
  text, text, text, jsonb, text, text, text, text, numeric, timestamptz,
  timestamptz, text) OWNER TO clued_lifecycle;
ALTER FUNCTION clued.resolve_memory_conflict(
  uuid, uuid, text, uuid, text, uuid, uuid, uuid, uuid, uuid)
  OWNER TO clued_lifecycle;

REVOKE ALL ON FUNCTION clued.apply_memory_mutation(
  uuid, uuid, text, text, uuid, text, uuid, uuid, uuid, uuid, uuid, uuid,
  text, text, text, jsonb, text, text, text, text, numeric, timestamptz,
  timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION clued.resolve_memory_conflict(
  uuid, uuid, text, uuid, text, uuid, uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clued.apply_memory_mutation(
  uuid, uuid, text, text, uuid, text, uuid, uuid, uuid, uuid, uuid, uuid,
  text, text, text, jsonb, text, text, text, text, numeric, timestamptz,
  timestamptz, text) TO clued_service;
GRANT EXECUTE ON FUNCTION clued.resolve_memory_conflict(
  uuid, uuid, text, uuid, text, uuid, uuid, uuid, uuid, uuid)
  TO clued_service;

REVOKE INSERT, UPDATE, DELETE ON clued.memory_versions, clued.memory_current,
  clued.conflict_groups, clued.change_events, clued.idempotency_records,
  clued.index_jobs, clued.tombstones, clued.audit_events FROM clued_service;

INSERT INTO clued.schema_migrations(migration_id, schema_version)
VALUES ('0002_memory_write_lifecycle', 2);

COMMIT;
