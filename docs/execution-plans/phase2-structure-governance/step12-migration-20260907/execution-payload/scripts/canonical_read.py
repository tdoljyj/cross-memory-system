"""P4 Canonical-first reads and deterministic T1 snapshot routing.

The authenticated Canonical client is supplied by the caller.  This repository
never embeds production credentials or turns a historical Snapshot into online
authority.
"""

from __future__ import annotations

import datetime as dt
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping, Sequence


POLICY_TTLS = {"strict": 3600, "balanced": 21600, "degraded": 1800}
CURRENT_VIEWS = ("state", "task", "decision")
HISTORICAL_VIEWS = ("archive", "log")
ALL_VIEWS = frozenset((*CURRENT_VIEWS, *HISTORICAL_VIEWS))
PROFILE_TRIGGERS = frozenset({
    "identity", "profile", "preference", "preferences",
    "身份", "画像", "偏好", "工作偏好", "用户偏好",
})
PROJECT_ID_RE = re.compile(
    r"(?<![0-9a-f])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f])",
    re.IGNORECASE,
)
PROJECT_ID_CANDIDATE_RE = re.compile(
    r"(?<![0-9A-Za-z])([0-9A-Za-z]{8}-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}-[0-9A-Za-z]{12})(?![0-9A-Za-z])"
)
PROJECT_PROGRESS_STATUSES = frozenset({"active", "paused", "completed", "archived"})
RECORD_LIFECYCLE_STATUSES = frozenset({"active", "archived", "superseded"})


class P4ReadError(RuntimeError):
    """A P4 authority, freshness, or deterministic-routing invariant failed."""

    def __init__(self, code: str, detail: str):
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


class CanonicalAccessError(P4ReadError):
    """An authenticated Canonical transport classified the failed access."""


@dataclass(frozen=True)
class FreshnessDecision:
    policy_id: str
    verified_at: str
    stale_age_seconds: int
    effective_expires_at: str
    freshness: str


@dataclass(frozen=True)
class T1Plan:
    requested_tier: str
    access_tier: str
    reason: str
    selector: str
    project_id: str | None
    paths: tuple[Path, ...]
    sources_read: tuple[str, ...]
    source_versions: tuple[str, ...]
    expansion_reason: str | None


def _parse_time(value: object, field: str) -> dt.datetime:
    if not isinstance(value, str) or not value:
        raise P4ReadError("SOURCE_ENVELOPE_INCOMPLETE", f"{field} is required")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise P4ReadError("SOURCE_ENVELOPE_INVALID", f"{field} is not RFC3339") from exc
    if parsed.tzinfo is None:
        raise P4ReadError("SOURCE_ENVELOPE_INVALID", f"{field} has no timezone")
    return parsed.astimezone(dt.timezone.utc)


def _iso(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def compute_freshness(
    *, policy_id: str, trusted_now: dt.datetime, verified_at: object,
    live_rechecked_at: object, session_expires_at: object,
    degraded_expires_at: object | None = None, degraded: bool = False,
) -> FreshnessDecision:
    """Apply the single P4 effective-expiry formula and fail closed."""
    if policy_id not in POLICY_TTLS:
        raise P4ReadError("FRESHNESS_POLICY_UNKNOWN", str(policy_id))
    if trusted_now.tzinfo is None:
        raise P4ReadError("CLOCK_UNTRUSTED", "trusted_now has no timezone")
    now = trusted_now.astimezone(dt.timezone.utc)
    verified = _parse_time(verified_at, "verified_at")
    live = _parse_time(live_rechecked_at, "live_rechecked_at")
    session = _parse_time(session_expires_at, "session_expires_at")
    if verified > now or live > now:
        raise P4ReadError("CLOCK_UNTRUSTED", "source timestamp is in the future")
    expiries = [session, live + dt.timedelta(seconds=POLICY_TTLS[policy_id])]
    if degraded:
        if policy_id != "degraded":
            raise P4ReadError("FRESHNESS_POLICY_INVALID", "degraded reads require degraded policy")
        expiries.append(_parse_time(degraded_expires_at, "degraded_expires_at"))
    elif policy_id == "degraded":
        raise P4ReadError("FRESHNESS_POLICY_INVALID", "degraded policy requires degraded source")
    effective = min(expiries)
    if now >= effective:
        raise P4ReadError("SOURCE_EXPIRED", f"effective expiry {_iso(effective)}")
    return FreshnessDecision(
        policy_id=policy_id, verified_at=_iso(verified),
        stale_age_seconds=max(0, int((now - verified).total_seconds())),
        effective_expires_at=_iso(effective),
        freshness="degraded" if degraded else "current",
    )


def _require_string_list(value: object, field: str) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise P4ReadError("SOURCE_ENVELOPE_INCOMPLETE", f"{field} must be a non-empty list")
    result = list(value)
    if not result or any(not isinstance(item, str) or not item for item in result):
        raise P4ReadError("SOURCE_ENVELOPE_INCOMPLETE", f"{field} must be a non-empty list")
    return result


def _validate_payload(payload: object, *, degraded: bool, trusted_now: dt.datetime) -> dict:
    if not isinstance(payload, Mapping):
        raise P4ReadError("SOURCE_ENVELOPE_INCOMPLETE", "response is not an object")
    source_kind = payload.get("source_kind")
    expected_kind = "snapshot_lkg" if degraded else "canonical_live"
    if source_kind != expected_kind:
        raise P4ReadError("SOURCE_BOUNDARY_MISMATCH", f"expected {expected_kind}, got {source_kind}")
    authoritative = payload.get("authoritative")
    if degraded and authoritative is not False:
        raise P4ReadError("INVALID_AUTHORITY_CLAIM", "LKG/degraded data cannot claim current authority")
    if not degraded and authoritative is not True:
        raise P4ReadError("INVALID_AUTHORITY_CLAIM", "Canonical current response must explicitly claim authority")
    sources_read = _require_string_list(payload.get("sources_read"), "sources_read")
    source_versions = _require_string_list(payload.get("source_versions"), "source_versions")
    if payload.get("complete") is not True:
        raise P4ReadError("SOURCE_ENVELOPE_INCOMPLETE", "complete must be true")
    if payload.get("source_conflicts"):
        raise P4ReadError("SOURCE_CONFLICT", "current sources disagree")
    views = payload.get("views")
    if not isinstance(views, Mapping) or any(name not in ALL_VIEWS for name in views):
        raise P4ReadError("FIELD_AUTHORITY_INVALID", "views contain missing or unknown authority classes")
    if any(name not in views for name in CURRENT_VIEWS):
        raise P4ReadError("FIELD_AUTHORITY_INVALID", "State, Task, and Decision are all required")
    field_versions = payload.get("field_versions")
    if not isinstance(field_versions, Mapping):
        raise P4ReadError("SOURCE_ENVELOPE_INCOMPLETE", "field_versions missing")
    for name in views:
        if not isinstance(field_versions.get(name), str) or not field_versions[name]:
            raise P4ReadError("SOURCE_ENVELOPE_INCOMPLETE", f"field version missing for {name}")
    degraded_reason = payload.get("degraded_reason")
    if degraded and (not isinstance(degraded_reason, str) or not degraded_reason):
        raise P4ReadError("SOURCE_ENVELOPE_INCOMPLETE", "degraded_reason missing")
    if not degraded and degraded_reason is not None:
        raise P4ReadError("SOURCE_ENVELOPE_INVALID", "current response has degraded_reason")
    freshness = compute_freshness(
        policy_id=payload.get("policy_id"), trusted_now=trusted_now,
        verified_at=payload.get("verified_at"), live_rechecked_at=payload.get("live_rechecked_at"),
        session_expires_at=payload.get("session_expires_at"),
        degraded_expires_at=payload.get("degraded_expires_at"), degraded=degraded,
    )
    return {
        "status": "degraded-read-only" if degraded else "authoritative-current",
        "authoritative": not degraded,
        "freshness": freshness.__dict__, "degraded_reason": degraded_reason,
        "current": {name: views[name] for name in CURRENT_VIEWS},
        "archive": views.get("archive"), "log_event_evidence": views.get("log"),
        "log_conflicts": list(payload.get("log_conflicts") or []),
        "sources_read": sources_read, "source_versions": source_versions,
        "field_versions": {name: field_versions[name] for name in views},
    }


def canonical_first_read(
    canonical_loader: Callable[[], Mapping], lkg_loader: Callable[[], Mapping],
    *, trusted_now: dt.datetime,
) -> dict:
    """Read Canonical first; only classified UNAVAILABLE permits LKG fallback."""
    try:
        canonical = canonical_loader()
    except CanonicalAccessError as exc:
        if exc.code != "UNAVAILABLE":
            raise
        degraded = _validate_payload(lkg_loader(), degraded=True, trusted_now=trusted_now)
        degraded["fallback_trigger"] = "UNAVAILABLE"
        return degraded
    return _validate_payload(canonical, degraded=False, trusted_now=trusted_now)


def _relative(repo: Path, paths: Sequence[Path]) -> tuple[str, ...]:
    return tuple(path.relative_to(repo).as_posix() for path in paths)


def _load_json(path: Path, code: str) -> Mapping:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise P4ReadError(code, path.as_posix()) from exc
    if not isinstance(value, Mapping):
        raise P4ReadError(code, path.as_posix())
    return value


def _is_positive_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _validate_project_object(
    path: Path, *, project_id: str, snapshot_version: str, canonical_version: str,
) -> Mapping:
    """Validate the exact Project Object before consulting derived routing data."""
    value = _load_json(path, "PROJECT_OBJECT_INVALID")
    if value.get("kind") != "project":
        raise P4ReadError("PROJECT_OBJECT_KIND_INVALID", project_id)
    if value.get("canonical_id") != project_id:
        raise P4ReadError("PROJECT_OBJECT_IDENTITY_MISMATCH", "canonical_id")
    if value.get("snapshot_version") != snapshot_version:
        raise P4ReadError("PROJECT_OBJECT_VERSION_MISMATCH", "snapshot_version")
    if value.get("canonical_version") != canonical_version:
        raise P4ReadError("PROJECT_OBJECT_VERSION_MISMATCH", "canonical_version")
    if not _is_positive_int(value.get("schema_version")):
        raise P4ReadError("PROJECT_OBJECT_INVALID", "schema_version")

    data = value.get("data")
    if not isinstance(data, Mapping):
        raise P4ReadError("PROJECT_OBJECT_INVALID", "data")
    if data.get("canonical_project_id") != project_id:
        raise P4ReadError("PROJECT_OBJECT_IDENTITY_MISMATCH", "data.canonical_project_id")
    required_strings = ("name", "certainty_status", "progress_status", "lifecycle_status", "recorded_at", "updated_at")
    if any(not isinstance(data.get(field), str) or not data[field] for field in required_strings):
        raise P4ReadError("PROJECT_OBJECT_INVALID", "required data string")
    if not _is_positive_int(data.get("project_schema_version")) or not _is_positive_int(data.get("version")):
        raise P4ReadError("PROJECT_OBJECT_INVALID", "data version")
    merge_generation = data.get("merge_generation")
    if not isinstance(merge_generation, int) or isinstance(merge_generation, bool) or merge_generation < 0:
        raise P4ReadError("PROJECT_OBJECT_INVALID", "merge_generation")
    aliases = data.get("aliases")
    if not isinstance(aliases, list) or any(not isinstance(alias, str) for alias in aliases):
        raise P4ReadError("PROJECT_OBJECT_INVALID", "aliases")
    for field in ("closed_at", "closed_reason", "closure_summary", "receipt_id"):
        if field not in data or (data[field] is not None and not isinstance(data[field], str)):
            raise P4ReadError("PROJECT_OBJECT_INVALID", field)
    if "merged_into_project_id" not in data:
        raise P4ReadError("PROJECT_OBJECT_INVALID", "merged_into_project_id")
    if (
        data["certainty_status"] != "confirmed"
        or data["lifecycle_status"] != "active"
        or data["progress_status"] not in PROJECT_PROGRESS_STATUSES
        or data.get("merged_into_project_id") is not None
    ):
        raise P4ReadError("PROJECT_OBJECT_LIFECYCLE_INVALID", project_id)
    return value


def _validate_project_index_route(
    index: Mapping, *, memory: Path, project_id: str, snapshot_version: str,
) -> str | None:
    """Return a rejection reason, or None when the derived route is valid."""
    if not _is_positive_int(index.get("schema_version")):
        return "index-schema-version"
    if index.get("snapshot_version") != snapshot_version:
        return "index-snapshot-version"
    by_scope = index.get("by_scope")
    by_id = index.get("by_id")
    projects = by_scope.get("projects") if isinstance(by_scope, Mapping) else None
    if not isinstance(projects, Mapping) or not isinstance(by_id, Mapping):
        return "index-schema"
    route = projects.get(project_id)
    if route is None:
        return "index-route-missing"
    if not isinstance(route, list) or not route:
        return "index-route-type"
    if any(
        not isinstance(record_id, str)
        or PROJECT_ID_RE.fullmatch(record_id) is None
        or record_id != record_id.casefold()
        for record_id in route
    ):
        return "index-record-id"
    if len(route) != len(set(route)):
        return "index-route-duplicate"
    expected_scope = f"project:{project_id}"
    for record_id in route:
        entry = by_id.get(record_id)
        if not isinstance(entry, Mapping) or entry.get("kind") != "record":
            return "index-record-missing"
        if entry.get("effective_scope") != expected_scope:
            return "index-record-scope"
        if entry.get("lifecycle_status") not in RECORD_LIFECYCLE_STATUSES:
            return "index-record-lifecycle"
        expected_path = f"objects/records/{record_id}.json"
        if entry.get("path") != expected_path:
            return "index-record-path"
        if not (memory / expected_path).is_file():
            return "index-record-target-missing"
    return None


def deterministic_t1_plan(
    repo: Path, *, query: str, project_id: str | None, history: bool,
    snapshot_version: str, canonical_version: str,
) -> T1Plan:
    """Resolve exact T1 selectors; zero-match becomes minimal T3 Global STD."""
    if not isinstance(query, str):
        raise P4ReadError("T1_SELECTOR_INVALID", "query must be a string")
    query_candidates = PROJECT_ID_CANDIDATE_RE.findall(query)
    if any(PROJECT_ID_RE.fullmatch(candidate) is None for candidate in query_candidates):
        raise P4ReadError("T1_SELECTOR_INVALID", "query contains a malformed UUID selector")
    query_ids = {match.casefold() for match in PROJECT_ID_RE.findall(query)}
    if project_id is not None and (
        not isinstance(project_id, str) or PROJECT_ID_RE.fullmatch(project_id) is None
    ):
        raise P4ReadError("T1_SELECTOR_INVALID", "project_id must be one canonical UUID")
    selected = project_id.casefold() if isinstance(project_id, str) else None
    selector = "explicit-project-id" if selected else "query-canonical-id"
    if selected and query_ids and query_ids != {selected}:
        raise P4ReadError("T1_SELECTOR_CONFLICT", "explicit and query project IDs differ")
    if not selected and len(query_ids) == 1:
        selected = next(iter(query_ids))
    if len(query_ids) > 1:
        raise P4ReadError("T1_SELECTOR_AMBIGUOUS", "multiple canonical project IDs")

    # No filesystem path derived from user input is constructed before all
    # selector syntax, conflict, and ambiguity checks above have completed.
    memory = repo / "memory"
    index_path = memory / "index.json"

    if selected:
        object_path = memory / "objects" / "projects" / f"{selected}.json"
        _validate_project_object(
            object_path, project_id=selected,
            snapshot_version=snapshot_version, canonical_version=canonical_version,
        )
        try:
            index = _load_json(index_path, "INDEX_INVALID")
            route_rejection = _validate_project_index_route(
                index, memory=memory, project_id=selected, snapshot_version=snapshot_version,
            )
        except P4ReadError:
            route_rejection = "index-invalid"
        reason = (
            "unique-canonical-project-route"
            if route_rejection is None
            else "index-rejected-exact-object-fallback"
        )
        project_root = memory / "projects" / selected
        names = ["state.md", "task.md", "decision.md"]
        if history:
            names.extend(("archive.md", "log.md"))
        paths = tuple(project_root / name for name in names)
        if any(not path.is_file() for path in paths):
            raise P4ReadError("T1_TARGET_INCOMPLETE", selected)
        sources = [object_path, index_path, *paths]
        return T1Plan(
            "T1", "T1", reason, selector, selected, paths, _relative(repo, sources),
            (snapshot_version, canonical_version),
            "history-explicitly-requested" if history else None,
        )

    index = _load_json(index_path, "INDEX_INVALID")
    by_scope = index.get("by_scope")
    projects = by_scope.get("projects") if isinstance(by_scope, Mapping) else None
    if not isinstance(projects, Mapping):
        raise P4ReadError("INDEX_INVALID", "by_scope.projects missing")
    folded = query.casefold()
    if any(trigger in folded for trigger in PROFILE_TRIGGERS):
        profile = memory / "profile.md"
        if not profile.is_file():
            raise P4ReadError("T1_TARGET_INCOMPLETE", "profile")
        return T1Plan(
            "T1", "T1", "unique-profile-trigger", "profile-trigger", None, (profile,),
            _relative(repo, (index_path, profile)), (snapshot_version, canonical_version), None,
        )

    paths = tuple(memory / "global" / name for name in ("state.md", "task.md", "decision.md"))
    if any(not path.is_file() for path in paths):
        raise P4ReadError("T3_TARGET_INCOMPLETE", "global")
    return T1Plan(
        "T1", "T3", "t1-zero-match-global-std", "no-deterministic-selector", None, paths,
        _relative(repo, (index_path, *paths)), (snapshot_version, canonical_version), None,
    )
