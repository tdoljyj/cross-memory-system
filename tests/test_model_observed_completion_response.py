"""Pure public-payload/non-model-sidecar fixtures, never actual observations."""
import builtins
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import types
import unittest


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts/model-program"
def load(name):
    spec = importlib.util.spec_from_file_location("private_" + name, SCRIPTS / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
SAVED = load("completion_saved_response")
RECORDS = load("runtime_observation_records")
SOURCE = SCRIPTS / "observed_completion_response.py"
M = types.ModuleType("private_observed_response")
M.__file__ = str(SOURCE)
private_builtins = dict(vars(builtins))
def private_import(name, globals=None, locals=None, fromlist=(), level=0):
    if not level and name == "completion_saved_response":
        return SAVED
    if not level and name == "runtime_observation_records":
        return RECORDS
    return builtins.__import__(name, globals, locals, fromlist, level)
private_builtins["__import__"] = private_import
M.__dict__["__builtins__"] = private_builtins
exec(compile(SOURCE.read_bytes(), str(SOURCE), "exec"), M.__dict__)

LIMITS = {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5}
TICK = 19876031  # Saved non-model fixture uptime tick; never elapsed/UTC.
def encode(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")

def binding(stop="eog", newline="LF"):
    return {**M.SOURCE_PINS, **M.FORMAT_ASSUMPTIONS,
            "runtime_files": {name: {"bytes": size, "sha256": digest} for name, (size, digest) in M.RUNTIME_FILES.items()},
            "framing": "source_stop_trailer", "newline": newline, "declared_stop": stop,
            "plan_sha256": "a" * 64, "provider_prompt_sha256": "b" * 64}

def input_frame(count=2, predict=2, total=5):
    return {"event_seq": 1, "monotonic_ms": TICK, "kind": "input", "input_tokens": count,
            "input_limit": 3, "predict_limit": predict, "total_limit": total}

def sample(ordinal=1, token=101, eog=False):
    return {"event_seq": ordinal + 1, "monotonic_ms": TICK, "kind": "sample",
            "sampled_ordinal": ordinal, "token_id": token, "eog": eog}

def terminal(count=2, samples=2, reason="eog", normal=True):
    return {"event_seq": samples + 2, "monotonic_ms": TICK, "kind": "terminal", "reason": reason,
            "normal_loop_exit": normal, "input_tokens": count, "sampled_tokens_including_eog": samples}

def sidecar(frames=None):
    if frames is None:
        frames = [input_frame(), sample(), sample(2, 102, True), terminal()]
    return b"".join(encode(frame) + b"\n" for frame in frames)

def snapshot(stdout, stderr, raw_sidecar, fmt, limits=LIMITS, usage=None, **updates):
    value = {"observation_ref": "hypothetical:nonmodel-machine-snapshot",
             "stdout_sha256": M._sha(stdout), "stderr_sha256": M._sha(stderr), "sidecar_sha256": M._sha(raw_sidecar),
             "format_binding_sha256": M._digest(fmt), "plan_sha256": fmt["plan_sha256"],
             "expected_limits": copy.deepcopy(limits), "exit_code": 0, "timed_out": False, "cancelled": False,
             "process_outcome": "PROCESS_EXIT", "owned_cleanup_verified": True,
             "captures": {key: {"complete": raw is not None, "truncated": False, "read_error": False}
                          for key, raw in (("stdout", stdout), ("stderr", stderr), ("sidecar", raw_sidecar))},
             "input_bytes_boundary": {"kind": "PROVIDER_PROMPT_RAW_BYTES", "prompt_sha256": fmt["provider_prompt_sha256"], "plan_sha256": fmt["plan_sha256"]},
             "output_bytes_boundary": {"kind": "STDOUT_RAW_BYTES", "stdout_sha256": M._sha(stdout)},
             "usage": usage}
    value.update(updates)
    return value

def machine_validator(raw, context):
    # Hypothetical pure fixture callback; never a qualified actual caller.
    return json.loads(raw)

def non_token_usage(stdout):
    return {"input_bytes": 27, "output_bytes": len(stdout), "elapsed_ms": 17.5, "cost_minor_units": 7,
            "currency": "USD", "currency_exponent": 2, "currency_profile_digest": "sha256:" + "c" * 64}


class ObservedCompletionResponseTests(unittest.TestCase):
    def adapt(self, stdout=b'{"value":"example"} [end of text]\n\n\n', stderr=b"", raw_sidecar=None,
              fmt=None, limits=None, value=None, validator=machine_validator):
        fmt = binding() if fmt is None else fmt
        limits = copy.deepcopy(LIMITS if limits is None else limits)
        raw_sidecar = sidecar() if raw_sidecar is None else raw_sidecar
        value = snapshot(stdout, stderr, raw_sidecar, fmt, limits) if value is None else value
        machine = encode(value)
        result = M.adapt_observed_completion_response(stdout, stderr, raw_sidecar, fmt, expected_limits=limits,
                                                      machine_snapshot_raw=machine, machine_validator=validator)
        self.assertIs(result["stdout_raw"], stdout)
        self.assertIs(result["stderr_raw"], stderr)
        self.assertIs(result["sidecar_raw"], raw_sidecar)
        self.assertIs(result["observation_raw"], machine)
        self.assertEqual(result["stdout_sha256"], M._sha(stdout))
        self.assertEqual(result["sidecar_sha256"], M._sha(raw_sidecar))
        self.assertIsNone(result["terminal_status"])
        self.assertEqual(result["authority_effect"], "NONE")
        self.assertEqual(result["qualification"], "NOT_ISSUED")
        return result

    def test_exact_eog_payload_sidecar_counts_and_missing_accounting(self):
        payload = b' {"value":"example"} \n'
        stdout = payload + b" [end of text]\n\n\n"
        result = self.adapt(stdout, b"perf is not usage")
        self.assertTrue(result["candidate_parsed"])
        self.assertEqual(result["parsed_candidate"], {"value": "example"})
        self.assertEqual(result["payload_raw"], payload)
        self.assertEqual(result["framing_raw"], b" [end of text]\n\n\n")
        self.assertEqual(result["usage"]["input_tokens"], 2)
        self.assertEqual(result["usage"]["output_tokens"], 2)
        for key in M.NON_TOKEN_USAGE_FIELDS:
            self.assertIsNone(result["usage"][key])
        self.assertIn("USAGE_INCOMPLETE", result["gaps"])
        self.assertFalse(result["token_records"]["binding_authenticated_here"])

    def test_predict_exact_two_newlines_retains_payload_whitespace_and_external_usage(self):
        fmt = binding("predict")
        limits = {"input_tokens": 3, "output_tokens": 1, "total_tokens": 4}
        raw_sidecar = sidecar([input_frame(predict=1, total=4), sample(token=201), terminal(samples=1, reason="predict")])
        payload = b' {"value":"example"} \n'
        stdout = payload + b"\n\n"
        value = snapshot(stdout, b"", raw_sidecar, fmt, limits, non_token_usage(stdout))
        result = self.adapt(stdout, raw_sidecar=raw_sidecar, fmt=fmt, limits=limits, value=value)
        self.assertTrue(result["candidate_parsed"])
        self.assertEqual(result["payload_raw"], payload)
        self.assertEqual(result["framing_raw"], b"\n\n")
        self.assertEqual(result["usage"]["output_tokens"], 1)
        self.assertEqual(result["usage"]["elapsed_ms"], 17.5)
        self.assertEqual(result["usage"]["cost_minor_units"], 7)
        self.assertEqual(result["usage_missing_fields"], [])
        self.assertEqual(value["usage"], non_token_usage(stdout))

    def test_declared_stop_must_match_sidecar_before_stdout_parsing(self):
        result = self.adapt(fmt=binding("predict"))
        self.assertFalse(result["candidate_parsed"])
        self.assertIn("DECLARED_STOP_MISMATCH", result["gaps"])
        self.assertIsNone(result["usage"])
        self.assertTrue(result["token_records"]["complete"])

    def test_each_runtime_source_assumption_and_legacy_binding_rejected(self):
        stdout, stderr, original = b"{} [end of text]\n\n\n", b"raw failure", sidecar()
        bad = [None, {}, {**SAVED.RUNTIME_SOURCE_PINS, **SAVED.FORMAT_ASSUMPTIONS, "framing": "source_eog_trailer", "newline": "LF"},
               {**binding(), "archive_sha256": SAVED.RUNTIME_SOURCE_PINS["archive_sha256"]}]
        for key in M.SOURCE_PINS:
            bad.append({**binding(), key: "wrong"})
        for key in M.FORMAT_ASSUMPTIONS:
            bad.append({**binding(), key: int(M.FORMAT_ASSUMPTIONS[key])})
        for name in M.RUNTIME_FILES:
            value = binding();value["runtime_files"][name]["sha256"] = "0" * 64;bad.append(value)
        for supplied in bad:
            with self.subTest(binding=supplied):
                result = M.adapt_observed_completion_response(stdout, stderr, original, supplied, expected_limits=LIMITS)
                self.assertIs(result["stdout_raw"], stdout)
                self.assertIs(result["sidecar_raw"], original)
                self.assertFalse(result["candidate_parsed"])
                self.assertIsNone(result["format_binding"])
                self.assertIsNone(result["usage"])

    def test_explicit_newline_and_wrong_source_framing_not_repaired(self):
        result = self.adapt(b"{} [end of text]\r\n\r\n\r\n", fmt=binding(newline="CRLF"))
        self.assertTrue(result["candidate_parsed"])
        for stdout in (b"{}", b"{} [end of text]\n\n", b"{} [end of text]\n\n\n ",
                       b"{} [end of text]\r\n\r\n\r\n", b"{} [end of text]\n\n\nlog",
                       b"{} [end of text]\n\n\n [end of text]\n\n\n"):
            with self.subTest(stdout=stdout):
                self.assertFalse(self.adapt(stdout)["candidate_parsed"])
        fmt, limits = binding("predict"), {"input_tokens": 3, "output_tokens": 1, "total_tokens": 4}
        original = sidecar([input_frame(predict=1, total=4), sample(token=201), terminal(samples=1, reason="predict")])
        result = self.adapt(b"{}\n", raw_sidecar=original, fmt=fmt, limits=limits)
        self.assertFalse(result["candidate_parsed"])
        self.assertIn("SOURCE_STOP_TRAILER_MISSING_OR_DIFFERENT", result["gaps"])

    def test_payload_json_logs_markdown_utf8_and_surrogates_never_repaired(self):
        for payload in (b'{"a":1,"a":2}', b'{"a":NaN}', b'{"a":1e999}', b'\xff', b'{"x":"\\ud800"}',
                        b'{"\\udfff":1}', b"log\n{}", b"```json\n{}\n```", b"{} {}", b"\xef\xbb\xbf{}"):
            with self.subTest(payload=payload):
                result = self.adapt(payload + b" [end of text]\n\n\n")
                self.assertFalse(result["candidate_parsed"])
                self.assertEqual(result["payload_raw"], payload)
                self.assertEqual(result["usage"]["output_tokens"], 2)
                self.assertIn("PAYLOAD_NOT_STRICT_FINITE_JSON", result["gaps"])

    def test_machine_raw_runtime_plan_limits_and_byte_boundaries_are_bound(self):
        stdout, original, fmt = b"{} [end of text]\n\n\n", sidecar(), binding()
        for key in ("stdout_sha256", "stderr_sha256", "sidecar_sha256", "format_binding_sha256", "plan_sha256"):
            value = snapshot(stdout, b"", original, fmt);value[key] = "0" * 64
            with self.subTest(key=key):
                result = self.adapt(stdout, raw_sidecar=original, fmt=fmt, value=value)
                self.assertIn("OBSERVATION_UNVERIFIED_OR_INVALID", result["gaps"])
                self.assertIsNone(result["process_observation"])
        for key in ("input_bytes_boundary", "output_bytes_boundary"):
            value = snapshot(stdout, b"", original, fmt);value[key]["kind"] = "ORIGINAL_SEGMENT_BYTES"
            result = self.adapt(stdout, raw_sidecar=original, fmt=fmt, value=value)
            self.assertIn("OBSERVATION_UNVERIFIED_OR_INVALID", result["gaps"])
        value = snapshot(stdout, b"", original, fmt);value["expected_limits"]["input_tokens"] = 4
        self.assertIn("OBSERVATION_UNVERIFIED_OR_INVALID", self.adapt(stdout, value=value)["gaps"])

    def test_missing_private_error_and_type_mutating_validators_fail_closed(self):
        self.assertIn("OBSERVATION_UNVERIFIED_OR_INVALID", self.adapt(validator=None)["gaps"])
        def private_error(raw, context):raise RuntimeError("PRIVATE_CALLBACK_SECRET")
        result = self.adapt(validator=private_error)
        self.assertNotIn("PRIVATE_CALLBACK_SECRET", str(result["gaps"]))
        def mutation(raw, context):
            context["format_binding"]["display_prompt"] = 0  # False == 0 must not pass.
            return json.loads(raw)
        self.assertIn("OBSERVATION_UNVERIFIED_OR_INVALID", self.adapt(validator=mutation)["gaps"])
        def wrong_facts(raw, context):
            value = json.loads(raw);value["timed_out"] = 0
            return value
        self.assertIn("OBSERVATION_UNVERIFIED_OR_INVALID", self.adapt(validator=wrong_facts)["gaps"])
        self.assertIn("OBSERVATION_UNVERIFIED_OR_INVALID", self.adapt(validator=lambda *args: True)["gaps"])

    def test_real_failure_timeout_and_cleanup_capture_gaps_preserve_actual_partial_usage(self):
        stdout, original, fmt = b"{} [end of text]\n\n\n", sidecar(), binding()
        for update in ({"exit_code": 1}, {"exit_code": 1, "timed_out": True, "process_outcome": "TIMEOUT"},
                       {"cancelled": True}, {"owned_cleanup_verified": False}, {"exit_code": None}):
            value = snapshot(stdout, b"", original, fmt, usage=non_token_usage(stdout), **update)
            result = self.adapt(stdout, raw_sidecar=original, fmt=fmt, value=value)
            self.assertFalse(result["candidate_parsed"])
            self.assertEqual(result["usage"]["cost_minor_units"], 7)
            self.assertEqual(result["usage"]["elapsed_ms"], 17.5)
            if update.get("owned_cleanup_verified") is False or "exit_code" in update and update["exit_code"] is None:
                self.assertIsNone(result["usage"]["input_tokens"])
            else:
                self.assertEqual(result["usage"]["input_tokens"], 2)
        value = snapshot(stdout, b"", original, fmt, usage=non_token_usage(stdout))
        value["captures"]["sidecar"]["complete"] = False
        result = self.adapt(stdout, value=value)
        self.assertFalse(result["candidate_parsed"])
        self.assertIsNone(result["usage"]["output_tokens"])
        self.assertEqual(result["usage"]["cost_minor_units"], 7)

    def test_partial_empty_and_input_refusal_never_fill_missing_sample_counts(self):
        stdout, fmt = b"{} [end of text]\n\n\n", binding()
        partial = sidecar([input_frame(), sample(token=601, eog=True)])
        refused = sidecar([input_frame(count=4), terminal(count=4, samples=0, reason="input_or_total_or_context_limit", normal=False)])
        for original in (partial, b"", refused):
            value = snapshot(stdout, b"", original, fmt, usage={"cost_minor_units": 7}, exit_code=1)
            result = self.adapt(stdout, raw_sidecar=original, value=value)
            self.assertFalse(result["candidate_parsed"])
            self.assertIsNone(result["usage"]["input_tokens"])
            self.assertIsNone(result["usage"]["output_tokens"])
            self.assertEqual(result["usage"]["cost_minor_units"], 7)
            self.assertIn("TOKEN_STREAM_INCOMPLETE_OR_NON_NORMAL", result["gaps"])
        self.assertEqual(self.adapt(stdout, raw_sidecar=refused)["token_records"]["diagnostic"]["input_tokens"], 4)

    def test_exact_machine_keys_types_and_tokens_not_taken_from_snapshot(self):
        stdout, original, fmt = b"{} [end of text]\n\n\n", sidecar(), binding()
        values = []
        value = snapshot(stdout, b"", original, fmt);value["extra"] = True;values.append(value)
        value = snapshot(stdout, b"", original, fmt);value["exit_code"] = False;values.append(value)
        value = snapshot(stdout, b"", original, fmt);value["owned_cleanup_verified"] = 1;values.append(value)
        value = snapshot(stdout, b"", original, fmt);value["usage"] = {"input_tokens": 99};values.append(value)
        value = snapshot(stdout, b"", original, fmt);value["usage"] = {"cost_minor_units": False};values.append(value)
        value = snapshot(stdout, b"", original, fmt);value["usage"] = {"output_bytes": 1};values.append(value)
        for value in values:
            with self.subTest(value=value):
                result = self.adapt(stdout, value=value)
                self.assertIsNone(result["usage"])
                self.assertIn("OBSERVATION_UNVERIFIED_OR_INVALID", result["gaps"])
        changed_limits = {"input_tokens": 4, "output_tokens": 2, "total_tokens": 5}
        value = snapshot(stdout, b"", original, fmt, changed_limits)
        result = self.adapt(stdout, raw_sidecar=original, limits=changed_limits, value=value)
        self.assertFalse(result["candidate_parsed"])
        self.assertIn("PLAN_LIMIT_MISMATCH", result["token_records"]["errors"])

    def test_unknown_captures_and_local_bounds_do_not_estimate_usage_or_mutate_old_codec(self):
        old_pins, old_assumptions = dict(SAVED.RUNTIME_SOURCE_PINS), dict(SAVED.FORMAT_ASSUMPTIONS)
        stdout, original, fmt = b"{} [end of text]\n\n\n", sidecar(), binding()
        result = M.adapt_observed_completion_response(stdout, b"", original, fmt, expected_limits=LIMITS)
        self.assertFalse(result["candidate_parsed"])
        self.assertIsNone(result["usage"])
        self.assertIn("PROCESS_OBSERVATION_MISSING", result["gaps"])
        with self.assertRaises(TypeError):
            M.adapt_observed_completion_response(bytearray(stdout), b"", original, fmt, expected_limits=LIMITS)
        huge = b" " * (SAVED.MAX_PARSE_BYTES + 1) + b" [end of text]\n\n\n"
        result = self.adapt(huge)
        self.assertFalse(result["candidate_parsed"])
        self.assertIn("LOCAL_PARSE_BOUND_EXCEEDED", result["gaps"])
        self.assertEqual(result["usage"]["output_tokens"], 2)
        self.assertEqual(old_pins, dict(SAVED.RUNTIME_SOURCE_PINS))
        self.assertEqual(old_assumptions, dict(SAVED.FORMAT_ASSUMPTIONS))


if __name__ == "__main__":
    unittest.main()
