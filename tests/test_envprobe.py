#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ENV-DEFECT-001/002 隔离检测与测试归因测试（Gate 1 裁决）。

probe 测试在**临时克隆**上执行，绝不触碰真实仓库；归因测试验证
环境失败与逻辑失败分栏正确（环境失败不降低逻辑测试门槛）。

运行：python tests/test_envprobe.py
"""

import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory_engine import envprobe  # noqa: E402

TESTS = []


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def register(fn):
    TESTS.append(fn)
    return fn


@register
def test_probe_runs_and_returns_result():
    result = envprobe.probe()
    _check(isinstance(result, envprobe.EnvProbeResult), "返回 EnvProbeResult")
    _check(isinstance(result.refs_remotes_writable, bool), "refs 字段为 bool")
    _check(isinstance(result.safe_delete_available, bool), "safe-delete 字段为 bool")
    _check(isinstance(result.defects(), list), "defects 为 list")
    d = result.to_dict()
    _check("defects" in d and "details" in d, "to_dict 结构")


@register
def test_probe_refs_write_does_not_touch_real_repo():
    """probe 在临时目录执行；结果可自适应（本环境可能 ENV-DEFECT-001）。"""
    import shutil
    import tempfile
    workdir = tempfile.mkdtemp(prefix="envprobe-work-")
    try:
        ok, detail = envprobe.probe_refs_remotes_write(workdir=workdir)
        _check(isinstance(ok, bool) or ok is None, "refs probe 返回 bool/None")
        _check(isinstance(detail, str), "detail 为 str")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


@register
def test_probe_safe_delete_runs():
    ok, detail = envprobe.probe_safe_delete()
    _check(isinstance(ok, bool), "safe-delete probe 返回 bool")
    _check(detail, "detail 非空")


@register
def test_diagnose_output():
    result = envprobe.probe()
    text = envprobe.diagnose(result)
    _check("capability probe" in text, "诊断标题")
    _check("refs/remotes" in text, "refs 行")


@register
def test_attribution_env_pattern():
    a = envprobe.TestAttributor()
    _check(a.attribute("t1", "PASS", "x") == "PASS", "PASS 保持")
    _check(a.attribute("t2", "SKIP", "x") == "SKIP", "SKIP 保持")
    _check(a.attribute("t3", "FAIL", "doctor: ref write persists (behavior probe)")
           == "ENV", "ref 探针失败 → ENV")
    _check(a.attribute("t4", "FAIL",
                       "SAFE_DELETE_FAIL_CLOSED windows-sandbox-recycle-bin-unavailable")
           == "ENV", "safe-delete 失败 → ENV")
    _check(a.attribute("t5", "FAIL", "assert 2 == 3 logic bug") == "LOGIC",
           "普通断言失败 → LOGIC")
    _check(a.attribute("t6", "ERROR", "Traceback module not found") == "LOGIC",
           "ERROR → LOGIC")


@register
def test_attribution_summary_split():
    a = envprobe.TestAttributor()
    results = [
        ("a", "PASS", ""),
        ("b", "FAIL", "ref write persists"),
        ("c", "FAIL", "logic bug"),
        ("d", "SKIP", ""),
    ]
    stats, by_name = a.summarize(results)
    _check(stats["PASS"] == 1 and stats["SKIP"] == 1, "PASS/SKIP 计数")
    _check(stats["ENV"] == 1 and stats["LOGIC"] == 1, "ENV/LOGIC 分栏")
    _check(by_name["b"] == "ENV" and by_name["c"] == "LOGIC", "逐项归因")


@register
def test_attribution_json():
    a = envprobe.TestAttributor()
    out = a.to_json([("x", "FAIL", "SAFE_DELETE_FAIL_CLOSED")])
    _check('"ENV": 1' in out, "json 含 ENV 分栏")


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
