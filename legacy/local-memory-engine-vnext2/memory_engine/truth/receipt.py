# -*- coding: utf-8 -*-
"""R3-T04 Truth Receipt Issuer / Validator（ADR-R3-002 §3）。

- schema：receipt 结构自含 schema_version 与 canonical digest；
- 绑定：claims 与 bound_evidence_head 绑定，digest 防篡改；
- same-operation reuse：同 request 在 reuse 窗口内可复用 receipt；
- bound facts：receipt 一经颁发即绑定当时 claims，禁止静默改写；
- reason codes：无效/过期/篡改返回稳定 reason；
- 无有效 receipt 不得产生 VERIFIED claim（fail-closed）。
"""

import hashlib
import json
import time
import uuid

from . import schema


class ReceiptError(Exception):
    def __init__(self, reason, detail=""):
        super(ReceiptError, self).__init__("%s: %s" % (reason, detail))
        self.reason = reason
        self.detail = detail


class TruthReceipt(object):

    @staticmethod
    def _canonical(claims, bound_evidence_head):
        """规范化 claims（按 claim_type 排序，去掉非 canonical 字段）。"""
        norm = {}
        for c in claims:
            if not isinstance(c, dict) or "claim_type" not in c:
                raise ReceiptError("UNKNOWN", "claim 结构非法")
            norm[c["claim_type"]] = c.get("value")
        return {
            "claims": norm,
            "bound_evidence_head": bound_evidence_head,
        }

    @staticmethod
    def _digest(canonical):
        raw = hashlib.sha256()
        for k in sorted(canonical):
            raw.update(k.encode())
            raw.update(json.dumps(canonical[k], sort_keys=True, ensure_ascii=False).encode())
        return raw.hexdigest()

    def issue(self, claims, bound_evidence_head, request_id="", verdict=None,
              created_at=None):
        """颁发一次性 receipt。claims: list[dict]（含 claim_type/value/status/reason）。"""
        canonical = self._canonical(claims, bound_evidence_head)
        digest = self._digest(canonical)
        receipt = {
            "schema_version": schema.RECEIPT_SCHEMA_VERSION,
            "receipt_id": str(uuid.uuid4()),
            "request_id": request_id,
            "claims": claims,
            "bound_evidence_head": bound_evidence_head,
            "verdict": verdict or schema.VERDICT_VERIFIED,
            "created_at": created_at or time.time(),
            "receipt_digest": digest,
        }
        return receipt

    # ---- 校验（fail-closed） ----
    def validate(self, receipt, max_age_seconds=None, now=None):
        """校验完整性+新鲜度。通过返回 True；否则抛 ReceiptError。

        校验顺序：结构 → digest → 新鲜度。
        任何缺失/异常 → 抛错（调用方必须 fail-closed 为 UNVERIFIED）。
        """
        if not isinstance(receipt, dict):
            raise ReceiptError("RECEIPT_TAMPERED", "receipt 非对象")
        if receipt.get("schema_version") != schema.RECEIPT_SCHEMA_VERSION:
            raise ReceiptError("RECEIPT_TAMPERED", "schema_version 不匹配")
        for field in ("receipt_id", "claims", "bound_evidence_head", "receipt_digest",
                      "created_at"):
            if field not in receipt:
                raise ReceiptError("RECEIPT_TAMPERED", "缺字段: %s" % field)
        # digest 复算
        canonical = self._canonical(receipt["claims"], receipt["bound_evidence_head"])
        if self._digest(canonical) != receipt["receipt_digest"]:
            raise ReceiptError("RECEIPT_TAMPERED", "digest 不匹配")
        # 新鲜度
        if max_age_seconds is not None:
            now = now if now is not None else time.time()
            if now - float(receipt["created_at"]) > max_age_seconds:
                raise ReceiptError("RECEIPT_STALE",
                                   "receipt 超龄 %.0fs" % (now - float(receipt["created_at"])))
        return True

    # ---- same-operation reuse ----
    def reuse_allowed(self, receipt, request_id, now=None, window_seconds=None):
        """同 operation（request_id 相同）且在窗口内 → 允许复用。"""
        try:
            self.validate(receipt, max_age_seconds=None)
        except ReceiptError:
            return False
        if receipt.get("request_id") != request_id:
            return False
        window = window_seconds if window_seconds is not None else schema.DEFAULT_REUSE_WINDOW_SECONDS
        now = now if now is not None else time.time()
        return (now - float(receipt["created_at"])) <= window

    # ---- 断言：无有效 receipt 不得产生 VERIFIED claim ----
    @staticmethod
    def claim_status_from_receipt(claim_type, receipt, max_age_seconds=None):
        """从 receipt 提取某 claim 的状态；无 receipt/无效 → UNVERIFIED。"""
        try:
            TruthReceipt().validate(receipt, max_age_seconds=max_age_seconds)
        except ReceiptError:
            return schema.VERDICT_UNVERIFIED
        for c in receipt.get("claims", []):
            if c.get("claim_type") == claim_type:
                return c.get("status", schema.VERDICT_VERIFIED)
        return schema.VERDICT_UNVERIFIED
