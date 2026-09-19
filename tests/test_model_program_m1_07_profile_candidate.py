import contextlib
import copy
import importlib.util
import io
import json
import os
import pathlib
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
P = ROOT / "scripts/model-program/validate_m1_07_profile_candidate.py"
O = ROOT / "scripts/model-program/m1_runtime_stability_pc.py"

spec = importlib.util.spec_from_file_location("m1_07_validator", P)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

orch_spec = importlib.util.spec_from_file_location("m1_07_orchestrator", O)
orch = importlib.util.module_from_spec(orch_spec)
orch_spec.loader.exec_module(orch)


class FakePopen:
    def __init__(self, pid=42420, stdout_bytes=b"", stderr_bytes=b""):
        self.pid = pid
        self.stdout = io.BytesIO(stdout_bytes)
        self.stderr = io.BytesIO(stderr_bytes)
        self.returncode = None
        self.kill_calls = 0

    def poll(self):
        return self.returncode

    def kill(self):
        self.kill_calls += 1
        self.returncode = -9

    def terminate(self):
        self.returncode = 0

    def send_signal(self, _sig):
        self.returncode = 0

    def wait(self, timeout=None):
        if self.returncode is None:
            self.returncode = 0
        return self.returncode


class ModelProgramM107CandidateTests(unittest.TestCase):
    def load_candidate(self):
        return m.load(m.CANDIDATE)

    def issued_profile(self):
        p = copy.deepcopy(self.load_candidate())
        p["profile_id"] = m.ISSUED_PROFILE_ID
        p["status"] = "ISSUED"
        p["effectful_authority_issued"] = True
        p["authority_effect"] = "M1-07_PC_RUNTIME_STABILITY_EXECUTION_ONLY"
        auth = {
            "present": True,
            "authorization_id": "OWNER-M1-07-TEST-STATIC",
            "owner_message": "static-test-only",
            "authorized_profile_id": m.ISSUED_PROFILE_ID,
            "authorized_authority_effect": "M1-07_PC_RUNTIME_STABILITY_EXECUTION_ONLY",
            "issued_at_utc": "2026-09-19T10:00:00+00:00",
        }
        auth["sha256"] = orch.owner_authorization_sha256(auth)
        p["owner_final_execution_authorization"] = auth
        p["trusted_execution_bindings"]["expected_owner_authorization_id"] = auth["authorization_id"]
        p["trusted_execution_bindings"]["expected_owner_authorization_sha256"] = auth["sha256"]
        p["expiry"] = "2099-01-01T00:00:00+00:00"
        return p

    def make_context(self, profile=None):
        temp = tempfile.TemporaryDirectory()
        root = pathlib.Path(temp.name)
        guard = root / "attempt-guard.json"
        output = root / "effectful-output"
        p = copy.deepcopy(profile or self.issued_profile())
        p["execution_control"]["attempt_guard_path"] = str(guard)
        physical = {
            "logical_name": "DESK-W-591",
            "machine_identity_source": orch.EXPECTED_MACHINE_IDENTITY_SOURCE,
            "machine_identity_sha256": orch.EXPECTED_MACHINE_IDENTITY_SHA256,
        }
        with (
            mock.patch.object(orch, "EXPECTED_ATTEMPT_GUARD_PATH", guard),
            mock.patch.object(orch, "verify_physical_device_identity", return_value=physical),
        ):
            ctx = orch.authorize_execution(p, output)
        return temp, ctx

    def assert_stability_error(self, expected_code, fn):
        with self.assertRaises(orch.StabilityError) as cm:
            fn()
        self.assertEqual(cm.exception.code, expected_code)

    def test_full_validator(self):
        self.assertEqual(m.main(), 0)

    def test_candidate_is_not_execution_ready(self):
        p = self.load_candidate()
        ready, reason = orch.validate_execution_profile(p)
        self.assertFalse(ready)
        self.assertEqual(reason, "PROFILE_NOT_ISSUED")
        self.assertEqual(p["status"], "BLOCKED_PENDING_REVIEW_AND_FINAL_ISSUANCE")
        self.assertIs(p["effectful_authority_issued"], False)
        self.assertEqual(p["authority_effect"], "NONE / PROFILE_PREPARATION_ONLY")

    def test_candidate_exact_stability_semantics(self):
        p = self.load_candidate()
        semantics = set(p["exact_model_ids_and_revisions"]["stability_subject"]["selection_semantics"].split(" / "))
        self.assertEqual(semantics, m.REQUIRED_MODEL_SEMANTICS)

    def test_profile_declares_another_orchestrator_commit_fails(self):
        p = self.issued_profile()
        p["code_revision"]["required_code_commit"] = "0" * 40
        ready, reason = orch.validate_execution_profile(p)
        self.assertFalse(ready)
        self.assertEqual(reason, "EXECUTION_ORCHESTRATOR_COMMIT_DRIFT")

    def test_profile_declares_another_orchestrator_blob_fails(self):
        p = self.issued_profile()
        p["code_revision"]["required_script_git_blob_sha1"] = "0" * 40
        ready, reason = orch.validate_execution_profile(p)
        self.assertFalse(ready)
        self.assertEqual(reason, "EXECUTION_ORCHESTRATOR_BLOB_DRIFT")

    def test_profile_declares_another_orchestrator_normalized_sha_fails(self):
        p = self.issued_profile()
        p["code_revision"]["required_script_normalized_sha256"] = "0" * 64
        ready, reason = orch.validate_execution_profile(p)
        self.assertFalse(ready)
        self.assertEqual(reason, "EXECUTION_ORCHESTRATOR_NORMALIZED_SHA256_DRIFT")

    def test_actual_script_bytes_mismatch_hardcoded_expected_sha_fails(self):
        p = self.issued_profile()
        with mock.patch.object(orch, "normalized_text_sha256", return_value="0" * 64):
            ready, reason = orch.validate_execution_profile(p)
        self.assertFalse(ready)
        self.assertEqual(reason, "EXECUTION_SCRIPT_SHA256_DRIFT")

    def test_computername_spoof_cannot_bypass_machine_identity(self):
        p = self.issued_profile()
        with (
            mock.patch.dict(os.environ, {"COMPUTERNAME": "DESK-W-591"}, clear=False),
            mock.patch.object(orch.os, "name", "nt"),
            mock.patch.object(orch.socket, "gethostname", return_value="DESK-W-591"),
            mock.patch.object(orch, "windows_machine_identity_sha256", return_value="0" * 64),
        ):
            self.assert_stability_error(
                "DEVICE_MACHINE_IDENTITY_DRIFT",
                lambda: orch.verify_physical_device_identity(p),
            )

    def test_authorization_self_rehash_still_fails_independent_expected_sha(self):
        p = self.issued_profile()
        auth = p["owner_final_execution_authorization"]
        auth["owner_message"] = "tampered-but-self-rehashed"
        auth["sha256"] = orch.owner_authorization_sha256(auth)
        ready, reason = orch.validate_execution_profile(p)
        self.assertFalse(ready)
        self.assertEqual(reason, "OWNER_AUTHORIZATION_SHA_TRUSTED_BINDING_MISMATCH")

    def test_authorization_id_drift_fails_independent_expected_id(self):
        p = self.issued_profile()
        auth = p["owner_final_execution_authorization"]
        auth["authorization_id"] = "OWNER-M1-07-DRIFT"
        auth["sha256"] = orch.owner_authorization_sha256(auth)
        ready, reason = orch.validate_execution_profile(p)
        self.assertFalse(ready)
        self.assertEqual(reason, "OWNER_AUTHORIZATION_ID_TRUSTED_BINDING_MISMATCH")

    def test_naive_issued_at_utc_fails(self):
        p = self.issued_profile()
        auth = p["owner_final_execution_authorization"]
        auth["issued_at_utc"] = "2026-09-19T10:00:00"
        auth["sha256"] = orch.owner_authorization_sha256(auth)
        ready, reason = orch.validate_execution_profile(p)
        self.assertFalse(ready)
        self.assertEqual(reason, "OWNER_FINAL_EXECUTION_AUTHORIZATION_TIME_INVALID")

    def test_non_utc_issued_at_fails(self):
        p = self.issued_profile()
        auth = p["owner_final_execution_authorization"]
        auth["issued_at_utc"] = "2026-09-19T18:00:00+08:00"
        auth["sha256"] = orch.owner_authorization_sha256(auth)
        ready, reason = orch.validate_execution_profile(p)
        self.assertFalse(ready)
        self.assertEqual(reason, "OWNER_FINAL_EXECUTION_AUTHORIZATION_TIME_INVALID")

    def test_server_start_health_failure_still_has_process_start_rss_evidence(self):
        temp, ctx = self.make_context()
        fake = FakePopen()
        try:
            with (
                mock.patch.object(orch, "build_server_command", return_value=[r"C:\fake\llama-server.exe"]),
                mock.patch.object(orch.subprocess, "Popen", return_value=fake),
                mock.patch.object(orch, "process_rss_bytes", return_value=123456),
                mock.patch.object(orch, "wait_health", side_effect=orch.StabilityError("HEALTH_TIMEOUT", "fake")),
            ):
                self.assert_stability_error("HEALTH_TIMEOUT", lambda: orch.run_cancel(ctx))
            rows = [
                json.loads(line)
                for line in (ctx.output_dir / "M1RuntimeStabilityProcessMetrics.jsonl").read_text(encoding="utf-8").splitlines()
            ]
            start = next(row for row in rows if row["sample"] == "process-start")
            self.assertEqual(start["scenario"], "M1-07-PC-CANCEL-001")
            self.assertEqual(start["start_index"], 1)
            self.assertEqual(start["start_label"], "cancel")
            self.assertEqual(start["pid"], fake.pid)
            self.assertIs(start["process_created"], True)
            self.assertEqual(start["initial_rss_bytes"], 123456)
            self.assertIs(start["rss_capture_succeeded"], True)
        finally:
            temp.cleanup()

    def test_rss_failure_after_popen_is_evidenced_then_fails_closed(self):
        temp, ctx = self.make_context()
        fake = FakePopen(pid=42421)
        try:
            with (
                mock.patch.object(orch, "build_server_command", return_value=[r"C:\fake\llama-server.exe"]),
                mock.patch.object(orch.subprocess, "Popen", return_value=fake),
                mock.patch.object(
                    orch,
                    "process_rss_bytes",
                    side_effect=orch.StabilityError("PROCESS_METRICS_READ_FAILED", "fake-rss-failure"),
                ),
            ):
                self.assert_stability_error(
                    "PROCESS_METRICS_READ_FAILED",
                    lambda: orch.start_server(ctx, "M1-07-PC-LOAD-001", "rss-fail"),
                )
            rows = [
                json.loads(line)
                for line in (ctx.output_dir / "M1RuntimeStabilityProcessMetrics.jsonl").read_text(encoding="utf-8").splitlines()
            ]
            start = rows[-1]
            self.assertIs(start["process_created"], True)
            self.assertIs(start["rss_capture_succeeded"], False)
            self.assertEqual(start["rss_failure_code"], "PROCESS_METRICS_READ_FAILED")
        finally:
            temp.cleanup()

    def test_stdout_stderr_attempt_to_exceed_storage_ceiling_fails_closed(self):
        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td)
            with (
                mock.patch.object(orch, "EXPECTED_MAX_STORAGE", 256),
                mock.patch.object(orch, "EXPECTED_EVIDENCE_RESERVE_BYTES", 64),
            ):
                budget = orch.OutputBudget(256)
                capture = orch.BoundedCapture(io.BytesIO(b"x" * 1024), root / "spam.log", budget)
                capture.start()
                capture.join(2.0)
                self.assert_stability_error("OUTPUT_STORAGE_BUDGET_EXCEEDED", budget.raise_if_failed)
                self.assertLessEqual((root / "spam.log").stat().st_size, 192)

    def test_process_start_evidence_can_use_reserved_bytes_after_capture_failure(self):
        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td)
            with (
                mock.patch.object(orch, "EXPECTED_MAX_STORAGE", 512),
                mock.patch.object(orch, "EXPECTED_EVIDENCE_RESERVE_BYTES", 256),
            ):
                budget = orch.OutputBudget(512)
                with self.assertRaises(orch.StabilityError):
                    budget.reserve(300, capture=True)
                evidence = root / "metrics.jsonl"
                budget.append_jsonl(evidence, {"process_created": True, "pid": 1}, allow_after_failure=True)
                self.assertTrue(evidence.is_file())
                self.assertLessEqual(budget.used, 512)

    def test_wall_deadline_inside_scenario_fails_closed(self):
        temp, ctx = self.make_context()
        try:
            with mock.patch.object(orch.time, "monotonic", return_value=ctx.deadline + 0.01):
                self.assert_stability_error("MAX_WALL_TIME_EXCEEDED", lambda: orch.wait_health(ctx, timeout=60.0))
        finally:
            temp.cleanup()

    def test_direct_run_bypass_attempt_is_blocked(self):
        self.assert_stability_error("EXECUTION_CONTEXT_REQUIRED", lambda: orch.run(self.load_candidate()))

    def test_direct_start_server_bypass_attempt_is_blocked(self):
        self.assert_stability_error(
            "EXECUTION_CONTEXT_REQUIRED",
            lambda: orch.start_server(self.load_candidate(), "M1-07-PC-LOAD-001", "bypass"),
        )

    def test_candidate_cannot_forge_registered_execution_context(self):
        candidate = self.load_candidate()
        self.assertEqual(candidate["status"], "BLOCKED_PENDING_REVIEW_AND_FINAL_ISSUANCE")
        self.assertIs(candidate["effectful_authority_issued"], False)
        self.assertFalse(hasattr(orch, "_CONTEXT_SEAL"))
        self.assert_stability_error(
            "EXECUTION_CONTEXT_CONSTRUCTION_FORBIDDEN",
            lambda: orch.ValidatedExecutionContext(),
        )
        temp, valid_ctx = self.make_context()
        try:
            forged = object.__new__(orch.ValidatedExecutionContext)
            for name in orch.ValidatedExecutionContext.__slots__:
                object.__setattr__(forged, name, getattr(valid_ctx, name))
            popen = mock.Mock(side_effect=AssertionError("Popen must not be reached"))
            with mock.patch.object(orch.subprocess, "Popen", popen):
                self.assert_stability_error(
                    "EXECUTION_CONTEXT_REQUIRED",
                    lambda: orch.start_server(forged, "M1-07-PC-LOAD-001", "forged"),
                )
            self.assertEqual(popen.call_count, 0)
        finally:
            temp.cleanup()

    def test_authorized_context_tamper_is_rejected_before_popen(self):
        temp, ctx = self.make_context()
        try:
            ctx.profile["config_revision"]["server"]["port"] = 18088
            with mock.patch.object(orch.subprocess, "Popen", side_effect=AssertionError("Popen must not be reached")):
                self.assert_stability_error(
                    "EXECUTION_CONTEXT_TAMPERED",
                    lambda: orch.start_server(ctx, "M1-07-PC-LOAD-001", "tampered-profile"),
                )
            ctx.profile["config_revision"]["server"]["port"] = 18087
            ctx.deadline += 10.0
            with mock.patch.object(orch.subprocess, "Popen", side_effect=AssertionError("Popen must not be reached")):
                self.assert_stability_error(
                    "EXECUTION_CONTEXT_TAMPERED",
                    lambda: orch.start_server(ctx, "M1-07-PC-LOAD-001", "tampered-deadline"),
                )
        finally:
            temp.cleanup()

    def test_foreign_popen_cannot_be_forged_into_owned_registry(self):
        temp, ctx = self.make_context()
        foreign = FakePopen(pid=99998)
        try:
            self.assertFalse(hasattr(orch, "_OWNED_PROCESS_SEAL"))
            self.assertFalse(hasattr(ctx, "owned"))
            self.assertFalse(hasattr(orch, "_create_owned_process"))
            self.assert_stability_error(
                "OWNED_PROCESS_CONSTRUCTION_FORBIDDEN",
                lambda: orch.OwnedServerProcess(),
            )
            forged = object.__new__(orch.OwnedServerProcess)
            object.__setattr__(forged, "pid", foreign.pid)
            object.__setattr__(forged, "label", "foreign")
            object.__setattr__(forged, "scenario", "M1-07-PC-CRASH-001")
            object.__setattr__(forged, "start_index", 99)
            with self.assertRaises(AttributeError):
                object.__setattr__(forged, "proc", foreign)
            self.assert_stability_error("FOREIGN_PROCESS_REJECTED", lambda: orch.force_kill_owned(ctx, forged))
            self.assertEqual(foreign.kill_calls, 0)
        finally:
            temp.cleanup()

    def test_registered_wrapper_metadata_cannot_redirect_internal_process(self):
        temp, ctx = self.make_context()
        original = FakePopen(pid=42423)
        foreign_same_pid = FakePopen(pid=42423)
        try:
            with (
                mock.patch.object(orch, "build_server_command", return_value=[r"C:\fake\llama-server.exe"]),
                mock.patch.object(orch.subprocess, "Popen", return_value=original),
                mock.patch.object(orch, "process_rss_bytes", return_value=123456),
            ):
                owned, _ = orch.start_server(ctx, "M1-07-PC-LOAD-001", "registered")
            self.assertFalse(hasattr(owned, "proc"))
            with self.assertRaises(AttributeError):
                object.__setattr__(owned, "proc", foreign_same_pid)
            owned.pid = 99999
            owned.label = "caller-mutated-diagnostic"
            orch.force_kill_owned(ctx, owned)
            self.assertEqual(foreign_same_pid.kill_calls, 0)
            self.assertEqual(original.kill_calls, 1)
        finally:
            temp.cleanup()

    def test_foreign_popen_passed_to_kill_is_rejected(self):
        temp, ctx = self.make_context()
        try:
            foreign = FakePopen(pid=99999)
            self.assert_stability_error("FOREIGN_PROCESS_REJECTED", lambda: orch.force_kill_owned(ctx, foreign))
            self.assertIsNone(foreign.returncode)
        finally:
            temp.cleanup()

    def test_owned_process_from_other_context_is_rejected(self):
        temp1, ctx1 = self.make_context()
        temp2, ctx2 = self.make_context()
        fake = FakePopen(pid=42422)
        try:
            with (
                mock.patch.object(orch, "build_server_command", return_value=[r"C:\fake\llama-server.exe"]),
                mock.patch.object(orch.subprocess, "Popen", return_value=fake),
                mock.patch.object(orch, "process_rss_bytes", return_value=123456),
            ):
                owned, _ = orch.start_server(ctx1, "M1-07-PC-LOAD-001", "ctx1-owned")
            self.assert_stability_error("FOREIGN_PROCESS_REJECTED", lambda: orch.force_kill_owned(ctx2, owned))
            self.assertEqual(fake.kill_calls, 0)
            orch.force_kill_owned(ctx1, owned)
        finally:
            temp1.cleanup()
            temp2.cleanup()

    def test_candidate_default_invocation_is_validate_only_and_effect_free(self):
        stdout = io.StringIO()
        with (
            mock.patch.object(sys, "argv", [str(O)]),
            mock.patch.object(orch.subprocess, "Popen", side_effect=AssertionError("Popen must not be called")),
            contextlib.redirect_stdout(stdout),
        ):
            rc = orch.main()
        self.assertEqual(rc, 0)
        result = json.loads(stdout.getvalue().strip())
        self.assertIs(result["execution_ready"], False)
        self.assertEqual(result["reason"], "PROFILE_NOT_ISSUED")
        self.assertIs(result["server_started"], False)
        self.assertIs(result["model_loaded"], False)

    def test_candidate_does_not_create_execution_context(self):
        p = self.load_candidate()
        with tempfile.TemporaryDirectory() as td:
            self.assert_stability_error(
                "EXECUTION_AUTHORIZATION_BLOCKED",
                lambda: orch.authorize_execution(p, pathlib.Path(td) / "effectful"),
            )

    def test_exact_issued_static_profile_passes_non_effectful_gate(self):
        p = self.issued_profile()
        ready, reason = orch.validate_execution_profile(p)
        self.assertTrue(ready)
        self.assertEqual(reason, "READY")

    def test_wrong_machine_binding_in_profile_fails_static_gate(self):
        p = self.issued_profile()
        p["runtime_and_device_profile"]["machine_identity"]["sha256"] = "0" * 64
        ready, reason = orch.validate_execution_profile(p)
        self.assertFalse(ready)
        self.assertEqual(reason, "M1_07_MACHINE_IDENTITY_BINDING_DRIFT")

    def test_non_loopback_port_or_gpu_drift_fails_candidate_validation(self):
        p = self.load_candidate()
        p["config_revision"]["server"]["port"] = 18088
        self.assertEqual(m.validate_candidate(p), (False, "M1_07_LOOPBACK_BOUNDARY"))
        p = self.load_candidate()
        p["config_revision"]["server"]["n_gpu_layers"] = 1
        self.assertEqual(m.validate_candidate(p), (False, "M1_07_CPU_ONLY_BOUNDARY"))

    def test_m1_08_authority_leak_fails_candidate_validation(self):
        p = self.load_candidate()
        p["prohibited_operations"].remove("M1_08_EXECUTION")
        self.assertEqual(m.validate_candidate(p), (False, "M1_07_PROHIBITED_BOUNDARY"))

    def test_crash_ordering_remains_active_stream_kill_close_restart(self):
        src = O.read_text(encoding="utf-8")
        block = src.split("def run_crash_restart", 1)[1].split("\ndef run(", 1)[0]
        open_pos = block.index("stream_conn, stream_resp, first = open_stream(ctx)")
        kill_pos = block.index("force_kill_owned(ctx, owned)")
        close_pos = block.index("stream_conn.close()")
        restart_pos = block.index('start_server(ctx, "M1-07-PC-CRASH-001", "crash-after")')
        self.assertLess(open_pos, kill_pos)
        self.assertLess(kill_pos, close_pos)
        self.assertLess(close_pos, restart_pos)

    def test_no_arbitrary_pid_termination_pathways(self):
        src = O.read_text(encoding="utf-8")
        self.assertNotIn("taskkill", src.lower())
        self.assertNotIn("Stop-Process", src)
        self.assertNotIn("os.kill(", src)


if __name__ == "__main__":
    unittest.main()
