#!/usr/bin/env python3
"""Build exact-source native owner as an external DEVELOPMENT artifact only."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(__file__).resolve().with_name("m1-runtime-owner")
OWNER_PUBLIC_KEY_HEX = "a683b21e2d838f0773fc1251e6d0165c4b15ad2b2994cabf4290edff1c24eb03"
OWNER_PUBLIC_KEY_SHA256 = "7d8a39adb80276686ff052b65e074a8ea9e74f7eccbc44f4340b194fec342f9c"

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
    if set(manifest["production_files"]) != expected:
        raise RuntimeError("native source set drift")
    for name, row in manifest["production_files"].items():
        data = (SOURCE / name).read_bytes()
        blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        if len(data) != row["bytes"] or hashlib.sha256(data).hexdigest() != row["sha256"] or blob != row["git_blob_sha1"]:
            raise RuntimeError("source identity mismatch: " + name)
    policy = (SOURCE / "policy.go").read_text(encoding="utf-8")
    if f'const issuerPublicKeyHex = "{OWNER_PUBLIC_KEY_HEX}"' not in policy:
        raise RuntimeError("successor build requires exact Owner-enrolled issuer public key")
    if f'const issuerPublicKeySHA256 = "{OWNER_PUBLIC_KEY_SHA256}"' not in policy:
        raise RuntimeError("successor build requires exact Owner public-key fingerprint")
    digest = hashlib.sha256(raw).hexdigest()
    output.mkdir(parents=True, exist_ok=False)
    binary = output / ("m1-07-owner.exe" if os.name == "nt" else "m1-07-owner")
    with tempfile.TemporaryDirectory(prefix="m107-go-build-") as temp:
        env = os.environ.copy()
        env.update(GOTOOLCHAIN="local", GOPROXY="off", GOSUMDB="off", CGO_ENABLED="0", GOCACHE=os.environ.get("CLUED_M107_GOCACHE", temp))
        argv = [str(go), "build", "-trimpath", "-buildvcs=false", "-ldflags=-X main.nativeSourceDigest=" + digest, "-o", str(binary), "."]
        process = subprocess.run(argv, cwd=SOURCE, env=env, capture_output=True, text=True, timeout=300)
        (output / "build.log").write_text(process.stdout + process.stderr, encoding="utf-8")
        if process.returncode:
            raise RuntimeError("native build failed; see external build.log")
        version = subprocess.check_output([str(go), "version"], env=env, text=True).strip()
    receipt = {"role": "OWNER_ROOT_PINNED_DEVELOPMENT_BUILD_NOT_ISSUANCE", "compiler": version, "compiler_sha256": hashlib.sha256(go.read_bytes()).hexdigest(), "argv": argv, "native_source_manifest_sha256": digest, "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "binary_bytes": binary.stat().st_size, "issuer_key_bound": True, "issuer_public_key_sha256_fingerprint": OWNER_PUBLIC_KEY_SHA256, "effectful_authority_issued": False, "binary_executed_by_build_helper": False}
    (output / "build-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
