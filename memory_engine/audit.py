# -*- coding: utf-8 -*-
"""Memory Audit（§19）：memory/audit/audit.log（JSON Lines，追加式）。

只记录操作元数据，不记录敏感对话全文：
    memory_id / operation / timestamp / adapter / reason /
    previous_status / new_status / session_id

用途：debug、可复现性、记忆演化追踪。git 历史是最终审计真相源；
audit.log 是引擎级操作日志（可随 memory/ 提交入库）。
"""

import json
import os

from . import paths
from .schema import now_iso

OPERATIONS = [
    "CREATE", "UPDATE", "SUPERSEDE", "ARCHIVE", "REJECT",
    "REINFORCE", "EXPIRE", "DEPRECATE", "CONSOLIDATE",
    "MIGRATE", "ROLLBACK", "REBUILD_INDEX",
]


def append(entry):
    """追加一条审计记录（UTF-8、LF、原子追加）。"""
    required = ("memory_id", "operation", "timestamp")
    for key in required:
        if key not in entry:
            raise ValueError("审计记录缺字段: %s" % key)
    if entry["operation"] not in OPERATIONS:
        raise ValueError("未知审计操作: %r" % (entry["operation"],))
    paths.AUDIT_DIR = os.path.join(paths.REPO, "memory", "audit")
    os.makedirs(paths.AUDIT_DIR, exist_ok=True)
    path = os.path.join(paths.AUDIT_DIR, "audit.log")
    with open(path, "a", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")


def make_entry(memory_id, operation, adapter="memory-engine",
               reason="", previous_status=None, new_status=None,
               session_id=None, extra=None):
    entry = {
        "memory_id": memory_id,
        "operation": operation,
        "timestamp": now_iso(),
        "adapter": adapter,
        "reason": reason or "",
        "previous_status": previous_status,
        "new_status": new_status,
        "session_id": session_id,
    }
    if extra:
        entry["extra"] = extra
    return entry


def read_all():
    """读取全部审计记录；文件缺失/损坏行跳过。"""
    path = os.path.join(paths.REPO, "memory", "audit", "audit.log")
    if not os.path.isfile(path):
        return []
    out = []
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except Exception:
                    continue
    except Exception:
        return []
    return out


def entries_for(memory_id):
    return [e for e in read_all() if e.get("memory_id") == memory_id]
