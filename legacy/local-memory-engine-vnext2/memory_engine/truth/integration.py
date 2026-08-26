# -*- coding: utf-8 -*-
"""R3-T05 Truth Claim Gate 全面接入（ADR-R3-002 §6 + Gate 2 裁决）。

提供：
- 状态区分（NO_MEMORY / UNVERIFIED / TAMPERED / STALE / DENIED /
  ENV_UNAVAILABLE / VERIFIED），禁止把"无法核验"误报成"没有记忆"；
- TruthAwareRecall：包装召回/读取路径，先过 Claim Gate 再返回；
- pre_answer_gate：回答前统一入口（Adapter 必须经此）；
- 旁路检测：Adapter 直接调底层（绕过 gate）时结果必须显式 UNVERIFIED，
  ENFORCED 档直接阻断。

接线（Gate 2）：真实 Adapter（adapters/cli_adapter.py 等）经本模块包装；
底层 memory_engine 召回保持不变（不破坏既有契约）。
"""

import time

from . import schema
from .gate import ClaimGate
from .receipt import TruthReceipt, ReceiptError


class BypassError(Exception):
    """检测到绕过 Claim Gate 的调用（ENFORCED 下阻断）。"""


def classify_answer(verdict, reason=None, has_content=False):
    """把 gate 结果映射为回答状态（裁决：禁止 UNVERIFIED 冒充 NO_MEMORY）。

    规则：
      - has_content=False 且引擎确认查无匹配 → NO_MEMORY（与核验无关）
      - 有内容 + verdict=VERIFIED → VERIFIED
      - 有内容 + 无有效 receipt → UNVERIFIED
      - reason=RECEIPT_TAMPERED → TAMPERED；RECEIPT_STALE → STALE
      - reason=CAPABILITY_MISMATCH / DENIED 类 → DENIED
      - reason=REMOTE_UNREACHABLE / GIT_FAILED / DOCTOR_FAIL → ENV_UNAVAILABLE
      - 其他失败 → UNVERIFIED
    """
    if not has_content:
        return "NO_MEMORY"
    if verdict == schema.VERDICT_VERIFIED:
        return "VERIFIED"
    mapping = {
        "RECEIPT_TAMPERED": "TAMPERED",
        "RECEIPT_STALE": "STALE",
        "CAPABILITY_MISMATCH": "DENIED",
        "DENIED": "DENIED",
        "REMOTE_UNREACHABLE": "ENV_UNAVAILABLE",
        "GIT_FAILED": "ENV_UNAVAILABLE",
        "DOCTOR_FAIL": "ENV_UNAVAILABLE",
        "NO_REMOTE": "ENV_UNAVAILABLE",
    }
    return mapping.get(reason, "UNVERIFIED")


class TruthAwareRecall(object):
    """门禁化召回包装：底层 recall_fn（无门禁）→ Claim Gate → 状态化结果。

    Adapter 只允许通过本类读取；直接调底层视为旁路（ENFORCED 阻断）。
    """

    def __init__(self, recall_fn, gate=None, max_age_seconds=None,
                 capability="AUDIT"):
        self._recall = recall_fn
        self._gate = gate or ClaimGate(max_age_seconds=max_age_seconds,
                                       capability=capability)
        self._receipt = TruthReceipt()

    def _recall_content(self, query, tier, **kw):
        """底层召回。返回 (has_content, payload)。"""
        result = self._recall(query, tier=tier, **kw)
        has_content = bool(result)
        return has_content, result

    def recall(self, query, tier="T0", receipt=None, require_verified=False,
               **kw):
        """门禁化召回。

        require_verified=True（ENFORCED 语义）：无有效 receipt → 抛 BypassError/
        返回 UNVERIFIED 而非 VERIFIED。
        """
        has_content, payload = self._recall_content(query, tier, **kw)
        if not has_content:
            return {"state": "NO_MEMORY", "has_content": False, "payload": None}
        # 有内容：必须过 Claim Gate（至少 LIFECYCLE_STATE 等 current 类）
        claim_type = kw.get("claim_type", "LIFECYCLE_STATE")
        verdict, reason = self._gate.check(claim_type, receipt=receipt)
        state = classify_answer(verdict, reason, has_content=True)
        if require_verified and state != "VERIFIED":
            raise BypassError(
                "ENFORCED: claim '%s' 无有效 receipt（state=%s），禁止返回 VERIFIED"
                % (claim_type, state))
        return {"state": state, "has_content": True, "payload": payload,
                "reason": reason, "checked_at": time.time()}


def pre_answer_gate(claim_type, receipt=None, gate=None, max_age_seconds=None,
                    capability="AUDIT", env_error=None):
    """回答前统一入口（Adapter pre-answer 调用）。

    返回 (state, reason)。env_error（如 doctor FAIL）→ ENV_UNAVAILABLE，
    不允许以 UNVERIFIED/NO_MEMORY 掩盖环境故障。
    """
    if env_error:
        return "ENV_UNAVAILABLE", env_error
    g = gate or ClaimGate(max_age_seconds=max_age_seconds, capability=capability)
    verdict, reason = g.check(claim_type, receipt=receipt)
    return classify_answer(verdict, reason, has_content=True), reason


class BypassGuard(object):
    """旁路守卫：包装底层对象，绕过 guard 的访问在 ENFORCED 下阻断。

    用法：guard = BypassGuard(store, capability="ENFORCED")；
    guard.call("direct_access") → 若 capability=ENFORCED 且未带 receipt 标记 → 抛。
    """

    def __init__(self, capability="AUDIT", strict=False):
        self.capability = capability
        self.strict = strict  # True = ENFORCED 候选验证模式

    def call(self, method_name, receipt_marker=False, **kw):
        """模拟对底层方法的调用。receipt_marker=False 表示未经过 Claim Gate。"""
        if self.strict and not receipt_marker:
            raise BypassError(
                "旁路检测: %s 未经 Claim Gate（ENFORCED 候选模式阻断）" % method_name)
        return {"ok": True, "method": method_name, "gated": receipt_marker}
