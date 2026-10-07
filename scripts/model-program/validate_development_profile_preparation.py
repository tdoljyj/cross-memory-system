"""Validate a preparation candidate, never issue or execute an experiment Profile.

No model, process, network, training, Canonical or native mutation entry exists.
The frozen M0/M1 Profile schemas are deliberately not rewritten by this consumer.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime
from pathlib import Path

SCHEMA = "clued.model-program.ExperimentAuthorizationProfile/preparation-v3"
CONTRACT_SCHEMA = "clued.model-program-stage-admission-successor/1"
DECISION = "07696647-1557-4b0d-9eed-c1f698f4b011"
RECEIPT = "7313df9c-b97f-4d90-beb6-f43d32cf469c"
PLAN_SHA = "a918f42e6e9de160f7b14a95afafeae9022ddcc189b3663e768aa197110118a4"
RULE_JSON_SHA = "8223b918471f8ef8a33207509c0052322b894824b596280c601395d224bb9fd1"
RULE_TEXT_SHA = "9e1917c5dcead7de060d262403577407396d74a0333b6feecaec1d60ffa22baf"
FOUNDATION = "EXACT_REVIEWED_INPUT_SET_OF_EXISTING_EXPERIMENT_AUTHORIZATION_PROFILE_ONLY"
STOPS = ["authority_unavailable", "budget_exhausted", "deadline_expired", "source_or_identity_drift", "validation_failure"]
HEX = re.compile(r"[0-9a-f]{64}\Z")


class PreparationError(ValueError):
    pass


def exact(value, keys, field):
    if type(value) is not dict or set(value) != set(keys):
        raise PreparationError(field + ": unknown or missing fields")
    return value


def string(value, field):
    if type(value) is not str or not value.strip() or len(value) > 512:
        raise PreparationError(field + ": nonempty bounded string required")


def digest(value, field, nullable=False):
    if value is None and nullable:
        return
    if type(value) is not str or not HEX.fullmatch(value):
        raise PreparationError(field + ": exact lowercase SHA256 required")


def integer(value, field, lower, upper):
    if type(value) is not int or not lower <= value <= upper:
        raise PreparationError(field + ": bounded integer required, boolean forbidden")


def nullable_reference(value, field):
    if value is not None:
        string(value, field)
        if value.lower().startswith(("dummy", "fixture", "fake", "mock")):
            raise PreparationError(field + ": synthetic authority/device reference forbidden")


def utc(value, field):
    if value is None:
        return None
    if type(value) is not str or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value):
        raise PreparationError(field + ": exact UTC timestamp required")
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError as exc:
        raise PreparationError(field + ": invalid UTC timestamp") from exc


def load_json(raw):
    if type(raw) is not bytes or len(raw) > 262144:
        raise PreparationError("JSON bytes bounded to 256KiB")
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise PreparationError("duplicate JSON field: " + key)
            result[key] = value
        return result
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=unique,
                          parse_constant=lambda value: (_ for _ in ()).throw(PreparationError("nonfinite JSON")))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise PreparationError("invalid UTF-8 JSON") from exc


def validate_profile(profile, contract_raw=None):
    """Return only candidate preparation findings. References never grant authority."""
    p = exact(profile, ["schema", "profile_id", "status", "stage_id", "environment", "experiment_kind",
                        "weight_learning_planned", "training_allowed", "real_model_evaluation_allowed",
                        "production_allowed", "source_lock", "dataset", "recipe", "device", "authority",
                        "window", "budget", "attempts", "stop_conditions", "acceptance_flow",
                        "legacy_m1_profile_ref"], "profile")
    if p["schema"] != SCHEMA or p["status"] != "CANDIDATE_PREPARATION_ONLY":
        raise PreparationError("preparation schema/status required; issued profile forbidden")
    string(p["profile_id"], "profile_id")
    if p["profile_id"].lower().startswith("m1-") or p["legacy_m1_profile_ref"] is not None:
        raise PreparationError("terminal M1 execution Profile must not reopen")
    if p["stage_id"] not in ("T0", "T1") or type(p["stage_id"]) is not str:
        raise PreparationError("only T0/T1 preparation; T2/T3/full qualification forbidden")
    if p["environment"] != "NON_PRODUCTION":
        raise PreparationError("NON_PRODUCTION only")
    if p["experiment_kind"] not in ("PIPELINE_SMOKE", "TOKENIZER_SMOKE", "ARCHITECTURE_SMOKE"):
        raise PreparationError("unregistered development experiment kind")
    if type(p["weight_learning_planned"]) is not bool:
        raise PreparationError("weight_learning_planned must be boolean")
    for name in ("training_allowed", "real_model_evaluation_allowed", "production_allowed"):
        if p[name] is not False:
            raise PreparationError(name + ": preparation grants no execution")

    lock = exact(p["source_lock"], ["formal_plan_sha256", "owner_rule_json_sha256", "owner_rule_text_sha256", "stage_contract_sha256"], "source_lock")
    if (lock["formal_plan_sha256"], lock["owner_rule_json_sha256"], lock["owner_rule_text_sha256"]) != (PLAN_SHA, RULE_JSON_SHA, RULE_TEXT_SHA):
        raise PreparationError("accepted source-lock hash drift")
    digest(lock["stage_contract_sha256"], "stage_contract_sha256", True)
    blocking = []
    if contract_raw is None or lock["stage_contract_sha256"] is None:
        blocking.append("stage_contract_exact_binding_unavailable")
    else:
        if hashlib.sha256(contract_raw).hexdigest() != lock["stage_contract_sha256"]:
            raise PreparationError("stage contract byte hash drift")
        contract = load_json(contract_raw)
        if type(contract) is not dict or contract.get("schema_version") != CONTRACT_SCHEMA:
            raise PreparationError("stage contract schema mismatch")
        admission = contract.get("development_admission", {})
        purposes = contract.get("purpose_flow", {})
        if admission.get("allowed_tiers") != ["T0", "T1"] or admission.get("blocked_until_full_m2") != ["T2", "T3", "FULL_M3_VERDICT", "QUALIFICATION_INHERITANCE", "RELEASE"]:
            raise PreparationError("stage contract admission drift")
        if (purposes.get("training_purpose"), purposes.get("non_learning_dev_purpose"), admission.get("blocked_dev_purposes")) != ("training", "development", ["qualification", "final_holdout"]):
            raise PreparationError("stage contract purpose drift")
        if admission.get("foundation_semantics") != FOUNDATION:
            raise PreparationError("parallel gate/authority forbidden")
        source = contract.get("source_lock", {})
        if (source.get("formal_plan_sha256"), source.get("owner_rule_json_sha256"), source.get("owner_rule_txt_sha256")) != (PLAN_SHA, RULE_JSON_SHA, RULE_TEXT_SHA):
            raise PreparationError("stage contract accepted source-lock drift")
        owner = contract.get("authority", {})
        if owner.get("owner_decision_id") != DECISION or type(owner.get("owner_decision_version")) is not int or owner.get("owner_decision_version") != 1 or owner.get("owner_receipt_id") != RECEIPT:
            raise PreparationError("stage contract Owner direction binding mismatch")
        milestones = purposes.get("ordered_milestones", [])
        if type(milestones) is not list or [item.get("subject") if type(item) is dict else None for item in milestones] != ["M2_REFERENCE_DETERMINISTIC_BASELINE", "M2_QUALIFICATION_AND_DATAGATE", "FULL_M3", "FINAL_PRODUCT_CANDIDATE_FREEZE", "FINAL_HOLDOUT_PRODUCT_QUALIFICATION"]:
            raise PreparationError("stage contract acceptance cycle/order mismatch")

    data = exact(p["dataset"], ["source_class", "source_ref", "source_sha256", "split_ref", "parent_boundary", "purpose_id", "content_class", "permission_proof_ref"], "dataset")
    if data["source_class"] not in ("PUBLIC_LICENSED", "OWNER_APPROVED_SYNTHETIC"):
        raise PreparationError("public license or explicit synthetic permission required")
    if data["content_class"] not in ("PUBLIC", "SYNTHETIC_PUBLIC"):
        raise PreparationError("protected48/sensitive data forbidden")
    expected_purpose = ("TRAINING", "training") if p["weight_learning_planned"] else ("DEVELOPMENT", "development")
    if (data["parent_boundary"], data["purpose_id"]) != expected_purpose:
        raise PreparationError("learning requires TRAINING; non-learning development requires DEVELOPMENT")
    for name in ("source_ref", "split_ref", "permission_proof_ref"):
        nullable_reference(data[name], "dataset." + name)
        if data[name] is None:
            blocking.append("dataset." + name)
    digest(data["source_sha256"], "dataset.source_sha256", True)
    if data["source_sha256"] is None:
        blocking.append("dataset.source_sha256")

    recipe = exact(p["recipe"], ["source_sha256", "tokenizer_sha256", "scorer_sha256", "weights_sha256"], "recipe")
    for name, value in recipe.items():
        digest(value, "recipe." + name, True)
        if value is None:
            blocking.append("recipe." + name)
    device = exact(p["device"], ["device_profile_ref", "actual_device_ref", "runner_ref"], "device")
    for name, value in device.items():
        nullable_reference(value, "device." + name)
        if value is None:
            blocking.append("device." + name)
    authority = exact(p["authority"], ["rule_decision_id", "rule_decision_version", "rule_receipt_ref", "experiment_authorization_ref", "current_claim_ref"], "authority")
    if authority["rule_decision_id"] != DECISION or type(authority["rule_decision_version"]) is not int or authority["rule_decision_version"] != 1:
        raise PreparationError("exact accepted Owner direction required")
    # This exact source Receipt is direction adoption, never effect authority.
    if authority["rule_receipt_ref"] != RECEIPT:
        raise PreparationError("Owner rule Receipt binding mismatch")
    for name in ("experiment_authorization_ref", "current_claim_ref"):
        nullable_reference(authority[name], "authority." + name)
        if authority[name] is None:
            blocking.append("authority." + name)
    window = exact(p["window"], ["not_before", "stop_at"], "window")
    start, stop = utc(window["not_before"], "window.not_before"), utc(window["stop_at"], "window.stop_at")
    if start is None or stop is None:
        blocking.append("window.actual_bounded_window")
    elif start >= stop:
        raise PreparationError("window must have ordered positive duration")
    budget = exact(p["budget"], ["max_wall_seconds", "max_compute_bytes", "max_cost_microunits", "max_steps", "max_model_calls"], "budget")
    integer(budget["max_wall_seconds"], "max_wall_seconds", 1, 1800)
    integer(budget["max_compute_bytes"], "max_compute_bytes", 1, 2147483648)
    integer(budget["max_cost_microunits"], "max_cost_microunits", 0, 0)
    integer(budget["max_steps"], "max_steps", 1, 128)
    integer(budget["max_model_calls"], "max_model_calls", 0, 0)
    if start is not None and stop is not None and (stop-start).total_seconds() < budget["max_wall_seconds"]:
        raise PreparationError("budget exceeds candidate window")
    attempts = exact(p["attempts"], ["max_attempts"], "attempts")
    integer(attempts["max_attempts"], "max_attempts", 1, 1)
    if type(p["stop_conditions"]) is not list or p["stop_conditions"] != STOPS:
        raise PreparationError("exact stop-condition set required")
    flow = exact(p["acceptance_flow"], ["m2_reference_candidate_stage", "m2_reference_purpose", "product_final_purpose", "result_consumer"], "acceptance_flow")
    if flow["m2_reference_candidate_stage"] not in ("M1_FIXED_REFERENCE", "FIXED_DETERMINISTIC_BASELINE"):
        raise PreparationError("M2 cannot depend on later M3/product candidate: dependency cycle")
    if flow["m2_reference_purpose"] != "QUALIFICATION" or flow["product_final_purpose"] != "FINAL_HOLDOUT" or flow["result_consumer"] != "DEVELOPMENT_EVIDENCE_ONLY":
        raise PreparationError("purpose cross-use, Holdout selection or qualification inheritance forbidden")
    # Even complete-looking references are caller supplied. This offline
    # consumer cannot authenticate a service receipt, device, lease or window.
    blocking += ["actual_data_permission_verification_unavailable", "actual_device_runner_verification_unavailable", "actual_experiment_authority_and_claim_verification_unavailable", "actual_window_currentness_verification_unavailable"]
    return {"status": "PREPARATION_VALIDATION", "structurally_valid_candidate": True,
            "execution_ready": False, "issued_profile": False, "actual_execution": "NONE",
            "authority_effect": "NONE", "m2_qualification": "NOT_ISSUED",
            "m3_qualification": "NOT_ISSUED", "blocking_fields": sorted(set(blocking))}


def main(argv=None):
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, default=root / "development/contracts/model-program/stage-admission/ExperimentAuthorizationProfile.T0.candidate.json")
    parser.add_argument("--contract", type=Path, default=root / "development/contracts/model-program/stage-admission/StageAdmissionSuccessor.v0.1.json")
    args = parser.parse_args(argv)
    try:
        profile = load_json(args.profile.read_bytes())
        contract_raw = args.contract.read_bytes() if args.contract.exists() else None
        result = validate_profile(profile, contract_raw)
        print(json.dumps(result, sort_keys=True))
        return 0  # structural preparation only; execution_ready remains False
    except (PreparationError, OSError) as exc:
        print(json.dumps({"status": "PREPARATION_REJECTED", "error": str(exc), "actual_execution": "NONE", "authority_effect": "NONE", "m2_qualification": "NOT_ISSUED", "m3_qualification": "NOT_ISSUED"}, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
