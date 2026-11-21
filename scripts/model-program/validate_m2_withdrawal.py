#!/usr/bin/env python3
"""Synthetic-only source withdrawal propagation; no live erasure or authority."""
from __future__ import annotations

import argparse
from collections import deque
import json
from pathlib import Path

from jsonschema import Draft202012Validator
from validate_m2_dataset_foundation import (
    ROOT, FIXTURE, FoundationError, digest, load, require, validate_bundle,
)

EVENTS = ROOT / "tests/fixtures/model-program-m2/withdrawal-events.json"
IDENTIFIER = {"type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$"}
HASH = {"type": "string", "pattern": "^[a-f0-9]{64}$"}
EVENT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["schema_version", "authority_effect", "baseline_sha256", "events"],
    "properties": {
        "schema_version": {"const": "clued.model-m2-withdrawal-candidate/1"},
        "authority_effect": {"const": "NONE"},
        "baseline_sha256": HASH,
        "events": {"type": "array", "maxItems": 10000, "items": {
            "type": "object", "additionalProperties": False,
            "required": ["event_id", "source_id", "source_revision",
                         "raw_snapshot_sha256", "reason"],
            "properties": {
                "event_id": IDENTIFIER, "source_id": IDENTIFIER,
                "source_revision": IDENTIFIER, "raw_snapshot_sha256": HASH,
                "reason": {"enum": ["WITHDRAWN", "DELETED", "LICENSE_INVALIDATED"]},
            },
        }},
    },
}


def propagate(bundle: dict, event_set: dict) -> dict:
    """Replay a complete declared event set against a pre-withdrawal baseline.

    The baseline must independently pass the existing synthetic source/DAG gates.
    An event set is caller-supplied fixture evidence, never an authenticated log.
    Inputs and historical identities are retained; no subset is silently reissued.
    """
    validate_bundle(bundle)
    require(not list(Draft202012Validator(EVENT_SCHEMA).iter_errors(event_set)),
            "WITHDRAWAL_SCHEMA")
    require(event_set["baseline_sha256"] == digest(bundle), "WITHDRAWAL_BASELINE")
    sources = {row["source_id"]: row for row in bundle["registry"]["sources"]}
    events = {}
    for event in event_set["events"]:
        event_id = event["event_id"]
        require(event_id not in events or events[event_id] == event,
                "WITHDRAWAL_EVENT_CONFLICT")
        require(event["source_id"] in sources, "WITHDRAWAL_SOURCE")
        source = sources[event["source_id"]]
        require(event["source_revision"] == source["source_revision"] and
                event["raw_snapshot_sha256"] == source["raw_snapshot_sha256"],
                "WITHDRAWAL_SOURCE_REVISION")
        events[event_id] = event
    canonical_events = [events[key] for key in sorted(events)]
    withdrawn_sources = {event["source_id"] for event in canonical_events}
    manifest = bundle["manifest"]
    samples = {row["sample_id"]: row for row in manifest["samples"]}
    children = {key: [] for key in samples}
    for sample in samples.values():
        for parent in sample["parent_sample_ids"]:
            children[parent].append(sample["sample_id"])
    direct = {key for key, row in samples.items() if row["source_id"] in withdrawn_sources}
    invalid = set(direct)
    pending = deque(sorted(direct))
    while pending:
        for child in children[pending.popleft()]:
            if child not in invalid:
                invalid.add(child)
                pending.append(child)
    report = {
        "schema_version": "clued.model-m2-withdrawal-impact-candidate/1",
        "status": "PASS_SYNTHETIC_PROPAGATION_ONLY",
        "authority_effect": "NONE",
        "baseline_sha256": digest(bundle),
        "event_set_sha256": digest(canonical_events),
        "event_ids": sorted(events),
        "dataset_id": manifest["dataset_id"],
        "dataset_revision": manifest["dataset_revision"],
        "manifest_revision_sha256": manifest["manifest_revision_sha256"],
        "dataset_status": "UNAVAILABLE_WITHDRAWAL" if invalid else "UNCHANGED_CANDIDATE",
        "dataset_rebuild_required": bool(invalid),
        "withdrawn_source_ids": sorted(withdrawn_sources),
        "affected_raw_snapshots": [
            {key: sources[source_id][key] for key in
             ("source_id", "source_revision", "raw_snapshot_sha256")}
            for source_id in sorted(withdrawn_sources)
        ],
        "direct_invalid_sample_ids": sorted(direct),
        "derived_invalid_sample_ids": sorted(invalid - direct),
        "invalid_sample_ids": sorted(invalid),
        "retained_sample_ids": sorted(set(samples) - invalid),
        "affected_split_ids": sorted({samples[key]["split_id"] for key in invalid}),
        "m2_verdict": "NOT_ISSUED",
        "training_or_data_use_authorized": False,
        "physical_erasure_performed": False,
        "model_lineage_status": "NOT_EVALUATED_NO_TRAINING_IN_THIS_CANDIDATE",
    }
    report["report_sha256"] = digest(report)
    return report


def validate_impact(bundle: dict, event_set: dict, report: dict,
                    *, require_available: bool = False) -> dict:
    expected = propagate(bundle, event_set)
    require(report == expected, "WITHDRAWAL_IMPACT_EVIDENCE")
    if require_available:
        require(not expected["dataset_rebuild_required"], "DATASET_UNAVAILABLE_WITHDRAWAL")
    return expected


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=FIXTURE)
    parser.add_argument("--events", type=Path, default=EVENTS)
    parser.add_argument("--impact", type=Path)
    parser.add_argument("--require-available", action="store_true")
    args = parser.parse_args(argv)
    try:
        bundle, events = load(args.fixture), load(args.events)
        result = propagate(bundle, events)
        if args.impact:
            result = validate_impact(bundle, events, load(args.impact))
        if args.require_available:
            validate_impact(bundle, events, result, require_available=True)
    except (FoundationError, OSError, ValueError, KeyError, TypeError, RecursionError) as exc:
        code = exc.code if isinstance(exc, FoundationError) else "CLUED_MODEL_M2_INVALID_INPUT"
        print(json.dumps({"status": "FAIL_SYNTHETIC_PROPAGATION", "error": code}, sort_keys=True))
        return 1
    print(json.dumps(result, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
