# -*- coding: utf-8 -*-
"""Gate 0-H isolated Shadow progress and in-process dual-run harness.

Only sanitized counters, generated request IDs, memory IDs and verdicts are
persisted.  Queries, object content, vectors, secrets and stable query hashes
are deliberately absent from the on-disk schema.
"""

import os
import re
import time
import uuid

from .identifiers import now_rfc3339, parse_rfc3339
from .locking import CrossProcessLock
from .manifests import atomic_write_json, read_json
from .paths import resolve_repo


SCHEMA_VERSION = "r4-gate0-shadow-progress-v1"
VALID_TARGET = 100
REVIEW_TARGET = 30
REQUEST_RE = re.compile(r"^shadow-[0-9a-f]{32}$")
MEMORY_ID_RE = re.compile(r"^mem_[0-9a-z]{8,16}$")
REVIEW_VERDICTS = ("BETTER", "SAME", "WORSE")
FALLBACK_CODES = {
    "HYBRID_ACTIVE",
    "HYBRID_RUNTIME_UNAVAILABLE",
    "HYBRID_INDEX_UNAVAILABLE",
    "HYBRID_INDEX_DIRTY",
    "HYBRID_INDEX_BUILDING",
    "HYBRID_SOURCE_FINGERPRINT_MISMATCH",
    "HYBRID_MODEL_INFERENCE_ERROR",
    "HYBRID_HISTORY_UNSUPPORTED",
    "HYBRID_RUNTIME_CRASH",
}

COUNTER_NAMES = (
    "valid_requests",
    "invalid_attempts",
    "hybrid_differences",
    "manual_reviews",
    "manual_worse",
    "critical_worse",
    "leakage_events",
    "runtime_crashes",
    "index_corruptions",
    "nondeterminism_events",
    "miv005a_correct_lost",
    "fallback_mismatches",
    "p0_p1_events",
)


class ShadowProgressError(RuntimeError):
    pass


def default_progress_path(repo=None):
    workspace = os.environ.get("CROSS_MEMORY_GATE0_WORKSPACE")
    if workspace:
        root = os.path.abspath(os.path.expanduser(workspace))
    else:
        root = os.path.join(repo or resolve_repo(), ".gate0-workspace")
    return os.path.join(root, "shadow", "progress.json")


def new_progress():
    return {
        "schema_version": SCHEMA_VERSION,
        "state": "NOT_STARTED",
        "started_at": None,
        "updated_at": None,
        "targets": {
            "valid_requests": VALID_TARGET,
            "manual_reviews": REVIEW_TARGET,
        },
        "counters": {name: 0 for name in COUNTER_NAMES},
        "requests": {},
    }


def _validate_memory_ids(values):
    if not isinstance(values, list):
        raise ShadowProgressError("sanitized memory ids must be a list")
    result = []
    for value in values:
        if not isinstance(value, str) or not MEMORY_ID_RE.match(value):
            raise ShadowProgressError("invalid sanitized memory id")
        result.append(value)
    if len(set(result)) != len(result):
        raise ShadowProgressError("duplicate sanitized memory id")
    return result


def _validate_progress(value):
    if not isinstance(value, dict) or value.get("schema_version") != SCHEMA_VERSION:
        raise ShadowProgressError("SHADOW_PROGRESS_SCHEMA_MISMATCH")
    expected_top = {
        "schema_version", "state", "started_at", "updated_at", "targets",
        "counters", "requests",
    }
    if set(value) != expected_top:
        raise ShadowProgressError("SHADOW_PROGRESS_FIELDS_INVALID")
    if value.get("state") not in ("NOT_STARTED", "RUNNING"):
        raise ShadowProgressError("SHADOW_PROGRESS_STATE_INVALID")
    if value.get("targets") != {
            "valid_requests": VALID_TARGET,
            "manual_reviews": REVIEW_TARGET}:
        raise ShadowProgressError("SHADOW_PROGRESS_TARGETS_INVALID")
    for field in ("started_at", "updated_at"):
        stamp = value.get(field)
        if stamp is not None and (
                not isinstance(stamp, str) or len(stamp) > 64 or
                parse_rfc3339(stamp) is None):
            raise ShadowProgressError("SHADOW_PROGRESS_TIMESTAMP_INVALID")
    counters = value.get("counters")
    if not isinstance(counters, dict) or set(counters) != set(COUNTER_NAMES):
        raise ShadowProgressError("SHADOW_PROGRESS_COUNTERS_INVALID")
    for name in COUNTER_NAMES:
        count = counters.get(name)
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            raise ShadowProgressError("SHADOW_PROGRESS_COUNTER_INVALID: %s" % name)
    requests = value.get("requests")
    if not isinstance(requests, dict):
        raise ShadowProgressError("SHADOW_PROGRESS_REQUESTS_INVALID")
    for request_id, item in requests.items():
        if not REQUEST_RE.match(request_id) or not isinstance(item, dict):
            raise ShadowProgressError("SHADOW_PROGRESS_REQUEST_INVALID")
        if set(item) != {
                "baseline_ids", "hybrid_ids", "different", "fallback_code",
                "fallback_matches", "events", "review"}:
            raise ShadowProgressError("SHADOW_PROGRESS_REQUEST_FIELDS_INVALID")
        _validate_memory_ids(item.get("baseline_ids"))
        _validate_memory_ids(item.get("hybrid_ids"))
        fallback = item.get("fallback_code")
        if fallback is not None and fallback not in FALLBACK_CODES:
            raise ShadowProgressError("SHADOW_PROGRESS_FALLBACK_INVALID")
        if not isinstance(item.get("different"), bool) or \
                item["different"] != \
                (item["baseline_ids"] != item["hybrid_ids"]):
            raise ShadowProgressError("SHADOW_PROGRESS_DIFFERENCE_INVALID")
        if not isinstance(item.get("fallback_matches"), bool):
            raise ShadowProgressError("SHADOW_PROGRESS_FALLBACK_MATCH_INVALID")
        events = item.get("events")
        if not isinstance(events, dict):
            raise ShadowProgressError("SHADOW_PROGRESS_EVENTS_INVALID")
        for name, count in events.items():
            if name not in set(COUNTER_NAMES) - {
                    "valid_requests", "invalid_attempts",
                    "hybrid_differences", "manual_reviews", "manual_worse",
                    "critical_worse", "fallback_mismatches"} or \
                    not isinstance(count, int) or \
                    isinstance(count, bool) or count < 0:
                raise ShadowProgressError("SHADOW_PROGRESS_EVENT_INVALID")
        review = item.get("review")
        if review is not None and (
                not isinstance(review, dict) or
                set(review) != {"verdict", "critical"} or
                review.get("verdict") not in REVIEW_VERDICTS or
                not isinstance(review.get("critical"), bool)):
            raise ShadowProgressError("SHADOW_PROGRESS_REVIEW_INVALID")
    if counters["valid_requests"] != len(requests):
        raise ShadowProgressError("SHADOW_PROGRESS_VALID_COUNT_MISMATCH")
    if counters["hybrid_differences"] != sum(
            1 for item in requests.values() if item["different"]):
        raise ShadowProgressError("SHADOW_PROGRESS_DIFFERENCE_COUNT_MISMATCH")
    reviews = [item["review"] for item in requests.values()
               if item["review"] is not None]
    if counters["manual_reviews"] != len(reviews) or \
            counters["manual_worse"] != sum(
                1 for review in reviews if review["verdict"] == "WORSE") or \
            counters["critical_worse"] != sum(
                1 for review in reviews
                if review["verdict"] == "WORSE" and review["critical"]):
        raise ShadowProgressError("SHADOW_PROGRESS_REVIEW_COUNT_MISMATCH")
    if counters["fallback_mismatches"] != sum(
            1 for item in requests.values() if not item["fallback_matches"]):
        raise ShadowProgressError("SHADOW_PROGRESS_FALLBACK_COUNT_MISMATCH")
    for name in set(COUNTER_NAMES) - {
            "valid_requests", "invalid_attempts", "hybrid_differences",
            "manual_reviews", "manual_worse", "critical_worse",
            "fallback_mismatches"}:
        if counters[name] != sum(
                item["events"].get(name, 0) for item in requests.values()):
            raise ShadowProgressError(
                "SHADOW_PROGRESS_EVENT_COUNT_MISMATCH: %s" % name)
    return value


def _read_or_initial(path):
    if not os.path.isfile(path):
        return new_progress()
    return _validate_progress(read_json(path))


def _status(value):
    counters = dict(value["counters"])
    differences = counters["hybrid_differences"]
    required_reviews = min(REVIEW_TARGET, differences)
    reviewed = counters["manual_reviews"]
    worse_rate = (float(counters["manual_worse"]) / reviewed
                  if reviewed else 0.0)
    hard_events = sum(counters[name] for name in (
        "leakage_events", "runtime_crashes", "index_corruptions",
        "nondeterminism_events", "miv005a_correct_lost",
        "fallback_mismatches", "p0_p1_events", "critical_worse"))
    if value["state"] == "NOT_STARTED":
        readiness = "NOT_STARTED"
    elif hard_events:
        readiness = "FAILED"
    elif counters["valid_requests"] < VALID_TARGET:
        readiness = "COLLECTING"
    elif reviewed < required_reviews:
        readiness = "REVIEW_PENDING"
    elif worse_rate > 0.05:
        readiness = "FAILED"
    else:
        readiness = "READY_FOR_VERIFIER"
    return {
        "state": value["state"],
        "readiness": readiness,
        "valid_requests": counters["valid_requests"],
        "valid_target": VALID_TARGET,
        "invalid_attempts": counters["invalid_attempts"],
        "hybrid_differences": differences,
        "manual_reviews": reviewed,
        "manual_review_target": REVIEW_TARGET,
        "manual_reviews_required": required_reviews,
        "manual_worse": counters["manual_worse"],
        "manual_worse_rate": worse_rate,
        "critical_worse": counters["critical_worse"],
        "leakage_events": counters["leakage_events"],
        "runtime_crashes": counters["runtime_crashes"],
        "index_corruptions": counters["index_corruptions"],
        "nondeterminism_events": counters["nondeterminism_events"],
        "miv005a_correct_lost": counters["miv005a_correct_lost"],
        "fallback_mismatches": counters["fallback_mismatches"],
        "p0_p1_events": counters["p0_p1_events"],
        "started_at": value.get("started_at"),
        "updated_at": value.get("updated_at"),
    }


class ShadowProgress(object):
    def __init__(self, path=None, repo=None):
        self.path = path or default_progress_path(repo=repo)
        self.lock_path = self.path + ".lock"

    def status(self):
        """Read-only status.  Missing progress remains NOT_STARTED on disk."""
        return _status(_read_or_initial(self.path))

    def _mutate(self, callback):
        deadline = time.monotonic() + 5.0
        lock = None
        while lock is None:
            candidate = CrossProcessLock(
                self.lock_path, purpose="gate0-shadow-progress")
            if candidate.acquire():
                lock = candidate
                break
            if time.monotonic() >= deadline:
                raise ShadowProgressError("SHADOW_PROGRESS_LOCK_BUSY")
            time.sleep(0.01)
        try:
            value = _read_or_initial(self.path)
            callback(value)
            value["updated_at"] = now_rfc3339()
            _validate_progress(value)
            atomic_write_json(self.path, value)
            try:
                os.chmod(os.path.dirname(self.path), 0o700)
                os.chmod(self.path, 0o600)
            except OSError:
                pass
            return _status(value)
        finally:
            lock.release()

    def start(self):
        def update(value):
            if value["state"] == "NOT_STARTED":
                value["state"] = "RUNNING"
                value["started_at"] = now_rfc3339()
        return self._mutate(update)

    def record_invalid_attempt(self):
        def update(value):
            if value["state"] != "RUNNING":
                raise ShadowProgressError("SHADOW_NOT_STARTED")
            value["counters"]["invalid_attempts"] += 1
        return self._mutate(update)

    def record_completed(self, baseline_ids, hybrid_ids, fallback_code=None,
                         fallback_matches=True, request_id=None,
                         event_counts=None):
        request_id = request_id or ("shadow-" + uuid.uuid4().hex)
        if not REQUEST_RE.match(request_id):
            raise ShadowProgressError("invalid generated request id")
        baseline_ids = _validate_memory_ids(baseline_ids)
        hybrid_ids = _validate_memory_ids(hybrid_ids)
        if fallback_code is not None and fallback_code not in FALLBACK_CODES:
            raise ShadowProgressError("invalid sanitized fallback code")
        event_counts = dict(event_counts or {})
        allowed_events = set(COUNTER_NAMES) - {
            "valid_requests", "invalid_attempts", "hybrid_differences",
            "manual_reviews", "manual_worse", "critical_worse",
            "fallback_mismatches",
        }
        for name, count in event_counts.items():
            if name not in allowed_events or not isinstance(count, int) or \
                    isinstance(count, bool) or count < 0:
                raise ShadowProgressError("invalid shadow event counter")

        def update(value):
            if value["state"] != "RUNNING":
                raise ShadowProgressError("SHADOW_NOT_STARTED")
            existing = value["requests"].get(request_id)
            item = {
                "baseline_ids": baseline_ids,
                "hybrid_ids": hybrid_ids,
                "different": baseline_ids != hybrid_ids,
                "fallback_code": fallback_code,
                "fallback_matches": bool(fallback_matches),
                "events": event_counts,
                "review": None,
            }
            if existing is not None:
                comparable = dict(existing)
                comparable["review"] = None
                if comparable != item:
                    raise ShadowProgressError("SHADOW_REQUEST_ID_COLLISION")
                return
            value["requests"][request_id] = item
            counters = value["counters"]
            counters["valid_requests"] += 1
            if item["different"]:
                counters["hybrid_differences"] += 1
            if not fallback_matches:
                counters["fallback_mismatches"] += 1
            for name, count in event_counts.items():
                counters[name] += count

        return request_id, self._mutate(update)

    def record_review(self, request_id, verdict, critical=False):
        if not REQUEST_RE.match(request_id):
            raise ShadowProgressError("invalid generated request id")
        verdict = str(verdict).upper()
        if verdict not in REVIEW_VERDICTS:
            raise ShadowProgressError("invalid manual review verdict")

        def update(value):
            item = value["requests"].get(request_id)
            if item is None or not item.get("different"):
                raise ShadowProgressError("review requires a differing request")
            review = {"verdict": verdict, "critical": bool(critical)}
            if item.get("review") is not None:
                if item["review"] != review:
                    raise ShadowProgressError("SHADOW_REVIEW_ALREADY_RECORDED")
                return
            item["review"] = review
            counters = value["counters"]
            counters["manual_reviews"] += 1
            if verdict == "WORSE":
                counters["manual_worse"] += 1
                if critical:
                    counters["critical_worse"] += 1

        return self._mutate(update)


class ShadowHarness(object):
    """Dual-run one query in memory; persist only IDs and fixed counters."""

    def __init__(self, progress, baseline_runner, hybrid_runner):
        self.progress = progress
        self.baseline_runner = baseline_runner
        self.hybrid_runner = hybrid_runner

    @staticmethod
    def _ids(result):
        objects = getattr(result, "objects", result)
        return _validate_memory_ids([
            item.get("id") if isinstance(item, dict) else item
            for item in objects
        ])

    def run(self, query, request_id=None):
        """The query exists only on this stack and is never passed to storage."""
        try:
            baseline = self.baseline_runner(query)
        except Exception:
            self.progress.record_invalid_attempt()
            raise
        try:
            hybrid = self.hybrid_runner(query)
        except Exception:
            return self.progress.record_completed(
                self._ids(baseline), self._ids(baseline),
                fallback_code="HYBRID_RUNTIME_CRASH",
                fallback_matches=True, request_id=request_id,
                event_counts={"runtime_crashes": 1})
        fallback_code = getattr(hybrid, "semantic_status", None)
        fallback_matches = True
        if fallback_code and fallback_code != "HYBRID_ACTIVE":
            fallback_matches = self._ids(baseline) == self._ids(hybrid)
        return self.progress.record_completed(
            self._ids(baseline), self._ids(hybrid),
            fallback_code=fallback_code,
            fallback_matches=fallback_matches,
            request_id=request_id)
