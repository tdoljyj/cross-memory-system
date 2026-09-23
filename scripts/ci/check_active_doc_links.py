#!/usr/bin/env python3
"""Check relative links in active repository entry documents only."""
from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

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
LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")


def local_target(source: Path, raw: str) -> Path | None:
    value = raw.strip().strip("<>")
    if not value or value.startswith("#"):
        return None
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc:
        return None
    path = unquote(parsed.path)
    if not path:
        return None
    target = (source.parent / path).resolve()
    try:
        target.relative_to(ROOT)
    except ValueError as exc:
        raise ValueError(f"link escapes repository: {raw}") from exc
    return target


def main() -> int:
    failures: list[str] = []
    checked = 0
    for relative in ACTIVE_DOCS:
        source = ROOT / relative
        if not source.is_file():
            failures.append(f"{relative}: active document missing")
            continue
        text = source.read_text(encoding="utf-8")
        for match in LINK_RE.finditer(text):
            raw = match.group(1)
            try:
                target = local_target(source, raw)
            except ValueError as exc:
                failures.append(f"{relative}: {exc}")
                continue
            if target is None:
                continue
            checked += 1
            if not target.exists():
                try:
                    shown = target.relative_to(ROOT)
                except ValueError:
                    shown = target
                failures.append(f"{relative}: broken link {raw!r} -> {shown}")

    if failures:
        print("ACTIVE_DOC_LINKS_FAIL", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1
    print(f"ACTIVE_DOC_LINKS_PASS checked={checked} documents={len(ACTIVE_DOCS)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
