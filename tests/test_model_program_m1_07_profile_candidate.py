import copy
import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
P = ROOT / "scripts/model-program/validate_m1_07_profile_candidate.py"
spec = importlib.util.spec_from_file_location("m1_07_validator", P)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ModelProgramM107CandidateTests(unittest.TestCase):
    def load_candidate(self):
        return m.load(m.CANDIDATE)

    def test_full_validator(self):
        self.assertEqual(m.main(), 0)

    def test_candidate_is_not_execution_ready(self):
        p = self.load_candidate()
        ready, reason = m.execution_readiness(p)
        self.assertFalse(ready)
        self.assertEqual(reason, "PROFILE_NOT_ISSUED")

    def test_forced_issued_status_without_authority_is_not_ready(self):
        p = copy.deepcopy(self.load_candidate())
        p["status"] = "ISSUED"
        ready, reason = m.execution_readiness(p)
        self.assertFalse(ready)
        self.assertEqual(reason, "EFFECTFUL_AUTHORITY_NOT_ISSUED")

    def test_forced_authority_with_unbound_code_is_not_ready(self):
        p = copy.deepcopy(self.load_candidate())
        p["status"] = "ISSUED"
        p["effectful_authority_issued"] = True
        ready, reason = m.execution_readiness(p)
        self.assertFalse(ready)
        self.assertEqual(reason, "EXECUTION_CODE_BINDING_UNRESOLVED")

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

    def test_code_binding_must_remain_unresolved_in_candidate(self):
        p = copy.deepcopy(self.load_candidate())
        p["code_revision"]["status"] = "EXACT_BOUND"
        p["code_revision"]["required_script_git_blob_sha1"] = "deadbeef"
        p["code_revision"]["required_code_commit"] = "deadbeef"
        good, code = m.validate_candidate(p)
        self.assertFalse(good)
        self.assertEqual(code, "M1_07_CANDIDATE_CODE_MUST_REMAIN_UNBOUND")


if __name__ == "__main__":
    unittest.main()
