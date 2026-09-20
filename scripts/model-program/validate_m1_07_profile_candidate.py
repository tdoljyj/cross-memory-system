#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
M1 = ROOT / "development/contracts/model-program/m1"
CANDIDATE = M1 / "governance/ExperimentAuthorizationProfile.M1-STAB-QWEN35-08B-PC-001.owner-root-pinned.candidate.json"
ORCHESTRATOR = ROOT / "scripts/model-program/m1_runtime_stability_pc.py"
BINDING = ROOT / "scripts/model-program/m1_runtime_stability_binding.py"
BUILD_HELPER = ROOT / "scripts/model-program/build_m1_07_native_owner.py"

PLAN_SHA = "a918f42e6e9de160f7b14a95afafeae9022ddcc189b3663e768aa197110118a4"
MODEL_REV = "2fc06364715b967f1860aea9cf38778875588b17"
MODEL_SHA = "04b1c301231dd422b8860db31311ab2721511346a32cb1e079c4c4e5f1fe4696"
Q8_SHA = "799482186ea1c91b63bf4eb2999e034330425745496a95f0bffbfe6300a1064d"
SERVER_SHA = "085151c9dc45b6b6b74ece45207afd809e68c91e05938bb00532a24e80aaabba"
RUNTIME_ASSET_NAME = "llama-b11033-bin-win-vulkan-x64.zip"
RUNTIME_ASSET_BYTES = 31766410
RUNTIME_ASSET_SHA256 = "8ca91d4621fcac8799245f01a6467e9c09eba7b8d3be161a382048dc5c839db2"
RUNTIME_DIR = r"C:\Users\Public\Clued\ModelProgram\M1\packages\Qwen_Qwen3.5-0.8B\m1pkg002\runtime\b11033-vulkan"
RUNTIME_TREE_SEMANTICS = "EXACT_RELEASE_ZIP_AND_EXTRACTED_TREE_MATCH / NO_EXTRA_MISSING_OR_MUTATED_FILES"
CONFIG_SOURCES = "SIGNED_ARGV_ONLY / CHILD_ENV_ALLOWLIST / NO_LLAMA_ARG / NO_PROGRAMDATA_APPDATA_CONFIG"
LLAMA_COMMIT = "8ed1a55efcd7424d2c592f6cbc9f97756db1d74d"
ORCH_COMMIT = '9aa75f272d6bf9007db036479d8e01bc088e0912'
ORCH_BLOB = '7389eed2d7cfd722c78db63d024ae84668eb760e'
ORCH_NORMALIZED_SHA256 = 'd21414bbb7f206426ccb66c799dfbcd3753391910a357b4489a2a93dc231e4af'
BINDING_BLOB = '13620a3fceba05edd35cb3f167eaa5c4c40050ba'
OWNER_BOUNDARY = ROOT / "scripts/model-program/m1_runtime_stability_owner_boundary.py"
OWNER_BOUNDARY_BLOB = '7a6bf6017ba233e474fe72e499e67a3e5581e16a'
OWNER_BOUNDARY_SHA256 = '35fea706a095a2cba6e3e31377e56c2246e890dfce751d1b038185e8b58a41b7'
ISSUED_PROFILE_ID = "M1-STAB-QWEN35-08B-PC-001-ISSUED"
MACHINE_IDENTITY_SHA256 = "00b300c3b04e170bc097ac0a69cf39378a61f1bdd3ca15a970e55f2119b65522"
ATTEMPT_GUARD_PATH = r"C:\Users\Public\Clued\ModelProgram\M1\runtime-state\M1-STAB-QWEN35-08B-PC-001\M1RuntimeStabilityAttemptGuard.json"
OWNER_PUBLIC_KEY_HEX = "a683b21e2d838f0773fc1251e6d0165c4b15ad2b2994cabf4290edff1c24eb03"
OWNER_PUBLIC_KEY_SHA256 = "7d8a39adb80276686ff052b65e074a8ea9e74f7eccbc44f4340b194fec342f9c"
NATIVE_BUILD_TOOLCHAIN = {
    "archive_name": "go1.27.1.windows-amd64.zip",
    "archive_bytes": 78931360,
    "archive_sha256": "a3911b5e0e1b1053f25ed0675f4c1c6aad1e2bfcf253df2b9be4caabd2edd95d",
    "tree_file_count": 15639,
    "tree_sha256": "bf7939c5c947597c3a2bbf56b7ddf943fa06cd10cae421eadc01d44f18a5df79",
    "go_exe_sha256": "d3ccdb604eafa6031133aefe1a3db24f0bb7362b857bc2125ac4e4c178b4b490",
    "compile_exe_sha256": "69294d68bcaa3e786f80d23bfb8bed807d5d969e931d5bf92161bdf518778a01",
    "link_exe_sha256": "9146582fd2b0a8cf765831e7ee3127603faaf51697531496584024db96414720",
    "version": "go version go1.27.1 windows/amd64",
    "target": {"goos": "windows", "goarch": "amd64", "goamd64": "v1"},
    "semantics": "EXACT_OFFICIAL_ZIP / FRESH_SAFE_EXTRACTION / EXTRACTED_TREE_EXACT_MATCH / NO_CALLER_EXECUTABLE",
}

REQUIRED_MODEL_SEMANTICS = {
    "STABILITY_REFERENCE_ONLY",
    "CONTINUITY_SUBJECT",
    "NOT_QUALITY_WINNER",
    "NOT_RELEASE_SELECTION",
    "NOT_TEACHER_SELECTION",
}
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
REQUIRED_EVIDENCE = {
    "PROCESS_RSS_SAMPLES",
    "PROCESS_RSS_SAMPLES_PER_SERVER_START",
    "OWNER_FINAL_EXECUTION_AUTHORIZATION_ID_AND_SHA256",
    "ATTEMPT_GUARD_PATH_AND_CLAIM_EVENT",
    "STABLE_WINDOWS_MACHINE_IDENTITY_SHA256_FROM_SYSTEM_SOURCE",
    "PROCESS_START_EVIDENCE_IMMEDIATELY_AFTER_EVERY_SUCCESSFUL_POPEN",
    "INITIAL_RSS_OR_EXPLICIT_RSS_FAILURE_PER_SERVER_START",
    "GLOBAL_MONOTONIC_DEADLINE_1800_SECONDS",
    "BOUNDED_STDOUT_STDERR_AND_BUDGETED_JSON_JSONL_WRITES",
    "VALIDATED_EXECUTION_CONTEXT_REQUIRED_FOR_EFFECTFUL_ENTRY_POINTS",
    "ORCHESTRATOR_OWNED_PROCESS_REGISTRY_FOR_FORCE_KILL",
    "OPAQUE_REGISTERED_EXECUTION_CONTEXT_CANNOT_BE_CALLER_FORGED",
    "PROCESS_WRAPPER_AND_ORIGINAL_NATIVE_HANDLE_IDENTITY_REGISTRY",
    "RUNTIME_RELEASE_ASSET_SHA256_AND_EXTRACTED_TREE_EXACT_MATCH",
    "NATIVE_BUILD_TOOLCHAIN_ZIP_TREE_AND_COMPILER_IDENTITIES",
}
REQUIRED_FINAL_ISSUANCE = {
    "STATIC_REVIEW_OR_TESTS_CONFIRM_PROFILE_STATUS_GUARD_AND_PID_OWNERSHIP_GUARD",
    "OWNER_EXPLICIT_M1_07_EFFECTFUL_EXECUTION_AUTHORIZATION",
    "BIND_FINAL_EXPIRY",
    "CREATE_ISSUED_SUCCESSOR_PROFILE_WITH_STATUS_ISSUED",
    "SET_ISSUED_SUCCESSOR_PROFILE_ID_TO_M1-STAB-QWEN35-08B-PC-001-ISSUED",
    "BIND_OWNER_FINAL_EXECUTION_AUTHORIZATION_OBJECT_WITH_CANONICAL_SHA256",
    "BIND_TRUSTED_OWNER_AUTHORIZATION_ID_AND_SHA256_IN_ISSUED_PROFILE_OUTER_BINDING",
    "RETAIN_EXACT_MACHINE_IDENTITY_SHA256_BINDING",
    "RETAIN_EXACT_ORCHESTRATOR_COMMIT_BLOB_AND_NORMALIZED_SHA256_BINDING",
    "RETAIN_EXACT_NATIVE_BUILD_TOOLCHAIN_BINDING_AT_FINAL_ISSUANCE",
}


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def fail(message: str):
    print("FAIL: " + message, file=sys.stderr)
    raise SystemExit(1)


def normalized_text_sha256(path: Path) -> str:
    text = path.read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n")
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def git_blob_sha1(path: Path) -> str:
    data = path.read_bytes()
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()


def binding_values() -> tuple[str, str, str]:
    spec = importlib.util.spec_from_file_location("m1_runtime_stability_binding_validator", BINDING)
    if spec is None or spec.loader is None:
        return "", "", ""
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return (
        module.EXPECTED_ORCHESTRATOR_COMMIT,
        module.EXPECTED_ORCHESTRATOR_BLOB_SHA1,
        module.EXPECTED_ORCHESTRATOR_NORMALIZED_SHA256,
    )


def exact_code_binding(profile: dict) -> bool:
    code = profile.get("code_revision") or {}
    return (
        code.get("status") == "EXACT_BOUND"
        and code.get("required_code_commit") == ORCH_COMMIT
        and code.get("required_script_git_blob_sha1") == ORCH_BLOB
        and code.get("required_script_normalized_sha256") == ORCH_NORMALIZED_SHA256
        and code.get("required_script_path") == "scripts/model-program/m1_runtime_stability_pc.py"
        and code.get("exact_binding_module_path") == "scripts/model-program/m1_runtime_stability_binding.py"
        and code.get("exact_binding_module_git_blob_sha1") == BINDING_BLOB
        and code.get("execution_allowed_while_candidate") is False
        and code.get("owner_boundary_path") == "scripts/model-program/m1_runtime_stability_owner_boundary.py"
        and code.get("owner_boundary_git_blob_sha1") == OWNER_BOUNDARY_BLOB
        and code.get("owner_boundary_normalized_sha256") == OWNER_BOUNDARY_SHA256
        and OWNER_BOUNDARY.is_file()
        and git_blob_sha1(OWNER_BOUNDARY) == OWNER_BOUNDARY_BLOB
        and normalized_text_sha256(OWNER_BOUNDARY) == OWNER_BOUNDARY_SHA256
        and ORCHESTRATOR.is_file()
        and BINDING.is_file()
        and git_blob_sha1(ORCHESTRATOR) == ORCH_BLOB
        and normalized_text_sha256(ORCHESTRATOR) == ORCH_NORMALIZED_SHA256
        and git_blob_sha1(BINDING) == BINDING_BLOB
        and binding_values() == (ORCH_COMMIT, ORCH_BLOB, ORCH_NORMALIZED_SHA256)
    )


def validate_native_source_binding(profile: dict) -> bool:
    native = ROOT / "scripts/model-program/m1-runtime-owner"
    path = native / "source-manifest.json"
    code = profile.get("code_revision") or {}
    if code.get("native_owner_source_manifest_path") != "scripts/model-program/m1-runtime-owner/source-manifest.json":
        return False
    if hashlib.sha256(path.read_bytes()).hexdigest() != code.get("native_owner_source_manifest_sha256"):
        return False
    manifest = load(path)
    expected = {"go.mod", "bindings.go", "policy.go", "owner.go", "platform_windows.go", "platform_other.go", "scenarios.go", "main.go"}
    expected_tests = {"owner_test.go", "runtime_tree_windows_test.go"}
    expected_metadata = {"source-manifest.json", "test-migration.json"}
    if set(manifest.get("production_files", {})) != expected:
        return False
    if set(manifest.get("test_files_excluded_from_production", [])) != expected_tests:
        return False
    if set(manifest.get("non_build_metadata_files", [])) != expected_metadata:
        return False
    if manifest.get("native_build_toolchain") != NATIVE_BUILD_TOOLCHAIN:
        return False
    actual_entries = {p.name for p in native.iterdir()}
    if actual_entries != expected | expected_tests | expected_metadata:
        return False
    if any(p.is_symlink() or not p.is_file() for p in native.iterdir()):
        return False
    helper_identity = manifest.get("build_provenance_helper") or {}
    if helper_identity.get("path") != "scripts/model-program/build_m1_07_native_owner.py":
        return False
    if (
        BUILD_HELPER.stat().st_size != helper_identity.get("bytes")
        or git_blob_sha1(BUILD_HELPER) != helper_identity.get("git_blob_sha1")
        or hashlib.sha256(BUILD_HELPER.read_bytes()).hexdigest() != helper_identity.get("sha256")
    ):
        return False
    for name, identity in manifest["production_files"].items():
        p = native / name
        if p.stat().st_size != identity["bytes"] or git_blob_sha1(p) != identity["git_blob_sha1"] or hashlib.sha256(p.read_bytes()).hexdigest() != identity["sha256"]:
            return False
    policy = (native / "policy.go").read_text(encoding="utf-8")
    owner = (native / "owner.go").read_text(encoding="utf-8")
    platform_windows = (native / "platform_windows.go").read_text(encoding="utf-8")
    build_helper = BUILD_HELPER.read_text(encoding="utf-8")
    if 'const issuerPublicKeyHex = "a683b21e2d838f0773fc1251e6d0165c4b15ad2b2994cabf4290edff1c24eb03"' not in policy:
        return False
    if 'const issuerPublicKeySHA256 = "7d8a39adb80276686ff052b65e074a8ea9e74f7eccbc44f4340b194fec342f9c"' not in policy:
        return False
    if "Env: sanitizedServerEnv()" not in platform_windows or "zip.OpenReader(assetPath)" not in platform_windows or "attestRuntimeTreeAgainst(runtimeAssetPath, runtimeDir, runtimeAssetBytes, runtimeAssetSHA, deadline)" not in platform_windows:
        return False
    if 'allowed := []string{"SystemRoot", "WINDIR", "TEMP", "TMP"}' not in owner:
        return False
    if 'if os.environ.get("GOFLAGS")' not in build_helper or 'GOENV="off"' not in build_helper or 'GOWORK="off"' not in build_helper:
        return False
    for required in (
        'parser.add_argument("--toolchain-archive", required=True, type=Path)',
        "validate_toolchain_archive(archive)",
        "safe_extract_verified_toolchain(archive, toolchain_root)",
        "actual_entries = {p.name for p in SOURCE.iterdir()}",
        "stat.S_ISREG(os.lstat(p).st_mode)",
        "verified_files: dict[str, bytes] = {}",
        'build_source = temp_root / "verified-source"',
        "cwd=build_source",
        'GOMODCACHE=modcache',
        'GOTMPDIR=gotmp',
        'GOROOT=goroot',
        'file_sha256(go) != TOOLCHAIN_GO_EXE_SHA256',
        'file_sha256(compile_exe) != TOOLCHAIN_COMPILE_EXE_SHA256',
        'file_sha256(link_exe) != TOOLCHAIN_LINK_EXE_SHA256',
    ):
        if required not in build_helper:
            return False
    if code.get("native_owner_build_provenance_helper_path") != "scripts/model-program/build_m1_07_native_owner.py":
        return False
    if code.get("native_owner_build_provenance_helper_sha256") != helper_identity.get("sha256"):
        return False
    if code.get("native_owner_build_provenance_semantics") != "EXACT_SOURCE_DIRECTORY_SET / MANIFEST_BINDS_HELPER / VERIFIED_SOURCE_SNAPSHOT_ONLY / EXACT_OFFICIAL_TOOLCHAIN_ZIP_AND_TREE / CLEAN_GO_ENV / NO_CALLER_EXECUTABLE":
        return False
    if code.get("native_owner_build_toolchain") != NATIVE_BUILD_TOOLCHAIN:
        return False
    if 'parser.add_argument("--go"' in build_helper:
        return False
    binary_sha = code.get("native_owner_binary_sha256")
    if not isinstance(binary_sha, str) or len(binary_sha) != 64 or any(c not in "0123456789abcdef" for c in binary_sha):
        return False
    control = profile.get("execution_control") or {}
    if control.get("issuer_public_key_sha256_fingerprint") != OWNER_PUBLIC_KEY_SHA256:
        return False
    if control.get("issuer_trust_root_status") != "PINNED_OWNER_ED25519_PUBLIC_KEY / OWNER_ENROLLMENT_COMPLETE / PRIVATE_KEY_OWNER_ONLY / NOT_ISSUED":
        return False
    if control.get("boundary_contract_adoption_status") != "OWNER_ADOPTED_EVENT_833 / SUCCESSOR_PREPARATION_GATE_EVENT_834 / INDEPENDENT_REVIEW_REQUIRED_BEFORE_FINAL_ISSUANCE":
        return False
    prep = profile.get("successor_preparation") or {}
    if prep.get("predecessor_exact_head") != "d58df9c4a1885512bd4dd9b94f121b6a84e25744" or prep.get("owner_public_key_canonical") != OWNER_PUBLIC_KEY_HEX or prep.get("owner_public_key_sha256_fingerprint") != OWNER_PUBLIC_KEY_SHA256:
        return False
    if prep.get("private_key_material_present_in_repository") is not False:
        return False
    return True


def validate_candidate(profile: dict) -> tuple[bool, str]:
    if profile.get("task_id") != "M1-07":
        return False, "M1_07_TASK_ID"
    if profile.get("status") != "BLOCKED_PENDING_REVIEW_AND_FINAL_ISSUANCE":
        return False, "M1_07_CANDIDATE_STATUS"
    if profile.get("effectful_authority_issued") is not False or profile.get("authority_effect") != "NONE / PROFILE_PREPARATION_ONLY":
        return False, "M1_07_AUTHORITY_EXPANSION"
    if profile.get("issued_successor_profile_id") != ISSUED_PROFILE_ID:
        return False, "M1_07_ISSUED_SUCCESSOR_ID"

    if profile.get("model_program_revision", {}).get("plan_sha256") != PLAN_SHA:
        return False, "M1_07_PLAN_BINDING"
    model = profile.get("exact_model_ids_and_revisions") or {}
    if model.get("upstream_revision") != MODEL_REV or model.get("upstream_weight_sha256") != MODEL_SHA:
        return False, "M1_07_MODEL_LINEAGE"
    subject = model.get("stability_subject") or {}
    if subject.get("variant_id") != "q8_0" or subject.get("filename") != "Qwen3.5-0.8B-Q8_0.gguf":
        return False, "M1_07_STABILITY_SUBJECT"
    if subject.get("sha256") != Q8_SHA or subject.get("bytes") != 833592320:
        return False, "M1_07_STABILITY_SUBJECT"
    semantics = set(str(subject.get("selection_semantics", "")).split(" / "))
    if semantics != REQUIRED_MODEL_SEMANTICS:
        return False, "M1_07_STABILITY_SEMANTICS"

    runtime = profile.get("runtime_and_device_profile") or {}
    if runtime.get("device_name") != "DESK-W-591" or runtime.get("device_class") != "PC" or runtime.get("binding_state") != "EXACT_BOUND":
        return False, "M1_07_DEVICE_BINDING"
    machine = runtime.get("machine_identity") or {}
    if (
        machine.get("source") != "WINDOWS_HKLM_MACHINEGUID"
        or machine.get("canonicalization") != "SHA256_UTF8_PREFIX_windows-machineguid_COLON_TRIM_LOWERCASE"
        or machine.get("sha256") != MACHINE_IDENTITY_SHA256
        or machine.get("raw_identifier_stored") is not False
    ):
        return False, "M1_07_MACHINE_IDENTITY_BINDING"
    if runtime.get("runtime_release_tag") != "b11033" or runtime.get("runtime_commit") != LLAMA_COMMIT:
        return False, "M1_07_RUNTIME_BINDING"
    if runtime.get("server_executable") != "llama-server.exe" or runtime.get("server_executable_sha256") != SERVER_SHA:
        return False, "M1_07_RUNTIME_BINDING"
    if (
        runtime.get("runtime_asset_name") != RUNTIME_ASSET_NAME
        or runtime.get("runtime_asset_bytes") != RUNTIME_ASSET_BYTES
        or runtime.get("runtime_asset_sha256") != RUNTIME_ASSET_SHA256
        or runtime.get("runtime_directory") != RUNTIME_DIR
        or runtime.get("runtime_tree_attestation_semantics") != RUNTIME_TREE_SEMANTICS
    ):
        return False, "M1_07_RUNTIME_TREE_BINDING"

    config = (profile.get("config_revision") or {}).get("server") or {}
    if config.get("host") != "127.0.0.1" or config.get("port") != 18087 or config.get("external_bind") is not False or config.get("external_network") is not False:
        return False, "M1_07_LOOPBACK_BOUNDARY"
    if config.get("offline") is not True or config.get("webui") is not False:
        return False, "M1_07_NETWORK_UI_BOUNDARY"
    if config.get("n_gpu_layers") != 0 or config.get("device") != "none" or config.get("op_offload") is not False:
        return False, "M1_07_CPU_ONLY_BOUNDARY"
    if config.get("threads") != 2 or config.get("threads_batch") != 2 or config.get("parallel") != 1 or config.get("ctx_size") != 2048:
        return False, "M1_07_COMPUTE_BOUNDARY"
    if config.get("configuration_sources") != CONFIG_SOURCES:
        return False, "M1_07_CONFIGURATION_SOURCE_BOUNDARY"

    scenarios = profile.get("scenario_contract") or []
    if {x.get("scenario_id") for x in scenarios} != SCENARIOS:
        return False, "M1_07_SCENARIO_SET"
    bg = next((x for x in scenarios if x.get("scenario_id") == "M1-07-PC-BACKGROUND-001"), {})
    if bg.get("semantics") != "PC_BACKGROUND_SERVICE_CONTINUITY_ONLY / NOT_MOBILE_APP_BACKGROUND_RESUME":
        return False, "M1_07_BACKGROUND_SCOPE"
    if "NO_CLAIM_ABOUT_PHONE_TABLET_APP_BACKGROUND_RESUME" not in set(bg.get("pass_criteria") or []):
        return False, "M1_07_BACKGROUND_SCOPE"
    crash = next((x for x in scenarios if x.get("scenario_id") == "M1-07-PC-CRASH-001"), {})
    if "AFTER_FIRST_NONEMPTY_STREAM_EVENT_FORCE_TERMINATE_ONLY_ORCHESTRATOR_OWNED_LLAMA_SERVER" not in set(crash.get("steps") or []):
        return False, "M1_07_CRASH_OWNERSHIP_SCOPE"

    if not REQUIRED_PROHIBITED.issubset(set(profile.get("prohibited_operations") or [])):
        return False, "M1_07_PROHIBITED_BOUNDARY"
    if profile.get("max_attempts") != 1 or profile.get("max_wall_time") != 1800 or profile.get("max_storage") != 134217728:
        return False, "M1_07_BUDGET"
    compute = profile.get("max_compute") or {}
    if (
        compute.get("device") != "DESK-W-591"
        or compute.get("cpu_threads") != 2
        or compute.get("gpu_layers") != 0
        or compute.get("non_cpu_devices") != "NONE"
        or compute.get("max_parallel_server_processes") != 1
        or compute.get("max_profile_owned_server_starts") != 7
    ):
        return False, "M1_07_COMPUTE_BUDGET"

    control = profile.get("execution_control") or {}
    if control.get("attempt_guard_path") != ATTEMPT_GUARD_PATH:
        return False, "M1_07_ATTEMPT_GUARD_PATH"
    if control.get("attempt_guard_semantics") != "ATOMIC_CREATE_ON_FIRST_EFFECTFUL_ATTEMPT / NO_REUSE_AFTER_SUCCESS_OR_FAILURE":
        return False, "M1_07_ATTEMPT_GUARD_SEMANTICS"
    if control.get("final_issued_profile_id") != ISSUED_PROFILE_ID:
        return False, "M1_07_EXECUTION_CONTROL_PROFILE_ID"
    if control.get("owner_authorization_binding") != "INDEPENDENT_ISSUED_PROFILE_OUTER_BINDING / AUTHORIZATION_ID_AND_RECOMPUTED_CANONICAL_SHA256_MUST_MATCH":
        return False, "M1_07_OWNER_AUTH_BINDING_POLICY"
    if control.get("validated_context_semantics") != "NATIVE_OWNER_PRIVATE_EXACT_CONTEXT_IDENTITY / NO_PYTHON_CONTEXT_CAPABILITY / POST_AUTH_TAMPER_FAIL_CLOSED":
        return False, "M1_07_CONTEXT_REGISTRY_POLICY"
    if control.get("process_ownership_semantics") != "NATIVE_OWNER_PRIVATE_EXACT_WRAPPER_IDENTITY_TO_ORIGINAL_OS_PROCESS_HANDLE / ALL_LIFECYCLE_RESOLVES_ORIGINAL_HANDLE / DIAGNOSTICS_NON_AUTHORITATIVE / NO_CALLER_PROCESS_INPUT":
        return False, "M1_07_PROCESS_OWNERSHIP_POLICY"

    if control.get("execution_boundary") != 'NATIVE_STANDALONE_OWNER / NO_EMBEDDED_PYTHON / DATA_ONLY_INPUT / NO_PROCESS_IMPORT':
        return False, "M1_07_OWNER_PROCESS_BOUNDARY"
    if control.get("import_surface") != "VALIDATE_ONLY / NO_RUNTIME_REGISTRY / NO_CONTEXT_EXPORT / NO_PROCESS_CONTROL":
        return False, "M1_07_IMPORT_SURFACE"

    trusted = profile.get("trusted_execution_bindings") or {}
    if (
        trusted.get("binding_location") != "ISSUED_PROFILE_OUTER_BINDING"
        or trusted.get("expected_owner_authorization_id") != "TO_BE_BOUND_AT_FINAL_ISSUANCE"
        or trusted.get("expected_owner_authorization_sha256") != "TO_BE_BOUND_AT_FINAL_ISSUANCE"
        or trusted.get("rule") != "OWNER_AUTHORIZATION_OBJECT_CANNOT_SELF_DECLARE_EXPECTED_ID_OR_SHA256"
    ):
        return False, "M1_07_TRUSTED_AUTH_BINDING_PREISSUANCE"

    outputs = set(profile.get("allowed_outputs") or [])
    if "M1RuntimeStabilityProcessMetrics.jsonl" not in outputs or "M1RuntimeStabilityAttemptGuard.json" not in outputs:
        return False, "M1_07_REQUIRED_OUTPUTS"
    if not REQUIRED_EVIDENCE.issubset(set(profile.get("evidence_requirements") or [])):
        return False, "M1_07_EVIDENCE_REQUIREMENTS"

    if not exact_code_binding(profile):
        return False, "M1_07_CODE_BINDING"
    if not validate_native_source_binding(profile):
        return False, "M1_07_NATIVE_SOURCE_OR_TRUST_ROOT_BINDING"
    if (profile.get("code_revision") or {}).get("orchestrator_default_mode") != "VALIDATE_ONLY / NO SERVER START / NO MODEL LOAD":
        return False, "M1_07_ORCHESTRATOR_DEFAULT_MODE"

    if profile.get("expiry") != "TO_BE_BOUND_AT_FINAL_ISSUANCE":
        return False, "M1_07_EXPIRY_PREMATURE"
    if profile.get("owner_final_execution_authorization") is not None:
        return False, "M1_07_OWNER_AUTH_PREMATURE"
    if "NO_M1_08_AUTHORITY" not in profile.get("release_ceiling", ""):
        return False, "M1_07_RELEASE_CEILING"
    if not REQUIRED_FINAL_ISSUANCE.issubset(set(profile.get("final_issuance_requirements") or [])):
        return False, "M1_07_FINAL_ISSUANCE_REQUIREMENTS"
    return True, "PASS"


def execution_readiness(profile: dict) -> tuple[bool, str]:
    if profile.get("status") != "ISSUED":
        return False, "PROFILE_NOT_ISSUED"
    if profile.get("profile_id") != ISSUED_PROFILE_ID:
        return False, "PROFILE_ID_SCOPE_DRIFT"
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

    print("PASS: M1-07 candidate is non-issued, exact-bound to the reviewed orchestrator and stable Windows machine identity, and retains independent Owner-authorization issuance binding")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
