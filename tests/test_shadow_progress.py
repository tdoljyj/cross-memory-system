#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Gate 0-H Shadow status, persistence and no-content contract tests."""

import contextlib
import io
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from clued import cli  # noqa: E402
from clued.shadow import ShadowHarness, ShadowProgress, ShadowProgressError  # noqa: E402


def check(condition, message):
    if not condition:
        raise AssertionError(message)


class Result(object):
    def __init__(self, ids, status=None):
        self.objects = [{"id": value, "content": "PRIVATE_OBJECT_CONTENT"}
                        for value in ids]
        self.semantic_status = status


def expect_error(fn, contains):
    try:
        fn()
    except ShadowProgressError as exc:
        check(contains in str(exc), str(exc))
        return
    raise AssertionError("expected ShadowProgressError")


def test_missing_status_is_read_only_not_started():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "shadow", "progress.json")
        status = ShadowProgress(path).status()
        check(status["state"] == "NOT_STARTED", status)
        check(status["valid_requests"] == 0, status)
        check(not os.path.exists(path), "status must not create progress")


def test_cli_status_json_and_human_do_not_need_controller():
    with tempfile.TemporaryDirectory() as tmp:
        old = os.environ.get("CROSS_MEMORY_GATE0_WORKSPACE")
        os.environ["CROSS_MEMORY_GATE0_WORKSPACE"] = tmp
        try:
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = cli.run(["shadow", "status", "--json"],
                               controller_factory=lambda: 1 / 0)
            payload = json.loads(out.getvalue())
            check(code == 0 and payload["ok"], payload)
            check(payload["data"]["shadow"]["valid_requests"] == 0,
                  payload)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = cli.run(["shadow", "status"],
                               controller_factory=lambda: 1 / 0)
            check(code == 0 and "valid 0/100" in out.getvalue(),
                  out.getvalue())
        finally:
            if old is None:
                os.environ.pop("CROSS_MEMORY_GATE0_WORKSPACE", None)
            else:
                os.environ["CROSS_MEMORY_GATE0_WORKSPACE"] = old


def test_harness_persists_no_query_or_content_and_resumes():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "shadow", "progress.json")
        progress = ShadowProgress(path)
        progress.start()
        harness = ShadowHarness(
            progress,
            lambda query: Result(["mem_00000001"]),
            lambda query: Result(["mem_00000002"], "HYBRID_ACTIVE"))
        marker = "PRIVATE_QUERY_MARKER ghp_" + "A" * 30
        request_id, status = harness.run(marker)
        check(status["valid_requests"] == 1, status)
        check(status["hybrid_differences"] == 1, status)
        raw = open(path, "r", encoding="utf-8").read()
        check(marker not in raw and "PRIVATE_OBJECT_CONTENT" not in raw,
              "query/content leaked to progress")
        check("ghp_" not in raw, "secret leaked to progress")
        restarted = ShadowProgress(path)
        check(restarted.status()["valid_requests"] == 1,
              "restart lost progress")
        _, replay = restarted.record_completed(
            ["mem_00000001"], ["mem_00000002"],
            fallback_code="HYBRID_ACTIVE", request_id=request_id)
        check(replay["valid_requests"] == 1, "duplicate request counted twice")


def test_review_and_readiness_contract():
    with tempfile.TemporaryDirectory() as tmp:
        progress = ShadowProgress(os.path.join(tmp, "progress.json"))
        progress.start()
        differing = []
        for pos in range(100):
            hybrid = ["mem_00000002"] if pos < 2 else ["mem_00000003"]
            baseline = ["mem_00000001"] if pos < 2 else ["mem_00000003"]
            request_id, _ = progress.record_completed(baseline, hybrid)
            if pos < 2:
                differing.append(request_id)
        status = progress.status()
        check(status["manual_review_target"] == 30, status)
        check(status["manual_reviews_required"] == 2, status)
        check(status["readiness"] == "REVIEW_PENDING", status)
        progress.record_review(differing[0], "BETTER")
        final = progress.record_review(differing[1], "SAME")
        check(final["readiness"] == "READY_FOR_VERIFIER", final)
        expect_error(
            lambda: progress.record_review(differing[1], "WORSE"),
            "ALREADY_RECORDED")


def test_hard_event_fails_readiness_and_invalid_ids_rejected():
    with tempfile.TemporaryDirectory() as tmp:
        progress = ShadowProgress(os.path.join(tmp, "progress.json"))
        expect_error(
            lambda: progress.record_completed([], []), "NOT_STARTED")
        progress.start()
        _, status = progress.record_completed(
            ["mem_00000001"], ["mem_00000001"],
            event_counts={"leakage_events": 1})
        check(status["leakage_events"] == 1, status)
        expect_error(
            lambda: progress.record_completed(["/home/user/private"], []),
            "memory id")


def test_tampered_progress_cannot_add_content_fields():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "progress.json")
        progress = ShadowProgress(path)
        progress.start()
        request_id, _ = progress.record_completed(
            ["mem_00000001"], ["mem_00000002"])
        value = json.loads(open(path, "r", encoding="utf-8").read())
        value["requests"][request_id]["raw_query"] = "PRIVATE_QUERY_MARKER"
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(value, fh)
        expect_error(progress.status, "REQUEST_FIELDS_INVALID")


def test_runner_failures_are_counted_without_error_text():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "progress.json")
        progress = ShadowProgress(path)
        progress.start()

        def baseline_ok(query):
            return Result(["mem_00000001"])

        def candidate_crash(query):
            raise RuntimeError("PRIVATE_QUERY_MARKER /home/user secret")

        _, status = ShadowHarness(
            progress, baseline_ok, candidate_crash).run("PRIVATE_QUERY_MARKER")
        check(status["valid_requests"] == 1, status)
        check(status["runtime_crashes"] == 1, status)
        raw = open(path, "r", encoding="utf-8").read()
        check("PRIVATE_QUERY_MARKER" not in raw and "/home/user" not in raw,
              "exception/query leaked to progress")

        def baseline_crash(query):
            raise RuntimeError("PRIVATE_BASELINE_ERROR")

        try:
            ShadowHarness(progress, baseline_crash, baseline_ok).run("private")
            raise AssertionError("baseline error must propagate")
        except RuntimeError:
            pass
        final = progress.status()
        check(final["invalid_attempts"] == 1, final)
        check(final["valid_requests"] == 1, final)


TESTS = [
    test_missing_status_is_read_only_not_started,
    test_cli_status_json_and_human_do_not_need_controller,
    test_harness_persists_no_query_or_content_and_resumes,
    test_review_and_readiness_contract,
    test_hard_event_fails_readiness_and_invalid_ids_rejected,
    test_tampered_progress_cannot_add_content_fields,
    test_runner_failures_are_counted_without_error_text,
]


if __name__ == "__main__":
    failures = 0
    for test in TESTS:
        try:
            test()
            print("PASS %s" % test.__name__)
        except Exception as exc:
            failures += 1
            print("FAIL %s: %s" % (test.__name__, exc))
    print("----")
    print("%d test(s), %d failure(s)" % (len(TESTS), failures))
    sys.exit(1 if failures else 0)
