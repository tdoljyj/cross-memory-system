"""Pure b11033 response-byte adapter; no runner, schema or result issuer.

adapt_completion_response(stdout_raw, stderr_raw, format_binding, *,
                         observation_raw=None, observation_validator=None)
returns a local intermediate carrier, not v2 result/attempt/candidate records.
Raw bytes and their SHA-256 remain unchanged even when parsing is refused.
JSON syntax is not product-schema validity, acceptance, qualification or PASS.

The caller supplies a trusted exact format binding. Matching public pins here
proves local compatibility only, never installation, currentness or authority.
It must also establish the format assumptions from its actual fixed invocation.
framing is 'strict_json' or 'source_eog_trailer'; newline is 'LF' or 'CRLF'.
There is no arbitrary marker, prefix removal, log scraping or fence repair.

The optional pure observation_validator(raw, copied_binding) returns already
verified machine-readable facts, equal to the JSON object in observation_raw.
The caller owns this validation's trust and purity; no boolean in the raw JSON
can replace it. Facts bind original stream hashes and runtime identities.
Only that verified observation can supply usage. Missing fields stay missing.
Budgets, fixture values, bench/perf text and historical numbers are not usage.

Exact historical Source: completion.cpp SHA de59ebd...f816958, lines 928-932
prints ' [end of text]\\n' on EOG; line 950 prints '\\n\\n'. log.h:117 and
log.cpp:104-120 put plain LOG output on stdout. common/sampling.cpp:541-582
prints rounded perf diagnostics, including n_eval *runs*, not a v2 usage ledger.
No file/network/process/model/store/CLI operation is performed by this module.
"""

import copy
import hashlib
import json
import math
from types import MappingProxyType


RUNTIME_SOURCE_PINS = MappingProxyType({
    "runtime_id": "llama.cpp",
    "runtime_build": "b11033",
    "entry": "llama-completion",
    "archive_sha256": "8ca91d4621fcac8799245f01a6467e9c09eba7b8d3be161a382048dc5c839db2",
    "executable_sha256": "0c5468b2adce760726b9d2ebdf317d25c8f58350610e993561f1b4c171e03099",
    "implementation_sha256": "79e2f2d13d9852aa9f3c745b20c3e1c7db5bcf87340bf8db0468437b431ed7cb",
    "common_sha256": "958da4d1c42be3702cb3fcd87548ce6028eea50f93a97cb674f9425d554f5ede",
    "completion_source_sha256": "de59ebd421de6fd174a2144fc6fca3d3f38583919f5ef8f485962afd3f816958",
    "sampling_source_sha256": "a38a6624109ce01d317d6c89f5d1ff27c1427fd5934bddcf71c77d922fcf15b2",
    "log_header_sha256": "d9a1b99a7767508548759a90b89dceb415f3af09af59931502663fe74f4d300e",
    "log_source_sha256": "d4c198a52e06284f22070bb50776dbb0f0ca9dd09bc176aac81983e49a432a21",
})
FORMAT_ASSUMPTIONS = MappingProxyType({
    "display_prompt": False, "conversation": False, "interactive": False,
    "simple_io": True, "color": False, "log_jsonl": False,
    "log_prefix": False, "log_timestamps": False, "session_save": False,
})
MAX_PARSE_BYTES = 262144  # Local parsing bound, not a model/Port budget.
_BINDING_FIELDS = set(RUNTIME_SOURCE_PINS) | set(FORMAT_ASSUMPTIONS) | {"framing", "newline"}
_OBSERVATION_FIELDS = {"observation_ref", "stdout_sha256", "stderr_sha256",
                       "archive_sha256", "executable_sha256", "implementation_sha256",
                       "exit_code", "timed_out", "cancelled", "usage"}
_USAGE_FIELDS = {"input_tokens", "output_tokens", "input_bytes", "output_bytes",
                 "elapsed_ms", "cost_minor_units", "currency", "currency_exponent",
                 "currency_profile_digest"}
_INTEGER_USAGE = _USAGE_FIELDS - {"elapsed_ms", "currency", "currency_profile_digest"}


def _sha(raw):
    return hashlib.sha256(raw).hexdigest() if raw is not None else None


def _finite(value):
    if type(value) is str:
        value.encode("utf-8", errors="strict")
    if type(value) is float and not math.isfinite(value):
        raise ValueError("nonfinite JSON number")
    if type(value) is dict:
        for key, child in value.items():
            key.encode("utf-8", errors="strict")
            _finite(child)
    elif type(value) is list:
        for child in value:
            _finite(child)


def _object(pairs):
    answer = {}
    for key, value in pairs:
        if key in answer:
            raise ValueError("duplicate JSON key")
        answer[key] = value
    return answer


def _constant(_value):
    raise ValueError("nonstandard JSON constant")


def _json(raw):
    if type(raw) is not bytes or len(raw) > MAX_PARSE_BYTES:
        raise ValueError("local parsing bound")
    value = json.loads(raw.decode("utf-8", errors="strict"),
                       object_pairs_hook=_object, parse_constant=_constant)
    _finite(value)
    return value


def _canonical(value):
    _finite(value)
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8", errors="strict")


def _binding(value):
    if type(value) is not dict or set(value) != _BINDING_FIELDS:
        return False
    if any(type(value[k]) is not str or value[k] != v for k, v in RUNTIME_SOURCE_PINS.items()):
        return False
    if any(type(value[k]) is not bool or value[k] is not v for k, v in FORMAT_ASSUMPTIONS.items()):
        return False
    return (type(value["framing"]) is str and value["framing"] in
            {"strict_json", "source_eog_trailer"} and type(value["newline"]) is str
            and value["newline"] in {"LF", "CRLF"})


def _usage(value):
    if value is None:
        return None
    if type(value) is not dict or not set(value) <= _USAGE_FIELDS:
        raise ValueError("usage fields")
    for key, number in value.items():
        if number is None:
            continue
        if key in _INTEGER_USAGE:
            if type(number) is not int or number < 0:
                raise ValueError("usage count")
        elif key == "elapsed_ms":
            if type(number) not in {int, float} or not math.isfinite(number) or number < 0:
                raise ValueError("usage time")
        elif type(number) is not str or not number:
            raise ValueError("usage identity")
    # Do not create omitted token, byte, time or currency fields.
    return copy.deepcopy(value)


def _observation(raw, validator, binding, stdout, stderr):
    if not callable(validator):
        raise ValueError("observation validator missing")
    value = _json(raw)
    if type(value) is not dict or set(value) != _OBSERVATION_FIELDS:
        raise ValueError("observation fields")
    frozen = copy.deepcopy(binding)
    verified = validator(raw, frozen)
    if (not _binding(frozen) or _canonical(frozen) != _canonical(binding)
            or type(verified) is not dict or _canonical(verified) != _canonical(value)):
        raise ValueError("observation validation")
    if type(value["observation_ref"]) is not str or not value["observation_ref"]:
        raise ValueError("observation reference")
    for name, expected in (("stdout_sha256", _sha(stdout)), ("stderr_sha256", _sha(stderr)),
                           *((k, binding[k]) for k in
                             ("archive_sha256", "executable_sha256", "implementation_sha256"))):
        if value[name] != expected:
            raise ValueError("observation stream/runtime binding")
    if value["exit_code"] is not None and type(value["exit_code"]) is not int:
        raise ValueError("exit code")
    for name in ("timed_out", "cancelled"):
        if value[name] is not None and type(value[name]) is not bool:
            raise ValueError("observation flag")
    value["usage"] = _usage(value["usage"])
    return copy.deepcopy(value)


def adapt_completion_response(stdout_raw, stderr_raw, format_binding, *,
                              observation_raw=None, observation_validator=None):
    """Preserve supplied bytes; parse only known format, with no authority claim.

    Missing/unknown process observations do not erase a syntactic candidate, but
    never establish completion. Verified nonzero exit/timeout/cancellation blocks
    candidate parsing. The outer existing result/attempt producer owns outcomes.
    """
    for raw in (stdout_raw, stderr_raw, observation_raw):
        if raw is not None and type(raw) is not bytes:
            raise TypeError("original captures must be bytes or None")
    answer = {"stdout_raw": stdout_raw, "stderr_raw": stderr_raw,
              "stdout_sha256": _sha(stdout_raw), "stderr_sha256": _sha(stderr_raw),
              "observation_raw": observation_raw, "observation_sha256": _sha(observation_raw),
              "payload_raw": None, "payload_sha256": None, "framing_raw": None,
              "candidate_parsed": False, "parsed_candidate": None,
              "process_observation": None, "usage": None,
              "usage_missing_fields": sorted(_USAGE_FIELDS),
              "format_binding": None, "gaps": [], "terminal_status": None,
              "authority_effect": "NONE", "qualification": "NOT_ISSUED"}
    if not _binding(format_binding):
        answer["gaps"].append("UNKNOWN_OR_INCOMPATIBLE_FORMAT_BINDING")
        return answer
    binding = copy.deepcopy(format_binding)
    answer["format_binding"] = binding
    if observation_raw is None:
        answer["gaps"].append("PROCESS_OBSERVATION_MISSING")
    else:
        try:
            observed = _observation(observation_raw, observation_validator,
                                    binding, stdout_raw, stderr_raw)
            answer["process_observation"] = observed
            answer["usage"] = copy.deepcopy(observed["usage"])
        except (ValueError, TypeError, UnicodeError, RecursionError, OverflowError):
            answer["gaps"].append("OBSERVATION_UNVERIFIED_OR_INVALID")
        except Exception:
            # Callback errors may carry secrets; preserve raw, not exception text.
            answer["gaps"].append("OBSERVATION_UNVERIFIED_OR_INVALID")
    if answer["usage"] is None:
        answer["gaps"].append("USAGE_MISSING")
    else:
        answer["usage_missing_fields"] = sorted(
            name for name in _USAGE_FIELDS if answer["usage"].get(name) is None)
        if answer["usage_missing_fields"]:
            answer["gaps"].append("USAGE_INCOMPLETE")
    observed = answer["process_observation"]
    if observed is not None:
        if observed["exit_code"] is None or observed["timed_out"] is None or observed["cancelled"] is None:
            answer["gaps"].append("PROCESS_CLOSURE_INCOMPLETE")
        if (observed["exit_code"] not in (None, 0) or observed["timed_out"] is True
                or observed["cancelled"] is True):
            answer["gaps"].append("PROCESS_FAILED_TIMED_OUT_OR_CANCELLED")
            return answer
    if stdout_raw is None:
        answer["gaps"].append("STDOUT_MISSING")
        return answer
    if len(stdout_raw) > MAX_PARSE_BYTES:
        answer["gaps"].append("LOCAL_PARSE_BOUND_EXCEEDED")
        return answer
    payload = stdout_raw
    if binding["framing"] == "source_eog_trailer":
        newline = b"\n" if binding["newline"] == "LF" else b"\r\n"
        trailer = b" [end of text]" + newline * 3
        if not payload.endswith(trailer):
            answer["gaps"].append("SOURCE_EOG_TRAILER_MISSING_OR_DIFFERENT")
            return answer
        payload = payload[:-len(trailer)]
        answer["framing_raw"] = trailer
    answer["payload_raw"], answer["payload_sha256"] = payload, _sha(payload)
    try:
        answer["parsed_candidate"] = _json(payload)
        answer["candidate_parsed"] = True
    except (ValueError, TypeError, UnicodeError, RecursionError, OverflowError):
        answer["gaps"].append("PAYLOAD_NOT_STRICT_FINITE_JSON")
    return answer
