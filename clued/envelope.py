# -*- coding: utf-8 -*-
"""JSON 响应包络（协议 §13.1）。

要求：
- JSON 模式的 stdout 只能输出一个有效 JSON 对象；诊断写 stderr；
- ok=false 必须使用非零退出码；错误码稳定；message 不含秘密；
- 降级时 ok 可为 true，但 state 必须是 DEGRADED_LOCAL，并返回 pending 数量；
- 本地成功但未同步不得使用 SYNCED 字样。
"""

import json
import uuid

from . import PROTOCOL_VERSION


def now_iso():
    from .identifiers import now_rfc3339
    return now_rfc3339()


def envelope(ok=True, code=None, state=None, message="", data=None,
             actions=None, retry_after_seconds=None, request_id=None,
             timestamp=None):
    return {
        "protocol_version": PROTOCOL_VERSION,
        "request_id": request_id or str(uuid.uuid4()),
        "ok": bool(ok),
        "code": code,
        "state": state,
        "message": message,
        "data": data or {},
        "actions": list(actions or []),
        "retry_after_seconds": retry_after_seconds,
        "timestamp": timestamp or now_iso(),
    }


def envelope_ok(state=None, code=None, message="", data=None, actions=None,
                retry_after_seconds=None, request_id=None):
    return envelope(True, code=code, state=state, message=message, data=data,
                    actions=actions, retry_after_seconds=retry_after_seconds,
                    request_id=request_id)


def envelope_fail(code, message="", state=None, data=None, actions=None,
                  retry_after_seconds=None, request_id=None):
    return envelope(False, code=code, state=state, message=message, data=data,
                    actions=actions, retry_after_seconds=retry_after_seconds,
                    request_id=request_id)


def dumps(obj):
    return json.dumps(obj, ensure_ascii=False, indent=2)
