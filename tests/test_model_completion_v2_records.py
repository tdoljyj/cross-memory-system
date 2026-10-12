"""Pure completion record regressions; old public fixture, hypothetical observations.
No model, tokenizer, new corpus, Gold, live qualification or actual usage claim.
"""
import builtins
import copy
import hashlib
import json
from pathlib import Path
import types
import unittest

ROOT = Path(__file__).resolve().parents[1]
OLD_PATH = ROOT / "tests/test_model_program_invocation_saved_projection.py"
OLD = types.ModuleType("private_completion_records_old_fixture")
OLD.__file__, OLD.__package__ = str(OLD_PATH), ""
exec(compile(OLD_PATH.read_bytes(), str(OLD_PATH), "exec"), OLD.__dict__)
B = OLD.private_source("completion_v2_records")
R = OLD.private_source("completion_saved_response")


def lifecycle(context):
    # Hypothetical Source test predicate, never a real lifecycle authority.
    return {"verified_context": copy.deepcopy(context), "outcome_consistent": True}


def machine(raw, binding):
    # Source fixture only; actual caller must supply its independently verified validator.
    return json.loads(raw)


def fixture():
    index, result, attempt, payload = OLD.example()
    attempt["result_received_at"] = result["completed_at"]
    fields = {"result_fields": {k: copy.deepcopy(result[k]) for k in B.RESULT_FIELDS},
              "attempt_fields": {k: copy.deepcopy(attempt[k]) for k in B.ATTEMPT_FIELDS},
              "capture": {"stdout_sha256": hashlib.sha256(payload).hexdigest(),
                  "stderr_sha256": hashlib.sha256(b"").hexdigest(),
                  "stdout_retained_bytes": len(payload), "stderr_retained_bytes": 0,
                  "stdout_complete": True, "stderr_complete": True,
                  "stdout_truncated": False, "stderr_truncated": False,
                  "stdout_read_error": False, "stderr_read_error": False,
                  "owned_cleanup_verified": True, "admission_current": True,
                  "after_hard_stop": False, "timing_tolerance_ms": 0}}
    binding = {**dict(R.RUNTIME_SOURCE_PINS), **dict(R.FORMAT_ASSUMPTIONS),
               "framing": "strict_json", "newline": "LF"}
    observed = {"observation_ref": "spec:observation", "stdout_sha256": hashlib.sha256(payload).hexdigest(),
        "stderr_sha256": hashlib.sha256(b"").hexdigest(), "exit_code": 0, "timed_out": False,
        "cancelled": False, "usage": {**result["usage"], "elapsed_ms": 1000},
        **{k: binding[k] for k in ("archive_sha256", "executable_sha256", "implementation_sha256")}}
    return index, fields, binding, observed, payload


def build(index, fields, binding, observed, stdout, **kwargs):
    args = {"schema_bundle": OLD.SCHEMAS, "port_digest": OLD.digest,
            "observation_raw": OLD.encoded(observed) if observed is not None else None,
            "observation_validator": machine, "lifecycle_validator": lifecycle,
            "output_validator": lambda *_: fields["result_fields"]["pre_output_schema_validation_status"]}
    args.update(kwargs)
    return B.build_completion_records(stdout, b"", binding, index, fields, **args)


def failed(fields, observed, code="MODEL_TIMEOUT"):
    fields["result_fields"].update(outcome="explicit_provider_failure", payload_ref=None,
        error={"code": code, "details_digest": None, "provider_status": None,
               "retryable": False, "sanitized_message": "Hypothetical specification failure."})
    fields["attempt_fields"]["candidate_acceptance_eligible"] = False
    observed["exit_code"] = 124
    observed["timed_out"] = code == "MODEL_TIMEOUT"


class CompletionV2RecordSemantics(unittest.TestCase):
    def test_verified_complete_success_connects_to_real_saved_projector(self):
        i, f, b, o, p = fixture()
        got = build(i, f, b, o, p)
        self.assertEqual(got["gaps"], [])
        result = json.loads(got["result_raw"])
        self.assertEqual(result["usage"], {k: o["usage"][k] for k in B.USAGE_FIELDS})
        self.assertEqual(result["output_digest"], OLD.digest(json.loads(p)))
        self.assertEqual(got["stdout_raw"], p)
        projected = OLD.project([i], [got["record"]])
        self.assertEqual(projected["snapshot"][0]["raw_output"], p)
        self.assertEqual(got["authority_effect"], "NONE")
        self.assertEqual(got["qualification"], "NOT_ISSUED")

    def test_missing_observation_and_each_usage_field_never_fill_zero(self):
        i, f, b, o, p = fixture()
        for key in (None, *B.USAGE_FIELDS):
            with self.subTest(key=key):
                observation = copy.deepcopy(o) if key is not None else None
                if key is not None:
                    del observation["usage"][key]
                got = build(i, f, b, observation, p)
                self.assertIsNone(got["result_raw"])
                self.assertEqual(got["stdout_raw"], p)
                self.assertEqual(got["stdout_sha256"], hashlib.sha256(p).hexdigest())

    def test_exit_zero_is_not_an_outcome_or_lifecycle_verification(self):
        i, f, b, o, p = fixture()
        f["result_fields"]["outcome"] = None
        self.assertIsNone(build(i, f, b, o, p)["result_raw"])
        i, f, b, o, p = fixture()
        self.assertIsNone(build(i, f, b, o, p, lifecycle_validator=None)["result_raw"])
        self.assertIsNone(build(i, f, b, o, p,
            lifecycle_validator=lambda ctx: {"verified_context": ctx, "outcome_consistent": False})["result_raw"])

    def test_timeout_records_retain_raw_evidence_without_payload(self):
        i, f, b, o, p = fixture()
        failed(f, o)
        got = build(i, f, b, o, p)
        self.assertIsNotNone(got["result_raw"])
        self.assertEqual(json.loads(got["result_raw"])["outcome"], "explicit_provider_failure")
        self.assertEqual(got["stdout_raw"], p)
        self.assertIsNone(got["record"]["payload_raw"])
        projected = OLD.project([i], [got["record"]])
        self.assertEqual(projected["snapshot"][0]["terminal_status"], "MODEL_TIMEOUT")

    def test_real_failure_overrun_is_preserved_while_success_overrun_rejects(self):
        i, f, b, o, p = fixture()
        o["usage"]["input_tokens"] = i["request"]["budgets"]["max_input_tokens"] + 1
        self.assertIsNone(build(i, f, b, o, p)["result_raw"])
        failed(f, o, "MODEL_BUDGET_EXCEEDED")
        got = build(i, f, b, o, p)
        self.assertIsNotNone(got["result_raw"])
        self.assertEqual(json.loads(got["result_raw"])["usage"]["input_tokens"], o["usage"]["input_tokens"])
        self.assertIn("input_tokens", got["budget_breaches"])

    def test_capture_interface_bool_errors_truncation_cleanup_and_missing_bytes(self):
        for key, value in (("stdout_read_error", True), ("stderr_read_error", True),
            ("stdout_truncated", True), ("owned_cleanup_verified", False),
            ("admission_current", False), ("after_hard_stop", True),
            ("stdout_complete", 1)):
            with self.subTest(key=key):
                i, f, b, o, p = fixture()
                f["capture"][key] = value
                self.assertIsNone(build(i, f, b, o, p)["result_raw"])
        i, f, b, o, p = fixture()
        failed(f, o)
        f["capture"].update(stdout_sha256=None, stdout_retained_bytes=None)
        o["stdout_sha256"] = None
        self.assertIsNone(build(i, f, b, o, None)["result_raw"])

    def test_lifecycle_context_binds_stream_observation_request_and_rejects_mutation(self):
        i, f, b, o, p = fixture()
        before = copy.deepcopy((i, f, b, o))
        def mutate(ctx):
            ctx["record_fields"]["attempt_fields"]["candidate_acceptance_eligible"] = 1
            return {"verified_context": ctx, "outcome_consistent": True}
        self.assertIsNone(build(i, f, b, o, p, lifecycle_validator=mutate)["result_raw"])
        def check(ctx):
            self.assertEqual(ctx["request_digest"], i["request_digest"])
            self.assertEqual(ctx["attempt_id"], i["request"]["attempt_id"])
            self.assertEqual(ctx["observation_sha256"], hashlib.sha256(OLD.encoded(o)).hexdigest())
            self.assertEqual(ctx["stdout_sha256"], hashlib.sha256(p).hexdigest())
            return lifecycle(ctx)
        self.assertIsNotNone(build(i, f, b, o, p, lifecycle_validator=check)["result_raw"])
        self.assertEqual((i, f, b, o), before)

    def test_parser_and_business_schema_validation_are_separate(self):
        i, f, b, o, p = fixture()
        got = build(i, f, b, o, p, output_validator=lambda *_: False)
        self.assertTrue(got["adapted"]["candidate_parsed"])
        self.assertIsNone(got["result_raw"])
        def mutate(candidate, request):
            candidate["injected"] = True
            return f["result_fields"]["pre_output_schema_validation_status"]
        self.assertIsNone(build(i, f, b, o, p, output_validator=mutate)["result_raw"])

    def test_ref_attempt_reservation_and_currency_binding_drift_reject(self):
        for field in ("subject_projection", "binding_projection", "project_projection"):
            with self.subTest(field=field):
                i, f, b, o, p = fixture()
                i[field] = OLD.OTHER
                self.assertIsNone(build(i, f, b, o, p)["result_raw"])
        for target, key, value in (("attempt_fields", "budget_reservation_ref", "other:reservation"),
            ("attempt_fields", "provider_deadline", OLD.HARDSTOP),
            ("attempt_fields", "attempt_ordinal", True)):
            with self.subTest(key=key):
                i, f, b, o, p = fixture()
                f[target][key] = value
                self.assertIsNone(build(i, f, b, o, p)["result_raw"])
        i, f, b, o, p = fixture()
        o["usage"]["currency_exponent"] = 3
        self.assertIsNone(build(i, f, b, o, p)["result_raw"])

    def test_times_are_bound_for_failure_and_success_monotonic_tolerance_explicit(self):
        for failure in (False, True):
            i, f, b, o, p = fixture()
            if failure:
                failed(f, o)
            f["attempt_fields"]["result_received_at"] = OLD.START
            self.assertIsNone(build(i, f, b, o, p)["result_raw"])
        i, f, b, o, p = fixture()
        o["usage"]["elapsed_ms"] = 10
        self.assertIsNone(build(i, f, b, o, p)["result_raw"])
        i, f, b, o, p = fixture()
        o["usage"]["elapsed_ms"] = 999
        f["capture"]["timing_tolerance_ms"] = 1
        self.assertIsNotNone(build(i, f, b, o, p)["result_raw"])

    def test_unknown_extra_nonfinite_boolean_and_schema_pin_inputs_preserve_raw(self):
        i, f, b, o, p = fixture()
        f["capture"]["invented_permission"] = True
        self.assertIsNone(build(i, f, b, o, p)["result_raw"])
        for value in (True, float("inf")):
            i, f, b, o, p = fixture()
            f["capture"]["timing_tolerance_ms"] = value
            self.assertIsNone(build(i, f, b, o, p)["result_raw"])
        i, f, b, o, p = fixture()
        bundle = dict(OLD.SCHEMAS)
        bundle["attempt"] += b" "
        got = build(i, f, b, o, p, schema_bundle=bundle)
        self.assertIsNone(got["result_raw"])
        self.assertEqual(got["stdout_raw"], p)

    def test_late_cancelled_ineligible_success_and_failure_error_none_reject(self):
        for key, value in (("late_result", True), ("cancel_requested_at", OLD.START),
                           ("candidate_acceptance_eligible", False)):
            i, f, b, o, p = fixture()
            f["attempt_fields"][key] = value
            self.assertIsNone(build(i, f, b, o, p)["result_raw"])
        i, f, b, o, p = fixture()
        failed(f, o)
        f["result_fields"]["error"] = None
        self.assertIsNone(build(i, f, b, o, p)["result_raw"])

