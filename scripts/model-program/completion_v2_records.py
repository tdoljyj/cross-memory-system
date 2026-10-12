"""Pure candidate construction from saved captures, not a runner or issuer.

build_completion_records(stdout_raw, stderr_raw, format_binding, index,
record_fields, *, schema_bundle, port_digest, observation_raw=None,
observation_validator=None, lifecycle_validator=None, output_validator=None).
record_fields has exactly result_fields, attempt_fields and capture; their exact
local keys are exported below. They are not a new PortSchema or authority.
lifecycle_validator(context_copy) returns {verified_context: same context,
outcome_consistent: True} after external verification of the claimed outcome,
including non-success timeout/cancellation mappings. Context binds request/index, attempt, captures, observation
bytes/digest and format. output_validator(candidate_copy, request_copy) returns
the externally bound pre_output_schema_validation_status string, separately
from JSON parsing. Neither callback identity nor a returned flag proves purity,
Host/currentness/qualification or rights: those remain the caller's obligation.

Only complete externally verified facts yield existing v2 record bytes. Usage
comes solely from the machine observation, never budgets/perf text/defaults.
Exit0 does not infer succeeded. Raw streams and gaps survive every refusal.
No file/network/process/model/tokenizer/store/CLI operation is performed.
"""
import copy
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json

from completion_saved_response import adapt_completion_response
from invocation_saved_projection import INDEX_FIELDS, validators, callback_digest
from saved_report_runner import canonical_sha256


RESULT_FIELDS = {"result_id", "started_at", "completed_at", "outcome", "error", "payload_ref",
                 "provider_response_id", "budget_reservation_ref", "settlement_ref",
                 "pre_output_schema_validation_status", "retention_policy", "routing_reason",
                 "response_summary", "stop_reason"}
ATTEMPT_FIELDS = {"started_at", "result_received_at", "provider_deadline", "budget_reservation_ref",
                  "attempt_ordinal", "backoff_ms", "jitter_ms", "cancel_requested_at",
                  "candidate_acceptance_eligible", "late_result", "late_result_evidence_ref",
                  "predecessor_attempt_id", "retry_not_before", "retry_trigger", "step_attempt_ref"}
CAPTURE_FIELDS = {"stdout_sha256", "stderr_sha256", "stdout_retained_bytes", "stderr_retained_bytes",
                  "stdout_complete", "stderr_complete", "stdout_truncated", "stderr_truncated",
                  "stdout_read_error", "stderr_read_error", "owned_cleanup_verified",
                  "admission_current", "after_hard_stop", "timing_tolerance_ms"}
USAGE_FIELDS = {"cost_minor_units", "currency", "currency_exponent", "currency_profile_digest",
                "input_bytes", "input_tokens", "output_bytes", "output_tokens"}
MAX_LOCAL_BYTES = 262144


def sha(raw):
    return hashlib.sha256(raw).hexdigest() if raw is not None else None


def same(a, b):
    if type(a) is not type(b):
        return False
    if type(a) is dict:
        return set(a) == set(b) and all(same(a[k], b[k]) for k in a)
    if type(a) is list:
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    return a == b


def encode(value):
    canonical_sha256(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def instant(value):
    """Compare supplied RFC3339 clocks exactly; never measure process duration."""
    stamp = value.replace("t", "T")
    if stamp.endswith(("Z", "z")):
        stamp = stamp[:-1] + "+00:00"
    fraction = ""
    if "." in stamp:
        prefix, tail = stamp.split(".", 1)
        split_at = next(i for i, char in enumerate(tail) if char in "+-")
        fraction, offset = tail[:split_at], tail[split_at:]
        stamp = prefix + offset
    point = datetime.fromisoformat(stamp).astimezone(timezone.utc)
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    delta = point - epoch
    return Decimal(delta.days * 86400 + delta.seconds) + (Decimal("0." + fraction) if fraction else 0)


def build_completion_records(stdout_raw, stderr_raw, format_binding, index, record_fields, *,
                             schema_bundle, port_digest, observation_raw=None,
                             observation_validator=None, lifecycle_validator=None,
                             output_validator=None):
    """Return saved raw evidence, gaps, and v2 result/attempt bytes orNone.

    Failure/timeout records may omit payload if all other required actual facts
    exist. Missing closure, usage or identity never becomes zero or succeeded.
    A constructed record remains candidate evidence, never live qualification.
    """
    for raw in (stdout_raw, stderr_raw, observation_raw):
        if raw is not None and type(raw) is not bytes:
            raise TypeError("captures must be original bytes or None")
    answer = {"stdout_raw": stdout_raw, "stderr_raw": stderr_raw, "observation_raw": observation_raw,
              "stdout_sha256": sha(stdout_raw), "stderr_sha256": sha(stderr_raw),
              "observation_sha256": sha(observation_raw), "adapted": None, "gaps": [],
              "result_raw": None, "attempt_raw": None, "record": None,
              "budget_breaches": [],
              "authority_effect": "NONE", "qualification": "NOT_ISSUED"}
    def gap(code):
        if code not in answer["gaps"]:
            answer["gaps"].append(code)
    try:
        check = validators(schema_bundle)
        if type(index) is not dict or set(index) != INDEX_FIELDS:
            raise ValueError("index fields")
        canonical_sha256(index)
        check["request"].validate(index["request"])
        idx = copy.deepcopy(index)
        req = idx["request"]
        if (req["training_mode"] != "none" or type(idx["id"]) is not str or not idx["id"]
                or type(idx["input_sha256"]) is not str or req["input_digest"] != "sha256:" + idx["input_sha256"]
                or callback_digest(port_digest, req) != idx["request_digest"]):
            raise ValueError("request identity")
        for projection, ref in (("binding_projection", "binding_ref"), ("subject_projection", "subject_ref"),
                                ("project_projection", "project_ref")):
            if idx[projection] != req[ref]:
                raise ValueError("request projection")
        if (type(idx["attempt_ordinal"]) is not int or not 1 <= idx["attempt_ordinal"] <=
                min(req["budgets"]["max_attempts"], req["budgets"]["max_request_count"])):
            raise ValueError("attempt ordinal")
    except Exception:
        gap("INVALID_SCHEMA_OR_REQUEST_BINDING")
        return answer
    answer["record"] = {"id": idx["id"], "result_raw": None, "attempt_raw": None, "payload_raw": None}
    if type(record_fields) is not dict or set(record_fields) != {"result_fields", "attempt_fields", "capture"}:
        gap("RECORD_FIELDS_MISSING_OR_UNKNOWN")
        return answer
    fields = copy.deepcopy(record_fields)
    try:
        canonical_sha256(fields)
        for key, keys in (("result_fields", RESULT_FIELDS), ("attempt_fields", ATTEMPT_FIELDS), ("capture", CAPTURE_FIELDS)):
            if type(fields[key]) is not dict or set(fields[key]) != keys:
                raise ValueError("missing or unknown fields")
    except Exception:
        gap("RECORD_FIELDS_MISSING_OR_UNKNOWN")
        return answer
    capture = fields["capture"]
    for stream, raw in (("stdout", stdout_raw), ("stderr", stderr_raw)):
        length = len(raw) if raw is not None else None
        if capture[stream + "_sha256"] != sha(raw) or not same(capture[stream + "_retained_bytes"], length):
            gap("CAPTURE_BYTE_IDENTITY")
        for suffix in ("_complete", "_truncated"):
            if type(capture[stream + suffix]) is not bool:
                gap("CAPTURE_CLOSURE_UNKNOWN")
        if raw is None and capture[stream + "_complete"] is True:
            gap("MISSING_CAPTURE_CANNOT_BE_COMPLETE")
        error = capture[stream + "_read_error"]
        if type(error) is not bool:
            gap("CAPTURE_READ_ERROR_INVALID")
    for key in ("owned_cleanup_verified", "admission_current", "after_hard_stop"):
        if type(capture[key]) is not bool:
            gap("LIFECYCLE_STATE_UNKNOWN")
    tolerance = capture["timing_tolerance_ms"]
    if type(tolerance) not in (int, float) or tolerance < 0 or tolerance > req["budgets"]["max_elapsed_ms"]:
        gap("TIMING_POLICY_MISSING_OR_INVALID")
    try:
        adapted = adapt_completion_response(stdout_raw, stderr_raw, format_binding,
            observation_raw=observation_raw, observation_validator=observation_validator)
        answer["adapted"] = adapted
    except Exception:
        gap("CAPTURE_ADAPTER_REFUSED")
        return answer
    observed = adapted["process_observation"]
    if observed is None or any(observed[key] is None for key in ("exit_code", "timed_out", "cancelled")):
        gap("MACHINE_OBSERVATION_OR_CLOSURE_MISSING")
    usage = adapted["usage"]
    if usage is None or any(usage.get(key) is None for key in USAGE_FIELDS):
        gap("ACTUAL_V2_USAGE_INCOMPLETE")
    context = {"index": idx, "request_digest": idx["request_digest"], "attempt_id": req["attempt_id"],
               "format_binding": adapted["format_binding"], "record_fields": fields,
               "stdout_sha256": sha(stdout_raw), "stderr_sha256": sha(stderr_raw),
               "observation_sha256": sha(observation_raw), "process_observation": observed}
    try:
        if not callable(lifecycle_validator):
            raise ValueError("missing lifecycle verifier")
        supplied = copy.deepcopy(context)
        verified = lifecycle_validator(supplied)
        canonical_sha256(verified)
        if (not same(supplied, context) or type(verified) is not dict
                or set(verified) != {"verified_context", "outcome_consistent"}
                or verified["outcome_consistent"] is not True
                or not same(verified["verified_context"], context)):
            raise ValueError("lifecycle binding or type mutation")
    except Exception:
        gap("LIFECYCLE_UNVERIFIED_OR_MUTATED")
    if answer["gaps"]:
        return answer
    extra, event = fields["result_fields"], fields["attempt_fields"]
    result = {key: copy.deepcopy(req[key]) for key in ("adapter_version", "attempt_id", "capability", "correlation_id",
        "data_classification", "input_digest", "invocation_id", "model_revision", "output_schema_digest",
        "policy_snapshot_digest", "provider_id", "provider_type", "purpose", "region", "retention_mode",
        "scope_digest", "template_hash", "training_mode")}
    result.update(copy.deepcopy(extra))
    result.update(object_type="ModelInvocationResult", schema_version="2.0", model_id=idx["model_id"],
        request_digest=idx["request_digest"], request_budget_snapshot=copy.deepcopy(req["budgets"]),
        business_receipt_boundary="SEPARATE_ID_SCHEMA_OUTCOME_AND_STORAGE",
        invocation_result_authority="PROVIDER_CALL_OUTCOME_ONLY", usage={k: copy.deepcopy(usage[k]) for k in USAGE_FIELDS},
        output_digest=None)
    for key in ("adapter_artifact_digest", "binding_projection", "project_projection", "subject_projection"):
        result[key] = copy.deepcopy(idx[key])
    attempt = {key: copy.deepcopy(req[key]) for key in ("adapter_version", "attempt_id", "idempotency_key",
                "invocation_id", "lease_hard_stop", "model_revision", "provider_id", "step_deadline")}
    attempt.update(copy.deepcopy(event))
    attempt.update(object_type="ModelInvocationAttempt", schema_version="2.0", model_id=idx["model_id"],
                   request_digest=idx["request_digest"], output_merge_policy="FORBID_CROSS_ATTEMPT_MERGE")
    try:
        if (attempt["attempt_ordinal"] != idx["attempt_ordinal"] or attempt["provider_deadline"] != req["deadline"]
                or attempt["budget_reservation_ref"] != result["budget_reservation_ref"]):
            raise ValueError("attempt identity")
        budget = req["budgets"]
        for key in ("currency", "currency_exponent", "currency_profile_digest"):
            if not same(usage[key], budget[key]):
                raise ValueError("usage currency")
        succeeded = result["outcome"] == "succeeded"
        for used, limit in (("cost_minor_units", "max_cost_minor_units"), ("input_bytes", "max_input_bytes"),
                            ("output_bytes", "max_response_bytes"), ("input_tokens", "max_input_tokens"),
                            ("output_tokens", "max_output_tokens")):
            if usage[used] > budget[limit]:
                answer["budget_breaches"].append(used)
        if answer["budget_breaches"] and (succeeded or type(result["error"]) is not dict
                or result["error"].get("code") != "MODEL_BUDGET_EXCEEDED"):
            raise ValueError("success or unmapped budget overrun")
        start, end = instant(result["started_at"]), instant(result["completed_at"])
        if (result["started_at"] != attempt["started_at"] or result["completed_at"] != attempt["result_received_at"]
                or start > end):
            raise ValueError("record time identity")
        if usage.get("elapsed_ms") is not None and abs((end - start) * 1000 - Decimal(str(usage["elapsed_ms"]))) > Decimal(str(tolerance)):
            raise ValueError("observed monotonic/wall time disagreement")
        if succeeded:
            if (observed["exit_code"] != 0 or observed["timed_out"] or observed["cancelled"]
                    or not adapted["candidate_parsed"] or not attempt["candidate_acceptance_eligible"]
                    or attempt["late_result"] or attempt["cancel_requested_at"] is not None
                    or not capture["admission_current"] or capture["after_hard_stop"]
                    or not capture["owned_cleanup_verified"]
                    or any(not capture[s + "_complete"] or capture[s + "_truncated"]
                           or capture[s + "_read_error"] for s in ("stdout", "stderr"))):
                raise ValueError("success closure")
            copies = [copy.deepcopy(adapted["parsed_candidate"]), copy.deepcopy(req)]
            before = canonical_sha256(copies)
            if not callable(output_validator):
                raise ValueError("product validator missing")
            status = output_validator(*copies)
            if (canonical_sha256(copies) != before or type(status) is not str or not status
                    or status != result["pre_output_schema_validation_status"]):
                raise ValueError("product validation")
            if (any(end > instant(t) for t in
                        (req["deadline"], req["step_deadline"], req["lease_hard_stop"], attempt["provider_deadline"]))
                    or (end - start) * 1000 > budget["max_elapsed_ms"]
                    or usage.get("elapsed_ms") is None or usage["elapsed_ms"] > budget["max_elapsed_ms"]
                    or result["payload_ref"] is None):
                raise ValueError("success time or payload evidence")
            payload = adapted["payload_raw"]
            if len(payload) > budget["max_response_bytes"]:
                raise ValueError("payload bound")
            result["output_digest"] = callback_digest(port_digest, adapted["parsed_candidate"])
        else:
            # Current saved projector requires a standard error for its supported
            # failure producer. This is compatibility, not a closed Port outcome enum.
            if attempt["candidate_acceptance_eligible"] or result["error"] is None:
                raise ValueError("failure eligible")
            # No diagnostic stream or unparsed failed bytes become a model payload.
            payload = None
            if result["payload_ref"] is not None:
                raise ValueError("missing failure payload")
        check["result"].validate(result)
        check["attempt"].validate(attempt)
        result_raw, attempt_raw = encode(result), encode(attempt)
        if len(result_raw) > MAX_LOCAL_BYTES or len(attempt_raw) > MAX_LOCAL_BYTES:
            raise ValueError("local record bound")
    except Exception:
        gap("V2_BINDING_CLOSURE_SCHEMA_OR_PRODUCT_VALIDATION_FAILED")
        return answer
    answer["result_raw"], answer["attempt_raw"] = result_raw, attempt_raw
    answer["record"].update(result_raw=result_raw, attempt_raw=attempt_raw, payload_raw=payload)
    return answer
