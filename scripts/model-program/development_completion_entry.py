"""Connect the observed process to live admission and durable single-use spend.

The Host must supply its authenticated live approval reader and actual private
namespace verifier. Neither a candidate Profile nor an injected test callback
qualifies that Host. There is deliberately no unguarded CLI or offline fallback.
This entry issues no permission and does not reopen a terminal M1 experiment.
"""
import copy
import math
import threading
import base64
import json
import time
import os
from datetime import datetime, timezone

import development_attempt_ledger as ledger
import observed_completion_execution as observed


IDENTITY_FIELDS = ledger.FIELDS - {"plan_sha256", "reserved_at"}
IDENTITY_FIELDS |= {"ledger_directory"}
PHASES = {"preflight", "before_observation_open", "observation_opened", "consume", "before_start",
          "before_resume", "running", "before_result"}

BOOTSTRAP_SCHEMA = "clued.fixed-development-child-bootstrap/1"


def _capture_child_job():
    """Bind this controller and every descendant before accepting bootstrap.

    Keep the non-inherited Job handle alive until OS process teardown. Closing
    it here would terminate this process itself. Parent termination closes it
    through the OS, including when a currentness callback is still blocked.
    """
    if os.name != "nt":
        raise ValueError("FIXED_HOST_WINDOWS_REQUIRED")
    job = observed.legacy.WindowsJob()
    job.kernel.GetCurrentProcess.argtypes = []
    job.kernel.GetCurrentProcess.restype = job.ctypes.c_void_p
    if not job.kernel.AssignProcessToJobObject(job.handle, job.kernel.GetCurrentProcess()):
        job.close()
        raise OSError("FIXED_HOST_SELF_JOB_ASSIGN")
    return job


def _result_json(value):
    """Encode every nested raw byte capture without interpreting model text."""
    if type(value) is bytes:
        return {"encoding": "base64", "data": base64.b64encode(value).decode("ascii")}
    if type(value) is dict:
        return {key: _result_json(item) for key, item in value.items()}
    if type(value) is list:
        return [_result_json(item) for item in value]
    if type(value) is float:
        if not math.isfinite(value):
            raise ValueError("FIXED_HOST_NONFINITE_RESULT")
        # Lossless float text avoids Python/JS exponent serialization drift.
        return {"encoding": "float64_hex", "data": value.hex()}
    return value


def run_captured_stdio_bootstrap(reader, writer):
    """Private child API called only by the admitted, source-bound fixed Host.

    No public CLI, issuer or permission flag exists. The Host retains its real
    approval capture and credentials; the child receives only frozen bindings.
    The Host must also own/terminate this process if its bootstrap pipe stalls.
    """
    # No child code that creates a process runs before this Job assignment.
    # The parent sends bindings only after reading this typed readiness frame.
    global _captured_child_job
    _captured_child_job = _capture_child_job()
    ready = (json.dumps({"schema": BOOTSTRAP_SCHEMA, "kind": "host_ready",
                        "job_bounded": True}, sort_keys=True, separators=(",", ":")) + "\n").encode()
    if writer.write(ready) != len(ready):
        raise OSError("FIXED_HOST_READY_SHORT_WRITE")
    writer.flush()
    from development_currentness_channel import decode, MAX_FRAME_BYTES
    bootstrap = decode(reader.readline(MAX_FRAME_BYTES + 1))
    if (type(bootstrap) is not dict or set(bootstrap) != {"schema", "identity", "plan", "live_pins",
            "output_directory", "output_name", "remaining_seconds"}
            or bootstrap["schema"] != BOOTSTRAP_SCHEMA):
        raise ValueError("FIXED_HOST_BOOTSTRAP_FIELDS")
    remaining = bootstrap["remaining_seconds"]
    policy = observed.legacy.development_budget_policy(bootstrap.get("plan", {}))
    control = bootstrap.get("plan", {}).get("budget", {}).get("control_wall_seconds", 120)
    if (type(control) not in (int, float) or not math.isfinite(control) or not 0 < control <= policy["control_seconds"]
            or type(remaining) not in (int, float) or not math.isfinite(remaining) or not 0 < remaining <= control):
        raise ValueError("FIXED_HOST_BOOTSTRAP_DEADLINE")
    identity, plan = bootstrap["identity"], bootstrap["plan"]
    if (type(identity) is not dict or set(identity) != IDENTITY_FIELDS
            or type(plan) is not dict or "deadline_monotonic" in plan):
        raise ValueError("FIXED_HOST_BOOTSTRAP_BINDING")
    plan = copy.deepcopy(plan)
    plan["deadline_monotonic"] = time.monotonic() + remaining
    with FixedDevelopmentEntry.for_clued_stdio(reader=reader, writer=writer,
            live_pins=bootstrap["live_pins"], ledger_directory=identity["ledger_directory"],
            output_directory=bootstrap["output_directory"], output_name=bootstrap["output_name"],
            timeout_seconds=min(30, remaining),
            deadline_monotonic=plan["deadline_monotonic"] - observed.legacy.CLEANUP_RESERVE_SECONDS) as host:
        result = host.execute(identity, plan)
    # Raw model stdout/stderr are data, never currentness/control messages.
    # Encode them inside one typed terminal frame only after owned cleanup.
    if result.get("owned_cleanup_verified") is not True:
        raise ValueError("FIXED_HOST_MODEL_CLEANUP_UNVERIFIED")
    safe = _result_json(result)
    raw = (json.dumps({"schema": BOOTSTRAP_SCHEMA, "kind": "terminal_result", "result": safe},
            ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
    if len(raw) > 1048576:
        raise ValueError("FIXED_HOST_TERMINAL_FRAME_LIMIT")
    if writer.write(raw) != len(raw):
        raise OSError("FIXED_HOST_TERMINAL_SHORT_WRITE")
    writer.flush()


class FixedDevelopmentEntry:
    """Host-owned entry; readers/verifiers are captured, never Profile options.

    live_check must authenticate fresh exact permission, Binding, scope,
    revocation, window, and this request on every phase. It returns None only
    after admission. namespace_check proves the ledger/output ACL and opened
    observation identity. Both must fail when their evidence is unavailable.
    Actual Host installation/qualification is separate from these Source tests.
    """
    def __init__(self, *, live_check, namespace_check, reservation_check):
        if not all(callable(value) for value in (live_check, namespace_check, reservation_check)):
            raise ValueError("ACTUAL_HOST_READERS_REQUIRED")
        self._live_check = live_check
        self._namespace_check = namespace_check
        self._reservation_check = reservation_check
        self._launch_lock = threading.Lock()
        self._owned_namespace = None

    @classmethod
    def for_clued_stdio(cls, *, reader, writer, live_pins, ledger_directory,
                        output_directory, output_name, timeout_seconds=15,
                        deadline_monotonic=None):
        """Compose the private Host channel with actual Windows namespace checks.

        The fixed Host owns both pipe endpoints and its authenticated Clued
        reader. This factory cannot turn serialized observations into permission.
        """
        from development_currentness_channel import PrivateCurrentnessChannel
        channel = PrivateCurrentnessChannel(reader, writer, live_pins=live_pins,
                                           timeout_seconds=timeout_seconds,
                                           deadline_monotonic=deadline_monotonic)
        return cls.for_windows_namespace(live_check=channel,
            ledger_directory=ledger_directory, output_directory=output_directory,
            output_name=output_name)

    @classmethod
    def for_windows_namespace(cls, *, live_check, ledger_directory,
                              output_directory, output_name):
        """Bind the actual native checker to Host-captured existing directories.

        This opens metadata handles only. The live reader must still be real,
        admitted and source-bound; a supplied callback cannot qualify itself.
        """
        if not callable(live_check):
            raise ValueError("ACTUAL_HOST_READERS_REQUIRED")
        from development_windows_namespace import WindowsPrivateNamespace
        namespace = WindowsPrivateNamespace(ledger_directory, output_directory, output_name)
        try:
            instance = cls(live_check=live_check, namespace_check=namespace.check,
                           reservation_check=namespace.check_reservation)
            instance._owned_namespace = namespace
            return instance
        except BaseException:
            namespace.close()
            raise

    def close(self):
        if self._owned_namespace is not None:
            self._owned_namespace.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def execute(self, admitted_identity, plan):
        # This is an admitted identity, not an author-supplied issuance flag.
        if type(admitted_identity) is not dict or set(admitted_identity) != IDENTITY_FIELDS:
            raise ValueError("ADMITTED_IDENTITY_FIELDS")
        identity = copy.deepcopy(admitted_identity)
        stable_plan = copy.deepcopy(plan)
        stable_plan.pop("deadline_monotonic", None)
        request_binding = {"identity": copy.deepcopy(identity),
                           "execution_plan_sha256": observed.legacy.digest(stable_plan)}
        binding_seal = observed.legacy.digest(request_binding)
        # Validate identities before any namespace write. No model files read.
        reservation = {k: identity[k] for k in ledger.FIELDS
                       if k not in ("plan_sha256", "reserved_at")}
        reservation.update(plan_sha256=request_binding["execution_plan_sha256"],
                           reserved_at=datetime.now(timezone.utc).isoformat())
        ledger._validate(reservation)
        deadline = plan.get("deadline_monotonic")
        budget = plan.get("budget")
        if type(budget) is not dict:
            raise ValueError("ADMITTED_BUDGET_REQUIRED")
        wall = budget.get("wall_seconds")
        control = budget.get("control_wall_seconds", wall)
        policy = observed.legacy.development_budget_policy(plan)
        if (type(deadline) not in (int, float) or not math.isfinite(deadline)
                or type(wall) not in (int, float) or not math.isfinite(wall)
                or not 0 < wall <= policy["model_seconds"]
                or type(control) not in (int, float) or not math.isfinite(control)
                or not 0 < control <= policy["control_seconds"]):
            raise ValueError("ADMITTED_DEADLINE_REQUIRED")
        deadline = min(deadline, observed.legacy.time.monotonic() + control)
        deadline -= observed.legacy.CLEANUP_RESERVE_SECONDS
        if not self._launch_lock.acquire(blocking=False):
            raise ValueError("HOST_LAUNCH_ALREADY_RUNNING")
        spend = None
        state_lock = threading.Lock()
        cancelled = threading.Event()

        def active():
            if (cancelled.is_set() or type(deadline) not in (int, float)
                    or not math.isfinite(deadline)
                    or observed.legacy.time.monotonic() >= deadline):
                raise TimeoutError("ADMISSION_DEADLINE_OR_CANCELLED")

        def boundary(phase, view, seal, opened):
            nonlocal spend
            if phase not in PHASES:
                raise ValueError("UNKNOWN_EXECUTION_PHASE")
            received_plan = copy.deepcopy(view)
            received_plan.pop("deadline_monotonic", None)
            if observed.legacy.digest(received_plan) != request_binding["execution_plan_sha256"]:
                raise ValueError("ADMITTED_PLAN_DRIFT")
            if observed.legacy.digest(view) != seal:
                raise ValueError("CALLER_PLAN_DRIFT")
            with state_lock:
                active()
                # Always check live permission first, including immediately
                # before spending and before the suspended child is resumed.
                request = copy.deepcopy(request_binding)
                if self._live_check(phase, request) is not None:
                    raise ValueError("LIVE_CHECK_MUST_ADMIT_OR_RAISE")
                if observed.legacy.digest(request) != binding_seal:
                    raise ValueError("LIVE_READER_MUTATED_BINDING")
                active()
                before = observed.legacy.digest(opened)
                if self._namespace_check(phase, identity["ledger_directory"],
                                         view["observation_path"], opened) is not None:
                    raise ValueError("NAMESPACE_CHECK_MUST_ADMIT_OR_RAISE")
                if observed.legacy.digest(opened) != before:
                    raise ValueError("NAMESPACE_READER_MUTATED_OBJECT")
                active()
                if phase == "consume":
                    if spend is not None:
                        raise ValueError("ATTEMPT_ALREADY_CONSUMED")
                    record = copy.deepcopy(reservation)
                    record["reserved_at"] = datetime.now(timezone.utc).isoformat()
                    def before_create():
                        active()
                        before = observed.legacy.digest(opened)
                        if self._namespace_check("before_ledger_create", identity["ledger_directory"],
                                                 view["observation_path"], opened) is not None:
                            raise ValueError("NAMESPACE_CHECK_MUST_ADMIT_OR_RAISE")
                        if observed.legacy.digest(opened) != before:
                            raise ValueError("NAMESPACE_READER_MUTATED_OBJECT")
                        active()
                    spend = ledger.reserve_once(identity["ledger_directory"], record,
                        before_create=before_create, verify_created=self._reservation_check)
                elif phase in ("before_start", "before_resume", "running", "before_result") and spend is None:
                    raise ValueError("ATTEMPT_NOT_CONSUMED")

        try:
            result = observed.execute_observed_completion(plan, boundary=boundary)
            if spend is None:
                raise ValueError("EXECUTION_RETURNED_WITHOUT_RESERVATION")
            result["budget_reservation"] = copy.deepcopy(spend)
            return result
        finally:
            # The process primitive may time out a daemon admission callback.
            # Its late return must not begin another namespace write/consume.
            cancelled.set()
            self._launch_lock.release()
            # No release/delete/reset of the spent reservation on any outcome.
