# -*- coding: utf-8 -*-
"""Clued 安装测试（协议 §6 / §19.1）。

覆盖：全新节点首次安装 / 同节点第二 Agent 独立 Binding / 重复安装
ALREADY_INSTALLED / artifact 篡改 repair / 在线认证失败完全回滚 /
doctor FAIL 不得完成安装 / 无能力 CLD-CAP-001 / 安装不修改既有记忆与
无关 Agent 配置。真实同步脚本（沙盒拷贝 + 本地 remote），零网络。
"""

import os
import sys
import tempfile

from clued_testkit import (
    authorized_spec, check, denied_spec, git, make_controller,
    unavailable_spec,
)

from clued_testkit import requires_ref_write, run_tests  # ENV 归因（R3 P0-3）

from clued import state_machine as SM
from clued.errors import CluedError


def _tmp():
    return tempfile.mkdtemp(prefix="clued-install-")


def test_fresh_node_install_success():
    tmp = _tmp()
    ctrl = make_controller(tmp)
    result = ctrl.install("codex", "TURING:codex", session_id="sess-a")
    binding = result["binding"]
    check(binding["status"] == "ACTIVE", "安装后 ACTIVE")
    check(binding["agent_type"] == "codex", "agent_type 记录")
    check(binding["binding_id"] != binding["agent_id"],
          "binding_id 与 agent_id 字段独立（§5.1）")
    check(ctrl.get_state(binding["binding_id"]) == SM.ONLINE_SYNCED,
          "安装成功 → ONLINE_SYNCED")
    node = ctrl.registry.load_node()
    check(node is not None and node["binding_count"] == 1,
          "node manifest 计数 1")
    # artifact 已登记且校验通过
    matched, mismatched = ctrl.registry.artifact_checks(binding)
    check(len(matched) >= 1 and not mismatched, "adapter artifact 登记且有效")
    # LKG 已登记
    entry, err = ctrl.auth_cache.load(binding["binding_id"])
    check(err is None and entry is not None, "安装后 LKG 存在")
    # 审计
    events = [e["event_type"] for e in ctrl.audit.tail(20)]
    check("install_begin" in events and "install_success" in events,
          "审计 install begin/success")
    check("bind_create" in events, "审计 bind_create")


def test_second_agent_independent_binding():
    tmp = _tmp()
    ctrl = make_controller(tmp)
    b1 = ctrl.install("codex", "TURING:codex", session_id="s1")["binding"]
    b2 = ctrl.install("codex", "TURING:codex-2", session_id="s2")["binding"]
    check(b1["binding_id"] != b2["binding_id"], "Binding 独立")
    check(b1["agent_id"] != b2["agent_id"], "agent_id 不同（§1.2 不共享身份）")
    check(b1["node_id"] == b2["node_id"], "同节点共享 node_id")
    node = ctrl.registry.load_node()
    check(node["binding_count"] == 2, "node binding_count=2")
    # b1 不受影响
    check(ctrl.registry.load_binding(b1["binding_id"])["status"] == "ACTIVE",
          "第一 Agent 仍 ACTIVE")


def test_repeat_install_already_installed():
    tmp = _tmp()
    ctrl = make_controller(tmp)
    first = ctrl.install("codex", "TURING:codex", session_id="s1")
    second = ctrl.install("codex", "TURING:codex", session_id="s2")
    check(second.get("code") == "ALREADY_INSTALLED", "重复安装幂等")
    check(second["binding"]["binding_id"] == first["binding"]["binding_id"],
          "不创建第二个 Binding（§6.5）")
    check(len(ctrl.registry.find_by_agent("codex", "TURING:codex")) == 1,
          "同 Agent 只有一个 Binding")


def test_artifact_tamper_repairs():
    tmp = _tmp()
    ctrl = make_controller(tmp)
    first = ctrl.install("codex", "TURING:codex", session_id="s1")
    binding = first["binding"]
    art = binding["installed_artifacts"][0]
    # 篡改 artifact 内容
    with open(art["path"], "w", encoding="utf-8") as fh:
        fh.write("tampered")
    result = ctrl.install("codex", "TURING:codex", session_id="s2")
    check(result.get("code") == "REPAIRED", "篡改后修复: %s" % result.get("code"))
    matched, mismatched = ctrl.registry.artifact_checks(
        ctrl.registry.load_binding(binding["binding_id"]))
    check(not mismatched, "修复后校验通过")


def test_install_auth_failure_full_rollback():
    tmp = _tmp()
    from clued.auth.fake import FakeAuthProvider
    ctrl = make_controller(tmp, provider=FakeAuthProvider(denied_spec()))
    try:
        ctrl.install("codex", "TURING:codex", session_id="s1")
        raise AssertionError("在线认证失败必须阻止安装（§6.4）")
    except CluedError as exc:
        check(exc.exit_code == 30, "明确拒绝退出码 30")
    check(ctrl.registry.find_by_agent("codex", "TURING:codex") == [],
          "回滚后无 Binding（§6.4 禁止创建可用 Binding）")
    check(not os.path.isfile(
        os.path.join(ctrl.paths.root, "auth", "bind-1.json")),
          "无残留 LKG")
    staging = ctrl.paths.staging_dir()
    leftovers = ([d for d in os.listdir(staging) if not d.startswith(".")]
                 if os.path.isdir(staging) else [])
    check(not leftovers, "staging 无残留（§6.2 无半安装状态）")
    events = [e["event_type"] for e in ctrl.audit.tail(20)]
    check("install_rollback_complete" in events, "审计回滚完成")


def test_install_unavailable_no_degrade_first_time():
    tmp = _tmp()
    from clued.auth.fake import FakeAuthProvider
    ctrl = make_controller(tmp, provider=FakeAuthProvider(unavailable_spec()))
    try:
        ctrl.install("codex", "TURING:codex", session_id="s1")
        raise AssertionError("首次安装不允许弱网降级（§6.3.5）")
    except CluedError as exc:
        check(exc.exit_code == 31, "不可用退出码 31")
    check(ctrl.registry.find_by_agent("codex", "TURING:codex") == [],
          "认证不可用同样回滚")


def test_doctor_fail_blocks_install():
    tmp = _tmp()
    ctrl = make_controller(tmp)
    # 破坏 doctor：删除同步脚本（预检第 4 项直接失败）
    os.remove(os.path.join(ctrl.repo, "sync-memory.py"))
    try:
        ctrl.install("codex", "TURING:codex", session_id="s1")
        raise AssertionError("doctor/预检 FAIL 不得完成安装（§19.1）")
    except CluedError as exc:
        check(exc.code in ("CLD-INSTALL-001", "CLD-SYNC-001"),
              "预检失败错误码: %s" % exc.code)
    check(ctrl.registry.find_by_agent("codex", "TURING:codex") == [],
          "无半安装状态")


def test_missing_capability_cap_001():
    tmp = _tmp()
    ctrl = make_controller(tmp)
    # 无 gh（能力缺失）→ 预检 capability 失败 → CLD-CAP-001
    ctrl.installer.find_gh = lambda: None
    pre = ctrl.installer.preflight("codex", "TURING:codex")
    check(not pre.ok, "能力缺失预检失败")
    check(pre.error_code == "CLD-CAP-001", "CLD-CAP-001（§1.4）")
    cap = {name: ok for name, ok, _d in pre.checks}.get("capability")
    check(cap is False, "capability 检查失败")


def test_install_does_not_modify_memory_or_others():
    tmp = _tmp()
    ctrl = make_controller(tmp)
    before = git("rev-parse", "HEAD", cwd=ctrl.repo).stdout.strip()
    ctrl.install("codex", "TURING:codex", session_id="s1")
    ctrl.install("codex", "OTHER:codex", session_id="s2")
    after = git("rev-parse", "HEAD", cwd=ctrl.repo).stdout.strip()
    check(before == after, "安装不修改 Canonical Store（记忆文件不变）")
    # 无关 Agent 配置不受影响：第二个 Agent 安装不影响第一个
    b1 = ctrl.registry.find_by_agent("codex", "TURING:codex")[0]
    check(b1["status"] == "ACTIVE", "第一个 Binding 完好")


def test_binding_conflict_detected():
    tmp = _tmp()
    ctrl = make_controller(tmp)
    ctrl.install("codex", "TURING:codex", session_id="s1")
    # 手工制造第二个同 Agent ACTIVE Binding（模拟历史残留）
    from clued import manifests
    from clued.identifiers import new_uuid
    b = manifests.build_binding_manifest(
        new_uuid(), new_uuid(), ctrl.registry.load_node()["node_id"],
        "github:testuser", "codex", "TURING:codex", "0.1.x",
        manifests.SCOPES, status="ACTIVE")
    ctrl.registry.save_binding(b)
    try:
        ctrl.install("codex", "TURING:codex", session_id="s2")
        raise AssertionError("多 Binding 必须 BINDING_CONFLICT（§6.5）")
    except CluedError as exc:
        check(exc.code == "CLD-BIND-002", exc.code)


TESTS = [
    test_fresh_node_install_success,
    test_second_agent_independent_binding,
    test_repeat_install_already_installed,
    test_artifact_tamper_repairs,
    test_install_auth_failure_full_rollback,
    test_install_unavailable_no_degrade_first_time,
    test_doctor_fail_blocks_install,
    test_missing_capability_cap_001,
    test_install_does_not_modify_memory_or_others,
    test_binding_conflict_detected,
]



TESTS = [requires_ref_write(t) for t in TESTS]

def main():
    run_tests(TESTS)


if __name__ == "__main__":
    main()
