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
from pathlib import Path, PurePosixPath

MODEL_ID = "Qwen/Qwen3.5-0.8B"
REVISION = "2fc06364715b967f1860aea9cf38778875588b17"
MAX_NETWORK_BYTES = 3221225472
MAX_STORAGE_BYTES = 4294967296
USER_AGENT = "Clued-M1-Reference-Downloader/1.0"

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
    name = p.name
    suffix = p.suffix.lower()
    if suffix in FORBIDDEN_SUFFIXES:
        return False
    return name in SAFE_EXACT_NAMES or suffix in SAFE_SUFFIXES

def stream_download(url: str, target: Path, network_state: dict) -> tuple[str, int]:
    target.parent.mkdir(parents=True, exist_ok=True)
    h = hashlib.sha256()
    written = 0
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as resp, target.open("wb") as out:
        while True:
            chunk = resp.read(8 * 1024 * 1024)
            if not chunk:
                break
            network_state["bytes"] += len(chunk)
            if network_state["bytes"] > MAX_NETWORK_BYTES:
                out.close()
                target.unlink(missing_ok=True)
                fail("network budget exceeded")
            written += len(chunk)
            if written > MAX_STORAGE_BYTES:
                out.close()
                target.unlink(missing_ok=True)
                fail("single-file storage ceiling exceeded")
            h.update(chunk)
            out.write(chunk)
    return h.hexdigest(), written

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--output-dir", required=True)
    args = ap.parse_args()
    root = Path(args.output_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)

    meta = fetch_json(api_url())
    if meta.get("sha") != REVISION:
        fail(f"model revision drift: expected {REVISION} got {meta.get('sha')}")
    if meta.get("gated") not in (False, None, "false"):
        fail("model unexpectedly gated")

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
                target.unlink(missing_ok=True)
                fail(f"LFS sha256 mismatch for {rel}")

        manifest_files.append({
            "path": rel,
            "bytes": written,
            "sha256": digest,
            "expected_lfs_sha256": expected_lfs,
            "source_url": download_url(rel)
        })

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
        "schema_version": "clued.model-m1-download-manifest/1",
        "model_id": MODEL_ID,
        "revision": REVISION,
        "api_observed_sha": meta.get("sha"),
        "gated": meta.get("gated"),
        "network_bytes": network_state["bytes"],
        "snapshot_bytes": total_written,
        "max_network_bytes": MAX_NETWORK_BYTES,
        "max_storage_bytes": MAX_STORAGE_BYTES,
        "files": manifest_files,
        "model_loaded": False,
        "inference_performed": False,
        "evaluation_performed": False,
        "trust_remote_code": False
    }
    (root / "DownloadManifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    sums = {
        "schema_version": "clued.model-m1-snapshot-sha256/1",
        "model_id": MODEL_ID,
        "revision": REVISION,
        "files": [{"path": x["path"], "sha256": x["sha256"], "bytes": x["bytes"]} for x in manifest_files]
    }
    (root / "SHA256SUMS.json").write_text(json.dumps(sums, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    bom = {
        "schema_version": "clued.model-m1-reference-bom/1",
        "model_id": MODEL_ID,
        "revision": REVISION,
        "license_declared": meta.get("cardData", {}).get("license"),
        "pipeline_tag": meta.get("pipeline_tag"),
        "library_name": meta.get("library_name"),
        "file_count": len(manifest_files),
        "snapshot_bytes": total_written,
        "download_source": "huggingface.co exact revision",
        "execution_scope": "M1-03_DOWNLOAD_AND_INTEGRITY_ONLY"
    }
    (root / "BOM.json").write_text(json.dumps(bom, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(json.dumps({
        "result": "PASS",
        "model_id": MODEL_ID,
        "revision": REVISION,
        "file_count": len(manifest_files),
        "network_bytes": network_state["bytes"],
        "snapshot_bytes": total_written,
        "output_dir": str(root)
    }, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
