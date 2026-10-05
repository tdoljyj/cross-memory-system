#!/usr/bin/env python3
"""Git transport and read-only local mirror for Clued v1.6 snapshots."""

from __future__ import annotations

import json
import io
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path

# Physical implementation moved; retain the repository-root module contract.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from isolated_mirror import MirrorCoordinator
from verification_context import MIRROR_GENERATION_FILENAME, RequestVerificationContext, sha256_file


REPO = Path(__file__).resolve().parent.parent
LOCAL_MEMORY = Path(os.environ.get("CROSS_MEMORY_LOCAL_DIR", Path.home() / "Documents" / "Codex" / "memory"))


def run(*args: str, check: bool = True):
    result = subprocess.run(args, cwd=REPO, text=True, encoding="utf-8", errors="replace", capture_output=True)
    if check and result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip())
    return result


def validate(
    root: Path,
    *,
    context: RequestVerificationContext | None = None,
    boundary: str = "repository_snapshot",
) -> tuple[dict, list[str]]:
    sys.path.insert(0, str(REPO))
    import memory as memory_cli
    return memory_cli.validate_bundle(root, context=context, boundary=boundary)


def new_verification_context(
    mode: str,
    remote_head: str = "not-applicable",
    *,
    capsule_root: Path | None = None,
    enforce_current_pointer: bool = True,
) -> RequestVerificationContext:
    sys.path.insert(0, str(REPO))
    import memory as memory_cli
    if capsule_root is None:
        return memory_cli.new_verification_context(
            mode,
            remote_head,
            enforce_current_pointer=enforce_current_pointer,
        )
    return memory_cli.new_verification_context(
        mode,
        remote_head,
        repository_root=REPO,
        pointer_path=capsule_root / "artifacts" / "clued-two-level-snapshots" / "current.json",
        version_path=capsule_root / "VERSION",
        endpoint_trust_path=capsule_root / "config" / "clued-endpoint-trust.json",
        enforce_current_pointer=enforce_current_pointer,
    )


def recovery_validator_for(capsule_root: Path):
    state: dict[str, object] = {"expected_sha256": None, "context": None}

    def validate_recovery(root: Path, boundary: str, expected: dict) -> tuple[dict, list[str]]:
        expected_sha256 = hashlib.sha256(
            json.dumps(expected, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        if state["context"] is None:
            state["expected_sha256"] = expected_sha256
            state["context"] = new_verification_context(
                "AUDIT_FULL",
                expected["remote_head"],
                capsule_root=capsule_root,
                enforce_current_pointer=False,
            )
        elif state["expected_sha256"] != expected_sha256:
            return {}, ["recovery:prior-lkg-evidence-changed"]

        def validate_expected(path: Path) -> tuple[dict, list[str]]:
            manifest, errors = validate(path)
            errors = list(errors)
            try:
                generation = json.loads((path / MIRROR_GENERATION_FILENAME).read_text(encoding="utf-8"))
            except Exception as exc:
                return manifest, [*errors, f"recovery:generation-invalid:{exc}"]
            comparisons = {
                "snapshot-version": manifest.get("snapshot_version") == expected["snapshot_version"],
                "manifest-sha256": sha256_file(path / "manifest.json") == expected["manifest_sha256"],
                "generation-id": generation.get("generation_id") == expected["generation_id"],
                "generation-manifest": generation.get("manifest_sha256") == expected["manifest_sha256"],
                "generation-remote": generation.get("remote_head") == expected["remote_head"],
                "generation-target-identity": generation.get("target_identity_sha256") == expected["target_identity_sha256"],
                "generation-read-only": generation.get("read_only_sha256") == expected["read_only_sha256"],
            }
            errors.extend(
                f"recovery:{name}-mismatch" for name, matches in comparisons.items() if not matches
            )
            return manifest, errors

        context = state["context"]
        assert isinstance(context, RequestVerificationContext)
        return context.verify_bundle(root, validate_expected, boundary=boundary)

    return validate_recovery


def _validate_boundary(
    root: Path,
    context: RequestVerificationContext | None,
    boundary: str,
) -> tuple[dict, list[str]]:
    if context is None:
        return validate(root)
    return validate(root, context=context, boundary=boundary)


def mirror(
    remote_sha: str | None = None,
    context: RequestVerificationContext | None = None,
    *,
    emit: bool = True,
) -> dict:
    if context is not None and remote_sha is not None and context.remote_head != remote_sha:
        raise RuntimeError("request Remote Head does not match Verification Context")
    manifest, errors = _validate_boundary(REPO / "memory", context, "repository_source")
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
    _, copied_errors = _validate_boundary(temporary, context, "target_candidate")
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
    result = {
        "status": "mirrored",
        "snapshot_version": manifest["snapshot_version"],
        "canonical_version": manifest["canonical_version"],
        "backup": str(backup) if moved_old else None,
    }
    if remote_sha is not None:
        result["remote_head"] = remote_sha
    if emit:
        print(json.dumps(result, ensure_ascii=False))
    return result


def _doctor(
    context: RequestVerificationContext,
    *,
    require_local: bool,
    emit: bool,
    source_root: Path | None = None,
    source_manifest: dict | None = None,
) -> tuple[dict, dict | None, list[str]]:
    root = source_root or (REPO / "memory")
    if source_manifest is None:
        manifest, errors = _validate_boundary(root, context, "repository_source")
    else:
        manifest, errors = dict(source_manifest), []
    if errors:
        if emit:
            for error in errors:
                print(f"[FAIL] {error}")
            print(f"doctor: {len(errors)} FAILURE(S)")
        return manifest, None, errors
    if emit:
        print(f"[PASS] repository snapshot {manifest['snapshot_version']} / {manifest['canonical_version']}")
    local_manifest = None
    if LOCAL_MEMORY.exists():
        local_manifest, local_errors = _validate_boundary(LOCAL_MEMORY, context, "local_mirror")
        same = not local_errors and local_manifest.get("snapshot_version") == manifest.get("snapshot_version")
        if require_local and not same:
            errors.extend(local_errors or ["local-mirror:snapshot-version-mismatch"])
        if emit:
            state = "PASS" if same else ("FAIL" if require_local else "WARN")
            print(f"[{state}] local read-only mirror {'aligned' if same else 'not aligned'}")
    else:
        if require_local:
            errors.append("local-mirror:missing")
        if emit:
            print(f"[{'FAIL' if require_local else 'WARN'}] local read-only mirror does not exist")
    if emit:
        print("doctor: ALL PASS" if not errors else f"doctor: {len(errors)} FAILURE(S)")
    return manifest, local_manifest, errors


def cmd_doctor() -> int:
    context = new_verification_context("AUDIT_FULL")
    _, _, errors = _doctor(context, require_local=False, emit=True)
    return 1 if errors else 0


def resolve_remote_head() -> str:
    try:
        result = run("git", "ls-remote", "origin", "refs/heads/main")
    except RuntimeError as exc:
        raise RuntimeError(f"remote unavailable: {exc}") from exc
    fields = result.stdout.split()
    if len(fields) != 2 or fields[1] != "refs/heads/main" or not re.fullmatch(r"[0-9a-fA-F]{40}", fields[0]):
        raise RuntimeError("remote unavailable: origin/main did not resolve to a concrete commit SHA")
    return fields[0].lower()


class GitConflictPacketError(RuntimeError):
    def __init__(self, packet: dict) -> None:
        self.packet = packet
        super().__init__("git history divergence: " + json.dumps(packet, ensure_ascii=False, sort_keys=True))


def _ensure_remote_commit(remote_sha: str) -> None:
    if run("git", "cat-file", "-e", f"{remote_sha}^{{commit}}", check=False).returncode != 0:
        try:
            run("git", "fetch", "--no-tags", "--no-write-fetch-head", "origin", remote_sha)
        except RuntimeError as exc:
            raise RuntimeError(f"remote unavailable: {exc}") from exc
    resolved = run("git", "rev-parse", f"{remote_sha}^{{commit}}", check=False)
    if resolved.returncode or resolved.stdout.strip().lower() != remote_sha:
        raise RuntimeError("remote changed during isolated source acquisition; retry required")


def _changed_paths(base: str, tip: str) -> list[dict]:
    output = run("git", "diff", "--name-status", base, tip, check=False).stdout
    changes = []
    for line in output.splitlines():
        fields = line.split("\t")
        if len(fields) >= 2:
            changes.append({"status": fields[0], "path": fields[-1]})
    return changes


def classify_local_remote(remote_sha: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{40}", remote_sha):
        raise RuntimeError("invalid request remote SHA")
    _ensure_remote_commit(remote_sha)
    local_sha = run("git", "rev-parse", "HEAD").stdout.strip().lower()
    if local_sha == remote_sha:
        return {"classification": "equal", "local": local_sha, "remote": remote_sha}
    if run("git", "merge-base", "--is-ancestor", local_sha, remote_sha, check=False).returncode == 0:
        return {"classification": "remote-ahead", "local": local_sha, "remote": remote_sha}
    if run("git", "merge-base", "--is-ancestor", remote_sha, local_sha, check=False).returncode == 0:
        return {"classification": "local-ahead", "local": local_sha, "remote": remote_sha}
    base = run("git", "merge-base", local_sha, remote_sha, check=False).stdout.strip().lower()
    local_changes = _changed_paths(base, local_sha) if base else []
    remote_changes = _changed_paths(base, remote_sha) if base else []
    local_paths = {item["path"] for item in local_changes}
    remote_paths = {item["path"] for item in remote_changes}
    packet = {
        "contract": "clued.git-conflict-packet.v1",
        "error_class": "git-history-divergence",
        "canonical_cas_conflict": False,
        "base": base or "no-common-base",
        "local": local_sha,
        "remote": remote_sha,
        "local_changes": local_changes,
        "remote_changes": remote_changes,
        "overlapping_paths": sorted(local_paths & remote_paths),
        "automatic_merge_attempted": False,
        "worktree_overwrite_attempted": False,
    }
    packet["evidence_sha256"] = hashlib.sha256(
        json.dumps(packet, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    raise GitConflictPacketError(packet)


def _run_binary(*args: str) -> bytes:
    result = subprocess.run(args, cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace").strip())
    return result.stdout


def extract_snapshot_capsule(remote_sha: str, destination: Path) -> Path:
    archive = _run_binary(
        "git",
        "archive",
        "--format=tar",
        remote_sha,
        "memory",
        "artifacts/clued-two-level-snapshots/current.json",
        "VERSION",
        "config/clued-endpoint-trust.json",
    )
    destination.mkdir(parents=True, exist_ok=False)
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as bundle:
        destination_root = destination.resolve()
        for member in bundle.getmembers():
            member_path = (destination / member.name).resolve(strict=False)
            if destination_root not in member_path.parents and member_path != destination_root:
                raise RuntimeError("unsafe path in isolated repository archive")
            if member.issym() or member.islnk():
                raise RuntimeError("links are not allowed in isolated repository archive")
        bundle.extractall(destination, filter="data")
    required = (
        destination / "memory" / "manifest.json",
        destination / "artifacts" / "clued-two-level-snapshots" / "current.json",
        destination / "VERSION",
        destination / "config" / "clued-endpoint-trust.json",
    )
    if not all(path.is_file() for path in required):
        raise RuntimeError("isolated repository archive is incomplete")
    return destination


def _local_backup_root() -> Path:
    return Path(os.environ.get("CROSS_MEMORY_BACKUP_DIR", LOCAL_MEMORY.parent / "memory-backups"))


def _backup_policy_path() -> Path:
    return Path(os.environ.get(
        "CROSS_MEMORY_BACKUP_POLICY",
        REPO / "config" / "clued-local-mirror-backup-policy.json",
    ))


def isolated_read_request(remote_sha: str) -> tuple[dict, RequestVerificationContext, Path, tempfile.TemporaryDirectory]:
    classification = classify_local_remote(remote_sha)
    backup_root = _local_backup_root()
    request_root = backup_root / ".requests"
    request_root.mkdir(parents=True, exist_ok=True)
    temporary = tempfile.TemporaryDirectory(prefix="p3-source-", dir=request_root)
    capsule_root = extract_snapshot_capsule(remote_sha, Path(temporary.name) / "capsule")
    context = new_verification_context("REPO_IMPLEMENT", remote_sha, capsule_root=capsule_root)
    coordinator = MirrorCoordinator(
        target=LOCAL_MEMORY,
        backup_root=backup_root,
        policy_path=_backup_policy_path(),
        raw_validator=lambda root: validate(root),
        recovery_validator=recovery_validator_for(capsule_root),
    )
    result = coordinator.apply(
        source=capsule_root / "memory",
        context=context,
        validate_boundary=lambda root, boundary: _validate_boundary(root, context, boundary),
        remote_head=remote_sha,
    )
    result["git_classification"] = classification
    return result, context, capsule_root, temporary


def align_to_remote(remote_sha: str) -> None:
    if not re.fullmatch(r"[0-9a-f]{40}", remote_sha):
        raise RuntimeError("invalid request remote SHA")
    local = run("git", "rev-parse", "HEAD").stdout.strip().lower()
    if local != remote_sha:
        run("git", "fetch", "origin", remote_sha)
        fetched = run("git", "rev-parse", "FETCH_HEAD").stdout.strip().lower()
        if fetched != remote_sha:
            raise RuntimeError("remote changed during alignment; retry required")
        if run("git", "merge-base", "--is-ancestor", local, remote_sha, check=False).returncode == 0:
            run("git", "-c", "user.name=Codex@TURING", "-c", "user.email=tdoljyj@users.noreply.github.com", "merge", "--no-edit", remote_sha)
        elif run("git", "merge-base", "--is-ancestor", remote_sha, local, check=False).returncode != 0:
            raise RuntimeError("local and origin/main diverged; semantic merge required")


def align_and_verify() -> str:
    if run("git", "status", "--porcelain", check=False).stdout.strip():
        raise RuntimeError("refusing pull: repository worktree is dirty")
    remote_sha = resolve_remote_head()
    align_to_remote(remote_sha)
    return remote_sha


def cmd_align_and_verify(access: str) -> int:
    if access.upper() == "NONE":
        print("Memory Access = NONE; skipping pull (no recall scope).")
        return 0
    remote_sha = resolve_remote_head()
    temporary = None
    try:
        result, context, capsule_root, temporary = isolated_read_request(remote_sha)
        source_manifest = result.pop("_source_manifest")
        if result["status"] == "stale-skipped":
            result["authoritative"] = False
            result["retry_required"] = True
            print(json.dumps(result, ensure_ascii=False))
            return 0
        manifest, local_manifest, errors = _doctor(
            context,
            require_local=True,
            emit=True,
            source_root=capsule_root / "memory",
            source_manifest=source_manifest,
        )
        if errors or local_manifest is None:
            raise RuntimeError("post-mirror doctor failed: " + "; ".join(errors[:10]))
        sources = context.source_envelope(
            boundary="local_mirror",
            sources_read=(
                "isolated-repository-source/memory/manifest.json",
                "isolated-repository-source/artifacts/clued-two-level-snapshots/current.json",
                "local-mirror/manifest.json",
            ),
            source_versions=(manifest["snapshot_version"], local_manifest["snapshot_version"]),
            freshness="historical",
            degraded_reason=None,
        )
        result["verification"] = context.summary(boundary="local_mirror", sources=sources)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    finally:
        if temporary is not None:
            temporary.cleanup()


def cmd_pull(access: str) -> int:
    """Backward-compatible alias for the unified request entry."""
    return cmd_align_and_verify(access)


def cmd_push() -> int:
    print("push rejected: memory/ and the local mirror are read-only derived views; write once through authenticated Clued M1 APIs.", file=sys.stderr)
    return 2


def cmd_bootstrap() -> int:
    run("git", "config", "core.autocrlf", "false")
    run("git", "config", "maintenance.auto", "false")
    print("bootstrap complete (v1.6 read-only snapshot consumer)")
    return 0


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "doctor"
    if mode == "doctor":
        return cmd_doctor()
    if mode in {"align-and-verify", "pull"}:
        return cmd_align_and_verify(sys.argv[2] if len(sys.argv) > 2 else "MULTI")
    if mode == "push":
        return cmd_push()
    if mode == "bootstrap":
        return cmd_bootstrap()
    if mode == "mirror":
        context = new_verification_context("AUDIT_FULL")
        mirror(context=context)
        return 0
    raise RuntimeError(f"unknown mode: {mode}")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"sync failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
