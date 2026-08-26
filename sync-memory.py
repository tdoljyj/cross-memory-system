#!/usr/bin/env python3
"""Git transport and read-only local mirror for Clued v1.6 snapshots."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path


REPO = Path(__file__).resolve().parent
LOCAL_MEMORY = Path(os.environ.get("CROSS_MEMORY_LOCAL_DIR", Path.home() / "Documents" / "Codex" / "memory"))


def run(*args: str, check: bool = True):
    result = subprocess.run(args, cwd=REPO, text=True, encoding="utf-8", errors="replace", capture_output=True)
    if check and result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip())
    return result


def validate(root: Path) -> tuple[dict, list[str]]:
    sys.path.insert(0, str(REPO))
    import memory as memory_cli
    return memory_cli.validate_bundle(root)


def mirror() -> None:
    manifest, errors = validate(REPO / "memory")
    if errors:
        raise RuntimeError("canonical snapshot invalid: " + "; ".join(errors[:10]))
    parent = LOCAL_MEMORY.parent
    parent.mkdir(parents=True, exist_ok=True)
    backup_root = Path(os.environ.get("CROSS_MEMORY_BACKUP_DIR", parent / "memory-backups"))
    backup_root.mkdir(parents=True, exist_ok=True)
    temporary = backup_root / f"memory-next-{os.getpid()}"
    backup = backup_root / f"memory-{int(time.time())}"
    if temporary.exists():
        shutil.rmtree(temporary)
    shutil.copytree(REPO / "memory", temporary)
    _, copied_errors = validate(temporary)
    if copied_errors:
        shutil.rmtree(temporary)
        raise RuntimeError("local candidate invalid: " + "; ".join(copied_errors[:10]))
    moved_old = False
    try:
        if LOCAL_MEMORY.exists():
            LOCAL_MEMORY.rename(backup)
            moved_old = True
        temporary.rename(LOCAL_MEMORY)
    except Exception:
        if not LOCAL_MEMORY.exists() and moved_old and backup.exists():
            backup.rename(LOCAL_MEMORY)
        raise
    print(json.dumps({"status": "mirrored", "snapshot_version": manifest["snapshot_version"], "canonical_version": manifest["canonical_version"], "backup": str(backup) if moved_old else None}, ensure_ascii=False))


def cmd_doctor() -> int:
    manifest, errors = validate(REPO / "memory")
    for error in errors:
        print(f"[FAIL] {error}")
    if errors:
        print(f"doctor: {len(errors)} FAILURE(S)")
        return 1
    print(f"[PASS] repository snapshot {manifest['snapshot_version']} / {manifest['canonical_version']}")
    if LOCAL_MEMORY.exists():
        local_manifest, local_errors = validate(LOCAL_MEMORY)
        same = not local_errors and local_manifest.get("snapshot_version") == manifest.get("snapshot_version")
        print(f"[{'PASS' if same else 'WARN'}] local read-only mirror {'aligned' if same else 'not aligned'}")
    else:
        print("[WARN] local read-only mirror does not exist")
    print("doctor: ALL PASS")
    return 0


def cmd_pull(access: str) -> int:
    if access.upper() == "NONE":
        print("Memory Access = NONE; skipping pull (no recall scope).")
        return 0
    if run("git", "status", "--porcelain", check=False).stdout.strip():
        raise RuntimeError("refusing pull: repository worktree is dirty")
    remote = run("git", "ls-remote", "origin", "refs/heads/main").stdout.split()[0]
    local = run("git", "rev-parse", "HEAD").stdout.strip()
    if local != remote:
        run("git", "fetch", "origin", "main")
        if run("git", "merge-base", "--is-ancestor", local, remote, check=False).returncode == 0:
            run("git", "-c", "user.name=Codex@TURING", "-c", "user.email=tdoljyj@users.noreply.github.com", "merge", "--no-edit", "FETCH_HEAD")
        elif run("git", "merge-base", "--is-ancestor", remote, local, check=False).returncode != 0:
            raise RuntimeError("local and origin/main diverged; semantic merge required")
    mirror()
    return 0


def cmd_push() -> int:
    print("push rejected: memory/ and the local mirror are read-only derived views; write once through authenticated Clued M1 APIs.", file=sys.stderr)
    return 2


def cmd_bootstrap() -> int:
    run("git", "config", "core.autocrlf", "false")
    run("git", "config", "maintenance.auto", "false")
    print("bootstrap complete (v1.6 read-only snapshot consumer)")
    return 0


def cmd_commit_repo() -> int:
    manifest, errors = validate(REPO / "memory")
    if errors:
        raise RuntimeError("refusing commit: " + "; ".join(errors[:10]))
    run("git", "add", "-A")
    staged = run("git", "diff", "--cached", "--name-only").stdout.strip()
    if staged:
        run("git", "-c", "user.name=Codex@TURING", "-c", "user.email=tdoljyj@users.noreply.github.com", "commit", "-m", f"memory v1.6 root cutover [Codex@TURING]: {manifest['snapshot_version']}")
    run("git", "fetch", "origin", "main")
    remote = run("git", "rev-parse", "FETCH_HEAD").stdout.strip()
    head = run("git", "rev-parse", "HEAD").stdout.strip()
    if run("git", "merge-base", "--is-ancestor", remote, head, check=False).returncode != 0:
        run("git", "-c", "user.name=Codex@TURING", "-c", "user.email=tdoljyj@users.noreply.github.com", "merge", "--no-edit", "FETCH_HEAD")
    run("git", "push", "origin", "HEAD:main")
    remote_after = run("git", "ls-remote", "origin", "refs/heads/main").stdout.split()[0]
    head_after = run("git", "rev-parse", "HEAD").stdout.strip()
    run("git", "fetch", "origin", "main")
    if run("git", "merge-base", "--is-ancestor", head_after, remote_after, check=False).returncode:
        raise RuntimeError("remote verification failed")
    print(f"repository committed and pushed: {head_after}")
    return 0


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "doctor"
    if mode == "doctor":
        return cmd_doctor()
    if mode == "pull":
        return cmd_pull(sys.argv[2] if len(sys.argv) > 2 else "MULTI")
    if mode == "push":
        return cmd_push()
    if mode == "bootstrap":
        return cmd_bootstrap()
    if mode == "commit-repo":
        return cmd_commit_repo()
    if mode == "mirror":
        mirror()
        return 0
    raise RuntimeError(f"unknown mode: {mode}")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"sync failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
