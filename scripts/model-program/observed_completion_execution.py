"""Bounded Source successor for the exact observed completion candidate.

No issuer, public CLI, installed Host acceptance or experiment authority exists
here. The existing trusted caller owns fresh Profile/Binding/revocation and an
atomic one-attempt consume before model load. A supplied callback is not proof.
Unlike the old wrapper, input tokens are observed in the admitted process and
bounded by the pinned runtime before decode/sample. This requires an explicitly
adopted successor, never an old Profile or pre-consume observation.
"""
import copy
import hashlib
import math
import os
from pathlib import Path
import queue
import subprocess
import threading
import types

import local_completion_execution as legacy


PATCH_SHA256 = "e5673d8758ad25963e03ac69ccb5ef1263b811197af498c77955d28ae875143f"
RUNTIME_FILES = {
    "ggml-base.dll": (966144, "35fb0d953f5150df5df52379724a11d92ae0a6706709c2966d72dcea9b7d05c6"),
    "ggml-cpu.dll": (1201152, "ef78ba74b19d1da95d20461d8f104062bd7cac488e5a6d0b3753311ed0c79841"),
    "ggml.dll": (85504, "c0ebb302e99dce7535a290ac0a46eb0d273993688a6701b6f46a2b9b10676399"),
    "libllama-common.dll": (5781504, "e3def2eb6e942da64ebea6b855ae56bbcdb6b32a20271f53d9ec5c51dbdece57"),
    "libllama-completion-impl.dll": (153600, "31ee113a8fedeae2b6ca8a32cbe7886cb40b2966c8dfe20383c7815167e2d855"),
    "libllama.dll": (3793920, "70cde42c0b48f68b51f5cce6fa62f6b9c3f3bebdafe9542200a7683428c7dacd"),
    "llama-completion.exe": (62464, "4d08c640c968f7ab4fabe2a45eaff4dc84044ed67e8895913fc076e1bb2dfe87"),
    "libc++.dll": (2000384, "81fb50f0866840d7e5a1d35d48cf31adc02f623a61d8b77daf62881e1e59401b"),
    "libunwind.dll": (183808, "b0636a4281610124704adb2be2edf5642e830d86c68b7f27dbc9c8154705a780"),
}
PLAN_FIELDS = {"executable", "working_directory", "runtime_files", "model", "prompt",
               "output_schema", "observation_path", "patch_sha256", "budget",
               "deadline_monotonic"}
BUDGET_FIELDS = legacy.BUDGET_FIELDS | {"observation_bytes"}
MAX_OBSERVATION_BYTES = 131072


def require(ok, code):
    if not ok:
        raise ValueError("OBSERVED_COMPLETION_" + code)


def validate_plan(plan, now):
    require(type(plan) is dict and set(plan) == PLAN_FIELDS, "PLAN_FIELDS")
    require(plan["patch_sha256"] == PATCH_SHA256, "PATCH_PIN")
    budget = plan["budget"]
    require(type(budget) is dict and set(budget) == BUDGET_FIELDS, "BUDGET_FIELDS")
    for key, ceiling in (("input_tokens", 4096), ("output_tokens", 512),
                         ("total_tokens", 4608), ("stdout_bytes", 1048576),
                         ("stderr_bytes", 1048576), ("observation_bytes", MAX_OBSERVATION_BYTES)):
        require(type(budget[key]) is int and 1 <= budget[key] <= ceiling, "BUDGET_" + key.upper())
    require(budget["output_tokens"] < budget["total_tokens"], "TOTAL_BUDGET")
    wall, end = budget["wall_seconds"], plan["deadline_monotonic"]
    require(type(wall) in (int, float) and math.isfinite(wall) and 0 < wall <= 120, "WALL")
    require(type(end) in (int, float) and math.isfinite(end) and now < end <= now + 120, "DEADLINE")
    directory = Path(plan["working_directory"])
    require(directory.is_absolute() and not str(directory).startswith(("\\\\", "//"))
            and directory.is_dir() and not directory.is_symlink()
            and str(directory.resolve()) == str(directory), "WORKING_DIRECTORY")
    exe = plan["executable"]
    require(type(exe) is dict and Path(exe.get("path", "")).name == "llama-completion.exe", "EXECUTABLE")
    rows = plan["runtime_files"]
    require(type(rows) is list and len(rows) == len(RUNTIME_FILES), "RUNTIME_CLOSURE")
    names = []
    for row in rows:
        path = legacy.file_identity(row)
        name = path.name
        require(path.parent == directory and name in RUNTIME_FILES, "RUNTIME_DIRECTORY_OR_MEMBER")
        require((row["bytes"], row["sha256"]) == RUNTIME_FILES[name], "RUNTIME_PIN")
        names.append(name)
    require(set(names) == set(RUNTIME_FILES) and len(set(names)) == len(names), "RUNTIME_CLOSURE")
    require(exe == next(row for row in rows if Path(row["path"]).name == "llama-completion.exe"), "EXECUTABLE_PIN")
    for key in ("model", "prompt", "output_schema"):
        legacy.file_identity(plan[key])
    output = Path(plan["observation_path"])
    require(output.is_absolute() and not str(output).startswith(("\\\\", "//"))
            and output.parent.is_dir() and not output.parent.is_symlink()
            and str(output.parent.resolve()) == str(output.parent)
            and str(output.resolve()) == str(output) and not output.exists(), "NEW_OBSERVATION_PATH")
    require(output.name not in ("", ".", "..") and ":" not in output.name, "OBSERVATION_NAME")
    require(str(output).casefold() not in {row["path"].casefold() for row in rows}
            | {plan[key]["path"].casefold() for key in ("model", "prompt", "output_schema")}, "OBSERVATION_ALIAS")
    return min(end, now + wall)


def command(plan, handle):
    require(type(handle) is int and handle > 0, "HANDLE")
    return legacy.command(plan) + [
        "--clued-observation-handle", str(handle),
        "--clued-input-token-limit", str(plan["budget"]["input_tokens"]),
        "--clued-total-token-limit", str(plan["budget"]["total_tokens"])]


def _opened_identity(stream):
    """Minimal same-process facts for the caller's external object validation."""
    import msvcrt
    stat = os.fstat(stream.fileno())
    return {"handle": msvcrt.get_osfhandle(stream.fileno()), "device": stat.st_dev,
            "inode": stat.st_ino, "links": stat.st_nlink, "size": stat.st_size}


def _transport(argv, cwd, env, deadline, limits, check_current, stream):
    """Private finite-child transport; local function globals, no shared patch."""
    import msvcrt
    handle = msvcrt.get_osfhandle(stream.fileno())
    require(handle > 0 and not os.get_handle_inheritable(handle), "NONINHERITABLE_PARENT_HANDLE")
    real_popen = subprocess.Popen
    inheritance_errors = []
    def launch(*args, **kwargs):
        info = subprocess.STARTUPINFO()
        info.lpAttributeList = {"handle_list": [handle]}
        kwargs["startupinfo"], kwargs["close_fds"] = info, True
        # Process creation is serialized by the trusted caller across its entire
        # Host. This function cannot protect unrelated os.system/Popen calls.
        os.set_handle_inheritable(handle, True)
        process = None
        try:
            process = real_popen(*args, **kwargs)
        finally:
            try:
                os.set_handle_inheritable(handle, False)
            except Exception as exc:
                inheritance_errors.append(type(exc).__name__)
                if process is None:
                    raise
        # Return the suspended owned process even if reset failed, so the
        # transport can kill/reap it rather than lose its handle on an exception.
        return process
    namespace = dict(legacy._run_owned.__globals__)
    proxy = types.SimpleNamespace(Popen=launch, PIPE=subprocess.PIPE, DEVNULL=subprocess.DEVNULL,
                                  CREATE_NO_WINDOW=subprocess.CREATE_NO_WINDOW)
    namespace["subprocess"] = proxy
    class ObservedJob(legacy.WindowsJob):
        def assign_and_resume(self, process, stop):
            require(not inheritance_errors, "HANDLE_RESET_FAILED_BEFORE_RESUME")
            check_current("before_resume")
            return super().assign_and_resume(process, stop)
    namespace["WindowsJob"] = ObservedJob
    run = types.FunctionType(legacy._run_owned.__code__, namespace,
                             "private_observed_transport", legacy._run_owned.__defaults__)
    def checked(phase):
        require(not inheritance_errors, "HANDLE_RESET_FAILED")
        check_current(phase)
    result = run(argv, cwd, env, deadline, limits, checked)
    try:
        require(not os.get_handle_inheritable(handle), "PARENT_HANDLE_NOT_RESET")
    except Exception as exc:
        result["outcome"], result["detail"] = "CLEANUP_UNVERIFIED", type(exc).__name__
        result["owned_cleanup_verified"] = False
    if inheritance_errors:
        result["outcome"], result["detail"] = "CLEANUP_UNVERIFIED", inheritance_errors[0]
        result["owned_cleanup_verified"] = False
    return result


def _capture_observation(stream, maximum, deadline):
    legacy.at_deadline(deadline)
    stream.seek(0)
    raw = stream.read(maximum + 1)
    late = legacy.time.monotonic() >= deadline
    truncated = len(raw) > maximum
    retained = raw[:maximum]
    return {"raw": retained, "sha256": hashlib.sha256(retained).hexdigest(),
            "retained_bytes": len(retained), "observed_bytes": len(raw),
            "truncated": truncated, "complete": not truncated and not late,
            "read_error": False, "late": late}


def execute_observed_completion(plan, *, boundary):
    """Caller must qualify and serialize launch/namespace; no authority minted."""
    require(callable(boundary), "TRUSTED_BOUNDARY_REQUIRED")
    start = legacy.time.monotonic()
    frozen = copy.deepcopy(plan)
    seal = legacy.digest(frozen)
    end = frozen.get("deadline_monotonic") if type(frozen) is dict else None
    wall = frozen.get("budget", {}).get("wall_seconds") if type(frozen) is dict else None
    require(type(end) in (int, float) and math.isfinite(end) and start < end <= start + 120, "DEADLINE")
    require(type(wall) in (int, float) and math.isfinite(wall) and 0 < wall <= 120, "WALL")
    end = min(end, start + wall)
    opened = None
    def check(phase):
        view, reply = copy.deepcopy(frozen), queue.Queue(maxsize=1)
        object_view = copy.deepcopy(opened)
        object_seal = legacy.digest(object_view)
        def invoke():
            try:
                response = boundary(phase, view, seal, object_view)
                require(response is None and legacy.digest(view) == seal, "BOUNDARY_RESULT_OR_MUTATION")
                require(legacy.digest(object_view) == object_seal, "BOUNDARY_OBJECT_MUTATION")
                reply.put(None)
            except BaseException as exc:
                reply.put(exc)
        threading.Thread(target=invoke, daemon=True).start()
        try:
            error = reply.get(timeout=max(0.001, end - legacy.time.monotonic()))
        except queue.Empty as exc:
            raise TimeoutError("Boundary status unresolved; no launch or retry") from exc
        if error is not None:
            raise error
    check("preflight")
    require(os.name == "nt", "WINDOWS_ONLY")
    deadline = end - legacy.CLEANUP_RESERVE_SECONDS
    require(legacy.time.monotonic() < deadline, "CLEANUP_RESERVATION")
    validate_plan(frozen, legacy.time.monotonic())
    for row in frozen["runtime_files"] + [frozen[k] for k in ("model", "prompt", "output_schema")]:
        legacy.verify_file(row, deadline)
    check("before_observation_open")
    require(legacy.time.monotonic() < deadline, "DEADLINE_BEFORE_OBSERVATION_OPEN")
    # The caller verifies the new-only private output namespace before this open.
    # x+b rejects overwrite; it does not itself prove ACL, links or file ownership.
    path = Path(frozen["observation_path"])
    result = None
    stream = path.open("x+b")
    try:
        # A late file-open return cannot start a new consume or model load.
        require(legacy.time.monotonic() < deadline, "DEADLINE_AFTER_OBSERVATION_OPEN")
        opened = _opened_identity(stream)
        require(legacy.time.monotonic() < deadline, "DEADLINE_AFTER_OBJECT_IDENTITY")
        require(opened["size"] == 0 and opened["links"] == 1, "NEW_OBSERVATION_OBJECT")
        check("observation_opened")  # Caller revalidates the actual new object/namespace.
        require(legacy.time.monotonic() < deadline, "DEADLINE_BEFORE_CONSUME")
        check("consume")  # Atomic attempt reservation before any model/backend load.
        require(legacy.time.monotonic() < deadline, "DEADLINE_AFTER_CONSUME")
        end = deadline
        import msvcrt
        handle = msvcrt.get_osfhandle(stream.fileno())
        result = _transport(command(frozen, handle), frozen["working_directory"],
            legacy.clean_environment(), deadline,
            {k: frozen["budget"][k + "_bytes"] for k in ("stdout", "stderr")}, check, stream)
        try:
            observed = _capture_observation(stream, frozen["budget"]["observation_bytes"], end + legacy.CLEANUP_RESERVE_SECONDS)
        except Exception as exc:
            observed = {"raw": None, "sha256": None, "retained_bytes": None,
                        "observed_bytes": None, "truncated": None, "complete": False,
                        "read_error": True, "error_type": type(exc).__name__}
        result["observation_capture"] = observed
        if not observed["complete"]:
            result["execution_outcome"] = result.get("execution_outcome", result["outcome"])
            result["outcome"] = "OBSERVATION_UNVERIFIED"
    finally:
        try:
            stream.close()
        except Exception as exc:
            if result is not None:
                result["outcome"], result["detail"] = "CLEANUP_UNVERIFIED", type(exc).__name__
                result["owned_cleanup_verified"] = False
                result["observation_close_error"] = type(exc).__name__
            else:
                raise
    result["plan_sha256"] = seal
    result["elapsed_seconds"] = legacy.time.monotonic() - start
    result["usage"], result["model_output_validated"] = None, False
    result["authority_effect"] = "NONE"
    return result

