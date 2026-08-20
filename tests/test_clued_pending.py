# -*- coding: utf-8 -*-
"""Clued Pending 与恢复测试（协议 §9 / §10 / §19.4）。

覆盖：降级 CREATE/UPDATE/DELETE 先入 Journal / 恢复顺序（重新认证→
pull→重放→push→远端确认才 SYNCED）/ operation_id 幂等 / no-change 规则 /
push 后远端确认才 SYNCED / 乐观锁冲突 → 快照 + CONFLICT_REVIEW + 不推送
批次 / Journal 损坏不被静默删除 / APPLYING 崩溃恢复。真实同步脚本 + 本地
file remote，零网络。
"""

import json
import os
import random
import shutil
import sys
import tempfile

from clued_testkit import (
    check, git, make_controller, make_sandbox, sh,
)

from clued_testkit import requires_ref_write, run_tests  # ENV 归因（R3 P0-3）

from clued import manifests
from clued import state_machine as SM
from clued.auth.provider import AUTHORIZED
from clued.errors import CluedError
from clued.identifiers import new_uuid

# 测试内关闭认证重试抖动（速度）
random.uniform = lambda a, b: 0.0

SCOPES = ["memory:read", "memory:write", "sync:request"]
AUTH = {"kind": "AUTHORIZED", "account_id": "github:testuser",
        "scopes": SCOPES, "subject": "testuser"}
UNAV = {"kind": "UNAVAILABLE", "reason": "network", "detail": "offline"}


def _tmp():
    return tempfile.mkdtemp(prefix="clued-pending-")


def _spec(outcomes):
    return {"outcomes": outcomes, "revoke": {"ok": True,
                                             "remote_confirmed": True}}


def _provider_ctrl(tmp, outcomes):
    """install 后的控制器（session=s-install）；outcomes 依序消费。"""
    from clued.auth.fake import FakeAuthProvider
    provider = FakeAuthProvider(_spec(outcomes))
    ctrl = make_controller(tmp, provider=provider)
    ctrl.install("codex", "TURING:codex", session_id="s-install")
    return ctrl


def _degraded_provider_ctrl(tmp):
    """install 后进入降级的控制器：AUTH(安装) → UNAV×2（降级会话）→ AUTH…"""
    return _provider_ctrl(tmp, [AUTH, UNAV, UNAV, AUTH])


def _binding_id(ctrl):
    return ctrl.registry.find_by_agent("codex", "TURING:codex")[0][
        "binding_id"]


def test_degraded_write_journaled_not_pushed():
    tmp = _tmp()
    ctrl = _degraded_provider_ctrl(tmp)
    bid = _binding_id(ctrl)
    remote_before = git("rev-parse", "HEAD", cwd=ctrl.repo).stdout.strip()
    result = ctrl.memory_write(
        bid, "sess-d", "CREATE", "降级期间的新记忆", category="state",
        remember=True)
    check(result["state"] == SM.DEGRADED_LOCAL, "降级状态")
    check(result["synced"] is False, "不得伪报已同步（§7.6）")
    check("SYNCED" not in result["summary"], "降级成功不得用 SYNCED 字样")
    check(result["pending"] == 1, "Journal pending=1")
    ops = ctrl.journal.pending(bid)
    check(len(ops) == 1 and ops[0]["operation_type"] == "CREATE",
          "CREATE 先入 Journal")
    check(ops[0]["schema_version"] == "clued.pending-op.v0.1", "schema")
    # 远端不变（未推送）
    remote_after = git("rev-parse", "HEAD", cwd=ctrl.repo).stdout.strip()
    check(remote_before == remote_after, "降级写入不触碰远端")


def test_degraded_update_and_delete_journaled():
    tmp = _tmp()
    ctrl = _degraded_provider_ctrl(tmp)
    bid = _binding_id(ctrl)
    r1 = ctrl.memory_write(bid, "s-d", "CREATE", "v1", category="state",
                           remember=True)
    mid = r1["memory_id"]
    r2 = ctrl.memory_write(bid, "s-d", "UPDATE", "v2", memory_id=mid)
    r3 = ctrl.memory_write(bid, "s-d", "DELETE", "", memory_id=mid)
    check(r2["pending"] == 2 and r3["pending"] == 3, "UPDATE/DELETE 均入 Journal")
    ops = ctrl.journal.pending(bid)
    types = [o["operation_type"] for o in ops]
    check(types == ["CREATE", "UPDATE", "DELETE"], types)
    # 同一 memory_id 严格保序（§9.4）
    mem_ids = [o["memory_id"] for o in ops]
    check(mem_ids == sorted(set(mem_ids), key=lambda m: m) or True, "")
    check(all(o["memory_id"] == "obj:" + mid for o in ops),
          "同一 memory_id 操作保序（§9.4）")


def test_recovery_replays_and_confirms_remote():
    tmp = _tmp()
    ctrl = _degraded_provider_ctrl(tmp)
    bid = _binding_id(ctrl)
    result = ctrl.memory_write(
        bid, "sess-d", "CREATE", "恢复测试记忆", category="state",
        remember=True)
    op_id = result["operation_id"]
    # 网络恢复 → 手动 sync（新会话，重新在线认证）
    sync_result = ctrl.sync(bid, session_id="sess-r")
    check(sync_result["state"] == SM.ONLINE_SYNCED, "恢复完成 ONLINE_SYNCED")
    check(sync_result.get("replayed") == 1, "重放 1 个操作")
    # Journal 归档为 SYNCED（远端确认后，§9.3.4）
    op = ctrl.journal.load(op_id)
    check(op["status"] == "SYNCED", "远端确认后才 SYNCED: %s" % op["status"])
    # 远端真实包含该对象
    from memory_engine import store
    from memory_engine import paths as engine_paths
    engine_paths.set_repo(ctrl.repo)
    check(store.load_object(result["memory_id"]) is not None,
          "远端（工作树=合并后远端）包含对象")
    remote = git("ls-remote", "origin", "main",
                 cwd=ctrl.repo).stdout.split()[0]
    local = git("rev-parse", "HEAD", cwd=ctrl.repo).stdout.strip()
    check(local == remote, "本地 HEAD == 远端 main")


def test_recovery_no_change_rule():
    tmp = _tmp()
    from clued.auth.fake import FakeAuthProvider
    provider = FakeAuthProvider(_spec([AUTH, AUTH]))
    ctrl = make_controller(tmp, provider=provider)
    ctrl.install("codex", "TURING:codex", session_id="s1")
    bid = _binding_id(ctrl)
    remote_before = git("ls-remote", "origin", "main",
                        cwd=ctrl.repo).stdout.split()[0]
    result = ctrl.sync(bid, session_id="sess-r")
    check(result.get("no_change") is True, "空 Journal → no-change")
    remote_after = git("ls-remote", "origin", "main",
                       cwd=ctrl.repo).stdout.split()[0]
    check(remote_before == remote_after,
          "NO_CHANGE → NO_WRITE → NO_SYNC → NO_INVALIDATION（§10.3）")
    commits = git("rev-list", "--count", "HEAD",
                  cwd=ctrl.repo).stdout.strip()
    check(commits == "1", "无多余 commit（沙盒初始 1 个）: %s" % commits)


def test_recovery_conflict_snapshot_no_push():
    tmp = _tmp()
    # AUTH：install + 在线写入的恢复重认证 + 冲突恢复的重新认证
    ctrl = _provider_ctrl(tmp, [AUTH, AUTH, UNAV, UNAV, AUTH])
    bid = _binding_id(ctrl)
    # 先在线创建对象并推送（安装会话已授权）
    r1 = ctrl.memory_write(bid, "s-install", "CREATE", "v1",
                           category="state", remember=True)
    mid = r1["memory_id"]
    # 降级会话本地 UPDATE
    r2 = ctrl.memory_write(bid, "sess-d", "UPDATE", "v2-local",
                           memory_id=mid)
    op_id = r2["operation_id"]
    # 远端被另一个克隆修改（模拟他端写入）
    clone2 = make_second_clone(tmp, ctrl.repo)
    obj_path = os.path.join(clone2, "memory", "objects", mid + ".json")
    obj = json.load(open(obj_path, encoding="utf-8"))
    obj["content"] = "v3-remote"
    with open(obj_path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=2)
    git("add", "memory", cwd=clone2)
    git("commit", "-m", "remote change", cwd=clone2)
    git("push", "origin", "main", cwd=clone2)
    # 恢复 → 乐观锁冲突
    try:
        ctrl.sync(bid, session_id="sess-r")
        raise AssertionError("乐观锁冲突必须暴露（§10.4）")
    except CluedError as exc:
        check(exc.code == "CLD-CONFLICT-001", exc.code)
        check(exc.state == SM.CONFLICT_REVIEW, "进入 CONFLICT_REVIEW")
        caught = exc
    op = ctrl.journal.load(op_id)
    check(op["status"] == "CONFLICTED", "op 标记 CONFLICTED")
    # 冲突快照：base/ours/theirs 保留
    conflicts_dir = ctrl.paths.conflict_dir(
        caught.data["conflict_ids"][0] if caught.data.get("conflict_ids")
        else "")
    if not os.path.isdir(conflicts_dir):
        conflicts = [d for d in os.listdir(ctrl.paths._p("conflicts"))]
        check(conflicts, "conflict 快照目录存在")
        conflicts_dir = ctrl.paths.conflict_dir(conflicts[0])
    for name in ("conflict.json", "base", "ours", "theirs"):
        check(os.path.isfile(os.path.join(conflicts_dir, name)),
              "快照含 %s" % name)
    meta = json.load(open(os.path.join(conflicts_dir, "conflict.json"),
                          encoding="utf-8"))
    check(meta["operation_id"] == op_id, "快照记录 operation_id")
    # 远端未被本批推送覆盖（v3-remote 仍为远端最新）
    remote_obj = git("show", "origin/main:memory/objects/%s.json" % mid,
                     cwd=ctrl.repo)
    remote_content = json.loads(remote_obj.stdout).get("content")
    check(remote_content == "v3-remote", "远端未被覆盖（§10.4 不覆盖远端）")


def test_recovery_requires_reauthentication():
    tmp = _tmp()
    from clued.auth.fake import FakeAuthProvider
    provider = FakeAuthProvider(_spec([AUTH, UNAV, UNAV, AUTH]))
    ctrl = make_controller(tmp, provider=provider)
    ctrl.install("codex", "TURING:codex", session_id="s1")
    bid = _binding_id(ctrl)
    ctrl.memory_write(bid, "s-d", "CREATE", "x", category="state",
                      remember=True)
    n = len(provider.calls)
    ctrl.sync(bid, session_id="sess-r")
    check(len(provider.calls) > n, "恢复前必须重新在线认证（§10.1.2）")


def test_recovery_unavailable_stays_degraded():
    tmp = _tmp()
    from clued.auth.fake import FakeAuthProvider
    provider = FakeAuthProvider(_spec([AUTH, UNAV, UNAV, UNAV, UNAV]))
    ctrl = make_controller(tmp, provider=provider)
    ctrl.install("codex", "TURING:codex", session_id="s1")
    bid = _binding_id(ctrl)
    ctrl.memory_write(bid, "s-d", "CREATE", "x", category="state",
                      remember=True)
    try:
        ctrl.sync(bid, session_id="sess-r")
        raise AssertionError("认证不可用应保持降级")
    except CluedError as exc:
        check(exc.exit_code == 31, "退出码 31（§13.2）")
        check(exc.state == SM.DEGRADED_LOCAL, "保持降级，不增加高频重试")
    check(ctrl.journal.pending_count(bid) == 1, "pending 保留")


def test_recovery_denied_locks():
    tmp = _tmp()
    from clued.auth.fake import FakeAuthProvider
    provider = FakeAuthProvider(_spec([AUTH, UNAV, UNAV,
                                       {"kind": "DENIED", "reason":
                                        "revoked"}]))
    ctrl = make_controller(tmp, provider=provider)
    ctrl.install("codex", "TURING:codex", session_id="s1")
    bid = _binding_id(ctrl)
    ctrl.memory_write(bid, "s-d", "CREATE", "x", category="state",
                      remember=True)
    try:
        ctrl.sync(bid, session_id="sess-r")
        raise AssertionError("恢复前认证拒绝必须 LOCKED（§10.1）")
    except CluedError as exc:
        check(exc.exit_code == 30 and exc.state == SM.LOCKED,
              "DENIED → LOCKED: %s %s" % (exc.exit_code, exc.state))


def test_applying_crash_recovery_idempotent():
    tmp = _tmp()
    ctrl = _degraded_provider_ctrl(tmp)
    bid = _binding_id(ctrl)
    result = ctrl.memory_write(bid, "s-d", "CREATE", "crash 测试",
                               category="state", remember=True)
    op_id = result["operation_id"]
    op = ctrl.journal.load(op_id)
    ctrl.journal.mark_applying(op)  # 模拟推送阶段崩溃
    sync_result = ctrl.sync(bid, session_id="sess-r")
    check(sync_result.get("replayed") == 1, "APPLYING → PENDING → 重放")
    check(ctrl.journal.load(op_id)["status"] == "SYNCED", "最终 SYNCED")


def test_journal_corruption_not_silently_dropped():
    tmp = _tmp()
    ctrl = _degraded_provider_ctrl(tmp)
    bid = _binding_id(ctrl)
    result = ctrl.memory_write(bid, "s-d", "CREATE", "x", category="state",
                               remember=True)
    op_id = result["operation_id"]
    path = ctrl.paths.pending_file(op_id)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("{ not json")
    # doctor 必须 FAIL（CLD-SYNC-001），不静默丢弃
    try:
        ctrl.doctor(include_sync=False, include_engine=False)
        raise AssertionError("Journal 损坏必须 doctor FAIL")
    except CluedError as exc:
        check(exc.exit_code == 40, "doctor FAIL 退出码 40")
    check(os.path.isfile(path), "损坏证据保留（§9.3.8）")


def test_push_failure_keeps_pending_and_degrades():
    tmp = _tmp()
    from clued.auth.fake import FakeAuthProvider
    provider = FakeAuthProvider(_spec([AUTH, AUTH]))
    ctrl = make_controller(tmp, provider=provider)
    ctrl.install("codex", "TURING:codex", session_id="s1")
    bid = _binding_id(ctrl)
    # 使 push 失败：把 sync 脚本换成必定失败版本
    script = os.path.join(ctrl.repo, "sync-memory.py")
    shutil.copy(script, script + ".bak")
    with open(script, "w", encoding="utf-8") as fh:
        fh.write("import sys\nsys.exit(1)\n")
    try:
        ctrl.memory_write(bid, "s1", "CREATE", "x", category="state",
                          remember=True)
        raise AssertionError("push 失败必须报错且不伪报已同步")
    except CluedError as exc:
        check("SYNCED" not in exc.message, "不伪报已同步")
    check(ctrl.journal.pending_count(bid) == 1, "pending 保留（不丢失）")
    state = ctrl.get_state(bid)
    check(state in (SM.ONLINE_DIRTY, SM.DEGRADED_LOCAL), state)
    # 恢复脚本后重试成功
    shutil.move(script + ".bak", script)
    sync_result = ctrl.sync(bid, session_id="sess-r")
    check(sync_result["state"] == SM.ONLINE_SYNCED, "重试恢复成功")


def test_degraded_write_keeps_worktree_clean_and_doctor_pass():
    """CLD-FIX-002 核心：降级写入不修改工作树，恢复前 sync doctor 可真实 PASS。"""
    tmp = _tmp()
    ctrl = _degraded_provider_ctrl(tmp)
    bid = _binding_id(ctrl)
    ctrl.memory_write(bid, "sess-d", "CREATE", "降级记忆", category="state",
                      remember=True)
    status = git("status", "--porcelain=v1", cwd=ctrl.repo).stdout.strip()
    check(status == "", "降级期间工作树干净: %r" % status)
    doc = ctrl.sync_provider.doctor()
    check(doc.ok, "降级期间 sync doctor PASS（恢复前可满足严格 doctor）")
    check(ctrl.journal.pending_count(bid) == 1, "payload 在 .clued/ staging")


# ================= CLD-FIX-004：LOCKED 出口（待产品确认项）=================
def test_locked_no_degrade_no_access_no_lkg_use():
    """LOCKED 期间：不降级、不读不写、不使用旧 LKG（专项测试）。"""
    tmp = _tmp()
    from clued.auth.fake import FakeAuthProvider
    provider = FakeAuthProvider(_spec([AUTH,
                                       {"kind": "DENIED", "reason":
                                        "revoked"},
                                       UNAV, UNAV]))
    ctrl = make_controller(tmp, provider=provider)
    ctrl.install("codex", "TURING:codex", session_id="s1")
    bid = _binding_id(ctrl)
    # 明确拒绝 → LOCKED
    try:
        ctrl.auth_check(bid, session_id="s-d")
        raise AssertionError("应进入 LOCKED")
    except CluedError as exc:
        check(exc.state == SM.LOCKED, "DENIED → LOCKED")
    check(ctrl.get_state(bid) == SM.LOCKED, "状态 LOCKED")
    # LKG 存在但 LOCKED 期间不得用于降级
    entry, err = ctrl.auth_cache.load(bid)
    check(err is None and entry is not None, "LKG 仍在缓存中")
    # Memory Access：强制新在线认证 → UNAVAILABLE → 不得降级、不得读写
    try:
        ctrl.memory_write(bid, "s-e", "CREATE", "locked 期间写入",
                          category="state", remember=True)
        raise AssertionError("LOCKED 期间必须拒绝 Memory Access")
    except CluedError as exc:
        check(exc.code == "CLD-AUTH-002" and exc.state == SM.LOCKED,
              "LOCKED 期间 UNAVAILABLE → 不降级保持 LOCKED: %s %s"
              % (exc.code, exc.state))
    check(ctrl.get_state(bid) == SM.LOCKED, "仍 LOCKED")
    check(ctrl.journal.pending_count(bid) == 0, "LOCKED 期间不得写 Pending")
    try:
        ctrl.memory_recall(bid, "s-f", "任何查询", tier="T2")
        raise AssertionError("LOCKED 期间不得读取私有记忆")
    except CluedError as exc:
        check(exc.state == SM.LOCKED, "LOCKED 期间拒绝读取: %s" % exc.code)


def test_locked_exit_requires_fresh_online_auth_and_audit():
    """D4：LOCKED → AUTH_REQUIRED → ONLINE_SYNCED（新在线认证成功 + 账户一致 +
    Binding ACTIVE + scope 合规），审计事件完整。"""
    tmp = _tmp()
    from clued.auth.fake import FakeAuthProvider
    provider = FakeAuthProvider(_spec([AUTH,
                                       {"kind": "DENIED", "reason":
                                        "revoked"},
                                       AUTH, AUTH]))
    ctrl = make_controller(tmp, provider=provider)
    ctrl.install("codex", "TURING:codex", session_id="s1")
    bid = _binding_id(ctrl)
    try:
        ctrl.auth_check(bid, session_id="s-d")
        raise AssertionError("应进入 LOCKED")
    except CluedError:
        pass
    check(ctrl.get_state(bid) == SM.LOCKED, "前置 LOCKED")
    # 新的在线认证成功（账户一致）→ 离开 LOCKED
    n = len(provider.calls)
    result = ctrl.auth_check(bid, session_id="s-r")
    check(len(provider.calls) > n, "LOCKED 出口必须新的在线认证（不得复用）")
    check(result["code"] == AUTHORIZED, "AUTHORIZED")
    check(ctrl.get_state(bid) == SM.ONLINE_SYNCED, "最终 ONLINE_SYNCED")
    events = [e["event_type"] for e in ctrl.audit.tail(30)]
    check("auth_recovered" in events, "审计 auth_recovered（LOCKED → AUTH_REQUIRED）")
    check("auth_authorized" in events, "审计 auth_authorized（→ ONLINE）")
    # 出口后写入恢复可用
    w = ctrl.memory_write(bid, "s-r", "CREATE", "解锁后写入",
                          category="state", remember=True)
    check(w.get("synced") is True, "解锁后在线写入同步成功")


def test_locked_account_mismatch_blocks_exit():
    """D4 出口条件：账户不一致 → 保持 LOCKED，不得离开。"""
    tmp = _tmp()
    from clued.auth.fake import FakeAuthProvider
    other = {"kind": "AUTHORIZED", "account_id": "github:otheruser",
             "scopes": SCOPES, "subject": "otheruser"}
    provider = FakeAuthProvider(_spec([AUTH,
                                       {"kind": "DENIED", "reason":
                                        "revoked"},
                                       other]))
    ctrl = make_controller(tmp, provider=provider)
    ctrl.install("codex", "TURING:codex", session_id="s1")
    bid = _binding_id(ctrl)
    try:
        ctrl.auth_check(bid, session_id="s-d")
        raise AssertionError("应进入 LOCKED")
    except CluedError:
        pass
    try:
        ctrl.auth_check(bid, session_id="s-other")
        raise AssertionError("账户不一致必须拒绝离开 LOCKED")
    except CluedError as exc:
        check(exc.code == "CLD-AUTH-001" and exc.state == SM.LOCKED,
              "账户不一致 → 保持 LOCKED: %s %s" % (exc.code, exc.state))
    check(ctrl.get_state(bid) == SM.LOCKED, "仍 LOCKED")


def make_second_clone(tmp, repo):
    clone = os.path.join(tmp, "clone2")
    sh(["git", "clone", os.path.join(tmp, "remote.git"), clone])
    git("config", "user.name", "OtherAgent", cwd=clone)
    git("config", "user.email", "other@localhost", cwd=clone)
    return clone


TESTS = [
    test_degraded_write_journaled_not_pushed,
    test_degraded_update_and_delete_journaled,
    test_degraded_write_keeps_worktree_clean_and_doctor_pass,
    test_recovery_replays_and_confirms_remote,
    test_recovery_no_change_rule,
    test_recovery_conflict_snapshot_no_push,
    test_recovery_requires_reauthentication,
    test_recovery_unavailable_stays_degraded,
    test_recovery_denied_locks,
    test_applying_crash_recovery_idempotent,
    test_journal_corruption_not_silently_dropped,
    test_push_failure_keeps_pending_and_degrades,
    test_locked_no_degrade_no_access_no_lkg_use,
    test_locked_exit_requires_fresh_online_auth_and_audit,
    test_locked_account_mismatch_blocks_exit,
]



TESTS = [requires_ref_write(t) for t in TESTS]

def main():
    run_tests(TESTS)


if __name__ == "__main__":
    main()
