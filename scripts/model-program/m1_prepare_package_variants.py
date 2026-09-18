#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

PROFILE_ID = "M1-PKG-QWEN35-08B-002"
LLAMA_COMMIT = "8ed1a55efcd7424d2c592f6cbc9f97756db1d74d"
LLAMA_TAG = "b11033"
RUNTIME_ASSET_URL = "https://github.com/ggml-org/llama.cpp/releases/download/b11033/llama-b11033-bin-win-vulkan-x64.zip"
RUNTIME_ASSET_BYTES = 31766410
RUNTIME_ASSET_SHA256 = "8ca91d4621fcac8799245f01a6467e9c09eba7b8d3be161a382048dc5c839db2"
RAW_MODEL_REVISION = "2fc06364715b967f1860aea9cf38778875588b17"
RAW_WEIGHT_SHA256 = "04b1c301231dd422b8860db31311ab2721511346a32cb1e079c4c4e5f1fe4696"
MAX_NETWORK_BYTES = 6 * 1024**3
MAX_OUTPUT_BYTES = 12 * 1024**3
USER_AGENT = "Clued-M1-Package-Preparation/1.1"

def fail(msg: str) -> None:
    print("FAIL: " + msg, file=sys.stderr)
    raise SystemExit(1)

def sha256_file(path: Path) -> tuple[str, int]:
    h = hashlib.sha256()
    n = 0
    with path.open("rb") as f:
        while True:
            b = f.read(8 * 1024 * 1024)
            if not b:
                break
            n += len(b)
            h.update(b)
    return h.hexdigest(), n

def tree_bytes(root: Path) -> int:
    if not root.exists():
        return 0
    return sum(p.stat().st_size for p in root.rglob("*") if p.is_file())

def run(cmd: list[str], cwd: Path | None = None) -> str:
    p = subprocess.run(cmd, cwd=str(cwd) if cwd else None, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if p.returncode != 0:
        print(p.stdout, file=sys.stderr)
        fail("command failed: " + " ".join(cmd))
    return p.stdout

def acquire_lock(root: Path) -> Path:
    root.parent.mkdir(parents=True, exist_ok=True)
    lock = root.parent / f".{root.name}.{PROFILE_ID}.lock"
    try:
        fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        fail("one-shot profile lock already exists")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"profile_id": PROFILE_ID, "state": "ATTEMPT_STARTED", "started_at_utc": datetime.now(timezone.utc).isoformat(), "pid": os.getpid()}, f, indent=2)
        f.write("\n")
    return lock

def download_exact(url: str, dest: Path, expected_sha: str, expected_bytes: int, direct_network: dict) -> None:
    part = Path(str(dest) + ".partial")
    if dest.exists() or part.exists():
        fail("download target already exists: " + str(dest))
    dest.parent.mkdir(parents=True, exist_ok=True)
    h = hashlib.sha256()
    n = 0
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp, part.open("xb") as out:
            while True:
                b = resp.read(8 * 1024 * 1024)
                if not b:
                    break
                n += len(b)
                direct_network["bytes"] += len(b)
                if direct_network["bytes"] > MAX_NETWORK_BYTES:
                    fail("direct network budget exceeded")
                h.update(b)
                out.write(b)
        if n != expected_bytes or h.hexdigest() != expected_sha:
            fail("runtime asset digest/size mismatch")
        os.replace(part, dest)
    finally:
        part.unlink(missing_ok=True)

def enforce_network_upper_bound(runtime_bytes: int, git_object_bytes: int, wheelhouse_bytes: int, evidence_path: Path) -> int:
    upper = runtime_bytes + git_object_bytes + wheelhouse_bytes
    evidence = {
        "schema_version": "clued.model-m1-network-accounting/1",
        "method": "CONSERVATIVE_AT_REST_UPPER_BOUND",
        "runtime_direct_http_bytes": runtime_bytes,
        "git_object_store_bytes": git_object_bytes,
        "pip_wheelhouse_bytes": wheelhouse_bytes,
        "network_upper_bound_bytes": upper,
        "max_network_bytes": MAX_NETWORK_BYTES,
        "pass": upper <= MAX_NETWORK_BYTES,
        "note": "Git object-store and wheelhouse sizes are used as conservative transfer proxies; installation is performed offline from wheelhouse.",
    }
    evidence_path.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    if upper > MAX_NETWORK_BYTES:
        fail("conservative network upper bound exceeded")
    return upper

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw-snapshot-dir", required=True)
    ap.add_argument("--output-dir", required=True)
    args = ap.parse_args()

    raw = Path(args.raw_snapshot_dir).resolve()
    root = Path(args.output_dir).resolve()
    lock = acquire_lock(root)
    if root.exists():
        fail("profile requires a new output directory")
    root.mkdir(parents=True)

    raw_weight = raw / "model.safetensors-00001-of-00001.safetensors"
    raw_manifest = raw / "DownloadManifest.json"
    if not raw_weight.is_file() or not raw_manifest.is_file():
        fail("exact M1-03 source snapshot missing")
    raw_sha, raw_bytes = sha256_file(raw_weight)
    if raw_sha != RAW_WEIGHT_SHA256:
        fail("raw weight digest drift")
    raw_meta = json.loads(raw_manifest.read_text(encoding="utf-8"))
    if raw_meta.get("revision") != RAW_MODEL_REVISION or raw_meta.get("post_download_independent_rehash") != "PASS":
        fail("raw M1-03 manifest drift")

    direct_network = {"bytes": 0}
    runtime_zip = root / "runtime" / "llama-b11033-bin-win-vulkan-x64.zip"
    download_exact(RUNTIME_ASSET_URL, runtime_zip, RUNTIME_ASSET_SHA256, RUNTIME_ASSET_BYTES, direct_network)
    runtime_dir = root / "runtime" / "b11033-vulkan"
    runtime_dir.mkdir(parents=True)
    with zipfile.ZipFile(runtime_zip) as z:
        for info in z.infolist():
            p = Path(info.filename)
            if p.is_absolute() or ".." in p.parts:
                fail("unsafe runtime zip path")
        z.extractall(runtime_dir)

    quantizers = list(runtime_dir.rglob("llama-quantize.exe"))
    if len(quantizers) != 1:
        fail("expected exactly one llama-quantize.exe")
    quantize = quantizers[0]
    quantize_sha, quantize_bytes = sha256_file(quantize)

    source_dir = root / "toolchain" / "llama.cpp"
    source_dir.parent.mkdir(parents=True)
    run(["git", "clone", "--filter=blob:none", "--no-checkout", "https://github.com/ggml-org/llama.cpp.git", str(source_dir)])
    run(["git", "checkout", "--detach", LLAMA_COMMIT], cwd=source_dir)
    head = run(["git", "rev-parse", "HEAD"], cwd=source_dir).strip()
    if head != LLAMA_COMMIT:
        fail("llama.cpp source revision drift")
    git_object_bytes = tree_bytes(source_dir / ".git" / "objects")

    venv = root / "toolchain" / "venv"
    run([sys.executable, "-m", "venv", str(venv)])
    py = venv / "Scripts" / "python.exe"
    wheelhouse = root / "toolchain" / "wheelhouse"
    wheelhouse.mkdir()
    req = source_dir / "requirements" / "requirements-convert_hf_to_gguf.txt"
    run([str(py), "-m", "pip", "download", "--disable-pip-version-check", "--dest", str(wheelhouse), "-r", str(req)])
    wheelhouse_bytes = tree_bytes(wheelhouse)
    network_upper_bound = enforce_network_upper_bound(
        direct_network["bytes"],
        git_object_bytes,
        wheelhouse_bytes,
        root / "NetworkAccounting.json",
    )
    run([str(py), "-m", "pip", "install", "--disable-pip-version-check", "--no-index", "--find-links", str(wheelhouse), "-r", str(req)])
    freeze = run([str(py), "-m", "pip", "freeze"])
    (root / "ResolvedPythonEnvironment.txt").write_text(freeze, encoding="utf-8")

    packages = root / "packages"
    packages.mkdir()
    bf16 = packages / "Qwen3.5-0.8B-BF16.gguf"
    q8 = packages / "Qwen3.5-0.8B-Q8_0.gguf"
    q40 = packages / "Qwen3.5-0.8B-Q4_0.gguf"
    q4km = packages / "Qwen3.5-0.8B-Q4_K_M.gguf"

    converter = source_dir / "convert_hf_to_gguf.py"
    run([str(py), str(converter), str(raw), "--outfile", str(bf16), "--outtype", "bf16"], cwd=source_dir)
    run([str(py), str(converter), str(raw), "--outfile", str(q8), "--outtype", "q8_0"], cwd=source_dir)
    run([str(quantize), str(bf16), str(q40), "Q4_0"], cwd=quantize.parent)
    run([str(quantize), str(bf16), str(q4km), "Q4_K_M"], cwd=quantize.parent)

    variants = []
    for variant_id, path, method in [
        ("bf16", bf16, "convert_hf_to_gguf:bf16"),
        ("q8_0", q8, "convert_hf_to_gguf:q8_0"),
        ("q4_0", q40, "llama-quantize:Q4_0"),
        ("q4_k_m", q4km, "llama-quantize:Q4_K_M"),
    ]:
        digest, size = sha256_file(path)
        variants.append({"variant_id": variant_id, "path": path.name, "bytes": size, "sha256": digest, "method": method})

    output_bytes = tree_bytes(root)
    if output_bytes > MAX_OUTPUT_BYTES:
        fail("output storage budget exceeded")

    manifest = {
        "schema_version": "clued.model-m1-package-preparation-manifest/2",
        "profile_id": PROFILE_ID,
        "source_model_revision": RAW_MODEL_REVISION,
        "source_weight_sha256": RAW_WEIGHT_SHA256,
        "runtime_release_tag": LLAMA_TAG,
        "runtime_commit": LLAMA_COMMIT,
        "runtime_asset": {"name": runtime_zip.name, "bytes": RUNTIME_ASSET_BYTES, "sha256": RUNTIME_ASSET_SHA256},
        "llama_quantize_exe": {"path": str(quantize.relative_to(root)), "bytes": quantize_bytes, "sha256": quantize_sha},
        "resolved_python_environment_sha256": sha256_file(root / "ResolvedPythonEnvironment.txt")[0],
        "network_accounting_sha256": sha256_file(root / "NetworkAccounting.json")[0],
        "network_upper_bound_bytes": network_upper_bound,
        "output_tree_bytes": output_bytes,
        "variants": variants,
        "model_inference_performed": False,
        "model_evaluation_performed": False,
        "training_performed": False,
        "quality_selection_performed": False,
    }
    (root / "PackagePreparationManifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    lock.write_text(json.dumps({
        "profile_id": PROFILE_ID,
        "state": "COMPLETED",
        "completed_at_utc": datetime.now(timezone.utc).isoformat(),
        "pid": os.getpid(),
        "manifest_sha256": sha256_file(root / "PackagePreparationManifest.json")[0],
        "network_upper_bound_bytes": network_upper_bound,
    }, indent=2) + "\n", encoding="utf-8")

    print(json.dumps({"result":"PASS","profile_id":PROFILE_ID,"variants":variants,"network_upper_bound_bytes":network_upper_bound}))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
