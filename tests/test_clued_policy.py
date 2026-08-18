# -*- coding: utf-8 -*-
"""Clued LKG 策略测试（ADR-CLD-003 / 协议 v0.3.0）。

覆盖（执行计划阶段 B §B5）：
- balanced=6h：5h59m59s 可降级 / 6h00m00s 边界有效 / >6h 禁止降级；
- strict=1h：59m59s 可降级 / 60m00s 边界有效 / >60m 禁止降级；
- 新装默认 balanced；clued-v0.1.0 遗留 Binding 保守迁移 strict（幂等）；
- 有效降级截止 = min(LKG 到期, 降级会话到期)，运行中不得越过 LKG 绝对截止；
- 未知策略 / 任意自定义秒数超 6h → fail closed；
- 仅显式命令可切到 balanced；DENIED / DENIED_SECURITY 与策略无关立即 LOCKED；
- status / doctor 准确呈现当前策略与窗口字段。
"""

import hashlib
import json
import os
import random
import sys
import tempfile

from clued_testkit import check, make_controller

random.uniform = lambda a, b: 0.0  # 关闭认证重试抖动（测试提速）

from clued.auth.authcache import AuthCache
from clued.auth.engine import DEGRADED_SESSION_TTL_S, AuthEngine
from clued.auth.fake import FakeAuthProvider
from clued.auth.policy import (
    DEFAULT_POLICY, MAX_LKG_MAX_AGE_S, POLICY_PROFILES, UPGRADE_POLICY,
)
from clued.auth.provider import (
    AUTHORIZED, DENIED, DENIED_SECURITY, UNAVAILABLE,
)
from clued.circuit_breaker import CircuitBreaker
from clued.errors import CluedError
from clued.identifiers import now_rfc3339
from clued.paths import RuntimePaths

SCOPES = ["memory:read", "memory:write", "sync:request"]
# 无 auth_policy = clued-v0.1.0 遗留形状
BINDING = {
    "binding_id": "bind-1", "agent_id": "agent-1", "node_id": "node-1",
    "account_id": "github:testuser", "agent_type": "codex",
    "agent_instance_label": "TURING:codex", "status": "ACTIVE",
    "scopes": SCOPES,
}
BINDING_BALANCED = dict(BINDING, auth_policy="balanced")
BINDING_STRICT = dict(BINDING, auth_policy="strict")


def _tmp():
    return tempfile.mkdtemp(prefix="clued-policy-")


def _make(policy=None, spec=None, lkg_age_s=None, ttl_s=None, binding=None,
          now=None):
    root = os.path.join(_tmp(), ".clued")
    paths = RuntimePaths(root)
    paths.ensure_dirs()
    provider = FakeAuthProvider(spec or {"outcomes": []})
    cache = AuthCache(paths, "node-1")
    breaker = CircuitBreaker("auth")
    engine = AuthEngine(provider, cache, breaker, paths,
                        now=now if now is not None else (lambda: 0.0),
                        clock=lambda *a: None,
                        degraded_ttl_s=ttl_s or DEGRADED_SESSION_TTL_S,
                        policy=policy)
    if lkg_age_s is not None:
        from datetime import datetime, timedelta, timezone
        at = (datetime.now(timezone.utc) - timedelta(seconds=lkg_age_s)
              ).replace(microsecond=0).isoformat()
        cache.store("bind-1", "github:testuser", SCOPES, at, "github",
                    hashlib.sha256(b"testuser").hexdigest())
    return paths, provider, cache, breaker, engine


def _unavailable_spec():
    return {"outcomes": [{"kind": "UNAVAILABLE", "reason": "network"}]}


# ---- balanced（6h）边界 ----

def test_balanced_5h59m59s_degrades():
    _p, provider, cache, breaker, engine = _make(
        policy="balanced", spec=_unavailable_spec(), lkg_age_s=21599,
        binding=BINDING_BALANCED)
    result = engine.ensure_authorized(BINDING_BALANCED, "sess-1")
    check(result.is_degraded, "balanced：LKG 5h59m59s 仍有效，可降级")


def test_balanced_6h00m00s_boundary_valid():
    _p, provider, cache, breaker, engine = _make(
        policy="balanced", spec=_unavailable_spec(), lkg_age_s=60,
        binding=BINDING_BALANCED)
    engine.cache.age = lambda entry: 21600.0  # 恰好 6h（age <= lkg_max_age）
    result = engine.ensure_authorized(BINDING_BALANCED, "sess-1")
    check(result.is_degraded, "balanced：LKG 恰好 6h00m00s 边界有效")


def test_balanced_over_6h_blocks_degrade():
    _p, provider, cache, breaker, engine = _make(
        policy="balanced", spec=_unavailable_spec(), lkg_age_s=60,
        binding=BINDING_BALANCED)
    engine.cache.age = lambda entry: 21600.1  # 超过 6h
    result = engine.ensure_authorized(BINDING_BALANCED, "sess-1")
    check(result.kind == UNAVAILABLE and not result.is_degraded,
          "balanced：LKG > 6h 禁止降级")


# ---- strict（1h）边界 ----

def test_strict_59m59s_degrades():
    _p, provider, cache, breaker, engine = _make(
        policy="strict", spec=_unavailable_spec(), lkg_age_s=3599,
        binding=BINDING_STRICT)
    result = engine.ensure_authorized(BINDING_STRICT, "sess-1")
    check(result.is_degraded, "strict：LKG 59m59s 仍有效，可降级")


def test_strict_60m00s_boundary_valid():
    _p, provider, cache, breaker, engine = _make(
        policy="strict", spec=_unavailable_spec(), lkg_age_s=60,
        binding=BINDING_STRICT)
    engine.cache.age = lambda entry: 3600.0  # 恰好 1h
    result = engine.ensure_authorized(BINDING_STRICT, "sess-1")
    check(result.is_degraded, "strict：LKG 恰好 60m00s 边界有效")


def test_strict_over_60m_blocks_degrade():
    _p, provider, cache, breaker, engine = _make(
        policy="strict", spec=_unavailable_spec(), lkg_age_s=60,
        binding=BINDING_STRICT)
    engine.cache.age = lambda entry: 3600.1  # 超过 1h
    result = engine.ensure_authorized(BINDING_STRICT, "sess-1")
    check(result.kind == UNAVAILABLE and not result.is_degraded,
          "strict：LKG > 60m 禁止降级")


# ---- 遗留 Binding（无 auth_policy）保守回退 strict ----

def test_legacy_binding_falls_back_strict():
    """无 auth_policy 字段 → 引擎按 strict(1h) 裁决，绝不静默放宽到 6h。"""
    _p, provider, cache, breaker, engine = _make(
        spec=_unavailable_spec(), lkg_age_s=3599, binding=BINDING)
    r1 = engine.ensure_authorized(BINDING, "sess-1")
    check(r1.is_degraded, "遗留 Binding：LKG 59m59s 按 strict 仍可降级")
    engine.cache.age = lambda entry: 3600.1
    r2 = engine.ensure_authorized(BINDING, "sess-2")
    check(r2.kind == UNAVAILABLE and not r2.is_degraded,
          "遗留 Binding：LKG > 1h 按 strict 禁止降级（不静默扩大权限）")


# ---- 有效降级截止 = min(LKG 到期, 会话到期) ----

def test_effective_degraded_until_is_min_of_lkg_and_session():
    """balanced：LKG 距到期仅 600s（age=21000）→ 有效截止 = 600s，不是 1800s。"""
    _p, provider, cache, breaker, engine = _make(
        policy="balanced", spec=_unavailable_spec(), lkg_age_s=21000,
        binding=BINDING_BALANCED)
    engine.cache.age = lambda entry: 21000.0  # 固定 age（确定性）
    result = engine.ensure_authorized(BINDING_BALANCED, "sess-1")
    check(result.is_degraded, "可降级")
    # degraded_until = min(0 - 21000 + 21600, 0 + 1800) = min(600, 1800) = 600
    check(result.degraded_until == 600.0,
          "有效截止必须取 min(LKG 到期 600s, 会话到期 1800s)，实际 %s"
          % result.degraded_until)


def test_fresh_lkg_gets_full_session_ttl():
    """LKG 距离到期远 > 30min → 有效截止 = 完整 30 分钟会话。"""
    _p, provider, cache, breaker, engine = _make(
        policy="balanced", spec=_unavailable_spec(), lkg_age_s=60,
        binding=BINDING_BALANCED)
    result = engine.ensure_authorized(BINDING_BALANCED, "sess-1")
    check(result.is_degraded, "可降级")
    check(result.degraded_until == DEGRADED_SESSION_TTL_S,
          "LKG 新鲜 → 完整 30 分钟 TTL（%s）" % result.degraded_until)


def test_running_degraded_session_cannot_cross_lkg_deadline():
    """运行中降级会话不得越过 LKG 绝对截止：有效截止恒为 min()，绝不续满。"""
    clock = [0.0]
    _p, provider, cache, breaker, engine = _make(
        policy="balanced", spec=_unavailable_spec(), lkg_age_s=21000,
        binding=BINDING_BALANCED, now=lambda: clock[0])
    engine.cache.age = lambda entry: 21000.0  # 固定 age（LKG 6h 前授权）
    r1 = engine.ensure_authorized(BINDING_BALANCED, "sess-1")
    check(r1.degraded_until == 600.0, "首次降级有效截止 = 600s（min(600, 1800)）")
    # 会话运行中（500s < 600s 有效截止）：复用，截止仍为 600s，不得续到 1800s
    clock[0] = 500.0
    r2 = engine.ensure_authorized(BINDING_BALANCED, "sess-1")
    check(r2.is_degraded and r2.degraded_until == 600.0,
          "运行中会话截止仍为 600s（LKG 绝对截止），实际 %s"
          % r2.degraded_until)
    # 超过有效截止（700s > 600s）：重新评估；新窗口仍受 min() 约束
    clock[0] = 700.0
    r3 = engine.ensure_authorized(BINDING_BALANCED, "sess-1")
    check(r3.degraded_until == 1300.0,
          "重新评估后有效截止 = min(700-21000+21600, 700+1800) = 1300s，实际 %s"
          % r3.degraded_until)


# ---- 通用不变量（与策略无关）----

def test_new_session_still_attempts_online_each_policy():
    for policy in ("balanced", "strict"):
        _p, provider, cache, breaker, engine = _make(
            policy=policy, spec={
                "outcomes": [{"kind": "AUTHORIZED", "account_id":
                              "github:testuser", "scopes": SCOPES,
                              "subject": "testuser"}]},
            binding=dict(BINDING, auth_policy=policy))
        engine.ensure_authorized(dict(BINDING, auth_policy=policy), "s-1")
        n = len(provider.calls)
        engine.ensure_authorized(dict(BINDING, auth_policy=policy), "s-2")
        check(len(provider.calls) == n + 1,
              "%s：新会话必须重新在线尝试（§7.1）" % policy)


def test_denied_locks_regardless_of_policy():
    for policy in ("balanced", "strict"):
        _p, provider, cache, breaker, engine = _make(
            policy=policy, spec={
                "outcomes": [{"kind": "DENIED", "reason": "forbidden"}]},
            binding=dict(BINDING, auth_policy=policy))
        result = engine.ensure_authorized(
            dict(BINDING, auth_policy=policy), "sess-1")
        check(result.is_denial, "%s：DENIED 立即拒绝，绝不降级" % policy)


def test_tls_denied_security_never_degrades_with_balanced():
    """TLS/签名安全错误与策略无关：balanced 下 DENIED_SECURITY 也不降级。"""
    _p, provider, cache, breaker, engine = _make(
        policy="balanced", spec={
            "outcomes": [{"kind": "DENIED_SECURITY", "reason": "tls"}]},
        lkg_age_s=60, binding=BINDING_BALANCED)
    result = engine.ensure_authorized(BINDING_BALANCED, "sess-1")
    check(result.kind == DENIED_SECURITY and not result.is_degraded,
          "balanced：TLS 安全错误绝不降级（§7.2）")


# ---- fail closed：未知策略 / 超 6h ----

def test_unknown_policy_engine_constructor_fail_closed():
    root = os.path.join(_tmp(), ".clued")
    paths = RuntimePaths(root)
    paths.ensure_dirs()
    provider = FakeAuthProvider({"outcomes": []})
    try:
        AuthEngine(provider, AuthCache(paths, "node-1"),
                   CircuitBreaker("auth"), paths, policy="turbo")
        raise AssertionError("未知策略必须 fail closed")
    except CluedError as exc:
        check(exc.code == "CLD-AUTH-006", exc.code)


def test_unknown_policy_binding_manifest_fail_closed():
    from clued import manifests
    bad = manifests.build_binding_manifest(
        "b1", "a1", "n1", "github:u", "codex", "x", "0.2.x", SCOPES,
        auth_policy="turbo")
    ok, err = manifests.validate_binding_manifest(bad)
    check(not ok and "turbo" in err, "未知策略 manifest 必须被拒绝: %s" % err)


def test_over_6h_seconds_fail_closed():
    root = os.path.join(_tmp(), ".clued")
    paths = RuntimePaths(root)
    paths.ensure_dirs()
    provider = FakeAuthProvider({"outcomes": []})
    try:
        AuthEngine(provider, AuthCache(paths, "node-1"),
                   CircuitBreaker("auth"), paths, lkg_max_age_s=21601)
        raise AssertionError(">6h 秒数必须 fail closed")
    except CluedError as exc:
        check(exc.code == "CLD-AUTH-006", exc.code)
    check(MAX_LKG_MAX_AGE_S == 21600.0, "6h 上限权威值")


def test_adapter_cannot_expand_policy():
    """Adapter 只能选语义策略名；不得自行传任意秒数扩大窗口。"""
    check(set(POLICY_PROFILES) == {"balanced", "strict"},
          "策略注册表只含 balanced/strict")
    check(POLICY_PROFILES["balanced"]["lkg_max_age_s"] == 21600.0
          and POLICY_PROFILES["strict"]["lkg_max_age_s"] == 3600.0,
          "注册表数值权威（balanced=6h / strict=1h）")


# ---- 安装 / 迁移 / 显式切换（controller 级）----

def test_new_install_defaults_to_balanced():
    tmp = _tmp()
    ctrl = make_controller(tmp)
    result = ctrl.install("codex", "TURING:codex", session_id="s1")
    binding = result["binding"]
    check(binding.get("auth_policy") == DEFAULT_POLICY,
          "新装默认 balanced，实际 %s" % binding.get("auth_policy"))
    check(DEFAULT_POLICY == "balanced", "DEFAULT_POLICY=balanced")
    st = ctrl.status(binding["binding_id"])
    b = st["bindings"][0]
    check(b["auth_policy"] == "balanced", "status 呈现 auth_policy")
    check(b["lkg_max_age"] == 21600.0, "status 呈现 lkg_max_age=6h")
    check(b["lkg_authorized_at"] is not None, "status 呈现 lkg_authorized_at")
    check(b["lkg_expires_at"] is not None, "status 呈现 lkg_expires_at")


def test_legacy_binding_migrates_to_strict_idempotent():
    tmp = _tmp()
    ctrl = make_controller(tmp)
    bid = ctrl.install("codex", "TURING:codex", session_id="s1")[
        "binding"]["binding_id"]
    # 手工剥掉 auth_policy → 模拟 clued-v0.1.0 遗留 Binding
    from clued import manifests
    path = ctrl.paths.binding_manifest(bid)
    data = manifests.read_json(path)
    data.pop("auth_policy", None)
    manifests.atomic_write_json(path, data)
    # 第一次加载 → 保守迁移 strict（写盘 + 审计一次）
    migrated = ctrl.registry.load_binding(bid)
    check(migrated.get("auth_policy") == UPGRADE_POLICY,
          "遗留 Binding 保守迁移 strict（实际 %s）"
          % migrated.get("auth_policy"))
    on_disk = manifests.read_json(path)
    check(on_disk.get("auth_policy") == "strict", "迁移已写盘")
    # 幂等：再次加载不重复写、不重复审计
    ctrl.registry.load_binding(bid)
    events = [e for e in ctrl.audit.tail(200)
              if e.get("event_type") == "policy_migrated"]
    check(len(events) == 1, "迁移审计仅一次（幂等），实际 %d" % len(events))
    # 迁移后仍为 strict，绝不自动放宽 balanced
    check(ctrl.registry.load_binding(bid).get("auth_policy") == "strict",
          "迁移结果稳定为 strict")


def test_explicit_command_switches_policy():
    tmp = _tmp()
    ctrl = make_controller(tmp)
    bid = ctrl.install("codex", "TURING:codex", session_id="s1")[
        "binding"]["binding_id"]
    # 只读查看
    cur = ctrl.auth_policy(bid)
    check(cur["auth_policy"] == "balanced", "默认 balanced")
    # 显式切 strict
    r1 = ctrl.auth_policy(bid, set_policy="strict")
    check(r1["changed"] is True and r1["auth_policy"] == "strict",
          "显式切换 strict")
    check(ctrl.registry.load_binding(bid).get("auth_policy") == "strict",
          "切换已写盘")
    # 显式切回 balanced（仅经显式命令）
    r2 = ctrl.auth_policy(bid, set_policy="balanced")
    check(r2["changed"] is True and r2["auth_policy"] == "balanced",
          "显式切换回 balanced")
    events = [e for e in ctrl.audit.tail(200)
              if e.get("event_type") == "policy_change"]
    check(len(events) == 2, "每次显式切换审计 policy_change（%d）"
          % len(events))
    # 未知策略经命令 → fail closed
    try:
        ctrl.auth_policy(bid, set_policy="turbo")
        raise AssertionError("命令切换未知策略必须拒绝")
    except CluedError as exc:
        check(exc.code == "CLD-AUTH-006", exc.code)
    # 同值切换 = 无变化
    r3 = ctrl.auth_policy(bid, set_policy="balanced")
    check(r3.get("changed") is False, "同策略切换无变化")


def test_degraded_status_shows_policy_and_window_fields():
    """status 必须显示 auth_policy / lkg_max_age / lkg_authorized_at /
    lkg_expires_at / degraded_session_expires_at / effective_degraded_until。"""
    tmp = _tmp()
    spec = {"outcomes": [
        {"kind": "AUTHORIZED", "account_id": "github:testuser",
         "scopes": SCOPES, "subject": "testuser"},
        {"kind": "UNAVAILABLE", "reason": "network", "detail": "offline"},
    ]}
    ctrl = make_controller(tmp, provider=FakeAuthProvider(spec))
    bid = ctrl.install("codex", "TURING:codex", session_id="s1")[
        "binding"]["binding_id"]
    # 新会话 → UNAVAILABLE → LKG 新鲜 → 降级（有效截止 = 30min）
    r = ctrl.auth_check(bid, session_id="s-degrade")
    check(r["code"] == "DEGRADED", "进入降级: %s" % r.get("code"))
    st = ctrl.status(bid)
    b = st["bindings"][0]
    for field in ("auth_policy", "lkg_max_age", "lkg_authorized_at",
                  "lkg_expires_at", "degraded_session_expires_at",
                  "effective_degraded_until"):
        check(b.get(field) is not None,
              "status 缺少字段 %s（实际 keys: %s）" % (field, sorted(b.keys())))
    check(b["auth_policy"] == "balanced", "auth_policy=balanced")
    check(b["lkg_max_age"] == 21600.0, "lkg_max_age=6h")
    # 有效截止 ≤ 会话到期（min 语义；LKG 新鲜时两者相等 = 30min）
    check(b["effective_degraded_until"] <= b["degraded_session_expires_at"],
          "effective_degraded_until <= degraded_session_expires_at")
    # 状态输出不得含凭据样值
    from clued.redact import contains_secret
    check(not contains_secret(json.dumps(st, ensure_ascii=False)),
          "status 不含任何凭据样值")


def test_doctor_reports_policy():
    tmp = _tmp()
    ctrl = make_controller(tmp)
    ctrl.install("codex", "TURING:codex", session_id="s1")
    doc = ctrl.doctor()
    findings = {f["check"]: f for f in doc["findings"]}
    policy_checks = [f for name, f in findings.items()
                     if name.startswith("policy_")]
    check(len(policy_checks) == 1, "doctor 含 policy_<binding> 检查")
    check(policy_checks[0]["ok"] is True, "策略检查 PASS")
    check("auth_policy=balanced" in policy_checks[0]["detail"],
          "doctor 呈现当前策略: %s" % policy_checks[0]["detail"])


TESTS = [
    test_balanced_5h59m59s_degrades,
    test_balanced_6h00m00s_boundary_valid,
    test_balanced_over_6h_blocks_degrade,
    test_strict_59m59s_degrades,
    test_strict_60m00s_boundary_valid,
    test_strict_over_60m_blocks_degrade,
    test_legacy_binding_falls_back_strict,
    test_effective_degraded_until_is_min_of_lkg_and_session,
    test_fresh_lkg_gets_full_session_ttl,
    test_running_degraded_session_cannot_cross_lkg_deadline,
    test_new_session_still_attempts_online_each_policy,
    test_denied_locks_regardless_of_policy,
    test_tls_denied_security_never_degrades_with_balanced,
    test_unknown_policy_engine_constructor_fail_closed,
    test_unknown_policy_binding_manifest_fail_closed,
    test_over_6h_seconds_fail_closed,
    test_adapter_cannot_expand_policy,
    test_new_install_defaults_to_balanced,
    test_legacy_binding_migrates_to_strict_idempotent,
    test_explicit_command_switches_policy,
    test_degraded_status_shows_policy_and_window_fields,
    test_doctor_reports_policy,
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
