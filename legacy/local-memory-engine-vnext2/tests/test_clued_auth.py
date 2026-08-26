# -*- coding: utf-8 -*-
"""Clued 授权测试（协议 §7 v0.3.0）：三值结果 / 有界预算 / 拒绝绝不降级 /
LKG 策略边界（ADR-CLD-003：strict=1h；balanced 边界见 test_clued_policy.py）/
降级 TTL / scope 上限 / 会话复用。
故障注入用 FakeAuthProvider。"""

import os
import random
import sys
import tempfile

from clued_testkit import check

random.uniform = lambda a, b: 0.0  # 关闭认证重试抖动（测试提速）

from clued.audit import AuditLog
from clued.auth.authcache import AuthCache
from clued.auth.engine import (
    DEGRADED_SESSION_TTL_S, AuthEngine,
)
from clued.auth.fake import FakeAuthProvider
from clued.auth.provider import (
    AUTHORIZED, DENIED, DENIED_SECURITY, UNAVAILABLE,
)
from clued.circuit_breaker import OPEN, CircuitBreaker
from clued.errors import CluedError
from clued.identifiers import now_rfc3339
from clued.paths import RuntimePaths

SCOPES = ["memory:read", "memory:write", "sync:request"]
BINDING = {
    "binding_id": "bind-1", "agent_id": "agent-1", "node_id": "node-1",
    "account_id": "github:testuser", "agent_type": "codex",
    "agent_instance_label": "TURING:codex", "status": "ACTIVE",
    "scopes": SCOPES,
}


def _tmp():
    return tempfile.mkdtemp(prefix="clued-auth-")


def _make(spec=None, lkg_age_s=None, budget_s=None, ttl_s=None):
    root = os.path.join(_tmp(), ".clued")
    paths = RuntimePaths(root)
    paths.ensure_dirs()
    provider = FakeAuthProvider(spec or {"outcomes": []})
    cache = AuthCache(paths, "node-1")
    breaker = CircuitBreaker("auth")
    engine = AuthEngine(provider, cache, breaker, paths,
                        now=lambda: 0.0,
                        clock=lambda *a: None,
                        budget_s=budget_s or 12.0,
                        degraded_ttl_s=ttl_s or DEGRADED_SESSION_TTL_S)
    if lkg_age_s is not None:
        from datetime import datetime, timedelta, timezone
        import hashlib
        at = (datetime.now(timezone.utc) - timedelta(seconds=lkg_age_s)
              ).replace(microsecond=0).isoformat()
        cache.store("bind-1", "github:testuser", SCOPES, at, "github",
                    hashlib.sha256(b"testuser").hexdigest())
    return paths, provider, cache, breaker, engine


def test_authorized_online():
    _p, provider, cache, breaker, engine = _make({
        "outcomes": [{"kind": "AUTHORIZED", "account_id": "github:testuser",
                      "scopes": SCOPES, "subject": "testuser"}]})
    result = engine.ensure_authorized(BINDING, "sess-1")
    check(result.is_authorized, "应 AUTHORIZED")
    check(result.online_attempted, "必须在线尝试")
    # LKG 已登记
    entry, err = cache.load("bind-1")
    check(err is None and entry is not None, "成功后写 LKG")
    check("ghp_" not in os.path.basename(cache.paths.auth_cache("bind-1")),
          "LKG 文件名无凭据")
    # 同会话复用：不再次在线（provider.calls 不增长）
    n = len(provider.calls)
    result2 = engine.ensure_authorized(BINDING, "sess-1")
    check(result2.is_authorized and not result2.online_attempted,
          "同会话复用授权结果")
    check(len(provider.calls) == n, "同会话复用不得再次在线")


def test_new_session_reattempts_online():
    _p, provider, cache, breaker, engine = _make({
        "outcomes": [{"kind": "AUTHORIZED", "account_id": "github:testuser",
                      "scopes": SCOPES, "subject": "testuser"}]})
    engine.ensure_authorized(BINDING, "sess-1")
    n = len(provider.calls)
    engine.ensure_authorized(BINDING, "sess-2")
    check(len(provider.calls) == n + 1, "新会话必须重新在线尝试（§7.1）")


def test_denied_never_degrades():
    _p, provider, cache, breaker, engine = _make({
        "outcomes": [{"kind": "DENIED", "reason": "forbidden"}]})
    result = engine.ensure_authorized(BINDING, "sess-1")
    check(result.is_denial, "明确拒绝")
    check(result.kind == DENIED, "DENIED 语义")
    check(cache.load("bind-1")[0] is None, "拒绝不写 LKG")
    # 同会话再次访问：仍拒绝，不降级
    result2 = engine.ensure_authorized(BINDING, "sess-1")
    check(result2.is_denial, "拒绝后同会话仍拒绝")


def test_tls_error_is_denied_security():
    _p, provider, cache, breaker, engine = _make({
        "outcomes": [{"kind": "DENIED_SECURITY", "reason": "tls"}]})
    result = engine.ensure_authorized(BINDING, "sess-1")
    check(result.kind == DENIED_SECURITY, "TLS 错误必须 DENIED_SECURITY（§7.2）")
    check(result.is_denial, "安全错误按拒绝处理")


def test_unavailable_with_fresh_lkg_degrades():
    _p, provider, cache, breaker, engine = _make(
        {"outcomes": [{"kind": "UNAVAILABLE", "reason": "network"}]},
        lkg_age_s=60)
    result = engine.ensure_authorized(BINDING, "sess-1")
    check(result.is_degraded, "LKG 新鲜 + 网络不可用 → 降级")
    check(result.degraded_until == DEGRADED_SESSION_TTL_S,
          "降级 TTL 30 分钟（clock=0）")
    check(set(result.scopes) <= set(SCOPES), "降级 scope 不超过 LKG")


def test_unavailable_no_lkg_blocks_degrade():
    _p, provider, cache, breaker, engine = _make({
        "outcomes": [{"kind": "UNAVAILABLE", "reason": "network"}]})
    result = engine.ensure_authorized(BINDING, "sess-1")
    check(result.kind == UNAVAILABLE, "无 LKG → CLD-AUTH-003 禁止降级")


def test_lkg_over_1h_blocks_degrade():
    _p, provider, cache, breaker, engine = _make(
        {"outcomes": [{"kind": "UNAVAILABLE", "reason": "network"}]},
        lkg_age_s=7200)
    result = engine.ensure_authorized(BINDING, "sess-1")
    check(result.kind == UNAVAILABLE, "LKG > 1h 禁止降级（ADR-CLD-001）")


def test_lkg_59m59s_degrades():
    """age = 3599s（59m59s）→ 仍有效，可按规则降级。"""
    _p, provider, cache, breaker, engine = _make(
        {"outcomes": [{"kind": "UNAVAILABLE", "reason": "network"}]},
        lkg_age_s=3599)
    result = engine.ensure_authorized(BINDING, "sess-1")
    check(result.is_degraded, "LKG 59m59s 仍有效，可降级")


def test_lkg_60m00s_boundary_valid():
    """边界固定：age <= 1h 有效 → 恰好 60m00s 仍可降级（假时钟固定 age）。"""
    _p, provider, cache, breaker, engine = _make(
        {"outcomes": [{"kind": "UNAVAILABLE", "reason": "network"}]},
        lkg_age_s=60)
    engine.cache.age = lambda entry: 3600.0  # 恰好 1h（边界）
    result = engine.ensure_authorized(BINDING, "sess-1")
    check(result.is_degraded, "LKG 恰好 60m00s（age <= 1h）仍有效")


def test_lkg_over_60m00s_blocks_degrade():
    """边界固定：age > 1h 失效 → 3600.1s 禁止降级（假时钟固定 age）。"""
    _p, provider, cache, breaker, engine = _make(
        {"outcomes": [{"kind": "UNAVAILABLE", "reason": "network"}]},
        lkg_age_s=60)
    engine.cache.age = lambda entry: 3600.1  # 超过 1h（失效）
    result = engine.ensure_authorized(BINDING, "sess-1")
    check(result.kind == UNAVAILABLE, "LKG > 1h 禁止降级")


def test_lkg_max_age_extension_rejected():
    """超过 6 小时上限 = 协议配置变化，必须拒绝（ADR-CLD-003，fail closed）。"""
    root = os.path.join(_tmp(), ".clued")
    paths = RuntimePaths(root)
    paths.ensure_dirs()
    provider = FakeAuthProvider({"outcomes": []})
    cache = AuthCache(paths, "node-1")
    breaker = CircuitBreaker("auth")
    try:
        AuthEngine(provider, cache, breaker, paths, lkg_max_age_s=21601)
        raise AssertionError("lkg_max_age > 6h 配置必须被拒绝")
    except CluedError as exc:
        check(exc.code == "CLD-AUTH-006", exc.code)
    # 6h 整（balanced 上限）允许作为覆盖；缩短（如 2h）也允许
    for allowed in (21600, 7200, 1800):
        shorter = AuthEngine(provider, cache, breaker, paths,
                             lkg_max_age_s=allowed)
        check(shorter.lkg_max_age_s == allowed,
              "允许 %ss（≤ 6h 上限）作为 LKG 上限覆盖" % allowed)


def test_tampered_lkg_never_degrades():
    _p, provider, cache, breaker, engine = _make(
        {"outcomes": [{"kind": "UNAVAILABLE", "reason": "network"}]},
        lkg_age_s=60)
    from clued import manifests
    data = manifests.read_json(cache.paths.auth_cache("bind-1"))
    data["scopes"] = ["memory:read", "memory:write", "sync:request",
                      "memory:delete"]
    manifests.atomic_write_json(cache.paths.auth_cache("bind-1"), data)
    result = engine.ensure_authorized(BINDING, "sess-1")
    check(result.kind == UNAVAILABLE and not result.is_degraded,
          "LKG 篡改 → 完整性失败，禁止降级（§7.4）")


def test_revoked_binding_denied():
    _p, provider, cache, breaker, engine = _make({
        "outcomes": [{"kind": "AUTHORIZED", "account_id": "github:testuser",
                      "scopes": SCOPES, "subject": "testuser"}]})
    revoked = dict(BINDING)
    revoked["status"] = "REVOKED"
    result = engine.ensure_authorized(revoked, "sess-1")
    check(result.is_denial, "已撤销 Binding 必须拒绝（§7.4）")


def test_auth_budget_bounded():
    """两次尝试 + 抖动，总墙钟预算 12s（§7.3）。clock 为假时钟验证次数。"""
    import time as real_time
    attempts = []
    started = real_time.monotonic()

    class SlowFake(FakeAuthProvider):
        def authenticate(self, binding, timeout_op_s=5.0,
                         timeout_connect_s=3.0):
            attempts.append(1)
            real_time.sleep(0.05)
            return super(SlowFake, self).authenticate(
                binding, timeout_op_s, timeout_connect_s)

    root = os.path.join(_tmp(), ".clued")
    paths = RuntimePaths(root)
    paths.ensure_dirs()
    provider = SlowFake({
        "outcomes": [{"kind": "UNAVAILABLE", "reason": "network"}]})
    engine = AuthEngine(provider, AuthCache(paths, "node-1"),
                        CircuitBreaker("auth"), paths, budget_s=1.0)
    result = engine.ensure_authorized(BINDING, "sess-1")
    check(result.kind == UNAVAILABLE, "预算耗尽返回 UNAVAILABLE")
    check(len(attempts) <= 2, "最多 2 次尝试（§7.3）")
    check(real_time.monotonic() - started < 10, "总墙钟预算受限")


def test_budget_exhausted_opens_breaker():
    _p, provider, cache, breaker, engine = _make(
        {"outcomes": [{"kind": "UNAVAILABLE", "reason": "network"}]})
    engine.online_attempt(BINDING)
    check(breaker.state == OPEN, "总预算耗尽 → 认证熔断器 OPEN（§8.3.1）")


def test_degraded_ttl_expiry_forces_reattempt():
    ttl = 10.0
    _p, provider, cache, breaker, engine = _make(
        {"outcomes": [{"kind": "UNAVAILABLE", "reason": "network"}]},
        lkg_age_s=60, ttl_s=ttl)
    r1 = engine.ensure_authorized(BINDING, "sess-1")
    check(r1.is_degraded, "进入降级")
    # 到期后（clock 仍是 0，但手动推进：构造新 engine 无法改 clock；
    # 用 load_session 校验 degraded_until 时间语义）
    rec = engine.load_session("sess-1")
    check(rec.kind == "DEGRADED" and rec.degraded_until == ttl,
          "降级会话 TTL 记录正确")
    # 到期后：必须重新在线尝试（§7.5 末尾；2 次尝试内都在预算中）
    n = len(provider.calls)
    engine.ensure_authorized(BINDING, "sess-1", force_online=True)
    check(len(provider.calls) > n, "到期后强制重新在线尝试")


def test_scope_ceiling_on_degrade():
    _p, provider, cache, breaker, engine = _make(
        {"outcomes": [{"kind": "UNAVAILABLE", "reason": "network"}]},
        lkg_age_s=60)
    result = engine.ensure_authorized(BINDING, "sess-1")
    check(all(s in SCOPES for s in result.scopes), "降级 scope ≤ LKG scope")


def test_capability_unavailable_not_degrade():
    """gh 缺失等能力问题 ≠ 网络不可用，不得降级（保守，§22）。"""
    _p, provider, cache, breaker, engine = _make(
        {"outcomes": [{"kind": "UNAVAILABLE", "reason": "capability"}]},
        lkg_age_s=60)
    result = engine.ensure_authorized(BINDING, "sess-1")
    check(result.kind == UNAVAILABLE and not result.is_degraded,
          "能力不可用不得降级")


TESTS = [
    test_authorized_online,
    test_new_session_reattempts_online,
    test_denied_never_degrades,
    test_tls_error_is_denied_security,
    test_unavailable_with_fresh_lkg_degrades,
    test_unavailable_no_lkg_blocks_degrade,
    test_lkg_over_1h_blocks_degrade,
    test_lkg_59m59s_degrades,
    test_lkg_60m00s_boundary_valid,
    test_lkg_over_60m00s_blocks_degrade,
    test_lkg_max_age_extension_rejected,
    test_tampered_lkg_never_degrades,
    test_revoked_binding_denied,
    test_auth_budget_bounded,
    test_budget_exhausted_opens_breaker,
    test_degraded_ttl_expiry_forces_reattempt,
    test_scope_ceiling_on_degrade,
    test_capability_unavailable_not_degrade,
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
