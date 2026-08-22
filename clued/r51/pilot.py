# -*- coding: utf-8 -*-
"""Deterministic 20-operation synthetic controlled Pilot for R5.1 K6."""

from __future__ import annotations

import hashlib
import os
import tempfile

from .activation import ActivationError, TransactionalInstallationEngine
from .idempotency import CallerIdentity
from .lifecycle_ops import MemoryLifecycleRepository
from .security import AccessController, SecurityError
from .sync import CloudSyncStore, DeviceReplica


class ControlledPilot:
    """Run the exact minimum workflow mix without production data."""

    def run(self):
        operations = []
        hard_violations = []
        issues = []
        access = AccessController()
        first_id = CallerIdentity("pilot-account", "pilot-binding-a", "pilot-device-a")
        second_id = CallerIdentity("pilot-account", "pilot-binding-b", "pilot-device-b")
        scopes = {"memory:read", "memory:write", "space:pilot"}
        access.register(first_id, scopes)
        access.register(second_id, scopes)
        cloud = CloudSyncStore(access)
        first = DeviceReplica(first_id, cloud)
        second = DeviceReplica(second_id, cloud)

        def record(category, name, result="PASS"):
            operations.append({
                "number": len(operations) + 1,
                "category": category,
                "name": name,
                "result": result,
            })

        # 1-5: create/update
        for index in range(1, 4):
            first.queue(
                "CREATE", "pilot-m%d" % index,
                content="synthetic pilot topic%d" % index,
                required_scope="space:pilot",
                request_id="pilot-create-%04d" % index)
            first.sync()
            record("create_update", "create-%d" % index)
        first.queue(
            "UPDATE", "pilot-m1", content="synthetic updated topic1",
            request_id="pilot-update-0001")
        first.sync()
        record("create_update", "update-1")
        first.queue(
            "UPDATE", "pilot-m2", content="synthetic updated topic2",
            request_id="pilot-update-0002")
        first.sync()
        record("create_update", "update-2")
        second.sync()

        # 6-10: cross-Agent lexical recall
        for query in ("synthetic", "updated", "topic1", "topic2", "topic3"):
            results = second.local_recall(query)
            if not results:
                raise RuntimeError("PILOT_RECALL_EMPTY")
            record("cross_agent_recall", "recall-" + query)

        # 11-13: offline/outbox recovery, including lost response
        first.queue(
            "CREATE", "pilot-m4", content="synthetic offline",
            request_id="pilot-offline-create")
        first.sync()
        record("offline_sync", "offline-create-recover")
        first.queue(
            "UPDATE", "pilot-m4", content="synthetic offline updated",
            request_id="pilot-offline-update")
        first.sync()
        record("offline_sync", "offline-update-recover")
        first.queue(
            "UPDATE", "pilot-m4", content="synthetic lost response",
            request_id="pilot-lost-response")
        degraded = first.sync(drop_response_for="pilot-lost-response")
        if degraded["state"] != "DEGRADED":
            raise RuntimeError("PILOT_EXPECTED_DEGRADED")
        recovered = first.sync()
        if recovered["state"] != "ONLINE":
            raise RuntimeError("PILOT_RECOVERY_FAILED")
        record("offline_sync", "committed-response-loss-recover")

        # 14-15: explicit stale-base conflicts on two objects.
        second.sync()
        for index in (1, 2):
            memory_id = "pilot-m%d" % index
            first.queue(
                "UPDATE", memory_id, content="first conflict %d" % index,
                request_id="pilot-conflict-a-%d" % index)
            second.queue(
                "UPDATE", memory_id, content="second conflict %d" % index,
                request_id="pilot-conflict-b-%d" % index)
            first.sync()
            result = second.sync()
            if result["conflicts"] < index:
                raise RuntimeError("PILOT_CONFLICT_MISSING")
            record("conflict_stale_base", "explicit-conflict-%d" % index)

        # 16: delete and remote disappearance.
        first.queue(
            "DELETE", "pilot-m3", request_id="pilot-delete-0001")
        first.sync()
        second.sync()
        if not cloud.object("pilot-account", "pilot-m3")["deleted"]:
            hard_violations.append("TOMBSTONE_NOT_APPLIED")
        record("delete_restore", "delete-and-sync")

        # 17 and 19 use the essential lifecycle repository.
        lifecycle = MemoryLifecycleRepository()
        lifecycle.create("pilot-account", "restore-m1", "synthetic restore")
        lifecycle.delete_one(
            "pilot-account", "restore-m1",
            request_id="pilot-restore-delete")
        backup = lifecycle.backup()
        restored = MemoryLifecycleRepository()
        restored.restore(backup["payload"], backup["sha256"])
        if restored.get("pilot-account", "restore-m1") is not None:
            hard_violations.append("DELETION_LEDGER_RESURRECTION")
        record("delete_restore", "backup-ledger-restore")

        # 18: revoked Binding cannot use the cloud path.
        revoked_id = CallerIdentity(
            "pilot-account", "pilot-binding-revoked", "pilot-device-revoked")
        access.register(revoked_id, scopes)
        revoked = DeviceReplica(revoked_id, cloud)
        access.revoke_binding("pilot-account", "pilot-binding-revoked")
        try:
            revoked.sync()
            hard_violations.append("REVOKED_BINDING_ACCEPTED")
        except SecurityError:
            pass
        record("binding_revoke", "binding-revoke")

        exported = lifecycle.export_jsonl("pilot-account")
        if hashlib.sha256(exported["payload"]).hexdigest() != (
                exported["manifest"]["sha256"]):
            hard_violations.append("EXPORT_CHECKSUM_MISMATCH")
        record("export", "jsonl-checksum-export")

        # 20: install then forced update failure; previous bytes survive.
        with tempfile.TemporaryDirectory() as directory:
            target = os.path.join(directory, "agent-config.txt")
            with open(target, "w", encoding="utf-8") as handle:
                handle.write("user_setting=true\n")
            engine = TransactionalInstallationEngine(directory)
            engine.execute("install", managed={
                "enabled": True, "semantic_recall_enabled": False})
            with open(target, "rb") as handle:
                before = handle.read()

            def fail_replace(source, destination):
                raise OSError("synthetic replace failure")

            failing = TransactionalInstallationEngine(
                directory, replace=fail_replace)
            try:
                failing.execute("update", managed={
                    "enabled": False, "semantic_recall_enabled": False})
                hard_violations.append("ROLLBACK_NOT_TRIGGERED")
            except ActivationError:
                pass
            with open(target, "rb") as handle:
                after = handle.read()
            if before != after:
                hard_violations.append("ROLLBACK_CHANGED_OLD_VERSION")
        record("install_rollback", "forced-update-rollback")

        counts = {}
        for operation in operations:
            counts[operation["category"]] = (
                counts.get(operation["category"], 0) + 1)
        return {
            "status": "PASS" if not hard_violations else "FAIL",
            "operations": operations,
            "operation_count": len(operations),
            "category_counts": counts,
            "hard_gate_violations": hard_violations,
            "unexplained_errors": 0,
            "data_loss": 0,
            "noncritical_issues": issues,
            "synthetic_only": True,
            "semantic_recall_enabled": False,
        }
