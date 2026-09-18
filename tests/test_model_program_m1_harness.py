import copy
import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
P = ROOT / "scripts/model-program/m1_invocation_harness.py"
V = ROOT / "scripts/model-program/validate_m1_harness.py"
F = ROOT / "tests/fixtures/model-program-m1-harness/fixtures.json"

s = importlib.util.spec_from_file_location("m1h", P)
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
v_spec = importlib.util.spec_from_file_location("m1hv", V)
v = importlib.util.module_from_spec(v_spec); v_spec.loader.exec_module(v)
fx = m.load(F)

class M1InvocationHarnessTests(unittest.TestCase):
    def test_full_validator(self):
        self.assertEqual(v.main(), 0)

    def test_positive_static_request_is_valid_but_not_executable(self):
        result = m.validate_static_request_envelope(fx["positive_request"])
        self.assertEqual(result["static_validation"], "PASS")
        self.assertFalse(result["execution_ready"])

    def test_positive_static_result_and_candidate(self):
        result = m.validate_static_result_envelope(fx["positive_result"], fx["positive_request"])
        self.assertEqual(result["result_validation"], "PASS")
        self.assertEqual(fx["positive_result"]["candidate"]["authority"], "NON_AUTHORITATIVE_CANDIDATE")
        self.assertEqual(fx["positive_result"]["candidate"]["canonical_status"], "NOT_CANONICAL")

    def test_unknown_adapter_fails_closed(self):
        x = copy.deepcopy(fx["positive_request"]); x["adapter_id"] = "unknown"
        with self.assertRaises(m.HarnessError) as ctx:
            m.validate_static_request_envelope(x)
        self.assertEqual(ctx.exception.code, "CLUED_MODEL_M1_HARNESS_UNKNOWN_ADAPTER")

    def test_output_schema_is_enforced(self):
        x = copy.deepcopy(fx["positive_result"]); x["output_payload"]["extra"] = "x"
        with self.assertRaises(m.HarnessError) as ctx:
            m.validate_static_result_envelope(x, fx["positive_request"])
        self.assertEqual(ctx.exception.code, "CLUED_MODEL_M1_HARNESS_OUTPUT_INVALID")

    def test_unknown_error_normalizes_to_internal_without_raw_detail(self):
        e = m.normalize_error("new-unknown-error", "SECRET RAW PROVIDER DETAIL")
        self.assertEqual(e["code"], "MODEL_INTERNAL_ERROR")
        self.assertNotIn("SECRET RAW PROVIDER DETAIL", e["sanitized_message"])
        self.assertTrue(e["details_digest"].startswith("sha256:"))

    def test_real_execution_is_blocked(self):
        gate = m.real_execution_readiness()
        self.assertFalse(gate["ready"])
        self.assertEqual(gate["status"], "BLOCKED")
        self.assertIn("CURRENT_MODEL_CAPABILITY_PROFILE_DISALLOWS_LOCAL_PROVIDER", gate["blockers"])

if __name__ == "__main__":
    unittest.main()
