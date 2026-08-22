# -*- coding: utf-8 -*-
"""Real, side-effect-free Adapter probes and content-free Doctor results."""

from __future__ import annotations

import hashlib
import os
import queue
import threading
from dataclasses import dataclass, field
from typing import Callable, Dict, Iterable, List, Optional

from clued.redact import redact


PROBE_STATUSES = (
    "AVAILABLE", "MISSING", "BROKEN", "TIMEOUT", "STALE_CREDENTIAL",
    "DENIED", "DEGRADED",
)


class StaleCredential(RuntimeError):
    pass


class ProbeDenied(RuntimeError):
    pass


@dataclass(frozen=True)
class ProbeResult:
    adapter: str
    status: str
    code: str
    detail: str = ""
    metadata: Dict[str, object] = field(default_factory=dict)

    def __post_init__(self):
        if self.status not in PROBE_STATUSES:
            raise ValueError("invalid probe status")

    def public(self):
        return {
            "adapter": self.adapter,
            "status": self.status,
            "code": self.code,
            "detail": redact(self.detail)[:300],
            "metadata": dict(self.metadata),
        }


def _file_snapshot(path: str):
    absolute = os.path.abspath(path)
    if not os.path.lexists(absolute):
        return ("MISSING",)
    info = os.lstat(absolute)
    if not os.path.isfile(absolute):
        return ("NON_FILE", info.st_mode, getattr(info, "st_file_attributes", 0))
    digest = hashlib.sha256()
    with open(absolute, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return ("FILE", info.st_size, digest.hexdigest(), info.st_mtime_ns,
            info.st_mode, getattr(info, "st_file_attributes", 0))


def snapshot(paths: Iterable[str]):
    return {os.path.abspath(path): _file_snapshot(path) for path in paths}


class ProbeRunner:
    """Run one real no-op operation and prove protected state is unchanged."""

    def __init__(self, timeout_seconds: float = 2.0):
        self.timeout_seconds = float(timeout_seconds)

    def run(self, adapter: str, operation: Callable[[], object], *,
            protected_paths: Iterable[str] = ()) -> ProbeResult:
        paths = tuple(protected_paths)
        before = snapshot(paths)
        channel = queue.Queue(maxsize=1)

        def invoke():
            try:
                channel.put(("ok", operation()))
            except Exception as exc:
                channel.put(("error", exc))

        worker = threading.Thread(target=invoke, daemon=True)
        worker.start()
        worker.join(self.timeout_seconds)
        after = snapshot(paths)
        if before != after:
            return ProbeResult(
                adapter, "DENIED", "PROBE_MUTATED_PROTECTED_STATE",
                "probe changed protected configuration or credential state")
        if worker.is_alive():
            return ProbeResult(
                adapter, "TIMEOUT", "PROBE_TIMEOUT",
                "probe did not finish within the bounded timeout")
        kind, value = channel.get_nowait()
        if kind == "error":
            if isinstance(value, FileNotFoundError):
                return ProbeResult(adapter, "MISSING", "PROBE_DEPENDENCY_MISSING")
            if isinstance(value, StaleCredential):
                return ProbeResult(
                    adapter, "STALE_CREDENTIAL", "PROBE_STALE_CREDENTIAL")
            if isinstance(value, (PermissionError, ProbeDenied)):
                return ProbeResult(adapter, "DENIED", "PROBE_DENIED")
            if isinstance(value, TimeoutError):
                return ProbeResult(adapter, "TIMEOUT", "PROBE_TIMEOUT")
            return ProbeResult(
                adapter, "BROKEN", "PROBE_FAILED", "probe operation failed")
        if value is False:
            return ProbeResult(adapter, "DEGRADED", "PROBE_NEGATIVE")
        if isinstance(value, dict):
            status = str(value.get("status") or "AVAILABLE").upper()
            if status not in PROBE_STATUSES:
                status = "BROKEN"
            detail = "adapter reported " + status.lower()
            safe_metadata = {
                str(key): item for key, item in value.get("metadata", {}).items()
                if isinstance(item, (bool, int, float)) or item is None
            }
            return ProbeResult(
                adapter, status, str(value.get("code") or "PROBE_OK"),
                detail, safe_metadata)
        return ProbeResult(adapter, "AVAILABLE", "PROBE_OK")


class AdapterSelector:
    """Select the first actually available backend from an ordered list."""

    def __init__(self, runner: Optional[ProbeRunner] = None):
        self.runner = runner or ProbeRunner()

    def select(self, candidates: Iterable[dict]):
        results: List[ProbeResult] = []
        active = None
        for candidate in candidates:
            result = self.runner.run(
                str(candidate["name"]), candidate["probe"],
                protected_paths=candidate.get("protected_paths", ()))
            results.append(result)
            if active is None and result.status == "AVAILABLE":
                active = result.adapter
        status = "AVAILABLE" if active else "DEGRADED"
        return {
            "status": status,
            "active_backend": active,
            "ordered_candidates": [item["name"] for item in candidates],
            "probes": [item.public() for item in results],
        }
