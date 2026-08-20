#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Gate 3-A：生产入口清单、零旁路证明与负向测试。

覆盖：
- 生产入口清单（read/recall/write/sync/pre_answer）逐个受 Claim Gate 保护；
- 零旁路证明（TruthEnabledAdapter._gate_marker）；
- 负向测试：Adapter 缺失入口 / 旧版本合同 / 错误版本 revision /
  恶意自报能力（声明 ENFORCED 但证据不足 → 降级）；
- 版本矩阵读取与一致性（只读，ADR-R3-005 执行）。

运行：python tests/test_production_wiring.py
"""

import hashlib
import os
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory_engine.truth import (  # noqa: E402
    TruthPlanner, TruthReceipt, ClaimGate, schema as TS,
    PRODUCTION_ENTRIES, BypassFound, verify_zero_bypass,
    read_version_matrix, assert_version_matrix_consistent,
    ConformanceVerifier, TruthStateStore,
)
from adapters.truth_adapter import TruthEnabledAdapter  # noqa: E402

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


def _adapter(tmp):
    from memory_engine.lifecycle_ctl import LifecycleController
    lc = LifecycleController(os.path.join(tmp, "state"))
    return TruthEnabledAdapter(
        planner=TruthPlanner(),
        recall_fn=lambda q, tier="T0", **kw: "content",
        lifecycle_controller=lc,
        gate=ClaimGate(capability="AUDIT"),
        capability="AUDIT")


@register
def test_entry_inventory_complete():
    names = {e["name"] for e in PRODUCTION_ENTRIES}
    _check(names == {"adapter.read", "adapter.recall", "adapter.write",
                     "adapter.sync", "adapter.pre_answer"},
           "五入口清单完整: %s" % names)
    _check(all(e["gated"] for e in PRODUCTION_ENTRIES), "全部要求 gate")


@register
def test_zero_bypass_with_truth_adapter():
    tmp = tempfile.mkdtemp(prefix="pw-")
    try:
        adp = _adapter(tmp)
        checked, bypass = verify_zero_bypass(adp)
        _check(checked == 5 and bypass == 0, "零旁路证明（5 入口全受保护）")
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_bypass_detected_when_entry_unguarded():
    tmp = tempfile.mkdtemp(prefix="pw-")
    try:
        adp = _adapter(tmp)
        adp._gate_marker = lambda name: False  # 模拟旁路（入口未受保护）
        try:
            verify_zero_bypass(adp)
            raise AssertionError("旁路必须被检出")
        except BypassFound as e:
            _check("绕过" in str(e), "旁路信息: %s" % e)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_negative_missing_entry():
    tmp = tempfile.mkdtemp(prefix="pw-")
    try:
        adp = _adapter(tmp)
        adp.read = None  # 入口缺失（遮蔽为不可调用，模拟未接线）
        try:
            verify_zero_bypass(adp)
            raise AssertionError("入口缺失必须被检出")
        except BypassFound:
            pass
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_negative_old_contract_version():
    """旧版本合同：contract_version 不匹配 → 拒绝（fail-closed）。"""
    from memory_engine.truth import validate_adapter, ContractViolation
    from memory_engine.truth.adapter_contract import BaseAdapter

    class OldAdapter(BaseAdapter):
        contract_version = 0  # 旧版本

        def query(self, r): return []
        def receipt(self, r): return None
        def claim_gate(self, c, r=None): return ("UNVERIFIED", "x")
        def capability(self): return "ADVISORY"
        def lifecycle(self, a, b): return {}

    try:
        validate_adapter(OldAdapter())
        raise AssertionError("旧版本合同应拒绝")
    except ContractViolation:
        pass


@register
def test_negative_wrong_revision():
    """错误版本 revision：conformance 绑定 revision 不匹配 → 降级。"""
    tmp = tempfile.mkdtemp(prefix="pw-")
    try:
        store = TruthStateStore(os.path.join(tmp, "truth-state"))
        ev = hashlib.sha256(b"evidence-v1").hexdigest()
        store.write("b1", "truth-enabled", "rev-1", ev, "ENFORCED",
                    evidence_meta={"verified_at": 0})
        verifier = ConformanceVerifier(truth_state_store=store,
                                       max_evidence_age_seconds=3600)
        receipt = TruthReceipt().issue(_claims(), bound_evidence_head="a" * 40)
        cap, summary = verifier.verify(
            "truth-enabled", "b1", "rev-WRONG", receipt=receipt,
            conformance_evidence=ev, environment="isolated")
        _check(cap != "ENFORCED", "revision 不符必须降级（实际=%s）" % cap)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_negative_malicious_self_report():
    """恶意自报能力：Adapter 声明 ENFORCED 但证据不足 → 降级（声明不作数）。"""
    tmp = tempfile.mkdtemp(prefix="pw-")
    try:
        class EvilAdapter(object):
            def capability(self):
                return "ENFORCED"  # 恶意自报
            contract_version = 1

        evil = EvilAdapter()
        store = TruthStateStore(os.path.join(tmp, "truth-state"))
        verifier = ConformanceVerifier(truth_state_store=store)
        # 无 receipt + 无 evidence → 即使声明 ENFORCED 也必须 ADVISORY
        cap, summary = verifier.verify(
            evil, "evil:1", "rev-1", receipt=None, conformance_evidence=None,
            environment="isolated")
        _check(cap == "ADVISORY", "恶意自报必须降级（实际=%s）" % cap)
        _check("声明=ENFORCED → 最终=ADVISORY" in summary,
               "summary 记录声明 vs 实际")
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_version_matrix_read_and_consistent():
    """版本矩阵执行检查（只读）：五个命名空间可读、无同命名空间冲突。"""
    matrix = read_version_matrix(REPO_ROOT)
    _check(matrix["PRODUCT_VERSION"] is not None, "产品版本可读")
    _check(matrix["PROTOCOL_VERSION"] is not None, "协议版本可读")
    _check(matrix["ADAPTER_CONTRACT"] == 1, "Adapter 合同 = 1")
    _check(matrix["ARTIFACT_SCHEMA"] == 1, "artifact schema = 1")
    _check(matrix["COMPONENT_VERSION"] is not None, "组件版本可读")
    result = assert_version_matrix_consistent(matrix)
    _check(result["consistent"] is True, "一致")
    # 跨命名空间差异是正常状态（ADR-R3-005），不强制统一
    _check(matrix["PRODUCT_VERSION"] != matrix["PROTOCOL_VERSION"],
           "产品/协议版本差异属正常（不统一）")


@register
def test_truth_adapter_read_gated():
    """read 经 TruthAwareRecall：无 receipt → UNVERIFIED（≠NO_MEMORY）。"""
    tmp = tempfile.mkdtemp(prefix="pw-")
    try:
        adp = _adapter(tmp)
        out = adp.read("q")
        _check(out["state"] == "UNVERIFIED", "read 无 receipt → UNVERIFIED")
        rec = TruthReceipt().issue(_claims(), bound_evidence_head="a" * 40)
        out2 = adp.read("q", receipt=rec)
        _check(out2["state"] == "VERIFIED", "read 有 receipt → VERIFIED")
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_truth_adapter_pre_answer():
    tmp = tempfile.mkdtemp(prefix="pw-")
    try:
        adp = _adapter(tmp)
        st, reason = adp.pre_answer("LIFECYCLE_STATE", receipt=None)
        _check(st == "UNVERIFIED", "pre_answer 无 receipt → UNVERIFIED")
        st2, r2 = adp.pre_answer("LIFECYCLE_STATE", env_error="doctor FAIL")
        _check(st2 == "ENV_UNAVAILABLE", "环境故障 → ENV_UNAVAILABLE")
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


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
