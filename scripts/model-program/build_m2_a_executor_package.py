"""Deterministic, uninstalled A-only package. No VM/registry/permission changes."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SOURCES = {
    "boundary.py": "kernel/host/m2-restricted-entry-python-candidate.py",
    "executor.py": "kernel/host/m2-restricted-entry-a-executor.py",
    "empty_probe.py": "kernel/host/m2-restricted-entry-a-empty-probe.py",
    "bridge.py": "kernel/host/m2-restricted-entry-a-bridge.py",
    "installer.py": "scripts/model-program/install_m2_a_executor.py",
    "install-plan.json": "development/contracts/model-program/m2/AExecutorInstall.candidate.json",
}


def build(destination):
    content = {name: (ROOT / source).read_bytes().replace(b"\r\n", b"\n") for name, source in SOURCES.items()}
    manifest = {"schema": "m2-a-package-v1", "files": {name: hashlib.sha256(data).hexdigest() for name, data in sorted(content.items())}}
    content["manifest.json"] = (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode("ascii")
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, data in sorted(content.items()):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100444 << 16
            archive.writestr(info, data)
    digest = hashlib.sha256(Path(destination).read_bytes()).hexdigest()
    Path(str(destination) + ".sha256").write_text(digest + "  " + Path(destination).name + "\n", encoding="ascii")
    return digest


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(build(args.output))
