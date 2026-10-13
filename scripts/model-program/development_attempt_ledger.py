"""Durable one-attempt accounting, using the existing M1 create-only rule.

This module does not issue a Profile or verify permission. The admitted fixed
caller supplies its already verified Profile identity. A failed/partial write
leaves the attempt spent. Only a new, separately authorized Profile can retry.
The ledger must be an existing private namespace verified by that caller.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat


SHA256 = re.compile(r"[0-9a-f]{64}\Z")
PROFILE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
TASK_ID = "1502fd80-8ff8-4adc-b4f5-da6d462f4f8a"
FIELDS = {"profile_id", "profile_sha256", "request_sha256", "plan_sha256",
          "approval_record_id", "approval_version", "approval_receipt_id",
          "task_id", "reserved_at"}


class AttemptLedgerError(ValueError):
    pass


def require(ok, code):
    if not ok:
        raise AttemptLedgerError(code)


def _root(directory):
    path = Path(directory)
    require(path.is_absolute() and not str(path).startswith(("\\\\", "//")),
            "LEDGER_LOCAL_ABSOLUTE_REQUIRED")
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and not path.is_symlink()
            and not (getattr(info, "st_file_attributes", 0) & 0x400),
            "LEDGER_REPARSE_OR_NON_DIRECTORY")
    require(path.resolve() == path, "LEDGER_CANONICAL_PATH_REQUIRED")
    return path, (info.st_dev, info.st_ino)


def _validate(reservation):
    require(type(reservation) is dict and set(reservation) == FIELDS,
            "RESERVATION_FIELDS")
    require(type(reservation["profile_id"]) is str
            and PROFILE_ID.fullmatch(reservation["profile_id"]), "PROFILE_ID")
    require(not reservation["profile_id"].lower().startswith("m1-"),
            "TERMINAL_M1_PROFILE_FORBIDDEN")
    for key in ("profile_sha256", "request_sha256", "plan_sha256"):
        require(type(reservation[key]) is str and SHA256.fullmatch(reservation[key]),
                "RESERVATION_DIGEST")
    require(reservation["task_id"] == TASK_ID, "TASK_ID")
    require(type(reservation["approval_version"]) is int
            and reservation["approval_version"] > 0, "APPROVAL_VERSION")
    for key in ("approval_record_id", "approval_receipt_id", "reserved_at"):
        require(type(reservation[key]) is str and 0 < len(reservation[key]) <= 128,
                "RESERVATION_REFERENCE")


def reserve_once(directory, reservation, *, before_create):
    """Return a fsynced reservation; an existing file always refuses launch.

    File name depends on Profile ID alone, so changing a request/plan/digest
    cannot reset its attempt. No read/update/delete/recovery-to-unused exists.
    The caller must still prove namespace ACL and serialize runtime launches.
    """
    require(callable(before_create), "HOST_STOP_GUARD_REQUIRED")
    _validate(reservation)
    root, identity = _root(directory)
    name = hashlib.sha256(reservation["profile_id"].encode("utf-8")).hexdigest()
    target = root / (name + ".spent.json")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    flags |= getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    # Metadata resolution can itself return late. Recheck after it, directly
    # before the first effect; an already-started OS call remains uncertain.
    require(before_create() is None, "HOST_STOP_GUARD_RESULT")
    try:
        fd = os.open(target, flags, 0o600)
    except FileExistsError as exc:
        raise AttemptLedgerError("ATTEMPT_ALREADY_SPENT_OR_UNCERTAIN") from exc
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
                "RESERVATION_OBJECT_INVALID")
        require(_root(root)[1] == identity, "LEDGER_IDENTITY_CHANGED")
        raw = (json.dumps({**reservation, "schema": "clued.model-attempt-reservation/1",
                          "status": "SPENT_BEFORE_MODEL_LOAD", "max_attempts": 1,
                          "retries_allowed": False}, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
        position = 0
        while position < len(raw):
            written = os.write(fd, raw[position:])
            require(type(written) is int and written > 0, "RESERVATION_WRITE_FAILED")
            position += written
        os.fsync(fd)
        require(os.fstat(fd).st_size == len(raw), "RESERVATION_SIZE_CHANGED")
        require(_root(root)[1] == identity, "LEDGER_IDENTITY_CHANGED")
    finally:
        # Even a close/fsync/write failure retains the create-only spent file.
        os.close(fd)
    return {"path": str(target), "bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "status": "SPENT_BEFORE_MODEL_LOAD"}
