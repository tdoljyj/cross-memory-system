# -*- coding: utf-8 -*-
"""Content-free mutation receipts used by R5.1 sync replay.

Receipt identity binds account, Binding, Device, request id, method and
canonical payload hash. The store intentionally never retains a request body.
"""

from __future__ import annotations

import copy
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Tuple

from clued.cloud_data.lifecycle import canonical_request_hash


class ReceiptError(RuntimeError):
    """Base class for content-free receipt failures."""

    code = "CLD-R51-RECEIPT-ERROR"

    def __init__(self, code: Optional[str] = None):
        self.code = code or self.code
        super().__init__(self.code)


class IdempotencyConflict(ReceiptError):
    code = "IDEMPOTENCY_CONFLICT"


class ReceiptPending(ReceiptError):
    code = "IDEMPOTENCY_PENDING"


@dataclass(frozen=True)
class CallerIdentity:
    account_id: str
    binding_id: str
    device_id: str

    def key(self) -> Tuple[str, str, str]:
        return (str(self.account_id), str(self.binding_id), str(self.device_id))


@dataclass
class _Receipt:
    caller: CallerIdentity
    request_id: str
    method: str
    payload_hash: str
    state: str
    created_at: float
    completed_at: Optional[float] = None
    result: Any = None

    def public(self) -> Dict[str, Any]:
        return {
            "account_id": self.caller.account_id,
            "binding_id": self.caller.binding_id,
            "device_id": self.caller.device_id,
            "request_id": self.request_id,
            "method": self.method,
            "payload_hash": self.payload_hash,
            "state": self.state,
            "created_at": self.created_at,
            "completed_at": self.completed_at,
        }


class MutationReceiptStore:
    """Thread-safe idempotency ledger with offline replay retention."""

    def __init__(self, *, retention_seconds: int = 30 * 24 * 3600,
                 max_offline_replay_seconds: int = 14 * 24 * 3600,
                 pending_wait_seconds: float = 10.0,
                 clock: Callable[[], float] = time.time):
        if retention_seconds < max_offline_replay_seconds:
            raise ValueError(
                "receipt retention is shorter than offline replay horizon")
        self.retention_seconds = int(retention_seconds)
        self.max_offline_replay_seconds = int(max_offline_replay_seconds)
        self.pending_wait_seconds = float(pending_wait_seconds)
        self.clock = clock
        self._condition = threading.Condition(threading.RLock())
        self._records: Dict[Tuple[str, str, str, str], _Receipt] = {}

    @staticmethod
    def _normalize_method(method: str) -> str:
        value = str(method or "").strip().upper()
        if not value or len(value) > 80:
            raise ReceiptError("IDEMPOTENCY_METHOD_INVALID")
        return value

    @staticmethod
    def _normalize_request_id(request_id: str) -> str:
        value = str(request_id or "").strip()
        if len(value) < 8 or len(value) > 200:
            raise ReceiptError("IDEMPOTENCY_REQUEST_ID_INVALID")
        return value

    def _key(self, caller: CallerIdentity, request_id: str):
        return caller.key() + (request_id,)

    @staticmethod
    def _assert_same(receipt: _Receipt, method: str,
                     payload_hash: str) -> None:
        if receipt.method != method or receipt.payload_hash != payload_hash:
            raise IdempotencyConflict()

    def reserve(self, caller: CallerIdentity, method: str, request_id: str,
                payload: Any) -> Dict[str, Any]:
        """Reserve without retaining payload; useful for lost-response tests."""
        method = self._normalize_method(method)
        request_id = self._normalize_request_id(request_id)
        payload_hash = canonical_request_hash(payload)
        key = self._key(caller, request_id)
        with self._condition:
            existing = self._records.get(key)
            if existing is not None:
                self._assert_same(existing, method, payload_hash)
                return {"state": existing.state,
                        "replayed": existing.state == "COMMITTED"}
            self._records[key] = _Receipt(
                caller=caller, request_id=request_id, method=method,
                payload_hash=payload_hash, state="PENDING",
                created_at=self.clock())
            return {"state": "PENDING", "replayed": False}

    def commit(self, caller: CallerIdentity, request_id: str,
               result: Any) -> Dict[str, Any]:
        request_id = self._normalize_request_id(request_id)
        key = self._key(caller, request_id)
        with self._condition:
            receipt = self._records.get(key)
            if receipt is None:
                raise ReceiptError("IDEMPOTENCY_RECEIPT_MISSING")
            if receipt.state == "COMMITTED":
                return {"result": copy.deepcopy(receipt.result),
                        "replayed": True}
            receipt.state = "COMMITTED"
            receipt.completed_at = self.clock()
            receipt.result = copy.deepcopy(result)
            self._condition.notify_all()
            return {"result": copy.deepcopy(result), "replayed": False}

    def abandon(self, caller: CallerIdentity, request_id: str) -> None:
        """Drop failed uncommitted work so a transient operation may retry."""
        key = self._key(caller, self._normalize_request_id(request_id))
        with self._condition:
            receipt = self._records.get(key)
            if receipt is not None and receipt.state == "PENDING":
                del self._records[key]
                self._condition.notify_all()

    def execute(self, caller: CallerIdentity, method: str, request_id: str,
                payload: Any, mutation: Callable[[], Any]) -> Dict[str, Any]:
        method = self._normalize_method(method)
        request_id = self._normalize_request_id(request_id)
        payload_hash = canonical_request_hash(payload)
        key = self._key(caller, request_id)
        owner = False
        deadline = time.monotonic() + self.pending_wait_seconds
        with self._condition:
            while True:
                receipt = self._records.get(key)
                if receipt is None:
                    self._records[key] = _Receipt(
                        caller=caller, request_id=request_id, method=method,
                        payload_hash=payload_hash, state="PENDING",
                        created_at=self.clock())
                    owner = True
                    break
                self._assert_same(receipt, method, payload_hash)
                if receipt.state == "COMMITTED":
                    return {"result": copy.deepcopy(receipt.result),
                            "replayed": True}
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ReceiptPending()
                self._condition.wait(remaining)
        if not owner:
            raise ReceiptPending()
        try:
            result = mutation()
        except Exception:
            self.abandon(caller, request_id)
            raise
        return self.commit(caller, request_id, result)

    def inspect(self, caller: CallerIdentity,
                request_id: str) -> Optional[Dict[str, Any]]:
        key = self._key(caller, self._normalize_request_id(request_id))
        with self._condition:
            value = self._records.get(key)
            return copy.deepcopy(value.public()) if value else None

    def purge_expired(self) -> int:
        cutoff = self.clock() - self.retention_seconds
        protected = self.clock() - self.max_offline_replay_seconds
        removed = 0
        with self._condition:
            for key, receipt in list(self._records.items()):
                timestamp = receipt.completed_at or receipt.created_at
                if (receipt.state == "COMMITTED" and timestamp < cutoff
                        and timestamp < protected):
                    del self._records[key]
                    removed += 1
        return removed

    def export_metadata(self):
        """Return content-free receipt metadata for audit/doctor output."""
        with self._condition:
            return [
                copy.deepcopy(item.public())
                for item in sorted(
                    self._records.values(),
                    key=lambda row: (row.created_at, row.request_id))
            ]
