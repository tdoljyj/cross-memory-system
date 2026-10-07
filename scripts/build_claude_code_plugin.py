#!/usr/bin/env python3
"""Assemble the private Clued plugin for Claude Code from its sources.

A Claude Code plugin installed from a marketplace is copied as a directory, and
symlinks inside it are not followed, so the plugin keeps its own copies of the
files it shares with the rest of this repository. This script makes those
copies; `--check` fails when a copy differs from its source, so the plugin
never ships a Skill or hook that the repository has since changed.

Sources (left) and their copies under integrations/claude-code/clued/ (right):
  skills/clued/**                    -> skills/clued/**
  scripts/hooks/run_python.sh        -> hooks/run_python.sh
  scripts/hooks/clued_capture_guard.py -> hooks/clued_capture_guard.py

The plugin's own files (.claude-plugin/plugin.json, hooks/hooks.json,
README.md) are written by hand and not touched here. Task 67c97003.

Usage: python3 scripts/build_claude_code_plugin.py [--check]
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "integrations" / "claude-code" / "clued"

# (source relative to ROOT, copy relative to PLUGIN); a directory is copied whole.
COPIES = [
    ("skills/clued", "skills/clued"),
    ("scripts/hooks/run_python.sh", "hooks/run_python.sh"),
    ("scripts/hooks/clued_capture_guard.py", "hooks/clued_capture_guard.py"),
]


def files_under(path: Path) -> dict[str, bytes]:
    if path.is_file():
        return {"": path.read_bytes()}
    if not path.is_dir():
        return {}
    return {
        p.relative_to(path).as_posix(): p.read_bytes()
        for p in sorted(path.rglob("*"))
        if p.is_file() and "__pycache__" not in p.parts
    }


def differences() -> list[str]:
    found = []
    for source, copy in COPIES:
        want, have = files_under(ROOT / source), files_under(PLUGIN / copy)
        if not want:
            found.append(f"{source}: source missing")
            continue
        for name in sorted(set(want) | set(have)):
            label = f"{copy}/{name}" if name else copy
            if name not in have:
                found.append(f"{label}: missing from the plugin")
            elif name not in want:
                found.append(f"{label}: not in {source}")
            elif want[name] != have[name]:
                found.append(f"{label}: differs from {source}")
    return found


def build() -> None:
    for source, copy in COPIES:
        src, dst = ROOT / source, PLUGIN / copy
        if dst.is_dir():
            shutil.rmtree(dst)
        elif dst.exists():
            dst.unlink()
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.is_dir():
            shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__"))
        else:
            shutil.copy2(src, dst)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail if a copy differs from its source")
    args = parser.parse_args(argv)
    if args.check:
        found = differences()
        for line in found:
            print(f"claude-code plugin: {line}", file=sys.stderr)
        if found:
            print("Run: python3 scripts/build_claude_code_plugin.py", file=sys.stderr)
            return 1
        print("claude-code plugin: copies match their sources")
        return 0
    build()
    print(f"claude-code plugin: copied {len(COPIES)} sources into {PLUGIN.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
