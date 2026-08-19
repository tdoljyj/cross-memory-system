# -*- coding: utf-8 -*-
"""R3-T05 前身 Claim Gate 基础链路（ADR-R3-002 §6，Gate 1 落地 fail-closed 语义）。

回答含任何 current 类陈述前，Claim Gate 依次检查：
  1) 有有效 receipt（validate 全过）→ 否则阻断为 UNVERIFIED；
  2) receipt 新鲜（≤ max_age）→ 否则重取；
  3) receipt 未篡改（digest）；
  4) 能力匹配（ENFORCED 档禁止 UNVERIFIED claim 成功返回）；
  5) 成功返回率：无有效 receipt 的 current claim 成功返回必须为 0。

Gate 1 交付的是基础链路（校验+阻断+unverified 语义），
ENFORCED 档位的 enforce 行为与 Adapter 接线属 Gate 2 R3-T05/R3-T06。
"""

import time

from . import schema
from .receipt import ReceiptError, TruthReceipt


class ClaimGate(object):

    def __init__(self, max_age_seconds=None, capability="AUDIT"):
        self.max_age = (max_age_seconds if max_age_seconds is not None
                        else schema.DEFAULT_CURRENT_CLAIM_MAX_AGE_SECONDS)
        self.capability = capability  # UNAVAILABLE | ADVISORY | AUDIT | ENFORCED
        self._receipt = TruthReceipt()

    # ---- 核心检查 ----
    def check(self, claim_type, receipt=None, now=None):
        """检查单个 current claim。返回 (status, reason)。

        成功返回 CURRENT_STATE_VERIFIED 当且仅当 receipt 有效且新鲜；
        否则 CURRENT_STATE_UNVERIFIED + 稳定 reason（fail-closed）。
        """
        if claim_type not in schema.CLAIM_TYPES:
            return schema.VERDICT_UNVERIFIED, "UNKNOWN"
        if not receipt:
            return schema.VERDICT_UNVERIFIED, "NO_VALID_RECEIPT"
        try:
            self._receipt.validate(receipt, max_age_seconds=self.max_age, now=now)
        except ReceiptError as e:
            return schema.VERDICT_UNVERIFIED, e.reason
        # receipt 有效：核对 claim 是否在 receipt 内且被 VERIFIED 覆盖
        for c in receipt.get("claims", []):
            if c.get("claim_type") == claim_type:
                st = c.get("status", schema.VERDICT_VERIFIED)
                if st == schema.VERDICT_VERIFIED:
                    return schema.VERDICT_VERIFIED, None
                return schema.VERDICT_UNVERIFIED, c.get("reason", "EVIDENCE_CONFLICT")
        return schema.VERDICT_UNVERIFIED, "NO_VALID_RECEIPT"

    # ---- 组合检查（一次核验多个 current claims） ----
    def check_many(self, claim_types, receipt=None, now=None):
        out = {}
        for ct in claim_types:
            out[ct] = self.check(ct, receipt=receipt, now=now)
        return out

    # ---- ENFORCED 语义 ----
    def assert_enforceable(self, receipt=None, now=None):
        """ENFORCED 档：所有 current claim 必须 VERIFIED；否则抛 AssertionError。

        Gate 2 起由 Adapter pre-answer 调用；Gate 1 保留语义与测试。
        """
        if self.capability == "ENFORCED":
            if not receipt:
                raise AssertionError("ENFORCED: 无 receipt 的 current claim 禁止成功返回")
            try:
                self._receipt.validate(receipt, max_age_seconds=self.max_age, now=now)
            except ReceiptError as e:
                raise AssertionError("ENFORCED: receipt 无效 (%s)" % e.reason)
        return True

    # ---- 输出（统一 unverified 结构） ----
    @staticmethod
    def unverified(claim_type, reason):
        return {
            "claim_type": claim_type,
            "status": schema.VERDICT_UNVERIFIED,
            "reason": reason,
            "produced_at": time.time(),
        }
