"""Existing technical projection examples; no new Corpus/Gold/model calls."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("domain_existing_projection_examples", ROOT / "tests/test_model_decision_candidate_projection.py")
OLD = importlib.util.module_from_spec(spec); spec.loader.exec_module(OLD)
spec = importlib.util.spec_from_file_location("candidate_domain_contract", ROOT / "scripts/model-program/workflow_domain_contract.py")
# Reuse the existing tests' private imports without global sys.path mutation.
M = type(OLD.M)("candidate_domain_contract")
M.__dict__["__builtins__"] = OLD.namespace
exec(compile(Path(spec.origin).read_bytes(), spec.origin, "exec"), M.__dict__)
PACKAGE_PATH = ROOT / "development/contracts/model-program/workflow-domain/TaskSpecs.candidate.v1.json"
RAW = PACKAGE_PATH.read_bytes()
PACKAGE = json.loads(RAW)
PIN = hashlib.sha256(RAW).hexdigest()


def bind(task, supplied, raw=RAW, pin=PIN, schema_digest=None):
    selected = next(s for s in PACKAGE["specs"] if s["logical_task"] == task)
    return M.bind_task_input(raw, pin, task, supplied,
                            schema_digest or selected["output_schema_digest"])


class WorkflowDomainContractTests(unittest.TestCase):
    def test_all_existing_task_inputs_bound_without_mutation_or_authority(self):
        for task in M.TASKS:
            _s, bindings, _p, _c = OLD.setup(task)
            supplied = bindings[0]["task_input"]
            before = copy.deepcopy(supplied)
            result = bind(task, supplied)
            self.assertEqual(result["task_input"], before)
            self.assertEqual(supplied, before)
            self.assertFalse(result["domain_adoption_verified"])
            self.assertFalse(result["input_permission_verified"])
            self.assertEqual(result["qualification"], "NOT_ISSUED")

    def test_exact_accepted_output_digests_and_definitions_retained(self):
        self.assertEqual(PACKAGE["definition_proposal_sha256"], "bee9d8146f52880951ca6b9b59903fd1d7073b309603694937e1a5fced4723ba")
        expected = {"decision.semantic_relation": "9e5ffa56f3c2b9e41c7e53aac8348c95bcad358b2b1c923357b8f17fa584c26e",
                    "decision.context_relevance": "4ab172c7ff6bc18a04287a758019c849cafa9b8430ec41c7999d3d029da32ae1",
                    "decision.processing_route": "99b306f8fa1604f2ae627cbf0e6c1f3f2924a0303c37d2ed8c577946da28ded9"}
        for item in PACKAGE["specs"]:
            self.assertEqual(item["output_schema_digest"], "sha256:" + expected[item["logical_task"]])
            self.assertTrue(all(v is None for v in item["actual_domain_bindings"].values()))
        relation = PACKAGE["specs"][0]["definition"]
        self.assertEqual(relation["comparison_direction"], "RIGHT_CONTENT_RELATIVE_TO_LEFT_CONTENT")
        self.assertEqual(len(relation["content_only_relation_candidates"]), 8)

    def test_valid_abstention_passes_the_existing_projection_with_real_schema(self):
        for task in M.TASKS:
            saved, bindings, policy, _c = OLD.setup(task)
            got = bind(task, bindings[0]["task_input"])
            bindings[0]["output_schema_digest"] = got["output_schema_digest"]
            saved[0]["raw_output"] = OLD.encoded({"status":"ABSTAINED","value":None,"score_kind":"NONE",
                "distribution":None,"calibration_ref":None,"evidence_refs":[],"abstain_reason":"INSUFFICIENT_EVIDENCE"})
            result = OLD.project(saved, bindings, policy, task, payload_schema_raw=got["payload_schema_raw"],
                                 payload_schema_sha256=got["payload_schema_sha256"])
            self.assertEqual(result["scorer_records"][0]["status"], "abstain")
            self.assertIsNone(result["scorer_report"]["results"][0]["correct"])

    def test_relation_pair_and_unexpected_port_identity_fields_refused(self):
        _, bindings, _, _ = OLD.setup()
        for fault in ("left", "provider", "missing"):
            supplied = copy.deepcopy(bindings[0]["task_input"])
            if fault == "left": supplied["left_input_ref"] = ""
            elif fault == "provider": supplied["provider_id"] = "invented"
            else: supplied.pop("right_input_ref")
            with self.assertRaises(ValueError): bind("decision.semantic_relation", supplied)

    def test_actual_accepted_prediction_schemas_reach_existing_scorers(self):
        for task in M.TASKS:
            saved, bindings, policy, candidate = OLD.setup(task)
            if task == "decision.semantic_relation":
                # Technical label substitution only, not a content adjudication.
                label = "EQUIVALENT_CONTENT"
                candidate["value"]["relation_id"] = label
                policy.update(labels=[label], loss_matrix=None)
                bindings[0]["scoring_reference"]["gold_label"] = None
            got = bind(task, bindings[0]["task_input"])
            bindings[0]["output_schema_digest"] = got["output_schema_digest"]
            saved[0]["raw_output"] = OLD.encoded(candidate)
            result = OLD.project(saved, bindings, policy, task, payload_schema_raw=got["payload_schema_raw"],
                                 payload_schema_sha256=got["payload_schema_sha256"])
            self.assertTrue(result["scorer_report"]["results"][0]["candidate_valid"])
            if task == "decision.semantic_relation":
                self.assertIsNone(result["scorer_report"]["results"][0]["correct"])

    def test_unaccepted_relation_label_is_invalid_without_changing_raw(self):
        saved, bindings, policy, candidate = OLD.setup()
        got = bind("decision.semantic_relation", bindings[0]["task_input"])
        bindings[0]["output_schema_digest"] = got["output_schema_digest"]
        raw = OLD.encoded(candidate); saved[0]["raw_output"] = raw
        result = OLD.project(saved, bindings, policy, payload_schema_raw=got["payload_schema_raw"],
                             payload_schema_sha256=got["payload_schema_sha256"])
        self.assertEqual(result["scorer_records"][0]["status"], "invalid")
        self.assertEqual(result["slots"][0]["raw_output"], raw)

    def test_catalogue_does_not_invent_a_no_loop_policy(self):
        task = "decision.processing_route"; _, bindings, _, _ = OLD.setup(task)
        supplied = bindings[0]["task_input"]
        supplied["route_catalog"]["a"] = ["start", "work", "start", "end"]
        self.assertEqual(bind(task, supplied)["task_input"], supplied)
        # Actual graph edges, depth and shared budgets stay the existing scorer's checks.

    def test_duplicate_context_and_evidence_ids_refused(self):
        task = "decision.context_relevance"; _, bindings, _, _ = OLD.setup(task)
        for field in ("context_ids", "visible_evidence_refs"):
            supplied = copy.deepcopy(bindings[0]["task_input"]); supplied[field] = ["a", "a"]
            with self.assertRaises(ValueError): bind(task, supplied)

    def test_route_catalogue_bad_keys_paths_and_model_actions_refused(self):
        task = "decision.processing_route"; _, bindings, _, _ = OLD.setup(task)
        for fault in ("key", "path", "actions"):
            supplied = copy.deepcopy(bindings[0]["task_input"])
            if fault == "key": supplied["route_catalog"] = {"": ["start"]}
            elif fault == "path": supplied["route_catalog"] = {"a": []}
            else: supplied["actions"] = ["invented"]
            with self.assertRaises(ValueError): bind(task, supplied)

    def test_original_request_output_schema_and_package_drift_refused(self):
        _, bindings, _, _ = OLD.setup(); supplied = bindings[0]["task_input"]
        with self.assertRaises(ValueError): bind("decision.semantic_relation", supplied, schema_digest="sha256:" + "0" * 64)
        with self.assertRaises(ValueError): bind("decision.semantic_relation", supplied, raw=RAW + b" ")

    def test_remote_schema_and_changed_schema_digest_refused_even_with_new_package_pin(self):
        _, bindings, _, _ = OLD.setup()
        for fault in ("remote", "digest"):
            package = copy.deepcopy(PACKAGE)
            if fault == "remote": package["specs"][0]["input_binding_schema"]["$ref"] = "https://invalid.example/schema"
            else: package["specs"][0]["input_binding_schema_digest"] = "sha256:" + "0" * 64
            raw = OLD.encoded(package)
            with self.assertRaises(ValueError): bind("decision.semantic_relation", bindings[0]["task_input"], raw, hashlib.sha256(raw).hexdigest())

    def test_candidate_cannot_assert_adoption_or_duplicate_task(self):
        _, bindings, _, _ = OLD.setup()
        for fault in ("status", "task"):
            package = copy.deepcopy(PACKAGE)
            if fault == "status": package["status"] = "ADOPTED"
            else: package["specs"][1] = copy.deepcopy(package["specs"][0])
            raw = OLD.encoded(package)
            with self.assertRaises(ValueError): bind("decision.semantic_relation", bindings[0]["task_input"], raw, hashlib.sha256(raw).hexdigest())

    def test_nonfinite_duplicate_and_oversized_package_refused(self):
        _, bindings, _, _ = OLD.setup()
        for raw in (b'{"x":NaN}', b'{"x":1,"x":2}', b" " * (M.MAX_PACKAGE_BYTES + 1)):
            with self.assertRaises(ValueError): bind("decision.semantic_relation", bindings[0]["task_input"], raw, hashlib.sha256(raw).hexdigest())


if __name__ == "__main__": unittest.main()
