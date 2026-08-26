# -*- coding: utf-8 -*-
"""Clued 恢复顺序与崩溃故障注入测试（CLD-FIX-002 §4.4 / CLD-FIX-003 §5.3）。

覆盖：
- doctor FAIL 阻断 canonical read 与 push（脏树非本批残留 → CLD-SYNC-001）；
- doctor FAIL 时绝不调用 push（调用计数证据）；
- 恢复事件序列严格 auth → doctor → pull → replay → validate → push → verify
  （审计 recovery_step 轨迹）；
- pull 失败时 Pending 保持可重试（失败后修复即可恢复）；
- 冲突整批不 push（一个冲突 → 批次内其它 apply 操作也不 replay/不推送）；
- push 失败：Pending 不丢、不标记 SYNCED、回滚后工作树干净 + doctor PASS；
- 远端确认失败：Pending 不标记 SYNCED、可重试；
- 空 Pending 且远端无变化 → NO_CHANGE → NO_WRITE → NO_SYNC → NO_INVALIDATION；
- 崩溃点注入（§5.3）：payload staging 前 / staging 后 journal 前（孤儿）/
  journal 后确认前 / APPLYING 中途崩溃（残留自愈）/ 已应用已推送未确认
  （幂等 already）/ 重启后同一 operation_id 幂等恢复。
真实同步脚本 + 本地 bare remote + FakeAuthProvider，零网络。
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
from clued.errors import CluedError
from clued.identifiers import new_uuid

random.uniform = lambda a, b: 0.0

SCOPES = ["memory:read", "memory:write", "sync:request"]
AUTH = {"kind": "AUTHORIZED", "account_id": "github:testuser",
        "scopes": SCOPES, "subject": "testuser"}
UNAV = {"kind": "UNAVAILABLE", "reason": "network", "detail": "offline"}


def _tmp():
    return tempfile.mkdtemp(prefix="clued-crash-")


def _spec(outcomes):
    return {"outcomes": outcomes, "revoke": {"ok": True,
                                             "remote_confirmed": True}}


def _provider_ctrl(tmp, outcomes):
    from clued.auth.fake import FakeAuthProvider
    provider = FakeAuthProvider(_spec(outcomes))
    ctrl = make_controller(tmp, provider=provider)
    ctrl.install("codex", "TURING:codex", session_id="s-install")
    return ctrl


def _binding_id(ctrl):
    return ctrl.registry.find_by_agent("codex", "TURING:codex")[0][
        "binding_id"]


def _degraded_write(ctrl, bid, content="x", session="sess-d", **kw):
    return ctrl.memory_write(bid, session, "CREATE", content,
                             category="state", remember=True, **kw)


def _recovery_steps(ctrl):
    """审计中的 recovery_step 轨迹（按时间顺序）。"""
    return [e["result_code"] for e in ctrl.audit.tail(200)
            if e["event_type"] == "recovery_step"]


def _remote_sha(ctrl):
    return git("ls-remote", "origin", "main", cwd=ctrl.repo).stdout.split()[0]


# ================= CLD-FIX-002 §4.4 =================
def test_doctor_fail_blocks_recovery_read_and_push():
    """doctor FAIL（脏树不属于 Clued 残留）→ CLD-SYNC-001 阻断，无 read/push。"""
    tmp = _tmp()
    ctrl = _provider_ctrl(tmp, [AUTH, UNAV, UNAV, AUTH])
    bid = _binding_id(ctrl)
    _degraded_write(ctrl, bid)
    # 制造与本批 pending 无关的脏树（外部文件）→ doctor「working tree clean」FAIL
    foreign = os.path.join(ctrl.repo, "memory", "foreign-dirty.txt")
    with open(foreign, "w", encoding="utf-8") as fh:
        fh.write("user edit outside Clued\n")
    remote_before = _remote_sha(ctrl)
    try:
        ctrl.sync(bid, session_id="sess-r")
        raise AssertionError("doctor FAIL 必须阻断恢复")
    except CluedError as exc:
        check(exc.code == "CLD-SYNC-001", exc.code)
    check(_remote_sha(ctrl) == remote_before, "doctor FAIL 期间远端零写入")
    check(ctrl.journal.pending_count(bid) == 1, "pending 保留")
    check("APPLYING" not in [o["status"] for o in ctrl.journal.list_all(bid)],
          "未进入 replay")
    # 清理外部文件后恢复成功（证明阻断的是 doctor 而非其它）
    os.remove(foreign)
    res = ctrl.sync(bid, session_id="sess-r2")
    check(res["state"] == SM.ONLINE_SYNCED, "清理后恢复成功")


def test_doctor_fail_never_calls_push():
    """doctor FAIL 时绝不调用 push（push 调用计数 = 0）。"""
    tmp = _tmp()
    ctrl = _provider_ctrl(tmp, [AUTH, UNAV, UNAV, AUTH])
    bid = _binding_id(ctrl)
    _degraded_write(ctrl, bid)

    class CountingSync(object):
        def __init__(self, inner):
            self.inner = inner
            self.pushes = 0
            self.pulls = 0

        def push(self):
            self.pushes += 1
            return self.inner.push()

        def pull(self, access=None):
            self.pulls += 1
            return self.inner.pull(access)

        def doctor(self):
            return self.inner.doctor()

        def bootstrap(self):
            return self.inner.bootstrap()

        def require_sync_script(self):
            return self.inner.require_sync_script()

    counting = CountingSync(ctrl.sync_provider)
    ctrl.sync_provider = counting
    # 脏树（外部）→ doctor FAIL
    foreign = os.path.join(ctrl.repo, "memory", "foreign-dirty.txt")
    with open(foreign, "w", encoding="utf-8") as fh:
        fh.write("x\n")
    try:
        ctrl.sync(bid, session_id="sess-r")
        raise AssertionError("应被 doctor 阻断")
    except CluedError as exc:
        check(exc.code == "CLD-SYNC-001", exc.code)
    check(counting.pushes == 0, "doctor FAIL 时 push 调用次数必须为 0")
    check(counting.pulls == 0, "doctor FAIL（非落后）时不得先 pull")
    os.remove(foreign)


def test_recovery_event_sequence_strict():
    """恢复事件序列严格 auth → doctor → pull → replay → validate → push →
    verify → mark_synced → close_breakers（审计轨迹）。"""
    tmp = _tmp()
    ctrl = _provider_ctrl(tmp, [AUTH, UNAV, UNAV, AUTH])
    bid = _binding_id(ctrl)
    _degraded_write(ctrl, bid)
    res = ctrl.sync(bid, session_id="sess-r")
    check(res["state"] == SM.ONLINE_SYNCED, "恢复成功")
    steps = [s for s in _recovery_steps(ctrl)
             if s in ("AUTHENTICATE", "DOCTOR_PASS",
                      "VALIDATE_PENDING_JOURNAL",
                      "PULL_VIA_EXISTING_SYNC_LAYER", "VALIDATE_REMOTE_HEAD",
                      "LOAD_PENDING_IN_ORDER",
                      "REPLAY_WITH_SAME_OPERATION_ID",
                      "CHECK_OPTIMISTIC_LOCKS",
                      "RUN_EXISTING_MEMORY_VALIDATION",
                      "PUSH_VIA_EXISTING_SYNC_LAYER", "VERIFY_REMOTE_RESULT",
                      "MARK_PENDING_SYNCED", "CLOSE_BREAKERS_AND_RETURN_ONLINE")]
    expected = [
        "AUTHENTICATE", "DOCTOR_PASS", "VALIDATE_PENDING_JOURNAL",
        "PULL_VIA_EXISTING_SYNC_LAYER", "VALIDATE_REMOTE_HEAD",
        "LOAD_PENDING_IN_ORDER", "REPLAY_WITH_SAME_OPERATION_ID",
        "CHECK_OPTIMISTIC_LOCKS", "RUN_EXISTING_MEMORY_VALIDATION",
        "PUSH_VIA_EXISTING_SYNC_LAYER", "VERIFY_REMOTE_RESULT",
        "MARK_PENDING_SYNCED", "CLOSE_BREAKERS_AND_RETURN_ONLINE",
    ]
    # 相对顺序严格（过滤重复事件后按序比较）
    seen, ordered = set(), []
    for s in steps:
        if s not in seen:
            ordered.append(s)
            seen.add(s)
    check(ordered[:len(expected)] == expected,
          "恢复事件顺序不符: %s" % ordered)


def test_pull_failure_keeps_pending_retryable():
    tmp = _tmp()
    ctrl = _provider_ctrl(tmp, [AUTH, UNAV, UNAV, AUTH, AUTH])
    bid = _binding_id(ctrl)
    result = _degraded_write(ctrl, bid)
    op_id = result["operation_id"]
    # 破坏 pull：替换 sync 脚本为 pull 失败版本（doctor 也失败 → 落后补救同样失败）
    script = os.path.join(ctrl.repo, "sync-memory.py")
    original = open(script, "r", encoding="utf-8").read()
    with open(script, "w", encoding="utf-8") as fh:
        fh.write("import sys\nsys.exit(1)\n")
    try:
        ctrl.sync(bid, session_id="sess-r")
        raise AssertionError("pull 失败必须报错")
    except CluedError as exc:
        check(exc.code in ("CLD-SYNC-001", "CLD-SYNC-002"), exc.code)
    op = ctrl.journal.load(op_id)
    check(op["status"] == "PENDING", "pull 失败后 pending 保持可重试: %s"
          % op["status"])
    # 修复后重试成功
    with open(script, "w", encoding="utf-8", newline="") as fh:
        fh.write(original)
    res = ctrl.sync(bid, session_id="sess-r2")
    check(res["state"] == SM.ONLINE_SYNCED, "修复后恢复成功")
    check(ctrl.journal.load(op_id)["status"] == "SYNCED", "最终 SYNCED")


def test_conflict_stops_whole_batch_no_push():
    """一个冲突 → 整批停止：其它 apply 操作也不 replay、不 commit、不 push。"""
    tmp = _tmp()
    ctrl = _provider_ctrl(tmp, [AUTH, AUTH, UNAV, UNAV, AUTH])
    bid = _binding_id(ctrl)
    # 在线创建 v1（已推送，远端基线）
    r1 = ctrl.memory_write(bid, "s-install", "CREATE", "v1",
                           category="state", remember=True)
    mid = r1["memory_id"]
    # 降级：两个操作 —— 全新 CREATE（会 apply）+ 对 mid 的 UPDATE（远端将被改）
    r2 = ctrl.memory_write(bid, "sess-d", "CREATE", "new-obj",
                           category="state", remember=True)
    r3 = ctrl.memory_write(bid, "sess-d", "UPDATE", "v2-local",
                           memory_id=mid)
    # 远端修改 mid（他端写入）
    clone2 = _second_clone(tmp, ctrl.repo)
    obj_path = os.path.join(clone2, "memory", "objects", mid + ".json")
    obj = json.load(open(obj_path, encoding="utf-8"))
    obj["content"] = "v3-remote"
    with open(obj_path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=2)
    git("add", "memory", cwd=clone2)
    git("commit", "-m", "remote change", cwd=clone2)
    git("push", "origin", "main", cwd=clone2)
    try:
        ctrl.sync(bid, session_id="sess-r")
        raise AssertionError("冲突必须暴露")
    except CluedError as exc:
        check(exc.code == "CLD-CONFLICT-001", exc.code)
        check(exc.state == SM.CONFLICT_REVIEW, exc.state)
    # 批次整体未 replay：新对象在远端/工作树均不存在
    from memory_engine import store
    from memory_engine import paths as engine_paths
    engine_paths.set_repo(ctrl.repo)
    check(store.load_object(r2["memory_id"]) is None,
          "批次停止：apply 操作也未 replay（无部分应用）")
    check(ctrl.journal.load(r2["operation_id"])["status"] == "PENDING",
          "apply 判定操作保持 PENDING（可重试）")
    check(ctrl.journal.load(r3["operation_id"])["status"] == "CONFLICTED",
          "冲突操作标记 CONFLICTED")
    # 远端未被覆盖
    remote_obj = git("show", "origin/main:memory/objects/%s.json" % mid,
                     cwd=ctrl.repo)
    check(json.loads(remote_obj.stdout).get("content") == "v3-remote",
          "远端未被覆盖（§10.4）")


def test_push_failure_rolls_back_clean_and_retryable():
    """push 失败：Pending 不丢、不标 SYNCED；回滚后工作树干净 + doctor PASS。"""
    tmp = _tmp()
    ctrl = _provider_ctrl(tmp, [AUTH, AUTH, AUTH])
    bid = _binding_id(ctrl)
    script = os.path.join(ctrl.repo, "sync-memory.py")
    original = open(script, "r", encoding="utf-8").read()
    # 保留真实脚本供 fallback 使用（push 失败后 doctor/pull 仍需可用）
    with open(os.path.join(ctrl.repo, "_orig_sync.py"), "w",
              encoding="utf-8") as fh:
        fh.write(original)
    with open(script, "w", encoding="utf-8") as fh:
        fh.write("import sys\n"
                 "if 'push' in sys.argv:\n    sys.exit(1)\n"
                 "import runpy, os\n"
                 "runpy.run_path(os.path.join(os.path.dirname("
                 "os.path.abspath('sync-memory.py')), '_orig_sync.py'), "
                 "run_name='__main__')\n")
    try:
        ctrl.memory_write(bid, "s1", "CREATE", "x", category="state",
                          remember=True)
        raise AssertionError("push 失败必须报错且不伪报已同步")
    except CluedError as exc:
        check(exc.code in ("CLD-SYNC-001", "CLD-SYNC-003"), exc.code)
        check("SYNCED" not in exc.message, "不伪报已同步")
    ops = ctrl.journal.list_all(bid, statuses=("PENDING",))
    check(len(ops) == 1, "pending 保留（不丢失）")
    check(all(o["status"] == "PENDING" for o in
              ctrl.journal.list_all(bid)), "未标记 SYNCED")
    # 恢复脚本（测试夹具）后校验回滚不变量：工作树干净、local == remote
    with open(script, "w", encoding="utf-8", newline="") as fh:
        fh.write(original)
    os.remove(os.path.join(ctrl.repo, "_orig_sync.py"))
    check(git("status", "--porcelain", cwd=ctrl.repo).stdout.strip() == "",
          "push 失败回滚后工作树干净")
    check(_remote_sha(ctrl) == git("rev-parse", "HEAD",
                                   cwd=ctrl.repo).stdout.strip(),
          "回滚后 local == remote")
    check(ctrl.sync_provider.doctor().ok,
          "回滚后 doctor PASS（恢复入口状态可重入）")
    # 重试成功
    res = ctrl.sync(bid, session_id="sess-r")
    check(res["state"] == SM.ONLINE_SYNCED, "重试恢复成功")


def test_verify_failure_pending_not_synced():
    """远端确认失败：Pending 不标记 SYNCED，回滚后可重试。"""
    tmp = _tmp()
    ctrl = _provider_ctrl(tmp, [AUTH, UNAV, UNAV, AUTH, AUTH])
    bid = _binding_id(ctrl)
    result = _degraded_write(ctrl, bid)
    op_id = result["operation_id"]
    # 注入：第一次 remote_head（VALIDATE_REMOTE_HEAD）真实，之后（VERIFY）失败
    real_remote_head = ctrl.git.remote_head
    calls = {"n": 0}

    def flaky_remote_head(*a, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            return real_remote_head(*a, **kw)
        return None  # 远端确认失败

    ctrl.git.remote_head = flaky_remote_head
    try:
        ctrl.sync(bid, session_id="sess-r")
        raise AssertionError("远端确认失败必须报错")
    except CluedError as exc:
        check(exc.code in ("CLD-SYNC-004", "CLD-SYNC-001"), exc.code)
    op = ctrl.journal.load(op_id)
    check(op["status"] == "PENDING", "远端确认失败不标记 SYNCED: %s"
          % op["status"])
    # 回滚不变量
    check(git("status", "--porcelain", cwd=ctrl.repo).stdout.strip() == "",
          "确认失败回滚后工作树干净")
    # 恢复后重试成功
    ctrl.git.remote_head = real_remote_head
    res = ctrl.sync(bid, session_id="sess-r2")
    check(res["state"] == SM.ONLINE_SYNCED, "恢复后重试成功")


# ================= CLD-FIX-003 §5.3 崩溃点注入 =================
def test_crash_before_payload_staging_no_side_effects():
    """staging 前崩溃等价：引擎拒绝（空内容）→ 无 journal、无工作树副作用。"""
    tmp = _tmp()
    ctrl = _provider_ctrl(tmp, [AUTH, UNAV, UNAV])
    bid = _binding_id(ctrl)
    result = ctrl.memory_write(bid, "sess-d", "CREATE", "   ",
                               category="state", remember=True)
    check(result["decision"] == "NO_CHANGE", "空内容 → NO_CHANGE（无副作用）")
    check(ctrl.journal.pending_count(bid) == 0, "无 journal 条目")
    check(git("status", "--porcelain", cwd=ctrl.repo).stdout.strip() == "",
          "工作树零改动")


def test_crash_after_payload_before_journal_orphan_isolated():
    """staging 后、journal 前崩溃 → 孤儿 payload：检测、隔离、审计，恢复不受阻。"""
    tmp = _tmp()
    ctrl = _provider_ctrl(tmp, [AUTH, UNAV, UNAV, AUTH])
    bid = _binding_id(ctrl)
    _degraded_write(ctrl, bid)
    # 模拟崩溃窗口：payload 已写、journal 未写
    orphan_id = new_uuid()
    env = {
        "schema_version": "clued.pending-payload.v0.1",
        "engine_op": "CREATE",
        "operation_id": orphan_id,
        "memory_id": "mem_dead0001",
        "target_id": None,
        "base_revision": None,
        "base_pending": False,
        "content": "孤儿 payload",
        "category": "state",
        "remember": True,
        "session_id": "sess-crash",
        "successor_oid": None,
        "candidate": {"id": "mem_dead0001", "content": "孤儿 payload"},
        "successor_candidate": None,
    }
    p = ctrl.paths.payload_ref_file(orphan_id)
    manifests.atomic_write_json(p, env)
    check(ctrl.journal.orphan_payloads(), "孤儿 payload 被检测")
    # doctor 检测并隔离（审计事件）
    try:
        ctrl.doctor(include_sync=False, include_engine=False)
        raise AssertionError("孤儿 payload 必须 doctor FAIL（CLD-SYNC-001）")
    except CluedError as exc:
        check(exc.code == "CLD-SYNC-001", exc.code)
    check(not os.path.isfile(ctrl.paths.payload_ref_file(orphan_id)),
          "孤儿已被隔离")
    check(os.path.isfile(os.path.join(ctrl.paths.orphan_payload_dir(),
                                      "%s.json" % orphan_id)),
          "孤儿证据保留在 orphans/")
    events = [e for e in ctrl.audit.tail(20)
              if e.get("event_type") == "pending_conflict"]
    check(any("orphan" in str(e.get("metadata")) for e in events),
          "孤儿隔离产生审计事件")
    # 已有 pending 不受影响，恢复成功
    res = ctrl.sync(bid, session_id="sess-r")
    check(res["state"] == SM.ONLINE_SYNCED, "孤儿不影响正常恢复")


def test_crash_after_journal_before_confirm_recoverable():
    """journal 后、用户确认前崩溃：重启后同一 operation_id 幂等恢复。"""
    tmp = _tmp()
    ctrl = _provider_ctrl(tmp, [AUTH, UNAV, UNAV, AUTH])
    bid = _binding_id(ctrl)
    result = _degraded_write(ctrl, bid)
    op_id = result["operation_id"]
    check(ctrl.journal.load(op_id)["status"] == "PENDING",
          "journal 已可恢复（未确认也已落盘）")
    res = ctrl.sync(bid, session_id="sess-r")
    check(res["state"] == SM.ONLINE_SYNCED, "重启后恢复")
    check(ctrl.journal.load(op_id)["status"] == "SYNCED", "同一 op 恢复成功")


def test_crash_mid_replay_residue_repair():
    """replay 进入 APPLYING 后崩溃（引擎已写、未 commit）：残留自愈 →
    doctor PASS → 完整重放成功。"""
    tmp = _tmp()
    ctrl = _provider_ctrl(tmp, [AUTH, UNAV, UNAV, AUTH])
    bid = _binding_id(ctrl)
    result = _degraded_write(ctrl, bid)
    op_id = result["operation_id"]
    op = ctrl.journal.load(op_id)
    # 模拟崩溃：mark_applying + 引擎写入已发生（无 commit、无 push）
    ctrl.journal.mark_applying(op)
    ctrl.gate.replay(op)
    check(git("status", "--porcelain", cwd=ctrl.repo).stdout.strip() != "",
          "崩溃残留存在（工作树脏）")
    doc = ctrl.sync_provider.doctor()
    check(not doc.ok, "残留导致 sync doctor FAIL（诚实暴露）")
    # 重新恢复：残留自愈 → doctor PASS → 重放 → 推送
    res = ctrl.sync(bid, session_id="sess-r")
    check(res["state"] == SM.ONLINE_SYNCED, "残留自愈后恢复成功")
    check(ctrl.journal.load(op_id)["status"] == "SYNCED", "最终 SYNCED")
    # 审计记录残留自愈
    events = [e for e in ctrl.audit.tail(100)]
    check(any(e.get("result_code") == "REPLAY_RESIDUE_REPAIRED"
              for e in events), "审计记录残留自愈")


def test_crash_after_applied_before_confirm_idempotent():
    """replay 已产生等价结果并已推送、尚未确认（mark SYNCED 前）崩溃：
    重启后 already 判定 → 不产生新 commit → SYNCED。"""
    tmp = _tmp()
    ctrl = _provider_ctrl(tmp, [AUTH, UNAV, UNAV, AUTH])
    bid = _binding_id(ctrl)
    result = _degraded_write(ctrl, bid)
    op_id = result["operation_id"]
    op = ctrl.journal.load(op_id)
    # 模拟：replay + commit + push 全部完成，仅 mark_synced 前崩溃
    ctrl.journal.mark_applying(op)
    _dec, touched = ctrl.gate.replay(op)
    from memory_engine import paths as engine_paths
    engine_paths.set_repo(ctrl.repo)
    relpaths = set()
    for oid in touched:
        relpaths.add(os.path.join("memory", "objects", "%s.json" % oid))
    relpaths.add(os.path.join("memory", "object-index.json"))
    relpaths.add(os.path.join("memory", "audit", "audit.log"))
    relpaths = sorted(r for r in relpaths
                      if os.path.isfile(os.path.join(ctrl.repo, r)))
    ctrl.git.commit_paths(relpaths, "[Clued] crash-sim replay", "Clued@T",
                          "clued@localhost")
    push = ctrl.sync_provider.push()
    check(push.ok, "模拟推送成功")
    check(_remote_sha(ctrl) == git("rev-parse", "HEAD",
                                   cwd=ctrl.repo).stdout.strip(),
          "远端已含等价结果")
    head_before = git("rev-parse", "HEAD", cwd=ctrl.repo).stdout.strip()
    # 重启恢复：already → 无新 commit → SYNCED
    res = ctrl.sync(bid, session_id="sess-r")
    check(res["state"] == SM.ONLINE_SYNCED, "恢复完成")
    check(ctrl.journal.load(op_id)["status"] == "SYNCED", "SYNCED")
    head_after = git("rev-parse", "HEAD", cwd=ctrl.repo).stdout.strip()
    check(head_before == head_after, "already 判定不产生新 commit")
    check(_remote_sha(ctrl) == head_after, "远端确认")


def test_restart_same_operation_id_idempotent():
    """重启后同一 operation_id 幂等恢复（不生成新 id、不产生二次效果）。"""
    tmp = _tmp()
    ctrl = _provider_ctrl(tmp, [AUTH, UNAV, UNAV, AUTH, AUTH])
    bid = _binding_id(ctrl)
    result = _degraded_write(ctrl, bid)
    op_id = result["operation_id"]
    mid = result["memory_id"]
    res = ctrl.sync(bid, session_id="sess-r")
    check(res["state"] == SM.ONLINE_SYNCED, "首次恢复")
    # 再次 sync（空 pending）→ 无二次效果
    from memory_engine import store
    from memory_engine import paths as engine_paths
    engine_paths.set_repo(ctrl.repo)
    before = store.load_object(mid)
    head_before = git("rev-parse", "HEAD", cwd=ctrl.repo).stdout.strip()
    res2 = ctrl.sync(bid, session_id="sess-r2")
    check(res2.get("no_change") is True, "空 pending → no-change")
    check(git("rev-parse", "HEAD", cwd=ctrl.repo).stdout.strip() ==
          head_before, "无新 commit")
    check(ctrl.journal.load(op_id)["status"] == "SYNCED",
          "operation_id 不变且已归档")


def _second_clone(tmp, repo):
    clone = os.path.join(tmp, "clone2")
    sh(["git", "clone", os.path.join(tmp, "remote.git"), clone])
    git("config", "user.name", "OtherAgent", cwd=clone)
    git("config", "user.email", "other@localhost", cwd=clone)
    return clone


TESTS = [
    test_doctor_fail_blocks_recovery_read_and_push,
    test_doctor_fail_never_calls_push,
    test_recovery_event_sequence_strict,
    test_pull_failure_keeps_pending_retryable,
    test_conflict_stops_whole_batch_no_push,
    test_push_failure_rolls_back_clean_and_retryable,
    test_verify_failure_pending_not_synced,
    test_crash_before_payload_staging_no_side_effects,
    test_crash_after_payload_before_journal_orphan_isolated,
    test_crash_after_journal_before_confirm_recoverable,
    test_crash_mid_replay_residue_repair,
    test_crash_after_applied_before_confirm_idempotent,
    test_restart_same_operation_id_idempotent,
]



TESTS = [requires_ref_write(t) for t in TESTS]

def main():
    run_tests(TESTS)


if __name__ == "__main__":
    main()
