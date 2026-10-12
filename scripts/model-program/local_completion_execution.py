"""Private bounded process primitive for an already admitted local completion.

This is not an issuer, Host qualification, authorization reader or public CLI.
The trusted Host caller must independently verify its live Profile, exact
Binding/subject/scope, revocation and one-attempt consumption. Its boundary
callback performs those operations; injecting an arbitrary callback does not
establish that caller's trust. Missing boundary or token observation fails before
process launch. Source tests use non-model children, never the installed model.

Only an exact Windows llama-completion package is accepted by the public
primitive. Original stdout/stderr are retained with raw SHA; exit zero is not
model success, output validation, measured usage or qualification.
"""
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import signal
import subprocess
import threading
import time


MAX_FILES = 64
CLEANUP_RESERVE_SECONDS = 13  # Job 5s, parent 5s, two readers 2s, closing margin.
PLAN_FIELDS = {"executable", "working_directory", "model", "prompt", "output_schema",
               "runtime_files", "input_token_observation", "budget", "deadline_monotonic"}
BUDGET_FIELDS = {"input_tokens", "output_tokens", "total_tokens", "wall_seconds",
                 "stdout_bytes", "stderr_bytes"}


def require(condition, code):
    if not condition:
        raise ValueError("LOCAL_COMPLETION_" + code)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def at_deadline(deadline):
    if deadline is not None:
        require(time.monotonic() < deadline, "DEADLINE_DURING_VERIFICATION")


def file_identity(value, deadline=None):
    at_deadline(deadline)
    require(type(value) is dict and set(value) == {"path", "bytes", "sha256"}, "FILE_FIELDS")
    require(type(value["path"]) is str and bool(value["path"]), "FILE_PATH")
    require(type(value["bytes"]) is int and 0 < value["bytes"] <= 2147483648, "FILE_SIZE")
    sha = value["sha256"]
    require(type(sha) is str and len(sha) == 64 and all(c in "0123456789abcdef" for c in sha), "FILE_SHA")
    path = Path(value["path"])
    require(not str(path).startswith(("\\\\", "//")), "NETWORK_PATH")
    require(path.is_absolute() and path.is_file() and not path.is_symlink(), "FILE_BOUNDARY")
    require(str(path.resolve()) == str(path), "FILE_CANONICAL_PATH")
    at_deadline(deadline)
    return path


def verify_file(value, deadline=None):
    path = file_identity(value, deadline)
    observed, count = hashlib.sha256(), 0
    with path.open("rb") as stream:
        while True:
            at_deadline(deadline)
            block = stream.read(1024 * 1024)
            at_deadline(deadline)
            if not block:
                break
            count += len(block)
            require(count <= value["bytes"], "FILE_GROWTH")
            observed.update(block)
    require(count == value["bytes"] and observed.hexdigest() == value["sha256"], "FILE_DRIFT")
    at_deadline(deadline)
    return path


def validate_plan(plan, now, deadline=None):
    require(type(plan) is dict and set(plan) == PLAN_FIELDS, "PLAN_FIELDS")
    budget = plan["budget"]
    require(type(budget) is dict and set(budget) == BUDGET_FIELDS, "BUDGET_FIELDS")
    for name, ceiling in (("input_tokens", 4096), ("output_tokens", 512),
                          ("total_tokens", 4608), ("stdout_bytes", 1048576),
                          ("stderr_bytes", 1048576)):
        require(type(budget[name]) is int and 1 <= budget[name] <= ceiling, "BUDGET_" + name.upper())
    require(type(budget["wall_seconds"]) in (int, float) and math.isfinite(budget["wall_seconds"])
            and 0 < budget["wall_seconds"] <= 120, "WALL_BOUND")
    end = plan["deadline_monotonic"]
    require(type(end) in (int, float) and math.isfinite(end) and now < end <= now + 120, "DEADLINE")
    observed = plan["input_token_observation"]
    require(type(observed) is dict and set(observed) == {"count", "prompt_sha256", "reference"}, "TOKEN_OBSERVATION")
    require(type(observed["count"]) is int and 0 < observed["count"] <= budget["input_tokens"], "INPUT_TOKEN_BOUND")
    require(observed["count"] + budget["output_tokens"] <= budget["total_tokens"], "TOTAL_TOKEN_BOUND")
    require(type(observed["reference"]) is str and bool(observed["reference"]), "TOKEN_OBSERVATION_REF")
    require(observed["prompt_sha256"] == plan["prompt"]["sha256"], "TOKEN_PROMPT_IDENTITY")
    exe = file_identity(plan["executable"], deadline)
    require(exe.name == "llama-completion.exe", "FIXED_EXECUTABLE")
    directory = Path(plan["working_directory"])
    require(directory.is_absolute() and directory.is_dir() and str(directory.resolve()) == str(directory), "WORKING_DIRECTORY")
    require(exe.parent == directory, "EXECUTABLE_DIRECTORY")
    at_deadline(deadline)
    files = plan["runtime_files"]
    require(type(files) is list and 1 <= len(files) <= MAX_FILES, "RUNTIME_CLOSURE")
    paths = [str(file_identity(row, deadline)) for row in files]
    require(len(set(paths)) == len(paths) and str(exe) in paths, "RUNTIME_CLOSURE_IDS")
    require(all(Path(path).parent == directory for path in paths), "RUNTIME_DIRECTORY")
    require(next(row for row in files if row["path"] == str(exe)) == plan["executable"], "EXECUTABLE_PIN")
    for name in ("model", "prompt", "output_schema"):
        file_identity(plan[name], deadline)
    return min(end, now + budget["wall_seconds"])


def command(plan):
    """No extra argv, server, download, cache, GPU, interactive or external API."""
    return [plan["executable"]["path"], "--model", plan["model"]["path"],
            "--file", plan["prompt"]["path"], "--json-schema-file", plan["output_schema"]["path"],
            "--threads", "2", "--threads-batch", "2", "--ctx-size", "8192",
            "--predict", str(plan["budget"]["output_tokens"]), "--device", "none",
            "--gpu-layers", "0", "--no-op-offload", "--no-kv-offload", "--no-context-shift",
            "--no-conversation", "--no-warmup", "--temp", "0",
            "--seed", "1", "--no-display-prompt", "--simple-io", "--color", "off"]


def clean_environment():
    """Do not forward API tokens, proxy, model download or preloading settings."""
    names = ("SystemRoot", "WINDIR", "TEMP", "TMP") if os.name == "nt" else ("TMPDIR",)
    env = {name: os.environ[name] for name in names if name in os.environ}
    if os.name == "nt":
        env["PATH"] = str(Path(env.get("SystemRoot", "C:/Windows")) / "System32")
    return env


class WindowsJob:
    """Own a kill-on-close Job; assign suspended child before any child code."""
    def __init__(self):
        import ctypes
        from ctypes import wintypes
        self.ctypes = ctypes
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        self.kernel.CreateJobObjectW.restype = wintypes.HANDLE
        self.kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        self.kernel.SetInformationJobObject.restype = wintypes.BOOL
        self.kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self.kernel.AssignProcessToJobObject.restype = wintypes.BOOL
        self.kernel.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        self.kernel.TerminateJobObject.restype = wintypes.BOOL
        self.kernel.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
        self.kernel.QueryInformationJobObject.restype = wintypes.BOOL
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.restype = wintypes.BOOL
        class BASIC(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]
        class IO(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]
        class LIMIT(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", BASIC), ("IoInfo", IO), ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]
        self.handle = self.kernel.CreateJobObjectW(None, None)
        self.assigned = False
        require(bool(self.handle), "JOB_CREATE")
        limit = LIMIT()
        limit.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limit), ctypes.sizeof(limit)):
            self.close()
            raise OSError("Cannot set owned Job limits")

    def assign_and_resume(self, process, deadline):
        require(bool(self.kernel.AssignProcessToJobObject(self.handle, int(process._handle))), "JOB_ASSIGN")
        self.assigned = True
        require(time.monotonic() < deadline, "DEADLINE_BEFORE_RESUME")
        ntdll = self.ctypes.WinDLL("ntdll")
        ntdll.NtResumeProcess.argtypes = [self.ctypes.c_void_p]
        ntdll.NtResumeProcess.restype = self.ctypes.c_long
        require(ntdll.NtResumeProcess(int(process._handle)) == 0, "JOB_RESUME")

    def stop(self):
        if self.handle:
            require(bool(self.kernel.TerminateJobObject(self.handle, 1)), "JOB_STOP")

    def close(self):
        if self.handle:
            require(bool(self.kernel.CloseHandle(self.handle)), "JOB_CLOSE")
            self.handle = None

    def wait_empty(self, timeout=5):
        ctypes = self.ctypes
        class ACCOUNTING(ctypes.Structure):
            _fields_ = [("TotalUserTime", ctypes.c_int64), ("TotalKernelTime", ctypes.c_int64),
                        ("ThisPeriodTotalUserTime", ctypes.c_int64), ("ThisPeriodTotalKernelTime", ctypes.c_int64),
                        ("TotalPageFaultCount", ctypes.c_uint32), ("TotalProcesses", ctypes.c_uint32),
                        ("ActiveProcesses", ctypes.c_uint32), ("TotalTerminatedProcesses", ctypes.c_uint32)]
        end = time.monotonic() + timeout
        while True:
            accounting = ACCOUNTING()
            require(bool(self.kernel.QueryInformationJobObject(self.handle, 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None)), "JOB_ACCOUNTING")
            if accounting.ActiveProcesses == 0:
                return
            require(time.monotonic() < end, "JOB_NOT_QUIESCENT")
            time.sleep(0.01)


def _run_owned(argv, cwd, env, deadline, limits, check_current):
    """Private transport, also tested with finite non-model child fixtures."""
    started = time.monotonic()
    job = WindowsJob() if os.name == "nt" else None
    process = None
    events = queue.Queue(maxsize=16)
    threads = []
    output = {"stdout": bytearray(), "stderr": bytearray()}
    capture = {name: {"observed_chunk_bytes": 0, "truncated": False, "read_error": False} for name in output}
    outcome, detail, eof = "PROCESS_EXIT", None, set()
    reader_stop = threading.Event()
    def pump(name, stream):
        try:
            while not reader_stop.is_set():
                chunk = os.read(stream.fileno(), 4096)
                while not reader_stop.is_set():
                    try:
                        events.put((name, chunk, None), timeout=0.05)
                        break
                    except queue.Full:
                        pass
                if not chunk:
                    return
        except BaseException as exc:
            try:
                events.put((name, b"", type(exc).__name__), timeout=0.1)
            except queue.Full:
                pass
    def stop():
        if process is not None:
            if job is not None:
                if not job.assigned:
                    process.kill()  # Our suspended child, never a foreign PID.
                job.stop()
            else:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
    try:
        check_current("before_start")
        require(time.monotonic() < deadline, "DEADLINE_BEFORE_START")
        options = {"creationflags": 0x4 | subprocess.CREATE_NO_WINDOW} if job else {"start_new_session": True}
        process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False, **options)
        require(time.monotonic() < deadline, "DEADLINE_AFTER_SPAWN")
        if job:
            job.assign_and_resume(process, deadline)
        for name in output:
            thread = threading.Thread(target=pump, args=(name, getattr(process, name)), daemon=True)
            threads.append(thread)
            thread.start()
        while len(eof) < 2 or process.poll() is None:
            if time.monotonic() >= deadline:
                outcome = "TIMEOUT"
                break
            try:
                check_current("running")
            except Exception as exc:
                outcome, detail = "ADMISSION_LOST", type(exc).__name__
                break
            try:
                name, chunk, reader_error = events.get(timeout=min(0.05, max(0.001, deadline - time.monotonic())))
            except queue.Empty:
                continue
            if reader_error:
                capture[name]["read_error"] = True
                outcome, detail = "READ_FAILURE", reader_error
                break
            if not chunk:
                eof.add(name)
                continue
            remaining = limits[name] - len(output[name])
            capture[name]["observed_chunk_bytes"] += len(chunk)
            output[name].extend(chunk[:max(0, remaining)])
            if len(chunk) > remaining:
                capture[name]["truncated"] = True
                outcome, detail = "OUTPUT_LIMIT", name
                break
        if outcome == "PROCESS_EXIT":
            try:
                check_current("before_result")
            except Exception as exc:
                outcome, detail = "ADMISSION_LOST", type(exc).__name__
        returncode = process.poll()
    except Exception as exc:
        outcome, detail, returncode = "LAUNCH_FAILURE", type(exc).__name__, None
    finally:
        stop_error = None
        cleanup_verified = process is None
        try:
            stop()  # Also closes any descendant retaining pipe handles after parent exit.
        except Exception as exc:
            stop_error = type(exc).__name__
        if job:
            try:
                job.wait_empty()
                cleanup_verified = True
            except Exception as exc:
                stop_error = stop_error or type(exc).__name__
            try:
                job.close()
            except Exception as exc:
                stop_error = stop_error or type(exc).__name__
        if process:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                stop_error = stop_error or "OwnedChildWaitTimeout"
            except Exception as exc:
                stop_error = stop_error or type(exc).__name__
            reader_stop.set()
            for thread in threads:
                thread.join(timeout=1)
            if any(thread.is_alive() for thread in threads):
                stop_error = stop_error or "OwnedReaderNotSettled"
            # Preserve bytes already read during termination, within the same
            # declared bounds. Oversized output is explicitly a retained prefix.
            while True:
                try:
                    name, chunk, reader_error = events.get_nowait()
                except queue.Empty:
                    break
                if chunk:
                    capture[name]["observed_chunk_bytes"] += len(chunk)
                    remaining = limits[name] - len(output[name])
                    output[name].extend(chunk[:max(0, remaining)])
                    if len(chunk) > remaining:
                        capture[name]["truncated"] = True
                        if outcome == "PROCESS_EXIT":
                            outcome, detail = "OUTPUT_LIMIT", name
                elif reader_error is None:
                    eof.add(name)
                if reader_error and outcome == "PROCESS_EXIT":
                    outcome, detail = "READ_FAILURE", reader_error
                if reader_error:
                    capture[name]["read_error"] = True
            for name in output:
                try:
                    getattr(process, name).close()
                except Exception as exc:
                    stop_error = stop_error or type(exc).__name__
    execution_outcome = outcome
    if stop_error:
        outcome, detail = "CLEANUP_UNVERIFIED", stop_error
    for name in capture:
        capture[name]["complete"] = name in eof and not capture[name]["truncated"] and not capture[name]["read_error"]
        capture[name]["retained_bytes"] = len(output[name])
    return {"outcome": outcome, "detail": detail, "returncode": returncode,
            "execution_outcome": execution_outcome, "cleanup_error": stop_error, "capture": capture,
            "final_returncode": process.returncode if process is not None else None,
            "owned_cleanup_verified": cleanup_verified and stop_error is None,
            "stdout_raw": bytes(output["stdout"]), "stderr_raw": bytes(output["stderr"]),
            "elapsed_seconds": time.monotonic() - started, "usage": None,
            "model_output_validated": False, "authority_effect": "NONE"}


def execute_fixed_completion(plan, *, boundary):
    """Trusted caller boundary verifies/consumes; this module never mints proof.

    boundary(phase, frozen_plan, plan_digest) must raise if unavailable, stale,
    revoked, already consumed, unqualified or outside exact permission. The
    consume phase must atomically reserve this one attempt before dispatch.
    Successful callbacks return None; neither True nor a local status dict is
    accepted as a substitute. The Host must pin and qualify the callback/code.
    """
    require(callable(boundary), "TRUSTED_BOUNDARY_REQUIRED")
    call_started = time.monotonic()
    frozen = copy.deepcopy(plan)
    plan_digest = digest(frozen)
    end = frozen.get("deadline_monotonic") if type(frozen) is dict else None
    require(type(end) in (int, float) and math.isfinite(end) and time.monotonic() < end <= time.monotonic() + 120, "BOUNDARY_DEADLINE")
    wall = frozen.get("budget", {}).get("wall_seconds")
    require(type(wall) in (int, float) and math.isfinite(wall) and 0 < wall <= 120, "WALL_BOUND")
    end = min(end, call_started + wall)
    def check(phase):
        view = copy.deepcopy(frozen)
        answer = queue.Queue(maxsize=1)
        def invoke():
            try:
                result = boundary(phase, view, plan_digest)
                require(result is None and digest(view) == plan_digest, "BOUNDARY_RESULT_OR_MUTATION")
                answer.put((result, None))
            except BaseException as exc:
                answer.put((None, exc))
        threading.Thread(target=invoke, daemon=True).start()
        try:
            _, error = answer.get(timeout=max(0.001, end - time.monotonic()))
        except queue.Empty as exc:
            # A late consume reply has unknown reservation status; never launch
            # or retry. Caller must settle that reservation through its boundary.
            raise TimeoutError("External boundary did not settle before hard stop") from exc
        if error is not None:
            raise error
    check("preflight")
    require(os.name == "nt", "WINDOWS_RUNTIME_ONLY")
    deadline = end - CLEANUP_RESERVE_SECONDS
    require(time.monotonic() < deadline, "CLEANUP_RESERVATION")
    validate_plan(frozen, time.monotonic(), deadline)
    for row in frozen["runtime_files"] + [frozen["model"], frozen["prompt"], frozen["output_schema"]]:
        verify_file(row, deadline)
    check("consume")
    require(time.monotonic() < deadline, "DEADLINE_AFTER_CONSUMPTION")
    end = deadline  # Running admission checks cannot spend the cleanup reserve.
    # Caller must freeze the verified file namespace/ACL through dispatch. Local
    # SHA equality cannot establish that external trust boundary or isolation.
    result = _run_owned(command(frozen), frozen["working_directory"], clean_environment(), deadline,
                        {name: frozen["budget"][name + "_bytes"] for name in ("stdout", "stderr")}, check)
    for name in ("stdout", "stderr"):
        result[name + "_retained_sha256"] = hashlib.sha256(result[name + "_raw"]).hexdigest()
    result["plan_sha256"] = plan_digest
    result["process_elapsed_seconds"] = result["elapsed_seconds"]
    result["elapsed_seconds"] = time.monotonic() - call_started
    return result
