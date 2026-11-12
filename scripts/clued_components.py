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
import fnmatch
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

__version__ = "1.0.8"

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = Path("config/clued-components.json")
# The Worker reports the versions it was built from; this module must match the manifest.
GENERATED = Path("apps/clued-cloud/worker/generated/components.ts")
GENERATED_VERSIONS = re.compile(r"CLUED_COMPONENT_VERSIONS[^=]*=\s*(\{.*?\});", re.DOTALL)
MECHANICAL_FILES = Path("config/clued-mechanical-files.json")
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
    """Write text with LF only. The repository is eol=lf and the R9 helper refuses CRLF,
    so Windows must not translate. (Path.write_text takes newline= only from Python 3.10.)"""
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


def against_base(data: dict, base: dict, semantic_changes: dict[str, bool] | None = None, root: Path | None = None) -> list[str]:
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
        elif (order == 0 and component.get("content_sha256") != before.get("content_sha256")
              and (semantic_changes is None or semantic_changes.get(component["id"], True))):
            problems.append(f"{component['id']}: files changed but the version is still {component['version']}; "
                            f"bump it (clued_components.py bump {component['id']} <version>)")
    for removed in sorted(set(old) - set(by_id(data))):
        # Retired: allowed only together with every file it covered.
        if root is not None and not component_files(root / old[removed].get("root", "."), old[removed].get("files", [])):
            continue
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
                # A generated registry or another component's marker may change
                # these bytes without changing this component's source. Actual
                # bytes still have to match above; this only avoids a cascade
                # of releases for the same mechanical update.
                try:
                    semantic = {row["id"]: row["content_changed"]
                                for row in integration_plan(base_ref, root)["components"]}
                except (ValueError, BaseRefError) as error:
                    problems.append(str(error))
                else:
                    problems += against_base(data, base, semantic, root)
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


def _safe_component_path(value: str, *, pattern: bool = False) -> str:
    if not isinstance(value, str) or not value or "\\" in value or value.startswith("/"):
        raise ValueError(f"unsafe component path: {value!r}")
    if value == ".":
        return value
    if any(part in ("", ".", "..") for part in value.split("/")) or ":" in value:
        raise ValueError(f"unsafe component path: {value!r}")
    if not pattern and any(char in value for char in "*?["):
        raise ValueError(f"unsafe component path: {value!r}")
    return value


def _glob_matches(name: str, pattern: str) -> bool:
    """Path.glob-style ** matching without reading an old tree into the checkout."""
    parts, patterns = name.split("/"), pattern.split("/")

    def matches(i: int, j: int) -> bool:
        if j == len(patterns):
            return i == len(parts)
        if patterns[j] == "**":
            return any(matches(k, j + 1) for k in range(i, len(parts) + 1))
        return i < len(parts) and fnmatch.fnmatchcase(parts[i], patterns[j]) and matches(i + 1, j + 1)

    return matches(0, 0)


def mechanical_policy(root: Path = ROOT) -> dict:
    """config/clued-mechanical-files.json, the only list of generated files.

    mechanical_paths are wholly generated; marker_paths are hand-written files
    in which only generated lines (declared version markers, digests) may change.
    """
    path = root / MECHANICAL_FILES
    if not path.exists():
        return {"mechanical_paths": [], "marker_paths": []}  # A historical base/fixture may predate the policy.
    policy = json.loads(path.read_text(encoding="utf-8"))
    if (set(policy) - {"marker_paths"} != {"schema", "repository", "context_keys", "mechanical_paths"}
            or policy["schema"] != 1
            or not isinstance(policy["repository"], str)
            or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", policy["repository"])
            or not isinstance(policy["context_keys"], list) or not policy["context_keys"]
            or any(not isinstance(scope, str) or not re.fullmatch(
                r"global|project:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", scope)
                for scope in policy["context_keys"])):
        raise ValueError("invalid mechanical file policy")
    paths, markers = policy["mechanical_paths"], policy.setdefault("marker_paths", [])
    for group in (paths, markers):
        if not isinstance(group, list) or len(group) != len(set(group)):
            raise ValueError("invalid mechanical file policy paths")
    for name in paths:
        _safe_component_path(name, pattern=True)
        if "*" in name and not (name.endswith("/**") and "*" not in name[:-3]):
            raise ValueError("mechanical file policy permits only a bounded directory /**")
    for name in markers:
        _safe_component_path(name)
        if any(_glob_matches(name, pattern) for pattern in paths):
            raise ValueError(f"{name} is both wholly generated and a marker file")
    return policy


def mechanical_paths(root: Path = ROOT) -> list[str]:
    return mechanical_policy(root)["mechanical_paths"]


def marker_paths(root: Path = ROOT) -> list[str]:
    return mechanical_policy(root)["marker_paths"]


_DIGEST = re.compile(rb"\b[0-9a-f]{40}(?:[0-9a-f]{24})?\b")


def generated_only(name: str, before: bytes | None, after: bytes | None, markers: dict[str, set[str]]) -> bool:
    """Whether a marker_paths file changed only in its generated lines."""
    if before is None or after is None:
        return False
    if name == MANIFEST.as_posix():
        def hand_written(data: bytes):
            manifest = json.loads(data)
            return {**manifest, "components": [{k: v for k, v in c.items() if k not in ("version", "content_sha256")}
                                               for c in manifest["components"]]}
        try:
            return hand_written(before) == hand_written(after)
        except (ValueError, KeyError, TypeError, AttributeError):
            return False
    def mask(data: bytes) -> bytes:
        return _DIGEST.sub(b"<digest>", _without_versions(name, data, markers))
    return mask(before) == mask(after)


def _component_patterns(component: dict) -> list[str]:
    prefix = _safe_component_path(component.get("root", "."))
    patterns = component.get("files", [])
    if not isinstance(patterns, list):
        raise ValueError("component files must be a list")
    result = []
    for pattern in patterns:
        _safe_component_path(pattern, pattern=True)
        result.append(pattern if prefix == "." else prefix + "/" + pattern)
    marker = component.get("version_marker")
    if marker:
        _safe_component_path(marker["file"])
        if marker["pattern"].count("{version}") != 1:
            raise ValueError("component marker must have one {version}")
    return result


def _git_output(root: Path, args: list[str], *, binary: bool = False) -> str | bytes:
    done = subprocess.run(["git", *args], cwd=root, capture_output=True,
                          text=not binary, encoding=None if binary else "utf-8")
    if done.returncode:
        raise BaseRefError(f"git {' '.join(args[:2])} failed{git_failure(done) if not binary else ''}")
    return done.stdout


def _checked_file(root: Path, relative: str) -> Path:
    _safe_component_path(relative)
    target = root / relative
    cursor = target
    while cursor != root:
        if cursor.is_symlink():
            raise ValueError(f"unsafe component path (symlink): {relative}")
        cursor = cursor.parent
    return target


def _marker_map(*manifests: dict) -> dict[str, set[str]]:
    result: dict[str, set[str]] = {}
    for data in manifests:
        for component in data["components"]:
            _component_patterns(component)
            marker = component.get("version_marker")
            if marker:
                prefix = component.get("root", ".")
                name = marker["file"] if prefix == "." else prefix + "/" + marker["file"]
                result.setdefault(name, set()).add(marker["pattern"])
    return result


def _without_versions(name: str, data: bytes | None, markers: dict[str, set[str]]) -> bytes | None:
    if data is None:
        return None
    data = data.replace(b"\r\n", b"\n")
    if name not in markers:
        return data
    text = data.decode("utf-8")
    for pattern in sorted(markers[name]):
        text = marker_regex(pattern).sub(lambda _: pattern.replace("{version}", "@VERSION@"), text)
    return text.encode("utf-8")


def integration_plan(base_ref: str, root: Path = ROOT, *, expected_head: str | None = None) -> dict:
    """Read-only exact-base plan: ordinary source PRs need no hand-edited versions.

    Mechanical outputs and declared version-marker lines do not cause cascading
    releases. Explicit higher semantic versions remain valid; automation never
    downgrades one or invents coverage for a marker-less logical service.
    """
    root = root.resolve()
    base = resolve_base(base_ref, root)
    head = resolve_base("HEAD", root)
    if expected_head is not None and head != expected_head:
        raise ValueError("head changed before component integration")
    before = base_manifest(base, root)
    if before is None:
        raise ValueError("integration base has no component manifest")
    data = load_manifest(root)
    for component in data["components"]:
        if component.get("kind") != "service":
            continue
        if (not isinstance(component.get("root"), str) or not component["root"]
                or not isinstance(component.get("files"), list) or not component["files"]):
            raise ValueError(f"{component['id']}: service has no explicit source coverage; "
                             "declare root/files before automatic component integration")
        _component_patterns(component)
        if not component_files(root / component["root"], component["files"]):
            raise ValueError(f"{component['id']}: service source coverage matches no files")
    old, current = by_id(before), by_id(data)
    if len(current) != len(data["components"]):
        raise ValueError("component integration refuses duplicate components")
    # A component retires only together with every file it covered (nothing it shipped is left unversioned).
    for cid in sorted(set(old) - set(current)):
        if component_files(root / old[cid].get("root", "."), old[cid].get("files", [])):
            raise ValueError(f"{cid}: a component is removed only together with all its files")
    markers = _marker_map(before, data)
    ignored, marked = mechanical_paths(root), set(marker_paths(root))
    changed = set(str(_git_output(root, ["diff", "--no-renames", "--name-only", "-z", base, "--"])).split("\0"))
    changed.update(str(_git_output(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0"))
    changed.discard("")
    base_names = set(str(_git_output(root, ["ls-tree", "-r", "--name-only", "-z", base])).split("\0"))
    cache: dict[str, bytes | None] = {}

    def old_bytes(name: str) -> bytes | None:
        if name not in cache:
            cache[name] = _git_output(root, ["show", f"{base}:{name}"], binary=True) if name in base_names else None
        return cache[name]

    rows, snapshot = [], {"manifest": data, "files": []}
    for component in data["components"]:
        patterns = _component_patterns(component)
        prior = old.get(component["id"])
        version = component["version"]
        parse_version(version)
        if prior and compare_versions(version, prior["version"]) < 0:
            raise ValueError(f"{component['id']}: version went down")
        for rel in component_files(root / component.get("root", "."), component.get("files", [])):
            prefix = component.get("root", ".")
            name = rel.as_posix() if prefix == "." else prefix + "/" + rel.as_posix()
            path = _checked_file(root, name)
            snapshot["files"].append([name, hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()])
        semantic = prior is None or {k: v for k, v in component.items() if k not in ("version", "content_sha256")} != {
            k: v for k, v in (prior or {}).items() if k not in ("version", "content_sha256")}
        relevant = patterns + (_component_patterns(prior) if prior else [])
        for name in sorted(changed):
            # A version-bearing .mjs is still executable source. Its marker
            # line is mechanical; a body edit must raise the owning version.
            # Full generated outputs remain independently generation-checked.
            if name not in markers and any(_glob_matches(name, pattern) for pattern in ignored):
                continue
            if not any(_glob_matches(name, pattern) for pattern in relevant):
                continue
            path = _checked_file(root, name)
            actual = path.read_bytes() if path.is_file() else None
            if name in marked:
                semantic = semantic or not generated_only(name, old_bytes(name), actual, markers)
            elif _without_versions(name, actual, markers) != _without_versions(name, old_bytes(name), markers):
                semantic = True
        target = version
        if prior and semantic:
            parts = list(parse_version(prior["version"]))
            parts[-1] += 1
            automatic = ".".join(map(str, parts))
            if compare_versions(target, automatic) < 0:
                target = automatic
        rows.append({"id": component["id"], "base_version": prior["version"] if prior else None,
                     "current_version": version, "target_version": target, "content_changed": semantic})
    state = hashlib.sha256(json.dumps(snapshot, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    return {"schema": "clued.component-integration/1", "base_commit": base, "head_commit": head,
            "input_state_sha256": state, "components": rows,
            "changes": [row for row in rows if row["target_version"] != row["current_version"]]}


def apply_integration(plan: dict, root: Path = ROOT) -> list[str]:
    """Apply a still-current plan to a disposable integration candidate, never Git refs."""
    current = integration_plan(plan["base_commit"], root, expected_head=plan["head_commit"])
    if current != plan:
        raise ValueError("component sources or versions changed since integration plan")
    data = load_manifest(root)
    targets = {row["id"]: row["target_version"] for row in plan["components"]}
    edits: dict[Path, str] = {}
    for component in data["components"]:
        target = targets[component["id"]]
        marker = component.get("version_marker")
        if marker:
            prefix = component.get("root", ".")
            relative = marker["file"] if prefix == "." else prefix + "/" + marker["file"]
            path = _checked_file(root.resolve(), relative)
            text = edits.get(path, path.read_text(encoding="utf-8"))
            regex = marker_regex(marker["pattern"])
            if not regex.search(text):
                raise ValueError(f"{relative}: missing declared version marker")
            rendered = regex.sub(lambda _: marker["pattern"].replace("{version}", target), text, count=1)
            if rendered != text:
                edits[path] = rendered
        component["version"] = target
    for path, text in edits.items():
        write_lf(path, text)
    save_manifest(data, root)
    changed = update(root)
    generated = root / GENERATED
    if generated.exists():
        versions = {c["id"]: c["version"] for c in data["components"]}
        lines = ["// Generated by scripts/generate-agent-contract.mjs from", "// config/clued-components.json. Do not edit by hand.",
                 f'export const CLUED_COMPONENTS_SCHEMA = {json.dumps(data["schema"])};',
                 "export const CLUED_COMPONENT_VERSIONS: Readonly<Record<string, string>> = "
                 + json.dumps(versions, indent=2, ensure_ascii=False) + ";"]
        if "mcp.server" in versions:
            lines.append(f'export const MCP_SERVER_VERSION = {json.dumps(versions["mcp.server"])};')
        write_lf(generated, "\n".join(lines) + "\n")
    # A declared service may cover generated modules. Record their final bytes,
    # after rendering versions, rather than leaving an immediately stale hash.
    changed.extend(item for item in update(root) if item not in changed)
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
    integrator = sub.add_parser("integrate", help="plan automatic versions for an exact integration base")
    integrator.add_argument("--base", required=True)
    integrator.add_argument("--expect-head")
    integrator.add_argument("--json", action="store_true")
    integrator.add_argument("--write", action="store_true", help="apply versions only to a clean candidate; no Git writes")
    args = parser.parse_args(argv)

    if args.command == "integrate":
        try:
            plan = integration_plan(args.base, expected_head=args.expect_head)
            if args.write:
                if args.expect_head is None:
                    raise ValueError("--write requires --expect-head")
                if str(_git_output(ROOT, ["status", "--porcelain", "--untracked-files=all"])).strip():
                    raise ValueError("component integration requires a clean candidate checkout")
                apply_integration(plan)
                plan["applied"] = True
            else:
                plan["applied"] = False
            print(json.dumps(plan, ensure_ascii=False, indent=2) if args.json else "\n".join(
                f'{row["id"]}: {row["current_version"]} -> {row["target_version"]}' for row in plan["changes"])
                or "no automatic component version changes")
            return 0
        except (ValueError, BaseRefError, OSError) as error:
            print(f"clued-components: {error}", file=sys.stderr)
            return 1

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
