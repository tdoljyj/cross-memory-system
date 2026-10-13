"""Pure saved v2 candidate -> existing workflow scorer projection.

The caller independently verifies the complete saved carrier, lawful input,
domain-adopted payload schema/spec, fixed policy/status mapping and references.
Hashes or supplied dictionaries do not establish that authority. This function
never invokes a model, acts on a route, creates truth, admits a Profile or
qualifies calibration. Structural/reference validity is separate from semantic
correctness; external scorer references never come from a model payload.

Original raw replies, usage, provider status and probability claims survive.
Valid semantic abstention is separate from actual provider failure. Unbound
inputs and malformed candidates retain explicit diagnostics and all expected
slots. Numeric labels, thresholds, cost/time/tokens and Gold are never invented.
"""
import copy
import hashlib
import math

from jsonschema import Draft202012Validator
from referencing import Registry
from validate_m2_scoped_successor import strict_json
import workflow_saved_scorers as scorers

MAX_RAW = 262144
SNAPSHOT_FIELDS = {"id", "input_sha256", "raw_output", "terminal_status", "usage", "split_id"}
BINDING_FIELDS = {"id", "input_sha256", "output_schema_digest", "task_input", "scoring_reference"}
PAYLOAD_FIELDS = {"status", "value", "score_kind", "distribution", "calibration_ref", "evidence_refs", "abstain_reason"}
TASKS = {"decision.semantic_relation": scorers.score_semantic_relations,
         "decision.context_relevance": scorers.score_context_relevance,
         "decision.processing_route": scorers.score_processing_routes}


class ProjectionError(ValueError):
    def __init__(self, code):
        self.code = "DECISION_PROJECTION_" + code
        super().__init__(self.code)


def require(ok, code):
    if not ok:
        raise ProjectionError(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest() if raw is not None else None


def hex_digest(value):
    return type(value) is str and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def deny_remote(_ref):
    raise ValueError("DECISION_PROJECTION_EXTERNAL_SCHEMA_REF")


def category_key(category, selected, policy):
    key = selected.get(category)
    require(type(key) is str and policy["status_categories"].get(key) == category, "SCORING_STATUS_MAPPING")
    return key


def candidate_value(task, body, supplied, policy, context_contract=None):
    """Local membership/type checks only, then existing scorer validates policy."""
    value = body["value"]
    visible = set(scorers.ids(supplied["visible_evidence_refs"]))
    require(set(scorers.ids(body["evidence_refs"])) <= visible, "EVIDENCE_OUTSIDE_INPUT")
    if task == "decision.semantic_relation":
        scorers.fields(supplied, {"visible_evidence_refs", "left_input_ref", "right_input_ref"})
        scorers.fields(value, {"relation_id", "left_input_ref", "right_input_ref", "support_refs", "counterevidence_refs"})
        require(value["left_input_ref"] == scorers.text(supplied["left_input_ref"])
                and value["right_input_ref"] == scorers.text(supplied["right_input_ref"]), "RELATION_PAIR_DRIFT")
        require(set(scorers.ids(value["support_refs"]) + scorers.ids(value["counterevidence_refs"])) <= visible,
                "RELATION_EVIDENCE_OUTSIDE_INPUT")
        return {"label": scorers.text(value["relation_id"]), "support_refs": copy.deepcopy(value["support_refs"]),
                "counterevidence_refs": copy.deepcopy(value["counterevidence_refs"])}
    if task == "decision.context_relevance":
        scorers.fields(supplied, {"visible_evidence_refs", "context_ids"})
        all_ids = scorers.ids(supplied["context_ids"])
        require(set(all_ids) == {item["id"] for item in policy["contexts"]}, "CONTEXT_POLICY_SET_DRIFT")
        scorers.fields(value, {"ranking", "unranked_context_refs"})
        require(type(value["ranking"]) is list and len(value["ranking"]) <= scorers.MAX_ITEMS, "RANKING_BOUND")
        order, scores = [], {}
        for item in value["ranking"]:
            scorers.fields(item, {"context_ref", "score"})
            key = scorers.text(item["context_ref"])
            order.append(key)
            if body["score_kind"] == "RAW_SCORE":
                scores[key] = scorers.number(item["score"], None)
            else:
                require(item["score"] is None, "RAW_RANK_SCORE_KIND")
        scorers.ids(order)
        unranked = scorers.ids(value["unranked_context_refs"])
        require(not set(order) & set(unranked) and set(order + unranked) == set(all_ids), "CONTEXT_PARTITION_DRIFT")
        if context_contract is not None and body["score_kind"] == "RAW_SCORE":
            stable = {key: index for index, key in enumerate(context_contract["stable_context_order"])}
            require(order == sorted(order, key=lambda key: (-scores[key], stable[key])), "CONTEXT_SCORE_ORDER")
        return {"ordered_ids": order, "raw_scores": scores if body["score_kind"] == "RAW_SCORE" else None}
    scorers.fields(supplied, {"visible_evidence_refs", "route_catalog"})
    scorers.fields(value, {"route_ref", "support_refs", "counterevidence_refs"})
    require(set(scorers.ids(value["support_refs"]) + scorers.ids(value["counterevidence_refs"])) <= visible,
            "ROUTE_EVIDENCE_OUTSIDE_INPUT")
    catalog = supplied["route_catalog"]
    require(type(catalog) is dict and len(catalog) <= scorers.MAX_ITEMS, "ROUTE_CATALOG_BOUND")
    key = scorers.text(value["route_ref"])
    require(key in catalog, "ROUTE_NOT_IN_PERMITTED_CODE_SET")
    # The model selects one permitted code-defined path; never provides actions.
    path = catalog[key]
    require(type(path) is list and 0 < len(path) <= scorers.MAX_ITEMS, "BOUND_ROUTE_PATH")
    nodes = {item["id"]: item for item in policy["nodes"]}
    require(all(type(node) is str and node in nodes for node in path), "BOUND_ROUTE_NODE")
    actions = [nodes[node]["action_id"] for node in path if nodes[node]["action_id"] is not None]
    return {"path": copy.deepcopy(path), "actions": actions}


def score_claims(body, contract):
    """Check finite probability shape, never calibration provenance or truth."""
    kind = body["score_kind"]
    require(kind in {"RAW_SCORE", "MODEL_PROBABILITY", "CALIBRATED_PROBABILITY", "NONE"}, "SCORE_KIND")
    distribution, calibration = body["distribution"], body["calibration_ref"]
    if kind in {"NONE", "RAW_SCORE"}:
        require(distribution is None and calibration is None, "NON_PROBABILITY_CLAIMS")
    else:
        require(type(contract) is dict and set(contract) == {"labels", "sum_tolerance", "estimation_object_ref"},
                "PROBABILITY_CONTRACT_UNBOUND")
        labels = scorers.ids(contract["labels"], True)
        scorers.text(contract["estimation_object_ref"])
        tolerance = scorers.number(contract["sum_tolerance"])
        require(tolerance < 1, "PROBABILITY_TOLERANCE")
        require(type(distribution) is dict and set(distribution) == set(labels), "PROBABILITY_LABEL_KEYS")
        for value in distribution.values():
            require(scorers.number(value) <= 1, "PROBABILITY_RANGE")
        require(abs(math.fsum(distribution.values()) - 1) <= tolerance, "PROBABILITY_SUM")
        if kind == "MODEL_PROBABILITY":
            require(calibration is None, "MODEL_PROBABILITY_CALIBRATION_CLAIM")
        else:
            scorers.text(calibration)
    return {"score_kind_claim": kind, "distribution": copy.deepcopy(distribution),
            "calibration_ref_claim": calibration, "estimation_object_ref":
            None if contract is None else contract.get("estimation_object_ref"),
            "calibration_provenance_verified": False, "probability_auto_path_admitted": False}


def project_decision_snapshot(snapshot, bindings, policy, *, task_key, payload_schema_raw,
                              payload_schema_sha256, runtime_status_categories, scoring_category_keys,
                              probability_contract=None, context_contract=None):
    """All inputs are local projections, not a registered schema or proof API.

    snapshot is the complete carrier from existing project_saved_snapshot.
    bindings are caller-fixed input hashes/visible refs/task inputs and separate
    scorer references. Status maps are pre-frozen by the caller; no defaults.
    supplied payload Schema must have actual domain adoption outside this code.
    """
    require(task_key in TASKS, "TASK")
    require(type(snapshot) is list and len(snapshot) <= scorers.MAX_REQUESTS, "SNAPSHOT_BOUND")
    require(type(bindings) is list and len(bindings) <= scorers.MAX_REQUESTS, "BINDING_BOUND")
    for metadata in (bindings, policy, runtime_status_categories, scoring_category_keys, probability_contract, context_contract):
        scorers.finite_json(metadata)
    require(type(runtime_status_categories) is dict and type(scoring_category_keys) is dict, "STATUS_MAPS")
    for key, category in runtime_status_categories.items():
        scorers.text(key); require(category in scorers.OUTCOMES, "RUNTIME_CATEGORY")
    expected = scorers.ids(policy["expected_request_ids"])
    require(type(payload_schema_raw) is bytes and len(payload_schema_raw) <= MAX_RAW
            and sha(payload_schema_raw) == payload_schema_sha256 and hex_digest(payload_schema_sha256), "SCHEMA_BYTES")
    schema = strict_json(payload_schema_raw); scorers.finite_json(schema)
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema, registry=Registry(retrieve=deny_remote))
    by_id, binding_by_id = {}, {}
    for slot in snapshot:
        scorers.fields(slot, SNAPSHOT_FIELDS)
        key = scorers.text(slot["id"])
        require(key not in by_id and hex_digest(slot["input_sha256"]), "SNAPSHOT_ID_OR_HASH")
        require(slot["raw_output"] is None or type(slot["raw_output"]) is bytes, "ORIGINAL_BYTES")
        scorers.finite_json(slot["usage"])
        require(slot["terminal_status"] is None or type(slot["terminal_status"]) is str, "RUNTIME_STATUS")
        by_id[key] = slot
    for binding in bindings:
        scorers.fields(binding, BINDING_FIELDS)
        key = scorers.text(binding["id"])
        require(key not in binding_by_id and hex_digest(binding["input_sha256"]), "BINDING_ID_OR_HASH")
        binding_by_id[key] = binding
    require(set(by_id) == set(expected) == set(binding_by_id), "EXPECTED_SET")
    if context_contract is not None:
        require(task_key == "decision.context_relevance", "CONTEXT_CONTRACT_TASK")
        scorers.fields(context_contract, {"score_direction", "stable_context_order", "reference_grades"})
        require(context_contract["score_direction"] == "HIGHER_FIRST", "CONTEXT_SCORE_DIRECTION")
        grades = context_contract["reference_grades"]
        require(type(grades) is list and grades == [0, 1, 2, 3]
                and all(type(grade) is int for grade in grades), "CONTEXT_REFERENCE_SCALE")
        stable_order = scorers.ids(context_contract["stable_context_order"])
        require(set(stable_order) == {item["id"] for item in policy["contexts"]}, "CONTEXT_STABLE_ORDER_SET")
        # External reference configuration errors refuse before classifying any
        # model candidate; missing external truth still stays unknown.
        for binding in bindings:
            reference = binding["scoring_reference"]
            if reference is not None:
                scorers.fields(reference, {"relevance", "downstream_effect", "source_ref"})
                relevance = reference["relevance"]
                if relevance is not None:
                    require(type(relevance) is dict and set(relevance) == set(stable_order), "CONTEXT_REFERENCE_SET")
                    require(all(type(value) in (int, float) and value in grades for value in relevance.values()),
                            "CONTEXT_REFERENCE_GRADE")
    # Caller configuration errors are not model mistakes. Refuse before
    # classifying any candidate; the untouched caller retains every raw slot.
    for key in expected:
        supplied = binding_by_id[key]["task_input"]
        require(by_id[key]["input_sha256"] == binding_by_id[key]["input_sha256"], "INPUT_IDENTITY_DRIFT")
        # Existing Port canonical-JSON digest convention. The caller takes this
        # field from the verified original request, not from a model reply.
        require(binding_by_id[key]["output_schema_digest"] == "sha256:" + scorers.digest(schema),
                "REQUEST_OUTPUT_SCHEMA_DRIFT")
        extra = {"decision.semantic_relation": {"left_input_ref", "right_input_ref"},
                 "decision.context_relevance": {"context_ids"},
                 "decision.processing_route": {"route_catalog"}}[task_key]
        scorers.fields(supplied, {"visible_evidence_refs"} | extra)
        scorers.ids(supplied["visible_evidence_refs"])
        if task_key == "decision.context_relevance":
            require(set(scorers.ids(supplied["context_ids"])) == {item["id"] for item in policy["contexts"]},
                    "CONTEXT_POLICY_SET_DRIFT")
    rows, slots = [], []
    for key in expected:
        original, binding = by_id[key], binding_by_id[key]
        raw = original["raw_output"]
        view = {"id": key, "raw_output": raw, "raw_sha256": sha(raw),
                "original_provider_status": original["terminal_status"], "usage": copy.deepcopy(original["usage"]),
                "decision_payload": None, "score_claims": None, "gaps": [], "scoring_row": None}
        row = {"id": key, "status": None, "candidate": None, "reference": copy.deepcopy(binding["scoring_reference"])}
        if task_key == "decision.context_relevance":
            row["input_context_ids"] = copy.deepcopy(binding["task_input"]["context_ids"])
        category = runtime_status_categories.get(original["terminal_status"], "UNKNOWN")
        try:
            if category == "SUCCEEDED":
                require(raw is not None and len(raw) <= MAX_RAW, "PAYLOAD_MISSING_OR_OVERSIZED")
                body = strict_json(raw); scorers.finite_json(body)
                view["decision_payload"] = copy.deepcopy(body)
                scorers.fields(body, PAYLOAD_FIELDS)
                require(not list(validator.iter_errors(body)), "PAYLOAD_SCHEMA")
                require(type(binding["task_input"]) is dict, "TASK_INPUT_UNBOUND")
                visible = set(scorers.ids(binding["task_input"]["visible_evidence_refs"]))
                require(set(scorers.ids(body["evidence_refs"])) <= visible, "EVIDENCE_OUTSIDE_INPUT")
                view["score_claims"] = score_claims(body, probability_contract)
                if body["score_kind"] == "CALIBRATED_PROBABILITY":
                    view["gaps"].append("CALIBRATION_PROVENANCE_NOT_VERIFIED")
                if body["status"] == "ABSTAINED":
                    require(body["value"] is None and body["score_kind"] == "NONE"
                            and body["abstain_reason"] is not None, "ABSTENTION_CONTRACT")
                    category = "ABSTAINED"
                else:
                    require(body["status"] == "PREDICTED" and body["abstain_reason"] is None, "MODEL_STATUS")
                    row["candidate"] = candidate_value(task_key, body, binding["task_input"], policy, context_contract)
            row["status"] = category_key(category, scoring_category_keys, policy)
        except Exception as error:
            # Only fixed local diagnostics, never arbitrary validator/error text.
            code = error.code if type(error) is ProjectionError else "DECISION_PROJECTION_CANDIDATE_OR_BINDING_INVALID"
            view["gaps"].append(code)
            row["candidate"] = None
            category = "UNKNOWN" if code == "DECISION_PROJECTION_PROBABILITY_CONTRACT_UNBOUND" else "SCHEMA_INVALID"
            row["status"] = category_key(category, scoring_category_keys, policy)
        view["scoring_row"] = copy.deepcopy(row)
        rows.append(row); slots.append(view)
    # Reuse all existing label/reference/ranking/graph/budget/scoring checks.
    scored = TASKS[task_key](rows, copy.deepcopy(policy))
    return {"slots": slots, "scorer_records": rows, "scorer_report": scored,
            "context_contract": copy.deepcopy(context_contract),
            "context_contract_sha256": None if context_contract is None else scorers.digest(context_contract),
            "authority_effect": "NONE", "qualification": "NOT_ISSUED",
            "domain_adoption_verified": False, "saved_carrier_authentication_verified": False,
            "reference_provenance_verified": False, "probability_auto_path_admitted": False}
