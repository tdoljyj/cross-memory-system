# -*- coding: utf-8 -*-
"""Safe lexical recall, evidence tiers and deterministic index generations."""

from __future__ import annotations

import copy
import hashlib
import json
import re
import time
from dataclasses import dataclass
from typing import Callable, Dict, Iterable, Optional

from .idempotency import CallerIdentity
from .security import AccessController, SecurityError


EVIDENCE_LEVELS = ("PREVIEW", "VERIFIED", "AUDIT")
HARD_EXCLUDED_STATUSES = {
    "deleted": "DELETED",
    "quarantined": "QUARANTINED",
    "superseded": "SUPERSEDED",
    "conflict_loser": "CONFLICT_LOSER",
    "archived": "ARCHIVED",
}
SEMANTIC_RECALL_ENABLED = False


class RecallError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class GenerationBuildError(RecallError):
    pass


def _canonical(value) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True,
        separators=(",", ":")).encode("utf-8")


def _hash(value) -> str:
    return hashlib.sha256(_canonical(value)).hexdigest()


def tokenize(value: str):
    """Deterministic lexical tokenizer with CJK character support."""
    text = str(value or "").casefold()
    terms = []
    for match in re.finditer(r"[a-z0-9_]+|[\u3400-\u9fff]+", text):
        token = match.group(0)
        terms.append(token)
        if any("\u3400" <= char <= "\u9fff" for char in token):
            terms.extend(list(token))
            terms.extend(token[i:i + 2] for i in range(len(token) - 1))
    return tuple(sorted(set(term for term in terms if term)))


@dataclass(frozen=True)
class GenerationManifest:
    generation_id: str
    canonical_committed_seq: int
    source_manifest_hash: str
    provider_or_extractor_identity: str
    schema_version: int
    build_parameters_hash: str
    created_at: float

    def public(self):
        return {
            "generation_id": self.generation_id,
            "canonical_committed_seq": self.canonical_committed_seq,
            "source_manifest_hash": self.source_manifest_hash,
            "provider_or_extractor_identity":
                self.provider_or_extractor_identity,
            "schema_version": self.schema_version,
            "build_parameters_hash": self.build_parameters_hash,
            "created_at": self.created_at,
        }


@dataclass
class IndexGeneration:
    manifest: GenerationManifest
    documents: Dict[str, dict]
    tokens: Dict[str, tuple]
    cache: Dict[str, tuple]


class DeterministicIndexBuilder:
    """Build a generation atomically; mixed or interrupted input never wins."""

    def __init__(self, provider_identity: str = "clued-cloud-fts/v1",
                 schema_version: int = 1, clock=time.time):
        self.provider_identity = str(provider_identity)
        self.schema_version = int(schema_version)
        self.clock = clock
        self.current: Optional[IndexGeneration] = None

    @staticmethod
    def _normalized(objects: Iterable[dict]):
        values = [copy.deepcopy(item) for item in objects]
        values.sort(key=lambda item: str(item.get("id") or ""))
        return values

    def build(self, source_loader: Callable[[], Iterable[dict]], *,
              canonical_committed_seq: int, parameters: Optional[dict] = None,
              previous: Optional[IndexGeneration] = None):
        parameters = dict(parameters or {})
        first = self._normalized(source_loader())
        first_hash = _hash(first)
        parameters_hash = _hash(parameters)
        documents = {}
        tokens = {}
        cache = {}
        prior_cache = previous.cache if previous else {}

        for item in first:
            object_id = str(item.get("id") or "")
            if not object_id:
                raise GenerationBuildError("INDEX_OBJECT_ID_MISSING")
            content_hash = hashlib.sha256(
                str(item.get("content") or "").encode("utf-8")).hexdigest()
            cache_key = _hash({
                "content_hash": content_hash,
                "provider": self.provider_identity,
                "schema_version": self.schema_version,
                "parameters_hash": parameters_hash,
            })
            object_tokens = prior_cache.get(cache_key)
            if object_tokens is None:
                object_tokens = tokenize(
                    " ".join([
                        str(item.get("content") or ""),
                        " ".join(str(value) for value in item.get("tags", [])),
                        " ".join(
                            str(value) for value in item.get("entities", [])),
                    ]))
            documents[object_id] = item
            tokens[object_id] = tuple(object_tokens)
            cache[cache_key] = tuple(object_tokens)

        second = self._normalized(source_loader())
        if _hash(second) != first_hash:
            raise GenerationBuildError("SOURCE_CHANGED_DURING_BUILD")
        identity = {
            "canonical_committed_seq": int(canonical_committed_seq),
            "source_manifest_hash": first_hash,
            "provider_or_extractor_identity": self.provider_identity,
            "schema_version": self.schema_version,
            "build_parameters_hash": parameters_hash,
        }
        manifest = GenerationManifest(
            generation_id=_hash(identity),
            canonical_committed_seq=int(canonical_committed_seq),
            source_manifest_hash=first_hash,
            provider_or_extractor_identity=self.provider_identity,
            schema_version=self.schema_version,
            build_parameters_hash=parameters_hash,
            created_at=float(self.clock()))
        candidate = IndexGeneration(manifest, documents, tokens, cache)
        self.current = candidate
        return candidate


class CloudFTSProvider:
    """Safe lexical provider over one immutable current generation."""

    identity = "clued-cloud-fts/v1"

    def __init__(self, generation: IndexGeneration):
        self.generation = generation

    def freshness(self, canonical_committed_seq: int):
        if (self.generation.manifest.canonical_committed_seq
                != int(canonical_committed_seq)):
            return {"status": "DEGRADED", "code": "INDEX_STALE"}
        return {"status": "AVAILABLE", "code": "INDEX_CURRENT"}

    def candidates(self, query: str):
        terms = set(tokenize(query))
        values = []
        for object_id, document in self.generation.documents.items():
            document_terms = set(self.generation.tokens[object_id])
            overlap = len(terms & document_terms)
            phrase = int(
                str(query or "").casefold()
                in str(document.get("content") or "").casefold())
            score = overlap * 10 + phrase
            if score:
                values.append((score, object_id, document))
        values.sort(key=lambda row: (-row[0], row[1]))
        return values


class SafeRecallEngine:
    """Hard-filter-before-rank lexical recall with machine evidence levels."""

    def __init__(self, provider: CloudFTSProvider,
                 access: AccessController, *,
                 canonical_committed_seq: int,
                 version_loader: Optional[Callable[[str], Optional[str]]] = None,
                 clock=time.time, max_results: int = 5):
        self.provider = provider
        self.access = access
        self.canonical_committed_seq = int(canonical_committed_seq)
        self.version_loader = version_loader or (
            lambda object_id: self.provider.generation.documents.get(
                object_id, {}).get("version_id"))
        self.clock = clock
        self.max_results = min(max(1, int(max_results)), 20)
        self.semantic_recall_enabled = False

    def _exclude(self, caller: CallerIdentity, item: dict):
        if str(item.get("account_id") or "") != caller.account_id:
            return "CROSS_TENANT"
        allowed_bindings = item.get("allowed_bindings")
        if allowed_bindings and caller.binding_id not in allowed_bindings:
            return "BINDING_DENIED"
        if not self.access.can_read_object(caller, item):
            return "SCOPE_DENIED"
        if str(item.get("sensitivity") or "").upper() == "SECRET":
            return "SECRET"
        status = str(item.get("status") or "active").lower()
        if status in HARD_EXCLUDED_STATUSES:
            return HARD_EXCLUDED_STATUSES[status]
        truth = str(item.get("truth_state") or "").upper()
        if truth in ("REJECTED", "UNTRUSTED", "CONFLICT_LOSER"):
            return "TRUTH_REJECTED"
        now = float(self.clock())
        valid_from = item.get("valid_from")
        valid_until = item.get("valid_until")
        if valid_from is not None and float(valid_from) > now:
            return "NOT_YET_VALID"
        if valid_until is not None and float(valid_until) <= now:
            return "EXPIRED"
        return None

    def recall(self, caller: CallerIdentity, query: str, *,
               evidence_level: str = "VERIFIED", limit: Optional[int] = None,
               audit_scope_complete: bool = False,
               pagination_complete: bool = False):
        evidence_level = str(evidence_level or "").upper()
        if evidence_level not in EVIDENCE_LEVELS:
            raise RecallError("EVIDENCE_LEVEL_INVALID")
        self.access.require(caller, "memory:read")
        freshness = self.provider.freshness(self.canonical_committed_seq)
        trace = {
            "query_hash": hashlib.sha256(
                str(query or "").encode("utf-8")).hexdigest(),
            "provider": self.provider.identity,
            "generation_id":
                self.provider.generation.manifest.generation_id,
            "evidence_level": evidence_level,
            "candidates": [],
            "exclusions": [],
        }
        accepted = []
        for score, object_id, item in self.provider.candidates(query):
            reason = self._exclude(caller, item)
            if reason is None and evidence_level in ("VERIFIED", "AUDIT"):
                current_version = self.version_loader(object_id)
                if current_version != item.get("version_id"):
                    reason = "SOURCE_VERSION_MISMATCH"
            if reason:
                trace["exclusions"].append(
                    {"id": object_id, "reason": reason})
                continue
            trace["candidates"].append(
                {"id": object_id, "score": score, "reason": "SELECTED"})
            accepted.append((score, object_id, item))

        maximum = min(limit or self.max_results, self.max_results)
        has_more = len(accepted) > maximum
        selected = accepted[:maximum]
        audit_complete = (
            evidence_level == "AUDIT"
            and audit_scope_complete
            and pagination_complete
            and not has_more
            and freshness["status"] == "AVAILABLE")
        results = []
        for score, object_id, item in selected:
            results.append({
                "id": object_id,
                "version_id": item.get("version_id"),
                "content": item.get("content"),
                "score": score,
                "provisional": evidence_level == "PREVIEW",
            })
        return {
            "status": "OK" if results else "NO_MEMORY",
            "results": results,
            "trace": trace,
            "evidence_level": evidence_level,
            "evidence_incomplete": not audit_complete,
            "completeness_claim_allowed": audit_complete,
            "freshness": freshness,
            "semantic_recall_enabled": False,
        }
