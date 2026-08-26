# -*- coding: utf-8 -*-
"""R5.1 ordered Outbox and cursor synchronization over synthetic/dev stores."""

from __future__ import annotations

import copy
import hashlib
import threading
import time
import uuid
from typing import Dict, Iterable, Optional

from .idempotency import CallerIdentity, MutationReceiptStore
from .security import AccessController, SecurityError


class SyncError(RuntimeError):
    def __init__(self, code, *, data=None):
        self.code = code
        self.data = data or {}
        super().__init__(code)


class Unavailable(SyncError):
    def __init__(self, code="UNAVAILABLE", *, committed=False):
        self.committed = committed
        super().__init__(code)


class CursorExpired(SyncError):
    def __init__(self):
        super().__init__("CURSOR_EXPIRED")


class ApplyCrash(SyncError):
    def __init__(self):
        super().__init__("LOCAL_APPLY_CRASH")


def _stable_id(prefix: str, request_id: str) -> str:
    digest = hashlib.sha256(
        (prefix + "\0" + str(request_id)).encode("utf-8")).hexdigest()
    return prefix + "_" + digest[:24]


class CloudSyncStore:
    """Deterministic cloud canonical used by local/dev/staging paths.

    Production adapters can implement the same methods over the K2/K3
    PostgreSQL functions.  This store is intentionally restricted to synthetic
    data and is also the K4 executable contract fixture.
    """

    def __init__(self, access: Optional[AccessController] = None,
                 receipts: Optional[MutationReceiptStore] = None,
                 clock=time.time):
        self.access = access or AccessController()
        self.receipts = receipts or MutationReceiptStore()
        self.clock = clock
        self._lock = threading.RLock()
        self._objects: Dict[tuple, dict] = {}
        self._events: Dict[str, list] = {}
        self._next_seq: Dict[str, int] = {}
        self._acks: Dict[tuple, int] = {}
        self._min_cursor: Dict[str, int] = {}

    def _authorize(self, caller: CallerIdentity, scope: str):
        return self.access.require(caller, scope)

    def _event(self, account_id: str, item: dict, kind: str):
        seq = self._next_seq.get(account_id, 0) + 1
        self._next_seq[account_id] = seq
        event = {
            "seq": seq,
            "kind": kind,
            "account_id": account_id,
            "memory_id": item["memory_id"],
            "version_id": item["version_id"],
            "content": item.get("content"),
            "deleted": bool(item.get("deleted")),
            "required_scope": item.get("required_scope"),
            "updated_at": item["updated_at"],
        }
        self._events.setdefault(account_id, []).append(event)
        return event

    def _apply_mutation(self, caller: CallerIdentity, operation: str,
                        request_id: str, payload: dict):
        with self._lock:
            memory_id = str(payload.get("memory_id") or "")
            if not memory_id:
                raise SyncError("MEMORY_ID_REQUIRED")
            key = (caller.account_id, memory_id)
            current = self._objects.get(key)
            base = payload.get("base_version_id")
            required_scope = payload.get("required_scope")
            if required_scope:
                self._authorize(caller, str(required_scope))

            if operation == "CREATE":
                if current is not None:
                    if current.get("deleted"):
                        raise SyncError("TOMBSTONE_BLOCKED")
                    raise SyncError("MEMORY_EXISTS")
                if base is not None:
                    raise SyncError("BASE_FORBIDDEN")
                kind = "CREATED"
                deleted = False
            else:
                if current is None:
                    raise SyncError("MEMORY_NOT_FOUND")
                if current.get("deleted"):
                    if operation == "DELETE":
                        return {
                            "status": "ALREADY_DELETED",
                            "memory_id": memory_id,
                            "version_id": current["version_id"],
                            "committed_seq": current["committed_seq"],
                        }
                    raise SyncError("TOMBSTONE_BLOCKED")
                if not base:
                    raise SyncError("BASE_REQUIRED")
                if base != current["version_id"]:
                    return {
                        "status": "CONFLICT",
                        "memory_id": memory_id,
                        "base": base,
                        "ours": {
                            "operation": operation,
                            "content_hash": hashlib.sha256(
                                str(payload.get("content") or "").encode(
                                    "utf-8")).hexdigest(),
                        },
                        "theirs": {
                            "version_id": current["version_id"],
                            "content_hash": hashlib.sha256(
                                str(current.get("content") or "").encode(
                                    "utf-8")).hexdigest(),
                        },
                    }
                kind = "DELETED" if operation == "DELETE" else "UPDATED"
                deleted = operation == "DELETE"

            version_id = _stable_id("ver", request_id)
            item = {
                "account_id": caller.account_id,
                "memory_id": memory_id,
                "version_id": version_id,
                "content": None if deleted else payload.get("content"),
                "deleted": deleted,
                "required_scope": required_scope or (
                    current.get("required_scope") if current else None),
                "updated_at": self.clock(),
                "created_by_binding_id": caller.binding_id,
                "created_by_device_id": caller.device_id,
            }
            event = self._event(caller.account_id, item, kind)
            item["committed_seq"] = event["seq"]
            self._objects[key] = item
            return {
                "status": kind,
                "memory_id": memory_id,
                "version_id": version_id,
                "committed_seq": event["seq"],
            }

    def mutate(self, caller: CallerIdentity, operation: str, request_id: str,
               payload: dict, *, drop_response=False):
        operation = str(operation or "").upper()
        if operation not in ("CREATE", "UPDATE", "DELETE"):
            raise SyncError("OPERATION_INVALID")
        self._authorize(caller, "memory:write")
        receipt = self.receipts.execute(
            caller, operation, request_id, payload,
            lambda: self._apply_mutation(
                caller, operation, request_id, payload))
        if drop_response:
            raise Unavailable("RESPONSE_LOST", committed=True)
        result = copy.deepcopy(receipt["result"])
        result["replayed"] = receipt["replayed"]
        return result

    def pull(self, caller: CallerIdentity, cursor: int):
        self._authorize(caller, "memory:read")
        cursor = int(cursor or 0)
        minimum = self._min_cursor.get(caller.account_id, 0)
        if cursor < minimum:
            raise CursorExpired()
        events = []
        for event in self._events.get(caller.account_id, []):
            if event["seq"] <= cursor:
                continue
            if self.access.can_read_object(caller, event):
                events.append(copy.deepcopy(event))
        return {
            "events": events,
            "cursor": self._next_seq.get(caller.account_id, 0),
            "source": "cloud_incremental",
        }

    def full_snapshot(self, caller: CallerIdentity):
        self._authorize(caller, "memory:read")
        items = []
        for (account_id, _), item in self._objects.items():
            if account_id != caller.account_id:
                continue
            if self.access.can_read_object(caller, item):
                items.append(copy.deepcopy(item))
        items.sort(key=lambda item: item["memory_id"])
        return {
            "items": items,
            "cursor": self._next_seq.get(caller.account_id, 0),
            "source": "cloud_full_snapshot",
        }

    def acknowledge(self, caller: CallerIdentity, cursor: int):
        self._authorize(caller, "memory:read")
        maximum = self._next_seq.get(caller.account_id, 0)
        value = min(max(0, int(cursor)), maximum)
        self._acks[caller.key()] = value
        return value

    def expire_cursors_before(self, account_id: str, cursor: int):
        self._min_cursor[account_id] = max(
            self._min_cursor.get(account_id, 0), int(cursor))

    def object(self, account_id: str, memory_id: str):
        value = self._objects.get((account_id, memory_id))
        return copy.deepcopy(value) if value else None

    def event_count(self, account_id: str):
        return len(self._events.get(account_id, []))


class DeviceReplica:
    """One isolated logical device profile with an ordered local Outbox."""

    def __init__(self, caller: CallerIdentity, cloud: CloudSyncStore, *,
                 protected_store=None, clock=time.time):
        self.caller = caller
        self.cloud = cloud
        self.protected_store = protected_store
        self.clock = clock
        self.objects: Dict[str, dict] = {}
        self.outbox = []
        self.conflicts = []
        self.cursor = 0
        self.last_sync_at = None
        self.state = "ONLINE"
        self.degradation_reason = None
        self._outbox_seq = 0

    def _persist(self):
        if self.protected_store is None:
            return
        self.protected_store.save({
            "caller": {
                "account_id": self.caller.account_id,
                "binding_id": self.caller.binding_id,
                "device_id": self.caller.device_id,
            },
            "objects": self.objects,
            "outbox": self.outbox,
            "conflicts": self.conflicts,
            "cursor": self.cursor,
            "last_sync_at": self.last_sync_at,
        })

    def queue(self, operation: str, memory_id: str, *, content=None,
              required_scope=None, request_id=None):
        operation = str(operation or "").upper()
        if operation not in ("CREATE", "UPDATE", "DELETE"):
            raise SyncError("OPERATION_INVALID")
        current = self.objects.get(memory_id)
        if operation != "CREATE" and current is None:
            raise SyncError("LOCAL_MEMORY_NOT_FOUND")
        self._outbox_seq += 1
        request_id = request_id or str(uuid.uuid4())
        base = current.get("version_id") if current else None
        entry = {
            "sequence": self._outbox_seq,
            "request_id": request_id,
            "operation": operation,
            "payload": {
                "memory_id": memory_id,
                "base_version_id": base,
                "content": content,
                "required_scope": required_scope or (
                    current.get("required_scope") if current else None),
            },
            "state": "PENDING",
        }
        self.outbox.append(entry)
        self.objects[memory_id] = {
            "account_id": self.caller.account_id,
            "memory_id": memory_id,
            "version_id": base,
            "content": None if operation == "DELETE" else content,
            "deleted": operation == "DELETE",
            "required_scope": entry["payload"]["required_scope"],
            "pending": True,
        }
        self._persist()
        return request_id

    def _apply_event(self, event: dict):
        self.objects[event["memory_id"]] = {
            "account_id": event["account_id"],
            "memory_id": event["memory_id"],
            "version_id": event["version_id"],
            "content": event.get("content"),
            "deleted": bool(event.get("deleted")),
            "required_scope": event.get("required_scope"),
            "pending": False,
        }

    def _apply_snapshot(self, snapshot: dict):
        self.objects = {}
        for item in snapshot["items"]:
            self.objects[item["memory_id"]] = {
                **item, "pending": False,
            }
        self.cursor = snapshot["cursor"]

    def sync(self, *, drop_response_for=None, crash_after_event=None):
        try:
            self.cloud.access.require(self.caller, "memory:read")
            self.cloud.access.require(self.caller, "memory:write")
        except SecurityError:
            self.state = "LOCKED"
            self.degradation_reason = "DENIED_SECURITY"
            self._persist()
            raise

        uploaded = 0
        for entry in sorted(list(self.outbox), key=lambda item: item["sequence"]):
            try:
                result = self.cloud.mutate(
                    self.caller, entry["operation"], entry["request_id"],
                    entry["payload"],
                    drop_response=entry["request_id"] == drop_response_for)
            except Unavailable as exc:
                self.state = "DEGRADED"
                self.degradation_reason = exc.code
                self._persist()
                return {
                    "state": self.state, "uploaded": uploaded,
                    "outbox": len(self.outbox), "reason": exc.code,
                }
            except SyncError as exc:
                if exc.code == "TOMBSTONE_BLOCKED":
                    conflict = {
                        "status": "TOMBSTONE_BLOCKED",
                        "request_id": entry["request_id"],
                        "memory_id": entry["payload"]["memory_id"],
                    }
                    entry["state"] = "CONFLICT"
                    self.conflicts.append(conflict)
                    break
                raise
            if result["status"] == "CONFLICT":
                entry["state"] = "CONFLICT"
                self.conflicts.append(result)
                break
            self.outbox = [
                item for item in self.outbox
                if item["request_id"] != entry["request_id"]]
            uploaded += 1
            local = self.objects.get(result["memory_id"], {})
            local.update({
                "version_id": result["version_id"],
                "pending": False,
                "deleted": result["status"] in (
                    "DELETED", "ALREADY_DELETED"),
            })
            self.objects[result["memory_id"]] = local

        recovered = False
        try:
            pulled = self.cloud.pull(self.caller, self.cursor)
        except Unavailable as exc:
            self.state = "DEGRADED"
            self.degradation_reason = exc.code
            self._persist()
            return {
                "state": self.state,
                "uploaded": uploaded,
                "outbox": len(self.outbox),
                "reason": exc.code,
            }
        except CursorExpired:
            pulled = self.cloud.full_snapshot(self.caller)
            self._apply_snapshot(pulled)
            recovered = True
        if not recovered:
            applied = 0
            for event in pulled["events"]:
                self._apply_event(event)
                applied += 1
                if crash_after_event is not None and applied == crash_after_event:
                    self._persist()
                    raise ApplyCrash()
                self.cursor = event["seq"]
        self.cloud.acknowledge(self.caller, self.cursor)
        self.last_sync_at = self.clock()
        self.state = "ONLINE"
        self.degradation_reason = None
        self._persist()
        return {
            "state": self.state,
            "uploaded": uploaded,
            "outbox": len(self.outbox),
            "cursor": self.cursor,
            "source": pulled["source"],
            "conflicts": len(self.conflicts),
        }

    def local_recall(self, query: str):
        """Scope-preserving offline fallback; never expands cloud authority."""
        grant = self.cloud.access.require(self.caller, "memory:read")
        terms = set(str(query or "").lower().split())
        results = []
        for item in self.objects.values():
            if item.get("deleted"):
                continue
            required = item.get("required_scope")
            if required and required not in grant.scopes:
                continue
            content = str(item.get("content") or "")
            if not terms or terms & set(content.lower().split()):
                results.append(copy.deepcopy(item))
        results.sort(key=lambda item: item["memory_id"])
        return results

    def status(self):
        return {
            "state": self.state,
            "source": "local_replica" if self.state == "DEGRADED" else "cloud",
            "cursor": self.cursor,
            "outbox_count": len(self.outbox),
            "last_sync_at": self.last_sync_at,
            "degradation_reason": self.degradation_reason,
            "conflict_count": len(self.conflicts),
        }
