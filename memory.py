#!/usr/bin/env python3
"""Read-only CLI for the Clued v1.6 two-level, five-view snapshot.

Supabase is the only online Canonical Store.  ``memory/`` is a verified,
immutable-at-commit export and must never be used as a write target.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

from verification_context import (
    AuthorizationEvidence,
    EndpointTrust,
    RequestVerificationContext,
    sha256_file,
)


REPO = Path(__file__).resolve().parent
MEMORY = REPO / "memory"
CURRENT_POINTER = REPO / "artifacts" / "clued-two-level-snapshots" / "current.json"
ENDPOINT_TRUST_CONFIG = REPO / "config" / "clued-endpoint-trust.json"
REQUIRED_GLOBAL = ("state.md", "task.md", "decision.md", "archive.md", "log.md")
LEGACY_ROOT_NAMES = {
    "画像.md", "状态.md", "待办.md", "决策.md", "归档.md",
    "object-index.json", "contexts", "audit", "session",
}


def _json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _validate_bundle_uncached(root: Path = MEMORY) -> tuple[dict, list[str]]:
    errors: list[str] = []
    manifest_path = root / "manifest.json"
    index_path = root / "index.json"
    for path in (manifest_path, index_path, root / "profile.md"):
        if not path.is_file():
            errors.append(f"missing:{path.relative_to(root)}")
    for name in REQUIRED_GLOBAL:
        if not (root / "global" / name).is_file():
            errors.append(f"missing:global/{name}")
    for name in LEGACY_ROOT_NAMES:
        if (root / name).exists():
            errors.append(f"legacy-root-entry:{name}")
    for directory in ("projects", "objects/records", "objects/projects", "objects/legacy", "events/raw", "evidence/migration"):
        if not (root / directory).is_dir():
            errors.append(f"missing-dir:{directory}")
    if errors or not manifest_path.is_file():
        return {}, errors
    try:
        manifest = _json(manifest_path)
    except Exception as exc:
        return {}, errors + [f"manifest-invalid:{exc}"]
    expected = {
        "contract": "clued.two-level-five-view.snapshot",
        "baseline_claim": "current",
        "source_verification": "live_rechecked",
        "views_complete": True,
        "status": "ready",
    }
    for key, value in expected.items():
        if manifest.get(key) != value:
            errors.append(f"manifest:{key}={manifest.get(key)!r}")
    snapshot_version = manifest.get("snapshot_version")
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        errors.append("manifest:files-empty")
        files = []
    seen: set[str] = set()
    for item in files:
        rel = item.get("path") if isinstance(item, dict) else None
        digest = item.get("sha256") if isinstance(item, dict) else None
        if not rel or rel in seen or Path(rel).is_absolute() or ".." in Path(rel).parts:
            errors.append(f"manifest:unsafe-or-duplicate-path:{rel}")
            continue
        seen.add(rel)
        path = root / rel
        if not path.is_file():
            errors.append(f"manifest:missing:{rel}")
            continue
        actual = sha256_file(path)
        if actual != digest:
            errors.append(f"manifest:hash-mismatch:{rel}")
        if item.get("snapshot_version") != snapshot_version:
            errors.append(f"manifest:snapshot-mismatch:{rel}")
    return manifest, errors


def validate_bundle(
    root: Path = MEMORY,
    *,
    context: RequestVerificationContext | None = None,
    boundary: str = "repository_snapshot",
) -> tuple[dict, list[str]]:
    if context is None:
        return _validate_bundle_uncached(root)
    return context.verify_bundle(root, _validate_bundle_uncached, boundary=boundary)


def _authorization_evidence() -> AuthorizationEvidence:
    """Bind optional opaque caller policy evidence without reading credentials."""
    return AuthorizationEvidence(
        tenant_ref=os.environ.get("CLUED_TENANT_REF", "not-applicable"),
        organization_ref=os.environ.get("CLUED_ORGANIZATION_REF", "not-applicable"),
        workspace_ref=os.environ.get("CLUED_WORKSPACE_REF", "not-applicable"),
        context_key=os.environ.get("CLUED_CONTEXT_KEY", "not-applicable"),
        binding_id=os.environ.get("CLUED_BINDING_ID", "not-applicable"),
        role=os.environ.get("CLUED_ROLE", "read-only-snapshot"),
        scope_hash=os.environ.get("CLUED_SCOPE_HASH", "not-applicable"),
        purpose=os.environ.get("CLUED_PURPOSE", "local-read"),
        policy_version=os.environ.get("CLUED_POLICY_VERSION", "not-applicable"),
        revocation_epoch=os.environ.get("CLUED_REVOCATION_EPOCH", "not-applicable"),
        session_expires_at=os.environ.get("CLUED_SESSION_EXPIRES_AT"),
        allowed=os.environ.get("CLUED_AUTHORIZED", "true").casefold() == "true",
    )


def new_verification_context(mode: str, remote_head: str = "not-applicable") -> RequestVerificationContext:
    return RequestVerificationContext(
        mode,
        repository_root=REPO,
        pointer_path=CURRENT_POINTER,
        version_path=REPO / "VERSION",
        remote_head=remote_head,
        authorization=_authorization_evidence(),
        endpoint_trust=EndpointTrust.load(ENDPOINT_TRUST_CONFIG),
    )


def cmd_doctor(args) -> int:
    context = getattr(args, "verification_context", None)
    manifest, errors = validate_bundle(context=context)
    if errors:
        for error in errors:
            print(f"[FAIL] {error}")
        print(f"bundle doctor: {len(errors)} FAILURE(S)")
        return 1
    print(f"[PASS] {manifest['snapshot_version']} / {manifest['canonical_version']}")
    print("[PASS] current + live_rechecked + views_complete")
    print(f"[PASS] {len(manifest['files'])} manifest files verified")
    if context is not None:
        sources = context.source_envelope(
            boundary="repository_snapshot",
            sources_read=("memory/manifest.json", "artifacts/clued-two-level-snapshots/current.json"),
            source_versions=(manifest["snapshot_version"], manifest["canonical_version"]),
            freshness="historical",
            degraded_reason=None,
        )
        print(json.dumps({"verification": context.summary(boundary="repository_snapshot", sources=sources)}, ensure_ascii=False))
    print("bundle doctor: ALL PASS")
    return 0


def cmd_status(args) -> int:
    context = getattr(args, "verification_context", None)
    manifest, errors = validate_bundle(context=context)
    if errors:
        print(json.dumps({"status": "invalid", "errors": errors}, ensure_ascii=False, indent=2))
        return 1
    payload = {
        "status": "ready",
        "read_only": True,
        "canonical_store": "Supabase via authenticated Clued API/MCP",
        "snapshot_version": manifest["snapshot_version"],
        "canonical_version": manifest["canonical_version"],
        "baseline_claim": manifest["baseline_claim"],
        "source_verification": manifest["source_verification"],
        "views_complete": manifest["views_complete"],
        "canonical_counts": manifest.get("canonical_counts", {}),
        "snapshot_counts": manifest.get("snapshot_counts", {}),
    }
    if context is not None:
        sources = context.source_envelope(
            boundary="repository_snapshot",
            sources_read=("memory/manifest.json", "artifacts/clued-two-level-snapshots/current.json"),
            source_versions=(manifest["snapshot_version"], manifest["canonical_version"]),
            freshness="historical",
            degraded_reason=None,
        )
        payload["verification"] = context.summary(boundary="repository_snapshot", sources=sources)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def _candidate_views(tier: str, history: bool, project_id: str | None) -> list[Path]:
    if tier == "T0":
        return []
    paths = [MEMORY / "profile.md", *(MEMORY / "global" / n for n in ("state.md", "task.md", "decision.md"))]
    project_root = MEMORY / "projects"
    projects = [project_root / project_id] if project_id else sorted(p for p in project_root.iterdir() if p.is_dir())
    for project in projects:
        paths.extend(project / n for n in ("state.md", "task.md", "decision.md"))
        if history:
            paths.extend(project / n for n in ("archive.md", "log.md"))
    if history:
        paths.extend(MEMORY / "global" / n for n in ("archive.md", "log.md"))
    if tier == "T3":
        paths = [p for p in paths if p.name in {"state.md", "task.md", "decision.md"}]
    return [p for p in paths if p.is_file()]


def _tokens(query: str) -> list[str]:
    words = re.findall(r"[\w.-]+", query.casefold())
    return sorted(set([query.casefold(), *words]), key=len, reverse=True)


def cmd_recall(args) -> int:
    # T0/NONE is deliberately decided before any Context, Git, pointer,
    # manifest, directory, or memory view access.
    if args.tier == "T0":
        print(json.dumps({
            "tier": "T0",
            "snapshot_version": None,
            "sources_read": [],
            "results": [],
            "verification_context": None,
        }, ensure_ascii=False, indent=2))
        return 0
    context = getattr(args, "verification_context", None)
    manifest, errors = validate_bundle(context=context)
    if errors:
        print(json.dumps({"status": "invalid", "errors": errors}, ensure_ascii=False, indent=2))
        return 1
    paths = _candidate_views(args.tier, args.history, args.project_id)
    tokens = _tokens(args.query)
    results = []
    for path in paths:
        text = path.read_text(encoding="utf-8")
        folded = text.casefold()
        score = sum(folded.count(token) * max(1, len(token)) for token in tokens if token)
        if score == 0 and args.tier != "T1":
            continue
        first = min((folded.find(t) for t in tokens if t and folded.find(t) >= 0), default=0)
        start = max(0, first - 180)
        excerpt = text[start:start + 700].strip()
        results.append({"path": path.relative_to(REPO).as_posix(), "score": score, "excerpt": excerpt})
    results.sort(key=lambda item: (-item["score"], item["path"]))
    # Detect any in-request input substitution after the view reads and before
    # the answer is labeled authoritative.
    manifest, errors = validate_bundle(context=context)
    if not errors and context is not None and not context.last_reused:
        errors = ["verification-input-changed-during-read"]
    if errors:
        print(json.dumps({"status": "invalid", "errors": errors}, ensure_ascii=False, indent=2))
        return 1
    payload = {
        "tier": args.tier,
        "snapshot_version": manifest["snapshot_version"],
        "canonical_version": manifest["canonical_version"],
        "sources_read": [p.relative_to(REPO).as_posix() for p in paths],
        "results": results[: args.limit],
    }
    if context is not None:
        sources = context.source_envelope(
            boundary="repository_snapshot",
            sources_read=(
                "memory/manifest.json",
                "artifacts/clued-two-level-snapshots/current.json",
                *(p.relative_to(REPO).as_posix() for p in paths),
            ),
            source_versions=(manifest["snapshot_version"], manifest["canonical_version"]),
            freshness="historical",
            degraded_reason=None,
        )
        payload["verification"] = context.summary(boundary="repository_snapshot", sources=sources)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def cmd_retired(args) -> int:
    print(json.dumps({
        "status": "rejected",
        "reason": "local_snapshot_is_read_only",
        "command": args.command,
        "write_path": "Use authenticated Clued M1 tools (record_mutate / decision_supersede / project_mutate); then publish a new live-rechecked snapshot.",
    }, ensure_ascii=False, indent=2), file=sys.stderr)
    return 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Clued v1.6 read-only snapshot CLI")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("doctor").set_defaults(func=cmd_doctor)
    sub.add_parser("status").set_defaults(func=cmd_status)
    recall = sub.add_parser("recall")
    recall.add_argument("query")
    recall.add_argument("--tier", default="T2", choices=("T0", "T1", "T2", "T3", "T4"))
    recall.add_argument("--history", action="store_true")
    recall.add_argument("--project-id")
    recall.add_argument("--limit", type=int, default=10)
    recall.set_defaults(func=cmd_recall)
    for name in ("add", "update", "supersede", "consolidate", "procedural", "rebuild-index", "migrate", "delete", "reject", "audit"):
        retired = sub.add_parser(name, add_help=False)
        retired.add_argument("args", nargs=argparse.REMAINDER)
        retired.set_defaults(func=cmd_retired)
    return parser


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] in {
        "add", "update", "supersede", "consolidate", "procedural",
        "rebuild-index", "migrate", "delete", "reject", "audit",
    }:
        return cmd_retired(argparse.Namespace(command=sys.argv[1]))
    parser = build_parser()
    args = parser.parse_args()
    if args.command == "recall" and args.tier == "T0":
        args.verification_context = None
    else:
        mode = "AUDIT_FULL" if args.command == "doctor" else "READ_SNAPSHOT_HISTORICAL"
        args.verification_context = new_verification_context(mode)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
