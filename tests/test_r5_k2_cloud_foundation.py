# -*- coding: utf-8 -*-
"""Static contract tests for Clued R5 Gate K2 Cloud Data Foundation."""

import os
import re
import sys


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

UP = os.path.join(ROOT, "cloud", "postgres", "migrations",
                  "0001_cloud_data_foundation.up.sql")
DOWN = os.path.join(ROOT, "cloud", "postgres", "migrations",
                    "0001_cloud_data_foundation.down.sql")
SCAN = os.path.join(ROOT, "cloud", "postgres", "sql",
                    "scan_invariants.sql")
PG_CONF = os.path.join(ROOT, "cloud", "postgres", "postgresql.k2.conf")
ROLE_BOOTSTRAP = os.path.join(ROOT, "cloud", "postgres", "sql",
                              "bootstrap_roles.sql")

TENANT_TABLES = {
    "accounts", "memory_spaces", "devices", "bindings",
    "memory_versions", "memory_current", "change_events",
    "idempotency_records", "index_jobs", "memory_embeddings",
    "conflict_groups", "tombstones", "sync_acks", "export_jobs",
    "deletion_ledger", "audit_events",
}


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def read(path):
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


def table_body(sql, name):
    marker = "CREATE TABLE clued.%s (" % name
    start = sql.index(marker) + len(marker)
    depth = 1
    i = start
    while i < len(sql) and depth:
        if sql[i] == "(":
            depth += 1
        elif sql[i] == ")":
            depth -= 1
        i += 1
    return sql[start:i - 1]


def test_migration_is_atomic_and_versioned():
    up = read(UP).strip()
    down = read(DOWN).strip()
    check(up.startswith("BEGIN;") and up.endswith("COMMIT;"),
          "up migration must be one transaction")
    check(down.startswith("BEGIN;") and down.endswith("COMMIT;"),
          "down migration must be one transaction")
    check("current_setting('server_version_num')" in up,
          "PostgreSQL version preflight missing")
    check("0001_cloud_data_foundation" in up,
          "migration receipt missing")


def test_core_tables_and_tenant_keys():
    up = read(UP)
    created = set(re.findall(r"CREATE TABLE clued\.([a-z_]+)\s*\(", up))
    check(TENANT_TABLES.issubset(created),
          "missing core tables: %r" % sorted(TENANT_TABLES - created))
    for name in TENANT_TABLES:
        check(re.search(r"\baccount_id\s+uuid\b", table_body(up, name)),
              "%s lacks account_id UUID" % name)


def test_rls_is_enabled_forced_and_default_deny():
    up = read(UP)
    for token in ("ENABLE ROW LEVEL SECURITY", "FORCE ROW LEVEL SECURITY",
                  "CREATE POLICY tenant_isolation", "clued.current_account_id()"):
        check(token in up, "RLS contract missing: %s" % token)
    check("tenant_tables text[]" in up, "RLS table allowlist missing")
    for name in TENANT_TABLES:
        check("'%s'" % name in up, "RLS allowlist omits %s" % name)
    check("NOBYPASSRLS" in up and "clued_client" in up,
          "client must not bypass RLS")
    check("GRANT SELECT ON ALL TABLES IN SCHEMA clued TO clued_client" in up,
          "client read surface missing")
    check("INSERT" not in re.search(
        r"GRANT SELECT ON ALL TABLES IN SCHEMA clued TO clued_client;", up).group(0),
        "client unexpectedly received direct writes")


def test_service_role_and_client_are_separate():
    up = read(UP)
    check("ALTER ROLE clued_service" in up and "BYPASSRLS" in up,
          "restricted service role contract missing")
    check("GRANT clued_service TO clued_client" not in up,
          "client must never inherit service role")
    check("REVOKE UPDATE, DELETE ON clued.memory_versions" in up,
          "append-only privilege guard missing")


def test_cluster_roles_are_owned_and_down_is_scoped():
    up = read(UP)
    down = read(DOWN)
    bootstrap = read(ROLE_BOOTSTRAP)
    check("clued-k2-managed-v1" in up and "CLD_K2_RESERVED_ROLE_EXISTS" in up,
          "migration must reject unowned pre-existing cluster roles")
    check("shobj_description" in down and "clued-k2-managed-v1" in down,
          "down migration must only remove K2-managed roles")
    for token in ("CLD_K2_RESERVED_ROLE_EXISTS", "clued-k2-managed-v1",
                  "NOBYPASSRLS", "BYPASSRLS"):
        check(token in bootstrap, "restore role bootstrap missing %s" % token)


def test_committed_sequence_and_idempotency_primitives():
    up = read(UP)
    for signature in (
            "clued.allocate_committed_seq(p_account_id uuid)",
            "clued.reserve_idempotency(",
            "UNIQUE (account_id, committed_seq)",
            "UNIQUE (account_id, binding_id, idempotency_key)"):
        check(signature in up, "missing concurrency primitive: %s" % signature)
    check("ON CONFLICT (account_id, binding_id, idempotency_key) DO NOTHING" in up,
          "idempotency reservation must be atomic")


def test_version_chain_and_projection_contract():
    up = read(UP)
    versions = table_body(up, "memory_versions")
    current = table_body(up, "memory_current")
    for field in (
            "memory_id", "version_id", "content", "summary", "memory_type",
            "scope", "scope_refs", "status", "truth_state", "sensitivity",
            "source_type", "source_ref", "confidence", "valid_from",
            "valid_until", "supersedes_version_id", "conflict_group_id",
            "schema_version", "created_at", "created_by_binding_id",
            "committed_seq"):
        check(re.search(r"\b%s\b" % field, versions),
              "memory_versions missing %s" % field)
    check("clued.rebuild_memory_current" in up,
          "projection rebuild function missing")
    check("current_version_id" in current,
          "current projection lacks version pointer")


def test_immutable_history_guards():
    up = read(UP)
    for table in ("memory_versions", "change_events", "tombstones",
                  "deletion_ledger", "audit_events"):
        check("CREATE TRIGGER %s_immutable" % table in up,
              "%s immutable trigger missing" % table)
        check("ENABLE ALWAYS TRIGGER %s_immutable" % table in up,
              "%s trigger can be bypassed by replication mode" % table)
    check("CLD_K2_IMMUTABLE_ROW" in up,
          "stable immutable error missing")


def test_index_and_deletion_metadata_are_bound():
    up = read(UP)
    embeddings = table_body(up, "memory_embeddings")
    for field in ("model_id", "model_revision", "dimension",
                  "normalized_content_hash", "embedding"):
        check(re.search(r"\b%s\b" % field, embeddings),
              "embedding contract missing %s" % field)
    check("tombstone_version_id" in table_body(up, "tombstones"),
          "tombstone not bound to immutable version")
    check("proof_hash" in table_body(up, "deletion_ledger"),
          "deletion ledger proof missing")
    check("UNIQUE NULLS NOT DISTINCT" in table_body(up, "index_jobs"),
          "nullable model identity permits duplicate FTS index jobs")


def test_metadata_blocks_content_keys():
    up = read(UP)
    check("metadata_is_content_free" in up,
          "content-free metadata validator missing")
    for key in ("content", "summary", "query", "prompt", "secret", "token",
                "password", "authorization", "cookie"):
        check(key in up, "metadata blocklist missing %s" % key)


def test_invariant_scanner_covers_k2_contract():
    scan = read(SCAN)
    expected = {
        "tenant_table_missing_account_id", "rls_not_enabled_or_forced",
        "tenant_policy_missing", "immutable_trigger_missing",
        "change_event_sequence_gap", "current_projection_not_latest",
        "change_event_unresolvable_reference", "index_job_orphan_version",
        "embedding_contract_invalid", "deleted_memory_has_ready_index",
        "tombstone_not_authoritative_current", "deletion_ledger_invalid_proof",
        "unsafe_audit_metadata",
    }
    missing = {name for name in expected if name not in scan}
    check(not missing, "invariant scanner gaps: %r" % sorted(missing))
    check("c.relnamespace = n.oid" in scan,
          "schema-local checks can be confused by same-name public tables")


def test_down_migration_is_scoped_and_reversible():
    down = read(DOWN)
    check("DROP SCHEMA IF EXISTS clued CASCADE" in down,
          "down migration does not remove candidate schema")
    for role in ("clued_client", "clued_service", "clued_owner"):
        check("'%s'" % role in down,
              "down migration omits managed role %s" % role)
    check("DROP DATABASE" not in down and "DROP SCHEMA public" not in down,
          "down migration exceeds K2 scope")


def test_tooling_is_shell_free_and_redacts_credentials():
    from clued.cloud_data import tooling
    source = read(tooling.__file__)
    check("shell=True" not in source, "database tooling must not use a shell")
    sample = "postgresql://alice:example-value@localhost/db password=example-value"
    redacted = tooling.redact(sample)
    check("alice" not in redacted and "example-value" not in redacted,
          "connection credential redaction failed")
    check('"--no-privileges"' not in source,
          "backup/restore must preserve restricted-role ACLs")
    check("file_sha256" in source,
          "backup evidence must include an artifact digest")
    for token in ("bootstrap_roles", "--single-transaction",
                  "expected_sha256", "backup SHA-256 mismatch"):
        check(token in source, "safe restore contract missing %s" % token)


def test_module_entrypoint_propagates_failure_exit_codes():
    entrypoint = read(os.path.join(ROOT, "clued", "cloud_data", "__main__.py"))
    check("raise SystemExit(main())" in entrypoint,
          "python -m clued.cloud_data swallows main() failure exit codes")


def test_postgres_logging_contract_suppresses_body_text():
    conf = read(PG_CONF)
    expected = {
        "log_statement": "'none'",
        "log_min_error_statement": "'panic'",
        "log_parameter_max_length": "0",
        "log_parameter_max_length_on_error": "0",
    }
    for key, value in expected.items():
        check(re.search(r"(?m)^%s\s*=\s*%s\s*$" %
                        (re.escape(key), re.escape(value)), conf),
              "unsafe/missing PostgreSQL logging setting: %s" % key)


def test_k1_surface_and_semantic_gate_remain_unchanged():
    contract = read(os.path.join(ROOT, "docs", "r5-kernel", "contracts",
                                 "kernel-contract-v1.json"))
    check('"contract_version": "1.0.0"' in contract,
          "K1 contract was rewritten")
    check('"semantic_recall": "remains_disabled_and_not_product_qualified"' in contract,
          "semantic recall gate changed during K2")
    check("clued/cloud_data" not in read(os.path.join(ROOT, "clued", "controller.py")),
          "candidate cloud foundation was wired into real Controller")


TESTS = [
    test_migration_is_atomic_and_versioned,
    test_core_tables_and_tenant_keys,
    test_rls_is_enabled_forced_and_default_deny,
    test_service_role_and_client_are_separate,
    test_cluster_roles_are_owned_and_down_is_scoped,
    test_committed_sequence_and_idempotency_primitives,
    test_version_chain_and_projection_contract,
    test_immutable_history_guards,
    test_index_and_deletion_metadata_are_bound,
    test_metadata_blocks_content_keys,
    test_invariant_scanner_covers_k2_contract,
    test_down_migration_is_scoped_and_reversible,
    test_tooling_is_shell_free_and_redacts_credentials,
    test_module_entrypoint_propagates_failure_exit_codes,
    test_postgres_logging_contract_suppresses_body_text,
    test_k1_surface_and_semantic_gate_remain_unchanged,
]


def main():
    for test in TESTS:
        test()
        print("PASS %s" % test.__name__)
    print("K2 STATIC CONTRACT: %d/%d PASS" % (len(TESTS), len(TESTS)))


if __name__ == "__main__":
    main()
