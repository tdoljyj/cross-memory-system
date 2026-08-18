# -*- coding: utf-8 -*-
"""标识符生成（协议 §5.1）。

- node_id / agent_id / binding_id / request_id / operation_id / conflict_id：
  首次生成 UUIDv4，稳定复用（由调用方持久化决定）；
- session_id：每次会话由适配器生成或接收，不得跨会话复用；
- account_id：来自认证提供方的稳定、非秘密账户标识，不得使用访问令牌。
"""

import uuid
from datetime import datetime, timezone


def new_uuid():
    return str(uuid.uuid4())


def now_rfc3339():
    """RFC3339 UTC；含微秒以满足同秒多次写入的严格保序（§9.4）。"""
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def now_unix():
    return datetime.now(timezone.utc).timestamp()


def parse_rfc3339(value):
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (TypeError, ValueError):
        return None


def age_seconds(rfc3339_value, now=None):
    """RFC3339 时间到当前时刻的秒数；解析失败返回 None。"""
    dt = parse_rfc3339(rfc3339_value)
    if dt is None:
        return None
    ref = now or datetime.now(timezone.utc)
    return max(0.0, (ref - dt).total_seconds())


def valid_uuid4(value):
    try:
        uuid.UUID(str(value), version=4)
        return True
    except (ValueError, TypeError, AttributeError):
        return False
