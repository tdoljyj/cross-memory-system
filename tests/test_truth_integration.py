#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""R3-T05 Truth Claim Gate 全面接入测试（Gate 2 裁决）。

覆盖：状态区分（NO_MEMORY/UNVERIFIED/TAMPERED/STALE/DENIED/ENV_UNAVAILABLE）、
禁止"无法核验"误报"没有记忆"、pre-answer gate、旁路检测（ENFORCED 阻断）。

运行：python tests/test_truth_integration.py
"""

import os
import sys
import time

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory_engine.truth import schema as TS  # noqa: E402
from memory_engine.truth import (  # noqa: E402
    TruthReceipt, ClaimGate, TruthAwareRecall, pre_answer_gate,
    classify_answer, BypassError, BypassGuard,
)

TESTS = []


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def register(fn):
    TESTS.append(fn)
    return fn


def _claims():
    return [{"claim_type": "LIFECYCLE_STATE", "value": "ACTIVE",
             "status": TS.VERDICT_VERIFIED}]


# ---- 状态区分 ----
@register
def test_classify_no_memory_vs_unverified():
    """禁止把无法核验误报成没有记忆。"""
    _check(classify_answer(TS.VERDICT_UNVERIFIED, "NO_VALID_RECEIPT", has_content=False)
           == "NO_MEMORY", "无内容 → NO_MEMORY")
    _check(classify_answer(TS.VERDICT_UNVERIFIED, "NO_VALID_RECEIPT", has_content=True)
           == "UNVERIFIED", "有内容但无 receipt → UNVERIFIED（≠ NO_MEMORY）")
    _check(classify_answer(TS.VERDICT_VERIFIED, None, has_content=True) == "VERIFIED",
           "有内容 + VERIFIED → VERIFIED")


@register
def test_classify_tampered_stale_denied_env():
    _check(classify_answer(TS.VERDICT_UNVERIFIED, "RECEIPT_TAMPERED", True) == "TAMPERED",
           "篡改 → TAMPERED")
    _check(classify_answer(TS.VERDICT_UNVERIFIED, "RECEIPT_STALE", True) == "STALE",
           "过期 → STALE")
    _check(classify_answer(TS.VERDICT_UNVERIFIED, "CAPABILITY_MISMATCH", True) == "DENIED",
           "能力不足 → DENIED")
    _check(classify_answer(TS.VERDICT_UNVERIFIED, "REMOTE_UNREACHABLE", True)
           == "ENV_UNAVAILABLE", "远端不可达 → ENV_UNAVAILABLE")
    _check(classify_answer(TS.VERDICT_UNVERIFIED, "DOCTOR_FAIL", True)
           == "ENV_UNAVAILABLE", "doctor FAIL → ENV_UNAVAILABLE")


# ---- TruthAwareRecall ----
@register
def test_recall_no_content_is_no_memory():
    r = TruthAwareRecall(recall_fn=lambda q, tier="T0", **kw: None)
    out = r.recall("q")
    _check(out["state"] == "NO_MEMORY", "无内容 → NO_MEMORY")
    _check(out["has_content"] is False, "has_content=False")


@register
def test_recall_content_without_receipt_unverified():
    r = TruthAwareRecall(recall_fn=lambda q, tier="T0", **kw: "some content")
    out = r.recall("q")
    _check(out["state"] == "UNVERIFIED", "有内容无 receipt → UNVERIFIED")
    _check(out["reason"] == "NO_VALID_RECEIPT", "reason")


@register
def test_recall_content_with_valid_receipt_verified():
    rec = TruthReceipt().issue(_claims(), bound_evidence_head="a" * 40)
    r = TruthAwareRecall(recall_fn=lambda q, tier="T0", **kw: "content")
    out = r.recall("q", receipt=rec)
    _check(out["state"] == "VERIFIED", "有效 receipt → VERIFIED")


@register
def test_recall_require_verified_blocks_without_receipt():
    r = TruthAwareRecall(recall_fn=lambda q, tier="T0", **kw: "content",
                         capability="ENFORCED")
    try:
        r.recall("q", require_verified=True)
        raise AssertionError("ENFORCED 无 receipt 必须阻断")
    except BypassError:
        pass


@register
def test_recall_require_verified_passes_with_receipt():
    rec = TruthReceipt().issue(_claims(), bound_evidence_head="a" * 40)
    r = TruthAwareRecall(recall_fn=lambda q, tier="T0", **kw: "content",
                         capability="ENFORCED")
    out = r.recall("q", receipt=rec, require_verified=True)
    _check(out["state"] == "VERIFIED", "ENFORCED + 有效 receipt → VERIFIED")


# ---- pre-answer gate ----
@register
def test_pre_answer_gate_env_error():
    state, reason = pre_answer_gate("LIFECYCLE_STATE", env_error="doctor FAIL")
    _check(state == "ENV_UNAVAILABLE", "环境故障 → ENV_UNAVAILABLE（不伪装）")


@register
def test_pre_answer_gate_no_receipt():
    state, reason = pre_answer_gate("LIFECYCLE_STATE", receipt=None)
    _check(state == "UNVERIFIED", "无 receipt → UNVERIFIED")


@register
def test_pre_answer_gate_tampered():
    rec = TruthReceipt().issue(_claims(), bound_evidence_head="a" * 40)
    rec["receipt_digest"] = "0" * 64
    state, reason = pre_answer_gate("LIFECYCLE_STATE", receipt=rec)
    _check(state == "TAMPERED", "篡改 → TAMPERED")


@register
def test_pre_answer_gate_stale():
    rec = TruthReceipt().issue(_claims(), bound_evidence_head="a" * 40,
                               created_at=time.time() - 9999)
    state, reason = pre_answer_gate("LIFECYCLE_STATE", receipt=rec, max_age_seconds=60)
    _check(state == "STALE", "过期 → STALE")


# ---- 旁路检测 ----
@register
def test_bypass_guard_strict_blocks():
    g = BypassGuard(capability="ENFORCED", strict=True)
    try:
        g.call("store.read", receipt_marker=False)
        raise AssertionError("ENFORCED 候选模式旁路必须阻断")
    except BypassError:
        pass


@register
def test_bypass_guard_with_marker_passes():
    g = BypassGuard(capability="ENFORCED", strict=True)
    out = g.call("store.read", receipt_marker=True)
    _check(out["gated"] is True, "带 gate 标记通过")


@register
def test_bypass_guard_audit_not_strict():
    g = BypassGuard(capability="AUDIT", strict=False)
    out = g.call("store.read")
    _check(out["ok"] is True, "AUDIT 非严格模式记录不阻断")


@register
def test_answer_states_enum():
    for s in ("NO_MEMORY", "UNVERIFIED", "TAMPERED", "STALE", "DENIED",
              "ENV_UNAVAILABLE", "VERIFIED"):
        _check(s in TS.ANSWER_STATES, "缺状态 %s" % s)


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
