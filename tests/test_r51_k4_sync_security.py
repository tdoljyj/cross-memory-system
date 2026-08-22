# -*- coding: utf-8 -*-
"""R5.1 K4 executable sync, security and BE-02 probe scenarios."""

import os
import tempfile
import unittest

from clued.r51.idempotency import CallerIdentity
from clued.r51.probe import AdapterSelector, ProbeRunner
from clued.r51.security import (
    AccessController, BindingRevoked, DeviceRevoked, IPCIdentityError,
    IPCVerifier)
from clued.r51.sync import (
    ApplyCrash, CloudSyncStore, DeviceReplica, Unavailable)


class K4SyncSecurityTests(unittest.TestCase):
    def setUp(self):
        self.access = AccessController()
        self.caller1 = CallerIdentity("account-a", "binding-a", "device-a")
        self.caller2 = CallerIdentity("account-a", "binding-b", "device-b")
        scopes = {"memory:read", "memory:write", "space:alpha"}
        self.access.register(self.caller1, scopes)
        self.access.register(self.caller2, scopes)
        self.cloud = CloudSyncStore(self.access)
        self.first = DeviceReplica(self.caller1, self.cloud)
        self.second = DeviceReplica(self.caller2, self.cloud)

    def create_and_share(self):
        self.first.queue(
            "CREATE", "memory-1", content="synthetic alpha",
            required_scope="space:alpha", request_id="create-request-0001")
        self.first.sync()
        self.second.sync()

    def test_01_normal_incremental_pull_and_ack(self):
        self.create_and_share()
        self.assertEqual("synthetic alpha",
                         self.second.objects["memory-1"]["content"])
        self.assertEqual(1, self.second.cursor)
        self.assertEqual("cloud", self.second.status()["source"])

    def test_02_offline_create_recovers_in_outbox_order(self):
        self.first.queue(
            "CREATE", "memory-1", content="first",
            request_id="offline-create-0001")
        self.first.queue(
            "CREATE", "memory-2", content="second",
            request_id="offline-create-0002")
        result = self.first.sync()
        self.assertEqual(2, result["uploaded"])
        self.assertEqual(0, result["outbox"])
        self.assertEqual(
            ["memory-1", "memory-2"],
            [event["memory_id"]
             for event in self.cloud._events["account-a"]])

    def test_03_offline_update_recovers(self):
        self.create_and_share()
        self.second.queue(
            "UPDATE", "memory-1", content="updated offline",
            request_id="offline-update-0001")
        result = self.second.sync()
        self.assertEqual(1, result["uploaded"])
        self.assertEqual(
            "updated offline",
            self.cloud.object("account-a", "memory-1")["content"])

    def test_04_committed_but_lost_response_is_idempotent(self):
        request = self.first.queue(
            "CREATE", "memory-1", content="synthetic",
            request_id="lost-response-0001")
        first = self.first.sync(drop_response_for=request)
        self.assertEqual("DEGRADED", first["state"])
        self.assertEqual(1, len(self.first.outbox))
        second = self.first.sync()
        self.assertEqual("ONLINE", second["state"])
        self.assertEqual(0, len(self.first.outbox))
        self.assertEqual(1, self.cloud.event_count("account-a"))

    def test_05_two_logical_devices_produce_explicit_conflict(self):
        self.create_and_share()
        self.first.queue(
            "UPDATE", "memory-1", content="ours",
            request_id="device-a-update-0001")
        self.second.queue(
            "UPDATE", "memory-1", content="theirs",
            request_id="device-b-update-0001")
        self.first.sync()
        result = self.second.sync()
        self.assertEqual(1, result["conflicts"])
        conflict = self.second.conflicts[0]
        self.assertEqual("CONFLICT", conflict["status"])
        self.assertEqual(
            {"base", "ours", "theirs"},
            {"base", "ours", "theirs"} & set(conflict))

    def test_06_expired_cursor_uses_full_snapshot(self):
        self.first.queue(
            "CREATE", "memory-1", content="one",
            request_id="cursor-create-0001")
        self.first.sync()
        self.cloud.expire_cursors_before("account-a", 1)
        result = self.second.sync()
        self.assertEqual("cloud_full_snapshot", result["source"])
        self.assertIn("memory-1", self.second.objects)

    def test_07_local_apply_crash_is_safe_to_replay(self):
        self.first.queue(
            "CREATE", "memory-1", content="one",
            request_id="crash-create-0001")
        self.first.sync()
        with self.assertRaises(ApplyCrash):
            self.second.sync(crash_after_event=1)
        self.assertEqual(0, self.second.cursor)
        recovered = self.second.sync()
        self.assertEqual(1, recovered["cursor"])
        self.assertEqual("one", self.second.objects["memory-1"]["content"])

    def test_08_tombstone_beats_old_outbox(self):
        self.create_and_share()
        self.second.queue(
            "UPDATE", "memory-1", content="stale device write",
            request_id="stale-update-0001")
        self.first.queue(
            "DELETE", "memory-1", request_id="delete-request-0001")
        self.first.sync()
        result = self.second.sync()
        self.assertEqual(1, result["conflicts"])
        self.assertEqual(
            "TOMBSTONE_BLOCKED", self.second.conflicts[0]["status"])
        self.assertTrue(
            self.cloud.object("account-a", "memory-1")["deleted"])

    def test_09_device_revoke_locks_profile(self):
        self.access.revoke_device("account-a", "device-a")
        with self.assertRaises(DeviceRevoked):
            self.first.sync()
        self.assertEqual("LOCKED", self.first.state)

    def test_10_binding_revoke_locks_profile(self):
        self.access.revoke_binding("account-a", "binding-a")
        with self.assertRaises(BindingRevoked):
            self.first.sync()
        self.assertEqual("LOCKED", self.first.state)

    def test_11_ipc_impersonation_is_rejected(self):
        verifier = IPCVerifier(self.caller1, b"x" * 32)
        envelope = {
            "account_id": "account-a",
            "binding_id": "binding-a",
            "device_id": "device-a",
            "request_id": "ipc-request-0001",
        }
        envelope["signature"] = verifier.sign(envelope)
        verifier.verify(envelope)
        forged = dict(envelope)
        forged["device_id"] = "device-b"
        with self.assertRaises(IPCIdentityError):
            verifier.verify(forged)

    def test_12_degraded_fallback_does_not_expand_scope(self):
        self.first.objects["allowed"] = {
            "account_id": "account-a", "memory_id": "allowed",
            "content": "alpha visible", "deleted": False,
            "required_scope": "space:alpha"}
        self.first.objects["forbidden"] = {
            "account_id": "account-a", "memory_id": "forbidden",
            "content": "alpha hidden", "deleted": False,
            "required_scope": "space:beta"}
        original = self.cloud.pull
        self.cloud.pull = lambda caller, cursor: (_ for _ in ()).throw(
            Unavailable())
        try:
            result = self.first.sync()
        finally:
            self.cloud.pull = original
        self.assertEqual("DEGRADED", result["state"])
        ids = [item["memory_id"]
               for item in self.first.local_recall("alpha")]
        self.assertEqual(["allowed"], ids)


class BE02ProbeTests(unittest.TestCase):
    def test_real_probe_reads_without_mutating_protected_state(self):
        with tempfile.TemporaryDirectory() as directory:
            config = os.path.join(directory, "config.json")
            with open(config, "wb") as handle:
                handle.write(b'{"synthetic":true}')
            def read_probe():
                with open(config, "rb") as handle:
                    return handle.read() == b'{"synthetic":true}'

            result = ProbeRunner().run(
                "synthetic-adapter",
                read_probe,
                protected_paths=[config])
            self.assertEqual("AVAILABLE", result.status)
            with open(config, "rb") as handle:
                self.assertEqual(b'{"synthetic":true}', handle.read())

    def test_probe_mutation_is_denied_and_failure_is_isolated(self):
        with tempfile.TemporaryDirectory() as directory:
            config = os.path.join(directory, "config.json")
            with open(config, "wb") as handle:
                handle.write(b"before")

            def mutating_probe():
                with open(config, "wb") as handle:
                    handle.write(b"after")
                return True

            result = ProbeRunner().run(
                "bad-adapter", mutating_probe, protected_paths=[config])
            self.assertEqual("DENIED", result.status)
            selected = AdapterSelector().select([
                {"name": "bad", "probe": lambda: (_ for _ in ()).throw(
                    RuntimeError("Bearer secret-token"))},
                {"name": "good", "probe": lambda: True},
            ])
            self.assertEqual("good", selected["active_backend"])
            serialized = str(selected)
            self.assertNotIn("secret-token", serialized)


if __name__ == "__main__":
    unittest.main()
