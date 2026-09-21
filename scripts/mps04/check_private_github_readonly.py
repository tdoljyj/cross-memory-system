#!/usr/bin/env python3
"""Owner-origin CI check of the private GitHub read-only D-007 source leg.

This is not a Native/Canonical D-007 or G4/G6 acceptance check.
"""
import json
import os
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "development" / "mps"))
from mps04.github_readonly import GitHubReadOnlyProvider


def main():
    adopted = os.environ.get("MPS04_CI_ADOPTED_SHA", "")
    expected_head = os.environ.get("MPS04_CI_HEAD_SHA", "")
    ref = os.environ.get("MPS04_GITHUB_REF", "")
    token = os.environ.get("MPS04_GITHUB_TOKEN", "")
    if (not re.fullmatch(r"[0-9a-f]{40}", adopted)
            or not re.fullmatch(r"[0-9a-f]{40}", expected_head)
            or not ref or not token):
        raise SystemExit("exact PR identity or ephemeral read-only token is missing")
    observed = GitHubReadOnlyProvider(
        "tdoljyj/cross-memory-system", ref, token
    ).observe(adopted)
    if (observed["provider_exact_commit"] != expected_head
            or observed["ancestry"] != "ahead"
            or not observed["drift"]
            or observed["clued_current_changed"]
            or observed["persistence"] != "NOT_REGISTERED_CANDIDATE_ONLY"):
        raise SystemExit("GitHub source identity or read-only boundary changed")
    print(json.dumps({
        "qualification": "PRIVATE_GITHUB_SOURCE_LEG_ONLY_NOT_LIVE_NATIVE_D007",
        "repository": observed["repository"],
        "ref": observed["ref"],
        "adopted_exact_commit": adopted,
        "provider_exact_commit": expected_head,
        "ancestry": observed["ancestry"],
        "observation_digest": observed["observation_digest"],
        "clued_current_changed": False,
    }, sort_keys=True))


if __name__ == "__main__":
    main()
