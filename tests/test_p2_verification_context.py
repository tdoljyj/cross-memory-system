import hashlib
import importlib.util
import json
import os
import pickle
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]

from verification_context import (  # noqa: E402
    AuthorizationEvidence,
    EndpointTrust,
    RequestVerificationContext,
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
        self.trust_path = self.repo / "endpoint-trust.json"
        self._write_trust()
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

    def _write_trust(self, owner="owner_fixture", scope="tenant_fixture"):
        self.trust_path.write_text(json.dumps({
            "contract": "clued.endpoint-trust.v1",
            "snapshot_trust": {
                "expected_owner_ref": owner,
                "expected_bundle_scope": scope,
            },
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
            endpoint_trust=kwargs.pop("endpoint_trust", EndpointTrust.load(self.trust_path)),
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
        for owner, scope, expected in (
            ("owner_wrong", "tenant_fixture", "owner-mismatch"),
            ("owner_fixture", "tenant_wrong", "tenant-scope-mismatch"),
        ):
            self._write_trust(owner, scope)
            context = self.context()
            _, errors = self.verify(context)
            self.assertIn(expected, errors)
            self.assertEqual(0, context.reuse_count)
            self._write_trust()

    def test_authorization_or_remote_or_ttl_change_clears_evidence(self):
        context = self.context()
        self.verify(context)
        changed = AuthorizationEvidence(
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

    def test_trusted_owner_or_scope_change_invalidates(self):
        context = self._initial_control()
        self._write_trust(owner="owner_changed")
        with self.assertRaisesRegex(VerificationContextError, "no longer valid"):
            context.summary(boundary="source")


class F31SourceEnvelope(VerificationContextFixture):
    def test_complete_envelope_is_authoritative(self):
        context = self.context()
        self.verify(context)
        envelope = context.source_envelope(
            boundary="source",
            sources_read=["bundle/data.txt"], source_versions=["snap_fixture"],
            freshness="historical", degraded_reason=None,
        )
        summary = context.summary(boundary="source", sources=envelope)
        self.assertTrue(summary["authoritative"])
        self.assertEqual("historical", summary["sources"]["freshness"])
        self.assertEqual("a" * 40, summary["repository"]["remote_head"])
        self.assertEqual("snap_fixture", summary["snapshot"]["snapshot_version"])
        self.assertEqual("owner_fixture", summary["authorization"]["expected_owner_ref"])
        self.assertEqual(summary["validator"]["contract_version"], summary["version_envelope"]["validator_contract_version"])

    def test_incomplete_envelopes_are_rejected_or_non_authoritative(self):
        context = self.context()
        self.verify(context)
        self.assertFalse(context.summary(boundary="source")["authoritative"])
        invalid = (
            dict(sources_read=[], source_versions=["v"], freshness="historical", degraded_reason=None),
            dict(sources_read=["s"], source_versions=[], freshness="historical", degraded_reason=None),
            dict(sources_read=["s"], source_versions=["v"], freshness="", degraded_reason=None),
            dict(sources_read=["s"], source_versions=["v"], freshness="degraded", degraded_reason=None),
        )
        for values in invalid:
            with self.subTest(values=values), self.assertRaises(VerificationContextError):
                context.source_envelope(boundary="source", **values)


class EvidenceAuthorityNegativeTests(VerificationContextFixture):
    def test_source_envelope_and_summary_reject_before_verify(self):
        context = self.context()
        with self.assertRaisesRegex(VerificationContextError, "verification boundary required"):
            context.verify_bundle(self.bundle, self.validator, boundary="")
        self.assertEqual(0, self.validator_calls)
        with self.assertRaisesRegex(VerificationContextError, "verification boundary required"):
            context.source_envelope(
                boundary="", sources_read=["bundle/data.txt"],
                source_versions=["snap_fixture"], freshness="historical", degraded_reason=None,
            )
        with self.assertRaisesRegex(VerificationContextError, "verification boundary required"):
            context.summary(boundary="")
        with self.assertRaisesRegex(VerificationContextError, "no current successful"):
            context.source_envelope(
                boundary="source", sources_read=["bundle/data.txt"],
                source_versions=["snap_fixture"], freshness="historical", degraded_reason=None,
            )
        with self.assertRaisesRegex(VerificationContextError, "no current successful"):
            context.summary(boundary="source")

    def test_validator_pass_then_tamper_before_evidence_capture_is_rejected(self):
        context = self.context()

        def validator_then_tamper(root):
            manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
            (root / "data.txt").write_text("tampered-after-validator-pass\n", encoding="utf-8")
            return manifest, []

        _, errors = context.verify_bundle(self.bundle, validator_then_tamper, boundary="source")
        self.assertIn("manifest:hash-mismatch:data.txt", errors)
        with self.assertRaisesRegex(VerificationContextError, "no current successful"):
            context.summary(boundary="source")

    def test_missing_owner_or_scope_expectation_is_rejected(self):
        for trust in (
            {"expected_bundle_scope": "tenant_fixture"},
            {"expected_owner_ref": "owner_fixture"},
        ):
            with self.subTest(trust=trust):
                self.trust_path.write_text(json.dumps({
                    "contract": "clued.endpoint-trust.v1",
                    "snapshot_trust": trust,
                }), encoding="utf-8")
                with self.assertRaisesRegex(VerificationContextError, "Owner Ref or Bundle Scope missing"):
                    EndpointTrust.load(self.trust_path)
        self._write_trust()
        context = self.context(endpoint_trust=None)
        _, errors = self.verify(context)
        self.assertIn("trusted-endpoint-config-missing", errors)

    def test_manifest_missing_owner_or_scope_is_rejected(self):
        for field, expected in (
            ("owner_ref", "manifest:owner-ref-missing"),
            ("bundle_scope", "manifest:bundle-scope-missing"),
        ):
            with self.subTest(field=field):
                saved = self.manifest.pop(field)
                self._write_manifest()
                self._write_pointer(previous="snap_previous")
                _, errors = self.verify(self.context())
                self.assertIn(expected, errors)
                self.manifest[field] = saved
                self._write_manifest()
                self._write_pointer(previous="snap_previous")

    def test_summary_rejects_after_evidence_is_invalidated(self):
        context = self.context()
        self.assertEqual([], self.verify(context)[1])
        (self.bundle / "data.txt").write_text("changed-after-evidence\n", encoding="utf-8")
        with self.assertRaisesRegex(VerificationContextError, "no longer valid"):
            context.summary(boundary="source")
        with self.assertRaisesRegex(VerificationContextError, "no current successful"):
            context.summary(boundary="source")

    def test_actual_validator_versions_are_reported_from_evidence(self):
        context = self.context()
        self.assertEqual([], context.verify_bundle(
            self.bundle, self.validator, boundary="source",
            validator_contract_version="fixture-validator-v9", doctor_version="fixture-doctor-v4",
        )[1])
        summary = context.summary(boundary="source")
        self.assertEqual("fixture-validator-v9", summary["validator"]["contract_version"])
        self.assertEqual("fixture-doctor-v4", summary["validator"]["doctor_version"])


class RealRequestCallChains(unittest.TestCase):
    def test_status_doctor_and_recall_use_business_call_counts(self):
        status = subprocess.run(
            [sys.executable, str(ROOT / "memory.py"), "status"], cwd=ROOT,
            text=True, encoding="utf-8", errors="replace", capture_output=True, check=True,
        )
        status_summary = json.loads(status.stdout)["verification"]
        self.assertEqual((1, 0), (status_summary["full_validation_count"], status_summary["reuse_count"]))

        doctor = subprocess.run(
            [sys.executable, str(ROOT / "memory.py"), "doctor"], cwd=ROOT,
            text=True, encoding="utf-8", errors="replace", capture_output=True, check=True,
        )
        doctor_json = next(json.loads(line)["verification"] for line in doctor.stdout.splitlines() if line.startswith("{"))
        self.assertEqual((1, 0), (doctor_json["full_validation_count"], doctor_json["reuse_count"]))

        recall = subprocess.run(
            [sys.executable, str(ROOT / "memory.py"), "recall", "clued", "--tier", "T3", "--limit", "1"], cwd=ROOT,
            text=True, encoding="utf-8", errors="replace", capture_output=True, check=True,
        )
        recall_summary = json.loads(recall.stdout)["verification"]
        self.assertEqual((1, 1), (recall_summary["full_validation_count"], recall_summary["reuse_count"]))

    @unittest.skipUnless(os.name == "nt", "PowerShell entry contract is Windows-specific")
    def test_non_none_powershell_request_shares_context_and_next_request_is_new(self):
        bundled_pwsh = Path.home() / ".cache" / "codex-runtimes" / "codex-primary-runtime" / "dependencies" / "native" / "powershell" / "pwsh.exe"
        pwsh = shutil.which("pwsh") or shutil.which("powershell") or (str(bundled_pwsh) if bundled_pwsh.is_file() else None)
        self.assertIsNotNone(pwsh, "PowerShell is required for the P2 entry gate")
        python_dir = Path(sys.executable).parent
        git_dir = Path(shutil.which("git") or r"C:\Program Files\Git\cmd\git.exe").parent

        with tempfile.TemporaryDirectory(prefix="clued-p2-pwsh-") as temp_name:
            temp = Path(temp_name)
            repo = temp / "repo"
            repo.mkdir()
            shutil.copy2(ROOT / ".gitignore", repo / ".gitignore")
            for name in ("sync-memory.ps1", "sync-memory.py", "memory.py", "verification_context.py", "VERSION"):
                shutil.copy2(ROOT / name, repo / name)
            shutil.copytree(ROOT / "memory", repo / "memory")
            shutil.copytree(ROOT / "config", repo / "config")
            pointer_dir = repo / "artifacts" / "clued-two-level-snapshots"
            pointer_dir.mkdir(parents=True)
            shutil.copy2(ROOT / "artifacts" / "clued-two-level-snapshots" / "current.json", pointer_dir / "current.json")
            endpoint = temp / "endpoint-memory"
            endpoint_ps = str(endpoint).replace("'", "''")
            python_ps = str(python_dir).replace("'", "''")
            git_ps = str(git_dir).replace("'", "''")
            config_text = (
                f"$MemoryDir = '{endpoint_ps}'\n"
                f"$env:PATH = '{python_ps};{git_ps};' + $env:PATH\n"
            )
            (repo / "sync.config.ps1").write_text(config_text, encoding="utf-8")
            subprocess.run(["git", "init", "-b", "main"], cwd=repo, check=True, capture_output=True)
            subprocess.run(["git", "config", "core.autocrlf", "false"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.name", "P2-PowerShell-Fixture"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.email", "fixture@example.invalid"], cwd=repo, check=True)
            subprocess.run(["git", "add", "."], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-m", "fixture"], cwd=repo, check=True, capture_output=True)
            origin = temp / "origin.git"
            subprocess.run(["git", "clone", "--bare", str(repo), str(origin)], cwd=temp, check=True, capture_output=True)
            subprocess.run(["git", "remote", "add", "origin", str(origin)], cwd=repo, check=True)
            fixture_status = subprocess.run(
                ["git", "status", "--porcelain"], cwd=repo, text=True, encoding="utf-8", capture_output=True, check=True,
            ).stdout
            self.assertEqual("", fixture_status, fixture_status)

            verification_ids = []
            for request_number in (1, 2):
                trace = temp / f"trace-{request_number}.jsonl"
                environment = os.environ.copy()
                environment["GIT_TRACE2_EVENT"] = str(trace)
                result = subprocess.run(
                    [pwsh, "-NoProfile", "-File", str(repo / "sync-memory.ps1"), "-AlignAndVerify", "-Access", "PROJECT"],
                    cwd=repo, env=environment, text=True, encoding="utf-8", errors="replace", capture_output=True,
                )
                self.assertEqual(0, result.returncode, result.stderr + result.stdout)
                payload = json.loads(next(line for line in reversed(result.stdout.splitlines()) if line.startswith("{")))
                summary = payload["verification"]
                verification_ids.append(summary["verification_id"])
                self.assertEqual("local_mirror", summary["boundary"])
                self.assertEqual((3, 1), (summary["full_validation_count"], summary["reuse_count"]))
                trace_events = [json.loads(line) for line in trace.read_text(encoding="utf-8", errors="replace").splitlines()]
                ls_remote_starts = [
                    event for event in trace_events
                    if event.get("event") == "start" and "ls-remote" in event.get("argv", [])
                ]
                self.assertEqual(1, len(ls_remote_starts))

            self.assertNotEqual(verification_ids[0], verification_ids[1])


class DocumentationContract(unittest.TestCase):
    def test_align_and_verify_does_not_require_a_second_doctor_request(self):
        agents = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
        read_before = agents.split("## Read-before-alignment", 1)[1].split(
            "## Request-local verification context", 1
        )[0]
        contract = (
            "`sync-memory.ps1 -AlignAndVerify` 已在同一 Python 进程、同一 "
            "RequestVerificationContext 中完成 mirror 与 doctor。成功后不得在同一请求中再次运行 "
            "`python memory.py doctor`。独立执行 doctor 属于新的 doctor-only 请求，必须创建新的 "
            "Context 并重新校验。"
        )
        self.assertIn(contract, read_before)
        self.assertNotIn("Run `python memory.py doctor`", read_before)
        self.assertIn("align-and-verify → mirror → doctor", agents)


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
