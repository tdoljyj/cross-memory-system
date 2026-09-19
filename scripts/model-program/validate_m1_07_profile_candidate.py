#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
M1 = ROOT / "development/contracts/model-program/m1"
CANDIDATE = M1 / "governance/ExperimentAuthorizationProfile.M1-STAB-QWEN35-08B-PC-001.candidate.json"
ORCHESTRATOR = ROOT / "scripts/model-program/m1_runtime_stability_pc.py"

PLAN_SHA = "a918f42e6e9de160f7b14a95afafeae9022ddcc189b3663e768aa197110118a4"
MODEL_REV = "2fc06364715b967f1860aea9cf38778875588b17"
MODEL_SHA = "04b1c301231dd422b8860db31311ab2721511346a32cb1e079c4c4e5f1fe4696"
Q8_SHA = "799482186ea1c91b63bf4eb2999e034330425745496a95f0bffbfe6300a1064d"
SERVER_SHA = "085151c9dc45b6b6b74ece45207afd809e68c91e05938bb00532a24e80aaabba"
LLAMA_COMMIT = "8ed1a55efcd7424d2c592f6cbc9f97756db1d74d"
ORCH_COMMIT = "3904702a615d618a760fc8e850bf891482592a3c"
ORCH_BLOB = "41c9952526573a204382e4b2af1f262ba13dd212"
ORCH_NORMALIZED_SHA256 = "f37864adfe91bb2ec632ff2c3b17a714da9f40eb69bcf16c360d0a5144b3f7c2"

REQUIRED_PROHIBITED = {
    "EXECUTION_WHILE_PROFILE_STATUS_IS_NOT_ISSUED",
    "EXECUTION_WITH_UNBOUND_CODE_REVISION",
    "NON_LOOPBACK_BIND",
    "NON_LOOPBACK_NETWORK_ACCESS",
    "MODEL_DOWNLOAD",
    "RUNTIME_DOWNLOAD",
    "HOSTED_PROVIDER_CALL",
    "GPU_OR_DEVICE_OFFLOAD",
    "QUALITY_RANKING",
    "QUALITY_WINNER_SELECTION",
    "TEACHER_SELECTION",
    "TRAINING",
    "CONTINUED_PRETRAINING",
    "SFT",
    "DISTILLATION",
    "PREFERENCE_TRAINING",
    "LORA_OR_ADAPTER_TRAINING",
    "PRODUCTION_DEPLOYMENT",
    "PRODUCTION_TRAFFIC",
    "PROMOTION",
    "ACTIVATION",
    "M1_08_EXECUTION",
}

SCENARIOS = {
    "M1-07-PC-LOAD-001",
    "M1-07-PC-CANCEL-001",
    "M1-07-PC-BACKGROUND-001",
    "M1-07-PC-CRASH-001",
}


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def fail(message: str):
    print("FAIL: " + message, file=sys.stderr)
    raise SystemExit(1)


def normalized_text_sha256(path: Path) -> str:
    text = path.read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n")
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def exact_code_binding(profile: dict) -> bool:
    code = profile.get("code_revision") or {}
    return (
        code.get("status") == "EXACT_BOUND"
        and code.get("required_code_commit") == ORCH_COMMIT
        and code.get("required_script_git_blob_sha1") == ORCH_BLOB
        and code.get("required_script_normalized_sha256") == ORCH_NORMALIZED_SHA256
        and code.get("required_script_path") == "scripts/model-program/m1_runtime_stability_pc.py"
        and code.get("execution_allowed_while_candidate") is False
    )


def validate_candidate(profile: dict) -> tuple[bool, str]:
    if profile.get("task_id") != "M1-07":
        return False, "M1_07_TASK_ID"
    if profile.get("status") != "BLOCKED_PENDING_REVIEW_AND_FINAL_ISSUANCE":
        return False, "M1_07_CANDIDATE_STATUS"
    if profile.get("effectful_authority_issued") is not False or profile.get("authority_effect") != "NONE / PROFILE_PREPARATION_ONLY":
        return False, "M1_07_AUTHORITY_EXPANSION"

    if profile.get("model_program_revision", {}).get("plan_sha256") != PLAN_SHA:
        return False, "M1_07_PLAN_BINDING"
    model = profile.get("exact_model_ids_and_revisions") or {}
    if model.get("upstream_revision") != MODEL_REV or model.get("upstream_weight_sha256") != MODEL_SHA:
        return False, "M1_07_MODEL_LINEAGE"
    subject = model.get("stability_subject") or {}
    if subject.get("variant_id") != "q8_0" or subject.get("sha256") != Q8_SHA or subject.get("bytes") != 833592320:
        return False, "M1_07_STABILITY_SUBJECT"
    if "NOT_QUALITY_WINNER" not in subject.get("selection_semantics", ""):
        return False, "M1_07_QUALITY_SELECTION_LEAK"

    runtime = profile.get("runtime_and_device_profile") or {}
    if runtime.get("device_name") != "DESK-W-591" or runtime.get("binding_state") != "EXACT_BOUND":
        return False, "M1_07_DEVICE_BINDING"
    if runtime.get("runtime_commit") != LLAMA_COMMIT or runtime.get("server_executable_sha256") != SERVER_SHA:
        return False, "M1_07_RUNTIME_BINDING"

    config = (profile.get("config_revision") or {}).get("server") or {}
    if config.get("host") != "127.0.0.1" or config.get("external_bind") is not False or config.get("external_network") is not False:
        return False, "M1_07_LOOPBACK_BOUNDARY"
    if config.get("offline") is not True or config.get("webui") is not False:
        return False, "M1_07_NETWORK_UI_BOUNDARY"
    if config.get("n_gpu_layers") != 0 or config.get("device") != "none" or config.get("op_offload") is not False:
        return False, "M1_07_CPU_ONLY_BOUNDARY"
    if config.get("threads") != 2 or config.get("threads_batch") != 2 or config.get("parallel") != 1:
        return False, "M1_07_COMPUTE_BOUNDARY"

    scenarios = profile.get("scenario_contract") or []
    if {x.get("scenario_id") for x in scenarios} != SCENARIOS:
        return False, "M1_07_SCENARIO_SET"
    bg = next((x for x in scenarios if x.get("scenario_id") == "M1-07-PC-BACKGROUND-001"), {})
    if bg.get("semantics") != "PC_BACKGROUND_SERVICE_CONTINUITY_ONLY / NOT_MOBILE_APP_BACKGROUND_RESUME":
        return False, "M1_07_BACKGROUND_SCOPE"
    if "NO_CLAIM_ABOUT_PHONE_TABLET_APP_BACKGROUND_RESUME" not in set(bg.get("pass_criteria") or []):
        return False, "M1_07_BACKGROUND_SCOPE"

    prohibited = set(profile.get("prohibited_operations") or [])
    if not REQUIRED_PROHIBITED.issubset(prohibited):
        return False, "M1_07_PROHIBITED_BOUNDARY"

    if profile.get("max_attempts") != 1 or profile.get("max_wall_time") != 1800 or profile.get("max_storage") != 134217728:
        return False, "M1_07_BUDGET"
    compute = profile.get("max_compute") or {}
    if compute.get("cpu_threads") != 2 or compute.get("gpu_layers") != 0 or compute.get("max_parallel_server_processes") != 1:
        return False, "M1_07_COMPUTE_BUDGET"

    if not exact_code_binding(profile):
        return False, "M1_07_CODE_BINDING"
    if not ORCHESTRATOR.is_file() or normalized_text_sha256(ORCHESTRATOR) != ORCH_NORMALIZED_SHA256:
        return False, "M1_07_ORCHESTRATOR_BYTES_DRIFT"
    if (profile.get("code_revision") or {}).get("orchestrator_default_mode") != "VALIDATE_ONLY / NO SERVER START / NO MODEL LOAD":
        return False, "M1_07_ORCHESTRATOR_DEFAULT_MODE"

    if profile.get("expiry") != "TO_BE_BOUND_AT_FINAL_ISSUANCE":
        return False, "M1_07_EXPIRY_PREMATURE"
    if profile.get("owner_final_execution_authorization") is not None:
        return False, "M1_07_OWNER_AUTH_PREMATURE"
    if "NO_M1_08_AUTHORITY" not in profile.get("release_ceiling", ""):
        return False, "M1_07_RELEASE_CEILING"
    requirements = set(profile.get("final_issuance_requirements") or [])
    for required in (
        "STATIC_REVIEW_OR_TESTS_CONFIRM_PROFILE_STATUS_GUARD_AND_PID_OWNERSHIP_GUARD",
        "OWNER_EXPLICIT_M1_07_EFFECTFUL_EXECUTION_AUTHORIZATION",
        "BIND_FINAL_EXPIRY",
        "CREATE_ISSUED_SUCCESSOR_PROFILE_WITH_STATUS_ISSUED",
    ):
        if required not in requirements:
            return False, "M1_07_FINAL_ISSUANCE_REQUIREMENTS"
    return True, "PASS"


def execution_readiness(profile: dict) -> tuple[bool, str]:
    if profile.get("status") != "ISSUED":
        return False, "PROFILE_NOT_ISSUED"
    if profile.get("effectful_authority_issued") is not True:
        return False, "EFFECTFUL_AUTHORITY_NOT_ISSUED"
    if not exact_code_binding(profile):
        return False, "EXECUTION_CODE_BINDING_INVALID"
    auth = profile.get("owner_final_execution_authorization") or {}
    if auth.get("present") is not True or not auth.get("owner_message"):
        return False, "OWNER_FINAL_EXECUTION_AUTHORIZATION_MISSING"
    if profile.get("expiry") in (None, "", "TO_BE_BOUND_AT_FINAL_ISSUANCE"):
        return False, "EXPIRY_UNRESOLVED"
    if profile.get("authority_effect") != "M1-07_PC_RUNTIME_STABILITY_EXECUTION_ONLY":
        return False, "M1_07_AUTHORITY_EFFECT"
    return True, "READY"


def main():
    stage = load(M1 / "governance/M1StageEntryAuthorization.v1.0.2.json")
    p7 = (stage.get("progression_policy") or {}).get("m1_07") or {}
    if p7.get("gate_satisfied") is not True:
        fail("M1-07 progression gate is not satisfied")
    if p7.get("effectful_execution_authorized_by_stage_successor") is not False:
        fail("stage successor unexpectedly grants M1-07 execution")
    if p7.get("exact_experiment_profile_still_required") is not True:
        fail("M1-07 exact profile gate missing")

    evidence = load(M1 / "evidence/DeviceBenchmarkEvidence.PC.DESK-W-591.v1.0.1.json")
    if (evidence.get("conclusions") or {}).get("pc_strict_cpu_baseline_evidence_complete") is not True:
        fail("M1-06A PC evidence prerequisite missing")
    if (evidence.get("conclusions") or {}).get("full_m1_06_closed") is not False:
        fail("M1-06 was incorrectly fully closed")

    matrix = load(M1 / "package/PackageVariantMatrix.v1.0.2.json")
    variants = {x["variant_id"]: x for x in matrix.get("variants", [])}
    q8 = variants.get("q8_0") or {}
    if q8.get("sha256") != Q8_SHA or q8.get("bytes") != 833592320:
        fail("Q8_0 package binding drift")
    if q8.get("quality_status") != "NOT_EVALUATED":
        fail("M1-07 candidate must not rely on a quality-selected Q8_0")

    candidate = load(CANDIDATE)
    good, code = validate_candidate(candidate)
    if not good:
        fail(code)
    ready, reason = execution_readiness(candidate)
    if ready or reason != "PROFILE_NOT_ISSUED":
        fail("candidate must remain fail-closed for execution")

    print("PASS: M1-07 PC runtime-stability candidate is exact-bound to model/runtime/device/config/scenarios and orchestrator code, while review/Owner final issuance remain unresolved and effectful execution is fail-closed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
