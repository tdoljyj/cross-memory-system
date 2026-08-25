# -*- coding: utf-8 -*-
"""R5.1 K6 BE-01/02/05 installation, Doctor, telemetry and Pilot tests."""

import contextlib
import io
import hashlib
import json
import os
import tempfile
import unittest
from unittest import mock

from clued.r51.activation import (
    ActivationError, LifecycleLock, SimulatedCrash,
    TransactionalInstallationEngine)
from clued.r51.pilot import ControlledPilot
from clued.r51.service import KernelService
from clued.r51.telemetry import TelemetryClient


class K6InstallationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = self.temporary.name
        self.target = os.path.join(self.root, "agent-config.txt")

    def read(self):
        if not os.path.isfile(self.target):
            return ""
        with open(self.target, "r", encoding="utf-8") as handle:
            return handle.read()

    def engine(self, **kwargs):
        return TransactionalInstallationEngine(self.root, **kwargs)

    def test_01_clean_install(self):
        result = self.engine().execute(
            "install", managed={"enabled": True})
        self.assertEqual("FINALIZED", result["state"])
        self.assertIn("# BEGIN CLUED MANAGED", self.read())
        self.assertIn('"enabled":true', self.read())

    def test_02_repeated_install_is_idempotent(self):
        engine = self.engine()
        first = engine.execute("install", managed={"enabled": True})
        second = engine.execute("install", managed={"enabled": True})
        self.assertFalse(first["idempotent"])
        self.assertTrue(second["idempotent"])
        self.assertEqual(first["target_sha256"],
                         second["target_sha256"])

    def test_03_update_replaces_only_managed_block(self):
        with open(self.target, "w", encoding="utf-8") as handle:
            handle.write("user_setting=keep\n")
        engine = self.engine()
        engine.execute("install", managed={"version": 1})
        engine.execute("update", managed={"version": 2})
        content = self.read()
        self.assertIn("user_setting=keep", content)
        self.assertIn('"version":2', content)
        self.assertNotIn('"version":1', content)

    def test_04_update_failure_rolls_back_old_version(self):
        engine = self.engine()
        engine.execute("install", managed={"version": 1})
        before = self.read()

        def fail_replace(source, destination):
            raise OSError("synthetic replace failure")

        with self.assertRaises(ActivationError) as raised:
            self.engine(replace=fail_replace).execute(
                "update", managed={"version": 2})
        self.assertEqual("TRANSACTION_ROLLED_BACK",
                         raised.exception.code)
        self.assertEqual(before, self.read())

    def test_05_repair_uses_same_transaction_state_machine(self):
        self.engine().execute("install", managed={"enabled": True})
        result = self.engine().execute(
            "repair", managed={"enabled": True, "repaired": True})
        self.assertEqual("FINALIZED", result["state"])
        self.assertIn('"repaired":true', self.read())

    def test_06_disable_and_enable_share_engine(self):
        service = KernelService(self.root)
        service.dispatch("install")
        service.dispatch("disable")
        self.assertIn('"enabled":false', self.read())
        service.dispatch("enable")
        self.assertIn('"enabled":true', self.read())

    def test_07_uninstall_preserves_non_clued_configuration(self):
        with open(self.target, "w", encoding="utf-8") as handle:
            handle.write("user_export_selection=keep\n")
        engine = self.engine()
        engine.execute("install", managed={"enabled": True})
        engine.execute("uninstall")
        content = self.read()
        self.assertEqual("user_export_selection=keep\n", content)
        self.assertNotIn("CLUED MANAGED", content)

    def test_08_symlink_or_reparse_target_is_rejected(self):
        with open(self.target, "w", encoding="utf-8") as handle:
            handle.write("safe=true\n")
        with mock.patch(
                "clued.r51.activation.os.path.islink",
                return_value=True):
            with self.assertRaises(ActivationError) as raised:
                self.engine().execute(
                    "install", managed={"enabled": True})
        self.assertEqual("LINK_TARGET_REJECTED", raised.exception.code)

    def test_09_replace_failure_never_loses_old_file(self):
        with open(self.target, "w", encoding="utf-8") as handle:
            handle.write("user_setting=original\n")
        before = self.read()
        failing = self.engine(
            replace=lambda source, destination: (
                _ for _ in ()).throw(OSError("replace failed")))
        with self.assertRaises(ActivationError):
            failing.execute("install", managed={"enabled": True})
        self.assertEqual(before, self.read())

    def test_10_committed_crash_is_recoverable(self):
        engine = self.engine()
        with self.assertRaises(SimulatedCrash):
            engine.execute(
                "install", managed={"enabled": True},
                simulate_crash_after_commit=True)
        recovered = self.engine().recover()
        self.assertEqual("FINALIZED", recovered["state"])
        self.assertTrue(recovered["recovered"])
        self.assertIn('"enabled":true', self.read())

    def test_11_manual_non_clued_edits_survive_repair(self):
        with open(self.target, "w", encoding="utf-8") as handle:
            handle.write("manual_before=1\n")
        engine = self.engine()
        engine.execute("install", managed={"version": 1})
        with open(self.target, "a", encoding="utf-8") as handle:
            handle.write("manual_after=2\n")
        engine.execute("repair", managed={"version": 1})
        content = self.read()
        self.assertIn("manual_before=1", content)
        self.assertIn("manual_after=2", content)

    def test_12_stale_lock_is_safely_recovered(self):
        lock_path = os.path.join(
            self.root, ".clued", "lifecycle", "lifecycle.lock")
        os.makedirs(os.path.dirname(lock_path))
        with open(lock_path, "w", encoding="utf-8") as handle:
            json.dump({
                "pid": 99999999, "created_at": 0,
                "token": "stale"}, handle)
        result = self.engine().execute(
            "install", managed={"enabled": True})
        self.assertEqual("FINALIZED", result["state"])
        self.assertFalse(os.path.exists(lock_path))


    def test_12a_abnormal_hard_link_count_is_rejected(self):
        with open(self.target, "w", encoding="utf-8") as handle:
            handle.write("safe=true\n")
        alias = os.path.join(self.root, "hardlink-alias.txt")
        os.link(self.target, alias)
        with self.assertRaises(ActivationError) as raised:
            self.engine().execute(
                "install", managed={"enabled": True})
        self.assertEqual("UNEXPECTED_LINK_COUNT", raised.exception.code)

    def test_12b_cli_and_conversation_share_kernel_service(self):
        from clued.r51.cli import run

        calls = []

        class FakeInstallation:
            def execute(self, action, managed=None):
                calls.append((action, managed))
                return {"state": "FINALIZED", "action": action}

            def recover(self):
                calls.append(("recover", None))
                return {"state": "FINALIZED"}

        service = KernelService(
            self.root, installation_engine=FakeInstallation())
        conversation = service.dispatch("install")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            exit_code = run(
                ["--root", self.root, "--json", "install"],
                service_factory=lambda root: service)
        self.assertEqual(0, exit_code)
        self.assertEqual("FINALIZED", conversation["state"])
        self.assertTrue(json.loads(output.getvalue())["ok"])
        self.assertEqual(["install", "install"],
                         [item[0] for item in calls])
class K6DoctorTelemetryTests(unittest.TestCase):

    def test_13_doctor_is_read_only_and_adapter_failure_is_isolated(self):
        with tempfile.TemporaryDirectory() as directory:
            protected = os.path.join(directory, "credentials.bin")
            with open(protected, "wb") as handle:
                handle.write(b"synthetic-credential")
            with open(protected, "rb") as handle:
                before = hashlib.sha256(handle.read()).hexdigest()

            def real_probe():
                with open(protected, "rb") as handle:
                    return bool(handle.read())

            service = KernelService(
                directory,
                adapter_candidates=[
                    {"name": "broken", "probe": lambda: (
                        _ for _ in ()).throw(RuntimeError("raw token"))},
                    {"name": "working", "probe": real_probe},
                ],
                protected_paths=[protected])
            result = service.doctor()
            with open(protected, "rb") as handle:
                after = hashlib.sha256(handle.read()).hexdigest()
            self.assertEqual(before, after)
            self.assertTrue(result["read_only"])
            self.assertEqual("working", result["active_backend"])
            self.assertEqual("AVAILABLE", result["status"])
            self.assertNotIn("raw token", json.dumps(result))

    def test_14_telemetry_allowlist_positive_path_and_buckets(self):
        sent = []
        client = TelemetryClient(
            lambda key, envelope: sent.append((key, envelope)),
            telemetry_key="synthetic-key", enabled=True, environment={})
        result = client.emit("sync_result", {
            "state": "ONLINE", "outbox_count": 3})
        self.assertTrue(result["sent"])
        self.assertEqual("le_5",
                         sent[0][1]["fields"]["outbox_count"])
        self.assertNotIn("synthetic-key", json.dumps(sent[0][1]))

    def test_15_unknown_and_sensitive_fields_are_dropped(self):
        sent = []
        client = TelemetryClient(
            lambda key, envelope: sent.append(envelope),
            telemetry_key="synthetic-key", enabled=True, environment={})
        self.assertEqual(
            "event_not_allowed",
            client.emit("memory_body", {"content": "secret"})["reason"])
        for field in (
                "content", "query", "path", "url", "exception", "token",
                "memory_id", "binding_id"):
            result = client.emit("sync_result", {
                "state": "ONLINE", "outbox_count": 0,
                field: "sensitive"})
            self.assertEqual("field_not_allowed", result["reason"])
        self.assertEqual([], sent)

    def test_16_dnt_ci_disabled_and_missing_key_gate_each_send(self):
        sent = []
        environment = {}
        client = TelemetryClient(
            lambda key, envelope: sent.append(envelope),
            telemetry_key="key", enabled=False, environment=environment)
        self.assertEqual("disabled", client.emit(
            "sync_result", {"state": "ONLINE", "outbox_count": 0})["reason"])
        client.enabled = True
        client.telemetry_key = None
        self.assertEqual("missing_key", client.emit(
            "sync_result", {"state": "ONLINE", "outbox_count": 0})["reason"])
        client.telemetry_key = "key"
        environment["DO_NOT_TRACK"] = "1"
        self.assertEqual("do_not_track", client.emit(
            "sync_result", {"state": "ONLINE", "outbox_count": 0})["reason"])
        environment.pop("DO_NOT_TRACK")
        environment["CI"] = "true"
        self.assertEqual("ci", client.emit(
            "sync_result", {"state": "ONLINE", "outbox_count": 0})["reason"])
        self.assertEqual([], sent)

    def test_17_telemetry_transport_failure_never_breaks_product(self):
        client = TelemetryClient(
            lambda key, envelope: (
                _ for _ in ()).throw(RuntimeError("network down")),
            telemetry_key="key", enabled=True, environment={})
        result = client.emit(
            "lifecycle_result",
            {"action": "install", "state": "FINALIZED",
             "duration_ms": 4})
        self.assertFalse(result["sent"])
        self.assertEqual("transport_failed", result["reason"])


class K6PilotTests(unittest.TestCase):
    def test_18_controlled_pilot_executes_required_twenty_operations(self):
        result = ControlledPilot().run()
        self.assertEqual("PASS", result["status"])
        self.assertEqual(20, result["operation_count"])
        self.assertEqual(5, result["category_counts"]["create_update"])
        self.assertEqual(5, result["category_counts"]["cross_agent_recall"])
        self.assertEqual(3, result["category_counts"]["offline_sync"])
        self.assertEqual(2, result["category_counts"]["conflict_stale_base"])
        self.assertEqual(2, result["category_counts"]["delete_restore"])
        self.assertEqual(1, result["category_counts"]["binding_revoke"])
        self.assertEqual(1, result["category_counts"]["export"])
        self.assertEqual(1, result["category_counts"]["install_rollback"])
        self.assertEqual([], result["hard_gate_violations"])
        self.assertEqual(0, result["data_loss"])
        self.assertEqual(0, result["unexplained_errors"])
        self.assertTrue(result["synthetic_only"])
        self.assertFalse(result["semantic_recall_enabled"])


if __name__ == "__main__":
    unittest.main()
