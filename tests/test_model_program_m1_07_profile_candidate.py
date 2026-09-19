import contextlib
import ast
import hashlib
import subprocess
from tests.m1_07_native_bridge import GO, native_case, native_binary
import copy
import importlib.util
import io
import json
import os
import pathlib
import shutil
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
P = ROOT / "scripts/model-program/validate_m1_07_profile_candidate.py"
O = ROOT / "scripts/model-program/m1_runtime_stability_pc.py"
BUILD_HELPER = ROOT / "scripts/model-program/build_m1_07_native_owner.py"
NATIVE_WINDOWS = ROOT / "scripts/model-program/m1-runtime-owner/platform_windows.go"
NATIVE_OWNER = ROOT / "scripts/model-program/m1-runtime-owner/owner.go"

spec = importlib.util.spec_from_file_location("m1_07_validator", P)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

# Normal imports are the unprivileged validation facade. No mock is applied.
orch_spec = importlib.util.spec_from_file_location("m1_07_public_orchestrator", O)
public_orch = importlib.util.module_from_spec(orch_spec)
orch_spec.loader.exec_module(public_orch)


def load_trusted_owner_unit_fixture():
    """White-box unit fixture, not a production activation or review receipt.

    Only this test loader substitutes the native startup check so the existing
    lifecycle tests can use fake Popen objects. External-boundary negative tests
    below use public_orch without this substitution. There is no --test switch
    or runtime factory in the shipped import facade.
    """
    real_spec = importlib.util.spec_from_file_location

    class TestBoundaryLoader:
        def __init__(self, original):
            self.original = original

        def create_module(self, spec):
            return None

        def exec_module(self, module):
            self.original.exec_module(module)
            module.require_owner_process = mock.Mock(return_value=None)

    def fixture_spec(name, location, *args, **kwargs):
        result = real_spec(name, location, *args, **kwargs)
        if pathlib.Path(location) == O.with_name("m1_runtime_stability_owner_boundary.py"):
            result.loader = TestBoundaryLoader(result.loader)
        return result

    owner_spec = real_spec("__main__", O)
    owner = importlib.util.module_from_spec(owner_spec)
    with (
        mock.patch.object(importlib.util, "spec_from_file_location", side_effect=fixture_spec),
        mock.patch.object(sys, "argv", [str(O), "--validate-only"]),
        contextlib.redirect_stdout(io.StringIO()),
    ):
        try:
            owner_spec.loader.exec_module(owner)
        except SystemExit as exc:
            if exc.code != 0:
                raise
    return owner


orch = public_orch  # r5: no privileged Python fixture; native mocks test lifecycle.



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
        raise AssertionError("No Python owner fixture in r5; lifecycle assertions must execute native_case")

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

    def test_candidate_pins_exact_owner_root_but_remains_non_issued(self):
        p = self.load_candidate()
        self.assertEqual(p["execution_control"]["issuer_public_key_sha256_fingerprint"], "7d8a39adb80276686ff052b65e074a8ea9e74f7eccbc44f4340b194fec342f9c")
        self.assertEqual(p["successor_preparation"]["owner_public_key_canonical"], "a683b21e2d838f0773fc1251e6d0165c4b15ad2b2994cabf4290edff1c24eb03")
        self.assertEqual(p["successor_preparation"]["predecessor_exact_head"], "d58df9c4a1885512bd4dd9b94f121b6a84e25744")
        self.assertFalse(p["successor_preparation"]["private_key_material_present_in_repository"])
        self.assertEqual(p["status"], "BLOCKED_PENDING_REVIEW_AND_FINAL_ISSUANCE")
        self.assertFalse(p["effectful_authority_issued"])
        self.assertIsNone(p.get("owner_final_execution_authorization"))
        self.assertEqual(p["expiry"], "TO_BE_BOUND_AT_FINAL_ISSUANCE")

    def test_candidate_binds_full_runtime_release_tree_and_signed_only_config(self):
        p = self.load_candidate()
        runtime = p["runtime_and_device_profile"]
        self.assertEqual(runtime["runtime_asset_name"], "llama-b11033-bin-win-vulkan-x64.zip")
        self.assertEqual(runtime["runtime_asset_bytes"], 31766410)
        self.assertEqual(runtime["runtime_asset_sha256"], "8ca91d4621fcac8799245f01a6467e9c09eba7b8d3be161a382048dc5c839db2")
        self.assertEqual(runtime["runtime_tree_attestation_semantics"], "EXACT_RELEASE_ZIP_AND_EXTRACTED_TREE_MATCH / NO_EXTRA_MISSING_OR_MUTATED_FILES")
        self.assertEqual(p["config_revision"]["server"]["configuration_sources"], "SIGNED_ARGV_ONLY / CHILD_ENV_ALLOWLIST / NO_LLAMA_ARG / NO_PROGRAMDATA_APPDATA_CONFIG")
        self.assertIn("zip.OpenReader(assetPath)", NATIVE_WINDOWS.read_text(encoding="utf-8"))
        self.assertIn("attestRuntimeTreeAgainst(runtimeAssetPath, runtimeDir, runtimeAssetBytes, runtimeAssetSHA, deadline)", NATIVE_WINDOWS.read_text(encoding="utf-8"))
        self.assertIn("Env: sanitizedServerEnv()", NATIVE_WINDOWS.read_text(encoding="utf-8"))
        self.assertIn('allowed := []string{"SystemRoot", "WINDIR", "TEMP", "TMP"}', NATIVE_OWNER.read_text(encoding="utf-8"))

    def test_build_helper_rejects_inherited_goflags_overlay_before_output(self):
        self.assertTrue(GO)
        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td)
            overlay = root / "overlay.json"
            overlay.write_text('{"Replace":{}}', encoding="utf-8")
            output = root / "must-not-exist"
            env = os.environ.copy()
            env["GOFLAGS"] = "-overlay=" + str(overlay)
            p = subprocess.run(
                [sys.executable, str(BUILD_HELPER), "--go", str(GO), "--output", str(output)],
                env=env, capture_output=True, text=True, timeout=30,
            )
            self.assertNotEqual(p.returncode, 0)
            self.assertIn("forbidden inherited Go build environment: GOFLAGS", p.stdout + p.stderr)
            self.assertFalse(output.exists())

    def test_build_helper_rejects_unmanifested_source_before_output(self):
        self.assertTrue(GO)
        with tempfile.TemporaryDirectory() as td, tempfile.TemporaryDirectory() as od:
            sandbox = pathlib.Path(td)
            helper_dir = sandbox / "scripts/model-program"
            helper_dir.mkdir(parents=True)
            shutil.copy2(BUILD_HELPER, helper_dir / BUILD_HELPER.name)
            shutil.copytree(ROOT / "scripts/model-program/m1-runtime-owner", helper_dir / "m1-runtime-owner")
            (helper_dir / "m1-runtime-owner/extra.go").write_text(
                "package main\n\nfunc init() {}\n", encoding="utf-8"
            )
            output = pathlib.Path(od) / "must-not-exist"
            env = os.environ.copy()
            env.pop("GOFLAGS", None)
            p = subprocess.run(
                [
                    sys.executable,
                    str(helper_dir / BUILD_HELPER.name),
                    "--go",
                    str(GO),
                    "--output",
                    str(output),
                ],
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertNotEqual(p.returncode, 0)
            self.assertIn("native source directory set drift", p.stdout + p.stderr)
            self.assertFalse(output.exists())

    def test_build_helper_clean_snapshot_matches_candidate_binary(self):
        self.assertTrue(GO)
        with tempfile.TemporaryDirectory() as td:
            output = pathlib.Path(td) / "clean-build"
            env = os.environ.copy()
            env.pop("GOFLAGS", None)
            p = subprocess.run(
                [
                    sys.executable,
                    str(BUILD_HELPER),
                    "--go",
                    str(GO),
                    "--output",
                    str(output),
                ],
                env=env,
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
            built = output / ("m1-07-owner.exe" if os.name == "nt" else "m1-07-owner")
            self.assertEqual(
                hashlib.sha256(built.read_bytes()).hexdigest(),
                self.load_candidate()["code_revision"]["native_owner_binary_sha256"],
            )

    def test_candidate_binary_binding_matches_rebuilt_native_owner(self):
        p = self.load_candidate()
        actual = hashlib.sha256(native_binary().read_bytes()).hexdigest()
        self.assertEqual(actual, p["code_revision"]["native_owner_binary_sha256"])

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
        native_case('test_server_start_health_failure_still_has_process_start_rss_evidence')

    def test_rss_failure_after_popen_is_evidenced_then_fails_closed(self):
        native_case('test_rss_failure_after_popen_is_evidenced_then_fails_closed')

    def test_stdout_stderr_attempt_to_exceed_storage_ceiling_fails_closed(self):
        native_case('test_stdout_stderr_attempt_to_exceed_storage_ceiling_fails_closed')

    def test_process_start_evidence_can_use_reserved_bytes_after_capture_failure(self):
        native_case('test_process_start_evidence_can_use_reserved_bytes_after_capture_failure')

    def test_wall_deadline_inside_scenario_fails_closed(self):
        native_case('test_wall_deadline_inside_scenario_fails_closed')

    def test_direct_run_bypass_attempt_is_blocked(self):
        self.assert_stability_error("EXECUTION_CONTEXT_REQUIRED", lambda: orch.run(self.load_candidate()))

    def test_direct_start_server_bypass_attempt_is_blocked(self):
        self.assert_stability_error(
            "EXECUTION_CONTEXT_REQUIRED",
            lambda: orch.start_server(self.load_candidate(), "M1-07-PC-LOAD-001", "bypass"),
        )

    def test_candidate_cannot_forge_registered_execution_context(self):
        native_case('test_candidate_cannot_forge_registered_execution_context')

    def test_authorized_context_tamper_is_rejected_before_popen(self):
        native_case('test_authorized_context_tamper_is_rejected_before_popen')

    def test_foreign_popen_cannot_be_forged_into_owned_registry(self):
        native_case('test_foreign_popen_cannot_be_forged_into_owned_registry')

    def test_registered_wrapper_metadata_cannot_redirect_internal_process(self):
        native_case('test_registered_wrapper_metadata_cannot_redirect_internal_process')

    def test_foreign_popen_passed_to_kill_is_rejected(self):
        native_case('test_foreign_popen_passed_to_kill_is_rejected')

    def test_owned_process_from_other_context_is_rejected(self):
        native_case('test_owned_process_from_other_context_is_rejected')

    def test_candidate_default_invocation_is_validate_only_and_effect_free(self):
        stdout = io.StringIO()
        with (
            mock.patch.object(sys, "argv", [str(O)]),
            mock.patch.object(subprocess, "Popen", side_effect=AssertionError("Popen must not be called")),
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
        src = (O.parent / "m1-runtime-owner/scenarios.go").read_text(encoding="utf-8")
        block = src.split('"crash-before"', 1)[1]
        stream_pos = block.index("close, e := c.stream(ctx)")
        kill_pos = block.index("e = c.forceKill(ctx, w)")
        close_pos = block.index("close()", kill_pos)
        restart_pos = block.index('"crash-after"')
        self.assertLess(stream_pos, kill_pos)
        self.assertLess(kill_pos, close_pos)
        self.assertLess(close_pos, restart_pos)

    def test_no_arbitrary_pid_termination_pathways(self):
        src = O.read_text(encoding="utf-8")
        self.assertNotIn("taskkill", src.lower())
        self.assertNotIn("Stop-Process", src)
        self.assertNotIn("os.kill(", src)


class ModelProgramM107ImportBoundaryTests(unittest.TestCase):
    def assert_rejected(self, code, fn):
        with self.assertRaises(public_orch.StabilityError) as cm:
            fn()
        self.assertEqual(cm.exception.code, code)

    def test_import_exposes_no_context_or_process_registration_factory(self):
        for name in (
            "_CONTEXT_SEAL", "_OWNED_PROCESS_SEAL", "_create_validated_context",
            "_create_owned_process", "_build_execution_authority_registry",
            "_make_authorize_execution", "_make_start_server", "_owner_bootstrap_allowed",
            "valid_contexts", "owned_processes", "claim_attempt_guard",
        ):
            self.assertFalse(hasattr(public_orch, name), name)

    def test_imported_entry_closures_contain_no_registry_or_factory(self):
        for name in ("authorize_execution", "start_server", "force_kill_owned", "_require_ctx", "_require_owned"):
            entry = getattr(public_orch, name)
            self.assertIsNone(entry.__closure__, name)
            self.assertEqual(entry.__code__.co_freevars, (), name)

    def test_imported_forged_context_rejected_before_popen(self):
        diagnostic = object.__new__(public_orch.ValidatedExecutionContext)
        forged = object.__new__(public_orch.ValidatedExecutionContext)
        for name in public_orch.ValidatedExecutionContext.__slots__:
            object.__setattr__(diagnostic, name, {"caller_supplied": True})
            object.__setattr__(forged, name, getattr(diagnostic, name))
        with mock.patch.object(subprocess, "Popen") as popen:
            self.assert_rejected("EXECUTION_CONTEXT_REQUIRED", lambda: public_orch.start_server(forged, "x", "x"))
            self.assertEqual(popen.call_count, 0)
        native_case("test_candidate_cannot_forge_registered_execution_context")

    def test_imported_foreign_wrapper_copied_metadata_cannot_kill(self):
        foreign = FakePopen(pid=42450)
        original = object.__new__(public_orch.OwnedServerProcess)
        forged = object.__new__(public_orch.OwnedServerProcess)
        for name, value in zip(public_orch.OwnedServerProcess.__slots__, (foreign.pid, "foreign", "M1-07-PC-CRASH-001", 1)):
            object.__setattr__(original, name, value)
            object.__setattr__(forged, name, getattr(original, name))
        with self.assertRaises(AttributeError):
            object.__setattr__(forged, "proc", foreign)
        self.assert_rejected("FOREIGN_PROCESS_REJECTED", lambda: public_orch.force_kill_owned(object(), forged))
        self.assertEqual(foreign.kill_calls, 0)
        native_case("test_registered_wrapper_metadata_cannot_redirect_internal_process")

    def test_imported_even_real_context_and_wrapper_have_no_owner_authority(self):
        # Native ownership is intentionally not exportable as a Python object.
        with mock.patch.object(subprocess, "Popen") as popen:
            self.assert_rejected("EXECUTION_CONTEXT_REQUIRED", lambda: public_orch.start_server(object(), "x", "x"))
            self.assertEqual(popen.call_count, 0)
        foreign = FakePopen()
        self.assert_rejected("FOREIGN_PROCESS_REJECTED", lambda: public_orch.force_kill_owned(object(), foreign))
        self.assertEqual(foreign.kill_calls, 0)
        native_case("test_owned_process_from_other_context_is_rejected")

    def test_imported_issued_fixture_cannot_export_context(self):
        p = ModelProgramM107CandidateTests().issued_profile()
        with tempfile.TemporaryDirectory() as td:
            output = pathlib.Path(td) / "must-not-exist"
            self.assert_rejected("ISOLATED_OWNER_PROCESS_REQUIRED", lambda: public_orch.authorize_execution(p, output))
            self.assertFalse(output.exists())

    def test_candidate_remains_blocked_and_creates_no_output(self):
        with tempfile.TemporaryDirectory() as td:
            output = pathlib.Path(td) / "must-not-exist"
            self.assert_rejected("EXECUTION_AUTHORIZATION_BLOCKED", lambda: public_orch.authorize_execution(m.load(m.CANDIDATE), output))
            self.assertFalse(output.exists())

    def test_changing_imported_name_does_not_install_runtime(self):
        with mock.patch.object(public_orch, "__name__", "__main__"):
            self.assertFalse(hasattr(public_orch, "_build_execution_authority_registry"))
            self.assert_rejected("EXECUTION_CONTEXT_REQUIRED", lambda: public_orch.start_server(object(), "x", "x"))

    def test_native_launch_rejects_python_c_and_foreign_script(self):
        boundary = public_orch._owner_boundary
        image = str(pathlib.Path(sys.executable).resolve())
        with self.assertRaises(boundary.OwnerBoundaryError):
            boundary.validate_native_owner_command(image, [image, "-I", "-S", "-c", "pass"], O)
        with tempfile.TemporaryDirectory() as td:
            foreign_script = pathlib.Path(td) / "foreign.py"
            foreign_script.write_text("pass", encoding="utf-8")
            argv = [image, "-I", "-S", str(foreign_script), "--execute", "--profile", str(m.CANDIDATE.resolve()), "--output-dir", str(pathlib.Path(td) / "out")]
            with self.assertRaises(boundary.OwnerBoundaryError):
                boundary.validate_native_owner_command(image, argv, O)

    def test_native_launch_validation_returns_no_activation_capability(self):
        boundary = public_orch._owner_boundary
        image = str(pathlib.Path(sys.executable).resolve())
        with tempfile.TemporaryDirectory() as td:
            argv = [image, "-I", "-S", str(O), "--execute", "--profile", str(m.CANDIDATE.resolve()), "--output-dir", str(pathlib.Path(td) / "out")]
            self.assertIsNone(boundary.validate_native_owner_command(image, argv, O))
            self.assertFalse(hasattr(public_orch, "_create_validated_context"))
            self.assert_rejected("EXECUTION_CONTEXT_REQUIRED", lambda: public_orch.start_server(object(), "x", "x"))

    def test_native_launch_has_no_pid_process_or_callback_input(self):
        boundary = public_orch._owner_boundary
        image = str(pathlib.Path(sys.executable).resolve())
        with tempfile.TemporaryDirectory() as td:
            base = [image, "-I", "-S", str(O), "--execute", "--profile", str(m.CANDIDATE.resolve()), "--output-dir", str(pathlib.Path(td) / "out")]
            for forbidden in ("--pid", "--process", "--callback", "--test", "--registry"):
                with self.assertRaises(boundary.OwnerBoundaryError):
                    boundary.validate_native_owner_command(image, base + [forbidden, "1"], O)

    def test_plain_import_process_cannot_satisfy_native_startup(self):
        with self.assertRaises(public_orch._owner_boundary.OwnerBoundaryError):
            public_orch._owner_boundary.require_owner_process(O)

    def test_boundary_helper_is_exact_bound(self):
        p = ModelProgramM107CandidateTests().issued_profile()
        p["code_revision"]["owner_boundary_normalized_sha256"] = "0" * 64
        self.assertEqual(public_orch.validate_execution_profile(p), (False, "OWNER_BOUNDARY_CODE_BINDING_DRIFT"))


    def test_real_isolated_c_process_name_and_argv_spoof_stay_unprivileged(self):
        # A real new interpreter, but not the exact standalone owner launch.
        # Even with __main__ and mutable argv spoofed, no runtime is installed.
        program = "\n".join([
            "import importlib.util, pathlib, sys, subprocess",
            "from unittest import mock",
            "script, profile, output = sys.argv[1:]",
            "sys.argv = [script, '--execute', '--profile', profile, '--output-dir', output]",
            "sys.orig_argv = [sys.executable, '-I', '-S'] + sys.argv",
            "spec = importlib.util.spec_from_file_location('__main__', script)",
            "module = importlib.util.module_from_spec(spec)",
            "with mock.patch.object(subprocess, 'Popen', side_effect=AssertionError('no child process')) as popen:",
            "    try:",
            "        spec.loader.exec_module(module)",
            "    except SystemExit as exc:",
            "        assert exc.code == 3, exc.code",
            "    assert module.start_server.__closure__ is None",
            "    assert module._require_owned.__closure__ is None",
            "    assert not hasattr(module, '_build_execution_authority_registry')",
            "    try:",
            "        module.start_server(object(), 'x', 'x')",
            "    except module.StabilityError as exc:",
            "        assert exc.code == 'EXECUTION_CONTEXT_REQUIRED'",
            "    else:",
            "        raise AssertionError('imported start accepted')",
            "    assert popen.call_count == 0",
            "assert not pathlib.Path(output).exists()",
            "print('IMPORT_SPOOF_REJECTED / POPEN_CALL_COUNT=0')",
        ])
        with tempfile.TemporaryDirectory() as td:
            result = subprocess.run(
                [sys.executable, "-I", "-S", "-c", program, str(O), str(m.CANDIDATE.resolve()), str(pathlib.Path(td) / "output")],
                capture_output=True, text=True, timeout=30,
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("POPEN_CALL_COUNT=0", result.stdout)

    def test_real_direct_owner_candidate_rejects_without_scenario_or_output(self):
        with tempfile.TemporaryDirectory() as td:
            output = pathlib.Path(td) / "must-not-exist"
            result = subprocess.run([str(native_binary()), "--execute", "--profile", str(m.CANDIDATE.resolve()), "--output-dir", str(output)], capture_output=True, text=True, timeout=30)
            self.assertFalse(output.exists())
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertIn("PROFILE_NOT_ISSUED", result.stderr)


class ModelProgramM107R5NativeBoundaryTests(unittest.TestCase):
    def test_r4_whitebox_loader_cannot_install_absent_runtime(self):
        module = load_trusted_owner_unit_fixture()
        for name in ("_build_execution_authority_registry", "_create_validated_context", "_create_owned_process", "claim_attempt_guard", "OutputBudget", "BoundedCapture"):
            self.assertFalse(hasattr(module, name), name)
        self.assertIsNone(module.start_server.__closure__)
        with mock.patch.object(subprocess, "Popen") as popen:
            with self.assertRaises(module.StabilityError):
                module.start_server(object(), "x", "x")
            self.assertEqual(popen.call_count, 0)

    def test_python_source_contains_no_effectful_installer(self):
        tree = ast.parse(O.read_text(encoding="utf-8"))
        imports = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports.update(n.name for n in node.names)
        self.assertTrue(imports.isdisjoint({"subprocess", "ctypes", "http.client", "signal"}))
        self.assertNotIn("_owner_bootstrap_allowed", O.read_text(encoding="utf-8"))

    def test_public_constructors_reject_before_process_creation(self):
        with mock.patch.object(subprocess, "Popen") as popen:
            for cls in (public_orch.ValidatedExecutionContext, public_orch.OwnedServerProcess):
                with self.assertRaises(public_orch.StabilityError):
                    cls()
            self.assertEqual(popen.call_count, 0)

    def test_legacy_launch_lint_requires_absolute_executable_and_script(self):
        boundary = public_orch._owner_boundary
        image = str(pathlib.Path(sys.executable).resolve())
        with tempfile.TemporaryDirectory() as td:
            args = [image, "-I", "-S", str(O.resolve()), "--execute", "--profile", str(m.CANDIDATE.resolve()), "--output-dir", str(pathlib.Path(td) / "out")]
            for index in (0, 3):
                altered = args.copy()
                altered[index] = pathlib.Path(altered[index]).name
                with self.assertRaises(boundary.OwnerBoundaryError):
                    boundary.validate_native_owner_command(image, altered, O)

    def test_native_authority_and_all_lifecycle_mock_regressions(self):
        out = native_case()
        self.assertIn("--- PASS: TestNativeBoundary/production_key_is_exact_owner_enrolled_root", out)

    def test_native_binary_has_no_process_injection_arguments(self):
        for flag in ("--pid", "--process", "--callback", "--registry", "--test", "--issuer-key"):
            p = subprocess.run([str(native_binary()), flag, "1"], capture_output=True, text=True, timeout=30)
            self.assertEqual(p.returncode, 3)
            self.assertIn("OWNER_FIXED_ARGUMENT_SCHEMA_REQUIRED", p.stderr)

    def test_python_execute_is_permanently_disabled_for_static_issued_fixture(self):
        profile = ModelProgramM107CandidateTests().issued_profile()
        with tempfile.TemporaryDirectory() as td:
            path = pathlib.Path(td) / "not-an-issued-artifact.json"
            path.write_text(json.dumps(profile), encoding="utf-8")
            output = pathlib.Path(td) / "must-not-exist"
            p = subprocess.run([sys.executable, "-B", str(O), "--execute", "--profile", str(path), "--output-dir", str(output)], capture_output=True, text=True, timeout=30)
            self.assertEqual(p.returncode, 3, p.stdout + p.stderr)
            self.assertIn("NATIVE_OWNER_PROCESS_REQUIRED", p.stderr)
            self.assertFalse(output.exists())
            native = subprocess.run([str(native_binary()), "--execute", "--profile", str(path), "--output-dir", str(output)], capture_output=True, text=True, timeout=30)
            self.assertEqual(native.returncode, 3, native.stdout + native.stderr)
            self.assertIn("OWNER_SIGNATURE_ALGORITHM", native.stderr)
            self.assertFalse(output.exists())

if __name__ == "__main__":
    unittest.main()
