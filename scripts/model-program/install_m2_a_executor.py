"""Reviewed-package installer candidate. Never invoked by the executor protocol.

Default is deny. --apply-approved/--rollback-approved require separately granted
Owner installation authorization, exact approved archive SHA and Owner root.
No listener/registry/module/service/network changes are performed by this file.
"""
import argparse
import hashlib
import importlib.util
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
FILES = {"boundary.py", "executor.py", "empty_probe.py", "bridge.py", "installer.py", "install-plan.json"}
LIMITS = {"memory.max": "67108864", "pids.max": "8", "cpu.max": "20000 100000"}
PUBLIC_INPUT = b"PUBLIC_EMPTY_PROBE_INPUT:a-input\n"


def pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("DUPLICATE_KEY")
        result[key] = value
    return result


def verify_package(package, expected):
    if package.stat().st_size > 1048576:
        raise ValueError("PACKAGE_TOO_LARGE")
    if not re.fullmatch(r"[a-f0-9]{64}", expected) or hashlib.sha256(package.read_bytes()).hexdigest() != expected:
        raise ValueError("PACKAGE_HASH_MISMATCH")
    with zipfile.ZipFile(package) as archive:
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


def apply(content, manifest):
    import pwd
    account = pwd.getpwnam("m2-a")
    if account.pw_uid == 0 or account.pw_gid == 0 or account.pw_shell not in ("/usr/sbin/nologin", "/sbin/nologin"):
        raise ValueError("ROLE_INVALID")
    for path in (CODE, CONFIG, DATA, CGROUP):
        safe_parent(path)
        if path.exists() or path.is_symlink():
            raise ValueError("INSTALL_COLLISION")
    root = Path("/srv/clued-m2/probe/a-input")
    safe_parent(root)
    s = root.lstat()
    marker = root / "marker.txt"
    m = marker.lstat()
    output = Path("/srv/clued-m2/probe/a-work").lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or s.st_gid != account.pw_gid or stat.S_IMODE(s.st_mode) != 0o750:
        raise ValueError("INPUT_PROFILE_INVALID")
    if not stat.S_ISREG(m.st_mode) or m.st_nlink != 1 or m.st_uid != 0 or m.st_gid != account.pw_gid or stat.S_IMODE(m.st_mode) != 0o640 or m.st_size != len(PUBLIC_INPUT) or marker.read_bytes() != PUBLIC_INPUT:
        raise ValueError("PUBLIC_INPUT_CHANGED")
    if not stat.S_ISDIR(output.st_mode) or output.st_uid != account.pw_uid or stat.S_IMODE(output.st_mode) != 0o700:
        raise ValueError("OUTPUT_PROFILE_INVALID")
    # No parent controller changes. Missing delegated features fail closed.
    for name in LIMITS:
        if name.split(".")[0] not in Path("/sys/fs/cgroup/cgroup.subtree_control").read_text().split():
            raise ValueError("CGROUP_CONTROLLERS_UNAVAILABLE")
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
    DATA.mkdir(mode=0o700)
    for name in ("executor.py", "boundary.py", "empty_probe.py"):
        exclusive(CODE / name, content[name], 0o555)
    profile = {"schema": "m2-a-installed-v1", "instance": "m2-a-public-empty-20261003",
               "frozen_inputs": {"marker.txt": hashlib.sha256(PUBLIC_INPUT).hexdigest()},
               "binding": {"uid": account.pw_uid, "gid": account.pw_gid,
                           "input": [s.st_dev, s.st_ino], "output": [output.st_dev, output.st_ino]},
               "files": {name: manifest["files"][name] for name in ("executor.py", "boundary.py", "empty_probe.py")}}
    exclusive(CONFIG / "profile.json", (json.dumps(profile, sort_keys=True) + "\n").encode("ascii"), 0o600)
    db = sqlite3.connect(DATA / "ledger.sqlite")
    try:
        db.execute("PRAGMA journal_mode=DELETE")
        db.execute("PRAGMA synchronous=EXTRA")
        db.execute("CREATE TABLE burns(instance TEXT NOT NULL, request TEXT NOT NULL, PRIMARY KEY(instance,request))")
        db.commit()
    finally:
        db.close()
    os.chmod(DATA / "ledger.sqlite", 0o600)
    # Role-owned roots/accounts remain unchanged. No executable is started.


def rollback(manifest):
    safe_parent(CGROUP)
    if CGROUP.is_symlink() or CGROUP.stat().st_uid != 0:
        raise ValueError("CGROUP_PROFILE_INVALID")
    fields = dict(line.split() for line in (CGROUP / "cgroup.events").read_text().splitlines())
    if fields.get("populated") != "0":
        raise ValueError("EXECUTION_STOP_UNCONFIRMED")
    for path, expected in [(CODE / name, manifest["files"][name]) for name in ("executor.py", "boundary.py", "empty_probe.py")]:
        safe_parent(path)
        s = path.lstat()
        if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or s.st_nlink != 1 or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError("ROLLBACK_IDENTITY_DRIFT")
    profile = CONFIG / "profile.json"
    safe_parent(profile)
    s = profile.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or s.st_nlink != 1:
        raise ValueError("ROLLBACK_IDENTITY_DRIFT")
    for name in ("executor.py", "boundary.py", "empty_probe.py"):
        (CODE / name).unlink()
    profile.unlink()
    CODE.rmdir()
    CONFIG.rmdir()
    CGROUP.rmdir()
    # DATA/ledger intentionally retained: no replay reset or recursive delete.


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", type=Path)
    parser.add_argument("--approved-sha256")
    parser.add_argument("--apply-approved", action="store_true")
    parser.add_argument("--rollback-approved", action="store_true")
    args = parser.parse_args(argv)
    if (args.apply_approved == args.rollback_approved or not args.package or not args.approved_sha256 or sys.platform != "linux" or os.geteuid() != 0):
        print("INSTALL_NOT_AUTHORIZED")
        return 2
    previous = os.umask(0o077)
    try:
        content, manifest = verify_package(args.package, args.approved_sha256)
        if args.apply_approved:
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
