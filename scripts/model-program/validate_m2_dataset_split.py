#!/usr/bin/env python3
"""Verify local DatasetSplit candidate wiring; never adopt a domain definition."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from jsonschema import Draft202012Validator

from validate_m2_dataset_foundation import BASE, ROOT, FoundationError, digest, load, require
from validate_m2_split_mapping import PURPOSE_IDENTITIES, RULES, expected_candidate

DOMAIN_REFERENCE = BASE / "DatasetSplitDomainReference.candidate.json"
# Exact bytes of this engineering reference; not a signature or live authority proof.
DOMAIN_REFERENCE_SHA256 = "f6367aaa8dac9a7c32245bb9a249cf68fcd10c5d37e3f98bf0b1862587eb4c03"
SPLIT_SCHEMA_ID = "urn:clued:model-program:m2:candidate:DatasetSplit"


def verify_artifact(ref: dict, expected_path: str) -> Path:
    require(ref["path"] == expected_path, "DOMAIN_ARTIFACT_PATH")
    path = ROOT / expected_path
    raw = path.read_bytes()
    require(len(raw) == ref["size_bytes"] and hashlib.sha256(raw).hexdigest() == ref["sha256"],
            "DOMAIN_ARTIFACT_IDENTITY")
    return path


def validate_domain_candidate(reference_path=DOMAIN_REFERENCE):
    raw = reference_path.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == DOMAIN_REFERENCE_SHA256, "DOMAIN_REFERENCE_IDENTITY")
    reference = load(reference_path)
    definition_path = verify_artifact(reference["definition"],
        "development/contracts/model-program/m2/DatasetSplitDefinition.candidate.json")
    schema_path = verify_artifact(reference["instance_schema"],
        "development/contracts/model-program/m2/schemas/DatasetSplit.candidate.schema.json")
    definition = load(definition_path)
    schema = load(schema_path)
    Draft202012Validator.check_schema(schema)
    require(schema["$id"] == SPLIT_SCHEMA_ID, "DATASET_SPLIT_SCHEMA_ID")
    verify_artifact(definition["ownership_registry"],
        "development/contracts/model-program/m0/upstream/ObjectAuthorityRegistry_model_program_v1_20260918.json")
    verify_artifact(definition["direction_acceptance"]["corresponding_proposal"],
        "development/contracts/model-program/m2/DatasetSplitDomainDecision.candidate.md")
    require(digest(definition["plan_source"]) == digest(expected_candidate()["plan_source"]),
            "DOMAIN_PLAN_BINDING")
    require(digest(definition["instance_schema"]) == digest(reference["instance_schema"])
            and digest(definition["direction_acceptance"]) == digest(reference["direction_acceptance"]),
            "DOMAIN_REFERENCE_BINDING")
    expected = [
        {"purpose_id": PURPOSE_IDENTITIES[purpose][0], "description": purpose,
         "parent_boundary": PURPOSE_IDENTITIES[purpose][1], "allowed_use_keys": uses,
         "final_holdout": holdout, "selection_report_allowed": selection,
         "fixed_candidate_required": purpose in ("资格", "最终 Holdout")}
        for purpose, _boundary, uses, holdout, selection in RULES
    ]
    require(digest(definition["purposes"]) == digest(expected), "DOMAIN_PURPOSE_DEFINITION")
    # The direction receipt is a real Canonical mutation receipt, but its recorded
    # scope is not machine-definition adoption. This CLI has no adoption issuer.
    require(reference["domain_authority_receipt_ref"] is None
            and reference["domain_adoption_status"] == "NOT_ADOPTED"
            and reference["formal_mapping_status"] == "UNRESOLVED"
            and reference["authority_effect"] == "NONE", "DOMAIN_ADOPTION_NOT_AUTHORIZED")
    return reference, definition


def validate_split_binding(split: dict, reference: dict, definition: dict) -> None:
    expected_ref = {"definition_id": definition["definition_id"], "version": definition["version"],
                    "sha256": reference["definition"]["sha256"]}
    require(digest(split["candidate_definition_ref"]) == digest(expected_ref), "SPLIT_DEFINITION_BINDING")
    rows = {row["description"]: row for row in definition["purposes"]}
    row = rows[split["purpose_description"]]
    require(split["purpose_id"] == row["purpose_id"]
            and split["parent_boundary"] == row["parent_boundary"], "SPLIT_PARENT_PURPOSE")
    binding = split["fixed_candidate_binding"]
    require((binding is not None) == row["fixed_candidate_required"], "FIXED_CANDIDATE_BINDING")
    if row["fixed_candidate_required"]:
        consumer = ("synthetic_final_verifier" if split["final_holdout"]
                    else "synthetic_qualification_verifier")
        require(split["allowed_consumers"] == [consumer], "FIXED_CANDIDATE_CONSUMER")
        require(not split["exposure_records"], "FIXED_CANDIDATE_EXPOSED")
    if row["purpose_id"] == "calibration_fit":
        require(not any(event["used_for_selection"] for event in split["exposure_records"]),
                "CALIBRATION_SELECTION_EXPOSED")


def validate_sample_binding(sample: dict, split: dict) -> None:
    if split["purpose_id"] == "calibration_fit":
        require(not any(event["used_for_selection"] for event in sample["exposure_records"]),
                "CALIBRATION_SELECTION_EXPOSED")
    if split["purpose_id"] == "qualification":
        require(not sample["exposure_records"]
                and sample["origin_kind"] == "NOVEL_SYNTHETIC_TEST_CASE", "QUALIFICATION_RELABELED")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--domain-reference", type=Path, default=DOMAIN_REFERENCE)
    parser.add_argument("--require-adoption", action="store_true",
                        help="Fail closed: the current candidate has no machine-definition adoption receipt.")
    args = parser.parse_args(argv)
    try:
        reference, definition = validate_domain_candidate(args.domain_reference)
        require(not args.require_adoption, "DOMAIN_ADOPTION_REQUIRED")
        result = {"status": "PASS_DATASET_SPLIT_CANDIDATE_ONLY", "definition_id": definition["definition_id"],
                  "definition_version": definition["version"], "definition_sha256": reference["definition"]["sha256"],
                  "direction_acceptance": "RECORDED_CANONICAL_REFERENCE",
                  "canonical_reference_live_check": "NOT_RUN_OFFLINE",
                  "domain_adoption": "NOT_ADOPTED", "dataset_split_authority_mapping": "UNRESOLVED",
                  "m2_verdict": "NOT_ISSUED", "training_or_data_use_authorized": False}
    except (FoundationError, OSError, ValueError, KeyError, TypeError) as exc:
        code = exc.code if isinstance(exc, FoundationError) else "CLUED_MODEL_M2_INVALID_INPUT"
        print(json.dumps({"status": "FAIL_DATASET_SPLIT_CANDIDATE", "error": code}, sort_keys=True))
        return 1
    print(json.dumps(result, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
