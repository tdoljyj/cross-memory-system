#!/usr/bin/env python3
"""Design documents name the Task or Decision behind every step and deferral.

Owner Decision on design-gap prevention (2026-10-03, Task b896173e), rule B:
in development/contracts/**, each item of a step list and each sentence that
leaves something undone must carry a Clued Task or Decision ID, so that no
step or deferral lives only in a document.

- A step list is the ordered list (`1.`, `2.`, ...) directly under a heading
  that names steps: 分步, 实施顺序, 实施步骤, "Implementation slices/steps/
  order", "Rollout steps". Each item, with its continuation lines, needs an ID.
- A deferral is any sentence (or table cell) with 不做, 暂缓, 未实现, 未做,
  待做, 暂不实现, 以后再做, 后续再做, "not (yet) implemented", "postponed" or
  "deferred to". It needs an ID in the same sentence. A sentence that only
  describes how the system behaves is written without these words.
- An ID is `Task` or `Decision` (or 任务 / 决定) followed by at least the
  first eight hex digits of the record's canonical ID, for example
  Task `5d379c50`.

Frozen documents whose bytes are pinned elsewhere are listed in
development/contracts/design-refs-exempt.json, with the file that pins them and
the Decision that froze them where Clued has one, and are not checked; their
deferrals are tracked in Clued instead. Code blocks, inline code and HTML comments are ignored.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = "development/contracts"
EXEMPT_FILE = "development/contracts/design-refs-exempt.json"

ID = re.compile(r"(?:Tasks?|Decisions?|任务|决定)\s*[：:]?\s*`?[0-9a-f]{8}(?![0-9a-z])", re.I)
DEFERRAL = re.compile(
    r"不做|暂缓|未实现|未做|待做|暂不实现|以后再做|后续再做|not (?:yet )?implemented|postponed|deferred to",
    re.I,
)
STEP_HEADING = re.compile(r"分步|实施顺序|实施步骤|Implementation (?:slices|steps|order)|Rollout steps", re.I)
HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
ORDERED_ITEM = re.compile(r"^\d+\.\s")
SENTENCE_BREAK = re.compile(r"[。；;！？!?|]|(?<=[.])\s")
HEX_SPAN = re.compile(r"`([0-9a-f]{8}(?:-[0-9a-f-]{4,27})?)`")


def visible(line: str) -> str:
    """The line without inline code (keeping bare ID spans) and HTML comments."""
    line = re.sub(r"<!--.*?-->", "", line)
    line = HEX_SPAN.sub(lambda m: m.group(1), line)
    return re.sub(r"`[^`]*`", "``", line)


def load_exempt(root: Path) -> tuple[dict[str, str], list[str]]:
    path = root / EXEMPT_FILE
    if not path.exists():
        return {}, []
    problems: list[str] = []
    exempt: dict[str, str] = {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        entries = data["exempt"]
        assert isinstance(entries, list)
    except Exception as error:  # noqa: BLE001 - any malformed file fails the check
        return {}, [f"{EXEMPT_FILE}: unreadable ({error})"]
    for entry in entries:
        name = entry.get("path") if isinstance(entry, dict) else None
        if not isinstance(name, str) or not name.startswith(CONTRACTS + "/"):
            problems.append(f"{EXEMPT_FILE}: entry without a path under {CONTRACTS}/: {entry!r}")
            continue
        if not (root / name).is_file():
            problems.append(f"{EXEMPT_FILE}: {name} does not exist")
        pinned_by = entry.get("pinned_by")
        if not isinstance(pinned_by, str) or not (root / pinned_by).is_file():
            problems.append(f"{EXEMPT_FILE}: {name} needs pinned_by, an existing file that pins its bytes")
        decision = entry.get("decision")
        if decision is not None and not ID.search(f"Decision `{decision}`"):
            problems.append(f"{EXEMPT_FILE}: {name} has a malformed decision ID")
        if not str(entry.get("reason", "")).strip():
            problems.append(f"{EXEMPT_FILE}: {name} needs a reason")
        exempt[name] = str(entry.get("reason", ""))
    return exempt, problems


def check_text(name: str, text: str) -> list[str]:
    findings: list[str] = []
    lines = text.split("\n")
    fence = False
    in_comment = False
    step_level: int | None = None
    item: list[tuple[int, str]] = []

    def close_item() -> None:
        if item and not any(ID.search(visible(body)) for _, body in item):
            number, first = item[0]
            findings.append(f"{name}:{number}: step without a Task or Decision ID: {first.strip()[:120]}")
        item.clear()

    for number, line in enumerate(lines, 1):
        stripped = line.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            fence = not fence
            continue
        if fence:
            continue
        if in_comment:
            if "-->" in line:
                in_comment = False
            continue
        if "<!--" in line and "-->" not in line.split("<!--", 1)[1]:
            in_comment = True
            line = line.split("<!--", 1)[0]
        heading = HEADING.match(line)
        if heading:
            close_item()
            level = len(heading.group(1))
            if step_level is not None and level <= step_level:
                step_level = None
            if STEP_HEADING.search(heading.group(2)):
                step_level = level
            continue
        if step_level is not None:
            if ORDERED_ITEM.match(line):
                close_item()
                item.append((number, line))
            elif item and (line.startswith((" ", "\t")) and stripped):
                item.append((number, line))
            elif item and not stripped:
                pass
            else:
                close_item()
        for sentence in SENTENCE_BREAK.split(visible(line)):
            if DEFERRAL.search(sentence) and not ID.search(sentence):
                findings.append(f"{name}:{number}: deferral without a Task or Decision ID: {sentence.strip()[:120]}")
    close_item()
    return findings


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    root = Path(args[0]).resolve() if args else ROOT
    exempt, findings = load_exempt(root)
    checked = 0
    for path in sorted((root / CONTRACTS).rglob("*.md")):
        name = path.relative_to(root).as_posix()
        if name in exempt:
            continue
        checked += 1
        findings.extend(check_text(name, path.read_text(encoding="utf-8")))
    for finding in findings:
        print(finding)
    if findings:
        print(f"FAIL: {len(findings)} finding(s) in {CONTRACTS}; add the Task or Decision ID "
              "(register the work in Clued first), or reword a sentence that only describes behavior.")
        return 1
    print(f"PASS: checked {checked} design document(s), {len(exempt)} frozen document(s) exempt")
    return 0


if __name__ == "__main__":
    sys.exit(main())
