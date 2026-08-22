# -*- coding: utf-8 -*-
"""Essential R5.1 export, delete, backup and ledger-first restore operations."""

from __future__ import annotations

import copy
import hashlib
import json
import time
from typing import Callable, Dict, Iterable, Optional


class LifecycleOpsError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _json_bytes(value) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True,
        separators=(",", ":")).encode("utf-8")


class MemoryLifecycleRepository:
    """Small canonical repository contract for synthetic/dev K5 verification."""

    def __init__(self, clock=time.time):
        self.clock = clock
        self.state = "READY"
        self.objects: Dict[tuple, dict] = {}
        self.deletion_ledger = []
        self._seq = 0
        self._delete_receipts = {}

    def _ready(self):
        if self.state != "READY":
            raise LifecycleOpsError("RESTORE_NOT_READY")

    def _next(self):
        self._seq += 1
        return self._seq

    def create(self, account_id: str, object_id: str, content: str, **metadata):
        self._ready()
        key = (str(account_id), str(object_id))
        if key in self.objects:
            raise LifecycleOpsError("MEMORY_EXISTS")
        seq = self._next()
        item = {
            "id": str(object_id),
            "account_id": str(account_id),
            "version_id": "ver-%d" % seq,
            "content": content,
            "status": "active",
            "deleted": False,
            "updated_at": self.clock(),
            "committed_seq": seq,
        }
        item.update(copy.deepcopy(metadata))
        self.objects[key] = item
        return copy.deepcopy(item)

    def get(self, account_id: str, object_id: str):
        self._ready()
        value = self.objects.get((str(account_id), str(object_id)))
        if value is None or value.get("deleted"):
            return None
        return copy.deepcopy(value)

    def edit(self, account_id: str, object_id: str, content: str):
        self._ready()
        key = (str(account_id), str(object_id))
        current = self.objects.get(key)
        if current is None or current.get("deleted"):
            raise LifecycleOpsError("MEMORY_NOT_FOUND")
        seq = self._next()
        current["content"] = content
        current["version_id"] = "ver-%d" % seq
        current["committed_seq"] = seq
        current["updated_at"] = self.clock()
        return copy.deepcopy(current)

    def _append_ledger(self, account_id: str, object_id: str,
                       reason: str, request_id: str):
        seq = self._next()
        record = {
            "account_id": str(account_id),
            "memory_id": str(object_id),
            "deletion_seq": seq,
            "reason": str(reason),
            "request_id_hash": hashlib.sha256(
                str(request_id).encode("utf-8")).hexdigest(),
            "created_at": self.clock(),
        }
        self.deletion_ledger.append(record)
        return record

    def delete_one(self, account_id: str, object_id: str, *,
                   request_id: str, reason="USER_DELETE"):
        self._ready()
        key = (str(account_id), str(object_id))
        current = self.objects.get(key)
        if current is None:
            raise LifecycleOpsError("MEMORY_NOT_FOUND")
        if current.get("deleted"):
            return {"status": "ALREADY_DELETED",
                    "memory_id": str(object_id)}
        record = self._append_ledger(
            account_id, object_id, reason, request_id)
        current["deleted"] = True
        current["status"] = "deleted"
        current["content"] = None
        current["version_id"] = "ver-%d" % record["deletion_seq"]
        current["committed_seq"] = record["deletion_seq"]
        current["updated_at"] = self.clock()
        return {"status": "DELETED", "memory_id": str(object_id),
                "deletion_seq": record["deletion_seq"]}

    def delete_account(self, account_id: str, *, request_id: str):
        self._ready()
        receipt_key = (str(account_id), str(request_id))
        prior = self._delete_receipts.get(receipt_key)
        if prior is not None:
            result = copy.deepcopy(prior)
            result["replayed"] = True
            return result
        deleted = []
        for (owner, object_id), item in sorted(self.objects.items()):
            if owner != str(account_id) or item.get("deleted"):
                continue
            self.delete_one(
                owner, object_id, request_id=request_id,
                reason="ACCOUNT_DELETE")
            deleted.append(object_id)
        result = {
            "status": "ACCOUNT_DELETED",
            "account_id": str(account_id),
            "deleted_count": len(deleted),
            "replayed": False,
        }
        self._delete_receipts[receipt_key] = copy.deepcopy(result)
        return result

    def recallable(self, account_id: str):
        self._ready()
        values = [
            copy.deepcopy(item)
            for (owner, _), item in self.objects.items()
            if owner == str(account_id) and not item.get("deleted")
        ]
        values.sort(key=lambda item: item["id"])
        return values

    def export_jsonl(self, account_id: str):
        self._ready()
        values = [
            copy.deepcopy(item)
            for (owner, _), item in self.objects.items()
            if owner == str(account_id)
        ]
        values.sort(key=lambda item: item["id"])
        lines = [
            json.dumps(item, ensure_ascii=False, sort_keys=True,
                       separators=(",", ":"))
            for item in values
        ]
        payload = (("\n".join(lines) + "\n") if lines else "").encode("utf-8")
        return {
            "payload": payload,
            "manifest": {
                "format": "clued-jsonl/v1",
                "account_id": str(account_id),
                "count": len(values),
                "sha256": hashlib.sha256(payload).hexdigest(),
            },
        }

    @staticmethod
    def parse_jsonl(payload: bytes, manifest: dict):
        if hashlib.sha256(payload).hexdigest() != manifest.get("sha256"):
            raise LifecycleOpsError("EXPORT_CHECKSUM_MISMATCH")
        values = []
        for line in payload.decode("utf-8").splitlines():
            if line.strip():
                item = json.loads(line)
                if not isinstance(item, dict):
                    raise LifecycleOpsError("EXPORT_INVALID")
                values.append(item)
        if len(values) != int(manifest.get("count", -1)):
            raise LifecycleOpsError("EXPORT_COUNT_MISMATCH")
        return values
    def import_jsonl(self, payload: bytes, manifest: dict):
        """Restore a verified export into an empty repository."""
        self._ready()
        if self.objects:
            raise LifecycleOpsError("IMPORT_TARGET_NOT_EMPTY")
        values = self.parse_jsonl(payload, manifest)
        staged = {}
        maximum = 0
        for item in values:
            account_id = str(item.get("account_id") or "")
            if account_id != str(manifest.get("account_id") or ""):
                raise LifecycleOpsError("EXPORT_ACCOUNT_MISMATCH")
            key = (account_id, str(item["id"]))
            if key in staged:
                raise LifecycleOpsError("EXPORT_DUPLICATE_ID")
            staged[key] = copy.deepcopy(item)
            maximum = max(maximum, int(item.get("committed_seq", 0)))
        self.objects = staged
        self._seq = maximum
        return {"status": "IMPORTED", "count": len(staged)}

    def backup(self):
        self._ready()
        payload = _json_bytes({
            "format": "clued-backup/v1",
            "objects": [
                copy.deepcopy(item)
                for _, item in sorted(self.objects.items())
            ],
            "deletion_ledger": copy.deepcopy(self.deletion_ledger),
            "committed_seq": self._seq,
        })
        return {
            "payload": payload,
            "sha256": hashlib.sha256(payload).hexdigest(),
            "bytes": len(payload),
        }

    def restore(self, payload: bytes, expected_sha256: str, *,
                rebuild_index: Optional[Callable[[Iterable[dict]], object]] = None):
        if hashlib.sha256(payload).hexdigest() != str(expected_sha256):
            raise LifecycleOpsError("BACKUP_CHECKSUM_MISMATCH")
        value = json.loads(payload.decode("utf-8"))
        if value.get("format") != "clued-backup/v1":
            raise LifecycleOpsError("BACKUP_FORMAT_INVALID")
        staged_objects = {}
        for item in value.get("objects", []):
            key = (str(item["account_id"]), str(item["id"]))
            staged_objects[key] = copy.deepcopy(item)
        staged_ledger = copy.deepcopy(value.get("deletion_ledger", []))
        self.state = "RECOVERING"
        try:
            self.objects = staged_objects
            self.deletion_ledger = staged_ledger
            self._seq = int(value.get("committed_seq", 0))
            # Mandatory order: ledger replay before index build or normal read.
            for record in sorted(
                    self.deletion_ledger,
                    key=lambda item: int(item["deletion_seq"])):
                key = (str(record["account_id"]), str(record["memory_id"]))
                item = self.objects.get(key)
                if item is not None:
                    item["deleted"] = True
                    item["status"] = "deleted"
                    item["content"] = None
                    item["committed_seq"] = max(
                        int(item.get("committed_seq", 0)),
                        int(record["deletion_seq"]))
            index_result = None
            if rebuild_index is not None:
                index_result = rebuild_index(
                    [copy.deepcopy(item)
                     for _, item in sorted(self.objects.items())])
            self.state = "READY"
            return {
                "status": "RESTORED",
                "objects": len(self.objects),
                "ledger_records": len(self.deletion_ledger),
                "index_result": index_result,
            }
        except Exception:
            self.state = "RECOVERY_NEEDED"
            raise
