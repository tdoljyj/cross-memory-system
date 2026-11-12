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
import shutil
import subprocess
import sys
import tempfile

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


REGISTER_HINT = ("新生成文件 {name} 未登记到 config/clued-mechanical-files.json "
                 "(generated file not registered): add it to mechanical_paths if wholly generated, "
                 "to marker_paths if only its generated lines change; otherwise commit the change in the PR itself")


def unregistered_outputs(root: Path, names, old_bytes) -> list[str]:
    """Integration may write only what config/clued-mechanical-files.json declares.

    names are the files integration wrote (or may write). A mechanical_paths file
    may change freely, a marker_paths file only in its generated lines.
    """
    policy = components.mechanical_policy(root)
    markers = components._marker_map(components.load_manifest(root))
    marked = set(policy["marker_paths"])
    bad = []
    for name in sorted(set(names)):
        if any(components._glob_matches(name, pattern) for pattern in policy["mechanical_paths"]):
            continue
        if name in marked:
            path = components._checked_file(root, name)
            now = path.read_bytes() if path.is_file() else None
            before = old_bytes(name)
            if now == before or components.generated_only(name, before, now, markers):
                continue
        bad.append(name)
    return bad


def _mtimes(root: Path) -> dict[str, int]:
    names = str(components._git_output(root, ["ls-files", "-z"])).split("\0")
    return {name: (root / name).stat().st_mtime_ns for name in names if name and (root / name).is_file()}


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
    # Every file a generator writes counts, even when it rewrites identical
    # bytes, so a new output is caught on its first run, not its first change.
    before = _mtimes(root)
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
    written = set(str(components._git_output(root, ["diff", "--no-renames", "--name-only", "-z", "HEAD", "--"])).split("\0"))
    written.update(str(components._git_output(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0"))
    written.update(name for name, mtime in _mtimes(root).items() if before.get(name) != mtime)
    # apply_integration may rewrite any declared version marker on a later bump.
    written.update(components._marker_map(components.load_manifest(root)))
    written.discard("")
    tracked = set(str(components._git_output(root, ["ls-tree", "-r", "--name-only", "-z", "HEAD"])).split("\0"))
    bad = unregistered_outputs(root, written, lambda name: components._git_output(
        root, ["show", f"HEAD:{name}"], binary=True) if name in tracked else None)
    if bad:
        raise ValueError("; ".join(REGISTER_HINT.format(name=name) for name in bad))
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


def _npm_ci(app: Path) -> None:
    npm = shutil.which("npm")
    if not npm:
        raise ValueError("mechanical-outputs: npm is not installed; cannot verify")
    done = subprocess.run([npm, "ci", "--ignore-scripts", "--prefer-offline", "--fetch-retries=2",
                           "--fetch-timeout=30000", "--no-audit", "--no-fund"], cwd=app, capture_output=True, text=True)
    if done.returncode:
        raise ValueError("mechanical-outputs: npm ci in the throwaway worktree failed; cannot verify\n" + done.stderr[-2000:])


def _is_link(path: Path) -> bool:
    return path.is_symlink() or bool(getattr(path, "is_junction", lambda: False)())


def audit(root: Path, base: str, *, install=_npm_ci) -> dict:
    """CI check mechanical-outputs: integrate a throwaway worktree of HEAD and
    fail on any generator output that config/clued-mechanical-files.json lacks.

    Installed packages are only ever read: the candidate's node_modules (which
    may be a link to a shared store) is linked into the throwaway worktree, or,
    when there is none, packages are installed into that worktree alone."""
    root = root.resolve()
    head = str(components._git_output(root, ["rev-parse", "HEAD"])).strip()
    with tempfile.TemporaryDirectory(prefix="mechanical-outputs-") as temp:
        tree = Path(temp) / "candidate"
        components._git_output(root, ["worktree", "add", "--detach", "--quiet", str(tree), head])
        modules, target = root / "apps/clued-cloud/node_modules", tree / "apps/clued-cloud/node_modules"
        try:
            if modules.is_dir():
                target.parent.mkdir(parents=True, exist_ok=True)
                if os.name == "nt":
                    subprocess.run(["cmd", "/c", "mklink", "/J", str(target), str(modules)], check=True, capture_output=True)
                else:
                    target.symlink_to(modules, target_is_directory=True)
            elif (tree / "apps/clued-cloud/package-lock.json").is_file():
                install(tree / "apps/clued-cloud")
            report = integrate_candidate(tree, base, head, write=True)
            return {"check": "mechanical-outputs", "status": "ok", "base_commit": base, "head_commit": head,
                    "outputs": sorted(report["output_sha256"])}
        finally:
            if _is_link(target):
                os.rmdir(target) if os.name == "nt" else target.unlink()
            # Never delete through a link that is still there: that would empty the store it points to.
            if not _is_link(target):
                subprocess.run(["git", "worktree", "remove", "--force", str(tree)], cwd=root, capture_output=True)


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):  # the registration hint is Chinese on every host
        stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=components.ROOT)
    parser.add_argument("--base", required=True)
    parser.add_argument("--expect-head")
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--audit", action="store_true", help="integrate a throwaway worktree of HEAD (CI)")
    args = parser.parse_args(argv)
    try:
        if args.audit:
            print(json.dumps(audit(args.root, args.base), indent=2, ensure_ascii=False))
            return 0
        if not args.expect_head:
            parser.error("--expect-head is required unless --audit")
        print(json.dumps(integrate_candidate(args.root, args.base, args.expect_head, write=args.write),
                         indent=2, ensure_ascii=False))
        return 0
    except (ValueError, components.BaseRefError, OSError) as error:
        print(f"component-version-integration: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
