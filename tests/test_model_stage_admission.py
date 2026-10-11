"""Pure object tests: no native/platform/model operation or issued authority."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("development_profile_preparation", ROOT / "scripts/model-program/validate_development_profile_preparation.py")
PREP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREP)


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.profile = json.loads((ROOT / "development/contracts/model-program/stage-admission/ExperimentAuthorizationProfile.T0.candidate.json").read_text(encoding="utf-8"))
        self.contract = {"schema_version": PREP.CONTRACT_SCHEMA,
                         "authority": {"owner_decision_id": PREP.DECISION, "owner_decision_version": 1, "owner_receipt_id": PREP.RECEIPT},
                         "source_lock": {"formal_plan_sha256": PREP.PLAN_SHA, "owner_rule_json_sha256": PREP.RULE_JSON_SHA, "owner_rule_txt_sha256": PREP.RULE_TEXT_SHA},
                         "development_admission": {"foundation_semantics": PREP.FOUNDATION, "allowed_tiers": ["T0", "T1"], "blocked_until_full_m2": ["T2", "T3", "FULL_M3_VERDICT", "QUALIFICATION_INHERITANCE", "RELEASE"], "blocked_dev_purposes": ["qualification", "final_holdout"]},
                         "purpose_flow": {"training_purpose": "training", "non_learning_dev_purpose": "development", "ordered_milestones": [{"subject": name} for name in ("M2_REFERENCE_DETERMINISTIC_BASELINE", "M2_QUALIFICATION_AND_DATAGATE", "FULL_M3", "FINAL_PRODUCT_CANDIDATE_FREEZE", "FINAL_HOLDOUT_PRODUCT_QUALIFICATION")]}}
        self.raw = json.dumps(self.contract, sort_keys=True).encode()
        self.profile["source_lock"]["stage_contract_sha256"] = hashlib.sha256(self.raw).hexdigest()

    def reject(self, profile=None, raw=None):
        with self.assertRaises(PREP.PreparationError):
            PREP.validate_profile(profile or self.profile, self.raw if raw is None else raw)

    def test_positive_is_blocked_preparation_never_issued(self):
        result = PREP.validate_profile(self.profile, self.raw)
        self.assertEqual(result["status"], "PREPARATION_VALIDATION")
        self.assertFalse(result["execution_ready"])
        self.assertFalse(result["issued_profile"])
        self.assertEqual(result["actual_execution"], "NONE")
        self.assertEqual(result["authority_effect"], "NONE")
        self.assertEqual(result["m2_qualification"], "NOT_ISSUED")
        self.assertEqual(result["m3_qualification"], "NOT_ISSUED")
        self.assertIn("actual_experiment_authority_and_claim_verification_unavailable", result["blocking_fields"])

    def test_boolean_budget_is_not_integer(self):
        self.profile["budget"]["max_wall_seconds"] = True
        self.reject()

    def test_boolean_direction_version_is_not_integer(self):
        self.profile["authority"]["rule_decision_version"] = True
        self.reject()

    def test_unknown_top_level_or_nested_key_rejected(self):
        for place in (self.profile, self.profile["dataset"]):
            place["allow_execution"] = True
            self.reject()
            del place["allow_execution"]

    def test_t2_t3_and_formal_stages_rejected(self):
        for stage in ("T2", "T3", "M3", "M4", "FORMAL_QUALIFICATION"):
            self.profile["stage_id"] = stage
            self.reject()

    def test_holdout_and_qualification_inputs_rejected(self):
        for purpose in ("QUALIFICATION", "FINAL_HOLDOUT", "TRAINING_AND_HOLDOUT"):
            self.profile["dataset"]["parent_boundary"] = purpose
            self.reject()

    def test_protected48_rejected_independently_of_purpose(self):
        self.profile["dataset"]["content_class"] = "PROTECTED48"
        self.reject()

    def test_caller_execution_boolean_cannot_authorize(self):
        self.profile["training_allowed"] = True
        self.reject()

    def test_fake_authority_receipt_rejected(self):
        self.profile["authority"]["experiment_authorization_ref"] = "dummy-receipt"
        self.reject()

    def test_complete_looking_refs_never_grant_authority(self):
        self.profile["authority"]["experiment_authorization_ref"] = "record:unverified-service-reference"
        self.profile["authority"]["current_claim_ref"] = "claim:unverified-service-reference"
        result = PREP.validate_profile(self.profile, self.raw)
        self.assertFalse(result["execution_ready"])
        self.assertIn("actual_experiment_authority_and_claim_verification_unavailable", result["blocking_fields"])

    def test_obsolete_m1_profile_reopening_rejected(self):
        self.profile["legacy_m1_profile_ref"] = "M1-REF-QWEN35-08B-001"
        self.reject()

    def test_source_and_contract_hash_drift_rejected(self):
        self.profile["source_lock"]["formal_plan_sha256"] = "f" * 64
        self.reject()
        self.profile["source_lock"]["formal_plan_sha256"] = PREP.PLAN_SHA
        self.reject(raw=self.raw + b" ")

    def test_weight_learning_cannot_use_development(self):
        self.profile["dataset"]["parent_boundary"] = "DEVELOPMENT"
        self.profile["dataset"]["purpose_id"] = "development"
        self.reject()

    def test_nonlearning_development_has_own_purpose(self):
        self.profile["weight_learning_planned"] = False
        self.profile["dataset"]["parent_boundary"] = "DEVELOPMENT"
        self.profile["dataset"]["purpose_id"] = "development"
        self.assertEqual(PREP.validate_profile(self.profile, self.raw)["status"], "PREPARATION_VALIDATION")

    def test_product_candidate_dependency_cycle_rejected(self):
        for stage in ("M3_T3", "M4", "M5", "M5A", "M6_RC"):
            self.profile["acceptance_flow"]["m2_reference_candidate_stage"] = stage
            self.reject()

    def test_purpose_cross_use_and_final_result_selection_rejected(self):
        self.profile["acceptance_flow"]["m2_reference_purpose"] = "FINAL_HOLDOUT"
        self.reject()
        self.profile["acceptance_flow"]["m2_reference_purpose"] = "QUALIFICATION"
        self.profile["acceptance_flow"]["result_consumer"] = "M3_SELECTION"
        self.reject()

    def test_production_and_paid_or_model_budget_rejected(self):
        for name in ("max_cost_microunits", "max_model_calls"):
            self.profile["budget"][name] = 1
            self.reject()
            self.profile["budget"][name] = 0
        self.profile["environment"] = "PRODUCTION"
        self.reject()

    def test_window_order_and_budget_clamp(self):
        self.profile["window"] = {"not_before": "2026-10-07T10:00:00Z", "stop_at": "2026-10-07T10:00:01Z"}
        self.reject()

    def test_invalid_digest_type_rejected(self):
        self.profile["recipe"]["scorer_sha256"] = True
        self.reject()

    def test_contract_cannot_add_parallel_gate(self):
        self.contract["development_admission"]["foundation_semantics"] = "NEW_KERNEL_GATE"
        raw = json.dumps(self.contract).encode()
        self.profile["source_lock"]["stage_contract_sha256"] = hashlib.sha256(raw).hexdigest()
        self.reject(raw=raw)

    def test_duplicate_json_fields_rejected(self):
        with self.assertRaises(PREP.PreparationError):
            PREP.load_json(b'{"training_allowed":false,"training_allowed":true}')

    def test_parent_and_purpose_id_mixed_binding_rejected(self):
        self.profile["dataset"]["purpose_id"] = "development"
        self.reject()

    def test_direction_receipt_partial_or_forged_rejected(self):
        for receipt in ("7313df9c", "7313df9c-0000-0000-0000-000000000000"):
            self.profile["authority"]["rule_receipt_ref"] = receipt
            self.reject()

    def test_contract_cycle_is_rejected_even_with_matching_bytes(self):
        self.contract["purpose_flow"]["ordered_milestones"][0]["subject"] = "FINAL_PRODUCT_CANDIDATE_FREEZE"
        raw = json.dumps(self.contract).encode()
        self.profile["source_lock"]["stage_contract_sha256"] = hashlib.sha256(raw).hexdigest()
        self.reject(raw=raw)

    def test_real_contract_and_profile_artifacts_integrate_without_issuing(self):
        directory = ROOT / "development/contracts/model-program/stage-admission"
        profile = PREP.load_json((directory / "ExperimentAuthorizationProfile.T0.candidate.json").read_bytes())
        raw = (directory / "StageAdmissionSuccessor.v0.1.json").read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), profile["source_lock"]["stage_contract_sha256"])
        result = PREP.validate_profile(profile, raw)
        self.assertEqual(result["status"], "PREPARATION_VALIDATION")
        self.assertFalse(result["execution_ready"])
        self.assertEqual(result["m2_qualification"], "NOT_ISSUED")
        self.assertEqual(result["m3_qualification"], "NOT_ISSUED")
        self.assertIn("dataset.permission_proof_ref", result["blocking_fields"])
        self.assertIn("device.actual_device_ref", result["blocking_fields"])

    def test_unbound_contract_is_incomplete_not_an_issued_profile(self):
        self.profile["source_lock"]["stage_contract_sha256"] = None
        result = PREP.validate_profile(self.profile, self.raw)
        self.assertIn("stage_contract_exact_binding_unavailable", result["blocking_fields"])
        self.assertFalse(result["issued_profile"])


if __name__ == "__main__":
    unittest.main()
