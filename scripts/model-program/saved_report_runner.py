"""Local candidate replay of saved outputs; no model calls or authority writer.

run_saved(snapshot, binding, split, consumer, scorer, projector, metrics,
renderer) accepts already validated local projections, not a new PortSchema.
The caller must verify actual Domain Schema, Source bytes, references, lawful
data access, split authority and callback purity BEFORE calling. SHA carriers
and callable identity alone prove none of those facts. This module checks only
carrier consistency, complete request preservation and deterministic replay.

snapshot rows: id, input_sha256, raw_output (bytes|None), terminal_status,
usage (dict|None), split_id. binding: snapshot_sha256, split_sha256, policy,
policy_sha256, sources and source_locks (each role has ref and sha256),
provider_ref, model_ref, model_revision_ref, profile_ref, gold_ref,
threshold_ref, evidence_kind, dataset_revision_sha256, evaluation_revision_sha256.
Source roles: scorer, projector, normalization, metrics, renderer. Source locks
are externally verified frozen references, not an authorization minted here.
split: split_id, purpose_id, experiment_scope, allowed_consumers,
exposure_records, final_holdout. consumer: id, uses_for_selection.

scorer(snapshot_copy, binding_copy, split_copy) -> list: each row retains EVERY
snapshot field byte-for-byte and may add JSON score fields.
projector(scored_copy, policy_copy) -> list: each row retains id, status (exact
terminal_status), usage; other fields are the injected metrics' local API.
metrics(rows_without_usage, policy_copy) -> JSON report; no algorithm copied.
renderer(report_copy) -> UTF-8 JSON bytes representing that exact report.

canonical_sha256(value) seals local JSON metadata with sorted keys, compact
UTF-8 and finite numbers; snapshot_metadata(snapshot) replaces output bytes by
their exact SHA-256. No JCS/Port/Gate or formal qualification is claimed.
"""

import copy
import hashlib
import json
import math


SNAPSHOT_FIELDS = {"id", "input_sha256", "raw_output", "terminal_status", "usage", "split_id"}
SPLIT_FIELDS = {"split_id", "purpose_id", "experiment_scope", "allowed_consumers",
                "exposure_records", "final_holdout"}
SOURCE_ROLES = {"scorer", "projector", "normalization", "metrics", "renderer"}
# Existing DatasetSplitDefinition.v0.1 purposes; caller declarations cannot remove them.
PURPOSE_IDS = {"training", "development", "calibration_fit", "selection_policy_validation",
               "qualification", "final_holdout"}
# Existing evidence distinctions in frozen model plan section 22.5.
EVIDENCE_KINDS = {"REFERENCE_DOCUMENTATION", "SPECIFICATION_EXAMPLE", "STATIC_VALIDATION",
                  "LIVE_MODEL_MEASUREMENT", "INDEPENDENT_REVIEW"}


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _text(value, name):
    _require(type(value) is str and value, name + " must be nonempty str")
    value.encode("utf-8", errors="strict")
    return value


def _sha(value, name):
    _require(type(value) is str and len(value) == 64 and
             all(c in "0123456789abcdef" for c in value), name + " must be lowercase SHA-256")
    return value


def _json(value):
    if value is None or type(value) in (bool, int):
        return
    if type(value) is float:
        _require(math.isfinite(value), "nonfinite JSON number")
    elif type(value) is str:
        value.encode("utf-8", errors="strict")
    elif type(value) is list:
        for item in value:
            _json(item)
    elif type(value) is dict:
        for key, item in value.items():
            _require(type(key) is str, "JSON object key must be str")
            _json(key)
            _json(item)
    else:
        raise ValueError("non-JSON local value")


def _canonical(value):
    _json(value)
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def canonical_sha256(value):
    return hashlib.sha256(_canonical(value)).hexdigest()


json_digest = canonical_sha256


def _ids(value, name):
    _require(type(value) is list, name + " must be list")
    for item in value:
        _text(item, name)
    _require(len(value) == len(set(value)), "duplicate " + name)
    return value


def _usage(value):
    _require(value is None or type(value) is dict, "usage must be dict or None")
    _json(value)
    if value is None:
        return
    for key, item in value.items():
        if key in {"input_tokens", "output_tokens", "total_tokens", "tokens_input", "tokens_output",
                   "cost_minor_units", "currency_exponent"}:
            _require(item is None or (type(item) is int and item >= 0), "invalid token usage")
        if key == "currency_exponent" and item is not None:
            # Existing ModelInvocationResult v2 bound; no new currency policy.
            _require(item <= 9, "currency exponent outside existing invocation bound")
        if key in {"cost", "cost_amount", "latency_ms", "duration_ms"}:
            _require(item is None or (type(item) in (int, float) and item >= 0), "invalid cost/time usage")
        if key == "currency" and item is not None:
            _text(item, "currency")


def snapshot_metadata(snapshot):
    """Preserve saved request order and missing output/usage in the frozen seal."""
    _require(type(snapshot) is list, "snapshot must be list")
    metadata = []
    for row in snapshot:
        _require(type(row) is dict and set(row) == SNAPSHOT_FIELDS, "invalid local snapshot projection")
        _text(row["id"], "request id")
        _sha(row["input_sha256"], "input_sha256")
        _text(row["terminal_status"], "terminal_status")
        _text(row["split_id"], "request split_id")
        _require(row["raw_output"] is None or type(row["raw_output"]) is bytes, "raw_output must be bytes or None")
        _usage(row["usage"])
        metadata.append({k: copy.deepcopy(row[k]) for k in SNAPSHOT_FIELDS if k != "raw_output"})
        metadata[-1]["raw_output_sha256"] = (hashlib.sha256(row["raw_output"]).hexdigest()
                                            if row["raw_output"] is not None else None)
    _ids([row["id"] for row in snapshot], "snapshot request ids")
    return metadata


def snapshot_digest(snapshot):
    return canonical_sha256(snapshot_metadata(snapshot))


def _reference(value, name, required=True):
    if value is None:
        _require(not required, "missing " + name)
        return
    _require((type(value) is str and value) or (type(value) is dict and value), "invalid " + name)
    _json(value)


def _validate(snapshot, binding, split, consumer):
    _require(type(binding) is dict and type(split) is dict and type(consumer) is dict, "invalid local arguments")
    _json(binding)
    _require(SPLIT_FIELDS <= set(split), "missing existing split fields")
    _json(split)
    _require(set(consumer) == {"id", "uses_for_selection"} and
             type(consumer["uses_for_selection"]) is bool, "invalid consumer projection")
    _text(consumer["id"], "consumer id")
    _text(split["split_id"], "split_id")
    _text(split["purpose_id"], "purpose_id")
    _require(split["experiment_scope"] is not None and split["experiment_scope"] != "",
             "missing experiment_scope")
    _require(type(split["final_holdout"]) is bool and type(split["exposure_records"]) is list,
             "invalid split exposure or holdout flag")
    allowed = _ids(split["allowed_consumers"], "allowed_consumers")
    _require(consumer["id"] in allowed, "consumer not allowed by split")
    # Reuse the existing preparation consumer identity; a false caller flag
    # cannot redefine this known selection consumer as a qualification reader.
    if consumer["id"] == "M3_SELECTION_PREPARATION":
        _require(consumer["uses_for_selection"], "known selection consumer flag conflict")
    _require(split["purpose_id"] in PURPOSE_IDS, "unknown existing purpose")
    _require(split["final_holdout"] == (split["purpose_id"] == "final_holdout"), "holdout purpose/flag mismatch")
    _require(not consumer["uses_for_selection"] or
             split["purpose_id"] not in {"qualification", "final_holdout"},
             "qualification/final holdout cannot feed M3 selection")
    for exposure in split["exposure_records"]:
        _require(type(exposure) is dict, "invalid exposure record")
        if "used_for_selection" in exposure:
            _require(type(exposure["used_for_selection"]) is bool, "invalid selection exposure flag")
        if exposure.get("consumer_id") == "M3_SELECTION_PREPARATION":
            _require(exposure.get("used_for_selection") is True,
                     "known selection exposure flag conflict")
        _require(split["purpose_id"] not in {"qualification", "final_holdout"} or
                 exposure.get("used_for_selection") is not True,
                 "selected/exposed material cannot retain qualification or unseen holdout purpose")
    _require(binding.get("evidence_kind") in EVIDENCE_KINDS, "unknown existing evidence kind")
    for field in ("dataset_revision_sha256", "evaluation_revision_sha256"):
        _sha(binding.get(field), field)
    for field in ("provider_ref", "model_ref", "model_revision_ref"):
        _reference(binding.get(field), field)
    for field in ("profile_ref", "gold_ref", "threshold_ref"):
        _require(field in binding, "missing reference field " + field)
        _reference(binding[field], field, required=False)
    sources, locks = binding.get("sources"), binding.get("source_locks")
    for group in (sources, locks):
        _require(type(group) is dict and set(group) == SOURCE_ROLES, "missing fixed Source roles")
        for source in group.values():
            _require(type(source) is dict and set(source) == {"ref", "sha256"}, "invalid Source ref")
            _text(source["ref"], "Source ref")
            _sha(source["sha256"], "Source sha256")
    _require(_canonical(sources) == _canonical(locks), "Source reference drift")
    policy = binding.get("policy")
    _require(type(policy) is dict, "missing pre-fixed policy")
    _require(canonical_sha256(policy) == _sha(binding.get("policy_sha256"), "policy_sha256"), "policy drift")
    _require(canonical_sha256(split) == _sha(binding.get("split_sha256"), "split_sha256"), "split identity drift")
    metadata = snapshot_metadata(snapshot)
    _require(canonical_sha256(metadata) == _sha(binding.get("snapshot_sha256"), "snapshot_sha256"), "saved snapshot drift")
    expected = _ids(policy.get("expected_request_ids"), "expected_request_ids")
    _require(set(expected) == {r["id"] for r in snapshot}, "request coverage mismatch")
    if "sample_ids" in split:
        _require(set(_ids(split["sample_ids"], "split sample_ids")) == set(expected), "split sample coverage mismatch")
    categories = policy.get("status_categories")
    _require(type(categories) is dict, "missing explicit arithmetic status mapping")
    currency_units = {}
    for row in snapshot:
        _require(row["split_id"] == split["split_id"], "cross-split saved request")
        _require(row["terminal_status"] in categories, "unmapped saved terminal status")
        _require(categories[row["terminal_status"]] != "SUCCEEDED" or row["raw_output"] is not None,
                 "successful request missing saved output bytes")
        usage = row["usage"] or {}
        if any(usage.get(k) is not None for k in ("cost", "cost_amount", "cost_minor_units")):
            currency = _text(usage.get("currency"), "observed cost currency")
            units = {k: v for k, v in usage.items() if k == "currency_exponent" or
                     k == "profile_ref" or k.startswith(("price_profile", "currency_profile"))}
            seal = canonical_sha256(units)
            _require(currency not in currency_units or currency_units[currency] == seal,
                     "same currency has conflicting units or price profiles")
            currency_units[currency] = seal
    return metadata


def _same_rows(rows, original, projection=False):
    _require(type(rows) is list and all(type(r) is dict for r in rows), "callback must return row list")
    ids = _ids([r.get("id") for r in rows], "callback request ids")
    _require(set(ids) == set(original), "callback omitted or added requests")
    for row in rows:
        saved = original[row["id"]]
        if projection:
            _require(row.get("status") == saved["terminal_status"] and "usage" in row and
                     _canonical(row["usage"]) == _canonical(saved["usage"]), "projector status/usage drift")
        else:
            _require(SNAPSHOT_FIELDS <= set(row) and row["raw_output"] == saved["raw_output"] and
                     all(_canonical(row[k]) == _canonical(saved[k]) for k in SNAPSHOT_FIELDS - {"raw_output"}),
                     "scorer saved identity/output/status/usage drift")
            _require(type(row["raw_output"]) is type(saved["raw_output"]), "scorer output byte type drift")


def _measurements(row, usage):
    """Check an explicit local projection, retaining minor units in source metadata."""
    usage = usage or {}
    for target, source in (("tokens_input", "input_tokens"), ("tokens_output", "output_tokens")):
        actual = usage.get(source, usage.get(target))
        _require(_canonical(row.get(target)) == _canonical(actual), "projector token measurement drift")
    latency = usage.get("latency_ms", usage.get("duration_ms"))
    _require(_canonical(row.get("latency_ms")) == _canonical(latency), "projector latency measurement drift")
    actual_cost = usage.get("cost", usage.get("cost_amount"))
    if usage.get("cost_minor_units") is not None:
        _require(usage.get("currency_exponent") is not None, "minor unit cost lacks currency exponent")
        try:
            converted = usage["cost_minor_units"] / (10 ** usage["currency_exponent"])
        except (OverflowError, ZeroDivisionError) as exc:
            raise ValueError("minor unit cost conversion overflow") from exc
        _require(math.isfinite(converted) and
                 (usage["cost_minor_units"] == 0 or converted > 0),
                 "positive observed cost cannot become zero or nonfinite")
        _require(actual_cost is None or actual_cost == converted, "inconsistent saved cost units")
        actual_cost = converted
    _require(row.get("cost") == actual_cost and
             (row.get("cost") is None or type(row["cost"]) in (int, float)), "projector cost measurement drift")
    _require(row.get("currency") == usage.get("currency"), "projector currency drift")


def _render(report, renderer):
    rendered = renderer(copy.deepcopy(report))
    _require(type(rendered) is bytes, "renderer must return exact UTF-8 JSON bytes")
    def pairs(items):
        result = {}
        for key, value in items:
            _require(key not in result, "duplicate rendered JSON key")
            result[key] = value
        return result
    parsed = json.loads(rendered.decode("utf-8", errors="strict"), object_pairs_hook=pairs,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite rendered JSON")))
    _require(_canonical(parsed) == _canonical(report), "renderer changed report content")
    return rendered


def run_saved(snapshot, binding, split, consumer, scorer, projector, metrics, renderer):
    """Return two checked saved-output replays, never infer or persist anything."""
    for callback in (scorer, projector, metrics, renderer):
        _require(callable(callback), "missing caller-verified pure callback")
    metadata = _validate(snapshot, binding, split, consumer)
    frozen_snapshot, frozen_binding = copy.deepcopy(snapshot), copy.deepcopy(binding)
    frozen_split, frozen_consumer = copy.deepcopy(split), copy.deepcopy(consumer)
    original = {row["id"]: row for row in frozen_snapshot}
    meta_by_id = {row["id"]: row for row in metadata}
    replays = []
    for _ in range(2):
        scored = copy.deepcopy(scorer(copy.deepcopy(frozen_snapshot), copy.deepcopy(frozen_binding), copy.deepcopy(frozen_split)))
        _same_rows(scored, original)
        live_without_gold = (frozen_binding["evidence_kind"] == "LIVE_MODEL_MEASUREMENT" and
                             frozen_binding["gold_ref"] is None)
        if live_without_gold:
            _require(all(row.get("true_label") is None and row.get("correct") is None for row in scored),
                     "missing live Gold cannot supply scored specification labels")
        score = [{"request": meta_by_id[row["id"]],
                  "score_fields": {k: v for k, v in row.items() if k not in SNAPSHOT_FIELDS}} for row in scored]
        score_sha = canonical_sha256(score)
        projected = copy.deepcopy(projector(copy.deepcopy(scored), copy.deepcopy(frozen_binding["policy"])))
        _same_rows(projected, original, projection=True)
        for row in projected:
            _measurements(row, original[row["id"]]["usage"])
        if live_without_gold:
            _require(all(row.get("true_label") is None and row.get("correct") is None for row in projected),
                     "missing live Gold cannot be replaced by specification labels")
        metric_rows = [{k: copy.deepcopy(v) for k, v in row.items() if k != "usage"} for row in projected]
        numeric = copy.deepcopy(metrics(copy.deepcopy(metric_rows), copy.deepcopy(frozen_binding["policy"])))
        _require(type(numeric) is dict, "metrics must return local JSON report")
        report = {"status": "CANDIDATE_SAVED_OUTPUT_REPLAY_ONLY", "authority_effect": "NONE",
            "qualification": "NOT_ISSUED", "evidence_kind": frozen_binding["evidence_kind"],
            "trust_boundary": "CALLER_VERIFIES_DOMAIN_AUTHORITY_SOURCE_BYTES_AND_CALLBACK_PURITY",
            "external_inputs_required": [k for k in ("gold_ref", "threshold_ref", "profile_ref")
                                          if frozen_binding[k] is None],
            "reference_status": {k: "EXTERNAL_INPUT_REQUIRED" if frozen_binding[k] is None else
                                 "REFERENCE_CARRIED_NOT_AUTHORITY_VERIFIED"
                                 for k in ("gold_ref", "threshold_ref", "profile_ref")},
            "source_binding": frozen_binding, "split": frozen_split, "consumer": frozen_consumer,
            "requests": metadata, "scores": score, "score_sha256": score_sha, "metrics": numeric}
        report_sha = canonical_sha256(report)
        rendered = _render(report, renderer)
        replays.append({"score_sha256": score_sha, "report_sha256": report_sha,
                        "rendered_sha256": hashlib.sha256(rendered).hexdigest(),
                        "rendered_bytes": rendered, "report": report})
    _require(all(replays[0][k] == replays[1][k] for k in
                 ("score_sha256", "report_sha256", "rendered_sha256", "rendered_bytes")), "non-deterministic saved replay")
    return {"status": "CANDIDATE_SAVED_OUTPUT_REPLAY_ONLY", "authority_effect": "NONE",
        "qualification": "NOT_ISSUED", "report": replays[0]["report"],
        "rendered_bytes": replays[0]["rendered_bytes"],
        "replay_digests": [{k: r[k] for k in ("score_sha256", "report_sha256", "rendered_sha256")}
                           for r in replays]}
