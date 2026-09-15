#!/usr/bin/env python3
"""Fail-closed validator for the Clued multi-track repository projection.

Validates Repository projection integrity only. Never writes Canonical state.
"""
from __future__ import annotations
import hashlib, json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROJECTION_PATH = ROOT / "development/projections/multitrack/CurrentGovernanceInventory.projection.json"
HUMAN_PATH = ROOT / "development/projections/multitrack/CurrentGovernanceInventory.projection.md"
CONTRACT_PATH = ROOT / "development/contracts/multitrack/RepositoryProjection.contract.json"
ITEM_RE = re.compile(r"^[EPRB]-[0-9]{3}$")

def fail(msg):
    print(f"FAIL: {msg}", file=sys.stderr)
    raise SystemExit(1)

def walk_keys(v):
    if isinstance(v, dict):
        for k, child in v.items():
            yield k
            yield from walk_keys(child)
    elif isinstance(v, list):
        for child in v:
            yield from walk_keys(child)

def canonical_sha(obj):
    raw = json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()

def load(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        fail(f"cannot load {path.relative_to(ROOT)}: {exc}")

def main():
    for path in (PROJECTION_PATH, HUMAN_PATH, CONTRACT_PATH):
        if not path.is_file():
            fail(f"missing required file: {path.relative_to(ROOT)}")

    projection = json.loads(PROJECTION_PATH.read_text(encoding="utf-8"))
    contract = load(CONTRACT_PATH)
    human = HUMAN_PATH.read_text(encoding="utf-8")
    required = contract["required_projection"]
    source_contract = contract["source_binding"]

    if projection.get("schema_version") != required["schema_version"]:
        fail("projection schema_version mismatch")
    if projection.get("authority_effect") != "NONE":
        fail("authority_effect must remain NONE")
    if projection.get("writeback") != "FORBIDDEN":
        fail("writeback must remain FORBIDDEN")
    for token in required["projection_status_must_include"]:
        if token not in projection.get("projection_status", ""):
            fail(f"projection_status must include {token}")

    semantics = projection.get("repository_semantics", {})
    if semantics.get("projection_is_canonical") is not False:
        fail("repository projection must never be canonical")
    if semantics.get("reverse_write_to_canonical") is not False:
        fail("reverse write must remain disabled")

    source = projection.get("source", {})
    expected = {
        "snapshot_id": source_contract["expected_snapshot_id"],
        "inventory_id": source_contract["expected_inventory_id"],
        "source_file_sha256": source_contract["expected_source_file_sha256"],
        "source_generated_at_date": source_contract["expected_source_generated_at_date"],
    }
    for key, value in expected.items():
        if source.get(key) != value:
            fail(f"source binding mismatch for {key}")

    forbidden = {"file_id", "manifest_file_id"}
    if forbidden.intersection(set(walk_keys(projection))):
        fail("connector-local identifiers leaked into manifest")

    tracks = projection.get("tracks", [])
    track_ids = [t.get("track_id") for t in tracks]
    if track_ids != required["track_ids"]:
        fail(f"track ids/order mismatch: {track_ids}")
    track_map = {t["track_id"]: t for t in tracks}
    file_meta = projection.get("track_files", {})
    if set(file_meta) != set(track_ids):
        fail("track_files keys must exactly match track ids")

    allowed_marks = required["allowed_status_marks"]
    allowed_grades = set(required["allowed_evidence_grades"])
    item_map = {}
    counts = {}

    for tid in track_ids:
        meta = file_meta[tid]
        path = ROOT / meta["path"]
        if not path.is_file():
            fail(f"{tid}: missing track file {meta['path']}")
        shard = load(path)
        if canonical_sha(shard) != meta["canonical_sha256"]:
            fail(f"{tid}: canonical SHA mismatch")
        if shard.get("schema_version") != "clued.multitrack-repository-track/1":
            fail(f"{tid}: track schema mismatch")
        if shard.get("authority_effect") != "NONE":
            fail(f"{tid}: authority_effect must remain NONE")
        if shard.get("track_id") != tid:
            fail(f"{tid}: shard track_id mismatch")
        if shard.get("source_snapshot_id") != source["snapshot_id"] or shard.get("source_inventory_id") != source["inventory_id"]:
            fail(f"{tid}: source binding mismatch")
        if forbidden.intersection(set(walk_keys(shard))):
            fail(f"{tid}: connector-local identifier leaked")
        if shard.get("frontier") != track_map[tid].get("frontier"):
            fail(f"{tid}: frontier mismatch between manifest and shard")
        items = shard.get("items", [])
        if len(items) != meta["items"]:
            fail(f"{tid}: item count mismatch")
        counts[tid] = len(items)
        for item in items:
            iid = item.get("id")
            if not isinstance(iid, str) or not ITEM_RE.fullmatch(iid):
                fail(f"{tid}: invalid Priority Item ID {iid}")
            if iid in item_map:
                fail(f"duplicate Priority Item ID {iid}")
            if item.get("track") != tid or iid[0] != tid:
                fail(f"{iid}: track prefix mismatch")
            status = item.get("status")
            if status not in allowed_marks:
                fail(f"{iid}: unsupported status {status}")
            if item.get("mark") != allowed_marks[status]:
                fail(f"{iid}: mark/status mismatch")
            if item.get("evidence_grade") not in allowed_grades:
                fail(f"{iid}: invalid evidence grade")
            item_map[iid] = item

    for iid, item in item_map.items():
        for field in ("depends_on", "blocked_by", "unlocks"):
            for ref in item.get(field, []):
                if isinstance(ref, str) and ITEM_RE.fullmatch(ref) and ref not in item_map:
                    fail(f"{iid}: unresolved {field} item reference {ref}")

    for tid in track_ids:
        for iid in track_map[tid].get("frontier", []):
            if iid not in item_map or item_map[iid]["track"] != tid:
                fail(f"{tid}: invalid frontier item {iid}")

    summary = projection.get("reconciliation_summary", {})
    if summary.get("total_items") != len(item_map):
        fail("reconciliation total_items mismatch")
    for iid in summary.get("hard_identity_conflicts", []):
        if iid not in item_map or item_map[iid].get("evidence_grade") != "X":
            fail(f"hard conflict {iid} must resolve to an X-grade item")

    manifest_sha = canonical_sha(projection)
    required_human = [
        projection["projection_id"], source["snapshot_id"], source["inventory_id"],
        source["source_file_sha256"], manifest_sha, "NOT Canonical",
        "Authority effect: `NONE`", "Writeback: `FORBIDDEN`",
    ]
    for token in required_human:
        if token not in human:
            fail(f"human projection missing required token: {token}")
    for tid in track_ids:
        meta = file_meta[tid]
        if meta["path"] not in human or meta["canonical_sha256"] not in human:
            fail(f"human projection missing {tid} track binding")
        for iid in track_map[tid].get("frontier", []):
            if f"`{iid}`" not in human:
                fail(f"human projection missing frontier item {iid}")

    print(
        "PASS: multi-track repository projection "
        f"items={len(item_map)} tracks={len(track_ids)} "
        f"manifest_canonical_sha256={manifest_sha} source_sha256={source['source_file_sha256']} "
        f"track_counts={counts}"
    )
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
