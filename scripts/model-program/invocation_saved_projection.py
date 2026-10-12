"""Pure local projection of supplied v2 records, never an invocation or issuer.

project_saved_snapshot(request_index, records, split, *, schema_bundle,
status_selector, status_policy, port_digest) preserves every registered slot.
Index rows carry id,input_sha256,split_id,request,request_digest,model_id,
adapter_artifact_digest,binding_projection,project_projection,subject_projection,
attempt_ordinal. Records carry id,result_raw,attempt_raw,payload_raw (bytes|None).
Schemas are the exact existing request/result/attempt v2 bytes. The full split
and pure callbacks are verified by the caller; local SHA equality grants nothing.
The selector maps copied result/attempt objects to a pre-frozen local status key.
port_digest uses the producer's already bound digest convention, not raw SHA.

Incomplete or nonconforming slots retain original bytes and diagnostics, and
snapshot stays None. Valid failures may have raw_output=None. No missing usage,
Gold, probability, latency, cost or permission is fabricated. A complete snapshot
is a saved-record carrier, not output validation, candidate acceptance or M2.
No file/network/process/model/store/CLI operation is provided.
"""
import copy
import hashlib
import re

from jsonschema import Draft202012Validator, FormatChecker
from development_input_renderer import date_time_format
from saved_output_metrics import CATEGORIES
from saved_report_runner import (SPLIT_FIELDS, PURPOSE_IDS, canonical_sha256,
                                 snapshot_metadata, snapshot_digest)
from validate_m2_scoped_successor import strict_json


SCHEMA_PINS = {
    "request": "4fe9f38171a925497631ff4bf59f06d6aed9db2d296a31f159a7e8f9f5f5f642",
    "result": "818f9eac55201fb442e45e7fd4f50b6c00b23b4c0bdea16a4a0e33023c893a1f",
    "attempt": "9c7fe6dc0538b84fd680704594f3c8ef31266780804954ffb2b38860185c9aa8"}
INDEX_FIELDS = {"id", "input_sha256", "split_id", "request", "request_digest",
                "model_id", "adapter_artifact_digest", "binding_projection",
                "project_projection", "subject_projection", "attempt_ordinal"}
RECORD_FIELDS = {"id", "result_raw", "attempt_raw", "payload_raw"}
MAX_SLOTS, MAX_RAW_BYTES = 168, 262144  # Local allocation bounds, not a Port limit.
SHA = re.compile(r"[0-9a-f]{64}\Z")
PORT_SHA = re.compile(r"sha256:[0-9a-f]{64}\Z")


def require(condition, code):
    if not condition:
        raise ValueError("SAVED_PROJECTION_" + code)


def text(value):
    require(type(value) is str and bool(value), "TEXT")
    value.encode("utf-8", errors="strict")
    return value


def raw_sha(value):
    return hashlib.sha256(value).hexdigest() if value is not None else None


def parsed(raw):
    require(type(raw) is bytes and len(raw) <= MAX_RAW_BYTES, "RAW_BOUND")
    value = strict_json(raw)
    canonical_sha256(value)  # Also rejects finite-looking JSON exponent overflow.
    return value


def validators(bundle):
    require(type(bundle) is dict and set(bundle) == set(SCHEMA_PINS), "SCHEMA_BUNDLE")
    checker = FormatChecker(formats=())
    checker.checks("date-time")(date_time_format)
    result = {}
    for role, pin in SCHEMA_PINS.items():
        raw = bundle[role]
        require(type(raw) is bytes and raw_sha(raw) == pin, "SCHEMA_PIN")
        schema = parsed(raw)
        Draft202012Validator.check_schema(schema)
        result[role] = Draft202012Validator(schema, format_checker=checker)
    return result


def callback_digest(callback, value):
    frozen = copy.deepcopy(value)
    before = canonical_sha256(frozen)
    answer = callback(frozen)
    require(canonical_sha256(frozen) == before, "DIGEST_CALLBACK_MUTATION")
    require(type(answer) is str and PORT_SHA.fullmatch(answer), "PORT_DIGEST")
    return answer


def gap(slot, code):
    if code not in slot["gaps"]:
        slot["gaps"].append(code)


def read_record(slot, key, validator):
    raw = slot["original_bytes"][key + "_raw"]
    if raw is None:
        gap(slot, "MISSING_" + key.upper())
        return None
    try:
        value = parsed(raw)
        validator.validate(value)
        return value
    except (ValueError, TypeError, UnicodeError, OverflowError):
        gap(slot, "INVALID_" + key.upper())
    except Exception:
        # ValidationError/provider text is never copied into local diagnostics.
        gap(slot, "INVALID_" + key.upper())
    return None


def bind(slot, index, result, attempt, digest):
    request = index["request"]
    expected_digest = callback_digest(digest, request)
    checks = [(index["request_digest"] == expected_digest, "REQUEST_DIGEST")]
    for value in (result, attempt):
        for key in ("invocation_id", "attempt_id", "provider_id", "model_revision", "adapter_version"):
            checks.append((value[key] == request[key], "IDENTITY_" + key.upper()))
        checks.append((value["request_digest"] == expected_digest, "REQUEST_DIGEST"))
        checks.append((value["model_id"] == index["model_id"], "MODEL_ID"))
    checks.extend([
        (request["input_digest"] == "sha256:" + index["input_sha256"], "INPUT_DIGEST"),
        (result["request_budget_snapshot"] == request["budgets"], "BUDGET_SNAPSHOT"),
        (result["budget_reservation_ref"] == attempt["budget_reservation_ref"], "RESERVATION"),
        (attempt["idempotency_key"] == request["idempotency_key"], "IDEMPOTENCY"),
        (attempt["lease_hard_stop"] == request["lease_hard_stop"], "LEASE"),
        (attempt["step_deadline"] == request["step_deadline"], "STEP_DEADLINE"),
        (attempt["provider_deadline"] == request["deadline"], "PROVIDER_DEADLINE"),
        (attempt["attempt_ordinal"] == index["attempt_ordinal"] and
         attempt["attempt_ordinal"] <= request["budgets"]["max_attempts"], "ATTEMPT_ORDINAL"),
        (attempt["predecessor_attempt_id"] != attempt["attempt_id"], "SELF_PREDECESSOR")])
    for key in ("adapter_artifact_digest", "binding_projection", "project_projection", "subject_projection"):
        checks.append((result[key] == index[key], key.upper()))
    for key in ("input_digest", "output_schema_digest", "capability", "purpose", "provider_type",
                "data_classification", "region", "retention_mode", "training_mode", "scope_digest",
                "policy_snapshot_digest", "template_hash", "correlation_id"):
        checks.append((result[key] == request[key], "CONFIG_" + key.upper()))
    for key in ("currency", "currency_exponent", "currency_profile_digest"):
        checks.append((result["usage"][key] == request["budgets"][key], "USAGE_" + key.upper()))
    for ok, code in checks:
        if not ok:
            gap(slot, code)


def project_saved_snapshot(request_index, records, split, *, schema_bundle,
                           status_selector, status_policy, port_digest):
    """Return all slots and complete six-field rows orNone; no automatic acceptance.

    This candidate binds provider_deadline directly to request.deadline. A future
    different producer derivation needs its adopted binding, not a guessed value.
    No currentness or model/data authority is inferred from these local arguments.
    """
    require(callable(status_selector) and callable(port_digest), "CALLBACK")
    require(type(status_policy) is dict and all(type(k) is str and k and type(v) is str and v in CATEGORIES
            for k, v in status_policy.items()), "STATUS_POLICY")
    canonical_sha256(status_policy)
    validate = validators(schema_bundle)
    require(type(request_index) is list and len(request_index) <= MAX_SLOTS, "INDEX_BOUND")
    require(type(records) is list and len(records) <= MAX_SLOTS, "RECORD_BOUND")
    require(type(split) is dict and SPLIT_FIELDS <= set(split), "SPLIT_FIELDS")
    canonical_sha256(split)
    text(split["split_id"])
    require(split["purpose_id"] in PURPOSE_IDS and type(split["final_holdout"]) is bool and
            split["final_holdout"] == (split["purpose_id"] == "final_holdout"), "SPLIT_PURPOSE")
    indexed, supplied = {}, {}
    for row in request_index:
        require(type(row) is dict and set(row) == INDEX_FIELDS, "INDEX_FIELDS")
        key = text(row["id"])
        require(key not in indexed, "DUPLICATE_INDEX")
        require(type(row["input_sha256"]) is str and SHA.fullmatch(row["input_sha256"]), "INPUT_SHA")
        require(row["split_id"] == split["split_id"], "CROSS_SPLIT")
        indexed[key] = copy.deepcopy(row)
    if "sample_ids" in split:
        ids = split["sample_ids"]
        require(type(ids) is list and all(type(i) is str and i for i in ids) and
                len(set(ids)) == len(ids) and set(ids) == set(indexed), "SPLIT_COVERAGE")
    for row in records:
        require(type(row) is dict and set(row) == RECORD_FIELDS, "RECORD_FIELDS")
        key = text(row["id"])
        require(key in indexed and key not in supplied, "RECORD_COVERAGE")
        require(all(row[k] is None or (type(row[k]) is bytes and len(row[k]) <= MAX_RAW_BYTES)
                    for k in RECORD_FIELDS - {"id"}), "RECORD_BYTES")
        supplied[key] = copy.deepcopy(row)
    slots, snapshot, units = [], [], {}
    for key, index in indexed.items():
        original = supplied.get(key, {"id": key, "result_raw": None, "attempt_raw": None, "payload_raw": None})
        slot = {"id": key, "index": index, "original_bytes": original,
                "raw_sha256": {k: raw_sha(original[k]) for k in RECORD_FIELDS - {"id"}},
                "result": None, "attempt": None, "terminal_status": None, "usage": None, "gaps": []}
        slots.append(slot)
        result = read_record(slot, "result", validate["result"])
        attempt = read_record(slot, "attempt", validate["attempt"])
        slot["result"], slot["attempt"] = result, attempt
        try:
            canonical_sha256(index)
            validate["request"].validate(index["request"])
            require(index["request"]["purpose"] == split["purpose_id"], "REQUEST_PURPOSE")
            require(index["request"]["training_mode"] == "none", "TRAINING_SCOPE")
            require(type(index["attempt_ordinal"]) is int and index["attempt_ordinal"] >= 1, "INDEX_ORDINAL")
            require(type(index["request_digest"]) is str and PORT_SHA.fullmatch(index["request_digest"]), "INDEX_DIGEST")
            text(index["model_id"])
            for field in ("adapter_artifact_digest", "binding_projection", "project_projection", "subject_projection"):
                require(type(index[field]) is str and PORT_SHA.fullmatch(index[field]), "INDEX_PROJECTION")
        except Exception:
            gap(slot, "INVALID_REQUEST_BINDING")
        if result is None or attempt is None or slot["gaps"]:
            continue
        slot["usage"] = copy.deepcopy(result["usage"])
        try:
            bind(slot, index, result, attempt, port_digest)
            payload = original["payload_raw"]
            if payload is not None:
                require(len(payload) <= index["request"]["budgets"]["max_response_bytes"], "PAYLOAD_BOUND")
                value = parsed(payload)
                require(callback_digest(port_digest, value) == result["output_digest"], "OUTPUT_DIGEST")
            if result["outcome"] == "succeeded":
                if payload is None or result["payload_ref"] is None:
                    gap(slot, "MISSING_SUCCESS_PAYLOAD")
                if not attempt["candidate_acceptance_eligible"] or attempt["late_result"] or attempt["cancel_requested_at"] is not None:
                    gap(slot, "SUCCESS_NOT_ACCEPTANCE_ELIGIBLE")
            elif result["error"] is None:
                gap(slot, "UNKNOWN_OUTCOME_WITHOUT_ERROR")
            if not slot["gaps"]:
                copies = copy.deepcopy([result, attempt])
                seal = canonical_sha256(copies)
                status = status_selector(*copies)
                require(canonical_sha256(copies) == seal, "STATUS_CALLBACK_MUTATION")
                require(type(status) is str and status in status_policy, "UNMAPPED_STATUS")
                category = status_policy[status]
                require(category != "SUCCEEDED" or result["outcome"] == "succeeded", "FALSE_SUCCESS")
                slot["terminal_status"] = status
        except Exception:
            gap(slot, "INVALID_PAYLOAD_OR_STATUS_BINDING")
        unit = (result["usage"]["currency_exponent"], result["usage"]["currency_profile_digest"])
        currency = result["usage"]["currency"]
        if currency in units and units[currency] != unit:
            for affected in slots:
                if affected["usage"] is not None and affected["usage"]["currency"] == currency:
                    gap(affected, "CURRENCY_UNIT_DRIFT")
        else:
            units[currency] = unit
        if not slot["gaps"]:
            snapshot.append({"id": key, "input_sha256": index["input_sha256"], "raw_output": original["payload_raw"],
                             "terminal_status": slot["terminal_status"], "usage": copy.deepcopy(slot["usage"]), "split_id": split["split_id"]})
    for slot in slots:
        if slot["gaps"]:
            slot["terminal_status"] = None
    complete = all(not slot["gaps"] for slot in slots)
    result_snapshot = snapshot if complete else None
    return {"slots": slots, "snapshot": result_snapshot,
            "snapshot_metadata": snapshot_metadata(snapshot) if complete else None,
            "snapshot_sha256": snapshot_digest(snapshot) if complete else None,
            "split_sha256": canonical_sha256(split), "authority_effect": "NONE", "qualification": "NOT_ISSUED"}
