#!/usr/bin/env python3
"""Read-only candidate mapping checks; no DatasetSplit authority is issued."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from validate_m2_dataset_foundation import FoundationError, PLAN_SHA256, ROOT, digest, load, require

CANDIDATE = ROOT / "development/contracts/model-program/m2/DatasetSplitMapping.candidate.json"
PLAN_SIZE = 356825
# Restrictive local synthetic guard profiles, not a published DatasetSplit enum.
# Development selection is conservatively considered exposed to selection.
RULES = (
    ("训练", "existing_training", ["weight_learning"], False, False),
    ("开发", "existing_development", ["prompt_or_architecture_tuning", "selection"], False, True),
    ("校准拟合", "existing_development_isolated_fit_partition", ["calibration_fit"], False, False),
    ("选型/策略验证", "existing_development_isolated_selection_partition", ["selection"], False, True),
    ("资格", "existing_qualification_fixed_candidate", [], False, False),
    ("最终 Holdout", "existing_final_holdout_fixed_candidate", [], True, False),
)
SOURCE_RANGES = [
    {"start_line": 2648, "end_line": 2670,
     "sha256": "1bb8b3885728fe974e9654e5f84a5319e837c94c7052dde2b197c50c47c667de"},
    {"start_line": 2709, "end_line": 2728,
     "sha256": "f69a0d689ee33cefdebe6c9c3792f968943e36f5af6488747c293f9c7480c14e"},
]
PURPOSE_IDENTITIES = dict(zip((row[0] for row in RULES), (
    ("training", "TRAINING"), ("development", "DEVELOPMENT"),
    ("calibration_fit", "DEVELOPMENT"), ("selection_policy_validation", "DEVELOPMENT"),
    ("qualification", "QUALIFICATION"), ("final_holdout", "FINAL_HOLDOUT"),
)))


def expected_candidate():
    return {
        "schema_version": "clued.model-m2-split-mapping-candidate/1",
        "status": "CANDIDATE_DIRECTION_ACCEPTED_NOT_ADOPTED",
        "authority_effect": "NONE",
        "domain_mapping_status": "UNRESOLVED",
        "official_definition_status": "NOT_LOCATED_OR_VERIFIED",
        "plan_source": {"version": "v1.0.1", "sha256": PLAN_SHA256,
                        "size_bytes": PLAN_SIZE, "ranges": SOURCE_RANGES},
        "mappings": [
            {"purpose_description": purpose, "proposed_boundary": boundary,
             "dataset_split_ref": None, "allowed_use_keys": uses,
             "final_holdout": holdout, "selection_report_allowed": selection,
             "candidate_purpose_id": PURPOSE_IDENTITIES[purpose][0],
             "candidate_parent_boundary": PURPOSE_IDENTITIES[purpose][1]}
            for purpose, boundary, uses, holdout, selection in RULES
        ],
    }


def validate_candidate(candidate):
    # Closed candidate identity prevents a changed profile, missing row, duplicate
    # purpose, accepted mapping or caller-supplied authority from passing silently.
    # JSON identity distinguishes bool/int and integer/float, unlike dict ==.
    require(digest(candidate) == digest(expected_candidate()), "SPLIT_MAPPING_CANDIDATE")
    return {row["purpose_description"]: row for row in candidate["mappings"]}


def verify_plan(path: Path, candidate):
    validate_candidate(candidate)
    raw = path.read_bytes()
    require(len(raw) == PLAN_SIZE and hashlib.sha256(raw).hexdigest() == PLAN_SHA256,
            "PLAN_SOURCE_IDENTITY")
    lines = raw.splitlines(keepends=True)
    for source in SOURCE_RANGES:
        selected = b"".join(lines[source["start_line"] - 1:source["end_line"]])
        require(hashlib.sha256(selected).hexdigest() == source["sha256"], "PLAN_SOURCE_RANGE")
    return "PASS_SOURCE_BINDING_ONLY"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, default=CANDIDATE)
    parser.add_argument("--plan", type=Path)
    args = parser.parse_args(argv)
    try:
        charter = load(ROOT / "development/contracts/model-program/m0/ModelProgramCharter.json")
        require(charter["target_plan"] == {"version": "v1.0.1", "sha256": PLAN_SHA256},
                "PLAN_BINDING")
        candidate = load(args.candidate)
        validate_candidate(candidate)
        from validate_m2_dataset_split import validate_domain_candidate
        validate_domain_candidate()
        source_check = verify_plan(args.plan, candidate) if args.plan else "NOT_RUN_ORIGINAL_REQUIRED"
        result = {"status": "PASS_CANDIDATE_CHECKS_ONLY", "plan_source_check": source_check,
                  "direction_acceptance": "RECORDED_CANONICAL_REFERENCE",
                  "domain_adoption": "NOT_ADOPTED",
                  "dataset_split_authority_mapping": "UNRESOLVED", "m2_verdict": "NOT_ISSUED",
                  "training_or_data_use_authorized": False}
    except (FoundationError, OSError, ValueError, KeyError, TypeError) as exc:
        code = exc.code if isinstance(exc, FoundationError) else "CLUED_MODEL_M2_INVALID_INPUT"
        print(json.dumps({"status": "FAIL_CANDIDATE_CHECKS", "error": code}, sort_keys=True))
        return 1
    print(json.dumps(result, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
