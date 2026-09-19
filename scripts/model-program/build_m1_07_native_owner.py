#!/usr/bin/env python3
"""Build exact-source native owner as an external DEVELOPMENT artifact only."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import stat
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(__file__).resolve().with_name("m1-runtime-owner")
OWNER_PUBLIC_KEY_HEX = "a683b21e2d838f0773fc1251e6d0165c4b15ad2b2994cabf4290edff1c24eb03"
OWNER_PUBLIC_KEY_SHA256 = "7d8a39adb80276686ff052b65e074a8ea9e74f7eccbc44f4340b194fec342f9c"
SAFE_HOST_ENV = {"SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATH", "PATHEXT", "USERPROFILE"}

def build_env(cache: str, modcache: str, gotmp: str) -> dict[str, str]:
    # GOFLAGS can inject -overlay and replace reviewed source bytes after the
    # manifest has been verified. Refuse it rather than silently inheriting it.
    if os.environ.get("GOFLAGS"):
        raise RuntimeError("forbidden inherited Go build environment: GOFLAGS")
    env = {k: v for k, v in os.environ.items() if k.upper() in SAFE_HOST_ENV and v}
    env.update(
        GOENV="off",
        GOFLAGS="",
        GOWORK="off",
        GOEXPERIMENT="",
        GOTOOLCHAIN="local",
        GOPROXY="off",
        GOSUMDB="off",
        CGO_ENABLED="0",
        GOCACHE=cache,
        GOMODCACHE=modcache,
        GOTMPDIR=gotmp,
    )
    return env

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--go", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    go = args.go.resolve(strict=True)
    output = args.output.resolve()
    if output.is_relative_to(ROOT):
        parser.error("build output must be outside repository")
    if output.exists():
        parser.error("build output must be a new directory")
    manifest_path = SOURCE / "source-manifest.json"
    raw = manifest_path.read_bytes()
    manifest = json.loads(raw)
    expected = {"go.mod", "bindings.go", "policy.go", "owner.go", "platform_windows.go", "platform_other.go", "scenarios.go", "main.go"}
    expected_tests = {"owner_test.go", "runtime_tree_windows_test.go"}
    expected_metadata = {"source-manifest.json", "test-migration.json"}
    if set(manifest["production_files"]) != expected:
        raise RuntimeError("native production source set drift")
    if set(manifest.get("test_files_excluded_from_production", [])) != expected_tests:
        raise RuntimeError("native test source set drift")
    if set(manifest.get("non_build_metadata_files", [])) != expected_metadata:
        raise RuntimeError("native metadata set drift")
    actual_entries = {p.name for p in SOURCE.iterdir()}
    allowed_entries = expected | expected_tests | expected_metadata
    if actual_entries != allowed_entries:
        extra = sorted(actual_entries - allowed_entries)
        missing = sorted(allowed_entries - actual_entries)
        raise RuntimeError(f"native source directory set drift: extra={extra} missing={missing}")
    for p in SOURCE.iterdir():
        if not stat.S_ISREG(os.lstat(p).st_mode):
            raise RuntimeError("native source directory contains non-regular entry: " + p.name)
    helper_row = manifest.get("build_provenance_helper") or {}
    if helper_row.get("path") != "scripts/model-program/build_m1_07_native_owner.py":
        raise RuntimeError("build provenance helper path drift")
    helper_data = Path(__file__).resolve().read_bytes()
    helper_blob = hashlib.sha1(b"blob " + str(len(helper_data)).encode() + b"\0" + helper_data).hexdigest()
    if (
        len(helper_data) != helper_row.get("bytes")
        or hashlib.sha256(helper_data).hexdigest() != helper_row.get("sha256")
        or helper_blob != helper_row.get("git_blob_sha1")
    ):
        raise RuntimeError("build provenance helper identity mismatch")
    verified_files: dict[str, bytes] = {}
    for name, row in manifest["production_files"].items():
        data = (SOURCE / name).read_bytes()
        blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        if len(data) != row["bytes"] or hashlib.sha256(data).hexdigest() != row["sha256"] or blob != row["git_blob_sha1"]:
            raise RuntimeError("source identity mismatch: " + name)
        verified_files[name] = data
    policy = (SOURCE / "policy.go").read_text(encoding="utf-8")
    if f'const issuerPublicKeyHex = "{OWNER_PUBLIC_KEY_HEX}"' not in policy:
        raise RuntimeError("successor build requires exact Owner-enrolled issuer public key")
    if f'const issuerPublicKeySHA256 = "{OWNER_PUBLIC_KEY_SHA256}"' not in policy:
        raise RuntimeError("successor build requires exact Owner public-key fingerprint")
    digest = hashlib.sha256(raw).hexdigest()
    with tempfile.TemporaryDirectory(prefix="m107-go-build-") as temp:
        temp_root = Path(temp)
        build_source = temp_root / "verified-source"
        go_cache = temp_root / "go-cache"
        mod_cache = temp_root / "go-mod-cache"
        go_tmp = temp_root / "go-tmp"
        build_source.mkdir()
        go_cache.mkdir()
        mod_cache.mkdir()
        go_tmp.mkdir()
        for name, data in verified_files.items():
            (build_source / name).write_bytes(data)
        env = build_env(str(go_cache), str(mod_cache), str(go_tmp))
        output.mkdir(parents=True, exist_ok=False)
        binary = output / ("m1-07-owner.exe" if os.name == "nt" else "m1-07-owner")
        argv = [str(go), "build", "-trimpath", "-buildvcs=false", "-ldflags=-X main.nativeSourceDigest=" + digest, "-o", str(binary), "."]
        process = subprocess.run(argv, cwd=build_source, env=env, capture_output=True, text=True, timeout=300)
        (output / "build.log").write_text(process.stdout + process.stderr, encoding="utf-8")
        if process.returncode:
            raise RuntimeError("native build failed; see external build.log")
        version = subprocess.check_output([str(go), "version"], env=env, text=True).strip()
        target = subprocess.check_output([str(go), "env", "GOOS", "GOARCH", "GOAMD64"], env=env, text=True).splitlines()
    receipt = {"role": "OWNER_ROOT_PINNED_DEVELOPMENT_BUILD_NOT_ISSUANCE", "compiler": version, "compiler_sha256": hashlib.sha256(go.read_bytes()).hexdigest(), "target": {"goos": target[0], "goarch": target[1], "goamd64": target[2]}, "effective_build_env": {k: env[k] for k in ("GOENV","GOFLAGS","GOWORK","GOEXPERIMENT","GOTOOLCHAIN","GOPROXY","GOSUMDB","CGO_ENABLED","GOCACHE","GOMODCACHE","GOTMPDIR")}, "argv": argv, "native_source_manifest_sha256": digest, "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "binary_bytes": binary.stat().st_size, "issuer_key_bound": True, "issuer_public_key_sha256_fingerprint": OWNER_PUBLIC_KEY_SHA256, "effectful_authority_issued": False, "binary_executed_by_build_helper": False}
    (output / "build-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
