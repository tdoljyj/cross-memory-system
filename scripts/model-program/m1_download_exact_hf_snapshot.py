#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath

MODEL_ID = "Qwen/Qwen3.5-0.8B"
REVISION = "2fc06364715b967f1860aea9cf38778875588b17"
PROFILE_ID = "M1-REF-QWEN35-08B-LLAMACPP-003"
MAX_NETWORK_BYTES = 3221225472
MAX_STORAGE_BYTES = 4294967296
RANGE_CHUNK_BYTES = 64 * 1024 * 1024
IO_CHUNK_BYTES = 8 * 1024 * 1024
USER_AGENT = "Clued-M1-Reference-Downloader/2.0"

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
    print("FAIL: " + msg, file=sys.stderr, flush=True)
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

def iter_ranges(total: int, chunk: int = RANGE_CHUNK_BYTES):
    if total <= 0 or chunk <= 0:
        raise ValueError("positive total and chunk required")
    start = 0
    while start < total:
        end = min(start + chunk - 1, total - 1)
        yield start, end
        start = end + 1

def account_and_write(data: bytes, out, hasher, network_state: dict) -> None:
    network_state["bytes"] += len(data)
    if network_state["bytes"] > MAX_NETWORK_BYTES:
        fail("network budget exceeded")
    hasher.update(data)
    out.write(data)

def stream_full(url: str, target: Path, network_state: dict) -> tuple[str, int]:
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".partial")
    partial.unlink(missing_ok=True)
    h = hashlib.sha256()
    written = 0
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as resp, partial.open("wb") as out:
        while True:
            data = resp.read(IO_CHUNK_BYTES)
            if not data:
                break
            written += len(data)
            if written > MAX_STORAGE_BYTES:
                fail("single-file storage ceiling exceeded")
            account_and_write(data, out, h, network_state)
    partial.replace(target)
    return h.hexdigest(), written

def stream_ranged(url: str, target: Path, expected_size: int, network_state: dict) -> tuple[str, int]:
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".partial")
    partial.unlink(missing_ok=True)
    h = hashlib.sha256()
    written = 0
    with partial.open("wb") as out:
        for start, end in iter_ranges(expected_size):
            req = urllib.request.Request(
                url,
                headers={"User-Agent": USER_AGENT, "Range": f"bytes={start}-{end}"}
            )
            with urllib.request.urlopen(req, timeout=120) as resp:
                if getattr(resp, "status", None) != 206:
                    fail(f"range request not honored for {target.name}: status={getattr(resp, 'status', None)}")
                content_range = resp.headers.get("Content-Range")
                expected_prefix = f"bytes {start}-{end}/"
                if not content_range or not content_range.startswith(expected_prefix):
                    fail(f"unexpected Content-Range for {target.name}: {content_range}")
                expected_chunk = end - start + 1
                header_len = resp.headers.get("Content-Length")
                if header_len is not None and int(header_len) != expected_chunk:
                    fail(f"range Content-Length mismatch for {target.name}")
                received = 0
                while received < expected_chunk:
                    data = resp.read(min(IO_CHUNK_BYTES, expected_chunk - received))
                    if not data:
                        break
                    received += len(data)
                    written += len(data)
                    if written > MAX_STORAGE_BYTES:
                        fail("single-file storage ceiling exceeded")
                    account_and_write(data, out, h, network_state)
                if received != expected_chunk:
                    fail(f"short range read for {target.name}: {received}/{expected_chunk}")
            print(json.dumps({
                "progress": "RANGE_COMPLETE",
                "file": target.name,
                "range_start": start,
                "range_end": end,
                "written": written,
                "expected_size": expected_size
            }), flush=True)
    if written != expected_size:
        fail(f"ranged file size mismatch for {target.name}: {written}/{expected_size}")
    partial.replace(target)
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
        size = row.get("size")
        lfs = row.get("lfs")
        use_range = isinstance(lfs, dict) and isinstance(size, int) and size >= RANGE_CHUNK_BYTES
        if use_range:
            digest, written = stream_ranged(download_url(rel), target, size, network_state)
        else:
            digest, written = stream_full(download_url(rel), target, network_state)

        total_written += written
        if total_written > MAX_STORAGE_BYTES:
            fail("snapshot storage ceiling exceeded")

        expected_lfs = lfs.get("sha256") if isinstance(lfs, dict) else None
        if expected_lfs and digest != expected_lfs:
            target.unlink(missing_ok=True)
            fail(f"LFS sha256 mismatch for {rel}")

        manifest_files.append({
            "path": rel,
            "bytes": written,
            "sha256": digest,
            "expected_lfs_sha256": expected_lfs,
            "source_url": download_url(rel),
            "transfer_mode": "RANGE_CHUNKED" if use_range else "FULL"
        })
        print(json.dumps({
            "progress": "FILE_COMPLETE",
            "file": rel,
            "bytes": written,
            "sha256": digest,
            "network_bytes": network_state["bytes"]
        }), flush=True)

    license_path = next((p for p in [root / "LICENSE", root / "LICENSE.txt"] if p.is_file()), None)
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
        "range_chunk_bytes": RANGE_CHUNK_BYTES,
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
        "schema_version": "clued.model-m1-reference-bom/2",
        "profile_id": PROFILE_ID,
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
        "profile_id": PROFILE_ID,
        "model_id": MODEL_ID,
        "revision": REVISION,
        "file_count": len(manifest_files),
        "network_bytes": network_state["bytes"],
        "snapshot_bytes": total_written,
        "output_dir": str(root)
    }, ensure_ascii=False), flush=True)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
