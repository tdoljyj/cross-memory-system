#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / "source-manifest.json"
EXPECTED_GO = "go1.23.2"
ALLOWED_UNMANIFESTED = {"source-manifest.json"}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def run(args: list[str], *, env: dict[str, str] | None = None) -> None:
    subprocess.run(args, cwd=HERE, env=env, check=True)


def verify_source_closure() -> tuple[dict, str]:
    raw = MANIFEST.read_bytes()
    manifest = json.loads(raw)
    if manifest.get("schema_version") != "clued.m1-08-native-owner-source-manifest/1":
        raise SystemExit("SOURCE_MANIFEST_SCHEMA")
    entries = manifest.get("files")
    if not isinstance(entries, list) or not entries:
        raise SystemExit("SOURCE_MANIFEST_FILES")
    declared: set[str] = set()
    for row in entries:
        rel = row.get("path")
        if not isinstance(rel, str) or not rel or rel in declared or "/" in rel or "\" in rel:
            raise SystemExit(f"SOURCE_MANIFEST_PATH:{rel!r}")
        declared.add(rel)
        p = HERE / rel
        data = p.read_bytes()
        if len(data) != row.get("bytes") or sha256_bytes(data) != row.get("sha256"):
            raise SystemExit(f"SOURCE_MANIFEST_DRIFT:{rel}")
    actual = {p.name for p in HERE.iterdir() if p.is_file() and p.name not in ALLOWED_UNMANIFESTED}
    if actual != declared:
        raise SystemExit(f"SOURCE_CLOSURE_DRIFT:missing={sorted(declared-actual)} extra={sorted(actual-declared)}")
    return manifest, sha256_bytes(raw)


def go_version() -> str:
    out = subprocess.check_output(["go", "version"], text=True).strip()
    m = re.match(r"go version (go\S+) ", out)
    if not m:
        raise SystemExit("GO_VERSION_PARSE")
    return m.group(1)


def file_sha(path: Path) -> tuple[int, str]:
    data = path.read_bytes()
    return len(data), sha256_bytes(data)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--receipt", type=Path)
    args = ap.parse_args()
    out = args.output.resolve()
    if not out.is_absolute() or out.parent.resolve() == HERE:
        raise SystemExit("OUTPUT_MUST_BE_ABSOLUTE_AND_OUTSIDE_SOURCE_DIR")

    manifest, manifest_sha = verify_source_closure()
    gv = go_version()
    if gv != EXPECTED_GO:
        raise SystemExit(f"GO_TOOLCHAIN_DRIFT expected={EXPECTED_GO} actual={gv}")

    # Common non-effectful static/negative/fault tests; never execute the owner.
    run(["go", "test", "./..."])
    run(["go", "vet", "./..."])

    env = os.environ.copy()
    env.update({"GOOS": "windows", "GOARCH": "amd64", "CGO_ENABLED": "0"})
    windows_test = out.with_name(out.name + ".tests.exe")
    run(["go", "test", "-c", "-trimpath", "-o", str(windows_test)], env=env)

    ldflags = f"-s -w -buildid= -X main.nativeSourceDigest={manifest_sha}"
    run(["go", "build", "-trimpath", "-buildvcs=false", "-ldflags", ldflags, "-o", str(out), "."], env=env)
    out_bytes, out_sha = file_sha(out)
    test_bytes, test_sha = file_sha(windows_test)

    bindings = (HERE / "bindings.go").read_text(encoding="utf-8")
    issuer_bound = 'const issuerPublicKeyHex = ""' not in bindings and 'const issuerPublicKeySHA256 = ""' not in bindings
    receipt = {
        "schema_version": "clued.m1-08-native-owner-build-receipt/1",
        "implementation_base": manifest["implementation_base"],
        "contract_git_blob_sha1": manifest["contract_git_blob_sha1"],
        "source_manifest_sha256": manifest_sha,
        "go_version": gv,
        "target": "windows/amd64",
        "common_go_test_pass": True,
        "go_vet_pass": True,
        "windows_test_binary_compiled": True,
        "windows_tests_executed_by_this_build": sys.platform == "win32",
        "owner_binary": {"path": str(out), "bytes": out_bytes, "sha256": out_sha},
        "windows_test_binary": {"path": str(windows_test), "bytes": test_bytes, "sha256": test_sha},
        "issuer_root_bound": issuer_bound,
        "effectful_execution_performed": False,
        "owner_binary_executed": False,
    }
    raw = json.dumps(receipt, ensure_ascii=False, sort_keys=True, indent=2) + "
"
    if args.receipt:
        rp = args.receipt.resolve()
        if rp.parent.resolve() == HERE:
            raise SystemExit("RECEIPT_MUST_BE_OUTSIDE_SOURCE_DIR")
        rp.write_text(raw, encoding="utf-8")
    print(raw, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
