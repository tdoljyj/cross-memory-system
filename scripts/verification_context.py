"""Request-local verification evidence for Clued read-only snapshot operations.

The context is deliberately process-memory-only.  It reuses a successful
validator result only after independently re-checking every bound identity,
including a streaming content fingerprint.  It is not an authorization cache
and never crosses a source/target trust boundary.
"""

from __future__ import annotations

import ctypes
import datetime as dt
import hashlib
import json
import os
import re
import stat
import subprocess
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable


CONTEXT_MODES = frozenset({
    "READ_ONLINE_CURRENT",
    "READ_SNAPSHOT_LKG",
    "READ_SNAPSHOT_HISTORICAL",
    "WRITE_CANONICAL",
    "SNAPSHOT_PUBLISH",
    "REPO_IMPLEMENT",
    "AUDIT_FULL",
})
VALIDATOR_CONTRACT_VERSION = "clued-request-verifier-v1"
DOCTOR_VERSION = "clued-v1.6"
ENDPOINT_TRUST_CONTRACT = "clued.endpoint-trust.v1"
SOURCE_FRESHNESS = frozenset({"current", "degraded", "historical"})
SHA256_CHUNK_SIZE = 1024 * 1024
MIRROR_GENERATION_CONTRACT = "clued.local-mirror-generation.v1"
MIRROR_GENERATION_FILENAME = ".clued-mirror-generation.json"


class VerificationContextError(RuntimeError):
    """A request-local evidence contract failed closed."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(SHA256_CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


def _hash_json(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _iso(epoch: float) -> str:
    return dt.datetime.fromtimestamp(epoch, tz=dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_rfc3339(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise VerificationContextError("invalid session expiry") from exc
    if parsed.tzinfo is None:
        raise VerificationContextError("session expiry must include a timezone")
    return parsed.timestamp()


def _opaque(value: str, field: str) -> str:
    folded = value.casefold()
    if "@" in value or "bearer " in folded or "client_secret" in folded or "access_token" in folded:
        raise VerificationContextError(f"sensitive value rejected for {field}")
    return value


@dataclass(frozen=True)
class AuthorizationEvidence:
    subject_ref: str = "not-applicable"
    tenant_ref: str = "not-applicable"
    organization_ref: str = "not-applicable"
    workspace_ref: str = "not-applicable"
    context_key: str = "not-applicable"
    binding_id: str = "not-applicable"
    role: str = "read-only-snapshot"
    scope_hash: str = "not-applicable"
    purpose: str = "local-read"
    policy_version: str = "not-applicable"
    revocation_epoch: str = "not-applicable"
    session_expires_at: str | None = None
    allowed: bool = True

    def fingerprint(self) -> str:
        values = {
            name: _opaque(str(value), name) if value is not None else None
            for name, value in self.__dict__.items()
            if name != "allowed"
        }
        values["allowed"] = self.allowed
        return _hash_json(values)


@dataclass(frozen=True)
class EndpointTrust:
    config_path: Path
    expected_owner_ref: str
    expected_bundle_scope: str
    contract: str = ENDPOINT_TRUST_CONTRACT

    @classmethod
    def load(cls, path: Path) -> "EndpointTrust":
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise VerificationContextError("trusted endpoint configuration unavailable") from exc
        if not isinstance(payload, dict):
            raise VerificationContextError("trusted endpoint configuration invalid")
        trust = payload.get("snapshot_trust")
        if payload.get("contract") != ENDPOINT_TRUST_CONTRACT or not isinstance(trust, dict):
            raise VerificationContextError("trusted endpoint configuration invalid")
        owner = trust.get("expected_owner_ref")
        scope = trust.get("expected_bundle_scope")
        if (
            not isinstance(owner, str)
            or not owner.strip()
            or owner == "not-applicable"
            or not isinstance(scope, str)
            or not scope.strip()
            or scope == "not-applicable"
        ):
            raise VerificationContextError("trusted endpoint Owner Ref or Bundle Scope missing")
        _opaque(owner, "expected_owner_ref")
        _opaque(scope, "expected_bundle_scope")
        return cls(path.resolve(strict=True), owner, scope)

    def current_sha256(self) -> str:
        current = EndpointTrust.load(self.config_path)
        if current.expected_owner_ref != self.expected_owner_ref or current.expected_bundle_scope != self.expected_bundle_scope:
            raise VerificationContextError("trusted endpoint configuration changed")
        return sha256_file(self.config_path)


@dataclass(frozen=True)
class SourceEnvelope:
    boundary: str
    evidence_id: str
    sources_read: tuple[str, ...]
    source_versions: tuple[str, ...]
    freshness: str
    degraded_reason: str | None

    def __post_init__(self) -> None:
        if not self.sources_read:
            raise VerificationContextError("source envelope missing Sources Read")
        if not self.source_versions:
            raise VerificationContextError("source envelope missing source versions")
        if self.freshness not in SOURCE_FRESHNESS:
            raise VerificationContextError("source envelope missing or invalid Freshness")
        if self.freshness == "degraded" and not self.degraded_reason:
            raise VerificationContextError("degraded source envelope missing degraded reason")
        if self.freshness != "degraded" and self.degraded_reason is not None:
            raise VerificationContextError("non-degraded source envelope has degraded reason")

    def as_dict(self) -> dict:
        return {
            "boundary": self.boundary,
            "evidence_id": self.evidence_id,
            "sources_read": list(self.sources_read),
            "source_versions": list(self.source_versions),
            "freshness": self.freshness,
            "degraded_reason": self.degraded_reason,
        }


class SystemClock:
    trusted = True

    @staticmethod
    def wall_time() -> float:
        return time.time()

    @staticmethod
    def monotonic() -> float:
        return time.monotonic()


def _security_fingerprint(path: Path, info: os.stat_result) -> str:
    if os.name == "nt":
        # OWNER | GROUP | DACL.  GetFileSecurityW returns the self-relative
        # descriptor, whose bytes change when the effective ACL identity does.
        owner_group_dacl = 0x00000001 | 0x00000002 | 0x00000004
        needed = ctypes.c_ulong(0)
        get_security = ctypes.windll.advapi32.GetFileSecurityW
        get_security(str(path), owner_group_dacl, None, 0, ctypes.byref(needed))
        if needed.value == 0:
            raise VerificationContextError("path ACL identity unavailable")
        buffer = ctypes.create_string_buffer(needed.value)
        if not get_security(str(path), owner_group_dacl, buffer, needed.value, ctypes.byref(needed)):
            raise VerificationContextError("path ACL identity unavailable")
        return hashlib.sha256(buffer.raw[: needed.value]).hexdigest()

    details: list[object] = [info.st_mode, info.st_uid, info.st_gid]
    if hasattr(os, "listxattr"):
        try:
            for name in sorted(os.listxattr(path)):
                details.append((name, hashlib.sha256(os.getxattr(path, name)).hexdigest()))
        except OSError:
            details.append("xattr-unavailable")
    return _hash_json(details)


@dataclass(frozen=True)
class PathIdentity:
    requested_path: str
    canonical_path: str
    device: int
    inode: int
    mode: int
    owner: int | None
    group: int | None
    file_attributes: int | None
    writable: bool
    is_symlink: bool
    security_sha256: str

    @classmethod
    def capture(cls, path: Path) -> "PathIdentity":
        requested = Path(os.path.abspath(path))
        canonical = requested.resolve(strict=True)
        info = canonical.stat()
        lexical = requested.lstat()
        if not stat.S_ISDIR(info.st_mode):
            raise VerificationContextError("verified bundle path is not a directory")
        if info.st_ino == 0:
            raise VerificationContextError("stable directory identity unavailable")
        is_junction = bool(getattr(requested, "is_junction", lambda: False)())
        return cls(
            requested_path=os.path.normcase(str(requested)),
            canonical_path=os.path.normcase(str(canonical)),
            device=int(info.st_dev),
            inode=int(info.st_ino),
            mode=int(info.st_mode),
            owner=getattr(info, "st_uid", None),
            group=getattr(info, "st_gid", None),
            file_attributes=getattr(info, "st_file_attributes", None),
            writable=os.access(canonical, os.W_OK),
            is_symlink=requested.is_symlink() or is_junction or stat.S_ISLNK(lexical.st_mode),
            security_sha256=_security_fingerprint(canonical, info),
        )

    def fingerprint(self) -> str:
        return _hash_json(self.__dict__)


def _git(repo: Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", "-c", f"safe.directory={repo}", *args],
        cwd=repo,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
    )
    if check and result.returncode:
        raise VerificationContextError("repository identity unavailable")
    return result.stdout.strip() if result.returncode == 0 else ""


def _repository_state(repo: Path) -> dict:
    if not (repo / ".git").exists():
        return {
            "local_head": "not-applicable",
            "tag_set_sha256": _hash_json([]),
            "repository_identity": _hash_json([str(repo.resolve()), "not-a-git-repository"]),
        }
    local_head = _git(repo, "rev-parse", "HEAD")
    tags = sorted(_git(repo, "show-ref", "--tags", "-d", check=False).splitlines())
    common_dir_text = _git(repo, "rev-parse", "--git-common-dir")
    common_dir = Path(common_dir_text)
    if not common_dir.is_absolute():
        common_dir = repo / common_dir
    origin = _git(repo, "remote", "get-url", "origin", check=False)
    return {
        "local_head": local_head,
        "tag_set_sha256": _hash_json(tags),
        "repository_identity": _hash_json([str(common_dir.resolve()), origin]),
    }


def _verified_content_fingerprint(root: Path, manifest: dict) -> str:
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise VerificationContextError("manifest files unavailable for content identity")
    digest = hashlib.sha256()
    seen: set[str] = set()
    for item in sorted(files, key=lambda value: str(value.get("path")) if isinstance(value, dict) else ""):
        rel = item.get("path") if isinstance(item, dict) else None
        if not rel or rel in seen or Path(rel).is_absolute() or ".." in Path(rel).parts:
            raise VerificationContextError("unsafe manifest path in content identity")
        seen.add(rel)
        path = root / rel
        if not path.is_file():
            raise VerificationContextError("manifest file missing during content identity")
        declared = item.get("sha256")
        if not isinstance(declared, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", declared):
            raise VerificationContextError(f"manifest:invalid-sha256:{rel}")
        actual = sha256_file(path)
        if actual != declared.lower():
            raise VerificationContextError(f"manifest:hash-mismatch:{rel}")
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        digest.update(bytes.fromhex(actual))
    return digest.hexdigest()


def _mirror_generation_state(root: Path, manifest: dict) -> tuple[str, str]:
    path = root / MIRROR_GENERATION_FILENAME
    if not path.exists():
        return "not-applicable", "not-applicable"
    if not path.is_file():
        raise VerificationContextError("mirror generation metadata is not a file")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise VerificationContextError("mirror generation metadata invalid") from exc
    generation_id = payload.get("generation_id") if isinstance(payload, dict) else None
    order_key = payload.get("order_key") if isinstance(payload, dict) else None
    if (
        not isinstance(payload, dict)
        or payload.get("contract") != MIRROR_GENERATION_CONTRACT
        or not isinstance(generation_id, str)
        or not re.fullmatch(r"[0-9a-f]{64}", generation_id)
        or not isinstance(order_key, list)
        or len(order_key) != 3
        or not all(isinstance(value, str) and value for value in order_key)
        or payload.get("snapshot_version") != manifest.get("snapshot_version")
    ):
        raise VerificationContextError("mirror generation metadata invalid")
    return generation_id, sha256_file(path)


@dataclass(frozen=True)
class VersionEnvelope:
    remote_head: str
    local_head: str
    repository_identity: str
    version_sha256: str
    tag_set_sha256: str
    manifest_sha256: str
    current_pointer_hash: str
    endpoint_config_sha256: str
    snapshot_version: str
    canonical_version: str
    owner_ref: str
    bundle_scope: str
    generator_version: str
    schema_version: str
    mirror_generation: str
    mirror_generation_sha256: str
    validator_contract_version: str
    doctor_version: str

    def fingerprint(self) -> str:
        return _hash_json(self.__dict__)


@dataclass
class BundleEvidence:
    evidence_id: str
    boundary: str
    root: str
    verified_at: float
    manifest: dict
    path_identity: PathIdentity
    version: VersionEnvelope
    content_sha256: str
    authorization_sha256: str


Validator = Callable[[Path], tuple[dict, list[str]]]


class RequestVerificationContext:
    """Ephemeral evidence container owned by exactly one request."""

    def __init__(
        self,
        mode: str,
        *,
        repository_root: Path,
        pointer_path: Path | None = None,
        version_path: Path | None = None,
        remote_head: str = "not-applicable",
        authorization: AuthorizationEvidence | None = None,
        endpoint_trust: EndpointTrust | None = None,
        allow_authoritative: bool = True,
        ttl_seconds: float = 300.0,
        clock: object | None = None,
        max_clock_skew_seconds: float = 5.0,
    ) -> None:
        if mode not in CONTEXT_MODES:
            raise VerificationContextError("NONE or unknown mode cannot create a Verification Context")
        if ttl_seconds <= 0:
            raise VerificationContextError("verification TTL must be positive")
        self.verification_id = uuid.uuid4().hex
        self.mode = mode
        self.repository_root = repository_root
        self.pointer_path = pointer_path
        self.version_path = version_path
        self.remote_head = remote_head
        self.authorization = authorization or AuthorizationEvidence()
        self.endpoint_trust = endpoint_trust
        self.allow_authoritative = bool(allow_authoritative)
        self.ttl_seconds = float(ttl_seconds)
        self.clock = clock or SystemClock()
        self.max_clock_skew_seconds = float(max_clock_skew_seconds)
        self._wall_anchor = float(self.clock.wall_time())
        self._monotonic_anchor = float(self.clock.monotonic())
        session_expiry = _parse_rfc3339(self.authorization.session_expires_at)
        ttl_expiry = self._wall_anchor + self.ttl_seconds
        self._effective_expiry = min(ttl_expiry, session_expiry) if session_expiry is not None else ttl_expiry
        self._authorization_sha256 = self.authorization.fingerprint()
        self._evidence: dict[str, BundleEvidence] = {}
        self.events: list[dict] = []
        self.full_validation_count = 0
        self.reuse_count = 0
        self.invalidation_count = 0
        self.last_reused = False

    def __getstate__(self):
        raise TypeError("Verification Context is request-local and cannot be serialized")

    def _trusted_now(self) -> float:
        if not bool(getattr(self.clock, "trusted", False)):
            self._fatal("untrusted-clock")
        wall = float(self.clock.wall_time())
        monotonic = float(self.clock.monotonic())
        monotonic_elapsed = monotonic - self._monotonic_anchor
        if monotonic_elapsed < 0:
            self._fatal("monotonic-clock-rollback")
        expected_wall = self._wall_anchor + monotonic_elapsed
        drift = wall - expected_wall
        if drift < -self.max_clock_skew_seconds:
            self._fatal("wall-clock-rollback")
        if drift > self.max_clock_skew_seconds:
            self._fatal("wall-clock-forward-jump")
        if wall < self._wall_anchor:
            self._fatal("verified-at-is-in-the-future")
        if wall > self._effective_expiry:
            self._fatal("verification-context-expired")
        return wall

    def stale_age_seconds(self) -> float:
        return max(0.0, self._trusted_now() - self._wall_anchor)

    def _fatal(self, reason: str):
        self._evidence.clear()
        self.invalidation_count += 1
        self.events.append({"action": "fail_closed", "reason": reason})
        raise VerificationContextError(reason)

    def _invalidate_boundary(self, boundary: str, reason: str) -> None:
        self._evidence.pop(boundary, None)
        self.invalidation_count += 1
        self.events.append({"action": "invalidate", "boundary": boundary, "reason": reason})

    def _assert_request_inputs(
        self,
        authorization: AuthorizationEvidence | None,
        ttl_seconds: float | None,
        remote_head: str | None,
    ) -> None:
        self._trusted_now()
        supplied = authorization or self.authorization
        if not supplied.allowed:
            self._fatal("authorization-denied")
        supplied_hash = supplied.fingerprint()
        if supplied_hash != self._authorization_sha256:
            self._fatal("authorization-changed")
        if ttl_seconds is not None and float(ttl_seconds) != self.ttl_seconds:
            self._fatal("verification-ttl-changed")
        if remote_head is not None and remote_head != self.remote_head:
            self._fatal("remote-head-changed")

    def _version_envelope(
        self,
        manifest: dict,
        manifest_sha256: str,
        mirror_generation: str,
        mirror_generation_sha256: str,
        validator_contract_version: str,
        doctor_version: str,
    ) -> VersionEnvelope:
        repository = _repository_state(self.repository_root)
        pointer_hash = "not-applicable"
        if self.pointer_path is not None:
            if not self.pointer_path.is_file():
                raise VerificationContextError("current pointer unavailable")
            pointer_hash = sha256_file(self.pointer_path)
        version_hash = "not-applicable"
        if self.version_path is not None:
            if not self.version_path.is_file():
                raise VerificationContextError("VERSION unavailable")
            version_hash = sha256_file(self.version_path)
        endpoint_config_sha256 = "missing"
        if self.endpoint_trust is not None:
            endpoint_config_sha256 = self.endpoint_trust.current_sha256()
        return VersionEnvelope(
            remote_head=self.remote_head,
            local_head=repository["local_head"],
            repository_identity=repository["repository_identity"],
            version_sha256=version_hash,
            tag_set_sha256=repository["tag_set_sha256"],
            manifest_sha256=manifest_sha256,
            current_pointer_hash=pointer_hash,
            endpoint_config_sha256=endpoint_config_sha256,
            snapshot_version=str(manifest.get("snapshot_version", "missing")),
            canonical_version=str(manifest.get("canonical_version", "missing")),
            owner_ref=str(manifest.get("owner_ref", "missing")),
            bundle_scope=str(manifest.get("bundle_scope", "missing")),
            generator_version=str(manifest.get("generator_version", "missing")),
            schema_version=str(manifest.get("schema_version", "missing")),
            mirror_generation=mirror_generation,
            mirror_generation_sha256=mirror_generation_sha256,
            validator_contract_version=validator_contract_version,
            doctor_version=doctor_version,
        )

    def _pointer_errors(self, manifest: dict, manifest_sha256: str) -> list[str]:
        if self.pointer_path is None:
            return []
        try:
            pointer = json.loads(self.pointer_path.read_text(encoding="utf-8"))
        except Exception as exc:
            return [f"pointer-invalid:{exc}"]
        errors = []
        if pointer.get("snapshot_version") != manifest.get("snapshot_version"):
            errors.append("pointer:snapshot-version-mismatch")
        if pointer.get("manifest_sha256") != manifest_sha256:
            errors.append("pointer:manifest-hash-mismatch")
        return errors

    def _owner_errors(self, manifest: dict) -> list[str]:
        errors = []
        if self.endpoint_trust is None:
            return ["trusted-endpoint-config-missing"]
        owner_ref = manifest.get("owner_ref")
        bundle_scope = manifest.get("bundle_scope")
        if not isinstance(owner_ref, str) or not owner_ref:
            errors.append("manifest:owner-ref-missing")
        elif owner_ref != self.endpoint_trust.expected_owner_ref:
            errors.append("owner-mismatch")
        if not isinstance(bundle_scope, str) or not bundle_scope:
            errors.append("manifest:bundle-scope-missing")
        elif bundle_scope != self.endpoint_trust.expected_bundle_scope:
            errors.append("tenant-scope-mismatch")
        return errors

    def _capture_state(
        self,
        root: Path,
        manifest: dict,
        validator_contract_version: str,
        doctor_version: str,
    ) -> tuple[PathIdentity, VersionEnvelope, str]:
        manifest_sha256 = sha256_file(root / "manifest.json")
        identity = PathIdentity.capture(root)
        mirror_generation, mirror_generation_sha256 = _mirror_generation_state(root, manifest)
        version = self._version_envelope(
            manifest,
            manifest_sha256,
            mirror_generation,
            mirror_generation_sha256,
            validator_contract_version,
            doctor_version,
        )
        content = _verified_content_fingerprint(root, manifest)
        return identity, version, content

    def _require_current_evidence(self, boundary: str) -> BundleEvidence:
        self._assert_request_inputs(None, None, None)
        if not isinstance(boundary, str) or not boundary.strip():
            raise VerificationContextError("verification boundary required")
        evidence = self._evidence.get(boundary)
        if evidence is None:
            raise VerificationContextError("no current successful Bundle Evidence for boundary")
        try:
            identity, version, content = self._capture_state(
                Path(evidence.root),
                evidence.manifest,
                evidence.version.validator_contract_version,
                evidence.version.doctor_version,
            )
        except Exception as exc:
            self._invalidate_boundary(boundary, "evidence-no-longer-observable")
            raise VerificationContextError("Bundle Evidence is no longer valid") from exc
        if (
            identity.fingerprint() != evidence.path_identity.fingerprint()
            or version.fingerprint() != evidence.version.fingerprint()
            or content != evidence.content_sha256
            or evidence.authorization_sha256 != self._authorization_sha256
        ):
            self._invalidate_boundary(boundary, "evidence-changed-before-summary")
            raise VerificationContextError("Bundle Evidence is no longer valid")
        self._trusted_now()
        return evidence

    def verify_bundle(
        self,
        root: Path,
        validator: Validator,
        *,
        boundary: str,
        authorization: AuthorizationEvidence | None = None,
        ttl_seconds: float | None = None,
        remote_head: str | None = None,
        validator_contract_version: str = VALIDATOR_CONTRACT_VERSION,
        doctor_version: str = DOCTOR_VERSION,
    ) -> tuple[dict, list[str]]:
        self._assert_request_inputs(authorization, ttl_seconds, remote_head)
        if not isinstance(boundary, str) or not boundary.strip():
            raise VerificationContextError("verification boundary required")
        self.last_reused = False
        evidence = self._evidence.get(boundary)
        if evidence is not None:
            try:
                identity, version, content = self._capture_state(
                    root, evidence.manifest, validator_contract_version, doctor_version
                )
            except Exception:
                self._invalidate_boundary(boundary, "identity-unavailable")
            else:
                comparisons = {
                    "path-identity-changed": identity.fingerprint() != evidence.path_identity.fingerprint(),
                    "version-envelope-changed": version.fingerprint() != evidence.version.fingerprint(),
                    "content-changed": content != evidence.content_sha256,
                    "authorization-changed": evidence.authorization_sha256 != self._authorization_sha256,
                }
                reason = next((name for name, changed in comparisons.items() if changed), None)
                if reason is None:
                    self._trusted_now()
                    self.reuse_count += 1
                    self.last_reused = True
                    self.events.append({"action": "reuse", "boundary": boundary})
                    return dict(evidence.manifest), []
                self._invalidate_boundary(boundary, reason)

        pre_identity = PathIdentity.capture(root)
        pre_manifest_sha256 = sha256_file(root / "manifest.json") if (root / "manifest.json").is_file() else "missing"
        self.full_validation_count += 1
        manifest, errors = validator(root)
        errors = list(errors)
        if not errors:
            try:
                post_identity, version, content = self._capture_state(
                    root, manifest, validator_contract_version, doctor_version
                )
            except VerificationContextError as exc:
                errors.append(str(exc))
        if not errors:
            if pre_identity.fingerprint() != post_identity.fingerprint():
                errors.append("verification-input-changed:path-identity")
            if pre_manifest_sha256 != version.manifest_sha256:
                errors.append("verification-input-changed:manifest")
            errors.extend(self._pointer_errors(manifest, version.manifest_sha256))
            errors.extend(self._owner_errors(manifest))
        if errors:
            self._invalidate_boundary(boundary, "full-validation-failed")
            self.events.append({"action": "reject", "boundary": boundary, "error_count": len(errors)})
            return manifest, errors
        self._trusted_now()
        self._evidence[boundary] = BundleEvidence(
            evidence_id=uuid.uuid4().hex,
            boundary=boundary,
            root=str(root.resolve(strict=True)),
            verified_at=float(self.clock.wall_time()),
            manifest=dict(manifest),
            path_identity=post_identity,
            version=version,
            content_sha256=content,
            authorization_sha256=self._authorization_sha256,
        )
        self.events.append({"action": "full_validate", "boundary": boundary})
        return dict(manifest), []

    def source_envelope(
        self,
        *,
        boundary: str,
        sources_read: list[str] | tuple[str, ...],
        source_versions: list[str] | tuple[str, ...],
        freshness: str,
        degraded_reason: str | None,
    ) -> SourceEnvelope:
        self._assert_request_inputs(None, None, None)
        if not self.allow_authoritative:
            raise VerificationContextError("recovery-only Context cannot create a Source Envelope")
        if not isinstance(boundary, str) or not boundary.strip():
            raise VerificationContextError("verification boundary required")
        evidence = self._evidence.get(boundary)
        if evidence is None:
            raise VerificationContextError("no current successful Bundle Evidence for boundary")
        return SourceEnvelope(
            boundary,
            evidence.evidence_id,
            tuple(sources_read),
            tuple(source_versions),
            freshness,
            degraded_reason,
        )

    def summary(self, *, boundary: str, sources: SourceEnvelope | None = None) -> dict:
        if sources is not None and not self.allow_authoritative:
            raise VerificationContextError("recovery-only Context cannot become authoritative")
        now = self._trusted_now()
        evidence = self._require_current_evidence(boundary)
        if sources is not None and (sources.boundary != boundary or sources.evidence_id != evidence.evidence_id):
            raise VerificationContextError("Source Envelope is not bound to current Bundle Evidence")
        version = evidence.version
        payload = {
            "verification_id": self.verification_id,
            "evidence_id": evidence.evidence_id,
            "boundary": boundary,
            "mode": self.mode,
            "verified_at": _iso(evidence.verified_at),
            "effective_expires_at": _iso(self._effective_expiry),
            "stale_age_seconds": max(0.0, now - self._wall_anchor),
            "repository": {
                "root": str(self.repository_root.resolve()),
                "identity_sha256": version.repository_identity,
                "remote_head": version.remote_head,
                "local_head": version.local_head,
            },
            "snapshot": {
                "root": evidence.root,
                "path_identity_sha256": evidence.path_identity.fingerprint(),
                "content_sha256": evidence.content_sha256,
                "snapshot_version": version.snapshot_version,
                "canonical_version": version.canonical_version,
                "manifest_sha256": version.manifest_sha256,
                "current_pointer_sha256": version.current_pointer_hash,
                "owner_ref": version.owner_ref,
                "bundle_scope": version.bundle_scope,
                "mirror_generation": version.mirror_generation,
                "mirror_generation_sha256": version.mirror_generation_sha256,
            },
            "authorization": {
                "evidence_sha256": evidence.authorization_sha256,
                "allowed": self.authorization.allowed,
                "role": self.authorization.role,
                "purpose": self.authorization.purpose,
                "policy_version": self.authorization.policy_version,
                "revocation_epoch": self.authorization.revocation_epoch,
                "session_expires_at": self.authorization.session_expires_at,
                "expected_owner_ref": self.endpoint_trust.expected_owner_ref,
                "expected_bundle_scope": self.endpoint_trust.expected_bundle_scope,
            },
            "version_envelope": asdict(version),
            "validator": {
                "contract_version": version.validator_contract_version,
                "doctor_version": version.doctor_version,
                "result": "pass",
            },
            "full_validation_count": self.full_validation_count,
            "reuse_count": self.reuse_count,
            "invalidation_count": self.invalidation_count,
        }
        if sources is not None:
            payload["sources"] = sources.as_dict()
            payload["authoritative"] = True
        else:
            payload["authoritative"] = False
        return payload
