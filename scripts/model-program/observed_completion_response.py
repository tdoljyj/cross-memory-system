"""Pure response carrier for the newly built e567 observed completion runtime.

Raw stdout/stderr/sidecar and machine-snapshot bytes are retained verbatim. No
file, network, process, model, tokenizer, clock, issuer or v2 producer is invoked.
The external machine validator owns Source/runtime/plan/currentness, real process
outcome, complete captures, cleanup and actual non-token accounting. Local pins,
hashes or a callback return never authenticate that caller or grant authority.

Token counts come only from the consistent sidecar and require independently
verified settled process/captures/cleanup. A real failure can retain actual
accounting without a parsed candidate. Partial streams retain diagnostics but
never turn retained sample records into a complete sampled-token measurement.
input_bytes means provider prompt raw bytes bound by prompt/plan hashes, not the
original Segment or request input digest. output_bytes means complete raw stdout
bytes, including Source framing; the caller must adopt these accounting bounds.
Costs/currency/elapsed are external observations, never guessed from budgets or
sidecar uptime ticks. Unknown fields stay None. This is a local intermediate,
not a formal observation Schema, admission, result/attempt record or success.

The declared stop must match the normal sidecar terminal. EOG removes exactly
b' [end of text]' + NL*3; predict removes exactly NL*2. NL is explicitly bound
LF or CRLF for stdout only; the sidecar always uses LF. Other payload whitespace
is retained, never trimmed or inferred to be an additional Source trailer.
"""
import copy
import hashlib
from types import MappingProxyType

import completion_saved_response as saved
import runtime_observation_records as records


RUNTIME_FILES = MappingProxyType({
    "ggml-base.dll": (966144, "35fb0d953f5150df5df52379724a11d92ae0a6706709c2966d72dcea9b7d05c6"),
    "ggml-cpu.dll": (1201152, "ef78ba74b19d1da95d20461d8f104062bd7cac488e5a6d0b3753311ed0c79841"),
    "ggml.dll": (85504, "c0ebb302e99dce7535a290ac0a46eb0d273993688a6701b6f46a2b9b10676399"),
    "libllama-common.dll": (5781504, "e3def2eb6e942da64ebea6b855ae56bbcdb6b32a20271f53d9ec5c51dbdece57"),
    "libllama-completion-impl.dll": (153600, "31ee113a8fedeae2b6ca8a32cbe7886cb40b2966c8dfe20383c7815167e2d855"),
    "libllama.dll": (3793920, "70cde42c0b48f68b51f5cce6fa62f6b9c3f3bebdafe9542200a7683428c7dacd"),
    "llama-completion.exe": (62464, "4d08c640c968f7ab4fabe2a45eaff4dc84044ed67e8895913fc076e1bb2dfe87"),
    "libc++.dll": (2000384, "81fb50f0866840d7e5a1d35d48cf31adc02f623a61d8b77daf62881e1e59401b"),
    "libunwind.dll": (183808, "b0636a4281610124704adb2be2edf5642e830d86c68b7f27dbc9c8154705a780"),
})
SOURCE_PINS = MappingProxyType({
    "runtime_id": "llama.cpp", "source_commit": "8ed1a55efcd7424d2c592f6cbc9f97756db1d74d",
    "patch_sha256": "e5673d8758ad25963e03ac69ccb5ef1263b811197af498c77955d28ae875143f",
    "completion_source_sha256": "ee0db53c042add26cb5bd1a823e5e3e7ec4f0a4d12277d55c3e20f616df60e96",
    "sampling_source_sha256": "a38a6624109ce01d317d6c89f5d1ff27c1427fd5934bddcf71c77d922fcf15b2",
    "log_header_sha256": "d9a1b99a7767508548759a90b89dceb415f3af09af59931502663fe74f4d300e",
    "log_source_sha256": "d4c198a52e06284f22070bb50776dbb0f0ca9dd09bc176aac81983e49a432a21",
})
# Exact candidate artifacts and actual Source identities, not permission or
# model-load qualification. Caller manifests cannot replace either closure.
FOUR_B_RUNTIME_FILES = {
    'ggml-base.dll': (966144, 'abdd8817e45c5c5c49b5b0ca2b5bacf935a430e8a2bde555394b88c7d7349865'),
    'ggml-cpu.dll': (1201152, 'b8d05f6734ceaa2b047db2eaa8856763a8d05fea268e36aa7e1befde8185721c'),
    'ggml.dll': (85504, '7d50cd49a5304f7bd9132cfb1c94c0b5d98fff5cd18f44f4c762038a378893fc'),
    'libc++.dll': (2000384, '81fb50f0866840d7e5a1d35d48cf31adc02f623a61d8b77daf62881e1e59401b'),
    'libllama-common.dll': (5781504, 'c03919e282b6a3a676778176f7a5a6ead8e0f1219156638f96eb1668841ef67b'),
    'libllama-completion-impl.dll': (153600, '49fe6633b804482d6c74d6ffb0c68bbdfad51dde1421a389f8ae1e682643849e'),
    'libllama.dll': (3793920, 'c3734b36a25638617bc69317765c7d984269b536a0146dcebf4db18ee7065d34'),
    'libunwind.dll': (183808, 'b0636a4281610124704adb2be2edf5642e830d86c68b7f27dbc9c8154705a780'),
    'llama-completion.exe': (62464, '9c6fcbc03ad0124b4ae42ad6290308ed131a841dd66692e38bb491a7e6a82cc8'),
}
FOUR_B_SOURCE_PINS = {
    'completion_source_sha256': '0c617a78dccbfe9cbf499df1cbd06ef4fc3c98f443ba79489b4b4411f674e787',
    'log_header_sha256': 'd9a1b99a7767508548759a90b89dceb415f3af09af59931502663fe74f4d300e',
    'log_source_sha256': 'd4c198a52e06284f22070bb50776dbb0f0ca9dd09bc176aac81983e49a432a21',
    'patch_sha256': 'e6db7fa673fef009afd6e8d76a08219d2a41f956b323a180f863f48d94597977',
    'runtime_id': 'llama.cpp',
    'sampling_source_sha256': 'a38a6624109ce01d317d6c89f5d1ff27c1427fd5934bddcf71c77d922fcf15b2',
    'source_commit': '8ed1a55efcd7424d2c592f6cbc9f97756db1d74d',
}
FORMAT_ASSUMPTIONS = saved.FORMAT_ASSUMPTIONS
BINDING_FIELDS = set(SOURCE_PINS) | set(FORMAT_ASSUMPTIONS) | {
    "runtime_files", "framing", "newline", "declared_stop", "plan_sha256", "provider_prompt_sha256"}
SNAPSHOT_FIELDS = {"observation_ref", "stdout_sha256", "stderr_sha256", "sidecar_sha256",
                   "format_binding_sha256", "plan_sha256", "expected_limits", "exit_code",
                   "timed_out", "cancelled", "process_outcome", "owned_cleanup_verified",
                   "captures", "input_bytes_boundary", "output_bytes_boundary", "usage"}
CAPTURE_FIELDS = {"complete", "truncated", "read_error"}
USAGE_FIELDS = set(saved._USAGE_FIELDS)
NON_TOKEN_USAGE_FIELDS = USAGE_FIELDS - {"input_tokens", "output_tokens"}


def _sha(raw):
    return hashlib.sha256(raw).hexdigest() if raw is not None else None


def _require(ok):
    if not ok:
        raise ValueError("local observed response binding or facts invalid")


def _digest(value):
    return _sha(records._canonical(value))


def _hex(value):
    return type(value) is str and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def _binding(value):
    if type(value) is not dict:
        return False
    new_class = "development_budget_class" in value
    if set(value) != (BINDING_FIELDS | {"development_budget_class"} if new_class else BINDING_FIELDS):
        return False
    pins, runtime = SOURCE_PINS, RUNTIME_FILES
    if new_class:
        if (value["development_budget_class"] != records.FOUR_B_BUDGET_CLASS
                or type(FOUR_B_SOURCE_PINS) is not dict or type(FOUR_B_RUNTIME_FILES) is not dict
                or set(FOUR_B_SOURCE_PINS) != set(SOURCE_PINS) or set(FOUR_B_RUNTIME_FILES) != set(RUNTIME_FILES)
                or FOUR_B_SOURCE_PINS == dict(SOURCE_PINS) or FOUR_B_RUNTIME_FILES == dict(RUNTIME_FILES)):
            return False
        pins, runtime = FOUR_B_SOURCE_PINS, FOUR_B_RUNTIME_FILES
    records._canonical(value)
    if any(type(value[k]) is not str or value[k] != expected for k, expected in pins.items()):
        return False
    if any(type(value[k]) is not bool or value[k] is not expected for k, expected in FORMAT_ASSUMPTIONS.items()):
        return False
    if type(value["runtime_files"]) is not dict or set(value["runtime_files"]) != set(runtime):
        return False
    for name, (size, digest) in runtime.items():
        row = value["runtime_files"][name]
        if (type(row) is not dict or set(row) != {"bytes", "sha256"} or type(row["bytes"]) is not int
                or row["bytes"] != size or type(row["sha256"]) is not str or row["sha256"] != digest):
            return False
    return (value["framing"] == "source_stop_trailer" and type(value["framing"]) is str
            and value["newline"] in {"LF", "CRLF"} and type(value["newline"]) is str
            and value["declared_stop"] in {"eog", "predict"} and type(value["declared_stop"]) is str
            and _hex(value["plan_sha256"]) and _hex(value["provider_prompt_sha256"]))


def _machine(raw, validator, binding, limits, stdout, stderr, sidecar):
    _require(callable(validator))
    value = saved._json(raw)
    _require(type(value) is dict and set(value) == SNAPSHOT_FIELDS)
    context = {"stdout_sha256": _sha(stdout), "stderr_sha256": _sha(stderr), "sidecar_sha256": _sha(sidecar),
               "format_binding": copy.deepcopy(binding), "format_binding_sha256": _digest(binding),
               "expected_limits": copy.deepcopy(limits), "plan_sha256": binding["plan_sha256"],
               "provider_prompt_sha256": binding["provider_prompt_sha256"]}
    before = records._canonical(context)
    supplied = copy.deepcopy(context)
    verified = validator(raw, supplied)
    _require(records._canonical(supplied) == before and _binding(supplied["format_binding"]))
    _require(type(verified) is dict and records._canonical(verified) == records._canonical(value))
    _require(type(value["observation_ref"]) is str and bool(value["observation_ref"]))
    for key in ("stdout_sha256", "stderr_sha256", "sidecar_sha256", "format_binding_sha256", "plan_sha256"):
        _require(type(value[key]) is type(context[key]) and value[key] == context[key])
    records._limits(value["expected_limits"], binding.get("development_budget_class"))
    _require(records._canonical(value["expected_limits"]) == records._canonical(limits))
    _require(value["exit_code"] is None or type(value["exit_code"]) is int)
    for key in ("timed_out", "cancelled", "owned_cleanup_verified"):
        _require(value[key] is None or type(value[key]) is bool)
    _require(value["process_outcome"] is None or type(value["process_outcome"]) is str and bool(value["process_outcome"]))
    captures = value["captures"]
    _require(type(captures) is dict and set(captures) == {"stdout", "stderr", "sidecar"})
    for name, original in (("stdout", stdout), ("stderr", stderr), ("sidecar", sidecar)):
        capture = captures[name]
        _require(type(capture) is dict and set(capture) == CAPTURE_FIELDS)
        _require(all(flag is None or type(flag) is bool for flag in capture.values()))
        _require(original is not None or capture["complete"] is not True)
    _require(value["input_bytes_boundary"] == {
        "kind": "PROVIDER_PROMPT_RAW_BYTES", "prompt_sha256": binding["provider_prompt_sha256"], "plan_sha256": binding["plan_sha256"]})
    _require(value["output_bytes_boundary"] == {"kind": "STDOUT_RAW_BYTES", "stdout_sha256": _sha(stdout)})
    usage = value["usage"]
    _require(usage is None or type(usage) is dict and set(usage) <= NON_TOKEN_USAGE_FIELDS)
    saved._usage(usage)  # strict finite counts, time and currency identities
    if usage is not None and usage.get("output_bytes") is not None:
        _require(stdout is not None and usage["output_bytes"] == len(stdout) and _capture_complete(captures["stdout"]))
    return copy.deepcopy(value)


def _capture_complete(value):
    return value["complete"] is True and value["truncated"] is False and value["read_error"] is False


def adapt_observed_completion_response(stdout_raw, stderr_raw, sidecar_raw, format_binding, *,
                                       expected_limits, machine_snapshot_raw=None, machine_validator=None):
    """machine_validator(snapshot_bytes, independent_context) returns exact facts.

    The trusted validator must bind these original hashes to actual Source,
    runtime, provider prompt, plan, currentness, process/capture/cleanup and usage.
    It owns any external validation and deadline. These local JSON fields are a
    private adapter input, not a registered schema or evidence of that trust.
    """
    for raw in (stdout_raw, stderr_raw, sidecar_raw, machine_snapshot_raw):
        if raw is not None and type(raw) is not bytes:
            raise TypeError("original captures must be bytes or None")
    answer = {"stdout_raw": stdout_raw, "stderr_raw": stderr_raw, "stdout_sha256": _sha(stdout_raw),
              "stderr_sha256": _sha(stderr_raw), "sidecar_raw": sidecar_raw, "sidecar_sha256": _sha(sidecar_raw),
              "observation_raw": machine_snapshot_raw, "observation_sha256": _sha(machine_snapshot_raw),
              "payload_raw": None, "payload_sha256": None, "framing_raw": None, "candidate_parsed": False,
              "parsed_candidate": None, "process_observation": None, "usage": None,
              "usage_missing_fields": sorted(USAGE_FIELDS), "format_binding": None, "token_records": None,
              "gaps": [], "terminal_status": None, "authority_effect": "NONE", "qualification": "NOT_ISSUED"}
    def gap(code):
        if code not in answer["gaps"]:
            answer["gaps"].append(code)
    try:
        _require(_binding(format_binding))
        records._limits(expected_limits, format_binding.get("development_budget_class"))
    except Exception:
        gap("UNKNOWN_OR_INCOMPATIBLE_FORMAT_BINDING_OR_LIMITS")
        return answer
    binding, limits = copy.deepcopy(format_binding), copy.deepcopy(expected_limits)
    answer["format_binding"] = binding
    if machine_snapshot_raw is None:
        gap("PROCESS_OBSERVATION_MISSING")
        return answer
    try:
        observed = _machine(machine_snapshot_raw, machine_validator, binding, limits, stdout_raw, stderr_raw, sidecar_raw)
    except Exception:
        gap("OBSERVATION_UNVERIFIED_OR_INVALID")
        return answer
    answer["process_observation"] = observed
    usage = {key: None for key in USAGE_FIELDS}
    if observed["usage"] is not None:
        usage.update(copy.deepcopy(observed["usage"]))
    settled = (observed["exit_code"] is not None and type(observed["timed_out"]) is bool
               and type(observed["cancelled"]) is bool and observed["process_outcome"] is not None
               and observed["owned_cleanup_verified"] is True)
    captures_complete = all(_capture_complete(v) for v in observed["captures"].values())
    if not settled:
        gap("PROCESS_CLOSURE_OR_CLEANUP_INCOMPLETE")
    if not captures_complete:
        gap("CAPTURE_INCOMPLETE_OR_FAILED")
    tokens = None
    if sidecar_raw is None:
        gap("SIDECAR_MISSING")
    else:
        # This closure transports a successful external machine validation of
        # the identical raw hash/format/limits/plan to the pure parser. It does
        # not authenticate that validator or manufacture another authority.
        parser_binding = {"machine_snapshot_sha256": _sha(machine_snapshot_raw), "format_binding": binding,
                          "plan_sha256": binding["plan_sha256"]}
        selected = binding.get("development_budget_class")
        if selected is not None:
            parser_binding["development_budget_class"] = selected
        def bound_sidecar(raw, supplied_limits, supplied_binding):
            _require(_sha(raw) == observed["sidecar_sha256"] and records._canonical(supplied_limits) == records._canonical(limits)
                     and records._canonical(supplied_binding) == records._canonical(parser_binding))
        tokens = records.parse_runtime_observation(sidecar_raw, expected_limits=limits, binding=parser_binding,
                                                   verify_binding=bound_sidecar, development_budget_class=selected)
        answer["token_records"] = tokens
        if not tokens["complete"]:
            gap("TOKEN_STREAM_INCOMPLETE_OR_NON_NORMAL")
    stop_consistent = tokens is not None and tokens["complete"] and tokens["frames"][-1]["reason"] == binding["declared_stop"]
    if tokens is not None and tokens["complete"] and not stop_consistent:
        gap("DECLARED_STOP_MISMATCH")
    if settled and captures_complete and stop_consistent:
        usage.update({key: tokens["usage"][key] for key in ("input_tokens", "output_tokens")})
    if any(value is not None for value in usage.values()):
        answer["usage"] = usage
        answer["usage_missing_fields"] = sorted(key for key, value in usage.items() if value is None)
    if answer["usage_missing_fields"]:
        gap("USAGE_INCOMPLETE")
    normal = (settled and captures_complete and observed["exit_code"] == 0 and observed["timed_out"] is False
              and observed["cancelled"] is False and observed["process_outcome"] == "PROCESS_EXIT")
    if not normal:
        gap("PROCESS_NOT_NORMAL_OR_CAPTURE_CLOSURE_UNVERIFIED")
        return answer
    if not stop_consistent:
        return answer
    if stdout_raw is None:
        gap("STDOUT_MISSING")
        return answer
    if len(stdout_raw) > saved.MAX_PARSE_BYTES:
        gap("LOCAL_PARSE_BOUND_EXCEEDED")
        return answer
    newline = b"\n" if binding["newline"] == "LF" else b"\r\n"
    trailer = (b" [end of text]" + newline * 3) if binding["declared_stop"] == "eog" else newline * 2
    if not stdout_raw.endswith(trailer):
        gap("SOURCE_STOP_TRAILER_MISSING_OR_DIFFERENT")
        return answer
    payload = stdout_raw[:-len(trailer)]
    answer["payload_raw"], answer["payload_sha256"], answer["framing_raw"] = payload, _sha(payload), trailer
    try:
        answer["parsed_candidate"] = saved._json(payload)
        answer["candidate_parsed"] = True
    except Exception:
        gap("PAYLOAD_NOT_STRICT_FINITE_JSON")
    return answer
