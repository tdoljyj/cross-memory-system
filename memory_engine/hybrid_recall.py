# -*- coding: utf-8 -*-
"""R4 Gate 0-D hybrid recall contract.

This module is imported only after T0/T4/temporary short-circuits.  It never
downloads a model and never stores a query.  ``SafeVectorRuntime`` validates a
complete Gate 0-C generation and the live canonical source fingerprint before
embedding the current in-process query.
"""

import json
import math
import os
import struct
import uuid

from . import relevance as REL
from . import schema as S
from . import vector_index as VI


HYBRID_TRACE_VERSION = "r4-g0-hybrid-v1"
MODES = ("off", "test", "shadow")

RC_LEXICAL_ADMIT = "MIV_005A_ADMIT"
RC_VECTOR_ADMIT = "VECTOR_ADMIT"
RC_LEXICAL_AND_VECTOR = "MIV_005A_AND_VECTOR_ADMIT"
RC_BELOW_BOTH = "BELOW_LEXICAL_AND_VECTOR_THRESHOLDS"
RC_LIMIT_TRUNCATED = "LIMIT_TRUNCATED"
RC_CONFLICT_LOSER = "CONFLICT_LOSER"

FB_RUNTIME_MISSING = "HYBRID_RUNTIME_UNAVAILABLE"
FB_INDEX_UNAVAILABLE = "HYBRID_INDEX_UNAVAILABLE"
FB_INDEX_DIRTY = "HYBRID_INDEX_DIRTY"
FB_INDEX_BUILDING = "HYBRID_INDEX_BUILDING"
FB_SOURCE_MISMATCH = "HYBRID_SOURCE_FINGERPRINT_MISMATCH"
FB_MODEL_ERROR = "HYBRID_MODEL_INFERENCE_ERROR"
FB_HISTORY_UNSUPPORTED = "HYBRID_HISTORY_UNSUPPORTED"


def validate_parameters(mode, alpha, tau):
    if mode not in MODES:
        raise ValueError("semantic_mode must be off/test/shadow")
    if mode == "off":
        return
    if not isinstance(alpha, (int, float)) or not 0.0 <= float(alpha) <= 1.0:
        raise ValueError("alpha must be within [0,1]")
    if not isinstance(tau, (int, float)) or not -1.0 <= float(tau) <= 1.0:
        raise ValueError("tau must be within [-1,1]")


def lex_norm(score):
    value = max(0.0, float(score))
    return value / (value + 1.0)


def hybrid_score(lexical_score, cosine, alpha):
    return (float(alpha) * lex_norm(lexical_score) +
            (1.0 - float(alpha)) * max(0.0, float(cosine)))


def _stable_hybrid_sort(items):
    """hybrid/priority/evidence/updated DESC, object_id ASC."""
    ranked = sorted(items, key=lambda item: item["object"]["id"])
    ranked.sort(
        key=lambda item: (item["object"].get("source") or {}).get(
            "updated_at") or "", reverse=True)
    ranked.sort(
        key=lambda item: S.EVIDENCE_PRIORITY.get(
            (item["object"].get("provenance") or {}).get("evidence"), 0),
        reverse=True)
    ranked.sort(
        key=lambda item: S.PRIORITY_WEIGHT.get(
            (item["object"].get("classification") or {}).get("priority"), 0),
        reverse=True)
    ranked.sort(key=lambda item: item["hybrid"], reverse=True)
    return ranked


def admit_and_rank(objects, lexical_scores, cosine_scores, alpha, tau,
                   tags=None, entities=None):
    """Apply the incremental OR contract after hard/conflict filtering."""
    admitted = []
    excluded = []
    metrics = {}
    for obj in objects:
        oid = obj["id"]
        lexical = float(lexical_scores.get(oid, 0.0))
        if oid not in cosine_scores:
            raise VI.VectorIndexError("INDEX_CANDIDATE_VECTOR_MISSING")
        cosine = float(cosine_scores[oid])
        if not math.isfinite(cosine):
            raise VI.VectorIndexError("INDEX_COSINE_NON_FINITE")
        lexical_admit = REL.admit(obj, lexical, tags, entities)
        vector_admit = cosine > float(tau)  # strict greater-than contract
        if lexical_admit and vector_admit:
            source = "LEXICAL_AND_VECTOR"
            reason = RC_LEXICAL_AND_VECTOR
        elif lexical_admit:
            source = "LEXICAL"
            reason = RC_LEXICAL_ADMIT
        elif vector_admit:
            source = "VECTOR"
            reason = RC_VECTOR_ADMIT
        else:
            source = None
            reason = RC_BELOW_BOTH
        item = {
            "admission_source": source,
            "cosine": cosine,
            "hybrid": hybrid_score(lexical, cosine, alpha),
            "lexical": lexical,
            "object": obj,
            "reason_code": reason,
        }
        metrics[oid] = item
        if source is None:
            excluded.append(item)
        else:
            admitted.append(item)
    ranked = _stable_hybrid_sort(admitted)
    return [item["object"] for item in ranked], metrics, excluded


def _source_fingerprint(objects, model_digest, when=None):
    included, excluded = VI.eligible_objects(objects, when=when)
    rows = []
    for obj in included:
        rows.append({
            "content_hash": VI.content_hash(obj),
            "object_id": obj["id"],
            "visibility_fingerprint": VI.visibility_fingerprint(obj),
        })
    return VI._source_fingerprint(rows, excluded, model_digest)


class SafeVectorRuntime(object):
    """Validated brute-force cosine runtime for one external generation."""

    def __init__(self, cache_dir, embedder, model_manifest_digest):
        self.cache_dir = VI.validate_cache_root(cache_dir)
        self.embedder = embedder
        self.model_manifest_digest = model_manifest_digest
        self._model = {
            "id": "intfloat/multilingual-e5-small",
            "immutable_revision": None,
            "manifest_digest": model_manifest_digest,
        }

    def trace_model(self):
        return dict(self._model)

    def score(self, query, candidate_ids, canonical_objects, valid_at=None):
        if os.path.exists(os.path.join(self.cache_dir, "BUILD.lock")):
            raise VI.VectorIndexError(FB_INDEX_BUILDING)
        if os.path.exists(os.path.join(self.cache_dir, "DIRTY.json")):
            raise VI.VectorIndexError(FB_INDEX_DIRTY)
        manifest, rows = VI.load_current_index(
            self.cache_dir, self.model_manifest_digest)
        embedder_digest = getattr(self.embedder, "manifest_digest", None)
        if embedder_digest != self.model_manifest_digest:
            raise VI.VectorIndexError("EMBEDDER_MANIFEST_DIGEST_MISMATCH")
        embedder_model = (getattr(self.embedder, "manifest", None) or {}).get(
            "model") or {}
        index_model = manifest.get("model") or {}
        if embedder_model.get("id") != index_model.get("id") or \
                embedder_model.get("immutable_revision") != \
                index_model.get("immutable_revision"):
            raise VI.VectorIndexError("EMBEDDER_MODEL_IDENTITY_MISMATCH")
        expected = _source_fingerprint(
            canonical_objects, self.model_manifest_digest, when=valid_at)
        if manifest.get("source_fingerprint") != expected:
            raise VI.VectorIndexError(FB_SOURCE_MISMATCH)
        self._model = {
            "id": (manifest.get("model") or {}).get("id"),
            "immutable_revision": (manifest.get("model") or {}).get(
                "immutable_revision"),
            "manifest_digest": self.model_manifest_digest,
        }
        query_rows = VI._rows_from_tensor(
            self.embedder.embed_query(query), 1)
        query_vector = query_rows[0]
        generation_id = manifest["generation_id"]
        vector_path = VI._generation_paths(
            self.cache_dir, generation_id)["vectors"]
        with open(vector_path, "rb") as fh:
            raw = fh.read()
        stride = VI.DIMENSION * 4
        if len(raw) != len(rows) * stride:
            raise VI.VectorIndexError("INDEX_VECTOR_SIZE_MISMATCH")
        wanted = set(candidate_ids)
        scores = {}
        for pos, row in enumerate(rows):
            oid = row["object_id"]
            if oid not in wanted:
                continue
            vector = struct.unpack_from("<%df" % VI.DIMENSION, raw, pos * stride)
            score = sum(a * b for a, b in zip(query_vector, vector))
            if not math.isfinite(score):
                raise VI.VectorIndexError("INDEX_COSINE_NON_FINITE")
            scores[oid] = float(score)
        if set(scores) != wanted:
            raise VI.VectorIndexError("INDEX_CANDIDATE_VECTOR_MISSING")
        return scores


def fallback_code(exc):
    text = str(exc)
    if "EMBEDDER_" in text:
        return FB_MODEL_ERROR
    if FB_INDEX_DIRTY in text:
        return FB_INDEX_DIRTY
    if FB_INDEX_BUILDING in text:
        return FB_INDEX_BUILDING
    if FB_SOURCE_MISMATCH in text:
        return FB_SOURCE_MISMATCH
    if isinstance(exc, VI.VectorIndexError):
        return FB_INDEX_UNAVAILABLE
    return FB_MODEL_ERROR


def _safe_model(runtime):
    try:
        value = runtime.trace_model()
    except Exception:
        value = {}
    return {
        "id": value.get("id"),
        "immutable_revision": value.get("immutable_revision"),
        "manifest_digest": value.get("manifest_digest"),
    }


def build_trace(mode, runtime, metrics, selected_objects, limit,
                inherited_excluded=None, conflict_losers=None,
                fallback=None):
    """Build a no-query/no-content/no-vector/no-token hybrid trace."""
    selected_ids = [obj["id"] for obj in selected_objects]
    selected = []
    for rank, oid in enumerate(selected_ids, 1):
        item = metrics.get(oid) or {}
        selected.append({
            "admission_source": item.get("admission_source"),
            "cosine": item.get("cosine"),
            "hybrid": item.get("hybrid"),
            "lexical": item.get("lexical"),
            "memory_id": oid,
            "rank": rank,
            "reason_codes": [item.get("reason_code")]
            if item.get("reason_code") else [],
        })
    excluded = []
    seen = set()
    for oid, codes in inherited_excluded or []:
        if oid not in seen:
            excluded.append({"memory_id": oid, "reason_codes": list(codes)})
            seen.add(oid)
    for oid in sorted(conflict_losers or []):
        if oid not in seen:
            excluded.append({
                "memory_id": oid, "reason_codes": [RC_CONFLICT_LOSER]})
            seen.add(oid)
    for oid, item in sorted(metrics.items()):
        if item.get("admission_source") is None and oid not in seen:
            excluded.append({
                "memory_id": oid, "reason_codes": [RC_BELOW_BOTH]})
            seen.add(oid)
    ranked_admitted = [
        oid for oid, item in metrics.items()
        if item.get("admission_source") is not None]
    if len(ranked_admitted) > limit:
        for oid in ranked_admitted:
            if oid not in selected_ids and oid not in seen:
                excluded.append({
                    "memory_id": oid, "reason_codes": [RC_LIMIT_TRUNCATED]})
                seen.add(oid)
    trace = {
        "fallback_code": fallback,
        "mode": mode,
        "model": _safe_model(runtime) if runtime is not None else {
            "id": None, "immutable_revision": None, "manifest_digest": None},
        "selected": selected,
        "excluded": excluded,
        "trace_id": "ht-" + uuid.uuid4().hex,
        "trace_version": HYBRID_TRACE_VERSION,
    }
    # Round only the report/trace view. Ranking always used raw floats.
    for entry in selected:
        for key in ("lexical", "cosine", "hybrid"):
            if isinstance(entry.get(key), float):
                entry[key] = round(entry[key], 6)
    return trace
