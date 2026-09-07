#!/usr/bin/env python3
"""Generate a fail-closed inventory of Clued naming surfaces.

This tool is intentionally read-only. It inventories tracked repository paths,
machine identifiers, version/stage tokens, path-normalization collisions, and
GitHub-owned naming surfaces. It does not rename, migrate, retire, accept, or
authorize any object.

The generated manifest is evidence for Structure Freeze preparation, not a
Structure Freeze decision and not a naming closeout.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path, PurePosixPath
from typing import Any

SCHEMA = "clued.naming-surface-inventory-manifest/v1"
FINDINGS_SCHEMA = "clued.naming-surface-inventory-findings/v1"
SUMMARY_SCHEMA = "clued.naming-surface-inventory-summary/v1"

TEXT_EXTENSIONS = {
    ".c", ".cc", ".cfg", ".conf", ".cpp", ".css", ".csv", ".env", ".go",
    ".h", ".hpp", ".html", ".ini", ".java", ".js", ".json", ".jsonl",
    ".jsx", ".md", ".mjs", ".mts", ".ps1", ".py", ".rb", ".rs", ".sh",
    ".sql", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
}
MACHINE_EXTENSIONS = {
    ".c", ".cc", ".cfg", ".conf", ".cpp", ".env", ".go", ".h", ".hpp",
    ".ini", ".java", ".js", ".json", ".jsonl", ".jsx", ".mjs", ".mts",
    ".ps1", ".py", ".rb", ".rs", ".sh", ".sql", ".toml", ".ts", ".tsx",
    ".xml", ".yaml", ".yml",
}
MACHINE_PATH_PREFIXES = (
    ".github/", "scripts/", "config/", "protocol/", "schemas/", "contracts/",
    "apps/", "packages/", "adapters/", "plugins/",
)

URN_RE = re.compile(r"\burn:clued:[A-Za-z0-9._~:/#?=&%+\-]+")
CLUED_TOKEN_RE = re.compile(
    r"\bclued(?:[.@:/_-][A-Za-z0-9][A-Za-z0-9._@:/+\-]*)+", re.IGNORECASE
)
UPPER_TYPED_RE = re.compile(r"\b[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+){1,}\b")
VERSION_RE = re.compile(
    r"(?<![A-Za-z0-9])v?\d+\.\d+(?:\.\d+)?(?:\.\d+)?"
    r"(?:[-+][0-9A-Za-z][0-9A-Za-z.\-]*)?(?![A-Za-z0-9])"
)
CANONICAL_STAGE_RE = re.compile(
    r"\b(?:IF-MVP0-[A-Z0-9]+|MODEL-PROGRAM-M\d+|PHASE2-CORE-SLICE-[A-Z0-9]+)\b"
)
BARE_M_STAGE_RE = re.compile(
    r"(?<![A-Za-z0-9_-])M\d+(?:-[A-Z0-9]+)?(?![A-Za-z0-9_-])"
)
BARE_SLICE_RE = re.compile(
    r"(?<![A-Za-z0-9_-])(?:Slice|SLICE)[ _-]?[A-Z](?![A-Za-z0-9_-])"
)
COPY_SUFFIX_RE = re.compile(r"\(\d+\)(?=(?:\.[^./]+)?$)")
VAGUE_NAME_RE = re.compile(
    r"(^|[-_. ])(?:copy|copied|final|final2|new|newer|latest|old|backup|bak|temp|tmp)"
    r"(?=$|[-_. ])", re.IGNORECASE
)
DATE_TOKEN_RE = re.compile(r"(?<!\d)(?:20\d{6}|20\d{2}-\d{2}-\d{2})(?!\d)")
ID_FIELD_RE = re.compile(
    r"(?:^|_)(?:id|ref|version|revision|schema|namespace|program|stage|domain|"
    r"artifact|candidate|receipt|decision|authority|subject|source|digest|sha256)$",
    re.IGNORECASE,
)
EXPLICIT_ID_KEYS = {
    "$id", "id", "artifact_id", "record_id", "candidate_id", "decision_id",
    "receipt_id", "schema", "schema_id", "schema_version", "contract",
    "contract_id", "contract_version", "namespace", "domain_id", "program_id",
    "stage_id", "subject_ref", "source_ref", "version", "version_axis",
    "package_revision", "artifact_revision", "revision_kind", "sha256",
}

MAX_TEXT_BYTES_DEFAULT = 8 * 1024 * 1024
MAX_GITHUB_PAGES = 100


class InventoryError(RuntimeError):
    """Raised when inventory generation cannot prove a required read."""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def run_git(repo: Path, *args: str, text: bool = True) -> str | bytes:
    proc = subprocess.run(
        ["git", "-C", str(repo), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=text,
        check=False,
    )
    if proc.returncode != 0:
        stderr = proc.stderr if text else proc.stderr.decode("utf-8", "replace")
        raise InventoryError(f"git {' '.join(args)} failed: {stderr.strip()}")
    return proc.stdout


def normalize_posix(path: str) -> str:
    return unicodedata.normalize("NFC", path.replace("\\", "/"))


def is_machine_surface(path: str, suffix: str) -> bool:
    return suffix in MACHINE_EXTENSIONS or path.startswith(MACHINE_PATH_PREFIXES)


def add_index(
    index: dict[str, dict[str, Any]],
    token: str,
    token_type: str,
    path: str,
    line: int,
    *,
    pointer: str | None = None,
    machine_surface: bool | None = None,
) -> None:
    entry = index.setdefault(
        token,
        {
            "token": token,
            "types": set(),
            "occurrence_count": 0,
            "locations": [],
            "locations_truncated": False,
        },
    )
    entry["types"].add(token_type)
    entry["occurrence_count"] += 1
    location: dict[str, Any] = {"path": path, "line": line}
    if pointer is not None:
        location["pointer"] = pointer
    if machine_surface is not None:
        location["machine_surface"] = machine_surface
    entry["locations"].append(location)


def json_pointer(parts: list[str]) -> str:
    if not parts:
        return ""
    escaped = [part.replace("~", "~0").replace("/", "~1") for part in parts]
    return "/" + "/".join(escaped)


def walk_json_fields(
    value: Any,
    path: str,
    out: list[dict[str, Any]],
    parts: list[str] | None = None,
) -> None:
    parts = [] if parts is None else parts
    if isinstance(value, dict):
        for key, child in value.items():
            child_parts = [*parts, str(key)]
            if isinstance(child, (str, int, float, bool)) or child is None:
                key_text = str(key)
                if key_text in EXPLICIT_ID_KEYS or ID_FIELD_RE.search(key_text):
                    rendered = child
                    truncated = isinstance(rendered, str) and len(rendered) > 1000
                    if truncated:
                        rendered = rendered[:1000] + "…"
                    out.append(
                        {
                            "path": path,
                            "pointer": json_pointer(child_parts),
                            "field": key_text,
                            "value": rendered,
                            "value_truncated": truncated,
                            **({"original_value_sha256": sha256_bytes(child.encode("utf-8")),
                                "original_value_length": len(child)} if truncated else {}),
                        }
                    )
            walk_json_fields(child, path, out, child_parts)
    elif isinstance(value, list):
        for idx, child in enumerate(value):
            walk_json_fields(child, path, out, [*parts, str(idx)])


def decode_text(data: bytes) -> tuple[str | None, str | None]:
    if b"\x00" in data[:8192]:
        return None, "binary_nul"
    try:
        return data.decode("utf-8"), None
    except UnicodeDecodeError as exc:
        return None, f"invalid_utf8:{exc.start}"


def tracked_files(repo: Path) -> list[dict[str, str]]:
    raw = run_git(repo, "ls-files", "--stage", "-z", text=False)
    assert isinstance(raw, bytes)
    entries: list[dict[str, str]] = []
    for record in raw.split(b"\x00"):
        if not record:
            continue
        try:
            meta, raw_path = record.split(b"\t", 1)
            mode, blob_sha, stage = meta.decode("ascii").split()
            path = raw_path.decode("utf-8", "surrogateescape")
        except Exception as exc:
            raise InventoryError(f"cannot parse git ls-files entry: {record!r}: {exc}")
        entries.append({"mode": mode, "blob_sha": blob_sha, "stage": stage, "path": path})
    return entries


def scan_repository(repo: Path, max_text_bytes: int) -> dict[str, Any]:
    entries = tracked_files(repo)
    file_records: list[dict[str, Any]] = []
    skipped_text: list[dict[str, Any]] = []
    identifier_index: dict[str, dict[str, Any]] = {}
    structured_fields: list[dict[str, Any]] = []
    bare_stage_refs: list[dict[str, Any]] = []
    canonical_stage_refs: list[dict[str, Any]] = []
    path_flags: list[dict[str, Any]] = []

    casefold_map: dict[str, list[str]] = defaultdict(list)
    nfc_map: dict[str, list[str]] = defaultdict(list)
    blob_map: dict[str, list[str]] = defaultdict(list)
    content_map: dict[str, list[str]] = defaultdict(list)

    for entry in entries:
        raw_path = entry["path"]
        path = normalize_posix(raw_path)
        casefold_map[path.casefold()].append(path)
        nfc_map[unicodedata.normalize("NFC", path)].append(path)
        blob_map[entry["blob_sha"]].append(path)

        full_path = repo / Path(PurePosixPath(path))
        suffix = full_path.suffix.lower()
        record: dict[str, Any] = {
            "path": path,
            "mode": entry["mode"],
            "stage": entry["stage"],
            "git_blob_sha1": entry["blob_sha"],
            "suffix": suffix,
            "basename": PurePosixPath(path).name,
            "unicode_nfc": unicodedata.normalize("NFC", path) == path,
            "ascii_only": path.isascii(),
        }

        flags: list[str] = []
        basename = record["basename"]
        if COPY_SUFFIX_RE.search(basename):
            flags.append("copy_suffix")
        if VAGUE_NAME_RE.search(basename):
            flags.append("vague_lifecycle_token")
        if DATE_TOKEN_RE.search(basename):
            flags.append("date_token")
        if not record["ascii_only"]:
            flags.append("non_ascii_path")
        if " " in path:
            flags.append("space_in_path")
        if "\\" in raw_path:
            flags.append("backslash_in_path")
        versions = sorted(set(VERSION_RE.findall(basename)))
        if versions:
            record["version_tokens"] = versions
        stages = sorted(
            set(CANONICAL_STAGE_RE.findall(basename))
            | set(BARE_M_STAGE_RE.findall(basename))
            | set(BARE_SLICE_RE.findall(basename))
        )
        if stages:
            record["stage_tokens"] = stages
        if flags:
            record["flags"] = flags
            path_flags.append({"path": path, "flags": flags})

        if entry["mode"] == "160000":
            record["kind"] = "gitlink"
            file_records.append(record)
            continue
        if not full_path.is_file() and not full_path.is_symlink():
            record["read_status"] = "missing_from_checkout"
            file_records.append(record)
            continue

        data = full_path.read_bytes()
        record["size_bytes"] = len(data)
        record["content_sha256"] = sha256_bytes(data)
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            record["binary_signature"] = "PNG"
        content_map[record["content_sha256"]].append(path)

        should_scan = (suffix in TEXT_EXTENSIONS or path.startswith(MACHINE_PATH_PREFIXES)) and not record.get("binary_signature")
        if should_scan:
            if len(data) > max_text_bytes:
                record["text_scan_status"] = "skipped_size_limit"
                skipped_text.append(
                    {"path": path, "size_bytes": len(data), "limit_bytes": max_text_bytes, "reason": "size_limit"}
                )
            else:
                text, decode_error = decode_text(data)
                if text is None:
                    record["text_scan_status"] = "skipped_non_utf8"
                    skipped_text.append({"path": path, "size_bytes": len(data), "reason": decode_error})
                else:
                    record["text_scan_status"] = "scanned"
                    machine_surface = is_machine_surface(path, suffix)
                    for line_no, line in enumerate(text.splitlines(), 1):
                        for token in URN_RE.findall(line):
                            add_index(identifier_index, token, "urn_clued", path, line_no, machine_surface=machine_surface)
                        for token in CLUED_TOKEN_RE.findall(line):
                            add_index(identifier_index, token, "clued_token", path, line_no, machine_surface=machine_surface)
                        for token in UPPER_TYPED_RE.findall(line):
                            add_index(identifier_index, token, "upper_typed_token", path, line_no, machine_surface=machine_surface)
                        for token in VERSION_RE.findall(line):
                            add_index(identifier_index, token, "version_token", path, line_no, machine_surface=machine_surface)
                        for match in CANONICAL_STAGE_RE.finditer(line):
                            canonical_stage_refs.append(
                                {"token": match.group(0), "path": path, "line": line_no, "machine_surface": machine_surface}
                            )
                        for regex, kind in ((BARE_M_STAGE_RE, "bare_m_stage"), (BARE_SLICE_RE, "bare_slice_stage")):
                            for match in regex.finditer(line):
                                bare_stage_refs.append(
                                    {
                                        "token": match.group(0),
                                        "kind": kind,
                                        "path": path,
                                        "line": line_no,
                                        "machine_surface": machine_surface,
                                    }
                                )

                    if suffix == ".json":
                        try:
                            parsed = json.loads(text)
                        except json.JSONDecodeError as exc:
                            record["json_parse_status"] = "invalid"
                            record["json_parse_error"] = {"line": exc.lineno, "column": exc.colno, "message": exc.msg}
                        else:
                            record["json_parse_status"] = "valid"
                            walk_json_fields(parsed, path, structured_fields)
        else:
            record["text_scan_status"] = "not_selected_binary_or_unknown"

        file_records.append(record)

    def collision_sets(mapping: dict[str, list[str]], kind: str) -> list[dict[str, Any]]:
        return [
            {"kind": kind, "key": key, "paths": sorted(paths)}
            for key, paths in sorted(mapping.items())
            if len(set(paths)) > 1
        ]

    duplicate_blobs = [
        {"git_blob_sha1": sha, "paths": sorted(paths)}
        for sha, paths in sorted(blob_map.items())
        if len(set(paths)) > 1
    ]
    duplicate_content = [
        {"content_sha256": sha, "paths": sorted(paths)}
        for sha, paths in sorted(content_map.items())
        if len(set(paths)) > 1
    ]

    for item in identifier_index.values():
        item["types"] = sorted(item["types"])
        item["locations"] = sorted(
            item["locations"], key=lambda loc: (loc["path"], loc["line"], loc.get("pointer", ""))
        )

    machine_bare = [item for item in bare_stage_refs if item["machine_surface"]]
    document_bare = [item for item in bare_stage_refs if not item["machine_surface"]]

    return {
        "tracked_entry_count": len(entries),
        "file_count": sum(1 for entry in entries if entry["mode"] != "160000"),
        "gitlink_count": sum(1 for entry in entries if entry["mode"] == "160000"),
        "files": sorted(file_records, key=lambda item: item["path"]),
        "path_flags": sorted(path_flags, key=lambda item: item["path"]),
        "skipped_text_files": sorted(skipped_text, key=lambda item: item["path"]),
        "identifier_index": sorted(identifier_index.values(), key=lambda item: item["token"]),
        "structured_identity_fields": sorted(
            structured_fields, key=lambda item: (item["path"], item["pointer"], item["field"])
        ),
        "stage_references": {
            "canonical": sorted(canonical_stage_refs, key=lambda item: (item["path"], item["line"], item["token"])),
            "bare_machine_surface": sorted(machine_bare, key=lambda item: (item["path"], item["line"], item["token"])),
            "bare_document_surface": sorted(document_bare, key=lambda item: (item["path"], item["line"], item["token"])),
        },
        "collisions": {
            "casefold": collision_sets(casefold_map, "casefold"),
            "unicode_nfc": collision_sets(nfc_map, "unicode_nfc"),
        },
        "duplicate_representations": {
            "same_git_blob_multiple_paths": duplicate_blobs,
            "same_sha256_multiple_paths": duplicate_content,
        },
    }


class GitHubClient:
    def __init__(self, token: str, repository: str):
        self.token = token
        self.repository = repository
        self.base = "https://api.github.com"

    def _request(self, url: str) -> tuple[Any, dict[str, str]]:
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self.token}",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "clued-naming-surface-inventory/1",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                raw = response.read()
                return json.loads(raw.decode("utf-8")), dict(response.headers.items())
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")
            raise InventoryError(f"GitHub API {exc.code} for {url}: {body[:1000]}") from exc
        except urllib.error.URLError as exc:
            raise InventoryError(f"GitHub API request failed for {url}: {exc}") from exc

    def get(self, endpoint: str) -> Any:
        url = endpoint if endpoint.startswith("https://") else self.base + endpoint
        value, _ = self._request(url)
        return value

    def paginate(self, endpoint: str, *, item_key: str | None = None) -> list[Any]:
        separator = "&" if "?" in endpoint else "?"
        url = self.base + endpoint + f"{separator}per_page=100"
        out: list[Any] = []
        pages = 0
        while url:
            pages += 1
            if pages > MAX_GITHUB_PAGES:
                raise InventoryError(f"GitHub pagination exceeded {MAX_GITHUB_PAGES} pages: {endpoint}")
            value, headers = self._request(url)
            if item_key is not None:
                items = value.get(item_key)
                if not isinstance(items, list):
                    raise InventoryError(f"GitHub response for {endpoint} lacks list key {item_key}")
            else:
                items = value
                if not isinstance(items, list):
                    raise InventoryError(f"GitHub response for {endpoint} is not a list")
            out.extend(items)
            url = parse_next_link(headers.get("Link") or headers.get("link"))
        return out


def parse_next_link(header: str | None) -> str | None:
    if not header:
        return None
    for part in header.split(","):
        section = part.strip()
        if 'rel="next"' not in section:
            continue
        match = re.match(r"<([^>]+)>", section)
        if match:
            return match.group(1)
    return None


def compact_repository(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": value.get("id"),
        "full_name": value.get("full_name"),
        "private": value.get("private"),
        "default_branch": value.get("default_branch"),
        "archived": value.get("archived"),
        "disabled": value.get("disabled"),
        "visibility": value.get("visibility"),
    }


def scan_github(repository: str, token: str) -> dict[str, Any]:
    client = GitHubClient(token, repository)
    quoted_repo = "/".join(urllib.parse.quote(part, safe="") for part in repository.split("/"))
    repo = client.get(f"/repos/{quoted_repo}")
    branches = client.paginate(f"/repos/{quoted_repo}/branches?")
    tags = client.paginate(f"/repos/{quoted_repo}/tags?")
    releases = client.paginate(f"/repos/{quoted_repo}/releases?")
    workflows = client.paginate(f"/repos/{quoted_repo}/actions/workflows?", item_key="workflows")
    artifacts = client.paginate(f"/repos/{quoted_repo}/actions/artifacts?", item_key="artifacts")

    compact_branches = [
        {"name": item.get("name"), "protected": item.get("protected"), "commit_sha": (item.get("commit") or {}).get("sha")}
        for item in branches
    ]
    compact_tags = [
        {
            "name": item.get("name"),
            "commit_sha": (item.get("commit") or {}).get("sha"),
            "tarball_url": item.get("tarball_url"),
            "zipball_url": item.get("zipball_url"),
        }
        for item in tags
    ]
    compact_releases = []
    for release in releases:
        compact_releases.append(
            {
                "id": release.get("id"),
                "tag_name": release.get("tag_name"),
                "name": release.get("name"),
                "target_commitish": release.get("target_commitish"),
                "draft": release.get("draft"),
                "prerelease": release.get("prerelease"),
                "created_at": release.get("created_at"),
                "published_at": release.get("published_at"),
                "assets": [
                    {
                        "id": asset.get("id"),
                        "name": asset.get("name"),
                        "size": asset.get("size"),
                        "digest": asset.get("digest"),
                        "state": asset.get("state"),
                        "created_at": asset.get("created_at"),
                        "updated_at": asset.get("updated_at"),
                    }
                    for asset in release.get("assets") or []
                ],
            }
        )
    compact_workflows = [
        {
            "id": item.get("id"),
            "name": item.get("name"),
            "path": item.get("path"),
            "state": item.get("state"),
            "created_at": item.get("created_at"),
            "updated_at": item.get("updated_at"),
        }
        for item in workflows
    ]
    compact_artifacts = [
        {
            "id": item.get("id"),
            "name": item.get("name"),
            "size_in_bytes": item.get("size_in_bytes"),
            "digest": item.get("digest"),
            "expired": item.get("expired"),
            "created_at": item.get("created_at"),
            "expires_at": item.get("expires_at"),
            "workflow_run": {
                "id": (item.get("workflow_run") or {}).get("id"),
                "head_branch": (item.get("workflow_run") or {}).get("head_branch"),
                "head_sha": (item.get("workflow_run") or {}).get("head_sha"),
            },
        }
        for item in artifacts
    ]

    return {
        "repository": compact_repository(repo),
        "branches": sorted(compact_branches, key=lambda item: item["name"] or ""),
        "tags": sorted(compact_tags, key=lambda item: item["name"] or ""),
        "releases": sorted(compact_releases, key=lambda item: (item.get("published_at") or "", item.get("id") or 0)),
        "workflows": sorted(compact_workflows, key=lambda item: item["path"] or ""),
        "artifacts": sorted(compact_artifacts, key=lambda item: item.get("id") or 0),
        "counts": {
            "branches": len(compact_branches),
            "tags": len(compact_tags),
            "releases": len(compact_releases),
            "release_assets": sum(len(item["assets"]) for item in compact_releases),
            "workflows": len(compact_workflows),
            "artifacts": len(compact_artifacts),
        },
        "pagination_complete": True,
    }


def classify_findings(repository_inventory: dict[str, Any], github_inventory: dict[str, Any] | None) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []

    def add(finding_id: str, category: str, title: str, evidence: Any, *, disposition_stage: str, impact: str) -> None:
        findings.append(
            {
                "finding_id": finding_id,
                "classification": "INVENTORY_OBSERVATION_UNDISPOSITIONED",
                "category": category,
                "title": title,
                "impact": impact,
                "disposition_stage": disposition_stage,
                "evidence": evidence,
                "authority_effect": "NONE",
                "engineering_closure": False,
            }
        )

    collisions = repository_inventory["collisions"]
    if collisions["casefold"]:
        add("NSI-OBS-001", "path_collision", "Tracked paths collide under case-folding", collisions["casefold"], disposition_stage="STRUCTURE_FREEZE_PREPARATION", impact="CROSS_PLATFORM_PATH_AMBIGUITY")
    if collisions["unicode_nfc"]:
        add("NSI-OBS-002", "path_collision", "Tracked paths collide after Unicode NFC normalization", collisions["unicode_nfc"], disposition_stage="STRUCTURE_FREEZE_PREPARATION", impact="UNICODE_NORMALIZATION_AMBIGUITY")

    machine_bare = repository_inventory["stage_references"]["bare_machine_surface"]
    if machine_bare:
        add("NSI-OBS-003", "stage_namespace", "Bare M*/Slice stage references exist on machine surfaces", machine_bare, disposition_stage="PRE_ARCHITECTURE_ACCEPTANCE_NAMING_CLOSURE", impact="CROSS_DOMAIN_STAGE_BINDING_RISK")

    flagged = repository_inventory["path_flags"]
    copy_paths = [item for item in flagged if "copy_suffix" in item["flags"]]
    if copy_paths:
        add("NSI-OBS-004", "copy_identity", "Tracked path names contain copy-number suffixes", copy_paths, disposition_stage="STRUCTURE_FREEZE_PREPARATION", impact="PHYSICAL_COPY_MAY_BE_MISREAD_AS_REVISION")

    vague_paths = [item for item in flagged if "vague_lifecycle_token" in item["flags"]]
    if vague_paths:
        add("NSI-OBS-005", "lifecycle_token", "Tracked paths contain vague lifecycle tokens", vague_paths, disposition_stage="STRUCTURE_FREEZE_PREPARATION", impact="FILENAME_MAY_BE_MISREAD_AS_CURRENT_OR_FINAL_AUTHORITY")

    skipped = repository_inventory["skipped_text_files"]
    if skipped:
        add("NSI-OBS-006", "coverage", "Selected text surfaces were not content-scanned", skipped, disposition_stage="INVENTORY_COMPLETION", impact="INCOMPLETE_IDENTIFIER_OCCURRENCE_COVERAGE")

    if github_inventory is not None:
        transformed_assets: list[dict[str, Any]] = []
        for release in github_inventory["releases"]:
            for asset in release["assets"]:
                name = asset.get("name") or ""
                if "._." in name or COPY_SUFFIX_RE.search(name) or VAGUE_NAME_RE.search(name):
                    transformed_assets.append(
                        {
                            "release_id": release.get("id"),
                            "tag_name": release.get("tag_name"),
                            "asset_id": asset.get("id"),
                            "asset_name": name,
                            "digest": asset.get("digest"),
                        }
                    )
        if transformed_assets:
            add("NSI-OBS-007", "transport_name", "Release assets contain transformed or ambiguous transport names", transformed_assets, disposition_stage="STRUCTURE_FREEZE_PREPARATION", impact="TRANSPORT_NAME_DRIFT_REQUIRES_EXACT_BINDING")

        unprotected = [branch for branch in github_inventory["branches"] if not branch.get("protected")]
        if unprotected:
            add("NSI-OBS-008", "enforcement", "GitHub branches are not marked protected", unprotected, disposition_stage="POST_MIGRATION_ENFORCEMENT", impact="NAMING_CHECK_NOT_YET_UNBYPASSABLE")

    duplicate_sha = repository_inventory["duplicate_representations"]["same_sha256_multiple_paths"]
    if duplicate_sha:
        add("NSI-OBS-009", "representation_copy", "Identical bytes exist at multiple tracked paths", duplicate_sha, disposition_stage="STRUCTURE_FREEZE_PREPARATION", impact="LOGICAL_OBJECT_REPRESENTATION_COPY_CLASSIFICATION_REQUIRED")

    return findings


def load_scope(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise InventoryError(f"cannot read scope contract {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise InventoryError("scope contract must be a JSON object")
    return value


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temp, path)


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(text, encoding="utf-8")
    os.replace(temp, path)


def render_summary(manifest: dict[str, Any], findings: list[dict[str, Any]]) -> str:
    repo = manifest["repository_inventory"]
    github = manifest.get("github_inventory")
    coverage = manifest["coverage"]
    lines = [
        "# Clued Naming Surface Inventory — Structure Freeze Preparation",
        "",
        f"- Schema: `{SUMMARY_SCHEMA}`",
        f"- Generated: `{manifest['generated_at_utc']}`",
        f"- Repository: `{manifest['source_lock']['repository']}`",
        f"- Branch: `{manifest['source_lock']['branch']}`",
        f"- Commit: `{manifest['source_lock']['commit_sha']}`",
        f"- Tree: `{manifest['source_lock']['tree_sha']}`",
        f"- Status: `{manifest['status']}`",
        f"- Authority effect: `{manifest['authority_effect']}`",
        "",
        "## Coverage",
        "",
        "| Surface | Status | Notes |",
        "|---|---|---|",
    ]
    for item in coverage:
        lines.append(f"| `{item['surface']}` | `{item['status']}` | {item.get('notes', '')} |")
    lines.extend(
        [
            "",
            "## Repository inventory",
            "",
            f"- Tracked entries: **{repo['tracked_entry_count']}**",
            f"- Files: **{repo['file_count']}**",
            f"- Gitlinks: **{repo['gitlink_count']}**",
            f"- Structured identity fields: **{len(repo['structured_identity_fields'])}**",
            f"- Indexed identifier tokens: **{len(repo['identifier_index'])}**",
            f"- Bare stage references on machine surfaces: **{len(repo['stage_references']['bare_machine_surface'])}**",
            f"- Case-fold collision sets: **{len(repo['collisions']['casefold'])}**",
            f"- Unicode NFC collision sets: **{len(repo['collisions']['unicode_nfc'])}**",
            f"- Identical-byte multi-path sets: **{len(repo['duplicate_representations']['same_sha256_multiple_paths'])}**",
        ]
    )
    if github is not None:
        counts = github["counts"]
        lines.extend(
            [
                "",
                "## GitHub inventory",
                "",
                f"- Branches: **{counts['branches']}**",
                f"- Tags: **{counts['tags']}**",
                f"- Releases: **{counts['releases']}**",
                f"- Release assets: **{counts['release_assets']}**",
                f"- Workflows: **{counts['workflows']}**",
                f"- Actions artifacts: **{counts['artifacts']}**",
            ]
        )
    lines.extend(
        [
            "",
            "## Inventory observations",
            "",
            "These are undispositioned inventory observations. They are not automatic architecture findings, acceptance decisions, or migration authorizations.",
            "",
            "| ID | Category | Impact | Title |",
            "|---|---|---|---|",
        ]
    )
    for finding in findings:
        lines.append(f"| `{finding['finding_id']}` | `{finding['category']}` | `{finding['impact']}` | {finding['title']} |")
    if not findings:
        lines.append("| — | — | — | No inventory observations emitted |")
    lines.extend(
        [
            "",
            "## Boundaries",
            "",
            "- This output does not rename or migrate any file.",
            "- It does not create a Registry Root Catalog.",
            "- It does not issue Architecture Acceptance or Structure Freeze.",
            "- It does not enable a required check on `main`.",
            "- External surfaces marked pending remain open within this inventory work item.",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", type=Path, default=Path("."))
    parser.add_argument("--scope", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--repository", default=os.getenv("GITHUB_REPOSITORY"))
    parser.add_argument("--github-token", default=os.getenv("GITHUB_TOKEN"))
    parser.add_argument("--require-github", action="store_true")
    parser.add_argument("--max-text-bytes", type=int, default=MAX_TEXT_BYTES_DEFAULT)
    args = parser.parse_args()

    repo = args.repo_root.resolve()
    if not (repo / ".git").exists():
        raise InventoryError(f"not a Git worktree: {repo}")

    scope = load_scope(args.scope)
    commit_sha = str(run_git(repo, "rev-parse", "HEAD")).strip()
    tree_sha = str(run_git(repo, "rev-parse", "HEAD^{tree}")).strip()
    branch = str(run_git(repo, "rev-parse", "--abbrev-ref", "HEAD")).strip()
    status_porcelain = str(run_git(repo, "status", "--porcelain=v1"))
    if status_porcelain:
        raise InventoryError("inventory requires a clean worktree")

    repository_inventory = scan_repository(repo, args.max_text_bytes)

    github_inventory: dict[str, Any] | None = None
    github_error: str | None = None
    if args.repository and args.github_token:
        try:
            github_inventory = scan_github(args.repository, args.github_token)
        except Exception as exc:
            github_error = f"{type(exc).__name__}: {exc}"
            if args.require_github:
                raise
    elif args.require_github:
        raise InventoryError("--require-github requires repository and token")

    findings = classify_findings(repository_inventory, github_inventory)
    coverage = [
        {"surface": "repository_tracked_paths", "status": "SCANNED", "notes": "All git-index entries at the exact source commit."},
        {
            "surface": "repository_selected_text_content",
            "status": "SCANNED" if not repository_inventory["skipped_text_files"] else "PARTIAL",
            "notes": "UTF-8 content scan of selected text/machine surfaces; skipped entries are enumerated.",
        },
        {
            "surface": "github_branches_tags_releases_workflows_artifacts",
            "status": "SCANNED" if github_inventory is not None else "PENDING",
            "notes": github_error or "GitHub REST pagination completed.",
        },
        {
            "surface": "chatgpt_library_metadata",
            "status": "PENDING_EXTERNAL_SNAPSHOT",
            "notes": "Must be supplied as a detached metadata-only inventory; no private payload read is implied.",
        },
        {
            "surface": "supabase_identifiers",
            "status": "PENDING_EXTERNAL_SNAPSHOT",
            "notes": "Project/schema/table/function/storage/edge-function/auth surface inventory remains separate.",
        },
        {
            "surface": "cloudflare_and_other_deployment_identifiers",
            "status": "PENDING_EXTERNAL_SNAPSHOT",
            "notes": "Worker/domain/route/deployment/binding identifiers require connector-backed snapshot or formal N/A/retirement proof.",
        },
    ]

    manifest = {
        "schema": SCHEMA,
        "record_id": f"CLUED_NAMING_SURFACE_INVENTORY_{commit_sha[:12].upper()}",
        "generated_at_utc": utc_now(),
        "status": "INVENTORY_CANDIDATE_NOT_CLOSEOUT",
        "authority_effect": "NONE",
        "purpose": "STRUCTURE_FREEZE_PREPARATION_NAMING_SURFACE_INVENTORY",
        "source_lock": {
            "repository": args.repository or scope.get("repository"),
            "branch": branch,
            "commit_sha": commit_sha,
            "tree_sha": tree_sha,
            "scope_path": args.scope.as_posix(),
            "scope_sha256": sha256_file(args.scope),
            "scanner_path": Path(__file__).resolve().relative_to(repo).as_posix(),
            "scanner_sha256": sha256_file(Path(__file__).resolve()),
        },
        "scope_contract": scope,
        "coverage": coverage,
        "repository_inventory": repository_inventory,
        "github_inventory": github_inventory,
        "github_inventory_error": github_error,
        "inventory_observation_ids": [item["finding_id"] for item in findings],
        "aggregate": {
            "tracked_entries": repository_inventory["tracked_entry_count"],
            "repository_files": repository_inventory["file_count"],
            "identifier_tokens": len(repository_inventory["identifier_index"]),
            "structured_identity_fields": len(repository_inventory["structured_identity_fields"]),
            "bare_machine_stage_references": len(repository_inventory["stage_references"]["bare_machine_surface"]),
            "casefold_collision_sets": len(repository_inventory["collisions"]["casefold"]),
            "unicode_nfc_collision_sets": len(repository_inventory["collisions"]["unicode_nfc"]),
            "inventory_observations": len(findings),
            "unresolved_external_surface_count": sum(1 for item in coverage if item["status"].startswith("PENDING")),
        },
        "boundaries": {
            "repository_mutation_by_scanner": False,
            "renaming_or_migration_performed": False,
            "registry_root_catalog_created": False,
            "architecture_acceptance": "NOT_ISSUED",
            "structure_freeze": "NOT_ISSUED",
            "naming_integrity_closeout": "NOT_ISSUED",
            "main_required_check": "NOT_ENABLED_BY_THIS_INVENTORY",
            "private_user_payload_access": "NONE",
        },
        "next_work_within_item": [
            "ATTACH_CHATGPT_LIBRARY_METADATA_SNAPSHOT",
            "ATTACH_SUPABASE_IDENTIFIER_SNAPSHOT_OR_FORMAL_SCOPE_EXCLUSION",
            "ATTACH_CLOUDFLARE_AND_DEPLOYMENT_IDENTIFIER_SNAPSHOT_OR_RETIREMENT_PROOF",
            "DISPOSITION_EACH_INVENTORY_OBSERVATION",
            "REPEAT_SCAN_UNTIL_ALL_IN_SCOPE_SURFACES_ARE_ACCOUNTED_FOR",
        ],
    }

    findings_doc = {
        "schema": FINDINGS_SCHEMA,
        "record_id": f"CLUED_NAMING_SURFACE_INVENTORY_FINDINGS_{commit_sha[:12].upper()}",
        "generated_at_utc": manifest["generated_at_utc"],
        "source_manifest_record_id": manifest["record_id"],
        "source_lock": manifest["source_lock"],
        "status": "UNDISPOSITIONED_INVENTORY_OBSERVATIONS",
        "authority_effect": "NONE",
        "findings": findings,
        "count": len(findings),
        "boundary": "An inventory observation is not automatically a BLOCKER/MAJOR/MINOR. Severity and target disposition require evidence and the applicable governance decision.",
    }

    output = args.output_dir.resolve()
    manifest_path = output / "NamingSurfaceInventoryManifest.json"
    findings_path = output / "NamingSurfaceInventoryFindings.json"
    summary_path = output / "NamingSurfaceInventorySummary.md"
    write_json(manifest_path, manifest)
    write_json(findings_path, findings_doc)
    write_text(summary_path, render_summary(manifest, findings))

    result = {
        "manifest": str(manifest_path),
        "manifest_sha256": sha256_file(manifest_path),
        "findings": str(findings_path),
        "findings_sha256": sha256_file(findings_path),
        "summary": str(summary_path),
        "summary_sha256": sha256_file(summary_path),
        "source_commit": commit_sha,
        "source_tree": tree_sha,
        "status": manifest["status"],
        "inventory_observation_count": len(findings),
        "unresolved_external_surface_count": manifest["aggregate"]["unresolved_external_surface_count"],
    }
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except InventoryError as exc:
        print(f"inventory error: {exc}", file=sys.stderr)
        raise SystemExit(1)
