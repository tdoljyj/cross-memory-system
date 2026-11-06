#!/usr/bin/env python3
"""BeamingFace component versions: one manifest, content-bound, checked in CI.

config/clued-components.json lists every self-developed Clued component (the
Skill, the Agent contract, the Claude Code hooks, the local scripts, the MCP
service) with its version. A component that ships files also records
content_sha256, a digest of those files, and may name a version marker: a line
in one of its files that repeats the version, so a copy installed elsewhere
still says which version it is.

    python3 scripts/clued_components.py versions [--json]
    python3 scripts/clued_components.py check [--base <git ref>]
    python3 scripts/clued_components.py bump <component id> <new version>
    python3 scripts/clued_components.py update

`check` fails when a component's files no longer match its recorded digest or
its marker, and, with --base, when a component changed against the base
manifest without a higher version. A --base that does not resolve to a commit
(not fetched, misspelled, all zeros or empty) is an error and a non-zero exit, never
a skipped comparison (Task 18af3b76). `bump` raises a version and rewrites its
marker; `update` re-records the digests. A content change therefore ships as:
edit -> bump -> update -> commit. Task 6dfd7560 (Owner Decision 967df3da).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

__version__ = "1.0.5"

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = Path("config/clued-components.json")
# The Worker reports the versions it was built from; this module must match the manifest.
GENERATED = Path("apps/clued-cloud/worker/generated/components.ts")
GENERATED_VERSIONS = re.compile(r"CLUED_COMPONENT_VERSIONS[^=]*=\s*(\{.*?\});", re.DOTALL)
SCHEMA = "clued.components/1"
SKIP_PARTS = {"__pycache__", ".DS_Store"}
VERSION_TEXT = re.compile(r"^\d+(?:\.\d+)*$")


def parse_version(value: str) -> tuple[int, ...]:
    if not isinstance(value, str) or not VERSION_TEXT.match(value):
        raise ValueError(f"version {value!r} is not dot-separated numbers")
    return tuple(int(part) for part in value.split("."))


def compare_versions(left: str, right: str) -> int:
    """-1, 0 or 1. Missing trailing parts count as 0, so 1.0 == 1.0.0."""
    a, b = parse_version(left), parse_version(right)
    width = max(len(a), len(b))
    a, b = a + (0,) * (width - len(a)), b + (0,) * (width - len(b))
    return (a > b) - (a < b)


def load_manifest(root: Path = ROOT) -> dict:
    data = json.loads((root / MANIFEST).read_text(encoding="utf-8"))
    if data.get("schema") != SCHEMA or not isinstance(data.get("components"), list):
        raise ValueError(f"{MANIFEST} is not a {SCHEMA} manifest")
    return data


def write_lf(path: Path, text: str) -> None:
    """The repository is eol=lf and the R9 re-registration helper refuses CRLF, so
    never let Windows turn a line feed into CRLF (Path.write_text only takes newline= from Python 3.10)."""
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def save_manifest(data: dict, root: Path = ROOT) -> None:
    write_lf(root / MANIFEST, json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def component_files(base: Path, patterns: list[str]) -> list[Path]:
    """Files under base matched by the patterns, relative to base, sorted."""
    found: set[Path] = set()
    for pattern in patterns:
        for path in base.glob(pattern):
            if path.is_file() and not SKIP_PARTS.intersection(path.relative_to(base).parts):
                found.add(path.relative_to(base))
    return sorted(found, key=lambda p: p.as_posix())


def content_digest(base: Path, patterns: list[str]) -> str | None:
    """sha256 over `<file sha256>  <relative path>` lines. Line endings are
    normalised to LF so a Windows checkout hashes the same as Linux."""
    files = component_files(base, patterns)
    if not files:
        return None
    lines = []
    for rel in files:
        data = (base / rel).read_bytes().replace(b"\r\n", b"\n")
        lines.append(f"{hashlib.sha256(data).hexdigest()}  {rel.as_posix()}\n")
    return hashlib.sha256("".join(lines).encode()).hexdigest()


def marker_regex(pattern: str) -> re.Pattern:
    head, _, tail = pattern.partition("{version}")
    # The lookahead checks the rest of the line without consuming it, so a
    # substitution keeps the line ending and any blank line after the marker.
    return re.compile(r"^" + re.escape(head) + r"([0-9][0-9.]*)" + re.escape(tail) + r"(?=[ \t\r]*$)", re.MULTILINE)


def read_marker(text: str, pattern: str) -> str | None:
    match = marker_regex(pattern).search(text)
    return match.group(1) if match else None


def by_id(data: dict) -> dict[str, dict]:
    return {c["id"]: c for c in data["components"]}


def component_status(component: dict, root: Path = ROOT) -> dict:
    """What the checkout holds for one component, against the manifest."""
    status = {"id": component["id"], "version": component["version"], "problems": []}
    try:
        parse_version(component["version"])
    except ValueError as error:
        status["problems"].append(str(error))
    patterns = component.get("files")
    if patterns:
        digest = content_digest(root / component["root"], patterns)
        status["content_sha256"] = digest
        if digest is None:
            status["problems"].append(f"no files match {component['root']}/{patterns}")
        elif digest != component.get("content_sha256"):
            status["problems"].append(
                "files changed since the recorded digest: bump the version "
                f"(clued_components.py bump {component['id']} <version>) and run clued_components.py update")
    marker = component.get("version_marker")
    if marker:
        try:
            text = (root / component["root"] / marker["file"]).read_text(encoding="utf-8")
        except OSError:
            text = ""
        found = read_marker(text, marker["pattern"])
        if found != component["version"]:
            status["problems"].append(
                f"{component['root']}/{marker['file']} declares {found or 'no version'}, "
                f"the manifest {component['version']}")
    return status


class BaseRefError(Exception):
    """The --base ref cannot be used, so no comparison can be made."""


def git_failure(done: subprocess.CompletedProcess) -> str:
    detail = (done.stderr or "").strip()
    return f" (git: {detail})" if detail else ""


def resolve_base(ref: str, root: Path = ROOT) -> str:
    """The commit a --base ref names; anything else is an error, never a skipped comparison."""
    if not ref.strip():
        raise BaseRefError("base ref is empty; pass a git ref such as origin/main")
    if ref.startswith("-"):
        raise BaseRefError(f"base ref {ref!r} looks like an option, not a git ref")
    try:
        done = subprocess.run(["git", "rev-parse", "--verify", "--quiet", "--end-of-options", f"{ref}^{{commit}}"],
                              cwd=root, capture_output=True, text=True)
    except OSError as error:
        raise BaseRefError(f"cannot run git to resolve base ref {ref!r}: {error}") from error
    commit = done.stdout.strip()
    if done.returncode != 0 or not commit:
        raise BaseRefError(f"base ref {ref!r} does not resolve to a commit "
                           f"(not fetched, misspelled, or all zeros); nothing was compared{git_failure(done)}")
    return commit


def base_manifest(ref: str, root: Path = ROOT) -> dict | None:
    """The manifest at the base ref; None only when that commit exists and holds no manifest file."""
    commit = resolve_base(ref, root)
    where = f"{MANIFEST.as_posix()} at base ref {ref!r}"
    try:
        # ls-tree separates "the path is not in that tree" (exit 0, no output) from a git failure.
        listed = subprocess.run(["git", "ls-tree", "--name-only", commit, "--", MANIFEST.as_posix()], cwd=root,
                                capture_output=True, text=True, encoding="utf-8")
        if listed.returncode != 0:
            raise BaseRefError(f"cannot read the tree of base ref {ref!r}{git_failure(listed)}")
        if not listed.stdout.strip():
            return None
        shown = subprocess.run(["git", "show", f"{commit}:{MANIFEST.as_posix()}"], cwd=root, capture_output=True,
                               text=True, encoding="utf-8")
    except OSError as error:
        raise BaseRefError(f"cannot read {where}: {error}") from error
    if shown.returncode != 0:
        raise BaseRefError(f"cannot read {where}{git_failure(shown)}")
    try:
        data = json.loads(shown.stdout)
    except ValueError as error:
        raise BaseRefError(f"{where} is not valid JSON: {error}") from error
    components = data.get("components") if isinstance(data, dict) else None
    if not isinstance(components, list) or not all(isinstance(c, dict) and "id" in c and "version" in c
                                                    for c in components):
        raise BaseRefError(f"{where} is not a component manifest (an object with a components list)")
    return data


def against_base(data: dict, base: dict) -> list[str]:
    problems = []
    old = by_id(base)
    for component in data["components"]:
        before = old.get(component["id"])
        if before is None:
            continue
        try:
            order = compare_versions(component["version"], before["version"])
        except ValueError:
            continue  # reported by component_status
        if order < 0:
            problems.append(f"{component['id']}: version went down from {before['version']} to {component['version']}")
        elif order == 0 and component.get("content_sha256") != before.get("content_sha256"):
            problems.append(f"{component['id']}: files changed but the version is still {component['version']}; "
                            f"bump it (clued_components.py bump {component['id']} <version>)")
    for removed in sorted(set(old) - set(by_id(data))):
        problems.append(f"{removed}: removed from the manifest")
    return problems


def generated_versions(root: Path = ROOT) -> dict | None:
    try:
        match = GENERATED_VERSIONS.search((root / GENERATED).read_text(encoding="utf-8"))
    except OSError:
        return None
    return json.loads(match.group(1)) if match else {}


def check(root: Path = ROOT, base_ref: str | None = None) -> list[str]:
    data = load_manifest(root)
    problems = []
    generated = generated_versions(root)
    if generated is not None and generated != {c["id"]: c["version"] for c in data["components"]}:
        problems.append(f"{GENERATED} does not match the manifest; run node apps/clued-cloud/scripts/generate-agent-contract.mjs")
    ids = [c.get("id") for c in data["components"]]
    if len(ids) != len(set(ids)):
        problems.append("duplicate component ids")
    for component in data["components"]:
        problems += [f"{component['id']}: {p}" for p in component_status(component, root)["problems"]]
    if base_ref is not None:  # an empty --base is an error too, not "no base"
        try:
            base = base_manifest(base_ref, root)
        except BaseRefError as error:
            problems.append(str(error))
        else:
            if base is None:
                print(f"clued-components: base ref {base_ref!r} holds no {MANIFEST.as_posix()}; "
                      "nothing was compared", file=sys.stderr)
            else:
                problems += against_base(data, base)
    return problems


def bump(component_id: str, version: str, root: Path = ROOT) -> None:
    data = load_manifest(root)
    component = by_id(data).get(component_id)
    if component is None:
        raise SystemExit(f"unknown component {component_id}")
    if compare_versions(version, component["version"]) <= 0:
        raise SystemExit(f"{version} is not higher than {component['version']}")
    marker = component.get("version_marker")
    if marker:
        path = root / component["root"] / marker["file"]
        text = path.read_text(encoding="utf-8")
        regex = marker_regex(marker["pattern"])
        if not regex.search(text):
            raise SystemExit(f"{path} has no version marker {marker['pattern']!r}")
        line = marker["pattern"].replace("{version}", version)
        write_lf(path, regex.sub(lambda _: line, text, count=1))
    component["version"] = version
    save_manifest(data, root)


def update(root: Path = ROOT) -> list[str]:
    data = load_manifest(root)
    changed = []
    for component in data["components"]:
        if component.get("files"):
            digest = content_digest(root / component["root"], component["files"])
            if digest != component.get("content_sha256"):
                component["content_sha256"] = digest
                changed.append(component["id"])
    save_manifest(data, root)
    return changed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    versions = sub.add_parser("versions", help="list component versions and whether the files match")
    versions.add_argument("--json", action="store_true")
    checker = sub.add_parser("check", help="fail on a changed component without a version bump")
    checker.add_argument("--base", help="git ref of the base manifest, for example origin/main")
    bumper = sub.add_parser("bump", help="raise a component's version and rewrite its marker")
    bumper.add_argument("component")
    bumper.add_argument("version")
    sub.add_parser("update", help="re-record content digests")
    args = parser.parse_args(argv)

    if args.command == "versions":
        rows = [component_status(c) for c in load_manifest()["components"]]
        if args.json:
            print(json.dumps(rows, indent=2, ensure_ascii=False))
        else:
            for row in rows:
                state = "ok" if not row["problems"] else "; ".join(row["problems"])
                print(f"{row['id']:<28} {row['version']:<10} {state}")
        return 0
    if args.command == "check":
        problems = check(base_ref=args.base)
        for problem in problems:
            print(f"clued-components: {problem}", file=sys.stderr)
        if not problems:
            print("clued-components: every component matches its version")
        return 1 if problems else 0
    if args.command == "bump":
        bump(args.component, args.version)
        print(f"{args.component} -> {args.version}; now run: python3 scripts/clued_components.py update")
        return 0
    changed = update()
    print("updated digests: " + (", ".join(changed) if changed else "none"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
