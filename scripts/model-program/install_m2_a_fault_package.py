"""Fail-closed guest companion installer. No transport, host or service actions.

The separately approved companion contains the unchanged original A package.
Partial failures are retained for inspection, never retried or overwritten.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import types
import zipfile

CODE = Path("/usr/local/lib/clued-m2-a-fault-fixture")
CONFIG = Path("/etc/clued-m2-a-fault")
LOG = Path("/var/log/clued-m2-a-fault")
VM_ID = "9d775385-4546-4450-a77f-08cdf4f696b6"
INSTANCE = "m2-a-public-empty-20261003"
REQUEST_IDS = {case: "m2-fault-20261004-" + case + "-01" for case in ("timeout", "revoke", "disconnect")}
INSTALLED = ("fault_fixture.py", "fault_observer.py", "management.py", "base_installer.py")
FILES = {"base-a.zip", "fault_fixture.py", "fault_observer.py", "management.py", "fault_bridge.py", "host-helper.ps1", "fault-installer.py", "fault-plan.json"}
BOUND = 2097152


def pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("DUPLICATE_KEY")
        result[key] = value
    return result


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


class SnapshotPackage:
    def __init__(self, raw):
        self.raw = raw

    def open(self, mode):
        if mode != "rb":
            raise ValueError("READ_ONLY_SNAPSHOT")
        return io.BytesIO(self.raw)


def unpack(raw, expected, files, schema, bound):
    if len(raw) > bound or not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected) or sha(raw) != expected:
        raise ValueError("PACKAGE_HASH_MISMATCH")
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        infos = archive.infolist()
        if len(infos) != len(files) + 1 or {item.filename for item in infos} != files | {"manifest.json"} or sum(item.file_size for item in infos) > bound:
            raise ValueError("PACKAGE_SHAPE_INVALID")
        if any(item.compress_type != zipfile.ZIP_STORED or item.flag_bits & 1 or item.is_dir() or item.external_attr >> 16 != 0o100444 for item in infos):
            raise ValueError("PACKAGE_SHAPE_INVALID")
        content = {item.filename: archive.read(item) for item in infos}
    manifest = json.loads(content.pop("manifest.json"), object_pairs_hook=pairs)
    if not isinstance(manifest, dict) or set(manifest) != {"schema", "files"} or manifest["schema"] != schema or not isinstance(manifest["files"], dict) or set(manifest["files"]) != files:
        raise ValueError("PACKAGE_MANIFEST_INVALID")
    if any(sha(content[name]) != manifest["files"][name] for name in files):
        raise ValueError("PACKAGE_HASH_MISMATCH")
    return content, manifest


def verify_package(package, expected):
    with package.open("rb") as stream:
        raw = stream.read(BOUND + 1)
    return unpack(raw, expected, FILES, "m2-a-fault-package-v1", BOUND)


def load_base(content, manifest):
    raw = content["base-a.zip"]
    base_files = {"boundary.py", "executor.py", "empty_probe.py", "bridge.py", "installer.py", "install-plan.json"}
    base_content, base_manifest = unpack(raw, manifest["files"]["base-a.zip"], base_files, "m2-a-package-v1", 1048576)
    base = types.ModuleType("approved_base_a_installer")
    exec(compile(base_content["installer.py"], "approved-base-a/installer.py", "exec"), base.__dict__)
    # Use the original verifier as well; its receipt/ledger contract is unchanged.
    verified, checked = base.verify_package(SnapshotPackage(raw), sha(raw))
    if verified != base_content or checked != base_manifest or base.INSTANCE != INSTANCE:
        raise ValueError("BASE_PACKAGE_INVALID")
    return base, base_content, base_manifest


def new_content(content, base_content):
    return {name: (base_content["installer.py"] if name == "base_installer.py" else content[name]) for name in INSTALLED}


def identities(base):
    result = {"code_directory": base.identity(CODE, 0o755, True),
              "config_directory": base.identity(CONFIG, 0o700, True),
              "log_directory": base.identity(LOG, 0o700, True),
              "profile.json": base.identity(CONFIG / "profile.json", 0o600)}
    result.update({name: base.identity(CODE / name, 0o555) for name in INSTALLED})
    return result


def new_targets_preflight(base):
    for path in (CODE, CONFIG, LOG):
        base.safe_parent(path)
        if path.exists() or path.is_symlink():
            raise ValueError("FAULT_INSTALL_COLLISION")


def base_preflight(base, retained):
    # All original _apply checks before its first mkdir, with no mutation.
    import pwd
    account = pwd.getpwnam("m2-a")
    if account.pw_uid == 0 or account.pw_gid == 0 or account.pw_shell not in ("/usr/sbin/nologin", "/sbin/nologin"):
        raise ValueError("ROLE_INVALID")
    for path in (base.CODE, base.CONFIG, base.CGROUP):
        base.safe_parent(path)
        if path.exists() or path.is_symlink():
            raise ValueError("INSTALL_COLLISION")
    base.safe_parent(base.INPUT)
    base.safe_parent(base.OUTPUT)
    root, marker, output = base.INPUT.lstat(), (base.INPUT / "marker.txt").lstat(), base.OUTPUT.lstat()
    if not stat.S_ISDIR(root.st_mode) or root.st_uid != 0 or root.st_gid != account.pw_gid or stat.S_IMODE(root.st_mode) != 0o750:
        raise ValueError("INPUT_PROFILE_INVALID")
    if not stat.S_ISREG(marker.st_mode) or marker.st_nlink != 1 or marker.st_uid != 0 or marker.st_gid != account.pw_gid or stat.S_IMODE(marker.st_mode) != 0o640 or (base.INPUT / "marker.txt").read_bytes() != base.PUBLIC_INPUT:
        raise ValueError("PUBLIC_INPUT_CHANGED")
    if not stat.S_ISDIR(output.st_mode) or output.st_uid != account.pw_uid or output.st_gid != account.pw_gid or stat.S_IMODE(output.st_mode) != 0o700:
        raise ValueError("OUTPUT_PROFILE_INVALID")
    controllers = base.CONTROLLERS.read_text().split()
    if any(name.split(".")[0] not in controllers for name in base.LIMITS):
        raise ValueError("CGROUP_CONTROLLERS_UNAVAILABLE")
    if retained != base.retained_snapshot():
        raise ValueError("SUCCESSOR_SNAPSHOT_DRIFT")


def install(content, manifest, base, previous_manifest, receipt_sha256, ledger_sha256, backup_sha256=None):
    base_content, base_manifest = base.verify_package(SnapshotPackage(content["base-a.zip"]), manifest["files"]["base-a.zip"])
    new_targets_preflight(base)
    snapshot = base.retained_snapshot()
    _, previous, raw = base.receipt_head(snapshot)
    base.check_history(snapshot, previous)
    if sha(raw) != receipt_sha256 or sha(snapshot["files"]["ledger.sqlite"][1]) != ledger_sha256 or previous["manifest_sha256"] != base.manifest_digest(previous_manifest):
        raise ValueError("SUCCESSOR_APPROVAL_MISMATCH")
    backup = sha(snapshot["files"][base.BACKUP][1]) if base.BACKUP in snapshot["files"] else None
    if backup != backup_sha256:
        raise ValueError("SUCCESSOR_BACKUP_NOT_APPROVED")
    if set(REQUEST_IDS.values()) & set(base.ledger_burns(snapshot["files"]["ledger.sqlite"][1])):
        raise ValueError("FAULT_REQUEST_ALREADY_BURNED")
    import pwd
    account = pwd.getpwnam("m2-a")
    source, output = base.INPUT.lstat(), base.OUTPUT.lstat()
    previous_profile = {"schema": "m2-a-installed-v1", "instance": base.INSTANCE,
                        "frozen_inputs": {"marker.txt": sha(base.PUBLIC_INPUT)},
                        "binding": {"uid": account.pw_uid, "gid": account.pw_gid,
                                    "input": [source.st_dev, source.st_ino], "output": [output.st_dev, output.st_ino]},
                        "files": {name: previous_manifest["files"][name] for name in base.INSTALLED_CODE}}
    if sha(base.encoded(previous_profile)) != previous["profile_sha256"]:
        raise ValueError("SUCCESSOR_PROFILE_DRIFT")
    base_preflight(base, snapshot)
    new_targets_preflight(base)
    base.resume_after_rollback(base_content, base_manifest, previous_manifest, receipt_sha256, ledger_sha256, backup_sha256)
    current = base.retained_snapshot()
    head_name, head, head_raw = base.receipt_head(current)
    base.check_history(current, head)
    original_profile = json.loads((base.CONFIG / "profile.json").read_bytes(), object_pairs_hook=pairs)
    installed = new_content(content, base_content)
    CODE.mkdir(mode=0o755)
    CODE.chmod(0o755)
    CONFIG.mkdir(mode=0o700)
    LOG.mkdir(mode=0o700)
    for name, data in installed.items():
        base.exclusive(CODE / name, data, 0o555)
    profile = {"schema": "m2-a-fault-installed-v1", "instance": INSTANCE,
               "vm_id": VM_ID, "files": {name: sha(data) for name, data in installed.items()},
               "base_receipt_sha256": sha(head_raw), "request_ids": REQUEST_IDS,
               "binding": original_profile["binding"],
               "log_directory_identity": base.identity(LOG, 0o700, True)}
    profile_raw = encoded(profile)
    base.exclusive(CONFIG / "profile.json", profile_raw, 0o600)
    receipt = {"schema": "m2-a-fault-install-receipt-v1", "manifest_sha256": sha(encoded(manifest)),
               "profile_sha256": sha(profile_raw), "identities": identities(base),
               "base_receipt": head_name, "base_receipt_sha256": sha(head_raw),
               "base_ledger_identity": current["files"]["ledger.sqlite"][0]}
    receipt["installation_id"] = sha(encoded(receipt))
    base.exclusive(LOG / "install-receipt.json", encoded(receipt), 0o600)


def base_rollback_preflight(base, manifest, receipt):
    # Same fixed targets/checks as original _rollback, using its validators.
    # The unchanged original _rollback repeats these before its own first unlink.
    if receipt["manifest_sha256"] != base.manifest_digest(manifest) or receipt["identities"] != base.installed_identities():
        raise ValueError("ROLLBACK_IDENTITY_DRIFT")
    fields = dict(line.split() for line in (base.CGROUP / "cgroup.events").read_text().splitlines())
    if fields.get("populated") != "0":
        raise ValueError("EXECUTION_STOP_UNCONFIRMED")
    if any((base.CGROUP / name).read_text().strip() != value for name, value in base.LIMITS.items()):
        raise ValueError("ROLLBACK_IDENTITY_DRIFT")
    if any(sha((base.CODE / name).read_bytes()) != manifest["files"][name] for name in base.INSTALLED_CODE):
        raise ValueError("ROLLBACK_IDENTITY_DRIFT")
    if sha((base.CONFIG / "profile.json").read_bytes()) != receipt["profile_sha256"] or set(p.name for p in base.CODE.iterdir()) != set(base.INSTALLED_CODE) or set(p.name for p in base.CONFIG.iterdir()) != {"profile.json"}:
        raise ValueError("ROLLBACK_IDENTITY_DRIFT")


def rollback_preflight(content, manifest, base):
    base_content, base_manifest = base.verify_package(SnapshotPackage(content["base-a.zip"]), manifest["files"]["base-a.zip"])
    _, raw = base.bound_read(LOG / "install-receipt.json")
    receipt = json.loads(raw, object_pairs_hook=pairs)
    keys = {"schema", "manifest_sha256", "profile_sha256", "identities", "base_receipt", "base_receipt_sha256", "base_ledger_identity", "installation_id"}
    if not isinstance(receipt, dict) or set(receipt) != keys or receipt["schema"] != "m2-a-fault-install-receipt-v1" or receipt["installation_id"] != sha(encoded({k: v for k, v in receipt.items() if k != "installation_id"})) or receipt["manifest_sha256"] != sha(encoded(manifest)) or receipt["identities"] != identities(base):
        raise ValueError("FAULT_ROLLBACK_DRIFT")
    if set(p.name for p in CODE.iterdir()) != set(INSTALLED) or set(p.name for p in CONFIG.iterdir()) != {"profile.json"}:
        raise ValueError("FAULT_ROLLBACK_DRIFT")
    if any(sha((CODE / name).read_bytes()) != sha(data) for name, data in new_content(content, base_content).items()) or sha((CONFIG / "profile.json").read_bytes()) != receipt["profile_sha256"]:
        raise ValueError("FAULT_ROLLBACK_DRIFT")
    # Only fixed bounded case log names can accompany the retained receipt.
    allowed_logs = {"install-receipt.json"} | {request + ".json" for request in REQUEST_IDS.values()}
    for path in LOG.iterdir():
        if path.name not in allowed_logs:
            raise ValueError("FAULT_UNKNOWN_LOG")
        base.identity(path, 0o600)
    snapshot = base.retained_snapshot()
    head_name, head, head_raw = base.receipt_head(snapshot)
    base.check_history(snapshot, head)
    if head_name != receipt["base_receipt"] or sha(head_raw) != receipt["base_receipt_sha256"] or snapshot["files"]["ledger.sqlite"][0] != receipt["base_ledger_identity"]:
        raise ValueError("FAULT_BASE_HISTORY_DRIFT")
    base_rollback_preflight(base, base_manifest, head)
    return base_manifest, head, snapshot


def rollback(content, manifest, base):
    base_manifest, head, snapshot = rollback_preflight(content, manifest, base)
    # Recheck both complete snapshots immediately before the first unlink.
    second = rollback_preflight(content, manifest, base)
    if second != (base_manifest, head, snapshot):
        raise ValueError("FAULT_ROLLBACK_DRIFT")
    base._rollback(base_manifest, head)
    for name in INSTALLED:
        (CODE / name).unlink()
    (CONFIG / "profile.json").unlink()
    CODE.rmdir()
    CONFIG.rmdir()
    # LOG and receipt remain immutable audit evidence; original DATA survives.


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", type=Path)
    parser.add_argument("--approved-sha256")
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--install-approved", action="store_true")
    actions.add_argument("--rollback-approved", action="store_true")
    parser.add_argument("--previous-package", type=Path)
    parser.add_argument("--previous-approved-sha256")
    parser.add_argument("--previous-receipt-sha256")
    parser.add_argument("--retained-ledger-sha256")
    parser.add_argument("--retained-backup-sha256")
    args = parser.parse_args(argv)
    if not (args.install_approved or args.rollback_approved) or not args.package or not args.approved_sha256 or sys.platform != "linux" or os.geteuid() != 0:
        print("FAULT_INSTALL_NOT_AUTHORIZED")
        return 2
    previous_umask = os.umask(0o077)
    try:
        content, manifest = verify_package(args.package, args.approved_sha256)
        base, _, _ = load_base(content, manifest)
        if args.install_approved:
            if not all((args.previous_package, args.previous_approved_sha256, args.previous_receipt_sha256, args.retained_ledger_sha256)):
                raise ValueError("SUCCESSOR_APPROVAL_MISSING")
            _, previous_manifest = base.verify_package(args.previous_package, args.previous_approved_sha256)
            install(content, manifest, base, previous_manifest, args.previous_receipt_sha256, args.retained_ledger_sha256, args.retained_backup_sha256)
        else:
            rollback(content, manifest, base)
        print("CANDIDATE_FAULT_INSTALL_ACTION_DONE_QUALIFICATION_NOT_ISSUED")
        return 0
    except Exception:
        print("FAULT_INSTALL_ACTION_FAILED_INSPECT_NEW_PATHS_NO_RETRY_OVERWRITE")
        return 2
    finally:
        os.umask(previous_umask)


if __name__ == "__main__":
    raise SystemExit(main())
