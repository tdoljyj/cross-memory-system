# -*- coding: utf-8 -*-
"""Static and DB-API contract tests for Clued R5 Gate K3."""

import hashlib
import json
import os
import sys
import unittest
import uuid


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from clued.cloud_data import (CloudMemoryLifecycle, LifecycleError,
                              LIFECYCLE_MIGRATION_ID)
from clued.cloud_data import tooling
from clued.cloud_data.lifecycle import canonical_request_hash


UP = os.path.join(ROOT, "cloud", "postgres", "migrations",
                  "0002_memory_write_lifecycle.up.sql")
DOWN = os.path.join(ROOT, "cloud", "postgres", "migrations",
                    "0002_memory_write_lifecycle.down.sql")
CONTRACT = os.path.join(ROOT, "docs", "r5-kernel", "contracts",
                        "k3-memory-lifecycle-v1.json")


class FakeCursor(object):
    def __init__(self, row=None, error=None):
        self.row = row or ("CREATED", "m", "v", 1, None, False)
        self.error = error
        self.description = [(name,) for name in (
            "result_code", "result_memory_id", "result_version_id",
            "result_committed_seq", "result_conflict_group_id", "replayed")]
        self.statement = None
        self.params = None
        self.closed = False

    def execute(self, statement, params):
        self.statement = statement
        self.params = params
        if self.error:
            raise RuntimeError(self.error)

    def fetchone(self):
        return self.row

    def close(self):
        self.closed = True


class FakeConnection(object):
    def __init__(self, row=None, error=None):
        self.cursor_value = FakeCursor(row=row, error=error)
        self.commits = 0
        self.rollbacks = 0

    def cursor(self):
        return self.cursor_value

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


class K3LifecycleContractTests(unittest.TestCase):
    def read(self, path):
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()

    def test_01_contract_is_frozen_and_k2_foundation_is_required(self):
        contract = json.loads(self.read(CONTRACT))
        self.assertEqual("clued-kernel-r5-k3-memory-lifecycle/1.0.0",
                         contract["contract_id"])
        self.assertEqual("0001_cloud_data_foundation",
                         contract["foundation_migration"])
        self.assertEqual(LIFECYCLE_MIGRATION_ID,
                         contract["lifecycle_migration"])

    def test_02_operations_and_conflict_policy_are_explicit(self):
        contract = json.loads(self.read(CONTRACT))
        self.assertEqual(["CREATE", "UPDATE", "SUPERSEDE", "DELETE", "RESOLVE"],
                         contract["operations"])
        rules = contract["write_rules"]
        self.assertEqual("CONFLICT_REVIEW", rules["stale_write"])
        self.assertFalse(rules["last_write_wins"])
        self.assertTrue(rules["delete_wins_against_late_update"])
        self.assertTrue(rules["tombstone_blocks_resurrection"])

    def test_03_migration_is_atomic_and_reversible(self):
        up = self.read(UP)
        down = self.read(DOWN)
        self.assertTrue(up.startswith("BEGIN;"))
        self.assertTrue(up.rstrip().endswith("COMMIT;"))
        self.assertTrue(down.startswith("BEGIN;"))
        self.assertTrue(down.rstrip().endswith("COMMIT;"))
        self.assertIn("0002_memory_write_lifecycle", up)
        self.assertIn("DROP FUNCTION IF EXISTS clued.apply_memory_mutation", down)

    def test_04_service_cannot_bypass_lifecycle_functions(self):
        up = self.read(UP)
        self.assertIn("REVOKE INSERT, UPDATE, DELETE ON clued.memory_versions", up)
        self.assertIn("OWNER TO clued_lifecycle", up)
        self.assertIn("TO clued_service", up)
        self.assertIn("FROM PUBLIC", up)
        self.assertNotIn("TO clued_client;", up)

    def test_05_mutation_has_idempotency_and_account_serialization(self):
        up = self.read(UP)
        self.assertIn("clued.reserve_idempotency", up)
        self.assertIn("FOR UPDATE", up)
        self.assertIn("clued.allocate_committed_seq", up)
        self.assertIn("CONFLICT_REVIEW", up)
        self.assertNotIn("last-write-wins", up.lower())

    def test_06_request_hash_is_canonical_and_content_sensitive(self):
        first = canonical_request_hash({"b": 2, "a": "x"})
        second = canonical_request_hash({"a": "x", "b": 2})
        changed = canonical_request_hash({"a": "y", "b": 2})
        self.assertEqual(first, second)
        self.assertNotEqual(first, changed)
        self.assertEqual(64, len(first))
        self.assertEqual(first, hashlib.sha256(b'{"a":"x","b":2}').hexdigest())

    def test_07_create_uses_bound_parameters_and_commits_once(self):
        conn = FakeConnection()
        lifecycle = CloudMemoryLifecycle(conn)
        op = str(uuid.uuid4())
        result = lifecycle.create(
            account_id=str(uuid.uuid4()), binding_id=str(uuid.uuid4()),
            idempotency_key="create-key-0001", client_operation_id=op,
            space_id=str(uuid.uuid4()), content="synthetic",
            memory_type="PROJECT", scope="SPACE",
            truth_state="USER_EXPLICIT", confidence=1.0)
        self.assertEqual("CREATED", result["result_code"])
        self.assertEqual(1, conn.commits)
        self.assertEqual(0, conn.rollbacks)
        self.assertIn("apply_memory_mutation", conn.cursor_value.statement)
        self.assertEqual(24, len(conn.cursor_value.params))
        self.assertNotIn("synthetic", conn.cursor_value.statement)

    def test_08_generated_ids_are_stable_for_retry(self):
        op = str(uuid.uuid4())
        calls = []
        for _ in range(2):
            conn = FakeConnection()
            CloudMemoryLifecycle(conn).create(
                account_id=str(uuid.uuid4()), binding_id=str(uuid.uuid4()),
                idempotency_key="stable-key-0001", client_operation_id=op,
                space_id=str(uuid.uuid4()), content="synthetic",
                memory_type="PROJECT", scope="SPACE",
                truth_state="OBSERVED", confidence=0.8)
            calls.append(conn.cursor_value.params[8:11])
        self.assertEqual(calls[0], calls[1])

    def test_09_database_error_is_rolled_back_and_content_free(self):
        conn = FakeConnection(error="CLD-K3-CONFLICT-OPEN secret-body")
        with self.assertRaises(LifecycleError) as raised:
            CloudMemoryLifecycle(conn).delete(
                account_id=str(uuid.uuid4()), binding_id=str(uuid.uuid4()),
                idempotency_key="delete-key-0001",
                client_operation_id=str(uuid.uuid4()),
                memory_id=str(uuid.uuid4()), base_version_id=str(uuid.uuid4()))
        self.assertEqual("CLD-K3-CONFLICT-OPEN", raised.exception.code)
        self.assertNotIn("secret-body", str(raised.exception))
        self.assertEqual(1, conn.rollbacks)
        self.assertEqual(0, conn.commits)

    def test_10_invalid_operation_fails_before_database_access(self):
        conn = FakeConnection()
        with self.assertRaises(LifecycleError) as raised:
            CloudMemoryLifecycle(conn).mutate(
                account_id="a", binding_id="b", operation="MERGE",
                idempotency_key="invalid-key", client_operation_id=str(uuid.uuid4()))
        self.assertEqual("CLD-K3-OPERATION-INVALID", raised.exception.code)
        self.assertEqual(0, conn.commits)

    def test_11_tooling_exposes_separate_lifecycle_migration(self):
        parser = tooling.build_parser()
        args = parser.parse_args(["--dsn", "postgresql://example/test",
                                  "lifecycle-migrate", "up"])
        self.assertEqual("lifecycle-migrate", args.command)
        self.assertEqual("up", args.direction)
        self.assertTrue(tooling.LIFECYCLE_UP_SQL.endswith(
            "0002_memory_write_lifecycle.up.sql"))
        scan_args = parser.parse_args(
            ["--dsn", "postgresql://example/test", "lifecycle-scan"])
        self.assertEqual("lifecycle-scan", scan_args.command)

    def test_12_k3_does_not_unlock_later_gates(self):
        contract = json.loads(self.read(CONTRACT))
        self.assertFalse(contract["semantic_recall_enabled"])
        self.assertFalse(contract["release_authorized"])
        self.assertFalse(contract["deployment_authorized"])
        self.assertEqual("K5", contract["deferred"]["real_binding_and_jwt"])
        self.assertEqual("K7", contract["deferred"]["semantic_recall_and_pgvector"])
        self.assertEqual("K8", contract["deferred"]["physical_purge_and_pitr"])


if __name__ == "__main__":
    unittest.main()
