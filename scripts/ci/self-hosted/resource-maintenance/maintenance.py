#!/usr/bin/env python3
"""Clued managed-cache maintenance. Unregistered caches are never adopted.

The worker and cache producers share an OS lease; immutable receipts live outside
cache generations. This module does not prune Docker, compact VHDX, stop services,
or retire pre-existing directories. See README.md before node registration.
"""
from __future__ import annotations

import argparse
import contextlib
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
import uuid
from functools import lru_cache

# -I callers still resolve only these reviewed sibling modules, never user paths.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import security

VERSION = "1.0.1"
ID = re.compile(r"[a-z0-9][a-z0-9-]{0,62}\Z")
GEN = re.compile(r"[0-9a-f]{32}\Z")
PROTECTED = {".git", ".env", "credentials", "receipt", "receipts", "ledger", "ledgers"}
SUFFIXES = {".pem", ".key", ".token", ".log", ".vhd", ".vhdx"}


class Refused(RuntimeError):
    pass


def require(ok, code):
    if not ok:
        raise Refused(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def load_json(path, limit=2_000_000):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and not reparse(info), "JSON_BOUNDARY")
    require(info.st_size <= limit, "JSON_SIZE")
    with path.open("rb") as stream:
        data = stream.read(limit + 1)
    require(len(data) <= limit, "JSON_SIZE")
    return json.loads(data)


def write_json(path, value, *, exclusive=False):
    data = canonical(value) + b"\n"
    if exclusive:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with os.fdopen(fd, "wb") as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        return
    temp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    write_json(temp, value, exclusive=True)
    os.replace(temp, path)


def emit(value, stream=None):
    # pythonw scheduled workers have no console; the durable report remains primary.
    stream = sys.stdout if stream is None else stream
    if stream is not None:
        print(json.dumps(value), file=stream, flush=True)


def reparse(info):
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


@lru_cache(maxsize=1)
def owner_identity():
    if os.name != "nt":
        require(os.geteuid() != 0, "STANDARD_ACCOUNT_REQUIRED")
        return str(os.geteuid())
    from ctypes import wintypes as w
    adv = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.restype = w.HANDLE
    adv.OpenProcessToken.argtypes = [w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE)]
    adv.GetTokenInformation.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD)]
    adv.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(w.LPWSTR)]
    kernel.CloseHandle.argtypes = [w.HANDLE]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    token, size, elevated = w.HANDLE(), w.DWORD(), w.DWORD()
    require(adv.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)), "TOKEN_QUERY")
    try:
        require(adv.GetTokenInformation(token, 20, ctypes.byref(elevated), ctypes.sizeof(elevated), ctypes.byref(size)), "TOKEN_QUERY")
        require(not elevated.value, "STANDARD_ACCOUNT_REQUIRED")
        adv.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))
        buffer = ctypes.create_string_buffer(size.value)
        require(adv.GetTokenInformation(token, 1, buffer, size.value, ctypes.byref(size)), "TOKEN_QUERY")
        sid = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p))[0]
        text = w.LPWSTR()
        require(adv.ConvertSidToStringSidW(sid, ctypes.byref(text)), "TOKEN_SID")
        try:
            return text.value
        finally:
            kernel.LocalFree(ctypes.cast(text, ctypes.c_void_p))
    finally:
        kernel.CloseHandle(token)


def checked_dir(path, *, owned=True):
    require(path.is_absolute() and path == path.resolve(), "ABSOLUTE_REAL_PATH_REQUIRED")
    for parent in (path, *path.parents):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and not reparse(info), "REPARSE_OR_NON_DIRECTORY")
        if os.name == "nt":
            require(security.windows_private(parent, owner_identity(), ancestor=True), "ANCESTOR_PERMISSIONS")
        else:
            require(info.st_uid in (0, os.geteuid()), "ANCESTOR_OWNER")
            sticky_root = info.st_uid == 0 and info.st_mode & stat.S_ISVTX
            require(not info.st_mode & 0o022 or sticky_root, "ANCESTOR_PERMISSIONS")
    info = path.lstat()
    if owned and os.name != "nt":
        require(info.st_uid == os.geteuid(), "DIRECTORY_OWNER")
        require(stat.S_IMODE(info.st_mode) & 0o077 == 0, "DIRECTORY_PERMISSIONS")
    if owned and os.name == "nt":
        require(security.windows_private(path, owner_identity()), "DIRECTORY_PERMISSIONS")
    return [info.st_dev, info.st_ino]


def private_dir(path):
    if path.exists():
        checked_dir(path)
        return
    if not path.parent.exists():
        private_dir(path.parent)
    checked_dir(path.parent, owned=False)
    security.create_directory(path, owner_identity())
    checked_dir(path)


def integer(value, low, high, code):
    require(type(value) is int and low <= value <= high, code)
    return value


class Lease:
    """One stable inode. Shared producers, exclusive maintenance; never unlink."""
    def __init__(self, path, exclusive, timeout=0):
        self.path, self.exclusive, self.timeout = path, exclusive, timeout
        self.fd = None

    def __enter__(self):
        if self.path.exists():
            s = self.path.lstat()
            require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and not reparse(s), "LEASE_BOUNDARY")
        self.fd = os.open(self.path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        deadline = time.monotonic() + self.timeout
        while True:
            if self._try_lock():
                return self
            if time.monotonic() >= deadline:
                os.close(self.fd)
                self.fd = None
                raise Refused("LEASE_BUSY")
            time.sleep(0.05)

    def _try_lock(self):
        if os.name != "nt":
            import fcntl
            try:
                fcntl.flock(self.fd, (fcntl.LOCK_EX if self.exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
                return True
            except BlockingIOError:
                return False
        import msvcrt
        from ctypes import wintypes as w
        class Overlapped(ctypes.Structure):
            _fields_ = [("Internal", ctypes.c_size_t), ("InternalHigh", ctypes.c_size_t),
                        ("Offset", w.DWORD), ("OffsetHigh", w.DWORD), ("hEvent", w.HANDLE)]
        self.overlapped = Overlapped()
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.LockFileEx.argtypes = [w.HANDLE, w.DWORD, w.DWORD, w.DWORD, w.DWORD, ctypes.c_void_p]
        self.kernel.UnlockFileEx.argtypes = [w.HANDLE, w.DWORD, w.DWORD, w.DWORD, ctypes.c_void_p]
        self.handle = msvcrt.get_osfhandle(self.fd)
        if self.kernel.LockFileEx(self.handle, 1 | (2 if self.exclusive else 0), 0, 1, 0, ctypes.byref(self.overlapped)):
            return True
        require(ctypes.get_last_error() in (33, 997), "WINDOWS_LEASE_FAILED")
        return False

    def __exit__(self, *_):
        if self.fd is None:
            return
        try:
            if os.name == "nt":
                self.kernel.UnlockFileEx(self.handle, 0, 1, 0, ctypes.byref(self.overlapped))
            else:
                import fcntl
                fcntl.flock(self.fd, fcntl.LOCK_UN)
        finally:
            os.close(self.fd)
            self.fd = None


def stable_stagger(node_id, maximum):
    return int(hashlib.sha256(node_id.encode()).hexdigest()[:16], 16) % (maximum + 1)


def mount_paths(lines):
    # proc(5) escapes whitespace/backslashes in mountinfo pathname fields.
    paths = []
    for line in lines:
        fields = line.split()
        require(len(fields) >= 6, "MOUNTINFO_FORMAT")
        paths.append(re.sub(r"\\(040|011|012|134)", lambda match: chr(int(match[1], 8)), fields[4]))
    return paths


def inspect_tree(path, max_entries, deadline, budget=None):
    """Metadata only. Any evidence-like, linked or foreign entry preserves the tree."""
    identity = checked_dir(path)
    device = path.lstat().st_dev
    rows, size, latest = [], 0, 0
    pending = [path]
    if sys.platform.startswith("linux"):
        # st_dev alone does not detect same-filesystem bind mounts.
        with open("/proc/self/mountinfo", encoding="utf-8") as stream:
            mounts = mount_paths(stream)
        prefix = str(path) + "/"
        require(not any(m == str(path) or m.startswith(prefix) for m in mounts), "MOUNT_BOUNDARY")
    while pending:
        require(time.monotonic() <= deadline, "INVENTORY_TIME_BUDGET")
        current = pending.pop()
        with os.scandir(current) as entries:
            for entry in entries:
                require(len(rows) < max_entries, "INVENTORY_ENTRY_BUDGET")
                require(time.monotonic() <= deadline, "INVENTORY_TIME_BUDGET")
                if budget is not None:
                    require(budget[0] > 0, "INVENTORY_ENTRY_BUDGET")
                    budget[0] -= 1
                # Windows DirEntry.stat() does not supply the volume/file identity.
                # A fresh lstat supplies st_dev/st_ino/st_nlink and still never follows links.
                s = Path(entry.path).lstat()
                name = entry.name.casefold()
                require(not reparse(s) and s.st_dev == device, "LINK_OR_DEVICE_BOUNDARY")
                require(name not in PROTECTED and Path(name).suffix not in SUFFIXES, "PROTECTED_CONTENT")
                require(stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode), "SPECIAL_FILE")
                if os.name != "nt":
                    require(s.st_uid == os.geteuid(), "ENTRY_OWNER")
                if stat.S_ISREG(s.st_mode):
                    require(s.st_nlink == 1, "HARDLINK_BOUNDARY")
                    size += s.st_size
                else:
                    pending.append(Path(entry.path))
                latest = max(latest, s.st_mtime_ns / 1e9)
                rows.append([str(Path(entry.path).relative_to(path)), s.st_dev, s.st_ino,
                             s.st_mode, s.st_size, s.st_mtime_ns, s.st_nlink])
    return {"identity": identity, "tree_sha256": digest(sorted(rows)), "bytes": size,
            "entries": len(rows), "latest_write": latest}


class Manager:
    def __init__(self, registry, binding, *, clock=time.time):
        self.registry, self.binding, self.clock = registry, binding, clock
        require(registry.get("schema") == "clued.cache-maintenance/1", "REGISTRY_SCHEMA")
        require(binding.get("schema") == "clued.cache-node/1", "BINDING_SCHEMA")
        require(set(binding) == {"schema", "node_id", "state_root", "caches"}, "BINDING_FIELDS")
        self.node = binding["node_id"]
        require(type(self.node) is str and ID.fullmatch(self.node), "NODE_ID")
        self.owner = owner_identity()
        self.state = Path(binding["state_root"])
        self.policy = registry["policy"]
        self.registry_sha, self.binding_sha = digest(registry), digest(binding)
        for key, bounds in {"interval_seconds": (60, 86400), "stagger_seconds": (0, 3600),
                            "max_entries": (1, 1_000_000), "max_generations": (1, 1000),
                            "max_seconds": (1, 3600), "max_remove_bytes": (0, 1 << 40),
                            "drain_wait_seconds": (0, 300), "plan_ttl_seconds": (1, 3600)}.items():
            integer(self.policy[key], *bounds, "POLICY_" + key.upper())
        for key in ("free_trigger_fraction", "free_target_fraction"):
            require(type(self.policy[key]) in (int, float) and 0 < self.policy[key] < 1
                    and math.isfinite(self.policy[key]), "DISK_FRACTION")
        require(self.policy["free_target_fraction"] > self.policy["free_trigger_fraction"], "DISK_HYSTERESIS")
        roots = [self.state]
        require(type(binding["caches"]) is dict and 0 < len(binding["caches"]) <= 1000, "CACHE_COUNT")
        for cache_id, spec in binding["caches"].items():
            require(ID.fullmatch(cache_id) and set(spec) == {"profile", "root"}, "CACHE_BINDING")
            require(spec["profile"] in registry["profiles"], "UNKNOWN_PROFILE")
            profile = registry["profiles"][spec["profile"]]
            require(profile["producer"] in ("npm", "pip", "generic", "job-temp"), "PRODUCER")
            for key in ("idle_seconds", "pressure_idle_seconds", "rotate_seconds", "keep_generations", "max_bytes"):
                integer(profile[key], 0, 1 << 40, "PROFILE_" + key.upper())
            require(profile["pressure_idle_seconds"] <= profile["idle_seconds"], "PROFILE_IDLE_ORDER")
            roots.append(Path(spec["root"]))
        for i, root in enumerate(roots):
            require(root.is_absolute() and root.name and len(root.parts) >= 3, "ROOT_PATH")
            require(root == root.resolve(), "ROOT_REAL_PATH")
            for other in roots[:i]:
                require(not root.is_relative_to(other) and not other.is_relative_to(root), "OVERLAPPING_ROOTS")

    def _state_marker(self):
        return {"schema": "clued.cache-state/1", "node_id": self.node, "owner": self.owner,
                "binding_sha256": self.binding_sha}

    def initialize(self):
        # Registration creates NEW empty roots. It never labels old arbitrary files disposable.
        for root in [self.state, *(Path(s["root"]) for s in self.binding["caches"].values())]:
            if root.exists():
                checked_dir(root)
            else:
                private_dir(root)
        marker = self.state / "node.json"
        if marker.exists():
            require(load_json(marker) == self._state_marker(), "NODE_MARKER")
        else:
            require(not any(self.state.iterdir()), "STATE_NOT_EMPTY")
            write_json(marker, self._state_marker(), exclusive=True)
        for name in ("receipts", "generations", "writers", "logs", "intents"):
            private_dir(self.state / name)
        for name in ("active", "settled"):
            private_dir(self.state / "writers" / name)
        for cache_id, spec in self.binding["caches"].items():
            private_dir(self.state / "generations" / cache_id)
            for name in ("live", "retired"):
                private_dir(self.state / "generations" / cache_id / name)
            root = Path(spec["root"])
            marker = root / ".clued-cache.json"
            value = {"schema": "clued.managed-cache/1", "node_id": self.node, "cache_id": cache_id,
                     "owner": self.owner, "root_identity": checked_dir(root), "binding_sha256": self.binding_sha}
            if marker.exists():
                require(load_json(marker) == value, "CACHE_MARKER")
            else:
                require(not any(root.iterdir()), "CACHE_NOT_EMPTY")
                write_json(marker, value, exclusive=True)
            private_dir(root / "data")
        return {"status": "REGISTERED_NEW_MANAGED_CACHES", "node_id": self.node, "cache_count": len(self.binding["caches"])}

    def validate(self):
        checked_dir(self.state)
        require(load_json(self.state / "node.json") == self._state_marker(), "NODE_MARKER")
        for name in ("receipts", "generations", "writers", "logs", "intents"):
            checked_dir(self.state / name)
        for name in ("active", "settled"):
            checked_dir(self.state / "writers" / name)
        for cache_id in self.binding["caches"]:
            checked_dir(self.state / "generations" / cache_id)
            for name in ("live", "retired"):
                checked_dir(self.state / "generations" / cache_id / name)
            self.cache_root(cache_id)

    def cache_root(self, cache_id):
        require(cache_id in self.binding["caches"], "UNREGISTERED_CACHE")
        root = Path(self.binding["caches"][cache_id]["root"])
        expected = {"schema": "clued.managed-cache/1", "node_id": self.node, "cache_id": cache_id,
                    "owner": self.owner, "root_identity": checked_dir(root), "binding_sha256": self.binding_sha}
        require(load_json(root / ".clued-cache.json") == expected, "CACHE_MARKER")
        checked_dir(root / "data")
        return root

    def receipt(self, kind, body):
        row = {"schema": "clued.cache-receipt/1", "tool_version": VERSION, "node_id": self.node,
               "kind": kind, "at": self.clock(), "registry_sha256": self.registry_sha, "body": body}
        name = f"{time.time_ns()}-{uuid.uuid4().hex}.json"
        write_json(self.state / "receipts" / name, row, exclusive=True)
        return name

    def _draining(self):
        path = self.state / "drain.json"
        if not path.exists():
            return False
        value = load_json(path)
        require(value.get("node_id") == self.node, "DRAIN_OWNER")
        # Even after a crashed drainer's marker expires, the OS exclusive lease is authoritative.
        return value["until"] >= self.clock()

    @contextlib.contextmanager
    def writer(self, cache_id, wait=30):
        self.validate()
        deadline = time.monotonic() + wait
        while True:
            require(time.monotonic() <= deadline, "DRAINING")
            if self._draining():
                time.sleep(0.05)
                continue
            try:
                lease = Lease(self.state / "jobs.lock", False, 0).__enter__()
            except Refused as error:
                if str(error) != "LEASE_BUSY":
                    raise
                time.sleep(0.05)
                continue
            if self._draining():
                lease.__exit__()
                continue
            break
        try:
            with Lease(self.state / "catalog.lock", True, wait):
                root = self.cache_root(cache_id)
                profile = self.registry["profiles"][self.binding["caches"][cache_id]["profile"]]
                blocked = self._unsettled_generations()
                rows = self._generation_rows(cache_id)
                usable = [r for r in rows if (cache_id, r["generation"]) not in blocked
                          and self.clock() - r["created_at"] < profile["rotate_seconds"]]
                if usable:
                    row = max(usable, key=lambda r: r["created_at"])
                else:
                    generation = uuid.uuid4().hex
                    target = root / "data" / generation
                    private_dir(target)
                    row = {"schema": "clued.cache-generation/1", "node_id": self.node, "cache_id": cache_id,
                           "generation": generation, "identity": checked_dir(target), "created_at": self.clock(),
                           "last_used": self.clock(), "state": "live"}
                    write_json(self._meta(cache_id, generation), row, exclusive=True)
                writer_id = uuid.uuid4().hex
                writer_file = self.state / "writers" / "active" / (writer_id + ".json")
                writer_row = {"schema": "clued.cache-writer/1", "node_id": self.node, "cache_id": cache_id,
                              "generation": row["generation"], "phase": "active", "supervisor_pid": os.getpid()}
                write_json(writer_file, writer_row, exclusive=True)
            success = False
            try:
                yield root / "data" / row["generation"], profile
                success = True
            finally:
                # A caller MUST leave the scope only after its complete process tree is terminal.
                # Exceptions deliberately retain an unsettled durable row; a dead PID alone is not proof.
                if success:
                    with Lease(self.state / "catalog.lock", True, wait):
                        row["last_used"] = self.clock()
                        write_json(self._meta(cache_id, row["generation"]), row)
                        writer_row["phase"] = "terminal-tree-confirmed"
                        write_json(writer_file, writer_row)
                        os.rename(writer_file, self.state / "writers" / "settled" / writer_file.name)
        finally:
            lease.__exit__()

    def _meta(self, cache_id, generation):
        require(ID.fullmatch(cache_id) and GEN.fullmatch(generation), "GENERATION_ID")
        return self.state / "generations" / cache_id / "live" / (generation + ".json")

    def _catalog_paths(self, directory, deadline=None):
        deadline = deadline if deadline is not None else time.monotonic() + self.policy["max_seconds"]
        with os.scandir(directory) as entries:
            for index, entry in enumerate(entries):
                require(index < self.policy["max_entries"], "CATALOG_ENTRY_BUDGET")
                require(time.monotonic() <= deadline, "CATALOG_TIME_BUDGET")
                require(entry.name.endswith(".json"), "CATALOG_UNKNOWN_ENTRY")
                yield Path(entry.path)

    def _generation_rows(self, cache_id, deadline=None):
        rows = []
        for path in self._catalog_paths(self.state / "generations" / cache_id / "live", deadline):
            row = load_json(path)
            require(row.get("schema") == "clued.cache-generation/1" and row.get("node_id") == self.node
                    and row.get("cache_id") == cache_id and GEN.fullmatch(row.get("generation", "")), "GENERATION_METADATA")
            require(path == self._meta(cache_id, row["generation"]), "GENERATION_METADATA_PATH")
            if row["state"] == "live":
                require(all(type(row[k]) in (int, float) and 0 <= row[k] <= self.clock() + 300 and math.isfinite(row[k])
                            for k in ("created_at", "last_used")), "GENERATION_CLOCK")
                rows.append(row)
        return rows

    def _unsettled_generations(self, deadline=None):
        result = set()
        for path in self._catalog_paths(self.state / "writers" / "active", deadline):
            row = load_json(path)
            require(row.get("schema") == "clued.cache-writer/1" and row.get("node_id") == self.node, "WRITER_METADATA")
            require(row.get("cache_id") in self.binding["caches"] and GEN.fullmatch(row.get("generation", "")), "WRITER_METADATA")
            if row["phase"] != "terminal-tree-confirmed":
                result.add((row["cache_id"], row["generation"]))
        return result

    def plan(self, deadline=None):
        self.validate()
        deadline = deadline if deadline is not None else time.monotonic() + self.policy["max_seconds"]
        blocked, candidates, deferred, observations = self._unsettled_generations(deadline), [], [], []
        budget = [self.policy["max_entries"]]
        for cache_id, spec in self.binding["caches"].items():
            require(time.monotonic() <= deadline, "INVENTORY_TIME_BUDGET")
            root, profile = self.cache_root(cache_id), self.registry["profiles"][spec["profile"]]
            rows = sorted(self._generation_rows(cache_id, deadline), key=lambda r: r["last_used"], reverse=True)
            disk = shutil.disk_usage(root)
            pressure = disk.free / disk.total < self.policy["free_trigger_fraction"]
            usage, infos = 0, []
            for index, row in enumerate(rows):
                if (cache_id, row["generation"]) in blocked:
                    deferred.append({"cache_id": cache_id, "generation": row["generation"], "reason": "UNSETTLED_WRITER"})
                    continue
                try:
                    info = inspect_tree(root / "data" / row["generation"], self.policy["max_entries"], deadline, budget)
                    require(info["identity"] == row["identity"], "GENERATION_REPLACED")
                    usage += info["bytes"]
                    infos.append((index, row, info))
                except (Refused, OSError) as error:
                    deferred.append({"cache_id": cache_id, "generation": row["generation"],
                                     "reason": str(error) if isinstance(error, Refused) else "FILESYSTEM_UNREADABLE"})
            known = {r["generation"] for r in rows}
            unknown = []
            for index, path in enumerate((root / "data").iterdir()):
                require(index < self.policy["max_entries"], "CATALOG_ENTRY_BUDGET")
                require(time.monotonic() <= deadline, "CATALOG_TIME_BUDGET")
                if path.name not in known:
                    unknown.append(path.name)
            if unknown:
                deferred.append({"cache_id": cache_id, "reason": "UNREGISTERED_DATA", "count": len(unknown)})
            observations.append({"cache_id": cache_id, "bytes": usage, "filesystem_free_bytes": disk.free,
                                 "filesystem_total_bytes": disk.total, "pressure": pressure, "unregistered_entries": len(unknown)})
            for index, row, info in reversed(infos):
                idle = self.clock() - max(row["last_used"], info["latest_write"])
                threshold = profile["pressure_idle_seconds"] if pressure else profile["idle_seconds"]
                expired = idle >= threshold and (pressure or index >= profile["keep_generations"])
                over_quota = usage > profile["max_bytes"] and idle >= profile["pressure_idle_seconds"]
                if expired or over_quota:
                    candidates.append({"cache_id": cache_id, "generation": row["generation"], **info,
                                       "last_used": row["last_used"], "reason": "pressure" if pressure else "quota" if over_quota else "age"})
                    usage -= info["bytes"]
        return {"schema": "clued.cache-plan/1", "node_id": self.node, "registry_sha256": self.registry_sha,
                "binding_sha256": self.binding_sha, "created_at": self.clock(),
                "expires_at": self.clock() + self.policy["plan_ttl_seconds"], "candidates": candidates,
                "deferred": deferred, "observations": observations}

    def cycle(self, reviewed_plan=None):
        self.validate()
        removed, bytes_removed = [], 0
        with Lease(self.state / "maintenance.lock", True, 0):
            cookie = uuid.uuid4().hex
            write_json(self.state / "drain.json", {"node_id": self.node, "cookie": cookie,
                       "until": self.clock() + self.policy["drain_wait_seconds"] + self.policy["max_seconds"] + 60})
            try:
                with Lease(self.state / "jobs.lock", True, self.policy["drain_wait_seconds"]):
                    deadline = time.monotonic() + self.policy["max_seconds"]
                    plan = self.plan(deadline)
                    if reviewed_plan is not None:
                        require(reviewed_plan.get("schema") == "clued.cache-plan/1"
                                and reviewed_plan.get("node_id") == self.node
                                and reviewed_plan.get("registry_sha256") == self.registry_sha
                                and reviewed_plan.get("binding_sha256") == self.binding_sha
                                and reviewed_plan["expires_at"] >= self.clock(), "PLAN_BINDING_OR_EXPIRY")
                        require(reviewed_plan["candidates"] == plan["candidates"], "PLAN_CHANGED")
                    for candidate in plan["candidates"]:
                        if len(removed) >= self.policy["max_generations"] or time.monotonic() > deadline:
                            plan["deferred"].append({"reason": "PASS_BUDGET"})
                            break
                        if bytes_removed + candidate["bytes"] > self.policy["max_remove_bytes"]:
                            plan["deferred"].append({"cache_id": candidate["cache_id"], "generation": candidate["generation"],
                                                     "reason": "REMOVE_BYTE_BUDGET"})
                            continue
                        if candidate["reason"] == "pressure":
                            disk = shutil.disk_usage(self.cache_root(candidate["cache_id"]))
                            if disk.free / disk.total >= self.policy["free_target_fraction"]:
                                continue
                        self._retire(candidate, deadline)
                        removed.append({"cache_id": candidate["cache_id"], "generation": candidate["generation"],
                                        "bytes": candidate["bytes"]})
                        bytes_removed += candidate["bytes"]
                    report = {"schema": "clued.cache-maintenance-report/1", "tool_version": VERSION,
                              "node_id": self.node, "at": self.clock(), "status": "deferred" if plan["deferred"] else "ok",
                              "removed": removed, "removed_bytes": bytes_removed, "deferred": plan["deferred"],
                              "observations": plan["observations"], "vhdx_compacted": False}
                    report.update(registry_sha256=self.registry_sha, binding_sha256=self.binding_sha)
                    report["after_filesystems"] = []
                    for cache_id in self.binding["caches"]:
                        disk = shutil.disk_usage(self.cache_root(cache_id))
                        report["after_filesystems"].append({"cache_id": cache_id, "free_bytes": disk.free,
                            "total_bytes": disk.total, "below_trigger": disk.free / disk.total < self.policy["free_trigger_fraction"],
                            "below_target": disk.free / disk.total < self.policy["free_target_fraction"]})
                    if any(row["below_trigger"] for row in report["after_filesystems"]):
                        report["status"] = "capacity-low"
                    report["receipt"] = self.receipt("maintenance-completed", report)
                    write_json(self.state / "report.json", report)
                    return report
            except (Refused, OSError) as error:
                code = str(error) if isinstance(error, Refused) else "FILESYSTEM_OPERATION_FAILED"
                report = {"schema": "clued.cache-maintenance-report/1", "tool_version": VERSION, "node_id": self.node,
                          "at": self.clock(), "status": "partial" if removed else "deferred", "code": code,
                          "removed": removed, "removed_bytes": bytes_removed}
                report.update(registry_sha256=self.registry_sha, binding_sha256=self.binding_sha)
                report["receipt"] = self.receipt("maintenance-deferred", report)
                write_json(self.state / "report.json", report)
                return report
            finally:
                row = load_json(self.state / "drain.json")
                require(row.get("cookie") == cookie, "DRAIN_CHANGED")
                (self.state / "drain.json").unlink()

    def _retire(self, candidate, deadline):
        cache_id, generation = candidate["cache_id"], candidate["generation"]
        root = self.cache_root(cache_id)
        row = load_json(self._meta(cache_id, generation))
        require(row["last_used"] == candidate["last_used"] and row["state"] == "live", "GENERATION_CHANGED")
        require((cache_id, generation) not in self._unsettled_generations(deadline), "WRITER_APPEARED")
        target = root / "data" / generation
        actual = inspect_tree(target, self.policy["max_entries"], deadline)
        require(actual == {k: candidate[k] for k in actual}, "TREE_CHANGED")
        retired_name = ".retired-" + uuid.uuid4().hex
        intent_id = self.receipt("retire-intent", {"candidate": candidate, "retired_name": retired_name})
        # This path is a NEW leased generation of this tool, never an old arbitrary cache.
        # Interrupted intents remain quarantined and alerted; no blind restart deletion.
        retired = root / "data" / retired_name
        if os.name != "nt":
            require(shutil.rmtree.avoids_symlink_attacks, "FD_SAFE_DELETE_REQUIRED")
            expected_parent = checked_dir(root / "data")
            parent_fd = os.open(root / "data", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                parent_info = os.fstat(parent_fd)
                require([parent_info.st_dev, parent_info.st_ino] == expected_parent, "PARENT_IDENTITY")
                before = os.stat(generation, dir_fd=parent_fd, follow_symlinks=False)
                require([before.st_dev, before.st_ino] == candidate["identity"] and stat.S_ISDIR(before.st_mode), "GENERATION_REPLACED")
                os.rename(generation, retired_name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
                after = os.stat(retired_name, dir_fd=parent_fd, follow_symlinks=False)
                require([after.st_dev, after.st_ino] == candidate["identity"] and stat.S_ISDIR(after.st_mode), "QUARANTINE_IDENTITY")
                shutil.rmtree(retired_name, dir_fd=parent_fd)
            finally:
                os.close(parent_fd)
        else:
            # Windows 3.12+ rmtree does not traverse directory junctions. All registered
            # writers are drained, and a fresh tree/identity check precedes quarantine.
            require(sys.version_info >= (3, 12), "PYTHON_312_REQUIRED")
            checked_dir(root / "data")
            require(checked_dir(target) == candidate["identity"], "GENERATION_REPLACED")
            os.rename(target, retired)
            require(checked_dir(retired) == candidate["identity"], "QUARANTINE_IDENTITY")
            shutil.rmtree(retired)
        row["state"] = "retired"
        row["retired_at"] = self.clock()
        write_json(self._meta(cache_id, generation), row)
        os.rename(self._meta(cache_id, generation), self.state / "generations" / cache_id / "retired" / (generation + ".json"))
        self.receipt("retire-completed", {"intent": intent_id, "cache_id": cache_id, "generation": generation,
                                          "bytes": candidate["bytes"]})

    def run(self, cache_id, argv, timeout=None):
        from producer import run_tree
        with self.writer(cache_id) as (path, profile):
            env = os.environ.copy()
            producer = profile["producer"]
            if producer == "npm":
                require(not any(a == "--cache" or a.startswith("--cache=") or a == "--logs-dir"
                                or a.startswith("--logs-dir=") for a in argv), "PRODUCER_CACHE_OVERRIDE")
                logs = self.state / "logs" / uuid.uuid4().hex
                private_dir(logs)
                env.update(npm_config_cache=str(path), npm_config_logs_dir=str(logs))
            elif producer == "pip":
                require(not any(a == "--cache-dir" or a.startswith("--cache-dir=") for a in argv), "PRODUCER_CACHE_OVERRIDE")
                env["PIP_CACHE_DIR"] = str(path)
            elif producer == "job-temp":
                env.update(TMP=str(path), TEMP=str(path), TMPDIR=str(path))
            else:
                env["CLUED_CACHE_DIR"] = str(path)
            return run_tree(argv, env, timeout)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", action="version", version=VERSION)
    parser.add_argument("--registry", required=True, type=Path)
    parser.add_argument("--registry-sha256", required=True)
    parser.add_argument("--binding", required=True, type=Path)
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("init")
    plan_parser = sub.add_parser("plan")
    plan_parser.add_argument("--out", type=Path)
    apply_parser = sub.add_parser("apply")
    apply_parser.add_argument("--plan", required=True, type=Path)
    apply_parser.add_argument("--plan-sha256", required=True)
    sub.add_parser("once")
    sub.add_parser("worker")
    run_parser = sub.add_parser("run")
    run_parser.add_argument("--cache-id", required=True)
    run_parser.add_argument("--timeout", type=int)
    run_parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    registry = load_json(args.registry)
    require(digest(registry) == args.registry_sha256, "REGISTRY_PIN")
    manager = Manager(registry, load_json(args.binding))
    if args.action == "run":
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        require(args.timeout is None or args.timeout > 0, "PRODUCER_TIMEOUT")
        return manager.run(args.cache_id, command, args.timeout)
    if args.action == "init":
        result = manager.initialize()
    elif args.action == "plan":
        result = manager.plan()
        if args.out:
            write_json(args.out, result, exclusive=True)
    elif args.action == "apply":
        plan = load_json(args.plan)
        require(digest(plan) == args.plan_sha256, "PLAN_PIN")
        result = manager.cycle(plan)
    elif args.action == "once":
        result = manager.cycle()
    else:
        stopping = False
        def stop(*_):
            nonlocal stopping
            stopping = True
        signal.signal(signal.SIGINT, stop)
        signal.signal(signal.SIGTERM, stop)
        manager.validate()
        with Lease(manager.state / "worker.lock", True, 0):
            wake = time.monotonic() + stable_stagger(manager.node, manager.policy["stagger_seconds"])
            while not stopping:
                if time.monotonic() < wake:
                    time.sleep(min(1, wake - time.monotonic()))
                    continue
                # The admitted manifest stays pinned for this worker's lifetime.
                require(digest(load_json(args.registry)) == args.registry_sha256, "REGISTRY_CHANGED")
                try:
                    result = manager.cycle()
                    emit(result)
                except Refused as error:
                    if str(error) != "LEASE_BUSY":
                        raise
                    result = {"status": "deferred"}
                # Pressure/budget debt is retried without waiting a whole hour.
                delay = min(300, manager.policy["interval_seconds"]) if result["status"] != "ok" else manager.policy["interval_seconds"]
                wake = time.monotonic() + delay
        return 0
    emit(result)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (Refused, OSError, ValueError, KeyError, TypeError) as error:
        emit({"status": "refused", "code": str(error) if isinstance(error, Refused) else type(error).__name__}, sys.stderr)
        raise SystemExit(2)
