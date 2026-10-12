"""Candidate orchestration of preregistered saved-output evaluations.

run_harness(required_bindings, saved_runs, run_one, *, consumer) uses the existing
run_saved as run_one; no scorer, metrics, parser or replay algorithm is copied.
No model, data acquisition, output writer, Gate or authority operation exists.
Caller verifies Domain authority, Source bytes and callback purity beforehand.

Each required local slot has slot_id, suite_ref, workflow_ref, comparison_group,
controls, binding, split, consumer and input_requests. requirement_refs may carry
the exact preregistered plan subitems; they are not new Suite/Capability IDs.
Suite/workflow refs are original caller-bound references, not title-based proof
of coverage. controls requires the eight existing semantic reference roles in
CONTROL_ROLES, with None explicitly marking an external input still required.
input_requests contains id/input_sha256/split_id; id is the frozen evaluation
sample identity, not a provider's independent invocation request identity.

saved_runs maps slot_id to run_saved's eight named arguments, or to exactly
{"not_admitted_reason": {"source_ref": ..., "reason_code": ...}}. An absent
saved run stays EXTERNAL_INPUT_REQUIRED; failed and NOT_ADMITTED slots are kept.
Within comparison_group only provider/model/model_revision identity and saved
output/usage/snapshot digest may differ. All controls, inputs, policies, Source,
split/purpose, Gold, threshold and Profile references remain fixed.

The collection's consumer is the same exact original consumer on every slot
and must be in each split's allowed_consumers. Selection collections are
rejected BEFORE any replay if any slot is not development/selection validation.
Returned completeness means registered slots only; it never proves the complete
five Suites, three workflows, real measurements or M2/product qualification.
"""

import copy
import hashlib
import json
import math
from collections import Counter

from saved_report_runner import _reference, _render, canonical_sha256, snapshot_metadata


CONTROL_ROLES = {"task_spec_ref", "workflow_spec_ref", "context_snapshot_ref",
    "budget_ref", "scope_ref", "allowed_side_effects_ref", "allowed_branches_ref", "input_snapshot_ref"}
SLOT_FIELDS = {"slot_id", "suite_ref", "workflow_ref", "comparison_group", "controls",
               "binding", "split", "consumer", "input_requests"}
RUN_FIELDS = {"snapshot", "binding", "split", "consumer", "scorer", "projector", "metrics", "renderer"}
CALLBACK_FIELDS = {"scorer", "projector", "metrics", "renderer"}
EXECUTOR_FIELDS = {"provider_ref", "model_ref", "model_revision_ref"}
PURPOSES = {"training", "development", "calibration_fit", "selection_policy_validation",
            "qualification", "final_holdout"}  # Existing DatasetSplitDefinition purposes.


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _text(value, name):
    _require(type(value) is str and value, "invalid " + name)
    value.encode("utf-8", errors="strict")


def _freeze(value, callbacks=False):
    if value is None or type(value) in (bool, int):
        return ["scalar", value]
    if type(value) is float:
        _require(math.isfinite(value), "nonfinite local value")
        return ["scalar", value]
    if type(value) is str:
        value.encode("utf-8", errors="strict")
        return ["scalar", value]
    if type(value) is bytes:
        return ["saved_bytes", hashlib.sha256(value).hexdigest()]
    if callbacks and callable(value):
        # Mutation check only, not portable Source identity or purity proof.
        return ["local_callback_object_identity", id(value)]
    if type(value) is list:
        return ["list", [_freeze(item, callbacks) for item in value]]
    _require(type(value) is dict and all(type(k) is str for k in value), "invalid local value")
    return ["dict", {k: _freeze(v, callbacks) for k, v in value.items()}]


def _seal(value, callbacks=False):
    raw = json.dumps(_freeze(value, callbacks), sort_keys=True, separators=(",", ":"),
                     ensure_ascii=False, allow_nan=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _selection(consumer):
    _require(type(consumer) is dict and set(consumer) == {"id", "uses_for_selection"} and
             type(consumer["uses_for_selection"]) is bool, "invalid existing consumer projection")
    _text(consumer["id"], "consumer")
    if consumer["id"] == "M3_SELECTION_PREPARATION":
        _require(consumer["uses_for_selection"], "known selection consumer flag conflict")
    return consumer["uses_for_selection"]


def _requests(rows):
    _require(type(rows) is list, "input_requests must be list")
    ids = []
    for row in rows:
        _require(type(row) is dict and set(row) == {"id", "input_sha256", "split_id"}, "invalid input identity")
        _text(row["id"], "sample identity")
        _text(row["split_id"], "split identity")
        sha = row["input_sha256"]
        _require(type(sha) is str and len(sha) == 64 and all(c in "0123456789abcdef" for c in sha),
                 "invalid input SHA-256")
        ids.append(row["id"])
    _require(len(ids) == len(set(ids)), "duplicate input identity")
    return sorted(rows, key=lambda row: row["id"])


def _compare_controls(slot):
    binding = {k: v for k, v in slot["binding"].items()
               if k not in EXECUTOR_FIELDS | {"snapshot_sha256"}}
    return _seal({"suite_ref": slot["suite_ref"], "workflow_ref": slot["workflow_ref"],
        "controls": slot["controls"], "binding": binding, "split": slot["split"],
        "consumer": slot["consumer"], "input_requests": _requests(slot["input_requests"]),
        "requirement_refs": slot.get("requirement_refs")})


def _preflight(required, saved, consumer):
    _require(type(required) is list and type(saved) is dict, "invalid preregistered collection")
    selection = _selection(consumer)
    ids, groups, external = [], {}, {}
    for slot in required:
        _require(type(slot) is dict and SLOT_FIELDS <= set(slot) <= SLOT_FIELDS | {"requirement_refs"},
                 "invalid preregistered slot")
        _text(slot["slot_id"], "slot_id")
        ids.append(slot["slot_id"])
        _require(type(slot["binding"]) is dict and type(slot["split"]) is dict and
                 type(slot["controls"]) is dict, "missing preregistered binding/split/controls")
        _require(CONTROL_ROLES <= set(slot["controls"]), "missing explicit control reference roles")
        for key in CONTROL_ROLES:
            _reference(slot["controls"][key], "controls." + key, required=False)
        for key in ("suite_ref", "workflow_ref"):
            _reference(slot[key], key, required=False)
        for key in EXECUTOR_FIELDS | {"gold_ref", "threshold_ref", "profile_ref"}:
            _require(key in slot["binding"], "missing explicit binding reference field")
            _reference(slot["binding"][key], "binding." + key, required=False)
        _require(_seal(slot["consumer"]) == _seal(consumer), "collection recipient differs from slot consumer")
        split = slot["split"]
        _require(split.get("purpose_id") in PURPOSES and type(split.get("final_holdout")) is bool and
                 split["final_holdout"] == (split["purpose_id"] == "final_holdout"), "purpose/holdout conflict")
        allowed = split.get("allowed_consumers")
        _require(type(allowed) is list and consumer["id"] in allowed, "collection recipient not allowed")
        _require(not selection or split["purpose_id"] in {"development", "selection_policy_validation"},
                 "collection cannot disclose this purpose to M3 selection")
        exposures = split.get("exposure_records")
        _require(type(exposures) is list, "missing exposure records")
        for exposure in exposures:
            _require(type(exposure) is dict, "invalid exposure record")
            if "used_for_selection" in exposure:
                _require(type(exposure["used_for_selection"]) is bool, "invalid exposure selection flag")
            if exposure.get("consumer_id") == "M3_SELECTION_PREPARATION":
                _require(exposure.get("used_for_selection") is True, "known selection exposure flag conflict")
            _require(split["purpose_id"] not in {"qualification", "final_holdout"} or
                     exposure.get("used_for_selection") is not True, "selected material retains qualification purpose")
        inputs = _requests(slot["input_requests"])
        _require(all(row["split_id"] == split.get("split_id") for row in inputs), "cross-split input identity")
        expected = slot["binding"].get("policy", {}).get("expected_request_ids")
        _require(type(expected) is list and len(expected) == len(set(expected)) and
                 set(expected) == {r["id"] for r in inputs}, "preregistered request coverage mismatch")
        missing = ["controls." + k for k in sorted(CONTROL_ROLES) if slot["controls"][k] is None]
        missing += [k for k in ("suite_ref", "workflow_ref") if slot[k] is None]
        missing += ["binding." + k for k in sorted(EXECUTOR_FIELDS | {"gold_ref", "threshold_ref", "profile_ref"})
                    if slot["binding"].get(k) is None]
        external[slot["slot_id"]] = missing
        group = slot["comparison_group"]
        if group is not None:
            _text(group, "comparison_group")
            signature = _compare_controls(slot)
            _require(group not in groups or groups[group] == signature, "fixed workflow comparison drift")
            groups[group] = signature
    _require(len(ids) == len(set(ids)), "duplicate preregistered slot")
    _require(set(saved) <= set(ids), "unregistered saved branch")
    for slot in required:
        run = saved.get(slot["slot_id"])
        if run is None:
            _require(slot["slot_id"] not in saved, "missing saved run must be absent, not ambiguous None")
            continue
        _require(type(run) is dict, "invalid saved run")
        if set(run) == {"not_admitted_reason"}:
            reason = run["not_admitted_reason"]
            _require(type(reason) is dict and set(reason) == {"source_ref", "reason_code"}, "missing admission reason")
            for value in reason.values():
                _text(value, "admission reason reference")
            continue
        _require(set(run) == RUN_FIELDS and all(callable(run[k]) for k in CALLBACK_FIELDS), "invalid saved replay arguments")
        for key in ("binding", "split", "consumer"):
            _require(_seal(run[key]) == _seal(slot[key]), "saved run differs from preregistered " + key)
        snapshot = run["snapshot"]
        _require(type(snapshot) is list and all(type(row) is dict for row in snapshot), "invalid saved snapshot")
        actual = [{k: row.get(k) for k in ("id", "input_sha256", "split_id")} for row in snapshot]
        _require(_seal(_requests(actual)) == _seal(_requests(slot["input_requests"])), "saved input identity drift")
    return external


def _replay_carrier(replay, run):
    """Check the existing runner's complete carrier; do not recompute its scores."""
    _require(type(replay) is dict and replay.get("status") == "CANDIDATE_SAVED_OUTPUT_REPLAY_ONLY" and
             replay.get("authority_effect") == "NONE" and replay.get("qualification") == "NOT_ISSUED",
             "invalid replay carrier")
    report = replay.get("report")
    _require(type(report) is dict and report.get("status") == "CANDIDATE_SAVED_OUTPUT_REPLAY_ONLY" and
             report.get("authority_effect") == "NONE" and report.get("qualification") == "NOT_ISSUED",
             "invalid replay report")
    for key, result_key in (("binding", "source_binding"), ("split", "split"), ("consumer", "consumer")):
        _require(_seal(run[key]) == _seal(report.get(result_key)), "returned replay binding drift")
    _require(report.get("evidence_kind") == run["binding"]["evidence_kind"], "replay evidence kind drift")
    expected_requests = snapshot_metadata(run["snapshot"])
    _require(_seal(report.get("requests")) == _seal(expected_requests), "replay omitted or changed saved requests")
    scores, metrics = report.get("scores"), report.get("metrics")
    _require(type(scores) is list and type(metrics) is dict and metrics.get("authority_effect") == "NONE" and
             metrics.get("gate_verdict") == "NOT_ISSUED", "missing original score/metrics carrier")
    requests = {row["id"]: row for row in expected_requests}
    score_ids = []
    for score in scores:
        _require(type(score) is dict and set(score) == {"request", "score_fields"} and
                 type(score["request"]) is dict and type(score["score_fields"]) is dict, "invalid scored request carrier")
        request_id = score["request"].get("id")
        _require(type(request_id) is str and request_id in requests and
                 _seal(score["request"]) == _seal(requests[request_id]), "scored saved request drift")
        score_ids.append(request_id)
    _require(len(score_ids) == len(set(score_ids)) == len(requests) and set(score_ids) == set(requests),
             "score coverage mismatch")
    score_sha = canonical_sha256(scores)
    _require(report.get("score_sha256") == score_sha, "score digest mismatch")
    rendered = replay.get("rendered_bytes")
    _render(report, lambda _: rendered)  # Reuse existing strict renderer/content validator.
    expected = {"score_sha256": score_sha, "report_sha256": canonical_sha256(report),
                "rendered_sha256": hashlib.sha256(rendered).hexdigest()}
    digests = replay.get("replay_digests")
    _require(type(digests) is list and len(digests) == 2 and all(d == expected for d in digests),
             "missing or inconsistent two-replay digests")


def run_harness(required_bindings, saved_runs, run_one, *, consumer):
    """Return all original registered slots to their same bound report consumer."""
    _require(callable(run_one), "missing existing run_saved callable")
    before = _seal({"required": required_bindings, "saved": saved_runs, "consumer": consumer}, callbacks=True)
    external = _preflight(required_bindings, saved_runs, consumer)
    required, saved, recipient = copy.deepcopy(required_bindings), copy.deepcopy(saved_runs), copy.deepcopy(consumer)
    slots = []
    for registered in required:
        slot_id = registered["slot_id"]
        record = {"slot_id": slot_id, "registered_binding": registered,
                  "external_inputs_required": external[slot_id], "authority_effect": "NONE",
                  "qualification": "NOT_ISSUED"}
        run = saved.get(slot_id)
        if run is None:
            record.update(status="EXTERNAL_INPUT_REQUIRED", reason_code="SAVED_RUN_MISSING")
        elif "not_admitted_reason" in run:
            record.update(status="NOT_ADMITTED", admission_reason=run["not_admitted_reason"])
        else:
            try:
                passed = copy.deepcopy(run)
                frozen = _seal(passed, callbacks=True)
                replay = copy.deepcopy(run_one(**passed))
                _require(frozen == _seal(passed, callbacks=True), "replay mutated supplied argument")
                _replay_carrier(replay, run)
                record.update(status="REPLAYED_CANDIDATE", replay=replay)
            except Exception as exc:
                record.update(status="FAILED_SLOT", reason_code="SAVED_REPLAY_REJECTED" if
                              isinstance(exc, ValueError) else "CALLBACK_ERROR", exception_type=type(exc).__name__)
        slots.append(record)
    _require(before == _seal({"required": required_bindings, "saved": saved_runs, "consumer": consumer}, callbacks=True),
             "callback mutated original collection")
    counts = Counter(row["status"] for row in slots)
    return {"status": "CANDIDATE_HARNESS_SUMMARY_ONLY", "coverage_scope": "REGISTERED_SLOT_MANIFEST_ONLY",
        "authority_effect": "NONE", "qualification": "NOT_ISSUED", "consumer": recipient,
        "registered_slot_count": len(required), "slot_status_counts": dict(counts), "slots": slots,
        "registered_replay_completeness": "ALL_REGISTERED_SLOTS_REPLAYED" if required and
             counts["REPLAYED_CANDIDATE"] == len(required) else "INCOMPLETE",
        "all_reference_inputs_present": not any(external.values()),
        "formal_suite_workflow_coverage": "NOT_ESTABLISHED",
        "trust_boundary": "CALLER_VERIFIES_EXISTING_DOMAIN_SOURCE_CALLBACK_AND_READ_WRITE_AUTHORITY"}
