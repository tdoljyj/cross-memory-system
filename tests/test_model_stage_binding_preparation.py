"""Pure metadata/source tests; no original M2 imports, data or model execution."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("m2_stage_preparer", ROOT / "scripts/model-program/prepare_m2_stage_binding.py")
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


class StageBindingTests(unittest.TestCase):
    def setUp(self):
        root = ROOT / "tests/fixtures/model-stage-admission/pr441-e76a7"
        self.sources = {path: (root / path).read_bytes() for path in M.PINS}
        self.contract = json.loads((ROOT / "development/contracts/model-program/stage-admission/M2StageBindingPreparation.v0.1.json").read_bytes())
        self.q = {"schema": "clued.model-program.m2-stage-binding-request/1", "status": "PREPARATION_ONLY", "original_source_commit": M.COMMIT,
                  "purpose_id": "training", "parent_boundary": "TRAINING", "use_key": "weight_learning", "stage_id": "T0",
                  "report_consumer": "TRAINING_ENGINEERING_PREPARATION", "fixed_candidate_binding": None, "reserved_source_pool": None,
                  "experiment_profile_ref": None, "data_permission_ref": None, "domain_authority_receipt_ref": None}

    def check(self):
        return M.prepare_binding(self.q, self.sources, self.contract)

    def reject(self, pattern=None):
        with self.assertRaisesRegex(M.PreparationError, pattern or ".+"):
            self.check()

    def qualification(self):
        self.q.update(purpose_id="qualification", parent_boundary="QUALIFICATION", use_key=None, stage_id="M2", report_consumer="M2_DATA_GATE_PREPARATION",
                      fixed_candidate_binding={key: None for key in M.BOUND_KEYS})
        self.q["fixed_candidate_binding"].update(candidate_role="M2_REFERENCE_BASELINE", source_stage="M1_FIXED_REFERENCE")

    def product(self):
        self.qualification()
        self.q.update(purpose_id="final_holdout", parent_boundary="FINAL_HOLDOUT", stage_id="M4", report_consumer="PRODUCT_FINAL_QUALIFICATION_PREPARATION")
        self.q["fixed_candidate_binding"].update(candidate_role="FINAL_PRODUCT_CANDIDATE", source_stage="M4")
        self.q["reserved_source_pool"] = {key: None for key in M.POOL_KEYS}

    def test_real_source_bound_positive_is_not_authority(self):
        r = self.check()
        self.assertEqual(r["status"], "PREPARATION_VALIDATION")
        self.assertFalse(r["execution_ready"])
        self.assertEqual(r["authority_effect"], "NONE")
        self.assertEqual(r["m2_qualification"], "NOT_ISSUED")
        self.assertEqual(r["data_gate"], "NOT_ISSUED")

    def test_missing_original_source_fails_closed(self):
        self.sources.pop(next(iter(M.PINS)))
        self.reject("SOURCE_UNAVAILABLE")

    def test_source_byte_drift_fails_closed(self):
        key = next(iter(M.PINS))
        self.sources[key] += b"\n"
        self.reject("SOURCE_HASH_DRIFT")

    def test_source_caller_boolean_is_not_bytes(self):
        self.sources[next(iter(M.PINS))] = True
        self.reject("SOURCE_HASH_DRIFT")

    def test_training_cannot_borrow_development_parent(self):
        self.q["parent_boundary"] = "DEVELOPMENT"
        self.reject("PURPOSE_PARENT")

    def test_development_cannot_allow_weight_learning(self):
        self.q.update(purpose_id="development", parent_boundary="DEVELOPMENT", report_consumer="DEVELOPMENT_ENGINEERING_PREPARATION")
        self.reject("PURPOSE_PARENT")

    def test_t0_cannot_consume_qualification_or_holdout(self):
        for method in (self.qualification, self.product):
            method()
            self.q["stage_id"] = "T0"
            self.reject("PROTECTED_PURPOSE")

    def test_final_holdout_cannot_produce_selection_report(self):
        self.product()
        self.q["report_consumer"] = "M3_SELECTION_PREPARATION"
        self.reject("CROSS_USE")

    def test_m2_reference_cannot_depend_on_product_candidate(self):
        self.qualification()
        self.q["fixed_candidate_binding"]["source_stage"] = "M4"
        self.reject("CROSS_USE")

    def test_product_final_cannot_reuse_m2_reference_role(self):
        self.product()
        self.q["fixed_candidate_binding"]["candidate_role"] = "M2_REFERENCE_BASELINE"
        self.reject("CROSS_USE")

    def test_materialization_must_follow_candidate_freeze(self):
        self.qualification()
        self.q["fixed_candidate_binding"].update(candidate_frozen_at="2026-10-07T02:00:00Z", samples_materialized_at="2026-10-07T01:00:00Z")
        self.reject("MATERIALIZATION")

    def test_reserved_pool_freeze_must_precede_selection(self):
        self.product()
        self.q["reserved_source_pool"].update(freeze_at="2026-10-07T02:00:00Z", first_selection_feedback_at="2026-10-07T01:00:00Z")
        self.reject("PRECEDE_SELECTION")

    def test_complete_metadata_cannot_attest_actual_custody(self):
        self.product()
        b = self.q["fixed_candidate_binding"]
        b.update(candidate_revision_sha256="a" * 64, candidate_frozen_at="2026-10-07T02:00:00Z", samples_materialized_at="2026-10-07T03:00:00Z")
        for key in M.BOUND_KEYS[3:9]:
            b[key] = "declared-reference"
        pool = self.q["reserved_source_pool"]
        for key in M.POOL_KEYS[:3]:
            pool[key] = "b" * 64
        for key in M.POOL_KEYS[3:7]:
            pool[key] = "declared-reference"
        pool.update(freeze_at="2026-10-07T00:00:00Z", first_selection_feedback_at="2026-10-07T01:00:00Z")
        r = self.check()
        self.assertFalse(r["actual_reserved_pool_freeze_verified"])
        self.assertEqual(r["domain_authority_receipt"], "NOT_ISSUED")
        self.assertIn("actual_custody_access_isolation_verification_unavailable", r["blocking_fields"])

    def test_caller_pool_frozen_boolean_forbidden(self):
        self.product()
        self.q["reserved_source_pool"]["actually_frozen"] = True
        self.reject("unknown/missing")

    def test_question_or_answer_material_forbidden(self):
        self.product()
        self.q["reserved_source_pool"]["questions"] = []
        self.reject("unknown/missing")

    def test_reference_boolean_cannot_grant_permission(self):
        self.q["data_permission_ref"] = True
        self.reject("caller boolean")

    def test_unknown_stage_or_complete_m3_forbidden(self):
        for stage in ("T2", "T3", "FULL_M3_VERDICT", "PRODUCTION"):
            self.q["stage_id"] = stage
            self.reject("STAGE_UNKNOWN")

    def test_contract_rule_version_bool_rejected(self):
        self.contract["owner_rule"]["version"] = True
        self.reject("OWNER_RULE")

    def test_contract_cannot_claim_domain_receipt_or_gate(self):
        self.contract["source_copy_is_domain_authority"] = True
        self.reject("AUTHORITY_FORBIDDEN")

    def test_invalid_time_and_digest_types_rejected(self):
        self.product()
        self.q["reserved_source_pool"]["manifest_sha256"] = True
        self.reject("SHA256")
        self.q["reserved_source_pool"]["manifest_sha256"] = None
        self.q["reserved_source_pool"]["freeze_at"] = "yesterday"
        self.reject("UTC")

    def test_final_candidate_cannot_be_frozen_before_selection_feedback(self):
        self.product()
        self.q["fixed_candidate_binding"].update(candidate_frozen_at="2026-10-07T01:00:00Z", samples_materialized_at="2026-10-07T03:00:00Z")
        self.q["reserved_source_pool"].update(freeze_at="2026-10-07T00:00:00Z", first_selection_feedback_at="2026-10-07T02:00:00Z")
        self.reject("AFTER_FINAL_PRODUCT_FREEZE")

    def test_unknown_contract_fields_or_issued_status_rejected(self):
        self.contract["signed_data_gate"] = True
        self.reject("unknown/missing")
        del self.contract["signed_data_gate"]
        self.contract["status"] = "ISSUED"
        self.reject("CONTRACT_SCHEMA")

    def test_duplicate_and_nonfinite_json_cannot_hide_purpose(self):
        for raw in (b'{"purpose_id":"final_holdout","purpose_id":"training"}', b'{"value":NaN}'):
            with self.assertRaises(M.PreparationError):
                M.strict_json(raw)

    def test_candidate_role_container_closed_and_typed(self):
        original = copy.deepcopy(self.contract["candidate_roles"])
        for roles in (None, [], ["qualification", "final_holdout"], {**original, "third_role": {}}, {"qualification": original["qualification"]}):
            with self.subTest(roles=roles):
                self.contract["candidate_roles"] = roles
                with self.assertRaises(M.PreflightError):
                    self.check()

    def test_actual_utc_microseconds_preserve_within_second_order(self):
        self.qualification()
        self.q["fixed_candidate_binding"].update(candidate_frozen_at="2026-10-07T02:00:00.123456+00:00", samples_materialized_at="2026-10-07T02:00:00.123457Z")
        self.assertEqual(self.check()["status"], "PREPARATION_VALIDATION")
        self.q["fixed_candidate_binding"]["samples_materialized_at"] = "2026-10-07T02:00:00.123455Z"
        self.reject("MATERIALIZATION")
        self.q["fixed_candidate_binding"]["samples_materialized_at"] = "2026-10-07T02:00:00.123456Z"
        self.reject("MATERIALIZATION")

    def test_reserved_utc_microseconds_preserve_selection_order(self):
        self.product()
        self.q["reserved_source_pool"].update(freeze_at="2026-10-07T00:00:00.999998Z", first_selection_feedback_at="2026-10-07T00:00:00.999999+00:00")
        self.assertEqual(self.check()["status"], "PREPARATION_VALIDATION")
        self.q["reserved_source_pool"]["first_selection_feedback_at"] = "2026-10-07T00:00:00.999997+00:00"
        self.reject("PRECEDE_SELECTION")
        self.q["reserved_source_pool"]["first_selection_feedback_at"] = "2026-10-07T00:00:00.999998+00:00"
        self.reject("PRECEDE_SELECTION")

    def test_naive_non_utc_and_unknown_time_formats_rejected(self):
        self.product()
        for value in ("2026-10-07T00:00:00", "2026-10-07T00:00:00+08:00", "2026-10-07 00:00:00Z", "2026-10-07T00:00:00.1234567Z", "2026-10-07T00:00:00-00:00", True):
            with self.subTest(value=value):
                self.q["reserved_source_pool"]["freeze_at"] = value
                self.reject("UTC")


if __name__ == "__main__":
    unittest.main()
