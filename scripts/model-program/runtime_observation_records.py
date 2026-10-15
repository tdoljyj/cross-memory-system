"""Pure, raw-preserving parser for the e567 completion observation candidate.

This consumes bytes, never files, models, clocks or processes. The caller must
independently verify the raw artifact, runtime/Source/plan identity and live
currentness. Its callback must return None and leave its independent snapshots
unchanged. A callback return or matching local hash does not authenticate that
caller or grant authority. The caller owns callback trust, I/O and deadlines.

Only a consistent normal eog/predict terminal supplies candidate token counts.
Missing, malformed, refused and partial streams retain raw bytes and diagnostics
without complete usage. Retained sample frames cannot count samples lost before
a failed write, and are never inferred from token pieces, perf text or budgets.
complete means stream consistency only, never process success or authenticated
real usage. A terminal can precede a close error/nonzero process exit. The caller
must also check owned cleanup, complete capture and the actual process outcome.
"""
import copy
import hashlib
import json
import math


MAX_RAW_BYTES = 131072
MAX_SAMPLES = 512
MAX_FRAMES = MAX_SAMPLES + 2
FOUR_B_BUDGET_CLASS = "m1_shortlist_4b_bf16_cpu8_v1"
UINT64_MAX = (1 << 64) - 1
LIMIT_KEYS = {"input_tokens", "output_tokens", "total_tokens"}
BASE_KEYS = {"event_seq", "monotonic_ms", "kind"}
FRAME_KEYS = {
    "input": BASE_KEYS | {"input_tokens", "input_limit", "predict_limit", "total_limit"},
    "sample": BASE_KEYS | {"sampled_ordinal", "token_id", "eog"},
    "terminal": BASE_KEYS | {"reason", "normal_loop_exit", "input_tokens", "sampled_tokens_including_eog"},
}
REFUSAL_REASONS = {"unsupported_configuration", "input_or_total_or_context_limit", "sample_budget_limit", "other_loop_exit"}


class ObservationError(ValueError):
    pass


def _require(ok, code):
    if not ok:
        raise ObservationError(code)


def _integer(value, lower, upper, code):
    _require(type(value) is int and lower <= value <= upper, code)


def _canonical(value):
    def check(item, depth=0):
        _require(depth <= 32, "JSON_DEPTH")
        if item is None or type(item) in (bool, int):
            return
        if type(item) is float:
            _require(math.isfinite(item), "JSON_NONFINITE")
            return
        if type(item) is str:
            item.encode("utf-8", errors="strict")
            return
        if type(item) is list:
            for child in item:
                check(child, depth + 1)
            return
        _require(type(item) is dict, "JSON_TYPE")
        for key, child in item.items():
            _require(type(key) is str, "JSON_KEY_TYPE")
            check(key, depth + 1)
            check(child, depth + 1)
    check(value)
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8", errors="strict")


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        _require(key not in result, "DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def _constant(value):
    raise ObservationError("JSON_NONFINITE")


def _policy(development_budget_class):
    _require(development_budget_class in (None, FOUR_B_BUDGET_CLASS), "DEVELOPMENT_BUDGET_CLASS")
    return ((147456, 1024, 5120) if development_budget_class == FOUR_B_BUDGET_CLASS
            else (MAX_RAW_BYTES, MAX_SAMPLES, 4608))


def _limits(value, development_budget_class=None):
    _require(type(value) is dict and set(value) == LIMIT_KEYS, "LIMIT_FIELDS")
    _, maximum_samples, total = _policy(development_budget_class)
    for key, maximum in (("input_tokens", 4096), ("output_tokens", maximum_samples), ("total_tokens", total)):
        _integer(value[key], 1, maximum, "LIMIT_VALUE")


def parse_runtime_observation(raw, *, expected_limits, binding, verify_binding, development_budget_class=None):
    """Return candidate facts; verify_binding(raw, limits_copy, binding_copy).

    binding is opaque, finite JSON metadata supplied by the trusted caller; this
    module neither invents an identity format nor verifies refs as authority.
    Callback snapshots are private copies and compared using type-sensitive
    canonical UTF-8 JSON. The callback must already bind this exact Source format
    and raw/runtime/plan/currentness; a permissive callback establishes no trust.
    """
    if type(raw) is not bytes:
        raise TypeError("raw must be exact bytes")
    result = {
        "raw": raw, "raw_sha256": hashlib.sha256(raw).hexdigest(),
        "parsed": False, "complete": False, "frames": [], "diagnostic": None,
        "usage": None, "errors": [], "gaps": [], "binding_callback_completed": False,
        "binding_authenticated_here": False, "authority_effect": "NONE", "gate": "NOT_ISSUED",
    }
    try:
        maximum_raw, maximum_samples, maximum_total = _policy(development_budget_class)
        _require(len(raw) <= maximum_raw, "RAW_BYTE_LIMIT")
        _limits(expected_limits, development_budget_class)
        _require(type(binding) is dict and bool(binding), "CALLER_BINDING_REQUIRED")
        if development_budget_class is not None:
            _require(binding.get("development_budget_class") == development_budget_class, "CALLER_CLASS_BINDING")
        else:
            _require("development_budget_class" not in binding, "CALLER_CLASS_BINDING")
        # Check exact JSON types before deepcopy can invoke an arbitrary object's
        # custom copy behavior. Only the caller's plain JSON metadata is accepted.
        limits_bytes, binding_bytes = _canonical(expected_limits), _canonical(binding)
        frozen_limits, frozen_binding = copy.deepcopy(expected_limits), copy.deepcopy(binding)
        _require(callable(verify_binding), "CALLER_VERIFIER_REQUIRED")
        callback_limits, callback_binding = copy.deepcopy(frozen_limits), copy.deepcopy(frozen_binding)
        try:
            answer = verify_binding(raw, callback_limits, callback_binding)
        except Exception as exc:
            raise ObservationError("CALLER_VERIFIER_EXCEPTION") from exc
        _require(answer is None, "CALLER_VERIFIER_RESULT")
        _limits(callback_limits, development_budget_class)
        _require(_canonical(callback_limits) == limits_bytes and _canonical(callback_binding) == binding_bytes,
                 "CALLER_VERIFIER_MUTATION")
        result["binding_callback_completed"] = True

        text = raw.decode("utf-8", errors="strict")
        _require("\r" not in text, "SOURCE_LF_FRAMING")
        lines = text.split("\n")
        if lines[-1]:
            # A killed/failed write can leave an unterminated tail. Do not parse
            # it as a whole record even when its prefix resembles complete JSON.
            result["gaps"].append("UNTERMINATED_FRAME")
        lines = lines[:-1]  # either trailing empty element or untrusted tail
        _require(len(lines) <= maximum_samples + 2, "FRAME_LIMIT")
        input_frame, samples, terminal, previous_tick = None, [], None, None
        for index, line in enumerate(lines, 1):
            frame = json.loads(line, object_pairs_hook=_pairs, parse_constant=_constant)
            _canonical(frame)  # reject nonfinite values and escaped surrogates
            _require(type(frame) is dict, "FRAME_OBJECT")
            kind = frame.get("kind")
            _require(type(kind) is str and kind in FRAME_KEYS, "FRAME_KIND")
            _require(set(frame) == FRAME_KEYS[kind], "FRAME_FIELDS")
            _integer(frame["event_seq"], 1, UINT64_MAX, "EVENT_SEQ_TYPE")
            _require(frame["event_seq"] == index, "EVENT_SEQ_CONTINUITY")
            _integer(frame["monotonic_ms"], 0, UINT64_MAX, "MONOTONIC_TYPE")
            _require(previous_tick is None or frame["monotonic_ms"] >= previous_tick, "MONOTONIC_REGRESSION")
            _require(terminal is None, "FRAME_AFTER_TERMINAL")
            if kind == "input":
                _require(input_frame is None and not samples and index == 1, "INPUT_ORDER_OR_DUPLICATE")
                _integer(frame["input_tokens"], 0, UINT64_MAX, "INPUT_COUNT_TYPE")
                for key, expected_key in (("input_limit", "input_tokens"), ("predict_limit", "output_tokens"),
                                          ("total_limit", "total_tokens")):
                    _integer(frame[key], 1, {"input_limit": 4096, "predict_limit": maximum_samples, "total_limit": maximum_total}[key], "FRAME_LIMIT_VALUE")
                    _require(frame[key] == frozen_limits[expected_key], "PLAN_LIMIT_MISMATCH")
                input_frame = frame
            elif kind == "sample":
                _require(input_frame is not None, "SAMPLE_BEFORE_INPUT")
                _require(not samples or samples[-1]["eog"] is False, "SAMPLE_AFTER_EOG")
                _require(input_frame["input_tokens"] <= frozen_limits["input_tokens"] and
                         input_frame["input_tokens"] + frozen_limits["output_tokens"] <= frozen_limits["total_tokens"],
                         "SAMPLE_AFTER_INPUT_REFUSAL")
                _integer(frame["sampled_ordinal"], 1, maximum_samples, "SAMPLE_ORDINAL_TYPE")
                _require(frame["sampled_ordinal"] == len(samples) + 1, "SAMPLE_ORDINAL_CONTINUITY")
                _integer(frame["token_id"], -(1 << 31), (1 << 31) - 1, "TOKEN_ID_TYPE")
                _require(type(frame["eog"]) is bool, "EOG_TYPE")
                _require(len(samples) < frozen_limits["output_tokens"] and
                         input_frame["input_tokens"] + len(samples) < frozen_limits["total_tokens"], "SAMPLE_LIMIT")
                samples.append(frame)
            else:
                _require(type(frame["reason"]) is str and frame["reason"] in REFUSAL_REASONS | {"eog", "predict"}, "TERMINAL_REASON")
                _require(type(frame["normal_loop_exit"]) is bool, "TERMINAL_NORMAL_TYPE")
                _integer(frame["sampled_tokens_including_eog"], 0, maximum_samples, "TERMINAL_SAMPLE_TYPE")
                _require(frame["sampled_tokens_including_eog"] == len(samples), "TERMINAL_SAMPLE_COUNT")
                expected_input = None if input_frame is None else input_frame["input_tokens"]
                if frame["input_tokens"] is not None:
                    _integer(frame["input_tokens"], 0, UINT64_MAX, "TERMINAL_INPUT_TYPE")
                _require(frame["input_tokens"] == expected_input, "TERMINAL_INPUT_COUNT")
                reason = frame["reason"]
                _require(frame["normal_loop_exit"] is (reason in {"eog", "predict"}), "TERMINAL_NORMAL_REASON")
                if reason == "unsupported_configuration":
                    _require(input_frame is None and not samples and index == 1, "UNSUPPORTED_CONFIGURATION_ORDER")
                else:
                    _require(input_frame is not None, "TERMINAL_WITHOUT_INPUT")
                    if reason in {"eog", "predict"}:
                        _require(input_frame["input_tokens"] <= frozen_limits["input_tokens"] and
                                 input_frame["input_tokens"] + frozen_limits["output_tokens"] <= frozen_limits["total_tokens"], "NORMAL_AFTER_INPUT_REFUSAL")
                        _require(bool(samples), "NORMAL_WITHOUT_SAMPLE")
                        _require(samples[-1]["eog"] is (reason == "eog"), "TERMINAL_EOG_REASON")
                        if reason == "predict":
                            _require(len(samples) == frozen_limits["output_tokens"], "PREDICT_COUNT")
                    elif reason == "input_or_total_or_context_limit":
                        _require(not samples, "INPUT_REFUSAL_AFTER_SAMPLE")
                    elif reason == "sample_budget_limit":
                        _require(len(samples) >= frozen_limits["output_tokens"] or
                                 input_frame["input_tokens"] + len(samples) >= frozen_limits["total_tokens"], "UNREACHED_SAMPLE_LIMIT")
                        _require(not samples or samples[-1]["eog"] is False, "REFUSAL_AFTER_EOG")
                terminal = frame
            previous_tick = frame["monotonic_ms"]
            result["frames"].append(frame)
            result["diagnostic"] = {
                "input_tokens": None if input_frame is None else input_frame["input_tokens"],
                "retained_sample_records": len(samples),
                "last_sampled_ordinal": None if not samples else samples[-1]["sampled_ordinal"],
                "terminal_frame_present": terminal is not None,
            }
        result["parsed"] = True
        if input_frame is None:
            result["gaps"].append("INPUT_NOT_OBSERVED")
        if terminal is None:
            result["gaps"].append("TERMINAL_MISSING")
        elif terminal["normal_loop_exit"] is False:
            result["gaps"].append("NON_NORMAL_TERMINAL")
        if not result["gaps"]:
            result["complete"] = True
            result["usage"] = {"input_tokens": input_frame["input_tokens"], "output_tokens": len(samples),
                               "total_tokens": input_frame["input_tokens"] + len(samples)}
    except (ObservationError, ValueError, UnicodeError, TypeError, OverflowError, RecursionError) as exc:
        result["errors"].append(str(exc) if isinstance(exc, ObservationError) else type(exc).__name__)
    except Exception:
        # External callback failure does not discard raw, disclose exception text
        # or turn a missing authority/currentness observation into usable counts.
        result["errors"].append("CALLER_VERIFIER_EXCEPTION")
    return result
