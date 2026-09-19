"""Test-only bridge to compiled native mocks. Never linked into production.
No auto-install, no skip on missing Go, no model/server execution. All build
outputs and caches live outside the source tree. Production binaries are run
only for candidate/unbound-issuer rejection. Legacy names map to native tests.
"""
import atexit
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "scripts/model-program/m1-runtime-owner"
TEMP = tempfile.TemporaryDirectory(prefix="clued-m107-native-tests-")
atexit.register(TEMP.cleanup)
CACHE = Path(TEMP.name)
GO = os.environ.get("CLUED_M107_GO") or shutil.which("go")
TEST_BINARY = CACHE / ("owner.test.exe" if os.name == "nt" else "owner.test")
OWNER_BINARY = CACHE / ("owner.exe" if os.name == "nt" else "owner")

SAFE_HOST_ENV = {"SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATH", "PATHEXT", "USERPROFILE"}

def _env():
    if os.environ.get("GOFLAGS"):
        raise AssertionError("forbidden inherited Go build environment: GOFLAGS")
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
        GOCACHE=os.environ.get("CLUED_M107_GOCACHE", str(CACHE / "go-cache")),
    )
    return env

def _capture(argv, name, timeout=180):
    p = subprocess.run(argv, cwd=SOURCE, env=_env(), capture_output=True, text=True, timeout=timeout)
    text = p.stdout + p.stderr
    directory = os.environ.get("CLUED_M107_TEST_LOG_DIR")
    if directory:
        out = Path(directory)
        if out.resolve().is_relative_to(ROOT.resolve()):
            raise AssertionError("test logs must be outside repository")
        out.mkdir(parents=True, exist_ok=True)
        (out / (name + ".log")).write_text(text, encoding="utf-8")
    if p.returncode:
        raise AssertionError(f"{name}: exit={p.returncode}\n{text}")
    return text

def _require_go():
    if not GO:
        raise AssertionError("Native lifecycle assertions require Go >=1.23; set CLUED_M107_GO. Never skip them.")

def native_case(name=None):
    _require_go()
    if not TEST_BINARY.exists():
        _capture([GO, "test", "-c", "-trimpath", "-buildvcs=false", "-o", str(TEST_BINARY), "."], "native-test-build")
    selector = "^TestLegacy$/^" + name + "$" if name else "."
    out = _capture([str(TEST_BINARY), "-test.v", "-test.count=1", "-test.run=" + selector], name or "native-full")
    required = "--- PASS: TestLegacy/" + name if name else "--- PASS: TestNativeBoundary/mock_only_complete_fixed_sequence"
    if required not in out or "PASS" not in out:
        raise AssertionError("native test did not execute expected assertions: " + out)
    return out

def native_binary():
    _require_go()
    if not OWNER_BINARY.exists():
        manifest = SOURCE / "source-manifest.json"
        digest = hashlib.sha256(manifest.read_bytes()).hexdigest()
        _capture([GO, "build", "-trimpath", "-buildvcs=false", "-ldflags=-X main.nativeSourceDigest=" + digest, "-o", str(OWNER_BINARY), "."], "native-owner-build")
    return OWNER_BINARY
