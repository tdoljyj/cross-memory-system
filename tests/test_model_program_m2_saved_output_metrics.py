"""Independent numeric specifications for the M2-10 arithmetic supplement.

These are small mathematical examples, not Dataset/Gold or model measurements.
Expected values follow adopted plan 17.7 and hand-computed confusion matrices.
"""
import copy
import importlib.util
import math
from pathlib import Path
import unittest

SOURCE = Path(__file__).resolve().parents[1] / "scripts/model-program/saved_output_metrics.py"
SPEC = importlib.util.spec_from_file_location("m2_saved_output_metric_candidate", SOURCE)
METRICS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(METRICS)
aggregate_metrics = METRICS.aggregate_metrics
quantiles = METRICS.quantiles
ranking_metrics = METRICS.ranking_metrics


def policy(ids, *, probability_required=True):
    result = {
        "labels": ["A", "B", "C"],
        "expected_request_ids": ids,
        "probability_required": probability_required,
        "reference_required": True,
        "status_categories": {
            "succeeded": "SUCCEEDED", "timeout": "TIMEOUT",
            "unavailable": "UNAVAILABLE", "budget": "BUDGET_FAILURE",
            "invalid": "SCHEMA_INVALID", "cancelled": "CANCELLED",
        },
        "loss_matrix": {
            "A": {"A": 0, "B": 2, "C": 10},
            "B": {"A": 3, "B": 0, "C": 4},
            "C": {"A": 7, "B": 5, "C": 0},
        },
        "minimum_sample_count": 5,
        "quantile_probabilities": [0, 0.5, 0.95, 1],
        "quantile_method": "LINEAR_R7",
    }
    if probability_required:
        result.update(nll_epsilon=1e-12, ece_bin_edges=[0, 0.5, 1],
                      probability_sum_tolerance=1e-12)
    return result


def row(identifier, true="A", predicted="A", probabilities=None, *, auto=True):
    return {
        "id": identifier, "status": "succeeded", "schema_valid": True,
        "reference_valid": True, "true_label": true,
        "predicted_label": predicted, "probabilities": probabilities,
        "auto_accepted": auto, "decision": None,
        "correct": None if true is None else true == predicted,
        "latency_ms": None, "tokens_input": None, "tokens_output": None,
        "cost": None, "currency": None,
    }


def numerical_rows():
    return [
        row("r1", "A", "A", {"A": .8, "B": .1, "C": .1}),
        row("r2", "B", "B", {"A": .2, "B": .6, "C": .2}),
        row("r3", "A", "C", {"A": .1, "B": .2, "C": .7}, auto=False),
    ]


class MetricSpecifications(unittest.TestCase):
    def rejection(self, rows, frozen_policy):
        with self.assertRaises(ValueError):
            aggregate_metrics(rows, frozen_policy)

    def test_multiclass_hand_oracle_and_rare_class(self):
        report = aggregate_metrics(numerical_rows(), policy(["r1", "r2", "r3"]))
        # (.06 + .24 + 1.34)/3. The adopted convention does not divide by K.
        self.assertAlmostEqual(report["probability"]["brier"], 1.64 / 3)
        self.assertAlmostEqual(report["probability"]["nll"],
                               -(math.log(.8) + math.log(.6) + math.log(.1)) / 3)
        # All three confidences are in [.5,1]; mean=.7, accuracy=2/3.
        self.assertAlmostEqual(report["probability"]["ece"], 1 / 30)
        matrix = report["classification"]["confusion_matrix"]
        self.assertEqual(matrix["A"]["A"], 1)
        self.assertEqual(matrix["A"]["C"], 1)
        self.assertEqual(matrix["B"]["B"], 1)
        classes = report["classification"]["per_class"]
        self.assertEqual(classes["A"]["precision"], 1)
        self.assertEqual(classes["A"]["recall"], .5)
        self.assertEqual(classes["C"]["precision"], 0)
        self.assertIsNone(classes["C"]["recall"])
        self.assertEqual(report["authority_effect"], "NONE")
        self.assertEqual(report["gate_verdict"], "NOT_ISSUED")
        self.assertEqual(report["confidence_intervals"], "NOT_COMPUTED")

    def test_failures_remain_in_overall_denominator(self):
        rows = numerical_rows()
        for identifier, status in [("r4", "timeout"), ("r5", "unavailable"),
                                   ("r6", "budget")]:
            item = row(identifier, None, None, auto=False)
            item.update(status=status, schema_valid=False, correct=False)
            rows.append(item)
        report = aggregate_metrics(rows, policy([r["id"] for r in rows]))
        self.assertEqual(report["quality"]["total_request_count"], 6)
        self.assertAlmostEqual(report["quality"]["success_fraction_all_requests"], 2 / 6)
        self.assertAlmostEqual(report["selective"]["coverage"], 2 / 6)
        self.assertEqual(report["selective"]["risk"]["value"], 0)
        self.assertEqual(report["selective"]["risk"]["denominator"], 2)
        self.assertEqual(report["selective"]["abstain_count"], 0)
        for category in ("TIMEOUT", "UNAVAILABLE", "BUDGET_FAILURE"):
            self.assertEqual(report["outcomes"][category]["count"], 1)

    def test_frozen_loss_is_not_unweighted_error_rate(self):
        rows = numerical_rows()
        rows[2]["auto_accepted"] = True
        result = aggregate_metrics(rows, policy(["r1", "r2", "r3"]))
        self.assertAlmostEqual(result["selective"]["risk"]["value"], 10 / 3)

    def test_zero_automatic_requests_do_not_prove_zero_risk(self):
        rows = numerical_rows()
        for item in rows:
            item["auto_accepted"] = False
        result = aggregate_metrics(rows, policy(["r1", "r2", "r3"]))
        self.assertEqual(result["selective"]["coverage"], 0)
        self.assertEqual(result["selective"]["risk"]["status"], "UNDEFINED")
        self.assertIsNone(result["selective"]["risk"]["value"])

    def test_no_requests_preserves_undefined_fraction(self):
        result = aggregate_metrics([], policy([]))
        self.assertIsNone(result["selective"]["coverage"])
        self.assertIsNone(result["quality"]["success_fraction_all_requests"])

    def test_missing_gold_remains_unknown(self):
        item = row("r1", None, "A", {"A": .8, "B": .1, "C": .1})
        result = aggregate_metrics([item], policy(["r1"]))
        self.assertEqual(result["quality"]["unknown_count"], 1)
        self.assertIsNone(result["quality"]["success_fraction_all_requests"])
        self.assertEqual(result["selective"]["risk"]["denominator"], 1)
        self.assertEqual(result["selective"]["risk"]["status"], "INCOMPLETE")

    def test_raw_score_policy_does_not_invent_probabilities(self):
        result = aggregate_metrics([row("r1")], policy(["r1"], probability_required=False))
        self.assertEqual(result["probability"]["status"], "NOT_APPLICABLE")
        self.assertIsNone(result["probability"]["brier"])

    def test_predeclared_request_count_cannot_hide_a_failure(self):
        self.rejection(numerical_rows(), policy(["r1", "r2", "r3", "failed-r4"]))
        self.rejection(numerical_rows(), policy(["r1", "r2"]))

    def test_duplicate_request_rejected(self):
        self.rejection([numerical_rows()[0]] * 2, policy(["r1"]))

    def test_unknown_status_is_not_success(self):
        item = numerical_rows()[0]
        item["status"] = "new_unknown_status"
        self.rejection([item], policy(["r1"]))

    def test_invalid_automatic_request_rejected(self):
        for changes in ({"schema_valid": False}, {"status": "timeout", "correct": False},
                        {"reference_valid": False}):
            item = numerical_rows()[0]
            item.update(changes)
            self.rejection([item], policy(["r1"]))

    def test_invalid_probabilities_rejected(self):
        for probabilities in ({"A": .8, "B": .1},
                              {"A": .8, "B": .1, "C": .2},
                              {"A": float("nan"), "B": .1, "C": .1},
                              {"A": float("inf"), "B": .1, "C": .1},
                              {"A": True, "B": 0, "C": 0},
                              {"A": -1, "B": 1, "C": 1}):
            item = numerical_rows()[0]
            item["probabilities"] = probabilities
            self.rejection([item], policy(["r1"]))

    def test_required_automatic_probability_cannot_be_missing(self):
        self.rejection([row("r1")], policy(["r1"]))

    def test_required_reference_cannot_treat_unknown_as_observed(self):
        item = numerical_rows()[0]
        item["reference_valid"] = None
        self.rejection([item], policy(["r1"]))

    def test_false_success_claim_is_rejected(self):
        item = numerical_rows()[2]
        item["correct"] = True
        self.rejection([item], policy(["r3"]))

    def test_frozen_probability_policy_required(self):
        for key in ("nll_epsilon", "ece_bin_edges", "probability_sum_tolerance"):
            frozen = policy(["r1"])
            del frozen[key]
            self.rejection([numerical_rows()[0]], frozen)

    def test_unknown_labels_rejected(self):
        item = numerical_rows()[0]
        item["true_label"] = "unknown"
        self.rejection([item], policy(["r1"]))

    def test_measurement_missing_is_not_zero_and_currency_is_not_averaged(self):
        rows = numerical_rows()
        rows[0].update(latency_ms=10, cost=1, currency="USD")
        rows[1].update(latency_ms=30, cost=4, currency="CNY")
        result = aggregate_metrics(rows, policy(["r1", "r2", "r3"]))
        measurements = result["measurements"]
        self.assertEqual(measurements["latency_ms"]["count"], 2)
        self.assertEqual(measurements["latency_ms"]["missing_count"], 1)
        self.assertEqual(measurements["latency_ms"]["quantiles"]["0.5"], 20)
        self.assertEqual(measurements["cost_by_currency"]["USD"]["sum"], 1)
        self.assertEqual(measurements["cost_by_currency"]["CNY"]["sum"], 4)
        self.assertEqual(measurements["cost_missing_count"], 1)

    def test_explicit_linear_quantile_oracle(self):
        self.assertEqual(quantiles([10, 20, 30, 40], [.5], method="LINEAR_R7")["quantiles"]["0.5"], 25)

    def test_required_unknown_reference_keeps_overall_quality_unknown(self):
        item = numerical_rows()[0]
        item.update(reference_valid=None, auto_accepted=False)
        result = aggregate_metrics([item], policy(["r1"]))
        self.assertEqual(result["quality"]["unknown_count"], 1)
        self.assertIsNone(result["quality"]["success_fraction_all_requests"])

    def test_vector_metrics_do_not_require_or_invent_hard_prediction(self):
        item = row("r1", "A", None, {"A": .8, "B": .1, "C": .1}, auto=False)
        result = aggregate_metrics([item], policy(["r1"]))
        self.assertAlmostEqual(result["probability"]["brier"], .06)
        self.assertAlmostEqual(result["probability"]["nll"], -math.log(.8))
        self.assertEqual(result["probability"]["evaluated_count"], 1)
        self.assertEqual(result["probability"]["ece_evaluated_count"], 0)
        self.assertIsNone(result["probability"]["ece"])
        self.assertEqual(result["classification"]["evaluated_count"], 0)

    def test_ece_edges_and_reported_label_not_argmax(self):
        rows = [
            row("r1", "B", "A", {"A": 0, "B": 1, "C": 0}, auto=False),
            row("r2", "A", "A", {"A": .5, "B": .5, "C": 0}, auto=False),
            row("r3", "A", "A", {"A": 1, "B": 0, "C": 0}, auto=False),
        ]
        result = aggregate_metrics(rows, policy(["r1", "r2", "r3"]))
        bins = result["probability"]["bins"]
        self.assertEqual([b["count"] for b in bins], [1, 2])
        self.assertAlmostEqual(result["probability"]["ece"], 1 / 6)

    def test_invalid_measurements_rejected(self):
        for changes in ({"latency_ms": -1}, {"latency_ms": float("inf")},
                        {"latency_ms": True}, {"tokens_input": .5},
                        {"tokens_output": False}, {"cost": 1, "currency": None}):
            item = numerical_rows()[0]
            item.update(changes)
            self.rejection([item], policy(["r1"]))

    def test_invalid_policy_types_and_identity_lists_rejected(self):
        for changes in ({"labels": ["A", "A"]}, {"expected_request_ids": ["r1", "r1"]},
                        {"expected_request_ids": None}, {"minimum_sample_count": True},
                        {"quantile_probabilities": []}, {"quantile_method": "unknown"},
                        {"nll_epsilon": True}, {"ece_bin_edges": [0, .5, .5, 1]}):
            frozen = policy(["r1"])
            frozen.update(changes)
            self.rejection([numerical_rows()[0]], frozen)

    def test_nll_uses_predeclared_epsilon_for_zero_probability(self):
        item = row("r1", "A", "B", {"A": 0, "B": 1, "C": 0}, auto=False)
        frozen = policy(["r1"])
        frozen["nll_epsilon"] = .01
        result = aggregate_metrics([item], frozen)
        self.assertAlmostEqual(result["probability"]["nll"], -math.log(.01))

    def test_ranking_hand_oracle_and_missing_failures(self):
        frozen = {
            "expected_request_ids": ["q1", "q2"],
            "status_categories": {"succeeded": "SUCCEEDED", "timeout": "TIMEOUT"},
            "minimum_sample_count": 5, "relevance_gains": {"L": 0, "M": 1, "H": 3},
            "cutoff": 2, "discounts": [1, .5], "selection_policy_ref": "SPECIFICATION_EXAMPLE:r1",
        }
        queries = [
            {"id": "q1", "status": "succeeded", "candidates": [
                {"id": "x", "relevance": "L"}, {"id": "y", "relevance": "M"},
                {"id": "z", "relevance": "H"}], "ordered_ids": ["x", "z"]},
            {"id": "q2", "status": "timeout", "candidates": None, "ordered_ids": None},
        ]
        result = ranking_metrics(queries, frozen)
        self.assertEqual(result["total_request_count"], 2)
        self.assertEqual(result["scored_request_count"], 1)
        self.assertEqual(result["failure_counts"]["TIMEOUT"], 1)
        self.assertAlmostEqual(result["results"][0]["dcg"], 1.5)
        self.assertAlmostEqual(result["results"][0]["ideal_dcg"], 3.5)
        self.assertAlmostEqual(result["mean_ndcg"], 3 / 7)
        self.assertIsNone(result["results"][1]["ndcg"])

    def test_zero_ranking_ideal_gain_is_undefined(self):
        frozen = {"expected_request_ids": ["q1"],
                  "status_categories": {"succeeded": "SUCCEEDED"},
                  "minimum_sample_count": 5, "relevance_gains": {"L": 0},
                  "cutoff": 1, "discounts": [1], "selection_policy_ref": "SPECIFICATION_EXAMPLE:r1"}
        result = ranking_metrics([{"id": "q1", "status": "succeeded",
            "candidates": [{"id": "x", "relevance": "L"}], "ordered_ids": ["x"]}], frozen)
        self.assertEqual(result["results"][0]["status"], "UNDEFINED")
        self.assertIsNone(result["mean_ndcg"])

    def test_ranking_unknown_duplicate_and_missing_requests_rejected(self):
        frozen = {"expected_request_ids": ["q1"],
                  "status_categories": {"succeeded": "SUCCEEDED"},
                  "minimum_sample_count": 5, "relevance_gains": {"L": 0, "H": 1},
                  "cutoff": 2, "discounts": [1, .5], "selection_policy_ref": "SPECIFICATION_EXAMPLE:r1"}
        query = {"id": "q1", "status": "succeeded",
                 "candidates": [{"id": "x", "relevance": "H"}], "ordered_ids": ["x"]}
        for changes in ({"ordered_ids": ["x", "x"]}, {"ordered_ids": ["unknown"]},
                        {"candidates": [{"id": "x", "relevance": "unknown"}]},
                        {"candidates": [query["candidates"][0]] * 2}):
            with self.assertRaises(ValueError):
                ranking_metrics([{**query, **changes}], frozen)
        with self.assertRaises(ValueError):
            ranking_metrics([], frozen)

    def test_deterministic_replay_and_inputs_unchanged(self):
        rows = numerical_rows()
        frozen = policy(["r1", "r2", "r3"])
        before = copy.deepcopy((rows, frozen))
        self.assertEqual(aggregate_metrics(rows, frozen), aggregate_metrics(rows, frozen))
        self.assertEqual((rows, frozen), before)

    def test_ranking_cannot_gain_meaning_without_frozen_policy(self):
        with self.assertRaises(ValueError):
            ranking_metrics([], {})


if __name__ == "__main__":
    unittest.main()
