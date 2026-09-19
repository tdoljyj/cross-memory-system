#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime
import hashlib
import http.client
import importlib.util
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, BinaryIO

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
    if control.get("execution_boundary") != 'DIRECT_NATIVE_COMMAND_LINE_BOUND_CPYTHON_OWNER / ISOLATED_NO_SITE / IMPORT_VALIDATE_ONLY / NO_UNTRUSTED_PYTHON_IN_OWNER':
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


class OutputBudget:
    def __init__(self, limit: int, initial_used: int = 0):
        if limit != EXPECTED_MAX_STORAGE:
            raise StabilityError("OUTPUT_STORAGE_BUDGET_INVALID", f"limit={limit}")
        self.limit = limit
        self.used = initial_used
        self._lock = threading.Lock()
        self._failure: StabilityError | None = None

    def reserve(self, amount: int, capture: bool = False, allow_after_failure: bool = False) -> None:
        if amount < 0:
            raise StabilityError("OUTPUT_STORAGE_BUDGET_INVALID", f"negative amount={amount}")
        with self._lock:
            if self._failure is not None and not allow_after_failure:
                raise self._failure
            effective_limit = self.limit - EXPECTED_EVIDENCE_RESERVE_BYTES if capture else self.limit
            if self.used + amount > effective_limit:
                exc = StabilityError(
                    "OUTPUT_STORAGE_BUDGET_EXCEEDED",
                    f"used={self.used} requested={amount} limit={effective_limit} capture={capture}",
                )
                if self._failure is None:
                    self._failure = exc
                raise exc
            self.used += amount

    def set_failure(self, exc: StabilityError) -> None:
        with self._lock:
            if self._failure is None:
                self._failure = exc

    def raise_if_failed(self) -> None:
        with self._lock:
            exc = self._failure
        if exc is not None:
            raise exc

    def write_bytes(self, path: Path, data: bytes, append: bool = False, allow_after_failure: bool = False) -> None:
        self.reserve(len(data), allow_after_failure=allow_after_failure)
        path.parent.mkdir(parents=True, exist_ok=True)
        mode = "ab" if append else "wb"
        with path.open(mode) as f:
            f.write(data)

    def write_text(self, path: Path, text: str, append: bool = False, allow_after_failure: bool = False) -> None:
        self.write_bytes(path, text.encode("utf-8"), append=append, allow_after_failure=allow_after_failure)

    def append_jsonl(self, path: Path, event: dict[str, Any], allow_after_failure: bool = False) -> None:
        self.write_text(
            path,
            json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n",
            append=True,
            allow_after_failure=allow_after_failure,
        )


class BoundedCapture:
    def __init__(self, stream: BinaryIO | None, path: Path, budget: OutputBudget):
        self.stream = stream
        self.path = path
        self.budget = budget
        self._thread = threading.Thread(target=self._run, name=f"capture-{path.name}", daemon=True)
        self._started = False

    def start(self) -> None:
        if self.stream is None:
            return
        self._started = True
        self._thread.start()

    def _run(self) -> None:
        assert self.stream is not None
        discard = False
        try:
            with self.path.open("ab") as out:
                while True:
                    chunk = self.stream.read(65536)
                    if not chunk:
                        break
                    if discard:
                        continue
                    try:
                        self.budget.reserve(len(chunk), capture=True)
                        out.write(chunk)
                        out.flush()
                    except StabilityError as exc:
                        self.budget.set_failure(exc)
                        discard = True
        except Exception as exc:
            self.budget.set_failure(StabilityError("OUTPUT_CAPTURE_FAILURE", repr(exc)))
        finally:
            try:
                self.stream.close()
            except Exception:
                pass

    def join(self, timeout: float) -> None:
        if self._started:
            self._thread.join(timeout=max(0.0, timeout))


def _owner_bootstrap_allowed() -> bool:
    # __name__ is only a routing condition. Native process facts are the gate.
    # runpy and a spoofed sys.argv cannot turn another script into this owner.
    if __name__ != "__main__":
        return False
    try:
        _owner_boundary.require_owner_process(SCRIPT_PATH)
    except _owner_boundary.OwnerBoundaryError:
        return False
    return True


if _owner_bootstrap_allowed():
    class OwnedServerProcess:
        __slots__ = ("pid", "label", "scenario", "start_index")

        def __init__(self, *args: Any, **kwargs: Any):
            raise StabilityError(
                "OWNED_PROCESS_CONSTRUCTION_FORBIDDEN",
                "owned process wrappers are created only by the internally registered start_server path",
            )


    class ValidatedExecutionContext:
        __slots__ = (
            "profile", "output_dir", "events_path", "attempt_guard", "started_monotonic", "deadline",
            "budget", "server_start_count", "physical_identity",
        )

        def __init__(self, *args: Any, **kwargs: Any):
            raise StabilityError(
                "EXECUTION_CONTEXT_CONSTRUCTION_FORBIDDEN",
                "context can be created only by authorize_execution after the full fail-closed gate",
            )

        def check_limits(self) -> None:
            _require_ctx(self)
            self.budget.raise_if_failed()
            if time.monotonic() >= self.deadline:
                raise StabilityError("MAX_WALL_TIME_EXCEEDED", f"limit={EXPECTED_MAX_WALL_TIME}")

        def remaining_time(self, ceiling: float | None = None) -> float:
            self.check_limits()
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise StabilityError("MAX_WALL_TIME_EXCEEDED", f"limit={EXPECTED_MAX_WALL_TIME}")
            if ceiling is not None:
                remaining = min(remaining, ceiling)
            return max(0.001, remaining)


    def _build_execution_authority_registry():
        valid_contexts: dict[int, dict[str, Any]] = {}
        owned_processes: dict[int, dict[int, tuple[OwnedServerProcess, subprocess.Popen[Any], str, str, int, BoundedCapture, BoundedCapture]]] = {}

        def digest(value: Any) -> str:
            return hashlib.sha256(canonical_json(value)).hexdigest()

        def create_context(
            profile: dict[str, Any],
            output_dir: Path,
            attempt_guard: Path,
            started_monotonic: float,
            budget: OutputBudget,
            physical_identity: dict[str, Any],
        ) -> ValidatedExecutionContext:
            _owner_boundary.require_owner_process(SCRIPT_PATH)
            ctx = object.__new__(ValidatedExecutionContext)
            object.__setattr__(ctx, "profile", profile)
            object.__setattr__(ctx, "output_dir", output_dir)
            object.__setattr__(ctx, "events_path", output_dir / "M1RuntimeStabilityEvents.jsonl")
            object.__setattr__(ctx, "attempt_guard", attempt_guard)
            object.__setattr__(ctx, "started_monotonic", started_monotonic)
            object.__setattr__(ctx, "deadline", started_monotonic + EXPECTED_MAX_WALL_TIME)
            object.__setattr__(ctx, "budget", budget)
            object.__setattr__(ctx, "server_start_count", 0)
            object.__setattr__(ctx, "physical_identity", physical_identity)
            valid_contexts[id(ctx)] = {
                "ctx": ctx,
                "profile_digest": digest(profile),
                "output_dir": output_dir,
                "attempt_guard": attempt_guard,
                "started_monotonic": started_monotonic,
                "deadline": started_monotonic + EXPECTED_MAX_WALL_TIME,
                "budget": budget,
                "server_start_count": 0,
                "physical_identity_digest": digest(physical_identity),
            }
            owned_processes[id(ctx)] = {}
            return ctx

        def require_ctx(ctx: Any) -> ValidatedExecutionContext:
            if not isinstance(ctx, ValidatedExecutionContext):
                raise StabilityError("EXECUTION_CONTEXT_REQUIRED", "effectful entry point requires ValidatedExecutionContext")
            record = valid_contexts.get(id(ctx))
            if record is None or record.get("ctx") is not ctx:
                raise StabilityError(
                    "EXECUTION_CONTEXT_REQUIRED",
                    "context is not registered by the original authorize_execution gate",
                )
            try:
                profile_digest = digest(ctx.profile)
                physical_digest = digest(ctx.physical_identity)
            except Exception as exc:
                raise StabilityError("EXECUTION_CONTEXT_TAMPERED", repr(exc))
            if (
                profile_digest != record["profile_digest"]
                or ctx.output_dir != record["output_dir"]
                or ctx.attempt_guard != record["attempt_guard"]
                or ctx.started_monotonic != record["started_monotonic"]
                or ctx.deadline != record["deadline"]
                or ctx.budget is not record["budget"]
                or ctx.server_start_count != record["server_start_count"]
                or physical_digest != record["physical_identity_digest"]
            ):
                raise StabilityError(
                    "EXECUTION_CONTEXT_TAMPERED",
                    "validated execution context state changed after authorization",
                )
            return ctx

        def create_owned_process(
            ctx: ValidatedExecutionContext,
            proc: subprocess.Popen[Any],
            label: str,
            scenario: str,
            stdout_capture: BoundedCapture,
            stderr_capture: BoundedCapture,
        ) -> OwnedServerProcess:
            _owner_boundary.require_owner_process(SCRIPT_PATH)
            require_ctx(ctx)
            record = valid_contexts[id(ctx)]
            start_index = int(record["server_start_count"]) + 1
            if start_index > EXPECTED_MAX_SERVER_STARTS:
                raise StabilityError("MAX_SERVER_STARTS_EXCEEDED", f"count={record['server_start_count']}")
            owned = object.__new__(OwnedServerProcess)
            object.__setattr__(owned, "pid", proc.pid)
            object.__setattr__(owned, "label", label)
            object.__setattr__(owned, "scenario", scenario)
            object.__setattr__(owned, "start_index", start_index)
            owned_processes[id(ctx)][id(owned)] = (
                owned, proc, label, scenario, start_index, stdout_capture, stderr_capture,
            )
            record["server_start_count"] = start_index
            object.__setattr__(ctx, "server_start_count", start_index)
            return owned

        def require_owned(
            ctx: ValidatedExecutionContext,
            owned: Any,
        ) -> tuple[subprocess.Popen[Any], str, str, int, BoundedCapture, BoundedCapture]:
            require_ctx(ctx)
            if not isinstance(owned, OwnedServerProcess):
                raise StabilityError(
                    "FOREIGN_PROCESS_REJECTED",
                    "kill/cleanup accepts only internally registered orchestrator-owned process wrappers",
                )
            entry = owned_processes.get(id(ctx), {}).get(id(owned))
            if entry is None or entry[0] is not owned:
                raise StabilityError(
                    "FOREIGN_PROCESS_REJECTED",
                    "wrapper identity was not created and registered by start_server in this execution context",
                )
            _, proc, label, scenario, start_index, stdout_capture, stderr_capture = entry
            return proc, label, scenario, start_index, stdout_capture, stderr_capture

        return create_context, require_ctx, create_owned_process, require_owned


    _create_validated_context, _require_ctx, _create_owned_process, _require_owned = _build_execution_authority_registry()


    def claim_attempt_guard(profile: dict[str, Any], output_dir: Path) -> Path:
        if profile.get("max_attempts") != 1:
            raise StabilityError("MAX_ATTEMPTS_DRIFT", str(profile.get("max_attempts")))
        guard = EXPECTED_ATTEMPT_GUARD_PATH
        guard.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "profile_id": profile.get("profile_id"),
            "claimed_at_utc": now_utc(),
            "output_dir": str(output_dir.resolve()),
            "semantics": "FIRST_EFFECTFUL_ATTEMPT_CONSUMES_PROFILE / NO_REUSE_AFTER_SUCCESS_OR_FAILURE",
        }
        try:
            with guard.open("x", encoding="utf-8", newline="\n") as f:
                f.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        except FileExistsError:
            raise StabilityError("MAX_ATTEMPTS_EXCEEDED", str(guard))
        return guard


    def _make_authorize_execution(create_validated_context):
        def authorize_execution(profile: dict[str, Any], output_dir: Path) -> ValidatedExecutionContext:
            _owner_boundary.require_owner_process(SCRIPT_PATH)
            ready, reason = validate_execution_profile(profile)
            if not ready:
                raise StabilityError("EXECUTION_AUTHORIZATION_BLOCKED", reason)
            physical = verify_physical_device_identity(profile)
            output_dir.mkdir(parents=True, exist_ok=False)
            started = time.monotonic()
            guard = claim_attempt_guard(profile, output_dir)
            budget = OutputBudget(EXPECTED_MAX_STORAGE, initial_used=guard.stat().st_size)
            ctx = create_validated_context(profile, output_dir, guard, started, budget, physical)
            event(ctx, "PROFILE", "attempt_guard_claimed", path=str(guard))
            event(ctx, "PROFILE", "physical_device_bound", **physical)
            return ctx

        return authorize_execution


    authorize_execution = _make_authorize_execution(_create_validated_context)
    del _make_authorize_execution, _create_validated_context


    def event(ctx: ValidatedExecutionContext, scenario: str, kind: str, **extra: Any) -> None:
        _require_ctx(ctx)
        ctx.check_limits()
        ctx.budget.append_jsonl(
            ctx.events_path,
            {"ts_utc": now_utc(), "scenario": scenario, "kind": kind, **extra},
        )


    def write_json(ctx: ValidatedExecutionContext, path: Path, value: Any) -> None:
        _require_ctx(ctx)
        ctx.check_limits()
        ctx.budget.write_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


    def preflight(ctx: ValidatedExecutionContext) -> dict[str, Any]:
        _require_ctx(ctx)
        profile = ctx.profile
        cfg = server_config(profile)
        if cfg.get("host") != EXPECTED_HOST or cfg.get("external_bind") is not False:
            raise StabilityError("NON_LOOPBACK_BIND", "server must bind only to 127.0.0.1")
        if cfg.get("offline") is not True or cfg.get("external_network") is not False:
            raise StabilityError("EXTERNAL_NETWORK_BOUNDARY", "offline/loopback-only boundary missing")
        if cfg.get("device") != "none" or cfg.get("n_gpu_layers") != 0 or cfg.get("op_offload") is not False:
            raise StabilityError("GPU_OFFLOAD_BOUNDARY", "strict CPU-only boundary missing")

        runtime = runtime_binding(profile)
        model = model_binding(profile)
        server_path = Path(runtime["package_root"]) / "runtime" / "b11033-vulkan" / runtime["server_executable"]
        model_path = Path(runtime["exact_model_path"])
        if not server_path.is_file():
            raise StabilityError("SERVER_EXECUTABLE_MISSING", str(server_path))
        if not model_path.is_file():
            raise StabilityError("MODEL_PATH_MISSING", str(model_path))

        server_bytes = server_path.stat().st_size
        model_bytes = model_path.stat().st_size
        server_sha = sha256_file(server_path, ctx)
        model_sha = sha256_file(model_path, ctx)
        if server_bytes != EXPECTED_SERVER_BYTES or server_sha != EXPECTED_SERVER_SHA256:
            raise StabilityError("SERVER_EXECUTABLE_DIGEST_DRIFT", server_sha)
        if model_bytes != EXPECTED_MODEL_BYTES or model_sha != EXPECTED_MODEL_SHA256:
            raise StabilityError("MODEL_DIGEST_DRIFT", model_sha)

        host = cfg["host"]
        port = int(cfg["port"])
        if not port_is_free(host, port):
            raise StabilityError("PORT_ALREADY_IN_USE", f"{host}:{port}")

        result = {
            "profile_id": profile.get("profile_id"),
            "checked_at_utc": now_utc(),
            "device_logical_name": ctx.physical_identity["logical_name"],
            "machine_identity_source": ctx.physical_identity["machine_identity_source"],
            "machine_identity_sha256": ctx.physical_identity["machine_identity_sha256"],
            "server_path": str(server_path),
            "server_bytes": server_bytes,
            "server_sha256": server_sha,
            "model_path": str(model_path),
            "model_bytes": model_bytes,
            "model_sha256": model_sha,
            "host": host,
            "port": port,
            "port_free": True,
        }
        write_json(ctx, ctx.output_dir / "M1RuntimeStabilityPreflight.json", result)
        return result


    def port_is_free(host: str, port: int) -> bool:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
            sock.bind((host, port))
            return True
        except OSError:
            return False
        finally:
            sock.close()


    def wait_port_released(ctx: ValidatedExecutionContext, host: str, port: int, timeout: float = 10.0) -> bool:
        _require_ctx(ctx)
        end = time.monotonic() + ctx.remaining_time(timeout)
        while time.monotonic() < end:
            ctx.check_limits()
            if port_is_free(host, port):
                return True
            time.sleep(min(0.2, ctx.remaining_time(0.2)))
        ctx.check_limits()
        return False


    def process_rss_bytes(proc: subprocess.Popen[Any]) -> int:
        if proc.poll() is not None:
            raise StabilityError("PROCESS_METRICS_PROCESS_EXITED", f"pid={proc.pid}")
        if os.name != "nt":
            raise StabilityError("PROCESS_METRICS_UNSUPPORTED_OS", os.name)
        import ctypes
        from ctypes import wintypes

        class PROCESS_MEMORY_COUNTERS_EX(ctypes.Structure):
            _fields_ = [
                ("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t),
                ("PrivateUsage", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESS_MEMORY_COUNTERS_EX), wintypes.DWORD]
        psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
        handle = kernel32.OpenProcess(0x0400 | 0x0010, False, proc.pid)
        if not handle:
            raise StabilityError("PROCESS_METRICS_OPEN_FAILED", f"pid={proc.pid} winerr={ctypes.get_last_error()}")
        try:
            counters = PROCESS_MEMORY_COUNTERS_EX()
            counters.cb = ctypes.sizeof(counters)
            if not psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
                raise StabilityError("PROCESS_METRICS_READ_FAILED", f"pid={proc.pid} winerr={ctypes.get_last_error()}")
            return int(counters.WorkingSetSize)
        finally:
            kernel32.CloseHandle(handle)


    def record_process_start_evidence(ctx: ValidatedExecutionContext, owned: OwnedServerProcess, command: list[str]) -> int:
        proc, label, scenario, start_index, _, _ = _require_owned(ctx, owned)
        base = {
            "ts_utc": now_utc(),
            "scenario": scenario,
            "sample": "process-start",
            "start_index": start_index,
            "start_label": label,
            "pid": proc.pid,
            "process_created": True,
            "command": command,
        }
        try:
            rss = process_rss_bytes(proc)
            base.update({"initial_rss_bytes": rss, "rss_capture_succeeded": True})
            ctx.budget.append_jsonl(
                ctx.output_dir / "M1RuntimeStabilityProcessMetrics.jsonl",
                base,
                allow_after_failure=True,
            )
            return rss
        except Exception as exc:
            if isinstance(exc, StabilityError):
                code = exc.code
                message = str(exc)
            else:
                code = "PROCESS_METRICS_READ_FAILED"
                message = repr(exc)
            base.update({
                "initial_rss_bytes": None,
                "rss_capture_succeeded": False,
                "rss_failure_code": code,
                "rss_failure_message": message,
            })
            ctx.budget.append_jsonl(
                ctx.output_dir / "M1RuntimeStabilityProcessMetrics.jsonl",
                base,
                allow_after_failure=True,
            )
            raise StabilityError(code, message)


    def record_process_metrics(ctx: ValidatedExecutionContext, owned: OwnedServerProcess, sample: str) -> int:
        proc, label, scenario, start_index, _, _ = _require_owned(ctx, owned)
        ctx.check_limits()
        rss = process_rss_bytes(proc)
        ctx.budget.append_jsonl(
            ctx.output_dir / "M1RuntimeStabilityProcessMetrics.jsonl",
            {
                "ts_utc": now_utc(),
                "scenario": scenario,
                "sample": sample,
                "start_index": start_index,
                "start_label": label,
                "pid": proc.pid,
                "rss_bytes": rss,
                "process_alive": proc.poll() is None,
            },
        )
        return rss


    def directory_size_bytes(ctx: ValidatedExecutionContext, root: Path) -> int:
        _require_ctx(ctx)
        total = 0
        for p in root.rglob("*"):
            ctx.check_limits()
            if p.is_file():
                total += p.stat().st_size
        return total


    def enforce_output_storage_budget(ctx: ValidatedExecutionContext) -> int:
        _require_ctx(ctx)
        ctx.budget.raise_if_failed()
        used = directory_size_bytes(ctx, ctx.output_dir) + ctx.attempt_guard.stat().st_size
        if used > EXPECTED_MAX_STORAGE:
            raise StabilityError("OUTPUT_STORAGE_BUDGET_EXCEEDED", f"used={used} limit={EXPECTED_MAX_STORAGE}")
        return used


    def build_server_command(profile: dict[str, Any]) -> list[str]:
        cfg = server_config(profile)
        runtime = runtime_binding(profile)
        server_path = Path(runtime["package_root"]) / "runtime" / "b11033-vulkan" / runtime["server_executable"]
        model_path = Path(runtime["exact_model_path"])
        return [
            str(server_path), "--model", str(model_path), "--offline",
            "--host", str(cfg["host"]), "--port", str(cfg["port"]), "--no-webui",
            "--threads", str(cfg["threads"]), "--threads-batch", str(cfg["threads_batch"]),
            "--ctx-size", str(cfg["ctx_size"]), "--parallel", str(cfg["parallel"]),
            "--n-gpu-layers", str(cfg["n_gpu_layers"]), "--device", str(cfg["device"]), "--no-op-offload",
        ]


    def _make_start_server(create_owned_process):
        def start_server(ctx: ValidatedExecutionContext, scenario: str, label: str) -> tuple[OwnedServerProcess, list[str]]:
            _owner_boundary.require_owner_process(SCRIPT_PATH)
            _require_ctx(ctx)
            ctx.check_limits()
            if ctx.server_start_count >= EXPECTED_MAX_SERVER_STARTS:
                raise StabilityError("MAX_SERVER_STARTS_EXCEEDED", f"count={ctx.server_start_count}")
            cmd = build_server_command(ctx.profile)
            creationflags = 0
            startupinfo = None
            if os.name == "nt":
                creationflags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                startupinfo.wShowWindow = 0

            stdout_path = ctx.output_dir / f"{label}.stdout.txt"
            stderr_path = ctx.output_dir / f"{label}.stderr.txt"
            ctx.budget.write_bytes(stdout_path, b"")
            ctx.budget.write_bytes(stderr_path, b"")

            proc = subprocess.Popen(
                cmd,
                cwd=str(Path(cmd[0]).parent),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                creationflags=creationflags,
                startupinfo=startupinfo,
            )
            stdout_capture = BoundedCapture(proc.stdout, stdout_path, ctx.budget)
            stderr_capture = BoundedCapture(proc.stderr, stderr_path, ctx.budget)
            owned = create_owned_process(ctx, proc, label, scenario, stdout_capture, stderr_capture)
            start_index = owned.start_index
            stdout_capture.start()
            stderr_capture.start()
            try:
                initial_rss = record_process_start_evidence(ctx, owned, cmd)
                event(ctx, scenario, "server_started", start_index=start_index, label=label, pid=proc.pid, command=cmd, initial_rss_bytes=initial_rss)
                return owned, cmd
            except Exception:
                _safe_cleanup_owned(ctx, owned)
                raise

        return start_server


    start_server = _make_start_server(_create_owned_process)
    del _make_start_server, _create_owned_process, _build_execution_authority_registry


    def owned_process_alive(ctx: ValidatedExecutionContext, owned: OwnedServerProcess) -> bool:
        proc, _, _, _, _, _ = _require_owned(ctx, owned)
        return proc.poll() is None


    def owned_process_pid(ctx: ValidatedExecutionContext, owned: OwnedServerProcess) -> int:
        proc, _, _, _, _, _ = _require_owned(ctx, owned)
        return int(proc.pid)


    def _cleanup_timeout(ctx: ValidatedExecutionContext, ceiling: float) -> float:
        remaining = ctx.deadline - time.monotonic()
        if remaining <= 0:
            return min(1.0, ceiling)
        return max(0.05, min(ceiling, remaining))


    def _close_captures(ctx: ValidatedExecutionContext, owned: OwnedServerProcess, raise_budget_failure: bool = True) -> None:
        _, _, _, _, stdout_capture, stderr_capture = _require_owned(ctx, owned)
        timeout = _cleanup_timeout(ctx, 2.0)
        stdout_capture.join(timeout)
        stderr_capture.join(timeout)
        if raise_budget_failure:
            ctx.budget.raise_if_failed()


    def graceful_stop_owned(ctx: ValidatedExecutionContext, owned: OwnedServerProcess, timeout: float = 10.0) -> bool:
        proc, _, _, _, _, _ = _require_owned(ctx, owned)
        ctx.check_limits()
        if proc.poll() is not None:
            _close_captures(ctx, owned)
            return True
        try:
            if os.name == "nt" and hasattr(signal, "CTRL_BREAK_EVENT"):
                proc.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                proc.terminate()
            proc.wait(timeout=ctx.remaining_time(timeout))
            _close_captures(ctx, owned)
            return True
        except subprocess.TimeoutExpired:
            ctx.check_limits()
            return False


    def force_kill_owned(ctx: ValidatedExecutionContext, owned: OwnedServerProcess, timeout: float = 10.0) -> None:
        _owner_boundary.require_owner_process(SCRIPT_PATH)
        proc, _, _, _, _, _ = _require_owned(ctx, owned)
        if proc.poll() is None:
            proc.kill()
        proc.wait(timeout=_cleanup_timeout(ctx, timeout))
        _close_captures(ctx, owned, raise_budget_failure=False)
        ctx.budget.raise_if_failed()


    def _safe_cleanup_owned(ctx: ValidatedExecutionContext, owned: OwnedServerProcess) -> None:
        try:
            proc, _, _, _, _, _ = _require_owned(ctx, owned)
            if proc.poll() is None:
                proc.kill()
                try:
                    proc.wait(timeout=_cleanup_timeout(ctx, 5.0))
                except Exception:
                    pass
            _close_captures(ctx, owned, raise_budget_failure=False)
        except Exception:
            pass


    def request_json(
        ctx: ValidatedExecutionContext,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        timeout: float = 10.0,
    ) -> tuple[int, Any]:
        _require_ctx(ctx)
        cfg = server_config(ctx.profile)
        conn = http.client.HTTPConnection(cfg["host"], int(cfg["port"]), timeout=ctx.remaining_time(timeout))
        try:
            body = None if payload is None else json.dumps(payload).encode("utf-8")
            headers = {} if body is None else {"Content-Type": "application/json"}
            conn.request(method, path, body=body, headers=headers)
            resp = conn.getresponse()
            raw = resp.read()
            ctx.check_limits()
            try:
                data = json.loads(raw.decode("utf-8")) if raw else None
            except Exception:
                data = raw.decode("utf-8", errors="replace")
            return resp.status, data
        finally:
            conn.close()


    def wait_health(ctx: ValidatedExecutionContext, timeout: float = 60.0) -> float:
        _require_ctx(ctx)
        start = time.monotonic()
        local_end = start + ctx.remaining_time(timeout)
        last_error = ""
        while time.monotonic() < local_end:
            ctx.check_limits()
            try:
                status, _ = request_json(ctx, "GET", "/health", timeout=min(2.0, ctx.remaining_time(2.0)))
                if 200 <= status < 300:
                    return time.monotonic() - start
                last_error = f"status={status}"
            except StabilityError:
                raise
            except Exception as exc:
                last_error = repr(exc)
            time.sleep(min(0.25, ctx.remaining_time(0.25)))
        ctx.check_limits()
        raise StabilityError("HEALTH_TIMEOUT", last_error)


    def minimal_probe(ctx: ValidatedExecutionContext) -> dict[str, Any]:
        status, data = request_json(
            ctx, "POST", "/completion",
            {"prompt": "Reply with exactly: OK", "n_predict": 8, "temperature": 0, "stream": False},
            timeout=30.0,
        )
        if not (200 <= status < 300):
            raise StabilityError("PROBE_HTTP_FAILURE", f"status={status}")
        return {"status": status, "response": data}


    def open_stream(ctx: ValidatedExecutionContext) -> tuple[http.client.HTTPConnection, http.client.HTTPResponse, bytes]:
        _require_ctx(ctx)
        cfg = server_config(ctx.profile)
        conn = http.client.HTTPConnection(cfg["host"], int(cfg["port"]), timeout=ctx.remaining_time(30.0))
        payload = json.dumps({
            "prompt": "Count upward from 1 and keep going with one number per token.",
            "n_predict": 512,
            "temperature": 0,
            "stream": True,
        }).encode("utf-8")
        try:
            conn.request("POST", "/completion", body=payload, headers={"Content-Type": "application/json"})
            resp = conn.getresponse()
            if not (200 <= resp.status < 300):
                conn.close()
                raise StabilityError("STREAM_HTTP_FAILURE", f"status={resp.status}")
            first = resp.read(1)
            ctx.check_limits()
            if not first:
                conn.close()
                raise StabilityError("STREAM_NO_DATA", "stream ended before cancellation point")
            return conn, resp, first
        except Exception:
            try:
                conn.close()
            except Exception:
                pass
            raise


    def stream_then_cancel(ctx: ValidatedExecutionContext) -> dict[str, Any]:
        conn, resp, first = open_stream(ctx)
        try:
            return {"http_status": resp.status, "first_byte_hex": first.hex(), "cancelled_by_client_close": True}
        finally:
            conn.close()


    def sleep_with_deadline(ctx: ValidatedExecutionContext, seconds: float) -> None:
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            ctx.check_limits()
            time.sleep(min(0.25, end - time.monotonic(), ctx.remaining_time(0.25)))


    def run_load_cycles(ctx: ValidatedExecutionContext) -> dict[str, Any]:
        _require_ctx(ctx)
        cfg = server_config(ctx.profile)
        rows = []
        for i in range(1, 4):
            label = f"load-{i:02d}"
            owned, _ = start_server(ctx, "M1-07-PC-LOAD-001", label)
            try:
                ready = wait_health(ctx)
                rss = record_process_metrics(ctx, owned, f"cycle-{i}-ready")
                probe = minimal_probe(ctx)
                event(ctx, "M1-07-PC-LOAD-001", "ready", cycle=i, pid=owned_process_pid(ctx, owned), readiness_seconds=ready, rss_bytes=rss)
                graceful = graceful_stop_owned(ctx, owned)
                if not graceful:
                    raise StabilityError("GRACEFUL_STOP_FAILED", f"cycle={i}")
                if not wait_port_released(ctx, cfg["host"], int(cfg["port"])):
                    raise StabilityError("PORT_RELEASE_TIMEOUT", f"cycle={i}")
                rows.append({"cycle": i, "pid": owned_process_pid(ctx, owned), "readiness_seconds": ready, "rss_bytes": rss, "probe": probe, "graceful_exit": True})
            finally:
                _safe_cleanup_owned(ctx, owned)
        return {"scenario_id": "M1-07-PC-LOAD-001", "cycles": rows, "pass": len(rows) == 3}


    def run_cancel(ctx: ValidatedExecutionContext) -> dict[str, Any]:
        _require_ctx(ctx)
        cfg = server_config(ctx.profile)
        owned, _ = start_server(ctx, "M1-07-PC-CANCEL-001", "cancel")
        try:
            ready = wait_health(ctx)
            rss_ready = record_process_metrics(ctx, owned, "ready")
            cancelled = stream_then_cancel(ctx)
            sleep_with_deadline(ctx, 0.5)
            alive = owned_process_alive(ctx, owned)
            if not alive:
                raise StabilityError("SERVER_CRASHED_AFTER_CANCEL", "server process exited")
            post_health = wait_health(ctx, timeout=5.0)
            rss_post_cancel = record_process_metrics(ctx, owned, "post-cancel")
            probe = minimal_probe(ctx)
            graceful = graceful_stop_owned(ctx, owned)
            if not graceful or not wait_port_released(ctx, cfg["host"], int(cfg["port"])):
                raise StabilityError("CANCEL_CLEANUP_FAILED", "server did not exit/release port")
            return {
                "scenario_id": "M1-07-PC-CANCEL-001", "readiness_seconds": ready,
                "rss_ready_bytes": rss_ready, "rss_post_cancel_bytes": rss_post_cancel,
                "cancel": cancelled, "server_alive_after_cancel": alive,
                "post_cancel_health_seconds": post_health, "post_cancel_probe": probe, "pass": True,
            }
        finally:
            _safe_cleanup_owned(ctx, owned)


    def run_background_reconnect(ctx: ValidatedExecutionContext) -> dict[str, Any]:
        _require_ctx(ctx)
        cfg = server_config(ctx.profile)
        owned, _ = start_server(ctx, "M1-07-PC-BACKGROUND-001", "background")
        pid = owned_process_pid(ctx, owned)
        try:
            ready = wait_health(ctx)
            rss_ready = record_process_metrics(ctx, owned, "ready")
            status, _ = request_json(ctx, "GET", "/health", timeout=2.0)
            if not (200 <= status < 300):
                raise StabilityError("BACKGROUND_INITIAL_HEALTH_FAILED", str(status))
            sleep_with_deadline(ctx, 10.0)
            same_pid_alive = owned_process_alive(ctx, owned)
            if not same_pid_alive:
                raise StabilityError("BACKGROUND_SERVER_EXITED", "server exited while controller detached")
            reconnect = wait_health(ctx, timeout=5.0)
            rss_reconnect = record_process_metrics(ctx, owned, "fresh-client-reconnect")
            probe = minimal_probe(ctx)
            graceful = graceful_stop_owned(ctx, owned)
            if not graceful or not wait_port_released(ctx, cfg["host"], int(cfg["port"])):
                raise StabilityError("BACKGROUND_CLEANUP_FAILED", "server did not exit/release port")
            return {
                "scenario_id": "M1-07-PC-BACKGROUND-001",
                "semantics": "PC_BACKGROUND_SERVICE_CONTINUITY_ONLY / NOT_MOBILE_APP_BACKGROUND_RESUME",
                "pid": pid, "readiness_seconds": ready, "rss_ready_bytes": rss_ready,
                "rss_reconnect_bytes": rss_reconnect, "same_pid_alive_after_10s_no_client": same_pid_alive,
                "reconnect_health_seconds": reconnect, "probe": probe, "pass": True,
            }
        finally:
            _safe_cleanup_owned(ctx, owned)


    def run_crash_restart(ctx: ValidatedExecutionContext) -> dict[str, Any]:
        _require_ctx(ctx)
        cfg = server_config(ctx.profile)
        owned, _ = start_server(ctx, "M1-07-PC-CRASH-001", "crash-before")
        first_pid = owned_process_pid(ctx, owned)
        try:
            ready1 = wait_health(ctx)
            rss_before_crash = record_process_metrics(ctx, owned, "pre-crash-ready")
            stream_conn, stream_resp, first = open_stream(ctx)
            event(
                ctx, "M1-07-PC-CRASH-001", "active_stream_observed",
                pid=first_pid, http_status=stream_resp.status, first_byte_hex=first.hex(),
            )
            try:
                force_kill_owned(ctx, owned)
                event(ctx, "M1-07-PC-CRASH-001", "forced_crash_during_active_stream", pid=first_pid)
            finally:
                stream_conn.close()
            if not wait_port_released(ctx, cfg["host"], int(cfg["port"])):
                raise StabilityError("CRASH_PORT_RELEASE_TIMEOUT", "port not released after forced crash")

            owned2, _ = start_server(ctx, "M1-07-PC-CRASH-001", "crash-after")
            second_pid = owned_process_pid(ctx, owned2)
            event(ctx, "M1-07-PC-CRASH-001", "server_restarted", pid=second_pid)
            try:
                ready2 = wait_health(ctx)
                rss_after_restart = record_process_metrics(ctx, owned2, "post-restart-ready")
                probe = minimal_probe(ctx)
                graceful = graceful_stop_owned(ctx, owned2)
                if not graceful or not wait_port_released(ctx, cfg["host"], int(cfg["port"])):
                    raise StabilityError("RESTART_CLEANUP_FAILED", "restarted server did not exit/release port")
            finally:
                _safe_cleanup_owned(ctx, owned2)

            return {
                "scenario_id": "M1-07-PC-CRASH-001", "first_pid": first_pid, "second_pid": second_pid,
                "first_readiness_seconds": ready1, "restart_readiness_seconds": ready2,
                "rss_before_crash_bytes": rss_before_crash, "rss_after_restart_bytes": rss_after_restart,
                "post_restart_probe": probe, "pass": True,
            }
        finally:
            _safe_cleanup_owned(ctx, owned)


    def run(ctx: ValidatedExecutionContext) -> dict[str, Any]:
        _require_ctx(ctx)
        ctx.check_limits()
        pre = preflight(ctx)
        event(ctx, "PROFILE", "preflight_pass", **pre)
        enforce_output_storage_budget(ctx)

        load = run_load_cycles(ctx)
        write_json(ctx, ctx.output_dir / "M1RuntimeStabilityLoad.json", load)
        enforce_output_storage_budget(ctx)

        cancel = run_cancel(ctx)
        write_json(ctx, ctx.output_dir / "M1RuntimeStabilityCancel.json", cancel)
        enforce_output_storage_budget(ctx)

        background = run_background_reconnect(ctx)
        write_json(ctx, ctx.output_dir / "M1RuntimeStabilityBackgroundReconnect.json", background)
        enforce_output_storage_budget(ctx)

        crash = run_crash_restart(ctx)
        write_json(ctx, ctx.output_dir / "M1RuntimeStabilityCrashRestart.json", crash)
        enforce_output_storage_budget(ctx)

        runtime = runtime_binding(ctx.profile)
        model = model_binding(ctx.profile)
        server_path = Path(runtime["package_root"]) / "runtime" / "b11033-vulkan" / runtime["server_executable"]
        model_path = Path(runtime["exact_model_path"])
        digests = {
            "model_sha256_post": sha256_file(model_path, ctx),
            "model_sha256_expected": model["sha256"],
            "server_sha256_post": sha256_file(server_path, ctx),
            "server_sha256_expected": runtime["server_executable_sha256"],
        }
        digests["pass"] = (
            digests["model_sha256_post"] == digests["model_sha256_expected"]
            and digests["server_sha256_post"] == digests["server_sha256_expected"]
        )
        write_json(ctx, ctx.output_dir / "M1RuntimeStabilityDigests.json", digests)
        if not digests["pass"]:
            raise StabilityError("POST_RUN_DIGEST_DRIFT", json.dumps(digests))

        ctx.check_limits()
        final_storage = enforce_output_storage_budget(ctx)
        final_wall = time.monotonic() - ctx.started_monotonic
        summary = {
            "profile_id": ctx.profile["profile_id"], "attempt_guard": str(ctx.attempt_guard),
            "started_at_utc": pre["checked_at_utc"], "ended_at_utc": now_utc(),
            "wall_seconds": round(final_wall, 3), "output_storage_bytes": final_storage,
            "load": load["pass"], "cancel": cancel["pass"], "background_reconnect": background["pass"],
            "crash_restart": crash["pass"], "post_run_digests": digests["pass"],
            "pass": all([load["pass"], cancel["pass"], background["pass"], crash["pass"], digests["pass"]]),
        }
        write_json(ctx, ctx.output_dir / "M1RuntimeStabilityCloseout.json", summary)
        ctx.check_limits()
        enforce_output_storage_budget(ctx)
        return summary

else:
    # Import is a validate-only facade. These are diagnostics, NOT capabilities.
    # There is no registry, writer, installer, RPC channel, or activation token
    # in this interpreter. Actual ownership exists only in the standalone owner.
    class OwnedServerProcess:
        __slots__ = ("pid", "label", "scenario", "start_index")

        def __init__(self, *args: Any, **kwargs: Any):
            raise StabilityError("OWNED_PROCESS_CONSTRUCTION_FORBIDDEN", "standalone owner only")

    class ValidatedExecutionContext:
        __slots__ = (
            "profile", "output_dir", "events_path", "attempt_guard", "started_monotonic",
            "deadline", "budget", "server_start_count", "physical_identity",
        )

        def __init__(self, *args: Any, **kwargs: Any):
            raise StabilityError("EXECUTION_CONTEXT_CONSTRUCTION_FORBIDDEN", "standalone owner only")

    def _require_ctx(ctx: Any) -> ValidatedExecutionContext:
        raise StabilityError("EXECUTION_CONTEXT_REQUIRED", "imported module has no execution authority")

    def _require_owned(ctx: Any, owned: Any) -> None:
        raise StabilityError("FOREIGN_PROCESS_REJECTED", "imported module owns no process")

    def authorize_execution(profile: dict[str, Any], output_dir: Path) -> ValidatedExecutionContext:
        ready, reason = validate_execution_profile(profile)
        if not ready:
            raise StabilityError("EXECUTION_AUTHORIZATION_BLOCKED", reason)
        raise StabilityError("ISOLATED_OWNER_PROCESS_REQUIRED", "launch the exact script directly with -I -S")

    def start_server(ctx: Any, scenario: str, label: str) -> None:
        _require_ctx(ctx)

    def force_kill_owned(ctx: Any, owned: Any, timeout: float = 10.0) -> None:
        _require_owned(ctx, owned)

    def graceful_stop_owned(ctx: Any, owned: Any, timeout: float = 10.0) -> None:
        _require_owned(ctx, owned)

    def run(ctx: Any) -> None:
        _require_ctx(ctx)

# Deleting this routing helper removes an unnecessary public entry; it is NOT
# the security boundary. No callable can install the runtime into the facade.
del _owner_bootstrap_allowed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", type=Path, default=DEFAULT_CANDIDATE)
    parser.add_argument("--validate-only", action="store_true", help="validate profile readiness only; never start server")
    parser.add_argument("--execute", action="store_true", help="execute M1-07 scenarios; requires final ISSUED profile")
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()

    if args.validate_only and args.execute:
        print("ERROR: choose either --validate-only or --execute", file=sys.stderr)
        return 2
    if not args.validate_only and not args.execute:
        args.validate_only = True

    profile = load_json(args.profile)
    ready, reason = validate_execution_profile(profile)

    if args.validate_only:
        print(json.dumps({
            "profile_id": profile.get("profile_id"),
            "status": profile.get("status"),
            "effectful_authority_issued": profile.get("effectful_authority_issued"),
            "execution_ready": ready,
            "reason": reason,
            "server_started": False,
            "model_loaded": False,
        }, ensure_ascii=False))
        return 0

    if not ready:
        print(f"BLOCKED: {reason}", file=sys.stderr)
        return 3
    if args.output_dir is None:
        print("ERROR: --output-dir is required with --execute", file=sys.stderr)
        return 2

    try:
        _owner_boundary.require_owner_process(SCRIPT_PATH)
        ctx = authorize_execution(profile, args.output_dir)
        result = run(ctx)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get("pass") else 1
    except _owner_boundary.OwnerBoundaryError as exc:
        print(json.dumps({"status": "FAIL_CLOSED", "code": "ISOLATED_OWNER_PROCESS_REQUIRED", "message": str(exc), "server_started": False, "model_loaded": False}), file=sys.stderr)
        return 3
    except StabilityError as exc:
        print(json.dumps({"status": "FAIL_CLOSED", "code": exc.code, "message": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
