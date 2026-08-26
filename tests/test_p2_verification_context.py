import hashlib
import importlib.util
import json
import pickle
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]

from verification_context import (  # noqa: E402
    AuthorizationEvidence,
    RequestVerificationContext,
    SourceEnvelope,
    VerificationContextError,
)


class FakeClock:
    trusted = True

    def __init__(self, wall=1_800_000_000.0, monotonic=10_000.0):
        self.wall = wall
        self.monotonic_value = monotonic

    def wall_time(self):
        return self.wall

    def monotonic(self):
        return self.monotonic_value

    def advance(self, seconds):
        self.wall += seconds
        self.monotonic_value += seconds


class VerificationContextFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="clued-p2-context-")
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.bundle = self.repo / "bundle"
        self.bundle.mkdir(parents=True)
        (self.bundle / "data.txt").write_text("verified-data\n", encoding="utf-8")
        self.manifest = {
            "snapshot_version": "snap_fixture",
            "canonical_version": "cv_fixture",
            "owner_ref": "owner_fixture",
            "bundle_scope": "tenant_fixture",
            "generator_version": "1.6.0",
            "schema_version": 5,
            "files": [{
                "path": "data.txt",
                "sha256": self._sha(self.bundle / "data.txt"),
                "snapshot_version": "snap_fixture",
            }],
        }
        self._write_manifest()
        self.pointer = self.repo / "current.json"
        self._write_pointer(previous="snap_previous")
        self.version = self.repo / "VERSION"
        self.version.write_text("fixture-v1\n", encoding="utf-8")
        self._git("init", "-b", "main")
        self._git("config", "user.name", "P2-Fixture")
        self._git("config", "user.email", "fixture@example.invalid")
        self._git("add", ".")
        self._git("commit", "-m", "fixture")
        self.clock = FakeClock()
        self.validator_calls = 0

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def _sha(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def _git(self, *args):
        return subprocess.run(
            ["git", *args], cwd=self.repo, text=True, encoding="utf-8",
            errors="replace", capture_output=True, check=True,
        )

    def _write_manifest(self):
        (self.bundle / "manifest.json").write_text(
            json.dumps(self.manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    def _write_pointer(self, previous):
        self.pointer.write_text(json.dumps({
            "snapshot_version": self.manifest["snapshot_version"],
            "manifest_sha256": self._sha(self.bundle / "manifest.json"),
            "previous_snapshot_version": previous,
        }, sort_keys=True), encoding="utf-8")

    def validator(self, root):
        self.validator_calls += 1
        try:
            manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
        except Exception as exc:
            return {}, [f"manifest-invalid:{exc}"]
        errors = []
        for item in manifest.get("files", []):
            path = root / item["path"]
            if not path.is_file():
                errors.append(f"manifest:missing:{item['path']}")
            elif self._sha(path) != item["sha256"]:
                errors.append(f"manifest:hash-mismatch:{item['path']}")
        return manifest, errors

    def context(self, **kwargs):
        authorization = kwargs.pop("authorization", AuthorizationEvidence(
            expected_owner_ref="owner_fixture",
            expected_bundle_scope="tenant_fixture",
            tenant_ref="tenant_fixture",
            workspace_ref="workspace_fixture",
            policy_version="policy_v1",
            revocation_epoch="rev_1",
        ))
        return RequestVerificationContext(
            "AUDIT_FULL",
            repository_root=self.repo,
            pointer_path=self.pointer,
            version_path=self.version,
            remote_head="a" * 40,
            authorization=authorization,
            ttl_seconds=kwargs.pop("ttl_seconds", 30),
            clock=kwargs.pop("clock", self.clock),
            **kwargs,
        )

    def verify(self, context, boundary="source", **kwargs):
        return context.verify_bundle(self.bundle, self.validator, boundary=boundary, **kwargs)


class F07ReuseAndInvalidation(VerificationContextFixture):
    def test_control_reuses_but_tamper_invalidates_and_rejects(self):
        context = self.context()
        self.assertEqual([], self.verify(context)[1])
        self.assertEqual([], self.verify(context)[1])
        self.assertEqual((1, 1), (context.full_validation_count, context.reuse_count))

        (self.bundle / "data.txt").write_text("tampered\n", encoding="utf-8")
        _, errors = self.verify(context)
        self.assertIn("manifest:hash-mismatch:data.txt", errors)
        self.assertEqual(2, context.full_validation_count)
        self.assertFalse(context.last_reused)
        self.assertGreaterEqual(context.invalidation_count, 2)

    def test_new_request_revalidates_and_context_cannot_be_serialized(self):
        first = self.context()
        second = self.context()
        self.verify(first)
        self.verify(second)
        self.assertNotEqual(first.verification_id, second.verification_id)
        self.assertEqual(2, self.validator_calls)
        with self.assertRaisesRegex(TypeError, "request-local"):
            pickle.dumps(first)

    def test_source_and_target_never_share_pass_evidence(self):
        context = self.context()
        self.assertEqual([], self.verify(context, "source")[1])
        self.assertEqual([], self.verify(context, "target")[1])
        self.assertEqual(2, context.full_validation_count)
        self.assertEqual([], self.verify(context, "source")[1])
        self.assertEqual([], self.verify(context, "target")[1])
        self.assertEqual(2, context.reuse_count)


class F08PointerEnvelope(VerificationContextFixture):
    def test_pointer_change_invalidates_and_revalidates(self):
        context = self.context()
        self.verify(context)
        self.verify(context)
        self._write_pointer(previous="snap_other")
        _, errors = self.verify(context)
        self.assertEqual([], errors)
        self.assertEqual(2, context.full_validation_count)
        self.assertFalse(context.last_reused)


class F09OwnerTenantAuthorization(VerificationContextFixture):
    def test_owner_and_tenant_mismatch_fail_closed(self):
        for field, value, expected in (
            ("expected_owner_ref", "owner_wrong", "owner-mismatch"),
            ("expected_bundle_scope", "tenant_wrong", "tenant-scope-mismatch"),
        ):
            auth_values = AuthorizationEvidence().__dict__.copy()
            auth_values[field] = value
            context = self.context(authorization=AuthorizationEvidence(**auth_values))
            _, errors = self.verify(context)
            self.assertIn(expected, errors)
            self.assertEqual(0, context.reuse_count)

    def test_authorization_or_remote_or_ttl_change_clears_evidence(self):
        context = self.context()
        self.verify(context)
        changed = AuthorizationEvidence(
            expected_owner_ref="owner_fixture", expected_bundle_scope="tenant_fixture",
            tenant_ref="tenant_fixture", workspace_ref="workspace_changed",
            policy_version="policy_v1", revocation_epoch="rev_1",
        )
        with self.assertRaisesRegex(VerificationContextError, "authorization-changed"):
            self.verify(context, authorization=changed)
        with self.assertRaisesRegex(VerificationContextError, "remote-head-changed"):
            self.verify(self.context(), remote_head="b" * 40)
        with self.assertRaisesRegex(VerificationContextError, "verification-ttl-changed"):
            self.verify(self.context(), ttl_seconds=20)


class F25ClockAndFreshness(VerificationContextFixture):
    def test_expiry_forward_jump_rollback_future_and_untrusted_clock_block(self):
        cases = (
            (lambda clock: clock.advance(31), "verification-context-expired"),
            (lambda clock: setattr(clock, "wall", clock.wall + 20), "wall-clock-forward-jump"),
            (lambda clock: setattr(clock, "wall", clock.wall - 20), "wall-clock-rollback"),
            (lambda clock: setattr(clock, "wall", clock.wall - 1), "verified-at-is-in-the-future"),
            (lambda clock: setattr(clock, "trusted", False), "untrusted-clock"),
        )
        for mutate, expected in cases:
            with self.subTest(expected=expected):
                clock = FakeClock()
                context = self.context(clock=clock)
                self.verify(context)
                mutate(clock)
                with self.assertRaisesRegex(VerificationContextError, expected):
                    context.stale_age_seconds()

    def test_stale_age_is_monotonic_and_never_negative(self):
        context = self.context()
        self.clock.advance(3)
        self.assertEqual(3, context.stale_age_seconds())


class F27PathIdentity(VerificationContextFixture):
    def test_directory_replacement_with_identical_bytes_invalidates(self):
        context = self.context()
        self.verify(context)
        self.verify(context)
        old = self.repo / "bundle-old"
        self.bundle.rename(old)
        shutil.copytree(old, self.bundle)
        _, errors = self.verify(context)
        self.assertEqual([], errors)
        self.assertEqual(2, context.full_validation_count)
        self.assertFalse(context.last_reused)
        self.assertTrue(any(e.get("reason") == "path-identity-changed" for e in context.events))


class F30VersionEnvelope(VerificationContextFixture):
    def _initial_control(self):
        context = self.context()
        self.verify(context)
        self.verify(context)
        self.assertEqual((1, 1), (context.full_validation_count, context.reuse_count))
        return context

    def test_version_change_revalidates(self):
        context = self._initial_control()
        self.version.write_text("fixture-v2\n", encoding="utf-8")
        self.assertEqual([], self.verify(context)[1])
        self.assertEqual(2, context.full_validation_count)

    def test_tag_change_revalidates(self):
        context = self._initial_control()
        self._git("tag", "fixture-v2")
        self.assertEqual([], self.verify(context)[1])
        self.assertEqual(2, context.full_validation_count)

    def test_manifest_change_invalidates_and_pointer_mismatch_rejects(self):
        context = self._initial_control()
        self.manifest["new_metadata"] = "changed"
        self._write_manifest()
        _, errors = self.verify(context)
        self.assertIn("pointer:manifest-hash-mismatch", errors)
        self.assertEqual(2, context.full_validation_count)

    def test_pointer_change_revalidates(self):
        context = self._initial_control()
        self._write_pointer(previous="snap_changed")
        self.assertEqual([], self.verify(context)[1])
        self.assertEqual(2, context.full_validation_count)

    def test_validator_contract_change_invalidates(self):
        context = self._initial_control()
        self.assertEqual([], self.verify(context, validator_contract_version="contract-v2")[1])
        self.assertEqual(2, context.full_validation_count)


class F31SourceEnvelope(VerificationContextFixture):
    def test_complete_envelope_is_authoritative(self):
        context = self.context()
        self.verify(context)
        envelope = context.source_envelope(
            sources_read=["bundle/data.txt"], source_versions=["snap_fixture"],
            freshness="historical", degraded_reason=None,
        )
        summary = context.summary(envelope)
        self.assertTrue(summary["authoritative"])
        self.assertEqual("historical", summary["sources"]["freshness"])

    def test_incomplete_envelopes_are_rejected_or_non_authoritative(self):
        context = self.context()
        self.verify(context)
        self.assertFalse(context.summary()["authoritative"])
        invalid = (
            dict(sources_read=[], source_versions=["v"], freshness="historical", degraded_reason=None),
            dict(sources_read=["s"], source_versions=[], freshness="historical", degraded_reason=None),
            dict(sources_read=["s"], source_versions=["v"], freshness="", degraded_reason=None),
            dict(sources_read=["s"], source_versions=["v"], freshness="degraded", degraded_reason=None),
        )
        for values in invalid:
            with self.subTest(values=values), self.assertRaises(VerificationContextError):
                SourceEnvelope(tuple(values["sources_read"]), tuple(values["source_versions"]), values["freshness"], values["degraded_reason"])


class NoneAccess(unittest.TestCase):
    def test_none_cannot_create_context_and_t0_performs_no_reads(self):
        with self.assertRaisesRegex(VerificationContextError, "NONE"):
            RequestVerificationContext("NONE", repository_root=ROOT)
        spec = importlib.util.spec_from_file_location("memory_p2_none", ROOT / "memory.py")
        memory_cli = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(memory_cli)
        args = SimpleNamespace(tier="T0", history=False, project_id=None, query="generic", limit=1)
        with mock.patch.object(memory_cli, "validate_bundle") as validate, mock.patch.object(
            memory_cli, "_candidate_views"
        ) as views:
            self.assertEqual(0, memory_cli.cmd_recall(args))
        validate.assert_not_called()
        views.assert_not_called()


class ExplicitPropagation(unittest.TestCase):
    def test_mirror_rejects_remote_sha_context_mismatch_before_validation(self):
        spec = importlib.util.spec_from_file_location("sync_memory_p2", ROOT / "sync-memory.py")
        sync = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(sync)
        context = SimpleNamespace(remote_head="a" * 40)
        with mock.patch.object(sync, "_validate_boundary") as validate:
            with self.assertRaisesRegex(RuntimeError, "does not match"):
                sync.mirror("b" * 40, context)
        validate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
