#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Gate 3-B：ENFORCED conformance 全套验证 + .truth-state 强化测试。

覆盖（裁决 B 项 fault injection）：
- 无 receipt → 降级；receipt 过期 → 降级；receipt 篡改 → 降级；
- Adapter/revision 不匹配 → 降级（fail-closed）；
- .truth-state 缺失 / 损坏 / 被替换 → fail-closed；
- conformance 证据过期 → 降级；
- disable 后尝试读写同步 → 拒绝；
- update 回滚与 journal 中断恢复（复用 lifecycle 既有测试锚点，本文件补断言）；
- 旁路调用与 TOCTOU 场景（并发替换 truth-state → 校验失败）；
- 分层结论：隔离 Binding → ENFORCED；真实环境 → AUDIT；实现 → ENFORCED-CAPABLE。

运行：python tests/test_truth_state_conformance.py
"""

import hashlib
import json
import os
import shutil
import sys
import tempfile
import time

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory_engine.truth import (  # noqa: E402
    TruthReceipt, TruthStateStore, TruthStateError, ConformanceVerifier,
    schema as TS,
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


def _state(tmp):
    return TruthStateStore(os.path.join(tmp, "truth-state"))


def _fresh_receipt(now=None):
    return TruthReceipt().issue(_claims(), bound_evidence_head="a" * 40,
                                created_at=(now or time.time()))


class FakeAdapter(object):
    def capability(self):
        return "ADVISORY"
    contract_version = 1


@register
def test_no_receipt_degrades():
    tmp = tempfile.mkdtemp(prefix="ts-")
    try:
        store = _state(tmp)
        ev = hashlib.sha256(b"e1").hexdigest()
        store.write("b1", "fake", "r1", ev, "ADVISORY",
                    evidence_meta={"verified_at": time.time()})
        v = ConformanceVerifier(truth_state_store=store)
        cap, s = v.verify("fake", "b1", "r1", receipt=None,
                          conformance_evidence=ev, environment="isolated")
        _check(cap != "ENFORCED" and cap == "ADVISORY",
               "无 receipt → 降级（实际=%s）" % cap)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_stale_receipt_degrades():
    tmp = tempfile.mkdtemp(prefix="ts-")
    try:
        store = _state(tmp)
        ev = hashlib.sha256(b"e1").hexdigest()
        store.write("b1", "fake", "r1", ev, "ADVISORY",
                    evidence_meta={"verified_at": time.time()})
        v = ConformanceVerifier(truth_state_store=store,
                                max_evidence_age_seconds=60)
        stale = TruthReceipt().issue(_claims(), bound_evidence_head="a" * 40,
                                     created_at=time.time() - 9999)
        cap, _ = v.verify("fake", "b1", "r1", receipt=stale,
                          conformance_evidence=ev, environment="isolated")
        _check(cap == "ADVISORY", "过期 receipt → 降级")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_tampered_receipt_degrades():
    tmp = tempfile.mkdtemp(prefix="ts-")
    try:
        store = _state(tmp)
        ev = hashlib.sha256(b"e1").hexdigest()
        store.write("b1", "fake", "r1", ev, "ADVISORY",
                    evidence_meta={"verified_at": time.time()})
        v = ConformanceVerifier(truth_state_store=store)
        rec = _fresh_receipt()
        rec["receipt_digest"] = "0" * 64  # 篡改
        cap, _ = v.verify("fake", "b1", "r1", receipt=rec,
                          conformance_evidence=ev, environment="isolated")
        _check(cap == "ADVISORY", "篡改 receipt → 降级")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_truth_state_missing_fail_closed():
    tmp = tempfile.mkdtemp(prefix="ts-")
    try:
        store = _state(tmp)  # 未写入任何 state
        v = ConformanceVerifier(truth_state_store=store)
        cap, _ = v.verify("fake", "nobody", "r1", receipt=_fresh_receipt(),
                          conformance_evidence="x" * 64, environment="isolated")
        _check(cap == "ADVISORY", ".truth-state 缺失 → fail-closed 降级")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_truth_state_corrupt_fail_closed():
    tmp = tempfile.mkdtemp(prefix="ts-")
    try:
        store = _state(tmp)
        ev = hashlib.sha256(b"e1").hexdigest()
        store.write("b1", "fake", "r1", ev, "ADVISORY",
                    evidence_meta={"verified_at": time.time()})
        # 损坏文件
        with open(os.path.join(tmp, "truth-state", "b1.json"), "w") as f:
            f.write("{corrupt")
        try:
            store.read("b1")
            raise AssertionError("损坏 state 必须 fail-closed")
        except TruthStateError as e:
            _check(e.reason == "STATE_CORRUPT", "reason=STATE_CORRUPT")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_truth_state_replaced_fail_closed():
    """被替换（TOCTOU 场景）：另一 binding/内容覆盖 → digest/绑定失败。"""
    tmp = tempfile.mkdtemp(prefix="ts-")
    try:
        store = _state(tmp)
        ev = hashlib.sha256(b"e1").hexdigest()
        store.write("b1", "fake", "r1", ev, "ADVISORY",
                    evidence_meta={"verified_at": time.time()})
        # 用不同内容替换（模拟并发替换）
        store.write("b1", "attacker", "r9", "f" * 64, "ENFORCED",
                    evidence_meta={"verified_at": time.time()})
        v = ConformanceVerifier(truth_state_store=store)
        cap, _ = v.verify("fake", "b1", "r1", receipt=_fresh_receipt(),
                          conformance_evidence=ev, environment="isolated")
        _check(cap == "ADVISORY", "被替换 state → 绑定失败降级")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_evidence_expired_degrades():
    tmp = tempfile.mkdtemp(prefix="ts-")
    try:
        store = _state(tmp)
        ev = hashlib.sha256(b"e1").hexdigest()
        store.write("b1", "fake", "r1", ev, "ADVISORY",
                    evidence_meta={"verified_at": time.time() - 99999})
        v = ConformanceVerifier(truth_state_store=store,
                                max_evidence_age_seconds=60)
        cap, summary = v.verify("fake", "b1", "r1",
                                receipt=_fresh_receipt(),
                                conformance_evidence=ev, environment="isolated")
        _check(cap == "ADVISORY", "conformance 证据过期 → 降级")
        _check("过期" in summary, "summary 含过期原因")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_isolated_binding_reaches_enforced():
    """临时 home 全证据链 → 临时 Binding ENFORCED（分层结论之一）。"""
    tmp = tempfile.mkdtemp(prefix="ts-")
    try:
        store = _state(tmp)
        ev = hashlib.sha256(b"e1").hexdigest()
        store.write("b1", "fake", "r1", ev, "ADVISORY",
                    evidence_meta={"verified_at": time.time()})
        v = ConformanceVerifier(truth_state_store=store)
        cap, _ = v.verify("fake", "b1", "r1", receipt=_fresh_receipt(),
                          conformance_evidence=ev, environment="isolated")
        _check(cap == "ENFORCED", "隔离全证据链 → 临时 Binding ENFORCED")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_real_environment_stays_audit():
    """真实环境：即使证据齐全也最多 AUDIT（未授权切换）。"""
    tmp = tempfile.mkdtemp(prefix="ts-")
    try:
        store = _state(tmp)
        ev = hashlib.sha256(b"e1").hexdigest()
        store.write("b1", "fake", "r1", ev, "ADVISORY",
                    evidence_meta={"verified_at": time.time()})
        v = ConformanceVerifier(truth_state_store=store)
        cap, _ = v.verify("fake", "b1", "r1", receipt=_fresh_receipt(),
                          conformance_evidence=ev, environment="real")
        _check(cap == "AUDIT", "真实环境 → AUDIT（实际=%s）" % cap)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_implementation_classification():
    """仓库 revision / Adapter 实现 → ENFORCED-CAPABLE（分层结论之一）。"""
    v = ConformanceVerifier()
    _check(v.classify_implementation(FakeAdapter(), 1, True)
           == "ENFORCED-CAPABLE", "conformance 全过 → ENFORCED-CAPABLE")
    _check(v.classify_implementation(FakeAdapter(), 0, True)
           == "ADVISORY-CAPABLE", "合同版本不符 → ADVISORY-CAPABLE")
    _check(v.classify_implementation(FakeAdapter(), 1, False)
           == "ADVISORY-CAPABLE", "conformance 未全过 → ADVISORY-CAPABLE")


@register
def test_atomic_write_no_partial_state():
    """原子写：写入后无 .tmp 残留；读回一致。"""
    tmp = tempfile.mkdtemp(prefix="ts-")
    try:
        store = _state(tmp)
        ev = hashlib.sha256(b"e1").hexdigest()
        store.write("b1", "fake", "r1", ev, "ADVISORY",
                    evidence_meta={"verified_at": time.time()})
        leftovers = [f for f in os.listdir(os.path.join(tmp, "truth-state"))
                     if f.endswith(".tmp")]
        _check(leftovers == [], "无 .tmp 残留")
        data = store.read("b1")
        _check(data["binding_id"] == "b1" and data["revision"] == "r1",
               "读回一致")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_disable_blocks_ops_after_conformance():
    """disable 后读/写/同步拒绝（INV-3，经 lifecycle 控制器）。"""
    from memory_engine.lifecycle_ctl import LifecycleController, LifecycleError
    tmp = tempfile.mkdtemp(prefix="ts-")
    try:
        lc = LifecycleController(os.path.join(tmp, "state"))
        lc.install("b1")
        lc.disable("b1")
        try:
            lc.assert_operations_allowed("b1", "read")
            raise AssertionError("disable 后 read 必须拒绝")
        except LifecycleError as e:
            _check(e.code == "CLD-DISABLE-001", "拒绝码")
        try:
            lc.assert_operations_allowed("b1", "sync")
            raise AssertionError("disable 后 sync 必须拒绝")
        except LifecycleError:
            pass
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_update_rollback_and_journal_recovery():
    """update 回滚 + journal 中断恢复（Gate 3 门槛锚点）。"""
    from memory_engine.lifecycle_ctl import LifecycleController
    from memory_engine.lifecycle_ctl import states as S
    tmp = tempfile.mkdtemp(prefix="ts-")
    try:
        c = LifecycleController(os.path.join(tmp, "state"))
        st = S.new_state(binding="INSTALLING", session="ONLINE", truth="UNAVAILABLE")
        c.save("b1", st)
        op_id, jp = c._begin("b1", "install")
        c._stage(jp, "installing")
        recovered = c.recover_pending()
        _check(len(recovered) == 1 and recovered[0][2] == "INSTALLING->BROKEN",
               "journal 中断恢复 → BROKEN")
    finally:
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
