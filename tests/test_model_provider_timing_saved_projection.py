"""Portable Python saved-byte IO: original serializer, persistence and reader.

The unchanged JavaScript clone/stable retention was exercised in separate
bounded local evidence. These CI checks do not execute JavaScript or need Node.
No model, issuer or formal usage is constructed.
"""
import ast
import copy
from decimal import Decimal
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / "scripts/model-program"
SPEC = importlib.util.spec_from_file_location("private_provider_timing_projection", SOURCES / "provider_timing_saved_projection.py")
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)
extract_provider_timing_projection = M.extract_provider_timing_projection
SERIALIZER = SOURCES / "development_completion_entry.py"


def original_serializer():
    raw = SERIALIZER.read_bytes()
    tree = ast.parse(raw)
    node = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_result_json")
    import base64
    ns = {"math": math, "base64": base64}
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(SERIALIZER), "exec"), ns)
    return ns["_result_json"]


def timing_fixture():
    # Clock values only: no scenario, request identity, receipt, cost or currency.
    return {"measurement_scope": "FIRST_BEFORE_START_BOUNDARY_TO_TRANSPORT_SETTLED_RETURN",
            "started": {"monotonic_seconds": 10.25, "utc_rfc3339": "2031-01-01T00:00:00.000000Z", "clock_errors": []},
            "transport_settled": {"monotonic_seconds": 11.75, "utc_rfc3339": "2031-01-01T00:00:01.500000Z", "clock_errors": []},
            "monotonic_elapsed_ms": 1500.0, "clock_errors": [], "measurement_complete": True,
            "utc_and_monotonic_sampled_separately": True, "adopted_v2_usage": None,
            "authority_effect": "NONE", "qualification": "NOT_ISSUED"}


def terminal(timing=None):
    return {"provider_timing_observation": timing_fixture() if timing is None else timing,
            "elapsed_seconds": 149.5, "elapsed_seconds_scope": "WHOLE_OBSERVED_EXECUTION_ENTRY",
            "usage": None, "model_output_validated": False, "authority_effect": "NONE"}


def bytes_for(value):
    return json.dumps(original_serializer()(value), sort_keys=True, separators=(",", ":"), allow_nan=False).encode() + b"\n"


def extract(raw, tolerance=0):
    return extract_provider_timing_projection(raw, expected_terminal_sha256=hashlib.sha256(raw).hexdigest(), timing_tolerance_ms=tolerance)


class TimingRetentionChecks(unittest.TestCase):
    def test_original_serializer_persisted_bytes_keep_nested_clock_envelopes(self):
        encoded = original_serializer()(terminal())
        raw = json.dumps(encoded, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8") + b"\n"
        with tempfile.TemporaryDirectory(dir=os.environ.get("CLUED_MODEL_SOURCE_TEST_TEMP_ROOT")) as temporary:
            saved = Path(temporary) / "terminal-clock-fixture.json"
            saved.write_bytes(raw)
            reloaded = saved.read_bytes()
        self.assertEqual(reloaded, raw)
        retained = json.loads(reloaded)
        self.assertEqual(retained["provider_timing_observation"], encoded["provider_timing_observation"])
        self.assertEqual(retained["provider_timing_observation"]["monotonic_elapsed_ms"], {"encoding": "float64_hex", "data": (1500.0).hex()})
        projection = extract(reloaded)
        self.assertEqual(projection["observed_monotonic_elapsed_ms"], 1500.0)
        self.assertEqual(projection["observed_utc_elapsed_ms_decimal"], "1500")
        self.assertFalse(projection["whole_execution_entry_elapsed_used"])
        self.assertIsNone(projection["usage"])
        self.assertFalse(projection["authenticated_current_invocation_binding_established"])

    def test_rejects_missing_incomplete_regressed_and_mismatched_timing(self):
        mutations = [
            lambda t: t.update(measurement_complete=False),
            lambda t: t.update(clock_errors=["UTC_READ_FAILED:OSError"]),
            lambda t: t["started"].update(utc_rfc3339=None),
            lambda t: t["transport_settled"].update(monotonic_seconds=None),
            lambda t: t["transport_settled"].update(monotonic_seconds=9.0),
            lambda t: t["transport_settled"].update(utc_rfc3339="2030-12-31T23:59:59.000000Z"),
            lambda t: t.update(monotonic_elapsed_ms=1501.0),
            lambda t: t["transport_settled"].update(utc_rfc3339="2031-01-01T00:00:02.000000Z"),
            lambda t: t["started"].update(utc_rfc3339="invalid"),
            lambda t: t["started"].update(clock_errors=["MONOTONIC_VALUE_INVALID"]),
            lambda t: t.update(adopted_v2_usage={"elapsed_ms": 1500}),
        ]
        for mutation in mutations:
            value = timing_fixture()
            mutation(value)
            with self.assertRaises(ValueError):
                extract(bytes_for(terminal(value)))
        value = terminal()
        del value["provider_timing_observation"]
        with self.assertRaises(ValueError):
            extract(bytes_for(value))  #149.5 exists, but cannot fill missing time.

    def test_explicit_tolerance_raw_pin_and_finite_encoding_are_required(self):
        value = terminal()
        value["provider_timing_observation"]["transport_settled"]["utc_rfc3339"] = "2031-01-01T00:00:01.501000Z"
        raw = bytes_for(value)
        with self.assertRaises(ValueError):
            extract(raw, 0)
        self.assertEqual(Decimal(extract(raw, 1)["utc_monotonic_difference_ms_decimal"]), Decimal(1))
        for tolerance in (None, True, -1, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                extract(raw, tolerance)
        with self.assertRaises(TypeError):
            extract_provider_timing_projection(raw, expected_terminal_sha256=hashlib.sha256(raw).hexdigest())
        with self.assertRaises(ValueError):
            extract_provider_timing_projection(raw, expected_terminal_sha256="0" * 64, timing_tolerance_ms=1)
        encoded = original_serializer()(terminal())
        for data in ("inf", "nan", "0x1.0000000000000p+9999", " 0x1.0000000000000p+0"):
            altered = copy.deepcopy(encoded)
            altered["provider_timing_observation"]["monotonic_elapsed_ms"] = {"encoding": "float64_hex", "data": data}
            with self.assertRaises(ValueError):
                extract(json.dumps(altered).encode())


if __name__ == "__main__":
    unittest.main(verbosity=2)
