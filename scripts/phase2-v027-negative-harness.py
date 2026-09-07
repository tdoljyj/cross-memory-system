#!/usr/bin/env python3
"""Create one isolated Phase2 v0.2.7 negative fixture and prove the target gate fails.

The base candidate is never modified. The mutated ZIP lives only in a temporary
working directory and is not a release candidate. The durable outputs are a gate
receipt and a small fixture manifest.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

CASES = (
    "candidate_identity",
    "manifest_integrity",
    "provenance",
    "product_increment_input",
)
GATE_ORDER = (
    "candidate_identity",
    "manifest_integrity",
    "provenance",
    "product_increment_input",
)
EXPECTED_STATUS = {
    "candidate_identity": {
        "candidate_identity": "FAIL",
        "manifest_integrity": "SKIPPED",
        "provenance": "SKIPPED",
        "product_increment_input": "SKIPPED",
    },
    "manifest_integrity": {
        "candidate_identity": "PASS",
        "manifest_integrity": "FAIL",
        "provenance": "PASS",
        "product_increment_input": "PASS",
    },
    "provenance": {
        "candidate_identity": "PASS",
        "manifest_integrity": "PASS",
        "provenance": "FAIL",
        "product_increment_input": "PASS",
    },
    "product_increment_input": {
        "candidate_identity": "PASS",
        "manifest_integrity": "PASS",
        "provenance": "PASS",
        "product_increment_input": "FAIL",
    },
}


class HarnessError(RuntimeError):
    pass


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as stream:
        value = json.load(stream, object_pairs_hook=OrderedDict)
    if not isinstance(value, dict):
        raise HarnessError(f"expected JSON object: {path}")
    return value


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(json_bytes(value))
    os.replace(temporary, path)


def flip_hex_digest(value: str) -> str:
    if len(value) != 64 or any(ch not in "0123456789abcdef" for ch in value):
        raise HarnessError("expected lowercase SHA-256 before mutation")
    replacement = "1" if value[0] != "1" else "0"
    return replacement + value[1:]


def parse_root(archive: zipfile.ZipFile, expected_root: str | None) -> str:
    roots: set[str] = set()
    for info in archive.infolist():
        if info.is_dir():
            continue
        parts = PurePosixPath(info.filename).parts
        if len(parts) < 2:
            raise HarnessError(f"archive member outside root: {info.filename}")
        roots.add(parts[0])
    if len(roots) != 1:
        raise HarnessError(f"expected one archive root, found {sorted(roots)}")
    root = next(iter(roots)) + "/"
    if expected_root is not None and root != expected_root:
        raise HarnessError(f"root mismatch: actual={root!r} expected={expected_root!r}")
    return root


def parse_sums(data: bytes) -> tuple[list[str], OrderedDict[str, str]]:
    try:
        lines = data.decode("utf-8").splitlines()
    except UnicodeDecodeError as exc:
        raise HarnessError(f"SHA256SUMS.txt is not UTF-8: {exc}") from exc
    order: list[str] = []
    mapping: OrderedDict[str, str] = OrderedDict()
    for number, line in enumerate(lines, 1):
        if not line:
            continue
        if "  " not in line:
            raise HarnessError(f"malformed SHA256SUMS.txt line {number}")
        digest, relative_path = line.split("  ", 1)
        if relative_path in mapping:
            raise HarnessError(f"duplicate SHA256SUMS path: {relative_path}")
        order.append(relative_path)
        mapping[relative_path] = digest
    return order, mapping


def render_sums(order: list[str], mapping: OrderedDict[str, str]) -> bytes:
    if set(order) != set(mapping):
        raise HarnessError("SHA256SUMS ordering and mapping diverged")
    return ("\n".join(f"{mapping[path]}  {path}" for path in order) + "\n").encode("utf-8")


def replace_manifest_entry(manifest: dict[str, Any], relative_path: str, data: bytes) -> None:
    entries = manifest.get("files")
    if not isinstance(entries, list):
        raise HarnessError("PACK_MANIFEST.json.files is not a list")
    matches = [entry for entry in entries if isinstance(entry, dict) and entry.get("path") == relative_path]
    if len(matches) != 1:
        raise HarnessError(f"manifest path {relative_path!r} resolved {len(matches)} times")
    matches[0]["bytes"] = len(data)
    matches[0]["sha256"] = sha256_bytes(data)


def rebaseline_integrity(
    archive: zipfile.ZipFile,
    root: str,
    replacements: dict[str, bytes],
    changed_relative_path: str,
) -> None:
    manifest_member = root + "PACK_MANIFEST.json"
    sums_member = root + "SHA256SUMS.txt"
    manifest = json.loads(archive.read(manifest_member).decode("utf-8"), object_pairs_hook=OrderedDict)
    if not isinstance(manifest, dict):
        raise HarnessError("PACK_MANIFEST.json is not an object")
    changed_member = root + changed_relative_path
    changed_data = replacements[changed_member]
    replace_manifest_entry(manifest, changed_relative_path, changed_data)
    manifest_data = json_bytes(manifest)
    replacements[manifest_member] = manifest_data

    order, sums = parse_sums(archive.read(sums_member))
    if changed_relative_path not in sums or "PACK_MANIFEST.json" not in sums:
        raise HarnessError("required checksum entries are missing")
    sums[changed_relative_path] = sha256_bytes(changed_data)
    sums["PACK_MANIFEST.json"] = sha256_bytes(manifest_data)
    replacements[sums_member] = render_sums(order, sums)


def copy_zip_with_replacements(
    source: Path,
    destination: Path,
    replacements: dict[str, bytes],
) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source, "r") as archive_in, zipfile.ZipFile(
        destination, "w", allowZip64=True
    ) as archive_out:
        source_names = [info.filename for info in archive_in.infolist()]
        unknown = sorted(set(replacements) - set(source_names))
        if unknown:
            raise HarnessError(f"replacement members do not exist: {unknown}")
        for info in archive_in.infolist():
            target_info = copy.copy(info)
            if info.filename in replacements:
                archive_out.writestr(target_info, replacements[info.filename])
                continue
            if info.is_dir():
                archive_out.writestr(target_info, b"")
                continue
            with archive_in.open(info, "r") as source_stream, archive_out.open(
                target_info, "w", force_zip64=True
            ) as destination_stream:
                shutil.copyfileobj(source_stream, destination_stream, 1 << 20)


def generated_identity(base_identity: dict[str, Any], fixture: Path, case: str) -> dict[str, Any]:
    value = copy.deepcopy(base_identity)
    with zipfile.ZipFile(fixture, "r") as archive:
        members = len(archive.infolist())
    value["bytes"] = fixture.stat().st_size
    value["members"] = members
    value["sha256"] = sha256_file(fixture)
    value["test_fixture"] = True
    value["authority_effect"] = "NONE"
    value["not_a_release_candidate"] = True
    value["negative_case"] = case
    return value


def build_fixture(
    base_candidate: Path,
    base_identity_path: Path,
    case: str,
    work_directory: Path,
) -> tuple[Path, Path, dict[str, Any]]:
    base_identity = load_json(base_identity_path)
    expected_name = base_identity.get("candidate")
    if expected_name != base_candidate.name:
        raise HarnessError(
            f"base candidate filename mismatch: actual={base_candidate.name!r} expected={expected_name!r}"
        )
    fixture = work_directory / base_candidate.name
    identity = work_directory / "candidate-identity.negative.json"
    mutation: dict[str, Any] = {
        "case": case,
        "integrity_metadata_rebaselined": False,
    }

    if case == "candidate_identity":
        shutil.copy2(base_candidate, fixture)
        with fixture.open("ab") as stream:
            stream.write(b"\nCLUED_NEGATIVE_GATE_01\n")
        shutil.copy2(base_identity_path, identity)
        mutation.update(
            {
                "target": "outer_candidate_bytes",
                "description": "append deterministic bytes while retaining the original identity record",
            }
        )
        return fixture, identity, mutation

    replacements: dict[str, bytes] = {}
    with zipfile.ZipFile(base_candidate, "r") as archive:
        root = parse_root(archive, base_identity.get("root_prefix"))
        manifest_member = root + "PACK_MANIFEST.json"

        if case == "manifest_integrity":
            manifest = json.loads(
                archive.read(manifest_member).decode("utf-8"), object_pairs_hook=OrderedDict
            )
            entries = manifest.get("files") if isinstance(manifest, dict) else None
            if not isinstance(entries, list) or not entries:
                raise HarnessError("PACK_MANIFEST.json.files is unavailable")
            removed = entries.pop(0)
            replacements[manifest_member] = json_bytes(manifest)
            mutation.update(
                {
                    "target": "PACK_MANIFEST.json",
                    "description": "remove one payload entry without updating SHA256SUMS",
                    "removed_manifest_path": removed.get("path") if isinstance(removed, dict) else None,
                }
            )

        elif case == "provenance":
            relative = "data/PredecessorPackageBinding.json"
            member = root + relative
            value = json.loads(archive.read(member).decode("utf-8"), object_pairs_hook=OrderedDict)
            predecessor = value.get("sole_direct_predecessor") if isinstance(value, dict) else None
            if not isinstance(predecessor, dict) or not isinstance(predecessor.get("sha256"), str):
                raise HarnessError("sole_direct_predecessor.sha256 is unavailable")
            old_digest = predecessor["sha256"]
            predecessor["sha256"] = flip_hex_digest(old_digest)
            replacements[member] = json_bytes(value)
            rebaseline_integrity(archive, root, replacements, relative)
            mutation.update(
                {
                    "target": relative,
                    "description": "change only the direct predecessor digest, then rebaseline root integrity metadata",
                    "old_digest": old_digest,
                    "new_digest": predecessor["sha256"],
                    "integrity_metadata_rebaselined": True,
                }
            )

        elif case == "product_increment_input":
            relative = "data/ProductIncrementIntake.json"
            member = root + relative
            value = json.loads(archive.read(member).decode("utf-8"), object_pairs_hook=OrderedDict)
            old_count = value.get("requirements") if isinstance(value, dict) else None
            if not isinstance(old_count, int) or isinstance(old_count, bool):
                raise HarnessError("ProductIncrementIntake.requirements is unavailable")
            value["requirements"] = old_count + 1
            replacements[member] = json_bytes(value)
            rebaseline_integrity(archive, root, replacements, relative)
            mutation.update(
                {
                    "target": relative,
                    "description": "increase the declared requirement count, then rebaseline root integrity metadata",
                    "old_requirements": old_count,
                    "new_requirements": old_count + 1,
                    "integrity_metadata_rebaselined": True,
                }
            )
        else:
            raise HarnessError(f"unsupported negative case: {case}")

    copy_zip_with_replacements(base_candidate, fixture, replacements)
    write_json(identity, generated_identity(base_identity, fixture, case))
    return fixture, identity, mutation


def read_gate_statuses(receipt_path: Path) -> dict[str, str | None]:
    receipt = load_json(receipt_path)
    gates = receipt.get("gates")
    if not isinstance(gates, dict):
        raise HarnessError("validator receipt has no gates object")
    return {
        gate: gates.get(gate, {}).get("status") if isinstance(gates.get(gate), dict) else None
        for gate in GATE_ORDER
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--identity", required=True, type=Path)
    parser.add_argument("--validator", required=True, type=Path)
    parser.add_argument("--case", required=True, choices=CASES)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--fixture-manifest", required=True, type=Path)
    parser.add_argument("--work-dir", type=Path)
    args = parser.parse_args()

    started = now()
    base_sha_before = sha256_file(args.candidate)
    base_size_before = args.candidate.stat().st_size
    harness_sha = sha256_file(Path(__file__))
    validator_sha = sha256_file(args.validator)
    manifest: dict[str, Any] = {
        "schema": "clued.phase2-v027-negative-fixture-manifest/v1",
        "generated_at_utc": started,
        "test_fixture": True,
        "authority_effect": "NONE",
        "not_a_release_candidate": True,
        "negative_case": args.case,
        "expected_gate_statuses": EXPECTED_STATUS[args.case],
        "repository": os.getenv("GITHUB_REPOSITORY"),
        "commit_sha": os.getenv("GITHUB_SHA"),
        "workflow": os.getenv("GITHUB_WORKFLOW"),
        "workflow_ref": os.getenv("GITHUB_WORKFLOW_REF"),
        "run_id": os.getenv("GITHUB_RUN_ID"),
        "run_attempt": os.getenv("GITHUB_RUN_ATTEMPT"),
        "implementation": {
            "harness_path": str(Path(__file__)),
            "harness_sha256": harness_sha,
            "validator_path": str(args.validator),
            "validator_sha256": validator_sha,
        },
        "base_candidate": {
            "filename": args.candidate.name,
            "bytes": base_size_before,
            "sha256_before": base_sha_before,
        },
        "expected_behavior_confirmed": False,
    }

    owned_temporary: tempfile.TemporaryDirectory[str] | None = None
    try:
        if args.work_dir is None:
            owned_temporary = tempfile.TemporaryDirectory(prefix="phase2-v027-negative-")
            work_directory = Path(owned_temporary.name)
        else:
            work_directory = args.work_dir
            if work_directory.exists():
                shutil.rmtree(work_directory)
            work_directory.mkdir(parents=True)

        fixture, fixture_identity, mutation = build_fixture(
            args.candidate, args.identity, args.case, work_directory
        )
        manifest["mutation"] = mutation
        with zipfile.ZipFile(fixture, "r") as archive:
            fixture_members = len(archive.infolist())
        manifest["mutated_fixture"] = {
            "filename": fixture.name,
            "bytes": fixture.stat().st_size,
            "members": fixture_members,
            "sha256": sha256_file(fixture),
            "identity_sha256": sha256_file(fixture_identity),
            "retained_after_run": False,
        }

        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        command = [
            sys.executable,
            str(args.validator),
            "--candidate",
            str(fixture),
            "--identity",
            str(fixture_identity),
            "--receipt",
            str(args.receipt),
        ]
        print(f"negative case: {args.case}")
        print(f"base candidate sha256: {base_sha_before}")
        print(f"mutated fixture sha256: {manifest['mutated_fixture']['sha256']}")
        completed = subprocess.run(command, check=False)
        actual_statuses = read_gate_statuses(args.receipt)
        base_sha_after = sha256_file(args.candidate)
        base_size_after = args.candidate.stat().st_size
        manifest["validator_exit_code"] = completed.returncode
        manifest["actual_gate_statuses"] = actual_statuses
        manifest["base_candidate"]["bytes_after"] = base_size_after
        manifest["base_candidate"]["sha256_after"] = base_sha_after
        manifest["base_candidate"]["unchanged"] = (
            base_sha_before == base_sha_after and base_size_before == base_size_after
        )
        manifest["expected_behavior_confirmed"] = (
            completed.returncode == 1
            and actual_statuses == EXPECTED_STATUS[args.case]
            and manifest["base_candidate"]["unchanged"] is True
        )
        if not manifest["expected_behavior_confirmed"]:
            manifest["harness_error"] = (
                "negative fixture did not produce the exact expected gate status map, "
                "validator exit code, and base-candidate immutability result"
            )
    except Exception as exc:
        manifest["harness_error"] = f"{type(exc).__name__}: {exc}"
        manifest["expected_behavior_confirmed"] = False
    finally:
        manifest["completed_at_utc"] = now()
        manifest["intentional_job_exit_code"] = (
            1 if manifest.get("expected_behavior_confirmed") else 2
        )
        write_json(args.fixture_manifest, manifest)
        if owned_temporary is not None:
            owned_temporary.cleanup()

    if manifest.get("expected_behavior_confirmed"):
        print(
            f"expected {args.case} failure confirmed; exiting 1 intentionally so GitHub Actions is red",
            file=sys.stderr,
        )
        return 1
    print("negative harness failed to prove the exact target-gate behavior", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
