# -*- coding: utf-8 -*-
"""每会话授权引擎（协议 §7）。

核心规则：
- 每个新会话对 Clued 的第一次 Memory Access 前 MUST 尝试在线认证（§7.1）；
- 同一 session_id 在线认证成功后可复用；新 session_id 必须重新尝试；
- 授权缓存不能替代在线尝试，只能在明确判定网络不可用后用于降级决策；
- DENIED / DENIED_SECURITY 绝不降级 → LOCKED（§7.4）；
- 有界在线尝试：连接 3s、操作 5s、2 次、抖动 500–1500ms、总预算 12s（§7.3）；
- 降级窗口：LKG ≤ 1h（lkg_max_age，保守裁决）且 < 6h 硬失效；
  降级会话 30 分钟；到期后下一次 Memory Access 重新在线尝试（§7.5）。
"""

import json
import os
import random
import time

from .. import manifests
from ..circuit_breaker import CircuitBreaker
from ..errors import CluedError
from ..identifiers import now_rfc3339
from ..state_machine import (
    AUTH_REQUIRED, DEGRADED_LOCAL, LOCKED, ONLINE_SYNCED,
)
from .provider import (
    AUTHORIZED, DENIED, DENIED_SECURITY, REASON_BREAKER, REASON_BUDGET,
    REASON_NETWORK, UNAVAILABLE, AuthResult,
)

CONNECT_TIMEOUT_S = 3.0
OP_TIMEOUT_S = 5.0
MAX_ATTEMPTS = 2
JITTER_RANGE_S = (0.5, 1.5)
TOTAL_BUDGET_S = 12.0

LKG_MAX_AGE_S = 3600.0       # 表值 lkg_max_age = 1h（保守裁决，§7.5）
LKG_HARD_CEILING_S = 21600.0  # §7.5 条件 3 / §22.7：6h 完全失效
DEGRADED_SESSION_TTL_S = 1800.0  # 30 分钟


class SessionRecord(object):
    def __init__(self, session_id, binding_id, kind, authorized_at=None,
                 degraded_until=None, scopes=None, provider=None):
        self.session_id = session_id
        self.binding_id = binding_id
        self.kind = kind  # AUTHORIZED | DEGRADED | DENIED
        self.authorized_at = authorized_at or now_rfc3339()
        self.degraded_until = degraded_until
        self.scopes = list(scopes or [])
        self.provider = provider

    def to_dict(self):
        return {
            "schema_version": "clued.session-auth.v0.1",
            "session_id": self.session_id,
            "binding_id": self.binding_id,
            "kind": self.kind,
            "authorized_at": self.authorized_at,
            "degraded_until": self.degraded_until,
            "scopes": self.scopes,
            "provider": self.provider,
        }

    @classmethod
    def from_dict(cls, d):
        return cls(
            d.get("session_id"), d.get("binding_id"), d.get("kind"),
            authorized_at=d.get("authorized_at"),
            degraded_until=d.get("degraded_until"),
            scopes=d.get("scopes") or [], provider=d.get("provider"))


class SessionAuthResult(object):
    def __init__(self, kind, scopes=None, detail="", degraded_until=None,
                 online_attempted=False):
        self.kind = kind          # AUTHORIZED | DEGRADED | DENIED | UNAVAILABLE
        self.scopes = list(scopes or [])
        self.detail = detail
        self.degraded_until = degraded_until
        self.online_attempted = online_attempted

    @property
    def is_authorized(self):
        return self.kind == AUTHORIZED

    @property
    def is_degraded(self):
        return self.kind == "DEGRADED"

    @property
    def is_denial(self):
        return self.kind in (DENIED, DENIED_SECURITY)


class AuthEngine(object):
    """会话授权：在线尝试 + LKG 降级决策 + 会话状态持久化。

    不持有凭据；LKG 经 AuthCache；熔断经 CircuitBreaker。
    """

    def __init__(self, provider, auth_cache, breaker, paths, audit=None,
                 now=time.time, clock=time.sleep, jitter=random.uniform,
                 lkg_max_age_s=None, lkg_hard_ceiling_s=None,
                 degraded_ttl_s=None, budget_s=None, max_attempts=None):
        self.provider = provider
        self.cache = auth_cache
        self.breaker = breaker
        self.paths = paths
        self.audit = audit
        self._now = now
        self._sleep = clock
        self._jitter = jitter
        self.lkg_max_age_s = lkg_max_age_s or LKG_MAX_AGE_S
        self.lkg_hard_ceiling_s = lkg_hard_ceiling_s or LKG_HARD_CEILING_S
        self.degraded_ttl_s = degraded_ttl_s or DEGRADED_SESSION_TTL_S
        self.budget_s = budget_s or TOTAL_BUDGET_S
        self.max_attempts = max_attempts or MAX_ATTEMPTS

    # ---- 会话状态持久化 ----
    def _session_path(self, session_id):
        return self.paths.session_file(session_id)

    def load_session(self, session_id):
        p = self._session_path(session_id)
        if not os.path.isfile(p):
            return None
        try:
            rec = SessionRecord.from_dict(manifests.read_json(p))
        except Exception:
            return None
        if rec.session_id != session_id:
            return None
        return rec

    def save_session(self, rec):
        d = self.paths.sessions_dir()
        if not os.path.isdir(d):
            os.makedirs(d)
        manifests.atomic_write_json(self._session_path(rec.session_id),
                                    rec.to_dict())

    def forget_session(self, session_id):
        p = self._session_path(session_id)
        if os.path.isfile(p):
            os.remove(p)

    # ---- 主入口：每次 Memory Access 前调用 ----
    def ensure_authorized(self, binding, session_id, request_id=None,
                          force_online=False):
        """返回 SessionAuthResult。

        force_online=True：显式 auth check（每次在线尝试，不受会话复用）。
        """
        node_id = binding.get("node_id") or ""
        binding_id = binding.get("binding_id") or ""

        if binding.get("status") != "ACTIVE":
            return SessionAuthResult(
                DENIED, detail="Binding 已撤销或禁用", online_attempted=True)

        rec = self.load_session(session_id)

        # 会话内复用（§7.1）：同一 session_id 在线成功后可复用
        if rec is not None and not force_online:
            if rec.kind == AUTHORIZED:
                return SessionAuthResult(
                    AUTHORIZED, scopes=rec.scopes, online_attempted=False)
            if rec.kind == "DEGRADED" and rec.degraded_until and \
                    self._now() < rec.degraded_until:
                return SessionAuthResult(
                    "DEGRADED", scopes=rec.scopes, online_attempted=False,
                    degraded_until=rec.degraded_until,
                    detail="降级会话有效期内复用")
            if rec.kind == DENIED:
                return SessionAuthResult(
                    DENIED, detail="本会话已明确拒绝，不重复尝试",
                    online_attempted=False)

        # 在线尝试（新会话 / 降级到期 / 显式检查）
        result = self.online_attempt(binding, request_id=request_id,
                                     manual=force_online)

        if result.is_authorized:
            self._store_lkg(binding, result)
            rec = SessionRecord(session_id, binding_id, AUTHORIZED,
                                authorized_at=result.authorized_at,
                                scopes=result.scopes, provider=result.provider)
            self.save_session(rec)
            return SessionAuthResult(AUTHORIZED, scopes=result.scopes,
                                     detail=result.detail,
                                     online_attempted=True)

        if result.is_denial:
            if self.audit is not None:
                self.audit.append(
                    "auth_denied", binding_id=binding_id,
                    request_id=request_id, result_code=result.kind,
                    metadata={"reason": result.reason, "detail": result.detail})
            rec = SessionRecord(session_id, binding_id, DENIED)
            self.save_session(rec)
            return SessionAuthResult(result.kind, detail=result.detail,
                                     online_attempted=True)

        # UNAVAILABLE → 降级决策
        degraded = self._degrade_decision(binding, result, request_id)
        if degraded is not None:
            degraded.session_id = session_id
            degraded.binding_id = binding_id
            self.save_session(degraded)
            return SessionAuthResult(
                "DEGRADED", scopes=degraded.scopes, online_attempted=True,
                degraded_until=degraded.degraded_until,
                detail=result.detail or "网络不可用，进入短时本地优先降级")
        return SessionAuthResult(
            UNAVAILABLE, detail=result.detail, online_attempted=True)

    # ---- 有界在线尝试（§7.3）----
    def online_attempt(self, binding, request_id=None, manual=False):
        """最多 2 次尝试 + 抖动，总墙钟预算 12s。预算耗尽 → UNAVAILABLE。

        manual=True（显式 auth check / 恢复重新认证）：经单飞锁执行一次受控
        HALF_OPEN 探测，不受熔断 OPEN 冷却期阻塞（§8.3.6）。
        """
        binding_id = binding.get("binding_id") or ""
        # 熔断 OPEN：暂停自动网络调用（§8.2），手动探测除外
        if self.breaker.state != "CLOSED" and not self.breaker.allow_request(
                manual=manual):
            return AuthResult(
                UNAVAILABLE, reason=REASON_BREAKER,
                detail="认证熔断器打开，暂停自动在线调用")
        started = self._now()
        attempt = 0
        last = None
        while attempt < self.max_attempts:
            elapsed = self._now() - started
            if elapsed >= self.budget_s:
                break
            attempt += 1
            if attempt > 1:
                jitter = min(self._jitter(*JITTER_RANGE_S),
                             max(0.0, self.budget_s - (self._now() - started)))
                self._sleep(jitter)
            remaining = max(OP_TIMEOUT_S,
                            self.budget_s - (self._now() - started))
            result = self.provider.authenticate(
                binding, timeout_op_s=min(OP_TIMEOUT_S, remaining),
                timeout_connect_s=CONNECT_TIMEOUT_S)
            last = result
            if result.is_authorized or result.is_denial:
                self.breaker.record_success()
                if self.audit is not None:
                    self.audit.append(
                        "auth_authorized" if result.is_authorized
                        else "auth_denied",
                        binding_id=binding_id, request_id=request_id,
                        result_code=result.kind,
                        metadata={"reason": result.reason,
                                  "detail": result.detail})
                return result
            # UNAVAILABLE：记录失败，可能继续尝试
            if self.audit is not None:
                self.audit.append(
                    "auth_unavailable", binding_id=binding_id,
                    request_id=request_id, result_code=result.kind,
                    metadata={"reason": result.reason, "attempt": attempt})
        # 预算耗尽或尝试失败殆尽 → 熔断
        if last is not None and last.is_network_unavailable:
            self.breaker.force_open()
            return AuthResult(
                UNAVAILABLE, reason=REASON_BUDGET, provider=last.provider,
                detail="在线认证总预算 %ss 耗尽，熔断器打开" % self.budget_s)
        if last is not None:
            return last
        return AuthResult(UNAVAILABLE, reason=REASON_BREAKER,
                          detail="熔断器打开，跳过在线尝试")

    # ---- 降级决策（§7.5 七条件）----
    def _degrade_decision(self, binding, result, request_id=None):
        binding_id = binding.get("binding_id") or ""
        entry, err = self.cache.load(binding_id)

        # 条件 2：存在校验完整的 LKG；篡改 → 明确拒绝（§7.4）
        if err:
            if self.audit is not None:
                self.audit.append("auth_denied", binding_id=binding_id,
                                  request_id=request_id,
                                  result_code="CLD-AUTH-004",
                                  metadata={"detail": err})
            return None
        if entry is None:
            # 条件 2 不满足 → 禁止降级（CLD-AUTH-003）
            return None

        # 条件 3：证明年龄 ≤ lkg_max_age（1h 保守裁决）且 < 6h 硬失效
        age = self.cache.age(entry)
        if age is None or age > self.lkg_hard_ceiling_s:
            return None
        if age > self.lkg_max_age_s:
            return None

        # 条件 4：Binding 本地状态为 ACTIVE
        if binding.get("status") != "ACTIVE":
            return None

        # 条件 5：无已知撤销/账户切换/scope 降级/安全错误
        if result.kind != UNAVAILABLE or result.is_denial:
            return None
        if result.reason not in (REASON_NETWORK, REASON_BUDGET,
                                 REASON_BREAKER):
            return None

        # 条件 6：本地存储与 Pending Journal 完整性（由调用方 doctor 保证，
        # 此处校验 LKG scopes 合法）
        scopes = [s for s in (entry.get("scopes") or [])
                  if s in manifests.SCOPES]

        # 条件 7：当前操作在降级允许列表内（调用方判定；这里授予降级会话）

        if self.audit is not None:
            self.audit.append(
                "degraded_enter", binding_id=binding_id,
                request_id=request_id, result_code="DEGRADED_LOCAL",
                metadata={"lkg_age_s": age, "scopes": scopes,
                          "reason": result.reason})
        return SessionRecord(
            session_id="",  # 由 ensure_authorized 填充
            binding_id=binding_id, kind="DEGRADED",
            authorized_at=entry.get("authorized_at"),
            degraded_until=self._now() + self.degraded_ttl_s,
            scopes=scopes, provider=entry.get("provider"))

    def _store_lkg(self, binding, result):
        import hashlib
        subject_hash = hashlib.sha256(
            (result.subject or result.account_id or "").encode("utf-8")
        ).hexdigest()
        self.cache.store(
            binding.get("binding_id"), result.account_id, result.scopes,
            result.authorized_at, result.provider, subject_hash)


def expire_degraded_session(auth_engine, binding, session_id, request_id=None):
    """降级到期：清除会话记录，迫使下一次 Memory Access 重新在线尝试（§7.5）。"""
    rec = auth_engine.load_session(session_id)
    if rec is not None and rec.kind == "DEGRADED":
        if auth_engine.audit is not None:
            auth_engine.audit.append(
                "degraded_expire", binding_id=binding.get("binding_id"),
                request_id=request_id, result_code="DEGRADED_EXPIRED",
                metadata={"session_id": session_id})
        auth_engine.forget_session(session_id)
