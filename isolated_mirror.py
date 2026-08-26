"""P3 isolated local mirror, lock, generation, rollback, and backup retention.

This module owns only the local read-only consumer mirror.  It never publishes
or mutates the repository Snapshot, Manifest, or formal Current Pointer.
"""

from __future__ import annotations

import datetime as dt
import contextlib
import hashlib
import json
import os
import re
import shutil
import stat
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from verification_context import (
    MIRROR_GENERATION_CONTRACT,
    MIRROR_GENERATION_FILENAME,
    PathIdentity,
    RequestVerificationContext,
    sha256_file,
)


BACKUP_POLICY_CONTRACT = "clued.local-mirror-backup-policy.v1"
AUDIT_CONTRACT = "clued.local-mirror-audit.v1"
BACKUP_RECORD_CONTRACT = "clued.local-mirror-backup-record.v1"
BACKUP_CONTROL_CONTRACT = "clued.local-mirror-backup-control.v1"
BACKUP_RECORD_FILENAME = ".clued-backup-record.json"
BACKUP_CONTROL_FILENAME = ".clued-backup-control.json"
AUDIT_FILENAME = "p3-mirror-audit.jsonl"
SWITCH_JOURNAL_CONTRACT = "clued.local-mirror-switch-journal.v1"


class MirrorError(RuntimeError):
    """The isolated mirror failed closed."""


class MirrorLockTimeout(MirrorError):
    """The per-target cross-process lock could not be acquired in time."""


Validator = Callable[[Path], tuple[dict, list[str]]]
BoundaryValidator = Callable[[Path, str], tuple[dict, list[str]]]
CandidateMutator = Callable[[Path], None]
SwitchHook = Callable[[str, Path, Path | None], None]


def _canonical_json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _hash_json(value: object) -> str:
    return hashlib.sha256(_canonical_json(value)).hexdigest()


def _iso(epoch: float) -> str:
    return dt.datetime.fromtimestamp(epoch, tz=dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _atomic_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    with temporary.open("w", encoding="utf-8", newline="\n") as stream:
        stream.write(encoded)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def _resolved(path: Path) -> Path:
    return Path(os.path.abspath(path)).resolve(strict=False)


def _is_within(path: Path, parent: Path) -> bool:
    try:
        _resolved(path).relative_to(_resolved(parent))
        return True
    except ValueError:
        return False


def _safe_remove(path: Path, parent: Path) -> None:
    absolute = Path(os.path.abspath(path))
    allowed = Path(os.path.abspath(parent))
    if absolute == allowed or not _is_within(absolute, allowed):
        raise MirrorError(f"unsafe removal target: {absolute}")
    if absolute.is_symlink() or bool(getattr(absolute, "is_junction", lambda: False)()):
        absolute.unlink(missing_ok=True)
    elif absolute.exists():
        for child in absolute.rglob("*"):
            with contextlib.suppress(OSError):
                child.chmod(stat.S_IREAD | stat.S_IWRITE | stat.S_IEXEC)
        with contextlib.suppress(OSError):
            absolute.chmod(stat.S_IREAD | stat.S_IWRITE | stat.S_IEXEC)
        shutil.rmtree(absolute)


def lock_path_for_target(target: Path) -> Path:
    target = Path(os.path.abspath(target))
    return target.parent / f".{target.name}.p3.lock"


def journal_path_for_target(target: Path) -> Path:
    target = Path(os.path.abspath(target))
    return target.parent / f".{target.name}.p3-switch-journal.json"


class ExclusiveFileLock:
    """Advisory OS lock released automatically when a holder process exits."""

    def __init__(self, path: Path, *, timeout_seconds: float = 30.0, poll_seconds: float = 0.05) -> None:
        self.path = path
        self.timeout_seconds = float(timeout_seconds)
        self.poll_seconds = float(poll_seconds)
        self._stream = None
        self.wait_seconds = 0.0

    def acquire(self) -> "ExclusiveFileLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        stream = self.path.open("a+b")
        if stream.seek(0, os.SEEK_END) == 0:
            stream.write(b"\0")
            stream.flush()
        started = time.monotonic()
        while True:
            try:
                stream.seek(0)
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except (BlockingIOError, OSError):
                if time.monotonic() - started >= self.timeout_seconds:
                    stream.close()
                    raise MirrorLockTimeout(f"mirror lock timeout: {self.path}")
                time.sleep(self.poll_seconds)
        self._stream = stream
        self.wait_seconds = max(0.0, time.monotonic() - started)
        return self

    def release(self) -> None:
        if self._stream is None:
            return
        try:
            self._stream.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self._stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._stream.fileno(), fcntl.LOCK_UN)
        finally:
            self._stream.close()
            self._stream = None

    def __enter__(self) -> "ExclusiveFileLock":
        return self.acquire()

    def __exit__(self, exc_type, exc, traceback) -> None:
        self.release()


@dataclass(frozen=True)
class BackupPolicy:
    policy_version: str
    max_retained_backups: int
    max_retention_seconds: int
    minimum_verified_lkg: int
    legal_hold_blocks_deletion: bool
    erasure_mode: str
    audit_contract: str

    @classmethod
    def load(cls, path: Path) -> "BackupPolicy":
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise MirrorError("backup policy unavailable") from exc
        if not isinstance(payload, dict) or payload.get("contract") != BACKUP_POLICY_CONTRACT:
            raise MirrorError("backup policy contract invalid")
        values = cls(
            policy_version=str(payload.get("policy_version", "")),
            max_retained_backups=payload.get("max_retained_backups"),
            max_retention_seconds=payload.get("max_retention_seconds"),
            minimum_verified_lkg=payload.get("minimum_verified_lkg"),
            legal_hold_blocks_deletion=payload.get("legal_hold_blocks_deletion"),
            erasure_mode=str(payload.get("erasure_mode", "")),
            audit_contract=str(payload.get("audit_contract", "")),
        )
        if (
            not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", values.policy_version)
            or not isinstance(values.max_retained_backups, int)
            or values.max_retained_backups < 1
            or not isinstance(values.max_retention_seconds, int)
            or values.max_retention_seconds < 1
            or not isinstance(values.minimum_verified_lkg, int)
            or values.minimum_verified_lkg < 1
            or values.minimum_verified_lkg > values.max_retained_backups
            or values.legal_hold_blocks_deletion is not True
            or values.erasure_mode != "delete-if-eligible"
            or values.audit_contract != AUDIT_CONTRACT
        ):
            raise MirrorError("backup policy values invalid")
        return values


@dataclass(frozen=True)
class MirrorGeneration:
    generation_id: str
    order_key: tuple[str, str, str]
    snapshot_version: str
    canonical_version: str
    manifest_sha256: str
    remote_head: str

    @classmethod
    def from_manifest(cls, manifest: dict, manifest_sha256: str, remote_head: str) -> "MirrorGeneration":
        snapshot = manifest.get("snapshot_version")
        canonical = manifest.get("canonical_version")
        build_epoch = manifest.get("build_epoch")
        if not isinstance(snapshot, str) or not snapshot:
            raise MirrorError("snapshot version missing for Mirror Generation")
        if not isinstance(canonical, str) or not re.fullmatch(r"cv_[0-9]+", canonical):
            raise MirrorError("canonical version invalid for Mirror Generation")
        if not isinstance(build_epoch, str) or not build_epoch.endswith("Z"):
            raise MirrorError("build epoch invalid for Mirror Generation")
        try:
            dt.datetime.fromisoformat(build_epoch.replace("Z", "+00:00"))
        except ValueError as exc:
            raise MirrorError("build epoch invalid for Mirror Generation") from exc
        if not re.fullmatch(r"[0-9a-f]{64}", manifest_sha256):
            raise MirrorError("manifest SHA-256 invalid for Mirror Generation")
        if not re.fullmatch(r"[0-9a-f]{40}", remote_head):
            raise MirrorError("remote head invalid for Mirror Generation")
        canonical_order = f"{int(canonical.removeprefix('cv_')):020d}"
        order_key = (build_epoch, canonical_order, snapshot)
        generation_id = _hash_json({
            "snapshot_version": snapshot,
            "manifest_sha256": manifest_sha256,
            "order_key": list(order_key),
        })
        return cls(generation_id, order_key, snapshot, canonical, manifest_sha256, remote_head)

    def as_payload(
        self,
        *,
        target_identity_sha256: str,
        read_only_sha256: str,
        activated_at: float,
    ) -> dict:
        return {
            "contract": MIRROR_GENERATION_CONTRACT,
            "generation_id": self.generation_id,
            "order_key": list(self.order_key),
            "snapshot_version": self.snapshot_version,
            "canonical_version": self.canonical_version,
            "manifest_sha256": self.manifest_sha256,
            "remote_head": self.remote_head,
            "target_identity_sha256": target_identity_sha256,
            "read_only_sha256": read_only_sha256,
            "activated_at": _iso(activated_at),
        }


def _load_generation(root: Path) -> dict | None:
    path = root / MIRROR_GENERATION_FILENAME
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise MirrorError("mirror generation metadata invalid") from exc
    if not isinstance(payload, dict):
        raise MirrorError("mirror generation metadata invalid")
    generation_id = payload.get("generation_id")
    order_key = payload.get("order_key")
    manifest_sha256 = payload.get("manifest_sha256")
    expected = _hash_json({
        "snapshot_version": payload.get("snapshot_version"),
        "manifest_sha256": manifest_sha256,
        "order_key": order_key,
    })
    if (
        payload.get("contract") != MIRROR_GENERATION_CONTRACT
        or not isinstance(generation_id, str)
        or generation_id != expected
        or not isinstance(order_key, list)
        or len(order_key) != 3
        or not all(isinstance(value, str) and value for value in order_key)
        or not isinstance(manifest_sha256, str)
        or not re.fullmatch(r"[0-9a-f]{64}", manifest_sha256)
        or not isinstance(payload.get("target_identity_sha256"), str)
        or not isinstance(payload.get("read_only_sha256"), str)
    ):
        raise MirrorError("mirror generation metadata invalid")
    return payload


def _read_only_fingerprint(root: Path, manifest: dict) -> str:
    paths = [root]
    for item in manifest.get("files", []):
        rel = item.get("path") if isinstance(item, dict) else None
        if isinstance(rel, str):
            paths.append(root / rel)
    details = []
    for path in paths:
        info = path.stat()
        details.append({
            "path": "." if path == root else path.relative_to(root).as_posix(),
            "mode": stat.S_IMODE(info.st_mode),
            "file_attributes": getattr(info, "st_file_attributes", None),
        })
    return _hash_json(details)


def _set_tree_read_only(root: Path) -> None:
    files = [path for path in root.rglob("*") if path.is_file()]
    directories = sorted((path for path in root.rglob("*") if path.is_dir()), key=lambda p: len(p.parts), reverse=True)
    for path in files:
        path.chmod(stat.S_IREAD)
    for path in directories:
        path.chmod(stat.S_IREAD | stat.S_IEXEC)
    root.chmod(stat.S_IREAD | stat.S_IEXEC)


def _make_root_writable(root: Path) -> None:
    root.chmod(stat.S_IREAD | stat.S_IWRITE | stat.S_IEXEC)


class AuditTrail:
    def __init__(self, path: Path, *, policy: BackupPolicy, clock: Callable[[], float]) -> None:
        self.path = path
        self.policy = policy
        self.clock = clock

    def emit(self, event: str, **details) -> dict:
        payload = {
            "contract": self.policy.audit_contract,
            "policy_version": self.policy.policy_version,
            "event_id": uuid.uuid4().hex,
            "at": _iso(self.clock()),
            "event": event,
            **details,
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        return payload


@dataclass
class BackupInfo:
    path: Path
    backup_id: str
    created_at: float
    verified: bool
    legal_hold: bool
    erasure_requested: bool


class MirrorCoordinator:
    def __init__(
        self,
        *,
        target: Path,
        backup_root: Path,
        policy_path: Path,
        raw_validator: Validator,
        lock_timeout_seconds: float = 30.0,
        clock: Callable[[], float] = time.time,
        request_id_factory: Callable[[], str] = lambda: uuid.uuid4().hex,
    ) -> None:
        self.target = Path(os.path.abspath(target))
        self.backup_root = Path(os.path.abspath(backup_root))
        self.policy = BackupPolicy.load(policy_path)
        self.raw_validator = raw_validator
        self.lock_timeout_seconds = float(lock_timeout_seconds)
        self.clock = clock
        self.request_id_factory = request_id_factory
        self.audit = AuditTrail(self.backup_root / AUDIT_FILENAME, policy=self.policy, clock=clock)

    def _assert_same_volume(self) -> None:
        self.target.parent.mkdir(parents=True, exist_ok=True)
        self.backup_root.mkdir(parents=True, exist_ok=True)
        target_device = self.target.parent.stat().st_dev
        backup_device = self.backup_root.stat().st_dev
        if target_device != backup_device:
            raise MirrorError("target, Candidate, and Backup must share one volume")

    def _candidate_path(self, request_id: str) -> Path:
        return self.target.parent / f".{self.target.name}.candidate-{request_id}"

    def _backup_path(self, generation: dict | None, request_id: str) -> Path:
        generation_id = generation.get("generation_id", "legacy") if generation else "legacy"
        order = generation.get("order_key", ["legacy"])[0] if generation else "legacy"
        safe_order = re.sub(r"[^0-9A-Za-z]+", "", str(order))[:24] or "legacy"
        return self.backup_root / f"backup-{safe_order}-{generation_id[:12]}-{request_id[:12]}"

    def _sweep_stale_candidates(self, request_id: str) -> None:
        prefix = f".{self.target.name}.candidate-"
        for path in self.target.parent.iterdir():
            if path.name.startswith(prefix):
                _safe_remove(path, self.target.parent)
                self.audit.emit("candidate_recovered", request_id=request_id, candidate=str(path))

    def _recover_interrupted_switch(self, request_id: str) -> None:
        journal_path = journal_path_for_target(self.target)
        if not journal_path.is_file():
            return
        try:
            journal = json.loads(journal_path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise MirrorError("switch journal invalid; manual recovery required") from exc
        if journal.get("contract") != SWITCH_JOURNAL_CONTRACT or journal.get("target") != str(self.target):
            raise MirrorError("switch journal target mismatch; manual recovery required")
        backup = Path(journal["backup"]) if journal.get("backup") else None
        candidate = Path(journal["candidate"]) if journal.get("candidate") else None
        if backup is not None and backup.exists():
            if self.target.exists() or self.target.is_symlink():
                _safe_remove(self.target, self.target.parent)
            os.replace(backup, self.target)
            _, errors = self.raw_validator(self.target)
            if errors:
                raise MirrorError("recovered LKG failed validation")
        elif self.target.exists() or self.target.is_symlink():
            _safe_remove(self.target, self.target.parent)
        if candidate is not None and (candidate.exists() or candidate.is_symlink()):
            _safe_remove(candidate, self.target.parent)
        journal_path.unlink(missing_ok=True)
        self.audit.emit("interrupted_switch_recovered", request_id=request_id, phase=journal.get("phase"))

    def _write_journal(self, *, phase: str, candidate: Path, backup: Path | None, request_id: str) -> None:
        _atomic_json(journal_path_for_target(self.target), {
            "contract": SWITCH_JOURNAL_CONTRACT,
            "request_id": request_id,
            "phase": phase,
            "target": str(self.target),
            "candidate": str(candidate),
            "backup": str(backup) if backup is not None else None,
        })

    def _validate_existing(self) -> tuple[dict, dict | None]:
        manifest, errors = self.raw_validator(self.target)
        if errors:
            raise MirrorError("existing mirror is not a verified LKG: " + "; ".join(errors[:10]))
        generation = _load_generation(self.target)
        if generation is not None:
            if generation.get("snapshot_version") != manifest.get("snapshot_version"):
                raise MirrorError("existing Mirror Generation snapshot mismatch")
            if generation.get("manifest_sha256") != sha256_file(self.target / "manifest.json"):
                raise MirrorError("existing Mirror Generation Manifest mismatch")
        return manifest, generation

    def _identity_is_current(self, generation: dict, manifest: dict) -> bool:
        identity = PathIdentity.capture(self.target).fingerprint()
        read_only = _read_only_fingerprint(self.target, manifest)
        return (
            generation.get("target_identity_sha256") == identity
            and generation.get("read_only_sha256") == read_only
        )

    def _finalize_generation(self, generation: MirrorGeneration, manifest: dict) -> dict:
        metadata_path = self.target / MIRROR_GENERATION_FILENAME
        _make_root_writable(self.target)
        provisional = generation.as_payload(
            target_identity_sha256="pending",
            read_only_sha256="pending",
            activated_at=self.clock(),
        )
        _atomic_json(metadata_path, provisional)
        _set_tree_read_only(self.target)
        identity = PathIdentity.capture(self.target).fingerprint()
        read_only = _read_only_fingerprint(self.target, manifest)
        _make_root_writable(self.target)
        metadata_path.chmod(stat.S_IREAD | stat.S_IWRITE)
        final = generation.as_payload(
            target_identity_sha256=identity,
            read_only_sha256=read_only,
            activated_at=self.clock(),
        )
        _atomic_json(metadata_path, final)
        metadata_path.chmod(stat.S_IREAD)
        self.target.chmod(stat.S_IREAD | stat.S_IEXEC)
        if PathIdentity.capture(self.target).fingerprint() != identity:
            raise MirrorError("target identity changed while finalizing Mirror Generation")
        if _read_only_fingerprint(self.target, manifest) != read_only:
            raise MirrorError("read-only identity changed while finalizing Mirror Generation")
        return final

    def _write_backup_record(self, backup: Path, *, request_id: str, generation: dict | None) -> None:
        _make_root_writable(backup)
        _atomic_json(backup / BACKUP_RECORD_FILENAME, {
            "contract": BACKUP_RECORD_CONTRACT,
            "backup_id": backup.name,
            "created_at_epoch": self.clock(),
            "created_at": _iso(self.clock()),
            "source_target": str(self.target),
            "generation_id": generation.get("generation_id") if generation else "legacy",
            "request_id": request_id,
            "verified_lkg": True,
        })
        _set_tree_read_only(backup)

    def _backup_info(self, path: Path) -> BackupInfo:
        record_path = path / BACKUP_RECORD_FILENAME
        try:
            record = json.loads(record_path.read_text(encoding="utf-8"))
        except Exception:
            record = {}
        control_path = path / BACKUP_CONTROL_FILENAME
        try:
            control = json.loads(control_path.read_text(encoding="utf-8")) if control_path.is_file() else {}
        except Exception:
            control = {"invalid": True}
        manifest, errors = self.raw_validator(path)
        verified = (
            not errors
            and record.get("contract") == BACKUP_RECORD_CONTRACT
            and record.get("backup_id") == path.name
            and record.get("verified_lkg") is True
        )
        if control and control.get("contract") not in {None, BACKUP_CONTROL_CONTRACT}:
            verified = False
        return BackupInfo(
            path=path,
            backup_id=path.name,
            created_at=float(record.get("created_at_epoch", 0.0)),
            verified=verified,
            legal_hold=control.get("legal_hold") is True,
            erasure_requested=control.get("erasure_requested") is True,
        )

    def enforce_retention(self, *, request_id: str, candidate: Path | None = None) -> dict:
        backups = [self._backup_info(path) for path in self.backup_root.glob("backup-*") if path.is_dir()]
        backups.sort(key=lambda item: (item.created_at, item.backup_id), reverse=True)
        verified = [item for item in backups if item.verified]
        protected_ids = {item.backup_id for item in verified[: self.policy.minimum_verified_lkg]}
        remaining_verified = len(verified)
        deleted: list[str] = []
        retained: list[str] = []
        skipped: list[str] = []
        now = self.clock()
        for info in sorted(backups, key=lambda item: (item.created_at, item.backup_id)):
            if info.legal_hold:
                retained.append(info.backup_id)
                self.audit.emit("backup_retain_hold", request_id=request_id, backup_id=info.backup_id, erasure_requested=info.erasure_requested)
                continue
            if not info.verified:
                skipped.append(info.backup_id)
                self.audit.emit("backup_skip_unverified", request_id=request_id, backup_id=info.backup_id, erasure_requested=info.erasure_requested)
                continue
            over_count = remaining_verified > self.policy.max_retained_backups
            expired = now - info.created_at > self.policy.max_retention_seconds
            requested = info.erasure_requested and self.policy.erasure_mode == "delete-if-eligible"
            if info.backup_id in protected_ids or remaining_verified <= self.policy.minimum_verified_lkg:
                retained.append(info.backup_id)
                event = "backup_erasure_skipped_only_lkg" if requested else "backup_retain_minimum_lkg"
                self.audit.emit(event, request_id=request_id, backup_id=info.backup_id)
                continue
            if not (requested or over_count or expired):
                retained.append(info.backup_id)
                self.audit.emit("backup_retain", request_id=request_id, backup_id=info.backup_id)
                continue
            resolved = _resolved(info.path)
            forbidden = {_resolved(self.target)}
            if candidate is not None:
                forbidden.add(_resolved(candidate))
            if resolved in forbidden:
                skipped.append(info.backup_id)
                self.audit.emit("backup_delete_skipped_active_target", request_id=request_id, backup_id=info.backup_id)
                continue
            reconfirmed = self._backup_info(info.path)
            if not reconfirmed.verified or reconfirmed.legal_hold or remaining_verified <= self.policy.minimum_verified_lkg:
                skipped.append(info.backup_id)
                self.audit.emit(
                    "backup_delete_skipped_recheck",
                    request_id=request_id,
                    backup_id=info.backup_id,
                    legal_hold=reconfirmed.legal_hold,
                    erasure_requested=reconfirmed.erasure_requested,
                )
                continue
            try:
                _safe_remove(info.path, self.backup_root)
            except Exception as exc:
                skipped.append(info.backup_id)
                self.audit.emit("backup_delete_failed", request_id=request_id, backup_id=info.backup_id, reason=str(exc))
                continue
            remaining_verified -= 1
            deleted.append(info.backup_id)
            self.audit.emit(
                "backup_deleted",
                request_id=request_id,
                backup_id=info.backup_id,
                reason="erasure" if requested else ("age" if expired else "count"),
            )
        return {"retained": retained, "skipped": skipped, "deleted": deleted}

    def apply(
        self,
        *,
        source: Path,
        context: RequestVerificationContext,
        validate_boundary: BoundaryValidator,
        remote_head: str,
        candidate_mutator: CandidateMutator | None = None,
        switch_hook: SwitchHook | None = None,
    ) -> dict:
        request_id = self.request_id_factory()
        self._assert_same_volume()
        lock = ExclusiveFileLock(lock_path_for_target(self.target), timeout_seconds=self.lock_timeout_seconds)
        with lock:
            self.audit.emit("lock_acquired", request_id=request_id, wait_seconds=round(lock.wait_seconds, 6), target=str(self.target))
            self._recover_interrupted_switch(request_id)
            self._sweep_stale_candidates(request_id)
            source_manifest, source_errors = validate_boundary(source, "repository_source")
            if source_errors:
                self.audit.emit("source_rejected", request_id=request_id, errors=source_errors[:10])
                raise MirrorError("canonical snapshot invalid: " + "; ".join(source_errors[:10]))
            generation = MirrorGeneration.from_manifest(
                source_manifest,
                sha256_file(source / "manifest.json"),
                remote_head,
            )
            current_manifest = None
            current_generation = None
            if self.target.exists() or self.target.is_symlink():
                current_manifest, current_generation = self._validate_existing()
                if current_generation is not None and not self._identity_is_current(current_generation, current_manifest):
                    if current_generation.get("generation_id") == generation.generation_id:
                        validate_boundary(self.target, "local_mirror")
                    self.audit.emit("no_op_evidence_invalidated", request_id=request_id, reason="target-identity-or-read-only-changed")
                    raise MirrorError("no-op Evidence invalid: target identity, ACL, volume, or read-only state changed")
                if current_generation is not None and current_generation.get("generation_id") == generation.generation_id:
                    _, local_errors = validate_boundary(self.target, "local_mirror")
                    if local_errors:
                        self.audit.emit("no_op_evidence_invalidated", request_id=request_id, reason="local-validation-failed", errors=local_errors[:10])
                        raise MirrorError("local mirror invalid: " + "; ".join(local_errors[:10]))
                    retention = self.enforce_retention(request_id=request_id)
                    self.audit.emit("mirror_noop", request_id=request_id, generation_id=generation.generation_id, snapshot_version=generation.snapshot_version)
                    self.audit.emit("lock_released", request_id=request_id, target=str(self.target))
                    return {
                        "status": "noop",
                        "snapshot_version": generation.snapshot_version,
                        "canonical_version": generation.canonical_version,
                        "remote_head": remote_head,
                        "generation": generation.as_payload(
                            target_identity_sha256=current_generation["target_identity_sha256"],
                            read_only_sha256=current_generation["read_only_sha256"],
                            activated_at=self.clock(),
                        ),
                        "backup": None,
                        "retention": retention,
                        "audit": str(self.audit.path),
                        "_source_manifest": source_manifest,
                    }
                if (
                    current_generation is not None
                    and current_manifest.get("snapshot_version") == generation.snapshot_version
                ):
                    _, local_errors = validate_boundary(self.target, "local_mirror")
                    self.audit.emit(
                        "no_op_evidence_invalidated",
                        request_id=request_id,
                        reason="mirror-generation-changed",
                        errors=local_errors[:10],
                    )
                    raise MirrorError("no-op Evidence invalid: Mirror Generation changed")
                if current_generation is not None:
                    current_order = tuple(current_generation["order_key"])
                    if generation.order_key < current_order:
                        retention = self.enforce_retention(request_id=request_id)
                        self.audit.emit("mirror_stale_skipped", request_id=request_id, incoming_order=list(generation.order_key), current_order=list(current_order))
                        self.audit.emit("lock_released", request_id=request_id, target=str(self.target))
                        return {
                            "status": "stale-skipped",
                            "snapshot_version": current_manifest["snapshot_version"],
                            "remote_head": remote_head,
                            "backup": None,
                            "retention": retention,
                            "audit": str(self.audit.path),
                            "_source_manifest": source_manifest,
                        }
                    if generation.order_key == current_order:
                        self.audit.emit("generation_conflict", request_id=request_id, order_key=list(generation.order_key))
                        raise MirrorError("different Snapshots have the same deterministic Generation order")

            candidate = self._candidate_path(request_id)
            if candidate.exists() or candidate.is_symlink():
                _safe_remove(candidate, self.target.parent)
            shutil.copytree(source, candidate)
            provisional = generation.as_payload(
                target_identity_sha256="pending",
                read_only_sha256="pending",
                activated_at=self.clock(),
            )
            _atomic_json(candidate / MIRROR_GENERATION_FILENAME, provisional)
            if candidate_mutator is not None:
                candidate_mutator(candidate)
            candidate_manifest, candidate_errors = validate_boundary(candidate, "target_candidate")
            if candidate_errors:
                _safe_remove(candidate, self.target.parent)
                self.audit.emit("candidate_rejected", request_id=request_id, errors=candidate_errors[:10])
                raise MirrorError("local candidate invalid: " + "; ".join(candidate_errors[:10]))
            if (
                candidate_manifest.get("snapshot_version") != source_manifest.get("snapshot_version")
                or sha256_file(candidate / "manifest.json") != generation.manifest_sha256
            ):
                _safe_remove(candidate, self.target.parent)
                self.audit.emit("candidate_rejected", request_id=request_id, errors=["source-target-identity-mismatch"])
                raise MirrorError("local candidate invalid: source-target identity mismatch")

            backup = self._backup_path(current_generation, request_id) if self.target.exists() else None
            self._write_journal(phase="prepared", candidate=candidate, backup=backup, request_id=request_id)
            try:
                if backup is not None:
                    os.replace(self.target, backup)
                    self._write_journal(phase="old-moved", candidate=candidate, backup=backup, request_id=request_id)
                    if switch_hook is not None:
                        switch_hook("after_backup", candidate, backup)
                os.replace(candidate, self.target)
                self._write_journal(phase="candidate-promoted", candidate=candidate, backup=backup, request_id=request_id)
                if switch_hook is not None:
                    switch_hook("after_candidate_promoted", self.target, backup)
                final_generation = self._finalize_generation(generation, candidate_manifest)
                _, local_errors = validate_boundary(self.target, "local_mirror")
                if local_errors:
                    raise MirrorError("local mirror invalid after switch: " + "; ".join(local_errors[:10]))
                if backup is not None:
                    self._write_backup_record(backup, request_id=request_id, generation=current_generation)
                journal_path_for_target(self.target).unlink(missing_ok=True)
            except Exception as exc:
                if self.target.exists() or self.target.is_symlink():
                    _safe_remove(self.target, self.target.parent)
                if backup is not None and backup.exists():
                    os.replace(backup, self.target)
                    _, restored_errors = self.raw_validator(self.target)
                    if restored_errors:
                        self.audit.emit("rollback_failed", request_id=request_id, errors=restored_errors[:10])
                        raise MirrorError("switch failed and prior LKG could not be restored") from exc
                    self.audit.emit("rollback_restored_lkg", request_id=request_id, reason=str(exc))
                else:
                    self.audit.emit("switch_failed_no_prior_lkg", request_id=request_id, reason=str(exc))
                if candidate.exists() or candidate.is_symlink():
                    _safe_remove(candidate, self.target.parent)
                journal_path_for_target(self.target).unlink(missing_ok=True)
                raise MirrorError(f"mirror switch failed: {exc}") from exc

            self.audit.emit(
                "mirror_switched",
                request_id=request_id,
                generation_id=generation.generation_id,
                order_key=list(generation.order_key),
                snapshot_version=generation.snapshot_version,
                backup=str(backup) if backup is not None else None,
            )
            retention = self.enforce_retention(request_id=request_id)
            self.audit.emit("lock_released", request_id=request_id, target=str(self.target))
            return {
                "status": "mirrored",
                "snapshot_version": generation.snapshot_version,
                "canonical_version": generation.canonical_version,
                "remote_head": remote_head,
                "generation": final_generation,
                "backup": str(backup) if backup is not None else None,
                "retention": retention,
                "audit": str(self.audit.path),
                "_source_manifest": source_manifest,
            }
