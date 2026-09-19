#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime
import hashlib
import importlib.util
import json
import os
import socket
import sys
from pathlib import Path
from typing import Any

SCRIPT_PATH = Path(__file__).resolve()
ROOT = SCRIPT_PATH.parents[2]
DEFAULT_CANDIDATE = ROOT / "development/contracts/model-program/m1/governance/ExperimentAuthorizationProfile.M1-STAB-QWEN35-08B-PC-001.candidate.json"
BINDING_PATH = SCRIPT_PATH.with_name("m1_runtime_stability_binding.py")

_binding_spec = importlib.util.spec_from_file_location("m1_runtime_stability_binding", BINDING_PATH)
if _binding_spec is None or _binding_spec.loader is None:
    raise RuntimeError(f"cannot load runtime-stability binding module: {BINDING_PATH}")
_binding = importlib.util.module_from_spec(_binding_spec)
_binding_spec.loader.exec_module(_binding)

EXPECTED_ORCHESTRATOR_COMMIT = _binding.EXPECTED_ORCHESTRATOR_COMMIT
EXPECTED_ORCHESTRATOR_BLOB_SHA1 = _binding.EXPECTED_ORCHESTRATOR_BLOB_SHA1
EXPECTED_ORCHESTRATOR_NORMALIZED_SHA256 = _binding.EXPECTED_ORCHESTRATOR_NORMALIZED_SHA256

OWNER_BOUNDARY_PATH = SCRIPT_PATH.with_name("m1_runtime_stability_owner_boundary.py")
EXPECTED_OWNER_BOUNDARY_BLOB_SHA1 = _binding.EXPECTED_OWNER_BOUNDARY_BLOB_SHA1
EXPECTED_OWNER_BOUNDARY_NORMALIZED_SHA256 = _binding.EXPECTED_OWNER_BOUNDARY_NORMALIZED_SHA256
_owner_bytes = OWNER_BOUNDARY_PATH.read_bytes()
if hashlib.sha1(b"blob " + str(len(_owner_bytes)).encode("ascii") + b"\0" + _owner_bytes).hexdigest() != EXPECTED_OWNER_BOUNDARY_BLOB_SHA1:
    raise RuntimeError("OWNER_BOUNDARY_BLOB_DRIFT")
if hashlib.sha256(_owner_bytes.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")).hexdigest() != EXPECTED_OWNER_BOUNDARY_NORMALIZED_SHA256:
    raise RuntimeError("OWNER_BOUNDARY_SHA256_DRIFT")
_owner_spec = importlib.util.spec_from_file_location("m1_runtime_stability_owner_boundary", OWNER_BOUNDARY_PATH)
if _owner_spec is None or _owner_spec.loader is None:
    raise RuntimeError("OWNER_BOUNDARY_MODULE_UNAVAILABLE")
_owner_boundary = importlib.util.module_from_spec(_owner_spec)
_owner_spec.loader.exec_module(_owner_boundary)
del _owner_bytes, _owner_spec


EXPECTED_ISSUED_PROFILE_ID = "M1-STAB-QWEN35-08B-PC-001-ISSUED"
EXPECTED_AUTHORITY_EFFECT = "M1-07_PC_RUNTIME_STABILITY_EXECUTION_ONLY"
EXPECTED_BASE_COMMIT = "bd80de6beed04a52b74f763baa7c274b5741fb1d"
EXPECTED_DEVICE_NAME = "DESK-W-591"
EXPECTED_MACHINE_IDENTITY_SOURCE = "WINDOWS_HKLM_MACHINEGUID"
EXPECTED_MACHINE_IDENTITY_CANONICALIZATION = "SHA256_UTF8_PREFIX_windows-machineguid_COLON_TRIM_LOWERCASE"
EXPECTED_MACHINE_IDENTITY_SHA256 = "00b300c3b04e170bc097ac0a69cf39378a61f1bdd3ca15a970e55f2119b65522"
EXPECTED_MODEL_FILENAME = "Qwen3.5-0.8B-Q8_0.gguf"
EXPECTED_MODEL_BYTES = 833592320
EXPECTED_MODEL_SHA256 = "799482186ea1c91b63bf4eb2999e034330425745496a95f0bffbfe6300a1064d"
EXPECTED_RUNTIME_RELEASE_TAG = "b11033"
EXPECTED_RUNTIME_COMMIT = "8ed1a55efcd7424d2c592f6cbc9f97756db1d74d"
EXPECTED_SERVER_BYTES = 9216
EXPECTED_SERVER_SHA256 = "085151c9dc45b6b6b74ece45207afd809e68c91e05938bb00532a24e80aaabba"
EXPECTED_HOST = "127.0.0.1"
EXPECTED_PORT = 18087
EXPECTED_THREADS = 2
EXPECTED_THREADS_BATCH = 2
EXPECTED_PARALLEL = 1
EXPECTED_CTX_SIZE = 2048
EXPECTED_MAX_WALL_TIME = 1800
EXPECTED_MAX_STORAGE = 134217728
EXPECTED_EVIDENCE_RESERVE_BYTES = 1048576
EXPECTED_MAX_ATTEMPTS = 1
EXPECTED_MAX_SERVER_STARTS = 7
EXPECTED_ATTEMPT_GUARD_PATH = Path(r"C:\Users\Public\Clued\ModelProgram\M1\runtime-state\M1-STAB-QWEN35-08B-PC-001\M1RuntimeStabilityAttemptGuard.json")



class StabilityError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def normalized_text_sha256(path: Path) -> str:
    text = path.read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n")
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def git_blob_sha1(path: Path) -> str:
    data = path.read_bytes()
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()


def sha256_file(path: Path, ctx: "ValidatedExecutionContext | None" = None) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            if ctx is not None:
                ctx.check_limits()
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def now_utc() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _is_hex(value: Any, length: int) -> bool:
    return isinstance(value, str) and len(value) == length and all(c in "0123456789abcdef" for c in value.lower())


def owner_authorization_sha256(auth: dict[str, Any]) -> str:
    payload = {k: v for k, v in auth.items() if k != "sha256"}
    return hashlib.sha256(canonical_json(payload)).hexdigest()


def parse_utc_timestamp(value: Any) -> datetime.datetime:
    if not isinstance(value, str) or not value:
        raise ValueError("timestamp missing")
    dt = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None or dt.utcoffset() is None:
        raise ValueError("naive timestamp")
    if dt.utcoffset() != datetime.timedelta(0):
        raise ValueError("timestamp is not UTC")
    return dt.astimezone(datetime.timezone.utc)


def server_config(profile: dict[str, Any]) -> dict[str, Any]:
    return ((profile.get("config_revision") or {}).get("server") or {})


def model_binding(profile: dict[str, Any]) -> dict[str, Any]:
    return ((profile.get("exact_model_ids_and_revisions") or {}).get("stability_subject") or {})


def runtime_binding(profile: dict[str, Any]) -> dict[str, Any]:
    return profile.get("runtime_and_device_profile") or {}


def validate_execution_profile(profile: dict[str, Any]) -> tuple[bool, str]:
    if profile.get("task_id") != "M1-07":
        return False, "M1_07_TASK_ID"
    if profile.get("status") != "ISSUED":
        return False, "PROFILE_NOT_ISSUED"
    if profile.get("profile_id") != EXPECTED_ISSUED_PROFILE_ID:
        return False, "PROFILE_ID_SCOPE_DRIFT"
    if profile.get("effectful_authority_issued") is not True:
        return False, "EFFECTFUL_AUTHORITY_NOT_ISSUED"
    if profile.get("authority_effect") != EXPECTED_AUTHORITY_EFFECT:
        return False, "M1_07_AUTHORITY_EFFECT"

    auth = profile.get("owner_final_execution_authorization") or {}
    if auth.get("present") is not True or not auth.get("owner_message"):
        return False, "OWNER_FINAL_EXECUTION_AUTHORIZATION_MISSING"
    if not auth.get("authorization_id") or not auth.get("issued_at_utc"):
        return False, "OWNER_FINAL_EXECUTION_AUTHORIZATION_IDENTITY_MISSING"
    if auth.get("authorized_profile_id") != EXPECTED_ISSUED_PROFILE_ID:
        return False, "OWNER_FINAL_EXECUTION_AUTHORIZATION_PROFILE_MISMATCH"
    if auth.get("authorized_authority_effect") != EXPECTED_AUTHORITY_EFFECT:
        return False, "OWNER_FINAL_EXECUTION_AUTHORIZATION_SCOPE_MISMATCH"
    try:
        parse_utc_timestamp(auth.get("issued_at_utc"))
    except Exception:
        return False, "OWNER_FINAL_EXECUTION_AUTHORIZATION_TIME_INVALID"
    recomputed_auth_sha = owner_authorization_sha256(auth)
    auth_sha = auth.get("sha256")
    if not _is_hex(auth_sha, 64) or auth_sha != recomputed_auth_sha:
        return False, "OWNER_FINAL_EXECUTION_AUTHORIZATION_DIGEST_INVALID"

    trusted = profile.get("trusted_execution_bindings") or {}
    expected_auth_id = trusted.get("expected_owner_authorization_id")
    expected_auth_sha = trusted.get("expected_owner_authorization_sha256")
    if not isinstance(expected_auth_id, str) or not expected_auth_id or expected_auth_id == "TO_BE_BOUND_AT_FINAL_ISSUANCE":
        return False, "OWNER_AUTHORIZATION_TRUSTED_BINDING_MISSING"
    if not _is_hex(expected_auth_sha, 64):
        return False, "OWNER_AUTHORIZATION_TRUSTED_BINDING_MISSING"
    if auth.get("authorization_id") != expected_auth_id:
        return False, "OWNER_AUTHORIZATION_ID_TRUSTED_BINDING_MISMATCH"
    if recomputed_auth_sha != expected_auth_sha:
        return False, "OWNER_AUTHORIZATION_SHA_TRUSTED_BINDING_MISMATCH"

    code = profile.get("code_revision") or {}
    if code.get("status") != "EXACT_BOUND":
        return False, "EXECUTION_CODE_BINDING_UNRESOLVED"
    if code.get("repository") != "tdoljyj/cross-memory-system":
        return False, "EXECUTION_CODE_REPOSITORY_DRIFT"
    if code.get("base_commit") != EXPECTED_BASE_COMMIT:
        return False, "EXECUTION_CODE_BASE_DRIFT"
    if code.get("required_script_path") != "scripts/model-program/m1_runtime_stability_pc.py":
        return False, "EXECUTION_SCRIPT_PATH_DRIFT"
    if code.get("required_code_commit") != EXPECTED_ORCHESTRATOR_COMMIT:
        return False, "EXECUTION_ORCHESTRATOR_COMMIT_DRIFT"
    if code.get("required_script_git_blob_sha1") != EXPECTED_ORCHESTRATOR_BLOB_SHA1:
        return False, "EXECUTION_ORCHESTRATOR_BLOB_DRIFT"
    if code.get("required_script_normalized_sha256") != EXPECTED_ORCHESTRATOR_NORMALIZED_SHA256:
        return False, "EXECUTION_ORCHESTRATOR_NORMALIZED_SHA256_DRIFT"
    if git_blob_sha1(SCRIPT_PATH) != EXPECTED_ORCHESTRATOR_BLOB_SHA1:
        return False, "EXECUTION_SCRIPT_BLOB_DRIFT"
    if normalized_text_sha256(SCRIPT_PATH) != EXPECTED_ORCHESTRATOR_NORMALIZED_SHA256:
        return False, "EXECUTION_SCRIPT_SHA256_DRIFT"

    if (
        code.get("owner_boundary_path") != "scripts/model-program/m1_runtime_stability_owner_boundary.py"
        or code.get("owner_boundary_git_blob_sha1") != EXPECTED_OWNER_BOUNDARY_BLOB_SHA1
        or code.get("owner_boundary_normalized_sha256") != EXPECTED_OWNER_BOUNDARY_NORMALIZED_SHA256
        or git_blob_sha1(OWNER_BOUNDARY_PATH) != EXPECTED_OWNER_BOUNDARY_BLOB_SHA1
        or normalized_text_sha256(OWNER_BOUNDARY_PATH) != EXPECTED_OWNER_BOUNDARY_NORMALIZED_SHA256
    ):
        return False, "OWNER_BOUNDARY_CODE_BINDING_DRIFT"

    model = model_binding(profile)
    if (
        model.get("filename") != EXPECTED_MODEL_FILENAME
        or model.get("bytes") != EXPECTED_MODEL_BYTES
        or model.get("sha256") != EXPECTED_MODEL_SHA256
        or model.get("variant_id") != "q8_0"
    ):
        return False, "M1_07_STABILITY_SUBJECT_DRIFT"

    runtime = runtime_binding(profile)
    machine = runtime.get("machine_identity") or {}
    if runtime.get("device_name") != EXPECTED_DEVICE_NAME or runtime.get("device_class") != "PC":
        return False, "M1_07_DEVICE_SCOPE_DRIFT"
    if (
        machine.get("source") != EXPECTED_MACHINE_IDENTITY_SOURCE
        or machine.get("canonicalization") != EXPECTED_MACHINE_IDENTITY_CANONICALIZATION
        or machine.get("sha256") != EXPECTED_MACHINE_IDENTITY_SHA256
    ):
        return False, "M1_07_MACHINE_IDENTITY_BINDING_DRIFT"
    if (
        runtime.get("runtime_release_tag") != EXPECTED_RUNTIME_RELEASE_TAG
        or runtime.get("runtime_commit") != EXPECTED_RUNTIME_COMMIT
        or runtime.get("server_executable") != "llama-server.exe"
        or runtime.get("server_executable_bytes") != EXPECTED_SERVER_BYTES
        or runtime.get("server_executable_sha256") != EXPECTED_SERVER_SHA256
    ):
        return False, "M1_07_RUNTIME_SCOPE_DRIFT"

    cfg = server_config(profile)
    expected_cfg = {
        "host": EXPECTED_HOST,
        "port": EXPECTED_PORT,
        "offline": True,
        "webui": False,
        "threads": EXPECTED_THREADS,
        "threads_batch": EXPECTED_THREADS_BATCH,
        "ctx_size": EXPECTED_CTX_SIZE,
        "parallel": EXPECTED_PARALLEL,
        "n_gpu_layers": 0,
        "device": "none",
        "op_offload": False,
        "external_bind": False,
        "external_network": False,
    }
    for key, value in expected_cfg.items():
        if cfg.get(key) != value:
            return False, f"M1_07_CONFIG_SCOPE_DRIFT:{key}"

    if profile.get("max_wall_time") != EXPECTED_MAX_WALL_TIME:
        return False, "M1_07_MAX_WALL_TIME_DRIFT"
    if profile.get("max_storage") != EXPECTED_MAX_STORAGE:
        return False, "M1_07_MAX_STORAGE_DRIFT"
    if profile.get("max_attempts") != EXPECTED_MAX_ATTEMPTS:
        return False, "M1_07_MAX_ATTEMPTS_DRIFT"
    compute = profile.get("max_compute") or {}
    if (
        compute.get("device") != EXPECTED_DEVICE_NAME
        or compute.get("cpu_threads") != EXPECTED_THREADS
        or compute.get("gpu_layers") != 0
        or compute.get("non_cpu_devices") != "NONE"
        or compute.get("max_parallel_server_processes") != 1
        or compute.get("max_profile_owned_server_starts") != EXPECTED_MAX_SERVER_STARTS
    ):
        return False, "M1_07_MAX_COMPUTE_DRIFT"

    control = profile.get("execution_control") or {}
    if control.get("execution_boundary") != 'NATIVE_STANDALONE_OWNER / NO_EMBEDDED_PYTHON / DATA_ONLY_INPUT / NO_PROCESS_IMPORT':
        return False, "M1_07_OWNER_PROCESS_BOUNDARY"
    if control.get("import_surface") != "VALIDATE_ONLY / NO_RUNTIME_REGISTRY / NO_CONTEXT_EXPORT / NO_PROCESS_CONTROL":
        return False, "M1_07_IMPORT_SURFACE"
    if control.get("attempt_guard_path") != str(EXPECTED_ATTEMPT_GUARD_PATH):
        return False, "M1_07_ATTEMPT_GUARD_PATH_DRIFT"
    if control.get("attempt_guard_semantics") != "ATOMIC_CREATE_ON_FIRST_EFFECTFUL_ATTEMPT / NO_REUSE_AFTER_SUCCESS_OR_FAILURE":
        return False, "M1_07_ATTEMPT_GUARD_SEMANTICS_DRIFT"

    expiry = profile.get("expiry")
    if not expiry or expiry == "TO_BE_BOUND_AT_FINAL_ISSUANCE":
        return False, "EXPIRY_UNRESOLVED"
    try:
        expiry_dt = parse_utc_timestamp(expiry)
        if datetime.datetime.now(datetime.timezone.utc) >= expiry_dt:
            return False, "PROFILE_EXPIRED"
    except Exception:
        return False, "EXPIRY_INVALID"

    return True, "READY"


def windows_machine_identity_sha256() -> str:
    if os.name != "nt":
        raise StabilityError("DEVICE_OS_DRIFT", "Windows machine identity required")
    import winreg
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography") as key:
        raw = str(winreg.QueryValueEx(key, "MachineGuid")[0])
    canonical = "windows-machineguid:" + raw.strip().lower()
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def verify_physical_device_identity(profile: dict[str, Any]) -> dict[str, Any]:
    if os.name != "nt":
        raise StabilityError("DEVICE_OS_DRIFT", "M1-07 PC stability profile is bound to Windows DESK-W-591")
    actual_logical_name = socket.gethostname().strip()
    if actual_logical_name.upper() != EXPECTED_DEVICE_NAME:
        raise StabilityError("DEVICE_LOGICAL_NAME_DRIFT", f"expected={EXPECTED_DEVICE_NAME} actual={actual_logical_name}")
    actual_machine_sha = windows_machine_identity_sha256()
    if actual_machine_sha != EXPECTED_MACHINE_IDENTITY_SHA256:
        raise StabilityError("DEVICE_MACHINE_IDENTITY_DRIFT", f"expected_sha256={EXPECTED_MACHINE_IDENTITY_SHA256} actual_sha256={actual_machine_sha}")
    runtime = runtime_binding(profile)
    machine = runtime.get("machine_identity") or {}
    if machine.get("sha256") != actual_machine_sha:
        raise StabilityError("DEVICE_PROFILE_MACHINE_IDENTITY_DRIFT", "profile machine identity does not match physical machine")
    return {
        "logical_name": actual_logical_name,
        "machine_identity_source": EXPECTED_MACHINE_IDENTITY_SOURCE,
        "machine_identity_sha256": actual_machine_sha,
    }


# r5: Python is permanently validation-only. No conditional runtime installer,
# context/process factory, registry, process controller or closure exists here.
# Replacing a Python loader/startup check cannot install absent implementation.
class OwnedServerProcess:
    __slots__ = ("pid", "label", "scenario", "start_index")
    def __init__(self, *args: Any, **kwargs: Any):
        raise StabilityError("OWNED_PROCESS_CONSTRUCTION_FORBIDDEN", "native owner only")

class ValidatedExecutionContext:
    __slots__ = ("profile", "output_dir", "events_path", "attempt_guard", "started_monotonic", "deadline", "budget", "server_start_count", "physical_identity")
    def __init__(self, *args: Any, **kwargs: Any):
        raise StabilityError("EXECUTION_CONTEXT_CONSTRUCTION_FORBIDDEN", "native owner only")

def _require_ctx(ctx: Any) -> None:
    raise StabilityError("EXECUTION_CONTEXT_REQUIRED", "Python cannot hold native execution authority")

def _require_owned(ctx: Any, owned: Any) -> None:
    raise StabilityError("FOREIGN_PROCESS_REJECTED", "Python cannot hold native process ownership")

def authorize_execution(profile: dict[str, Any], output_dir: Path) -> None:
    ready, reason = validate_execution_profile(profile)
    if not ready:
        raise StabilityError("EXECUTION_AUTHORIZATION_BLOCKED", reason)
    raise StabilityError("ISOLATED_OWNER_PROCESS_REQUIRED", "native standalone owner required; Python is validation-only")

def start_server(ctx: Any, scenario: str, label: str) -> None:
    _require_ctx(ctx)

def force_kill_owned(ctx: Any, owned: Any, timeout: float = 10.0) -> None:
    _require_owned(ctx, owned)

def graceful_stop_owned(ctx: Any, owned: Any, timeout: float = 10.0) -> None:
    _require_owned(ctx, owned)

def run(ctx: Any) -> None:
    _require_ctx(ctx)

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", type=Path, default=DEFAULT_CANDIDATE)
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    if args.validate_only and args.execute:
        print("ERROR: choose either --validate-only or --execute", file=sys.stderr)
        return 2
    profile = load_json(args.profile)
    ready, reason = validate_execution_profile(profile)
    if args.execute:
        print("BLOCKED: " + (reason if not ready else "NATIVE_OWNER_PROCESS_REQUIRED"), file=sys.stderr)
        return 3
    print(json.dumps({"profile_id": profile.get("profile_id"), "status": profile.get("status"), "effectful_authority_issued": profile.get("effectful_authority_issued"), "execution_ready": False, "profile_checks_ready": ready, "reason": reason if not ready else "NATIVE_OWNER_PROCESS_REQUIRED", "server_started": False, "model_loaded": False}, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
