#!/usr/bin/env python3
"""Build the M1-08 native owner as a non-effectful implementation artifact."""
from __future__ import annotations

import sys
sys.dont_write_bytecode = True  # imported helpers must not write __pycache__ into source
from qualification_scope import QualificationScope, validate_output_path, require_go_test_report

import argparse
import ctypes
import hashlib
import json
import os
import stat
import subprocess
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
MANIFEST = HERE / "source-manifest.json"
CONTRACT = ROOT / "development/contracts/model-program/m1/governance/M1RuntimeLifecycleSmokeContract.v0.1.2.json"
BASE_CANDIDATE = ROOT / "development/contracts/model-program/m1/governance/ExperimentAuthorizationProfile.M1-LIFE-QWEN35-08B-PC-001.candidate.json"
SUCCESSOR_PROFILE_REPO_PATH = "development/contracts/model-program/m1/governance/ExperimentAuthorizationProfile.M1-LIFE-QWEN35-08B-PC-003.owner-root-pinned.candidate.json"
SUCCESSOR_CANDIDATE = ROOT / SUCCESSOR_PROFILE_REPO_PATH

IMPLEMENTATION_BASE = "ab234beb9c5143a35a7c4e98e1bc9f65d64c507c"
CONTRACT_BLOB = "2a11bc4fa3d56d58547e11024cd0bfb5f8ba45e7"
CONTRACT_BYTES = 87536
CONTRACT_SHA256 = "0310b230f0194c7bb02fdf6ee7d3a8724cc50622dfcb148ceb2cc4585fdf07c4"
BASE_CANDIDATE_BLOB = "51b0083f74dd12318b7cdcdf3b939d31723de787"
BASE_CANDIDATE_BYTES = 37761
BASE_CANDIDATE_SHA256 = "c0699d1364cf9bdad7c447edacb5e1702a69fdd893a4937269b55cf00d82ffd3"
EXPECTED_ISSUER_PUBLIC_KEY_HEX = "a683b21e2d838f0773fc1251e6d0165c4b15ad2b2994cabf4290edff1c24eb03"
EXPECTED_ISSUER_PUBLIC_KEY_SHA256 = "7d8a39adb80276686ff052b65e074a8ea9e74f7eccbc44f4340b194fec342f9c"

TOOLCHAIN_ARCHIVE_NAME = "go1.27.1.windows-amd64.zip"
TOOLCHAIN_ARCHIVE_BYTES = 78931360
TOOLCHAIN_ARCHIVE_SHA256 = "a3911b5e0e1b1053f25ed0675f4c1c6aad1e2bfcf253df2b9be4caabd2edd95d"
TOOLCHAIN_TREE_FILES = 15639
TOOLCHAIN_TREE_SHA256 = "bf7939c5c947597c3a2bbf56b7ddf943fa06cd10cae421eadc01d44f18a5df79"
TOOLCHAIN_GO_EXE_SHA256 = "d3ccdb604eafa6031133aefe1a3db24f0bb7362b857bc2125ac4e4c178b4b490"
TOOLCHAIN_COMPILE_EXE_SHA256 = "69294d68bcaa3e786f80d23bfb8bed807d5d969e931d5bf92161bdf518778a01"
TOOLCHAIN_LINK_EXE_SHA256 = "9146582fd2b0a8cf765831e7ee3127603faaf51697531496584024db96414720"
TOOLCHAIN_VERSION = "go version go1.27.1 windows/amd64"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def git_blob_sha1(data: bytes) -> str:
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()


def source_tree_git_sha1(manifest: dict, manifest_raw: bytes) -> str:
    entries = [(row["path"], row["git_blob_sha1"]) for row in manifest["files"]]
    entries.append(("source-manifest.json", git_blob_sha1(manifest_raw)))
    body = b"".join(
        b"100644 " + name.encode("utf-8") + b"\0" + bytes.fromhex(blob)
        for name, blob in sorted(entries)
    )
    return hashlib.sha1(b"tree " + str(len(body)).encode("ascii") + b"\0" + body).hexdigest()


def verify_successor_profile(manifest: dict, manifest_raw: bytes, manifest_sha: str) -> tuple[bytes, str, str, str]:
    st = os.lstat(SUCCESSOR_CANDIDATE)
    if not stat.S_ISREG(st.st_mode) or SUCCESSOR_CANDIDATE.is_symlink():
        raise RuntimeError("successor profile must be a non-symlink regular file")
    raw = SUCCESSOR_CANDIDATE.read_bytes()
    p = json.loads(raw)
    tree_sha = source_tree_git_sha1(manifest, manifest_raw)
    code = p.get("code_revision")
    execution = p.get("execution_control")
    prep = p.get("successor_preparation")
    if not isinstance(code, dict) or not isinstance(execution, dict) or not isinstance(prep, dict):
        raise RuntimeError("successor profile required binding objects missing")
    if p.get("status") != "BLOCKED_PENDING_FRESH_CONTEXT_REVIEW_PARENT_PROVISIONING_AND_FINAL_ISSUANCE":
        raise RuntimeError("successor profile stage drift")
    if p.get("effectful_authority_issued") is not False or p.get("authority_effect") != "NONE / PROFILE_PREPARATION_ONLY":
        raise RuntimeError("successor profile unexpectedly grants effectful authority")
    if "owner_signature" in p or "owner_final_execution_authorization" in p:
        raise RuntimeError("successor profile unexpectedly contains issuance authorization/signature")
    if code.get("required_effectful_owner_binary_sha256") != "TO_BE_BOUND_AT_FINAL_ISSUANCE":
        raise RuntimeError("successor profile final binary binding unexpectedly resolved")
    if code.get("execution_allowed_while_candidate") is not False or code.get("implementation_authorized_by_this_profile") is not False:
        raise RuntimeError("successor profile unexpectedly authorizes candidate execution/implementation")
    if code.get("required_effectful_owner_source_path") != "scripts/model-program/m1-runtime-lifecycle-owner/source-manifest.json":
        raise RuntimeError("successor profile source path does not match production admission")
    if code.get("required_effectful_owner_source_manifest_sha256") != manifest_sha:
        raise RuntimeError("successor profile manifest SHA-256 drift")
    if code.get("required_effectful_owner_source_manifest_git_blob_sha1") != git_blob_sha1(manifest_raw):
        raise RuntimeError("successor profile manifest Git blob drift")
    if code.get("required_effectful_owner_source_tree_git_sha1") != tree_sha:
        raise RuntimeError("successor profile source tree drift")
    if prep.get("effectful_owner_source_manifest_sha256") != manifest_sha:
        raise RuntimeError("successor preparation manifest SHA-256 drift")
    if prep.get("effectful_owner_source_manifest_git_blob_sha1") != git_blob_sha1(manifest_raw):
        raise RuntimeError("successor preparation manifest Git blob drift")
    if prep.get("effectful_owner_source_tree_git_sha1") != tree_sha:
        raise RuntimeError("successor preparation source tree drift")
    if execution.get("issuer_public_key_canonical") != EXPECTED_ISSUER_PUBLIC_KEY_HEX:
        raise RuntimeError("successor profile issuer public key drift")
    if execution.get("issuer_public_key_sha256_fingerprint") != EXPECTED_ISSUER_PUBLIC_KEY_SHA256:
        raise RuntimeError("successor profile issuer fingerprint drift")
    if "PINNED_REUSED_EXISTING_M1_07_OWNER_ROOT" not in execution.get("issuer_trust_root_status", ""):
        raise RuntimeError("successor profile issuer root stage drift")
    return raw, hashlib.sha256(raw).hexdigest(), git_blob_sha1(raw), tree_sha


def verify_exact_file(path: Path, *, size: int, sha256: str, blob: str) -> None:
    st = os.lstat(path)
    if not stat.S_ISREG(st.st_mode) or path.is_symlink():
        raise RuntimeError(f"exact file must be a non-symlink regular file: {path}")
    data = path.read_bytes()
    if len(data) != size or hashlib.sha256(data).hexdigest() != sha256 or git_blob_sha1(data) != blob:
        raise RuntimeError(f"exact file identity drift: {path}")


def windows_directory() -> str:
    if os.name != "nt":
        raise RuntimeError("M1-08 native owner build requires a Windows host")
    buf = ctypes.create_unicode_buffer(32768)
    n = ctypes.windll.kernel32.GetWindowsDirectoryW(buf, len(buf))
    if not n or n >= len(buf):
        raise RuntimeError("GetWindowsDirectoryW failed")
    return str(Path(buf.value).resolve())


def exact_build_env(temp_root: Path, goroot: Path) -> dict[str, str]:
    wd = windows_directory()
    cache = temp_root / "go-cache"
    modcache = temp_root / "go-mod-cache"
    gotmp = temp_root / "go-tmp"
    for p in (cache, modcache, gotmp):
        p.mkdir()
    # Construct from empty: no PATH, no GOFLAGS, no caller Go config.
    return {
        "SystemRoot": wd,
        "WINDIR": wd,
        "TEMP": str(gotmp),
        "TMP": str(gotmp),
        "COMSPEC": str(Path(wd) / "System32" / "cmd.exe"),
        "GOENV": "off",
        "GOFLAGS": "",
        "GOWORK": "off",
        "GOEXPERIMENT": "",
        "GOTOOLCHAIN": "local",
        "GOPROXY": "off",
        "GOSUMDB": "off",
        "CGO_ENABLED": "0",
        "GOOS": "windows",
        "GOARCH": "amd64",
        "GOAMD64": "v1",
        "GOCACHE": str(cache),
        "GOMODCACHE": str(modcache),
        "GOTMPDIR": str(gotmp),
        "GOROOT": str(goroot),
    }


def validate_toolchain_archive(path: Path) -> None:
    st = os.lstat(path)
    if path.name != TOOLCHAIN_ARCHIVE_NAME or not stat.S_ISREG(st.st_mode) or path.is_symlink():
        raise RuntimeError("toolchain archive identity/type drift")
    if st.st_size != TOOLCHAIN_ARCHIVE_BYTES or sha256_file(path) != TOOLCHAIN_ARCHIVE_SHA256:
        raise RuntimeError("toolchain archive digest/size drift")


def extract_exact_toolchain(archive: Path, destination: Path) -> tuple[Path, str, int]:
    expected: dict[str, tuple[int, str]] = {}
    with zipfile.ZipFile(archive, "r") as zf:
        seen: set[str] = set()
        for info in zf.infolist():
            name = info.filename
            if not name or "\\" in name:
                raise RuntimeError("toolchain archive path invalid")
            pp = PurePosixPath(name)
            if pp.is_absolute() or ".." in pp.parts or not pp.parts or pp.parts[0] != "go":
                raise RuntimeError("toolchain archive path escape")
            if name in seen:
                raise RuntimeError("toolchain archive duplicate entry")
            seen.add(name)
            unix_mode = (info.external_attr >> 16) & 0xFFFF
            if unix_mode and stat.S_ISLNK(unix_mode):
                raise RuntimeError("toolchain archive symlink forbidden")
            target = destination.joinpath(*pp.parts)
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
    for p in destination.rglob("*"):
        if p.is_symlink():
            raise RuntimeError("extracted toolchain symlink forbidden")
        if p.is_file():
            actual[p.relative_to(destination).as_posix()] = p
    if set(actual) != set(expected):
        raise RuntimeError("extracted toolchain file set drift")

    tree = hashlib.sha256()
    for name in sorted(expected):
        size, expected_sha = expected[name]
        p = actual[name]
        if p.stat().st_size != size or sha256_file(p) != expected_sha:
            raise RuntimeError("extracted toolchain file identity drift: " + name)
        tree.update((name + "\0" + str(size) + "\0" + expected_sha + "\n").encode())
    tree_sha = tree.hexdigest()
    if len(expected) != TOOLCHAIN_TREE_FILES or tree_sha != TOOLCHAIN_TREE_SHA256:
        raise RuntimeError("extracted toolchain tree identity drift")

    go = destination / "go/bin/go.exe"
    compile_exe = destination / "go/pkg/tool/windows_amd64/compile.exe"
    link_exe = destination / "go/pkg/tool/windows_amd64/link.exe"
    if sha256_file(go) != TOOLCHAIN_GO_EXE_SHA256:
        raise RuntimeError("go.exe identity drift")
    if sha256_file(compile_exe) != TOOLCHAIN_COMPILE_EXE_SHA256:
        raise RuntimeError("compile.exe identity drift")
    if sha256_file(link_exe) != TOOLCHAIN_LINK_EXE_SHA256:
        raise RuntimeError("link.exe identity drift")
    return go, tree_sha, len(expected)


def verify_source_manifest() -> tuple[dict, bytes, str]:
    raw = MANIFEST.read_bytes()
    manifest = json.loads(raw)
    if manifest.get("schema_version") != "clued.m1-08-native-owner-source-manifest/1":
        raise RuntimeError("source manifest schema drift")
    if manifest.get("implementation_base") != IMPLEMENTATION_BASE:
        raise RuntimeError("implementation base drift")
    if manifest.get("contract_git_blob_sha1") != CONTRACT_BLOB:
        raise RuntimeError("contract binding drift")
    if manifest.get("candidate_profile_git_blob_sha1") != BASE_CANDIDATE_BLOB:
        raise RuntimeError("candidate profile binding drift")
    if manifest.get("successor_profile_path") != SUCCESSOR_PROFILE_REPO_PATH:
        raise RuntimeError("successor profile path binding drift")
    if manifest.get("candidate_profile_binding_semantics") != "IMPLEMENTATION_BASE_CANDIDATE_ONLY / NOT_SUCCESSOR_QUALIFICATION_TARGET":
        raise RuntimeError("candidate profile binding semantics drift")

    rows = manifest.get("files")
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("source manifest file set missing")
    declared: set[str] = set()
    for row in rows:
        name = row.get("path")
        if not isinstance(name, str) or not name or name in declared or "/" in name or "\\" in name:
            raise RuntimeError(f"invalid manifest path: {name!r}")
        declared.add(name)
        p = HERE / name
        data = p.read_bytes()
        if (
            len(data) != row.get("bytes")
            or hashlib.sha256(data).hexdigest() != row.get("sha256")
            or git_blob_sha1(data) != row.get("git_blob_sha1")
        ):
            raise RuntimeError("source identity mismatch: " + name)
        if p.is_symlink() or not stat.S_ISREG(os.lstat(p).st_mode):
            raise RuntimeError("source must be a non-symlink regular file: " + name)

    actual = {p.name for p in HERE.iterdir() if p.name != "source-manifest.json"}
    if actual != declared:
        raise RuntimeError(f"source closure drift: extra={sorted(actual-declared)} missing={sorted(declared-actual)}")
    return manifest, raw, hashlib.sha256(raw).hexdigest()


def run_logged(argv: list[str], *, cwd: Path, env: dict[str, str], log: Path, timeout: int = 300) -> None:
    p = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
    log.write_text(p.stdout + p.stderr, encoding="utf-8")
    if p.returncode:
        raise RuntimeError(f"command failed ({p.returncode}); see {log.name}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--toolchain-archive", type=Path, required=True)
    ap.add_argument("--output", type=Path, required=True)
    args = ap.parse_args()

    archive = args.toolchain_archive.resolve(strict=True)
    # Reject lexical aliases and protected overlap BEFORE resolving or creating.
    output = Path(validate_output_path(str(args.output), str(ROOT)))

    validate_toolchain_archive(archive)
    verify_exact_file(CONTRACT, size=CONTRACT_BYTES, sha256=CONTRACT_SHA256, blob=CONTRACT_BLOB)
    verify_exact_file(BASE_CANDIDATE, size=BASE_CANDIDATE_BYTES, sha256=BASE_CANDIDATE_SHA256, blob=BASE_CANDIDATE_BLOB)
    manifest, manifest_raw, manifest_sha = verify_source_manifest()
    successor_raw, successor_sha, successor_blob, successor_tree = verify_successor_profile(manifest, manifest_raw, manifest_sha)

    # Owner-root-pinned successor qualification: the exact Owner-approved
    # public root MUST be pinned while effectful authority remains closed.
    if manifest.get("effectful_authority_issued") is not False:
        raise RuntimeError("owner-root successor unexpectedly issues effectful authority")
    if manifest.get("owner_binary_execution_authorized") is not False:
        raise RuntimeError("owner-root successor unexpectedly authorizes owner binary execution")
    issuer_root = manifest.get("issuer_root")
    if not isinstance(issuer_root, dict):
        raise RuntimeError("owner-root successor issuer binding missing")
    if (
        issuer_root.get("public_key_hex") != EXPECTED_ISSUER_PUBLIC_KEY_HEX
        or issuer_root.get("public_key_sha256_fingerprint") != EXPECTED_ISSUER_PUBLIC_KEY_SHA256
        or issuer_root.get("private_key_material_in_repository") is not False
    ):
        raise RuntimeError("owner-root successor issuer binding drift")
    bindings = (HERE / "bindings.go").read_text(encoding="utf-8")
    if (
        f'const issuerPublicKeyHex = "{EXPECTED_ISSUER_PUBLIC_KEY_HEX}"' not in bindings
        or f'const issuerPublicKeySHA256 = "{EXPECTED_ISSUER_PUBLIC_KEY_SHA256}"' not in bindings
    ):
        raise RuntimeError("owner-root successor compiled issuer binding drift")

    with QualificationScope(output, ROOT) as scope:
        with tempfile.TemporaryDirectory(prefix="m108-owner-build-", dir=scope.output) as td:
            temp_root = Path(td)
            toolchain_root = temp_root / "verified-toolchain"
            toolchain_root.mkdir()
            go, tree_sha, tree_count = extract_exact_toolchain(archive, toolchain_root)
            goroot = toolchain_root / "go"
            env = exact_build_env(temp_root, goroot)

            version = subprocess.check_output([str(go), "version"], env=env, text=True, timeout=30).strip()
            target = subprocess.check_output(
                [str(go), "env", "GOOS", "GOARCH", "GOAMD64", "GOROOT"],
                env=env, text=True, timeout=30,
            ).splitlines()
            if version != TOOLCHAIN_VERSION or target[:3] != ["windows", "amd64", "v1"]:
                raise RuntimeError("toolchain self-reported identity drift")
            if Path(target[3]).resolve() != goroot.resolve():
                raise RuntimeError("toolchain GOROOT drift")

            run_logged([str(go), "test", "-json", "-count=1", "./..."], cwd=HERE, env=env, log=output/"go-test.log")
            test_report = require_go_test_report((output/"go-test.log").read_text(encoding="utf-8"), (
                "TestRemediationFullLifecycleProductionFunctionsOnTinyFixture",
                "TestRemediationGuardFirstEffectRechecksExpiry",
                "TestRemediationCreatedGuardValidationFailureConsumesAndReports",
                "TestWindowsRemediationRetainedGuardParentAndRelativeCreate",
                "TestWindowsRemediationNativeFailureLeavesOldAndTemp",
                "TestWindowsRemediationNativeReplacementPreservesOldReader",
            ))
            run_logged([str(Path(sys.executable).resolve()), "-B", "-m", "unittest", "-v", "qualification_scope_test"],
                       cwd=HERE, env=env, log=output/"python-qualification-scope.log")
            run_logged([str(go), "vet", "./..."], cwd=HERE, env=env, log=output/"go-vet.log")

            test_binary = output / "m1-08-owner.tests.exe"
            run_logged(
                [str(go), "test", "-c", "-trimpath", "-o", str(test_binary)],
                cwd=HERE, env=env, log=output/"go-test-compile.log",
            )

            binary = output / "m1-08-owner.exe"
            ldflags = "-s -w -buildid= -X main.nativeSourceDigest=" + manifest_sha
            argv = [
                str(go), "build", "-trimpath", "-buildvcs=false", "-mod=readonly",
                "-ldflags=" + ldflags, "-o", str(binary), ".",
            ]
            run_logged(argv, cwd=HERE, env=env, log=output/"go-build.log")

        receipt = {
            "schema_version": "clued.m1-08-native-owner-build-receipt/1",
            "role": "OWNER_ROOT_PINNED_SUCCESSOR_BUILD / NO_EFFECTFUL_AUTHORITY / OWNER_BINARY_NOT_EXECUTED",
            "implementation_base": IMPLEMENTATION_BASE,
            "contract_git_blob_sha1": CONTRACT_BLOB,
            "candidate_profile_git_blob_sha1": successor_blob,
            "candidate_profile_raw_sha256": successor_sha,
            "candidate_profile_bytes": len(successor_raw),
            "base_candidate_profile_git_blob_sha1": BASE_CANDIDATE_BLOB,
            "qualified_successor_source_tree_git_sha1": successor_tree,
            "successor_profile_static_binding_check": True,
            "native_source_manifest_sha256": manifest_sha,
            "toolchain": {
                "archive_name": TOOLCHAIN_ARCHIVE_NAME,
                "archive_bytes": TOOLCHAIN_ARCHIVE_BYTES,
                "archive_sha256": TOOLCHAIN_ARCHIVE_SHA256,
                "tree_file_count": tree_count,
                "tree_sha256": tree_sha,
                "go_exe_sha256": TOOLCHAIN_GO_EXE_SHA256,
                "compile_exe_sha256": TOOLCHAIN_COMPILE_EXE_SHA256,
                "link_exe_sha256": TOOLCHAIN_LINK_EXE_SHA256,
                "version": version,
                "target": {"goos": target[0], "goarch": target[1], "goamd64": target[2]},
            },
            "tests": {
                "go_test_pass": True,
                "go_test_level_report": test_report,
                "qualification_scope_tests_pass": True,
                "go_vet_pass": True,
                "windows_test_binary_compiled": True,
                "test_scope": "TEST_BINARY_ONLY / TEST_OWNED_TEMP_PATHS / NO_REAL_MODEL",
            },
            "owner_binary": {
                "path": str(binary),
                "bytes": binary.stat().st_size,
                "sha256": sha256_file(binary),
                "executed_by_build_helper": False,
            },
            "windows_test_binary": {
                "path": str(test_binary),
                "bytes": test_binary.stat().st_size,
                "sha256": sha256_file(test_binary),
            },
            "issuer_root_bound": True,
            "issuer_public_key_sha256_fingerprint": EXPECTED_ISSUER_PUBLIC_KEY_SHA256,
            "effectful_authority_issued": False,
            "qualification_namespace": scope.evidence(),
            "production_effects_authorized": False,
            "production_host_observation": "NOT_PERFORMED / DO_NOT_INFER_FROM_BUILD_SUCCESS",
        }
        (output/"build-receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(json.dumps(receipt, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
