"""Candidate arithmetic for numeric projections of already saved M2 outputs.

This module does not parse outputs, validate product schemas, create data, or
replace score_m2_core_saved_outputs.py. Its caller first uses the existing
parser/schema/reference/exact-match scorer, then supplies local Python rows.
Rows are not a PortSchema and these functions issue no Gate or qualification.
Policies must be frozen externally; this module cannot establish their adoption,
Gold provenance, split isolation, calibration validity, or measurement reality.

aggregate_metrics(rows, policy): rows require id, status, schema_valid,
auto_accepted; optional numeric/label fields are listed in ROW_FIELDS below.
Explicit None means missing. policy requires labels, expected_request_ids,
status_categories, probability_required, reference_required, loss_matrix,
minimum_sample_count, quantile_probabilities and quantile_method. Probability
paths also require nll_epsilon, ece_bin_edges and probability_sum_tolerance.
ECE measures confidence of the reported predicted label, not an invented
argmax prediction. Bins are left closed/right open, except the closed last bin.
The caller groups rows into predeclared slices; no slice is selected here.

ranking_metrics(queries, policy): explicit candidate relevance grades, actual
ordered_ids, frozen relevance_gains, cutoff, discounts and selection_policy_ref
are required. Failed queries carry candidates=None and ordered_ids=None.
No confidence intervals, risk bounds, calibration fit, or PASS are generated.
"""

import math
from collections import Counter
from collections.abc import Mapping


CATEGORIES = frozenset({"SUCCEEDED", "TIMEOUT", "UNAVAILABLE", "BUDGET_FAILURE",
    "SCHEMA_INVALID", "REFERENCE_INVALID", "INVALID_NUMERIC", "RUNTIME_ERROR", "CANCELLED"})
ROW_FIELDS = frozenset({"id", "status", "schema_valid", "reference_valid",
    "predicted_label", "true_label", "auto_accepted", "probabilities", "decision",
    "correct", "latency_ms", "tokens_input", "tokens_output", "cost", "currency"})


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _number(value, name, low=None, high=None):
    _require(type(value) in (int, float), name + " must be a number, not bool")
    try:
        finite = math.isfinite(value)
    except OverflowError:
        finite = False
    _require(finite and (low is None or value >= low) and
             (high is None or value <= high), name + " out of range or nonfinite")
    return value


def _strings(value, name, nonempty=True):
    _require(type(value) is list and (value or not nonempty), name + " must be a list")
    _require(all(type(item) is str and item for item in value), name + " needs nonempty strings")
    _require(len(set(value)) == len(value), name + " contains duplicates")
    return value


def _mapping(value, name):
    _require(isinstance(value, Mapping), name + " must be a mapping")
    return value


def _base(rows, policy):
    _require(type(rows) is list, "rows must be a list")
    _mapping(policy, "policy")
    expected = _strings(policy.get("expected_request_ids"), "expected_request_ids", nonempty=False)
    statuses = _mapping(policy.get("status_categories"), "status_categories")
    _require(statuses and all(type(k) is str and k and type(v) is str and
        v in CATEGORIES for k, v in statuses.items()), "invalid explicit status_categories")
    minimum = policy.get("minimum_sample_count")
    _require(type(minimum) is int and minimum >= 1, "minimum_sample_count must be positive int")
    ids = []
    for row in rows:
        _mapping(row, "row")
        _require(type(row.get("id")) is str and row["id"], "invalid request id")
        ids.append(row["id"])
        _require(type(row.get("status")) is str and row["status"] in statuses,
                 "unmapped request status")
    _require(len(ids) == len(set(ids)) and len(ids) == len(expected) and
             set(ids) == set(expected), "request coverage or duplicate id mismatch")
    return statuses, minimum


def _mean(values):
    if not values:
        return None
    result = math.fsum(value / len(values) for value in values)
    return _number(result, "computed mean")


def quantiles(values, probabilities, method="LINEAR_R7"):
    """Missing values stay missing; R7 uses (n-1)*q with linear interpolation."""
    _require(type(values) is list and type(probabilities) is list and probabilities,
             "values and nonempty probabilities must be lists")
    _require(method == "LINEAR_R7", "unsupported explicit quantile method")
    fractions = [_number(p, "quantile probability", 0, 1) for p in probabilities]
    _require(len(fractions) == len(set(fractions)), "duplicate quantile probability")
    present = sorted(_number(v, "measurement", 0) for v in values if v is not None)
    result = {}
    for p in fractions:
        if not present:
            result[str(p)] = None
            continue
        position = (len(present) - 1) * p
        lower = int(math.floor(position))
        upper = int(math.ceil(position))
        fraction = position - lower
        result[str(p)] = present[lower] * (1 - fraction) + present[upper] * fraction
    return {"count": len(present), "missing_count": len(values) - len(present),
            "method": method, "quantiles": result}


def _summary(values, policy):
    report = quantiles(values, policy["quantile_probabilities"], policy["quantile_method"])
    present = [v for v in values if v is not None]
    try:
        total = math.fsum(present) if present else None
    except OverflowError as exc:
        raise ValueError("computed measurement sum overflow") from exc
    if total is not None:
        _number(total, "computed measurement sum")
    return {**report, "sum": total, "mean": _mean(present)}


def aggregate_metrics(rows, policy):
    """Return arithmetic and explicit missingness; reject invalid projections.

    Raw statuses are preserved and classified only by supplied local policy.
    Invalid/running failures cannot be auto accepted or marked correct. Missing
    Gold remains unknown; accepted requests with unknown Gold keep the complete
    risk denominator and yield INCOMPLETE risk. No zero substitutes for missing
    measurements, zero-denominator precision/recall, or zero-coverage risk.
    """
    statuses, minimum = _base(rows, policy)
    labels = _strings(policy.get("labels"), "labels")
    for name in ("probability_required", "reference_required"):
        _require(type(policy.get(name)) is bool, name + " must be bool")
    losses = _mapping(policy.get("loss_matrix"), "loss_matrix")
    _require(set(losses) == set(labels), "loss_matrix true labels mismatch")
    for label in labels:
        _mapping(losses[label], "loss row")
        _require(set(losses[label]) == set(labels), "loss_matrix predicted labels mismatch")
        for loss in losses[label].values():
            _number(loss, "loss", 0)
    # Validate measurement policy even when every measurement is missing.
    quantiles([], policy.get("quantile_probabilities"), policy.get("quantile_method"))
    required = policy["probability_required"]
    tolerance = policy.get("probability_sum_tolerance")
    if required or any(row.get("probabilities") is not None for row in rows):
        _number(tolerance, "probability_sum_tolerance", 0)
        _require(tolerance < 1, "probability_sum_tolerance must be below 1")
    if required:
        epsilon = _number(policy.get("nll_epsilon"), "nll_epsilon", 0, 1)
        _require(0 < epsilon < 1, "nll_epsilon must be strictly between 0 and 1")
        edges = policy.get("ece_bin_edges")
        _require(type(edges) is list and len(edges) >= 2, "explicit ECE edges required")
        for edge in edges:
            _number(edge, "ECE edge", 0, 1)
        _require(edges[0] == 0 and edges[-1] == 1 and
                 all(a < b for a, b in zip(edges, edges[1:])), "invalid ECE edges")
    confusion = {actual: {predicted: 0 for predicted in labels} for actual in labels}
    correct_count = known_count = auto_count = known_auto = 0
    auto_losses, probability_rows, confidence_rows = [], [], []
    outcome_counts, raw_counts, decisions = Counter(), Counter(), Counter()
    schema_counts, reference_counts = Counter(), Counter()
    costs, cost_missing = {}, 0
    numeric = {name: [] for name in ("latency_ms", "tokens_input", "tokens_output")}
    for row in rows:
        _require(set(row) <= ROW_FIELDS, "unknown local arithmetic row fields")
        _require(type(row.get("schema_valid")) is bool, "schema_valid must be bool")
        _require(type(row.get("auto_accepted")) is bool, "auto_accepted must be bool")
        ref, declared = row.get("reference_valid"), row.get("correct")
        _require(ref is None or type(ref) is bool, "reference_valid must be bool or None")
        _require(declared is None or type(declared) is bool, "correct must be bool or None")
        actual, predicted = row.get("true_label"), row.get("predicted_label")
        for label in (actual, predicted):
            _require(label is None or (type(label) is str and label in labels), "unknown label")
        decision = row.get("decision")
        _require(decision is None or (type(decision) is str and decision in
            {"ABSTAIN", "ESCALATE", "MANUAL_REVIEW", "UNRESOLVED"}), "unknown local decision")
        category = statuses[row["status"]]
        _require(not row["auto_accepted"] or decision is None, "auto accepted decision conflict")
        _require(category == "SUCCEEDED" or decision is None,
                 "runtime/budget failure is not a deliberate abstain/escalation")
        valid = category == "SUCCEEDED" and row["schema_valid"] and ref is not False
        if policy["reference_required"] and ref is None:
            valid = False
        failed = category != "SUCCEEDED" or not row["schema_valid"] or ref is False
        if failed:
            _require(declared is not True, "failed request cannot be correct")
            correctness = False
        elif policy["reference_required"] and ref is None:
            # Matching labels cannot establish workflow success without its
            # required evidence. Preserve the request as unknown, not success.
            correctness = None
        elif actual is not None and predicted is not None:
            correctness = actual == predicted
            _require(declared is None or declared == correctness, "correctness/labels conflict")
        else:
            # A candidate exact-match flag is not a missing adjudicated label.
            correctness = None
        if correctness is not None:
            known_count += 1
            correct_count += correctness
        probabilities = row.get("probabilities")
        if probabilities is not None:
            _mapping(probabilities, "probabilities")
            _require(set(probabilities) == set(labels), "probability labels mismatch")
            for value in probabilities.values():
                _number(value, "probability", 0, 1)
            _require(abs(math.fsum(probabilities.values()) - 1) <= tolerance,
                     "probabilities must sum to 1 within explicit tolerance")
        _require(not row["auto_accepted"] or (valid and predicted is not None and
                 (not required or probabilities is not None)), "invalid automatic acceptance")
        if valid and actual is not None and predicted is not None:
            confusion[actual][predicted] += 1
        if valid and actual is not None and required and probabilities is not None:
            # Vector scoring needs a probability vector and adjudicated label;
            # a missing hard prediction is not a reason to discard this sample.
            probability_rows.append((actual, probabilities))
            if predicted is not None:
                confidence_rows.append((actual, predicted, probabilities))
        if row["auto_accepted"]:
            auto_count += 1
            if actual is not None:
                known_auto += 1
                auto_losses.append(losses[actual][predicted])
        outcome_counts[category] += 1
        raw_counts[row["status"]] += 1
        decisions[decision] += 1
        schema_counts["valid" if row["schema_valid"] else "invalid"] += 1
        reference_counts["unknown" if ref is None else "valid" if ref else "invalid"] += 1
        for name in numeric:
            value = row.get(name)
            if value is not None:
                _number(value, name, 0)
                if name.startswith("tokens_"):
                    _require(type(value) is int, name + " must be int")
            numeric[name].append(value)
        cost, currency = row.get("cost"), row.get("currency")
        _require(currency is None or (type(currency) is str and currency), "invalid currency")
        if cost is None:
            cost_missing += 1
        else:
            _number(cost, "cost", 0)
            _require(currency is not None, "observed cost requires currency")
        if currency is not None:
            costs.setdefault(currency, []).append(cost)
    n = len(rows)
    per_class = {}
    for label in labels:
        support = sum(confusion[label].values())
        predicted_count = sum(confusion[other][label] for other in labels)
        per_class[label] = {"support": support, "predicted_count": predicted_count,
            "precision": confusion[label][label] / predicted_count if predicted_count else None,
            "recall": confusion[label][label] / support if support else None}
    probability = {"status": "NOT_APPLICABLE", "estimand": "REPORTED_LABEL_CONFIDENCE",
                   "evaluated_count": 0, "ece_evaluated_count": 0,
                   "brier": None, "nll": None, "ece": None, "bins": []}
    if required:
        bins = []
        for index, (lower, upper) in enumerate(zip(edges, edges[1:])):
            subset = [(a, p, ps) for a, p, ps in confidence_rows if
                lower <= ps[p] < upper or (index == len(edges) - 2 and ps[p] == upper)]
            bins.append({"lower": lower, "upper": upper, "count": len(subset),
                "mean_confidence": _mean([ps[p] for a, p, ps in subset]),
                "accuracy": _mean([int(a == p) for a, p, ps in subset])})
        count = len(probability_rows)
        ece_count = len(confidence_rows)
        probability = {"status": "NOT_COMPUTED" if not count else
            "INSUFFICIENT_SAMPLE" if count < minimum else "COMPUTED_ARITHMETIC_ONLY",
            "estimand": "REPORTED_LABEL_CONFIDENCE", "evaluated_count": count,
            "ece_evaluated_count": ece_count,
            "ece_missing_or_ineligible_count": n - ece_count,
            "missing_or_ineligible_count": n - count,
            "brier": _mean([math.fsum((ps[label] - int(label == a)) ** 2 for label in labels)
                            for a, ps in probability_rows]),
            "nll": _mean([-math.log(max(ps[a], epsilon)) for a, ps in probability_rows]),
            "ece": math.fsum(b["count"] / ece_count * abs(b["accuracy"] - b["mean_confidence"])
                              for b in bins if b["count"]) if ece_count else None,
            "bins": bins, "nll_epsilon": epsilon, "ece_bin_edges": list(edges)}
    risk_status = "UNDEFINED" if not auto_count else "INCOMPLETE" if known_auto < auto_count else (
        "INSUFFICIENT_SAMPLE" if auto_count < minimum else "COMPUTED_ARITHMETIC_ONLY")
    return {"status": "CANDIDATE_ARITHMETIC_ONLY", "authority_effect": "NONE",
        "gate_verdict": "NOT_ISSUED", "confidence_intervals": "NOT_COMPUTED", "risk_bounds": "NOT_COMPUTED",
        "minimum_sample_count": minimum,
        "minimum_sample_status": "INSUFFICIENT_SAMPLE" if n < minimum else "COUNT_REACHED_ONLY",
        "total_request_count": n, "status_counts": dict(raw_counts),
        "outcomes": {c: {"count": outcome_counts[c], "rate": outcome_counts[c] / n if n else None}
                     for c in sorted(CATEGORIES)},
        "structure": {"schema_counts": dict(schema_counts), "reference_counts": dict(reference_counts)},
        "classification": {"confusion_matrix": confusion, "per_class": per_class,
            "evaluated_count": sum(sum(line.values()) for line in confusion.values())},
        "quality": {"correct_count": correct_count, "known_count": known_count,
            "unknown_count": n - known_count, "total_request_count": n,
            "success_fraction_all_requests": correct_count / n if n and known_count == n else None,
            "observed_correct_fraction_all_requests": correct_count / n if n else None},
        "selective": {"auto_accepted_count": auto_count, "coverage": auto_count / n if n else None,
            "risk": {"status": risk_status, "value": _mean(auto_losses) if known_auto == auto_count else None,
                     "denominator": auto_count, "known_loss_count": known_auto},
            "abstain_count": decisions["ABSTAIN"], "escalation_count": decisions["ESCALATE"]},
        "probability": {**probability, "estimands": {
            "brier": "MULTICLASS_LABEL_DISTRIBUTION",
            "nll": "MULTICLASS_LABEL_DISTRIBUTION",
            "ece": "REPORTED_LABEL_CONFIDENCE"}},
        "measurements": {**{k: _summary(v, policy) for k, v in numeric.items()},
            "cost_by_currency": {c: _summary(v, policy) for c, v in sorted(costs.items())},
            "cost_missing_count": cost_missing}}


def ranking_metrics(queries, policy):
    """Compute explicitly specified DCG/NDCG; failures remain outside scored means."""
    statuses, minimum = _base(queries, policy)
    gains = _mapping(policy.get("relevance_gains"), "relevance_gains")
    _require(gains and all(type(k) is str and k for k in gains), "explicit relevance grades required")
    for gain in gains.values():
        _number(gain, "relevance gain", 0)
    cutoff, discounts = policy.get("cutoff"), policy.get("discounts")
    _require(type(cutoff) is int and cutoff >= 1, "cutoff must be positive int")
    _require(type(discounts) is list and len(discounts) == cutoff, "discounts must match cutoff")
    for discount in discounts:
        _require(_number(discount, "discount", 0) > 0, "discount must be positive")
    _require(all(a >= b for a, b in zip(discounts, discounts[1:])), "discounts must be nonincreasing")
    _require(type(policy.get("selection_policy_ref")) is str and policy["selection_policy_ref"],
             "explicit frozen selection policy reference required")
    results, failures = [], Counter()
    for query in queries:
        _require(set(query) == {"id", "status", "candidates", "ordered_ids"}, "unknown ranking query fields")
        category = statuses[query["status"]]
        if category != "SUCCEEDED":
            _require(query["candidates"] is None and query["ordered_ids"] is None,
                     "failed ranking request cannot masquerade as a scored ranking")
            failures[category] += 1
            results.append({"id": query["id"], "status": category, "dcg": None, "ndcg": None})
            continue
        candidates = query["candidates"]
        _require(type(candidates) is list, "ranking candidates must be list")
        by_id = {}
        for candidate in candidates:
            _mapping(candidate, "candidate")
            _require(set(candidate) == {"id", "relevance"}, "unknown candidate fields")
            key, grade = candidate["id"], candidate["relevance"]
            _require(type(key) is str and key and key not in by_id, "invalid or duplicate candidate id")
            _require(type(grade) is str and grade in gains, "unknown relevance grade")
            by_id[key] = gains[grade]
        order = _strings(query["ordered_ids"], "ordered_ids", nonempty=False)
        _require(len(order) <= cutoff and set(order) <= set(by_id), "invalid selected ranking")
        dcg = math.fsum(by_id[key] * discounts[index] for index, key in enumerate(order))
        ideal = math.fsum(gain * discounts[index] for index, gain in
                         enumerate(sorted(by_id.values(), reverse=True)[:cutoff]))
        _number(dcg, "DCG", 0)
        _number(ideal, "ideal DCG", 0)
        results.append({"id": query["id"], "status": "COMPUTED_ARITHMETIC_ONLY" if ideal else "UNDEFINED",
                        "dcg": dcg, "ideal_dcg": ideal, "ndcg": dcg / ideal if ideal else None})
    measured = [r["ndcg"] for r in results if r["ndcg"] is not None]
    return {"status": "CANDIDATE_ARITHMETIC_ONLY", "authority_effect": "NONE",
        "gate_verdict": "NOT_ISSUED", "confidence_intervals": "NOT_COMPUTED", "risk_bounds": "NOT_COMPUTED",
        "minimum_sample_status": "INSUFFICIENT_SAMPLE" if len(measured) < minimum else "COUNT_REACHED_ONLY",
        "total_request_count": len(queries), "scored_request_count": len(measured),
        "failure_counts": dict(failures), "mean_ndcg": _mean(measured), "results": results,
        "cutoff": cutoff, "discounts": list(discounts), "selection_policy_ref": policy["selection_policy_ref"]}
