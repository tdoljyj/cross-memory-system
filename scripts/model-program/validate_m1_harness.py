#!/usr/bin/env python3
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[2]
M1 = ROOT / "development/contracts/model-program/m1"
HARNESS = M1 / "harness"
SCHEMAS = M1 / "schemas"
PROTOCOL = ROOT / "protocol/continuity/v1/schemas/model"
FIXTURES = ROOT / "tests/fixtures/model-program-m1-harness/fixtures.json"
HARN = ROOT / "scripts/model-program/m1_invocation_harness.py"

EXPECTED_UPSTREAM = {
    "model_invocation_request": ("protocol/continuity/v1/schemas/model/model-invocation-request.schema.json", "4fe9f38171a925497631ff4bf59f06d6aed9db2d296a31f159a7e8f9f5f5f642"),
    "model_invocation_result": ("protocol/continuity/v1/schemas/model/model-invocation-result.schema.json", "818f9eac55201fb442e45e7fd4f50b6c00b23b4c0bdea16a4a0e33023c893a1f"),
    "model_output_candidate": ("protocol/continuity/v1/schemas/model/model-output-candidate.schema.json", "69fdbe65eb86b4af54f5428c85e072df7b91adf2b33a84f5b248429444b569c5"),
    "provider_descriptor": ("protocol/continuity/v1/schemas/model/provider-descriptor.schema.json", "9fc150f7682a32799e5ca6e8439c28a0912804c16af70c034a5d080134b3f6b7"),
    "model_capability_profile": ("protocol/continuity/v1/profiles/model-capability.profile.json", "880060ef06dc497df126b265f90a0265b708ce7172a4c4225c9de926ae13b663"),
    "complete_call": ("development/contracts/model-program/m0/schemas/CompleteCall.schema.json", "511c8478a3f253286f9958af9b5a49e047efa594c3bba2bc6c72f288fb539aeb"),
}

def load(p): return json.loads(Path(p).read_text(encoding="utf-8"))
def sha_file(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def canon(v): return json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
def digest(v): return "sha256:" + hashlib.sha256((v.encode("utf-8") if isinstance(v, str) else canon(v))).hexdigest()
def fail(m): print("FAIL: " + m, file=sys.stderr); raise SystemExit(1)

def set_path(obj, path, value=None, delete=False):
    parts = path.split(".")
    cur = obj
    for part in parts[:-1]:
        cur = cur[part]
    if delete:
        del cur[parts[-1]]
    else:
        cur[parts[-1]] = value

def main():
    closeout = load(M1 / "evidence/M1ExperimentProfile003ExecutionCloseout_20260918.json")
    if closeout.get("result") != "PASS / CLUED_MODEL_M1_PROFILE_003_DOWNLOAD_AND_INTEGRITY_ACCEPTED":
        fail("M1-03 prerequisite is not PASS")

    binding = load(HARNESS / "M1InvocationHarnessBinding.v1.0.1.json")
    if binding.get("task_id") != "M1-04" or binding.get("authority_effect") != "NONE":
        fail("harness binding identity/authority invalid")
    if digest(binding["binding_identity"]) != binding["binding_identity_sha256"]:
        fail("binding identity digest drift")

    for key, (rel, expected_sha) in EXPECTED_UPSTREAM.items():
        entry = binding["upstream_contracts"][key]
        if entry["path"] != rel or entry["sha256"] != expected_sha:
            fail("upstream binding declaration drift: " + key)
        if sha_file(ROOT / rel) != expected_sha:
            fail("upstream file bytes drift: " + key)

    capability = load(ROOT / "protocol/continuity/v1/profiles/model-capability.profile.json")
    if capability.get("allowed_provider_types") != ["Test"] or capability.get("allowed_capabilities") != []:
        fail("current ModelCapabilityProfile changed; re-review real execution gate")
    if binding["real_inference_gate"]["status"] != "BLOCKED":
        fail("real inference gate must remain blocked")

    adapter = load(HARNESS / "ProviderAdapterRegistry.v1.0.1.json")
    if digest(adapter["static_qualification_identity"]) != adapter["static_qualification_identity_sha256"]:
        fail("static qualification identity digest drift")
    row = adapter["adapters"][0]
    if row["execution_allowed"] is not False or row["qualified_capabilities"] != []:
        fail("adapter execution/qualification authority expanded")
    if row["runtime_package_binding"] != "PENDING_M1_05_PACKAGE_VARIANT":
        fail("M1-05 package dependency disappeared")

    prompts = load(HARNESS / "PromptTemplateRegistry.v1.0.1.json")
    p = prompts["templates"][0]
    if digest(p["content"]) != p["template_sha256"]:
        fail("prompt template hash drift")

    policy = load(HARNESS / "InvocationPolicySnapshot.v1.0.1.json")
    if digest(policy["policy"]) != policy["policy_body_sha256"]:
        fail("policy digest drift")

    errreg = load(HARNESS / "ErrorNormalizationRegistry.v1.0.1.json")
    result_schema = load(PROTOCOL / "model-invocation-result.schema.json")
    canonical_codes = set(result_schema["$defs"]["standard_error"]["properties"]["code"]["enum"])
    mapped_codes = {v["code"] for v in errreg["mappings"].values()} | {errreg["unknown_mapping"]["code"]}
    if not mapped_codes.issubset(canonical_codes):
        fail("error normalization created non-canonical error code")

    for path in [SCHEMAS / "M1HarnessRequestEnvelope.schema.json", SCHEMAS / "M1HarnessResultEnvelope.schema.json"]:
        Draft202012Validator.check_schema(load(path))

    src = HARN.read_text(encoding="utf-8")
    for forbidden in ("subprocess", "urllib", "requests", "socket", "transformers", "torch", "llama_cpp"):
        if forbidden in src:
            fail("static harness contains execution/network primitive: " + forbidden)

    spec = importlib.util.spec_from_file_location("m1h", HARN)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    fx = load(FIXTURES)
    req = fx["positive_request"]
    res = fx["positive_result"]
    vr = m.validate_static_request_envelope(req)
    if vr["static_validation"] != "PASS" or vr["execution_ready"] is not False:
        fail("positive request static validation failed")
    if m.real_execution_readiness()["ready"] is not False:
        fail("real execution unexpectedly ready")
    if m.validate_static_result_envelope(res, req)["result_validation"] != "PASS":
        fail("positive result validation failed")

    for case in fx["negative_cases"]:
        obj = copy.deepcopy(req if case["target"] == "request" else res)
        set_path(obj, case["path"], case.get("value"), case.get("delete", False))
        for extra in case.get("additional_mutations", []):
            set_path(obj, extra["path"], extra.get("value"), extra.get("delete", False))
        try:
            if case["target"] == "request":
                m.validate_static_request_envelope(obj)
            else:
                m.validate_static_result_envelope(obj, req)
        except m.HarnessError as exc:
            if exc.code != case["expected_error"]:
                fail(f"{case['id']} expected {case['expected_error']} got {exc.code}")
        else:
            fail(case["id"] + " unexpectedly passed")

    for case in fx["error_normalization_cases"]:
        e = m.normalize_error(case["kind"], "raw provider detail that must not be exposed")
        if e["code"] != case["expected_code"] or "raw provider detail" in e["sanitized_message"]:
            fail("error normalization failed: " + case["kind"])

    print("PASS: MODEL-PROGRAM-M1 M1-04 static invocation harness is schema-bound, fail-closed, candidate-only, and real Local provider execution remains blocked")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
