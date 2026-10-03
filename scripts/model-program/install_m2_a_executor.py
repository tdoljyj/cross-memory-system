"""Reviewed-package installer candidate. Never invoked by the executor protocol.

Default is deny. --apply-approved/--rollback-approved require separately granted
Owner installation authorization, exact approved archive SHA and Owner root.
No listener/registry/module/service/network changes are performed by this file.
"""
import argparse
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import zipfile

CODE = Path("/usr/local/lib/clued-m2-a")
CONFIG = Path("/etc/clued-m2-a")
DATA = Path("/var/lib/clued-m2-a")
CGROUP = Path("/sys/fs/cgroup/clued-m2-a")
INPUT = Path("/srv/clued-m2/probe/a-input")
OUTPUT = Path("/srv/clued-m2/probe/a-work")
CONTROLLERS = Path("/sys/fs/cgroup/cgroup.subtree_control")
INSTALLED_CODE = ("executor.py", "boundary.py", "empty_probe.py")
FILES = {"boundary.py", "executor.py", "empty_probe.py", "bridge.py", "installer.py", "install-plan.json"}
LIMITS = {"memory.max": "67108864", "pids.max": "8", "cpu.max": "20000 100000"}
PUBLIC_INPUT = b"PUBLIC_EMPTY_PROBE_INPUT:a-input\n"
INSTANCE = "m2-a-public-empty-20261003"
BACKUP = "cache-cleanup-backup-20261003.bin"
BURNS_SQL = "CREATE TABLE burns(instance TEXT NOT NULL, request TEXT NOT NULL, PRIMARY KEY(instance,request))"


def pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("DUPLICATE_KEY")
        result[key] = value
    return result


def verify_package(package, expected):
    # One bounded snapshot: staging may be mutable, even after hash verification.
    with package.open("rb") as stream:
        snapshot = stream.read(1048576 + 1)
    if len(snapshot) > 1048576:
        raise ValueError("PACKAGE_TOO_LARGE")
    if not re.fullmatch(r"[a-f0-9]{64}", expected) or hashlib.sha256(snapshot).hexdigest() != expected:
        raise ValueError("PACKAGE_HASH_MISMATCH")
    with zipfile.ZipFile(io.BytesIO(snapshot)) as archive:
        names = archive.namelist()
        if set(names) != FILES | {"manifest.json"} or len(names) != len(FILES) + 1 or sum(i.file_size for i in archive.infolist()) > 1048576:
            raise ValueError("PACKAGE_SHAPE_INVALID")
        content = {name: archive.read(name) for name in names}
    manifest = json.loads(content.pop("manifest.json"), object_pairs_hook=pairs)
    if set(manifest) != {"schema", "files"} or manifest["schema"] != "m2-a-package-v1" or set(manifest["files"]) != FILES:
        raise ValueError("PACKAGE_MANIFEST_INVALID")
    if any(hashlib.sha256(content[name]).hexdigest() != manifest["files"][name] for name in FILES):
        raise ValueError("PACKAGE_HASH_MISMATCH")
    return content, manifest


def safe_parent(path):
    for parent in reversed(path.parents):
        s = parent.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022:
            raise ValueError("PARENT_INVALID")


def exclusive(path, content, mode):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "wb") as stream:
        os.fchmod(stream.fileno(), mode)
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")


def manifest_digest(manifest):
    return hashlib.sha256(encoded(manifest)).hexdigest()


def identity(path, mode, directory=False):
    safe_parent(path)
    s = path.lstat()
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if not kind(s.st_mode) or s.st_uid != 0 or s.st_gid != 0 or stat.S_IMODE(s.st_mode) != mode or (not directory and s.st_nlink != 1):
        raise ValueError("ROLLBACK_IDENTITY_DRIFT")
    return {"device": s.st_dev, "inode": s.st_ino, "uid": s.st_uid,
            "gid": s.st_gid, "mode": stat.S_IMODE(s.st_mode)}


def installed_identities():
    # Fixed targets only; paths are never taken from the receipt.
    result = {"code_directory": identity(CODE, 0o755, True),
              "config_directory": identity(CONFIG, 0o700, True),
              "data_directory": identity(DATA, 0o700, True),
              "cgroup": identity(CGROUP, 0o700, True),
              "profile.json": identity(CONFIG / "profile.json", 0o600),
              "ledger.sqlite": identity(DATA / "ledger.sqlite", 0o600)}
    result.update({name: identity(CODE / name, 0o555) for name in INSTALLED_CODE})
    return result


def apply(content, manifest):
    _apply(content, manifest)


def _apply(content, manifest, retained=None):
    import pwd
    account = pwd.getpwnam("m2-a")
    if account.pw_uid == 0 or account.pw_gid == 0 or account.pw_shell not in ("/usr/sbin/nologin", "/sbin/nologin"):
        raise ValueError("ROLE_INVALID")
    for path in (CODE, CONFIG, DATA, CGROUP):
        safe_parent(path)
        if path == DATA and retained is not None:
            continue
        if path.exists() or path.is_symlink():
            raise ValueError("INSTALL_COLLISION")
    root = INPUT
    safe_parent(root)
    s = root.lstat()
    marker = root / "marker.txt"
    m = marker.lstat()
    safe_parent(OUTPUT)
    output = OUTPUT.lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or s.st_gid != account.pw_gid or stat.S_IMODE(s.st_mode) != 0o750:
        raise ValueError("INPUT_PROFILE_INVALID")
    if not stat.S_ISREG(m.st_mode) or m.st_nlink != 1 or m.st_uid != 0 or m.st_gid != account.pw_gid or stat.S_IMODE(m.st_mode) != 0o640 or m.st_size != len(PUBLIC_INPUT) or marker.read_bytes() != PUBLIC_INPUT:
        raise ValueError("PUBLIC_INPUT_CHANGED")
    if not stat.S_ISDIR(output.st_mode) or output.st_uid != account.pw_uid or output.st_gid != account.pw_gid or stat.S_IMODE(output.st_mode) != 0o700:
        raise ValueError("OUTPUT_PROFILE_INVALID")
    # No parent controller changes. Missing delegated features fail closed.
    for name in LIMITS:
        if name.split(".")[0] not in CONTROLLERS.read_text().split():
            raise ValueError("CGROUP_CONTROLLERS_UNAVAILABLE")
    # Recheck the full retained snapshot immediately before the first write.
    if retained is not None and retained != retained_snapshot():
        raise ValueError("SUCCESSOR_SNAPSHOT_DRIFT")
    CGROUP.mkdir(mode=0o700)
    try:
        for name, value in LIMITS.items():
            (CGROUP / name).write_text(value)
            if (CGROUP / name).read_text().strip() != value:
                raise ValueError("CGROUP_PROFILE_INVALID")
        if not (CGROUP / "cgroup.kill").exists():
            raise ValueError("CGROUP_KILL_UNAVAILABLE")
    except BaseException:
        CGROUP.rmdir()
        raise
    CODE.mkdir(mode=0o755)
    CODE.chmod(0o755)
    CONFIG.mkdir(mode=0o700)
    if retained is None:
        DATA.mkdir(mode=0o700)
    for name in INSTALLED_CODE:
        exclusive(CODE / name, content[name], 0o555)
    profile = {"schema": "m2-a-installed-v1", "instance": INSTANCE,
               "frozen_inputs": {"marker.txt": hashlib.sha256(PUBLIC_INPUT).hexdigest()},
               "binding": {"uid": account.pw_uid, "gid": account.pw_gid,
                           "input": [s.st_dev, s.st_ino], "output": [output.st_dev, output.st_ino]},
               "files": {name: manifest["files"][name] for name in INSTALLED_CODE}}
    profile_bytes = encoded(profile)
    exclusive(CONFIG / "profile.json", profile_bytes, 0o600)
    if retained is None:
        db = sqlite3.connect(DATA / "ledger.sqlite")
        try:
            db.execute("PRAGMA journal_mode=DELETE")
            db.execute("PRAGMA synchronous=EXTRA")
            db.execute(BURNS_SQL)
            db.commit()
        finally:
            db.close()
        os.chmod(DATA / "ledger.sqlite", 0o600)
    receipt = {"schema": "m2-a-install-receipt-v1", "manifest_sha256": manifest_digest(manifest),
               "profile_sha256": hashlib.sha256(profile_bytes).hexdigest(),
               "identities": installed_identities()}
    if retained is not None:
        old_path, old, old_raw = receipt_head(retained)
        receipt["schema"] = "m2-a-install-receipt-v2"
        receipt["predecessor"] = {"receipt": old_path, "sha256": sha(old_raw),
                                  "ledger_sha256": sha(retained["files"]["ledger.sqlite"][1]),
                                  "burns": ledger_burns(retained["files"]["ledger.sqlite"][1]),
                                  "backup_sha256": sha(retained["files"][BACKUP][1]) if BACKUP in retained["files"] else None}
    receipt["installation_id"] = sha(encoded(receipt))
    name = "install-receipt.json" if retained is None else "install-receipt-" + receipt["installation_id"] + ".json"
    exclusive(DATA / name, encoded(receipt), 0o600)
    # Role-owned roots/accounts remain unchanged. No executable is started.


def rollback(manifest):
    if any(p.name.startswith("install-receipt-") for p in DATA.iterdir()):
        snapshot = retained_snapshot()
        _, receipt, _ = receipt_head(snapshot)
        check_history(snapshot, receipt)
        return _rollback(manifest, receipt)
    receipt_path = DATA / "install-receipt.json"
    identity(receipt_path, 0o600)
    with receipt_path.open("rb") as stream:
        receipt_bytes = stream.read(16384 + 1)
    if len(receipt_bytes) > 16384:
        raise ValueError("ROLLBACK_IDENTITY_DRIFT")
    receipt = json.loads(receipt_bytes, object_pairs_hook=pairs)
    if not isinstance(receipt, dict) or set(receipt) != {"schema", "manifest_sha256", "profile_sha256", "identities", "installation_id"}:
        raise ValueError("ROLLBACK_IDENTITY_DRIFT")
    installation_id = receipt.pop("installation_id")
    if receipt["schema"] != "m2-a-install-receipt-v1" or installation_id != hashlib.sha256(encoded(receipt)).hexdigest() or receipt["manifest_sha256"] != manifest_digest(manifest):
        raise ValueError("ROLLBACK_IDENTITY_DRIFT")
    _rollback(manifest, receipt)


def _rollback(manifest, receipt):
    if receipt["manifest_sha256"] != manifest_digest(manifest):
        raise ValueError("ROLLBACK_IDENTITY_DRIFT")
    # Validate EVERY deletion target and retained ledger identity before unlink.
    if receipt["identities"] != installed_identities():
        raise ValueError("ROLLBACK_IDENTITY_DRIFT")
    fields = dict(line.split() for line in (CGROUP / "cgroup.events").read_text().splitlines())
    if fields.get("populated") != "0":
        raise ValueError("EXECUTION_STOP_UNCONFIRMED")
    if any((CGROUP / name).read_text().strip() != value for name, value in LIMITS.items()):
        raise ValueError("ROLLBACK_IDENTITY_DRIFT")
    for name in INSTALLED_CODE:
        if hashlib.sha256((CODE / name).read_bytes()).hexdigest() != manifest["files"][name]:
            raise ValueError("ROLLBACK_IDENTITY_DRIFT")
    profile = CONFIG / "profile.json"
    if hashlib.sha256(profile.read_bytes()).hexdigest() != receipt["profile_sha256"] or set(p.name for p in CODE.iterdir()) != set(INSTALLED_CODE) or set(p.name for p in CONFIG.iterdir()) != {"profile.json"}:
        raise ValueError("ROLLBACK_IDENTITY_DRIFT")
    for name in INSTALLED_CODE:
        (CODE / name).unlink()
    profile.unlink()
    CODE.rmdir()
    CONFIG.rmdir()
    CGROUP.rmdir()
    # DATA/ledger/install receipt retained: no replay reset or recursive delete.


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def bound_read(path):
    before = identity(path, 0o600)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        s = os.fstat(stream.fileno())
        actual = {"device": s.st_dev, "inode": s.st_ino, "uid": s.st_uid,
                  "gid": s.st_gid, "mode": stat.S_IMODE(s.st_mode)}
        if actual != before or not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
            raise ValueError("SUCCESSOR_IDENTITY_DRIFT")
        raw = stream.read(1048577)
        if len(raw) > 1048576 or identity(path, 0o600) != before:
            raise ValueError("SUCCESSOR_SNAPSHOT_DRIFT")
    return before, raw


def retained_snapshot():
    result = {"directory": identity(DATA, 0o700, True), "files": {}}
    total = 0
    for path in DATA.iterdir():
        name = path.name
        if name not in ("ledger.sqlite", "install-receipt.json", BACKUP) and not re.fullmatch(r"install-receipt-[a-f0-9]{64}\.json", name):
            raise ValueError("SUCCESSOR_UNKNOWN_DATA")
        result["files"][name] = bound_read(path)
        total += len(result["files"][name][1])
        if total > 1048576:
            raise ValueError("SUCCESSOR_HISTORY_TOO_LARGE")
    if not {"ledger.sqlite", "install-receipt.json"} <= result["files"].keys():
        raise ValueError("SUCCESSOR_HISTORY_MISSING")
    return result


def ledger_burns(raw):
    # Deserialize into RAM only: preflight never opens the retained DB writable.
    if raw[:16] != b"SQLite format 3\x00" or raw[18:20] != b"\x01\x01":
        raise ValueError("SUCCESSOR_LEDGER_INVALID")
    with contextlib.closing(sqlite3.connect(":memory:")) as db:
        db.deserialize(raw)
        db.execute("PRAGMA query_only=ON")
        if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ValueError("SUCCESSOR_LEDGER_INVALID")
        objects = db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").fetchall()
        if objects != [("table", "burns", "burns", BURNS_SQL), ("index", "sqlite_autoindex_burns_1", "burns", None)]:
            raise ValueError("SUCCESSOR_LEDGER_SCHEMA")
        if db.execute("PRAGMA table_info(burns)").fetchall() != [(0, "instance", "TEXT", 1, None, 1), (1, "request", "TEXT", 1, None, 2)]:
            raise ValueError("SUCCESSOR_LEDGER_SCHEMA")
        rows = db.execute("SELECT instance,request FROM burns ORDER BY request LIMIT 257").fetchall()
    if len(rows) > 256 or any(instance != INSTANCE or not isinstance(request, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", request) for instance, request in rows):
        raise ValueError("SUCCESSOR_LEDGER_HISTORY")
    return [request for _, request in rows]


def receipt_head(snapshot):
    receipts = {}
    base_keys = {"schema", "manifest_sha256", "profile_sha256", "identities", "installation_id"}
    for name, (_, raw) in snapshot["files"].items():
        if not name.startswith("install-receipt"):
            continue
        value = json.loads(raw, object_pairs_hook=pairs)
        legacy = name == "install-receipt.json"
        if not isinstance(value, dict) or set(value) != base_keys | (set() if legacy else {"predecessor"}) or value["schema"] != ("m2-a-install-receipt-v1" if legacy else "m2-a-install-receipt-v2"):
            raise ValueError("SUCCESSOR_RECEIPT_INVALID")
        payload = {k: v for k, v in value.items() if k != "installation_id"}
        if value["installation_id"] != sha(encoded(payload)) or (not legacy and name != "install-receipt-" + value["installation_id"] + ".json"):
            raise ValueError("SUCCESSOR_RECEIPT_INVALID")
        if value["identities"]["data_directory"] != snapshot["directory"] or value["identities"]["ledger.sqlite"] != snapshot["files"]["ledger.sqlite"][0]:
            raise ValueError("SUCCESSOR_IDENTITY_DRIFT")
        receipts[name] = (value, raw)
    referenced = set()
    for name, (value, _) in receipts.items():
        if name == "install-receipt.json":
            continue
        prev = value["predecessor"]
        if not isinstance(prev, dict) or set(prev) != {"receipt", "sha256", "ledger_sha256", "burns", "backup_sha256"} or prev["receipt"] not in receipts or prev["receipt"] in referenced or prev["receipt"] == name or prev["sha256"] != sha(receipts[prev["receipt"]][1]):
            raise ValueError("SUCCESSOR_RECEIPT_CHAIN")
        burns = prev["burns"]
        if not isinstance(burns, list) or len(burns) > 256 or any(not isinstance(x, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", x) for x in burns) or burns != sorted(set(burns)) or not re.fullmatch(r"[a-f0-9]{64}", prev["ledger_sha256"]):
            raise ValueError("SUCCESSOR_RECEIPT_CHAIN")
        referenced.add(prev["receipt"])
    heads = receipts.keys() - referenced
    if len(heads) != 1:
        raise ValueError("SUCCESSOR_RECEIPT_CHAIN")
    head = next(iter(heads))
    visited = set()
    cursor = head
    while cursor != "install-receipt.json":
        if cursor in visited:
            raise ValueError("SUCCESSOR_RECEIPT_CHAIN")
        visited.add(cursor)
        cursor = receipts[cursor][0]["predecessor"]["receipt"]
    if len(visited) + 1 != len(receipts):
        raise ValueError("SUCCESSOR_RECEIPT_CHAIN")
    return head, *receipts[head]


def check_history(snapshot, head):
    burns = set(ledger_burns(snapshot["files"]["ledger.sqlite"][1]))
    backup = sha(snapshot["files"][BACKUP][1]) if BACKUP in snapshot["files"] else None
    for name, (_, raw) in snapshot["files"].items():
        if name.startswith("install-receipt-"):
            prev = json.loads(raw, object_pairs_hook=pairs)["predecessor"]
            if not set(prev["burns"]) <= burns or prev["backup_sha256"] != backup:
                raise ValueError("SUCCESSOR_HISTORY_LOST")


def resume_after_rollback(content, manifest, previous_manifest, receipt_sha256, ledger_sha256, backup_sha256=None):
    # Explicit successor action, never an exception to ordinary apply collision.
    for path in (CODE, CONFIG, CGROUP):
        safe_parent(path)
        if path.exists() or path.is_symlink():
            raise ValueError("INSTALL_COLLISION")
    snapshot = retained_snapshot()
    _, previous, raw = receipt_head(snapshot)
    if sha(raw) != receipt_sha256 or sha(snapshot["files"]["ledger.sqlite"][1]) != ledger_sha256 or previous["manifest_sha256"] != manifest_digest(previous_manifest):
        raise ValueError("SUCCESSOR_APPROVAL_MISMATCH")
    backup = sha(snapshot["files"][BACKUP][1]) if BACKUP in snapshot["files"] else None
    if backup != backup_sha256:
        raise ValueError("SUCCESSOR_BACKUP_NOT_APPROVED")
    import pwd
    account = pwd.getpwnam("m2-a")
    s, output = INPUT.lstat(), OUTPUT.lstat()
    previous_profile = {"schema": "m2-a-installed-v1", "instance": INSTANCE,
                        "frozen_inputs": {"marker.txt": sha(PUBLIC_INPUT)},
                        "binding": {"uid": account.pw_uid, "gid": account.pw_gid,
                                    "input": [s.st_dev, s.st_ino], "output": [output.st_dev, output.st_ino]},
                        "files": {name: previous_manifest["files"][name] for name in INSTALLED_CODE}}
    if sha(encoded(previous_profile)) != previous["profile_sha256"]:
        raise ValueError("SUCCESSOR_PROFILE_DRIFT")
    check_history(snapshot, previous)
    _apply(content, manifest, snapshot)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", type=Path)
    parser.add_argument("--approved-sha256")
    parser.add_argument("--apply-approved", action="store_true")
    parser.add_argument("--rollback-approved", action="store_true")
    parser.add_argument("--resume-after-rollback-approved", action="store_true")
    parser.add_argument("--previous-package", type=Path)
    parser.add_argument("--previous-approved-sha256")
    parser.add_argument("--previous-receipt-sha256")
    parser.add_argument("--retained-ledger-sha256")
    parser.add_argument("--retained-backup-sha256")
    args = parser.parse_args(argv)
    if (sum((args.apply_approved, args.rollback_approved, args.resume_after_rollback_approved)) != 1 or not args.package or not args.approved_sha256 or sys.platform != "linux" or os.geteuid() != 0):
        print("INSTALL_NOT_AUTHORIZED")
        return 2
    previous = os.umask(0o077)
    try:
        content, manifest = verify_package(args.package, args.approved_sha256)
        if args.resume_after_rollback_approved:
            if not all((args.previous_package, args.previous_approved_sha256, args.previous_receipt_sha256, args.retained_ledger_sha256)):
                raise ValueError("SUCCESSOR_APPROVAL_MISSING")
            _, previous_manifest = verify_package(args.previous_package, args.previous_approved_sha256)
            resume_after_rollback(content, manifest, previous_manifest, args.previous_receipt_sha256, args.retained_ledger_sha256, args.retained_backup_sha256)
        elif args.apply_approved:
            apply(content, manifest)
        else:
            rollback(manifest)
        print("CANDIDATE_INSTALL_ACTION_DONE_QUALIFICATION_NOT_ISSUED")
        return 0
    except Exception:
        print("INSTALL_ACTION_FAILED_INSPECT_NEW_PATHS_NO_RETRY_OVERWRITE")
        return 2
    finally:
        os.umask(previous)


if __name__ == "__main__":
    raise SystemExit(main())
