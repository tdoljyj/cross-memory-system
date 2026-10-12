"""New pure Source byte tests, hypothetical observations; no Dataset or model."""

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest


SOURCE = Path(__file__).resolve().parents[1] / "scripts/model-program/completion_saved_response.py"
SPEC = importlib.util.spec_from_file_location("private_completion_bytes", SOURCE)
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


def binding(framing="source_eog_trailer", newline="LF"):
    return {**M.RUNTIME_SOURCE_PINS, **M.FORMAT_ASSUMPTIONS,
            "framing": framing, "newline": newline}


def encode(value):
    return json.dumps(value, separators=(",", ":"), allow_nan=False).encode()


def machine(stdout, stderr=b"", **updates):
    b = binding()
    value = {"observation_ref": "hypothetical:machine-observation",
             "stdout_sha256": M._sha(stdout), "stderr_sha256": M._sha(stderr),
             **{k: b[k] for k in ("archive_sha256", "executable_sha256", "implementation_sha256")},
             "exit_code": 0, "timed_out": False, "cancelled": False, "usage": None}
    value.update(updates)
    return encode(value)


def validate(raw, _binding):
    # Hypothetical pure validator for byte tests, not runtime qualification.
    return json.loads(raw)


class CompletionByteTests(unittest.TestCase):
    def assert_raw(self, answer, stdout, stderr):
        self.assertIs(answer["stdout_raw"], stdout)
        self.assertIs(answer["stderr_raw"], stderr)
        self.assertEqual(answer["stdout_sha256"], M._sha(stdout))
        self.assertEqual(answer["stderr_sha256"], M._sha(stderr))
        self.assertIsNone(answer["terminal_status"])
        self.assertEqual(answer["qualification"], "NOT_ISSUED")

    def test_exact_lf_trailer_preserves_original_payload_and_missing_usage(self):
        payload = b' {"value":"example"} \n'
        stdout, stderr = payload + b" [end of text]\n\n\n", b"perf diagnostics"
        answer = M.adapt_completion_response(stdout, stderr, binding())
        self.assert_raw(answer, stdout, stderr)
        self.assertEqual(answer["payload_raw"], payload)
        self.assertEqual(answer["payload_sha256"], hashlib.sha256(payload).hexdigest())
        self.assertTrue(answer["candidate_parsed"])
        self.assertIsNone(answer["usage"])
        self.assertIn("PROCESS_OBSERVATION_MISSING", answer["gaps"])

    def test_crlf_only_when_explicitly_bound(self):
        stdout = b'{} [end of text]\r\n\r\n\r\n'
        self.assertFalse(M.adapt_completion_response(stdout, b"", binding())["candidate_parsed"])
        self.assertTrue(M.adapt_completion_response(stdout, b"", binding(newline="CRLF"))["candidate_parsed"])

    def test_unknown_binding_and_each_pin_or_assumption_fail_closed(self):
        stdout, stderr = b'{} [end of text]\n\n\n', b"failure preserved"
        for supplied in (None, {}, {**binding(), "marker": "arbitrary"}):
            answer = M.adapt_completion_response(stdout, stderr, supplied)
            self.assert_raw(answer, stdout, stderr)
            self.assertFalse(answer["candidate_parsed"])
        for key in M.RUNTIME_SOURCE_PINS:
            with self.subTest(pin=key):
                answer = M.adapt_completion_response(stdout, stderr, {**binding(), key: "wrong"})
                self.assertFalse(answer["candidate_parsed"])
        for key, value in M.FORMAT_ASSUMPTIONS.items():
            with self.subTest(assumption=key):
                answer = M.adapt_completion_response(stdout, stderr, {**binding(), key: not value})
                self.assertFalse(answer["candidate_parsed"])

    def test_strict_json_never_scrapes_marker_log_or_markdown(self):
        for raw in (b'{} [end of text]\n\n\n', b'log\n{}', b'```json\n{}\n```', b'{} {}'):
            with self.subTest(raw=raw):
                answer = M.adapt_completion_response(raw, b"", binding("strict_json"))
                self.assert_raw(answer, raw, b"")
                self.assertFalse(answer["candidate_parsed"])

    def test_marker_inside_json_string_is_preserved(self):
        payload = b'{"text":" [end of text]"}'
        answer = M.adapt_completion_response(payload + b" [end of text]\n\n\n", b"", binding())
        self.assertEqual(answer["parsed_candidate"], {"text": " [end of text]"})
        self.assertEqual(answer["payload_raw"], payload)

    def test_wrong_missing_duplicate_or_extra_trailers_not_repaired(self):
        for raw in (b'{}', b'{} [end of text]\n', b'{} [end of text]\n\n\n ',
                    b'{} [end of text]\n\n\n [end of text]\n\n\n',
                    b'{} [end of text]\n\n\nlog'):
            with self.subTest(raw=raw):
                self.assertFalse(M.adapt_completion_response(raw, b"", binding())["candidate_parsed"])

    def test_nonfinite_duplicate_keys_invalid_utf8_bom_and_deep_json_refused(self):
        for raw in (b'{"a":1,"a":2}', b'{"a":NaN}', b'{"a":Infinity}', b'{"a":1e999}',
                    b'\xff', b'\xef\xbb\xbf{}', b'{"a":"\\ud800"}', b'{"\\udfff":1}',
                    b'[' * 1100 + b'0' + b']' * 1100):
            with self.subTest(raw=raw[:30]):
                answer = M.adapt_completion_response(raw, b"", binding("strict_json"))
                self.assertEqual(answer["payload_raw"], raw)
                self.assertFalse(answer["candidate_parsed"])

    def test_valid_json_null_is_distinct_from_parse_failure(self):
        answer = M.adapt_completion_response(b'null', b"", binding("strict_json"))
        self.assertTrue(answer["candidate_parsed"])
        self.assertIsNone(answer["parsed_candidate"])

    def test_missing_and_oversize_captures_preserve_identity(self):
        for raw in (None, b"x" * (M.MAX_PARSE_BYTES + 1)):
            answer = M.adapt_completion_response(raw, None, binding())
            self.assert_raw(answer, raw, None)
            self.assertFalse(answer["candidate_parsed"])

    def test_perf_budget_and_bench_text_never_becomes_usage(self):
        stderr = b'common_perf_print: eval time = 1.00 ms / 3 runs\nmax_input_tokens=4096\nbench tg128'
        answer = M.adapt_completion_response(b'{} [end of text]\n\n\n', stderr, binding())
        self.assertIsNone(answer["usage"])
        self.assertEqual(answer["stderr_raw"], stderr)

    def test_verified_machine_usage_stays_partial_and_inputs_not_mutated(self):
        stdout, stderr = b'{} [end of text]\n\n\n', b""
        raw = machine(stdout, stderr, usage={"input_tokens": 3, "output_tokens": None})
        b = binding(); before = copy.deepcopy(b)
        answer = M.adapt_completion_response(stdout, stderr, b, observation_raw=raw,
                                             observation_validator=validate)
        self.assertTrue(answer["candidate_parsed"])
        self.assertEqual(answer["usage"], {"input_tokens": 3, "output_tokens": None})
        self.assertNotIn("cost_minor_units", answer["usage"])
        self.assertIn("cost_minor_units", answer["usage_missing_fields"])
        self.assertIn("output_tokens", answer["usage_missing_fields"])
        self.assertNotIn("input_tokens", answer["usage_missing_fields"])
        self.assertIn("USAGE_INCOMPLETE", answer["gaps"])
        self.assertEqual(b, before)
        self.assertIs(answer["observation_raw"], raw)

    def test_verified_failure_timeout_cancel_preserved_and_blocks_candidate(self):
        stdout = b'{} [end of text]\n\n\n'
        for update in ({"exit_code": 1}, {"timed_out": True}, {"cancelled": True}):
            with self.subTest(update=update):
                raw = machine(stdout, **update)
                answer = M.adapt_completion_response(stdout, b"", binding(), observation_raw=raw,
                                                     observation_validator=validate)
                self.assertEqual(answer["process_observation"], json.loads(raw))
                self.assertFalse(answer["candidate_parsed"])
                self.assertIn("PROCESS_FAILED_TIMED_OUT_OR_CANCELLED", answer["gaps"])

    def test_missing_closure_does_not_become_zero_or_success(self):
        stdout = b'{} [end of text]\n\n\n'
        raw = machine(stdout, exit_code=None, timed_out=None, cancelled=None)
        answer = M.adapt_completion_response(stdout, b"", binding(), observation_raw=raw,
                                             observation_validator=validate)
        self.assertIn("PROCESS_CLOSURE_INCOMPLETE", answer["gaps"])
        self.assertIsNone(answer["process_observation"]["exit_code"])
        self.assertIsNone(answer["terminal_status"])

    def test_raw_verified_flag_cannot_replace_validator(self):
        stdout = b'{} [end of text]\n\n\n'
        raw = machine(stdout, usage={"input_tokens": 3})
        answer = M.adapt_completion_response(stdout, b"", binding(), observation_raw=raw)
        self.assertIsNone(answer["usage"])
        self.assertIn("OBSERVATION_UNVERIFIED_OR_INVALID", answer["gaps"])
        forged = encode({**json.loads(raw), "verified": True})
        answer = M.adapt_completion_response(stdout, b"", binding(), observation_raw=forged,
                                             observation_validator=validate)
        self.assertIsNone(answer["usage"])

    def test_stream_runtime_usage_and_callback_mismatches_refused(self):
        stdout = b'{} [end of text]\n\n\n'
        for update in ({"stdout_sha256": "wrong"}, {"implementation_sha256": "wrong"},
                       {"usage": {"input_tokens": True}}, {"usage": {"output_tokens": -1}},
                       {"usage": {"estimated_tokens": 3}}, {"usage": {"elapsed_ms": "1.0"}}):
            with self.subTest(update=update):
                answer = M.adapt_completion_response(stdout, b"", binding(),
                    observation_raw=machine(stdout, **update), observation_validator=validate)
                self.assertIsNone(answer["process_observation"])
                self.assertIsNone(answer["usage"])
        def mutate(raw, b):
            b["entry"] = "changed"
            return json.loads(raw)
        def alter(raw, b):
            value = json.loads(raw); value["usage"] = {"input_tokens": 7}; return value
        def raise_secret(raw, b):
            raise RuntimeError("SECRET_SHOULD_NOT_APPEAR")
        for callback in (mutate, alter, raise_secret, lambda raw, b: True):
            answer = M.adapt_completion_response(stdout, b"", binding(),
                observation_raw=machine(stdout), observation_validator=callback)
            self.assertIsNone(answer["process_observation"])
            self.assertNotIn("SECRET_SHOULD_NOT_APPEAR", str(answer["gaps"]))

    def test_callback_bool_numeric_changes_refused_type_sensitive(self):
        stdout = b'{} [end of text]\n\n\n'
        raw = machine(stdout, usage={"input_tokens": 3})
        def changed_binding(key, value):
            def callback(raw, b):
                b[key] = value
                return json.loads(raw)
            return callback
        def changed_fact(key, value):
            def callback(raw, b):
                facts = json.loads(raw)
                facts[key] = value
                return facts
            return callback
        def changed_count(raw, b):
            facts = json.loads(raw)
            facts["usage"]["input_tokens"] = 3.0
            return facts
        callbacks = (changed_binding("display_prompt", 0),
                     changed_binding("simple_io", 1),
                     changed_fact("timed_out", 0),
                     changed_fact("exit_code", False), changed_count)
        for callback in callbacks:
            with self.subTest(callback=callback):
                answer = M.adapt_completion_response(stdout, b"", binding(),
                    observation_raw=raw, observation_validator=callback)
                self.assertIsNone(answer["process_observation"])
                self.assertIsNone(answer["usage"])
                self.assertEqual(answer["observation_raw"], raw)
                self.assertIn("OBSERVATION_UNVERIFIED_OR_INVALID", answer["gaps"])


if __name__ == "__main__":
    unittest.main()
