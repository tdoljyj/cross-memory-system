"""Build a deterministic host-only candidate; never extract or execute runtime.

This hashes a source independently verified by the source-verifier receipt. Hash
matching here is not a signature-verification operation or installation approval.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import stat
import zipfile

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = ROOT / "development/contracts/model-program/m2/AFaultRuntime.candidate.json"
CONTRACT_SHA256 = "b0c7af17da24f5384e754118edd5d4afa227ca7309b16c07e67148fda90e8bfa"
ARCHIVE = "python-3.14.8-embed-amd64.zip"
SOURCE_SHA256 = "a93abe456ab01bd96d7a085b3cdb6566b3063f4241360d114142fbdb07f0a310"
SOURCE_SIZE = 12601679
RUNTIME_DIRECTORY = "python-3.14.8-amd64"
MAX_ARCHIVE = 16 * 1024 * 1024
MAX_MEMBER = 8 * 1024 * 1024
MAX_TOTAL = 32 * 1024 * 1024


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def unique(items):
    value = {}
    for key, item in items:
        if key in value:
            raise ValueError("DUPLICATE_JSON_KEY")
        value[key] = item
    return value


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")


def load_contract():
    raw = CONTRACT.read_bytes()
    if sha(raw) != CONTRACT_SHA256:
        raise ValueError("RUNTIME_CONTRACT_CHANGED")
    contract = json.loads(raw, object_pairs_hook=unique)
    if (contract["schema"] != "m2-a-fault-runtime-contract-v1" or
            contract["archive"] != ARCHIVE or contract["archive_sha256"] != SOURCE_SHA256 or
            contract["archive_size"] != SOURCE_SIZE or contract["runtime_directory"] != RUNTIME_DIRECTORY or
            contract["qualification"] != "NOT_ISSUED" or len(contract["files"]) != 37):
        raise ValueError("RUNTIME_CONTRACT_INVALID")
    return contract


def validate_archive(raw, files, expected_sha256, expected_size):
    """Finite validator seam for public test archives; CLI pins cannot override."""
    if (len(raw) > MAX_ARCHIVE or len(raw) != expected_size or sha(raw) != expected_sha256 or
            not isinstance(files, dict) or not files):
        raise ValueError("RUNTIME_SOURCE_MISMATCH")
    if any(not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", name) or name in (".", "..") or
           not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest) for name, digest in files.items()):
        raise ValueError("RUNTIME_FILE_PIN_INVALID")
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        infos = archive.infolist()
        if len(infos) != len(files) or {i.filename for i in infos} != set(files) or sum(i.file_size for i in infos) > MAX_TOTAL:
            raise ValueError("RUNTIME_ARCHIVE_SHAPE_INVALID")
        for info in infos:
            mode = info.external_attr >> 16
            if (info.is_dir() or info.flag_bits & 1 or info.external_attr & 0x10 or
                    not stat.S_ISREG(mode) or info.file_size > MAX_MEMBER or
                    info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)):
                raise ValueError("RUNTIME_MEMBER_INVALID")
            if sha(archive.read(info)) != files[info.filename]:
                raise ValueError("RUNTIME_MEMBER_HASH_MISMATCH")
    return {"schema": "m2-a-fault-runtime-v1", "archive_sha256": expected_sha256,
            "runtime_directory": RUNTIME_DIRECTORY, "files": dict(files)}


def package_bytes(raw, manifest):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, data in sorted({ARCHIVE: raw, "runtime-manifest.json": encoded(manifest)}.items()):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100444 << 16
            archive.writestr(info, data)
    return stream.getvalue()


def build(source, destination):
    contract = load_contract()
    # One bounded immutable source snapshot. Nothing is extracted or launched.
    with Path(source).open("rb") as stream:
        raw = stream.read(MAX_ARCHIVE + 1)
    manifest = validate_archive(raw, contract["files"], SOURCE_SHA256, SOURCE_SIZE)
    output = package_bytes(raw, manifest)
    destination = Path(destination)
    sidecar = Path(str(destination) + ".sha256")
    if destination.exists() or destination.is_symlink() or sidecar.exists() or sidecar.is_symlink():
        raise ValueError("RUNTIME_OUTPUT_COLLISION")
    digest = sha(output)
    with destination.open("xb") as stream:
        stream.write(output)
    with sidecar.open("x", encoding="ascii", newline="\n") as stream:
        stream.write(digest + "  " + destination.name + "\n")
    return digest


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    print(build(args.source, args.output))


if __name__ == "__main__":
    main()
