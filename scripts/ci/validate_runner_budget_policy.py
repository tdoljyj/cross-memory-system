#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# P10 supersession probe: a newer PR commit must cancel stale validation runs.

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_DIR = ROOT / ".github" / "workflows"

HOSTED_ONLY_ALLOWLIST = {
    "clued-currentness-post-deploy-attestation.yml": (
        "Owner-triggered post-deploy verification uses a clean Ubuntu worker with the ICU runtime and an isolated production database secret."
    ),
    "clued-cloud-production-release.yml": (
        "Owner-dispatched production release uses a clean Ubuntu worker with ICU and isolated database and Cloudflare deployment credentials; it does not run on pull requests."
    ),
    "clued-storage-executor-window.yml": (
        "Owner-dispatched Storage executor gate (on until closed, a five-minute window, or close) uses a clean Ubuntu worker with the isolated Cloudflare deployment credential; it does not run on pull requests or check out code."
    ),
    "clued-storage-read-config.yml": (
        "Owner-dispatched Storage read key provisioning and read-flag switch uses a clean Ubuntu worker with the isolated Cloudflare deployment credential; it does not run on pull requests or check out code."
    ),
    "clued-information-flow-prod-e2e.yml": (
        "Owner-dispatched production E2E reaches the public Worker with a dedicated test account; it holds no database or deployment credential and does not run on pull requests."
    ),
    "clued-ci-health.yml": (
        "The lightweight monitor must remain independent of the self-hosted pool so it can detect complete Windows/Linux capability-pool loss."
    ),
    "clued-work-admission.yml": (
        "Work Claim Admission L0a: an unfiltered required check that makes one Clued call per pull request and must not wait on self-hosted capacity; it runs base-branch code only (pull_request_target), installs nothing and executes no PR code."
    ),
    "clued-work-admission-dispatch.yml": (
        "Work Claim Admission hand-dispatch check: verifies a claim before a heavy workflow is dispatched; default-branch code only, one Clued call, no install, no pull request trigger."
    ),
    "clued-work-admission-reverify.yml": (
        "Work Claim Admission hourly re-verification: re-runs a passing admission check whose claim expired or moved; default-branch code only, no install, no pull request trigger."
    ),
    "clued-release-tags.yml": (
        "Release tagging (Task 6dfd7560): creates the VERSION and release/<date>-r<run> tags after a VERSION change on main or a successful production deploy; default-branch code only, no install, no pull request trigger."
    ),
    "phase2-naming-surface-inventory.yml": (
        "Frozen historical exact-byte inventory workflow; modifying its execution contract would invalidate bound evidence."
    ),
    "phase2-v027-validation.yml": (
        "Frozen historical exact-source validation lane with self-referential accepted-source bindings."
    ),
}

CONCURRENCY_EXEMPTIONS = {
    "model-program-m0.yml": (
        "M0 SHA256SUMS binds this workflow as an exact candidate input; changing its bytes invalidates the formal M0 manifest."
    ),
}

HOSTED_RE = re.compile(r"\b(?:ubuntu|windows|macos)-(?:latest|[0-9][A-Za-z0-9._-]*)\b", re.I)
SELF_HOSTED_RE = re.compile(r"\bself-hosted\b", re.I)
PR_TRIGGER_RE = re.compile(r"(?m)^\s*pull_request(?:_target)?\s*:")
CONCURRENCY_RE = re.compile(r"(?m)^concurrency\s*:")
CANCEL_RE = re.compile(r"(?m)^\s*cancel-in-progress\s*:")


def runs_on_values(text: str) -> list[str]:
    lines = text.splitlines()
    values: list[str] = []
    for index, line in enumerate(lines):
        match = re.match(r"^(\s*)runs-on:\s*(.*)$", line)
        if not match:
            continue
        base_indent = len(match.group(1))
        tail = match.group(2).strip()
        if tail:
            values.append(tail)
            continue
        block: list[str] = []
        for next_line in lines[index + 1 :]:
            if not next_line.strip():
                continue
            indent = len(next_line) - len(next_line.lstrip())
            if indent <= base_indent:
                break
            block.append(next_line.strip())
        values.append(" ".join(block))
    return values


def main() -> int:
    violations: list[dict[str, str]] = []
    records: list[dict[str, object]] = []

    for path in sorted([*WORKFLOW_DIR.glob("*.yml"), *WORKFLOW_DIR.glob("*.yaml")]):
        text = path.read_text(encoding="utf-8")
        values = runs_on_values(text)
        hosted = any(HOSTED_RE.search(value) for value in values)
        self_hosted = any(SELF_HOSTED_RE.search(value) for value in values)
        allowlisted = path.name in HOSTED_ONLY_ALLOWLIST
        pr_triggered = bool(PR_TRIGGER_RE.search(text))
        has_concurrency = bool(CONCURRENCY_RE.search(text))
        has_cancel = bool(CANCEL_RE.search(text))
        concurrency_exempt = path.name in CONCURRENCY_EXEMPTIONS

        if hosted and not self_hosted and not allowlisted:
            violations.append({
                "workflow": path.name,
                "reason": "new hosted-only workflow is not in the explicit allowlist",
            })

        if self_hosted and "trust-internal" not in text:
            violations.append({
                "workflow": path.name,
                "reason": "self-hosted workflow is missing trust-internal capability boundary",
            })

        if self_hosted and pr_triggered and not concurrency_exempt and not has_concurrency:
            violations.append({
                "workflow": path.name,
                "reason": "PR-triggered self-hosted workflow is missing top-level concurrency",
            })
        elif self_hosted and pr_triggered and not concurrency_exempt and not has_cancel:
            violations.append({
                "workflow": path.name,
                "reason": "PR-triggered self-hosted workflow is missing cancel-in-progress",
            })

        records.append({
            "workflow": path.name,
            "runs_on": values,
            "hosted": hosted,
            "self_hosted": self_hosted,
            "hosted_only_allowlisted": allowlisted and hosted and not self_hosted,
            "allowlist_reason": HOSTED_ONLY_ALLOWLIST.get(path.name),
            "pr_triggered": pr_triggered,
            "has_concurrency": has_concurrency,
            "has_cancel_in_progress": has_cancel,
            "concurrency_exempt": concurrency_exempt,
            "concurrency_exemption_reason": CONCURRENCY_EXEMPTIONS.get(path.name),
        })

    report = {
        "schema": "clued.ci-runner-budget-policy/v2",
        "status": "PASS" if not violations else "FAIL",
        "hosted_only_allowlist": HOSTED_ONLY_ALLOWLIST,
        "concurrency_exemptions": CONCURRENCY_EXEMPTIONS,
        "workflows": records,
        "violations": violations,
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))

    if violations:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
