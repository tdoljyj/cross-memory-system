#!/usr/bin/env python3
"""Contract placement and byte-preserving rollout: ComponentVersioning.v0.2 §2.4–2.5.

Task af536fcc; Decisions 07f0edc7, 56c3fc66 and d5fb7433.
Inspect Git objects, not a PR-selected directory or generated manifest path list.
The caller binds base/head to the target branch and candidate commit.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import posixpath
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = "config/clued-components.json"
LEGACY = "skills/clued/references/agent-contract.md"
COPY = "integrations/claude-code/clued/skills/clued/references/agent-contract.md"
NEW = "protocol/agent/agent-contract.md"
BUDGET_BYTES = 76_000
PRODUCTION_BOOTSTRAP = "https://clued.pixelgrav.com/v1/continuity/bootstrap"
REGULAR = {"100644", "100755"}
MARKER = re.compile(r"^Contract version: \d+$", re.M)
PIN_PATTERNS = (
    re.compile(r"\bcontract(?:'s)?\s+(?:version\s*[:#]?\s*)?v?\d+(?!\.?\d)", re.I),
    re.compile(r"(?<![\w.])contract_version\W{0,4}\d+", re.I),
    re.compile(r"\bcontract\s*\(v\d+\)", re.I),
    re.compile(r"\bv\d+\s+of\s+the\s+contract", re.I),
    re.compile(r"合同\s*v?\d+(?!\.?\d)"),
)
REF = "ComponentVersioning.v0.2 §2.4/§2.5; Decisions 07f0edc7, 56c3fc66, d5fb7433"


@dataclass(frozen=True)
class Blob:
    mode: str
    data: bytes


def skill_path(path: str) -> bool:
    parts = path.split("/")
    return parts[0] == "skills" or (parts[0] == "integrations" and "skills" in parts[1:])


def normalized_root(value: object) -> str:
    if not isinstance(value, str) or not value or "\\" in value or value.startswith("/"):
        raise ValueError("component root must be a repository-relative POSIX path")
    if any(part == ".." for part in value.split("/")):
        raise ValueError("component root may not escape through ..")
    return posixpath.normpath(value)


def under(path: str, root: str) -> bool:
    return root == "." or path == root or path.startswith(root + "/")


def components(tree: dict[str, Blob]) -> dict[str, dict]:
    blob = tree.get(MANIFEST)
    if blob is None or blob.mode not in REGULAR:
        raise ValueError("component manifest missing or not a regular file")
    manifest = json.loads(blob.data)
    if manifest.get("schema") != "clued.components/1" or not isinstance(manifest.get("components"), list):
        raise ValueError("invalid component manifest schema")
    result = {}
    for component in manifest["components"]:
        if not isinstance(component, dict) or not isinstance(component.get("id"), str):
            raise ValueError("component identity missing")
        if component["id"] in result:
            raise ValueError("duplicate component identity")
        if "root" in component:
            normalized_root(component["root"])
        result[component["id"]] = component
    skill = result.get("skill.clued", {})
    if skill.get("kind") != "skill" or skill.get("root") != "skills/clued":
        raise ValueError("skill.clued must have kind skill and exact root skills/clued")
    contract = result.get("agent-contract", {})
    if contract.get("kind") != "contract" or "root" not in contract:
        raise ValueError("agent-contract component missing or not a rooted contract")
    return result


def legacy_identity(tree: dict[str, Blob], manifest: dict[str, dict]) -> bool:
    contract = manifest["agent-contract"]
    source = tree.get(LEGACY)
    return (source is not None and source.mode in REGULAR and
            contract.get("root") == "skills/clued/references" and
            contract.get("files") == ["agent-contract.md"])


def numeric_version(value: object) -> tuple[int, ...]:
    if not isinstance(value, str) or not re.fullmatch(r"\d+(?:\.\d+)*", value):
        raise ValueError("missing or invalid mcp.server version")
    return tuple(int(part) for part in value.split("."))


def check_rollout(base: dict[str, Blob], head: dict[str, Blob], manifest: dict[str, dict],
                  read_production: Callable[[], dict], minimum_service_version: str) -> list[str]:
    failures = []
    if NEW not in head or head[NEW].mode not in REGULAR:
        failures.append("rollout: new source missing or not a regular file")
    elif head[NEW].data != base[LEGACY].data:
        failures.append("rollout: moved contract differs from base source bytes")
    if COPY in head:
        failures.append("rollout: legacy plugin copy must be removed")
    contract = manifest["agent-contract"]
    if contract.get("root") != "protocol/agent" or contract.get("files") != ["agent-contract.md"]:
        failures.append("rollout: manifest must identify the new exact source")
    try:
        production = read_production()
        sha = hashlib.sha256(base[LEGACY].data.replace(b"\r\n", b"\n")).hexdigest()
        if production.get("agent_contract", {}).get("sha256") != sha:
            failures.append("rollout: production does not deliver the base contract hash")
        actual = numeric_version(production.get("components", {}).get("versions", {}).get("mcp.server"))
        minimum = numeric_version(minimum_service_version)
        length = max(len(actual), len(minimum))
        if actual + (0,) * (length - len(actual)) < minimum + (0,) * (length - len(minimum)):
            failures.append("rollout: production predates contract delivery")
    except (ValueError, TypeError, AttributeError, OSError) as error:
        failures.append(f"rollout: production verification unavailable ({type(error).__name__})")
    return failures


def check_placement(base: dict[str, Blob], head: dict[str, Blob], *,
                    read_production: Callable[[], dict] | None = None,
                    minimum_service_version: str | None = None) -> tuple[list[str], list[str]]:
    failures, notices = [], []
    try:
        base_manifest, head_manifest = components(base), components(head)
    except (ValueError, KeyError, TypeError, AttributeError) as error:
        return [f"manifest: {error}"], []
    transition = legacy_identity(base, base_manifest) and legacy_identity(head, head_manifest)
    exceptions = set()
    if transition:
        for label, tree in (("base", base), ("head", head)):
            copy = tree.get(COPY)
            if copy is None or copy.mode not in REGULAR or copy.data != tree[LEGACY].data:
                failures.append(f"transition: {label} plugin copy missing, non-regular or drifting")
        if not failures:
            exceptions = {LEGACY, COPY}
            notices.append(f"pending-split: {LEGACY} and exact synchronized plugin copy")
    skill_roots = [normalized_root(c["root"]) for c in head_manifest.values()
                   if c.get("kind") == "skill" and "root" in c]
    for path, blob in head.items():
        if not (skill_path(path) or any(under(path, root) for root in skill_roots)):
            continue
        if path in exceptions:
            continue
        if blob.mode not in REGULAR:
            failures.append(f"rule 1: non-regular Skill file cannot be scanned: {path}")
            continue
        text = blob.data.decode("utf-8", errors="replace").replace("\r\n", "\n")
        if path.rsplit("/", 1)[-1] == "agent-contract.md" or MARKER.search(text):
            failures.append(f"rule 1: contract packaged in Skill: {path}")
        # The rule covers instruction/reference files, not the admitted legacy contract.
        if path.endswith(".md") and any(pattern.search(text) for pattern in PIN_PATTERNS):
            failures.append(f"rule 3: contract version pinned in Skill: {path}")
    for identity, component in head_manifest.items():
        if component.get("kind") != "contract":
            continue
        root = normalized_root(component["root"])
        if skill_path(root) or any(under(root, skill_root) for skill_root in skill_roots):
            if not (transition and identity == "agent-contract" and root == "skills/clued/references"):
                failures.append(f"rule 2: contract component root inside Skill: {identity}")
    if LEGACY in base and LEGACY not in head:
        if base[LEGACY].mode not in REGULAR:
            failures.append("rollout: base legacy source is not regular")
        elif read_production is None or minimum_service_version is None:
            failures.append("rollout: production reader and delivery-version floor required")
        else:
            failures.extend(check_rollout(base, head, head_manifest, read_production, minimum_service_version))
    return failures, notices


def check_response_budget(responses: list[dict]) -> list[str]:
    """Check actual renderer results; integration must supply every part, including synthetic parts."""
    failures = []
    if not responses:
        return ["rule 4: rendered response set is empty"]
    for index, response in enumerate(responses, 1):
        if not isinstance(response, dict) or not isinstance(response.get("content"), list) or not isinstance(response.get("structuredContent"), dict):
            failures.append(f"rule 4: invalid renderer result {index}")
            continue
        wire = json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(wire) > BUDGET_BYTES:
            failures.append(f"rule 4: rendered response {index} is {len(wire)} bytes, over {BUDGET_BYTES}")
    return failures


def git_tree(root: Path, revision: str) -> dict[str, Blob]:
    commit = subprocess.run(["git", "rev-parse", "--verify", f"{revision}^{{commit}}"], cwd=root,
                            check=True, capture_output=True, text=True).stdout.strip()
    entries = subprocess.run(["git", "ls-tree", "-r", "-z", commit], cwd=root,
                             check=True, capture_output=True).stdout.split(b"\0")
    result = {}
    for entry in entries:
        if not entry:
            continue
        metadata, path_bytes = entry.split(b"\t", 1)
        mode, kind, oid = metadata.decode("ascii").split()
        path = path_bytes.decode("utf-8")
        # All Skill bytes are read independently of editable manifest globs.
        if not (skill_path(path) or path in {MANIFEST, NEW}):
            continue
        data = subprocess.run(["git", "cat-file", "blob", oid], cwd=root,
                              check=True, capture_output=True).stdout if kind == "blob" else b""
        result[path] = Blob(mode, data)
    # Include any custom Skill root too, after parsing the manifest; no manifest can hide the fixed locations.
    roots = [normalized_root(c["root"]) for c in components(result).values() if c.get("kind") == "skill" and "root" in c]
    for entry in entries:
        if not entry:
            continue
        metadata, path_bytes = entry.split(b"\t", 1)
        path = path_bytes.decode("utf-8")
        if path in result or not any(under(path, root_path) for root_path in roots):
            continue
        mode, kind, oid = metadata.decode("ascii").split()
        data = subprocess.run(["git", "cat-file", "blob", oid], cwd=root,
                              check=True, capture_output=True).stdout if kind == "blob" else b""
        result[path] = Blob(mode, data)
    return result


def production_bootstrap() -> dict:
    with urlopen(PRODUCTION_BOOTSTRAP, timeout=20) as response:
        data = response.read(100_001)
    if len(data) > 100_000:
        raise ValueError("production bootstrap exceeds read bound")
    return json.loads(data)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, help="verified target branch commit")
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--minimum-service-version", help="version established by step 1, pinned by the trusted workflow")
    parser.add_argument("--rendered-responses", type=Path, required=True, help="actual source renderer output, including current and synthetic multi-part cases")
    args = parser.parse_args()
    try:
        failures, notices = check_placement(git_tree(ROOT, args.base), git_tree(ROOT, args.head),
            read_production=production_bootstrap, minimum_service_version=args.minimum_service_version)
        responses = json.loads(args.rendered_responses.read_text(encoding="utf-8"))
        if not isinstance(responses, list):
            raise ValueError("renderer output must be a list")
        failures.extend(check_response_budget(responses))
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        failures, notices = [f"verification unavailable: {type(error).__name__}: {error}"], []
    for notice in notices:
        print(notice)
    for failure in failures:
        print(f"FAIL: {failure} ({REF})", file=sys.stderr)
    if not failures:
        print(f"PASS: contract placement ({REF})")
    return int(bool(failures))


if __name__ == "__main__":
    raise SystemExit(main())
