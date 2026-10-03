"""Offline candidate primitives. No listener, process launcher or qualification.

The future trusted broker must own the ledger and pin the role before dispatch.
These primitives do not replace the JS Host or establish complete Agent isolation.
"""
import hashlib
import os
import re
import sqlite3
import stat
import sys

MAX_BYTES = 65536
ROLES = {
    "A": ("m2-a", "/srv/clued-m2/probe/a-input", "/srv/clued-m2/probe/a-work"),
    "R": ("m2-r", "/srv/clued-m2/probe/r-input", "/srv/clued-m2/probe/r-output"),
}


class Denied(Exception):
    """Only the fixed code, never filesystem exception text, crosses the boundary."""


def leaf(name):
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", name) or name in (".", ".."):
        raise Denied("PATH_INVALID")
    return name


class ReplayLedger:
    """Trusted, pre-provisioned SQLite database; durable burns precede IO.

    No auto-creation: installation must establish a broker-private ledger first.
    Instance ID is supplied by the trusted Host, never by tool arguments.
    """
    def __init__(self, database):
        self.db = sqlite3.connect(database.as_uri() + "?mode=rw", uri=True, timeout=1)
        self.db.execute("PRAGMA synchronous=FULL")
        if self.db.execute("PRAGMA journal_mode").fetchone()[0] != "delete":
            self.db.close()
            raise Denied("LEDGER_PROFILE_INVALID")
        # Schema provisioning is an explicit installation step, not a runtime fallback.
        try:
            self.db.execute("SELECT instance, request FROM burns LIMIT 0")
        except BaseException:
            self.db.close()
            raise

    def burn(self, instance, request):
        if any(not isinstance(v, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", v) for v in (instance, request)):
            raise Denied("REQUEST_INVALID")
        try:
            self.db.execute("BEGIN IMMEDIATE")
            count = self.db.execute("SELECT count(*) FROM burns WHERE instance=?", (instance,)).fetchone()[0]
            if count >= 256:
                raise Denied("ENTRY_REQUEST_LIMIT")
            self.db.execute("INSERT INTO burns(instance,request) VALUES (?,?)", (instance, request))
            self.db.commit()
        except sqlite3.IntegrityError:
            self.db.rollback()
            raise Denied("REPLAY_REJECTED") from None
        except BaseException:
            self.db.rollback()
            raise

    def close(self):
        self.db.close()


class DirectoryHandle:
    """Linux-only, single-component handle IO. Ancestor provisioning is external.

    Private immutable input root and private output root are installation
    prerequisites. No recursive paths, mounts, general filesystem RPC or shell.
    Root path inode is checked before/after IO; a drift invalidates the entry.
    """
    def __init__(self, path, uid):
        if sys.platform != "linux" or os.geteuid() != uid:
            raise Denied("IDENTITY_OR_PLATFORM_INVALID")
        self.path, self.uid = path, uid
        self.fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            s = os.fstat(self.fd)
            if s.st_uid != uid or stat.S_IMODE(s.st_mode) != 0o700:
                raise Denied("ROOT_PROFILE_INVALID")
            self.identity = (s.st_dev, s.st_ino)
            self.recheck()
        except BaseException:
            os.close(self.fd)
            raise

    def recheck(self):
        s = os.stat(self.path, follow_symlinks=False)
        if (s.st_dev, s.st_ino) != self.identity or not stat.S_ISDIR(s.st_mode) or s.st_uid != self.uid or stat.S_IMODE(s.st_mode) != 0o700:
            raise Denied("ROOT_IDENTITY_DRIFT")

    def read_frozen(self, name, expected):
        name = leaf(name)
        if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
            raise Denied("INPUT_NOT_FROZEN")
        self.recheck()
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_dev != self.identity[0] or before.st_uid != self.uid or before.st_mode & 0o222:
                raise Denied("INPUT_PROFILE_INVALID")
            data = bytearray()
            while len(data) <= MAX_BYTES:
                chunk = os.read(fd, min(8192, MAX_BYTES + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
            after = os.fstat(fd)
            self.recheck()
            if len(data) > MAX_BYTES:
                raise Denied("CONTENT_TOO_LARGE")
            if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns) or hashlib.sha256(data).hexdigest() != expected:
                raise Denied("INPUT_IDENTITY_DRIFT")
            return bytes(data)
        finally:
            os.close(fd)

    def create_only(self, name, data, cancelled):
        """Atomic visibility with exclusive link. Cancellation checked at commit.

        Caller must serialize revocation with this synchronous commit boundary;
        this function alone cannot fence cross-process cancellation.
        """
        name = leaf(name)
        if type(data) is not bytes or len(data) > MAX_BYTES:
            raise Denied("CONTENT_TOO_LARGE")
        self.recheck()
        temporary = ".m2-" + os.urandom(16).hex()
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
        try:
            view = memoryview(data)
            while view:
                count = os.write(fd, view)
                if count <= 0:
                    raise Denied("IO_FAILED")
                view = view[count:]
            os.fsync(fd)
            self.recheck()
            if cancelled():
                raise Denied("ENTRY_REVOKED_OR_EXPIRED")
            # link fails if target exists, including symlinks; never overwrites.
            os.link(f"/proc/self/fd/{fd}", name, dst_dir_fd=self.fd, follow_symlinks=True)
            os.fsync(self.fd)
            self.recheck()
        finally:
            os.close(fd)
            os.unlink(temporary, dir_fd=self.fd)

    def close(self):
        os.close(self.fd)


def fixed_role_handles(role):
    """Trusted role only; UID/root are resolved internally and cannot be injected."""
    if role not in ROLES or sys.platform != "linux":
        raise Denied("HOST_PROFILE_INVALID")
    import pwd
    principal, input_root, output_root = ROLES[role]
    uid = pwd.getpwnam(principal).pw_uid
    first = DirectoryHandle(input_root, uid)
    try:
        return first, DirectoryHandle(output_root, uid)
    except BaseException:
        first.close()
        raise


def run_empty_probe():
    # No guessed launcher or unverified subprocess termination is permitted.
    raise Denied("LAUNCHER_NOT_CONFIGURED")
