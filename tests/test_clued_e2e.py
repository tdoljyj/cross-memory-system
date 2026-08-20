# -*- coding: utf-8 -*-
"""Clued 端到端验收测试（协议 §13 / §19 / §20）。

覆盖：CLI JSON 合同（stdout 单一 JSON 对象、退出码、信封字段）/
同节点双 Agent 全生命周期（安装→降级写入→恢复→卸载→另一 Agent 存活）/
明确拒绝路径 / 状态查询不含私有内容 / doctor 命令。
真实同步脚本 + 本地 file remote + fake provider 故障注入，零网络。
"""

import json
import os
import random
import subprocess
import sys
import tempfile

from clued_testkit import check, git, make_sandbox, sh
from clued_testkit import requires_ref_write, run_tests  # ENV 归因（R3 P0-3）

random.uniform = lambda a, b: 0.0

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCOPES = ["memory:read", "memory:write", "sync:request"]
AUTH = {"kind": "AUTHORIZED", "account_id": "github:testuser",
        "scopes": SCOPES, "subject": "testuser"}
UNAV = {"kind": "UNAVAILABLE", "reason": "network", "detail": "offline"}
DENIED = {"kind": "DENIED", "reason": "forbidden", "detail": "no"}


def _tmp():
    return tempfile.mkdtemp(prefix="clued-e2e-")


def _write_spec(tmp, spec):
    path = os.path.join(tmp, "auth-spec.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(spec, fh)
    return path


def _cli_env(repo, runtime_root, spec_path):
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["CROSS_MEMORY_REPO"] = repo
    env["CROSS_MEMORY_CLUED_ROOT"] = runtime_root
    env["CLUED_AUTH_PROVIDER"] = "fake:%s" % spec_path
    env["PATH"] = ("C:\\Program Files\\Git\\cmd;" + env.get("PATH", ""))
    return env


def _cli(argv, cwd, env, expect_exit=0):
    p = subprocess.run([sys.executable, os.path.join(REPO_ROOT, "clued.py")]
                       + argv, cwd=cwd, env=env, capture_output=True,
                       text=True, encoding="utf-8", errors="replace",
                       timeout=120)
    if p.returncode != expect_exit:
        raise AssertionError(
            "cli 退出码 %d（期望 %d）: %s\nstdout:\n%s\nstderr:\n%s"
            % (p.returncode, expect_exit, " ".join(argv), p.stdout, p.stderr))
    return p


def test_cli_json_contract_single_object():
    tmp = _tmp()
    repo = make_sandbox(tmp)
    runtime = os.path.join(tmp, "runtime")
    spec = _write_spec(tmp, {"outcomes": [AUTH],
                             "revoke": {"ok": True, "remote_confirmed": True}})
    env = _cli_env(repo, runtime, spec)
    p = _cli(["status", "--json"], repo, env)
    # stdout 必须恰好一个 JSON 对象
    try:
        data = json.loads(p.stdout)
    except ValueError as exc:
        raise AssertionError("stdout 不是合法 JSON: %s" % exc)
    check(data["ok"] is True, "信封 ok")
    check(data["protocol_version"] == "0.3.0", "协议版本字段（v0.3.0）")
    for key in ("request_id", "code", "state", "message", "data",
                "actions", "retry_after_seconds", "timestamp"):
        check(key in data, "信封缺 %s" % key)
    # status 不含私有记忆内容（§7.1 MAY 条款）
    check("content" not in json.dumps(data, ensure_ascii=False),
          "status 不含记忆内容")
    check(len(data["data"]["bindings"]) == 0, "初始无 Binding")


def test_cli_install_status_roundtrip():
    tmp = _tmp()
    repo = make_sandbox(tmp)
    runtime = os.path.join(tmp, "runtime")
    spec = _write_spec(tmp, {"outcomes": [AUTH],
                             "revoke": {"ok": True, "remote_confirmed": True}})
    env = _cli_env(repo, runtime, spec)
    p = _cli(["install", "--agent-type", "codex", "--agent-instance",
              "TURING:codex", "--session-id", "cli-sess", "--json"],
             repo, env)
    data = json.loads(p.stdout)
    check(data["ok"] is True, "安装成功")
    check(data["data"]["binding"]["status"] == "ACTIVE", "Binding ACTIVE")
    bid = data["data"]["binding"]["binding_id"]
    p2 = _cli(["status", "--json"], repo, env)
    data2 = json.loads(p2.stdout)
    check(len(data2["data"]["bindings"]) == 1, "status 显示 1 个 Binding")
    check(data2["data"]["bindings"][0]["binding_id"] == bid, "binding_id 一致")
    check(data2["data"]["bindings"][0]["state"] == "ONLINE_SYNCED", "状态")


def test_cli_denied_exit_30():
    tmp = _tmp()
    repo = make_sandbox(tmp)
    runtime = os.path.join(tmp, "runtime")
    spec = _write_spec(tmp, {"outcomes": [AUTH],
                             "revoke": {"ok": True, "remote_confirmed": True}})
    env = _cli_env(repo, runtime, spec)
    _cli(["install", "--agent-type", "codex", "--agent-instance",
          "TURING:codex", "--session-id", "s1", "--json"], repo, env)
    st = json.loads(_cli(["status", "--json"], repo, env).stdout)
    bid = st["data"]["bindings"][0]["binding_id"]
    # 拒绝 spec：新会话 auth check → 明确拒绝 → 退出码 30
    denied_spec = _write_spec(tmp, {"outcomes": [DENIED],
                                    "revoke": {"ok": False}})
    env2 = _cli_env(repo, runtime, denied_spec)
    p = _cli(["auth", "check", "--binding-id", bid, "--session-id", "s2",
              "--json"], repo, env2, expect_exit=30)
    data = json.loads(p.stdout)
    check(data["ok"] is False, "ok=false")
    check(data["code"] == "CLD-AUTH-001", "CLD-AUTH-001")
    check(data["state"] == "LOCKED", "明确拒绝 → LOCKED")


def test_cli_degraded_memory_write_and_sync():
    tmp = _tmp()
    repo = make_sandbox(tmp)
    runtime = os.path.join(tmp, "runtime")
    spec = _write_spec(tmp, {"outcomes": [AUTH, UNAV, UNAV, AUTH],
                             "revoke": {"ok": True, "remote_confirmed": True}})
    env = _cli_env(repo, runtime, spec)
    _cli(["install", "--agent-type", "codex", "--agent-instance",
          "TURING:codex", "--session-id", "s1", "--json"], repo, env)
    st = json.loads(_cli(["status", "--json"], repo, env).stdout)
    bid = st["data"]["bindings"][0]["binding_id"]
    # 降级写入：ok=true、state=DEGRADED_LOCAL、synced=false、pending=1
    p = _cli(["memory", "add", "--content", "CLI 降级写入",
              "--category", "state", "--remember", "--binding-id", bid,
              "--session-id", "s-d", "--json"], repo, env)
    data = json.loads(p.stdout)
    check(data["ok"] is True, "降级本地成功 ok=true")
    check(data["state"] == "DEGRADED_LOCAL", "state=DEGRADED_LOCAL")
    check(data["data"]["synced"] is False, "不伪报已同步")
    check(data["data"]["pending"] == 1, "pending=1")
    # 手动同步（重新认证）→ ONLINE_SYNCED
    p2 = _cli(["sync", "--binding-id", bid, "--session-id", "s-r", "--json"],
              repo, env)
    data2 = json.loads(p2.stdout)
    check(data2["state"] == "ONLINE_SYNCED", "恢复 ONLINE_SYNCED")
    check(data2["data"].get("replayed") == 1, "重放 1")


def test_cli_exit_code_usage_error():
    tmp = _tmp()
    repo = make_sandbox(tmp)
    runtime = os.path.join(tmp, "runtime")
    spec = _write_spec(tmp, {"outcomes": [AUTH]})
    env = _cli_env(repo, runtime, spec)
    _cli(["install", "--agent-type", "codex", "--json"], repo, env,
         expect_exit=10)


def test_full_multi_agent_lifecycle():
    """同节点两个 Agent：独立安装 → 降级写入 → 恢复 → 卸载 A → B 存活。"""
    tmp = _tmp()
    from clued.auth.fake import FakeAuthProvider
    from clued_testkit import make_controller
    provider = FakeAuthProvider({
        "outcomes": [AUTH, AUTH, UNAV, UNAV, AUTH, AUTH],
        "revoke": {"ok": True, "remote_confirmed": True}})
    from clued.controller import Controller
    ctrl = make_controller(tmp, provider=provider)
    b1 = ctrl.install("codex", "TURING:codex", session_id="s1")["binding"]
    b2 = ctrl.install("codex", "OTHER:codex", session_id="s2")["binding"]
    # A 降级写入
    w = ctrl.memory_write(b1["binding_id"], "s-d", "CREATE", "A 的记忆",
                          category="state", remember=True)
    check(w["state"] == "DEGRADED_LOCAL" and w["pending"] == 1, "A 降级写入")
    # A 恢复
    s = ctrl.sync(b1["binding_id"], session_id="s-r")
    check(s["state"] == "ONLINE_SYNCED", "A 恢复")
    # B 全程可用
    check(ctrl.registry.load_binding(b2["binding_id"])["status"] == "ACTIVE",
          "B 全程 ACTIVE")
    # 卸载 A
    u = ctrl.uninstall(b1["binding_id"], session_id="s3")
    check(u["state"] == "UNINSTALLED", "A 卸载")
    check(u["other_bindings"] == 1, "B 仍在")
    check(ctrl.registry.load_binding(b2["binding_id"])["status"] == "ACTIVE",
          "卸载 A 后 B 仍 ACTIVE（§20.2）")


def test_cli_uninstall_and_already_uninstalled():
    tmp = _tmp()
    repo = make_sandbox(tmp)
    runtime = os.path.join(tmp, "runtime")
    spec = _write_spec(tmp, {"outcomes": [AUTH, AUTH],
                             "revoke": {"ok": True, "remote_confirmed": True}})
    env = _cli_env(repo, runtime, spec)
    inst = json.loads(_cli(["install", "--agent-type", "codex",
                            "--agent-instance", "TURING:codex",
                            "--session-id", "s1", "--json"],
                           repo, env).stdout)
    bid = inst["data"]["binding"]["binding_id"]
    u = json.loads(_cli(["uninstall", "--binding-id", bid, "--session-id",
                         "s2", "--json"], repo, env).stdout)
    check(u["data"]["state"] == "UNINSTALLED", "卸载成功")
    u2 = json.loads(_cli(["uninstall", "--binding-id", bid, "--session-id",
                          "s3", "--json"], repo, env).stdout)
    check(u2["data"]["code"] == "ALREADY_UNINSTALLED", "重复卸载幂等")


def test_cli_doctor():
    tmp = _tmp()
    repo = make_sandbox(tmp)
    runtime = os.path.join(tmp, "runtime")
    spec = _write_spec(tmp, {"outcomes": [AUTH]})
    env = _cli_env(repo, runtime, spec)
    p = _cli(["doctor", "--json"], repo, env)
    data = json.loads(p.stdout)
    check(data["ok"] is True, "doctor PASS")
    check("findings" in data["data"], "findings 返回")


TESTS = [
    test_cli_json_contract_single_object,
    test_cli_install_status_roundtrip,
    test_cli_denied_exit_30,
    test_cli_degraded_memory_write_and_sync,
    test_cli_exit_code_usage_error,
    test_full_multi_agent_lifecycle,
    test_cli_uninstall_and_already_uninstalled,
    test_cli_doctor,
]



TESTS = [requires_ref_write(t) for t in TESTS]

def main():
    run_tests(TESTS)


if __name__ == "__main__":
    main()
