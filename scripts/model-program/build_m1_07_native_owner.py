#!/usr/bin/env python3
"""Build exact-source native owner as an external DEVELOPMENT artifact only."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import subprocess
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(__file__).resolve().with_name("m1-runtime-owner")
OWNER_PUBLIC_KEY_HEX = "a683b21e2d838f0773fc1251e6d0165c4b15ad2b2994cabf4290edff1c24eb03"
OWNER_PUBLIC_KEY_SHA256 = "7d8a39adb80276686ff052b65e074a8ea9e74f7eccbc44f4340b194fec342f9c"

TOOLCHAIN_ARCHIVE_NAME = "go1.27.1.windows-amd64.zip"
TOOLCHAIN_ARCHIVE_BYTES = 78931360
TOOLCHAIN_ARCHIVE_SHA256 = "a3911b5e0e1b1053f25ed0675f4c1c6aad1e2bfcf253df2b9be4caabd2edd95d"
TOOLCHAIN_TREE_FILES = 15639
TOOLCHAIN_TREE_SHA256 = "b6c3561132d8efde201d5d39a12daa893a2c4a053432ea6c427f0246df5b1fe3"
TOOLCHAIN_GO_EXE_SHA256 = "d3ccdb604eafa6031133aefe1a3db24f0bb7362b857bc2125ac4e4c178b4b490"
TOOLCHAIN_COMPILE_EXE_SHA256 = "69294d68bcaa3e786f80d23bfb8bed807d5d969e931d5bf92161bdf518778a01"
TOOLCHAIN_LINK_EXE_SHA256 = "9146582fd2b0a8cf765831e7ee3127603faaf51697531496584024db96414720"
TOOLCHAIN_VERSION = "go version go1.27.1 windows/amd64"
TOOLCHAIN_GOOS = "windows"
TOOLCHAIN_GOARCH = "amd64"
TOOLCHAIN_GOAMD64 = "v1"

SAFE_HOST_ENV = {"SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC"}


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def git_blob_sha1(data: bytes) -> str:
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()


def build_env(cache: str, modcache: str, gotmp: str, goroot: str) -> dict[str, str]:
    # Ambient Go settings are not part of authority. Refuse known injection
    # input and then construct an allowlisted environment from scratch.
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
        GOROOT=goroot,
    )
    return env


def exact_toolchain_contract() -> dict[str, object]:
    return {
        "archive_name": TOOLCHAIN_ARCHIVE_NAME,
        "archive_bytes": TOOLCHAIN_ARCHIVE_BYTES,
        "archive_sha256": TOOLCHAIN_ARCHIVE_SHA256,
        "tree_file_count": TOOLCHAIN_TREE_FILES,
        "tree_sha256": TOOLCHAIN_TREE_SHA256,
        "go_exe_sha256": TOOLCHAIN_GO_EXE_SHA256,
        "compile_exe_sha256": TOOLCHAIN_COMPILE_EXE_SHA256,
        "link_exe_sha256": TOOLCHAIN_LINK_EXE_SHA256,
        "version": TOOLCHAIN_VERSION,
        "target": {
            "goos": TOOLCHAIN_GOOS,
            "goarch": TOOLCHAIN_GOARCH,
            "goamd64": TOOLCHAIN_GOAMD64,
        },
        "semantics": "EXACT_OFFICIAL_ZIP / FRESH_SAFE_EXTRACTION / EXTRACTED_TREE_EXACT_MATCH / NO_CALLER_EXECUTABLE",
    }


def validate_toolchain_archive(path: Path) -> None:
    st = os.lstat(path)
    if not stat.S_ISREG(st.st_mode):
        raise RuntimeError("toolchain archive must be a regular file")
    if path.name != TOOLCHAIN_ARCHIVE_NAME:
        raise RuntimeError("toolchain archive filename drift")
    if st.st_size != TOOLCHAIN_ARCHIVE_BYTES:
        raise RuntimeError("toolchain archive size drift")
    if file_sha256(path) != TOOLCHAIN_ARCHIVE_SHA256:
        raise RuntimeError("toolchain archive digest drift")


def safe_extract_verified_toolchain(archive: Path, destination: Path) -> tuple[Path, str, int]:
    expected: dict[str, tuple[int, str]] = {}
    with zipfile.ZipFile(archive, "r") as zf:
        seen: set[str] = set()
        for info in zf.infolist():
            name = info.filename
            if not name or "\\" in name:
                raise RuntimeError("toolchain archive path invalid")
            posix = PurePosixPath(name)
            if posix.is_absolute() or ".." in posix.parts or not posix.parts or posix.parts[0] != "go":
                raise RuntimeError("toolchain archive path invalid")
            if name in seen:
                raise RuntimeError("toolchain archive duplicate entry")
            seen.add(name)
            unix_mode = (info.external_attr >> 16) & 0xFFFF
            if unix_mode and stat.S_ISLNK(unix_mode):
                raise RuntimeError("toolchain archive symlink forbidden")
            target = destination.joinpath(*posix.parts)
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            data = zf.read(info)
            if len(data) != info.file_size:
                raise RuntimeError("toolchain archive entry size drift")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            expected[name] = (len(data), hashlib.sha256(data).hexdigest())

    actual: dict[str, Path] = {}
    for path in destination.rglob("*"):
        if path.is_symlink():
            raise RuntimeError("extracted toolchain symlink forbidden")
        if path.is_file():
            actual[path.relative_to(destination).as_posix()] = path
    if set(actual) != set(expected):
        raise RuntimeError("extracted toolchain file set drift")

    tree = hashlib.sha256()
    for name in sorted(expected):
        size, expected_sha = expected[name]
        path = actual[name]
        if path.stat().st_size != size or file_sha256(path) != expected_sha:
            raise RuntimeError("extracted toolchain file identity drift: " + name)
        tree.update((name + "\0" + str(size) + "\0" + expected_sha + "\n").encode("utf-8"))
    tree_sha = tree.hexdigest()
    if len(expected) != TOOLCHAIN_TREE_FILES or tree_sha != TOOLCHAIN_TREE_SHA256:
        raise RuntimeError("extracted toolchain tree identity drift")

    go = destination / "go/bin/go.exe"
    compile_exe = destination / "go/pkg/tool/windows_amd64/compile.exe"
    link_exe = destination / "go/pkg/tool/windows_amd64/link.exe"
    if file_sha256(go) != TOOLCHAIN_GO_EXE_SHA256:
        raise RuntimeError("toolchain go.exe identity drift")
    if file_sha256(compile_exe) != TOOLCHAIN_COMPILE_EXE_SHA256:
        raise RuntimeError("toolchain compile.exe identity drift")
    if file_sha256(link_exe) != TOOLCHAIN_LINK_EXE_SHA256:
        raise RuntimeError("toolchain link.exe identity drift")
    return go, tree_sha, len(expected)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--toolchain-archive", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    archive = args.toolchain_archive.resolve(strict=True)
    output = args.output.resolve()
    if output.is_relative_to(ROOT):
        parser.error("build output must be outside repository")
    if output.exists():
        parser.error("build output must be a new directory")

    # Toolchain identity is verified before any executable from it is run and
    # before any build output directory is created.
    validate_toolchain_archive(archive)

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
    if manifest.get("native_build_toolchain") != exact_toolchain_contract():
        raise RuntimeError("native build toolchain contract drift")

    actual_entries = {p.name for p in SOURCE.iterdir()}
    allowed_entries = expected | expected_tests | expected_metadata
    if actual_entries != allowed_entries:
        extra = sorted(actual_entries - allowed_entries)
        missing = sorted(allowed_entries - actual_entries)
        raise RuntimeError(f"native source directory set drift: extra={extra} missing={missing}")
    for path in SOURCE.iterdir():
        if not stat.S_ISREG(os.lstat(path).st_mode):
            raise RuntimeError("native source directory contains non-regular entry: " + path.name)

    helper_row = manifest.get("build_provenance_helper") or {}
    if helper_row.get("path") != "scripts/model-program/build_m1_07_native_owner.py":
        raise RuntimeError("build provenance helper path drift")
    helper_data = Path(__file__).resolve().read_bytes()
    if (
        len(helper_data) != helper_row.get("bytes")
        or hashlib.sha256(helper_data).hexdigest() != helper_row.get("sha256")
        or git_blob_sha1(helper_data) != helper_row.get("git_blob_sha1")
    ):
        raise RuntimeError("build provenance helper identity mismatch")

    verified_files: dict[str, bytes] = {}
    for name, row in manifest["production_files"].items():
        data = (SOURCE / name).read_bytes()
        if (
            len(data) != row["bytes"]
            or hashlib.sha256(data).hexdigest() != row["sha256"]
            or git_blob_sha1(data) != row["git_blob_sha1"]
        ):
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
        toolchain_root = temp_root / "verified-toolchain"
        build_source = temp_root / "verified-source"
        go_cache = temp_root / "go-cache"
        mod_cache = temp_root / "go-mod-cache"
        go_tmp = temp_root / "go-tmp"
        toolchain_root.mkdir()
        build_source.mkdir()
        go_cache.mkdir()
        mod_cache.mkdir()
        go_tmp.mkdir()

        go, toolchain_tree_sha, toolchain_file_count = safe_extract_verified_toolchain(archive, toolchain_root)
        for name, data in verified_files.items():
            (build_source / name).write_bytes(data)

        goroot = toolchain_root / "go"
        env = build_env(str(go_cache), str(mod_cache), str(go_tmp), str(goroot))

        # Verify the freshly extracted toolchain's self-reported identity before
        # it is permitted to build the candidate.
        version = subprocess.check_output([str(go), "version"], env=env, text=True, timeout=30).strip()
        target = subprocess.check_output(
            [str(go), "env", "GOOS", "GOARCH", "GOAMD64", "GOROOT"],
            env=env,
            text=True,
            timeout=30,
        ).splitlines()
        if version != TOOLCHAIN_VERSION:
            raise RuntimeError("toolchain version drift")
        if target[:3] != [TOOLCHAIN_GOOS, TOOLCHAIN_GOARCH, TOOLCHAIN_GOAMD64]:
            raise RuntimeError("toolchain target drift")
        if Path(target[3]).resolve() != goroot.resolve():
            raise RuntimeError("toolchain GOROOT drift")

        output.mkdir(parents=True, exist_ok=False)
        binary = output / ("m1-07-owner.exe" if os.name == "nt" else "m1-07-owner")
        argv = [
            str(go),
            "build",
            "-trimpath",
            "-buildvcs=false",
            "-ldflags=-X main.nativeSourceDigest=" + digest,
            "-o",
            str(binary),
            ".",
        ]
        process = subprocess.run(argv, cwd=build_source, env=env, capture_output=True, text=True, timeout=300)
        (output / "build.log").write_text(process.stdout + process.stderr, encoding="utf-8")
        if process.returncode:
            raise RuntimeError("native build failed; see external build.log")

    receipt = {
        "role": "OWNER_ROOT_PINNED_DEVELOPMENT_BUILD_NOT_ISSUANCE",
        "toolchain_archive_name": TOOLCHAIN_ARCHIVE_NAME,
        "toolchain_archive_bytes": TOOLCHAIN_ARCHIVE_BYTES,
        "toolchain_archive_sha256": TOOLCHAIN_ARCHIVE_SHA256,
        "toolchain_tree_file_count": toolchain_file_count,
        "toolchain_tree_sha256": toolchain_tree_sha,
        "compiler": version,
        "compiler_sha256": TOOLCHAIN_GO_EXE_SHA256,
        "compiler_compile_exe_sha256": TOOLCHAIN_COMPILE_EXE_SHA256,
        "compiler_link_exe_sha256": TOOLCHAIN_LINK_EXE_SHA256,
        "target": {"goos": target[0], "goarch": target[1], "goamd64": target[2]},
        "effective_build_env": {
            key: env[key]
            for key in (
                "GOENV",
                "GOFLAGS",
                "GOWORK",
                "GOEXPERIMENT",
                "GOTOOLCHAIN",
                "GOPROXY",
                "GOSUMDB",
                "CGO_ENABLED",
                "GOCACHE",
                "GOMODCACHE",
                "GOTMPDIR",
                "GOROOT",
            )
        },
        "argv": argv,
        "native_source_manifest_sha256": digest,
        "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "binary_bytes": binary.stat().st_size,
        "issuer_key_bound": True,
        "issuer_public_key_sha256_fingerprint": OWNER_PUBLIC_KEY_SHA256,
        "effectful_authority_issued": False,
        "binary_executed_by_build_helper": False,
    }
    (output / "build-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
