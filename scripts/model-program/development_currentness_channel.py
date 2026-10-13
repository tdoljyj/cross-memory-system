"""Private stdio currentness client for the already admitted fixed Host.

The Host owns both pipe endpoints and the authenticated Clued reader. No token,
Profile issuer, network client, model launcher or offline admission exists here.
A matching observation is not permission; the Host must have separately admitted
the exact experiment before constructing the fixed development entry.
"""
import copy
import json
import math
import queue
import secrets
import threading
import time


SCHEMA = "clued.development-currentness-channel/1"
MAX_FRAME_BYTES = 32768
PHASES = {"preflight", "before_observation_open", "observation_opened", "consume",
          "before_start", "before_resume", "running", "before_result"}
OBSERVATION_FIELDS = {"kind", "approval_record_id", "approval_version",
    "approval_receipt_id", "approval_content_hash", "task_id", "task_version",
    "claim_id", "claim_fence", "request_sha256", "profile_sha256",
    "authority_effect", "permission_issued", "attempt_consumed"}


class CurrentnessChannelError(ValueError):
    pass


def require(ok, code):
    if not ok:
        raise CurrentnessChannelError(code)


def decode(raw):
    require(type(raw) is bytes and 0 < len(raw) <= MAX_FRAME_BYTES
            and raw.endswith(b"\n"), "HOST_FRAME_BOUND_OR_EOF")
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "HOST_FRAME_DUPLICATE_FIELD")
            result[key] = value
        return result
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=unique,
            parse_constant=lambda value: (_ for _ in ()).throw(
                CurrentnessChannelError("HOST_FRAME_NONFINITE")))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise CurrentnessChannelError("HOST_FRAME_INVALID_JSON") from exc


class PrivateCurrentnessChannel:
    """Finite, non-reusable on failure; use only actual Host-owned binary pipes.

    The timeout seals the channel even if its daemon reader returns late. Fixed
    entry cancellation/deadline checks still govern all filesystem/model effects.
    Possession of a stdio endpoint does not qualify an unrelated generic Host.
    """
    def __init__(self, reader, writer, *, live_pins, timeout_seconds=15,
                 deadline_monotonic=None):
        require(callable(getattr(reader, "readline", None))
                and callable(getattr(writer, "write", None))
                and callable(getattr(writer, "flush", None)), "HOST_BINARY_PIPES_REQUIRED")
        require(type(timeout_seconds) in (int, float) and 0 < timeout_seconds <= 30,
                "HOST_CHANNEL_TIMEOUT")
        require(deadline_monotonic is None or (type(deadline_monotonic) in (int, float)
                and math.isfinite(deadline_monotonic)), "HOST_CHANNEL_DEADLINE")
        require(type(live_pins) is dict and set(live_pins) == {"task_version", "claim_id", "claim_fence"}
                and type(live_pins["task_version"]) is int and live_pins["task_version"] > 0
                and type(live_pins["claim_fence"]) is int and live_pins["claim_fence"] > 0
                and type(live_pins["claim_id"]) is str and 0 < len(live_pins["claim_id"]) <= 128,
                "HOST_CAPTURED_LIVE_PINS_REQUIRED")
        self._reader, self._writer = reader, writer
        self._live_pins = copy.deepcopy(live_pins)
        self._timeout = timeout_seconds
        self._deadline = deadline_monotonic
        self._lock = threading.Lock()
        self._sequence = 0
        self._failed = False

    def __call__(self, phase, binding):
        require(phase in PHASES and type(binding) is dict, "HOST_CHANNEL_REQUEST")
        require(self._lock.acquire(blocking=False), "HOST_CHANNEL_CONCURRENT_REQUEST")
        try:
            require(not self._failed, "HOST_CHANNEL_SEALED")
            # One captured deadline spans all rounds; neither a successful reply
            # nor the per-round cap creates a fresh execution budget.
            wait = self._timeout if self._deadline is None else min(
                self._timeout, self._deadline - time.monotonic())
            if wait <= 0:
                self._failed = True
                raise TimeoutError("HOST_CURRENTNESS_SHARED_DEADLINE")
            self._sequence += 1
            require(self._sequence <= 4096, "HOST_CHANNEL_ROUND_LIMIT")
            request = {"schema": SCHEMA, "id": secrets.token_hex(16),
                "sequence": self._sequence, "phase": phase, "binding": copy.deepcopy(binding)}
            raw = (json.dumps(request, ensure_ascii=False, sort_keys=True,
                separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
            require(len(raw) <= MAX_FRAME_BYTES, "HOST_REQUEST_FRAME_TOO_LARGE")
            # Any uncertain write/read remains sealed; never re-send the request.
            self._failed = True
            answer = queue.Queue(maxsize=1)
            def receive():
                try:
                    require(self._writer.write(raw) == len(raw), "HOST_REQUEST_SHORT_WRITE")
                    self._writer.flush()
                    answer.put((self._reader.readline(MAX_FRAME_BYTES + 1), None))
                except BaseException as exc:
                    answer.put((None, exc))
            threading.Thread(target=receive, daemon=True).start()
            try:
                result, error = answer.get(timeout=wait)
            except queue.Empty as exc:
                raise TimeoutError("HOST_CURRENTNESS_REPLY_TIMEOUT") from exc
            if error is not None:
                raise CurrentnessChannelError("HOST_REPLY_READ_FAILED") from error
            if self._deadline is not None and time.monotonic() >= self._deadline:
                raise TimeoutError("HOST_CURRENTNESS_SHARED_DEADLINE")
            reply = decode(result)
            require(type(reply) is dict and set(reply) == {"schema", "id", "sequence",
                    "phase", "admitted", "observation"}, "HOST_REPLY_FIELDS")
            require(type(reply["sequence"]) is int, "HOST_REPLY_SEQUENCE_TYPE")
            require(all(reply[k] == request[k] for k in ("schema", "id", "sequence", "phase")),
                    "HOST_REPLY_BINDING_OR_REPLAY")
            require(reply["admitted"] is True, "HOST_CURRENTNESS_UNAVAILABLE")
            observation = reply["observation"]
            require(type(observation) is dict and set(observation) == OBSERVATION_FIELDS,
                    "HOST_OBSERVATION_FIELDS")
            require(observation["kind"] == "CURRENT_OWNER_DECISION_AND_PROFILE_BINDING_OBSERVATION"
                    and observation["authority_effect"] == "NONE"
                    and observation["permission_issued"] is False
                    and observation["attempt_consumed"] is False, "HOST_OBSERVATION_NOT_ADMISSION")
            identity = binding.get("identity", {})
            require(type(observation["approval_version"]) is int
                    and type(observation["task_version"]) is int
                    and type(observation["claim_fence"]) is int, "HOST_OBSERVATION_INTEGER_TYPE")
            for key in ("task_id", "profile_sha256", "request_sha256", "approval_record_id",
                        "approval_version", "approval_receipt_id"):
                require(key in identity and observation[key] == identity[key], "HOST_OBSERVATION_PIN_DRIFT")
            require(all(observation[k] == self._live_pins[k] for k in self._live_pins),
                    "HOST_OBSERVATION_CLAIM_DRIFT")
            self._failed = False
            return None
        finally:
            self._lock.release()
