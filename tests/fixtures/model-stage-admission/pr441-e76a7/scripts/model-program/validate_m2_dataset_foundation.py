#!/usr/bin/env python3
"""Offline M2 candidate metadata checks; never an admission or dataset loader.

Only self-contained synthetic fixtures are accepted by this first slice. References
and declared exposure history are checked, not independently attested. There is no
network, model, storage adapter, data collection, or training execution path.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "development/contracts/model-program/m2"
FIXTURE = ROOT / "tests/fixtures/model-program-m2/synthetic-foundation.json"
PLAN_SHA256 = "a918f42e6e9de160f7b14a95afafeae9022ddcc189b3663e768aa197110118a4"


class FoundationError(ValueError):
    """A stable local validation code without echoing rejected sample contents."""

    def __init__(self, code: str):
        self.code = "CLUED_MODEL_M2_" + code
        super().__init__(self.code)


def require(condition: bool, code: str) -> None:
    if not condition:
        raise FoundationError(code)


def load(path: Path):
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "DUPLICATE_JSON_KEY")
            result[key] = value
        return result

    def reject_constant(_value):
        raise FoundationError("NON_FINITE_JSON")

    return json.loads(path.read_text(encoding="utf-8"),
                      object_pairs_hook=unique_pairs, parse_constant=reject_constant)


def digest(value) -> str:
    """Local fixture JSON digest, deliberately not a Canonical/JCS identity."""
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True,
                     separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def validate_schema(name: str, value) -> None:
    schema = load(BASE / "schemas" / name)
    Draft202012Validator.check_schema(schema)
    split_schema = load(BASE / "schemas" / "DatasetSplit.candidate.schema.json")
    # Resolve only the installed local split contract. No network schema resolver.
    registry = Registry().with_resource(split_schema["$id"], Resource.from_contents(split_schema))
    require(not list(Draft202012Validator(schema, registry=registry).iter_errors(value)), "SCHEMA")


def unique_index(rows, key, code):
    result = {}
    for row in rows:
        require(row[key] not in result, code)
        result[row[key]] = row
    return result


def validate_source_registry(registry: dict) -> dict:
    validate_schema("DataSourceLicenseRegistry.schema.json", registry)
    sources = unique_index(registry["sources"], "source_id", "DUPLICATE_SOURCE")
    for source in sources.values():
        # This is a candidate fixture allowance, never a legal/data-use approval.
        require(source["source_class"] == "C" and
                source["origin"] == "SELF_CONTAINED_SYNTHETIC_FIXTURE", "REAL_DATA_BLOCKED")
        require(source["license_review"] == "SYNTHETIC_TEST_ONLY" and
                source["license_ref"] == "tests/fixtures/model-program-m2/synthetic-foundation.json",
                "LICENSE_UNRESOLVED")
        require(not source["withdrawn"] and not source["contains_secrets"] and
                not source["contains_personal_data"], "PRIVACY_OR_WITHDRAWAL")
        require(source["raw_snapshot_sha256"] == digest(source["synthetic_inputs"]),
                "SOURCE_DIGEST")
    return sources


def validate_manifest(manifest: dict, sources: dict) -> dict:
    # Local policy proposals are checked separately from formal domain mapping.
    # Import here to avoid a module cycle in the source-binding CLI.
    from validate_m2_split_mapping import CANDIDATE, validate_candidate
    profiles = validate_candidate(load(CANDIDATE))
    from validate_m2_dataset_split import (DOMAIN_REFERENCE_SHA256, validate_domain_candidate,
                                          validate_sample_binding, validate_split_binding)
    domain_reference, definition = validate_domain_candidate()
    validate_schema("DatasetManifest.schema.json", manifest)
    require(manifest["candidate_domain_reference_sha256"] == DOMAIN_REFERENCE_SHA256,
            "MANIFEST_DOMAIN_BINDING")
    splits = unique_index(manifest["splits"], "split_id", "DUPLICATE_SPLIT")
    samples = unique_index(manifest["samples"], "sample_id", "DUPLICATE_SAMPLE")
    require(manifest["manifest_revision_sha256"] == digest({
        key: value for key, value in manifest.items() if key != "manifest_revision_sha256"
    }), "MANIFEST_DIGEST")
    require(manifest["registry_sha256"] == digest(list(sources.values())), "REGISTRY_BINDING")

    for split in splits.values():
        uses = split["allowed_uses"]
        if uses["weight_learning"]:
            require(not any(value for key, value in uses.items() if key != "weight_learning"),
                    "TRAINING_USE_OVERLAP")
        if split["final_holdout"]:
            require(not any(uses.values()), "HOLDOUT_USE")
            require(not split["exposure_records"], "HOLDOUT_EXPOSED")
            require(split["allowed_consumers"] == ["synthetic_final_verifier"],
                    "HOLDOUT_CONSUMER")
        if uses["calibration_fit"]:
            require(not any(value for key, value in uses.items() if key != "calibration_fit"),
                    "CALIBRATION_SELECTION_OVERLAP")
        require(split["purpose_description"] in profiles, "UNKNOWN_LOGICAL_PURPOSE")
        profile = profiles[split["purpose_description"]]
        require({key for key, value in uses.items() if value} == set(profile["allowed_use_keys"])
                and split["final_holdout"] == profile["final_holdout"], "PURPOSE_USE_MISMATCH")
        require(set(split["sample_ids"]) == {
            sample["sample_id"] for sample in samples.values()
            if sample["split_id"] == split["split_id"]
        }, "SPLIT_MEMBERSHIP")
        validate_split_binding(split, domain_reference, definition)

    # The same source can supply different groups, but sessions/projects and
    # semantic-near-duplicate groups must not straddle isolated splits.
    group_partitions = {}
    content_ids = set()
    for sample in samples.values():
        require(sample["source_id"] in sources, "UNKNOWN_SOURCE")
        require(sample["split_id"] in splits, "UNKNOWN_SPLIT")
        source = sources[sample["source_id"]]
        require(sample["source_revision"] == source["source_revision"] and
                sample["raw_snapshot_sha256"] == source["raw_snapshot_sha256"],
                "SOURCE_REVISION")
        require(sample["input_key"] in source["synthetic_inputs"], "SOURCE_INPUT")
        raw = source["synthetic_inputs"][sample["input_key"]]
        require(sample["content_sha256"] == digest(raw), "SAMPLE_DIGEST")
        require(sample["content_sha256"] not in content_ids, "EXACT_DUPLICATE")
        content_ids.add(sample["content_sha256"])
        for group_kind, group_id in sample["isolation_groups"].items():
            key = (group_kind, group_id)
            require(key not in group_partitions or group_partitions[key] == sample["split_id"],
                    "CROSS_SPLIT_GROUP")
            group_partitions[key] = sample["split_id"]
        split = splits[sample["split_id"]]
        validate_sample_binding(sample, split)
        if split["final_holdout"]:
            require(not sample["exposure_records"] and
                    sample["origin_kind"] == "NOVEL_SYNTHETIC_TEST_CASE", "HOLDOUT_RELABELED")
        for parent_id in sample["parent_sample_ids"]:
            require(parent_id in samples and parent_id != sample["sample_id"], "LINEAGE_PARENT")
            require(samples[parent_id]["split_id"] == sample["split_id"], "LINEAGE_CROSS_SPLIT")

    visited, active = set(), set()

    for sample_id in samples:
        stack = [(sample_id, False)]
        while stack:
            current, exiting = stack.pop()
            if exiting:
                active.remove(current)
                visited.add(current)
                continue
            require(current not in active, "LINEAGE_CYCLE")
            if current in visited:
                continue
            active.add(current)
            stack.append((current, True))
            stack.extend((parent, False) for parent in samples[current]["parent_sample_ids"])
    return splits


def validate_selection_report(report: dict, manifest: dict, splits: dict) -> None:
    validate_schema("SelectionInput.schema.json", report)
    require(report["manifest_revision_sha256"] == manifest["manifest_revision_sha256"],
            "REPORT_REVISION")
    require(report["split_id"] in splits, "UNKNOWN_SPLIT")
    split = splits[report["split_id"]]
    require(not split["final_holdout"] and split["allowed_uses"]["selection"],
            "HOLDOUT_OR_NON_SELECTION_REPORT")
    require(report["experiment_scope"] == split["experiment_scope"] and
            report["purpose_description"] == split["purpose_description"], "REPORT_SCOPE")
    require(report["consumer_id"] in split["allowed_consumers"], "REPORT_CONSUMER")


def validate_bundle(bundle: dict) -> dict:
    require(isinstance(bundle, dict) and set(bundle) == {"registry", "manifest", "selection_reports"},
            "BUNDLE_SHAPE")
    require(isinstance(bundle["selection_reports"], list), "BUNDLE_SHAPE")
    sources = validate_source_registry(bundle["registry"])
    splits = validate_manifest(bundle["manifest"], sources)
    for report in bundle["selection_reports"]:
        validate_selection_report(report, bundle["manifest"], splits)
    return {
        "status": "PASS_SYNTHETIC_OFFLINE_CHECKS_ONLY",
        "bundle_sha256": digest(bundle),
        "source_count": len(sources),
        "sample_count": len(bundle["manifest"]["samples"]),
        "split_count": len(splits),
        "dataset_split_authority_mapping": "UNRESOLVED",
        "dataset_split_candidate_wiring": "BOUND_LOCAL_CANDIDATE_ONLY",
        "direction_acceptance": "RECORDED_CANONICAL_REFERENCE",
        "domain_adoption": "NOT_ADOPTED",
        "m2_verdict": "NOT_ISSUED",
        "training_or_data_use_authorized": False,
        "real_holdout_secrecy_or_contamination_clearance": False,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=FIXTURE)
    args = parser.parse_args(argv)
    try:
        # Check the already-owned plan binding; never infer formal stage authority.
        charter = load(ROOT / "development/contracts/model-program/m0/ModelProgramCharter.json")
        require(charter["target_plan"]["sha256"] == PLAN_SHA256, "PLAN_BINDING")
        result = validate_bundle(load(args.fixture))
    except (FoundationError, OSError, ValueError, KeyError, TypeError, RecursionError) as exc:
        code = exc.code if isinstance(exc, FoundationError) else "CLUED_MODEL_M2_INVALID_INPUT"
        print(json.dumps({"status": "FAIL_SYNTHETIC_OFFLINE_CHECKS", "error": code}, sort_keys=True))
        return 1
    print(json.dumps(result, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
