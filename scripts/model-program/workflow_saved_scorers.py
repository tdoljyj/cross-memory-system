"""Pure local scorers for caller-supplied saved decision candidates.

score_semantic_relations(records, policy), score_context_relevance(records,
policy), score_processing_routes(records, policy) do no I/O or execution.
Argument dictionaries are local Python projections, not new Port schemas.
The three decision.* keys are plan logical names, not registered capabilities.
Caller must independently freeze/authenticate specs, schemas, reference labels,
Policy, allowed graph/actions, split/exposure, and actual observation provenance.
A policy_ref, hash or supplied reference does not prove those obligations.

Every policy includes policy_ref/task_spec_ref/threshold_ref (str or None),
expected_request_ids, status_categories. Every record has id/status/candidate/
reference; Context also has input_context_ids. Exact field sets are below.
Non-success rows carry candidate=None. Missing records must be supplied as
explicit unknown rows; missing/duplicate/unregistered IDs are rejected.
Reference objects are separate caller evidence, never candidate self-grading.
Absent references preserve None correctness, loss, NDCG and downstream effects.
Numeric means use the full declared request set or stay None when incomplete;
counts and per-request diagnostics expose failures, abstentions and unknowns.

Relation: caller labels/loss, available/supporting/required-counter references.
Context: one fixed candidate set, explicit linear or exp2_minus1 gain, cutoff,
discounts and token budget. Raw scores never acquire probability semantics.
Ideal DCG uses all fixed candidates without the selection token constraint;
it is a ranking reference, not budget-optimal selection or minimum sufficiency.
Route: caller nodes/edges/start, allowed action IDs, node cost units, bounded
steps/budget. Path termination and actions are derived from that supplied graph.
Configured costs are budget units, not measured model/currency usage.
All reports are candidate arithmetic only, authority NONE, gate NOT_ISSUED.
"""

import copy
from collections import Counter
import hashlib
import json
import math


MAX_REQUESTS, MAX_ITEMS = 168, 512  # Local allocation bounds, not task authority.
BASE_POLICY = {"policy_ref", "task_spec_ref", "threshold_ref", "expected_request_ids", "status_categories"}
ROW = {"id", "status", "candidate", "reference"}
# Diagnostic normalization only; not an official model status registry.
OUTCOMES = {"SUCCEEDED", "TIMEOUT", "UNAVAILABLE", "BUDGET_FAILURE", "SCHEMA_INVALID",
            "REFERENCE_INVALID", "INVALID_NUMERIC", "RUNTIME_ERROR", "CANCELLED",
            "ABSTAINED", "UNKNOWN", "NOT_ADMITTED"}


def require(condition, reason):
    if not condition:
        raise ValueError("WORKFLOW_SCORER_" + reason)


def fields(value, expected):
    require(type(value) is dict and set(value) == expected, "UNKNOWN_OR_MISSING_FIELDS")


def text(value):
    require(type(value) is str and 0 < len(value) <= 2048, "TEXT")
    value.encode("utf-8", errors="strict")
    return value


def reference(value):
    return None if value is None else text(value)


def number(value, low=0):
    require(type(value) in (int, float), "NUMBER_NOT_BOOL")
    try:
        require(math.isfinite(value) and (low is None or value >= low), "FINITE_NUMBER")
    except OverflowError as exc:
        raise ValueError("WORKFLOW_SCORER_FINITE_NUMBER") from exc
    return value


def integer(value, low=0):
    require(type(value) is int and low <= value <= 2**63 - 1, "INTEGER_NOT_BOOL")
    return value


def ids(value, nonempty=False):
    require(type(value) is list and len(value) <= MAX_ITEMS and
            (not nonempty or bool(value)), "ID_LIST")
    for key in value:
        text(key)
    require(len(value) == len(set(value)), "DUPLICATE_ID")
    return value


def finite_json(value, depth=0):
    require(depth <= 100, "JSON_DEPTH")
    if value is None or type(value) is bool:
        return
    if type(value) is str:
        value.encode("utf-8", errors="strict")
    elif type(value) in (int, float):
        number(value, None)
    elif type(value) is list:
        require(len(value) <= 65536, "JSON_BOUND")
        for child in value:
            finite_json(child, depth + 1)
    elif type(value) is dict:
        require(len(value) <= 65536, "JSON_BOUND")
        for key, child in value.items():
            text(key)
            finite_json(child, depth + 1)
    else:
        require(False, "JSON_TYPE")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                         separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def base(records, policy, extra, row_fields=ROW):
    finite_json(policy); finite_json(records)
    fields(policy, BASE_POLICY | extra)
    for key in ("policy_ref", "task_spec_ref", "threshold_ref"):
        reference(policy[key])
    expected = ids(policy["expected_request_ids"])
    require(len(expected) <= MAX_REQUESTS, "REQUEST_BOUND")
    statuses = policy["status_categories"]
    require(type(statuses) is dict and bool(statuses), "STATUS_POLICY")
    for raw, category in statuses.items():
        text(raw)
        require(type(category) is str and category in OUTCOMES, "STATUS_CATEGORY")
    require(type(records) is list and len(records) <= MAX_REQUESTS, "RECORDS")
    by_id = {}
    for row in records:
        fields(row, row_fields)
        key = text(row["id"])
        require(key not in by_id, "DUPLICATE_REQUEST")
        text(row["status"])
        require(row["status"] in statuses, "UNKNOWN_STATUS")
        if statuses[row["status"]] != "SUCCEEDED":
            require(row["candidate"] is None, "NON_SUCCESS_CANDIDATE")
        by_id[key] = row
    require(set(by_id) == set(expected), "MISSING_OR_UNREGISTERED_REQUEST")
    return [by_id[key] for key in expected], statuses


def report(key, policy, records, statuses, results):
    return {"logical_task_key": key, "formal_capability_id": None,
            "status": "CANDIDATE_ARITHMETIC_ONLY", "authority_effect": "NONE",
            "gate": "NOT_ISSUED", "gate_verdict": "NOT_ISSUED",
            "policy_ref": policy["policy_ref"], "task_spec_ref": policy["task_spec_ref"],
            "threshold_ref": policy["threshold_ref"], "policy_sha256": digest(policy),
            "records_sha256": digest(records), "total_request_count": len(records),
            "outcome_counts": dict(Counter(statuses[row["status"]] for row in records)),
            "invalid_candidate_count": sum(r["candidate_valid"] is False for r in results),
            "unassessed_candidate_count": sum(r["candidate_valid"] is None for r in results),
            "results": results, "authority_and_freeze_verified": False,
            "reference_provenance_verified": False,
            "reference_comparison_scope": "Caller-supplied candidate arithmetic; even nonempty source_ref does not prove verified Gold."}


def result(row, statuses):
    return {"id": row["id"], "original_status": row["status"],
            "outcome": statuses[row["status"]], "candidate_valid": None,
            "correct": None, "loss": None, "gaps": []}


def complete_mean(values):
    if not values or any(v is None for v in values):
        return None
    try:
        answer = math.fsum(values) / len(values)
    except OverflowError as exc:
        raise ValueError("WORKFLOW_SCORER_ARITHMETIC_OVERFLOW") from exc
    return number(answer)


def matrix(value, labels):
    if value is None:
        return None
    require(labels is not None and type(value) is dict and set(value) == set(labels), "LOSS_LABELS")
    for row in value.values():
        require(type(row) is dict and set(row) == set(labels), "LOSS_LABELS")
        for loss in row.values():
            number(loss)
    return value


def classification(answer, results, labels):
    answer["accuracy"] = complete_mean([None if r["correct"] is None else int(r["correct"]) for r in results])
    answer["mean_loss"] = complete_mean([r["loss"] for r in results])
    answer["known_reference_count"] = sum(r.get("external_label") is not None for r in results)
    answer["scored_request_count"] = sum(r["correct"] is not None for r in results)
    confusion = None if labels is None else {a: {b: 0 for b in labels} for a in labels}
    if confusion is not None:
        for r in results:
            if r["correct"] is not None:
                confusion[r["external_label"]][r["predicted_label"]] += 1
    answer["confusion_on_scored_requests"] = confusion
    per_class = None
    if confusion is not None:
        per_class = {}
        for label in labels:
            predicted = sum(confusion[actual][label] for actual in labels)
            actual = sum(confusion[label].values())
            per_class[label] = {"precision": confusion[label][label] / predicted if predicted else None,
                                "recall": confusion[label][label] / actual if actual else None}
    answer["per_class_on_scored_requests"] = per_class
    return answer


def local_validity(gaps, unknown):
    return True if not gaps else None if set(gaps) <= unknown else False


def score_semantic_relations(records, policy):
    rows, statuses = base(records, policy, {"labels", "loss_matrix", "require_support"})
    labels = None if policy["labels"] is None else ids(policy["labels"], True)
    losses = matrix(policy["loss_matrix"], labels)
    require(policy["require_support"] is None or type(policy["require_support"]) is bool, "SUPPORT_POLICY")
    output = []
    for row in rows:
        r = result(row, statuses)
        r.update({"predicted_label": None, "external_label": None,
                  "support_valid": None, "counterevidence_preserved": None})
        ref = row["reference"]
        if ref is not None:
            fields(ref, {"available_refs", "supporting_refs", "required_counterevidence_refs", "gold_label", "source_ref"})
            available, supporting, opposing = (ids(ref[k]) for k in
                 ("available_refs", "supporting_refs", "required_counterevidence_refs"))
            require(set(supporting + opposing) <= set(available), "REFERENCE_SCOPE")
            reference(ref["source_ref"])
            if ref["gold_label"] is not None:
                text(ref["gold_label"])
                require(labels is None or ref["gold_label"] in labels, "REFERENCE_LABEL")
            r["external_label"] = ref["gold_label"]
        candidate = row["candidate"]
        if r["outcome"] != "SUCCEEDED":
            r["gaps"].append("NON_PREDICTION_OUTCOME")
        elif candidate is None:
            r["candidate_valid"] = False; r["gaps"].append("MISSING_CANDIDATE")
        else:
            fields(candidate, {"label", "support_refs", "counterevidence_refs"})
            predicted = text(candidate["label"])
            support = ids(candidate["support_refs"])
            counter = ids(candidate["counterevidence_refs"])
            r["predicted_label"] = predicted
            if labels is None:
                r["gaps"].append("LABELSPACE_UNBOUND")
            elif predicted not in labels:
                r["gaps"].append("UNKNOWN_RELATION_LABEL")
            if ref is None:
                r["gaps"].append("EVIDENCE_POLICY_OR_REFERENCE_MISSING")
            else:
                # Membership and preservation remain decidable even when the
                # separate mandatory-support policy has not been bound.
                in_scope = set(support) <= set(supporting)
                r["support_valid"] = (False if not in_scope else
                    None if not support and policy["require_support"] is None else
                    bool(support) or not policy["require_support"])
                r["counterevidence_preserved"] = (set(counter) <= set(available) and set(opposing) <= set(counter))
                if policy["require_support"] is None:
                    r["gaps"].append("EVIDENCE_POLICY_OR_REFERENCE_MISSING")
                if r["support_valid"] is False:
                    r["gaps"].append("UNSUPPORTED_REFERENCE")
                if not r["counterevidence_preserved"]:
                    r["gaps"].append("COUNTEREVIDENCE_NOT_PRESERVED")
            r["candidate_valid"] = local_validity(r["gaps"],
                {"LABELSPACE_UNBOUND", "EVIDENCE_POLICY_OR_REFERENCE_MISSING"})
            if r["candidate_valid"] is True and ref["gold_label"] is not None:
                r["correct"] = predicted == ref["gold_label"]
                r["loss"] = None if losses is None else losses[ref["gold_label"]][predicted]
        if r["external_label"] is None:
            r["gaps"].append("EXTERNAL_LABEL_MISSING")
        output.append(r)
    return classification(report("decision.semantic_relation", policy, rows, statuses, output), output, labels)


def score_context_relevance(records, policy):
    rows, statuses = base(records, policy,
        {"contexts", "context_set_ref", "gain_rule", "cutoff", "discounts", "token_budget"}, ROW | {"input_context_ids"})
    reference(policy["context_set_ref"])
    require(type(policy["contexts"]) is list and len(policy["contexts"]) <= MAX_ITEMS, "CONTEXTS")
    contexts = {}
    for item in policy["contexts"]:
        fields(item, {"id", "tokens"}); key = text(item["id"])
        require(key not in contexts, "DUPLICATE_CONTEXT")
        contexts[key] = integer(item["tokens"])
    require(type(policy["gain_rule"]) is str and policy["gain_rule"] in {"linear", "exp2_minus1"}, "EXPLICIT_GAIN_RULE")
    cutoff = integer(policy["cutoff"], 1)
    require(cutoff <= MAX_ITEMS, "CUTOFF_BOUND")
    discounts = policy["discounts"]
    require(type(discounts) is list and len(discounts) == cutoff, "DISCOUNTS")
    for value in discounts:
        require(number(value) > 0, "DISCOUNT_POSITIVE")
    require(all(a >= b for a, b in zip(discounts, discounts[1:])), "DISCOUNT_ORDER")
    budget = None if policy["token_budget"] is None else integer(policy["token_budget"])
    def gain(value):
        value = number(value)
        try:
            return number(value if policy["gain_rule"] == "linear" else 2.0**value - 1.0)
        except OverflowError as exc:
            raise ValueError("WORKFLOW_SCORER_GAIN_OVERFLOW") from exc
    output = []
    for row in rows:
        require(set(ids(row["input_context_ids"])) == set(contexts), "CHANGED_CONTEXT_SET")
        r = result(row, statuses)
        r.update({"selected_tokens": None, "dcg": None, "ideal_dcg": None, "ndcg": None,
                  "downstream_effect": None, "raw_score_kind": "RAW_SCORE_ONLY"})
        ref = row["reference"]
        relevance = None
        if ref is not None:
            fields(ref, {"relevance", "downstream_effect", "source_ref"}); reference(ref["source_ref"])
            relevance = ref["relevance"]
            if relevance is not None:
                require(type(relevance) is dict and set(relevance) == set(contexts), "REFERENCE_CONTEXT_IDS")
                for value in relevance.values(): gain(value)
            effect = ref["downstream_effect"]
            if effect is not None:
                fields(effect, {"correct", "required_omissions", "conflicts_preserved"})
                for name in ("correct", "conflicts_preserved"):
                    require(effect[name] is None or type(effect[name]) is bool, "DOWNSTREAM_BOOL")
                if effect["required_omissions"] is not None: integer(effect["required_omissions"])
        candidate = row["candidate"]
        if r["outcome"] != "SUCCEEDED":
            r["gaps"].append("NON_PREDICTION_OUTCOME")
        elif candidate is None:
            r["candidate_valid"] = False; r["gaps"].append("MISSING_CANDIDATE")
        else:
            fields(candidate, {"ordered_ids", "raw_scores"})
            order = ids(candidate["ordered_ids"])
            raw_scores = candidate["raw_scores"]
            if raw_scores is not None:
                require(type(raw_scores) is dict and set(raw_scores) <= set(contexts), "RAW_SCORE_CONTEXT_IDS")
                for value in raw_scores.values(): number(value, None)
            if not set(order) <= set(contexts): r["gaps"].append("UNKNOWN_SELECTED_CONTEXT")
            if len(order) > cutoff: r["gaps"].append("CUTOFF_EXCEEDED")
            if set(order) <= set(contexts):
                r["selected_tokens"] = sum(contexts[key] for key in order)
                if budget is None: r["gaps"].append("TOKEN_BUDGET_UNBOUND")
                elif r["selected_tokens"] > budget: r["gaps"].append("TOKEN_BUDGET_EXCEEDED")
            r["candidate_valid"] = local_validity(r["gaps"], {"TOKEN_BUDGET_UNBOUND"})
            if r["candidate_valid"] is True:
                if ref is not None:
                    # Independent caller observation is not relevance Gold.
                    r["downstream_effect"] = copy.deepcopy(ref["downstream_effect"])
                if relevance is not None:
                    r["dcg"] = number(math.fsum(gain(relevance[key]) * discounts[i] for i, key in enumerate(order)))
                    r["ideal_dcg"] = number(math.fsum(value * discounts[i] for i, value in
                        enumerate(sorted((gain(v) for v in relevance.values()), reverse=True)[:cutoff])))
                    r["ndcg"] = None if r["ideal_dcg"] == 0 else number(r["dcg"] / r["ideal_dcg"])
        if relevance is None: r["gaps"].append("EXTERNAL_RELEVANCE_MISSING")
        output.append(r)
    answer = report("decision.context_relevance", policy, rows, statuses, output)
    answer.update({"mean_ndcg": complete_mean([r["ndcg"] for r in output]),
                   "ndcg_available_count": sum(r["ndcg"] is not None for r in output),
                   "gain_rule": policy["gain_rule"], "context_set_ref": policy["context_set_ref"],
                   "ideal_dcg_scope": "All fixed candidates, unconstrained by selection tokens; not budget-optimal or minimum-sufficient selection."})
    return answer


def score_processing_routes(records, policy):
    rows, statuses = base(records, policy, {"nodes", "edges", "start", "allowed_action_ids", "max_steps", "budget"})
    allowed_actions = set(ids(policy["allowed_action_ids"]))
    require(type(policy["nodes"]) is list and 0 < len(policy["nodes"]) <= MAX_ITEMS, "GRAPH_NODES")
    nodes = {}
    for item in policy["nodes"]:
        fields(item, {"id", "action_id", "terminal", "cost"}); key = text(item["id"])
        require(key not in nodes, "DUPLICATE_NODE")
        require(type(item["terminal"]) is bool, "TERMINAL_BOOL")
        if item["action_id"] is not None: require(text(item["action_id"]) in allowed_actions, "GRAPH_ACTION_NOT_ALLOWED")
        number(item["cost"]); nodes[key] = item
    start = text(policy["start"]); require(start in nodes, "GRAPH_START")
    require(type(policy["edges"]) is list and len(policy["edges"]) <= MAX_ITEMS * 4, "GRAPH_EDGES")
    edges = set()
    for edge in policy["edges"]:
        require(type(edge) is list and len(edge) == 2, "EDGE_PAIR")
        require(all(text(k) in nodes for k in edge), "EDGE_NODE")
        pair = tuple(edge); require(pair not in edges, "DUPLICATE_EDGE"); edges.add(pair)
        require(not nodes[edge[0]]["terminal"], "EDGE_FROM_TERMINAL")
    steps = None if policy["max_steps"] is None else integer(policy["max_steps"], 1)
    budget = None if policy["budget"] is None else number(policy["budget"])
    def path_check(path):
        require(type(path) is list and 0 < len(path) <= MAX_ITEMS, "ROUTE_PATH")
        for key in path: text(key)
        errors = []
        if not set(path) <= set(nodes): return ["UNKNOWN_ROUTE_NODE"], None, None
        if path[0] != start: errors.append("WRONG_START")
        if any(pair not in edges for pair in zip(path, path[1:])): errors.append("ILLEGAL_EDGE")
        if not nodes[path[-1]]["terminal"]: errors.append("NOT_TERMINATED")
        if steps is not None and len(path) > steps: errors.append("STEP_BUDGET_EXCEEDED")
        cost = number(math.fsum(nodes[key]["cost"] for key in path))
        if budget is not None and cost > budget: errors.append("ROUTE_BUDGET_EXCEEDED")
        actions = [nodes[key]["action_id"] for key in path if nodes[key]["action_id"] is not None]
        return errors, cost, actions
    output = []
    for row in rows:
        r = result(row, statuses); r.update({"configured_budget_cost": None, "external_allowed": None})
        ref, allowed, losses = row["reference"], None, None
        if ref is not None:
            fields(ref, {"allowed_routes", "route_losses", "source_ref"}); reference(ref["source_ref"])
            allowed, losses = ref["allowed_routes"], ref["route_losses"]
            for collection in (allowed, losses): require(collection is None or type(collection) is list and len(collection) <= MAX_ITEMS, "ROUTE_REFERENCE")
            if allowed is not None:
                seen = set()
                for path in allowed:
                    errors, _, _ = path_check(path); require(not errors, "ILLEGAL_REFERENCE_ROUTE")
                    require(tuple(path) not in seen, "DUPLICATE_REFERENCE_ROUTE"); seen.add(tuple(path))
            if losses is not None:
                seen = set()
                for loss in losses:
                    fields(loss, {"path", "loss"}); errors, _, _ = path_check(loss["path"])
                    require(not errors, "ILLEGAL_REFERENCE_ROUTE"); number(loss["loss"])
                    require(tuple(loss["path"]) not in seen, "DUPLICATE_ROUTE_LOSS"); seen.add(tuple(loss["path"]))
        candidate = row["candidate"]
        if r["outcome"] != "SUCCEEDED": r["gaps"].append("NON_PREDICTION_OUTCOME")
        elif candidate is None:
            r["candidate_valid"] = False; r["gaps"].append("MISSING_CANDIDATE")
        else:
            fields(candidate, {"path", "actions"})
            require(type(candidate["actions"]) is list and len(candidate["actions"]) <= MAX_ITEMS, "ACTION_SEQUENCE")
            for action in candidate["actions"]: text(action)
            errors, cost, actions = path_check(candidate["path"])
            r["gaps"].extend(errors); r["configured_budget_cost"] = cost
            if not set(candidate["actions"]) <= allowed_actions: r["gaps"].append("ACTION_NOT_ALLOWED")
            if actions is not None and candidate["actions"] != actions: r["gaps"].append("ACTION_SEQUENCE_MISMATCH")
            if steps is None or budget is None: r["gaps"].append("ROUTE_BUDGET_UNBOUND")
            r["candidate_valid"] = local_validity(r["gaps"], {"ROUTE_BUDGET_UNBOUND"})
            if r["candidate_valid"] is True:
                if allowed is not None:
                    r["external_allowed"] = candidate["path"] in allowed
                    r["correct"] = r["external_allowed"]
                if losses is not None:
                    found = next((v for v in losses if v["path"] == candidate["path"]), None)
                    r["loss"] = None if found is None else found["loss"]
        if allowed is None: r["gaps"].append("EXTERNAL_ALLOWED_ROUTES_MISSING")
        if losses is None: r["gaps"].append("EXTERNAL_ROUTE_LOSS_MISSING")
        output.append(r)
    answer = report("decision.processing_route", policy, rows, statuses, output)
    answer.update({"accuracy": complete_mean([None if v["correct"] is None else int(v["correct"]) for v in output]),
                   "mean_loss": complete_mean([v["loss"] for v in output]),
                   "externally_assessed_count": sum(v["external_allowed"] is not None for v in output)})
    return answer
