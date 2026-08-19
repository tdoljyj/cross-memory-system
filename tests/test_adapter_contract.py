#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""R3-T06 版本化 Adapter 公共合同测试（Gate 2 裁决）。

覆盖：合同版本化、五方法、capability 档位保守升级/降级、Adapter 不直 Git、
validate_adapter fail-closed、TruthAwareAdapter 骨架。

运行：python tests/test_adapter_contract.py
"""

import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory_engine.truth import (  # noqa: E402
    ADAPTER_CONTRACT_VERSION, CAPABILITY_LEVELS, CONTRACT_METHODS,
    ContractViolation, validate_adapter, BaseAdapter, CapabilityReporter,
    TruthAwareAdapter, TruthPlanner,
)

TESTS = []


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def register(fn):
    TESTS.append(fn)
    return fn


class GoodAdapter(BaseAdapter):
    name = "good"

    def query(self, request):
        return []

    def receipt(self, request):
        return None

    def claim_gate(self, claim_type, receipt=None):
        return ("UNVERIFIED", "NO_VALID_RECEIPT")

    def capability(self):
        return "ADVISORY"

    def lifecycle(self, action, binding_id):
        return {"action": action, "binding_id": binding_id}


class BadVersionAdapter(GoodAdapter):
    contract_version = 999


class MissingMethodAdapter(GoodAdapter):
    def receipt(self, request):  # noqa: D102
        raise NotImplementedError
    receipt = None  # 移除方法


@register
def test_contract_version_constant():
    _check(ADAPTER_CONTRACT_VERSION == 1, "合同版本 = 1")
    _check(CAPABILITY_LEVELS == ("UNAVAILABLE", "ADVISORY", "AUDIT", "ENFORCED"),
           "能力档位枚举")
    _check(len(CONTRACT_METHODS) == 5, "五方法")


@register
def test_validate_good_adapter():
    _check(validate_adapter(GoodAdapter()) is True, "合格 Adapter 通过")


@register
def test_validate_wrong_version_fail_closed():
    try:
        validate_adapter(BadVersionAdapter())
        raise AssertionError("版本不匹配应拒绝")
    except ContractViolation:
        pass


@register
def test_validate_missing_method():
    try:
        validate_adapter(MissingMethodAdapter())
        raise AssertionError("缺方法应拒绝")
    except ContractViolation:
        pass


@register
def test_validate_no_version_attr():
    class NoVersion:
        def query(self, r): pass
        def receipt(self, r): pass
        def claim_gate(self, c, r=None): pass
        def capability(self): return "ADVISORY"
        def lifecycle(self, a, b): pass
    try:
        validate_adapter(NoVersion())
        raise AssertionError("缺 contract_version 应拒绝（视为 0）")
    except ContractViolation:
        pass


@register
def test_base_adapter_not_instantiable_direct():
    try:
        validate_adapter(BaseAdapter())
        raise AssertionError("BaseAdapter 直接实例化应拒绝")
    except ContractViolation:
        pass


@register
def test_capability_promote_conservative():
    c = CapabilityReporter("UNAVAILABLE")
    _check(c.level() == "UNAVAILABLE", "初始")
    c.promote("ADVISORY", evidence="doctor pass")
    _check(c.level() == "ADVISORY", "升 ADVISORY")
    try:
        c.promote("ENFORCED")  # 跳级
        raise AssertionError("跳级应拒绝")
    except ContractViolation:
        pass
    c.promote("AUDIT", evidence="gate audit")
    c.promote("ENFORCED", evidence="conformance+e2e")
    _check(c.level() == "ENFORCED", "逐级到 ENFORCED")
    try:
        c.promote("ADVISORY")  # 降级走 demote
        raise AssertionError("promote 不得降级")
    except ContractViolation:
        pass


@register
def test_capability_demote():
    c = CapabilityReporter("ENFORCED")
    c.demote("AUDIT", reason="e2e 回归失败")
    _check(c.level() == "AUDIT", "降 AUDIT")
    try:
        c.demote("ENFORCED")
        raise AssertionError("demote 只能降级")
    except ContractViolation:
        pass
    _check(len(c.history()) == 1, "历史记录")


@register
def test_truth_aware_adapter_query_uses_planner():
    a = TruthAwareAdapter(planner=TruthPlanner())
    plan = a.query({"claim_types": ["REPO_LOCAL_HEAD"]})
    _check(plan[0]["claim_type"] == "REPO_LOCAL_HEAD", "planner 规划")
    _check(a.capability() == "ADVISORY", "默认 ADVISORY")
    try:
        a.lifecycle("install", "b1")
        raise AssertionError("未实现 lifecycle 应抛 NotImplementedError")
    except NotImplementedError:
        pass


@register
def test_validate_adapter_no_git_surface():
    """Adapter 类不得含 git 直连方法名（合同层轻量探测）。"""
    for name in ("git", "rev-parse", "ls-remote"):
        _check(not hasattr(GoodAdapter(), name), "Adapter 不应暴露 %s" % name)


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
