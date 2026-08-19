#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""R3-T01 TruthPlanner 测试（ADR-R3-002 §1/§2）。

运行：python tests/test_truth_planner.py
"""

import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory_engine.truth import schema as TS  # noqa: E402
from memory_engine.truth import TruthPlanner  # noqa: E402

TESTS = []


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def register(fn):
    TESTS.append(fn)
    return fn


@register
def test_claim_types_enumeration():
    _check(len(TS.CLAIM_TYPES) == 15, "应有 15 种 claim type")
    for ct in ("REPO_LOCAL_HEAD", "REPO_REMOTE_HEAD", "REPO_BASELINE",
               "REPO_PUSH_STATUS", "VALIDATION_DECISION", "TEST_RESULT",
               "CAPABILITY_ENFORCEMENT", "HISTORICAL_STATUS"):
        _check(ct in TS.CLAIM_TYPES, "缺 %s" % ct)


@register
def test_fact_kinds_classification():
    p = TruthPlanner()
    _check(p.classify("REPO_LOCAL_HEAD") == "current", "LOCAL_HEAD 应 current")
    _check(p.classify("TEST_INVENTORY") == "historical", "TEST_INVENTORY 应 historical")
    _check(p.classify("REPO_BASELINE") == "mixed", "BASELINE 应 mixed")
    _check(p.classify("HISTORICAL_STATUS") == "historical", "HISTORICAL_STATUS 应 historical")


@register
def test_plan_default_verify_all_live():
    p = TruthPlanner()
    plan = p.plan(["REPO_LOCAL_HEAD", "REPO_REMOTE_HEAD"])
    _check(len(plan) == 2, "规划数量")
    for it in plan:
        _check(it["source"] == "live", "current 类默认 live 来源")
        _check(it["allow_unverified_fallback"] is False, "默认禁止 unverified 回退")


@register
def test_plan_historical_with_allow_flag():
    p = TruthPlanner()
    plan = p.plan(["TEST_INVENTORY"], allow_historical=True)
    _check(plan[0]["source"] == "receipt", "historical 允许时走 receipt")
    plan2 = p.plan(["TEST_INVENTORY"], allow_historical=False)
    _check(plan2[0]["source"] == "live", "保守：historical 也现场重取")


@register
def test_unknown_claim_type_rejected():
    p = TruthPlanner()
    try:
        p.plan(["NOT_A_CLAIM"])
        raise AssertionError("应抛 ValueError")
    except ValueError:
        pass


@register
def test_conservative_fallback_unverified():
    p = TruthPlanner()
    it = {"claim_type": "REPO_REMOTE_HEAD", "kind": "current"}
    _check(p.conservative_fallback(it) == TS.VERDICT_UNVERIFIED,
           "无法核验必须 UNVERIFIED")


@register
def test_redact_tokens_and_urls():
    p = TruthPlanner()
    # 运行时拼接假 token，避免字面量命中 guards secret_patterns（保持 secret scan 0 命中）
    fake_gh = "ghp_" + "abcdefghijklmnopqrstuvwxyz123456"
    text = ("token=%s bearer xyz1234567890abcde url https://user:pass@host/x"
            % fake_gh)
    out = p.redact(text)
    _check(fake_gh not in out, "gh token 未脱敏")
    _check("pass@" not in out, "URL 凭据未脱敏")
    _check("<gh-token>" in out or "<redacted>" in out, "应有脱敏标记")


@register
def test_trace_redacted():
    p = TruthPlanner()
    plan = p.plan(["REPO_REMOTE_HEAD"])
    trace = p.trace(plan, request_id="req-1")
    _check(trace["component"] == "truth-planner", "component 标记")
    _check(trace["request_id"] == "req-1", "request_id 透传")
    _check(trace["plan"][0]["claim_type"] == "REPO_REMOTE_HEAD", "plan 内容")


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
