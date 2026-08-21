# -*- coding: utf-8 -*-
"""Clued 卸载测试（协议 §12 / §19.5）。

覆盖：默认只卸载当前 Agent / 其他 Binding 与共享运行时保持可用 /
pending 数量准确展示 / 离线卸载 REMOTE_REVOCATION_PENDING + 撤销队列 /
在线卸载远端撤销 / 本地凭据立即失效 / 最后 Binding 才提供共享清理 /
云端数据不被默认删除 / artifact 校验不符停止危险删除 / 重复卸载幂等 /
卸载后无法 Memory Access。
"""

import json
import os
import random
import sys
import tempfile

from clued_testkit import check, git, make_controller
from clued_testkit import requires_ref_write, run_tests  # ENV 归因（R3 P0-3）

from clued import state_machine as SM
from clued.errors import CluedError

random.uniform = lambda a, b: 0.0

SCOPES = ["memory:read", "memory:write", "sync:request"]
AUTH = {"kind": "AUTHORIZED", "account_id": "github:testuser",
        "scopes": SCOPES, "subject": "testuser"}
UNAV = {"kind": "UNAVAILABLE", "reason": "network", "detail": "offline"}


def _tmp():
    return tempfile.mkdtemp(prefix="clued-uninstall-")


def _two_agents(tmp, provider):
    ctrl = make_controller(tmp, provider=provider)
    b1 = ctrl.install("codex", "TURING:codex", session_id="s1")["binding"]
    b2 = ctrl.install("codex", "OTHER:codex", session_id="s2")["binding"]
    return ctrl, b1, b2


def test_uninstall_default_only_current_agent():
    tmp = _tmp()
    from clued.auth.fake import FakeAuthProvider
    ctrl, b1, b2 = _two_agents(tmp, FakeAuthProvider(
        {"outcomes": [AUTH, AUTH, AUTH], "revoke": {"ok": True,
                                                    "remote_confirmed": True}}))
    result = ctrl.uninstall(b1["binding_id"], session_id="s3")
    check(result["state"] == SM.UNINSTALLED, "卸载完成")
    check(result.get("remote_revocation_pending") is False, "在线撤销完成")
    # 其他 Binding 保持有效（§12.2.11）
    check(ctrl.registry.load_binding(b2["binding_id"])["status"] == "ACTIVE",
          "其他 Agent 不受影响")
    # 共享运行时/记忆仍在
    check(os.path.isdir(ctrl.paths.root), "共享运行时保留（§12.5）")
    check(os.path.isfile(os.path.join(ctrl.repo, "memory", "index.json")),
          "共享记忆保留")
    # 云端数据未默认删除
    remote = git("ls-remote", "origin", "main", cwd=ctrl.repo).stdout.split()[0]
    local = git("rev-parse", "HEAD", cwd=ctrl.repo).stdout.strip()
    check(local == remote, "远端未变（云端数据不默认删除，§12.1）")


def test_uninstall_removes_local_credentials_immediately():
    tmp = _tmp()
    from clued.auth.fake import FakeAuthProvider
    ctrl, b1, b2 = _two_agents(tmp, FakeAuthProvider(
        {"outcomes": [AUTH, AUTH, AUTH], "revoke": {"ok": True,
                                                    "remote_confirmed": True}}))
    check(os.path.isfile(ctrl.paths.auth_cache(b1["binding_id"])),
          "卸载前 LKG 存在")
    ctrl.uninstall(b1["binding_id"], session_id="s3")
    check(not os.path.isfile(ctrl.paths.auth_cache(b1["binding_id"])),
          "本地凭据证明立即失效（§12.2.7）")
    check(not os.path.isfile(
        ctrl.paths.binding_manifest(b1["binding_id"])),
          "binding 清单已移除")


def test_uninstall_removes_state_json():
    """P0：卸载必须清除三轴状态 state.json（P0-1 布局 binding.json+state.json
    原子双写），否则残留致目录非空、卸载不彻底。"""
    tmp = _tmp()
    from clued.auth.fake import FakeAuthProvider
    ctrl, b1, b2 = _two_agents(tmp, FakeAuthProvider(
        {"outcomes": [AUTH, AUTH, AUTH], "revoke": {"ok": True,
                                                    "remote_confirmed": True}}))
    bid = b1["binding_id"]
    state_path = os.path.join(ctrl.paths.binding_dir(bid), "state.json")
    check(os.path.isfile(state_path), "卸载前 state.json 存在（P0-1 双写布局）")
    ctrl.uninstall(bid, session_id="s3")
    check(not os.path.isfile(state_path), "卸载后 state.json 已清除（P0）")
    check(not os.path.isdir(ctrl.paths.binding_dir(bid)),
          "binding 目录已彻底移除（无残留）")


def test_uninstall_online_pending_shows_count_and_blocks():
    tmp = _tmp()
    from clued.auth.fake import FakeAuthProvider
    provider = FakeAuthProvider({"outcomes": [AUTH, UNAV, UNAV, AUTH],
                                 "revoke": {"ok": True,
                                            "remote_confirmed": True}})
    ctrl = make_controller(tmp, provider=provider)
    b1 = ctrl.install("codex", "TURING:codex", session_id="s1")["binding"]
    bid = b1["binding_id"]
    ctrl.memory_write(bid, "s-d", "CREATE", "x", category="state",
                      remember=True)
    ctrl.memory_write(bid, "s-d", "CREATE", "y", category="state",
                      remember=True)
    try:
        ctrl.uninstall(bid, session_id="s3")
        raise AssertionError("有 pending 必须阻止在线卸载（§12.3）")
    except CluedError as exc:
        check(exc.code == "CLD-UNINSTALL-001", exc.code)
        check("2" in exc.message, "展示准确 pending 数量: %s" % exc.message)
    check(ctrl.journal.pending_count(bid) == 2, "pending 未丢失")


def test_uninstall_online_discard_pending_exports():
    tmp = _tmp()
    from clued.auth.fake import FakeAuthProvider
    provider = FakeAuthProvider({"outcomes": [AUTH, UNAV, UNAV, AUTH],
                                 "revoke": {"ok": True,
                                            "remote_confirmed": True}})
    ctrl = make_controller(tmp, provider=provider)
    b1 = ctrl.install("codex", "TURING:codex", session_id="s1")["binding"]
    bid = b1["binding_id"]
    ctrl.memory_write(bid, "s-d", "CREATE", "x", category="state",
                      remember=True)
    # 先确认不带 --discard-pending 会阻止
    try:
        ctrl.uninstall(bid, session_id="s3")
        raise AssertionError("应被阻止")
    except CluedError:
        pass
    # 显式丢弃 → 导出 + 卸载
    result = ctrl.uninstall(bid, session_id="s3", discard_pending=True)
    check(result["state"] == SM.UNINSTALLED, "丢弃后卸载成功")
    exports = ctrl.paths.exports_dir()
    dirs = [d for d in os.listdir(exports)]
    check(len(dirs) == 1, "生成可恢复导出（§12.3 独立确认）")


def test_uninstall_offline_revocation_pending():
    tmp = _tmp()
    from clued.auth.fake import FakeAuthProvider
    provider = FakeAuthProvider({"outcomes": [AUTH, UNAV, UNAV, UNAV, UNAV],
                                 "revoke": {"ok": False, "reason": "network"}})
    ctrl = make_controller(tmp, provider=provider)
    b1 = ctrl.install("codex", "TURING:codex", session_id="s1")["binding"]
    bid = b1["binding_id"]
    ctrl.memory_write(bid, "s-d", "CREATE", "x", category="state",
                      remember=True)
    result = ctrl.uninstall(bid, session_id="s3")
    check(result["state"] == SM.UNINSTALLED, "本地解绑完成")
    check(result.get("remote_revocation_pending") is True,
          "REMOTE_REVOCATION_PENDING（§12.3 离线）")
    check("云端已撤销" not in result["summary"], "不得表述为云端已撤销（§12.4）")
    # 撤销队列登记 + Pending Journal 保留
    tasks = [t for t in os.listdir(ctrl.paths.revoke_queue_dir())
             if t.endswith(".json")]
    check(len(tasks) == 1, "撤销队列 1 条")
    check(ctrl.journal.pending_count(bid) == 1, "Pending Journal 保留")
    events = [e["event_type"] for e in ctrl.audit.tail(20)]
    check("uninstall_pending_revoke" in events, "审计 pending-revoke")


def test_revoke_queue_runs_after_reconnect():
    tmp = _tmp()
    from clued.auth.fake import FakeAuthProvider
    provider = FakeAuthProvider({"outcomes": [AUTH, UNAV, UNAV, AUTH],
                                 "revoke": {"ok": True,
                                            "remote_confirmed": True}})
    ctrl = make_controller(tmp, provider=provider)
    b1 = ctrl.install("codex", "TURING:codex", session_id="s1")["binding"]
    bid = b1["binding_id"]
    ctrl.uninstall(bid, session_id="s3")  # 离线（outcomes 耗尽后 AUTH 仍在）
    tasks = [t for t in os.listdir(ctrl.paths.revoke_queue_dir())
             if t.endswith(".json")]
    # 重新联网 → 优先执行撤销队列（§12.4）
    results = ctrl.uninstaller.run_revoke_queue()
    check(any(ok for _tid, ok in results), "撤销队列执行成功")
    done = json.load(open(os.path.join(ctrl.paths.revoke_queue_dir(),
                                       tasks[0]), encoding="utf-8"))
    check(done["status"] == "DONE", "撤销任务 DONE")


def test_uninstall_idempotent():
    tmp = _tmp()
    from clued.auth.fake import FakeAuthProvider
    ctrl, b1, b2 = _two_agents(tmp, FakeAuthProvider(
        {"outcomes": [AUTH, AUTH, AUTH], "revoke": {"ok": True,
                                                    "remote_confirmed": True}}))
    ctrl.uninstall(b1["binding_id"], session_id="s3")
    result = ctrl.uninstall(b1["binding_id"], session_id="s4")
    check(result.get("code") == "ALREADY_UNINSTALLED", "重复卸载幂等（§12.6）")
    check(ctrl.registry.load_binding(b2["binding_id"])["status"] == "ACTIVE",
          "幂等路径不误伤其他 Binding")


def test_uninstall_artifact_mismatch_stops_deletion():
    tmp = _tmp()
    from clued.auth.fake import FakeAuthProvider
    ctrl, b1, b2 = _two_agents(tmp, FakeAuthProvider(
        {"outcomes": [AUTH, AUTH, AUTH], "revoke": {"ok": True,
                                                    "remote_confirmed": True}}))
    bid = b1["binding_id"]
    art = b1["installed_artifacts"][0]
    with open(art["path"], "w", encoding="utf-8") as fh:
        fh.write("tampered")
    try:
        ctrl.uninstall(bid, session_id="s3")
        raise AssertionError("artifact 校验不符必须停止危险删除（§12.2.8）")
    except CluedError as exc:
        check(exc.code == "CLD-UNINSTALL-003", exc.code)
    check(ctrl.registry.load_binding(bid) is not None, "Binding 未被删除")
    # 其他 Binding 完好
    check(ctrl.registry.load_binding(b2["binding_id"])["status"] == "ACTIVE",
          "其他 Binding 完好")


def test_uninstall_blocks_memory_access_afterwards():
    tmp = _tmp()
    from clued.auth.fake import FakeAuthProvider
    ctrl, b1, b2 = _two_agents(tmp, FakeAuthProvider(
        {"outcomes": [AUTH, AUTH, AUTH], "revoke": {"ok": True,
                                                    "remote_confirmed": True}}))
    bid = b1["binding_id"]
    ctrl.uninstall(bid, session_id="s3")
    try:
        ctrl.memory_recall(bid, "s4", "测试", tier="T2")
        raise AssertionError("卸载后必须无法 Memory Access（§12.2.10）")
    except CluedError as exc:
        check(exc.code == "CLD-BIND-001", "CLD-BIND-001: %s" % exc.code)


def test_remove_node_requires_confirm():
    tmp = _tmp()
    from clued.auth.fake import FakeAuthProvider
    ctrl, b1, b2 = _two_agents(tmp, FakeAuthProvider(
        {"outcomes": [AUTH, AUTH], "revoke": {"ok": True,
                                              "remote_confirmed": True}}))
    try:
        ctrl.uninstall("none", mode="remove-node")
        raise AssertionError("remove-node 必须二次确认（§12.1）")
    except CluedError as exc:
        check("confirm" in exc.message.lower() or "确认" in exc.message,
              "要求二次确认")
    # 二次确认后全部移除，但共享记忆不删
    result = ctrl.uninstall("none", mode="remove-node",
                            confirm_shared_cleanup=True)
    check(result.get("removed_bindings") == 2, "节点全部 Binding 移除")
    check(os.path.isfile(os.path.join(ctrl.repo, "memory", "index.json")),
          "用户记忆与云端数据不被默认删除（§12.5）")


def test_uninstall_denied_still_removes_local():
    """明确拒绝：不得再读/同步记忆，但必须允许移除本地适配器与凭据（§12.3）。"""
    tmp = _tmp()
    from clued.auth.fake import FakeAuthProvider
    provider = FakeAuthProvider({"outcomes": [AUTH,
                                              {"kind": "DENIED",
                                               "reason": "revoked"}],
                                 "revoke": {"ok": False, "reason": "denied"}})
    ctrl = make_controller(tmp, provider=provider)
    b1 = ctrl.install("codex", "TURING:codex", session_id="s1")["binding"]
    bid = b1["binding_id"]
    result = ctrl.uninstall(bid, session_id="s3")
    check(result["state"] == SM.UNINSTALLED, "DENIED 下仍完成本地卸载")
    check(not os.path.isfile(ctrl.paths.auth_cache(bid)), "凭据已移除")
    check(result.get("remote_revocation_pending") is True,
          "远端撤销待完成")


TESTS = [
    test_uninstall_default_only_current_agent,
    test_uninstall_removes_local_credentials_immediately,
    test_uninstall_removes_state_json,
    test_uninstall_online_pending_shows_count_and_blocks,
    test_uninstall_online_discard_pending_exports,
    test_uninstall_offline_revocation_pending,
    test_revoke_queue_runs_after_reconnect,
    test_uninstall_idempotent,
    test_uninstall_artifact_mismatch_stops_deletion,
    test_uninstall_blocks_memory_access_afterwards,
    test_remove_node_requires_confirm,
    test_uninstall_denied_still_removes_local,
]



TESTS = [requires_ref_write(t) for t in TESTS]

def main():
    run_tests(TESTS)


if __name__ == "__main__":
    main()
