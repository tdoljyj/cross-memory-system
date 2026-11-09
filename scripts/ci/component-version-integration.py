#!/usr/bin/env python3
"""Materialise automatic component metadata before an integration candidate is tested.

Invoke from the existing integration builder after its trial merge and before
publishing/checking the candidate head. Never run this after the merge to main:
this command writes files only, never commits, pushes, updates a ref or grants
Source/host qualification. Default is a read-only plan.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import clued_components as components


def _command(root: Path, argv: list[str]) -> None:
    env = dict(os.environ)
    # The pinned checker must fail on UNCHECKED even when invoked from CI.
    env["GITHUB_ACTIONS"] = "false"
    done = subprocess.run(argv, cwd=root, capture_output=True, text=True, env=env)
    if done.returncode:
        raise ValueError(f"integration step failed ({done.returncode}): {' '.join(argv)}\n"
                         + done.stdout[-4000:] + done.stderr[-4000:])


def _state(root: Path) -> str:
    # Includes the diff's filenames, modes and bytes, not timestamps.
    diff = components._git_output(root, ["diff", "--binary", "HEAD", "--"], binary=True)
    extra = []
    for name in str(components._git_output(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0"):
        if name:
            extra.append([name, hashlib.sha256(components._checked_file(root, name).read_bytes()).hexdigest()])
    return hashlib.sha256(diff + json.dumps(extra, sort_keys=True).encode()).hexdigest()


def integrate_candidate(root: Path, base: str, head: str, *, write: bool = False) -> dict:
    root = root.resolve()
    if not re.fullmatch(r"[a-f0-9]{40}", base) or not re.fullmatch(r"[a-f0-9]{40}", head):
        raise ValueError("integration requires exact base and candidate commit SHAs")
    actual_root = Path(str(components._git_output(root, ["rev-parse", "--show-toplevel"])).strip()).resolve()
    if actual_root != root:
        raise ValueError("integration root must be the candidate checkout root")
    plan = components.integration_plan(base, root, expected_head=head)
    if not write:
        return {**plan, "applied": False, "qualification": "not_run"}
    if str(components._git_output(root, ["status", "--porcelain", "--untracked-files=all"])).strip():
        raise ValueError("integration requires a clean candidate checkout")
    components._git_output(root, ["merge-base", "--is-ancestor", base, head])
    if not (root / "scripts/ci/check-pinned-registries.mjs").is_file():
        raise ValueError("candidate lacks pinned-registry verification")
    generators = [
        ["node", "scripts/ci/merge-admission-r9-reregister.mjs", "--write", "--base", base],
        ["node", "apps/clued-cloud/scripts/generate-agent-contract.mjs"],
        [sys.executable, "scripts/build_claude_code_plugin.py"],
        ["node", "scripts/ci/clued-control-source-pins.mjs", "--base", base, "--write"],
        ["node", "scripts/ci/clued-merge-reconcile-source-build.mjs"],
    ]
    # Only fixed, existing deterministic generators are permitted. Their own
    # acceptance/Source/host checks are neither regenerated nor bypassed here.
    for _ in range(3):
        previous = _state(root)
        components.apply_integration(components.integration_plan(base, root, expected_head=head), root)
        for command in generators:
            if (root / command[1]).is_file():
                _command(root, command)
        components.update(root)
        agent_generator = root / "apps/clued-cloud/scripts/generate-agent-contract.mjs"
        if agent_generator.is_file():
            _command(root, ["node", agent_generator.relative_to(root).as_posix()])
        if _state(root) == previous:
            break
    else:
        raise ValueError("automatic component metadata did not converge in three passes")
    problems = components.check(root, base)
    if problems:
        raise ValueError("integrated component verification failed: " + "; ".join(problems))
    _command(root, ["node", "scripts/ci/check-pinned-registries.mjs", "--base", base, "--root", str(root)])
    after = components.integration_plan(base, root, expected_head=head)
    if after["changes"]:
        raise ValueError("automatic component metadata changed after verification")
    paths = set(str(components._git_output(root, ["diff", "--name-only", "HEAD", "--"])).splitlines())
    paths.update(name for name in str(components._git_output(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0") if name)
    outputs = {name: hashlib.sha256(components._checked_file(root, name).read_bytes()).hexdigest()
               for name in sorted(paths) if (root / name).is_file()}
    return {**after, "applied": True, "qualification": "pinned_registries_checked_not_execution_authority",
            "output_sha256": outputs}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=components.ROOT)
    parser.add_argument("--base", required=True)
    parser.add_argument("--expect-head", required=True)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args(argv)
    try:
        print(json.dumps(integrate_candidate(args.root, args.base, args.expect_head, write=args.write),
                         indent=2, ensure_ascii=False))
        return 0
    except (ValueError, components.BaseRefError, OSError) as error:
        print(f"component-version-integration: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
