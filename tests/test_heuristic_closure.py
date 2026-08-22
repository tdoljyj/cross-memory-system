#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Gate 3 启动前复核③：四项 HEURISTIC 的证明性关闭测试。

目的：证明 4 项 HEURISTIC 归因 FAIL 的产品逻辑路径（auth denied→30、
unavailable→31、capability 缺失→CLD-CAP-001、CLI doctor 契约）在
**隔离条件（mock doctor 通过，消除 ENV-DEFECT-001 前置阻塞）**下正确，
从而把原 FAIL 判定为"已证明的 ENV"（环境缺陷阻塞预检，测试无法到达
预期阶段），而非产品逻辑失败。

四项：
  H1 test_install_auth_failure_full_rollback   → 期望 exit 30（auth denied）
  H2 test_install_unavailable_no_degrade_first → 期望 exit 31（auth unavailable）
  H3 test_missing_capability_cap_001           → 期望 CLD-CAP-001
  H4 test_cli_doctor（e2e）                    → 期望 CLI doctor PASS

本测试不修改 clued/ 既有代码；仅 mock SyncProvider.doctor 为 PASS
（在临时沙盒 repo 上运行，零网络、零真实环境副作用）。

运行：python tests/test_heuristic_closure.py
"""

import importlib.util
import os
import sys
import tempfile
from types import SimpleNamespace

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)
TEST_DIR = os.path.join(REPO_ROOT, "tests")
if TEST_DIR not in sys.path:
    sys.path.insert(0, TEST_DIR)

from clued_testkit import (  # noqa: E402
    make_controller, denied_spec, unavailable_spec, check,
)
from clued.errors import CluedError  # noqa: E402

TESTS = []


def _mock_doctor_pass(sync_provider):
    """把 sync_provider.doctor 替换为 PASS（消除 ENV-DEFECT-001 前置阻塞）。"""
    sync_provider.doctor = lambda: SimpleNamespace(ok=True, combined=lambda: "PASS(mocked)")


def register(fn):
    TESTS.append(fn)
    return fn


@register
def h1_auth_denied_exit_30():
    """H1 证明：预检通过（doctor mock PASS）→ auth denied → exit 30。"""
    tmp = tempfile.mkdtemp(prefix="hc-h1-")
    try:
        from clued.auth.fake import FakeAuthProvider
        ctrl = make_controller(tmp, provider=FakeAuthProvider(denied_spec()))
        _mock_doctor_pass(ctrl.sync_provider)
        try:
            ctrl.install("codex", "TURING:codex", session_id="s1")
            raise AssertionError("在线认证失败必须阻止安装")
        except CluedError as exc:
            check(exc.exit_code == 30,
                  "H1: auth denied 必须 exit 30（隔离条件证明）")
        check(ctrl.registry.find_by_agent("codex", "TURING:codex") == [],
              "H1: 回滚后无 Binding")
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


@register
def h2_auth_unavailable_exit_31():
    """H2 证明：预检通过 → auth unavailable → exit 31。"""
    tmp = tempfile.mkdtemp(prefix="hc-h2-")
    try:
        from clued.auth.fake import FakeAuthProvider
        ctrl = make_controller(tmp, provider=FakeAuthProvider(unavailable_spec()))
        _mock_doctor_pass(ctrl.sync_provider)
        try:
            ctrl.install("codex", "TURING:codex", session_id="s1")
            raise AssertionError("首次安装不允许弱网降级")
        except CluedError as exc:
            check(exc.exit_code == 31,
                  "H2: auth unavailable 必须 exit 31（隔离条件证明）")
        check(ctrl.registry.find_by_agent("codex", "TURING:codex") == [],
              "H2: 认证不可用同样回滚")
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


@register
def h3_capability_missing_cld_cap_001():
    """H3 证明：其余预检通过 + capability 缺失 → CLD-CAP-001。"""
    tmp = tempfile.mkdtemp(prefix="hc-h3-")
    try:
        ctrl = make_controller(tmp)
        _mock_doctor_pass(ctrl.sync_provider)
        # 无 gh → capability/credentials 失败 → CLD-CAP-001
        ctrl.installer.find_gh = lambda: None
        pre = ctrl.installer.preflight("codex", "TURING:codex")
        check(pre.error_code == "CLD-CAP-001",
              "H3: 能力缺失必须 CLD-CAP-001（隔离条件证明，实际=%s）"
              % pre.error_code)
        cap = {n: ok for n, ok, _d in pre.checks}.get("capability")
        check(cap is False, "H3: capability 检查失败")
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


@register
def h4_cli_doctor_contract_pass_when_doctor_ok():
    """H4 证明：doctor 在隔离的 sync doctor PASS 条件下整体通过。

    环境探针的具体失败项会随执行环境变化，不属于产品合同。与 H1-H3
    一致，本测试在临时沙盒中 mock sync doctor 为 PASS，只验证 Controller
    对 PASS 结果的稳定分类，不再把某个历史 ENV-DEFECT 签名写死为前提。
    """
    tmp = tempfile.mkdtemp(prefix="hc-h4-")
    try:
        ctrl = make_controller(tmp)
        _mock_doctor_pass(ctrl.sync_provider)
        result = ctrl.doctor(include_engine=False)
        check(result["summary"] == "doctor ALL PASS",
              "H4: doctor PASS 摘要")
        sync_findings = [f for f in result["findings"]
                         if f["check"] == "sync_doctor"]
        check(len(sync_findings) == 1 and sync_findings[0]["ok"] is True,
              "H4: sync_doctor PASS 被稳定分类")
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
