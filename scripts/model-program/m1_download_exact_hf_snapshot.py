#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

MODEL_ID = "Qwen/Qwen3.5-0.8B"
REVISION = "2fc06364715b967f1860aea9cf38778875588b17"
PROFILE_ID = "M1-REF-QWEN35-08B-LLAMACPP-003"
MAX_NETWORK_BYTES = 3221225472
MAX_STORAGE_BYTES = 4294967296
USER_AGENT = "Clued-M1-Reference-Downloader/1.1"

SAFE_EXACT_NAMES = {".gitattributes", "LICENSE", "LICENSE.txt", "NOTICE", "NOTICE.txt"}
SAFE_SUFFIXES = {
    ".json", ".safetensors", ".txt", ".md", ".model", ".tiktoken", ".jinja",
    ".yaml", ".yml"
}
FORBIDDEN_SUFFIXES = {
    ".py", ".pyc", ".pyo", ".so", ".dll", ".dylib", ".exe", ".msi",
    ".bat", ".cmd", ".ps1", ".sh", ".pt", ".pth", ".pkl", ".pickle"
}

def fail(msg: str) -> None:
    print("FAIL: " + msg, file=sys.stderr)
    raise SystemExit(1)

def api_url() -> str:
    model = urllib.parse.quote(MODEL_ID, safe="/")
    return f"https://huggingface.co/api/models/{model}/revision/{REVISION}?blobs=true"

def download_url(rel: str) -> str:
    model = urllib.parse.quote(MODEL_ID, safe="/")
    path = "/".join(urllib.parse.quote(x, safe="") for x in PurePosixPath(rel).parts)
    return f"https://huggingface.co/{model}/resolve/{REVISION}/{path}?download=true"

def fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))

def safe_relpath(rel: str) -> PurePosixPath:
    p = PurePosixPath(rel)
    if not rel or p.is_absolute() or ".." in p.parts or "\\" in rel:
        fail("unsafe repository path: " + rel)
    return p

def allowed_file(rel: str) -> bool:
    p = safe_relpath(rel)
    suffix = p.suffix.lower()
    if suffix in FORBIDDEN_SUFFIXES:
        return False
    return p.name in SAFE_EXACT_NAMES or suffix in SAFE_SUFFIXES

def acquire_one_shot_lock(root: Path) -> Path:
    parent = root.parent
    parent.mkdir(parents=True, exist_ok=True)
    lock = parent / f".{root.name}.{PROFILE_ID}.lock"
    try:
        fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        fail("profile one-shot lock already exists: " + str(lock))
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(json.dumps({
            "profile_id": PROFILE_ID,
            "state": "ATTEMPT_STARTED",
            "started_at_utc": datetime.now(timezone.utc).isoformat(),
            "pid": os.getpid(),
            "output_dir": str(root),
        }, indent=2) + "\n")
    return lock

def stream_download(url: str, target: Path, network_state: dict) -> tuple[str, int]:
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = Path(str(target) + ".partial")
    if partial.exists() or target.exists():
        fail("target or partial already exists: " + str(target))
    h = hashlib.sha256()
    written = 0
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp, partial.open("xb") as out:
            while True:
                chunk = resp.read(8 * 1024 * 1024)
                if not chunk:
                    break
                network_state["bytes"] += len(chunk)
                if network_state["bytes"] > MAX_NETWORK_BYTES:
                    fail("network budget exceeded")
                written += len(chunk)
                if written > MAX_STORAGE_BYTES:
                    fail("single-file storage ceiling exceeded")
                h.update(chunk)
                out.write(chunk)
        os.replace(partial, target)
    except Exception:
        partial.unlink(missing_ok=True)
        raise
    return h.hexdigest(), written

def independent_rehash(root: Path, rows: list[dict]) -> None:
    for row in rows:
        p = root.joinpath(*PurePosixPath(row["path"]).parts)
        if not p.is_file():
            fail("post-download file missing: " + row["path"])
        h = hashlib.sha256()
        size = 0
        with p.open("rb") as f:
            while True:
                chunk = f.read(8 * 1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                h.update(chunk)
        if size != row["bytes"] or h.hexdigest() != row["sha256"]:
            fail("post-download independent rehash mismatch: " + row["path"])

def write_json_atomic(path: Path, value: dict) -> None:
    tmp = Path(str(path) + ".partial")
    if path.exists() or tmp.exists():
        fail("output already exists: " + str(path))
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--output-dir", required=True)
    args = ap.parse_args()
    root = Path(args.output_dir).resolve()

    lock = acquire_one_shot_lock(root)
    if root.exists():
        fail("profile 003 requires a new non-existent output directory")
    root.mkdir(parents=True, exist_ok=False)

    meta = fetch_json(api_url())
    if meta.get("sha") != REVISION:
        fail(f"model revision drift: expected {REVISION} got {meta.get('sha')}")
    if meta.get("gated") not in (False, None, "false"):
        fail("model unexpectedly gated")
    license_id = (meta.get("cardData") or {}).get("license")
    if str(license_id).lower() != "apache-2.0":
        fail("license drift: " + str(license_id))

    siblings = meta.get("siblings") or []
    if not siblings:
        fail("empty model file list")

    selected = []
    estimated = 0
    for row in siblings:
        rel = row.get("rfilename")
        if not isinstance(rel, str):
            fail("missing sibling filename")
        safe_relpath(rel)
        if not allowed_file(rel):
            fail("unsupported or executable artifact present: " + rel)
        size = row.get("size")
        if isinstance(size, int) and size >= 0:
            estimated += size
        selected.append(row)

    if estimated and estimated > MAX_STORAGE_BYTES:
        fail(f"declared snapshot size exceeds storage ceiling: {estimated}")

    manifest_files = []
    network_state = {"bytes": 0}
    total_written = 0

    for row in selected:
        rel = row["rfilename"]
        target = root.joinpath(*PurePosixPath(rel).parts)
        digest, written = stream_download(download_url(rel), target, network_state)
        total_written += written
        if total_written > MAX_STORAGE_BYTES:
            fail("snapshot storage ceiling exceeded")

        expected_lfs = None
        lfs = row.get("lfs")
        if isinstance(lfs, dict):
            expected_lfs = lfs.get("sha256")
            if expected_lfs and digest != expected_lfs:
                fail(f"LFS sha256 mismatch for {rel}")

        manifest_files.append({
            "path": rel,
            "bytes": written,
            "sha256": digest,
            "expected_lfs_sha256": expected_lfs,
            "source_url": download_url(rel)
        })

    independent_rehash(root, manifest_files)

    license_candidates = [root / "LICENSE", root / "LICENSE.txt"]
    license_path = next((p for p in license_candidates if p.is_file()), None)
    readme_path = root / "README.md"
    if license_path is None:
        fail("LICENSE snapshot missing")
    if not readme_path.is_file():
        fail("README model card snapshot missing")

    shutil.copyfile(license_path, root / "LicenseSnapshot.txt")
    shutil.copyfile(readme_path, root / "ModelCardSnapshot.md")

    manifest = {
        "schema_version": "clued.model-m1-download-manifest/2",
        "profile_id": PROFILE_ID,
        "model_id": MODEL_ID,
        "revision": REVISION,
        "api_observed_sha": meta.get("sha"),
        "gated": meta.get("gated"),
        "network_bytes": network_state["bytes"],
        "snapshot_bytes": total_written,
        "max_network_bytes": MAX_NETWORK_BYTES,
        "max_storage_bytes": MAX_STORAGE_BYTES,
        "post_download_independent_rehash": "PASS",
        "files": manifest_files,
        "model_loaded": False,
        "inference_performed": False,
        "evaluation_performed": False,
        "trust_remote_code": False
    }
    write_json_atomic(root / "DownloadManifest.json", manifest)

    sums = {
        "schema_version": "clued.model-m1-snapshot-sha256/2",
        "profile_id": PROFILE_ID,
        "model_id": MODEL_ID,
        "revision": REVISION,
        "files": [{"path": x["path"], "sha256": x["sha256"], "bytes": x["bytes"]} for x in manifest_files]
    }
    write_json_atomic(root / "SHA256SUMS.json", sums)

    bom = {
        "schema_version": "clued.model-m1-reference-bom/2",
        "profile_id": PROFILE_ID,
        "model_id": MODEL_ID,
        "revision": REVISION,
        "license_declared": license_id,
        "pipeline_tag": meta.get("pipeline_tag"),
        "library_name": meta.get("library_name"),
        "file_count": len(manifest_files),
        "snapshot_bytes": total_written,
        "download_source": "huggingface.co exact revision",
        "execution_scope": "M1-03_DOWNLOAD_AND_INTEGRITY_ONLY"
    }
    write_json_atomic(root / "BOM.json", bom)

    lock.write_text(json.dumps({
        "profile_id": PROFILE_ID,
        "state": "COMPLETED",
        "completed_at_utc": datetime.now(timezone.utc).isoformat(),
        "pid": os.getpid(),
        "output_dir": str(root),
        "network_bytes": network_state["bytes"],
        "snapshot_bytes": total_written,
    }, indent=2) + "\n", encoding="utf-8")

    print(json.dumps({
        "result": "PASS",
        "profile_id": PROFILE_ID,
        "model_id": MODEL_ID,
        "revision": REVISION,
        "file_count": len(manifest_files),
        "network_bytes": network_state["bytes"],
        "snapshot_bytes": total_written,
        "output_dir": str(root),
        "post_download_independent_rehash": "PASS"
    }, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
