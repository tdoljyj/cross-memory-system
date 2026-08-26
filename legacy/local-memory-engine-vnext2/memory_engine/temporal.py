# -*- coding: utf-8 -*-
"""时间记忆（Phase 6）：valid_from / valid_until / created_at / updated_at。

解决 CURRENT vs HISTORY 混淆（§11）：
- 「我现在用什么？」 → 只返回当前 active + 时间有效的记忆
- 「以前用过什么？」 → 允许返回历史（superseded/archived/expired）
"""

from datetime import datetime, timezone

from . import schema as S


def _now():
    return datetime.now(timezone.utc)


def is_valid_now(obj, when=None):
    """对象在指定时刻（默认现在）是否时间有效。

    规则：valid_from（有则须 >= when）；valid_until（有则须 > when）。
    两个都为空 = 永久有效。
    """
    if when is None:
        when = _now()
    temporal = (obj or {}).get("temporal") or {}
    vf = S.parse_ts(temporal.get("valid_from"))
    vu = S.parse_ts(temporal.get("valid_until"))
    if vf and when < vf:
        return False
    if vu and when >= vu:
        return False
    return True


def is_expired(obj, when=None):
    """对象是否已过 valid_until（供 doctor 提示 active→expired 待办）。"""
    if when is None:
        when = _now()
    temporal = (obj or {}).get("temporal") or {}
    vu = S.parse_ts(temporal.get("valid_until"))
    return bool(vu and when >= vu)


def active_and_valid(obj, when=None):
    """召回用：status ∈ {active, reinforced} 且时间有效。"""
    return obj.get("status") in S.RECALLABLE_STATUSES and is_valid_now(obj, when)


def expired_but_active(obj, when=None):
    """doctor 用：仍 active 但已过 valid_until（应转 expired）。"""
    return obj.get("status") in ("active", "reinforced") and is_expired(obj, when)
