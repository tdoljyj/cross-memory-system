#!/usr/bin/env python3
"""Build the M1-08 native owner as a non-effectful implementation artifact."""
from __future__ import annotations

import argparse
import contextlib
import ntpath
import re
import ctypes
import hashlib
import json
import os
import stat
import sys
import subprocess
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
MANIFEST = HERE / "source-manifest.json"
CONTRACT = ROOT / "development/contracts/model-program/m1/governance/M1RuntimeLifecycleSmokeContract.v0.1.json"
CANDIDATE = ROOT / "development/contracts/model-program/m1/governance/ExperimentAuthorizationProfile.M1-LIFE-QWEN35-08B-PC-001.candidate.json"

IMPLEMENTATION_BASE = "3d8a4c88373f5a54831b40d34c0ad89281d02ac1"
CONTRACT_BLOB = "f422d4da73deb1cafb6c00468602c8309d896786"
CONTRACT_BYTES = 42486
CONTRACT_SHA256 = "b40040a1302620b965bdf6dbe2283d0d6d5f9413c8c784e4b65d9cd030ac7ee3"
CANDIDATE_BLOB = "51b0083f74dd12318b7cdcdf3b939d31723de787"
CANDIDATE_BYTES = 37761
CANDIDATE_SHA256 = "c0699d1364cf9bdad7c447edacb5e1702a69fdd893a4937269b55cf00d82ffd3"

TOOLCHAIN_ARCHIVE_NAME = "go1.27.1.windows-amd64.zip"
TOOLCHAIN_ARCHIVE_BYTES = 78931360
TOOLCHAIN_ARCHIVE_SHA256 = "a3911b5e0e1b1053f25ed0675f4c1c6aad1e2bfcf253df2b9be4caabd2edd95d"
TOOLCHAIN_TREE_FILES = 15639
TOOLCHAIN_TREE_SHA256 = "bf7939c5c947597c3a2bbf56b7ddf943fa06cd10cae421eadc01d44f18a5df79"
TOOLCHAIN_GO_EXE_SHA256 = "d3ccdb604eafa6031133aefe1a3db24f0bb7362b857bc2125ac4e4c178b4b490"
TOOLCHAIN_COMPILE_EXE_SHA256 = "69294d68bcaa3e786f80d23bfb8bed807d5d969e931d5bf92161bdf518778a01"
TOOLCHAIN_LINK_EXE_SHA256 = "9146582fd2b0a8cf765831e7ee3127603faaf51697531496584024db96414720"
TOOLCHAIN_VERSION = "go version go1.27.1 windows/amd64"


# Not a caller option. All build outputs AND temporary/cache paths are confined
# to this non-production validation namespace, disjoint from ModelProgram/M1.
QUALIFICATION_ROOT = Path(r"C:\Users\Public\Clued\Validation\M108-owner-qualification")


def qualification_output_name(value: str) -> str:
    """Pure lexical gate; reject before resolve(), mkdir() or any subprocess."""
    if not value or value.startswith(("\\\\", "//")):
        raise ValueError("qualification output cannot use UNC/device paths")
    drive, rest = ntpath.splitdrive(value)
    if ":" in rest or not drive or not rest.startswith(("\\", "/")):
        raise ValueError("qualification output must be an absolute normal drive path")
    parts = re.split(r"[\\/]", rest)
    if any(x in {".", ".."} or x.endswith((".", " ")) for x in parts if x):
        raise ValueError("qualification output has an unsafe component")
    parent, name = ntpath.split(ntpath.normpath(value))
    if ntpath.normcase(parent) != ntpath.normcase(str(QUALIFICATION_ROOT)):
        raise ValueError("output must be a direct child of the fixed qualification root")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}", name):
        raise ValueError("qualification output name invalid")
    if name.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(10)), *(f"LPT{i}" for i in range(10))}:
        raise ValueError("reserved device name")
    return name


@contextlib.contextmanager
def pinned_qualification_output(output: Path):
    """Pin all existing ancestors, reject reparse components before writes.

    Existing directories cannot be renamed/deleted while their handles remain
    held. No production directory is created, and no caller temp is inherited.
    """
    qualification_output_name(str(output))
    if os.name != "nt":
        raise RuntimeError("Windows qualification host required")
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
    k.CreateFileW.restype = ctypes.c_void_p
    k.CloseHandle.argtypes = [ctypes.c_void_p]
    k.GetFinalPathNameByHandleW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32]
    k.GetFileInformationByHandleEx.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    handles = []
    def pin(path: Path) -> None:
        h = k.CreateFileW(str(path), 0x80, 3, None, 3, 0x02000000 | 0x00200000, None)
        if h == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        handles.append(h)
        attrs = (ctypes.c_uint32 * 2)()
        if not k.GetFileInformationByHandleEx(h, 9, ctypes.byref(attrs), ctypes.sizeof(attrs)):
            raise ctypes.WinError(ctypes.get_last_error())
        if attrs[0] & 0x400 or not attrs[0] & 0x10:
            raise RuntimeError("qualification ancestor is reparse or non-directory")
        buf = ctypes.create_unicode_buffer(32768)
        n = k.GetFinalPathNameByHandleW(h, buf, len(buf), 0)
        if not n or n >= len(buf):
            raise RuntimeError("qualification final path unavailable")
        actual = buf.value
        if actual.startswith("\\\\?\\"):
            actual = actual[4:]
        if ntpath.normcase(actual) != ntpath.normcase(str(path)):
            raise RuntimeError("qualification handle/path mismatch")
    try:
        # Validation itself must already exist. Do not bootstrap arbitrary roots.
        for path in reversed(QUALIFICATION_ROOT.parent.parents):
            pin(path)
        pin(QUALIFICATION_ROOT.parent)
        if not QUALIFICATION_ROOT.exists():
            QUALIFICATION_ROOT.mkdir(exist_ok=False)
        pin(QUALIFICATION_ROOT)
        if output.exists():
            raise RuntimeError("qualification output must be new")
        output.mkdir(exist_ok=False)
        pin(output)
        yield output
    finally:
        for h in reversed(handles):
            k.CloseHandle(h)


def summarize_test_events(path: Path) -> dict:
    started, passed, skipped, failed = set(), set(), set(), set()
    for line in path.read_text(encoding="utf-8").splitlines():
        row = json.loads(line)
        name = row.get("Test")
        if not name:
            continue
        action = row.get("Action")
        if action == "run": started.add(name)
        elif action == "pass": passed.add(name)
        elif action == "skip": skipped.add(name)
        elif action == "fail": failed.add(name)
    if not started or skipped or failed or started != passed:
        raise RuntimeError(f"incomplete qualification tests: skipped={sorted(skipped)} failed={sorted(failed)} unfinished={sorted(started-passed)}")
    return {"root_tests": sum("/" not in n for n in started), "all_test_cases": len(started), "passed": len(passed), "skipped": 0, "failed": 0}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def git_blob_sha1(data: bytes) -> str:
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()


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
    if manifest.get("candidate_profile_git_blob_sha1") != CANDIDATE_BLOB:
        raise RuntimeError("candidate profile binding drift")

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
    p = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True, encoding="utf-8", errors="strict", timeout=timeout)
    log.write_text(p.stdout + p.stderr, encoding="utf-8")
    if p.returncode:
        raise RuntimeError(f"command failed ({p.returncode}); see {log.name}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--toolchain-archive", type=Path, required=True)
    ap.add_argument("--output", type=Path, required=True)
    args = ap.parse_args()

    archive = args.toolchain_archive.resolve(strict=True)
    try:
        name = qualification_output_name(str(args.output))
    except ValueError as exc:
        ap.error(str(exc))
    output = QUALIFICATION_ROOT / name
    if output.is_relative_to(ROOT) or ROOT.is_relative_to(output):
        ap.error("qualification output cannot overlap the repository")
    if output.exists():
        ap.error("output must be a new directory")

    validate_toolchain_archive(archive)
    verify_exact_file(CONTRACT, size=CONTRACT_BYTES, sha256=CONTRACT_SHA256, blob=CONTRACT_BLOB)
    verify_exact_file(CANDIDATE, size=CANDIDATE_BYTES, sha256=CANDIDATE_SHA256, blob=CANDIDATE_BLOB)
    manifest, manifest_raw, manifest_sha = verify_source_manifest()

    # The implementation-preparation candidate MUST remain unissued and
    # intentionally unbound to an Owner root.
    bindings = (HERE / "bindings.go").read_text(encoding="utf-8")
    if 'const issuerPublicKeyHex = ""' not in bindings or 'const issuerPublicKeySHA256 = ""' not in bindings:
        raise RuntimeError("implementation preparation unexpectedly binds an issuer root")

    with pinned_qualification_output(output):
        with tempfile.TemporaryDirectory(prefix="m108-owner-build-", dir=output) as td:
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
            test_summary = summarize_test_events(output/"go-test.log")
            run_logged([sys.executable, "-I", "-B", str(HERE/"test_build.py"), "-v"], cwd=HERE, env=env, log=output/"python-build-boundary-tests.log")
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

        final_manifest, final_raw, final_sha = verify_source_manifest()
        if final_raw != manifest_raw or final_sha != manifest_sha:
            raise RuntimeError("source/manifest changed during build")
        receipt = {
            "schema_version": "clued.m1-08-native-owner-build-receipt/1",
            "role": "IMPLEMENTATION_PREPARATION_BUILD / NO_EFFECTFUL_AUTHORITY / OWNER_BINARY_NOT_EXECUTED",
            "implementation_base": IMPLEMENTATION_BASE,
            "contract_git_blob_sha1": CONTRACT_BLOB,
            "candidate_profile_git_blob_sha1": CANDIDATE_BLOB,
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
                "go_vet_pass": True,
                "python_build_boundary_tests_pass": True,
                "windows_test_binary_compiled": True,
                "tests_use_production_guard_or_test_root": False,
                "observed_test_events": test_summary,
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
            "issuer_root_bound": False,
            "effectful_authority_issued": False,
            "filesystem_boundary": {
                "fixed_qualification_root": str(QUALIFICATION_ROOT),
                "validated_output": str(output),
                "temporary_files_inside_output": True,
                "production_path_effect_claim": "NO_OWNER_BINARY_EXECUTED; NO_PRODUCTION_ROOT_PASSED_TO_BUILD_OR_TESTS; NOT_A_LIVE_RUNTIME_ATTESTATION",
            },
        }
        (output/"build-receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(json.dumps(receipt, sort_keys=True))
        return 0

if __name__ == "__main__":
    raise SystemExit(main())
