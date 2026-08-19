#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""R3-T04 TruthReceipt 与 ClaimGate 测试（ADR-R3-002 §3/§6）。

覆盖：issue/validate/digest 防篡改/新鲜度/same-operation reuse/
fail-closed（无有效 receipt 不得产生 VERIFIED claim）。

运行：python tests/test_truth_receipt_gate.py
"""

import os
import sys
import time

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory_engine.truth import schema as TS  # noqa: E402
from memory_engine.truth import TruthReceipt, ReceiptError, ClaimGate  # noqa: E402

TESTS = []
GIT = "git"


def _claims(head="a" * 40):
    return [
        {"claim_type": "REPO_LOCAL_HEAD", "value": head,
         "status": TS.VERDICT_VERIFIED},
        {"claim_type": "REPO_REMOTE_HEAD", "value": head,
         "status": TS.VERDICT_VERIFIED},
    ]


def register(fn):
    TESTS.append(fn)
    return fn


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


@register
def test_issue_and_validate():
    r = TruthReceipt()
    receipt = r.issue(_claims(), bound_evidence_head="a" * 40, request_id="r1")
    _check(receipt["schema_version"] == 1, "schema 版本")
    _check(receipt["receipt_id"], "有 receipt_id")
    _check(r.validate(receipt, max_age_seconds=3600) is True, "校验通过")


@register
def test_tamper_detected():
    r = TruthReceipt()
    receipt = r.issue(_claims(), bound_evidence_head="a" * 40)
    receipt["claims"][0]["value"] = "b" * 40  # 篡改
    try:
        r.validate(receipt, max_age_seconds=3600)
        raise AssertionError("篡改应被检出")
    except ReceiptError as e:
        _check(e.reason == "RECEIPT_TAMPERED", "reason 应为 TAMPERED")


@register
def test_stale_detected():
    r = TruthReceipt()
    receipt = r.issue(_claims(), bound_evidence_head="a" * 40,
                      created_at=time.time() - 1000)
    try:
        r.validate(receipt, max_age_seconds=60)
        raise AssertionError("过期应被检出")
    except ReceiptError as e:
        _check(e.reason == "RECEIPT_STALE", "reason 应为 STALE")


@register
def test_missing_field_fail_closed():
    r = TruthReceipt()
    receipt = r.issue(_claims(), bound_evidence_head="a" * 40)
    del receipt["receipt_digest"]
    try:
        r.validate(receipt, max_age_seconds=3600)
        raise AssertionError("缺字段应被检出")
    except ReceiptError:
        pass


@register
def test_reuse_same_request_within_window():
    r = TruthReceipt()
    receipt = r.issue(_claims(), bound_evidence_head="a" * 40, request_id="op1")
    _check(r.reuse_allowed(receipt, request_id="op1", window_seconds=5) is True,
           "同 operation 窗口内可复用")
    _check(r.reuse_allowed(receipt, request_id="op2", window_seconds=5) is False,
           "不同 operation 禁止复用")
    old = r.issue(_claims(), bound_evidence_head="a" * 40, request_id="op1",
                  created_at=time.time() - 100)
    _check(r.reuse_allowed(old, request_id="op1", window_seconds=5) is False,
           "超窗口禁止复用")


@register
def test_claim_status_from_receipt():
    r = TruthReceipt()
    receipt = r.issue(_claims(), bound_evidence_head="a" * 40)
    _check(r.claim_status_from_receipt("REPO_LOCAL_HEAD", receipt) == TS.VERDICT_VERIFIED,
           "有 receipt → VERIFIED")
    _check(r.claim_status_from_receipt("REPO_LOCAL_HEAD", None) == TS.VERDICT_UNVERIFIED,
           "无 receipt → UNVERIFIED（fail-closed）")
    receipt["claims"][0]["value"] = "c" * 40
    _check(r.claim_status_from_receipt("REPO_LOCAL_HEAD", receipt) == TS.VERDICT_UNVERIFIED,
           "篡改 receipt → UNVERIFIED")


@register
def test_gate_fail_closed_no_receipt():
    g = ClaimGate()
    st, reason = g.check("REPO_LOCAL_HEAD", receipt=None)
    _check(st == TS.VERDICT_UNVERIFIED, "无 receipt 必须 UNVERIFIED")
    _check(reason == "NO_VALID_RECEIPT", "reason 应为 NO_VALID_RECEIPT")


@register
def test_gate_stale_receipt_blocked():
    g = ClaimGate(max_age_seconds=60)
    r = TruthReceipt()
    receipt = r.issue(_claims(), bound_evidence_head="a" * 40,
                      created_at=time.time() - 1000)
    st, reason = g.check("REPO_REMOTE_HEAD", receipt=receipt)
    _check(st == TS.VERDICT_UNVERIFIED, "过期 receipt 必须 UNVERIFIED")
    _check(reason == "RECEIPT_STALE", "reason=STALE")


@register
def test_gate_verified_with_fresh_receipt():
    g = ClaimGate(max_age_seconds=60)
    r = TruthReceipt()
    receipt = r.issue(_claims(), bound_evidence_head="a" * 40)
    st, reason = g.check("REPO_REMOTE_HEAD", receipt=receipt)
    _check(st == TS.VERDICT_VERIFIED and reason is None, "新鲜有效 receipt → VERIFIED")


@register
def test_gate_check_many():
    g = ClaimGate()
    r = TruthReceipt()
    receipt = r.issue(_claims(), bound_evidence_head="a" * 40)
    out = g.check_many(["REPO_LOCAL_HEAD", "REPO_REMOTE_HEAD"], receipt=receipt)
    _check(all(v[0] == TS.VERDICT_VERIFIED for v in out.values()), "双 claim 均 VERIFIED")
    out2 = g.check_many(["REPO_LOCAL_HEAD"], receipt=None)
    _check(out2["REPO_LOCAL_HEAD"][0] == TS.VERDICT_UNVERIFIED, "无 receipt 全 UNVERIFIED")


@register
def test_gate_enforced_requires_receipt():
    g = ClaimGate(capability="ENFORCED")
    try:
        g.assert_enforceable(receipt=None)
        raise AssertionError("ENFORCED 无 receipt 应抛")
    except AssertionError:
        pass
    r = TruthReceipt()
    receipt = r.issue(_claims(), bound_evidence_head="a" * 40)
    _check(g.assert_enforceable(receipt=receipt) is True, "ENFORCED 有有效 receipt 通过")


@register
def test_gate_unverified_output_shape():
    g = ClaimGate()
    u = g.unverified("REPO_REMOTE_HEAD", "REMOTE_UNREACHABLE")
    _check(u["claim_type"] == "REPO_REMOTE_HEAD", "claim_type")
    _check(u["status"] == TS.VERDICT_UNVERIFIED, "status")
    _check(u["reason"] == "REMOTE_UNREACHABLE", "reason")


def main():
    failures = 0
    for fn in TESTS:
        try:
            fn()
            print("PASS %s" % fn.__name__)
        except Exception as e:
            failures += 1
            print("FAIL %s: %s" % (fn.__name__, e))
    print("----")
    print("%d test(s), %d failure(s)" % (len(TESTS), failures))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
