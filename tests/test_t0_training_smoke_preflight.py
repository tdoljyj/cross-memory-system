"""Policy-only T0 tests. Never call forward, NLL, SGD or actual training.

Actual runner/recipe bytes are read; fabricated issued/Host objects below are
attack inputs, never authority fixtures or a successful execution admission.
"""
import ast
from contextlib import ExitStack, redirect_stdout
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "scripts/model-program/run_t0_training_smoke.py"
RECIPE = ROOT / "development/contracts/model-program/stage-admission/T0TrainingRecipe.v0.1.json"
PROFILE = ROOT / "development/contracts/model-program/stage-admission/ExperimentAuthorizationProfile.T0.candidate.json"


def import_runner(name):
    spec = importlib.util.spec_from_file_location(name, RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class T0PreparationPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runner_raw = RUNNER.read_bytes()
        tree = ast.parse(cls.runner_raw, filename=str(RUNNER))
        # All training calls must be within function bodies, never module import.
        forbidden = {"run_training_smoke", "sgd_step", "forward_loss", "checkpoint_validate"}
        for statement in tree.body:
            if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            for node in ast.walk(statement):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in forbidden:
                    raise AssertionError("training call reachable at module import: " + node.func.id)
        cls.module = import_runner("t0_policy_only_under_test")

    def setUp(self):
        self.recipe_raw = RECIPE.read_bytes()
        self.recipe = json.loads(self.recipe_raw)
        self.candidate = json.loads(PROFILE.read_text(encoding="utf-8"))
        self.runner_sha = hashlib.sha256(self.runner_raw).hexdigest()
        self.recipe_sha = hashlib.sha256(self.recipe_raw).hexdigest()

    def guards(self):
        stack = ExitStack()
        training = {}
        for name in ("run_training_smoke", "sgd_step", "forward_loss", "checkpoint_validate"):
            training[name] = stack.enter_context(patch.object(self.module, name, side_effect=AssertionError("FORBIDDEN actual model operation: " + name)))
        writes = {}
        for name in ("mkdir", "write_text", "write_bytes"):
            writes[name] = stack.enter_context(patch.object(Path, name, side_effect=AssertionError("FORBIDDEN filesystem mutation")))
        writes["exclusive_json"] = stack.enter_context(patch.object(self.module, "exclusive_json", side_effect=AssertionError("FORBIDDEN artifact mutation")))
        return stack, training, writes

    def assert_untouched(self, training, writes):
        for item in list(training.values()) + list(writes.values()):
            item.assert_not_called()

    def fabricated_issued_metadata(self):
        # Complete-looking caller data intentionally simulates forgery.
        return {"status": "ISSUED", "task_id": self.module.TASK_ID, "tier": "T0",
                "recipe_id": self.module.RECIPE_ID, "training_allowed": True,
                "production_allowed": False, "qualification_allowed": False,
                "dataset_parent_boundary": "TRAINING", "dataset_purpose_id": "training",
                "corpus_sha256": self.recipe["corpus_sha256"],
                "source_lock": {"runner_sha256": self.runner_sha, "recipe_sha256": self.recipe_sha},
                "max_attempts": 1, "max_sgd_updates": 16, "max_wall_seconds": 30,
                "host_hard_timeout_seconds": 120, "max_artifact_bytes": 1048576,
                "output_root": str(self.module.OUTPUT_ROOT)}

    def fabricated_host_metadata(self):
        return {"status": "EXTERNALLY_ADMITTED_FOR_EXACT_EXECUTION", "task_id": self.module.TASK_ID,
                "fence": 121, "owner_authority_ref": "unverified-owner-ref",
                "claim_id": "unverified-claim-ref", "data_permission_ref": "unverified-data-ref",
                "device_ref": "unverified-device-ref", "window_ref": "unverified-window-ref",
                "profile_record_ref": "unverified-issued-profile-ref"}

    def precheck(self, profile=None, host=None, **kwargs):
        arguments = {"runner_sha256": self.runner_sha, "recipe_sha256": self.recipe_sha, "output_exists": False}
        arguments.update(kwargs)
        return self.module.preflight_execute(self.recipe, self.fabricated_issued_metadata() if profile is None else profile,
                                             host, **arguments)

    def test_actual_artifact_source_and_corpus_binding(self):
        self.assertEqual(self.recipe["runner_sha256"], self.runner_sha)
        self.assertEqual(self.recipe["corpus_sha256"], hashlib.sha256(self.recipe["corpus"].encode("ascii")).hexdigest())
        self.assertEqual(self.recipe["corpus"], "abacabadabacabad")
        self.assertEqual(self.recipe["dataset_parent_boundary"], "TRAINING")
        self.assertEqual(self.recipe["dataset_purpose_id"], "training")
        self.assertGreaterEqual(self.candidate["budget"]["max_steps"], 16)
        self.assertFalse(self.candidate["training_allowed"])

    def test_import_has_no_training_or_filesystem_mutation(self):
        with patch.object(Path, "mkdir", side_effect=AssertionError("import mutation")), \
             patch.object(Path, "write_text", side_effect=AssertionError("import mutation")), \
             patch.object(Path, "write_bytes", side_effect=AssertionError("import mutation")):
            imported = import_runner("t0_second_import_policy_only")
        self.assertTrue(callable(imported.build_plan))

    def test_default_plan_does_not_forward_update_or_write(self):
        stack, training, writes = self.guards()
        with stack:
            plan = self.module.build_plan(self.recipe, self.candidate)
            self.assertEqual(plan["actual_execution"], "NONE")
            self.assertEqual(plan["authority_effect"], "NONE")
            self.assertEqual(plan["qualification"], "NOT_ISSUED")
            self.assertFalse(plan["execution_ready"])
            self.assert_untouched(training, writes)

    def test_default_cli_only_prints_a_plan(self):
        stack, training, writes = self.guards()
        output = io.StringIO()
        with stack, redirect_stdout(output):
            self.assertEqual(self.module.main([]), 0)
            self.assert_untouched(training, writes)
        plan = json.loads(output.getvalue())
        self.assertEqual(plan["actual_execution"], "NONE")
        self.assertEqual(plan["total_sgd_updates"], 16)

    def test_all_trajectories_count_toward_the_single_budget(self):
        plan = self.module.build_plan(self.recipe, self.candidate)
        self.assertEqual(plan["trajectories"], {"control": 8, "checkpoint_segment": 4, "resume_segment": 4})
        self.assertEqual(sum(plan["trajectories"].values()), plan["total_sgd_updates"])
        self.assertEqual(plan["parameter_count"], 16)
        self.assertEqual(plan["attempts"], 1)

    def test_plan_counts_forward_computation_without_doing_it(self):
        stack, training, writes = self.guards()
        with stack:
            plan = self.module.build_plan(self.recipe, self.candidate)
            self.assertEqual(plan["loss_evaluations"], 17)
            self.assertEqual(plan["full_batch_compute_passes"], plan["total_sgd_updates"] + plan["loss_evaluations"])
            self.assertEqual(plan["full_batch_compute_passes"], 33)
            self.assertEqual(plan["softmax_pair_evaluations"], 33 * (len(self.recipe["corpus"]) - 1))
            self.assertEqual(plan["softmax_pair_evaluations"], 495)
            self.assert_untouched(training, writes)

    def test_unknown_recipe_operation_rejected(self):
        changed = copy.deepcopy(self.recipe)
        changed["post_training_command"] = "caller-selected-operation"
        with self.assertRaises(self.module.PreflightError):
            self.module.build_plan(changed, self.candidate)

    def test_compute_scope_declaration_drift_rejected_without_computation(self):
        expected = {"optimizer_updates": 16, "loss_evaluations": 17, "full_batch_compute_passes": 33,
                    "training_pairs": 15, "softmax_pair_evaluations": 495,
                    "max_scalar_exp_evaluations": 1980, "external_model_or_provider_calls": 0,
                    "zero_compute_claim": False}
        self.assertEqual(self.recipe["compute_scope"], expected)
        stack, training, writes = self.guards()
        with stack:
            for key, value in expected.items():
                changed = copy.deepcopy(self.recipe)
                changed["compute_scope"][key] = True if type(value) is bool else value + 1
                with self.subTest(key=key), self.assertRaises(self.module.PreflightError):
                    self.module.build_plan(changed, self.candidate)
            changed = copy.deepcopy(self.recipe)
            changed["compute_scope"]["optimizer_updates"] = True
            with self.assertRaises(self.module.PreflightError):
                self.module.build_plan(changed, self.candidate)
            self.assert_untouched(training, writes)

    def test_complete_looking_local_precheck_still_is_not_host_admission(self):
        stack, training, writes = self.guards()
        with stack:
            result = self.precheck(host=self.fabricated_host_metadata())
            self.assertEqual(result["actual_execution"], "NONE")
            self.assertEqual(result["authority_effect"], "NONE")
            self.assertEqual(result["qualification"], "NOT_ISSUED")
            self.assertFalse(result["execution_ready"])
            self.assertFalse(result["trusted_execution_bridge_available"])
            self.assert_untouched(training, writes)

    def test_recipe_type_and_exact_bounds_rejected_without_training(self):
        for key, value in (("attempts", True), ("total_sgd_updates", True), ("control_steps", 9),
                           ("checkpoint_steps", 5), ("resume_steps", 5), ("parameter_count", 17),
                           ("cooperative_wall_seconds", 31), ("host_hard_timeout_seconds", 121),
                           ("max_artifact_bytes", 1048577), ("learning_rate", float("nan"))):
            with self.subTest(key=key):
                changed = copy.deepcopy(self.recipe)
                changed[key] = value
                with self.assertRaises(self.module.PreflightError):
                    self.module.build_plan(changed, self.candidate)

    def test_learning_cannot_borrow_development_or_holdout_purpose(self):
        for parent, purpose in (("DEVELOPMENT", "development"), ("QUALIFICATION", "qualification"),
                                ("FINAL_HOLDOUT", "final_holdout"), ("TRAINING", "development")):
            changed = copy.deepcopy(self.recipe)
            changed["dataset_parent_boundary"], changed["dataset_purpose_id"] = parent, purpose
            with self.assertRaises(self.module.PreflightError):
                self.module.build_plan(changed, self.candidate)

    def test_corpus_and_vocabulary_cannot_change_under_same_recipe(self):
        for key, value in (("corpus", "PRIVATE_OR_PROTECTED48"), ("vocabulary", ["a", "b", "c", "e"]),
                           ("corpus_sha256", "0" * 64)):
            changed = copy.deepcopy(self.recipe)
            changed[key] = value
            with self.assertRaises(self.module.PreflightError):
                self.module.build_plan(changed, self.candidate)

    def test_candidate_profile_is_not_an_issued_execution_profile(self):
        with self.assertRaisesRegex(self.module.PreflightError, "ISSUED|ADMISSION|AUTHORITY"):
            self.precheck(profile=self.candidate)

    def test_caller_boolean_does_not_replace_external_host(self):
        for host in (True, {"verified": True}, {"status": "EXTERNALLY_ADMITTED_FOR_EXACT_EXECUTION", "verified": True}):
            with self.assertRaises(self.module.PreflightError):
                self.precheck(host=host)

    def test_source_pin_drift_rejected_before_any_effect(self):
        with self.assertRaisesRegex(self.module.PreflightError, "PIN|HASH|SOURCE"):
            self.precheck(runner_sha256="f" * 64)
        with self.assertRaisesRegex(self.module.PreflightError, "PIN|HASH|SOURCE"):
            self.precheck(recipe_sha256="f" * 64)

    def test_output_collision_stops_without_overwrite_or_retry(self):
        stack, training, writes = self.guards()
        with stack, self.assertRaisesRegex(self.module.PreflightError, "COLLISION|OUTPUT"):
            self.precheck(output_exists=True)
        self.assert_untouched(training, writes)

    def test_issued_metadata_exact_budget_and_target_guards(self):
        for key, value in (("tier", "T1"), ("task_id", "other-task"), ("max_attempts", True),
                           ("max_sgd_updates", 17), ("max_wall_seconds", 31),
                           ("host_hard_timeout_seconds", 121), ("max_artifact_bytes", 1048577),
                           ("output_root", "outside-proposed-root"), ("production_allowed", True)):
            changed = self.fabricated_issued_metadata()
            changed[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(self.module.PreflightError, "EXACT|BUDGET|ATTEMPT|SIXTEEN|PRODUCTION|ARTIFACT|TYPE|INTEGER"):
                self.precheck(profile=changed)

    def test_execute_flag_without_host_never_reaches_model_or_output(self):
        stack, training, writes = self.guards()
        with stack, redirect_stdout(io.StringIO()):
            self.assertNotEqual(self.module.main(["--execute"]), 0)
            self.assert_untouched(training, writes)

    def test_complete_fabricated_json_cannot_launch_training(self):
        profile, host = self.fabricated_issued_metadata(), self.fabricated_host_metadata()
        profile_raw = json.dumps(profile, sort_keys=True).encode()
        profile_sha = hashlib.sha256(profile_raw).hexdigest()
        def loader(path):
            if path == self.module.RECIPE_PATH:
                return self.recipe_raw, self.recipe
            if str(path) == "fabricated-issued.json":
                return profile_raw, profile
            if str(path) == "fabricated-host.json":
                return json.dumps(host).encode(), host
            raise AssertionError("Unexpected read outside controlled policy fixture")
        stack, training, writes = self.guards()
        with stack, patch.object(self.module, "load_bounded_json", side_effect=loader), \
             patch.object(self.module, "no_reparse_chain"), patch.object(Path, "exists", return_value=False), \
             patch.object(Path, "read_bytes", return_value=self.runner_raw), redirect_stdout(io.StringIO()):
            result = self.module.main(["--execute", "--issued-profile", "fabricated-issued.json",
                                       "--profile-sha256", profile_sha, "--host-verified-context", "fabricated-host.json"])
            self.assertNotEqual(result, 0)
            self.assert_untouched(training, writes)


if __name__ == "__main__":
    unittest.main()
