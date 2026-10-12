"""Saved projection Source tests; old public examples, hypothetical v2 metadata only.

No new Dataset/Gold, measured usage, invocation, model or runtime acceptance.
Embedded compressed schemas are exact f14d82b7 Git object bytes, not a new schema.
"""
import base64
import builtins
import copy
import hashlib
import json
from pathlib import Path
import types
import unittest
from unittest import mock
import zlib

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts/model-program"
FIXTURE = ROOT / "tests/fixtures/model-stage-admission/core-adapter-e76"
MODULES = {}


def private_source(name):
    if name in MODULES:
        return MODULES[name]
    path = SCRIPTS / (name + ".py")
    module = types.ModuleType("private_saved_projection." + name)
    module.__file__, module.__package__ = str(path), ""
    namespace = dict(vars(builtins))
    def resolve(import_name, globals=None, locals=None, fromlist=(), level=0):
        if level == 0 and (SCRIPTS / (import_name + ".py")).is_file():
            return private_source(import_name)
        return builtins.__import__(import_name, globals, locals, fromlist, level)
    namespace["__import__"] = resolve
    module.__dict__["__builtins__"] = namespace
    exec(compile(path.read_bytes(), str(path), "exec"), module.__dict__)
    MODULES[name] = module
    return module


S = private_source("invocation_saved_projection")
COMPRESSED_SCHEMAS = {"request":"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","result":"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","attempt":"eNrNWFtz4jYUfu+v8Hj2EYNtAgnuU5plW2Y2IZNkO20zVCOsY6JdW3YlmYYy/Pce2QbMNZfSaXmxLZ1zdG7fd2zm9gfO7MDOpQjCOAcWqPAJEhokKYPY4WKahlTzVDhUa0gyHUx9u2F/KKVQ8UnrTAWt1leFMuVqM5WTFpM00i3f9V3H81uVeMOmjHFjjsa3Ms1Aag7KDiIaK8DNOB5GdvA4tzle5nZWE5nblQMklYyjvlkKU6G0HXiLRcOW8EfOJWAwjzuiI9zXTyB2jY5p+C2NIpKomj0Xxb9ytCF31zM8AkJQKpVkeYzJ4NzWswwwISKPY7vwR8sZEakmY4hSCQdFtOSTCcjaOTYXmCT0e4G/xquzkaBakid24L8/H4fDy8yjRBX798dL5zfq/OU6vdH6tkkCZzR3G36ns/iAla5iVRiemBxKCF4TaiJmVIOjeQKHNWt5AmHCfLS1pEJlqdQEpEwl6kq0Q2KecE3O/J5ZgAlX6DgwUkhzEJp0np/t0c5Bh5MdG6sSVB7rWpm0zGE703XJw1kOqWDchExoGEKmqQiBQMwnfBxD7YQCF2ilZpXAlDMw8hIKTxP6/BnERD/ZQcfzG6YLls/eG0IMjQ8xMbEA5osRqmsdu9LfjHaf0qmixt+osd30jGYGlVOQCknkJG154i4/hst1PbjQYHoZFTYZaCXr7pXN2QS06QSQ04KW39UFjUPVPgLHx6V2o6SvUWnleEGrc8dpGgMV5mDs3SRLNTbwjHyD2VbK1RP1O93gERNNnWg0757tT/J6LJ2qbBt0f7wIW2SwG+M/Reu+VKNtBeSJSkaUTrPXc2cxx0+VpdKYxKBOBr90/BVCTcr19QS8NicNVmW+LFFVKOQ6yzVJQE6AZGnMw1ld8dPw7ofBR3J1N7y/J5cPD/3r2wdy3b/7sW8fnd7vC2RfqZCyTNElYUBZzMUbBt1K9WQjt8A3YXwCSr8TbFUnS8wbn76XKt44/A+b2H0LMAKN1StT4zQvBfscKF9i68Nn2XR+0zWZUprKV5FpLbvoRrZqxfeReWHirc22/Ya4NVk35uLuVNsYWwfn0v4589Lc2B0S24Rfp+tNPj5CvrscWiPHHWrbJKb9rHOQTvZxwCa4d6C5F2Z7YLMNg52u3OjCPe213S6m47k24/oQ565ap8wIPj87xaeiE6YJ8gkf85jrmRHIyk87ZxmqY2C4oYBu0gk437gwX533Vz/1ry/J/Zfb2+HdAxnefP6V3AwfSP+X/tWXh8HwhvR/Hnzs31z1a0YYRAXY8XtzBUWDwKbrxOh67MjQmXodp6johp40iXX+xJ5HTwQiPzQgqeK0Ig4xU9YYZqlg1rTdbFvwnGGlubbG6C/CRllUgjX1LZ5kMSTIGkWm1ts6tRTmyKx5rnWXi9Y9ZrtVHfG9hS/Gs8IGltQKY4rQZBZVFgYyRlNJeWzhiSVoAqpZC6BYdlKsPC/YpwqIVKcfh/F/hdz/O1L/TRy+DL1lg5Fpm7TrX+qFb9us9zKr1LBvJtaycyYgwAxB7CGZJmYKlLM/6nXPIxa1odt2/Qvm94B5Pc/rut3exbnfHXfYuXtOKcX9Met1vKg7pj5cdC7Oeu1uBGGtOdcj1dGYyBXUTaNWqVF5VvCBGZzcBHs1cHpnaMNcO9W1V6SFU7PfH1w6Zx5uFDed5c1FOY3RpNA8JDIXZsSR9Tir7K8MjRaLw47CM4S5LlnEcM/dlxvysf9pcDMoCMhwUi1MleYyBKcCuTJeei7uty+aq6tXXrsmkpVejp+xCntQve3PNs9efPc37xbU5Q=="}
SCHEMAS = {key: zlib.decompress(base64.b64decode(value))
           for key, value in COMPRESSED_SCHEMAS.items()}
OLD_INPUTS = json.loads((FIXTURE / "tests/fixtures/model-program-m2/core-development-candidate.json").read_bytes())
OLD_OUTPUTS = json.loads((FIXTURE / "tests/fixtures/model-program-m2/core-saved-synthetic-outputs.json").read_bytes())


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(value):
    raw = value.encode("utf-8") if type(value) is str else encoded(value)
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def select(result, attempt):
    if result["outcome"] == "succeeded":
        return "succeeded"
    return result["error"]["code"] if result["error"] is not None else "unknown"


POLICY = {"succeeded": "SUCCEEDED", "MODEL_TIMEOUT": "TIMEOUT",
          "MODEL_PROVIDER_UNAVAILABLE": "UNAVAILABLE", "MODEL_OUTPUT_INVALID": "SCHEMA_INVALID",
          "unknown": "RUNTIME_ERROR"}
REF = "sha256:" + "a" * 64
OTHER = "sha256:" + "b" * 64
START, END = "2031-04-06T09:00:00Z", "2031-04-06T09:00:01Z"
DEADLINE, HARDSTOP = "2031-04-06T09:00:30Z", "2031-04-06T09:01:00Z"


def example(number=0):
    old = OLD_OUTPUTS["outputs"][number]
    sample = next(row for row in OLD_INPUTS["samples"] if row["sample_id"] == old["sample_id"])
    input_raw, payload = encoded(sample["input"]), old["output_text"].encode("utf-8")
    budgets = {"currency": "TST", "currency_exponent": 2, "currency_profile_digest": REF,
        "max_attempts": 1, "max_concurrent_requests": 1, "max_cost_minor_units": 0,
        "max_elapsed_ms": 30000, "max_input_bytes": 65536, "max_input_tokens": 512,
        "max_output_tokens": 256, "max_request_count": 1, "max_response_bytes": 65536,
        "parse_budget_ms": 1000, "persistence_budget_ms": 1000,
        "scrub_wall_clock_budget_ms": 1000, "validation_budget_ms": 1000}
    req = {"object_type": "ModelInvocationRequest", "schema_version": "2.0",
        "adapter_version": "spec-adapter-v1", "attempt_id": "spec-attempt-" + str(number),
        "binding_ref": REF, "budgets": budgets, "capability": "structured_generate",
        "context_slice_ref": "spec:public-example", "correlation_id": "spec-correlation-" + str(number),
        "data_classification": "internal", "deadline": DEADLINE, "eval_set_digest": REF,
        "idempotency_key": REF, "input_digest": "sha256:" + hashlib.sha256(input_raw).hexdigest(),
        "invocation_id": "spec-invocation-" + str(number), "lease_hard_stop": HARDSTOP,
        "model_revision": "spec-model-v1", "output_schema_digest": REF, "policy_snapshot_digest": REF,
        "project_ref": REF, "provider_id": "spec-provider", "provider_qualification_ref": REF,
        "provider_type": "Test", "purpose": "development", "region": "spec-local",
        "retention_mode": "spec-local-only", "scope_digest": REF, "security_profile_id": "spec-profile",
        "step_deadline": DEADLINE, "subject_ref": REF, "template_hash": REF,
        "training_mode": "none", "training_opt_in_receipt_ref": None}
    result = {key: copy.deepcopy(req[key]) for key in ("adapter_version", "attempt_id",
        "capability", "correlation_id", "data_classification", "input_digest", "invocation_id",
        "model_revision", "output_schema_digest", "policy_snapshot_digest", "provider_id",
        "provider_type", "purpose", "region", "retention_mode", "scope_digest",
        "template_hash", "training_mode")}
    result.update(object_type="ModelInvocationResult", schema_version="2.0",
        adapter_artifact_digest=REF, binding_projection=REF, budget_reservation_ref="spec:reservation",
        business_receipt_boundary="SEPARATE_ID_SCHEMA_OUTCOME_AND_STORAGE", completed_at=END,
        error=None, invocation_result_authority="PROVIDER_CALL_OUTCOME_ONLY", model_id="spec-model",
        outcome="succeeded", output_digest=digest(json.loads(payload)), payload_ref="spec:old-saved-bytes",
        pre_output_schema_validation_status="specification-only", project_projection=REF,
        provider_response_id=None, request_budget_snapshot=copy.deepcopy(budgets),
        request_digest=digest(req), response_summary=None, result_id="spec-result-" + str(number),
        retention_policy="spec-local-only", routing_reason="hypothetical schema fixture",
        settlement_ref=None, started_at=START, stop_reason=None, subject_projection=REF,
        usage={"cost_minor_units": 0, "currency": "TST", "currency_exponent": 2,
               "currency_profile_digest": REF, "input_bytes": len(input_raw), "input_tokens": 7,
               "output_bytes": len(payload), "output_tokens": 11})
    attempt = {"object_type": "ModelInvocationAttempt", "schema_version": "2.0",
        "adapter_version": req["adapter_version"], "attempt_id": req["attempt_id"],
        "attempt_ordinal": 1, "backoff_ms": 0, "budget_reservation_ref": "spec:reservation",
        "cancel_requested_at": None, "candidate_acceptance_eligible": True,
        "idempotency_key": REF, "invocation_id": req["invocation_id"], "jitter_ms": 0,
        "late_result": False, "late_result_evidence_ref": None, "lease_hard_stop": HARDSTOP,
        "model_id": "spec-model", "model_revision": req["model_revision"],
        "output_merge_policy": "FORBID_CROSS_ATTEMPT_MERGE", "predecessor_attempt_id": None,
        "provider_deadline": DEADLINE, "provider_id": req["provider_id"],
        "request_digest": digest(req), "result_received_at": "2031-04-06T09:00:02Z",
        "retry_not_before": None, "retry_trigger": "initial", "started_at": START,
        "step_attempt_ref": "spec:step-attempt", "step_deadline": DEADLINE}
    index = {"id": sample["sample_id"], "input_sha256": hashlib.sha256(input_raw).hexdigest(),
        "split_id": "spec:old-development", "request": req, "request_digest": digest(req),
        "model_id": "spec-model", "adapter_artifact_digest": REF, "binding_projection": REF,
        "project_projection": REF, "subject_projection": REF, "attempt_ordinal": 1}
    return index, result, attempt, payload


def record(index, result, attempt, payload):
    return {"id": index["id"], "result_raw": encoded(result) if result is not None else None,
            "attempt_raw": encoded(attempt) if attempt is not None else None, "payload_raw": payload}


def split(indexes):
    return {"split_id": "spec:old-development", "purpose_id": "development",
            "experiment_scope": "specification-example-only", "allowed_consumers": ["spec:reader"],
            "exposure_records": [], "final_holdout": False, "sample_ids": [i["id"] for i in indexes]}


def project(indexes, records, **overrides):
    args = dict(schema_bundle=SCHEMAS, status_selector=select, status_policy=POLICY, port_digest=digest)
    args.update(overrides)
    return S.project_saved_snapshot(indexes, records, split(indexes), **args)


def timeout(result, attempt):
    result.update(outcome="provider_terminal_timeout", output_digest=None, payload_ref=None,
        error={"code": "MODEL_TIMEOUT", "details_digest": None, "provider_status": None,
               "retryable": False, "sanitized_message": "Hypothetical specification timeout."})
    attempt["candidate_acceptance_eligible"] = False


class SavedProjectionSemantics(unittest.TestCase):
    def test_original_bytes_complete_snapshot_and_independent_seal(self):
        i, r, a, p = example()
        got = project([i], [record(i, r, a, p)])
        self.assertEqual(got["slots"][0]["gaps"], [])
        row = got["snapshot"][0]
        self.assertEqual(set(row), {"id", "input_sha256", "raw_output", "terminal_status", "usage", "split_id"})
        self.assertEqual(row["raw_output"], p)
        self.assertEqual(row["usage"], r["usage"])
        metadata = [{k: copy.deepcopy(v) for k, v in row.items() if k != "raw_output"}]
        metadata[0]["raw_output_sha256"] = hashlib.sha256(p).hexdigest()
        expected = hashlib.sha256(encoded(metadata)).hexdigest()
        self.assertEqual(got["snapshot_sha256"], expected)
        self.assertEqual(got["authority_effect"], "NONE")
        self.assertEqual(got["qualification"], "NOT_ISSUED")
        self.assertNotIn("latency_ms", row["usage"])
        self.assertFalse({"correct", "true_label", "probabilities"} & set(row))

    def test_whitespace_changes_raw_seal_not_port_canonical_digest(self):
        i, r, a, p = example()
        first = project([i], [record(i, r, a, p)])
        pretty = b" \n" + json.dumps(json.loads(p), indent=2).encode() + b"\n"
        r["usage"]["output_bytes"] = len(pretty)
        second = project([i], [record(i, r, a, pretty)])
        self.assertEqual(second["snapshot"][0]["raw_output"], pretty)
        self.assertEqual(r["output_digest"], digest(json.loads(pretty)))
        self.assertNotEqual(first["snapshot_sha256"], second["snapshot_sha256"])

    def test_valid_failure_without_payload_is_retained_in_complete_all_requests(self):
        i, r, a, p = example()
        j, s, b, q = example(1)
        timeout(s, b)
        got = project([i, j], [record(i, r, a, p), record(j, s, b, None)])
        self.assertEqual(len(got["snapshot"]), 2)
        self.assertIsNone(got["snapshot"][1]["raw_output"])
        self.assertEqual(got["snapshot"][1]["terminal_status"], "MODEL_TIMEOUT")
        self.assertEqual(got["slots"][1]["result"]["outcome"], "provider_terminal_timeout")

    def test_omitted_or_absent_record_preserves_registered_slots(self):
        i, r, a, p = example()
        j, s, b, q = example(1)
        got = project([i, j], [record(i, r, a, p)])
        self.assertIsNone(got["snapshot"])
        self.assertEqual([slot["id"] for slot in got["slots"]], [i["id"], j["id"]])
        self.assertEqual(got["slots"][1]["gaps"], ["MISSING_RESULT", "MISSING_ATTEMPT"])
        got = project([i], [record(i, None, a, None)])
        self.assertEqual(got["slots"][0]["original_bytes"]["attempt_raw"], encoded(a))

    def test_usage_none_partial_and_bool_are_not_filled(self):
        for value in (None, {"cost_minor_units": 0}, {**example()[1]["usage"], "input_tokens": True}):
            with self.subTest(usage=value):
                i, r, a, p = example()
                r["usage"] = value
                raw = encoded(r)
                got = project([i], [record(i, r, a, p)])
                self.assertIsNone(got["snapshot"])
                self.assertIsNone(got["slots"][0]["usage"])
                self.assertEqual(got["slots"][0]["original_bytes"]["result_raw"], raw)
                self.assertEqual(got["slots"][0]["raw_sha256"]["result_raw"], hashlib.sha256(raw).hexdigest())

    def test_unknown_outcome_without_error_is_not_success(self):
        i, r, a, p = example()
        r["outcome"] = "new_undefined_state"
        got = project([i], [record(i, r, a, p)])
        self.assertIsNone(got["snapshot"])
        self.assertIn("UNKNOWN_OUTCOME_WITHOUT_ERROR", got["slots"][0]["gaps"])
        self.assertEqual(got["slots"][0]["result"]["outcome"], "new_undefined_state")

    def test_selector_cannot_override_failure_as_success_or_unknown_mapping(self):
        i, r, a, p = example()
        timeout(r, a)
        got = project([i], [record(i, r, a, None)], status_selector=lambda *_: "succeeded")
        self.assertIsNone(got["snapshot"])
        i, r, a, p = example()
        got = project([i], [record(i, r, a, p)], status_selector=lambda *_: "not_registered")
        self.assertIsNone(got["snapshot"])

    def test_missing_success_payload_and_noneligible_success_hold(self):
        for missing, eligible in ((True, True), (False, False)):
            with self.subTest(missing=missing, eligible=eligible):
                i, r, a, p = example()
                a["candidate_acceptance_eligible"] = eligible
                got = project([i], [record(i, r, a, None if missing else p)])
                self.assertIsNone(got["snapshot"])
                self.assertEqual(got["slots"][0]["result"]["outcome"], "succeeded")
                self.assertIsNone(got["slots"][0]["terminal_status"])

    def test_late_and_cancelled_succeeded_cannot_be_accepted(self):
        for change in ({"late_result": True, "late_result_evidence_ref": "spec:late"},
                       {"cancel_requested_at": START}):
            with self.subTest(change=change):
                i, r, a, p = example()
                a.update(change)
                a["candidate_acceptance_eligible"] = False
                selector = mock.Mock(return_value="succeeded")
                got = project([i], [record(i, r, a, p)], status_selector=selector)
                self.assertIsNone(got["snapshot"])
                self.assertIn("SUCCESS_NOT_ACCEPTANCE_ELIGIBLE", got["slots"][0]["gaps"])
                self.assertEqual(got["slots"][0]["attempt"], a)
                self.assertIsNone(got["slots"][0]["terminal_status"])
                selector.assert_not_called()

    def test_direct_identity_and_configuration_drift_hold(self):
        changes = {"provider_id": "other-provider", "model_revision": "spec-model-v2",
            "adapter_version": "adapter-v2", "adapter_artifact_digest": OTHER,
            "policy_snapshot_digest": OTHER, "output_schema_digest": OTHER,
            "scope_digest": OTHER, "data_classification": "public", "subject_projection": OTHER}
        for field, value in changes.items():
            with self.subTest(field=field):
                i, r, a, p = example()
                r[field] = value
                got = project([i], [record(i, r, a, p)])
                self.assertIsNone(got["snapshot"])
                self.assertTrue(got["slots"][0]["gaps"])

    def test_deadline_lease_reservation_idempotency_and_attempt_drift_hold(self):
        changes = {"provider_deadline": HARDSTOP, "lease_hard_stop": DEADLINE,
            "step_deadline": HARDSTOP, "budget_reservation_ref": "spec:other",
            "idempotency_key": OTHER, "attempt_id": "other-attempt"}
        for field, value in changes.items():
            with self.subTest(field=field):
                i, r, a, p = example()
                a[field] = value
                self.assertIsNone(project([i], [record(i, r, a, p)])["snapshot"])
        i, r, a, p = example()
        a.update(attempt_ordinal=2, predecessor_attempt_id="old-attempt", retry_trigger="transport_error",
                 retry_not_before=START)
        self.assertIsNone(project([i], [record(i, r, a, p)])["snapshot"])

    def test_currency_profile_or_exponent_difference_not_combined(self):
        for field, value in (("currency_exponent", 3), ("currency_profile_digest", OTHER)):
            with self.subTest(field=field):
                i, r, a, p = example()
                j, s, b, q = example(1)
                j["request"]["budgets"][field] = value
                j["request_digest"] = digest(j["request"])
                s["request_budget_snapshot"] = copy.deepcopy(j["request"]["budgets"])
                s["request_digest"] = b["request_digest"] = j["request_digest"]
                s["usage"][field] = value
                got = project([i, j], [record(i, r, a, p), record(j, s, b, q)])
                self.assertIsNone(got["snapshot"])
                self.assertIn("CURRENCY_UNIT_DRIFT", got["slots"][0]["gaps"])

    def test_malformed_bytes_duplicate_keys_overflow_and_bad_calendar_preserved(self):
        for bad in (b"\xff", b'{"object_type":1,"object_type":2}', b'{"usage":1e999}'):
            with self.subTest(bad=bad):
                i, r, a, p = example()
                rec = record(i, r, a, p)
                rec["result_raw"] = bad
                got = project([i], [rec])
                self.assertIsNone(got["snapshot"])
                self.assertEqual(got["slots"][0]["original_bytes"]["result_raw"], bad)
        i, r, a, p = example()
        r["completed_at"] = "2031-02-30T09:00:01Z"
        self.assertIsNone(project([i], [record(i, r, a, p)])["snapshot"])

    def test_payload_digest_drift_bounds_and_malformed_payload_hold(self):
        for payload in (b'{"different":true}', b"\xff", b"{}" * 40000):
            with self.subTest(size=len(payload)):
                i, r, a, p = example()
                got = project([i], [record(i, r, a, payload)])
                self.assertIsNone(got["snapshot"])
                self.assertEqual(got["slots"][0]["original_bytes"]["payload_raw"], payload)

    def test_wrong_schema_pin_duplicate_extra_and_cross_split_reject(self):
        i, r, a, p = example()
        bad = dict(SCHEMAS)
        bad["result"] += b" "
        with self.assertRaises(ValueError):
            project([i], [record(i, r, a, p)], schema_bundle=bad)
        for indexes, recs in (([i, i], []), ([i], [record(i, r, a, p)] * 2),
                              ([i], [{**record(i, r, a, p), "id": "not-indexed"}])):
            with self.subTest(indexes=len(indexes), records=len(recs)), self.assertRaises(ValueError):
                project(indexes, recs)
        i["split_id"] = "spec:other-split"
        with self.assertRaises(ValueError):
            project([i], [record(i, r, a, p)])

    def test_callback_mutation_is_detected_caller_inputs_and_usage_unchanged(self):
        i, r, a, p = example()
        indexes, recs = [i], [record(i, r, a, p)]
        before = copy.deepcopy((indexes, recs))
        def mutate_status(result, attempt):
            result["usage"]["input_tokens"] = 0
            return "succeeded"
        self.assertIsNone(project(indexes, recs, status_selector=mutate_status)["snapshot"])
        self.assertEqual((indexes, recs), before)
        def mutate_digest(value):
            if type(value) is dict:
                value["invented"] = True
            return digest(value)
        self.assertIsNone(project(indexes, recs, port_digest=mutate_digest)["snapshot"])
        self.assertEqual((indexes, recs), before)

    def test_no_io_in_projection_and_no_timestamp_latency_derivation(self):
        i, r, a, p = example()
        with mock.patch("builtins.open", side_effect=AssertionError("file access")), \
             mock.patch("socket.create_connection", side_effect=AssertionError("network")), \
             mock.patch("subprocess.run", side_effect=AssertionError("process")):
            got = project([i], [record(i, r, a, p)])
        self.assertIsNotNone(got["snapshot"])
        self.assertNotIn("latency_ms", got["snapshot"][0]["usage"])
        self.assertNotIn("duration_ms", got["snapshot"][0]["usage"])

    def test_empty_registered_scope_has_empty_snapshot_no_qualification(self):
        got = project([], [])
        self.assertEqual(got["snapshot"], [])
        self.assertEqual(got["slots"], [])
        self.assertEqual(got["qualification"], "NOT_ISSUED")

