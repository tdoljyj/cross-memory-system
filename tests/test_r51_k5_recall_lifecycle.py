# -*- coding: utf-8 -*-
"""R5.1 K5 safe recall, BE-03/04 and lifecycle verification."""

import hashlib
import json
import unittest

from clued.r51.idempotency import CallerIdentity
from clued.r51.lifecycle_ops import (
    LifecycleOpsError, MemoryLifecycleRepository)
from clued.r51.recall import (
    CloudFTSProvider, DeterministicIndexBuilder, GenerationBuildError,
    SafeRecallEngine)
from clued.r51.security import AccessController


class K5RecallTests(unittest.TestCase):
    def setUp(self):
        self.now = 2000.0
        self.caller = CallerIdentity("account-a", "binding-a", "device-a")
        self.access = AccessController()
        self.access.register(
            self.caller,
            {"memory:read", "memory:write", "space:alpha"})

    def document(self, object_id, content, **overrides):
        value = {
            "id": object_id,
            "account_id": "account-a",
            "version_id": "v-" + object_id,
            "content": content,
            "tags": [],
            "entities": [],
            "required_scope": "space:alpha",
            "status": "active",
            "truth_state": "USER_EXPLICIT",
            "sensitivity": "NORMAL",
            "valid_from": None,
            "valid_until": None,
        }
        value.update(overrides)
        return value

    def engine(self, documents, seq=10, previous=None):
        builder = DeterministicIndexBuilder(clock=lambda: self.now)
        generation = builder.build(
            lambda: documents, canonical_committed_seq=seq,
            parameters={"language": "mixed"}, previous=previous)
        return SafeRecallEngine(
            CloudFTSProvider(generation), self.access,
            canonical_committed_seq=seq, clock=lambda: self.now), generation

    def test_01_generation_manifest_binds_required_sources(self):
        documents = [self.document("m1", "alpha workflow")]
        _, generation = self.engine(documents)
        manifest = generation.manifest.public()
        self.assertEqual(10, manifest["canonical_committed_seq"])
        self.assertEqual("clued-cloud-fts/v1",
                         manifest["provider_or_extractor_identity"])
        self.assertEqual(1, manifest["schema_version"])
        for key in (
                "generation_id", "source_manifest_hash",
                "build_parameters_hash", "created_at"):
            self.assertIn(key, manifest)
        cache_key = next(iter(generation.cache))
        changed = DeterministicIndexBuilder(
            provider_identity="clued-cloud-fts/v2",
            clock=lambda: self.now).build(
                lambda: documents, canonical_committed_seq=10,
                parameters={"language": "mixed"})
        self.assertNotIn(cache_key, changed.cache)

    def test_02_source_change_or_interruption_never_becomes_current(self):
        stable = [self.document("m1", "stable input")]
        builder = DeterministicIndexBuilder(clock=lambda: self.now)
        current = builder.build(
            lambda: stable, canonical_committed_seq=1)
        calls = [0]

        def changing_source():
            calls[0] += 1
            if calls[0] == 1:
                return [self.document("m1", "first")]
            return [self.document("m1", "changed during build")]

        with self.assertRaises(GenerationBuildError):
            builder.build(changing_source, canonical_committed_seq=2)
        self.assertIs(current, builder.current)

    def test_03_cold_and_incremental_generations_are_equivalent(self):
        documents = [
            self.document("m1", "alpha release workflow"),
            self.document("m2", "beta recovery workflow"),
        ]
        cold_engine, cold = self.engine(documents)
        incremental_engine, incremental = self.engine(
            documents, previous=cold)
        self.assertEqual(cold.documents, incremental.documents)
        self.assertEqual(cold.tokens, incremental.tokens)
        cold_result = cold_engine.recall(
            self.caller, "recovery workflow")
        incremental_result = incremental_engine.recall(
            self.caller, "recovery workflow")
        self.assertEqual(
            [item["id"] for item in cold_result["results"]],
            [item["id"] for item in incremental_result["results"]])
        self.assertEqual(
            cold_result["trace"]["exclusions"],
            incremental_result["trace"]["exclusions"])

    def test_04_all_hard_rules_filter_before_ranking(self):
        documents = [
            self.document("allowed", "needle allowed"),
            self.document(
                "tenant", "needle tenant", account_id="account-b"),
            self.document(
                "binding", "needle binding",
                allowed_bindings=["binding-b"]),
            self.document(
                "scope", "needle scope", required_scope="space:beta"),
            self.document(
                "secret", "needle secret", sensitivity="SECRET"),
            self.document("deleted", "needle deleted", status="deleted"),
            self.document(
                "quarantine", "needle quarantine", status="quarantined"),
            self.document(
                "superseded", "needle superseded", status="superseded"),
            self.document(
                "loser", "needle loser", status="conflict_loser"),
            self.document(
                "truth", "needle truth", truth_state="REJECTED"),
            self.document(
                "future", "needle future", valid_from=self.now + 1),
            self.document(
                "expired", "needle expired", valid_until=self.now),
        ]
        engine, _ = self.engine(documents)
        result = engine.recall(self.caller, "needle")
        self.assertEqual(["allowed"],
                         [item["id"] for item in result["results"]])
        reasons = {
            item["reason"] for item in result["trace"]["exclusions"]}
        self.assertEqual({
            "CROSS_TENANT", "BINDING_DENIED", "SCOPE_DENIED", "SECRET",
            "DELETED", "QUARANTINED", "SUPERSEDED", "CONFLICT_LOSER",
            "TRUTH_REJECTED", "NOT_YET_VALID", "EXPIRED",
        }, reasons)

    def test_05_evidence_levels_have_machine_enforced_boundaries(self):
        engine, _ = self.engine(
            [self.document("m1", "alpha evidence")])
        preview = engine.recall(
            self.caller, "alpha", evidence_level="PREVIEW")
        self.assertTrue(preview["results"][0]["provisional"])
        self.assertTrue(preview["evidence_incomplete"])
        verified = engine.recall(self.caller, "alpha")
        self.assertEqual("VERIFIED", verified["evidence_level"])
        self.assertFalse(verified["results"][0]["provisional"])
        self.assertTrue(verified["evidence_incomplete"])
        audit = engine.recall(
            self.caller, "missing", evidence_level="AUDIT",
            audit_scope_complete=True, pagination_complete=True)
        self.assertEqual("NO_MEMORY", audit["status"])
        self.assertFalse(audit["evidence_incomplete"])
        self.assertTrue(audit["completeness_claim_allowed"])
        unverified = engine.recall(self.caller, "missing")
        self.assertFalse(unverified["completeness_claim_allowed"])

    def test_06_version_mismatch_is_excluded_in_verified_mode(self):
        engine, generation = self.engine(
            [self.document("m1", "alpha version")])
        engine.version_loader = lambda object_id: "newer-version"
        result = engine.recall(self.caller, "alpha")
        self.assertEqual([], result["results"])
        self.assertEqual(
            "SOURCE_VERSION_MISMATCH",
            result["trace"]["exclusions"][0]["reason"])
        preview = engine.recall(
            self.caller, "alpha", evidence_level="PREVIEW")
        self.assertEqual("m1", preview["results"][0]["id"])
        self.assertEqual(
            generation.manifest.generation_id,
            preview["trace"]["generation_id"])

    def test_07_trace_has_reasons_but_no_query_or_content(self):
        engine, _ = self.engine(
            [self.document("m1", "private synthetic phrase")])
        result = engine.recall(self.caller, "private synthetic")
        serialized = json.dumps(result["trace"])
        self.assertNotIn("private synthetic", serialized)
        self.assertNotIn("private synthetic phrase", serialized)
        self.assertIn("query_hash", serialized)
        self.assertIn("SELECTED", serialized)

    def test_08_thirty_query_sanity_set_places_expected_in_top_five(self):
        documents = [
            self.document(
                "sanity-%02d" % index,
                "workflow topic%02d expected synthetic" % index)
            for index in range(30)
        ]
        engine, _ = self.engine(documents, seq=30)
        hits = 0
        for index in range(30):
            expected = "sanity-%02d" % index
            result = engine.recall(
                self.caller, "topic%02d" % index)
            if expected in [item["id"] for item in result["results"][:5]]:
                hits += 1
        self.assertGreaterEqual(hits, 27)
        self.assertEqual(30, hits)
        self.assertFalse(engine.semantic_recall_enabled)

    def test_09_stale_generation_is_explicitly_degraded(self):
        engine, _ = self.engine(
            [self.document("m1", "alpha stale")], seq=10)
        engine.canonical_committed_seq = 11
        result = engine.recall(self.caller, "alpha")
        self.assertEqual("DEGRADED", result["freshness"]["status"])
        self.assertTrue(result["evidence_incomplete"])


class K5LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.repo = MemoryLifecycleRepository(clock=lambda: 2000.0)
        self.repo.create("account-a", "m1", "synthetic one")
        self.repo.create("account-a", "m2", "synthetic two")

    def test_10_single_view_edit_delete_and_jsonl_empty_import(self):
        self.assertEqual("synthetic one",
                         self.repo.get("account-a", "m1")["content"])
        self.repo.edit("account-a", "m1", "edited synthetic")
        exported = self.repo.export_jsonl("account-a")
        target = MemoryLifecycleRepository(clock=lambda: 2000.0)
        result = target.import_jsonl(
            exported["payload"], exported["manifest"])
        self.assertEqual(2, result["count"])
        self.assertEqual("edited synthetic",
                         target.get("account-a", "m1")["content"])
        self.repo.delete_one(
            "account-a", "m1", request_id="delete-request-0001")
        self.assertIsNone(self.repo.get("account-a", "m1"))
        self.assertEqual(["m2"], [
            item["id"] for item in self.repo.recallable("account-a")])

    def test_11_export_checksum_and_count_are_mandatory(self):
        exported = self.repo.export_jsonl("account-a")
        corrupt = exported["payload"] + b"x"
        with self.assertRaises(LifecycleOpsError):
            self.repo.parse_jsonl(corrupt, exported["manifest"])
        manifest = dict(exported["manifest"])
        manifest["count"] = 99
        with self.assertRaises(LifecycleOpsError):
            self.repo.parse_jsonl(exported["payload"], manifest)

    def test_12_account_delete_is_retryable_without_ledger_duplication(self):
        first = self.repo.delete_account(
            "account-a", request_id="account-delete-0001")
        second = self.repo.delete_account(
            "account-a", request_id="account-delete-0001")
        self.assertEqual(2, first["deleted_count"])
        self.assertTrue(second["replayed"])
        self.assertEqual(2, len(self.repo.deletion_ledger))
        self.assertEqual([], self.repo.recallable("account-a"))

    def test_13_restore_replays_deletion_ledger_before_index_build(self):
        self.repo.delete_one(
            "account-a", "m1", request_id="delete-before-backup")
        backup = self.repo.backup()
        value = json.loads(backup["payload"].decode("utf-8"))
        for item in value["objects"]:
            if item["id"] == "m1":
                item["content"] = "stale resurrected body"
                item["deleted"] = False
                item["status"] = "active"
        tampered = json.dumps(
            value, sort_keys=True, separators=(",", ":")).encode("utf-8")
        digest = hashlib.sha256(tampered).hexdigest()
        observed = {}

        def rebuild(objects):
            observed["objects"] = list(objects)
            deleted = [
                item for item in observed["objects"] if item["id"] == "m1"][0]
            self.assertTrue(deleted["deleted"])
            self.assertIsNone(deleted["content"])
            return {"generation": "rebuilt"}

        target = MemoryLifecycleRepository(clock=lambda: 2000.0)
        result = target.restore(
            tampered, digest, rebuild_index=rebuild)
        self.assertEqual("READY", target.state)
        self.assertEqual("RESTORED", result["status"])
        self.assertIsNone(target.get("account-a", "m1"))
        self.assertEqual(["m2"], [
            item["id"] for item in target.recallable("account-a")])

    def test_14_restore_failure_blocks_normal_reads(self):
        backup = self.repo.backup()

        def fail_rebuild(objects):
            raise RuntimeError("synthetic rebuild failure")

        target = MemoryLifecycleRepository(clock=lambda: 2000.0)
        with self.assertRaises(RuntimeError):
            target.restore(
                backup["payload"], backup["sha256"],
                rebuild_index=fail_rebuild)
        self.assertEqual("RECOVERY_NEEDED", target.state)
        with self.assertRaises(LifecycleOpsError):
            target.recallable("account-a")


class _FTSCursor:
    def __init__(self, error=None):
        self.error = error
        self.statement = None
        self.params = None
        self.description = [
            ("id",), ("version_id",), ("content",), ("score",)]
        self.closed = False

    def execute(self, statement, params):
        self.statement = statement
        self.params = params
        if self.error:
            raise RuntimeError(self.error)

    def fetchall(self):
        return [("m1", "v1", "synthetic result", 0.9)]

    def close(self):
        self.closed = True


class _FTSConnection:
    def __init__(self, error=None):
        self.value = _FTSCursor(error=error)

    def cursor(self):
        return self.value


class K5PostgresFTSContractTests(unittest.TestCase):
    def test_15_postgres_fts_is_parameterized_and_hard_filtered(self):
        from clued.r51.recall import PostgresCloudFTSProvider, RecallError

        caller = CallerIdentity("account-a", "binding-a", "device-a")
        connection = _FTSConnection()
        provider = PostgresCloudFTSProvider(connection)
        result = provider.search(
            caller, "private synthetic query",
            accessible_space_ids=["00000000-0000-0000-0000-000000000001"])
        statement = connection.value.statement
        self.assertNotIn("private synthetic query", statement)
        self.assertEqual("private synthetic query", connection.value.params[0])
        for contract in (
                "c.account_id = %s::uuid",
                "b.binding_id = %s::uuid",
                "b.status = 'ACTIVE'",
                "'memory:read' = ANY(b.scopes)",
                "c.status = 'ACTIVE'",
                "v.status = 'ACTIVE'",
                "v.sensitivity <> 'SECRET'",
                "v.truth_state NOT IN",
                "v.valid_from IS NULL",
                "v.valid_until IS NULL",
                "v.space_id = ANY(%s::uuid[])"):
            self.assertIn(contract, statement)
        self.assertEqual("VERIFIED", result["evidence_level"])
        self.assertFalse(result["semantic_recall_enabled"])
        self.assertTrue(connection.value.closed)

        broken = PostgresCloudFTSProvider(
            _FTSConnection(error="secret database detail"))
        with self.assertRaises(RecallError) as raised:
            broken.search(caller, "query")
        self.assertEqual("CLOUD_FTS_QUERY_FAILED", str(raised.exception))
        self.assertNotIn("secret database detail", str(raised.exception))
if __name__ == "__main__":
    unittest.main()
