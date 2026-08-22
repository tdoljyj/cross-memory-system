# -*- coding: utf-8 -*-
"""R5.1 BE-06 Orca-style K3 idempotency invariants."""

import json
import os
import threading
import unittest

from clued.r51.idempotency import (
    CallerIdentity, IdempotencyConflict, MutationReceiptStore)


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
K3_SQL = os.path.join(
    ROOT, "cloud", "postgres", "migrations",
    "0002_memory_write_lifecycle.up.sql")


class BE06IdempotencyTests(unittest.TestCase):
    def setUp(self):
        self.caller = CallerIdentity("acct-a", "binding-a", "device-a")
        self.store = MutationReceiptStore(pending_wait_seconds=2)

    def test_01_exact_replay_returns_same_result_without_new_commit(self):
        calls = []
        payload = {"memory_id": "m1", "content": "synthetic"}
        first = self.store.execute(
            self.caller, "CREATE", "request-0001", payload,
            lambda: calls.append("commit") or {"version_id": "v1"})
        second = self.store.execute(
            self.caller, "CREATE", "request-0001", payload,
            lambda: calls.append("duplicate") or {"version_id": "v2"})
        self.assertFalse(first["replayed"])
        self.assertTrue(second["replayed"])
        self.assertEqual(first["result"], second["result"])
        self.assertEqual(["commit"], calls)

    def test_02_same_request_changed_payload_conflicts(self):
        self.store.execute(
            self.caller, "UPDATE", "request-0002",
            {"memory_id": "m1", "content": "first"}, lambda: {"ok": True})
        with self.assertRaises(IdempotencyConflict):
            self.store.execute(
                self.caller, "UPDATE", "request-0002",
                {"memory_id": "m1", "content": "changed"},
                lambda: {"ok": True})

    def test_03_same_request_changed_method_conflicts(self):
        payload = {"memory_id": "m1"}
        self.store.execute(
            self.caller, "UPDATE", "request-0003", payload,
            lambda: {"ok": True})
        with self.assertRaises(IdempotencyConflict):
            self.store.execute(
                self.caller, "DELETE", "request-0003", payload,
                lambda: {"ok": True})

    def test_04_binding_and_device_namespaces_are_independent(self):
        calls = []
        payload = {"memory_id": "m1"}
        callers = [
            self.caller,
            CallerIdentity("acct-a", "binding-b", "device-a"),
            CallerIdentity("acct-a", "binding-a", "device-b"),
        ]
        for index, caller in enumerate(callers):
            result = self.store.execute(
                caller, "UPDATE", "request-0004", payload,
                lambda i=index: calls.append(i) or {"version_id": str(i)})
            self.assertFalse(result["replayed"])
        self.assertEqual([0, 1, 2], calls)

    def test_05_committed_lost_response_replays_completed_result(self):
        payload = {"memory_id": "m1", "content": "synthetic"}
        self.store.reserve(
            self.caller, "CREATE", "request-0005", payload)
        self.store.commit(
            self.caller, "request-0005", {"version_id": "v-committed"})
        result = self.store.execute(
            self.caller, "CREATE", "request-0005", payload,
            lambda: self.fail("committed mutation executed twice"))
        self.assertTrue(result["replayed"])
        self.assertEqual("v-committed", result["result"]["version_id"])

    def test_06_concurrent_pending_replay_never_double_commits(self):
        started = threading.Event()
        release = threading.Event()
        calls = []
        results = []

        def mutation():
            calls.append("commit")
            started.set()
            self.assertTrue(release.wait(2))
            return {"version_id": "v-one"}

        def worker():
            results.append(self.store.execute(
                self.caller, "UPDATE", "request-0006",
                {"memory_id": "m1", "base_version_id": "v0"}, mutation))

        first = threading.Thread(target=worker)
        second = threading.Thread(target=worker)
        first.start()
        self.assertTrue(started.wait(2))
        second.start()
        release.set()
        first.join(3)
        second.join(3)
        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(["commit"], calls)
        self.assertEqual([False, True],
                         sorted(item["replayed"] for item in results))

    def test_07_stale_base_is_explicit_conflict_before_authoritative_write(self):
        with open(K3_SQL, "r", encoding="utf-8") as handle:
            sql = handle.read()
        stale = sql.index(
            "IF p_base_version_id IS DISTINCT FROM current_row.current_version_id")
        conflict_insert = sql.index(
            "INSERT INTO clued.conflict_groups(", stale)
        version_insert = sql.index(
            "INSERT INTO clued.memory_versions(", conflict_insert)
        self.assertLess(stale, conflict_insert)
        self.assertLess(conflict_insert, version_insert)
        self.assertIn("'CONFLICT'", sql[version_insert:version_insert + 900])
        self.assertNotIn("'ACTIVE'", sql[version_insert:version_insert + 900])

    def test_08_mutation_kinds_replay_without_duplicate_authoritative_event(self):
        calls = []
        for method in ("DELETE", "UPDATE", "RESOLVE_CONFLICT"):
            request = "request-" + method.lower().replace("_", "-")
            payload = {"memory_id": "m1", "base_version_id": "v1"}
            first = self.store.execute(
                self.caller, method, request, payload,
                lambda m=method: calls.append(m) or {"event": m})
            second = self.store.execute(
                self.caller, method, request, payload,
                lambda: self.fail("duplicate authoritative event"))
            self.assertFalse(first["replayed"])
            self.assertTrue(second["replayed"])
        self.assertEqual(["DELETE", "UPDATE", "RESOLVE_CONFLICT"], calls)

    def test_09_receipt_retention_covers_offline_outbox_replay(self):
        now = [1000.0]
        store = MutationReceiptStore(
            retention_seconds=20, max_offline_replay_seconds=10,
            clock=lambda: now[0])
        store.execute(
            self.caller, "CREATE", "request-0009", {"memory_id": "m1"},
            lambda: {"version_id": "v1"})
        now[0] += 19
        self.assertEqual(0, store.purge_expired())
        now[0] += 2
        self.assertEqual(1, store.purge_expired())
        with self.assertRaises(ValueError):
            MutationReceiptStore(
                retention_seconds=9, max_offline_replay_seconds=10)

    def test_10_receipt_metadata_never_contains_body_or_raw_payload(self):
        self.store.execute(
            self.caller, "CREATE", "request-0010",
            {"content": "secret-body", "token": "token-value"},
            lambda: {"content": "secret-result", "version_id": "v1"})
        serialized = json.dumps(self.store.export_metadata())
        self.assertNotIn("secret-body", serialized)
        self.assertNotIn("token-value", serialized)
        self.assertNotIn("secret-result", serialized)
        self.assertIn("payload_hash", serialized)


if __name__ == "__main__":
    unittest.main()
