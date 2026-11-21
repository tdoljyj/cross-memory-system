#!/usr/bin/env python3
"""Offline owner-adopted definition wiring; no domain receipt or data admission."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from validate_m2_dataset_foundation import BASE, ROOT, FoundationError, digest, load, require, validate_bundle
from validate_m2_dataset_split import validate_domain_candidate, verify_artifact

REFERENCE = BASE / "DatasetSplitOwnerAdoption.v0.1.json"
REFERENCE_SHA256 = "d60a2b463e9a6a53a9d3a82032acd3b31c2fd5f78df96ee7043ef1af489baa45"
FIXTURE = ROOT / "tests/fixtures/model-program-m2/owner-adopted-foundation.json"
MAPPING = "OWNER_ADOPTED_BASELINE_BOUND_DOMAIN_RECEIPT_PENDING"
SPLIT_ID = "urn:clued:model-program:m2:DatasetSplit:v0.1"


def validate_baseline(reference_path=REFERENCE):
    raw = reference_path.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == REFERENCE_SHA256, "OWNER_ADOPTION_REFERENCE_IDENTITY")
    ref = load(reference_path)
    _historical_ref, candidate = validate_domain_candidate()
    definition_path = verify_artifact(ref["definition"],
        "development/contracts/model-program/m2/DatasetSplitDefinition.v0.1.json")
    schema_path = verify_artifact(ref["instance_schema"],
        "development/contracts/model-program/m2/schemas/DatasetSplit.v0.1.schema.json")
    manifest_path = verify_artifact(ref["manifest_schema"],
        "development/contracts/model-program/m2/schemas/DatasetManifest.owner-adopted.schema.json")
    source_path = verify_artifact(ref["accepted_sources"]["definition"],
        "development/contracts/model-program/m2/DatasetSplitDefinition.candidate.json")
    source_schema_path = verify_artifact(ref["accepted_sources"]["instance_schema"],
        "development/contracts/model-program/m2/schemas/DatasetSplit.candidate.schema.json")
    require(digest(load(source_path)) == digest(candidate), "ADOPTED_SOURCE_BINDING")
    definition, schema, manifest = load(definition_path), load(schema_path), load(manifest_path)
    expected = copy.deepcopy(candidate)
    expected.update(schema_version="clued.model-dataset-split-definition/1", version="v0.1",
        status="OWNER_ADOPTED_NON_PRODUCTION_BASELINE", authority_effect="OWNER_DEFINITION_ADOPTION_ONLY",
        enum_effect="OWNER_ADOPTED_MODEL_DOMAIN_BASELINE_ONLY")
    expected.update(adopted_from=ref["accepted_sources"], owner_adoption=ref["owner_adoption"],
                    instance_schema=ref["instance_schema"])
    require(digest(definition) == digest(expected), "ADOPTED_DEFINITION_DERIVATION")
    expected_schema = load(source_schema_path)
    expected_schema["$id"] = SPLIT_ID
    expected_schema["properties"]["schema_version"]["const"] = "clued.model-dataset-split/1"
    expected_schema["properties"]["domain_mapping_status"]["const"] = MAPPING
    expected_schema["properties"]["dataset_split_ref"] = {
        "type": "object", "additionalProperties": False,
        "required": ["definition_id", "version", "sha256"], "properties": {
            "definition_id": {"const": definition["definition_id"]}, "version": {"const": "v0.1"},
            "sha256": {"type": "string", "pattern": "^[0-9a-f]{64}$"}}}
    require(digest(schema) == digest(expected_schema), "ADOPTED_SCHEMA_DERIVATION")
    expected_manifest = load(BASE / "schemas/DatasetManifest.schema.json")
    expected_manifest["$id"] = "urn:clued:model-program:m2:owner-adopted:DatasetManifest"
    expected_manifest["properties"]["schema_version"]["const"] = "clued.model-m2-owner-adopted-manifest/1"
    expected_manifest["properties"]["dataset_split_authority_mapping"]["const"] = MAPPING
    expected_manifest["properties"]["splits"]["items"]["$ref"] = SPLIT_ID
    expected_manifest["required"].append("owner_adoption_reference_sha256")
    expected_manifest["properties"]["owner_adoption_reference_sha256"] = {
        "type": "string", "pattern": "^[0-9a-f]{64}$"}
    require(digest(manifest) == digest(expected_manifest), "ADOPTED_MANIFEST_SCHEMA_DERIVATION")
    Draft202012Validator.check_schema(schema)
    Draft202012Validator.check_schema(manifest)
    require(ref["domain_authority_receipt_ref"] is None and ref["m2_verdict"] == "NOT_ISSUED"
            and not ref["training_or_data_use_authorized"], "DOMAIN_AUTHORITY_NOT_ISSUED")
    return ref, definition, schema, manifest


def validate_adopted_bundle(bundle):
    ref, definition, schema, manifest_schema = validate_baseline()
    require(isinstance(bundle, dict) and set(bundle) == {"registry", "manifest", "selection_reports"}
            and isinstance(bundle["selection_reports"], list), "BUNDLE_SHAPE")
    manifest = bundle["manifest"]
    registry = Registry().with_resource(SPLIT_ID, Resource.from_contents(schema))
    require(not list(Draft202012Validator(manifest_schema, registry=registry).iter_errors(manifest)), "SCHEMA")
    require(manifest["owner_adoption_reference_sha256"] == REFERENCE_SHA256, "MANIFEST_OWNER_ADOPTION_BINDING")
    require(manifest["manifest_revision_sha256"] == digest({
        k:v for k,v in manifest.items() if k != "manifest_revision_sha256"}), "MANIFEST_DIGEST")
    expected = {"definition_id": definition["definition_id"], "version": "v0.1",
                "sha256": ref["definition"]["sha256"]}
    for split in manifest["splits"]:
        require(digest(split["dataset_split_ref"]) == digest(expected), "FORMAL_SPLIT_BINDING")
    for report in bundle["selection_reports"]:
        require(isinstance(report, dict) and report.get("manifest_revision_sha256") ==
                manifest["manifest_revision_sha256"], "REPORT_REVISION")
    # Reuse every existing source/license, membership, lineage, use/exposure and
    # selection guard. Only the verified version/reference envelope is projected.
    # The input remains synthetic and unchanged; no data is loaded or authorized.
    legacy = copy.deepcopy(bundle)
    old_manifest = legacy["manifest"]
    old_manifest.pop("owner_adoption_reference_sha256")
    old_manifest["schema_version"] = "clued.model-m2-manifest-candidate/1"
    old_manifest["dataset_split_authority_mapping"] = "UNRESOLVED"
    for split in old_manifest["splits"]:
        split["schema_version"] = "clued.model-dataset-split-candidate/1"
        split["domain_mapping_status"] = "UNRESOLVED"
        split["dataset_split_ref"] = None
    old_manifest["manifest_revision_sha256"] = digest({
        k:v for k,v in old_manifest.items() if k != "manifest_revision_sha256"})
    for report in legacy["selection_reports"]:
        report["manifest_revision_sha256"] = old_manifest["manifest_revision_sha256"]
    result = validate_bundle(legacy)
    result.update(status="PASS_OWNER_ADOPTED_BASELINE_WIRING_SYNTHETIC_ONLY",
        bundle_sha256=digest(bundle), definition_id=definition["definition_id"], definition_version="v0.1",
        definition_sha256=ref["definition"]["sha256"], owner_adoption="RECORDED_CANONICAL_RECEIPT",
        domain_adoption="OWNER_BASELINE_ADOPTED_DOMAIN_RECEIPT_PENDING",
        dataset_split_authority_mapping=MAPPING, dataset_split_candidate_wiring="OWNER_ADOPTED_BASELINE_BOUND",
        domain_authority_receipt="NOT_ISSUED", canonical_reference_live_check="NOT_RUN_OFFLINE")
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=FIXTURE)
    parser.add_argument("--require-domain-authority", action="store_true")
    parser.add_argument("--require-live-currentness", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = validate_adopted_bundle(load(args.fixture))
        require(not args.require_domain_authority, "DOMAIN_AUTHORITY_RECEIPT_REQUIRED")
        require(not args.require_live_currentness, "LIVE_CANONICAL_READ_REQUIRED")
    except (FoundationError, OSError, ValueError, KeyError, TypeError, RecursionError) as exc:
        code = exc.code if isinstance(exc, FoundationError) else "CLUED_MODEL_M2_INVALID_INPUT"
        print(json.dumps({"status": "FAIL_OWNER_ADOPTED_BASELINE_WIRING", "error": code}, sort_keys=True))
        return 1
    print(json.dumps(result, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
