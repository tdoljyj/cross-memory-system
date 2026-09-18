#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[2]
M1 = ROOT / "development/contracts/model-program/m1"
HARNESS = M1 / "harness"
SCHEMAS = M1 / "schemas"
PROTOCOL = ROOT / "protocol/continuity/v1/schemas/model"

class HarnessError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message

def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))

def canonical_bytes(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")

def digest_value(value) -> str:
    if isinstance(value, str):
        data = value.encode("utf-8")
    else:
        data = canonical_bytes(value)
    return "sha256:" + hashlib.sha256(data).hexdigest()

def schema_validate(schema: dict, value, code="CLUED_MODEL_M1_HARNESS_SCHEMA_VALIDATION") -> None:
    try:
        Draft202012Validator(schema, format_checker=FormatChecker()).validate(value)
    except Exception as exc:
        raise HarnessError(code, str(exc)) from exc

def _registry():
    return load(HARNESS / "ProviderAdapterRegistry.v1.0.1.json")

def _policy():
    return load(HARNESS / "InvocationPolicySnapshot.v1.0.1.json")

def _prompt():
    return load(HARNESS / "PromptTemplateRegistry.v1.0.1.json")

def _binding():
    return load(HARNESS / "M1InvocationHarnessBinding.v1.0.1.json")

def _error_registry():
    return load(HARNESS / "ErrorNormalizationRegistry.v1.0.1.json")

def find_adapter(adapter_id: str) -> dict:
    for row in _registry()["adapters"]:
        if row["adapter_id"] == adapter_id:
            return row
    raise HarnessError("CLUED_MODEL_M1_HARNESS_UNKNOWN_ADAPTER", "unknown adapter")

def validate_static_request_envelope(envelope: dict) -> dict:
    schema_validate(load(SCHEMAS / "M1HarnessRequestEnvelope.schema.json"), envelope)
    schema_validate(load(PROTOCOL / "model-invocation-request.schema.json"), envelope["request"])

    req = envelope["request"]
    adapter = find_adapter(envelope["adapter_id"])
    binding = _binding()
    policy = _policy()
    prompt = _prompt()["templates"][0]
    registry = _registry()

    if req["provider_id"] != adapter["provider_id"] or req["provider_type"] != adapter["provider_type"]:
        raise HarnessError("CLUED_MODEL_M1_HARNESS_PROVIDER_BINDING_DRIFT", "provider binding drift")
    if req["model_revision"] != adapter["model_revision"]:
        raise HarnessError("CLUED_MODEL_M1_HARNESS_MODEL_REVISION_DRIFT", "model revision drift")
    if req["adapter_version"] != adapter["adapter_version"]:
        raise HarnessError("CLUED_MODEL_M1_HARNESS_ADAPTER_VERSION_DRIFT", "adapter version drift")
    if req["training_mode"] != policy["policy"]["required_training_mode"]:
        raise HarnessError("CLUED_MODEL_M1_HARNESS_TRAINING_FORBIDDEN", "training mode is not allowed")
    if req["data_classification"] not in policy["policy"]["allowed_data_classifications"]:
        raise HarnessError("CLUED_MODEL_M1_HARNESS_DATA_CLASSIFICATION_BLOCKED", "data classification blocked")
    if req["binding_ref"] != binding["binding_identity_sha256"]:
        raise HarnessError("CLUED_MODEL_M1_HARNESS_BINDING_DRIFT", "binding ref drift")
    if req["provider_qualification_ref"] != registry["static_qualification_identity_sha256"]:
        raise HarnessError("CLUED_MODEL_M1_HARNESS_QUALIFICATION_BINDING_DRIFT", "static qualification binding drift")
    if req["template_hash"] != prompt["template_sha256"]:
        raise HarnessError("CLUED_MODEL_M1_HARNESS_TEMPLATE_DRIFT", "template hash drift")
    if req["policy_snapshot_digest"] != policy["policy_body_sha256"]:
        raise HarnessError("CLUED_MODEL_M1_HARNESS_POLICY_DRIFT", "policy digest drift")

    Draft202012Validator.check_schema(envelope["output_schema"])
    if req["output_schema_digest"] != digest_value(envelope["output_schema"]):
        raise HarnessError("CLUED_MODEL_M1_HARNESS_OUTPUT_SCHEMA_DRIFT", "output schema digest drift")
    if req["input_digest"] != digest_value(envelope["input_payload"]["text"]):
        raise HarnessError("CLUED_MODEL_M1_HARNESS_INPUT_DIGEST_DRIFT", "input digest drift")
    if req["budgets"]["max_cost_minor_units"] != 0 or req["budgets"]["max_attempts"] != 1:
        raise HarnessError("CLUED_MODEL_M1_HARNESS_BUDGET_POLICY", "static harness budget must remain zero-cost and one-attempt")

    return {
        "static_validation": "PASS",
        "execution_ready": False,
        "execution_blockers": list(adapter["execution_blockers"]),
        "authority_effect": "NONE",
    }

def validate_static_result_envelope(envelope: dict, request_envelope: dict) -> dict:
    schema_validate(load(SCHEMAS / "M1HarnessResultEnvelope.schema.json"), envelope)
    result = envelope["result"]
    schema_validate(load(PROTOCOL / "model-invocation-result.schema.json"), result)

    req = request_envelope["request"]
    if result["request_digest"] != digest_value(req):
        raise HarnessError("CLUED_MODEL_M1_HARNESS_REQUEST_DIGEST_DRIFT", "request digest drift")
    if result["input_digest"] != req["input_digest"]:
        raise HarnessError("CLUED_MODEL_M1_HARNESS_INPUT_DIGEST_DRIFT", "result input digest drift")
    if result["output_schema_digest"] != req["output_schema_digest"]:
        raise HarnessError("CLUED_MODEL_M1_HARNESS_OUTPUT_SCHEMA_DRIFT", "result output schema digest drift")
    if result["provider_id"] != req["provider_id"] or result["model_revision"] != req["model_revision"]:
        raise HarnessError("CLUED_MODEL_M1_HARNESS_PROVIDER_BINDING_DRIFT", "result provider/model binding drift")

    if result["outcome"] == "succeeded":
        if envelope["output_payload"] is None or envelope["candidate"] is None:
            raise HarnessError("CLUED_MODEL_M1_HARNESS_OUTPUT_INVALID", "successful result requires payload and candidate")
        try:
            Draft202012Validator(request_envelope["output_schema"], format_checker=FormatChecker()).validate(envelope["output_payload"])
        except Exception as exc:
            raise HarnessError("CLUED_MODEL_M1_HARNESS_OUTPUT_INVALID", str(exc)) from exc
        if result["output_digest"] != digest_value(envelope["output_payload"]):
            raise HarnessError("CLUED_MODEL_M1_HARNESS_OUTPUT_DIGEST_DRIFT", "output digest drift")
        candidate = envelope["candidate"]
        schema_validate(load(PROTOCOL / "model-output-candidate.schema.json"), candidate)
        if candidate["output_digest"] != result["output_digest"] or candidate["invocation_result_digest"] != digest_value(result):
            raise HarnessError("CLUED_MODEL_M1_HARNESS_CANDIDATE_BINDING_DRIFT", "candidate/result binding drift")
        if candidate["authority"] != "NON_AUTHORITATIVE_CANDIDATE" or candidate["canonical_status"] != "NOT_CANONICAL":
            raise HarnessError("CLUED_MODEL_M1_HARNESS_CANDIDATE_AUTHORITY", "candidate attempted authority expansion")
    else:
        if result["error"] is None or envelope["output_payload"] is not None or envelope["candidate"] is not None:
            raise HarnessError("CLUED_MODEL_M1_HARNESS_RESULT_SEMANTICS", "failed result semantics invalid")

    return {"result_validation": "PASS", "authority_effect": "NONE"}

def normalize_error(kind: str, raw_detail: str) -> dict:
    reg = _error_registry()
    row = reg["mappings"].get(kind, reg["unknown_mapping"])
    return {
        "code": row["code"],
        "details_digest": digest_value(raw_detail),
        "provider_status": None,
        "retryable": row["retryable"],
        "sanitized_message": row["sanitized_message"],
    }

def real_execution_readiness() -> dict:
    b = _binding()
    gate = b["real_inference_gate"]
    return {
        "ready": gate["status"] == "READY",
        "status": gate["status"],
        "required_before_real_model_call": deepcopy(gate["required_before_real_model_call"]),
        "blockers": deepcopy(gate["current_blockers"]),
    }
