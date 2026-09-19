#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_DIR = ROOT / ".github" / "workflows"

HOSTED_ONLY_ALLOWLIST = {
    "clued-connection-authorization.yml": (
        "Intentional clean-room Ubuntu candidate validation; installs a system ICU compatibility package."
    ),
    "phase2-naming-surface-inventory.yml": (
        "Frozen historical exact-byte inventory workflow; modifying its execution contract would invalidate bound evidence."
    ),
    "phase2-v027-validation.yml": (
        "Frozen historical exact-source validation lane with self-referential accepted-source bindings."
    ),
}

HOSTED_RE = re.compile(r"\b(?:ubuntu|windows|macos)-(?:latest|[0-9][A-Za-z0-9._-]*)\b", re.I)
SELF_HOSTED_RE = re.compile(r"\bself-hosted\b", re.I)


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

        records.append({
            "workflow": path.name,
            "runs_on": values,
            "hosted": hosted,
            "self_hosted": self_hosted,
            "hosted_only_allowlisted": allowlisted and hosted and not self_hosted,
            "allowlist_reason": HOSTED_ONLY_ALLOWLIST.get(path.name),
        })

    report = {
        "schema": "clued.ci-runner-budget-policy/v1",
        "status": "PASS" if not violations else "FAIL",
        "hosted_only_allowlist": HOSTED_ONLY_ALLOWLIST,
        "workflows": records,
        "violations": violations,
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))

    if violations:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
