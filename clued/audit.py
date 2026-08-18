# -*- coding: utf-8 -*-
"""审计（协议 §15.4）。

必须审计：install begin/success/failure/rollback；bind create/revoke；
auth authorized/denied/unavailable；degraded enter/expire/exit；
pending create/replay/conflict/synced；breaker open/half-open/close；
uninstall begin/success/pending-revoke/failure。
字段至少：timestamp、request_id、binding_id、event_type、result_code、
redacted metadata。不得记录记忆正文或秘密。
"""

import json
import os

from .identifiers import now_rfc3339
from .redact import redact

EVENT_TYPES = (
    "install_begin", "install_success", "install_failure",
    "install_rollback_complete", "install_repair_begin",
    "bind_create", "bind_revoke",
    "auth_authorized", "auth_denied", "auth_unavailable",
    "degraded_enter", "degraded_expire", "degraded_exit",
    "pending_create", "pending_replay", "pending_conflict", "pending_synced",
    "breaker_open", "breaker_half_open", "breaker_close",
    "uninstall_begin", "uninstall_success", "uninstall_pending_revoke",
    "uninstall_failure",
    "state_transition", "recovery_begin", "recovery_success",
    "recovery_step",
    "conflict_snapshot", "lock_acquired", "lock_released",
)


def _fsync_dir(path):
    try:
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        pass


class AuditLog(object):
    """追加式 JSON Lines 审计。元数据经 redact；调用方不得传入记忆正文。"""

    def __init__(self, path):
        self.path = path

    def _ensure(self):
        d = os.path.dirname(self.path)
        if not os.path.isdir(d):
            os.makedirs(d)

    def append(self, event_type, binding_id=None, request_id=None,
               result_code=None, metadata=None):
        entry = {
            "timestamp": now_rfc3339(),
            "request_id": request_id or "",
            "binding_id": binding_id or "",
            "event_type": event_type,
            "result_code": result_code or "",
            "metadata": redact(json.dumps(
                metadata or {}, ensure_ascii=False)),
        }
        self._ensure()
        line = json.dumps(entry, ensure_ascii=False) + "\n"
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(line)
            fh.flush()
            os.fsync(fh.fileno())
        _fsync_dir(os.path.dirname(self.path))
        return entry

    def tail(self, limit=50):
        if not os.path.isfile(self.path):
            return []
        with open(self.path, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
        out = []
        for line in lines[-limit:]:
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
        return out
