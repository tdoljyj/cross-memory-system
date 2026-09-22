#!/usr/bin/env python3
"""Check relative Markdown links in the small set of active repository entry documents."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[2]
ACTIVE_DOCS = (
    "README.md",
    "AGENTS.md",
    "docs/README.md",
    "skills/README.md",
    "apps/clued-cloud/README.md",
    "apps/clued-cloud/AGENTS.md",
    "protocol/continuity/v1/README.md",
    "scripts/ci/self-hosted/README.md",
)
LINK = re.compile(r"\[[^\]]*\]\(([^)]+)\)")


def local_target(source: Path, href: str) -> Path | None:
    href = href.strip().strip("<>")
    if not href or href.startswith("#"):
        return None
    if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", href):
        return None
    href = unquote(href.split("#", 1)[0].split("?", 1)[0])
    if not href:
        return None
    return (source.parent / href).resolve()


def main() -> int:
    failures: list[str] = []
    for relative in ACTIVE_DOCS:
        source = ROOT / relative
        if not source.is_file():
            failures.append(f"{relative}: active document is missing")
            continue
        text = source.read_text(encoding="utf-8")
        for match in LINK.finditer(text):
            href = match.group(1)
            target = local_target(source, href)
            if target is None:
                continue
            try:
                target.relative_to(ROOT)
            except ValueError:
                failures.append(f"{relative}: relative link escapes repository: {href}")
                continue
            if not target.exists():
                failures.append(f"{relative}: broken relative link: {href}")

    if failures:
        for failure in failures:
            print(failure, file=sys.stderr)
        print(f"FAIL: {len(failures)} active documentation link error(s)", file=sys.stderr)
        return 1

    print(f"PASS: checked {len(ACTIVE_DOCS)} active documentation entry files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
