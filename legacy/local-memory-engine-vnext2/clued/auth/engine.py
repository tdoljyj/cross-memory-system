# -*- coding: utf-8 -*-
"""每会话授权引擎（协议 §7，v0.3.0）。

核心规则：
- 每个新会话对 Clued 的第一次 Memory Access 前 MUST 尝试在线认证（§7.1）；
- 同一 session_id 在线认证成功后可复用；新 session_id 必须重新尝试；
- 授权缓存不能替代在线尝试，只能在明确判定网络不可用后用于降级决策；
- DENIED / DENIED_SECURITY 绝不降级 → LOCKED（§7.4）；
- 有界在线尝试：连接 3s、操作 5s、2 次、抖动 500–1500ms、总预算 12s（§7.3）；
- 降级窗口（ADR-CLD-003，协议 v0.3.0）：LKG 最大年龄 = 当前策略的
  lkg_max_age（balanced=6h / strict=1h）；降级会话 30 分钟；有效降级截止 =
  min(LKG 到期, 降级会话到期)（B2 绝对截止，不得越过 LKG 上限）；
- 未知策略、任意自定义秒数、超过 6 小时的配置 → 全部 fail closed（CLD-AUTH-006）。
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
from .policy import (
    DEFAULT_POLICY, MAX_LKG_MAX_AGE_S, POLICY_PROFILES, UPGRADE_POLICY,
    resolve_lkg_max_age,
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

# 单次降级会话 TTL（协议 §7.5，30 分钟，不变；ADR-CLD-003）
DEGRADED_SESSION_TTL_S = 1800.0


class SessionRecord(object):
    def __init__(self, session_id, binding_id, kind, authorized_at=None,
                 degraded_until=None, scopes=None, provider=None,
                 degraded_started_at=None):
        self.session_id = session_id
        self.binding_id = binding_id
        self.kind = kind  # AUTHORIZED | DEGRADED | DENIED
        self.authorized_at = authorized_at or now_rfc3339()
        self.degraded_until = degraded_until
        self.degraded_started_at = degraded_started_at
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
            "degraded_started_at": self.degraded_started_at,
            "scopes": self.scopes,
            "provider": self.provider,
        }

    @classmethod
    def from_dict(cls, d):
        return cls(
            d.get("session_id"), d.get("binding_id"), d.get("kind"),
            authorized_at=d.get("authorized_at"),
            degraded_until=d.get("degraded_until"),
            scopes=d.get("scopes") or [], provider=d.get("provider"),
            degraded_started_at=d.get("degraded_started_at"))


class SessionAuthResult(object):
    def __init__(self, kind, scopes=None, detail="", degraded_until=None,
                 online_attempted=False, account_id=None,
                 degraded_started_at=None, effective_degraded_until=None):
        self.kind = kind          # AUTHORIZED | DEGRADED | DENIED | UNAVAILABLE
        self.scopes = list(scopes or [])
        self.detail = detail
        self.degraded_until = degraded_until
        self.online_attempted = online_attempted
        self.account_id = account_id
        self.degraded_started_at = degraded_started_at
        self.effective_degraded_until = effective_degraded_until

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
                 lkg_max_age_s=None, degraded_ttl_s=None,
                 budget_s=None, max_attempts=None, policy=None):
        self.provider = provider
        self.cache = auth_cache
        self.breaker = breaker
        self.paths = paths
        self.audit = audit
        self._now = now
        self._sleep = clock
        self._jitter = jitter
        # ADR-CLD-003（协议 v0.3.0）：
        # - 任意自定义秒数：允许作为「缩短」覆盖，但超过 6 小时上限一律拒绝
        #   （fail closed，CLD-AUTH-006；v0.2.0 的 1h 上限已由策略化取代）；
        # - policy 只允许语义策略名（balanced/strict），未知策略 fail closed；
        # - 未显式给定 policy 时，缺省回退 UPGRADE_POLICY=strict（保守，与
        #   v0.2.0 的 1h 语义一致；真实 Binding 总是携带 auth_policy 字段）。
        if lkg_max_age_s is not None and lkg_max_age_s > MAX_LKG_MAX_AGE_S:
            raise CluedError(
                "CLD-AUTH-006",
                "协议配置变化被拒绝：lkg_max_age 超过 6 小时上限（%ss > %ss）"
                "需经产品所有者批准并写 ADR" % (lkg_max_age_s,
                                               MAX_LKG_MAX_AGE_S))
        if policy is not None and policy not in POLICY_PROFILES:
            raise CluedError(
                "CLD-AUTH-006",
                "未知认证策略 %r（仅允许 balanced/strict，fail closed）"
                % (policy,))
        self._policy_override = policy
        self.lkg_max_age_s = lkg_max_age_s  # None = 按 Binding 策略解析
        self.degraded_ttl_s = degraded_ttl_s or DEGRADED_SESSION_TTL_S
        self.budget_s = budget_s or TOTAL_BUDGET_S
        self.max_attempts = max_attempts or MAX_ATTEMPTS

    # ---- 策略解析（ADR-CLD-003）----
    def lkg_max_age_for(self, binding):
        """Binding 的 LKG 最大年龄（秒）。

        优先级：显式 lkg_max_age_s 覆盖（仅缩短）> Binding.auth_policy 策略
        > 引擎缺省策略（strict，保守）。未知策略 → 抛 CLD-AUTH-006
        （fail closed；正常情况下 Binding manifest 校验已拦截）。
        """
        if self.lkg_max_age_s is not None:
            return self.lkg_max_age_s
        policy = binding.get("auth_policy") or self._policy_override \
            or UPGRADE_POLICY
        return resolve_lkg_max_age(policy)

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
                                     online_attempted=True,
                                     account_id=result.account_id)

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
                degraded_started_at=degraded.degraded_started_at,
                effective_degraded_until=degraded.degraded_until,
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

    # ---- 降级决策（§7.5 七条件 + ADR-CLD-003 策略化）----
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

        # 条件 3（ADR-CLD-003 / 协议 v0.3.0）：age <= 策略 lkg_max_age 有效、
        # age > 策略 lkg_max_age 失效；未知策略 fail closed（不降级）。
        try:
            max_age = self.lkg_max_age_for(binding)
        except CluedError:
            return None
        age = self.cache.age(entry)
        if age is None or age > max_age:
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

        # ADR-CLD-003 B2：有效降级截止 = min(LKG 到期, 降级会话到期)。
        # 不能在 LKG 临近失效时额外获得完整 30 分钟，从而突破 LKG 绝对上限。
        lkg_expires_at = self._now() - age + max_age
        session_expires_at = self._now() + self.degraded_ttl_s
        effective_until = min(lkg_expires_at, session_expires_at)

        if self.audit is not None:
            self.audit.append(
                "degraded_enter", binding_id=binding_id,
                request_id=request_id, result_code="DEGRADED_LOCAL",
                metadata={"lkg_age_s": age, "lkg_max_age_s": max_age,
                          "effective_until_s": effective_until,
                          "scopes": scopes, "reason": result.reason})
        return SessionRecord(
            session_id="",  # 由 ensure_authorized 填充
            binding_id=binding_id, kind="DEGRADED",
            authorized_at=entry.get("authorized_at"),
            degraded_started_at=self._now(),
            degraded_until=effective_until,
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
