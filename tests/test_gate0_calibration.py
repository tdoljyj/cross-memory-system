# -*- coding: utf-8 -*-
"""Gate 0-E calibration selection and blind-input contract tests."""

import json
import os
import sys


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from memory_eval import gate0_calibration as C  # noqa: E402


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def test_sealed_inputs_are_exact_calibration_partition():
    lock, cases, fixtures = C.verify_and_load_inputs()
    ids = [case["case_id"] for case in cases]
    check(len(ids) == 53, "must load exactly 53 calibration cases")
    check(C._ordered_ids_sha(ids) == C.EXPECTED_CALIBRATION_IDS_SHA256,
          "calibration ID commitment mismatch")
    check(len(lock["alpha_grid"]) * len(lock["tau_grid"]) == 60,
          "grid must contain exactly 60 combinations")
    used = {fid for case in cases for fid in case["fixtures"]}
    check(used == set(fixtures), "fixture bundle must be minimal and exact")


def test_selection_source_contains_no_holdout_case_details():
    with open(C.__file__, "r", encoding="utf-8") as fh:
        source = fh.read()
    for marker in ("pp-001", "cs-004", "ps-016", "holdout_ids"):
        check(marker not in source,
              "selection source must not contain holdout detail: " + marker)
    with open(C.CASES_PATH, "r", encoding="utf-8") as fh:
        bundle = fh.read()
    for marker in ("pp-001", "cs-004", "ps-016"):
        check(marker not in bundle,
              "calibration case bundle contains holdout detail: " + marker)


def test_raw_metrics_preserve_unrounded_counts_and_hard_gates():
    verdicts = [
        {
            "case_id": "a", "returned_ids": ["x"],
            "expected_relevant_ids": ["x"], "forbidden_ids": [],
            "forbidden_hits": [], "no_memory_expected": False,
            "no_memory_violated": False, "tokens": 17, "error": None,
        },
        {
            "case_id": "b", "returned_ids": [],
            "expected_relevant_ids": [], "forbidden_ids": [],
            "forbidden_hits": [], "no_memory_expected": True,
            "no_memory_violated": False, "tokens": 0, "error": None,
        },
    ]
    raw, counts, reasons = C.raw_metrics(
        verdicts, baseline_top5={"a": ["x"], "b": []})
    check(raw["precision_at5_v2"] == 1.0, "precision raw value")
    check(raw["critical_memory_recall_v2"] == 1.0, "critical raw value")
    check(raw["false_recall_rate_v2"] == 0.0, "false raw value")
    check(raw["prompt_token_p95"] == 17, "token p95")
    check(counts["no_memory_correct"] == counts["no_memory_total"] == 1,
          "NO MEMORY raw numerator/denominator")
    check(reasons == [], "perfect row must qualify: %r" % reasons)


def _row(alpha, tau, critical=0.96, precision=0.91, false=0.01,
         tokens=100, qualifying=True):
    return {
        "alpha": alpha, "tau": tau, "qualifying": qualifying,
        "raw_metrics": {
            "critical_memory_recall_v2": critical,
            "precision_at5_v2": precision,
            "false_recall_rate_v2": false,
            "prompt_token_p95": tokens,
        },
    }


def test_winner_rule_exact_tie_break_order():
    rows = [
        _row(0.25, 0.50, critical=0.97, precision=0.90),
        _row(0.50, 0.40, critical=0.97, precision=0.92, false=0.02),
        _row(0.75, 0.55, critical=0.97, precision=0.92, false=0.01,
             tokens=90),
        _row(1.00, 0.60, critical=0.97, precision=0.92, false=0.01,
             tokens=90),
        _row(0.75, 0.60, critical=0.97, precision=0.92, false=0.01,
             tokens=90),
        _row(1.00, 0.55, critical=0.99, qualifying=False),
    ]
    winner = C.select_winner(rows)
    check(winner["tau"] == 0.60 and winner["alpha"] == 1.00,
          "must choose critical, precision, false, tokens, tau, alpha order")


def test_no_qualifying_combination_is_no_winner():
    check(C.select_winner([_row(1.0, 0.6, qualifying=False)]) is None,
          "no qualifying row must stop calibration")


TESTS = [
    test_sealed_inputs_are_exact_calibration_partition,
    test_selection_source_contains_no_holdout_case_details,
    test_raw_metrics_preserve_unrounded_counts_and_hard_gates,
    test_winner_rule_exact_tie_break_order,
    test_no_qualifying_combination_is_no_winner,
]


if __name__ == "__main__":
    failed = 0
    for test in TESTS:
        try:
            test()
            print("PASS " + test.__name__)
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print("FAIL %s: %s" % (test.__name__, exc))
    print("----")
    print("%d test(s), %d failure(s)" % (len(TESTS), failed))
    raise SystemExit(1 if failed else 0)
