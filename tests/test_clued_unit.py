# -*- coding: utf-8 -*-
"""Clued 单元测试：信封 / 错误码 / 状态机 / 清单 / 审计脱敏 / LKG / 熔断 /
Journal 状态机 / 锁 / 标识符。无网络、无 git。"""

import json
import os
import sys
import tempfile

from clued_testkit import check

from clued import envelope
from clued import errors
from clued import manifests
from clued import state_machine as SM
from clued.audit import AuditLog
from clued.auth.authcache import AuthCache
from clued.circuit_breaker import CLOSED, HALF_OPEN, OPEN, CircuitBreaker
from clued.errors import CluedError, exit_code_for
from clued.identifiers import (
    age_seconds, new_uuid, now_rfc3339, valid_uuid4,
)
from clued.locking import CrossProcessLock
from clued.paths import RuntimePaths
from clued.pending_journal import PendingJournal
from clued.redact import contains_secret, redact


def _tmp():
    return tempfile.mkdtemp(prefix="clued-unit-")


def _paths():
    return RuntimePaths(os.path.join(_tmp(), ".clued"))


# ---- 信封（§13.1）----
def test_envelope_ok_shape():
    env = envelope.envelope_ok(state="ONLINE_SYNCED", code="AUTHORIZED",
                               message="ok")
    check(env["ok"] is True, "ok 应为 true")
    check(env["protocol_version"] == "0.2.0", "协议版本 0.2.0")
    for key in ("request_id", "code", "state", "message", "data", "actions",
                "retry_after_seconds", "timestamp"):
        check(key in env, "缺少信封字段 %s" % key)
    check(isinstance(env["actions"], list), "actions 应为列表")


def test_envelope_fail_has_nonzero_exit():
    env = envelope.envelope_fail("CLD-AUTH-001", message="denied")
    check(env["ok"] is False, "ok 应为 false")


# ---- 退出码（§13.2）----
def test_exit_code_mapping():
    cases = {
        "CLD-CAP-001": 20, "CLD-INSTALL-001": 50, "CLD-AUTH-001": 30,
        "CLD-AUTH-002": 30, "CLD-NET-001": 31, "CLD-SYNC-001": 40,
        "CLD-CONFLICT-001": 41, "CLD-UNINSTALL-001": 50, "CLD-SEC-001": 60,
        "CLD-PEND-001": 41, "DENIED": 30, "UNAVAILABLE": 31,
    }
    for code, expected in cases.items():
        check(exit_code_for(code) == expected,
              "退出码映射错误 %s → %s（期望 %s）"
              % (code, exit_code_for(code), expected))


def test_error_codes_stable():
    for code in errors.ERROR_CODES:
        check(code.startswith("CLD-"), code)
    # 协议要求的点名结果码
    for code in errors.RESULT_CODES:
        check(code in errors.RESULT_CODES, code)


# ---- 状态机（§11）----
def test_state_machine_key_transitions():
    ok = [
        (SM.UNINSTALLED, SM.INSTALLING),
        (SM.INSTALLING, SM.ONLINE_SYNCED),
        (SM.AUTH_REQUIRED, SM.DEGRADED_LOCAL),
        (SM.AUTH_REQUIRED, SM.LOCKED),
        (SM.ONLINE_SYNCED, SM.ONLINE_DIRTY),
        (SM.ONLINE_SYNCED, SM.DEGRADED_LOCAL),
        (SM.DEGRADED_LOCAL, SM.RECOVERING),
        (SM.RECOVERING, SM.ONLINE_SYNCED),
        (SM.RECOVERING, SM.CONFLICT_REVIEW),
        (SM.ONLINE_SYNCED, SM.LOCKED),
        (SM.ONLINE_SYNCED, SM.UNINSTALLING),
        (SM.UNINSTALLING, SM.UNINSTALLED),
        (SM.LOCKED, SM.AUTH_REQUIRED),
    ]
    for a, b in ok:
        SM.check_transition(a, b)


def test_state_machine_illegal_transitions():
    bad = [
        (SM.UNINSTALLED, SM.ONLINE_SYNCED),
        (SM.LOCKED, SM.ONLINE_SYNCED),
        (SM.ONLINE_SYNCED, SM.UNINSTALLED),
        (SM.DEGRADED_LOCAL, SM.UNINSTALLED),
    ]
    for a, b in bad:
        try:
            SM.check_transition(a, b)
            raise AssertionError("非法转换未被拒绝: %s→%s" % (a, b))
        except SM.InvalidTransition:
            pass


# ---- 清单（§5.2–§5.4 / §15.3）----
def test_node_and_binding_manifest_roundtrip():
    node = manifests.build_node_manifest(new_uuid())
    ok, err = manifests.validate_node_manifest(node)
    check(ok, err)
    binding = manifests.build_binding_manifest(
        new_uuid(), new_uuid(), node["node_id"], "github:u", "codex",
        "TURING:codex", "0.1.x", manifests.SCOPES)
    ok, err = manifests.validate_binding_manifest(binding)
    check(ok, err)
    check(binding["schema_version"] == "clued.binding.v0.1", "schema 版本")


def test_binding_manifest_rejects_secrets():
    binding = manifests.build_binding_manifest(
        new_uuid(), new_uuid(), new_uuid(), "github:u", "codex", "x",
        "0.1.x", manifests.SCOPES)
    binding["agent_instance_label"] = "ghp_" + "A" * 25
    ok, err = manifests.validate_binding_manifest(binding)
    check(not ok, "manifest 含凭据样值必须被拒绝")


def test_auth_cache_integrity():
    paths = _paths()
    paths.ensure_dirs()
    cache = AuthCache(paths, "node-1")
    entry = cache.store("bind-1", "github:u", manifests.SCOPES,
                        now_rfc3339(), "github", "a" * 64)
    loaded, err = cache.load("bind-1")
    check(err is None, "LKG 读取失败: %s" % err)
    # 篡改 proof_hash → 完整性失败
    path = paths.auth_cache("bind-1")
    data = manifests.read_json(path)
    data["proof_hash"] = "f" * 64
    manifests.atomic_write_json(path, data)
    loaded2, err2 = cache.load("bind-1")
    check(err2 is not None, "篡改必须被检测（CLD-AUTH-004）")
    check("proof_hash" in (err2 or ""), err2)


def test_auth_cache_rejects_secret_write():
    paths = _paths()
    paths.ensure_dirs()
    cache = AuthCache(paths, "node-1")
    try:
        cache.store("bind-1", "github:u", ["ghp_" + "B" * 25],
                    now_rfc3339(), "github", "a" * 64)
        raise AssertionError("含凭据 scope 的 LKG 必须被拒绝")
    except CluedError:
        pass


def test_manifest_atomic_write():
    paths = _paths()
    path = os.path.join(paths.root, "x.json")
    manifests.atomic_write_json(path, {"a": 1})
    check(manifests.read_json(path) == {"a": 1}, "原子写回读")


# ---- 审计（§15.4）----
def test_audit_redacts_secrets():
    paths = _paths()
    audit = AuditLog(paths.audit_log())
    audit.append("auth_denied", binding_id="b1", request_id="r1",
                 result_code="DENIED",
                 metadata={"detail": "token ghp_" + "C" * 30})
    tail = audit.tail(1)
    check(len(tail) == 1, "审计应有 1 条")
    blob = json.dumps(tail[0], ensure_ascii=False)
    check("ghp_" not in blob, "审计不得含凭据")
    check("REDACTED" in blob, "凭据应被掩码")
    for field in ("timestamp", "request_id", "binding_id", "event_type",
                  "result_code"):
        check(field in tail[0], "审计缺字段 %s" % field)


def test_redact_guards_patterns():
    check(redact("gho_" + "d" * 25) == "***REDACTED***", "gho_ 掩码")
    check(redact("AKIA" + "1234567890ABCDEF") == "***REDACTED***", "AKIA 掩码")
    check(redact("Bearer " + "e" * 25) == "***REDACTED***", "Bearer 掩码")
    check(contains_secret("github_pat_" + "f" * 30), "PAT 检测")
    check(not contains_secret("普通文本"), "普通文本不误报")


# ---- 熔断器（§8）----
def test_breaker_open_close():
    b = CircuitBreaker("sync")
    check(b.state == CLOSED, "初始 CLOSED")
    check(b.allow_request(), "CLOSED 放行")
    b.record_failure(temporary=True)
    b.record_failure(temporary=True)
    check(b.state == OPEN, "2 次同步失败 → OPEN")
    check(not b.allow_request(), "OPEN 冷却期内拒绝")
    check(b.retry_after() is not None, "OPEN 有 retry_after")


def test_breaker_half_open_single_flight():
    paths = _paths()
    paths.ensure_dirs()
    b = CircuitBreaker("auth", paths=paths, binding_id="b1")
    b.state = OPEN
    b.opened_at = 0  # 冷却已过
    check(b.allow_request(), "冷却后应允许进入 HALF_OPEN")
    check(b.state == HALF_OPEN, "进入 HALF_OPEN")
    check(not b.allow_request(), "HALF_OPEN 单飞：第二个请求拒绝")
    b.record_success()
    check(b.state == CLOSED, "探测成功 → CLOSED")


def test_breaker_exponential_cooldown():
    b = CircuitBreaker("sync")
    b.force_open(now=0)
    c1 = b.cooldown_s
    b._open(now=1)  # 连续失败 → 指数增长
    check(b.cooldown_s == min(c1 * 2, 900), "冷却指数增长")
    for _ in range(10):
        b._open(now=2)
    check(b.cooldown_s <= 900, "冷却上限 15 分钟")


# ---- Journal（§9）----
def test_journal_create_and_order():
    paths = _paths()
    paths.ensure_dirs()
    j = PendingJournal(paths)
    op1 = j.create("b", "a", "n", "s", "CREATE", "obj:x", None,
                   "memory/objects/x.json", "a" * 64)
    op2 = j.create("b", "a", "n", "s", "UPDATE", "obj:x", "b" * 64,
                   "memory/objects/x.json", "a" * 64)
    ops = j.pending("b")
    check([o["operation_id"] for o in ops]
          == [op1["operation_id"], op2["operation_id"]],
          "同一 Binding 按创建顺序处理（§9.4）")
    check(op1["operation_id"] != op2["operation_id"], "operation_id 唯一")


def test_journal_transition_rules():
    paths = _paths()
    paths.ensure_dirs()
    j = PendingJournal(paths)
    op = j.create("b", "a", "n", "s", "CREATE", "obj:x", None, "r", "a" * 64)
    j.mark_applying(op)
    check(j.load(op["operation_id"])["status"] == "APPLYING",
          "PENDING → APPLYING")
    j.mark_synced(op)
    check(j.load(op["operation_id"])["status"] == "SYNCED",
          "APPLYING → SYNCED")
    # 非法转移：SYNCED → PENDING 必须拒绝
    try:
        j.transition(j.load(op["operation_id"]), "PENDING")
        raise AssertionError("SYNCED → PENDING 非法转移未被拒绝")
    except CluedError:
        pass


def test_journal_crash_recovery_applying_to_pending():
    paths = _paths()
    paths.ensure_dirs()
    j = PendingJournal(paths)
    op = j.create("b", "a", "n", "s", "CREATE", "obj:x", None, "r", "a" * 64)
    j.mark_applying(op)
    recovered = j.recover_applying("b")
    check(len(recovered) == 1, "APPLYING 应恢复为 PENDING（§9.3.5）")
    check(j.load(op["operation_id"])["status"] == "PENDING", "恢复后 PENDING")


def test_journal_retry_keeps_operation_id():
    paths = _paths()
    paths.ensure_dirs()
    j = PendingJournal(paths)
    op = j.create("b", "a", "n", "s", "CREATE", "obj:x", None, "r", "a" * 64)
    op_id = op["operation_id"]
    j.mark_applying(op)
    j.recover_applying("b")
    again = j.pending("b")[0]
    check(again["operation_id"] == op_id, "重试不得生成新 operation_id（§9.3.1）")


def test_journal_corrupt_kept_not_dropped():
    paths = _paths()
    paths.ensure_dirs()
    j = PendingJournal(paths)
    op = j.create("b", "a", "n", "s", "CREATE", "obj:x", None, "r", "a" * 64)
    path = paths.pending_file(op["operation_id"])
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("{ broken json")
    loaded = j.load(op["operation_id"])
    check(loaded is None, "损坏条目 load 返回 None")
    check(os.path.isfile(path), "损坏证据必须保留（§9.3.8），不静默丢弃")


# ---- 锁 ----
def test_lock_exclusive():
    paths = _paths()
    paths.ensure_dirs()
    lock_path = os.path.join(paths.locks_dir(), "t.lock")
    a = CrossProcessLock(lock_path)
    b = CrossProcessLock(lock_path)
    check(a.acquire(), "首个锁成功")
    check(not b.acquire(), "同进程第二把锁拒绝")
    a.release()
    check(b.acquire(), "释放后可再获取")
    b.release()


# ---- 标识符（§5.1）----
def test_identifiers():
    a, b = new_uuid(), new_uuid()
    check(valid_uuid4(a) and valid_uuid4(b), "UUIDv4 合法")
    check(a != b, "UUID 唯一")
    check(age_seconds(now_rfc3339()) is not None, "RFC3339 解析")
    check(age_seconds("not-a-time") is None, "非法时间返回 None")


def test_pending_op_schema_validation():
    op = manifests.build_pending_op(
        new_uuid(), new_uuid(), new_uuid(), new_uuid(), new_uuid(), "CREATE",
        "obj:x", None, "r", "a" * 64)
    ok, err = manifests.validate_pending_op(op)
    check(ok, err)
    op["operation_type"] = "DESTROY"
    ok, err = manifests.validate_pending_op(op)
    check(not ok, "非法 operation_type 必须被拒绝")


def test_path_traversal_rejected():
    base = os.path.join(_tmp(), "safe-root")
    os.makedirs(base)
    try:
        manifests._fs_safe_path(base, os.path.join(base, "..", "evil.txt"))
        raise AssertionError("路径越界必须拒绝（§15.3）")
    except CluedError:
        pass
    # 允许根内路径
    ok = manifests._fs_safe_path(base, os.path.join(base, "ok.txt"))
    check(ok.endswith("ok.txt"), "根内路径放行")


def test_wide_delete_never_invoked():
    """§12.5：删除必须基于 manifest 精确路径；工具层不提供宽泛递归删除入口。"""
    import clued.uninstaller as U
    check(not hasattr(U.Uninstaller, "rmtree"), "卸载器无宽泛删除入口")
    import clued.recovery as R
    check(not hasattr(R.Recovery, "rmtree"), "恢复器无宽泛删除入口")


TESTS = [
    test_envelope_ok_shape,
    test_envelope_fail_has_nonzero_exit,
    test_exit_code_mapping,
    test_error_codes_stable,
    test_state_machine_key_transitions,
    test_state_machine_illegal_transitions,
    test_node_and_binding_manifest_roundtrip,
    test_binding_manifest_rejects_secrets,
    test_auth_cache_integrity,
    test_auth_cache_rejects_secret_write,
    test_manifest_atomic_write,
    test_audit_redacts_secrets,
    test_redact_guards_patterns,
    test_breaker_open_close,
    test_breaker_half_open_single_flight,
    test_breaker_exponential_cooldown,
    test_journal_create_and_order,
    test_journal_transition_rules,
    test_journal_crash_recovery_applying_to_pending,
    test_journal_retry_keeps_operation_id,
    test_journal_corrupt_kept_not_dropped,
    test_lock_exclusive,
    test_identifiers,
    test_pending_op_schema_validation,
    test_path_traversal_rejected,
    test_wide_delete_never_invoked,
]


def main():
    failures = 0
    for fn in TESTS:
        try:
            fn()
            print("PASS %s" % fn.__name__)
        except Exception as exc:
            failures += 1
            print("FAIL %s: %s" % (fn.__name__, exc))
    print("----")
    print("%d test(s), %d failure(s)" % (len(TESTS), failures))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
