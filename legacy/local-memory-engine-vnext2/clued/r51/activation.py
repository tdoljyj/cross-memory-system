# -*- coding: utf-8 -*-
"""Transactional R5.1 installation/update/repair lifecycle."""

from __future__ import annotations

import hashlib
import ctypes
import json
import os
import shutil
import stat
import tempfile
import time
import uuid
from typing import Callable, Optional


BEGIN_MARKER = "# BEGIN CLUED MANAGED"
END_MARKER = "# END CLUED MANAGED"
TRANSACTION_STATES = (
    "STAGED", "COMMITTED", "ROLLED_BACK", "FINALIZED", "RECOVERY_NEEDED",
)


class ActivationError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class SimulatedCrash(RuntimeError):
    """Test-only crash boundary; transaction remains recoverable."""


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _atomic_json(path: str, value: dict):
    parent = os.path.dirname(path)
    os.makedirs(parent, mode=0o700, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".clued-json-", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)

def _verify_windows_owner_acl(path: str):
    """Require current-user ownership and reject broad writable ACEs."""
    from ctypes import wintypes

    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    void_pointer = ctypes.c_void_p
    void_pointer_pointer = ctypes.POINTER(void_pointer)
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [void_pointer]
    kernel32.LocalFree.restype = void_pointer
    advapi32.GetNamedSecurityInfoW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
        void_pointer_pointer, void_pointer_pointer,
        void_pointer_pointer, void_pointer_pointer,
        void_pointer_pointer]
    advapi32.GetNamedSecurityInfoW.restype = wintypes.DWORD
    advapi32.OpenProcessToken.argtypes = [
        wintypes.HANDLE, wintypes.DWORD,
        ctypes.POINTER(wintypes.HANDLE)]
    advapi32.OpenProcessToken.restype = wintypes.BOOL
    advapi32.GetTokenInformation.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, void_pointer,
        wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    advapi32.GetTokenInformation.restype = wintypes.BOOL
    advapi32.EqualSid.argtypes = [void_pointer, void_pointer]
    advapi32.EqualSid.restype = wintypes.BOOL
    advapi32.CreateWellKnownSid.argtypes = [
        wintypes.DWORD, void_pointer, void_pointer,
        ctypes.POINTER(wintypes.DWORD)]
    advapi32.CreateWellKnownSid.restype = wintypes.BOOL
    advapi32.GetAce.argtypes = [
        void_pointer, wintypes.DWORD, void_pointer_pointer]
    advapi32.GetAce.restype = wintypes.BOOL
    owner = ctypes.c_void_p()
    dacl = ctypes.c_void_p()
    descriptor = ctypes.c_void_p()
    token = wintypes.HANDLE()
    OWNER_SECURITY_INFORMATION = 0x00000001
    DACL_SECURITY_INFORMATION = 0x00000004
    SE_FILE_OBJECT = 1
    TOKEN_QUERY = 0x0008
    TOKEN_USER_CLASS = 1

    status = advapi32.GetNamedSecurityInfoW(
        ctypes.c_wchar_p(path), SE_FILE_OBJECT,
        OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        ctypes.byref(owner), None, ctypes.byref(dacl), None,
        ctypes.byref(descriptor))
    if status != 0 or not owner.value or not descriptor.value:
        raise ActivationError("TARGET_SECURITY_DESCRIPTOR_REJECTED")
    try:
        if not advapi32.OpenProcessToken(
                kernel32.GetCurrentProcess(), TOKEN_QUERY,
                ctypes.byref(token)):
            raise ActivationError("TARGET_OWNER_CHECK_FAILED")
        needed = wintypes.DWORD()
        advapi32.GetTokenInformation(
            token, TOKEN_USER_CLASS, None, 0, ctypes.byref(needed))
        buffer = ctypes.create_string_buffer(needed.value)
        if not advapi32.GetTokenInformation(
                token, TOKEN_USER_CLASS, buffer, needed.value,
                ctypes.byref(needed)):
            raise ActivationError("TARGET_OWNER_CHECK_FAILED")

        class SID_AND_ATTRIBUTES(ctypes.Structure):
            _fields_ = [
                ("Sid", ctypes.c_void_p),
                ("Attributes", wintypes.DWORD),
            ]

        class TOKEN_USER(ctypes.Structure):
            _fields_ = [("User", SID_AND_ATTRIBUTES)]

        user = TOKEN_USER.from_buffer(buffer)
        if not advapi32.EqualSid(owner, user.User.Sid):
            raise ActivationError("TARGET_OWNER_REJECTED")
        if not dacl.value:
            raise ActivationError("TARGET_ACL_REJECTED")

        class ACL(ctypes.Structure):
            _fields_ = [
                ("AclRevision", ctypes.c_ubyte),
                ("Sbz1", ctypes.c_ubyte),
                ("AclSize", wintypes.WORD),
                ("AceCount", wintypes.WORD),
                ("Sbz2", wintypes.WORD),
            ]

        class ACE_HEADER(ctypes.Structure):
            _fields_ = [
                ("AceType", ctypes.c_ubyte),
                ("AceFlags", ctypes.c_ubyte),
                ("AceSize", wintypes.WORD),
            ]

        class ACCESS_ALLOWED_ACE(ctypes.Structure):
            _fields_ = [
                ("Header", ACE_HEADER),
                ("Mask", wintypes.DWORD),
                ("SidStart", wintypes.DWORD),
            ]

        broad_sids = []
        for sid_type in (1, 17, 27, 28):  # Everyone/Auth Users/Users/Guests
            sid_buffer = ctypes.create_string_buffer(68)
            sid_size = wintypes.DWORD(len(sid_buffer))
            if advapi32.CreateWellKnownSid(
                    sid_type, None, sid_buffer, ctypes.byref(sid_size)):
                broad_sids.append(sid_buffer)
        acl = ctypes.cast(dacl, ctypes.POINTER(ACL)).contents
        broad_write_mask = (
            0x00000002 | 0x00000004 | 0x00000010 | 0x00000100
            | 0x00010000 | 0x00040000 | 0x00080000
            | 0x10000000 | 0x40000000)
        for index in range(acl.AceCount):
            ace_pointer = ctypes.c_void_p()
            if not advapi32.GetAce(dacl, index, ctypes.byref(ace_pointer)):
                raise ActivationError("TARGET_ACL_CHECK_FAILED")
            header = ACE_HEADER.from_address(ace_pointer.value)
            if header.AceType != 0:  # ACCESS_ALLOWED_ACE_TYPE
                continue
            ace = ACCESS_ALLOWED_ACE.from_address(ace_pointer.value)
            sid_pointer = ctypes.c_void_p(
                ace_pointer.value + ACCESS_ALLOWED_ACE.SidStart.offset)
            if ace.Mask & broad_write_mask:
                for broad_sid in broad_sids:
                    if advapi32.EqualSid(sid_pointer, broad_sid):
                        raise ActivationError("TARGET_ACL_REJECTED")
    finally:
        if token:
            kernel32.CloseHandle(token)
        if descriptor:
            kernel32.LocalFree(descriptor)

def _target_snapshot(path: str):
    if not os.path.lexists(path):
        return {"exists": False}
    info = os.lstat(path)
    attributes = getattr(info, "st_file_attributes", 0)
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    if os.path.islink(path) or attributes & reparse:
        raise ActivationError("LINK_TARGET_REJECTED")
    if not stat.S_ISREG(info.st_mode):
        raise ActivationError("NON_REGULAR_TARGET_REJECTED")
    if getattr(info, "st_nlink", 1) != 1:
        raise ActivationError("UNEXPECTED_LINK_COUNT")
    if os.name == "nt":
        _verify_windows_owner_acl(path)
    else:
        if info.st_uid != os.geteuid():
            raise ActivationError("TARGET_OWNER_REJECTED")
        if stat.S_IMODE(info.st_mode) & 0o022:
            raise ActivationError("TARGET_ACL_REJECTED")
    with open(path, "rb") as handle:
        content = handle.read()
    return {
        "exists": True,
        "device": info.st_dev,
        "inode": info.st_ino,
        "size": info.st_size,
        "sha256": _sha(content),
        "attributes": attributes,
    }


def render_marker(existing: str, managed: Optional[dict]):
    """Replace/remove only Clued's marker-fenced block."""
    lines = str(existing or "").splitlines()
    begin = [index for index, line in enumerate(lines)
             if line.strip() == BEGIN_MARKER]
    end = [index for index, line in enumerate(lines)
           if line.strip() == END_MARKER]
    if len(begin) != len(end) or len(begin) > 1:
        raise ActivationError("MARKER_LAYOUT_INVALID")
    if begin and begin[0] >= end[0]:
        raise ActivationError("MARKER_LAYOUT_INVALID")
    block = []
    if managed is not None:
        body = json.dumps(
            managed, ensure_ascii=False, sort_keys=True,
            separators=(",", ":"))
        block = [BEGIN_MARKER, body, END_MARKER]
    if begin:
        result = lines[:begin[0]] + block + lines[end[0] + 1:]
    else:
        result = list(lines)
        if block:
            if result and result[-1] != "":
                result.append("")
            result.extend(block)
    while result and result[-1] == "":
        result.pop()
    return ("\n".join(result) + "\n") if result else ""


def _pid_alive(pid: int):
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class LifecycleLock:
    """Exclusive lock with bounded stale-owner recovery."""

    def __init__(self, path: str, *, stale_seconds=300, clock=time.time):
        self.path = path
        self.stale_seconds = float(stale_seconds)
        self.clock = clock
        self.token = None

    def acquire(self):
        os.makedirs(os.path.dirname(self.path), mode=0o700, exist_ok=True)
        for _ in range(2):
            token = uuid.uuid4().hex
            payload = json.dumps({
                "pid": os.getpid(), "created_at": self.clock(),
                "token": token}, sort_keys=True).encode("utf-8")
            try:
                fd = os.open(
                    self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            except FileExistsError:
                try:
                    with open(self.path, "r", encoding="utf-8") as handle:
                        current = json.load(handle)
                    stale = (
                        self.clock() - float(current.get("created_at", 0))
                        > self.stale_seconds
                        and not _pid_alive(int(current.get("pid", 0))))
                except Exception:
                    stale = True
                if not stale:
                    raise ActivationError("LIFECYCLE_LOCKED")
                os.remove(self.path)
                continue
            with os.fdopen(fd, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            self.token = token
            return token
        raise ActivationError("LIFECYCLE_LOCKED")

    def release(self):
        if not self.token or not os.path.exists(self.path):
            return
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                current = json.load(handle)
            if current.get("token") == self.token:
                os.remove(self.path)
        finally:
            self.token = None


class TransactionalInstallationEngine:
    """One state machine shared by CLI and AI-conversation entry points."""

    def __init__(self, root: str, *, target_name="agent-config.txt",
                 replace: Callable[[str, str], None] = os.replace,
                 on_staged: Optional[Callable[[dict], None]] = None,
                 clock=time.time):
        self.root = os.path.abspath(root)
        self.target = os.path.join(self.root, target_name)
        self.private = os.path.join(self.root, ".clued", "lifecycle")
        self.journal = os.path.join(self.private, "transaction.json")
        self.lock = LifecycleLock(
            os.path.join(self.private, "lifecycle.lock"), clock=clock)
        self.replace = replace
        self.on_staged = on_staged
        self.clock = clock

    def _read_target(self):
        snapshot = _target_snapshot(self.target)
        if not snapshot["exists"]:
            return "", snapshot
        with open(self.target, "r", encoding="utf-8") as handle:
            return handle.read(), snapshot

    def _write_stage(self, transaction_id: str, desired: bytes):
        os.makedirs(self.private, mode=0o700, exist_ok=True)
        path = os.path.join(self.private, transaction_id + ".stage")
        with open(path, "wb") as handle:
            handle.write(desired)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(path, 0o600)
        return path

    def _backup(self, transaction_id: str, snapshot: dict):
        if not snapshot["exists"]:
            return None
        path = os.path.join(self.private, transaction_id + ".backup")
        shutil.copyfile(self.target, path)
        os.chmod(path, 0o600)
        with open(path, "r+b") as handle:
            os.fsync(handle.fileno())
        return path

    def _journal(self, value):
        if value["state"] not in TRANSACTION_STATES:
            raise ActivationError("TRANSACTION_STATE_INVALID")
        _atomic_json(self.journal, value)

    def _rollback(self, transaction):
        backup = transaction.get("backup_path")
        if backup and os.path.isfile(backup):
            os.replace(backup, self.target)
        elif not transaction["target_before"]["exists"]:
            if os.path.isfile(self.target):
                os.remove(self.target)
        transaction["state"] = "ROLLED_BACK"
        transaction["rolled_back_at"] = self.clock()
        self._journal(transaction)

    def _desired(self, action: str, managed: Optional[dict]):
        current, snapshot = self._read_target()
        if action == "uninstall":
            rendered = render_marker(current, None)
        else:
            rendered = render_marker(current, managed or {})
        return rendered.encode("utf-8"), snapshot

    def execute(self, action: str, *, managed: Optional[dict] = None,
                simulate_crash_after_commit=False):
        action = str(action or "").lower()
        if action not in (
                "install", "update", "repair", "disable", "enable",
                "uninstall"):
            raise ActivationError("LIFECYCLE_ACTION_INVALID")
        self.lock.acquire()
        transaction = None
        try:
            desired, target_before = self._desired(action, managed)
            if target_before["exists"] and target_before["sha256"] == _sha(desired):
                return {
                    "state": "FINALIZED", "action": action,
                    "idempotent": True, "target_sha256": _sha(desired)}
            transaction_id = uuid.uuid4().hex
            stage_path = self._write_stage(transaction_id, desired)
            transaction = {
                "transaction_id": transaction_id,
                "state": "STAGED",
                "action": action,
                "stage_path": stage_path,
                "backup_path": None,
                "target_path": self.target,
                "target_before": target_before,
                "desired_sha256": _sha(desired),
                "created_at": self.clock(),
            }
            self._journal(transaction)
            if self.on_staged:
                self.on_staged(copy_public(transaction))
            if _target_snapshot(self.target) != target_before:
                raise ActivationError("TARGET_IDENTITY_CHANGED")
            os.makedirs(os.path.dirname(self.target), exist_ok=True)
            transaction["backup_path"] = self._backup(
                transaction_id, target_before)
            self._journal(transaction)
            self.replace(stage_path, self.target)
            target_after = _target_snapshot(self.target)
            if target_after.get("sha256") != transaction["desired_sha256"]:
                raise ActivationError("COMMIT_IDENTITY_MISMATCH")
            transaction["state"] = "COMMITTED"
            transaction["committed_at"] = self.clock()
            self._journal(transaction)
            if simulate_crash_after_commit:
                raise SimulatedCrash("SIMULATED_CRASH")
            transaction["state"] = "FINALIZED"
            transaction["finalized_at"] = self.clock()
            self._journal(transaction)
            return {
                "state": "FINALIZED", "action": action,
                "idempotent": False,
                "target_sha256": target_after["sha256"],
                "transaction_id": transaction_id,
            }
        except SimulatedCrash:
            raise
        except Exception as exc:
            if transaction is not None:
                try:
                    self._rollback(transaction)
                except Exception:
                    transaction["state"] = "RECOVERY_NEEDED"
                    self._journal(transaction)
                    raise ActivationError("RECOVERY_NEEDED")
            if isinstance(exc, ActivationError):
                raise
            raise ActivationError("TRANSACTION_ROLLED_BACK")
        finally:
            self.lock.release()

    def recover(self):
        self.lock.acquire()
        try:
            if not os.path.isfile(self.journal):
                return {"state": "FINALIZED", "recovered": False}
            with open(self.journal, "r", encoding="utf-8") as handle:
                transaction = json.load(handle)
            state = transaction.get("state")
            if state == "FINALIZED":
                return {"state": state, "recovered": False}
            if state == "COMMITTED":
                current = _target_snapshot(self.target)
                if current.get("sha256") == transaction.get("desired_sha256"):
                    transaction["state"] = "FINALIZED"
                    transaction["recovered_at"] = self.clock()
                    self._journal(transaction)
                    return {"state": "FINALIZED", "recovered": True}
            self._rollback(transaction)
            return {"state": "ROLLED_BACK", "recovered": True}
        finally:
            self.lock.release()


def copy_public(transaction: dict):
    """Content-free transaction snapshot for callbacks and Doctor."""
    return {
        key: transaction.get(key) for key in (
            "transaction_id", "state", "action", "desired_sha256",
            "created_at")
    }
