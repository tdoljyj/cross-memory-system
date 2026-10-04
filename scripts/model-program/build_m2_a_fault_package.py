"""Deterministic companion archive; its SHA requires separate Owner approval."""
import argparse
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SOURCES = {
    "fault_fixture.py": "kernel/host/m2-restricted-entry-a-fault-fixture.py",
    "fault_observer.py": "kernel/host/m2-restricted-entry-a-fault-observer.py",
    "management.py": "kernel/host/m2-restricted-entry-a-fault-management.py",
    "fault_bridge.py": "kernel/host/m2-restricted-entry-a-fault-bridge.py",
    "host-helper.ps1": "kernel/host/m2-restricted-entry-a-fault-host.ps1",
    "fault-installer.py": "scripts/model-program/install_m2_a_fault_package.py",
    "fault-plan.json": "development/contracts/model-program/m2/AFaultInstall.candidate.json",
}


def archive_bytes(content):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, data in sorted(content.items()):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100444 << 16
            archive.writestr(info, data)
    return stream.getvalue()


def build(destination):
    # Reproduce the original builder's exact output without a second staging file.
    spec = importlib.util.spec_from_file_location("base_a_builder", ROOT / "scripts/model-program/build_m2_a_executor_package.py")
    base = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(base)
    original = {name: (ROOT / source).read_bytes().replace(b"\r\n", b"\n") for name, source in base.SOURCES.items()}
    base_manifest = {"schema": "m2-a-package-v1", "files": {name: hashlib.sha256(data).hexdigest() for name, data in sorted(original.items())}}
    original["manifest.json"] = (json.dumps(base_manifest, sort_keys=True, indent=2) + "\n").encode("ascii")
    content = {name: (ROOT / source).read_bytes().replace(b"\r\n", b"\n") for name, source in SOURCES.items()}
    content["base-a.zip"] = archive_bytes(original)
    manifest = {"schema": "m2-a-fault-package-v1", "files": {name: hashlib.sha256(data).hexdigest() for name, data in sorted(content.items())}}
    content["manifest.json"] = (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode("ascii")
    raw = archive_bytes(content)
    Path(destination).write_bytes(raw)
    digest = hashlib.sha256(raw).hexdigest()
    Path(str(destination) + ".sha256").write_text(digest + "  " + Path(destination).name + "\n", encoding="ascii")
    return digest


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    print(build(parser.parse_args().output))
