"""Pure technical frames based on the seven non-model Source fixtures.

No Corpus/Gold, models, tokenizer, device measurements or real authority.
"""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest


PATH = Path(__file__).resolve().parents[1] / "scripts/model-program/runtime_observation_records.py"
SPEC = importlib.util.spec_from_file_location("runtime_observation_records", PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
parse = MODULE.parse_runtime_observation
LIMITS = {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5}
BINDING = {"fixture_source_ref": "e567-technical-fixture-only", "caller_currentness_claim": True}
TICK = 19876031  # From the saved non-model fixture; not a duration or UTC time.


def input_frame(count=2, predict=2, total=5):
    return {"event_seq": 1, "monotonic_ms": TICK, "kind": "input", "input_tokens": count,
            "input_limit": 3, "predict_limit": predict, "total_limit": total}


def sample(ordinal=1, token=101, eog=False):
    return {"event_seq": ordinal + 1, "monotonic_ms": TICK, "kind": "sample",
            "sampled_ordinal": ordinal, "token_id": token, "eog": eog}


def terminal(count=2, samples=2, reason="eog", normal=True):
    return {"event_seq": samples + 2, "monotonic_ms": TICK, "kind": "terminal", "reason": reason,
            "normal_loop_exit": normal, "input_tokens": count, "sampled_tokens_including_eog": samples}


def eog_frames():
    return [input_frame(), sample(), sample(2, 102, True), terminal()]


def raw(frames):
    return b"".join(json.dumps(f, separators=(",", ":")).encode("utf-8") + b"\n" for f in frames)


def caller_fixture_callback(value, limits, binding):
    # Technical stand-in only; assertions below never authenticate this callback.
    return None


class RuntimeObservationRecordsTests(unittest.TestCase):
    def parse(self, value, limits=None, verifier=caller_fixture_callback, binding=None):
        return parse(value, expected_limits=copy.deepcopy(LIMITS if limits is None else limits),
                     binding=copy.deepcopy(BINDING if binding is None else binding), verify_binding=verifier)

    def invalid(self, value, code=None, **kwargs):
        answer = self.parse(value, **kwargs)
        self.assertFalse(answer["parsed"])
        self.assertFalse(answer["complete"])
        self.assertIsNone(answer["usage"])
        self.assertTrue(answer["errors"])
        if code is not None:
            self.assertIn(code, answer["errors"])
        self.assertEqual(answer["raw"], value)
        self.assertEqual(answer["raw_sha256"], hashlib.sha256(value).hexdigest())
        return answer

    def test_saved_normal_eog_counts_include_returned_eog(self):
        value = raw(eog_frames())
        seen = []
        def verifier(actual, limits, binding):
            seen.append((actual, limits, binding))
        answer = self.parse(value, verifier=verifier)
        self.assertTrue(answer["parsed"])
        self.assertTrue(answer["complete"])
        self.assertEqual(answer["usage"], {"input_tokens": 2, "output_tokens": 2, "total_tokens": 4})
        self.assertEqual(answer["frames"][-2]["eog"], True)
        self.assertEqual(answer["diagnostic"]["input_tokens"], 2)
        self.assertEqual(answer["diagnostic"]["retained_sample_records"], 2)
        self.assertEqual(answer["raw"], value)
        self.assertEqual(len(seen), 1)
        self.assertTrue(answer["binding_callback_completed"])
        self.assertFalse(answer["binding_authenticated_here"])
        self.assertEqual(answer["authority_effect"], "NONE")
        self.assertEqual(answer["gate"], "NOT_ISSUED")
        self.assertEqual(answer["errors"], [])
        self.assertEqual(answer["gaps"], [])

    def test_saved_normal_predict_needs_exact_predict_count(self):
        frames = [input_frame(predict=1, total=4), sample(token=201), terminal(samples=1, reason="predict")]
        answer = self.parse(raw(frames), {"input_tokens": 3, "output_tokens": 1, "total_tokens": 4})
        self.assertTrue(answer["complete"])
        self.assertEqual(answer["usage"], {"input_tokens": 2, "output_tokens": 1, "total_tokens": 3})
        self.assertEqual(answer["frames"][-1]["reason"], "predict")

    def test_saved_flush_partial_and_truncated_tail_never_supply_usage(self):
        frames = [input_frame(), sample(token=601, eog=True)]
        for value in (raw(frames), raw(frames) + b'{"event_seq":3', raw(frames)[:-1]):
            with self.subTest(value=value[-25:]):
                answer = self.parse(value)
                self.assertTrue(answer["parsed"])
                self.assertFalse(answer["complete"])
                self.assertIsNone(answer["usage"])
                self.assertIn("TERMINAL_MISSING", answer["gaps"])
                self.assertEqual(answer["diagnostic"]["input_tokens"], 2)
                self.assertFalse(answer["diagnostic"]["terminal_frame_present"])
                self.assertEqual(answer["raw"], value)
        self.assertEqual(self.parse(raw(frames))["diagnostic"]["retained_sample_records"], 1)
        self.assertEqual(self.parse(raw(frames)[:-1])["diagnostic"]["retained_sample_records"], 0)

    def test_saved_invalid_handle_or_real_write_failure_empty_raw_is_unknown(self):
        answer = self.parse(b"")
        self.assertTrue(answer["parsed"])
        self.assertFalse(answer["complete"])
        self.assertIsNone(answer["usage"])
        self.assertIsNone(answer["diagnostic"])
        self.assertEqual(answer["gaps"], ["INPUT_NOT_OBSERVED", "TERMINAL_MISSING"])
        self.assertEqual(answer["raw_sha256"], hashlib.sha256(b"").hexdigest())

    def test_refusal_terminal_preserves_counts_without_complete_usage(self):
        input_refusal = [input_frame(count=4), terminal(count=4, samples=0, reason="input_or_total_or_context_limit", normal=False)]
        sample_refusal = [input_frame(predict=1, total=4), sample(token=401), terminal(samples=1, reason="sample_budget_limit", normal=False)]
        unsupported = [{"event_seq": 1, "monotonic_ms": TICK, "kind": "terminal", "reason": "unsupported_configuration",
                        "normal_loop_exit": False, "input_tokens": None, "sampled_tokens_including_eog": 0}]
        for frames, limits in ((input_refusal, LIMITS), (sample_refusal, {"input_tokens": 3, "output_tokens": 1, "total_tokens": 4}),
                               (unsupported, LIMITS)):
            with self.subTest(reason=frames[-1]["reason"]):
                answer = self.parse(raw(frames), limits)
                self.assertTrue(answer["parsed"])
                self.assertFalse(answer["complete"])
                self.assertIsNone(answer["usage"])
                self.assertIn("NON_NORMAL_TERMINAL", answer["gaps"])
                self.assertTrue(answer["diagnostic"]["terminal_frame_present"])
        self.assertEqual(self.parse(raw(input_refusal))["diagnostic"]["input_tokens"], 4)
        self.assertIsNone(self.parse(raw(unsupported))["diagnostic"]["input_tokens"])

    def test_verifier_unavailable_raises_or_returns_non_none_keeps_raw(self):
        value = raw(eog_frames())
        self.invalid(value, "CALLER_VERIFIER_REQUIRED", verifier=None)
        for answer in (False, True, 0, 1, {}):
            with self.subTest(answer=answer):
                self.invalid(value, "CALLER_VERIFIER_RESULT", verifier=lambda *args, result=answer: result)
        def unavailable(*args):
            raise RuntimeError("external caller currentness unavailable")
        answer = self.invalid(value, "CALLER_VERIFIER_EXCEPTION", verifier=unavailable)
        self.assertFalse(answer["binding_callback_completed"])
        self.assertEqual(answer["frames"], [])
        def private_exception(*args):
            raise MODULE.ObservationError("private callback detail must not appear")
        answer = self.invalid(value, "CALLER_VERIFIER_EXCEPTION", verifier=private_exception)
        self.assertNotIn("private callback detail", str(answer["errors"]))

    def test_verifier_snapshots_reject_type_mutation_and_leave_originals_frozen(self):
        limits, binding = copy.deepcopy(LIMITS), copy.deepcopy(BINDING)
        def mutate_binding(value, limits_view, binding_view):
            binding_view["caller_currentness_claim"] = 1  # True == 1 is insufficient.
        answer = parse(raw(eog_frames()), expected_limits=limits, binding=binding, verify_binding=mutate_binding)
        self.assertEqual(answer["errors"], ["CALLER_VERIFIER_MUTATION"])
        self.assertIsNone(answer["usage"])
        self.assertEqual(limits, LIMITS)
        self.assertIs(binding["caller_currentness_claim"], True)
        def mutate_limits(value, limits_view, binding_view):
            limits_view["output_tokens"] = True
        self.invalid(raw(eog_frames()), "LIMIT_VALUE", verifier=mutate_limits)
        self.invalid(raw(eog_frames()), binding={"source": "\ud800"})
        self.invalid(raw(eog_frames()), binding={})

    def test_utf8_json_lf_duplicate_unknown_keys_and_nonfinite_are_rejected(self):
        value = raw(eog_frames())
        bad = [b"\xff\n", value.replace(b"\n", b"\r\n"), value.replace(b'"kind":"input"', b'"kind":"input","kind":"input"', 1),
               value.replace(b'"input_tokens":2', b'"input_tokens":NaN', 1),
               value.replace(b'"kind":"input"', b'"kind":"input","extra":0', 1),
               value.replace(b'"reason":"eog"', b'"reason":"\\ud800"', 1), b"\n" + value,
               b'[]\n', value.replace(b'"input_tokens":2', b'"input_tokens":Infinity', 1)]
        for index, candidate in enumerate(bad):
            with self.subTest(index=index):
                self.invalid(candidate)

    def test_event_sequence_monotonic_and_integer_types_are_strict(self):
        for frame_index, key, replacement in ((0, "event_seq", True), (1, "event_seq", 9),
                                               (1, "monotonic_ms", TICK - 1), (0, "monotonic_ms", False),
                                               (0, "monotonic_ms", -1), (0, "monotonic_ms", 1 << 64),
                                               (0, "input_tokens", True), (0, "input_limit", 3.0)):
            frames = eog_frames()
            frames[frame_index][key] = replacement
            with self.subTest(key=key, replacement=replacement):
                self.invalid(raw(frames))

    def test_sample_ordinal_id_eog_and_stage_order_are_strict(self):
        for key, replacement in (("sampled_ordinal", True), ("sampled_ordinal", 2), ("token_id", True),
                                 ("token_id", 1.0), ("token_id", 1 << 31), ("eog", 1)):
            frames = eog_frames()
            frames[1][key] = replacement
            with self.subTest(key=key, replacement=replacement):
                self.invalid(raw(frames))
        frames = eog_frames()
        frames[1]["eog"] = True
        self.invalid(raw(frames), "SAMPLE_AFTER_EOG")
        self.invalid(raw([dict(sample(), event_seq=1)]), "SAMPLE_BEFORE_INPUT")
        frames = eog_frames()
        frames[0]["input_tokens"] = 4
        self.invalid(raw(frames), "SAMPLE_AFTER_INPUT_REFUSAL")
        duplicate_input = [input_frame(), dict(input_frame(), event_seq=2)]
        self.invalid(raw(duplicate_input), "INPUT_ORDER_OR_DUPLICATE")

    def test_terminal_counts_reason_flags_and_finality_are_consistent(self):
        for key, replacement in (("input_tokens", 3), ("input_tokens", True), ("sampled_tokens_including_eog", 1),
                                 ("sampled_tokens_including_eog", False), ("normal_loop_exit", 1),
                                 ("normal_loop_exit", False), ("reason", "perf"), ("reason", "predict")):
            frames = eog_frames()
            frames[-1][key] = replacement
            with self.subTest(key=key, replacement=replacement):
                self.invalid(raw(frames))
        frames = [input_frame(), sample(), terminal(samples=1, reason="predict")]
        self.invalid(raw(frames), "PREDICT_COUNT")
        frames = eog_frames()
        frames[-2]["eog"] = False
        self.invalid(raw(frames), "TERMINAL_EOG_REASON")
        frames = eog_frames() + [dict(input_frame(), event_seq=5)]
        self.invalid(raw(frames), "FRAME_AFTER_TERMINAL")
        self.invalid(raw([dict(terminal(count=None, samples=0), event_seq=1)]), "TERMINAL_WITHOUT_INPUT")

    def test_byte_sample_and_frame_bounds_and_expected_plan_limits(self):
        self.invalid(b"x" * (131072 + 1), "RAW_BYTE_LIMIT")
        frames = [input_frame(predict=512, total=4608)] + [sample(i, 1, False) for i in range(1, 514)]
        limits = {"input_tokens": 3, "output_tokens": 512, "total_tokens": 4608}
        self.invalid(raw(frames), "SAMPLE_ORDINAL_TYPE", limits=limits)
        self.invalid(raw(frames + [terminal(samples=513, reason="predict")]), "FRAME_LIMIT", limits=limits)
        self.invalid(raw(eog_frames()), "PLAN_LIMIT_MISMATCH", limits={"input_tokens": 4, "output_tokens": 2, "total_tokens": 5})
        for key, value in (("input_tokens", 4097), ("output_tokens", 513), ("total_tokens", 4609), ("input_tokens", True)):
            limits = dict(LIMITS, **{key: value})
            with self.subTest(key=key, value=value):
                self.invalid(raw(eog_frames()), "LIMIT_VALUE", limits=limits)
        self.invalid(raw(eog_frames()), "LIMIT_FIELDS", limits=dict(LIMITS, cost=0))


if __name__ == "__main__":
    unittest.main()
