"""Read-only local timing extraction from retained terminal bytes, never v2 usage."""
from datetime import datetime
from decimal import Decimal
import hashlib
import json
import math
import re

MAX_TERMINAL_BYTES = 1048576
SCOPE = "FIRST_BEFORE_START_BOUNDARY_TO_TRANSPORT_SETTLED_RETURN"
POINT_KEYS = {"monotonic_seconds", "utc_rfc3339", "clock_errors"}
TIMING_KEYS = {"measurement_scope", "started", "transport_settled", "monotonic_elapsed_ms", "clock_errors",
               "measurement_complete", "utc_and_monotonic_sampled_separately", "adopted_v2_usage",
               "authority_effect", "qualification"}


def require(ok, code):
    if not ok:
        raise ValueError("PROVIDER_TIMING_PROJECTION_" + code)


def _number(value):
    # The original recursive terminal serializer encodes every float as this
    # exact lossless envelope. Integers remain integers. No perf-text fallback.
    if type(value) is int:
        number = value
    else:
        require(type(value) is dict and set(value) == {"encoding", "data"}
                and value["encoding"] == "float64_hex" and type(value["data"]) is str
                and len(value["data"]) <= 64, "NUMBER_ENCODING")
        try:
            number = float.fromhex(value["data"])
        except (ValueError, OverflowError) as exc:
            raise ValueError("PROVIDER_TIMING_PROJECTION_NUMBER_ENCODING") from exc
        require(number.hex() == value["data"], "NUMBER_CANONICAL_ENCODING")
    try:
        require(math.isfinite(number) and number >= 0, "NUMBER_FINITE_NONNEGATIVE")
    except OverflowError as exc:
        raise ValueError("PROVIDER_TIMING_PROJECTION_NUMBER_FINITE_NONNEGATIVE") from exc
    return number


def _utc(value):
    require(type(value) is str and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z", value), "UTC_TIMESTAMP")
    try:
        point = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise ValueError("PROVIDER_TIMING_PROJECTION_UTC_TIMESTAMP") from exc
    require(point.isoformat(timespec="microseconds").replace("+00:00", "Z") == value, "UTC_TIMESTAMP")
    return point


def _strict_terminal(raw):
    require(type(raw) is bytes and 0 < len(raw) <= MAX_TERMINAL_BYTES, "TERMINAL_BYTE_BOUND")
    def pairs(rows):
        result = {}
        for key, value in rows:
            require(key not in result, "TERMINAL_DUPLICATE_KEY")
            result[key] = value
        return result
    def constant(_):
        raise ValueError("PROVIDER_TIMING_PROJECTION_TERMINAL_NONFINITE")
    try:
        result = json.loads(raw.decode("utf-8", "strict"), object_pairs_hook=pairs, parse_constant=constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise ValueError("PROVIDER_TIMING_PROJECTION_TERMINAL_JSON") from exc
    stack = [(result, 0)]
    while stack:
        node, depth = stack.pop()
        require(depth <= 64, "TERMINAL_DEPTH")
        if type(node) is float:
            require(math.isfinite(node), "TERMINAL_NONFINITE")
        elif type(node) is dict:
            stack.extend((child, depth + 1) for child in node.values())
        elif type(node) is list:
            stack.extend((child, depth + 1) for child in node)
    require(type(result) is dict, "TERMINAL_OBJECT")
    return result


def extract_provider_timing_projection(terminal_raw, *, expected_terminal_sha256, timing_tolerance_ms):
    """Requires retained raw pin and explicit tolerance; authenticates neither.

    Values are only future local clock evidence. Missing clocks/measurement or
    unmatched UTC/monotonic intervals reject. Whole execution-entry time is
    never consulted. No process, file, authority callback or record is created.
    """
    require(type(expected_terminal_sha256) is str and re.fullmatch(r"[0-9a-f]{64}", expected_terminal_sha256), "EXPECTED_RAW_PIN")
    require(type(timing_tolerance_ms) in (int, float), "EXPLICIT_TOLERANCE")
    try:
        require(math.isfinite(timing_tolerance_ms) and timing_tolerance_ms >= 0, "EXPLICIT_TOLERANCE")
    except OverflowError as exc:
        raise ValueError("PROVIDER_TIMING_PROJECTION_EXPLICIT_TOLERANCE") from exc
    terminal = _strict_terminal(terminal_raw)
    require(hashlib.sha256(terminal_raw).hexdigest() == expected_terminal_sha256, "RETAINED_RAW_PIN")
    require("usage" in terminal and terminal["usage"] is None and terminal.get("model_output_validated") is False
            and terminal.get("authority_effect") == "NONE", "NO_ADOPTED_USAGE_OR_AUTHORITY")
    timing = terminal.get("provider_timing_observation")
    require(type(timing) is dict and set(timing) == TIMING_KEYS, "TIMING_MISSING_OR_FIELDS")
    require(timing["measurement_scope"] == SCOPE and timing["measurement_complete"] is True
            and timing["clock_errors"] == [] and timing["utc_and_monotonic_sampled_separately"] is True
            and timing["adopted_v2_usage"] is None and timing["authority_effect"] == "NONE"
            and timing["qualification"] == "NOT_ISSUED", "TIMING_INCOMPLETE_OR_AUTHORITY")
    points = []
    for name in ("started", "transport_settled"):
        point = timing[name]
        require(type(point) is dict and set(point) == POINT_KEYS and point["clock_errors"] == [], "ENDPOINT_INCOMPLETE")
        points.append((_number(point["monotonic_seconds"]), _utc(point["utc_rfc3339"])))
    first, last = points
    require(last[0] >= first[0] and last[1] >= first[1], "CLOCK_REGRESSED")
    measured = _number(timing["monotonic_elapsed_ms"])
    recomputed = (last[0] - first[0]) * 1000
    require(math.isfinite(recomputed) and measured == recomputed, "MONOTONIC_DURATION_MISMATCH")
    utc_delta = last[1] - first[1]
    utc_microseconds = (utc_delta.days * 86400 + utc_delta.seconds) * 1000000 + utc_delta.microseconds
    utc_elapsed_ms = Decimal(utc_microseconds) / Decimal(1000)
    difference_ms = abs(Decimal(str(measured)) - utc_elapsed_ms)
    require(difference_ms <= Decimal(str(timing_tolerance_ms)), "UTC_MONOTONIC_DURATION_MISMATCH")
    return {"status": "LOCAL_TIMING_INPUT_PROJECTION_ONLY_NOT_FORMAL_USAGE",
            "terminal_raw_sha256": expected_terminal_sha256, "terminal_raw_bytes": len(terminal_raw),
            "source_json_pointer": "/provider_timing_observation", "measurement_scope": SCOPE,
            "started_utc_observation": timing["started"]["utc_rfc3339"],
            "settled_utc_observation": timing["transport_settled"]["utc_rfc3339"],
            "started_monotonic_seconds": first[0], "settled_monotonic_seconds": last[0],
            "observed_monotonic_elapsed_ms": measured, "observed_utc_elapsed_ms_decimal": str(utc_elapsed_ms),
            "utc_monotonic_difference_ms_decimal": str(difference_ms), "supplied_timing_tolerance_ms": timing_tolerance_ms,
            "whole_execution_entry_elapsed_used": False, "usage": None,
            "authority_effect": "NONE", "qualification": "NOT_ISSUED",
            "formal_result_raw": None, "formal_attempt_raw": None,
            "authenticated_current_invocation_binding_established": False}
