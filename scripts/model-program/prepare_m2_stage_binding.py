"""Source-bound metadata preparation; never load samples or attest real freeze.

No old M2 module is imported. No model/data execution, question generation,
domain permission, DataGate, Gate or Authority is implemented here.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
from datetime import datetime, timezone

COMMIT = "e76a7db7edc6b47b5a719e165f688621efa9580a"
PINS = {
    "scripts/model-program/validate_m2_dataset_split.py": "c80614e2832e665cd3c1a706bd8c59a54a2bf0d14c5637ecfb51347f3263f4e2",
    "scripts/model-program/validate_m2_dataset_foundation.py": "4851363816c650c83bfd7be00d16e4a61b4d59d816d585b10c3a6f7580fe8d77",
    "development/contracts/model-program/m2/schemas/DatasetSplit.v0.1.schema.json": "062860afd3dc16fa9ee1de27582439701a67b7c5976ad45981a7cca3e515468f",
    "development/contracts/model-program/m2/schemas/DatasetManifest.owner-adopted.schema.json": "7352272c3d066bae22c9868ac41a043de6f9f877107c3fae798b36e8832b2d5b",
    "development/contracts/model-program/m2/schemas/SelectionInput.schema.json": "f733cb1e6f470a1d2d222d51e90cc51b786d5f4c01ec7c9530f3fef9f7f9c76e",
}
PARENTS = {"training": "TRAINING", "development": "DEVELOPMENT", "calibration_fit": "DEVELOPMENT", "selection_policy_validation": "DEVELOPMENT", "qualification": "QUALIFICATION", "final_holdout": "FINAL_HOLDOUT"}
USE = {"training": "weight_learning", "development": "prompt_or_architecture_tuning", "calibration_fit": "calibration_fit", "selection_policy_validation": "selection", "qualification": None, "final_holdout": None}
ROLES = {"qualification": ("M2_REFERENCE_BASELINE", ["M1_FIXED_REFERENCE", "FIXED_DETERMINISTIC_BASELINE"], "M2_DATA_GATE_PREPARATION"), "final_holdout": ("FINAL_PRODUCT_CANDIDATE", ["M4", "M5", "M5A"], "PRODUCT_FINAL_QUALIFICATION_PREPARATION")}
HEX = re.compile(r"[0-9a-f]{64}\Z")
BOUND_KEYS = ["candidate_role", "source_stage", "candidate_revision_sha256", "calibrator_revision", "threshold_policy_revision", "workflow_revision", "scorer_revision", "prompt_revision", "schema_revision", "candidate_frozen_at", "samples_materialized_at"]
POOL_KEYS = ["manifest_sha256", "near_duplicate_groups_sha256", "sampling_policy_sha256", "size_statistical_basis_ref", "custody_ref", "access_isolation_ref", "freeze_evidence_ref", "freeze_at", "first_selection_feedback_at"]


class PreflightError(ValueError):
    pass


# Keep the preparation API name used by the first source-bound consumer.
PreparationError = PreflightError


def exact(value, keys, name):
    if type(value) is not dict or set(value) != set(keys):
        raise PreparationError(name + ": unknown/missing fields")
    return value


def ref(value, name, blocking):
    if value is None:
        blocking.append(name)
    elif type(value) is not str or not value.strip() or len(value) > 512:
        raise PreparationError(name + ": reference required, caller boolean forbidden")


def sha(value, name, blocking):
    if value is None:
        blocking.append(name)
    elif type(value) is not str or not HEX.fullmatch(value):
        raise PreparationError(name + ": exact SHA256 required")


def timestamp(value, name, blocking):
    if value is None:
        blocking.append(name)
        return None
    if type(value) is not str or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)", value):
        raise PreparationError(name + ": exact UTC metadata time required")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None or parsed.utcoffset() != timezone.utc.utcoffset(parsed):
            raise PreparationError(name + ": UTC required")
        return parsed
    except ValueError as exc:
        raise PreparationError(name + ": invalid time") from exc


def validate_sources(sources):
    if type(sources) is not dict or set(sources) != set(PINS):
        raise PreparationError("ORIGINAL_SOURCE_UNAVAILABLE_OR_UNKNOWN")
    for path, expected in PINS.items():
        raw = sources[path]
        if type(raw) is not bytes or len(raw) > 65536 or hashlib.sha256(raw).hexdigest() != expected:
            raise PreparationError("ORIGINAL_SOURCE_HASH_DRIFT: " + path)


def validate_contract(contract):
    # Deliberately source/policy validation, not permission or an issuer check.
    exact(contract, ["schema", "status", "owner_rule", "original_source_commit", "source_pins", "purpose_parent_map", "candidate_roles", "reserved_pool_semantics", "source_copy_is_domain_authority", "actual_question_generation", "actual_execution", "authority_effect", "m2_qualification", "m3_qualification", "old_frozen_definition_schema_mapping_modified"], "contract")
    if contract.get("schema") != "clued.model-program.m2-stage-binding-preparation/1" or contract.get("status") != "ENGINEERING_SUCCESSOR_PREPARATION_ONLY":
        raise PreparationError("CONTRACT_SCHEMA")
    owner = contract.get("owner_rule", {})
    if owner != {"decision_id": "07696647-1557-4b0d-9eed-c1f698f4b011", "version": 1, "receipt_id": "7313df9c-b97f-4d90-beb6-f43d32cf469c"} or type(owner.get("version")) is not int:
        raise PreparationError("CONTRACT_OWNER_RULE_BINDING")
    if contract.get("original_source_commit") != COMMIT or contract.get("source_pins") != PINS or contract.get("purpose_parent_map") != PARENTS:
        raise PreparationError("CONTRACT_SOURCE_OR_PURPOSE_DRIFT")
    candidate_roles = exact(contract["candidate_roles"], ["qualification", "final_holdout"], "candidate_roles")
    for purpose, (role, stages, consumer) in ROLES.items():
        if candidate_roles[purpose] != {"role": role, "source_stages": stages, "consumer": consumer}:
            raise PreparationError("CONTRACT_CANDIDATE_ROLE_DRIFT")
    for key in ("source_copy_is_domain_authority", "actual_question_generation", "old_frozen_definition_schema_mapping_modified"):
        if contract.get(key) is not False:
            raise PreparationError("CONTRACT_EFFECT_OR_AUTHORITY_FORBIDDEN")
    if contract.get("actual_execution") != "NONE" or contract.get("authority_effect") != "NONE" or contract.get("m2_qualification") != "NOT_ISSUED" or contract.get("m3_qualification") != "NOT_ISSUED":
        raise PreparationError("CONTRACT_QUALIFICATION_FORBIDDEN")


def prepare_binding(request, sources, contract):
    validate_sources(sources)
    validate_contract(contract)
    q = exact(request, ["schema", "status", "original_source_commit", "purpose_id", "parent_boundary", "use_key", "stage_id", "report_consumer", "fixed_candidate_binding", "reserved_source_pool", "experiment_profile_ref", "data_permission_ref", "domain_authority_receipt_ref"], "request")
    if q["schema"] != "clued.model-program.m2-stage-binding-request/1" or q["status"] != "PREPARATION_ONLY" or q["original_source_commit"] != COMMIT:
        raise PreparationError("REQUEST_SCOPE")
    purpose = q["purpose_id"]
    if type(purpose) is not str or purpose not in PARENTS or q["parent_boundary"] != PARENTS[purpose] or q["use_key"] != USE[purpose]:
        raise PreparationError("PURPOSE_PARENT_OR_USE_MIXED")
    if q["stage_id"] not in ("T0", "T1", "M2", "M4", "M5", "M5A"):
        raise PreparationError("STAGE_UNKNOWN_OR_FULL_M3_T2_T3_FORBIDDEN")
    if q["stage_id"] in ("T0", "T1") and purpose not in ("training", "development"):
        raise PreparationError("DEVELOPMENT_FOUNDATION_PROTECTED_PURPOSE_FORBIDDEN")
    blocking = []
    for key in ("experiment_profile_ref", "data_permission_ref", "domain_authority_receipt_ref"):
        ref(q[key], key, blocking)
    binding = q["fixed_candidate_binding"]
    candidate_time = materialized_time = None
    if purpose in ROLES:
        b = exact(binding, BOUND_KEYS, "fixed_candidate_binding")
        role, stages, consumer = ROLES[purpose]
        if b["candidate_role"] != role or b["source_stage"] not in stages or q["report_consumer"] != consumer:
            raise PreparationError("CANDIDATE_ROLE_STAGE_OR_REPORT_CROSS_USE")
        if purpose == "qualification" and q["stage_id"] != "M2":
            raise PreparationError("M2_REFERENCE_ACCEPTANCE_STAGE_REQUIRED")
        if purpose == "final_holdout" and q["stage_id"] not in ("M4", "M5", "M5A"):
            raise PreparationError("FINAL_PRODUCT_ACCEPTANCE_STAGE_REQUIRED")
        sha(b["candidate_revision_sha256"], "candidate_revision_sha256", blocking)
        for key in BOUND_KEYS[3:9]:
            ref(b[key], "fixed_candidate_binding." + key, blocking)
        candidate_time = timestamp(b["candidate_frozen_at"], "candidate_frozen_at", blocking)
        materialized_time = timestamp(b["samples_materialized_at"], "samples_materialized_at", blocking)
        if candidate_time is not None and materialized_time is not None and not candidate_time < materialized_time:
            raise PreparationError("MATERIALIZATION_MUST_FOLLOW_PURPOSE_BOUND_CANDIDATE_FREEZE")
    else:
        if binding is not None:
            raise PreparationError("FIXED_CANDIDATE_BINDING_NOT_APPLICABLE")
        allowed_reports = {"training": "TRAINING_ENGINEERING_PREPARATION", "development": "DEVELOPMENT_ENGINEERING_PREPARATION", "calibration_fit": "CALIBRATION_PREPARATION", "selection_policy_validation": "M3_SELECTION_PREPARATION"}
        if q["report_consumer"] != allowed_reports[purpose]:
            raise PreparationError("FINAL_OR_QUALIFICATION_RESULT_CANNOT_FLOW_TO_SELECTION")
    pool = q["reserved_source_pool"]
    requires_pool = purpose in ("final_holdout", "selection_policy_validation")
    if pool is None:
        if requires_pool:
            blocking.append("reserved_source_pool_metadata_required")
    else:
        pool = exact(pool, POOL_KEYS, "reserved_source_pool")
        for key in POOL_KEYS[:3]:
            sha(pool[key], "reserved_source_pool." + key, blocking)
        for key in POOL_KEYS[3:7]:
            ref(pool[key], "reserved_source_pool." + key, blocking)
        frozen = timestamp(pool["freeze_at"], "reserved_source_pool.freeze_at", blocking)
        feedback = timestamp(pool["first_selection_feedback_at"], "reserved_source_pool.first_selection_feedback_at", blocking)
        if frozen is not None and feedback is not None and not frozen < feedback:
            raise PreparationError("RESERVED_INPUT_FREEZE_MUST_PRECEDE_SELECTION_FEEDBACK")
        if purpose == "final_holdout" and frozen is not None and candidate_time is not None and not frozen <= candidate_time:
            raise PreparationError("RESERVED_INPUT_FREEZE_AFTER_PRODUCT_FREEZE")
        if purpose == "final_holdout" and feedback is not None and candidate_time is not None and not feedback <= candidate_time:
            raise PreparationError("SELECTION_FEEDBACK_AFTER_FINAL_PRODUCT_FREEZE")
    blocking += ["actual_effect_profile_permission_verification_unavailable", "actual_data_permission_verification_unavailable", "actual_domain_authority_and_data_gate_verification_unavailable"]
    if pool is not None or requires_pool:
        blocking += ["actual_reserved_pool_freeze_verification_unavailable", "actual_custody_access_isolation_verification_unavailable"]
    if purpose in ROLES:
        blocking += ["actual_fixed_candidate_and_time_evidence_verification_unavailable"]
    return {"status": "PREPARATION_VALIDATION", "original_source_commit": COMMIT,
            "source_sha256": dict(PINS), "purpose_id": purpose, "parent_boundary": q["parent_boundary"],
            "execution_ready": False, "actual_execution": "NONE", "authority_effect": "NONE",
            "m2_qualification": "NOT_ISSUED", "m3_qualification": "NOT_ISSUED",
            "domain_authority_receipt": "NOT_ISSUED", "data_gate": "NOT_ISSUED",
            "actual_reserved_pool_freeze_verified": False, "actual_question_generation": False,
            "blocking_fields": sorted(set(blocking))}


def strict_json(raw):
    if type(raw) is not bytes or len(raw) > 65536:
        raise PreparationError("JSON_BYTE_BOUND")
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise PreparationError("DUPLICATE_JSON_KEY")
            value[key] = item
        return value
    def nonfinite(_value):
        raise PreparationError("NONFINITE_JSON")
    return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=nonfinite)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request", type=Path)
    args = parser.parse_args(argv)
    here = Path(__file__).resolve().parent
    try:
        raw = args.request.read_bytes()
        if len(raw) > 65536:
            raise PreparationError("REQUEST_BYTE_BOUND")
        repo_root = here.parents[1]
        source_root = repo_root / "tests/fixtures/model-stage-admission/pr441-e76a7"
        sources = {path: (source_root / path).read_bytes() for path in PINS}
        result = prepare_binding(strict_json(raw), sources, strict_json((repo_root / "development/contracts/model-program/stage-admission/M2StageBindingPreparation.v0.1.json").read_bytes()))
        print(json.dumps(result, sort_keys=True))
        return 0
    except (PreparationError, OSError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps({"status": "PREPARATION_REJECTED", "error": str(exc), "execution_ready": False, "actual_execution": "NONE", "authority_effect": "NONE", "m2_qualification": "NOT_ISSUED"}, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
