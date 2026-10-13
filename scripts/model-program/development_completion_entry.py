"""Connect the observed process to live admission and durable single-use spend.

The Host must supply its authenticated live approval reader and actual private
namespace verifier. Neither a candidate Profile nor an injected test callback
qualifies that Host. There is deliberately no unguarded CLI or offline fallback.
This entry issues no permission and does not reopen a terminal M1 experiment.
"""
import copy
import math
import threading
from datetime import datetime, timezone

import development_attempt_ledger as ledger
import observed_completion_execution as observed


IDENTITY_FIELDS = ledger.FIELDS - {"plan_sha256", "reserved_at"}
IDENTITY_FIELDS |= {"ledger_directory"}
PHASES = {"preflight", "before_observation_open", "observation_opened", "consume", "before_start",
          "before_resume", "running", "before_result"}


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
                        output_directory, output_name, timeout_seconds=15):
        """Compose the private Host channel with actual Windows namespace checks.

        The fixed Host owns both pipe endpoints and its authenticated Clued
        reader. This factory cannot turn serialized observations into permission.
        """
        from development_currentness_channel import PrivateCurrentnessChannel
        channel = PrivateCurrentnessChannel(reader, writer, live_pins=live_pins,
                                           timeout_seconds=timeout_seconds)
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
        if (type(deadline) not in (int, float) or not math.isfinite(deadline)
                or type(wall) not in (int, float) or not math.isfinite(wall)
                or not 0 < wall <= 120):
            raise ValueError("ADMITTED_DEADLINE_REQUIRED")
        deadline = min(deadline, observed.legacy.time.monotonic() + wall)
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
