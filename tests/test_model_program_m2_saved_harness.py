"""Orchestration semantics on existing numerical examples; no real evaluation."""
import copy
import builtins
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
REPLAY_DIR = ROOT / "scripts/model-program"


def private_source(path, name, dependencies=None):
    """Use real Source bytes with private dependency resolution, no global registry."""
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    namespace = vars(builtins).copy()
    dependencies = dependencies or {}
    def resolve(import_name, globals=None, locals=None, fromlist=(), level=0):
        if level == 0 and import_name in dependencies:
            return dependencies[import_name]
        return builtins.__import__(import_name, globals, locals, fromlist, level)
    namespace["__import__"] = resolve
    module.__dict__["__builtins__"] = namespace
    spec.loader.exec_module(module)
    return module


RUNNER = private_source(REPLAY_DIR / "saved_report_runner.py", "private_harness_runner_dependency")
DEPENDENCIES = {"saved_report_runner": RUNNER}
HARNESS = private_source(REPLAY_DIR / "saved_harness.py", "private_harness_under_test", DEPENDENCIES)
EXAMPLES = private_source(Path(__file__).with_name("test_model_program_m2_saved_report_runner.py"), "private_harness_replay_examples", DEPENDENCIES)
run_harness, CONTROL_ROLES = HARNESS.run_harness, HARNESS.CONTROL_ROLES
run_saved = RUNNER.run_saved


def case(slot_id, executor="A", *, group="fixed-workflow"):
    snapshot, binding, split, consumer = EXAMPLES.fixture()
    binding["model_ref"] = "SPECIFICATION_EXAMPLE:executor-" + executor
    controls = {key: "SPECIFICATION_EXAMPLE:" + key for key in CONTROL_ROLES}
    slot = {"slot_id": slot_id, "suite_ref": "SPECIFICATION_EXAMPLE:Clued Core",
        "workflow_ref": "SPECIFICATION_EXAMPLE:decision.semantic_relation",
        "comparison_group": group, "controls": controls, "binding": copy.deepcopy(binding),
        "split": copy.deepcopy(split), "consumer": copy.deepcopy(consumer),
        "input_requests": [{k: row[k] for k in ("id", "input_sha256", "split_id")} for row in snapshot],
        "requirement_refs": ["SPECIFICATION_EXAMPLE:fixed-workflow-executor-control"]}
    run = {"snapshot": snapshot, "binding": binding, "split": split, "consumer": consumer,
        "scorer": EXAMPLES.scorer, "projector": EXAMPLES.projector,
        "metrics": EXAMPLES.METRICS.aggregate_metrics, "renderer": EXAMPLES.canonical}
    return slot, run


class HarnessSemantics(unittest.TestCase):
    def test_real_replay_keeps_all_registered_slots_and_original_inputs(self):
        first, first_run = case("branch-A")
        second, second_run = case("branch-B", "B")
        second_run["snapshot"][0]["raw_output"] = b'{"prediction":"B","probabilities":{"A":0.2,"B":0.8}}'
        second_run["binding"]["snapshot_sha256"] = EXAMPLES.snapshot_seal(second_run["snapshot"])
        second["binding"] = copy.deepcopy(second_run["binding"])
        registered, saved = [first, second], {"branch-A": first_run, "branch-B": second_run}
        before = copy.deepcopy((registered, saved))
        report = run_harness(registered, saved, run_saved, consumer=first["consumer"])
        self.assertEqual((registered, saved), before)
        self.assertEqual(report["slot_status_counts"], {"REPLAYED_CANDIDATE": 2})
        self.assertEqual(report["registered_replay_completeness"], "ALL_REGISTERED_SLOTS_REPLAYED")
        self.assertEqual(report["formal_suite_workflow_coverage"], "NOT_ESTABLISHED")
        self.assertEqual(report["qualification"], "NOT_ISSUED")
        # Independent outcome expectation: correct executor A, incorrect executor B.
        metrics = [r["replay"]["report"]["metrics"] for r in report["slots"]]
        self.assertEqual([m["quality"]["correct_count"] for m in metrics], [1, 0])

    def test_missing_not_admitted_and_failure_are_not_dropped(self):
        slots = [case(name, group=None)[0] for name in ("missing", "inaccessible", "failed", "healthy")]
        failed_run, healthy_run = case("failed", group=None)[1], case("healthy", group=None)[1]
        calls = []
        def real_or_failure(**kwargs):
            calls.append(kwargs["binding"]["model_ref"])
            if len(calls) == 1:
                raise RuntimeError("private failure detail must not enter the summary")
            return run_saved(**kwargs)
        saved = {"inaccessible": {"not_admitted_reason": {"source_ref": "SPECIFICATION_EXAMPLE:access",
                  "reason_code": "ACCESS_NOT_ADMITTED"}}, "failed": failed_run, "healthy": healthy_run}
        report = run_harness(slots, saved, real_or_failure, consumer=slots[0]["consumer"])
        self.assertEqual([s["status"] for s in report["slots"]],
            ["EXTERNAL_INPUT_REQUIRED", "NOT_ADMITTED", "FAILED_SLOT", "REPLAYED_CANDIDATE"])
        self.assertEqual(len(calls), 2)
        self.assertNotIn("private failure detail", repr(report))
        self.assertEqual(report["registered_replay_completeness"], "INCOMPLETE")

    def test_control_drift_rejected_before_any_replay(self):
        for key in ("context_snapshot_ref", "budget_ref", "allowed_side_effects_ref", "scope_ref"):
            first, first_run = case("A")
            second, second_run = case("B", "B")
            second["controls"][key] = "SPECIFICATION_EXAMPLE:changed"
            calls = []
            with self.subTest(key=key), self.assertRaises(ValueError):
                run_harness([first, second], {"A": first_run, "B": second_run},
                            lambda **kwargs: calls.append(kwargs), consumer=first["consumer"])
            self.assertEqual(calls, [])

    def test_source_gold_threshold_profile_and_policy_cannot_change_in_comparison(self):
        for key in ("gold_ref", "threshold_ref", "profile_ref", "sources", "policy"):
            first, first_run = case("A")
            second, second_run = case("B", "B")
            if key == "sources":
                second["binding"][key]["scorer"]["sha256"] = "0" * 64
            elif key == "policy":
                second["binding"][key]["nll_epsilon"] = .001
            else:
                second["binding"][key] = "SPECIFICATION_EXAMPLE:changed"
            calls = []
            with self.subTest(key=key), self.assertRaises(ValueError):
                run_harness([first, second], {"A": first_run, "B": second_run},
                            lambda **kwargs: calls.append(kwargs), consumer=first["consumer"])
            self.assertEqual(calls, [])

    def test_aggregate_selection_cannot_launder_qualification_or_holdout(self):
        for purpose in ("qualification", "final_holdout", "training", "calibration_fit"):
            first, first_run = case("development", group=None)
            second, second_run = case("protected", group=None)
            recipient = {"id": "M3_SELECTION_PREPARATION", "uses_for_selection": True}
            for slot, run in ((first, first_run), (second, second_run)):
                slot["consumer"] = copy.deepcopy(recipient)
                slot["split"]["allowed_consumers"] = [recipient["id"]]
                run["consumer"] = copy.deepcopy(recipient)
                run["split"] = copy.deepcopy(slot["split"])
            second["split"].update(purpose_id=purpose, final_holdout=purpose == "final_holdout")
            second_run["split"] = copy.deepcopy(second["split"])
            calls = []
            with self.subTest(purpose=purpose), self.assertRaises(ValueError):
                run_harness([first, second], {"development": first_run, "protected": second_run},
                            lambda **kwargs: calls.append(kwargs), consumer=recipient)
            self.assertEqual(calls, [])

    def test_outer_recipient_cannot_replace_original_reader(self):
        slot, run = case("A")
        slot["split"]["allowed_consumers"].append("M3_SELECTION_PREPARATION")
        calls = []
        with self.assertRaises(ValueError):
            run_harness([slot], {"A": run}, lambda **kwargs: calls.append(kwargs),
                consumer={"id": "M3_SELECTION_PREPARATION", "uses_for_selection": True})
        self.assertEqual(calls, [])

    def test_no_coverage_claim_from_empty_or_missing_inputs(self):
        slot, _ = case("missing")
        slot["controls"]["context_snapshot_ref"] = None
        report = run_harness([slot], {}, run_saved, consumer=slot["consumer"])
        self.assertIn("controls.context_snapshot_ref", report["slots"][0]["external_inputs_required"])
        empty = run_harness([], {}, run_saved, consumer=slot["consumer"])
        self.assertEqual(empty["registered_replay_completeness"], "INCOMPLETE")
        self.assertEqual(empty["formal_suite_workflow_coverage"], "NOT_ESTABLISHED")

    def test_blank_reference_cannot_mark_missing_run_inputs_present(self):
        for field in ("gold_ref", "threshold_ref", "profile_ref", "model_ref"):
            for blank in ("", {}, False, 0):
                slot, _ = case("missing")
                slot["binding"][field] = blank
                with self.subTest(field=field, blank=blank), self.assertRaises(ValueError):
                    run_harness([slot], {}, run_saved, consumer=slot["consumer"])
        for field in ("context_snapshot_ref", "budget_ref"):
            for blank in ("", {}, False, 0):
                slot, _ = case("missing")
                slot["controls"][field] = blank
                with self.subTest(field=field, blank=blank), self.assertRaises(ValueError):
                    run_harness([slot], {}, run_saved, consumer=slot["consumer"])
        for field in ("suite_ref", "workflow_ref"):
            for blank in ("", {}, False, 0):
                slot, _ = case("missing")
                slot[field] = blank
                with self.subTest(field=field, blank=blank), self.assertRaises(ValueError):
                    run_harness([slot], {}, run_saved, consumer=slot["consumer"])

    def test_minimal_fake_replay_does_not_establish_completeness(self):
        slot, run = case("A")
        def fake(**kwargs):
            return {"authority_effect": "NONE", "qualification": "NOT_ISSUED", "report": {
                "source_binding": kwargs["binding"], "split": kwargs["split"],
                "consumer": kwargs["consumer"], "authority_effect": "NONE", "qualification": "NOT_ISSUED"}}
        result = run_harness([slot], {"A": run}, fake, consumer=slot["consumer"])
        self.assertEqual(result["slots"][0]["status"], "FAILED_SLOT")
        self.assertEqual(result["registered_replay_completeness"], "INCOMPLETE")

    def test_two_digest_render_request_and_score_carriers_are_required(self):
        for field in ("replay_digests", "rendered_bytes", "requests", "scores", "metrics"):
            slot, run = case("A")
            def incomplete(**kwargs):
                result = run_saved(**kwargs)
                (result if field in ("replay_digests", "rendered_bytes") else result["report"]).pop(field)
                return result
            result = run_harness([slot], {"A": run}, incomplete, consumer=slot["consumer"])
            with self.subTest(field=field):
                self.assertEqual(result["slots"][0]["status"], "FAILED_SLOT")
                self.assertEqual(result["registered_replay_completeness"], "INCOMPLETE")

    def test_replay_digest_drift_is_not_a_successful_slot(self):
        slot, run = case("A")
        def drifted(**kwargs):
            result = run_saved(**kwargs)
            result["replay_digests"][1]["report_sha256"] = "0" * 64
            return result
        result = run_harness([slot], {"A": run}, drifted, consumer=slot["consumer"])
        self.assertEqual(result["slots"][0]["status"], "FAILED_SLOT")

    def test_duplicate_or_unregistered_branch_rejected(self):
        slot, run = case("A")
        for registered, saved in (([slot, slot], {"A": run}), ([slot], {"extra": run})):
            with self.assertRaises(ValueError):
                run_harness(registered, saved, run_saved, consumer=slot["consumer"])

    def test_callback_mutation_of_its_copy_marks_slot_failure(self):
        slot, run = case("A")
        def mutating(**kwargs):
            result = run_saved(**kwargs)
            kwargs["snapshot"][0]["usage"] = {"input_tokens": 7}
            return result
        result = run_harness([slot], {"A": run}, mutating, consumer=slot["consumer"])
        self.assertEqual(result["slots"][0]["status"], "FAILED_SLOT")
        self.assertIsNone(run["snapshot"][0]["usage"])

    def test_callback_mutation_of_original_is_not_returned_as_success(self):
        slot, run = case("A")
        def mutating(**kwargs):
            result = run_saved(**kwargs)
            slot["controls"]["budget_ref"] = "SPECIFICATION_EXAMPLE:changed-by-callback"
            return result
        with self.assertRaises(ValueError):
            run_harness([slot], {"A": run}, mutating, consumer=slot["consumer"])


if __name__ == "__main__":
    unittest.main()
