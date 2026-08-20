#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""R1 修复验证：试装执行器（单进程单 install / journal 零残留 / 关闭自动重试）。

覆盖（裁决 2026-08-20 R1 范围）：
- 首次 install 成功 → journal 零残留；
- 第二次幂等 install → ALREADY_INSTALLED 且 journal 仍零；
- 模拟上次中断（预置 journal）→ preflight 拒绝（跨进程防重试）；
- 进程内 install 计数 >1 → 拒绝；
- "一次进程调用、一次 install 调用"证据输出。

全部在临时 fixture 执行，不触碰真实 Binding 路径。

运行：python tests/test_trial_runner.py
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from tools.trial_runner import TrialRunner, TrialStop  # noqa: E402

TESTS = []
PY = sys.executable


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def register(fn):
    TESTS.append(fn)
    return fn


@register
def test_first_install_journal_zero():
    tmp = tempfile.mkdtemp(prefix="tr-")
    try:
        state = os.path.join(tmp, "state")
        from memory_engine.lifecycle_ctl import LifecycleController
        runner = TrialRunner(state)
        result = runner.install_once(
            "b1", lambda: LifecycleController(state_root=state))
        _check(result["binding"] == "ACTIVE", "install → ACTIVE")
        leftovers = [f for f in os.listdir(state) if f.startswith(".journal-")]
        _check(leftovers == [], "首次 install 后 journal 零残留")
        ev = runner.evidence("b1", result)
        _check(ev["install_calls"] == 1 and ev["install_limit"] == 1,
               "单次调用证据")
        _check(ev["single_process_single_install"] is True,
               "一次进程一次 install")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_idempotent_install_journal_zero():
    tmp = tempfile.mkdtemp(prefix="tr-")
    try:
        state = os.path.join(tmp, "state")
        from memory_engine.lifecycle_ctl import LifecycleController
        runner = TrialRunner(state)
        runner.install_once("b1", lambda: LifecycleController(state_root=state))
        # 第二次（幂等）
        runner2 = TrialRunner(state)
        result = runner2.install_once(
            "b1", lambda: LifecycleController(state_root=state))
        _check(result.get("note") == "ALREADY_INSTALLED", "幂等返回")
        leftovers = [f for f in os.listdir(state) if f.startswith(".journal-")]
        _check(leftovers == [], "幂等返回后 journal 零残留（R1 修复）")
        # binding 无重复/漂移
        files = [f for f in os.listdir(state) if f == "b1.json"]
        _check(len(files) == 1, "binding 文件唯一")
        st = json.load(open(os.path.join(state, "b1.json"), encoding="utf-8"))
        _check(st["binding"] == "ACTIVE" and st["truth"] == "ADVISORY",
               "三轴无漂移")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_interrupted_prevents_retry():
    """模拟上次中断（journal 残留）→ 拒绝执行（跨进程防自动重试）。"""
    tmp = tempfile.mkdtemp(prefix="tr-")
    try:
        state = os.path.join(tmp, "state")
        os.makedirs(state)
        with open(os.path.join(state, ".journal-b1-abc123.json"), "w") as f:
            f.write('{"op_id":"abc123","binding_id":"b1","action":"install"}')
        from memory_engine.lifecycle_ctl import LifecycleController
        runner = TrialRunner(state)
        try:
            runner.install_once("b1",
                                lambda: LifecycleController(state_root=state))
            raise AssertionError("journal 残留必须拒绝执行（不自动重试）")
        except TrialStop as e:
            _check("journal 残留" in str(e), "STOP 原因=journal 残留")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_install_call_count_limit():
    """进程内 install 调用计数 >1 → 拒绝。"""
    tmp = tempfile.mkdtemp(prefix="tr-")
    try:
        state = os.path.join(tmp, "state")
        from memory_engine.lifecycle_ctl import LifecycleController
        runner = TrialRunner(state)
        runner.install_once("b1", lambda: LifecycleController(state_root=state))
        try:
            runner.install_once("b1",
                                lambda: LifecycleController(state_root=state))
            raise AssertionError("同进程第二次 install 必须拒绝")
        except TrialStop as e:
            _check("禁止重试" in str(e), "STOP 原因=调用计数超限")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_cli_evidence_output():
    """CLI 调用：输出可核验证据（一次进程一次 install）。"""
    tmp = tempfile.mkdtemp(prefix="tr-")
    try:
        state = os.path.join(tmp, "state")
        p = subprocess.run(
            [PY, os.path.join(REPO_ROOT, "tools", "trial_runner.py"),
             "install", state, "cli-1"],
            capture_output=True, text=True, encoding="utf-8", timeout=60)
        _check(p.returncode == 0, "CLI exit 0: %s" % p.stderr[:200])
        ev = json.loads(p.stdout)
        _check(ev["install_calls"] == 1 and ev["single_process_single_install"],
               "CLI 证据：一次进程一次 install")
        leftovers = [f for f in os.listdir(state) if f.startswith(".journal-")]
        _check(leftovers == [], "CLI 后 journal 零残留")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_cli_retry_process_stops():
    """CLI 层面：第二次进程（模拟 Bash 自动重试）因 preflight 拒绝。"""
    tmp = tempfile.mkdtemp(prefix="tr-")
    try:
        state = os.path.join(tmp, "state")
        # 第一次进程：正常 install
        p1 = subprocess.run(
            [PY, os.path.join(REPO_ROOT, "tools", "trial_runner.py"),
             "install", state, "cli-2"],
            capture_output=True, text=True, encoding="utf-8", timeout=60)
        _check(p1.returncode == 0, "第一次进程 OK")
        # 模拟中断：人为遗留 journal（跨进程重试场景的等价物）
        with open(os.path.join(state, ".journal-cli-2-xyz.json"), "w") as f:
            f.write("{}")
        # 第二次进程（自动重试）→ 必须 STOP（exit 3）
        p2 = subprocess.run(
            [PY, os.path.join(REPO_ROOT, "tools", "trial_runner.py"),
             "install", state, "cli-2"],
            capture_output=True, text=True, encoding="utf-8", timeout=60)
        _check(p2.returncode == 3, "第二次进程 STOP（exit 3，实际 %s）"
               % p2.returncode)
        _check("journal 残留" in p2.stderr, "STOP 原因=journal 残留")
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
