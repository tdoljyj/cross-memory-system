# -*- coding: utf-8 -*-
"""R4 Gate 0-C safe, derived vector index.

The index is deliberately outside the canonical ``memory/`` tree.  It contains
only identifiers, hashes, visibility fingerprints and float32 vectors; passage
text exists only long enough to call the injected offline embedder.

Build protocol::

    canonical objects -> hard filter -> deterministic passages -> embeddings
    -> staging generation -> full self-check -> atomic CURRENT.json switch

Any failure leaves the previous generation selected.  The module does not
download models and does not import the torch/transformers adapter; callers
must inject an already verified embedder.
"""

import hashlib
import json
import math
import os
import shutil
import struct
import subprocess
import time
import unicodedata
import uuid
from datetime import datetime, timezone

from . import conflict
from . import paths
from . import schema as S
from . import store
from . import temporal


INDEX_SCHEMA_VERSION = 1
PASSAGE_SERIALIZER_VERSION = "r4-g0-passage-v1"
DIMENSION = 384
DTYPE = "float32"
PASSAGE_BATCH = 32

RC_INVALID_OBJECT = "INVALID_OBJECT"
RC_ACCESS_DENIED = "ACCESS_DENIED"
RC_STATUS_NOT_RECALLABLE = "STATUS_NOT_RECALLABLE"
RC_TEMPORARY_OBJECT = "TEMPORARY_OBJECT"
RC_TEMPORAL_NOT_CURRENT = "TEMPORAL_NOT_CURRENT"
RC_SECRET_DETECTED = "SECRET_DETECTED"
RC_CONFLICT_LOSER = "CONFLICT_LOSER"


class VectorIndexError(RuntimeError):
    pass


class VectorIndexBusy(VectorIndexError):
    pass


def _utc_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _canonical_bytes(value):
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"), allow_nan=False).encode("utf-8")


def _sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _atomic_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp-" + uuid.uuid4().hex
    with open(tmp, "wb") as fh:
        fh.write(_canonical_bytes(value) + b"\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    _chmod_file(path)


def _chmod_dir(path):
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


def _chmod_file(path):
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def harden_cache_permissions(cache_dir):
    """Apply 0700/0600 or a Windows DACL with equivalent principals.

    Windows keeps only the executing identity, SYSTEM and Administrators on
    the cache root, then makes existing descendants inherit that protected
    root.  This two-step order is important: applying ``inheritance:r``
    recursively without re-enabling child inheritance leaves files with no
    usable ACEs.
    """
    cache = validate_cache_root(cache_dir)
    if os.name != "nt":
        for root, dirs, files in os.walk(cache):
            _chmod_dir(root)
            for name in dirs:
                _chmod_dir(os.path.join(root, name))
            for name in files:
                _chmod_file(os.path.join(root, name))
        return {"mode": "posix-0700-0600"}
    try:
        principal = subprocess.check_output(
            ["whoami"], stderr=subprocess.STDOUT).decode(
                "utf-8", "replace").strip()
        if not principal:
            raise VectorIndexError("WINDOWS_PRINCIPAL_EMPTY")
        first = subprocess.run([
            "icacls", cache, "/inheritance:r", "/grant:r",
            principal + ":(OI)(CI)F",
            "*S-1-5-18:(OI)(CI)F",
            "*S-1-5-32-544:(OI)(CI)F", "/T", "/C",
        ], capture_output=True, check=False)
        if first.returncode != 0 or b"Failed processing 0 files" not in \
                first.stdout:
            raise VectorIndexError("WINDOWS_ACL_ROOT_HARDEN_FAILED")
        children = os.path.join(cache, "*")
        second = subprocess.run([
            "icacls", children, "/inheritance:e", "/T", "/C",
        ], capture_output=True, check=False)
        if second.returncode != 0 or b"Failed processing 0 files" not in \
                second.stdout:
            raise VectorIndexError("WINDOWS_ACL_CHILD_INHERIT_FAILED")
        return {
            "mode": "windows-protected-dacl",
            "principals": ["EXECUTING_IDENTITY", "SYSTEM", "ADMINISTRATORS"],
        }
    except FileNotFoundError as exc:
        raise VectorIndexError("WINDOWS_ACL_TOOL_MISSING: %s" % exc)


def _is_within(path, root):
    try:
        return os.path.commonpath(
            [os.path.abspath(path), os.path.abspath(root)]) == \
            os.path.abspath(root)
    except ValueError:
        return False


def validate_cache_root(cache_dir, repo=None):
    """Reject a derived-cache path inside the repository/canonical memory."""
    if not isinstance(cache_dir, str) or not cache_dir.strip():
        raise VectorIndexError("VECTOR_CACHE_PATH_EMPTY")
    cache = os.path.abspath(os.path.expanduser(cache_dir))
    root = os.path.abspath(repo or paths.REPO)
    if _is_within(cache, root) or _is_within(root, cache):
        raise VectorIndexError("VECTOR_CACHE_INSIDE_REPOSITORY")
    return cache


def configured_cache_root(repo=None):
    """Return an explicitly configured cache root, otherwise ``None``.

    There is intentionally no implicit user-home write.  Production/Shadow
    activation must opt in through ``CROSS_MEMORY_VECTOR_CACHE`` or the local,
    gitignored ``sync.config.json`` key ``vector_cache_dir``.
    """
    env = os.environ.get("CROSS_MEMORY_VECTOR_CACHE")
    if env:
        return validate_cache_root(env, repo=repo)
    root = os.path.abspath(repo or paths.REPO)
    cfg = os.path.join(root, "sync.config.json")
    try:
        with open(cfg, "r", encoding="utf-8") as fh:
            value = json.load(fh).get("vector_cache_dir")
        if isinstance(value, str) and value.strip():
            return validate_cache_root(value, repo=root)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    return None


def _normalize_text(value):
    text = unicodedata.normalize("NFKC", value or "")
    return " ".join(text.replace("\r\n", "\n").replace("\r", "\n").split())


def _normalize_values(values):
    cleaned = {_normalize_text(v) for v in (values or []) if _normalize_text(v)}
    return sorted(cleaned)


def serialize_passage(obj):
    """Serialize only fields already visible to current MIV-005A scoring.

    ``content``, category, tags and entities are the fields consumed by
    ``recall_engine._match_score``.  Metadata, paths, source references,
    timestamps and permissions never enter the model input.
    """
    payload = {
        "category": _normalize_text(
            (obj.get("classification") or {}).get("category")),
        "content": _normalize_text(obj.get("content")),
        "entities": _normalize_values(obj.get("entities")),
        "tags": _normalize_values(obj.get("tags")),
    }
    return _canonical_bytes(payload).decode("utf-8")


def content_hash(obj):
    return _sha256_bytes(serialize_passage(obj).encode("utf-8"))


def _opaque(value):
    if value is None:
        return None
    return _sha256_bytes(_normalize_text(str(value)).encode("utf-8"))


def visibility_fingerprint(obj):
    src = obj.get("source") or {}
    visible = {
        "project_id": _opaque(obj.get("project_id")),
        "scope": obj.get("scope"),
        "session_id": _opaque(src.get("session_id")),
        "status": obj.get("status"),
    }
    return _sha256_bytes(_canonical_bytes(visible))


def _initial_exclusion_reasons(obj, when=None):
    if not isinstance(obj, dict):
        return [RC_INVALID_OBJECT]
    if obj.get("denied") is True or obj.get("status") == "denied":
        return [RC_ACCESS_DENIED]
    ok, _ = S.validate_object(obj)
    if not ok:
        return [RC_INVALID_OBJECT]
    if obj.get("type") == "temporary":
        return [RC_TEMPORARY_OBJECT]
    if obj.get("status") not in S.RECALLABLE_STATUSES:
        return [RC_STATUS_NOT_RECALLABLE]
    if not temporal.is_valid_now(obj, when=when):
        return [RC_TEMPORAL_NOT_CURRENT]
    if store.find_secret_in_object(obj):
        return [RC_SECRET_DETECTED]
    return []


def _conflict_losers(objects):
    """Resolve active visible relations before passages reach the embedder."""
    by_id = {o["id"]: o for o in objects}
    losers = set()
    handled = set()
    for obj in sorted(objects, key=lambda item: item["id"]):
        rel = obj.get("relations") or {}
        for other_id in sorted(rel.get("supersedes") or []):
            if other_id in by_id and other_id != obj["id"]:
                losers.add(other_id)
        for other_id in sorted(rel.get("contradicts") or []):
            other = by_id.get(other_id)
            if not other or other_id == obj["id"]:
                continue
            pair = tuple(sorted((obj["id"], other_id)))
            if pair in handled:
                continue
            handled.add(pair)
            ev_a = (obj.get("provenance") or {}).get("evidence")
            ev_b = (other.get("provenance") or {}).get("evidence")
            t_a = (obj.get("source") or {}).get("updated_at")
            t_b = (other.get("source") or {}).get("updated_at")
            a_wins = conflict.evidence_wins(ev_a, t_a, ev_b, t_b)
            b_wins = conflict.evidence_wins(ev_b, t_b, ev_a, t_a)
            if a_wins and not b_wins:
                losers.add(other_id)
            elif b_wins and not a_wins:
                losers.add(obj["id"])
            else:
                losers.add(max(obj["id"], other_id))
    return losers


def eligible_objects(objects, when=None):
    """Return ``(included, excluded)`` after all pre-embedding guards.

    ``excluded`` maps an object id (or a stable invalid placeholder) to one or
    more reason codes.  The returned included sequence is ID-sorted.
    """
    included = []
    excluded = {}
    for pos, obj in enumerate(objects or []):
        oid = obj.get("id") if isinstance(obj, dict) else None
        key = oid or "<invalid-%06d>" % pos
        reasons = _initial_exclusion_reasons(obj, when=when)
        if reasons:
            excluded[key] = reasons
        else:
            included.append(obj)
    losers = _conflict_losers(included)
    if losers:
        kept = []
        for obj in included:
            if obj["id"] in losers:
                excluded[obj["id"]] = [RC_CONFLICT_LOSER]
            else:
                kept.append(obj)
        included = kept
    return sorted(included, key=lambda item: item["id"]), excluded


def _reason_counts(excluded):
    counts = {}
    for reasons in excluded.values():
        for reason in reasons:
            counts[reason] = counts.get(reason, 0) + 1
    return dict(sorted(counts.items()))


def _source_fingerprint(rows, excluded, model_digest):
    value = {
        "excluded_reason_counts": _reason_counts(excluded),
        "model_manifest_digest": model_digest,
        "objects": [{
            "content_hash": row["content_hash"],
            "object_id": row["object_id"],
            "visibility_fingerprint": row["visibility_fingerprint"],
        } for row in rows],
        "serializer_version": PASSAGE_SERIALIZER_VERSION,
    }
    return _sha256_bytes(_canonical_bytes(value))


def _rows_from_tensor(value, expected_count):
    tensor = value
    if hasattr(tensor, "detach"):
        tensor = tensor.detach()
    if hasattr(tensor, "cpu"):
        tensor = tensor.cpu()
    ndim = getattr(tensor, "ndim", None)
    if ndim is not None and ndim != 2:
        raise VectorIndexError("EMBEDDING_NDIM_MISMATCH")
    shape = getattr(tensor, "shape", None)
    if shape is not None and (len(shape) != 2 or shape[1] != DIMENSION):
        raise VectorIndexError("EMBEDDING_SHAPE_MISMATCH")
    if hasattr(tensor, "tolist"):
        rows = tensor.tolist()
    else:
        rows = tensor
    if not isinstance(rows, (list, tuple)) or len(rows) != expected_count:
        raise VectorIndexError("EMBEDDING_ROW_COUNT_MISMATCH")
    checked = []
    for row in rows:
        if not isinstance(row, (list, tuple)) or len(row) != DIMENSION:
            raise VectorIndexError("EMBEDDING_DIMENSION_MISMATCH")
        vals = [float(v) for v in row]
        if not all(math.isfinite(v) for v in vals):
            raise VectorIndexError("EMBEDDING_NON_FINITE")
        norm = math.sqrt(sum(v * v for v in vals))
        if abs(norm - 1.0) > 1e-4:
            raise VectorIndexError("EMBEDDING_NOT_L2_NORMALIZED")
        checked.append(vals)
    return checked


def _embed_all(embedder, passages):
    if getattr(embedder, "dim", DIMENSION) != DIMENSION:
        raise VectorIndexError("EMBEDDER_DIMENSION_MISMATCH")
    vectors = []
    for start in range(0, len(passages), PASSAGE_BATCH):
        chunk = passages[start:start + PASSAGE_BATCH]
        raw = embedder.embed_passages(chunk)
        vectors.extend(_rows_from_tensor(raw, len(chunk)))
    return vectors


def _manifest_self_hash(manifest):
    value = dict(manifest)
    value.pop("self_hash", None)
    return _sha256_bytes(_canonical_bytes(value))


def _read_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _verify_manifest_self_hash(manifest):
    expected = manifest.get("self_hash")
    return isinstance(expected, str) and expected == _manifest_self_hash(manifest)


def _generation_paths(cache_dir, generation_id):
    root = os.path.join(cache_dir, "indexes", generation_id)
    return {
        "root": root,
        "manifest": os.path.join(root, "INDEX-MANIFEST.json"),
        "rows": os.path.join(root, "rows.jsonl"),
        "vectors": os.path.join(root, "vectors.f32"),
    }


def verify_generation(cache_dir, generation_id,
                      expected_model_manifest_digest=None):
    """Full hash/row/dimension validation for one immutable generation."""
    cache = validate_cache_root(cache_dir)
    gp = _generation_paths(cache, generation_id)
    try:
        manifest = _read_json(gp["manifest"])
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise VectorIndexError("INDEX_MANIFEST_INVALID: %s" % exc)
    if manifest.get("index_schema_version") != INDEX_SCHEMA_VERSION:
        raise VectorIndexError("INDEX_SCHEMA_MISMATCH")
    if manifest.get("passage_serializer_version") != \
            PASSAGE_SERIALIZER_VERSION:
        raise VectorIndexError("SERIALIZER_VERSION_MISMATCH")
    if not _verify_manifest_self_hash(manifest):
        raise VectorIndexError("INDEX_MANIFEST_SELF_HASH_MISMATCH")
    if expected_model_manifest_digest is not None and \
            manifest.get("model_manifest_digest") != \
            expected_model_manifest_digest:
        raise VectorIndexError("MODEL_MANIFEST_DIGEST_MISMATCH")
    if manifest.get("dimension") != DIMENSION or \
            manifest.get("dtype") != DTYPE or \
            manifest.get("l2_normalized") is not True:
        raise VectorIndexError("INDEX_VECTOR_CONTRACT_MISMATCH")
    for name in ("rows", "vectors"):
        meta = (manifest.get("files") or {}).get(name) or {}
        path = gp[name]
        if not os.path.isfile(path):
            raise VectorIndexError("INDEX_FILE_MISSING: %s" % name)
        if os.path.getsize(path) != meta.get("size"):
            raise VectorIndexError("INDEX_FILE_SIZE_MISMATCH: %s" % name)
        if _sha256_file(path) != meta.get("sha256"):
            raise VectorIndexError("INDEX_FILE_HASH_MISMATCH: %s" % name)
    try:
        with open(gp["rows"], "r", encoding="utf-8") as fh:
            rows = [json.loads(line) for line in fh if line.strip()]
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise VectorIndexError("INDEX_ROWS_INVALID: %s" % exc)
    if len(rows) != manifest.get("included_object_count"):
        raise VectorIndexError("INDEX_ROW_COUNT_MISMATCH")
    ids = [row.get("object_id") for row in rows]
    if len(ids) != len(set(ids)) or any(not store.safe_id(oid) for oid in ids):
        raise VectorIndexError("INDEX_OBJECT_IDS_INVALID")
    expected_bytes = len(rows) * DIMENSION * 4
    if os.path.getsize(gp["vectors"]) != expected_bytes:
        raise VectorIndexError("INDEX_VECTOR_SIZE_MISMATCH")
    return manifest, rows


def load_current_index(cache_dir, expected_model_manifest_digest=None):
    cache = validate_cache_root(cache_dir)
    current_path = os.path.join(cache, "CURRENT.json")
    try:
        current = _read_json(current_path)
        generation_id = current["generation_id"]
    except (OSError, KeyError, TypeError, ValueError,
            json.JSONDecodeError) as exc:
        raise VectorIndexError("CURRENT_POINTER_INVALID: %s" % exc)
    if not isinstance(generation_id, str) or not generation_id.startswith("g-"):
        raise VectorIndexError("CURRENT_GENERATION_ID_INVALID")
    manifest, rows = verify_generation(
        cache, generation_id,
        expected_model_manifest_digest=expected_model_manifest_digest)
    if current.get("manifest_self_hash") != manifest.get("self_hash"):
        raise VectorIndexError("CURRENT_MANIFEST_DIGEST_MISMATCH")
    return manifest, rows


def mark_dirty(cache_dir, reason, object_ids=None):
    cache = validate_cache_root(cache_dir)
    lock = _acquire_build_lock(cache)
    try:
        marker = {
            "dirty_since_utc": _utc_now(),
            "nonce": uuid.uuid4().hex,
            "object_ids": sorted(set(object_ids or [])),
            "reason": str(reason or "CANONICAL_OBJECT_CHANGED"),
            "schema_version": 1,
        }
        _atomic_json(os.path.join(cache, "DIRTY.json"), marker)
        return marker
    finally:
        _release_build_lock(lock)


def mark_dirty_if_configured(reason, object_ids=None, repo=None):
    cache = configured_cache_root(repo=repo)
    if cache is None:
        return False
    mark_dirty(cache, reason, object_ids=object_ids)
    return True


def _acquire_build_lock(cache):
    os.makedirs(cache, exist_ok=True)
    _chmod_dir(cache)
    path = os.path.join(cache, "BUILD.lock")
    for attempt in range(2):
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            break
        except FileExistsError:
            pid = _lock_pid(path)
            if attempt == 0 and pid is not None and not _pid_alive(pid):
                try:
                    os.remove(path)
                except OSError:
                    pass
                continue
            raise VectorIndexBusy("INDEX_BUILD_ALREADY_RUNNING")
    with os.fdopen(fd, "w", encoding="ascii") as fh:
        fh.write("pid=%d\nstarted=%s\n" % (os.getpid(), _utc_now()))
    _chmod_file(path)
    return path


def _lock_pid(path):
    try:
        with open(path, "r", encoding="ascii") as fh:
            first = fh.readline().strip()
        if first.startswith("pid="):
            pid = int(first[4:])
            return pid if pid > 0 else None
    except (OSError, ValueError):
        pass
    return None


def _pid_alive(pid):
    if pid == os.getpid():
        return True
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def _release_build_lock(path):
    try:
        os.remove(path)
    except OSError:
        pass


def build_index(objects, embedder, cache_dir, model_manifest_digest,
                model_id="intfloat/multilingual-e5-small",
                model_revision=None, when=None, fault_hook=None,
                harden_permissions=True):
    """Build or reuse an immutable safe generation.

    ``fault_hook(stage, context)`` is a test-only failure-injection point.  A
    raised exception aborts staging and preserves the previous CURRENT pointer.
    """
    if not isinstance(model_manifest_digest, str) or \
            len(model_manifest_digest) != 64:
        raise VectorIndexError("MODEL_MANIFEST_DIGEST_INVALID")
    cache = validate_cache_root(cache_dir)
    lock = _acquire_build_lock(cache)
    staging = None
    started = _utc_now()
    started_clock = time.monotonic()
    try:
        included, excluded = eligible_objects(objects, when=when)
        rows = []
        passages = []
        for obj in included:
            rows.append({
                "content_hash": content_hash(obj),
                "object_id": obj["id"],
                "project_id_hash": _opaque(obj.get("project_id")),
                "scope": obj.get("scope"),
                "session_id_hash": _opaque(
                    (obj.get("source") or {}).get("session_id")),
                "status": obj.get("status"),
                "visibility_fingerprint": visibility_fingerprint(obj),
            })
            passages.append(serialize_passage(obj))
        source_fingerprint = _source_fingerprint(
            rows, excluded, model_manifest_digest)

        dirty_path = os.path.join(cache, "DIRTY.json")
        if not os.path.exists(dirty_path):
            try:
                current_manifest, current_rows = load_current_index(
                    cache, expected_model_manifest_digest=model_manifest_digest)
                if current_manifest.get("source_fingerprint") == \
                        source_fingerprint:
                    return {
                        "excluded": excluded,
                        "generation_id": current_manifest["generation_id"],
                        "manifest": current_manifest,
                        "rows": current_rows,
                        "status": "REUSED",
                    }
            except VectorIndexError:
                pass

        if fault_hook:
            fault_hook("before_embedding", {"included_count": len(included)})
        vectors = _embed_all(embedder, passages)
        if len(vectors) != len(rows):
            raise VectorIndexError("INDEX_VECTOR_ROW_MISMATCH")

        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        generation_id = "g-%s-%s-%s" % (
            stamp, source_fingerprint[:12], uuid.uuid4().hex[:8])
        indexes = os.path.join(cache, "indexes")
        os.makedirs(indexes, exist_ok=True)
        _chmod_dir(indexes)
        staging = os.path.join(indexes, ".staging-" + generation_id)
        os.makedirs(staging)
        _chmod_dir(staging)
        rows_path = os.path.join(staging, "rows.jsonl")
        vectors_path = os.path.join(staging, "vectors.f32")
        with open(rows_path, "wb") as fh:
            for row in rows:
                fh.write(_canonical_bytes(row) + b"\n")
            fh.flush()
            os.fsync(fh.fileno())
        with open(vectors_path, "wb") as fh:
            for vector in vectors:
                fh.write(struct.pack("<%df" % DIMENSION, *vector))
            fh.flush()
            os.fsync(fh.fileno())
        _chmod_file(rows_path)
        _chmod_file(vectors_path)
        if fault_hook:
            fault_hook("after_payload_write", {"staging": staging})

        finished = _utc_now()
        manifest = {
            "build_finished_utc": finished,
            "build_started_utc": started,
            "dimension": DIMENSION,
            "dtype": DTYPE,
            "excluded_object_count": len(excluded),
            "excluded_reason_counts": _reason_counts(excluded),
            "files": {
                "rows": {
                    "sha256": _sha256_file(rows_path),
                    "size": os.path.getsize(rows_path),
                },
                "vectors": {
                    "sha256": _sha256_file(vectors_path),
                    "size": os.path.getsize(vectors_path),
                },
            },
            "generation_id": generation_id,
            "included_object_count": len(rows),
            "index_schema_version": INDEX_SCHEMA_VERSION,
            "l2_normalized": True,
            "model": {
                "id": model_id,
                "immutable_revision": model_revision,
            },
            "model_manifest_digest": model_manifest_digest,
            "object_set_digest": _sha256_bytes(_canonical_bytes([{
                "content_hash": row["content_hash"],
                "object_id": row["object_id"],
                "visibility_fingerprint": row["visibility_fingerprint"],
            } for row in rows])),
            "passage_serializer_version": PASSAGE_SERIALIZER_VERSION,
            "source_fingerprint": source_fingerprint,
        }
        manifest["self_hash"] = _manifest_self_hash(manifest)
        manifest_path = os.path.join(staging, "INDEX-MANIFEST.json")
        _atomic_json(manifest_path, manifest)
        if fault_hook:
            fault_hook("before_generation_commit", {"staging": staging})

        final = os.path.join(indexes, generation_id)
        os.replace(staging, final)
        staging = None
        verify_generation(
            cache, generation_id,
            expected_model_manifest_digest=model_manifest_digest)
        if harden_permissions:
            harden_cache_permissions(cache)
        if fault_hook:
            fault_hook("before_current_switch", {"generation": final})
        _atomic_json(os.path.join(cache, "CURRENT.json"), {
            "generation_id": generation_id,
            "manifest_self_hash": manifest["self_hash"],
            "schema_version": 1,
        })
        if os.path.exists(dirty_path):
            os.remove(dirty_path)
        return {
            "build_duration_ms": round(
                (time.monotonic() - started_clock) * 1000.0, 3),
            "excluded": excluded,
            "generation_id": generation_id,
            "manifest": manifest,
            "rows": rows,
            "status": "BUILT",
        }
    finally:
        if staging and os.path.isdir(staging):
            shutil.rmtree(staging, ignore_errors=True)
        _release_build_lock(lock)


def canonical_object_snapshot(repo=None):
    """Hash canonical object/index files for before/after immutability evidence."""
    root = os.path.abspath(repo or paths.REPO)
    memory = os.path.join(root, "memory")
    rels = ["index.json", "object-index.json"]
    objects = os.path.join(memory, "objects")
    if os.path.isdir(objects):
        rels.extend(os.path.join("objects", name) for name in sorted(
            os.listdir(objects)) if name.endswith(".json"))
    result = {}
    for rel in rels:
        path = os.path.join(memory, rel)
        if os.path.isfile(path):
            result[rel.replace("\\", "/")] = _sha256_file(path)
    return result
