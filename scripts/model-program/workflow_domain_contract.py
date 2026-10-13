"""Bind candidate TaskSpec schemas to existing saved projection arguments.

This pure helper checks exact local bytes and structural compatibility only.
Caller independently verifies domain adoption, original request/context identity,
current permissions and reference provenance. No model, issuer or action runs.
"""
import copy
import hashlib
import json

from jsonschema import Draft202012Validator
from referencing import Registry

from validate_m2_scoped_successor import strict_json
import workflow_saved_scorers as scorers
import decision_candidate_projection as projection

TASKS = {"decision.semantic_relation", "decision.context_relevance", "decision.processing_route"}
MAX_PACKAGE_BYTES = 262144
ACCEPTED_DEFINITION_DIGESTS = {
    "decision.semantic_relation": "cccbdf3652882b8d9719cdc9cb1b7a347bf26a72fd803cd503c84834e4ac24db",
    "decision.context_relevance": "d19d843b842c7454f3133c38c7f5d8b421c84350ddcd85fc8a18407c56699d14",
    "decision.processing_route": "dbeab859448b8e96af5662e0da8a9e6d94892737e9d38bafa4b36f03cd411b76",
}  # Whole definition objects from the exact Owner-accepted r2, not label counts.


def require(value, reason):
    if not value:
        raise ValueError("WORKFLOW_DOMAIN_" + reason)


def deny_remote(_ref):
    raise ValueError("WORKFLOW_DOMAIN_EXTERNAL_SCHEMA")


def schema_without_refs(schema):
    # These private schemas are self-contained. Never fetch an external schema.
    if type(schema) is dict:
        require(not ({"$ref", "$dynamicRef"} & set(schema)), "EXTERNAL_SCHEMA")
        for child in schema.values():
            schema_without_refs(child)
    elif type(schema) is list:
        for child in schema:
            schema_without_refs(child)


def bind_task_input(package_raw, package_sha256, logical_task, task_input, request_output_schema_digest):
    """Return structurally checked input/schema for project_decision_snapshot.

    input_sha256 and context identity remain the verified original caller's
    responsibility; task_input is not the actual prompt or a second Port DTO.
    """
    require(type(package_raw) is bytes and 0 < len(package_raw) <= MAX_PACKAGE_BYTES, "PACKAGE_BYTES")
    require(hashlib.sha256(package_raw).hexdigest() == package_sha256, "PACKAGE_DRIFT")
    package = strict_json(package_raw)
    scorers.finite_json(package); scorers.finite_json(task_input)
    require(package.get("artifact_role") == "MODEL_DOMAIN_TASK_SPEC_COMPATIBILITY_CANDIDATE"
            and package.get("version") == "1"
            and package.get("status") == "CANDIDATE_PENDING_DOMAIN_ADOPTION"
            and package.get("authority_effect") == "NONE", "PACKAGE_ROLE")
    specs = package.get("specs")
    require(type(specs) is list and len(specs) == 3
            and all(type(spec) is dict for spec in specs), "TASK_SET")
    require({spec.get("logical_task") for spec in specs} == TASKS, "TASK_SET")
    for spec in specs:
        require(scorers.digest(spec["definition"]) == ACCEPTED_DEFINITION_DIGESTS[spec["logical_task"]], "SEMANTIC_DRIFT")
    require(logical_task in TASKS, "UNKNOWN_TASK")
    selected = next(spec for spec in specs if spec["logical_task"] == logical_task)
    for schema_key, digest_key in (("input_binding_schema", "input_binding_schema_digest"),
                                   ("output_schema", "output_schema_digest")):
        schema = selected[schema_key]
        schema_without_refs(schema)
        Draft202012Validator.check_schema(schema)
        require("sha256:" + scorers.digest(schema) == selected[digest_key], "SCHEMA_DRIFT")
    require(request_output_schema_digest == selected["output_schema_digest"], "REQUEST_SCHEMA_DRIFT")
    validator = Draft202012Validator(selected["input_binding_schema"], registry=Registry(retrieve=deny_remote))
    require(not list(validator.iter_errors(task_input)), "INPUT_BINDING_SCHEMA")
    # Preserve the existing Port canonical-JSON digest, plus original bytes for
    # the saved projection's independent raw-byte check. Neither is authority.
    output_raw = json.dumps(selected["output_schema"], sort_keys=True, ensure_ascii=False,
                            separators=(",", ":"), allow_nan=False).encode("utf-8")
    return {"task_input": copy.deepcopy(task_input), "payload_schema_raw": output_raw,
            "payload_schema_sha256": hashlib.sha256(output_raw).hexdigest(),
            "output_schema_digest": selected["output_schema_digest"],
            "authority_effect": "NONE", "domain_adoption_verified": False,
            "input_permission_verified": False, "qualification": "NOT_ISSUED"}


def project_task_snapshot(package_raw, package_sha256, snapshot, bindings, policy, *, task_key,
                          runtime_status_categories, scoring_category_keys, stable_context_order=None,
                          probability_contract=None):
    """Use accepted candidate definitions with the existing saved projection.

    Context tie order is an explicit caller-frozen policy input, never selected
    after seeing model scores. No ordering is inferred for rank-only output.
    This checks declared definitions, not actual adoption, permission or freeze.
    """
    require(type(bindings) is list and 0 < len(bindings) <= scorers.MAX_REQUESTS, "BINDING_SET")
    prepared = None
    for binding in bindings:
        prepared = bind_task_input(package_raw, package_sha256, task_key, binding["task_input"],
                                   binding["output_schema_digest"])
    context_contract = None
    if task_key == "decision.context_relevance":
        # Task definitions are pinned above; this is the discrete reference
        # adjudication scale, not model raw scores or a probability threshold.
        require(type(stable_context_order) is list, "FROZEN_CONTEXT_ORDER_UNBOUND")
        context_contract = {"score_direction": "HIGHER_FIRST", "stable_context_order": copy.deepcopy(stable_context_order),
                            "reference_grades": [0, 1, 2, 3]}
    else:
        require(stable_context_order is None, "UNEXPECTED_CONTEXT_ORDER")
    result = projection.project_decision_snapshot(snapshot, bindings, policy, task_key=task_key,
        payload_schema_raw=prepared["payload_schema_raw"], payload_schema_sha256=prepared["payload_schema_sha256"],
        runtime_status_categories=runtime_status_categories, scoring_category_keys=scoring_category_keys,
        probability_contract=probability_contract, context_contract=context_contract)
    result["candidate_definition_package_sha256"] = package_sha256
    return result
