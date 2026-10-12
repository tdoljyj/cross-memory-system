"""Numerical specification cases, not generated Dataset/Gold or live calls."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
RUNNER_PATH = ROOT / "scripts/model-program/saved_report_runner.py"
RUNNER_SPEC = importlib.util.spec_from_file_location("m2_saved_report_test_subject", RUNNER_PATH)
RUNNER = importlib.util.module_from_spec(RUNNER_SPEC)
RUNNER_SPEC.loader.exec_module(RUNNER)
run_saved = RUNNER.run_saved

METRIC_PATH = ROOT / "scripts/model-program/saved_output_metrics.py"
METRIC_SPEC = importlib.util.spec_from_file_location("replay_metric_test_dependency", METRIC_PATH)
METRICS = importlib.util.module_from_spec(METRIC_SPEC)
METRIC_SPEC.loader.exec_module(METRICS)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def seal(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def snapshot_seal(rows):
    # Independent, explicit source-byte identity oracle.
    return seal([{
        "id": r["id"], "input_sha256": r["input_sha256"],
        "terminal_status": r["terminal_status"], "usage": r["usage"],
        "split_id": r["split_id"],
        "raw_output_sha256": None if r["raw_output"] is None else
            hashlib.sha256(r["raw_output"]).hexdigest(),
    } for r in rows])


def fixture():
    rows = [{"id": "r1", "input_sha256": "a" * 64,
        "terminal_status": "succeeded", "usage": None, "split_id": "example-split",
        "raw_output": b'{"prediction":"A","probabilities":{"A":0.8,"B":0.2}}'}]
    split = {"split_id": "example-split", "purpose_id": "development",
        "experiment_scope": "SPECIFICATION_EXAMPLE", "allowed_consumers": ["example-reader"],
        "exposure_records": [], "final_holdout": False, "sample_ids": ["r1"],
        "schema_version": "0.1", "allowed_uses": {"selection": False}}
    policy = {"labels": ["A", "B"], "expected_request_ids": ["r1"],
        "status_categories": {"succeeded": "SUCCEEDED", "timeout": "TIMEOUT"},
        "probability_required": True, "reference_required": True,
        "loss_matrix": {"A": {"A": 0, "B": 2}, "B": {"A": 3, "B": 0}},
        "minimum_sample_count": 5, "quantile_probabilities": [.5],
        "quantile_method": "LINEAR_R7", "nll_epsilon": 1e-12,
        "ece_bin_edges": [0, .5, 1], "probability_sum_tolerance": 1e-12}
    sources = {role: {"ref": "SPECIFICATION_EXAMPLE:" + role, "sha256": str(i) * 64}
               for i, role in enumerate(("scorer", "projector", "normalization", "metrics", "renderer"), 1)}
    binding = {"snapshot_sha256": snapshot_seal(rows), "policy": policy,
        "policy_sha256": seal(policy), "split_sha256": seal(split),
        "dataset_revision_sha256": "c" * 64, "evaluation_revision_sha256": "d" * 64,
        "sources": sources, "source_locks": copy.deepcopy(sources),
        "provider_ref": "SPECIFICATION_EXAMPLE:provider", "model_ref": "SPECIFICATION_EXAMPLE:model",
        "model_revision_ref": "SPECIFICATION_EXAMPLE:revision", "profile_ref": None,
        "gold_ref": None, "threshold_ref": None, "evidence_kind": "SPECIFICATION_EXAMPLE"}
    consumer = {"id": "example-reader", "uses_for_selection": False}
    return rows, binding, split, consumer


def scorer(rows, binding, split):
    for row in rows:
        row["answer"] = json.loads(row["raw_output"].decode()) if row["raw_output"] else None
    return rows


def projector(scored, policy):
    result = []
    for saved in scored:
        answer = saved["answer"]
        success = saved["terminal_status"] == "succeeded"
        result.append({"id": saved["id"], "status": saved["terminal_status"],
            "usage": saved["usage"], "schema_valid": success, "reference_valid": success,
            "predicted_label": answer["prediction"] if success else None,
            "true_label": "A" if success else None,
            "probabilities": answer["probabilities"] if success else None,
            "auto_accepted": success, "decision": None,
            "correct": answer["prediction"] == "A" if success else False,
            "latency_ms": None, "tokens_input": None, "tokens_output": None,
            "cost": None, "currency": None})
    return result


def execute(parts, *, score=scorer, project=projector, render=canonical):
    return run_saved(*parts, score, project, METRICS.aggregate_metrics, render)


class SavedReplaySpecifications(unittest.TestCase):
    def test_saved_bytes_binding_and_two_replays_without_input_mutation(self):
        parts = fixture()
        before = copy.deepcopy(parts)
        result = execute(parts)
        self.assertEqual(parts, before)
        self.assertEqual(result["replay_digests"][0], result["replay_digests"][1])
        self.assertEqual(json.loads(result["rendered_bytes"]), result["report"])
        self.assertEqual(result["authority_effect"], "NONE")
        self.assertEqual(result["qualification"], "NOT_ISSUED")
        self.assertEqual(result["report"]["evidence_kind"], "SPECIFICATION_EXAMPLE")
        self.assertAlmostEqual(result["report"]["metrics"]["probability"]["brier"], .08)

    def test_each_identity_drift_is_rejected(self):
        for field in ("snapshot_sha256", "policy_sha256", "split_sha256"):
            parts = fixture()
            parts[1][field] = "0" * 64
            with self.subTest(field=field), self.assertRaises(ValueError):
                execute(parts)

    def test_source_drift_is_rejected(self):
        parts = fixture()
        parts[1]["sources"]["scorer"]["sha256"] = "0" * 64
        with self.assertRaises(ValueError):
            execute(parts)

    def test_raw_output_change_is_rejected_before_callbacks(self):
        parts = fixture()
        parts[0][0]["raw_output"] += b" "
        calls = []
        def never(*args):
            calls.append(True)
            return []
        with self.assertRaises(ValueError):
            execute(parts, score=never)
        self.assertEqual(calls, [])

    def test_final_and_qualification_results_cannot_enter_selection(self):
        for purpose in ("qualification", "final_holdout"):
            parts = fixture()
            parts[2].update(purpose_id=purpose, final_holdout=purpose == "final_holdout")
            parts[1]["split_sha256"] = seal(parts[2])
            parts[3]["uses_for_selection"] = True
            with self.subTest(purpose=purpose), self.assertRaises(ValueError):
                execute(parts)

    def test_known_selection_consumer_cannot_lie_about_its_use(self):
        for purpose in ("qualification", "final_holdout"):
            parts = fixture()
            parts[2].update(purpose_id=purpose, final_holdout=purpose == "final_holdout",
                           allowed_consumers=["M3_SELECTION_PREPARATION"])
            parts[1]["split_sha256"] = seal(parts[2])
            parts[3].update(id="M3_SELECTION_PREPARATION", uses_for_selection=False)
            calls = []
            def never(*args):
                calls.append(True)
                return scorer(*args)
            with self.subTest(purpose=purpose), self.assertRaises(ValueError):
                execute(parts, score=never)
            self.assertEqual(calls, [])

    def test_final_holdout_exposure_is_not_relabelled_unseen(self):
        parts = fixture()
        parts[2].update(purpose_id="final_holdout", final_holdout=True,
                       exposure_records=[{"used_for_selection": True}])
        parts[1]["split_sha256"] = seal(parts[2])
        with self.assertRaises(ValueError):
            execute(parts)

    def test_qualification_and_holdout_exposure_cannot_hide_selection(self):
        for purpose in ("qualification", "final_holdout"):
            for exposure in ({"consumer_id": "M3_SELECTION_PREPARATION", "used_for_selection": False},
                             {"consumer_id": "other-selector", "used_for_selection": True}):
                parts = fixture()
                parts[2].update(purpose_id=purpose, final_holdout=purpose == "final_holdout",
                               exposure_records=[exposure])
                parts[1]["split_sha256"] = seal(parts[2])
                with self.subTest(purpose=purpose, exposure=exposure), self.assertRaises(ValueError):
                    execute(parts)

    def test_unlisted_consumer_unknown_purpose_and_cross_split_rejected(self):
        for modification in ("consumer", "purpose", "split"):
            parts = fixture()
            if modification == "consumer":
                parts[3]["id"] = "unknown-consumer"
            elif modification == "purpose":
                parts[2]["purpose_id"] = "invented-purpose"
                parts[1]["split_sha256"] = seal(parts[2])
            else:
                parts[0][0]["split_id"] = "other-split"
                parts[1]["snapshot_sha256"] = snapshot_seal(parts[0])
            with self.subTest(modification=modification), self.assertRaises(ValueError):
                execute(parts)

    def test_missing_registered_request_cannot_disappear(self):
        parts = fixture()
        parts[0].clear()
        parts[1]["snapshot_sha256"] = snapshot_seal(parts[0])
        with self.assertRaises(ValueError):
            execute(parts)

    def test_scorer_must_preserve_usage_and_failed_requests(self):
        for field in ("usage", "terminal_status", "input_sha256"):
            parts = fixture()
            def changed(rows, binding, split):
                rows = scorer(rows, binding, split)
                rows[0][field] = {"input_tokens": 999} if field == "usage" else "modified"
                return rows
            with self.subTest(field=field), self.assertRaises(ValueError):
                execute(parts, score=changed)

    def test_projector_cannot_fabricate_observed_tokens(self):
        parts = fixture()
        def changed(rows, policy):
            projected = projector(rows, policy)
            projected[0]["tokens_input"] = 999
            return projected
        with self.assertRaises(ValueError):
            execute(parts, project=changed)

    def test_registered_runtime_failure_remains_in_report_and_denominator(self):
        parts = fixture()
        parts[0].append({"id": "r2", "input_sha256": "b" * 64,
            "raw_output": None, "terminal_status": "timeout", "usage": None,
            "split_id": "example-split"})
        parts[2]["sample_ids"].append("r2")
        parts[1]["policy"]["expected_request_ids"].append("r2")
        parts[1].update(snapshot_sha256=snapshot_seal(parts[0]),
                        split_sha256=seal(parts[2]), policy_sha256=seal(parts[1]["policy"]))
        report = execute(parts)["report"]
        self.assertEqual(len(report["requests"]), 2)
        self.assertEqual(report["metrics"]["quality"]["total_request_count"], 2)
        self.assertEqual(report["metrics"]["selective"]["coverage"], .5)
        self.assertEqual(report["metrics"]["outcomes"]["TIMEOUT"]["count"], 1)

    def test_observed_usage_and_minor_currency_units_are_preserved(self):
        parts = fixture()
        usage = {"input_tokens": 12, "output_tokens": 3, "latency_ms": 10,
            "cost_minor_units": 200, "currency": "USD", "currency_exponent": 2,
            "currency_profile_digest": "sha256:" + "e" * 64}
        parts[0][0]["usage"] = usage
        parts[1]["snapshot_sha256"] = snapshot_seal(parts[0])
        def observed(rows, policy):
            result = projector(rows, policy)
            result[0].update(tokens_input=12, tokens_output=3, latency_ms=10,
                             cost=2, currency="USD")
            return result
        report = execute(parts, project=observed)["report"]
        self.assertEqual(report["requests"][0]["usage"], usage)
        self.assertEqual(report["metrics"]["measurements"]["tokens_input"]["sum"], 12)
        self.assertEqual(report["metrics"]["measurements"]["cost_by_currency"]["USD"]["sum"], 2)

    def test_positive_cost_cannot_underflow_to_zero(self):
        parts = fixture()
        parts[0][0]["usage"] = {"cost_minor_units": 1, "currency_exponent": 400,
                                 "currency": "USD"}
        parts[1]["snapshot_sha256"] = snapshot_seal(parts[0])
        def underflow(rows, policy):
            result = projector(rows, policy)
            result[0].update(cost=0.0, currency="USD")
            return result
        with self.assertRaises(ValueError):
            execute(parts, project=underflow)

    def test_same_currency_incompatible_unit_profiles_are_not_averaged(self):
        parts = fixture()
        parts[0][0]["usage"] = {"cost_minor_units": 200, "currency_exponent": 2,
            "currency": "USD", "currency_profile_digest": "sha256:" + "a" * 64}
        second = copy.deepcopy(parts[0][0])
        second["id"] = "r2"
        second["usage"]["currency_profile_digest"] = "sha256:" + "b" * 64
        parts[0].append(second)
        parts[2]["sample_ids"].append("r2")
        parts[1]["policy"]["expected_request_ids"].append("r2")
        parts[1].update(snapshot_sha256=snapshot_seal(parts[0]), split_sha256=seal(parts[2]),
                        policy_sha256=seal(parts[1]["policy"]))
        def prices(rows, policy):
            result = projector(rows, policy)
            for row in result:
                row.update(cost=2, currency="USD")
            return result
        with self.assertRaises(ValueError):
            execute(parts, project=prices)

    def test_relabelled_usage_or_projector_status_is_rejected(self):
        for field in ("usage", "status"):
            def changed(rows, policy):
                result = projector(rows, policy)
                result[0][field] = {"input_tokens": 100} if field == "usage" else "timeout"
                return result
            with self.subTest(field=field), self.assertRaises(ValueError):
                execute(fixture(), project=changed)

    def test_live_saved_output_can_be_replayed_with_external_references(self):
        # This tests an API mode with invented refs, not real LIVE evidence.
        parts = fixture()
        parts[1].update(evidence_kind="LIVE_MODEL_MEASUREMENT",
                        gold_ref="API_EXAMPLE:gold", threshold_ref="API_EXAMPLE:threshold",
                        profile_ref="API_EXAMPLE:profile")
        report = execute(parts)["report"]
        self.assertEqual(report["evidence_kind"], "LIVE_MODEL_MEASUREMENT")
        self.assertEqual(report["qualification"], "NOT_ISSUED")
        self.assertEqual(report["external_inputs_required"], [])

    def test_missing_formal_inputs_remain_external(self):
        report = execute(fixture())["report"]
        self.assertTrue(report["external_inputs_required"])
        self.assertEqual(report["qualification"], "NOT_ISSUED")

    def test_live_measurement_cannot_import_hand_labels_without_gold(self):
        parts = fixture()
        parts[1]["evidence_kind"] = "LIVE_MODEL_MEASUREMENT"
        with self.assertRaises(ValueError):
            execute(parts)

    def test_renderer_cannot_change_or_hide_results(self):
        for renderer in (lambda report: b'{"fake":"success"}',
                         lambda report: b'{"a":1,"a":2}',
                         lambda report: b'{"a":NaN}'):
            with self.assertRaises(ValueError):
                execute(fixture(), render=renderer)

    def test_unstable_replay_is_rejected(self):
        count = [0]
        def unstable(rows, binding, split):
            rows = scorer(rows, binding, split)
            count[0] += 1
            rows[0]["replay_variant"] = count[0]
            return rows
        with self.assertRaises(ValueError):
            execute(fixture(), score=unstable)


if __name__ == "__main__":
    unittest.main()
