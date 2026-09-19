import copy
import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
P = ROOT / "scripts/model-program/validate_m1_07_profile_candidate.py"
O = ROOT / "scripts/model-program/m1_runtime_stability_pc.py"

spec = importlib.util.spec_from_file_location("m1_07_validator", P)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

orch_spec = importlib.util.spec_from_file_location("m1_07_orchestrator", O)
orch = importlib.util.module_from_spec(orch_spec)
orch_spec.loader.exec_module(orch)


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
        p["expiry"] = "2099-01-01T00:00:00+00:00"
        return p

    def test_full_validator(self):
        self.assertEqual(m.main(), 0)

    def test_candidate_is_not_execution_ready(self):
        p = self.load_candidate()
        ready, reason = m.execution_readiness(p)
        self.assertFalse(ready)
        self.assertEqual(reason, "PROFILE_NOT_ISSUED")

    def test_orchestrator_agrees_candidate_is_not_execution_ready(self):
        p = self.load_candidate()
        ready, reason = orch.validate_execution_profile(p)
        self.assertFalse(ready)
        self.assertEqual(reason, "PROFILE_NOT_ISSUED")

    def test_forced_issued_status_without_exact_issued_profile_id_is_not_ready(self):
        p = copy.deepcopy(self.load_candidate())
        p["status"] = "ISSUED"
        ready, reason = m.execution_readiness(p)
        self.assertFalse(ready)
        self.assertEqual(reason, "PROFILE_ID_SCOPE_DRIFT")

    def test_exact_issued_profile_id_without_authority_is_not_ready(self):
        p = copy.deepcopy(self.load_candidate())
        p["status"] = "ISSUED"
        p["profile_id"] = m.ISSUED_PROFILE_ID
        ready, reason = m.execution_readiness(p)
        self.assertFalse(ready)
        self.assertEqual(reason, "EFFECTFUL_AUTHORITY_NOT_ISSUED")

    def test_forced_effectful_authority_without_owner_final_auth_is_not_ready(self):
        p = copy.deepcopy(self.load_candidate())
        p["status"] = "ISSUED"
        p["profile_id"] = m.ISSUED_PROFILE_ID
        p["effectful_authority_issued"] = True
        ready, reason = m.execution_readiness(p)
        self.assertFalse(ready)
        self.assertEqual(reason, "OWNER_FINAL_EXECUTION_AUTHORIZATION_MISSING")

    def test_owner_auth_without_expiry_is_not_ready(self):
        p = self.issued_profile()
        p["expiry"] = "TO_BE_BOUND_AT_FINAL_ISSUANCE"
        ready, reason = m.execution_readiness(p)
        self.assertFalse(ready)
        self.assertEqual(reason, "EXPIRY_UNRESOLVED")

    def test_non_loopback_host_fails(self):
        p = copy.deepcopy(self.load_candidate())
        p["config_revision"]["server"]["host"] = "0.0.0.0"
        good, code = m.validate_candidate(p)
        self.assertFalse(good)
        self.assertEqual(code, "M1_07_LOOPBACK_BOUNDARY")

    def test_gpu_offload_fails(self):
        p = copy.deepcopy(self.load_candidate())
        p["config_revision"]["server"]["n_gpu_layers"] = 1
        good, code = m.validate_candidate(p)
        self.assertFalse(good)
        self.assertEqual(code, "M1_07_CPU_ONLY_BOUNDARY")

    def test_quality_winner_leak_fails(self):
        p = copy.deepcopy(self.load_candidate())
        p["exact_model_ids_and_revisions"]["stability_subject"]["selection_semantics"] = "QUALITY_WINNER"
        good, code = m.validate_candidate(p)
        self.assertFalse(good)
        self.assertEqual(code, "M1_07_QUALITY_SELECTION_LEAK")

    def test_mobile_background_claim_fails(self):
        p = copy.deepcopy(self.load_candidate())
        bg = next(x for x in p["scenario_contract"] if x["scenario_id"] == "M1-07-PC-BACKGROUND-001")
        bg["semantics"] = "MOBILE_APP_BACKGROUND_RESUME"
        good, code = m.validate_candidate(p)
        self.assertFalse(good)
        self.assertEqual(code, "M1_07_BACKGROUND_SCOPE")

    def test_m1_08_authority_removal_fails(self):
        p = copy.deepcopy(self.load_candidate())
        p["prohibited_operations"].remove("M1_08_EXECUTION")
        good, code = m.validate_candidate(p)
        self.assertFalse(good)
        self.assertEqual(code, "M1_07_PROHIBITED_BOUNDARY")

    def test_code_binding_drift_fails(self):
        p = copy.deepcopy(self.load_candidate())
        p["code_revision"]["required_script_normalized_sha256"] = "deadbeef"
        good, code = m.validate_candidate(p)
        self.assertFalse(good)
        self.assertEqual(code, "M1_07_CODE_BINDING")

    def test_non_exact_port_fails_candidate_validation(self):
        p = copy.deepcopy(self.load_candidate())
        p["config_revision"]["server"]["port"] = 18088
        good, code = m.validate_candidate(p)
        self.assertFalse(good)
        self.assertEqual(code, "M1_07_LOOPBACK_BOUNDARY")

    def test_orchestrator_exact_issued_profile_is_static_ready(self):
        p = self.issued_profile()
        ready, reason = orch.validate_execution_profile(p)
        self.assertTrue(ready)
        self.assertEqual(reason, "READY")

    def test_orchestrator_rejects_port_drift_before_execution(self):
        p = self.issued_profile()
        p["config_revision"]["server"]["port"] = 18088
        ready, reason = orch.validate_execution_profile(p)
        self.assertFalse(ready)
        self.assertEqual(reason, "M1_07_CONFIG_SCOPE_DRIFT:port")

    def test_orchestrator_rejects_thread_drift_before_execution(self):
        p = self.issued_profile()
        p["config_revision"]["server"]["threads"] = 3
        ready, reason = orch.validate_execution_profile(p)
        self.assertFalse(ready)
        self.assertEqual(reason, "M1_07_CONFIG_SCOPE_DRIFT:threads")

    def test_orchestrator_rejects_device_scope_drift_before_execution(self):
        p = self.issued_profile()
        p["runtime_and_device_profile"]["device_name"] = "Turing"
        ready, reason = orch.validate_execution_profile(p)
        self.assertFalse(ready)
        self.assertEqual(reason, "M1_07_DEVICE_SCOPE_DRIFT")

    def test_orchestrator_rejects_model_subject_drift_before_execution(self):
        p = self.issued_profile()
        p["exact_model_ids_and_revisions"]["stability_subject"]["sha256"] = "0" * 64
        ready, reason = orch.validate_execution_profile(p)
        self.assertFalse(ready)
        self.assertEqual(reason, "M1_07_STABILITY_SUBJECT_DRIFT")

    def test_orchestrator_rejects_owner_authorization_digest_drift(self):
        p = self.issued_profile()
        p["owner_final_execution_authorization"]["owner_message"] = "tampered"
        ready, reason = orch.validate_execution_profile(p)
        self.assertFalse(ready)
        self.assertEqual(reason, "OWNER_FINAL_EXECUTION_AUTHORIZATION_DIGEST_INVALID")

    def test_orchestrator_contains_process_metrics_and_budget_guards(self):
        src = O.read_text(encoding="utf-8")
        self.assertIn("M1RuntimeStabilityProcessMetrics.jsonl", src)
        self.assertIn("def process_rss_bytes(", src)
        self.assertIn("def enforce_output_storage_budget(", src)
        self.assertIn("def enforce_wall_budget(", src)
        self.assertIn("def claim_attempt_guard(", src)
        self.assertIn("MAX_ATTEMPTS_EXCEEDED", src)

    def test_orchestrator_default_mode_is_validate_only(self):
        src = O.read_text(encoding="utf-8")
        self.assertIn("if not args.validate_only and not args.execute:", src)
        self.assertIn("args.validate_only = True", src)
        self.assertIn('"server_started": False', src)
        self.assertIn('"model_loaded": False', src)

    def test_crash_guard_kills_only_owned_popen_handle(self):
        src = O.read_text(encoding="utf-8")
        self.assertIn("def force_kill_owned(proc:", src)
        self.assertIn("proc.kill()", src)
        self.assertNotIn("taskkill", src.lower())
        self.assertNotIn("Stop-Process", src)
        self.assertNotIn("os.kill(", src)

    def test_crash_occurs_while_stream_connection_is_still_open(self):
        src = O.read_text(encoding="utf-8")
        block = src.split("def run_crash_restart", 1)[1].split("\ndef run(", 1)[0]
        open_pos = block.index("stream_conn, stream_resp, first = open_stream(profile)")
        kill_pos = block.index("force_kill_owned(proc)")
        close_pos = block.index("stream_conn.close()")
        self.assertLess(open_pos, kill_pos)
        self.assertLess(kill_pos, close_pos)


if __name__ == "__main__":
    unittest.main()
